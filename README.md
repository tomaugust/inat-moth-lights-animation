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
npm install
npm run serve
# then open http://localhost:8080/
```

Any static file server works equally well (`python3 -m http.server`, `npx serve`, etc.).

## Testing

```sh
npm install

npm run lint       # ESLint over src/, scripts/ and test/
npm run test:unit  # node:test against the pure animation/audio logic, no browser needed
npm run test:e2e   # Playwright: boots the real page and drives it end to end
npm test           # unit tests only (what CI's fast path runs first)
```

Unit tests (`test/unit/`) cover the pure functions in `src/animation-engine.js` and `src/audio-engine.js` (orbit math, seeded randomness, color/time formatting) against a small hand-written fixture in `test/fixtures/sample-config.mjs` — no DOM or browser involved.

End-to-end tests (`test/e2e/`) spin up the zero-dependency static server in `scripts/dev-server.mjs` and drive the real page with Playwright: launch screen → animation start, the active-moths side panel populating, the sound toggle, and a check that nothing lands in the browser console or throws.

Playwright needs a Chromium build. `npm ci && npx playwright install --with-deps chromium` (as CI does) downloads one; in an environment that already provides a compatible browser binary, point at it instead with `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:e2e` to skip the download.

CI (`.github/workflows/ci.yml`) runs lint, unit tests and the Playwright suite on every push and pull request.

### Legacy offline export

`scripts/build-standalone.ps1` still generates a single, emailable HTML file from a config JSON (see `public/example-config.json` / `public/template-config.json`) for anyone who needs an offline copy. It's no longer the primary way this site is built or deployed, and its PowerShell here-string does not survive JS template literals unescaped (`` ` `` and `${...}` inside the embedded script get interpreted by PowerShell) — a known caveat to fix before relying on it again.
