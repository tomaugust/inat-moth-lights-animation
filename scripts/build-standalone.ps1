param(
  [string]$ConfigPath = "public\example-config.json",
  [string]$OutputPath = "index.html"
)

$ErrorActionPreference = "Stop"

function Resolve-ProjectPath {
  param([string]$Path)

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }

  return Join-Path (Get-Location) $Path
}

function Get-ConfigValue {
  param(
    [object]$Object,
    [string]$Name,
    [object]$Default
  )

  if ($null -eq $Object) {
    return $Default
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Default
  }

  return $property.Value
}

function ConvertTo-PositiveNumber {
  param(
    [object]$Value,
    [double]$Default,
    [double]$Minimum
  )

  try {
    $number = [double]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture)
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
      return $Default
    }

    return [Math]::Max($Minimum, $number)
  } catch {
    return $Default
  }
}

function ConvertTo-HtmlText {
  param([string]$Value)
  return [System.Net.WebUtility]::HtmlEncode($Value)
}

function Read-AnimationConfig {
  param([string]$Path)

  $resolvedPath = Resolve-ProjectPath $Path
  if (-not (Test-Path -LiteralPath $resolvedPath)) {
    throw "JSON config file not found: $resolvedPath"
  }

  $rawConfig = Get-Content -Raw -LiteralPath $resolvedPath | ConvertFrom-Json
  $animation = Get-ConfigValue $rawConfig "animation" ([pscustomobject]@{})
  $light = Get-ConfigValue $rawConfig "light" (Get-ConfigValue $rawConfig "centerDot" ([pscustomobject]@{}))
  $scene = Get-ConfigValue $rawConfig "scene" ([pscustomobject]@{})
  $species = @(Get-ConfigValue $rawConfig "species" @())
  $moths = @(Get-ConfigValue $rawConfig "moths" @())

  if ($species.Count -lt 1) {
    throw "JSON config must contain at least one species in the species array."
  }

  if ($moths.Count -lt 1) {
    throw "JSON config must contain at least one moth in the moths array."
  }

  $speciesById = @{}
  $normalizedSpecies = @()
  foreach ($speciesRecord in $species) {
    $speciesId = [string](Get-ConfigValue $speciesRecord "id" "")
    if ([string]::IsNullOrWhiteSpace($speciesId)) {
      throw "Every species must have a non-empty id."
    }

    $normalized = @{
      chimeNote = [string](Get-ConfigValue $speciesRecord "chimeNote" "")
      color = [string](Get-ConfigValue $speciesRecord "color" "#000000")
      erraticness = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "erraticness" 0) 0 0
      id = $speciesId
      name = [string](Get-ConfigValue $speciesRecord "name" $speciesId)
      shadowBlur = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "shadowBlur" 12) 12 0
      shadowColor = [string](Get-ConfigValue $speciesRecord "shadowColor" "rgba(255, 255, 255, 0.12)")
      size = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "size" 10) 10 2
      speed = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "speed" 1) 1 0.01
      trailLength = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "trailLength" 18) 18 1
    }
    $speciesById[$speciesId] = $normalized
    $normalizedSpecies += $normalized
  }

  $normalizedMoths = @()
  for ($index = 0; $index -lt $moths.Count; $index++) {
    $moth = $moths[$index]
    $speciesId = [string](Get-ConfigValue $moth "species" "")
    if (-not $speciesById.ContainsKey($speciesId)) {
      throw "Moth '$([string](Get-ConfigValue $moth "id" $index))' references unknown species '$speciesId'."
    }

    $speciesDefaults = $speciesById[$speciesId]
    $defaultEntryTime = [Math]::Min($index * 4, 20)
    $entryTime = ConvertTo-PositiveNumber (Get-ConfigValue $moth "entryTime" $defaultEntryTime) $defaultEntryTime 0
    $exitTime = ConvertTo-PositiveNumber (Get-ConfigValue $moth "exitTime" ($entryTime + 40)) ($entryTime + 40) $entryTime
    $normalizedMoths += @{
      angle = ConvertTo-PositiveNumber (Get-ConfigValue $moth "angle" (($index * 360) / $moths.Count)) (($index * 360) / $moths.Count) 0
      chimeNote = [string](Get-ConfigValue $moth "chimeNote" $speciesDefaults.chimeNote)
      color = [string](Get-ConfigValue $moth "color" $speciesDefaults.color)
      entryTime = $entryTime
      erraticness = ConvertTo-PositiveNumber (Get-ConfigValue $moth "erraticness" $speciesDefaults.erraticness) $speciesDefaults.erraticness 0
      exitTime = $exitTime
      id = [string](Get-ConfigValue $moth "id" "moth-$($index + 1)")
      label = [string](Get-ConfigValue $moth "label" $speciesDefaults.name)
      radius = ConvertTo-PositiveNumber (Get-ConfigValue $moth "radius" 0) 0 0
      shadowBlur = ConvertTo-PositiveNumber (Get-ConfigValue $moth "shadowBlur" $speciesDefaults.shadowBlur) $speciesDefaults.shadowBlur 0
      shadowColor = [string](Get-ConfigValue $moth "shadowColor" $speciesDefaults.shadowColor)
      size = ConvertTo-PositiveNumber (Get-ConfigValue $moth "size" $speciesDefaults.size) $speciesDefaults.size 2
      species = $speciesId
      speciesName = $speciesDefaults.name
      speed = ConvertTo-PositiveNumber (Get-ConfigValue $moth "speed" $speciesDefaults.speed) $speciesDefaults.speed 0.01
      trailLength = ConvertTo-PositiveNumber (Get-ConfigValue $moth "trailLength" $speciesDefaults.trailLength) $speciesDefaults.trailLength 1
    }
  }

  return @{
    animation = @{
      backgroundColor = [string](Get-ConfigValue $animation "backgroundColor" "#121212")
      autoplay = [bool](Get-ConfigValue $animation "autoplay" $true)
      canvasBackground = [string](Get-ConfigValue $animation "canvasBackground" "radial-gradient(circle at center, #1b1b1b 0%, #090909 60%)")
      canvasBorderColor = [string](Get-ConfigValue $animation "canvasBorderColor" "rgba(255, 255, 255, 0.12)")
      description = [string](Get-ConfigValue $animation "description" "This standalone animation was generated from a JSON configuration and can be opened directly from the file.")
      duration = ConvertTo-PositiveNumber (Get-ConfigValue $animation "duration" 80) 80 1
      loop = [bool](Get-ConfigValue $animation "loop" $true)
      playbackSpeed = ConvertTo-PositiveNumber (Get-ConfigValue $animation "playbackSpeed" 1) 1 0.01
      startClockTime = [string](Get-ConfigValue $animation "startClockTime" "22:00")
      textColor = [string](Get-ConfigValue $animation "textColor" "#f5f5f5")
      timeLabel = [string](Get-ConfigValue $animation "timeLabel" "Time")
      title = [string](Get-ConfigValue $animation "title" "Orbit Animation")
    }
    light = @{
      color = [string](Get-ConfigValue $light "color" "#fffdf4")
      flickerSpeed = ConvertTo-PositiveNumber (Get-ConfigValue $light "flickerSpeed" 0.0025) 0.0025 0
      flickerStrength = ConvertTo-PositiveNumber (Get-ConfigValue $light "flickerStrength" 0.06) 0.06 0
      glowColor = [string](Get-ConfigValue $light "glowColor" "rgba(255, 250, 226, 0.8)")
      glowRadius = ConvertTo-PositiveNumber (Get-ConfigValue $light "glowRadius" 150) 150 20
      haloColor = [string](Get-ConfigValue $light "haloColor" "rgba(255, 244, 201, 0.22)")
      shadowBlur = ConvertTo-PositiveNumber (Get-ConfigValue $light "shadowBlur" 36) 36 0
      size = ConvertTo-PositiveNumber (Get-ConfigValue $light "size" 15) 15 2
    }
    moths = $normalizedMoths
    scene = @{
      backgroundMothOpacity = ConvertTo-PositiveNumber (Get-ConfigValue $scene "backgroundMothOpacity" 0.45) 0.45 0
      centerYRatio = ConvertTo-PositiveNumber (Get-ConfigValue $scene "centerYRatio" 0.55) 0.55 0.1
      foregroundMothOpacity = ConvertTo-PositiveNumber (Get-ConfigValue $scene "foregroundMothOpacity" 1) 1 0
      groundBackColor = [string](Get-ConfigValue $scene "groundBackColor" "#07080b")
      groundFrontColor = [string](Get-ConfigValue $scene "groundFrontColor" "#211b14")
      groundMidColor = [string](Get-ConfigValue $scene "groundMidColor" "#14120f")
      horizonYRatio = ConvertTo-PositiveNumber (Get-ConfigValue $scene "horizonYRatio" 0.34) 0.34 0
      lightPoolColor = [string](Get-ConfigValue $scene "lightPoolColor" "rgba(255, 244, 201, 0.3)")
      lightPoolRadius = ConvertTo-PositiveNumber (Get-ConfigValue $scene "lightPoolRadius" 330) 330 40
      orbitTilt = ConvertTo-PositiveNumber (Get-ConfigValue $scene "orbitTilt" 0.3) 0.3 0.05
      showGround = [bool](Get-ConfigValue $scene "showGround" $true)
    }
    species = $normalizedSpecies
  }
}

