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

`index.html` itself still has no live iNaturalist data behind it — it is the same static, fixed-timeline animation as before, just as source files instead of one generated file. The pieces below run alongside it, unused by the production page, in preparation for Phase 3+ swapping in a real API poller.

Phase 2 added the live-data engine components, proven against the recorded fixtures from Phase 0 rather than a real API call:

- `src/observation-adapter.js` — validates and normalizes a raw observation payload (the contract in `fixtures/observations-*.json`) into records the rest of the app can trust; a missing id or unparseable date drops just that record instead of breaking the batch.
- `src/species-style.js` — deterministic per-taxon visual/audio styling (color, chime notes, size, speed, drift) hashed from the taxon ID, so a global stream never needs a hand-maintained species list. Anything not identified to species level gets one shared grey "unknown" profile.
- `src/observation-queue.js` — dedupes by observation id, paces release by the source `createdAt` gaps (scaled, jittered, clamped), caps how many overdue observations catch up in one call, keeps the oldest observations on overflow, and persists its cursor/seen-id window (tolerating missing or corrupt storage).
- `src/moth-store.js` — the mutable replacement for the old fixed `config.moths` timeline: each observation gets an independent entry/orbit/exit lifecycle from a monotonic clock, bounded to `maxActiveMoths`, with a focused (hovered/tapped) moth kept alive past its exit until focus clears or a grace period elapses. Its output is drop-in compatible with `animation-engine.js`'s `projectMoth`/`drawScene` — no rendering code changed.
- `fixtures-demo.html` / `src/fixtures-demo.js` — a minimal page (no launch screen, audio or side panel — that polish is Phase 5) wiring all of the above together: it polls the three committed fixture files on a loop, replaying them with relabeled ids/timestamps after the first pass so the queue and store are exercised continuously rather than draining once, and shows a live active/pending count for an easy soak check.

Phase 3 added a real (development-only) API poller, reusing the same queue/store/adapter from Phase 2 unchanged:

- `src/inaturalist-client.js` — polls the real `https://api.inaturalist.org/v2/observations` directly from the browser (the Phase 0 spike confirmed CORS allows this for a prototype), maps each raw v2 result into the same contract shape `observation-adapter.js` already validates, advances the `id_above` cursor so pages aren't replayed, and never overlaps polls. It tracks the `starting` / `live` / `quiet` / `stale` / `offline` / `rate-limited` / `fatal-schema-error` connection states from inat_website.txt section 7, honors `Retry-After` on a 429, backs off with jitter on other failures (resetting after a success), and stops polling on `offline`/resumes immediately on `online`. A browser `fetch()` cannot set a custom `User-Agent` header, so the "descriptive User-Agent" requirement from section 5.2 genuinely can't be met until Phase 4's server-side adapter exists — this file documents that rather than pretending otherwise.
- `live-demo.html` / `src/live-demo.js` — wires the client into the Phase 2 queue/store/renderer and shows connection state, request count and an observed observations/minute rate next to the Phase 0 measurement (~25-41/min) for comparison. **This page is deliberately not deployed** (see `.github/workflows/pages.yml`) — it makes real requests to a third party, and Phase 3 is explicitly a local dev prototype, not the production architecture.

Phase 4 adds the shared cache/API adapter — a Cloudflare Worker sitting between every visitor's browser and iNaturalist:

