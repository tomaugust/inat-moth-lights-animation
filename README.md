# Moth Trap Animation Generator

IN DEVELOPMENT

Create a smooth, modern, data-driven animation that is an abstract representation of a moth trap. The project takes a JSON configuration file and generates a standalone HTML file with the animation data, CSS, and JavaScript embedded. The generated file can be opened directly from disk or emailed as an HTML attachment.

View the current example on GitHub Pages:

https://tomaugust.github.io/moth-lights-animation/

## Current State

- The project generates `index.html` from JSON using `scripts\build-standalone.ps1`.
- The generated animation is a full-screen canvas scene with top-right title/description overlays and bottom timeline controls.
- The JSON structure separates `animation`, `audio`, `scene`, `light`, `species`, and `moths`.
- Moth records are observation events only: `id`, `species`, `entryTime`, and `exitTime`.
- Species records define appearance, motion, trails, glow, hover content, and sound.
- Moths enter from the left, orbit the light, exit to the right, and fade before the edge.
- Orbits use a low oblique projection, depth sorting, foreground/background opacity, horizontal distance fading, deterministic erratic motion, and slow species-level orbit drift.
- Each moth is assigned a deterministic 50:50 clockwise or counter-clockwise orbit direction.
- Orbit radius is generated from species speed: faster moths use smaller orbits and slower moths use larger orbits.
- Known species use a near-white natural moth palette; unknown moths remain grey.
- The light is a fixed-size hanging bulb with a dark fixture, cord, glow-only flicker, configurable glow/halo opacity, and optional launch-screen reveal.
- Moth shadows are implemented as blurred ray-cast polygons projected away from the light.
- Desktop hover and mobile tap focus known moths, pause playback, highlight the focal moth, fade non-focal moths, and show a popout with species image and description.
- The special `unknown` species is excluded from entry labels and hover/tap popouts.
- Web Audio windchime sound and a configurable drone are generated inside the standalone HTML.
- The example currently uses `scene.showGround: false`, returning the visual to a light in black space.

## Build A Standalone HTML File

From this folder, run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\build-standalone.ps1
```

That reads `public\example-config.json` and writes `index.html`.

To use a different JSON config or output filename:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\build-standalone.ps1 -ConfigPath .\my-config.json -OutputPath .\outputs\moth-animation.html
```

You can then email the generated `.html` file as an attachment. Remote species image URLs keep the generated file small but require an internet connection for images to appear in hover/tap popouts.

## JSON Format

Use this shape:

```json
{
  "animation": {
    "title": "Moth Light Animation",
    "description": "A standalone animation generated from JSON.",
    "backgroundColor": "#101114",
    "textColor": "#f5f1e8",
    "titleColor": "#f5f1e8",
    "titleSize": "clamp(1.25rem, 2.4vw, 2.35rem)",
    "descriptionColor": "#f5f1e8",
    "descriptionSize": "clamp(0.78rem, 1.1vw, 0.98rem)",
    "speciesTagColor": "",
    "speciesTagSize": 13,
    "speciesTagDuration": 10,
    "canvasBackground": "radial-gradient(circle at center, #252018 0%, #07080a 100%)",
    "duration": 360,
    "timeLabel": "Time",
    "startClockTime": "22:00",
    "playbackSpeed": 1.5,
    "autoplay": true,
    "loop": true,
    "launchScreenEnabled": false
  },
  "audio": {
    "enabled": true,
    "volume": 0.12,
    "chimeProbability": 0.26,
    "noteDecay": 8,
    "minInterval": 1.1,
    "droneEnabled": true,
    "droneNotes": ["C3", "G3", "C4"],
    "droneVariation": 0.3,
    "droneBrightness": 0.3,
    "droneVolume": 1
  },
  "scene": {
    "showGround": false,
    "centerYRatio": 0.56,
    "horizonYRatio": 0.34,
    "orbitTilt": 0.28,
    "orbitRadiusScale": 0.7,
    "backgroundMothOpacity": 1,
    "foregroundMothOpacity": 0.6,
    "horizontalFadeEnabled": true,
    "horizontalEdgeMothOpacity": 0.1,
    "mothShadowsEnabled": true,
    "mothShadowOpacity": 0.05,
    "mothShadowLength": 130,
    "mothShadowBlur": 5
  },
  "light": {
    "size": 18,
    "color": "#fffdf4",
    "glowColor": "rgba(255, 250, 226, 0.52)",
    "haloColor": "rgba(255, 244, 201, 0.26)",
    "glowRadius": 260,
    "shadowBlur": 26,
    "flickerStrength": 0.05,
    "flickerSpeed": 0.006
  },
  "species": [
    {
      "id": "large-yellow-underwing",
      "name": "Large Yellow Underwing",
      "imageURL": "https://commons.wikimedia.org/wiki/Special:FilePath/Large%20Yellow%20Underwing%2C%20Noctua%20pronuba%20%2820325748541%29.jpg",
      "speciesDescription": "A common and widespread large moth, often abundant at light traps in peak season.",
      "color": "#eddcb9",
      "chimeNote": "C3",
      "chimeNotes": ["C3", "G3", "E4"],
      "size": 7,
      "speed": 0.6,
      "erraticness": 3,
      "inclinationDriftSpeed": 0.1,
      "nodeDriftSpeed": 0.1,
      "trailLength": 10,
      "shadowColor": "rgba(243, 231, 207, 0.24)",
      "shadowBlur": 16
    }
  ],
  "moths": [
    {
      "id": "moth-001",
      "species": "large-yellow-underwing",
      "entryTime": 4,
      "exitTime": 62
    }
  ]
}
```

