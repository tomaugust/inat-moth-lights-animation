# Phase 4 Worker: iNaturalist rate-limiting investigation

Working notes from the session that deployed the Cloudflare Worker adapter
(PR #4) and then spent a long stretch diagnosing sustained `429`/rate-limited
responses from iNaturalist. Written so a fresh session (or a fresh agent) can
pick this up without re-deriving everything from scratch. See `CLAUDE.md` for
the short version and current status.

## Timeline

1. PR #4 merged `.github/workflows/deploy-worker.yml`, deploying
   `worker/src/index.js` to `https://inat-moth-lights-adapter.tomaugust1985.workers.dev`
   for the first time, with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`
   repo secrets already configured.
2. Verifying the deploy required repeatedly redeploying and hitting the live
   worker (temporarily widening the workflow's push trigger onto the dev
   branch each time, then reverting) — this happened many times over about
   an hour while adding a post-deploy smoke test, fixing review findings
   (job timeout, concurrency scoping, least-privilege `permissions`, a smoke
   test that could actually fail), and re-verifying each fix.
3. Partway through, the worker started getting `429`s from iNaturalist
   (surfaced as `{"stale": true, "error": "rate-limited"}` in its own
   contract). This **persisted for at least ~12 hours** across multiple
   re-checks spaced hours apart (last confirmed clean success: `19:35:19
   UTC` on the day of the merge; still failing all 3 retry attempts,
   60 seconds apart, at `06:52 UTC` the next day).
4. Investigated several hypotheses with the user, discarding some along the
   way:
   - **Cloudflare shared-IP noise** (this worker's outbound `fetch()` shares
     Cloudflare Workers' free `workers.dev` egress IP pool with unrelated
     traffic) — plausible in general, but **ruled out for this specific
     endpoint**: `api.inaturalist.org` resolves directly to `13.66.155.195`,
     a Microsoft Azure IP, not a Cloudflare one (confirmed via
     `socket.gethostbyname_ex` — no live HTTP needed). Note `www.inaturalist.org`
     (the separate Rails web app) *is* Cloudflare-fronted
     (`www.inaturalist.org.cdn.cloudflare.net` → `104.20.24.172` /
     `172.66.151.8`) — don't conflate the two hosts.
   - **iNaturalist's documented rate limit** (100/min hard throttle,
     60/min recommended, 10k/day, per
     `https://www.inaturalist.org/pages/api+recommended+practices` and
     corroborating forum threads found via web search) — our actual call
     volume (a handful of calls per hour) is nowhere near these numbers in
     isolation, so the *documented, count-based* policy alone doesn't
     explain it.
   - **Query cost/shape, not volume** (most likely explanation): every
     request asked for `per_page=200` (the max), sorted by recency with
     **no time bound at all**, across one of iNaturalist's largest taxa
     (Lepidoptera, `taxon_id=47157`), worldwide, with nested `taxon`+`photos`
     joins on every row. The response payload itself is modest
     (~100KB for 200 records, measured directly from a real captured
     response) — so it's not raw bytes-over-the-wire. But an unbounded
     sort-by-recency (or an indefinite `id_above` cursor walk) is
     structurally identical to systematic full-history scraping from the
     server's point of view, regardless of how little actually comes back,
     and is plausibly more expensive to plan/execute without a time
     predicate to narrow the scan. Combined with an unusually high number of
     redeploy-and-verify cycles in a short window that day, this is the
     leading theory for why a real, if likely self-inflicted, throttle
     kicked in.
5. Decided fix (shipped, **not yet verified live** — see Open questions):
   commit `d79ab3e` on `claude/repository-review-iok690` added:
   - `created_d1`/`created_d2` bounding every query to a rolling 48-hour
     window (confirmed user's intent was 48h, not 24h, after they said both
     numbers in one message — asked and got "48 hours").
   - A lat/lng bounding box (`swlat`/`swlng`/`nelat`/`nelng`) defaulting to
     the UK, as a deliberate temporary stopgap ahead of scoping each visitor
     by their own detected location (a bigger feature — see below).
   - Both live in the shared `buildQueryUrl` (`src/inaturalist-client.js`),
     so the Phase 3 direct client and the Phase 4 Worker get them
     identically. `worker/wrangler.toml` gained `RECENT_HOURS` (default 48);
     the bounding box is a plain constant, not a var, since it's explicitly
     temporary.
   - Also shipped earlier in the same investigation: raised the Worker's
     shared cache TTL 45s → 120s (`CACHE_SECONDS`), and reworked the
     post-deploy smoke test to retry using the Worker's own `Retry-After`
     header (capped at 60s) instead of a naive fixed delay, and to actually
     fail if the Worker can only ever return the stale/empty
     upstream-failure fallback (the original version would have silently
     reported "verified" forever in that case — a real bug caught by trying
     it against the genuinely-rate-limited worker).

