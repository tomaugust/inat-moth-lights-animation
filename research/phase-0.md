# Phase 0: iNaturalist API spike and decisions

Phase 0 validates a privacy-conscious, fixture-first data contract for the future live animation. It does not connect the current animation to iNaturalist.

## Validated request

The spike uses `GET https://api.inaturalist.org/v2/observations` with:

- `taxon_id=47157` for the initial Lepidoptera technical scope;
- `photos=true` and an explicit `photo_license` list that excludes unlicensed media;
- `order_by=created_at&order=desc` for an initial seed, followed later by `id_above=<cursor>&order_by=id&order=asc` for incremental ingestion;
- `per_page=200` in the planned adapter, with a smaller default in the research script;
- a RISON `fields` expression containing only observation, taxon and first-photo fields used by the project contract.

The v2 response currently returns a photo's `url` as a square-sized URL even when `medium_url` is requested. Following the v2 documentation, the normalizer replaces only the size token with `medium`. The script requests no user object, coordinates, positional accuracy, descriptions or private fields. A place guess is normalized for the runtime contract but replaced with synthetic broad regions in committed fixtures.

## Browser CORS result

A request sent with `Origin: http://localhost:8000` returned `Access-Control-Allow-Origin: *` and allowed `GET`. Direct browser access is therefore technically possible for a development prototype as of the measurement date. This is not the production architecture: the chosen Cloudflare Worker adapter will provide shared caching, response validation, backoff and stale fallback.

## Volume measurement

`scripts/inat-api-spike.ps1 -WriteArtifacts` measures four six-hour UTC windows from the most recent complete day using `created_d1` and `created_d2`. Results are saved in `research/phase-0-measurements.json`. Counts represent newly created, photo-bearing Lepidoptera observations with an explicit Creative Commons licence, not all moth observations and not biological abundance.

The 12 July 2026 UTC measurement ranged from 8,980 to 14,913 observations per six-hour window, or approximately 24.9 to 41.4 observations per minute. The four exact counts and query metadata are retained in the JSON report.

The design must assume that arrivals can substantially exceed a calm display rate. The initial settings therefore poll once per minute, request up to 200 records, preserve source creation-time gaps when releasing observations, apply a deterministic 0.65-1.35 jitter multiplier, clamp release gaps to 0.75-30 seconds, cap catch-up releases at 50 observations, cap the scene at 50 active moths, cap the queue at 500 and retain 2,000 recently seen IDs.

## Decisions

- Technical prototype scope: all Lepidoptera, labelled honestly as Butterflies and moths.
- Public moth-only strategy: a reviewed and versioned allowlist of moth families/superfamilies is a launch requirement.
- Media: show only explicitly Creative Commons-licensed photos, unchanged, with attribution, licence and source link. Do not proxy or commit real media.
- Hosting: GitHub Pages for the static frontend and a Cloudflare Worker for the shared cached adapter.
- Cursor: use the highest successfully processed observation ID; order incremental pages by ID ascending and deduplicate in the future queue.
- Timing: use observation createdAt as the intended live-time sequence. For records discovered in a batch, schedule them from adjacent source timestamps, scale gaps by sourceTimeScale, add deterministic observation-seeded jitter, and clamp the result to the configured bounds.
- Burst handling: if a large upload batch or API outage creates a backlog, do not replay every record at once. Cap catch-up, sample fairly when the queue overflows, and let the scene return to source-time pacing.

The machine-readable decisions are in `config/phase-0-decisions.json`. Fixtures are synthetic/redacted and contain no usernames, exact coordinates or real photo URLs.

## Reproduce

From PowerShell:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\inat-api-spike.ps1 -WriteArtifacts
```

The script uses only PowerShell's built-in HTTP and JSON support. It prints the normalized project-owned contract, tests CORS, reports volume and refreshes the redacted fixtures and measurement report.