## Config Notes

`animation` controls whole-file presentation, including the title and description overlay, bottom clock/scrub controls, species tag presentation, playback, looping, and the optional launch screen. When `launchScreenEnabled` is true, the generated file starts with a full-screen launch screen using the animation background. Clicking the switch fades out the switch, fades in the light alone, then fades in the title, description, clock, scrub bar, and controls.

Animation timing fields are animation seconds. `animation.duration` controls the loop length, and each moth's `entryTime` and `exitTime` control when it flies in, orbits, and flies out. For the displayed clock, each animation second is represented as one clock minute. `animation.playbackSpeed` is a multiplier: `2` plays twice as fast and `0.5` plays half speed. `animation.startClockTime` sets the `HH:MM` clock shown above the scrub bar.

`audio` controls the optional windchime synth and sound button. Browser audio is unlocked by the viewer via the bottom-right sound button. Chimes use warm, layered bell partials, select from each species' `chimeNotes`, and only trigger while at least one moth of that species is active. Chime probability is proportional to active moth count. A soft configurable background drone can play under the chimes. `audio.droneVolume` is a multiplier: `1` is the intended level, `2` is twice that level, and `0` is silent. `audio.droneVariation` and `audio.droneBrightness` are `0` to `1` controls. The example avoids very low drone notes because small speakers can reproduce them as flutter or distortion. Toggling sound off immediately mutes the chimes, delay tail, and drone.

`scene` controls the optional ground plane, oblique projection, moth opacity cues, generated orbit radius scale, and moth shadows. `horizontalEdgeMothOpacity` is the moth opacity at `light.glowRadius * 1.5` from the light. Moth shadows are blurred ray-cast polygons: each starts at the sides of the moth and extends away from the light along lines from the light through those sides. `mothShadowOpacity`, `mothShadowLength`, and `mothShadowBlur` control their strength, reach, and softness.

`light` controls the bright trap light, glow, flicker, and hanging bulb fixture. `glowColor` and `haloColor` set the radial gradient colours and opacity through their RGBA alpha channels. `flickerStrength` changes only the glow opacity and radius; it does not resize the bulb circle.

`species` defines shared visual, motion, trail, glow, hover, and sound settings. Useful species-level fields:

- `id`: unique species identifier used by moth records.
- `name`: display name for species labels and popouts.
- `imageURL`: optional species image shown in hover/tap popouts.
- `speciesDescription`: optional short species description shown in hover/tap popouts.
- `size`: moth radius in pixels.
- `speed`: orbital speed.
- `color`: moth colour.
- `erraticness`: irregular flight strength. `0` is smooth orbiting; higher values add more organic deviation.
- `inclinationDriftSpeed`: speed of slow drift in orbit tilt.
- `nodeDriftSpeed`: speed of slow drift in orbit orientation.
- `trailLength`: target visual tail length.
- `chimeNote`: fallback windchime note for the species.
- `chimeNotes`: optional note set for richer species chime variation.
- `shadowColor` and `shadowBlur`: glow around the moth itself.

