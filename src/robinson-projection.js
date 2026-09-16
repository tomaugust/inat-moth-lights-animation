// Robinson projection (Robinson, 1974) — the standard published coefficient
// table used by essentially every open-source projection library (PROJ,
// d3-geo-projection, etc.), tabulated here at its usual 5-degree latitude
// steps. These are cartographic constants, not anyone's copyrighted
// expression. Linear interpolation between steps (rather than the cubic
// spline some libraries use) is a deliberate simplification — at any on-
// screen map size this project renders, the visual difference is not
// perceptible, and it keeps this module dependency-free.
const ROBINSON_TABLE = [
  [1.0000, 0.0000],
  [0.9986, 0.0620],
  [0.9954, 0.1240],
  [0.9900, 0.1860],
  [0.9822, 0.2480],
  [0.9730, 0.3100],
  [0.9600, 0.3720],
  [0.9427, 0.4340],
  [0.9216, 0.4958],
  [0.8962, 0.5571],
  [0.8679, 0.6176],
  [0.8350, 0.6769],
  [0.7986, 0.7346],
  [0.7597, 0.7903],
  [0.7186, 0.8435],
  [0.6732, 0.8936],
  [0.6213, 0.9394],
  [0.5722, 0.9761],
  [0.5322, 1.0000]
];

// The two standard Robinson scaling constants (also published, also not
// anyone's expression) that turn the table's normalized X/Y factors into the
// projection's actual aspect ratio.
const ROBINSON_X_SCALE = 0.8487;
const ROBINSON_Y_SCALE = 1.3523;

function lookupRobinsonFactors(absLatDeg) {
  const clamped = Math.min(90, Math.max(0, absLatDeg));
  const step = clamped / 5;
  const lowIndex = Math.min(ROBINSON_TABLE.length - 2, Math.floor(step));
  const fraction = step - lowIndex;
  const [xLow, yLow] = ROBINSON_TABLE[lowIndex];
  const [xHigh, yHigh] = ROBINSON_TABLE[lowIndex + 1];
  return {
    x: xLow + (xHigh - xLow) * fraction,
    y: yLow + (yHigh - yLow) * fraction
  };
}

// Projects [lon, lat] (degrees) to unitless Robinson-projection coordinates
// centered on (0, 0), x increasing east, y increasing SOUTH (matching canvas
// convention — a common source of sign-error, called out explicitly here).
// centralMeridian (degrees) re-centers the map on a different longitude than
// 0°, wrapping so every point still lands within ±180° of it.
export function projectRobinson([lon, lat], centralMeridian = 0) {
  let lonOffset = lon - centralMeridian;
  while (lonOffset > 180) lonOffset -= 360;
  while (lonOffset < -180) lonOffset += 360;

  const { x: xFactor, y: yFactor } = lookupRobinsonFactors(Math.abs(lat));
  const lonOffsetRad = (lonOffset * Math.PI) / 180;
  return {
    x: ROBINSON_X_SCALE * xFactor * lonOffsetRad,
    y: -ROBINSON_Y_SCALE * yFactor * Math.sign(lat)
  };
}

// The projection's own natural bounding box in the same unitless coordinates
// projectRobinson returns, at the equator/180° edge and the poles — used to
// fit the whole map to a target pixel width/height while preserving its
// aspect ratio.
export function robinsonExtent() {
  const edge = projectRobinson([180, 0]);
  const pole = projectRobinson([0, 90]);
  return { halfWidth: edge.x, halfHeight: Math.abs(pole.y) };
}

// Builds a reusable lon/lat -> screen-pixel projector for a given canvas
// size, centered at (offsetX, offsetY) with uniform scale so the map fills
// as much of the available box as possible without distortion.
export function createMapProjector({ width, height, centralMeridian = 0, offsetX = width / 2, offsetY = height / 2, padding = 0 }) {
  const extent = robinsonExtent();
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(availableWidth / (extent.halfWidth * 2), availableHeight / (extent.halfHeight * 2));

  return {
    scale,
    project(lonLat) {
      const { x, y } = projectRobinson(lonLat, centralMeridian);
      return { x: offsetX + x * scale, y: offsetY + y * scale };
    }
  };
}