$config = Read-AnimationConfig $ConfigPath
$configJson = $config | ConvertTo-Json -Compress -Depth 8
$safeTitle = ConvertTo-HtmlText $config.animation.title
$safeDescription = ConvertTo-HtmlText $config.animation.description
$safeBackgroundColor = ConvertTo-HtmlText $config.animation.backgroundColor
$safeTextColor = ConvertTo-HtmlText $config.animation.textColor
$safeCanvasBackground = ConvertTo-HtmlText $config.animation.canvasBackground
$safeCanvasBorderColor = ConvertTo-HtmlText $config.animation.canvasBorderColor

$html = @"
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>$safeTitle</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, system-ui, sans-serif;
        background: $safeBackgroundColor;
        color: $safeTextColor;
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        height: 100%;
        min-height: 100%;
      }

      body {
        background: $safeBackgroundColor;
        color: $safeTextColor;
        overflow: hidden;
      }

      .app-shell {
        height: 100vh;
        min-height: 100vh;
        position: relative;
        width: 100%;
      }

      .canvas-shell {
        height: 100%;
        min-height: 100%;
        position: relative;
      }

      canvas {
        display: block;
        width: 100%;
        height: 100%;
        background: $safeCanvasBackground;
      }

      .animation-heading {
        max-width: min(360px, calc(100vw - 40px));
        pointer-events: none;
        position: absolute;
        right: clamp(18px, 4vw, 48px);
        text-align: right;
        top: clamp(18px, 4vw, 42px);
        z-index: 2;
      }

      .animation-heading h1 {
        font-size: clamp(1.25rem, 2.4vw, 2.35rem);
        font-weight: 650;
        line-height: 1.05;
        margin: 0 0 8px;
      }

      .animation-heading p {
        color: $safeTextColor;
        font-size: clamp(0.78rem, 1.1vw, 0.98rem);
        line-height: 1.35;
        margin: 0;
        opacity: 0.76;
      }

      .timeline-control {
        align-items: center;
        bottom: clamp(14px, 2.4vw, 28px);
        display: grid;
        gap: 12px;
        grid-template-columns: auto minmax(160px, 520px);
        left: 50%;
        max-width: calc(100vw - 32px);
        position: absolute;
        transform: translateX(-50%);
        width: min(620px, calc(100vw - 32px));
        z-index: 2;
      }

      .time-readout {
        font-size: 0.82rem;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0;
        min-width: 4.8rem;
        opacity: 0.82;
        text-align: right;
        white-space: nowrap;
      }

      .timeline-control input[type="range"] {
        accent-color: $safeTextColor;
        cursor: pointer;
        height: 24px;
        width: 100%;
      }

      @media (max-width: 620px) {
        .animation-heading {
          max-width: calc(100vw - 32px);
          right: 16px;
          top: 16px;
        }

        .timeline-control {
          grid-template-columns: 1fr;
          gap: 4px;
        }

        .time-readout {
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <main class="app-shell">
      <section class="canvas-shell" aria-label="Orbit animation">
        <canvas id="orbit-canvas"></canvas>
        <div class="animation-heading" aria-label="Animation details">
          <h1>$safeTitle</h1>
          <p>$safeDescription</p>
        </div>
        <div class="timeline-control" aria-label="Animation timeline">
          <output class="time-readout" id="time-readout">00:00</output>
          <input id="timeline-scrubber" type="range" min="0" max="80" step="0.01" value="0" aria-label="Scrub animation time" />
        </div>
      </section>
    </main>

    <script>
      const config = $configJson;

      function createMoths(config, width, height) {
        const maxMothSize = config.moths.reduce((largest, moth) => Math.max(largest, moth.size), 0);
        const usableRadius = Math.max(32, Math.min(width, height) * 0.48 - maxMothSize - 18);
        const minRadius = Math.min(72, usableRadius);
        const autoStep = config.moths.length > 1 ? Math.max(0, (usableRadius - minRadius) / (config.moths.length - 1)) : 0;

        return config.moths.map((moth, index) => ({
          angle: (moth.angle * Math.PI) / 180,
          chimeNote: moth.chimeNote,
          color: moth.color,
          entryTime: moth.entryTime,
          erraticness: moth.erraticness,
          exitTime: moth.exitTime,
          id: moth.id,
          label: moth.label,
          noiseSeed: hashString(moth.id || moth.species || String(index)),
          radius: moth.radius > 0 ? Math.min(moth.radius, usableRadius) : Math.min(usableRadius, minRadius + index * autoStep),
          shadowBlur: moth.shadowBlur,
          shadowColor: moth.shadowColor,
          size: moth.size,
          species: moth.species,
          speciesName: moth.speciesName,
          speed: moth.speed,
          trailLength: moth.trailLength
        }));
      }

      function easeInOut(value) {
        const t = Math.max(0, Math.min(1, value));
        return t * t * (3 - 2 * t);
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
        const angle = moth.angle + activeTime * moth.speed + angleJitter;
        const radius = Math.max(12, moth.radius + radiusJitter);
        const depth = Math.sin(angle);
        return {
          depth,
          x: cx + Math.cos(angle) * radius,
          y: cy + depth * radius * config.scene.orbitTilt + verticalJitter
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
          const start = {
            x: -moth.size * 4,
            y: orbit.y - height * 0.16
          };
          const point = interpolatePoint(start, orbit, progress);
          x = point.x;
          y = point.y;
          phase = "entering";
        } else if (animationTime > exitStart) {
          const progress = easeInOut((animationTime - exitStart) / exitDuration);
          const end = {
            x: width + moth.size * 4,
            y: orbit.y - height * 0.12
          };
          const point = interpolatePoint(orbit, end, progress);
          x = point.x;
          y = point.y;
          phase = "exiting";
        }

        const depthRatio = (orbit.depth + 1) * 0.5;
        let opacity = config.scene.backgroundMothOpacity +
          (config.scene.foregroundMothOpacity - config.scene.backgroundMothOpacity) * depthRatio;

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
        const sampleCount = Math.max(2, Math.round(moth.trailLength || 2));
        const sampleStep = 0.08;

        for (let index = sampleCount - 1; index >= 0; index -= 1) {
          const sampleTime = animationTime - index * sampleStep;
          const point = projectMoth(moth, sampleTime, width, height, cx, cy, false);
          if (point && point.opacity > 0.01) {
            points.push(point);
          }
        }

        return points;
      }

      function drawTrail(context, moth) {
        if (!moth.trail || moth.trail.length < 2) {
          return;
        }

        const first = moth.trail[0];
        const last = moth.trail[moth.trail.length - 1];
        const trailGradient = context.createLinearGradient(first.x, first.y, last.x, last.y);
        trailGradient.addColorStop(0, "transparent");
        trailGradient.addColorStop(0.28, colorWithAlpha(moth.color, 0.08));
        trailGradient.addColorStop(1, colorWithAlpha(moth.color, Math.min(0.62, last.opacity * 0.62)));

        context.save();
        context.globalAlpha = Math.max(0, Math.min(1, last.opacity));
        context.lineCap = "round";
        context.lineJoin = "round";
        context.strokeStyle = trailGradient;
        context.lineWidth = Math.max(1.2, moth.size * 0.42);
        context.beginPath();
        context.moveTo(first.x, first.y);

        for (let index = 1; index < moth.trail.length - 1; index += 1) {
          const point = moth.trail[index];
          const next = moth.trail[index + 1];
          context.quadraticCurveTo(point.x, point.y, (point.x + next.x) * 0.5, (point.y + next.y) * 0.5);
        }

        context.lineTo(last.x, last.y);
        context.stroke();
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

      function drawMoth(context, moth) {
        if (moth.opacity <= 0.01) {
          return;
        }

        context.save();
        context.globalAlpha = moth.opacity;
        context.fillStyle = moth.color;
        context.shadowColor = moth.shadowColor;
        context.shadowBlur = moth.shadowBlur;
        context.beginPath();
        context.arc(moth.x, moth.y, moth.size, 0, Math.PI * 2);
        context.fill();
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

      function drawScene(context, moths, width, height, elapsed, animationTime) {
        context.clearRect(0, 0, width, height);

        const cx = width / 2;
        const cy = height * config.scene.centerYRatio;
        const projectedMoths = moths
          .map((moth) => projectMoth(moth, animationTime, width, height, cx, cy))
          .filter(Boolean)
          .sort((a, b) => a.depth - b.depth);

        drawGround(context, width, height, cx, cy);
        projectedMoths.filter((moth) => moth.depth < 0).forEach((moth) => drawTrail(context, moth));
        projectedMoths.filter((moth) => moth.depth < 0).forEach((moth) => drawMoth(context, moth));
        drawLight(context, cx, cy, elapsed);
        projectedMoths.filter((moth) => moth.depth >= 0).forEach((moth) => drawTrail(context, moth));
        projectedMoths.filter((moth) => moth.depth >= 0).forEach((moth) => drawMoth(context, moth));
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

      function setupOrbitAnimation() {
        const canvas = document.getElementById("orbit-canvas");
        const context = canvas.getContext("2d");
        const scrubber = document.getElementById("timeline-scrubber");
        const timeReadout = document.getElementById("time-readout");
        let moths = [];
        let animationTime = 0;
        let lastTimestamp = null;
        let isPlaying = config.animation.autoplay;
        let wasPlayingBeforeScrub = false;

        function updateTimelineControls() {
          scrubber.max = String(config.animation.duration);
          scrubber.value = String(animationTime);
          timeReadout.textContent = config.animation.timeLabel + " " + formatClockTime(animationTime);
        }

        function resizeCanvas() {
          const rect = canvas.getBoundingClientRect();
          const scale = window.devicePixelRatio || 1;
          canvas.width = Math.max(1, Math.floor(rect.width * scale));
          canvas.height = Math.max(1, Math.floor(rect.height * scale));
          context.setTransform(scale, 0, 0, scale, 0, 0);
          moths = createMoths(config, rect.width, rect.height);
        }

        function tick(timestamp) {
          if (lastTimestamp === null) {
            lastTimestamp = timestamp;
          }

          const deltaSeconds = ((timestamp - lastTimestamp) / 1000) * config.animation.playbackSpeed;
          lastTimestamp = timestamp;

          if (isPlaying) {
            animationTime = normalizeAnimationTime(animationTime + deltaSeconds);
          }

          drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, timestamp, animationTime);
          updateTimelineControls();
          requestAnimationFrame(tick);
        }

        scrubber.addEventListener("pointerdown", () => {
          wasPlayingBeforeScrub = isPlaying;
          isPlaying = false;
        });

        scrubber.addEventListener("input", () => {
          animationTime = clampAnimationTime(Number(scrubber.value));
          drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime);
          updateTimelineControls();
        });

        scrubber.addEventListener("pointerup", () => {
          isPlaying = wasPlayingBeforeScrub;
          lastTimestamp = null;
        });

        scrubber.addEventListener("change", () => {
          animationTime = clampAnimationTime(Number(scrubber.value));
          isPlaying = wasPlayingBeforeScrub;
          lastTimestamp = null;
        });

        window.addEventListener("resize", resizeCanvas);
        resizeCanvas();
        updateTimelineControls();
        requestAnimationFrame(tick);
      }

      setupOrbitAnimation();
    </script>
  </body>
</html>
"@

$resolvedOutputPath = Resolve-ProjectPath $OutputPath
$outputDirectory = Split-Path -Parent $resolvedOutputPath
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

Set-Content -LiteralPath $resolvedOutputPath -Value $html -Encoding UTF8
Write-Output "Wrote standalone animation: $resolvedOutputPath"