- `worker/src/index.js` — validates and normalizes upstream responses (reusing `mapRawObservationToContract`/`buildQueryUrl` from `src/inaturalist-client.js` and `parseObservationsResponse` from `src/observation-adapter.js` unchanged, so the contract can't drift between the direct-client and adapter paths), sets a real `User-Agent` (something only a server-side fetch can do — a browser silently strips a custom one), and restricts CORS to an allow-listed origin list. Rather than caching per client cursor, it always asks upstream for the freshest page and caches **that one response** for every caller for a short shared TTL (default 120s) — so any number of concurrent browsers within that window costs exactly one upstream request; each client's own `ObservationQueue` already dedupes by id, so handing everyone "the latest snapshot" is exactly what a shared feed should do. On a timeout, 429, or non-2xx from upstream it falls back to a separate, much-longer-lived "last known good" cached copy marked `stale: true` — never an empty/fabricated list — so a real outage degrades gracefully instead of breaking every viewer at once.
- `worker/wrangler.toml` — Cloudflare Worker config: allow-listed CORS origins, taxon scope, page size, cache TTL, recent-hours window, upstream timeout, all as `[vars]` you can tune per-deployment.
- `src/inaturalist-client.js` gained a `buildUrl`/`upstreamShape: "adapter-contract"` option so the exact same `InatClient` (state machine, backoff, overlap prevention — all unchanged) can point at a deployed adapter instead of iNaturalist directly, treating the response as the already-normalized contract instead of a raw v2 page.
- `buildQueryUrl` also bounds every request by **time and place** instead of querying worldwide with no window at all: a rolling `created_d1`/`created_d2` window (`RECENT_HOURS`, default 48h) plus a lat/lng bounding box currently hardcoded to the UK (`UK_BOUNDING_BOX`). An unbounded sort-by-recency (or an indefinite `id_above` walk) is both expensive for iNaturalist to compute and structurally indistinguishable from systematic full-history scraping regardless of how little actually comes back — this is a deliberate, temporary stopgap ahead of scoping each visitor by their own detected location, not a permanent design decision. See `research/phase-4-rate-limiting-investigation.md` for why this was added (a sustained rate-limiting incident after the worker's first deploy) and what's still unverified about it (v2 API param support, the correct `place_id` for the UK).

**Not yet deployed.** Deploying a Cloudflare Worker needs a real Cloudflare account/credentials, which this environment doesn't have — the code, tests and config are ready, but nobody has run `wrangler deploy` yet.

Update `ALLOWED_ORIGINS` in `wrangler.toml` first if your GitHub Pages URL or local dev port differ from the defaults. Once deployed, the production frontend can be pointed at it by constructing an `InatClient` with `buildUrl: () => "<your-worker-url>/observations"` and `upstreamShape: "adapter-contract"` — that wiring (and any production `index.html` changes) is intentionally not done yet, since pointing the live site at a URL that doesn't exist would break it.

There are two ways to deploy:

**Option A — from your own machine**, if you're comfortable running Wrangler locally:

```sh
cd worker
npx wrangler login          # opens a browser OAuth flow, no pasted secrets
npx wrangler deploy         # publishes to <name>.<your-subdomain>.workers.dev
```

**Option B — via GitHub Actions** (`.github/workflows/deploy-worker.yml`), if you'd rather not run Wrangler (and the native binaries it pulls in, e.g. esbuild) on your own machine at all. This runs `wrangler deploy` inside GitHub's CI runner on every push to `main` that touches `worker/` (or the shared client/adapter modules it bundles), or on demand via the Actions tab's "Run workflow" button. It needs two repository secrets, set once under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — create at https://dash.cloudflare.com/profile/api-tokens using the **"Edit Cloudflare Workers"** template (don't grant broader permissions than that).
- `CLOUDFLARE_ACCOUNT_ID` — shown in the Cloudflare dashboard sidebar, or via `wrangler whoami` once logged in anywhere.

Until both secrets are set, the workflow runs but skips the deploy step with a warning rather than failing — so it's safe to merge before Cloudflare is set up.

### Run it locally

The app fetches its config over `fetch()`, so it needs to be served over HTTP rather than opened as a `file://` URL:

```sh
npm install
npm run serve
# then open http://localhost:8080/               (the production animation)
# or       http://localhost:8080/fixtures-demo.html (the Phase 2 fixture/queue/store demo)
# or       http://localhost:8080/live-demo.html     (the Phase 3 real-API prototype — makes real requests to iNaturalist)
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

Unit tests (`test/unit/`) cover:
- the pure functions in `src/animation-engine.js` and `src/audio-engine.js` (orbit math, seeded randomness, color/time formatting) against a small hand-written fixture in `test/fixtures/sample-config.mjs`;
- `src/observation-adapter.js` against the real committed fixtures plus deliberately broken records (missing id, missing/invalid `createdAt`, no taxon, an incomplete photo);
- `src/species-style.js`'s determinism, bounds, and unknown-taxon fallback;
- `src/observation-queue.js`'s dedup/sort/pacing/catch-up-cap/overflow behavior (with an injected clock, no real timers) and its persistence against fake and deliberately corrupt storage;
- `src/moth-store.js`'s admit/expire/focus/capacity logic, plus one check that its output actually renders through the real `projectMoth()`.
- `src/inaturalist-client.js` against a fake `fetch`/timer/clock (never the real API): mapping a raw v2 result, cursor advancement, overlap prevention, 429/`Retry-After` and jittered backoff, stale-then-recovers on a server error or network failure, the fatal-schema-error stop, offline/online handling, and adapter-contract mode.
- `worker/src/index.js` against a fake `fetch` and a fake Cache implementation (with a fake clock, so Cache-Control TTLs don't need real waiting): CORS origin allow-listing, the shared single-upstream-request-per-TTL-window behavior, the real `User-Agent`, and every upstream failure mode (429, 5xx, network error, malformed/unexpected shape) falling back to the last-known-good cached contract — or a stale empty list, never a throw — instead of a hard failure.

No DOM or browser — and no real network request — is involved in any of the above.

End-to-end tests (`test/e2e/`) spin up the zero-dependency static server in `scripts/dev-server.mjs` and drive the real pages with Playwright:
- `site.test.js` — the production page: launch screen → animation start, the active-moths side panel populating, the sound toggle, and a check that nothing lands in the browser console or throws;
- `fixtures-demo.test.js` — the Phase 2 demo: the fixture loads and moths are admitted and drawn, and the active count both stays within `maxActiveMoths` and comes back down (proving expired moths are actually removed, not just capped);
- `live-demo.test.js` — the Phase 3 demo with the real `api.inaturalist.org` request intercepted (`page.route`) and answered with a canned response: a normal poll renders moths with a `live` connection state, and a mocked 429 recovers without throwing.

Playwright needs a Chromium build. `npm ci && npx playwright install --with-deps chromium` (as CI does) downloads one; in an environment that already provides a compatible browser binary, point at it instead with `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:e2e` to skip the download.

CI (`.github/workflows/ci.yml`) runs lint, unit tests and the Playwright suite on every push and pull request.

### Legacy offline export

`scripts/build-standalone.ps1` still generates a single, emailable HTML file from a config JSON (see `public/example-config.json` / `public/template-config.json`) for anyone who needs an offline copy. It's no longer the primary way this site is built or deployed, and its PowerShell here-string does not survive JS template literals unescaped (`` ` `` and `${...}` inside the embedded script get interpreted by PowerShell) — a known caveat to fix before relying on it again.
