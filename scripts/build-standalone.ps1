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
  $audio = Get-ConfigValue $rawConfig "audio" ([pscustomobject]@{})
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
  $minMothDuration = ConvertTo-PositiveNumber (Get-ConfigValue $animation "minMothDuration" 0) 0 0
  foreach ($speciesRecord in $species) {
    $speciesId = [string](Get-ConfigValue $speciesRecord "id" "")
    if ([string]::IsNullOrWhiteSpace($speciesId)) {
      throw "Every species must have a non-empty id."
    }

    $rawChimeNotes = @(Get-ConfigValue $speciesRecord "chimeNotes" @())
    $chimeNotes = @($rawChimeNotes | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $fallbackChimeNote = [string](Get-ConfigValue $speciesRecord "chimeNote" "")
    if ($chimeNotes.Count -lt 1 -and -not [string]::IsNullOrWhiteSpace($fallbackChimeNote)) {
      $chimeNotes = @($fallbackChimeNote)
    }

    $normalized = @{
      chimeNote = $fallbackChimeNote
      chimeNotes = $chimeNotes
      color = [string](Get-ConfigValue $speciesRecord "color" "#000000")
      erraticness = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "erraticness" 0) 0 0
      id = $speciesId
      imageURL = [string](Get-ConfigValue $speciesRecord "imageURL" "")
      inclinationDriftSpeed = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "inclinationDriftSpeed" 0) 0 0
      name = [string](Get-ConfigValue $speciesRecord "name" $speciesId)
      nodeDriftSpeed = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "nodeDriftSpeed" 0) 0 0
      shadowBlur = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "shadowBlur" 12) 12 0
      shadowColor = [string](Get-ConfigValue $speciesRecord "shadowColor" "rgba(255, 255, 255, 0.12)")
      size = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "size" 10) 10 2
      speed = ConvertTo-PositiveNumber (Get-ConfigValue $speciesRecord "speed" 1) 1 0.01
      speciesDescription = [string](Get-ConfigValue $speciesRecord "speciesDescription" "")
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
    $exitTime = [Math]::Max($exitTime, $entryTime + $minMothDuration)
    $normalizedMoths += @{
      angle = ($index * 360) / $moths.Count
      chimeNote = $speciesDefaults.chimeNote
      chimeNotes = $speciesDefaults.chimeNotes
      color = $speciesDefaults.color
      entryTime = $entryTime
      erraticness = $speciesDefaults.erraticness
      exitTime = $exitTime
      id = [string](Get-ConfigValue $moth "id" "moth-$($index + 1)")
      inclinationDriftSpeed = $speciesDefaults.inclinationDriftSpeed
      imageURL = $speciesDefaults.imageURL
      label = $speciesDefaults.name
      nodeDriftSpeed = $speciesDefaults.nodeDriftSpeed
      radius = 0
      shadowBlur = $speciesDefaults.shadowBlur
      shadowColor = $speciesDefaults.shadowColor
      size = $speciesDefaults.size
      species = $speciesId
      speciesName = $speciesDefaults.name
      speciesDescription = $speciesDefaults.speciesDescription
      speed = $speciesDefaults.speed
      trailLength = $speciesDefaults.trailLength
    }
  }

  return @{
    animation = @{
      backgroundColor = [string](Get-ConfigValue $animation "backgroundColor" "#121212")
      autoplay = [bool](Get-ConfigValue $animation "autoplay" $true)
      canvasBackground = [string](Get-ConfigValue $animation "canvasBackground" "radial-gradient(circle at center, #1b1b1b 0%, #090909 60%)")
      canvasBorderColor = [string](Get-ConfigValue $animation "canvasBorderColor" "rgba(255, 255, 255, 0.12)")
      description = [string](Get-ConfigValue $animation "description" "This standalone animation was generated from a JSON configuration and can be opened directly from the file.")
      descriptionColor = [string](Get-ConfigValue $animation "descriptionColor" (Get-ConfigValue $animation "textColor" "#f5f5f5"))
      descriptionSize = [string](Get-ConfigValue $animation "descriptionSize" "clamp(0.78rem, 1.1vw, 0.98rem)")
      duration = ConvertTo-PositiveNumber (Get-ConfigValue $animation "duration" 80) 80 1
      loop = [bool](Get-ConfigValue $animation "loop" $true)
      launchScreenEnabled = [bool](Get-ConfigValue $animation "launchScreenEnabled" $false)
      minMothDuration = $minMothDuration
      playbackSpeed = ConvertTo-PositiveNumber (Get-ConfigValue $animation "playbackSpeed" 1) 1 0.01
      startClockTime = [string](Get-ConfigValue $animation "startClockTime" "22:00")
      speciesTag = [bool](Get-ConfigValue $animation "speciesTag" $true)
      speciesTagColor = [string](Get-ConfigValue $animation "speciesTagColor" "")
      speciesTagDuration = ConvertTo-PositiveNumber (Get-ConfigValue $animation "speciesTagDuration" 5.5) 5.5 0.1
      speciesTagSize = ConvertTo-PositiveNumber (Get-ConfigValue $animation "speciesTagSize" 13) 13 1
      textColor = [string](Get-ConfigValue $animation "textColor" "#f5f5f5")
      timeLabel = [string](Get-ConfigValue $animation "timeLabel" "Time")
      title = [string](Get-ConfigValue $animation "title" "Orbit Animation")
      titleColor = [string](Get-ConfigValue $animation "titleColor" (Get-ConfigValue $animation "textColor" "#f5f5f5"))
      titleSize = [string](Get-ConfigValue $animation "titleSize" "clamp(1.25rem, 2.4vw, 2.35rem)")
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
    audio = @{
      chimeProbability = ConvertTo-PositiveNumber (Get-ConfigValue $audio "chimeProbability" 0.3) 0.3 0
      droneBrightness = ConvertTo-PositiveNumber (Get-ConfigValue $audio "droneBrightness" 0.45) 0.45 0
      droneEnabled = [bool](Get-ConfigValue $audio "droneEnabled" $false)
      droneNotes = @(Get-ConfigValue $audio "droneNotes" @("D2", "A2", "D3")) | ForEach-Object { [string]$_ }
      droneVariation = ConvertTo-PositiveNumber (Get-ConfigValue $audio "droneVariation" 0.65) 0.65 0
      droneVolume = ConvertTo-PositiveNumber (Get-ConfigValue $audio "droneVolume" 0.035) 0.035 0
      enabled = [bool](Get-ConfigValue $audio "enabled" $true)
      minInterval = ConvertTo-PositiveNumber (Get-ConfigValue $audio "minInterval" 0.85) 0.85 0.05
      noteDecay = ConvertTo-PositiveNumber (Get-ConfigValue $audio "noteDecay" 2.8) 2.8 0.1
      volume = ConvertTo-PositiveNumber (Get-ConfigValue $audio "volume" 0.12) 0.12 0
    }
    moths = $normalizedMoths
    scene = @{
      backgroundMothOpacity = ConvertTo-PositiveNumber (Get-ConfigValue $scene "backgroundMothOpacity" 0.45) 0.45 0
      centerYRatio = ConvertTo-PositiveNumber (Get-ConfigValue $scene "centerYRatio" 0.55) 0.55 0.1
      foregroundMothOpacity = ConvertTo-PositiveNumber (Get-ConfigValue $scene "foregroundMothOpacity" 1) 1 0
      groundBackColor = [string](Get-ConfigValue $scene "groundBackColor" "#07080b")
      groundFrontColor = [string](Get-ConfigValue $scene "groundFrontColor" "#211b14")
      groundMidColor = [string](Get-ConfigValue $scene "groundMidColor" "#14120f")
      horizontalEdgeMothOpacity = ConvertTo-PositiveNumber (Get-ConfigValue $scene "horizontalEdgeMothOpacity" 0.28) 0.28 0
      horizontalFadeEnabled = [bool](Get-ConfigValue $scene "horizontalFadeEnabled" $true)
      horizonYRatio = ConvertTo-PositiveNumber (Get-ConfigValue $scene "horizonYRatio" 0.34) 0.34 0
      lightPoolColor = [string](Get-ConfigValue $scene "lightPoolColor" "rgba(255, 244, 201, 0.3)")
      lightPoolRadius = ConvertTo-PositiveNumber (Get-ConfigValue $scene "lightPoolRadius" 330) 330 40
      mothShadowsEnabled = [bool](Get-ConfigValue $scene "mothShadowsEnabled" $false)
      mothShadowBlur = ConvertTo-PositiveNumber (Get-ConfigValue $scene "mothShadowBlur" 12) 12 0
      mothShadowLength = ConvertTo-PositiveNumber (Get-ConfigValue $scene "mothShadowLength" 110) 110 1
      mothShadowOpacity = ConvertTo-PositiveNumber (Get-ConfigValue $scene "mothShadowOpacity" 0.22) 0.22 0
      orbitTilt = ConvertTo-PositiveNumber (Get-ConfigValue $scene "orbitTilt" 0.3) 0.3 0.05
      orbitRadiusScale = ConvertTo-PositiveNumber (Get-ConfigValue $scene "orbitRadiusScale" 0.92) 0.92 0.1
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
$safeTitleColor = ConvertTo-HtmlText $config.animation.titleColor
$safeTitleSize = ConvertTo-HtmlText $config.animation.titleSize
$safeDescriptionColor = ConvertTo-HtmlText $config.animation.descriptionColor
$safeDescriptionSize = ConvertTo-HtmlText $config.animation.descriptionSize

$html = @"
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
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
        width: 100%;
      }

      body {
        background: $safeBackgroundColor;
        color: $safeTextColor;
        overflow: hidden;
      }

      .app-shell {
        height: 100vh;
        height: 100svh;
        min-height: 100vh;
        min-height: 100svh;
        position: relative;
        width: 100%;
      }

      @supports (height: 100dvh) {
        .app-shell {
          height: 100dvh;
          min-height: 100dvh;
        }
      }

      .canvas-shell {
        height: 100%;
        min-height: 100%;
        position: relative;
      }

      canvas {
        opacity: 1;
        transition: opacity 760ms ease;
        display: block;
        width: 100%;
        height: 100%;
        background: $safeCanvasBackground;
        cursor: default;
        touch-action: manipulation;
      }

      .animation-heading {
        max-width: min(360px, calc(100vw - 40px));
        pointer-events: none;
        position: absolute;
        right: clamp(18px, 4vw, 48px);
        text-align: right;
        top: clamp(18px, 4vw, 42px);
        transition: opacity 620ms ease;
        z-index: 2;
      }

      .animation-heading h1 {
        color: $safeTitleColor;
        font-size: $safeTitleSize;
        font-weight: 650;
        line-height: 1.05;
        margin: 0 0 8px;
      }

      .animation-heading p {
        color: $safeDescriptionColor;
        font-size: $safeDescriptionSize;
        line-height: 1.35;
        margin: 0;
        opacity: 0.76;
      }

      .timeline-control {
        align-items: stretch;
        bottom: calc(env(safe-area-inset-bottom, 0px) + clamp(14px, 2.4vw, 28px));
        display: grid;
        gap: 6px;
        grid-template-columns: 1fr;
        left: 50%;
        max-width: calc(100vw - 32px);
        position: fixed;
        transform: translateX(-50%);
        transition: opacity 620ms ease;
        width: min(620px, calc(100vw - 32px));
        z-index: 10;
      }

      .time-readout {
        font-size: clamp(1rem, 1.7vw, 1.45rem);
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        letter-spacing: 0;
        opacity: 0.82;
        text-align: center;
        white-space: nowrap;
      }

      .timeline-control input[type="range"] {
        accent-color: $safeTextColor;
        cursor: pointer;
        height: 24px;
        width: 100%;
      }

      .sound-toggle {
        align-items: center;
        background: rgba(10, 10, 12, 0.36);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 999px;
        bottom: calc(env(safe-area-inset-bottom, 0px) + clamp(16px, 2.4vw, 30px));
        cursor: pointer;
        display: flex;
        height: 38px;
        justify-content: center;
        opacity: 0.78;
        padding: 0;
        position: fixed;
        right: clamp(16px, 2.4vw, 30px);
        transition: opacity 160ms ease, border-color 160ms ease, background 160ms ease;
        width: 38px;
        z-index: 11;
      }

      body.launch-screen-active canvas {
        opacity: 0;
      }

      body.launch-screen-active.launch-light-visible canvas {
        opacity: 1;
      }

      body.launch-screen-active:not(.launch-controls-visible) .animation-heading,
      body.launch-screen-active:not(.launch-controls-visible) .timeline-control,
      body.launch-screen-active:not(.launch-controls-visible) .sound-toggle,
      body.launch-screen-active:not(.launch-controls-visible) .active-moths-toggle,
      body.launch-screen-active:not(.launch-controls-visible) .active-moths-panel {
        opacity: 0;
        pointer-events: none;
      }

      .active-moths-toggle {
        align-items: center;
        background: rgba(10, 10, 12, 0.32);
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        color: rgba(245, 241, 232, 0.86);
        cursor: pointer;
        display: flex;
        height: 34px;
        justify-content: center;
        padding: 0;
        position: fixed;
        right: clamp(14px, 2.1vw, 26px);
        top: 50%;
        transform: translateY(-50%);
        transition: background 260ms ease, border-color 260ms ease, opacity 820ms ease, transform 520ms ease;
        width: 34px;
        z-index: 12;
      }

      .active-moths-toggle:hover,
      .active-moths-toggle:focus-visible {
        background: rgba(18, 18, 22, 0.72);
        border-color: rgba(255, 255, 255, 0.42);
        outline: none;
      }

      .active-moths-toggle::before,
      .active-moths-toggle::after {
        background: currentColor;
        border-radius: 999px;
        content: "";
        height: 2px;
        position: absolute;
        transition: transform 260ms ease;
        width: 13px;
      }

      .active-moths-toggle::before {
        transform: translateY(-4px) rotate(-45deg);
      }

      .active-moths-toggle::after {
        transform: translateY(4px) rotate(45deg);
      }

      .active-moths-toggle.is-open {
        transform: translateY(-50%) translateX(-286px);
      }

      .active-moths-toggle.is-open::before {
        transform: translateY(-4px) rotate(45deg);
      }

      .active-moths-toggle.is-open::after {
        transform: translateY(4px) rotate(-45deg);
      }

      .active-moths-panel {
        background: #08080a;
        border-left: 1px solid rgba(255, 255, 255, 0.12);
        bottom: 0;
        box-shadow: -18px 0 34px rgba(0, 0, 0, 0.22);
        display: flex;
        flex-direction: column;
        gap: 10px;
        opacity: 0;
        padding: calc(env(safe-area-inset-top, 0px) + 18px) 14px calc(env(safe-area-inset-bottom, 0px) + 18px);
        pointer-events: none;
        position: fixed;
        right: 0;
        top: 0;
        transform: translateX(100%);
        transition: opacity 520ms ease, transform 520ms ease;
        width: 286px;
        z-index: 11;
      }

      .active-moths-panel.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateX(0);
      }

      .active-moths-panel__title {
        color: rgba(245, 241, 232, 0.82);
        font-size: 0.78rem;
        font-weight: 600;
        letter-spacing: 0;
        margin: 0;
        text-align: right;
      }

      .active-moths-list {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 2px 2px 2px 0;
        scrollbar-color: rgba(245, 241, 232, 0.28) transparent;
        scrollbar-width: thin;
      }

      .active-moths-card {
        background: rgba(255, 255, 255, 0.065);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        color: rgba(245, 241, 232, 0.9);
        cursor: pointer;
        display: grid;
        gap: 3px;
        grid-template-columns: auto 1fr;
        min-height: 58px;
        opacity: 1;
        padding: 9px 10px;
        position: relative;
        text-align: left;
        transform: translateX(0);
        overflow: hidden;
        max-height: 220px;
        transition: background 220ms ease, border-color 220ms ease, opacity 820ms ease, transform 820ms ease, max-height 820ms ease, min-height 820ms ease, padding 820ms ease;
        width: 258px;
        will-change: transform, opacity;
        border-color: rgba(255, 255, 255, 0.32);
      }

      .active-moths-card.is-entering,
      .active-moths-card.is-leaving {
        opacity: 0;
        transform: translateX(14px);
      }

      .active-moths-card.is-entering {
        opacity: 0.08;
      }

      .active-moths-card.is-leaving {
        min-height: 0;
        max-height: 0;
        padding-top: 0;
        padding-bottom: 0;
      }

      .active-moths-card.is-focused {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.42);
      }

      .active-moths-card:hover,
      .active-moths-card:focus-visible {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.28);
        outline: none;
      }

      .active-moths-card__swatch {
        border-radius: 999px;
        box-shadow: 0 0 10px currentColor;
        height: 9px;
        margin-top: 5px;
        width: 9px;
      }

      .active-moths-card__name {
        font-size: 0.82rem;
        font-weight: 600;
        line-height: 1.2;
        overflow-wrap: anywhere;
      }

      .active-moths-card__time {
        color: rgba(245, 241, 232, 0.58);
        font-size: 0.72rem;
        font-variant-numeric: tabular-nums;
        grid-column: 2;
        line-height: 1.2;
      }

      .active-moths-card__meta {
        color: rgba(245, 241, 232, 0.48);
        font-size: 0.68rem;
        grid-column: 2;
        line-height: 1.2;
      }

      .sound-toggle span {
        inset: 0;
        position: absolute;
      }

      .sound-toggle:hover,
      .sound-toggle:focus-visible {
        background: rgba(18, 18, 22, 0.72);
        border-color: rgba(255, 255, 255, 0.42);
        opacity: 1;
        outline: none;
      }

      .sound-toggle::before {
        border-bottom: 7px solid transparent;
        border-right: 11px solid rgba(245, 241, 232, 0.86);
        border-top: 7px solid transparent;
        content: "";
        height: 0;
        left: 9px;
        margin-left: 0;
        position: absolute;
        top: 11px;
        width: 0;
      }

      .sound-toggle::after {
        border: 2px solid rgba(245, 241, 232, 0.86);
        border-bottom-color: transparent;
        border-left-color: transparent;
        border-radius: 50%;
        content: "";
        height: 9px;
        left: 17px;
        margin-left: 0;
        position: absolute;
        top: 12px;
        transform: rotate(45deg);
        width: 9px;
      }

      .sound-toggle:not(.is-on)::after {
        display: none;
      }

      .sound-toggle span::before,
      .sound-toggle span::after {
        background: rgba(245, 241, 232, 0.86);
        border-radius: 999px;
        content: "";
        height: 2px;
        opacity: 0;
        position: absolute;
        left: 19px;
        top: 18px;
        transform-origin: center;
        transition: opacity 120ms ease;
        width: 11px;
      }

      .sound-toggle:not(.is-on) span::before {
        opacity: 1;
        transform: rotate(45deg);
      }

      .sound-toggle:not(.is-on) span::after {
        opacity: 1;
        transform: rotate(-45deg);
      }

      .launch-screen {
        align-items: center;
        background: $safeCanvasBackground;
        bottom: 0;
        color: #f5f1e8;
        display: flex;
        inset: 0;
        justify-content: center;
        left: 0;
        position: fixed;
        right: 0;
        top: 0;
        transition: opacity 280ms ease;
        width: 100%;
        z-index: 20;
      }

      .launch-screen.launch-screen--hidden {
        opacity: 0;
        pointer-events: none;
      }

      .launch-screen__panel {
        text-align: center;
        transition: opacity 300ms ease;
      }

      .launch-screen.launch-screen--switch-hidden .launch-screen__panel {
        opacity: 0;
        pointer-events: none;
      }

      .launch-screen__switch {
        align-items: center;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 999px;
        cursor: pointer;
        display: inline-flex;
        height: 52px;
        justify-content: flex-start;
        padding: 8px;
        position: relative;
        transition: background 180ms ease, border-color 180ms ease;
        width: 112px;
      }

      .launch-screen__switch:hover,
      .launch-screen__switch:focus-visible {
        border-color: rgba(255, 255, 255, 0.48);
        outline: none;
      }

      .launch-screen__switch::after {
        background: #f5f1e8;
        border-radius: 999px;
        content: "";
        display: block;
        height: 36px;
        left: 8px;
        position: absolute;
        top: 8px;
        transition: left 240ms ease;
        width: 36px;
      }

      .launch-screen__switch.is-on {
        background: rgba(255, 255, 255, 0.18);
        justify-content: flex-end;
      }

      .launch-screen__switch.is-on::after {
        left: calc(100% - 44px);
      }

      .launch-screen__text {
        color: rgba(245, 241, 232, 0.88);
        font-size: 1rem;
        margin-top: 18px;
      }

      @media (max-width: 620px) {
        .animation-heading {
          max-width: calc(100vw - 32px);
          right: 16px;
          top: 16px;
        }

        .timeline-control {
          gap: 4px;
        }

        .time-readout {
          text-align: center;
        }
      }
    </style>
  </head>
  <body>
    <div class="launch-screen" id="launch-screen" aria-label="Launch screen" role="dialog" aria-modal="true">
      <div class="launch-screen__panel">
        <button class="launch-screen__switch" id="launch-switch" type="button" aria-label="Turn on the moth animation"></button>
        <div class="launch-screen__text" id="launch-text">Turn on the light</div>
      </div>
    </div>
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
        <button class="active-moths-toggle" id="active-moths-toggle" type="button" aria-label="Show active moths" aria-expanded="false" aria-controls="active-moths-panel"></button>
        <aside class="active-moths-panel" id="active-moths-panel" aria-label="Active known moths">
          <h2 class="active-moths-panel__title">Active moths</h2>
          <div class="active-moths-list" id="active-moths-list"></div>
        </aside>
        <button class="sound-toggle" id="sound-toggle" type="button" aria-label="Enable sound"><span aria-hidden="true"></span></button>
      </section>
    </main>

    <script>
      const config = $configJson;

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
          entryTime: moth.entryTime,
          erraticness: moth.erraticness,
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

      function noteToFrequency(note) {
        const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(note || ""));
        if (!match) {
          return 440;
        }

        const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        const letter = match[1].toUpperCase();
        const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
        const octave = Number(match[3]);
        const midi = (octave + 1) * 12 + semitones[letter] + accidental;
        return 440 * Math.pow(2, (midi - 69) / 12);
      }

      function setupAudio(moths) {
        const button = document.getElementById("sound-toggle");
        const settings = config.audio || {};
        const enabledByConfig = settings.enabled !== false;
        let audioContext = null;
        let masterGain = null;
        let delay = null;
        let delayGain = null;
        let droneGain = null;
        let droneStarted = false;
        let isEnabled = false;
        const nextChimeAt = new Map();

        if (!button || !enabledByConfig) {
          if (button) {
            button.hidden = true;
          }

          return {
            update: () => {}
          };
        }

        function initialiseAudio() {
          if (audioContext) {
            return;
          }

          const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextConstructor) {
            button.hidden = true;
            return;
          }

          audioContext = new AudioContextConstructor();
          masterGain = audioContext.createGain();
          delay = audioContext.createDelay(4);
          delayGain = audioContext.createGain();
          droneGain = audioContext.createGain();

          masterGain.gain.value = Math.max(0, Math.min(0.35, settings.volume ?? 0.12));
          delay.delayTime.value = 0.34;
          delayGain.gain.value = 0.16;
          droneGain.gain.value = 0;

          masterGain.connect(audioContext.destination);
          masterGain.connect(delay);
          delay.connect(delayGain);
          delayGain.connect(audioContext.destination);
          droneGain.connect(audioContext.destination);
        }

        function audioLevel(value, fallback, maximum) {
          const numeric = Number(value ?? fallback);
          const scaled = Number.isFinite(numeric) && numeric > 1 ? numeric / 100 : numeric;
          return Math.max(0, Math.min(maximum, Number.isFinite(scaled) ? scaled : fallback));
        }

        function levelMultiplier(value, fallback, baseLevel, maximumMultiplier = 8) {
          const numeric = Number(value ?? fallback);
          const multiplier = Number.isFinite(numeric) ? numeric : fallback;
          return Math.max(0, Math.min(maximumMultiplier, multiplier)) * baseLevel;
        }

        function setChimesActive(active) {
          if (!audioContext || !masterGain || !delayGain) {
            return;
          }

          const now = audioContext.currentTime;
          const target = active ? audioLevel(settings.volume, 0.12, 0.35) : 0;
          masterGain.gain.cancelScheduledValues(now);
          masterGain.gain.setValueAtTime(target, now);
          delayGain.gain.cancelScheduledValues(now);
          delayGain.gain.setValueAtTime(active ? 0.16 : 0, now);
        }

        function startDrone() {
          if (!audioContext || !droneGain || droneStarted || settings.droneEnabled !== true) {
            return;
          }

          const notes = Array.isArray(settings.droneNotes) && settings.droneNotes.length > 0
            ? settings.droneNotes
            : ["D2", "A2", "D3"];
          const variation = Math.max(0, Math.min(1, settings.droneVariation ?? 0.65));
          const brightness = Math.max(0, Math.min(1, settings.droneBrightness ?? 0.45));
          const baseFilterFrequency = 260 + brightness * 980;

          notes.forEach((note, index) => {
            const frequency = noteToFrequency(note);
            const now = audioContext.currentTime;
            const voiceBus = audioContext.createGain();
            const lowpass = audioContext.createBiquadFilter();
            const filterLfo = audioContext.createOscillator();
            const filterLfoGain = audioContext.createGain();
            const layers = [
              { ratio: 1, type: "sine", gain: 0.42, drift: 0, driftAmount: 0 },
              { ratio: 2, type: "sine", gain: 0.04, drift: 0, driftAmount: 0.16 },
              { ratio: 4, type: "sine", gain: 0.008, drift: 0, driftAmount: 0.08 }
            ];

            voiceBus.gain.setValueAtTime(0.0001, now);
            voiceBus.gain.linearRampToValueAtTime(1, now + 1.8);
            lowpass.type = "lowpass";
            lowpass.frequency.setValueAtTime(baseFilterFrequency + index * 90, now);
            lowpass.Q.value = 0.5 + brightness * 0.35;
            filterLfo.frequency.value = 0.018 + index * 0.006;
            filterLfoGain.gain.value = baseFilterFrequency * 0.045 * variation;
            filterLfo.connect(filterLfoGain);
            filterLfoGain.connect(lowpass.frequency);
            voiceBus.connect(lowpass);
            lowpass.connect(droneGain);
            filterLfo.start(now);

            layers.forEach((layer, layerIndex) => {
              const oscillator = audioContext.createOscillator();
              const gain = audioContext.createGain();
              const detuneLfo = audioContext.createOscillator();
              const detuneLfoGain = audioContext.createGain();
              const layerGain = layer.gain / Math.max(1, notes.length);

              oscillator.type = layer.type;
              oscillator.frequency.setValueAtTime(frequency * layer.ratio, now);
              oscillator.detune.setValueAtTime(layer.drift, now);

              gain.gain.value = layerGain * (1 - variation * 0.16);
              detuneLfo.frequency.value = 0.012 + index * 0.004 + layerIndex * 0.003;
              detuneLfoGain.gain.value = layer.driftAmount * variation;
              detuneLfo.connect(detuneLfoGain);
              detuneLfoGain.connect(oscillator.detune);

              oscillator.connect(gain);
              gain.connect(voiceBus);
              oscillator.start(now);
              detuneLfo.start(now);
            });
          });

          droneStarted = true;
        }

        function setDroneActive(active) {
          if (!audioContext || !droneGain || settings.droneEnabled !== true) {
            return;
          }

          startDrone();
          const now = audioContext.currentTime;
          const target = active ? levelMultiplier(settings.droneVolume, 1, 0.38) : 0;
          droneGain.gain.cancelScheduledValues(now);
          if (active) {
            droneGain.gain.setTargetAtTime(target, now, 0.9);
          } else {
            droneGain.gain.setValueAtTime(0, now);
          }
        }

        function setButtonState() {
          button.classList.toggle("is-on", isEnabled);
          button.setAttribute("aria-label", isEnabled ? "Disable sound" : "Enable sound");
        }

        function playChime(note, intensity) {
          if (!audioContext || !masterGain || !isEnabled) {
            return;
          }

          const now = audioContext.currentTime;
          const decay = Math.max(0.45, settings.noteDecay ?? 2.8);
          const frequency = noteToFrequency(note);
          const partials = [
            { ratio: 1, gain: 0.24, decay: 1 },
            { ratio: 2.005, gain: 0.085, decay: 0.78 },
            { ratio: 3.01, gain: 0.038, decay: 0.52 },
            { ratio: 4.02, gain: 0.018, decay: 0.34 },
            { ratio: 1.505, gain: 0.026, decay: 0.62 }
          ];

          partials.forEach((partial, index) => {
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            const filter = audioContext.createBiquadFilter();
            const detune = (seededUnit(Math.round(frequency * 100), index + 91) - 0.5) * 6;
            const partialDecay = Math.max(0.28, decay * partial.decay);

            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(frequency * partial.ratio, now);
            oscillator.detune.setValueAtTime(detune, now);
            oscillator.detune.linearRampToValueAtTime(detune * 0.25, now + partialDecay);
            filter.type = "lowpass";
            filter.frequency.setValueAtTime(Math.min(4200, frequency * 5.8), now);
            filter.Q.value = 0.45;

            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.linearRampToValueAtTime(partial.gain * intensity, now + 0.04 + index * 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + partialDecay);

            oscillator.connect(filter);
            filter.connect(gain);
            gain.connect(masterGain);
            oscillator.start(now);
            oscillator.stop(now + partialDecay + 0.08);
          });

          const noiseDuration = 0.075;
          const noiseBuffer = audioContext.createBuffer(1, Math.max(1, Math.floor(audioContext.sampleRate * noiseDuration)), audioContext.sampleRate);
          const noiseData = noiseBuffer.getChannelData(0);
          for (let index = 0; index < noiseData.length; index += 1) {
            const fade = 1 - index / noiseData.length;
            noiseData[index] = (Math.random() * 2 - 1) * fade;
          }

          const noise = audioContext.createBufferSource();
          const noiseFilter = audioContext.createBiquadFilter();
          const noiseGain = audioContext.createGain();
          noise.buffer = noiseBuffer;
          noiseFilter.type = "bandpass";
          noiseFilter.frequency.setValueAtTime(Math.min(3200, frequency * 4.2), now);
          noiseFilter.Q.value = 1.6;
          noiseGain.gain.setValueAtTime(0.009 * intensity, now);
          noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + noiseDuration);
          noise.connect(noiseFilter);
          noiseFilter.connect(noiseGain);
          noiseGain.connect(masterGain);
          noise.start(now);
          noise.stop(now + noiseDuration);
        }

        function pickSpeciesNote(species) {
          const notes = Array.isArray(species.chimeNotes) && species.chimeNotes.length > 0
            ? species.chimeNotes
            : species.chimeNote ? [species.chimeNote] : [];

          if (notes.length < 1) {
            return "";
          }

          return notes[Math.floor(Math.random() * notes.length)];
        }

        function activeSpeciesCountsAt(animationTime) {
          const activeSpeciesCounts = new Map();
          moths.forEach((moth) => {
            if (animationTime >= moth.entryTime && animationTime <= moth.exitTime) {
              activeSpeciesCounts.set(moth.species, (activeSpeciesCounts.get(moth.species) || 0) + 1);
            }
          });
          return activeSpeciesCounts;
        }

        function update(animationTime, deltaSeconds) {
          if (!isEnabled || !audioContext || audioContext.state !== "running") {
            return;
          }

          const activeSpeciesCounts = activeSpeciesCountsAt(animationTime);
          const probability = Math.max(0, settings.chimeProbability ?? 0.3);
          const minInterval = Math.max(0.05, settings.minInterval ?? 0.85);

          config.species.forEach((species) => {
            const note = pickSpeciesNote(species);
            const activeCount = activeSpeciesCounts.get(species.id) || 0;
            if (activeCount < 1 || !note) {
              return;
            }

            const audioTime = audioContext.currentTime;
            const earliest = nextChimeAt.get(species.id) || 0;
            if (audioTime < earliest) {
              return;
            }

            const countMultiplier = Math.min(12, activeCount);
            const chance = 1 - Math.exp(-probability * countMultiplier * Math.max(0, deltaSeconds));
            if (Math.random() < chance) {
              const size = Math.max(1, species.size || 6);
              const intensity = Math.max(0.35, Math.min(1, 8 / size));
              playChime(note, intensity);
              nextChimeAt.set(species.id, audioTime + minInterval + Math.random() * minInterval * 2.2);
            }
          });
        }

        button.addEventListener("click", async () => {
          initialiseAudio();
          if (!audioContext) {
            return;
          }

          isEnabled = !isEnabled;

          if (isEnabled && audioContext.state !== "running") {
            await audioContext.resume();
          }

          setChimesActive(isEnabled);
          setDroneActive(isEnabled);

          setButtonState();
        });

        setButtonState();

        return {
          update
        };
      }

      function setupOrbitAnimation(initialPresentationMode = "normal") {
        const canvas = document.getElementById("orbit-canvas");
        const context = canvas.getContext("2d");
        const scrubber = document.getElementById("timeline-scrubber");
        const timeReadout = document.getElementById("time-readout");
        const activeMothsToggle = document.getElementById("active-moths-toggle");
        const activeMothsPanel = document.getElementById("active-moths-panel");
        const activeMothsList = document.getElementById("active-moths-list");
        const audio = setupAudio(config.moths);
        let moths = [];
        let animationTime = 0;
        let lastTimestamp = null;
        let isPlaying = config.animation.autoplay && initialPresentationMode !== "light-only";
        let wasPlayingBeforeScrub = false;
        let wasPlayingBeforeHover = false;
        let isScrubbing = false;
        let isHoverPaused = false;
        let presentationMode = initialPresentationMode;
        const canHover = window.matchMedia
          ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
          : true;
        const hoverState = {
          hoveredMothId: null,
          imageCache: new Map()
        };
        const activeCardRecords = new Map();
        const cardExitDelay = 1600;

        function updateTimelineControls() {
          scrubber.max = String(config.animation.duration);
          scrubber.value = String(animationTime);
          timeReadout.textContent = formatClockTime(animationTime);
        }

        function activeProjectedKnownMoths() {
          const width = canvas.clientWidth;
          const height = canvas.clientHeight;
          const cx = width / 2;
          const cy = height * config.scene.centerYRatio;

          return moths
            .map((moth) => projectMoth(moth, animationTime, width, height, cx, cy, false))
            .filter((moth) => moth && moth.species !== "unknown" && moth.opacity > 0.02)
            .sort((a, b) => a.entryTime - b.entryTime);
        }

        function setFocusedMoth(mothId, pausePlayback = true) {
          hoverState.hoveredMothId = mothId;
          canvas.style.cursor = mothId ? "pointer" : "default";

          if (mothId && pausePlayback && !isHoverPaused && !isScrubbing) {
            wasPlayingBeforeHover = isPlaying;
            isPlaying = false;
            isHoverPaused = true;
            lastTimestamp = null;
          }

          if (!mothId && isHoverPaused && !isScrubbing) {
            isPlaying = wasPlayingBeforeHover;
            lastTimestamp = null;
            isHoverPaused = false;
          }
        }

        function createActiveMothCard(moth) {
          const card = document.createElement("button");
          card.className = "active-moths-card is-entering";
          card.type = "button";
          card.dataset.mothId = moth.id;

          const swatch = document.createElement("span");
          swatch.className = "active-moths-card__swatch";
          swatch.style.background = moth.color;
          swatch.style.color = moth.color;

          const name = document.createElement("span");
          name.className = "active-moths-card__name";
          name.textContent = moth.speciesName || moth.label || moth.id;

          const time = document.createElement("span");
          time.className = "active-moths-card__time";

          card.append(swatch, name, time);
          card.addEventListener("pointerenter", () => {
            setFocusedMoth(card.dataset.mothId);
          });
          card.addEventListener("pointerleave", () => {
            if (hoverState.hoveredMothId === card.dataset.mothId) {
              clearHover();
            }
          });
          card.addEventListener("focus", () => {
            setFocusedMoth(card.dataset.mothId);
          });
          card.addEventListener("blur", () => {
            if (hoverState.hoveredMothId === card.dataset.mothId) {
              clearHover();
            }
          });
          card.addEventListener("click", () => {
            if (hoverState.hoveredMothId === card.dataset.mothId) {
              clearHover();
            } else {
              setFocusedMoth(card.dataset.mothId);
            }
            drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
          });

          requestAnimationFrame(() => card.classList.remove("is-entering"));
          return card;
        }

        function updateActiveMothCard(card, moth) {
          const name = card.querySelector(".active-moths-card__name");
          const time = card.querySelector(".active-moths-card__time");
          const swatch = card.querySelector(".active-moths-card__swatch");
          const isFocused = hoverState.hoveredMothId === moth.id;

          card.classList.toggle("is-focused", isFocused);
          card.setAttribute("aria-pressed", isFocused ? "true" : "false");
          card.setAttribute("aria-label", "Focus " + (moth.speciesName || moth.label || moth.id));

          if (name) {
            name.textContent = moth.speciesName || moth.label || moth.id;
          }
          if (time) {
            time.textContent = formatClockTime(moth.entryTime) + " - " + formatClockTime(moth.exitTime);
          }
          if (swatch) {
            swatch.style.background = moth.color;
            swatch.style.color = moth.color;
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

          const activeMoths = activeProjectedKnownMoths();
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
          moths = createMoths(config, rect.width, rect.height);
        }

        function preloadSpeciesImages() {
          config.species.forEach((species) => {
            const imageURL = species.imageURL;
            if (!imageURL || hoverState.imageCache.has(imageURL)) {
              return;
            }

            const image = new Image();
            const record = {
              image,
              loaded: false,
              failed: false
            };

            hoverState.imageCache.set(imageURL, record);
            image.crossOrigin = "anonymous";
            image.addEventListener("load", () => {
              record.loaded = true;
              drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
            });
            image.addEventListener("error", () => {
              record.failed = true;
            });
            image.src = imageURL;
          });
        }

        function tick(timestamp) {
          if (lastTimestamp === null) {
            lastTimestamp = timestamp;
          }

          const deltaSeconds = ((timestamp - lastTimestamp) / 1000) * config.animation.playbackSpeed;
          lastTimestamp = timestamp;

          if (isPlaying) {
            animationTime = normalizeAnimationTime(animationTime + deltaSeconds);
            audio.update(animationTime, deltaSeconds);
          }

          drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, timestamp, animationTime, hoverState, presentationMode);
          updateTimelineControls();
          updateActiveMothsPanel();
          requestAnimationFrame(tick);
        }

        function findHoveredMoth(pointerX, pointerY) {
          const width = canvas.clientWidth;
          const height = canvas.clientHeight;
          const cx = width / 2;
          const cy = height * config.scene.centerYRatio;

          return moths
            .map((moth) => projectMoth(moth, animationTime, width, height, cx, cy, false))
            .filter((moth) => moth && moth.species !== "unknown" && moth.opacity > 0.05)
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

        function clearHover() {
          hoverState.hoveredMothId = null;
          canvas.style.cursor = "default";

          if (isHoverPaused && !isScrubbing) {
            isPlaying = wasPlayingBeforeHover;
            lastTimestamp = null;
          }

          isHoverPaused = false;
        }

        function updateHover(event) {
          if (!canHover) {
            return;
          }

          const rect = canvas.getBoundingClientRect();
          const pointerX = event.clientX - rect.left;
          const pointerY = event.clientY - rect.top;
          const hoveredMoth = findHoveredMoth(pointerX, pointerY);

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
          const tappedMoth = findHoveredMoth(pointerX, pointerY);

          event.preventDefault();

          if (!tappedMoth || tappedMoth.id === hoverState.hoveredMothId) {
            clearHover();
            drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
            return;
          }

          setFocusedMoth(tappedMoth.id);

          drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
        }

        scrubber.addEventListener("pointerdown", () => {
          isScrubbing = true;
          wasPlayingBeforeScrub = isHoverPaused ? wasPlayingBeforeHover : isPlaying;
          isPlaying = false;
        });

        scrubber.addEventListener("input", () => {
          animationTime = clampAnimationTime(Number(scrubber.value));
          drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
          updateTimelineControls();
        });

        scrubber.addEventListener("pointerup", () => {
          isScrubbing = false;
          if (hoverState.hoveredMothId) {
            wasPlayingBeforeHover = wasPlayingBeforeScrub;
            isPlaying = false;
            isHoverPaused = true;
          } else {
            isPlaying = wasPlayingBeforeScrub;
            isHoverPaused = false;
          }

          lastTimestamp = null;
        });

        scrubber.addEventListener("change", () => {
          animationTime = clampAnimationTime(Number(scrubber.value));
          isScrubbing = false;
          if (hoverState.hoveredMothId) {
            wasPlayingBeforeHover = wasPlayingBeforeScrub;
            isPlaying = false;
            isHoverPaused = true;
          } else {
            isPlaying = wasPlayingBeforeScrub;
            isHoverPaused = false;
          }

          lastTimestamp = null;
        });

        if (activeMothsToggle && activeMothsPanel) {
          activeMothsToggle.addEventListener("click", () => {
            const isOpen = !activeMothsPanel.classList.contains("is-open");
            activeMothsPanel.classList.toggle("is-open", isOpen);
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
        preloadSpeciesImages();
        updateTimelineControls();
        requestAnimationFrame(tick);

        return {
          setPresentationMode(mode) {
            presentationMode = mode;
            if (mode !== "light-only" && !isScrubbing && !isHoverPaused) {
              isPlaying = config.animation.autoplay;
              lastTimestamp = null;
            }
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

      setupLaunchScreen();
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
