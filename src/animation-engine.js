import { config } from "./config-store.js";
import { formatUploadedTime } from "./observation-time.js";

function createMoths(config, width, height) {
  const maxMothSize = config.moths.reduce((largest, moth) => Math.max(largest, moth.size), 0);
  const orbitRadiusScale = Math.max(0.1, Math.min(1.15, config.scene.orbitRadiusScale || 0.92));
  const usableRadius = Math.max(32, (Math.min(width, height) * 0.48 - maxMothSize - 18) * orbitRadiusScale);
  const minRadius = Math.min(72, usableRadius);
  const speeds = config.moths.map((moth) => moth.speed);
  const minSpeed = Math.min(...speeds);
  const maxSpeed = Math.max(...speeds);
  const speedRange = Math.max(0.001, maxSpeed - minSpeed);
  const radiusRange = Math.max(0, usableRadius - minRadius);

  return config.moths.map((moth, index) => {
    const speedRatio = (moth.speed - minSpeed) / speedRange;
    const baseRadius = minRadius + (1 - speedRatio) * radiusRange;
    const noiseSeed = hashString(moth.id || moth.species || String(index));
    const offset = (seededUnit(noiseSeed, 7) - 0.5) * radiusRange * 0.08;
    const radius = Math.max(minRadius, Math.min(usableRadius, baseRadius + offset));

    return {
    angle: (moth.angle * Math.PI) / 180,
    chimeNote: moth.chimeNote,
    color: moth.color,
    entryAngle: (sampleBiasedApproachAngle(noiseSeed, 173) * Math.PI) / 180,
    entryTime: moth.entryTime,
    erraticness: moth.erraticness,
    exitAngle: (sampleBiasedApproachAngle(noiseSeed, 211) * Math.PI) / 180,
    exitTime: moth.exitTime,
    id: moth.id,
    imageAttribution: moth.imageAttribution,
    imageLicense: moth.imageLicense,
    inclinationDriftSpeed: moth.inclinationDriftSpeed,
    label: moth.label,
    nodeDriftSpeed: moth.nodeDriftSpeed,
    noiseSeed,
    observationUrl: moth.observationUrl,
    orbitDirection: seededUnit(noiseSeed, 131) < 0.5 ? -1 : 1,
    radius,
    shadowBlur: moth.shadowBlur,
    shadowColor: moth.shadowColor,
    size: moth.size,
    species: moth.species,
    speciesDescription: moth.speciesDescription,
    imageURL: moth.imageURL,
    speciesName: moth.speciesName,
    speed: moth.speed,
    trailLength: moth.trailLength
    };
  });
}

