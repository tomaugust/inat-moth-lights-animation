// The world map layer behind the light: loading/rendering the Robinson-
// projection borders, drawing steady map-point markers and the arrival/
// departure pulse for each active moth's real reported location, and
// hit-testing pointer position against those points. Kept independent of
// app.js's own state (queue/store/hover) — every function here just takes
// what it needs and draws or returns a value, the same separation
// animation-engine.js's drawScene/projectMoth already keep from the rest of
// the app. Promoted from a standalone concept mockup (global-map-mockup.js)
// to the production data path in Phase 15 — see README.md.
import { easeInOut } from "./animation-engine.js";

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

// Builds (or rebuilds, on resize) an offscreen render of the whole map —
// projecting and filling 177 countries' worth of polygons every animation
// frame would be wasted work, since the map itself never changes shape.
export function renderMapToOffscreenCanvas(countries, projector, width, height) {
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

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// A quick ping at the map location reads better than a ring that takes as
// long to resolve as the moth's own multi-second flight, so this starts from
// the same entry/exit duration formula projectMoth itself uses
// (animation-engine.js) for the fly-in/fly-out animation moth.entryPoint/
// exitPoint drives, then plays this many times faster. The ring no longer
// stays in sync with the flight for its whole duration (it finishes well
// before the moth actually arrives/departs) — a deliberate tradeoff for a
// snappier-looking pulse. Duplicated rather than exported from
// animation-engine.js since this pairing (a pulse at a real map location)
// only exists here so far.
const PULSE_SPEED_MULTIPLIER = 5;

export function pulsePhase(moth, t) {
  const duration = Math.min(6, Math.max(2, (moth.exitTime - moth.entryTime) * 0.22)) / PULSE_SPEED_MULTIPLIER;
  if (t < moth.entryTime + duration) {
    return { kind: "entering", progress: easeInOut(clamp01((t - moth.entryTime) / duration)) };
  }
  const exitStart = Math.max(moth.entryTime, moth.exitTime - duration);
  if (t > exitStart) {
    return { kind: "exiting", progress: easeInOut(clamp01((t - exitStart) / duration)) };
  }
  return null;
}

// ringProgress: 0 = tight and bright right at the point, 1 = fully expanded
// and faded out. Arrival plays this forward (a ripple emanating outward as
// the moth departs the map to fly in); departure plays the exact same
// drawing backward — starting expanded and faded, converging back to a
// bright point exactly as the moth lands back where it came from — rather
// than being a separately designed animation.
function drawLocationPulse(context, x, y, color, ringProgress) {
  const maxRadius = 42;
  const radius = 3 + ringProgress * maxRadius;
  const alpha = 1 - ringProgress;

  context.save();
  context.globalAlpha = alpha * 0.85;
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.shadowColor = color;
  context.shadowBlur = 16;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

// Drawn separately from the steady point markers below, and in *normal*
// (source-over) compositing rather than the markers' destination-over —
// early in arrival, the ring is centered exactly on the same point the moth
// itself is flying in from, so under destination-over its brightest,
// tightest moment would be silently hidden behind the moth's own opaque
// glow sitting right on top of it. The pulse is a foreground event (like a
// sonar ping), not part of the background map layer, so it belongs on top
// of everything, always visible regardless of what else is on the canvas.
export function drawArrivalDeparturePulses(context, projector, activeMoths, t) {
  activeMoths.forEach((moth) => {
    if (!Number.isFinite(moth.lat) || !Number.isFinite(moth.lon)) {
      return;
    }
    const pulse = pulsePhase(moth, t);
    if (!pulse) {
      return;
    }
    const { x, y } = projector.project([moth.lon, moth.lat]);
    const ringProgress = pulse.kind === "entering" ? pulse.progress : 1 - pulse.progress;
    drawLocationPulse(context, x, y, moth.color, ringProgress);
  });
}

export function drawMapPoints(context, projector, activeMoths, hoveredMothId) {
  activeMoths.forEach((moth) => {
    if (!Number.isFinite(moth.lat) || !Number.isFinite(moth.lon)) {
      return;
    }
    const { x, y } = projector.project([moth.lon, moth.lat]);
    const isFocused = hoveredMothId === moth.id;

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

// Hit-tests a pointer position against every active moth's map point (not
// its orbiting position on the light — see animation-engine.js's projectMoth
// for that), for hover-linking the map to the light show and side panel.
export function findMapPointAt(projector, activeMoths, pointerX, pointerY) {
  let closest = null;
  let closestDistance = Infinity;
  activeMoths.forEach((moth) => {
    if (!Number.isFinite(moth.lat) || !Number.isFinite(moth.lon)) {
      return;
    }
    const { x, y } = projector.project([moth.lon, moth.lat]);
    const distance = Math.hypot(pointerX - x, pointerY - y);
    if (distance <= 10 && distance < closestDistance) {
      closest = moth;
      closestDistance = distance;
    }
  });
  return closest;
}
