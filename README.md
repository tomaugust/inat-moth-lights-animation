# moths.live — iNaturalist Moth Lights

[![Status: in production](https://img.shields.io/badge/status-in%20production-brightgreen)](https://moths.live)
[![CI](https://github.com/tomaugust/inat-moth-lights-animation/actions/workflows/ci.yml/badge.svg)](https://github.com/tomaugust/inat-moth-lights-animation/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Live site: https://moths.live** (also at https://tomaugust.github.io/inat-moth-lights-animation/)

A living animation of moths being recorded around the world, right now. Every moth that flies around the glowing light is a real moth that someone has just photographed and uploaded to [iNaturalist](https://www.inaturalist.org). A faint world map sits behind the light, and each new arrival ripples out from the place it was seen.

## Aims

- **Make citizen science tangible.** Moth records is usually experienced as a database of observations. Here you can watch it happen: people in different countries and time zones adding sightings of moths, minute by minute.
- **Evoke a moth light trap.** The scene deliberately echoes the experience of running a light trap on a summer night: a bright light in the dark, moths drifting in from the edges, circling, and leaving again.
- **Need no backend.** It is a static website that talks directly to the public iNaturalist API.

The visual design and animation engine build on [tomaugust/moth-lights-animation](https://github.com/tomaugust/moth-lights-animation).

## What you see and hear

- **Launch screen.** A rocker light switch; flip it to turn the light on and start the animation.
- **The light and the moths.** Each moth orbits the light as a flapping, side-on moth. Its colour, size, speed and flight style are derived deterministically from its taxon, so the same species always looks the same. Moths not identified to species level share a neutral grey style.
- **The world map.** A Robinson-projection map of the world sits behind the scene, fading into the background at its edges. When a moth arrives, a ripple spreads from where it was observed, followed by a small breathing ring that stays for as long as the moth is on screen.
- **Active moths panel.** A side panel lists every moth currently on screen as a card: photo, common or scientific name, upload time, how precisely it was identified, where it was observed, photo credit and licence, and a "View observation" link.
- **Hover to pause.** Hovering a moth, its card or its ring on the map freezes the whole scene and shows a pop-out with the same details. Moving away resumes.
- **Sound.** Off by default; the toggle at the bottom right turns on a soft drone, pentatonic chimes for each species, and a low "woooow" timed with each arrival ripple.
- **Loading state.** While the first response is pending, the scene is greyed out with a spinner around the light.

## How it works

```
iNaturalist API ──► InatClient ──► ObservationQueue ──► MothStore ──► canvas renderer
 (v2 observations)    fetch +        dedupe, order,       active moths,   light, moths,
                      normalize      pace releases        lifecycles      map, cards, audio
```

1. **Fetching** (`src/inaturalist-client.js`). The browser polls `api.inaturalist.org/v2/observations` every 30 seconds for new moth observations with photos under a Creative Commons licence. The scope is Lepidoptera excluding Papilionoidea (butterflies and skippers). The first request asks only for the last two minutes of uploads; later requests continue from the highest observation id seen, so only new records are returned. Only the fields the animation needs are requested. The client handles rate limiting (`429`/`Retry-After`), jittered exponential backoff, going offline and online, and tab visibility.
2. **Validating** (`src/observation-adapter.js`). Every record passes through a single validation point. Records without an id, an upload time, a usable photo or an identification to at least family level are discarded, so every moth shown is at least recognisable as a kind of moth.
3. **Pacing** (`src/observation-queue.js`). The queue removes duplicates, sorts by upload time and releases observations at the same gaps they were uploaded with (bounded between 0.75 and 30 seconds), so what you see follows the real rhythm of uploads. If a backlog builds up, it is thinned to a sample that round-robins across species so a common species cannot crowd out the rest.
4. **Lifecycles** (`src/moth-store.js`). Admitted observations become moths. Each gets an independent entry, orbit and exit lifecycle on a monotonic clock. At most ten are active, and the scene is never left empty: the last moth is held in orbit until another arrives.
5. **Rendering** (`src/animation-engine.js`, `src/world-map.js`, `src/robinson-projection.js`). Pure functions project each moth's orbit and draw the light, moths, trails, labels and pop-outs on a canvas; the map layer draws antimeridian-aware borders and the arrival rings.
6. **Audio** (`src/audio-engine.js`). Web Audio synthesis driven by the moths that are actually on screen.
7. **Fallback** (`src/fallback-observations.js`). If a first page load cannot reach iNaturalist at all, a bundled capture of several hundred real observations from a busy 15-minute window is replayed through the same pipeline, with a short banner explaining what is being shown. It is replaced by live data the moment a real response arrives.

### Configuration

`config/site-config.json` holds the presentation settings for the light, scene and audio (colours, glow, orbit tilt, drone and chime settings). Polling and pacing settings live where they are used: `src/app.js`, `src/moth-store.js` and `src/observation-queue.js`.

Appending `?debug` to the URL shows a small diagnostic readout (connection state, request and observation counts, queue and store sizes).

## Repository layout

```
index.html              page shell
styles/main.css         layout and styling
config/                 scene, light and audio settings
src/                    application modules (plain ES modules, no build step)
public/                 low-resolution world borders for the map
favicon.svg
scripts/dev-server.mjs  zero-dependency static server for local development and tests
test/unit/              node:test unit tests
test/e2e/               Playwright end-to-end tests
test/fixtures/          shared test data
.github/workflows/      CI and GitHub Pages deployment
```

There is no build step: the files in the repository are the files that are served.

## Running locally

The app fetches its config with `fetch()`, so it must be served over HTTP rather than opened as a `file://` URL:

```sh
npm install
npm run serve   # http://localhost:8080/
```

Any static file server works equally well (`python3 -m http.server`, `npx serve`, …). Running locally makes real requests to the iNaturalist API.

## Testing

```sh
npm run lint       # ESLint
npm run test:unit  # node:test: pure logic, no browser, no network
npm run test:e2e   # Playwright: drives the real page with the iNaturalist API mocked
npm test           # unit tests
```

The end-to-end tests need a Chromium build. `npx playwright install --with-deps chromium` downloads one; alternatively point at an existing binary with `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:e2e`. No test ever contacts the real iNaturalist API.

CI (`.github/workflows/ci.yml`) runs lint, unit tests and end-to-end tests on every push and pull request.

## Deployment

Pushes to `main` are deployed to GitHub Pages by `.github/workflows/pages.yml`. The custom domain is set in `CNAME`.

## Data, attribution and privacy

- All sightings come from [iNaturalist](https://www.inaturalist.org). Each moth's card and pop-out credit the photographer and licence and link back to the original observation.
- Only photos with a Creative Commons licence are used. The animation requests no user profiles, only the public fields it displays, and stores nothing about visitors.
- The visitor's browser queries iNaturalist directly; browsers cannot set a custom `User-Agent`, so requests are anonymous and rate-limited by iNaturalist like any other.

## Credits

Created by [Tom August](https://www.ceh.ac.uk/staff/tom-august). Released under the [MIT License](LICENSE).