function easeInOut(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function sampleBiasedApproachAngle(noiseSeed, salt) {
  const baseAngle = seededUnit(noiseSeed, salt) < 0.5 ? 90 : 270;
  const offset = (seededUnit(noiseSeed, salt + 1) * 60) - 30;
  return (baseAngle + offset + 360) % 360;
}

function pointBeyondCanvas(x, y, width, height, margin, angleRadians) {
  // 0 degrees is straight up, 90 right, 180 down, 270 left.
  const directionX = Math.sin(angleRadians);
  const directionY = -Math.cos(angleRadians);
  const distances = [];

  if (Math.abs(directionX) > 0.0001) {
    distances.push(directionX > 0
      ? (width + margin - x) / directionX
      : (-margin - x) / directionX);
  }

  if (Math.abs(directionY) > 0.0001) {
    distances.push(directionY > 0
      ? (height + margin - y) / directionY
      : (-margin - y) / directionY);
  }

  const distance = distances
    .filter((candidate) => candidate > 0)
    .reduce((smallest, candidate) => Math.min(smallest, candidate), Number.POSITIVE_INFINITY);
  const safeDistance = Number.isFinite(distance) ? distance : Math.max(width, height) + margin;

  return {
    x: x + directionX * safeDistance,
    y: y + directionY * safeDistance
  };
}

function interpolatePoint(from, to, progress) {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress
  };
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed, salt) {
  let value = seed + Math.imul(salt + 1, 374761393);
  value = Math.imul(value ^ (value >>> 15), 2246822519);
  value = Math.imul(value ^ (value >>> 13), 3266489917);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function erraticWave(moth, activeTime, salt, baseFrequency) {
  const phaseA = seededUnit(moth.noiseSeed, salt) * Math.PI * 2;
  const phaseB = seededUnit(moth.noiseSeed, salt + 19) * Math.PI * 2;
  const frequencyA = baseFrequency * (0.75 + seededUnit(moth.noiseSeed, salt + 37) * 0.65);
  const frequencyB = baseFrequency * (1.35 + seededUnit(moth.noiseSeed, salt + 53) * 0.8);
  return Math.sin(activeTime * frequencyA + phaseA) * 0.62 +
    Math.sin(activeTime * frequencyB + phaseB) * 0.38;
}

function orbitPosition(moth, animationTime, cx, cy) {
  const activeTime = Math.max(0, animationTime - moth.entryTime);
  const erraticness = Math.max(0, moth.erraticness || 0);
  const angleJitter = erraticWave(moth, activeTime, 3, 1.9) * erraticness * 0.22;
  const radiusJitter = erraticWave(moth, activeTime, 11, 1.35) * moth.radius * erraticness * 0.08;
  const verticalJitter = erraticWave(moth, activeTime, 23, 2.3) * moth.radius * erraticness * 0.065;
  const inclinationDrift = moth.inclinationDriftSpeed > 0
    ? erraticWave(moth, activeTime * moth.inclinationDriftSpeed, 41, 0.45) * erraticness * 0.08
    : 0;
  const nodeDrift = moth.nodeDriftSpeed > 0
    ? erraticWave(moth, activeTime * moth.nodeDriftSpeed, 59, 0.34) * erraticness * 0.26
    : 0;
  const orbitDirection = moth.orbitDirection || 1;
  const angle = moth.angle + activeTime * moth.speed * orbitDirection + angleJitter;
  const radius = Math.max(12, moth.radius + radiusJitter);
  const orbitTilt = Math.max(0.08, Math.min(0.9, config.scene.orbitTilt + inclinationDrift));
  const depth = Math.sin(angle);
  const localX = Math.cos(angle) * radius;
  const localY = depth * radius * orbitTilt;
  const nodeCos = Math.cos(nodeDrift);
  const nodeSin = Math.sin(nodeDrift);
  return {
    depth,
    x: cx + localX * nodeCos - localY * nodeSin,
    y: cy + localX * nodeSin + localY * nodeCos + verticalJitter
  };
}

// How long a moth takes to fly in, and (the same amount) to fly back out.
function mothTransitionDuration(moth) {
  return Math.min(6, Math.max(2, (moth.exitTime - moth.entryTime) * 0.22));
}

// The instant a moth begins its fly-out (and starts fading), as opposed to
// exitTime, when it's fully gone. Exported so moth-store.js can tell when a
// moth is about to visibly leave the scene — see MothStore.holdLastMoth().
function getExitStartTime(moth) {
  return Math.max(moth.entryTime, moth.exitTime - mothTransitionDuration(moth));
}

function projectMoth(moth, animationTime, width, height, cx, cy, includeTrail = true) {
  if (animationTime < moth.entryTime || animationTime > moth.exitTime) {
    return null;
  }

  const orbit = orbitPosition(moth, animationTime, cx, cy);
  const entryDuration = mothTransitionDuration(moth);
  // Position eases in over the whole, slower entryDuration above, but
  // opacity ramps up several times faster (about a second, for the usual 6s
  // fly-in), so a moth reads as emerging out of the first ring of the
  // arrival ripple (world-map.js's computeMothRings), already close to fully
  // visible while that ring is still bright, rather than still fading in
  // long after the ripple has died away. Applies to every moth's arrival,
  // not just ones with a real map location, for one consistent, snappier
  // entrance either way.
  const opacityFadeInDuration = entryDuration / 5;
  const exitDuration = mothTransitionDuration(moth);
  const exitStart = getExitStartTime(moth);
  let x = orbit.x;
  let y = orbit.y;
  let phase = "orbiting";

  if (animationTime < moth.entryTime + entryDuration) {
    const progress = easeInOut((animationTime - moth.entryTime) / entryDuration);
    // moth.entryPoint is an opt-in override (set by, e.g., the global-map
    // mockup to fly a moth in from its real observed location instead of a
    // random point beyond the canvas edge) — every other caller leaves it
    // unset and gets the original behavior unchanged.
    const start = moth.entryPoint || pointBeyondCanvas(
      orbit.x,
      orbit.y,
      width,
      height,
      moth.size * 4,
      moth.entryAngle
    );
    const point = interpolatePoint(start, orbit, progress);
    x = point.x;
    y = point.y;
    phase = "entering";
  } else if (animationTime > exitStart) {
    const progress = easeInOut((animationTime - exitStart) / exitDuration);
    // Same opt-in override as entryPoint above, for flying back out to a
    // real location (typically the same point the moth entered from)
    // instead of a random point beyond the canvas edge.
    const end = moth.exitPoint || pointBeyondCanvas(
      orbit.x,
      orbit.y,
      width,
      height,
      moth.size * 4,
      moth.exitAngle
    );
    const point = interpolatePoint(orbit, end, progress);
    x = point.x;
    y = point.y;
    phase = "exiting";
  }

  const depthRatio = (orbit.depth + 1) * 0.5;
  let opacity = config.scene.backgroundMothOpacity +
    (config.scene.foregroundMothOpacity - config.scene.backgroundMothOpacity) * depthRatio;
  if (config.scene.horizontalFadeEnabled !== false) {
    const edgeOpacity = Math.max(0, Math.min(1, config.scene.horizontalEdgeMothOpacity));
    const fadeDistance = Math.max(1, config.light.glowRadius * 1.5);
    const horizontalDistanceRatio = Math.min(1, Math.abs(x - cx) / fadeDistance);
    const horizontalFade = edgeOpacity + (1 - easeInOut(horizontalDistanceRatio)) * (1 - edgeOpacity);
    opacity *= horizontalFade;
  }

  if (phase === "entering") {
    opacity *= easeInOut((animationTime - moth.entryTime) / opacityFadeInDuration);
  } else if (phase === "exiting") {
    opacity *= 1 - easeInOut((animationTime - exitStart) / exitDuration);
    const edgeFadeDistance = Math.max(48, moth.size * 10);
    const edgeInset = Math.max(moth.size * 2, moth.shadowBlur);
    opacity *= Math.max(0, Math.min(1, (width - edgeInset - x) / edgeFadeDistance));
  }

  return {
    ...moth,
    depth: orbit.depth,
    opacity: Math.max(0, Math.min(1, opacity)),
    phase,
    trail: includeTrail ? buildTrail(moth, animationTime, width, height, cx, cy) : [],
    x,
    y
  };
}

function buildTrail(moth, animationTime, width, height, cx, cy) {
  const points = [];
  const targetDistance = Math.max(moth.size * 5, (moth.trailLength || 2) * 18);
  const sampleStep = 0.025;
  const maxLookback = Math.max(0.5, (moth.trailLength || 2) * 0.22);
  const maxSamples = Math.ceil(maxLookback / sampleStep);
  let distance = 0;
  let previousPoint = null;

  for (let index = 0; index <= maxSamples; index += 1) {
    const sampleTime = animationTime - index * sampleStep;
    const point = projectMoth(moth, sampleTime, width, height, cx, cy, false);

    if (point && point.opacity > 0.01) {
      points.push(point);

      if (previousPoint) {
        distance += Math.hypot(previousPoint.x - point.x, previousPoint.y - point.y);
      }

      previousPoint = point;
    }

    if (points.length >= 2 && distance >= targetDistance) {
      break;
    }
  }

  return points.reverse();
}

function drawTrail(context, moth, dimFactor = 1, isFocused = false) {
  if (!moth.trail || moth.trail.length < 2) {
    return;
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.globalAlpha = 1;

  const baseWidth = Math.max(1.2, moth.size * 0.42);
  const segmentCount = moth.trail.length - 1;

  for (let index = 1; index < moth.trail.length; index += 1) {
    const previous = moth.trail[index - 1];
    const point = moth.trail[index];
    const progress = index / segmentCount;
    const fade = easeInOut(progress);
    const opacity = isFocused
      ? 1
      : Math.min(0.58, point.opacity * 0.58) * fade * dimFactor;
    const width = baseWidth * (0.45 + fade * 0.55);

    context.strokeStyle = colorWithAlpha(moth.color, opacity);
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  context.restore();
}

function colorWithAlpha(color, alpha) {
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);

  if (hexMatch) {
    const hex = hexMatch[1];
    const expanded = hex.length === 3
      ? hex.split("").map((character) => character + character).join("")
      : hex;
    const red = parseInt(expanded.slice(0, 2), 16);
    const green = parseInt(expanded.slice(2, 4), 16);
    const blue = parseInt(expanded.slice(4, 6), 16);
    return "rgba(" + red + ", " + green + ", " + blue + ", " + clampedAlpha + ")";
  }

  const rgbaMatch = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgbaMatch) {
    const channels = rgbaMatch[1].split(",").slice(0, 3).map((channel) => channel.trim());
    return "rgba(" + channels.join(", ") + ", " + clampedAlpha + ")";
  }

  return color;
}

function drawMothShadow(context, moth, lightX, lightY, width, height, dimFactor = 1) {
  const scene = config.scene || {};
  if (scene.mothShadowsEnabled !== true || moth.opacity <= 0.01) {
    return;
  }

  const dx = moth.x - lightX;
  const dy = moth.y - lightY;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) {
    return;
  }

  const centerDirectionX = dx / distance;
  const centerDirectionY = dy / distance;
  const perpendicularX = -centerDirectionY;
  const perpendicularY = centerDirectionX;
  const glowRadius = Math.max(1, config.light.glowRadius || 160);
  const proximity = 1 - Math.min(1, distance / (glowRadius * 1.65));
  const depthRatio = Math.max(0, Math.min(1, (moth.depth + 1) * 0.5));
  const baseLength = Math.max(1, scene.mothShadowLength || 110);
  const shadowLength = baseLength * (0.45 + proximity * 0.95) * (0.7 + depthRatio * 0.35);
  const mothRadius = Math.max(1, moth.size);
  const sideAX = moth.x + perpendicularX * mothRadius;
  const sideAY = moth.y + perpendicularY * mothRadius;
  const sideBX = moth.x - perpendicularX * mothRadius;
  const sideBY = moth.y - perpendicularY * mothRadius;
  const rayADistance = Math.max(1, Math.hypot(sideAX - lightX, sideAY - lightY));
  const rayBDistance = Math.max(1, Math.hypot(sideBX - lightX, sideBY - lightY));
  const rayAX = (sideAX - lightX) / rayADistance;
  const rayAY = (sideAY - lightY) / rayADistance;
  const rayBX = (sideBX - lightX) / rayBDistance;
  const rayBY = (sideBY - lightY) / rayBDistance;
  const endAX = sideAX + rayAX * shadowLength;
  const endAY = sideAY + rayAY * shadowLength;
  const endBX = sideBX + rayBX * shadowLength;
  const endBY = sideBY + rayBY * shadowLength;
  const gradientStartX = moth.x + centerDirectionX * mothRadius;
  const gradientStartY = moth.y + centerDirectionY * mothRadius;
  const gradientEndX = moth.x + centerDirectionX * shadowLength;
  const gradientEndY = moth.y + centerDirectionY * shadowLength;
  const opacity = Math.min(0.65, Math.max(0, scene.mothShadowOpacity || 0.22) * moth.opacity * (0.45 + proximity * 0.9) * dimFactor);

  if (opacity <= 0.004 || gradientEndX < -shadowLength || gradientEndX > width + shadowLength || gradientEndY < -shadowLength || gradientEndY > height + shadowLength) {
    return;
  }

  const gradient = context.createLinearGradient(gradientStartX, gradientStartY, gradientEndX, gradientEndY);
  gradient.addColorStop(0, "rgba(0, 0, 0, " + opacity.toFixed(3) + ")");
  gradient.addColorStop(0.45, "rgba(0, 0, 0, " + (opacity * 0.34).toFixed(3) + ")");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

  context.save();
  context.filter = "blur(" + Math.max(0, scene.mothShadowBlur || 12) + "px)";
  context.fillStyle = gradient;
  context.beginPath();
  context.moveTo(sideAX, sideAY);
  context.lineTo(sideBX, sideBY);
  context.lineTo(endBX, endBY);
  context.lineTo(endAX, endAY);
  context.closePath();
  context.fill();
  context.restore();
}

