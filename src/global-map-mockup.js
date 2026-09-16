// Concept mockup (dev only, not part of the deployed site): a global,
// last-5-minutes moth feed plotted on a dark Robinson-projection world map,
// with the existing light + orbiting-moth animation layered on top and
// hover-linked to the map points and a side list of species cards.
//
// Talks directly to api.inaturalist.org from the browser (same "development-
// only direct client" pattern as live-demo.html/src/live-demo.js) — this is
// here to let the concept be judged against real, current data, not to be
// shipped as-is. A production version would go through a Worker adapter for
// the same reasons Phase 4 already exists (real User-Agent, one shared
// refresh instead of N).
import { setConfig, config } from "./config-store.js";
import { drawScene, easeInOut, projectMoth } from "./animation-engine.js";
import { ObservationQueue } from "./observation-queue.js";
import { MothStore } from "./moth-store.js";
import { mapRawObservationToContract } from "./inaturalist-client.js";
import { parseObservationsResponse } from "./observation-adapter.js";
import { createMapProjector } from "./robinson-projection.js";

const API_BASE = "https://api.inaturalist.org/v2/observations";
const TAXON_ID = 47157; // Lepidoptera
const WITHOUT_TAXON_ID = 47224; // Papilionoidea ("Butterflies", nests skippers too) — moths only, matching the deployed site's own scope decision
const LOOKBACK_MINUTES = 5;
const POLL_INTERVAL_MS = 25000;
const FIELDS =
  "(id:!t,uuid:!t,created_at:!t,observed_on:!t,time_observed_at:!t,uri:!t,quality_grade:!t," +
  "place_guess:!t,location:!t,taxon:(id:!t,rank:!t,name:!t,preferred_common_name:!t)," +
  "photos:(id:!t,url:!t,attribution:!t,license_code:!t))";

function buildUrl() {
  const params = new URLSearchParams();
  params.set("taxon_id", String(TAXON_ID));
  params.set("without_taxon_id", String(WITHOUT_TAXON_ID));
  params.set("per_page", "200");
  params.set("order_by", "created_at");
  params.set("order", "desc");
  params.set("photos", "true");
  params.set("photo_license", "cc0,cc-by,cc-by-sa,cc-by-nc,cc-by-nc-sa,cc-by-nd,cc-by-nc-nd");
  params.set("created_d1", new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000).toISOString());
  params.set("fields", FIELDS);
  return `${API_BASE}?${params.toString()}`;
}

// The v2 API's "location" field is a plain "lat,lon" string (confirmed
// against a live response — not documented alongside the structured
// "geojson" field it sits next to, which was the other candidate).
function parseLocation(raw) {
  if (typeof raw.location !== "string") {
    return null;
  }
  const parts = raw.location.split(",");
  if (parts.length !== 2) {
    return null;
  }
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

async function fetchRecentGlobalMoths() {
  const response = await fetch(buildUrl(), { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`iNaturalist request failed: ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.results)) {
    throw new Error("Unexpected iNaturalist response shape");
  }

  // Observations with no usable location are skipped here (a small minority
  // — real measurement during this concept's design found 0 of 82 missing
  // in a live sample) rather than plotted at a fake/default point.
  const withLocation = [];
  const locationsById = new Map();
  payload.results.forEach((raw) => {
    const location = parseLocation(raw);
    if (!location) {
      return;
    }
    const mapped = mapRawObservationToContract(raw);
    // A record identified no further than the Lepidoptera order itself
    // (rank "order" — genuinely just "we know it's a moth or butterfly,
    // nothing more specific") carries iNaturalist's default common name for
    // that whole order, "Butterflies and Moths" — misleading to show as-is
    // in a feed that's already scoped to moths only (without_taxon_id above
    // guarantees it isn't an actual butterfly). Blanking it here falls
    // through to the scientific name ("Lepidoptera") instead, matching how
    // every other under-identified record already degrades (see
    // isIdentifiedToSpecies in moth-store.js for the same idea one rank up).
    if (mapped.taxonRank === "order") {
      mapped.commonName = "";
    }
    withLocation.push(mapped);
    locationsById.set(mapped.id, location);
  });

  return { observations: withLocation, locationsById };
}

// A ring crossing the antimeridian (Russia, Fiji, the Aleutians) has
// consecutive points that jump from ~+180° to ~-180° (or back) — projecting
// that jump directly draws one giant streak across the whole map, since its
// two halves land on opposite edges. Splitting the ring here, in raw lon/lat
// space before projection, at the exact ±180° crossing (interpolating the
// latitude the crossing happens at) turns that into two separate, properly
// bounded sub-rings that each end cleanly at the map's own left/right edge.
function splitRingAtAntimeridian(ring) {
  const subRings = [];
  let current = [ring[0]];

  for (let index = 1; index < ring.length; index += 1) {
    const [lon1, lat1] = ring[index - 1];
    const [lon2, lat2] = ring[index];
    const delta = lon2 - lon1;

    if (delta > 180 || delta < -180) {
      const crossingLon = delta > 180 ? -180 : 180;
      const unwrappedLon2 = delta > 180 ? lon2 - 360 : lon2 + 360;
      const denominator = unwrappedLon2 - lon1;
      // Degenerate case: both points already sit essentially ON the
      // antimeridian (e.g. lon1=180, lon2=-180 — the same physical line, a
      // real occurrence for a boundary that runs along the dateline itself,
      // seen in Fiji/Russia/Antarctica's real coordinates). There's no
      // actual interior span to interpolate a crossing latitude across —
      // dividing by ~0 would otherwise produce NaN — so just use lat1
      // (≈lat2 in this case) directly instead of splitting at all.
      const crossingLat = Math.abs(denominator) > 1e-9
        ? lat1 + (lat2 - lat1) * ((crossingLon - lon1) / denominator)
        : lat1;

      current.push([crossingLon, crossingLat]);
      subRings.push(current);
      current = [[-crossingLon, crossingLat]];
    }

    current.push([lon2, lat2]);
  }

  subRings.push(current);
  return subRings;
}

function loadWorldBorders() {
  return fetch("public/world-borders-110m.json").then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load world-borders-110m.json: ${response.status}`);
    }
    return response.json();
  });
}

