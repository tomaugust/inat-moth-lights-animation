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
      orbitStrokeColor = [string](Get-ConfigValue $speciesRecord "orbitStrokeColor" "")
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
      orbitStrokeColor = [string](Get-ConfigValue $moth "orbitStrokeColor" $speciesDefaults.orbitStrokeColor)
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
      orbitStrokeColor = [string](Get-ConfigValue $animation "orbitStrokeColor" "rgba(255, 255, 255, 0.09)")
      panelBackground = [string](Get-ConfigValue $animation "panelBackground" "rgba(255, 255, 255, 0.06)")
      panelBorderColor = [string](Get-ConfigValue $animation "panelBorderColor" "rgba(255, 255, 255, 0.08)")
      textColor = [string](Get-ConfigValue $animation "textColor" "#f5f5f5")
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
$safePanelBackground = ConvertTo-HtmlText $config.animation.panelBackground
$safePanelBorderColor = ConvertTo-HtmlText $config.animation.panelBorderColor
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
        min-height: 100vh;
      }

      body {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: $safeBackgroundColor;
        color: $safeTextColor;
      }

      .app-shell {
        display: grid;
        gap: 24px;
        grid-template-columns: minmax(220px, 360px) minmax(320px, 1fr);
        max-width: 1200px;
        width: 100%;
      }

      .panel {
        background: $safePanelBackground;
        border: 1px solid $safePanelBorderColor;
        border-radius: 8px;
        padding: 20px;
      }

      .panel h1 {
        font-size: 1.7rem;
        margin: 0 0 12px;
      }

      .panel p {
        line-height: 1.5;
        margin: 0;
      }

      .canvas-shell {
        min-height: 580px;
      }

      canvas {
        display: block;
        width: 100%;
        min-height: 580px;
        height: 100%;
        border: 1px solid $safeCanvasBorderColor;
        border-radius: 8px;
        background: $safeCanvasBackground;
      }

      @media (max-width: 760px) {
        body {
          align-items: stretch;
          padding: 16px;
        }

        .app-shell {
          grid-template-columns: 1fr;
        }

        .canvas-shell,
        canvas {
          min-height: min(70vh, 520px);
        }
      }
    </style>
  </head>
  <body>
    <main class="app-shell">
      <section class="panel" aria-label="Animation details">
        <h1>$safeTitle</h1>
        <p>$safeDescription</p>
      </section>
      <section class="canvas-shell" aria-label="Orbit animation">
        <canvas id="orbit-canvas"></canvas>
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
          orbitStrokeColor: moth.orbitStrokeColor || config.animation.orbitStrokeColor,
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

      function orbitPosition(moth, animationTime, cx, cy) {
        const activeTime = Math.max(0, animationTime - moth.entryTime);
        const angle = moth.angle + activeTime * moth.speed;
        const depth = Math.sin(angle);
        return {
          depth,
          x: cx + Math.cos(angle) * moth.radius,
          y: cy + depth * moth.radius * config.scene.orbitTilt
        };
      }

      function projectMoth(moth, animationTime, width, height, cx, cy) {
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
          x,
          y
        };
      }

      function drawOrbit(context, moth, cx, cy) {
        context.save();
        context.strokeStyle = moth.orbitStrokeColor;
        context.lineWidth = 1;
        context.beginPath();
        context.ellipse(cx, cy, moth.radius, moth.radius * config.scene.orbitTilt, 0, 0, Math.PI * 2);
        context.stroke();
        context.restore();
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

      function drawLight(context, cx, cy, elapsed) {
        const flicker = lightFlicker(elapsed);
        const pulse = 1 - config.light.flickerStrength + flicker * config.light.flickerStrength * 2;
        const glowRadius = config.light.glowRadius * (0.88 + flicker * 0.22);

        context.save();
        context.globalAlpha = Math.max(0.65, Math.min(1, pulse));
        const halo = context.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
        halo.addColorStop(0, config.light.glowColor);
        halo.addColorStop(0.28, config.light.haloColor);
        halo.addColorStop(1, "rgba(255, 255, 255, 0)");
        context.fillStyle = halo;
        context.beginPath();
        context.arc(cx, cy, glowRadius, 0, Math.PI * 2);
        context.fill();
        context.restore();

        context.save();
        context.globalAlpha = Math.max(0.86, Math.min(1, pulse));
        context.fillStyle = config.light.color;
        context.shadowColor = config.light.glowColor;
        context.shadowBlur = config.light.shadowBlur * (0.7 + flicker * 0.5);
        context.beginPath();
        context.arc(cx, cy, config.light.size * (0.92 + flicker * 0.12), 0, Math.PI * 2);
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
        moths.forEach((moth) => drawOrbit(context, moth, cx, cy));
        projectedMoths.filter((moth) => moth.depth < 0).forEach((moth) => drawMoth(context, moth));
        drawLight(context, cx, cy, elapsed);
        projectedMoths.filter((moth) => moth.depth >= 0).forEach((moth) => drawMoth(context, moth));
      }

      function setupOrbitAnimation() {
        const canvas = document.getElementById("orbit-canvas");
        const context = canvas.getContext("2d");
        let moths = [];
        let startTimestamp = null;

        function resizeCanvas() {
          const rect = canvas.getBoundingClientRect();
          const scale = window.devicePixelRatio || 1;
          canvas.width = Math.max(1, Math.floor(rect.width * scale));
          canvas.height = Math.max(1, Math.floor(rect.height * scale));
          context.setTransform(scale, 0, 0, scale, 0, 0);
          moths = createMoths(config, rect.width, rect.height);
        }

        function tick(timestamp) {
          if (startTimestamp === null) {
            startTimestamp = timestamp;
          }

          const elapsedSeconds = (timestamp - startTimestamp) / 1000;
          const animationTime = config.animation.loop
            ? elapsedSeconds % config.animation.duration
            : Math.min(config.animation.duration, elapsedSeconds);

          drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, timestamp, animationTime);
          requestAnimationFrame(tick);
        }

        window.addEventListener("resize", resizeCanvas);
        resizeCanvas();
        if (config.animation.autoplay) {
          requestAnimationFrame(tick);
        } else {
          drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, 0, 0);
        }
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
