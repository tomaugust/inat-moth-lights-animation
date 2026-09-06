# iNaturalist Moth Lights — working notes for Claude

Living canvas animation of recently-uploaded iNaturalist moth observations.
See `README.md` for the full project/architecture writeup (Phases 1-4). This
file is the fast-orientation entry point for picking work back up.

## Right now (as of the last session)

Phase 4 (the Cloudflare Worker shared cache/adapter, `worker/`) is deployed
at `https://inat-moth-lights-adapter.tomaugust1985.workers.dev` and merged to
`main` via PR #4. Immediately after, it started getting sustained
rate-limiting (`429`s) from iNaturalist that persisted for hours. That's been
investigated and a fix has been written and unit-tested, but **not yet
verified against the real, live worker**.

**Read `research/phase-4-rate-limiting-investigation.md` before touching
anything Worker- or query-related** — it has the full timeline, what's
confirmed vs. still-unverified, and the specific next steps the user asked
for, including:
- Reading iNaturalist's actual API docs to confirm `created_d1`/`created_d2`
  and `swlat`/`swlng`/`nelat`/`nelng` are valid on the **v2** endpoint (only
  confirmed on v1 so far), and whether `place_id` is a better way to scope by
  country than the current hand-rolled UK bounding box.
- Finding the *correct, verified* iNaturalist `place_id` for the UK if so —
  a candidate value (`6857`) came up in a web search but **failed
  verification** and must not be trusted or reused without confirming it
  against the real API/docs.
- Live-verifying the already-shipped fixes (48h/UK query bounding, 120s
  cache TTL, `Retry-After`-aware smoke test) against the real deployed
  worker — only unit-tested with fakes so far.

**This new session should have broader network access than the one that did
this investigation** (which could not reach `api.inaturalist.org`,
`developers.cloudflare.com`, or almost anything outside a small allowlist —
that's *why* several things above are unverified). Use that access to check
things directly rather than continuing to infer from web search summaries.

**Do not start wiring the production frontend to the live worker** until the
above is confirmed working — that's the next planned step after, not
before.

## Standing rules for this project

- Designated dev branch: `claude/repository-review-iok690`, against `main`.
  If its PR merged, restart it from `main`
  (`git fetch origin main && git checkout -B claude/repository-review-iok690 origin/main`)
  rather than stacking on merged history.
- **Never proactively check whether a PR has merged.** The user tells you
  when they've merged something — don't poll for it.
- Prefer "Squash and merge" for PRs touching `.github/workflows/deploy-worker.yml`
  (its live-verification process leaves TEMP-widen/revert commit pairs in
  history).
- Live-verifying the deploy workflow means temporarily adding the dev branch
  to `deploy-worker.yml`'s `on.push.branches`, pushing, watching the run,
  then **reverting that trigger change** before opening/merging any PR —
  don't skip the revert.
- Be deliberate about hitting the live worker at all: repeated rapid
  redeploy-and-verify cycles are the likely cause of the rate-limiting
  incident above. Prefer one careful check over several quick ones.
- Every network-touching module takes injectable `fetchImpl`/`now`/
  `setTimeoutImpl`/`clearTimeoutImpl` (see `src/inaturalist-client.js`,
  `worker/src/index.js`). Tests never hit the real API — fake `fetch` +
  fake clock for unit tests, Playwright `page.route()` interception for
  e2e. Keep following this pattern for new tests.
- `npm run lint`, `npm run test:unit`, `npm run test:e2e` should all be
  clean before pushing. If Playwright can't find its browser (a version/
  revision mismatch, not a real bug), rerun with
  `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`
  rather than trying to install a new browser.