## Open questions for the next session (do these first)

The user is starting a fresh session with broader network access
specifically to resolve these — the previous sandbox could not reach
`api.inaturalist.org`, `developers.cloudflare.com`, or almost anything
outside a small allowlist, so several things below were reasoned about via
web search and prior/general knowledge rather than verified against the
real docs.

1. **Read iNaturalist's actual API docs directly** (`https://api.inaturalist.org/v2/docs/`
   and/or `https://www.inaturalist.org/pages/api+recommended+practices`) and
   confirm, rather than assume:
   - That `created_d1`/`created_d2` are valid on the **v2** observations
     endpoint (confirmed working on **v1** via this repo's own
     `scripts/inat-api-spike.ps1`, which this project's v2 client already
     mimics for other v1-style fields like `place_guess` — but v2 parity for
     these two specifically hasn't been checked against the real docs).
   - That `swlat`/`swlng`/`nelat`/`nelng` bounding-box params are valid on
     v2 (same caveat — inferred from general/v1 knowledge, not verified).
   - Whether `place_id` is the more correct way to scope by country instead
     of a hand-rolled bounding box (see next item).
2. **Find the correct iNaturalist `place_id` for "United Kingdom"** (or
   confirm whichever country the product settles on). A candidate value of
   `6857` came up during a web search attributed to iNaturalist's own
   `inaturalist/inaturalist.github.io` GitHub repo, but a direct follow-up
   search of that exact repo for `6857` came back with **zero matches** —
   so that number is **not verified and should not be trusted**. With real
   API access, either call `GET /v1/places/autocomplete?q=United+Kingdom`
   directly, or check `https://www.inaturalist.org/places` in a browser (the
   ID is in the URL of the matching place page). If `place_id` checks out
   as correct/available, prefer it over the current bounding box — it uses
   iNaturalist's actual place-boundary polygon rather than a crude
   rectangle that necessarily includes small slivers of neighbouring
   territory/sea.
3. **Verify the shipped fixes against the real, live worker** — none of
   commit `d79ab3e` (time/place bounding), `08a55d2` (cache TTL), or
   `79aea4f` (Retry-After-aware smoke test) have been confirmed against a
   real deploy yet, only via local unit tests with fake fetch/clock. The
   established procedure (used several times already this session, see git
   log on `claude/repository-review-iok690`): temporarily add the dev
   branch to `deploy-worker.yml`'s `on.push.branches`, push, watch the run
   via the GitHub Actions MCP tools, confirm a fresh `stale:false` response
   with real observations, then **revert the temporary trigger** before
   opening/merging any PR. Do not skip the revert step.
4. **Be deliberate about live-hitting the worker at all** given the ~12-hour
   throttle this session triggered from repeated verification cycles: prefer
   one careful check over several rapid ones, and if a fresh `429` shows up
   immediately, don't repeat the same rapid-redeploy pattern that likely
   caused it last time.

## Not yet started

- Wiring the production frontend (`index.html` / `src/app.js`) to the real
  deployed worker (`InatClient` with `buildUrl` → the worker's
  `/observations` endpoint, `upstreamShape: "adapter-contract"`, following
  the pattern already proven in `src/live-demo.js`). This was explicitly
  deferred until the worker's reliability is confirmed live (see open
  questions above) — don't start it until that's done.

## Session conventions worth knowing

- Designated dev branch for this work: `claude/repository-review-iok690`,
  developed against `main`. If its PR has merged by the time you read this,
  restart the branch from the latest `main` (`git fetch origin main &&
  git checkout -B claude/repository-review-iok690 origin/main`) rather than
  stacking new commits on merged history — PR #4 was squash-merged, so the
  branch's old commits are superseded by one new commit on `main`, not
  literally present in its history.
- **Never proactively check whether a PR has merged** — this is a standing
  instruction from the user; they will say when they've merged something.
- Prefer "Squash and merge" on PRs touching `deploy-worker.yml` given the
  TEMP-widen/revert commit pairs that accumulate during live verification.
- This project's testability convention: every network-touching module
  takes injectable `fetchImpl`/`now`/`setTimeoutImpl`/`clearTimeoutImpl`
  (see `src/inaturalist-client.js`, `worker/src/index.js`). Tests never hit
  the real API — they use a fake `fetch` and a fake clock, or Playwright's
  `page.route()` interception for e2e. Keep doing this.