// ---------------------------------------------------------------------------
// Moths are drawn as simple flapping moths seen from the SIDE — the same
// side-on view as the hanging light they orbit. The shapes follow photographs
// of moths in flight (rosy maple, ermine, a hummingbird hawk-moth):
//   - a stout, fluffy thorax with a small head, an abdomen tapering back and
//     drooping, feathery antennae in a V pointing forward and up, and short
//     legs dangling underneath;
//   - the body held nose-up in flight, not level;
//   - big wings attached at the top of the thorax — a forewing with a nearly
//     straight leading edge, a rounded tip and a convex back edge, plus a
//     separate rounded hindwing beneath it — raised high in a V at the top of
//     the stroke (the far wing behind and higher than the near one);
//   - wings that FOLD rather than hinge: a moth flaps about the long axis of
//     its body, so from the side a raised wing looks tall, foreshortens as it
//     swings down toward the viewer until it is squashed flat against the
//     body (edge-on), then opens out again below the body. (A first version
//     rotated the wing rigidly about its shoulder, like a hinge in the plane
//     of the picture, which is not what a side view of a flap looks like.)
//     So the wing's height is scaled by the sine of its elevation, not turned;
//   - some moths broad-winged, some narrow-winged.
// The geometry is a pure function of the moth and the scene clock so it can be
// unit-tested; drawMoth just paints it.
// ---------------------------------------------------------------------------

// Body length in pixels: a moth's species-derived size (2-5) is far too small
// to read as a moth if used directly, so it's scaled up while still varying
// by species — the smallest come out about 16px long, the largest about 24px.
const MOTH_LENGTH_BASE = 11;
const MOTH_LENGTH_PER_SIZE = 2.5;
// Wing length as a multiple of body length, varying per moth from narrow,
// hawk-moth-like wings to broad, rosy-maple-like ones.
const WING_RATIO_MIN = 0.8;
const WING_RATIO_MAX = 1.1;
// Wingbeats per second — stylised and slower than a real moth's, so each
// stroke is readable — varying a little by moth so they don't all beat
// together.
const FLAP_MIN_HZ = 5.25;
const FLAP_MAX_HZ = 9;
// The near wing's elevation about the body's long axis: 0 is straight out to
// the side (toward the viewer, so edge-on and squashed flat), positive is above
// the body and negative below it. This is the top of the upstroke and the
// bottom of the downstroke, in radians. A big swing on purpose — it's what
// makes it read as flapping. It flaps whatever the
// visitor's "reduce motion" setting says: the moths orbit and the rings pulse
// regardless, and a ~20px wing is not the kind of large, sweeping or flashing
// motion that setting is about. (An earlier version held the wings still under
// that setting, and on a machine with Windows animations switched off — which
// reports it — the moths simply never flapped.)
const WING_UP_ANGLE = (80 * Math.PI) / 180;
const WING_DOWN_ANGLE = (-80 * Math.PI) / 180;
// The wing's length axis, when fully raised, in degrees above the body's
// backward-pointing axis — nearly straight up, swept a little back. Folding
// squashes this vertically; it doesn't turn it.
const WING_AXIS_ANGLE = (75 * Math.PI) / 180;
// The thinnest a folding wing is ever drawn, as a fraction of its full height,
// so it never disappears entirely while edge-on against the body.
const MIN_WING_THICKNESS = 0.05;
// The body bobs a little as it flaps: dropping on the upstroke, rising on the
// downstroke, by this fraction of its length either side of the middle.
const BOB_AMPLITUDE = 0.04;
// A flying moth holds its body nose-up rather than level (drawMoth applies
// this on top of the climb/dive pitch below).
const BODY_TILT = 0.45;
// How much the moth tilts (nose up/down) to follow its climbing or diving,
// at most, in radians.
const MAX_PITCH = 0.55;
// How much horizontal travel (in pixels, across the few trail samples used for
// facing) it takes to be fully turned to one side. Below that the moth is only
// partly turned — its whole sprite squeezed narrower — so as it reverses
// direction it turns through edge-on, like a real turn seen from the side,
// instead of flipping in one frame.
const TURN_FULL_TRAVEL = 6;
// The narrowest a turning moth is ever drawn, as a fraction of full width, so
// it never vanishes entirely at the exact moment it's edge-on.
const MIN_TURN_WIDTH = 0.08;

