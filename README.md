# Moth Trap Animation Generator

IN DEVELOPMENT

Create a standalone HTML moth-trap animation from a JSON config file. The generated HTML has all CSS, JavaScript, and animation data embedded, so it can be emailed as an attachment and opened directly in a browser.

View the current example on GitHub Pages:

https://tomaugust.github.io/moth-lights-animation/

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
    "duration": 80,
    "timeLabel": "Time",
    "startClockTime": "22:00",
    "playbackSpeed": 1,
    "autoplay": true,
    "loop": true
  },
  "audio": {
    "enabled": true,
    "volume": 0.12,
    "chimeProbability": 0.26,
    "noteDecay": 8,
    "minInterval": 1.1,
    "droneEnabled": true,
    "droneNotes": ["C2", "G2", "C3"],
    "droneVolume": 40
  },
  "scene": {
    "showGround": false,
    "centerYRatio": 0.56,
    "horizonYRatio": 0.34,
    "orbitTilt": 0.28,
    "groundBackColor": "#212121",
    "groundFrontColor": "#dbdbdb",
    "lightPoolColor": "rgba(255, 239, 188, 0.58)"
  },
  "light": {
    "size": 15,
    "color": "#fffdf4",
    "glowColor": "rgba(255, 250, 226, 0.82)",
    "glowRadius": 200,
    "shadowBlur": 20,
    "flickerStrength": 0.01,
    "flickerSpeed": 0.006
  },
  "species": [
    {
      "id": "large-yellow-underwing",
      "name": "Large Yellow Underwing",
      "color": "#d7b46a",
      "chimeNote": "C3",
      "chimeNotes": ["C3", "G3", "E4"],
      "size": 7,
      "speed": 0.85,
      "erraticness": 3,
      "inclinationDriftSpeed": 0.1,
      "nodeDriftSpeed": 0.1,
      "trailLength": 10,
      "shadowColor": "rgba(255, 224, 151, 0.24)",
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

`animation` controls whole-file presentation, including the title and description shown as top-right overlay text, the bottom clock/scrub controls, and species tag size, colour, and duration. `audio` controls the optional windchime synth and sound button. `scene` controls the optional ground plane and oblique projection. `light` controls the bright trap light, glow, flicker, and hanging bulb fixture. `species` defines shared visual, motion, trail, glow, and sound settings. `moths` defines individual moth observations.

Animation timing fields are animation seconds. `animation.duration` controls the loop length, and each moth's `entryTime` and `exitTime` control when it flies in, orbits, and flies out. For the displayed clock, each animation second is represented as one clock minute. `animation.playbackSpeed` is a multiplier for overall playback speed; `2` plays twice as fast and `0.5` plays half speed. `animation.startClockTime` sets the `HH:MM` clock shown in the bottom timeline overlay, and `animation.timeLabel` controls its label.

The generated animation includes a bottom timeline overlay. The `HH:MM` clock is centred above the scrub bar, and the scrub bar lets viewers move backward and forward manually. Dragging the scrub bar pauses playback and releasing it resumes autoplay when autoplay was active.

Audio is generated inside the standalone HTML with the Web Audio API. The animation shows a subtle bottom-right sound button because browsers normally block autoplaying audio until the viewer interacts with the page. Chimes use warm, layered bell partials, select from each species' `chimeNotes`, and only trigger while at least one moth of that species is active. A soft configurable background drone can play under the chimes. Toggling sound off immediately mutes the chimes, delay tail, and drone.

When a moth enters, its species name briefly appears as a centred tag near the light glow. Tags stack vertically, with new names appended at the bottom and older names moving upward. Species labels use the same font family and computed size as the description overlay. `animation.speciesTagDuration` and `animation.speciesTagColor` control their presentation; when `speciesTagColor` is empty, tags use each species colour.

The light is drawn as a hanging bulb: a fixed-size white core, a small dark fixture above it, and a cord fading upward into black. `light.flickerStrength` changes only the glow opacity and radius; it does not resize the bulb circle.

Useful species-level fields:

- `size`: moth radius in pixels.
- `speed`: orbital speed.
- `color`: moth colour.
- `erraticness`: irregular flight strength. `0` is smooth orbiting; higher values add more organic deviation.
- `inclinationDriftSpeed`: speed of slow drift in orbit tilt.
- `nodeDriftSpeed`: speed of slow drift in orbit orientation.
- `trailLength`: target visual tail length.
- `chimeNote`: fallback windchime note for the species.
- `chimeNotes`: optional note set for richer species chime variation.
- `shadowColor` and `shadowBlur`: glow around the moth.

Useful moth-level fields:

- `id`: unique moth identifier.
- `species`: id of the species this moth belongs to.
- `entryTime` and `exitTime`: seconds on the animation timeline when the moth enters and leaves.

Moth records do not override species attributes. Orbit angle is assigned automatically from moth order, and orbit radius is assigned by the generator from species speed: faster moths get smaller orbits, slower moths get larger orbits. The generated maximum orbit radius is capped below the full viewport radius so moths stay closer to the light.

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

You can then email the generated `.html` file as an attachment.

## Project Files

- `scripts\build-standalone.ps1` generates the HTML attachment.
- `public\example-config.json` is the example JSON input.
- `index.html` is the current generated standalone animation and the GitHub Pages example.
- `.github\workflows\pages.yml` publishes the example to GitHub Pages.
- `README.md` and `context.txt` describe the project and workflow.
