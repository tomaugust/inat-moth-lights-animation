import { config } from "./config-store.js";

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
    inclinationDriftSpeed: moth.inclinationDriftSpeed,
    label: moth.label,
    nodeDriftSpeed: moth.nodeDriftSpeed,
    noiseSeed,
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

function projectMoth(moth, animationTime, width, height, cx, cy, includeTrail = true) {
  if (animationTime < moth.entryTime || animationTime > moth.exitTime) {
    return null;
  }

  const orbit = orbitPosition(moth, animationTime, cx, cy);
  const entryDuration = Math.min(6, Math.max(2, (moth.exitTime - moth.entryTime) * 0.22));
  const exitDuration = Math.min(6, Math.max(2, (moth.exitTime - moth.entryTime) * 0.22));
  const exitStart = Math.max(moth.entryTime, moth.exitTime - exitDuration);
  let x = orbit.x;
  let y = orbit.y;
  let phase = "orbiting";

  if (animationTime < moth.entryTime + entryDuration) {
    const progress = easeInOut((animationTime - moth.entryTime) / entryDuration);
    const start = pointBeyondCanvas(
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
    const end = pointBeyondCanvas(
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
    opacity *= easeInOut((animationTime - moth.entryTime) / entryDuration);
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

function drawMoth(context, moth, state = "normal") {
  if (moth.opacity <= 0.01) {
    return;
  }

  const dimFactor = state === "dimmed" ? 0.24 : 1;
  const focusFactor = state === "focused" ? 1.18 : 1;
  const opacityFactor = state === "focused" ? 1 : moth.opacity;

  context.save();
  context.globalAlpha = opacityFactor * dimFactor;
  context.fillStyle = moth.color;
  context.shadowColor = moth.shadowColor;
  context.shadowBlur = moth.shadowBlur * focusFactor;
  context.beginPath();
  context.arc(moth.x, moth.y, moth.size * focusFactor, 0, Math.PI * 2);
  context.fill();
  context.restore();

  if (state === "focused") {
    context.save();
    context.globalAlpha = Math.min(0.55, moth.opacity * 0.5);
    context.strokeStyle = colorWithAlpha(moth.color, 0.55);
    context.lineWidth = 1.2;
    context.beginPath();
    context.arc(moth.x, moth.y, moth.size * 2.2, 0, Math.PI * 2);
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
      if (moth.species === "unknown") {
        return null;
      }

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

  return lines;
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

function drawHoverPopout(context, moth, width, height, animationTime, imageCache) {
  if (!moth) {
    return;
  }

  const descriptionElement = document.querySelector(".animation-heading p");
  const descriptionStyle = descriptionElement ? window.getComputedStyle(descriptionElement) : null;
  const fontSize = descriptionStyle ? parseFloat(descriptionStyle.fontSize) : 15;
  const speciesName = moth.speciesName || moth.label || moth.species || moth.id;
  const activeRange = formatClockTime(moth.entryTime) + " - " + formatClockTime(moth.exitTime);
  const paddingX = 12;
  const paddingY = 9;
  const gap = 7;
  const titleFont = "600 " + Math.max(12, fontSize) + "px Inter, system-ui, sans-serif";
  const detailFont = "400 " + Math.max(11, fontSize * 0.82) + "px Inter, system-ui, sans-serif";
  const descriptionFont = "400 " + Math.max(10.5, fontSize * 0.78) + "px Inter, system-ui, sans-serif";
  const imageRecord = imageCache && moth.imageURL ? imageCache.get(moth.imageURL) : null;
  const hasImage = imageRecord && imageRecord.loaded && imageRecord.image;
  const imageWidth = hasImage ? 92 : 0;
  const imageHeight = hasImage ? 72 : 0;
  const textWidth = 188;
  const description = moth.speciesDescription || "";

  context.save();
  context.font = titleFont;
  const titleWidth = context.measureText(speciesName).width;
  context.font = detailFont;
  const detailWidth = context.measureText(activeRange).width;
  context.font = descriptionFont;
  const descriptionLines = wrapTextLines(context, description, textWidth);

  const contentGap = hasImage ? 10 : 0;
  const bodyWidth = imageWidth + contentGap + textWidth;
  const textBlockHeight = fontSize + gap + fontSize * 0.82 + (descriptionLines.length > 0 ? gap + descriptionLines.length * fontSize * 1.05 : 0);
  const bodyHeight = Math.max(imageHeight, textBlockHeight);
  const boxWidth = Math.ceil(Math.max(titleWidth, detailWidth, bodyWidth) + paddingX * 2);
  const boxHeight = Math.ceil(bodyHeight + paddingY * 2);
  const offset = Math.max(20, moth.size * 3.2);
  let x = moth.x + offset;
  let y = moth.y - boxHeight - offset * 0.42;

  if (x + boxWidth > width - 12) {
    x = moth.x - boxWidth - offset;
  }

  x = Math.max(12, Math.min(width - boxWidth - 12, x));
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
  context.fillText(speciesName, textX, contentY);
  context.font = detailFont;
  context.fillStyle = "rgba(255, 255, 255, 0.72)";
  context.fillText(activeRange, textX, contentY + fontSize + gap);

  if (descriptionLines.length > 0) {
    context.font = descriptionFont;
    context.fillStyle = "rgba(255, 255, 255, 0.68)";
    descriptionLines.forEach((line, index) => {
      context.fillText(line, textX, contentY + fontSize + gap + fontSize * 0.82 + gap + index * fontSize * 1.05);
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

function drawProjectedMothLayer(context, moths, hoverState, lightX, lightY, width, height) {
  moths.forEach((moth) => {
    const state = getMothDrawState(moth, hoverState);
    drawMothShadow(context, moth, lightX, lightY, width, height, state === "dimmed" ? 0.22 : 1);
  });

  moths.forEach((moth) => {
    const state = getMothDrawState(moth, hoverState);
    drawTrail(context, moth, state === "dimmed" ? 0.18 : 1, state === "focused");
  });

  moths.forEach((moth) => drawMoth(context, moth, getMothDrawState(moth, hoverState)));
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

  drawProjectedMothLayer(context, projectedMoths.filter((moth) => moth.depth < 0), hoverState, cx, cy, width, height);
  drawLight(context, cx, cy, elapsed);
  drawProjectedMothLayer(context, projectedMoths.filter((moth) => moth.depth >= 0), hoverState, cx, cy, width, height);
  drawEntryLabels(context, projectedMoths, animationTime, width, height);
  drawHoverPopout(context, hoveredMoth, width, height, animationTime, hoverState ? hoverState.imageCache : null);
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
  createMoths,
  drawScene,
  formatClockTime,
  normalizeAnimationTime,
  projectMoth,
  seededUnit
};