// { length, wingRatio, wingAngle, wingSquash, bob, facing, pitch } for a projected moth at
// scene time animationTime:
//   length     body length in pixels, scaling the whole sprite;
//   wingRatio  wing length as a multiple of body length (narrow to broad);
//   wingAngle  the near wing's elevation in radians (swinging between
//              WING_DOWN_ANGLE and WING_UP_ANGLE as it flaps);
//   wingSquash sin(wingAngle): the wing's height as a fraction of full, with
//              the sign saying which side of the body — +1 fully raised, 0
//              squashed flat against the body, negative hanging below it;
//   bob        how far the body is displaced down at this instant, as a
//              fraction of its length (negative = up);
//   facing     -1..+1: +1 fully facing right (travelling right on screen),
//              -1 fully facing left, and in between while it's turning, with 0
//              exactly edge-on. The sprite is squeezed by this, and mirrored
//              below zero — never upside down, since the view is side-on;
//   pitch      radians of nose-down tilt, from how steeply it's climbing or
//              diving (positive = diving).
// Facing and pitch come from the moth's own trail (recent positions); it
// faces right and level until it has moved.
function getMothSprite(moth, animationTime) {
  const seed = moth.noiseSeed || 0;
  const length = MOTH_LENGTH_BASE + moth.size * MOTH_LENGTH_PER_SIZE;
  const wingRatio = WING_RATIO_MIN + (WING_RATIO_MAX - WING_RATIO_MIN) * seededUnit(seed, 57);
  const frequency = FLAP_MIN_HZ + (FLAP_MAX_HZ - FLAP_MIN_HZ) * seededUnit(seed, 55);
  const phase = seededUnit(seed, 56);
  const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * (frequency * animationTime + phase));
  const wingAngle = WING_DOWN_ANGLE + (WING_UP_ANGLE - WING_DOWN_ANGLE) * wave;
  const wingSquash = Math.sin(wingAngle);
  const bob = (wave - 0.5) * 2 * BOB_AMPLITUDE;

  let facing = 1;
  let pitch = 0;
  const trail = moth.trail;
  if (trail && trail.length >= 2) {
    // A few samples back rather than the very last two, so tiny frame-to-frame
    // wobble doesn't make the moth flip or twitch.
    const from = trail[Math.max(0, trail.length - 4)];
    const to = trail[trail.length - 1];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const turned = Math.max(-1, Math.min(1, dx / TURN_FULL_TRAVEL));
    facing = Math.sign(turned) * easeInOut(Math.abs(turned));
    if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.atan2(dy, Math.abs(dx))));
    }
  }

  return { length, wingRatio, wingAngle, wingSquash, bob, facing, pitch };
}

// A forewing, from its shoulder at the origin, pointing along local +x. The
// leading edge (local +y side) is nearly straight, the tip rounded, and the
// trailing edge (local -y side) a convex sweep back to the body. wingLength is
// the shoulder-to-tip length.
function traceForewing(context, wingLength) {
  context.beginPath();
  context.moveTo(0, wingLength * 0.02);
  context.quadraticCurveTo(wingLength * 0.5, wingLength * 0.1, wingLength * 0.98, wingLength * 0.02);
  context.bezierCurveTo(wingLength * 1.04, -wingLength * 0.1, wingLength * 0.95, -wingLength * 0.38, wingLength * 0.62, -wingLength * 0.52);
  context.quadraticCurveTo(wingLength * 0.25, -wingLength * 0.48, 0, -wingLength * 0.1);
  context.closePath();
}

// A smaller, rounded hindwing, on the same axes.
function traceHindwing(context, wingLength) {
  context.beginPath();
  context.moveTo(0, -wingLength * 0.02);
  context.bezierCurveTo(wingLength * 0.3, wingLength * 0.05, wingLength * 0.75, -wingLength * 0.05, wingLength * 0.72, -wingLength * 0.3);
  context.bezierCurveTo(wingLength * 0.6, -wingLength * 0.5, wingLength * 0.2, -wingLength * 0.42, 0, -wingLength * 0.1);
  context.closePath();
}

// Both wings of one side (forewing and, lower and further back, hindwing),
// folding about the shoulder: squash is the wing's height as a fraction of
// full (+1 fully raised, 0 flat against the body, negative hanging below it),
// applied as a vertical scale after the wing is laid out along its raised
// axis — so it flattens and re-opens rather than rotating.
// hindwingLag is how much further down/back the hindwing sits than the
// forewing at any moment, in radians.
function fillWingPair(context, wingLength, squash) {
  const hindwingLag = 0.5;
  const thickness = (squash < 0 ? -1 : 1) * Math.max(MIN_WING_THICKNESS, Math.abs(squash));
  context.save();
  // Vertical squash (negative = flipped below the body), then lay the wing out
  // along its raised axis: local +x points back and (nearly) up.
  context.scale(1, thickness);
  context.rotate(Math.PI + WING_AXIS_ANGLE);
  traceHindwingAt(context, wingLength, hindwingLag);
  traceForewing(context, wingLength);
  context.fill();
  // Fine edge and veins, so the wing reads as a wing and not a leaf.
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(255, 255, 255, 0.4)";
  context.lineWidth = 0.9;
  context.stroke();
  context.strokeStyle = "rgba(255, 255, 255, 0.2)";
  context.lineWidth = 0.7;
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(wingLength * 0.9, -wingLength * 0.16);
  context.moveTo(0, -wingLength * 0.04);
  context.lineTo(wingLength * 0.68, -wingLength * 0.44);
  context.stroke();
  context.restore();
}

// Fills the hindwing (rotated lag radians further back than the forewing) —
// split out so fillWingPair keeps the forewing's path current for its outline.
function traceHindwingAt(context, wingLength, lag) {
  context.save();
  context.rotate(-lag);
  traceHindwing(context, wingLength);
  context.fill();
  context.restore();
}

