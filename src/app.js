import { config, setConfig } from "./config-store.js";
import { drawScene, formatIdentification, formatPhotoCredit, projectMoth } from "./animation-engine.js";
import { formatUploadedTime } from "./observation-time.js";
import { setupAudio } from "./audio-engine.js";
import { ObservationQueue } from "./observation-queue.js";
import { MothStore } from "./moth-store.js";
import { CONNECTION_STATES, InatClient } from "./inaturalist-client.js";
import { parseObservationsResponse } from "./observation-adapter.js";
import { FALLBACK_OBSERVATIONS } from "./fallback-observations.js";
import { createMapProjector } from "./robinson-projection.js";
import { drawArrivalPulses, drawMapPoints, findMapPointAt, loadWorldBorders, renderMapToOffscreenCanvas } from "./world-map.js";

// The production site's one and only data source: api.inaturalist.org
// itself, called directly from this browser via InatClient's default direct
// mode (see README's Phase 14) — there is no server component, no shared
// cache, and no custom User-Agent (a browser fetch() can't set one). No
// place_id is ever sent (see startClient's explicit placeId: null below) —
// the feed is global, not scoped to any one visitor's country, matching the
// world map now behind the light (Phase 15).

// The last line of defense: a small, bundled-in-the-app dataset of real
// iNaturalist observations (see fallback-observations.js), shown only when a
// fresh page load can't get live data from anywhere — there's no server-side
// cache standing in front of it anymore (Phase 14), so this is the only
// thing left once iNaturalist itself is unreachable. Normalized once here
// (module load), not per fallback trigger, since it never changes.
const FALLBACK_NORMALIZED_OBSERVATIONS = parseObservationsResponse({ observations: FALLBACK_OBSERVATIONS }).observations;

// Every queue this page ever constructs — the live feed's and the fallback
// set's alike — runs at real, uncompressed time (sourceTimeScale: 1),
// overriding ObservationQueue's own default (~1440x compression, tuned for
// the old Worker's full-24h-window-per-poll behavior — see
// observation-queue.js's DEFAULT_SOURCE_TIME_SCALE). Now that Phase 14's
// direct client only ever returns a handful of genuinely-recent
// observations per poll, real-time pacing is what actually makes the scene
// read as a live feed: a moth appears roughly when it was really posted
// relative to the others, not sped up into a time-lapse. This also means
// the fallback set (a real, time-spread capture — see
// fallback-observations.js) plays out over a comparably long stretch of
// animation time instead of draining in seconds.
//
// minReleaseIntervalSeconds/maxReleaseIntervalSeconds must come along with
// sourceTimeScale: 1 — ObservationQueue's own defaults for those (0.05s/3s)
// are sized for its ~1440x-compressed default scale (see that file's own
// comment on them), not for real time. Left at those defaults, any real gap
// between observations longer than 3s — the common case — gets clamped down
// to 3s, which is exactly the "faster than real-time" bug this was meant to
// fix: real-time sourceTimeScale with compressed-scale clamps still plays
// faster than real time. 0.75s/30s are that same comment's own documented
// pre-compression, real-time values.
function createQueue() {
  return new ObservationQueue({
    sourceTimeScale: 1,
    minReleaseIntervalSeconds: 0.75,
    maxReleaseIntervalSeconds: 30
  });
}

// Shown in #debug-status purely so a screenshot from a real device proves
// which deployed build that browser is actually running, rather than leaving
// it ambiguous whether a cached older bundle is being served.
const BUILD_ID = "2026-09-25a";

