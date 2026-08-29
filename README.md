# iNaturalist Moth Lights

This project will turn recently uploaded moth observations from around the world on iNaturalist into a continuous, living animation around a glowing moth light. New observations will enter a calm, bounded stream with species details, photographs and attribution, while making clear that the display represents recently shared records rather than real-time moth abundance or movement.

The project builds on the visual design and animation engine developed in [tomaugust/moth-lights-animation](https://github.com/tomaugust/moth-lights-animation). See that original repository for details of how the canvas animation, moth movement, interactions and audio work. The completed initial API research, timing model, decisions and reproducible spike are documented in [research/phase-0.md](research/phase-0.md).

## Project structure

Phase 1 extracted the previous single-file, PowerShell-generated `index.html` into plain ES modules so the live site can be developed as normal source files:

- `index.html` — thin HTML shell that loads `styles/main.css` and `src/app.js`.
- `styles/main.css` — all animation, layout and control styling.
- `src/config-store.js` — the shared, live-updating config binding.
- `src/animation-engine.js` — moth physics, orbit math and canvas drawing (stateless, pure functions).
- `src/audio-engine.js` — chime and drone synthesis.
- `src/app.js` — DOM wiring, canvas controller, launch screen, and the bootstrap that fetches `config/site-config.json` and starts the animation.
- `config/site-config.json` — the real animation/species/moth data currently shown on the site.

This still has no live iNaturalist data behind it (that's Phase 2+); it is the same static, fixed-timeline animation as before, just as source files instead of one generated file.

### Run it locally

The app fetches its config over `fetch()`, so it needs to be served over HTTP rather than opened as a `file://` URL:

```sh
npx http-server . -p 8080
# then open http://localhost:8080/
```

Any static file server works equally well (`python3 -m http.server`, `npx serve`, etc.).

### Legacy offline export

`scripts/build-standalone.ps1` still generates a single, emailable HTML file from a config JSON (see `public/example-config.json` / `public/template-config.json`) for anyone who needs an offline copy. It's no longer the primary way this site is built or deployed, and its PowerShell here-string does not survive JS template literals unescaped (`` ` `` and `${...}` inside the embedded script get interpreted by PowerShell) — a known caveat to fix before relying on it again.