function drawMoth(context, moth, state = "normal", animationTime = 0) {
  if (moth.opacity <= 0.01) {
    return;
  }

  const dimFactor = state === "dimmed" ? 0.24 : 1;
  const focusFactor = state === "focused" ? 1.18 : 1;
  const opacityFactor = state === "focused" ? 1 : moth.opacity;
  const sprite = getMothSprite(moth, animationTime);
  const length = sprite.length * focusFactor;
  const wingLength = length * sprite.wingRatio;
  const baseAlpha = opacityFactor * dimFactor;

  context.save();
  context.translate(moth.x, moth.y + sprite.bob * length);
  // Squeeze horizontally while turning and mirror to face left when travelling
  // left (the sprite is drawn facing right), then tilt: nose-up for flight,
  // plus the climb or dive.
  context.scale((sprite.facing < 0 ? -1 : 1) * Math.max(MIN_TURN_WIDTH, Math.abs(sprite.facing)), 1);
  context.rotate(sprite.pitch - BODY_TILT);

  // The near wings, in the moth's colour, with the glow. While they hang below
  // the body they're drawn BEFORE it, so the body stays in front of them;
  // otherwise on top.
  const wingsBelow = sprite.wingSquash < 0;
  const drawNearWings = () => {
    context.save();
    context.fillStyle = moth.color;
    context.shadowColor = moth.shadowColor;
    context.shadowBlur = moth.shadowBlur * focusFactor;
    context.globalAlpha = baseAlpha;
    context.translate(length * 0.02, -length * 0.1);
    fillWingPair(context, wingLength, sprite.wingSquash);
    context.restore();
  };

  // The far wings first, behind the body: a little smaller and dimmer, raised
  // a bit higher than the near ones (as they appear in photographs), for depth.
  context.fillStyle = moth.color;
  context.shadowColor = moth.shadowColor;
  context.shadowBlur = moth.shadowBlur * focusFactor * 0.6;
  context.globalAlpha = baseAlpha * 0.55;
  context.save();
  context.translate(length * 0.03, -length * 0.1);
  fillWingPair(context, wingLength * 0.88, Math.sin(sprite.wingAngle + 0.14));
  context.restore();

  if (wingsBelow) {
    drawNearWings();
  }

  // Legs, dangling under the thorax.
  context.shadowBlur = 0;
  context.globalAlpha = baseAlpha * 0.7;
  context.strokeStyle = "rgba(255, 255, 255, 0.65)";
  context.lineWidth = 0.8;
  context.beginPath();
  context.moveTo(length * 0.08, length * 0.1);
  context.lineTo(length * 0.05, length * 0.27);
  context.moveTo(length * 0.0, length * 0.11);
  context.lineTo(length * -0.05, length * 0.28);
  context.moveTo(length * -0.07, length * 0.1);
  context.lineTo(length * -0.12, length * 0.25);
  context.stroke();

  // The abdomen, tapering back and drooping; then the stout, fluffy thorax and
  // small head (a soft glow in the moth's colour stands in for the fuzz).
  context.globalAlpha = baseAlpha * 0.9;
  context.fillStyle = "rgba(255, 246, 228, 0.9)";
  context.beginPath();
  context.moveTo(-length * 0.06, -length * 0.09);
  context.bezierCurveTo(-length * 0.3, -length * 0.14, -length * 0.55, -length * 0.06, -length * 0.66, length * 0.12);
  context.bezierCurveTo(-length * 0.5, length * 0.17, -length * 0.25, length * 0.16, -length * 0.06, length * 0.11);
  context.closePath();
  context.fill();
  // Faint bands across it, as on the banded abdomens in photographs.
  context.strokeStyle = "rgba(40, 25, 10, 0.3)";
  context.lineWidth = 1;
  context.beginPath();
  [0.2, 0.32, 0.44].forEach((along) => {
    const centre = along * 0.28;
    context.moveTo(-length * along, -length * (0.11 - centre * 0.1));
    context.lineTo(-length * (along + 0.02), length * (0.13 + centre * 0.1));
  });
  context.stroke();
  context.shadowColor = moth.color;
  context.shadowBlur = 4;
  context.beginPath();
  context.ellipse(length * 0.02, 0, length * 0.2, length * 0.14, 0, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(length * 0.25, -length * 0.02, length * 0.075, 0, Math.PI * 2);
  context.fill();

  // Feathery antennae, in a V pointing forward and up.
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(255, 255, 255, 0.7)";
  context.lineWidth = 0.9;
  context.beginPath();
  context.moveTo(length * 0.28, -length * 0.07);
  context.quadraticCurveTo(length * 0.44, -length * 0.22, length * 0.56, -length * 0.17);
  context.moveTo(length * 0.26, -length * 0.08);
  context.quadraticCurveTo(length * 0.3, -length * 0.3, length * 0.42, -length * 0.36);
  context.stroke();

  if (!wingsBelow) {
    drawNearWings();
  }
  context.restore();

  if (state === "focused") {
    context.save();
    context.globalAlpha = Math.min(0.55, moth.opacity * 0.5);
    context.strokeStyle = colorWithAlpha(moth.color, 0.55);
    context.lineWidth = 1.2;
    context.beginPath();
    context.arc(moth.x, moth.y, Math.max(moth.size * 2.2, length * 0.9), 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

function drawEntryLabels(context, moths, animationTime, width, height) {
  if (config.animation.speciesTag !== true) {
    return;
  }

  const activeLabels = moths
    .map((moth) => {
      const labelDuration = config.animation.speciesTagDuration;
      const age = animationTime - moth.entryTime;
      if (age < 0 || age > labelDuration) {
        return null;
      }

      const fadeInDuration = Math.min(0.8, labelDuration * 0.25);
      const fadeOutDuration = Math.min(2.1, labelDuration * 0.38);
      const fadeOutStart = Math.max(fadeInDuration, labelDuration - fadeOutDuration);
      const fadeIn = easeInOut(Math.min(1, age / fadeInDuration));
      const fadeOut = 1 - easeInOut(Math.max(0, (age - fadeOutStart) / fadeOutDuration));
      return {
        alpha: Math.max(0, Math.min(1, fadeIn * fadeOut)),
        color: config.animation.speciesTagColor || moth.color,
        entryTime: moth.entryTime,
        id: moth.id,
        label: moth.speciesName || moth.label
      };
    })
    .filter((label) => label && label.alpha > 0.02)
    .sort((a, b) => a.entryTime - b.entryTime);

  if (activeLabels.length === 0) {
    return;
  }

  context.save();
  const descriptionElement = document.querySelector(".animation-heading p");
  const descriptionStyle = descriptionElement ? window.getComputedStyle(descriptionElement) : null;
  const tagSize = descriptionStyle ? parseFloat(descriptionStyle.fontSize) : Math.max(1, config.animation.speciesTagSize);
  context.font = "400 " + tagSize + "px Inter, system-ui, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";

  const labelX = Math.max(24, width * 0.08);
  const rowHeight = Math.max(18, tagSize * 1.65);
  const glowTopY = height * config.scene.centerYRatio - config.light.glowRadius - 18;
  const topPadding = 84;
  const bottomPadding = 74;
  const minBottomY = topPadding + (activeLabels.length - 1) * rowHeight;
  const maxBottomY = height - bottomPadding;
  const bottomY = Math.max(minBottomY, Math.min(maxBottomY, glowTopY));
  const firstY = bottomY - (activeLabels.length - 1) * rowHeight;

  activeLabels.forEach((label, index) => {
    const y = firstY + index * rowHeight;
    const alpha = label.alpha * 0.9;

    context.globalAlpha = alpha;
    context.fillStyle = colorWithAlpha(label.color, 0.95);
    context.fillText(label.label, labelX, y);
  });

  context.restore();
}

function drawGround(context, width, height, cx, cy) {
  const horizonY = Math.max(0, Math.min(height, height * config.scene.horizonYRatio));

  context.fillStyle = config.animation.backgroundColor;
  context.fillRect(0, 0, width, height);

  if (!config.scene.showGround) {
    return;
  }

  const groundGradient = context.createLinearGradient(0, horizonY, 0, height);
  groundGradient.addColorStop(0, config.scene.groundBackColor);
  groundGradient.addColorStop(0.58, config.scene.groundMidColor);
  groundGradient.addColorStop(1, config.scene.groundFrontColor);
  context.fillStyle = groundGradient;
  context.fillRect(0, horizonY, width, height - horizonY);

  context.save();
  context.strokeStyle = "rgba(255, 244, 201, 0.06)";
  context.lineWidth = 1;
  for (let index = 0; index < 9; index += 1) {
    const y = cy + 28 + index * index * 5.2;
    if (y >= height) {
      break;
    }
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.restore();

  context.save();
  context.translate(cx, cy);
  context.scale(1, config.scene.orbitTilt * 1.35);
  const poolGradient = context.createRadialGradient(0, 0, 0, 0, 0, config.scene.lightPoolRadius);
  poolGradient.addColorStop(0, config.scene.lightPoolColor);
  poolGradient.addColorStop(0.45, "rgba(255, 244, 201, 0.12)");
  poolGradient.addColorStop(1, "rgba(255, 244, 201, 0)");
  context.fillStyle = poolGradient;
  context.beginPath();
  context.arc(0, 0, config.scene.lightPoolRadius, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function lightFlicker(elapsed) {
  const wave = Math.sin(elapsed * config.light.flickerSpeed) * 0.5 + 0.5;
  const shimmer = Math.sin(elapsed * config.light.flickerSpeed * 2.7 + 1.8) * 0.5 + 0.5;
  return wave * 0.72 + shimmer * 0.28;
}

function drawRoundedRect(context, x, y, width, height, radius) {
  const corner = Math.min(radius, width * 0.5, height * 0.5);
  context.beginPath();
  context.moveTo(x + corner, y);
  context.lineTo(x + width - corner, y);
  context.quadraticCurveTo(x + width, y, x + width, y + corner);
  context.lineTo(x + width, y + height - corner);
  context.quadraticCurveTo(x + width, y + height, x + width - corner, y + height);
  context.lineTo(x + corner, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - corner);
  context.lineTo(x, y + corner);
  context.quadraticCurveTo(x, y, x + corner, y);
}

function drawLightFixture(context, cx, cy) {
  const bulbDiameter = config.light.size * 2;
  const fixtureWidth = bulbDiameter / 3;
  const fixtureHeight = bulbDiameter / 2;
  const fixtureX = cx - fixtureWidth * 0.5;
  const fixtureY = cy - config.light.size - fixtureHeight * 0.8;
  const cableBottom = fixtureY + 3;
  const cableTop = 0;
  const cableGradient = context.createLinearGradient(cx, cableBottom, cx, Math.max(cableTop, cableBottom * 0.5));

  cableGradient.addColorStop(0, "rgba(82, 82, 82, 0.72)");
  cableGradient.addColorStop(0.5, "rgba(0, 0, 0, 0.82)");
  cableGradient.addColorStop(1, "rgba(0, 0, 0, 0)");

  context.save();
  context.strokeStyle = cableGradient;
  context.lineCap = "round";
  context.lineWidth = Math.max(2, config.light.size * 0.22);
  context.beginPath();
  context.moveTo(cx, cableBottom);
  context.lineTo(cx, cableTop);
  context.stroke();
  context.restore();

  const fixtureGradient = context.createLinearGradient(fixtureX, fixtureY, fixtureX + fixtureWidth, fixtureY);
  fixtureGradient.addColorStop(0, "#575757");
  fixtureGradient.addColorStop(0.5, "#151515");
  fixtureGradient.addColorStop(1, "#1e1e1e");

  context.save();
  context.fillStyle = fixtureGradient;
  context.shadowColor = "rgba(0, 0, 0, 0.46)";
  context.shadowBlur = 8;
  drawRoundedRect(context, fixtureX, fixtureY, fixtureWidth, fixtureHeight, Math.max(2, fixtureWidth * 0.3));
  context.fill();
  context.strokeStyle = "rgba(95, 95, 95, 0.42)";
  context.lineWidth = 1;
  context.stroke();
  context.restore();
}

// Always the same subtle ambient shimmer — there's deliberately no separate
// "loading" look here any more (an earlier version sputtered the light like a
// failing bulb while data loaded). The loading state is a greyed-out scene
// with a central spinner instead, done in CSS/DOM (see .is-loading in
// styles/main.css), so the light itself never flashes.
function drawLight(context, cx, cy, elapsed) {
  const flicker = lightFlicker(elapsed);
  const flickerStrength = Math.max(0, config.light.flickerStrength);
  const glowPulse = 1 - flickerStrength + flicker * flickerStrength * 2;
  const glowRadius = config.light.glowRadius * (1 - flickerStrength * 0.7 + flicker * flickerStrength * 1.4);

  context.save();
  context.globalAlpha = Math.max(0.35, Math.min(1, glowPulse));
  const halo = context.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
  halo.addColorStop(0, config.light.glowColor);
  halo.addColorStop(0.28, config.light.haloColor);
  halo.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = halo;
  context.beginPath();
  context.arc(cx, cy, glowRadius, 0, Math.PI * 2);
  context.fill();
  context.restore();

  drawLightFixture(context, cx, cy);

  context.save();
  context.globalAlpha = 1;
  context.fillStyle = config.light.color;
  context.shadowColor = config.light.glowColor;
  context.shadowBlur = config.light.shadowBlur;
  context.beginPath();
  context.arc(cx, cy, config.light.size, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function wrapTextLines(context, text, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  words.forEach((word) => {
    const testLine = line ? line + " " + word : word;
    if (line && context.measureText(testLine).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  });

  if (line) {
    lines.push(line);
  }

  // A single word wider than the column (a long name, a long unbroken
  // attribution) can't be wrapped, so it's cut short with an ellipsis rather
  // than spilling out of whatever box it's drawn in.
  return lines.map((text) => {
    if (context.measureText(text).width <= maxWidth) {
      return text;
    }
    let cut = text;
    while (cut.length > 1 && context.measureText(cut + "…").width > maxWidth) {
      cut = cut.slice(0, -1);
    }
    return cut + "…";
  });
}

function drawCoverImage(context, image, x, y, width, height) {
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = image.naturalWidth;
  let sourceHeight = image.naturalHeight;

  if (imageRatio > targetRatio) {
    sourceWidth = image.naturalHeight * targetRatio;
    sourceX = (image.naturalWidth - sourceWidth) * 0.5;
  } else {
    sourceHeight = image.naturalWidth / targetRatio;
    sourceY = (image.naturalHeight - sourceHeight) * 0.5;
  }

  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

// "Identified to family" — the record's own taxonomic resolution, so a moth
// that iNaturalist could only place at genus or family level says exactly
// that instead of implying a species. Shared by the pop-out and the cards.
function formatIdentification(moth) {
  return moth.taxonRank ? `Identified to ${moth.taxonRank}` : "";
}

// The short facts under a moth's name, one per line, shared by the pop-out
// and (built separately in app.js from the same helpers) the cards. entryTime/
// exitTime are seconds on the animation's own clock — a monotonic
// performance.now()-based clock for live moths, with no fixed relationship to
// a calendar time — so the real upload time (see observation-time.js) is what
// gets shown; the old entryTime/exitTime range remains the fallback for moths
// that don't carry it (e.g. the static demo config's fixed timeline).
function formatPopoutDetails(moth) {
  const lines = [formatUploadedTime(moth), formatIdentification(moth)].filter(Boolean);
  return lines.length > 0 ? lines : [formatClockTime(moth.entryTime) + " - " + formatClockTime(moth.exitTime)];
}

// "CC-BY-NC · A. Person" — the license code and the photographer's
// attribution. Only present when the adapter confirmed a licensed, attributed
// photo (see observation-adapter.js) — an image without both is never shown
// at all. Shared by the hover pop-out and the side-panel cards.
function formatPhotoCredit(moth) {
  return moth.imageAttribution
    ? [moth.imageLicense ? moth.imageLicense.toUpperCase() : null, moth.imageAttribution].filter(Boolean).join(" · ")
    : "";
}

// rightInset: how much of the canvas's right edge something else (the open
// side panel) covers, so the pop-out stays clear of it instead of sliding
// underneath.
function drawHoverPopout(context, moth, width, height, animationTime, imageCache, rightInset = 0) {
  if (!moth) {
    return;
  }

  const descriptionElement = document.querySelector(".animation-heading p");
  const descriptionStyle = descriptionElement ? window.getComputedStyle(descriptionElement) : null;
  const fontSize = descriptionStyle ? parseFloat(descriptionStyle.fontSize) : 15;
  const speciesName = moth.speciesName || moth.label || moth.species || moth.id;
  const detailTexts = formatPopoutDetails(moth);
  const usableWidth = width - Math.max(0, rightInset);
  const paddingX = 12;
  const paddingY = 9;
  const gap = 7;
  const titleFont = "600 " + Math.max(12, fontSize) + "px Inter, system-ui, sans-serif";
  const detailFont = "400 " + Math.max(11, fontSize * 0.82) + "px Inter, system-ui, sans-serif";
  const descriptionFont = "400 " + Math.max(10.5, fontSize * 0.78) + "px Inter, system-ui, sans-serif";
  const attributionFont = "400 " + Math.max(9.5, fontSize * 0.68) + "px Inter, system-ui, sans-serif";
  const imageRecord = imageCache && moth.imageURL ? imageCache.get(moth.imageURL) : null;
  const hasImage = imageRecord && imageRecord.loaded && imageRecord.image;
  const imageWidth = hasImage ? 92 : 0;
  const imageHeight = hasImage ? 72 : 0;
  const textWidth = 188;
  const description = moth.speciesDescription || "";
  const attributionText = formatPhotoCredit(moth);

  // Every piece of text is wrapped (or, for a single over-long word,
  // truncated) to the same fixed column, and the box is sized from that
  // column plus the photo beside it — never from how wide a line happened to
  // measure. Sizing the box from a raw line width (as this once did) let a
  // long name or detail line run out past the box's right edge, since text
  // starts to the right of the photo.
  context.save();
  const wrap = (text, font) => {
    context.font = font;
    return wrapTextLines(context, text, textWidth);
  };
  const titleLines = wrap(speciesName, titleFont);
  const detailLines = detailTexts.flatMap((text) => wrap(text, detailFont));
  const descriptionLines = wrap(description, descriptionFont);
  const attributionLines = attributionText ? wrap(attributionText, attributionFont) : [];

  const titleLineHeight = fontSize * 1.1;
  const detailLineHeight = fontSize * 0.82 * 1.2;
  const descriptionLineHeight = fontSize * 1.05;
  const attributionLineHeight = fontSize * 0.68 * 1.15;
  const detailBlockHeight = detailLines.length > 0 ? gap + detailLines.length * detailLineHeight : 0;
  const descriptionBlockHeight = descriptionLines.length > 0 ? gap + descriptionLines.length * descriptionLineHeight : 0;
  const attributionBlockHeight = attributionLines.length > 0 ? gap + attributionLines.length * attributionLineHeight : 0;

  const contentGap = hasImage ? 10 : 0;
  const bodyWidth = imageWidth + contentGap + textWidth;
  const textBlockHeight = titleLines.length * titleLineHeight + detailBlockHeight + descriptionBlockHeight + attributionBlockHeight;
  const bodyHeight = Math.max(imageHeight, textBlockHeight);
  const boxWidth = Math.ceil(bodyWidth + paddingX * 2);
  const boxHeight = Math.ceil(bodyHeight + paddingY * 2);
  const offset = Math.max(20, moth.size * 3.2);
  let x = moth.x + offset;
  let y = moth.y - boxHeight - offset * 0.42;

  if (x + boxWidth > usableWidth - 12) {
    x = moth.x - boxWidth - offset;
  }

  x = Math.max(12, Math.min(usableWidth - boxWidth - 12, x));
  y = Math.max(12, Math.min(height - boxHeight - 68, y));

  context.fillStyle = "rgba(8, 8, 10, 0.72)";
  context.strokeStyle = colorWithAlpha(moth.color, 0.42);
  context.lineWidth = 1;
  drawRoundedRect(context, x, y, boxWidth, boxHeight, 8);
  context.fill();
  context.stroke();

  const boxCenterX = x + boxWidth * 0.5;
  const boxCenterY = y + boxHeight * 0.5;
  const deltaX = moth.x - boxCenterX;
  const deltaY = moth.y - boxCenterY;
  let lineX = boxCenterX;
  let lineY = boxCenterY;

  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    lineX = deltaX > 0 ? x + boxWidth : x;
    lineY = boxCenterY + (boxWidth * 0.5) * (deltaY / Math.abs(deltaX));
  } else {
    lineY = deltaY > 0 ? y + boxHeight : y;
    lineX = boxCenterX + (boxHeight * 0.5) * (deltaX / Math.abs(deltaY || 1));
  }

  lineX = Math.max(x, Math.min(x + boxWidth, lineX));
  lineY = Math.max(y, Math.min(y + boxHeight, lineY));

  context.strokeStyle = colorWithAlpha(moth.color, 0.72);
  context.lineWidth = 1.5;
  context.setLineDash([4, 3]);
  context.beginPath();
  context.moveTo(moth.x, moth.y);
  context.lineTo(lineX, lineY);
  context.stroke();
  context.setLineDash([]);

  context.textAlign = "left";
  context.textBaseline = "top";

  const contentX = x + paddingX;
  const contentY = y + paddingY;
  const textX = contentX + imageWidth + contentGap;

  if (hasImage) {
    context.save();
    drawRoundedRect(context, contentX, contentY, imageWidth, imageHeight, 6);
    context.clip();
    drawCoverImage(context, imageRecord.image, contentX, contentY, imageWidth, imageHeight);
    context.restore();
    context.strokeStyle = "rgba(255, 255, 255, 0.16)";
    context.lineWidth = 1;
    drawRoundedRect(context, contentX, contentY, imageWidth, imageHeight, 6);
    context.stroke();
  }

  context.font = titleFont;
  context.fillStyle = colorWithAlpha(moth.color, 0.96);
  titleLines.forEach((line, index) => {
    context.fillText(line, textX, contentY + index * titleLineHeight);
  });
  let cursorY = contentY + titleLines.length * titleLineHeight;

  if (detailLines.length > 0) {
    cursorY += gap;
    context.font = detailFont;
    context.fillStyle = "rgba(255, 255, 255, 0.72)";
    detailLines.forEach((line, index) => {
      context.fillText(line, textX, cursorY + index * detailLineHeight);
    });
    cursorY += detailLines.length * detailLineHeight;
  }

  if (descriptionLines.length > 0) {
    cursorY += gap;
    context.font = descriptionFont;
    context.fillStyle = "rgba(255, 255, 255, 0.68)";
    descriptionLines.forEach((line, index) => {
      context.fillText(line, textX, cursorY + index * descriptionLineHeight);
    });
    cursorY += descriptionLines.length * descriptionLineHeight;
  }

  // Required whenever a licensed photo is shown (inat_website.txt 6.6/8): the
  // license code and the photographer's attribution, e.g. "CC-BY-NC · A.
  // Person". observationUrl is threaded through the moth record too (see
  // moth-store.js) for a future clickable "view on iNaturalist" link — canvas
  // has no native hyperlinks, so that needs its own hit-region/DOM affordance
  // rather than rendering a bare, unclickable URL here.
  if (attributionLines.length > 0) {
    cursorY += gap;
    context.font = attributionFont;
    context.fillStyle = "rgba(255, 255, 255, 0.5)";
    attributionLines.forEach((line, index) => {
      context.fillText(line, textX, cursorY + index * attributionLineHeight);
    });
  }

  context.restore();
}

function getMothDrawState(moth, hoverState) {
  if (!hoverState || !hoverState.hoveredMothId) {
    return "normal";
  }

  return moth.id === hoverState.hoveredMothId ? "focused" : "dimmed";
}

function drawProjectedMothLayer(context, moths, hoverState, lightX, lightY, width, height, animationTime) {
  moths.forEach((moth) => {
    const state = getMothDrawState(moth, hoverState);
    drawMothShadow(context, moth, lightX, lightY, width, height, state === "dimmed" ? 0.22 : 1);
  });

  moths.forEach((moth) => {
    const state = getMothDrawState(moth, hoverState);
    drawTrail(context, moth, state === "dimmed" ? 0.18 : 1, state === "focused");
  });

  moths.forEach((moth) => drawMoth(context, moth, getMothDrawState(moth, hoverState), animationTime));
}

function drawScene(context, moths, width, height, elapsed, animationTime, hoverState = null, presentationMode = "normal") {
  context.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height * config.scene.centerYRatio;
  const isLightOnly = presentationMode === "light-only";
  const projectedMoths = moths
    .map((moth) => projectMoth(moth, animationTime, width, height, cx, cy))
    .filter(Boolean)
    .sort((a, b) => a.depth - b.depth);
  const hoveredMoth = !isLightOnly && hoverState && hoverState.hoveredMothId
    ? projectedMoths.find((moth) => moth.id === hoverState.hoveredMothId)
    : null;

  drawGround(context, width, height, cx, cy);
  if (isLightOnly) {
    drawLight(context, cx, cy, elapsed);
    return;
  }

  drawProjectedMothLayer(context, projectedMoths.filter((moth) => moth.depth < 0), hoverState, cx, cy, width, height, animationTime);
  drawLight(context, cx, cy, elapsed);
  drawProjectedMothLayer(context, projectedMoths.filter((moth) => moth.depth >= 0), hoverState, cx, cy, width, height, animationTime);
  drawEntryLabels(context, projectedMoths, animationTime, width, height);
  drawHoverPopout(context, hoveredMoth, width, height, animationTime, hoverState ? hoverState.imageCache : null, hoverState ? hoverState.rightInset : 0);
}

function parseClockTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ""));
  if (!match) {
    return 0;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  return ((hours * 60 + minutes) * 60 + seconds) % 86400;
}

function formatClockTime(animationTime) {
  const startSeconds = parseClockTime(config.animation.startClockTime);
  const totalSeconds = Math.floor(startSeconds + animationTime * 60) % 86400;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
}

function normalizeAnimationTime(animationTime) {
  if (config.animation.loop) {
    return ((animationTime % config.animation.duration) + config.animation.duration) % config.animation.duration;
  }

  return Math.max(0, Math.min(config.animation.duration, animationTime));
}

function clampAnimationTime(animationTime) {
  return Math.max(0, Math.min(config.animation.duration, animationTime));
}

export {
  clampAnimationTime,
  colorWithAlpha,
  createMoths,
  drawScene,
  easeInOut,
  formatClockTime,
  formatIdentification,
  formatPhotoCredit,
  getExitStartTime,
  getMothSprite,
  hashString,
  normalizeAnimationTime,
  projectMoth,
  sampleBiasedApproachAngle,
  seededUnit
};