function setupOrbitAnimation(initialPresentationMode = "normal") {
  const canvas = document.getElementById("orbit-canvas");
  const context = canvas.getContext("2d");
  const activeMothsToggle = document.getElementById("active-moths-toggle");
  const activeMothsPanel = document.getElementById("active-moths-panel");
  const activeMothsList = document.getElementById("active-moths-list");
  const loadingStatus = document.getElementById("loading-status");
  const loadingSpinner = document.getElementById("loading-spinner");
  // While `.is-loading` is on this, the whole scene is greyed out and a
  // spinner shows in the middle (styles/main.css) — set in index.html so the
  // very first paint is already in the loading state, and cleared below once
  // the first real response (plus the minimum display time) is in.
  const canvasShell = document.querySelector(".canvas-shell");
  const fallbackStatus = document.getElementById("fallback-status");
  // Hidden by default — this diagnostic readout was added to debug a real
  // production incident and was never meant for every visitor to see. Opt
  // in with ?debug on the URL for troubleshooting a future report.
  const debugStatus = new URLSearchParams(window.location.search).has("debug")
    ? document.getElementById("debug-status")
    : null;
  const audio = setupAudio();

  // The Robinson-projection world map behind the light (Phase 15): built
  // once the borders finish loading (fire-and-forget, not awaited before the
  // rest of the scene starts — a visitor's first paint shouldn't wait on it)
  // and rebuilt on resize alongside the canvas itself. mapCanvas is an
  // offscreen render of the whole map (see world-map.js's
  // renderMapToOffscreenCanvas) composited in every frame rather than
  // redrawn, since the map's shape never changes; projector turns a real
  // observation's lat/lon into a screen point, used both for that
  // compositing and for aiming each moth's entry/exit flight at its own
  // real reported location (see tick() below).
  let worldBorders = null;
  let mapCanvas = null;
  let projector = null;

  function rebuildMap() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // Centered on the same point drawScene's own light uses (cx, cy) so the
    // globe's "center" (0°N 0°E) sits right behind the bulb — expected to
    // partially obscure that part of the map, an accepted tradeoff rather
    // than something to design around.
    projector = createMapProjector({
      width,
      height,
      offsetX: width / 2,
      offsetY: height * config.scene.centerYRatio,
      padding: 24
    });
    if (worldBorders) {
      mapCanvas = renderMapToOffscreenCanvas(worldBorders, projector, width, height);
    }
  }

  loadWorldBorders()
    .then((borders) => {
      worldBorders = borders;
      rebuildMap();
    })
    .catch((error) => {
      // The light show and live moths work fine without the map background —
      // this is a visual layer, not a hard dependency, so a failed fetch
      // (offline, a bad deploy) degrades to just not showing it rather than
      // breaking the whole page.
      console.error("Failed to load the world map background; continuing without it.", error);
    });

  // Deliberately in-memory only (no storage option) — persisting the seen-ID
  // dedup/cursor to localStorage across page loads (the option other callers
  // use for a resumable cursor-based feed) would mean a returning visitor's
  // fresh load resumes from wherever their last visit left off, potentially
  // hours or days ago, rather than starting from what's actually recent —
  // the opposite of the intended "living view" experience. A fresh load
  // should always replay the current window from scratch.
  // Reassigned (not just mutated) when entering/leaving fallback mode — see
  // below. `let` rather than `const` because every downstream reader (tick,
  // the side panel, hit-testing) closes over this binding, so reassigning it
  // here is what makes them all pick up the fresh queue/store on their next
  // call.
  let queue = createQueue();
  let store = new MothStore();
  // A false autoplay is the one remaining kill-switch: the scene loads (just
  // the light, in whichever presentation mode) but never admits a moth. Real
  // network polling still runs in the background regardless — see the
  // launch-screen note on why that's deliberate.
  const isLive = config.animation.autoplay !== false;

  let lastTimestamp = null;
  // Set while a moth is hovered/focused (canvas or side-panel card — both
  // funnel through hoverState.hoveredMothId), holding the render clock at
  // the instant focus began so the whole scene visibly stops rather than
  // just keeping the focused moth alive a little longer past its exit.
  // Real data ingestion (the network poll, ObservationQueue) is untouched —
  // only rendering and moth admission/expiry pause; anything that arrives
  // while frozen is simply admitted the moment focus clears.
  let frozenTimestamp = null;
  let frozenSeconds = null;
  // performance.now() (and therefore nowSeconds()) never actually stops —
  // "frozen" only ever meant "keep returning this one constant value" above,
  // not "the clock itself paused". So the instant a freeze ended, the live
  // clock had already run on ahead by however long the hover lasted, and the
  // very next frame jumped straight to that real elapsed time — every active
  // moth's position/age (all computed from currentSceneSeconds() minus its
  // own entryTime, which was stamped before the freeze) suddenly leapt
  // forward by the freeze's real duration instead of resuming smoothly from
  // where it visibly stopped.
  //
  // Fixed with a running offset: every completed freeze adds its own real
  // duration to freezeOffsetSeconds/Ms, and currentSceneSeconds()/
  // currentRenderTimestamp() subtract that offset from the live clock
  // whenever not currently frozen. freezeBeganAtRealSeconds/Ms mark when the
  // *current* freeze (if any) started, purely to compute that duration once
  // it ends — see tick()'s isFrozen handling.
  let freezeOffsetSeconds = 0;
  let freezeOffsetMs = 0;
  let freezeBeganAtRealSeconds = null;
  let freezeBeganAtRealMs = null;
  let presentationMode = initialPresentationMode;
  const canHover = window.matchMedia
    ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
    : true;
  const hoverState = {
    hoveredMothId: null,
    imageCache: new Map(),
    // Width of the side panel while it's open (0 when closed), so the hover
    // pop-out drawn on the canvas keeps clear of it instead of being
    // covered — see drawHoverPopout's rightInset.
    rightInset: 0
  };
  const activeCardRecords = new Map();
  const cardExitDelay = 1600;

  function nowSeconds() {
    return performance.now() / 1000;
  }

  // The single source of truth for "what instant is the scene showing right
  // now" — every reader of scene state (rendering, hit-testing, the side
  // panel list) must agree on this, or a frozen canvas would visibly
  // disagree with hover hit-testing or the panel list still reordering
  // underneath it. Live time whenever nothing is focused; held at the
  // instant focus began for as long as it stays focused (see tick()).
  function currentSceneSeconds() {
    return frozenSeconds !== null ? frozenSeconds : nowSeconds() - freezeOffsetSeconds;
  }

  function currentRenderTimestamp() {
    return frozenTimestamp !== null ? frozenTimestamp : performance.now() - freezeOffsetMs;
  }

  // Every moth in the scene gets a card, whatever its taxonomic resolution —
  // one identified only to genus or family shows under the name it does have,
  // with its "Identified to …" line saying so. (This once skipped anything
  // not identified to species, which left moths flying around with no card.)
  function activeProjectedMoths() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;
    const t = currentSceneSeconds();

    return store.getActiveMoths()
      .map((moth) => projectMoth(moth, t, width, height, cx, cy, false))
      .filter((moth) => moth && moth.opacity > 0.02)
      .sort((a, b) => a.entryTime - b.entryTime);
  }

  // Hovering/focusing a moth (canvas or side-panel card) freezes the whole
  // scene at the instant focus began — see tick()'s isFrozen handling and
  // currentSceneSeconds() above, which every other reader of "now" (hit-
  // testing, the side panel list, this redraw) also goes through so nothing
  // visibly disagrees with what's actually frozen on screen.
  function setFocusedMoth(mothId) {
    hoverState.hoveredMothId = mothId;
    canvas.style.cursor = mothId ? "pointer" : "default";
    if (mothId) {
      store.focusMoth(mothId, nowSeconds());
    }
  }

  function clearHover() {
    hoverState.hoveredMothId = null;
    canvas.style.cursor = "default";
    store.clearFocus();
  }

  function redrawNow() {
    drawScene(context, store.getActiveMoths(), canvas.clientWidth, canvas.clientHeight, currentRenderTimestamp(), currentSceneSeconds(), hoverState, presentationMode);
  }

  // The card is a wrapper around two independent controls, not one big
  // button: `.active-moths-card__focus` toggles the moth's highlight in the
  // scene (the card's original behavior), while `.active-moths-card__link`
  // navigates to the iNaturalist observation when one is known. An <a> can't
  // be nested inside a <button> (invalid content model, and unreliable
  // focus/click handling across browsers), so the two live as siblings
  // instead, with the whole card's hover area still setting scene focus.
  function createActiveMothCard(moth) {
    const card = document.createElement("div");
    card.className = "active-moths-card is-entering";
    card.dataset.mothId = moth.id;

    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.className = "active-moths-card__focus";

    const thumb = document.createElement("img");
    thumb.className = "active-moths-card__thumb";
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.hidden = true;

    const swatch = document.createElement("span");
    swatch.className = "active-moths-card__swatch";
    swatch.style.background = moth.color;
    swatch.style.color = moth.color;

    const name = document.createElement("span");
    name.className = "active-moths-card__name";
    name.textContent = moth.speciesName || moth.label || moth.id;

    // The same facts the on-canvas hover pop-out shows (see
    // drawHoverPopout in animation-engine.js): when it was uploaded, how
    // precisely it's identified, where, and the photo credit.
    const details = document.createElement("span");
    details.className = "active-moths-card__details";
    ["uploaded", "identification", "place", "credit"].forEach((field) => {
      const line = document.createElement("span");
      line.className = `active-moths-card__${field}`;
      line.hidden = true;
      details.append(line);
    });

    focusButton.append(thumb, swatch, name, details);

    const link = document.createElement("a");
    link.className = "active-moths-card__link";
    link.textContent = "View observation ↗";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.hidden = true;
    // Clicking through to iNaturalist is a separate action from focusing the
    // moth in the scene, so it must not also trigger the card's own
    // pointerenter/click handling below.
    link.addEventListener("pointerdown", (event) => event.stopPropagation());
    link.addEventListener("click", (event) => event.stopPropagation());

    card.append(focusButton, link);

    card.addEventListener("pointerenter", () => {
      setFocusedMoth(card.dataset.mothId);
    });
    card.addEventListener("pointerleave", () => {
      if (hoverState.hoveredMothId === card.dataset.mothId) {
        clearHover();
      }
    });
    focusButton.addEventListener("focus", () => {
      setFocusedMoth(card.dataset.mothId);
    });
    focusButton.addEventListener("blur", () => {
      if (hoverState.hoveredMothId === card.dataset.mothId) {
        clearHover();
      }
    });
    focusButton.addEventListener("click", () => {
      if (hoverState.hoveredMothId === card.dataset.mothId) {
        clearHover();
      } else {
        setFocusedMoth(card.dataset.mothId);
      }
      redrawNow();
    });

    requestAnimationFrame(() => card.classList.remove("is-entering"));
    return card;
  }

  function updateActiveMothCard(card, moth) {
    const focusButton = card.querySelector(".active-moths-card__focus");
    const name = card.querySelector(".active-moths-card__name");
    const swatch = card.querySelector(".active-moths-card__swatch");
    const thumb = card.querySelector(".active-moths-card__thumb");
    const link = card.querySelector(".active-moths-card__link");
    const isFocused = hoverState.hoveredMothId === moth.id;
    const displayName = moth.speciesName || moth.label || moth.id;

    card.classList.toggle("is-focused", isFocused);
    if (focusButton) {
      focusButton.setAttribute("aria-pressed", isFocused ? "true" : "false");
      focusButton.setAttribute("aria-label", "Focus " + displayName);
    }

    if (name) {
      name.textContent = displayName;
    }
    // updateActiveMothsPanel runs once per frame, so the formatted text is
    // only rebuilt when something it's built from actually changed.
    const detailsKey = [moth.createdAtMs, moth.taxonRank, moth.speciesDescription, moth.imageAttribution, moth.imageLicense].join("|");
    if (card.dataset.detailsKey !== detailsKey) {
      card.dataset.detailsKey = detailsKey;
      const lines = {
        uploaded: formatUploadedTime(moth),
        identification: formatIdentification(moth),
        place: moth.speciesDescription,
        credit: formatPhotoCredit(moth)
      };
      Object.entries(lines).forEach(([field, text]) => {
        const line = card.querySelector(`.active-moths-card__${field}`);
        if (line) {
          line.textContent = text || "";
          line.hidden = !text;
        }
      });
    }
    if (swatch) {
      swatch.style.background = moth.color;
      swatch.style.color = moth.color;
    }

    // dataset-guarded so a plain observation photo/link isn't re-applied on
    // every animation frame (updateActiveMothsPanel runs once per tick).
    if (thumb) {
      const nextImageUrl = moth.imageURL || "";
      if (thumb.dataset.src !== nextImageUrl) {
        thumb.dataset.src = nextImageUrl;
        if (nextImageUrl) {
          thumb.src = nextImageUrl;
          thumb.alt = displayName;
          thumb.hidden = false;
        } else {
          thumb.removeAttribute("src");
          thumb.hidden = true;
        }
      }
    }

    if (link) {
      const nextObservationUrl = moth.observationUrl || "";
      if (link.dataset.href !== nextObservationUrl) {
        link.dataset.href = nextObservationUrl;
        if (nextObservationUrl) {
          link.href = nextObservationUrl;
          link.hidden = false;
        } else {
          link.removeAttribute("href");
          link.hidden = true;
        }
      }
    }
  }

  function updateActiveMothsPanel() {
    if (!activeMothsList) {
      return;
    }

    const previousRects = new Map();
    activeCardRecords.forEach((record, mothId) => {
      if (record.card.parentElement && !record.card.classList.contains("is-leaving")) {
        previousRects.set(mothId, record.card.getBoundingClientRect());
      }
    });

    const activeMoths = activeProjectedMoths();
    const activeIds = new Set(activeMoths.map((moth) => moth.id));

    activeMoths.forEach((moth, index) => {
      let record = activeCardRecords.get(moth.id);
      if (!record) {
        const card = createActiveMothCard(moth);
        record = {
          card,
          exitTimer: null
        };
        activeCardRecords.set(moth.id, record);
      }

      if (record.exitTimer) {
        clearTimeout(record.exitTimer);
        record.exitTimer = null;
      }
      record.card.classList.remove("is-leaving");
      updateActiveMothCard(record.card, moth);
      record.card.style.order = String(index);
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
      }, cardExitDelay);
    });

    requestAnimationFrame(() => {
      activeCardRecords.forEach((record, mothId) => {
        if (!record.card.parentElement || record.card.classList.contains("is-leaving") || record.card.classList.contains("is-entering")) {
          return;
        }

        const previousRect = previousRects.get(mothId);
        const currentRect = record.card.getBoundingClientRect();
        if (!previousRect) {
          return;
        }

        const deltaY = previousRect.top - currentRect.top;
        if (deltaY !== 0) {
          record.card.style.transform = `translateY(${deltaY}px)`;
          record.card.getBoundingClientRect();
          requestAnimationFrame(() => {
            record.card.style.transform = "";
          });
        }
      });
    });
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * scale));
    canvas.height = Math.max(1, Math.floor(rect.height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
    rebuildMap();
    positionLoadingSpinner(rect);
  }

  // The loading spinner is a ring around the light itself (the bulb's centre
  // is where drawScene puts it), sized off the bulb so it stays a ring
  // around it at any screen size.
  function positionLoadingSpinner(rect) {
    if (!loadingSpinner) {
      return;
    }
    const diameter = config.light.size * 2 + 44;
    loadingSpinner.style.width = diameter + "px";
    loadingSpinner.style.height = diameter + "px";
    loadingSpinner.style.left = rect.left + rect.width / 2 + "px";
    loadingSpinner.style.top = rect.top + rect.height * config.scene.centerYRatio + "px";
    loadingSpinner.style.margin = -diameter / 2 + "px 0 0 " + -diameter / 2 + "px";
  }

  // Preloads one real observation photo the first time it's admitted (rather
  // than a fixed species list, which live taxa have no relationship to), so
  // the canvas-drawn hover popout's thumbnail is ready by the time anyone
  // actually hovers it. iNaturalist's photo host sends CORS headers
  // (confirmed against inaturalist-open-data.s3.amazonaws.com), so
  // crossOrigin="anonymous" loads it without tainting the canvas.
  function preloadMothImage(imageURL) {
    if (!imageURL || hoverState.imageCache.has(imageURL)) {
      return;
    }

    const image = new Image();
    const record = { image, loaded: false, failed: false };
    hoverState.imageCache.set(imageURL, record);
    image.crossOrigin = "anonymous";
    image.addEventListener("load", () => {
      record.loaded = true;
      redrawNow();
    });
    image.addEventListener("error", () => {
      record.failed = true;
    });
    image.src = imageURL;
  }

  let lastDebugUpdateSeconds = 0;
  // Assigned synchronously by startClient() below, called immediately —
  // before tick()/updateDebugStatus() ever run.
  let client = null;

  function updateDebugStatus(t) {
    if (!debugStatus || !client || t - lastDebugUpdateSeconds < 0.5) {
      return;
    }
    lastDebugUpdateSeconds = t;

    const stats = client.getStats();
    const lines = [
      `build=${BUILD_ID} state=${client.state} reqs=${stats.requestCount} obs=${stats.observationsReceived}`,
      `pending=${queue.pendingCount} seen=${queue.seenIds.size} active=${store.getActiveMoths().length}`
    ];
    if (client.lastError) {
      lines.push(`err=${client.lastError}`);
    }
    debugStatus.textContent = lines.join("\n");
  }

  function tick(timestamp) {
    if (lastTimestamp === null) {
      lastTimestamp = timestamp;
    }
    const realDeltaSeconds = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    const isFrozen = hoverState.hoveredMothId !== null;
    if (isFrozen && frozenTimestamp === null) {
      // Freeze just began: capture the current (already offset-adjusted)
      // scene time as the constant to hold, and remember the real clock
      // reading it started at so this freeze's own duration can be measured
      // once it ends (see the !isFrozen branch below).
      freezeBeganAtRealMs = timestamp;
      freezeBeganAtRealSeconds = nowSeconds();
      frozenTimestamp = timestamp - freezeOffsetMs;
      frozenSeconds = freezeBeganAtRealSeconds - freezeOffsetSeconds;
    } else if (!isFrozen && frozenTimestamp !== null) {
      // Freeze just ended: fold its real duration into the running offset
      // so the live clock (nowSeconds()/performance.now() minus this
      // offset — see currentSceneSeconds()/currentRenderTimestamp())
      // continues from exactly frozenSeconds/frozenTimestamp instead of
      // jumping straight to wherever the un-adjusted real clock has since
      // reached, which is what made the scene visibly leap forward by the
      // hover's own duration the instant it ended.
      freezeOffsetMs += timestamp - freezeBeganAtRealMs;
      freezeOffsetSeconds += nowSeconds() - freezeBeganAtRealSeconds;
      freezeBeganAtRealMs = null;
      freezeBeganAtRealSeconds = null;
      frozenTimestamp = null;
      frozenSeconds = null;
    }
    const renderTimestamp = currentRenderTimestamp();
    const t = currentSceneSeconds();
    const deltaSeconds = isFrozen ? 0 : realDeltaSeconds;

    if (isLive && !isFrozen) {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const due = queue.peekDue(t);
      due.forEach((observation) => {
        if (store.addObservation(observation, t, width, height)) {
          queue.acknowledge(observation.id, t);
          preloadMothImage(observation.imageUrl);
        }
      });
      // Before removal, not after: a moth begins visibly leaving (fading out,
      // flying off) well before it's removed, so the check for "would this
      // leave the scene empty?" has to happen ahead of that — see
      // MothStore.holdLastMoth().
      store.holdLastMoth(t);
      store.removeExpired(t);
    }

    const activeMoths = store.getActiveMoths();
    // Every active moth flies in from — and, on exit, back out to — its own
    // real reported location instead of animation-engine.js's default random
    // point beyond the canvas edge (see projectMoth's entryPoint/exitPoint
    // override). Recomputed every frame, not cached at admission time, so it
    // keeps tracking the right screen position across a resize (rebuildMap()
    // runs on resize too). getActiveMoths() returns the store's own moth
    // objects by reference, so mutating them here is what makes drawScene's
    // own projectMoth calls below actually see these fields. A moth with no
    // known location (a real minority — see observation-adapter.js) simply
    // keeps the default off-canvas entry/exit instead.
    if (projector) {
      activeMoths.forEach((moth) => {
        if (Number.isFinite(moth.lat) && Number.isFinite(moth.lon)) {
          const point = projector.project([moth.lon, moth.lat]);
          moth.entryPoint = point;
          moth.exitPoint = point;
        }
      });
    }

    // drawScene() clears the whole canvas and fills it (transparently, per
    // the backgroundColor override in bootstrap()) before drawing the light/
    // moths — so the map has to be composited in AFTER, "behind" whatever
    // drawScene just drew, rather than before it (which drawScene's own
    // clear would just erase). destination-over draws new content only
    // where the existing canvas is transparent or partially so, which is
    // exactly "behind the light and moths" — including the light visibly
    // obscuring the map underneath it, an accepted tradeoff of this design.
    drawScene(context, activeMoths, canvas.clientWidth, canvas.clientHeight, renderTimestamp, t, hoverState, presentationMode);
    if (projector) {
      context.save();
      context.globalCompositeOperation = "destination-over";
      if (mapCanvas) {
        context.drawImage(mapCanvas, 0, 0, canvas.clientWidth, canvas.clientHeight);
      }
      drawMapPoints(context, projector, activeMoths, hoverState.hoveredMothId);
      context.restore();
      // Normal (source-over) compositing, on top of everything drawn above —
      // see drawArrivalPulses's own comment for why this can't share the
      // destination-over pass the steady point markers use.
      drawArrivalPulses(context, projector, activeMoths, t);
    }
    audio.update(activeMoths, deltaSeconds);
    updateActiveMothsPanel();
    updateDebugStatus(t);
    requestAnimationFrame(tick);
  }

  function findHoveredMoth(pointerX, pointerY) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;
    const t = currentSceneSeconds();

    return store.getActiveMoths()
      .map((moth) => projectMoth(moth, t, width, height, cx, cy, false))
      .filter((moth) => moth && moth.opacity > 0.05)
      .map((moth) => {
        const distance = Math.hypot(pointerX - moth.x, pointerY - moth.y);
        const hitRadius = Math.max(14, moth.size * 2.4 + moth.shadowBlur * 0.12);
        return {
          distance,
          hitRadius,
          moth
        };
      })
      .filter((candidate) => candidate.distance <= candidate.hitRadius)
      .sort((a, b) => {
        if (Math.abs(a.distance - b.distance) > 0.1) {
          return a.distance - b.distance;
        }

        return b.moth.depth - a.moth.depth;
      })[0]?.moth || null;
  }

  // Checks the orbiting light show first (a moth's own position on the
  // canvas), then falls back to its steady marker on the world map behind it
  // (world-map.js's findMapPointAt) — so hovering either one focuses the
  // same moth, and the smaller background map marker never steals a hit
  // from the light show sitting on top of it.
  function findHoveredMothOrPoint(pointerX, pointerY) {
    const hoveredMoth = findHoveredMoth(pointerX, pointerY);
    if (hoveredMoth) {
      return hoveredMoth;
    }
    return projector ? findMapPointAt(projector, store.getActiveMoths(), pointerX, pointerY) : null;
  }

  function updateHover(event) {
    if (!canHover) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const hoveredMoth = findHoveredMothOrPoint(pointerX, pointerY);

    if (!hoveredMoth) {
      clearHover();
      return;
    }

    setFocusedMoth(hoveredMoth.id);
  }

  function handleTapFocus(event) {
    if (canHover && event.pointerType === "mouse") {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const tappedMoth = findHoveredMothOrPoint(pointerX, pointerY);

    event.preventDefault();

    if (!tappedMoth || tappedMoth.id === hoverState.hoveredMothId) {
      clearHover();
      redrawNow();
      return;
    }

    setFocusedMoth(tappedMoth.id);
    redrawNow();
  }

  if (activeMothsToggle && activeMothsPanel) {
    activeMothsToggle.addEventListener("click", () => {
      const isOpen = !activeMothsPanel.classList.contains("is-open");
      activeMothsPanel.classList.toggle("is-open", isOpen);
      hoverState.rightInset = isOpen ? activeMothsPanel.offsetWidth : 0;
      activeMothsToggle.classList.toggle("is-open", isOpen);
      activeMothsToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      activeMothsToggle.setAttribute("aria-label", isOpen ? "Hide active moths" : "Show active moths");
      updateActiveMothsPanel();
    });
  }

  if (canHover) {
    canvas.addEventListener("pointermove", updateHover);
    canvas.addEventListener("pointerleave", clearHover);
  }

  canvas.addEventListener("pointerdown", handleTapFocus);
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // Constructs and starts the one and only InatClient this page ever needs —
  // no place_id, ever (see the file header): the feed is global, matching
  // the world map now behind the light.
  function startClient() {
    let hasReceivedLiveData = false;
    let fallbackActive = false;

    // Ends the loading state (greyed-out scene, spinner, caption) the moment
    // the first fetch has resolved one way or the other — no minimum display
    // time, so a fast response is shown as fast as it arrives.
    function finishLoading() {
      if (loadingStatus) {
        loadingStatus.classList.add("is-hidden");
      }
      if (canvasShell) {
        canvasShell.classList.remove("is-loading");
      }
    }

    function enterFallbackModeIfNeeded() {
      if (hasReceivedLiveData || fallbackActive) {
        return;
      }
      fallbackActive = true;
      queue = createQueue();
      store = new MothStore();
      queue.enqueue(FALLBACK_NORMALIZED_OBSERVATIONS);
      if (fallbackStatus) {
        fallbackStatus.textContent =
          "It looks like live data is temporarily unavailable. While we wait, here's a look at moths recently shared from around the world.";
        fallbackStatus.classList.remove("is-hidden");
      }
    }

    client = new InatClient({
      placeId: null,
      // Live feel: the first request only asks for the last couple of minutes
      // of uploads (later ones continue from the cursor, so they only return
      // what's new), and it checks twice as often as the client's default.
      // Playback follows each observation's upload time, so this is what
      // keeps what's on screen close to what was just posted.
      initialLookbackMinutes: 2,
      pollIntervalSeconds: 30,
      getCursor: () => queue.cursor || null,
      onStateChange: (state) => {
        // STARTING is the synchronous initial state set the instant
        // client.start() runs, before any network activity — only a later,
        // real state (success or failure) means the first fetch has actually
        // resolved, which is what "no longer loading" should mean here.
        if (state !== CONNECTION_STATES.STARTING) {
          finishLoading();
        }
        if (state === CONNECTION_STATES.FATAL_SCHEMA_ERROR) {
          console.error("iNaturalist returned an unexpected response shape; live updates have stopped.");
        }
        // Every failure state (RATE_LIMITED and FATAL_SCHEMA_ERROR are just
        // as much "no live data" from this visitor's point of view as
        // STALE/OFFLINE) — but only while this client has never once
        // succeeded. Once real data has ever arrived, later failures don't
        // re-trigger the static fallback (there's no server-side cache left
        // to fall back to either, see README's Phase 14) — they just mean no
        // new observations until the next successful poll, while whatever
        // was already admitted keeps playing out.
        if (
          state === CONNECTION_STATES.STALE ||
          state === CONNECTION_STATES.OFFLINE ||
          state === CONNECTION_STATES.RATE_LIMITED ||
          state === CONNECTION_STATES.FATAL_SCHEMA_ERROR
        ) {
          enterFallbackModeIfNeeded();
        }
      },
      onBatch: (payload) => {
        hasReceivedLiveData = true;
        // A real batch just arrived — even an empty (QUIET) one is real data,
        // unlike the substitute fallback set. Swap back to a clean queue/store
        // rather than mixing static fallback moths in with live ones, which
        // would be confusing (a card claiming to be a real-time sighting
        // sitting right next to one from an unrelated captured window).
        if (fallbackActive) {
          fallbackActive = false;
          queue = createQueue();
          store = new MothStore();
          if (fallbackStatus) {
            fallbackStatus.classList.add("is-hidden");
          }
        }
        queue.enqueue(payload.observations, payload.cursor);
      }
    });
    client.start();
  }

  startClient();

  requestAnimationFrame(tick);

  return {
    setPresentationMode(mode) {
      presentationMode = mode;
    }
  };
}

