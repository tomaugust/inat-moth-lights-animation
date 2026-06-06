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
  $centerDot = Get-ConfigValue $rawConfig "centerDot" ([pscustomobject]@{})
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
    $normalizedMoths += @{
      angle = ConvertTo-PositiveNumber (Get-ConfigValue $moth "angle" (($index * 360) / $moths.Count)) (($index * 360) / $moths.Count) 0
      chimeNote = [string](Get-ConfigValue $moth "chimeNote" $speciesDefaults.chimeNote)
      color = [string](Get-ConfigValue $moth "color" $speciesDefaults.color)
      erraticness = ConvertTo-PositiveNumber (Get-ConfigValue $moth "erraticness" $speciesDefaults.erraticness) $speciesDefaults.erraticness 0
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
      canvasBackground = [string](Get-ConfigValue $animation "canvasBackground" "radial-gradient(circle at center, #1b1b1b 0%, #090909 60%)")
      canvasBorderColor = [string](Get-ConfigValue $animation "canvasBorderColor" "rgba(255, 255, 255, 0.12)")
      description = [string](Get-ConfigValue $animation "description" "This standalone animation was generated from a JSON configuration and can be opened directly from the file.")
      orbitStrokeColor = [string](Get-ConfigValue $animation "orbitStrokeColor" "rgba(255, 255, 255, 0.09)")
      panelBackground = [string](Get-ConfigValue $animation "panelBackground" "rgba(255, 255, 255, 0.06)")
      panelBorderColor = [string](Get-ConfigValue $animation "panelBorderColor" "rgba(255, 255, 255, 0.08)")
      textColor = [string](Get-ConfigValue $animation "textColor" "#f5f5f5")
      title = [string](Get-ConfigValue $animation "title" "Orbit Animation")
    }
    centerDot = @{
      color = [string](Get-ConfigValue $centerDot "color" "#ffffff")
      glowColor = [string](Get-ConfigValue $centerDot "glowColor" "rgba(255, 255, 255, 0)")
      shadowBlur = ConvertTo-PositiveNumber (Get-ConfigValue $centerDot "shadowBlur" 0) 0 0
      size = ConvertTo-PositiveNumber (Get-ConfigValue $centerDot "size" 16) 16 2
    }
    moths = $normalizedMoths
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
        const usableRadius = Math.max(32, Math.min(width, height) * 0.5 - maxMothSize - 18);
        const minRadius = Math.min(72, usableRadius);
        const autoStep = config.moths.length > 1 ? Math.max(0, (usableRadius - minRadius) / (config.moths.length - 1)) : 0;

        return config.moths.map((moth, index) => ({
          angle: (moth.angle * Math.PI) / 180,
          chimeNote: moth.chimeNote,
          color: moth.color,
          erraticness: moth.erraticness,
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

      function drawScene(context, moths, width, height, elapsed) {
        context.clearRect(0, 0, width, height);

        const cx = width / 2;
        const cy = height / 2;

        context.save();
        context.fillStyle = config.centerDot.color;
        context.shadowColor = config.centerDot.glowColor;
        context.shadowBlur = config.centerDot.shadowBlur;
        context.beginPath();
        context.arc(cx, cy, config.centerDot.size, 0, Math.PI * 2);
        context.fill();
        context.restore();

        moths.forEach((moth) => {
          const angle = moth.angle + elapsed * moth.speed * 0.001;
          const x = cx + Math.cos(angle) * moth.radius;
          const y = cy + Math.sin(angle) * moth.radius;

          context.save();
          context.strokeStyle = moth.orbitStrokeColor;
          context.lineWidth = 1;
          context.beginPath();
          context.arc(cx, cy, moth.radius, 0, Math.PI * 2);
          context.stroke();
          context.restore();

          context.save();
          context.fillStyle = moth.color;
          context.shadowColor = moth.shadowColor;
          context.shadowBlur = moth.shadowBlur;
          context.beginPath();
          context.arc(x, y, moth.size, 0, Math.PI * 2);
          context.fill();
          context.restore();
        });
      }

      function setupOrbitAnimation() {
        const canvas = document.getElementById("orbit-canvas");
        const context = canvas.getContext("2d");
        let moths = [];

        function resizeCanvas() {
          const rect = canvas.getBoundingClientRect();
          const scale = window.devicePixelRatio || 1;
          canvas.width = Math.max(1, Math.floor(rect.width * scale));
          canvas.height = Math.max(1, Math.floor(rect.height * scale));
          context.setTransform(scale, 0, 0, scale, 0, 0);
          moths = createMoths(config, rect.width, rect.height);
        }

        function tick(timestamp) {
          drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, timestamp);
          requestAnimationFrame(tick);
        }

        window.addEventListener("resize", resizeCanvas);
        resizeCanvas();
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