// Every antimeridian-safe sub-ring (see splitRingAtAntimeridian) a country's
// polygons resolve to, each already projected to screen points — computed
// once and reused for both the fill and stroke passes below, since which
// points to trace is identical between them.
function projectedSubRings(country, projector) {
  const subRings = [];
  country.polygons.forEach((polygon) => {
    polygon.forEach((ring) => {
      splitRingAtAntimeridian(ring).forEach((subRing) => {
        if (subRing.length >= 2) {
          subRings.push(subRing.map((lonLat) => projector.project(lonLat)));
        }
      });
    });
  });
  return subRings;
}

function tracePath(mapContext, points, close) {
  points.forEach((point, index) => {
    if (index === 0) {
      mapContext.moveTo(point.x, point.y);
    } else {
      mapContext.lineTo(point.x, point.y);
    }
  });
  if (close) {
    mapContext.closePath();
  }
}

// Builds (or rebuilds, on resize) an offscreen render of the whole map —
// projecting and filling 177 countries' worth of polygons every animation
// frame would be wasted work, since the map itself never changes shape.
function renderMapToOffscreenCanvas(countries, projector, width, height) {
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = width;
  mapCanvas.height = height;
  const mapContext = mapCanvas.getContext("2d");

  mapContext.fillStyle = "#050505";
  mapContext.fillRect(0, 0, width, height);

  mapContext.fillStyle = "#161616";
  mapContext.strokeStyle = "#2a2a2a";
  mapContext.lineWidth = 1;

  countries.forEach((country) => {
    const subRings = projectedSubRings(country, projector);

    // Fill and stroke are built as two separate paths on purpose. A ring
    // split at the antimeridian needs each piece closed for fill() to know
    // what's "inside" — but closePath()'s own closing segment (a straight
    // line from a piece's last point back to its first) is a synthetic
    // edge, not a real coastline, and stroking it drew a bright diagonal
    // streak across every dateline-crossing landmass (visible on
    // Chukotka/Fiji even before this file's antimeridian handling existed —
    // closePath() was already doing this per ring). Leaving the stroke path
    // open (no closePath()) skips exactly that synthetic edge while leaving
    // the real coastline traced normally.
    mapContext.beginPath();
    subRings.forEach((points) => tracePath(mapContext, points, true));
    // evenodd so a ring's winding order (exterior vs. hole) never has to be
    // trusted — any point covered by an odd number of ring crossings is
    // "inside", regardless of which way each ring was wound.
    mapContext.fill("evenodd");

    mapContext.beginPath();
    subRings.forEach((points) => tracePath(mapContext, points, false));
    mapContext.stroke();
  });

  return mapCanvas;
}

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function main() {
  const configResponse = await fetch("config/site-config.json");
  if (!configResponse.ok) {
    throw new Error(`Failed to load config/site-config.json: ${configResponse.status}`);
  }
  setConfig(await configResponse.json());
  // drawScene() (see drawGround in animation-engine.js) unconditionally
  // clears the canvas and fills it with this opaque color every frame,
  // regardless of showGround — reasonable when it's the only thing drawing
  // to the canvas, but it would erase the map drawn underneath it here.
  // Making it transparent, combined with drawing the map via
  // globalCompositeOperation "destination-over" (see tick() below) after
  // drawScene runs, is what actually gets the map to sit behind the light/
  // moths rather than behind an opaque rectangle.
  config.animation.backgroundColor = "rgba(0, 0, 0, 0)";

  const canvas = document.getElementById("orbit-canvas");
  const context = canvas.getContext("2d");
  const statusElement = document.getElementById("demo-status");
  const activeMothsList = document.getElementById("active-moths-list");

  const worldBorders = await loadWorldBorders();

  let mapCanvas = null;
  let projector = null;

  function rebuildMap() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);

    // Centered on the same point drawScene's own light uses (cx, cy) so the
    // globe's "center" (0°N 0°E) sits right behind the bulb — expected to
    // partially obscure that part of the map, an accepted tradeoff of this
    // concept rather than something to design around.
    projector = createMapProjector({
      width,
      height,
      offsetX: width / 2,
      offsetY: height * config.scene.centerYRatio,
      padding: 24
    });
    mapCanvas = renderMapToOffscreenCanvas(worldBorders, projector, width, height);
  }

  window.addEventListener("resize", rebuildMap);
  rebuildMap();

  // ObservationQueue's pacing (minReleaseIntervalSeconds/maxReleaseIntervalSeconds/
  // sourceTimeScale) was tuned on the deployed site for compressing a 24-HOUR
  // window into about a minute of animation (see observation-queue.js).
  // That compression has no purpose here: the window being fetched is
  // already only 5 real minutes, and the whole point of this concept is
  // that the pacing reads as genuinely live, not a time-lapse. sourceTimeScale:
  // 1 keeps real gaps between uploads real (clamped to a sane display range
  // rather than left completely unbounded, since a real gap can be minutes).
  const queue = new ObservationQueue({
    storage: getStorage(),
    storageKey: "inat-moth-lights:global-map-mockup-queue",
    sourceTimeScale: 1,
    minReleaseIntervalSeconds: 0.5,
    maxReleaseIntervalSeconds: 8,
    targetSampleSize: 40
  });
  const store = new MothStore();
  // Keyed by observation id (queue/store's own "moth.id"), populated whenever
  // a batch of raw observations arrives, pruned when a moth leaves the store.
  // Kept alongside the normal queue/store pipeline rather than inside it —
  // observation-adapter.js's normalizeObservation() only carries the fixed
  // set of fields every caller (including the production site) already
  // trusts, and this mockup-only lat/lon doesn't belong being added there.
  const locationsById = new Map();

  const hoverState = { hoveredMothId: null, imageCache: new Map() };
  const activeCardRecords = new Map();

  function setFocusedMoth(mothId) {
    hoverState.hoveredMothId = mothId;
    canvas.style.cursor = mothId ? "pointer" : "default";
  }

  function clearHover() {
    hoverState.hoveredMothId = null;
    canvas.style.cursor = "default";
  }

  let connectionStatusText = "loading recent global moth records…";

  async function pollOnce() {
    try {
      const { observations: raw, locationsById: newLocations } = await fetchRecentGlobalMoths();
      const { observations } = parseObservationsResponse({ observations: raw });
      newLocations.forEach((location, id) => locationsById.set(id, location));
      const added = queue.enqueue(observations);
      connectionStatusText = `live — ${observations.length} in the last ${LOOKBACK_MINUTES}min window (${added} new), next check in ${Math.round(POLL_INTERVAL_MS / 1000)}s`;
    } catch (error) {
      connectionStatusText = `poll failed: ${error.message} — retrying in ${Math.round(POLL_INTERVAL_MS / 1000)}s`;
    }
  }

  pollOnce();
  window.setInterval(pollOnce, POLL_INTERVAL_MS);

  // --- Freeze-on-hover, mirroring app.js's own fix for the same feature ---
  // (see that file's freezeOffsetSeconds/Ms comment): performance.now() never
  // stops, so "frozen" has to mean "hold this value" AND "remember how long
  // we held it for", or resuming jumps forward by the hover's own duration.
  let frozenTimestamp = null;
  let frozenSeconds = null;
  let freezeOffsetSeconds = 0;
  let freezeOffsetMs = 0;
  let freezeBeganAtRealSeconds = null;
  let freezeBeganAtRealMs = null;

  function nowSeconds() {
    return performance.now() / 1000;
  }

  function currentSceneSeconds() {
    return frozenSeconds !== null ? frozenSeconds : nowSeconds() - freezeOffsetSeconds;
  }

  function currentRenderTimestamp() {
    return frozenTimestamp !== null ? frozenTimestamp : performance.now() - freezeOffsetMs;
  }

  function formatObservedTime(observedAtMs) {
    if (!Number.isFinite(observedAtMs)) {
      return "";
    }
    return new Date(observedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function createActiveMothCard(moth) {
    const card = document.createElement("div");
    card.className = "active-moths-card is-entering";
    card.dataset.mothId = moth.id;

    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.className = "active-moths-card__focus";

    const swatch = document.createElement("span");
    swatch.className = "active-moths-card__swatch";
    swatch.style.background = moth.color;
    swatch.style.color = moth.color;

    const name = document.createElement("span");
    name.className = "active-moths-card__name";
    name.textContent = moth.speciesName || moth.label || moth.id;

    const place = document.createElement("span");
    place.className = "active-moths-card__time";

    focusButton.append(swatch, name, place);
    card.append(focusButton);

    card.addEventListener("pointerenter", () => setFocusedMoth(card.dataset.mothId));
    card.addEventListener("pointerleave", () => {
      if (hoverState.hoveredMothId === card.dataset.mothId) {
        clearHover();
      }
    });

    requestAnimationFrame(() => card.classList.remove("is-entering"));
    return card;
  }

  function updateActiveMothCard(card, moth) {
    const name = card.querySelector(".active-moths-card__name");
    const place = card.querySelector(".active-moths-card__time");
    const swatch = card.querySelector(".active-moths-card__swatch");
    const isFocused = hoverState.hoveredMothId === moth.id;
    card.classList.toggle("is-focused", isFocused);
    if (name) name.textContent = moth.speciesName || moth.label || moth.id;
    if (place) place.textContent = [moth.place, formatObservedTime(moth.observedAtMs)].filter(Boolean).join(" · ");
    if (swatch) {
      swatch.style.background = moth.color;
      swatch.style.color = moth.color;
    }
  }

  function updateActiveMothsPanel(activeMoths) {
    if (!activeMothsList) {
      return;
    }
    const activeIds = new Set(activeMoths.map((moth) => moth.id));

    activeMoths.forEach((moth) => {
      let record = activeCardRecords.get(moth.id);
      if (!record) {
        const card = createActiveMothCard(moth);
        record = { card, exitTimer: null };
        activeCardRecords.set(moth.id, record);
      }
      if (record.exitTimer) {
        clearTimeout(record.exitTimer);
        record.exitTimer = null;
      }
      record.card.classList.remove("is-leaving");
      updateActiveMothCard(record.card, moth);
      if (!record.card.parentElement) {
        activeMothsList.append(record.card);
      }
    });

    activeCardRecords.forEach((record, mothId) => {
      if (activeIds.has(mothId) || record.exitTimer) {
        return;
      }
      record.card.classList.add("is-leaving");
      record.exitTimer = window.setTimeout(() => {
        record.card.remove();
        activeCardRecords.delete(mothId);
        if (hoverState.hoveredMothId === mothId) {
          clearHover();
        }
      }, 1200);
    });
  }

  // --- Map points, and the arrival/departure pulse ---

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  // Mirrors the small entry/exit duration formula projectMoth itself uses
  // (animation-engine.js) so this pulse stays exactly in sync with the fly-
  // in/fly-out animation moth.entryPoint/exitPoint now drives (see tick()
  // below) — duplicated rather than exported since this pairing (a pulse at
  // a real map location) only exists in this mockup so far; if it moves into
  // the production engine, this is the bit to fold back into projectMoth's
  // own returned phase/progress instead of recomputing it here.
  function pulsePhase(moth, t) {
    const duration = Math.min(6, Math.max(2, (moth.exitTime - moth.entryTime) * 0.22));
    if (t < moth.entryTime + duration) {
      return { kind: "entering", progress: easeInOut(clamp01((t - moth.entryTime) / duration)) };
    }
    const exitStart = Math.max(moth.entryTime, moth.exitTime - duration);
    if (t > exitStart) {
      return { kind: "exiting", progress: easeInOut(clamp01((t - exitStart) / duration)) };
    }
    return null;
  }

  // ringProgress: 0 = tight and bright right at the point, 1 = fully
  // expanded and faded out. Arrival plays this forward (a ripple emanating
  // outward as the moth departs the map to fly in); departure plays the
  // exact same drawing backward — starting expanded and faded, converging
  // back to a bright point exactly as the moth lands back where it came
  // from — rather than being a separately designed animation.
  function drawLocationPulse(context2d, x, y, color, ringProgress) {
    const maxRadius = 42;
    const radius = 3 + ringProgress * maxRadius;
    const alpha = 1 - ringProgress;

    context2d.save();
    context2d.globalAlpha = alpha * 0.85;
    context2d.strokeStyle = color;
    context2d.lineWidth = 2;
    context2d.shadowColor = color;
    context2d.shadowBlur = 16;
    context2d.beginPath();
    context2d.arc(x, y, radius, 0, Math.PI * 2);
    context2d.stroke();
    context2d.restore();
  }

  // Drawn separately from the steady point markers below, and in *normal*
  // (source-over) compositing rather than the markers' destination-over —
  // early in arrival, the ring is centered exactly on the same point the
  // moth itself is flying in from, so under destination-over its brightest,
  // tightest moment was being silently hidden behind the moth's own opaque
  // glow sitting right on top of it. The pulse is a foreground event (like a
  // sonar ping), not part of the background map layer, so it belongs on top
  // of everything, always visible regardless of what else is on the canvas.
  function drawArrivalDeparturePulses(activeMoths, t) {
    activeMoths.forEach((moth) => {
      const location = locationsById.get(moth.id);
      if (!location) {
        return;
      }
      const pulse = pulsePhase(moth, t);
      if (!pulse) {
        return;
      }
      const { x, y } = projector.project([location.lon, location.lat]);
      const ringProgress = pulse.kind === "entering" ? pulse.progress : 1 - pulse.progress;
      drawLocationPulse(context, x, y, moth.color, ringProgress);
    });
  }

  function drawMapPoints(activeMoths) {
    activeMoths.forEach((moth) => {
      const location = locationsById.get(moth.id);
      if (!location) {
        return;
      }
      const { x, y } = projector.project([location.lon, location.lat]);
      const isFocused = hoverState.hoveredMothId === moth.id;

      const radius = isFocused ? 7 : 3.5;
      context.save();
      context.globalAlpha = isFocused ? 1 : 0.85;
      context.shadowColor = moth.color;
      context.shadowBlur = isFocused ? 24 : 10;
      context.fillStyle = moth.color;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      if (isFocused) {
        context.lineWidth = 2;
        context.strokeStyle = "rgba(255, 255, 255, 0.95)";
        context.beginPath();
        context.arc(x, y, radius + 6, 0, Math.PI * 2);
        context.stroke();
        context.lineWidth = 1;
        context.strokeStyle = "rgba(255, 255, 255, 0.4)";
        context.beginPath();
        context.arc(x, y, radius + 11, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
    });
  }

  function findPointAt(pointerX, pointerY, activeMoths) {
    let closest = null;
    let closestDistance = Infinity;
    activeMoths.forEach((moth) => {
      const location = locationsById.get(moth.id);
      if (!location) {
        return;
      }
      const { x, y } = projector.project([location.lon, location.lat]);
      const distance = Math.hypot(pointerX - x, pointerY - y);
      if (distance <= 10 && distance < closestDistance) {
        closest = moth;
        closestDistance = distance;
      }
    });
    return closest;
  }

  // --- Main loop ---

  function tick(timestamp) {
    const isFrozen = hoverState.hoveredMothId !== null;
    if (isFrozen && frozenTimestamp === null) {
      freezeBeganAtRealMs = timestamp;
      freezeBeganAtRealSeconds = nowSeconds();
      frozenTimestamp = timestamp - freezeOffsetMs;
      frozenSeconds = freezeBeganAtRealSeconds - freezeOffsetSeconds;
    } else if (!isFrozen && frozenTimestamp !== null) {
      freezeOffsetMs += timestamp - freezeBeganAtRealMs;
      freezeOffsetSeconds += nowSeconds() - freezeBeganAtRealSeconds;
      freezeBeganAtRealMs = null;
      freezeBeganAtRealSeconds = null;
      frozenTimestamp = null;
      frozenSeconds = null;
    }

    const renderTimestamp = currentRenderTimestamp();
    const t = currentSceneSeconds();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    if (!isFrozen) {
      const due = queue.peekDue(t);
      due.forEach((observation) => {
        if (store.addObservation(observation, t, width, height)) {
          queue.acknowledge(observation.id, t);
        }
      });
      const removedIds = store.removeExpired(t);
      removedIds.forEach((id) => locationsById.delete(id));
    }

    const activeMoths = store.getActiveMoths();
    // Every active moth flies in from — and, on exit, back out to — its own
    // real observed location instead of animation-engine.js's default
    // random point beyond the canvas edge (see the entryPoint/exitPoint
    // override projectMoth now supports). Recomputed every frame, not
    // cached at admission time, so it keeps tracking the right screen
    // position across a resize (the map itself is rebuilt on resize too —
    // see rebuildMap()). getActiveMoths() returns the store's own moth
    // objects by reference, so mutating them here is what makes drawScene's
    // own projectMoth calls below actually see these fields.
    activeMoths.forEach((moth) => {
      const location = locationsById.get(moth.id);
      if (!location) {
        return;
      }
      const point = projector.project([location.lon, location.lat]);
      moth.entryPoint = point;
      moth.exitPoint = point;
    });

    // drawScene() clears the whole canvas and fills it (transparently, per
    // the backgroundColor override above) before drawing the light/moths —
    // so the map has to be composited in AFTER, "behind" whatever drawScene
    // just drew, rather than before it (which drawScene's own clear would
    // just erase). destination-over draws new content only where the
    // existing canvas is transparent or partially so, which is exactly
    // "behind the light and moths" — including the light visibly obscuring
    // the map underneath it, the expected tradeoff of this concept.
    drawScene(context, activeMoths, width, height, renderTimestamp, t, hoverState, "normal", false);
    context.save();
    context.globalCompositeOperation = "destination-over";
    if (mapCanvas) {
      context.drawImage(mapCanvas, 0, 0, width, height);
    }
    drawMapPoints(activeMoths);
    context.restore();
    // Normal (source-over) compositing, on top of everything drawn above —
    // see drawArrivalDeparturePulses's own comment for why this can't share
    // the destination-over pass the steady point markers use.
    drawArrivalDeparturePulses(activeMoths, t);
    updateActiveMothsPanel(activeMoths);

    if (statusElement) {
      statusElement.textContent = [
        connectionStatusText,
        `active: ${store.activeCount} · pending: ${queue.pendingCount} · seen: ${queue.seenIds.size}`
      ].join("\n");
    }

    requestAnimationFrame(tick);
  }

  // Foreground (orbiting moth) hit-testing, identical in approach to
  // app.js's own findHoveredMoth: project every active moth to its current
  // screen position and pick the closest one whose hit radius covers the
  // pointer. Checked before map points below, so the orbiting light show
  // takes priority over its own (smaller, background) map marker when both
  // happen to sit under the cursor.
  function findHoveredMothOnCanvas(pointerX, pointerY) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;
    const t = currentSceneSeconds();

    return store.getActiveMoths()
      .map((moth) => projectMoth(moth, t, width, height, cx, cy, false))
      .filter((moth) => moth && moth.species !== "unknown" && moth.opacity > 0.05)
      .map((moth) => {
        const distance = Math.hypot(pointerX - moth.x, pointerY - moth.y);
        const hitRadius = Math.max(14, moth.size * 2.4 + moth.shadowBlur * 0.12);
        return { distance, hitRadius, moth };
      })
      .filter((candidate) => candidate.distance <= candidate.hitRadius)
      .sort((a, b) => a.distance - b.distance)[0]?.moth || null;
  }

  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    const hoveredMoth = findHoveredMothOnCanvas(pointerX, pointerY);
    if (hoveredMoth) {
      setFocusedMoth(hoveredMoth.id);
      return;
    }

    const hoveredPoint = findPointAt(pointerX, pointerY, store.getActiveMoths());
    if (hoveredPoint) {
      setFocusedMoth(hoveredPoint.id);
    } else {
      clearHover();
    }
  });
  canvas.addEventListener("pointerleave", clearHover);

  requestAnimationFrame(tick);
}

main();