function setupLaunchScreen() {
  const launchScreen = document.getElementById("launch-screen");
  const launchSwitch = document.getElementById("launch-switch");
  const launchText = document.getElementById("launch-text");
  const launchScreenEnabled = config.animation.launchScreenEnabled === true || config.animation.launchScreenEnabled === "true";
  let orbitStarted = false;
  let orbitController = null;

  function startAnimation(initialPresentationMode = "normal") {
    if (orbitStarted) {
      return orbitController;
    }
    orbitController = setupOrbitAnimation(initialPresentationMode);
    orbitStarted = true;
    return orbitController;
  }

  function removeLaunchScreenWhenHidden() {
    if (!launchScreen) {
      return;
    }

    launchScreen.classList.add("launch-screen--hidden");
    launchScreen.addEventListener("transitionend", function onTransitionEnd(event) {
      if (event.propertyName !== "opacity") {
        return;
      }
      launchScreen.removeEventListener("transitionend", onTransitionEnd);
      launchScreen.remove();
    });
  }

  function revealMainAnimation() {
    const controller = startAnimation("light-only");
    document.body.classList.add("launch-light-visible");
    removeLaunchScreenWhenHidden();

    window.setTimeout(() => {
      if (controller) {
        controller.setPresentationMode("normal");
      }
      document.body.classList.add("launch-controls-visible");

      window.setTimeout(() => {
        document.body.classList.remove("launch-screen-active", "launch-light-visible", "launch-controls-visible");
      }, 700);
    }, 1000);
  }

  function activateLaunchScreen() {
    if (!launchScreen || !launchSwitch || launchSwitch.classList.contains("is-on")) {
      return;
    }
    launchSwitch.classList.add("is-on");
    launchScreen.classList.add("launch-screen--switch-hidden");
    if (launchText) {
      launchText.textContent = "Turning on...";
    }
    setTimeout(revealMainAnimation, 320);
  }

  if (!launchScreenEnabled) {
    if (launchScreen) {
      launchScreen.remove();
    }
    setupOrbitAnimation();
    return;
  }

  if (launchScreen && launchSwitch) {
    document.body.classList.add("launch-screen-active");
    launchSwitch.addEventListener("click", (event) => {
      event.stopPropagation();
      activateLaunchScreen();
    });
    launchSwitch.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateLaunchScreen();
      }
    });
  } else {
    setupOrbitAnimation();
  }
}

async function bootstrap() {
  const response = await fetch("config/site-config.json");
  if (!response.ok) {
    throw new Error("Failed to load config/site-config.json: " + response.status);
  }
  setConfig(await response.json());
  // drawScene() (see drawGround in animation-engine.js) unconditionally
  // clears the canvas and fills it with this opaque color every frame,
  // regardless of showGround — reasonable when it's the only thing drawing
  // to the canvas, but it would erase the world map drawn underneath it
  // here (Phase 15). Making it transparent, combined with drawing the map
  // via globalCompositeOperation "destination-over" (see tick() in
  // setupOrbitAnimation), is what actually gets the map to sit behind the
  // light/moths rather than behind an opaque rectangle.
  config.animation.backgroundColor = "rgba(0, 0, 0, 0)";
  setupLaunchScreen();
}

bootstrap();