`moths` defines individual moth observations. Moth records do not override species attributes. Useful moth-level fields:

- `id`: unique moth identifier.
- `species`: id of the species this moth belongs to.
- `entryTime` and `exitTime`: seconds on the animation timeline when the moth enters and leaves.

Orbit angle is assigned automatically from moth order, orbit direction is assigned automatically with a deterministic 50:50 clockwise/counter-clockwise split, and orbit radius is assigned by the generator from species speed.

## Interaction

The generated animation includes a bottom timeline overlay. The `HH:MM` clock is centred above the scrub bar, and the scrub bar lets viewers move backward and forward manually. Dragging the scrub bar pauses playback and releasing it resumes autoplay when autoplay was active.

When a known moth enters, its species name briefly appears as a centred tag near the light glow. Tags stack vertically, with new names appended at the bottom and older names moving upward. When `animation.speciesTagColor` is empty, tags use each species colour.

Desktop hover and mobile tap focus a known moth, pause playback, highlight the focal moth, fade the others, and show a popout containing the species name, active time window, image, and description. Unknown moths are excluded from this interaction.

## Development Plan

### Mission

Create a smooth, modern, professional, data-driven animation that is an abstract representation of a moth trap. The final output should remain a standalone HTML file that can be generated from a JSON config and emailed as an attachment.

### Next Step

1. Document config metrics. [NEXT]
   - Document every JSON config metric with its minimum, maximum, default value, and a detailed description of how it affects the animation or audio.
   - Cover `animation`, `audio`, `scene`, `light`, `species`, and `moths`.
   - Decide whether this belongs in the README only or a separate generated config reference.

2. Polish and test.
   - Open `index.html` directly from disk and check visual playback.
   - Check GitHub Pages rendering after push.
   - Check mobile layout and scrub behaviour.
   - Check launch-screen sequencing when enabled.
   - Check shadow tuning at different light/glow opacity levels.
   - Check sound toggle, immediate mute, drone level, and chime pacing in a browser.
   - Check external runtime dependencies: known species popout images currently use remote URLs, so the file is standalone for code/data but not fully offline for those images.

### Planned Enhancements

- Add a subtle expansion button on the right side that opens a side panel listing all currently active known moths.
- Each active moth should appear as a card in the side panel, with cards fading in on entry and fading out on exit.
- Cards should self-sort so as cards leave through an animated fade and movement to the right, cards below shuffle up to fill the space.
- New cards should be added from the bottom.
- If there are more cards than fit on screen, a subtle scroll bar should appear.
- Hovering over a side-panel card should produce the same focal effect as hovering over that moth in the main animation window.
- Tune moth shadow parameters so they add depth without muddying trails or the glow.

### Future Data Work

- Define a lightweight raw data ingestion workflow for converting CSV-based trap observations into the JSON format that drives the animation.
- Prefer a one-line command using only standard-library tooling, for example `python scripts/convert-csv.py raw-data.csv output.json` or `node scripts/convert-csv.mjs raw-data.csv output.json`.
- The conversion should handle common cleanup tasks such as trimming whitespace, normalizing species names, parsing timestamps to `entryTime`/`exitTime`, and filling defaults for missing fields.
- Keep the workflow simple to run with limited installation requirements, avoiding non-standard libraries where possible.
- Consider optional build-time embedding of species images so emailed HTML attachments can show popout images without internet access.
- Future moth counts and timings should come from real trap observation data.
- Animation time should represent real clock time from the trap.
- Trap/location information can be shown in the top-right overlay.

### Success Criteria

- A generated HTML file opens directly from disk and plays without a server.
- The scene reads as a moth trap: bright light, moths circling, and a clean abstract presentation.
- The motion feels smooth, alive, and not mechanical.
- The JSON controls global scene properties, species properties, audio settings, and individual moth timing.
- The animation remains professional and uncluttered with multiple moths active.
- Manual scrubbing works cleanly and the animation loops reliably.
- Windchime audio can be enabled by the viewer, remains warm and subtle, and mutes immediately when disabled.

## Project Files

- `scripts\build-standalone.ps1` generates the HTML attachment.
- `public\example-config.json` is the example JSON input.
- `index.html` is the current generated standalone animation and the GitHub Pages example.
- `.github\workflows\pages.yml` publishes the example to GitHub Pages.
- `README.md` is the single project documentation and development-plan file.
