// The world map layer behind the light: loading/rendering the Robinson-
// projection borders (with a vignette toward the edges) and drawing the
// arrival ripple / idle ring for each active moth's real reported location.
// Kept independent of
// app.js's own state (queue/store/hover) — every function here just takes
// what it needs and draws or returns a value, the same separation
// animation-engine.js's drawScene/projectMoth already keep from the rest of
// the app. Promoted from a standalone concept mockup (global-map-mockup.js)
// to the production data path in Phase 15 — see README.md.
import { easeInOut, getExitStartTime, seededUnit } from "./animation-engine.js";

export function loadWorldBorders() {
  return fetch("public/world-borders-110m.json").then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load world-borders-110m.json: ${response.status}`);
    }
    return response.json();
  });
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

// The map's own background colour (the "ocean"), as rgb components so the
// vignette below can fade land and borders into exactly this.
const MAP_BACKGROUND_RGB = "5, 5, 5";

// The vignette: [distance from the map's centre, how much of the background
// colour is laid over the map there]. Distance is 0 at the centre (where the
// light hangs) and 1 at the map's own left/right and top/bottom extremes
// (an ellipse matching the Robinson map's proportions). Untouched out to
// about the halfway mark, so the middle of the map keeps its full detail,
// then darkening steadily until, at the very edge, land and borders have
// all but sunk into the background.
export const VIGNETTE_STOPS = [
  [0, 0],
  [0.5, 0],
  [0.8, 0.5],
  [1, 0.94]
];

// Applied to the map's own offscreen render only — never to the canvas the
// light, moths and rings are drawn on — so it darkens the map
// and nothing else. Lays the map's background colour over it with a radial
// gradient (rather than making the edges transparent, which would let the
// page's own background gradient show through and change their colour).
function applyMapVignette(context, projector, width, height) {
  const center = projector.project([0, 0]);
  const halfWidth = Math.abs(projector.project([180, 0]).x - center.x);
  const halfHeight = Math.abs(projector.project([0, 90]).y - center.y);
  if (!(halfWidth > 0) || !(halfHeight > 0)) {
    return;
  }

  // A circular gradient stretched into the map's ellipse.
  const stretch = halfHeight / halfWidth;
  context.save();
  context.translate(center.x, center.y);
  context.scale(1, stretch);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, halfWidth);
  VIGNETTE_STOPS.forEach(([stop, alpha]) => {
    gradient.addColorStop(stop, `rgba(${MAP_BACKGROUND_RGB}, ${alpha})`);
  });
  context.fillStyle = gradient;
  // Covers the whole canvas once un-stretched; past the last stop the
  // gradient just carries on at full strength.
  context.fillRect(-center.x, -center.y / stretch, width, height / stretch);
  context.restore();
}

// Builds (or rebuilds, on resize) an offscreen render of the whole map —
// projecting and filling 177 countries' worth of polygons every animation
// frame would be wasted work, since the map itself never changes shape.
// options.vignette (default true) darkens the map toward its edges.
export function renderMapToOffscreenCanvas(countries, projector, width, height, { vignette = true } = {}) {
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = width;
  mapCanvas.height = height;
  const mapContext = mapCanvas.getContext("2d");

  mapContext.fillStyle = `rgb(${MAP_BACKGROUND_RGB})`;
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

  if (vignette) {
    applyMapVignette(mapContext, projector, width, height);
  }

  return mapCanvas;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Location rings: how each moth marks the spot on the map it came from.
//
//   1. Arrival — one ring that spreads out from the location to
//      RIPPLE_MAX_RADIUS while it thins and fades, taking
//      RIPPLE_DURATION_SECONDS. The moth itself fades in over its first
//      second or so (animation-engine.js's opacityFadeInDuration), so it
//      reads as emerging out of the ring.
//   2. Afterwards, for as long as the moth is in the animation — one small
//      ring that slowly breathes out and in (brighter as it contracts,
//      dimmer as it spreads), so the moth's origin stays marked. It fades in
//      as the ripple dies away, so there is never a gap, and fades out over
//      the moth's fly-out, so it doesn't vanish abruptly.
//
// Exit has no ripple of its own: with the map behind the light and other
// moths, a departure ping was mostly visual noise (Phase 16). (The arrival
// ripple was three staggered rings for a while; Phase 17 settled on one.)
//
// Everything is a function of the scene clock t — the same clock the moths
// use — so hovering (which freezes that clock) freezes the rings too.
// ---------------------------------------------------------------------------
export const RIPPLE_DURATION_SECONDS = 3;
export const RIPPLE_MAX_RADIUS = 100;
const RIPPLE_START_RADIUS = 6;
const RIPPLE_START_LINE_WIDTH = 4;
const RIPPLE_END_LINE_WIDTH = 1.2;
const RIPPLE_PEAK_ALPHA = 0.95;

export const IDLE_RING_MIN_RADIUS = 6;
export const IDLE_RING_MAX_RADIUS = 14;
const IDLE_RING_PERIOD_SECONDS = 3.6;
const IDLE_RING_LINE_WIDTH = 2;
const IDLE_RING_MAX_ALPHA = 0.7; // at its smallest
const IDLE_RING_MIN_ALPHA = 0.25; // at its widest
const IDLE_RING_FADE_IN_FROM_SECONDS = 1.6; // age at which it starts to appear

// How strong the arrival ripple is `age` seconds after the moth arrives: 1 at
// the instant it appears, fading to 0 as the ring finishes spreading out, and
// 0 outside that span. The ring's own brightness is this (times a peak alpha),
// and the arrival sound's loudness follows it too (audio-engine.js), so the
// two fade out together by construction.
export function rippleIntensity(age) {
  if (age < 0 || age > RIPPLE_DURATION_SECONDS) {
    return 0;
  }
  return Math.pow(1 - age / RIPPLE_DURATION_SECONDS, 1.4);
}

function easeOutCubic(value) {
  const t = clamp01(value);
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

// Every ring one moth should have on screen at scene time t, as plain data
// ({kind, radius, alpha, lineWidth}) — no drawing, so it can be unit-tested.
// Empty before the moth arrives and after it leaves.
export function computeMothRings(moth, t) {
  if (t < moth.entryTime || t > moth.exitTime) {
    return [];
  }

  const age = t - moth.entryTime;
  const rings = [];

  if (age <= RIPPLE_DURATION_SECONDS) {
    const progress = age / RIPPLE_DURATION_SECONDS;
    rings.push({
      kind: "ripple",
      radius: RIPPLE_START_RADIUS + easeOutCubic(progress) * (RIPPLE_MAX_RADIUS - RIPPLE_START_RADIUS),
      alpha: RIPPLE_PEAK_ALPHA * rippleIntensity(age),
      lineWidth: RIPPLE_START_LINE_WIDTH + (RIPPLE_END_LINE_WIDTH - RIPPLE_START_LINE_WIDTH) * progress
    });
  }

  const fadeIn = easeInOut(
    clamp01((age - IDLE_RING_FADE_IN_FROM_SECONDS) / (RIPPLE_DURATION_SECONDS - IDLE_RING_FADE_IN_FROM_SECONDS))
  );
  const exitStart = getExitStartTime(moth);
  const fadeOut = t > exitStart ? 1 - easeInOut(clamp01((t - exitStart) / Math.max(0.001, moth.exitTime - exitStart))) : 1;
  const visibility = fadeIn * fadeOut;

  if (visibility > 0.001) {
    // A per-moth phase so a scene full of moths doesn't breathe in unison.
    const phase = seededUnit(moth.noiseSeed || 0, 77);
    const expanded = 0.5 + 0.5 * Math.cos(2 * Math.PI * (age / IDLE_RING_PERIOD_SECONDS + phase));
    rings.push({
      kind: "idle",
      radius: IDLE_RING_MIN_RADIUS + (IDLE_RING_MAX_RADIUS - IDLE_RING_MIN_RADIUS) * expanded,
      alpha: (IDLE_RING_MAX_ALPHA + (IDLE_RING_MIN_ALPHA - IDLE_RING_MAX_ALPHA) * expanded) * visibility,
      lineWidth: IDLE_RING_LINE_WIDTH
    });
  }

  return rings;
}

function drawRing(context, x, y, color, ring) {
  context.save();
  context.globalAlpha = clamp01(ring.alpha);
  context.strokeStyle = color;
  context.lineWidth = ring.lineWidth;
  context.shadowColor = color;
  context.shadowBlur = ring.kind === "ripple" ? 16 : 8;
  context.beginPath();
  context.arc(x, y, ring.radius, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

// Drawn in *normal* (source-over) compositing, on top of the map — the map
// itself is composited behind everything else (see app.js's tick), and
// early in arrival, the rings are centred exactly on the same point the moth
// itself is flying in from, so under destination-over their brightest,
// tightest moment would be silently hidden behind the moth's own opaque
// glow sitting right on top of it. The rings are a foreground event (like a
// sonar ping), not part of the background map layer, so they belong on top
// of everything, always visible regardless of what else is on the canvas.
// hoveredMothId: the moth currently focused (by hovering it, its ring or its
// card), whose idle ring is drawn brighter, thicker and a touch larger so the
// link between the card, the moth in orbit and its place on the map is visible
// — and always visible, even while its ring would otherwise be faint.
export function drawMothRings(context, projector, activeMoths, t, hoveredMothId = null) {
  activeMoths.forEach((moth) => {
    if (!Number.isFinite(moth.lat) || !Number.isFinite(moth.lon)) {
      return;
    }
    const rings = computeMothRings(moth, t);
    if (rings.length === 0) {
      return;
    }
    const { x, y } = projector.project([moth.lon, moth.lat]);
    const isFocused = moth.id === hoveredMothId;
    rings.forEach((ring) => {
      drawRing(
        context,
        x,
        y,
        moth.color,
        isFocused && ring.kind === "idle"
          ? { ...ring, alpha: Math.max(ring.alpha, FOCUSED_RING_ALPHA), lineWidth: ring.lineWidth + 1.5, radius: ring.radius + 2 }
          : ring
      );
    });
  });
}

const FOCUSED_RING_ALPHA = 0.95;
// How far off a ring, in pixels, the pointer can be and still count as on it.
const RING_HIT_TOLERANCE = 8;
// A ring fainter than this isn't there as far as the pointer is concerned.
const RING_HIT_MIN_ALPHA = 0.05;

// Hit-tests a pointer position against every active moth's rings (not its
// orbiting position on the light — see animation-engine.js's projectMoth for
// that), for hover-linking the map to the light show and the side panel: the
// small breathing ring counts as a disc, and the expanding arrival ripple as
// the band the ring itself covers. Rings that have faded out can't be hit.
// t is the scene clock, so a frozen scene keeps its rings where they are.
// Returns the closest matching moth, or null.
export function findMothRingAt(projector, activeMoths, t, pointerX, pointerY) {
  let closest = null;
  let closestDistance = Infinity;
  activeMoths.forEach((moth) => {
    if (!Number.isFinite(moth.lat) || !Number.isFinite(moth.lon)) {
      return;
    }
    const rings = computeMothRings(moth, t);
    if (rings.length === 0) {
      return;
    }
    const { x, y } = projector.project([moth.lon, moth.lat]);
    const distance = Math.hypot(pointerX - x, pointerY - y);
    const onARing = rings.some((ring) => {
      if (ring.alpha < RING_HIT_MIN_ALPHA) {
        return false;
      }
      return ring.kind === "idle"
        ? distance <= ring.radius + RING_HIT_TOLERANCE
        : Math.abs(distance - ring.radius) <= RING_HIT_TOLERANCE + ring.lineWidth / 2;
    });
    if (onARing && distance < closestDistance) {
      closest = moth;
      closestDistance = distance;
    }
  });
  return closest;
}
