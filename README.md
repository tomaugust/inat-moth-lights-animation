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
    "canvasBackground": "radial-gradient(circle at center, #252018 0%, #07080a 100%)",
    "duration": 80,
    "playbackSpeed": 1,
    "autoplay": true,
    "loop": true
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
      "chimeNote": "E3",
      "size": 13,
      "speed": 0.85,
      "erraticness": 0.72,
      "trailLength": 18
    }
  ],
  "moths": [
    {
      "id": "moth-001",
      "species": "large-yellow-underwing",
      "entryTime": 4,
      "exitTime": 62,
      "angle": 15,
      "radius": 230
    }
  ]
}
```

`animation` controls whole-file presentation, including the title and description shown as top-right overlay text. `scene` controls the optional ground plane and oblique projection. `light` controls the bright trap light, glow, flicker, and hanging bulb fixture. `species` defines shared visual and sound defaults. `moths` defines individual moth observations.

Animation timing fields are measured in seconds. `animation.duration` controls the loop length, and each moth's `entryTime` and `exitTime` control when it flies in, orbits, and flies out. `animation.playbackSpeed` is a multiplier for overall playback speed; `2` plays twice as fast and `0.5` plays half speed.

The light is drawn as a hanging bulb: a fixed-size white core, a small dark fixture above it, and a cord fading upward into black. `light.flickerStrength` changes only the glow opacity and radius; it does not resize the bulb circle.

Useful species-level fields:

- `size`: moth radius in pixels.
- `speed`: orbital speed.
- `color`: moth colour.
- `erraticness`: irregular flight strength. `0` is smooth orbiting; higher values add more organic deviation.
- `trailLength`: number of recent sampled positions used for the fading trail.
- `chimeNote`: planned windchime note for the species.
- `shadowColor` and `shadowBlur`: glow around the moth.

Useful moth-level fields:

- `id`: unique moth identifier.
- `species`: id of the species this moth belongs to.
- `entryTime` and `exitTime`: seconds on the animation timeline when the moth enters and leaves.
- `angle`: starting angle in degrees. Optional.
- `radius`: orbit radius in pixels. Optional; omitted moths are spaced automatically.
- `size`, `speed`, `color`, `erraticness`, `trailLength`, `shadowColor`, and `shadowBlur`: optional overrides for species defaults.

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
