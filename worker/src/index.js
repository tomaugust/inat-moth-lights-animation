// Phase 4 shared cache / API adapter (inat_website.txt section 6, Phase 4).
//
// Sits between every visitor's browser and the real iNaturalist API. Instead
// of caching per visitor cursor (which wouldn't collapse concurrent
// requests), it always asks upstream for every observation in the configured
// taxon/place/24h-window scope (fetchAllObservationsInWindow paginates as
// many pages as that takes, up to MAX_WINDOW_PAGES) and caches that response
// for every caller sharing the same place_id, for a shared TTL — so N
// concurrent browsers cost exactly one refresh (one or more upstream
// requests), not N refreshes. Each client's own ObservationQueue (see
// src/observation-queue.js) already deduplicates by observation id, so
// repeatedly handing out "everything currently in the window" is exactly
// what a shared, recently-uploaded-observations feed should do.
//
// The shared cache lives in Workers KV (env.OBSERVATIONS_KV), not
// caches.default. caches.default is per-Cloudflare-datacenter, not global:
// a real incident showed this in production — a UK colo's own refresh hit
// iNaturalist's rate limit, its stale-backup entry had also expired, and
// every visitor routed to that one colo got a hard 502 while every other
// colo (and every check run from elsewhere) looked completely healthy. KV
// is globally replicated: one successful refresh from any colo populates a
// value every colo reads, so no single colo's bad luck can strand its own
// visitors — the tradeoff is KV's own eventual-consistency propagation
// (up to ~60s), which only ever means "a colo briefly sees the previous
// still-valid entry", never "sees nothing".
//
// Reuses the same raw-v2-to-contract mapping and query-building the Phase 3
// direct client uses, and the same validation/normalization the frontend
// already trusts, so the contract can't drift between the two paths.
import { DEFAULT_WITHOUT_TAXON_ID, fetchAllObservationsInWindow, mapRawObservationToContract } from "../../src/inaturalist-client.js";
import { parseObservationsResponse } from "../../src/observation-adapter.js";

const DEFAULT_TAXON_ID = 47157;
// iNaturalist place_id for the United Kingdom (admin_level 0), confirmed
// against GET /v1/places/autocomplete?q=United%20Kingdom.
const DEFAULT_PLACE_ID = 6857;
const DEFAULT_PAGE_SIZE = 200;
// Kept comfortably under iNaturalist's ~1 req/s recommended ceiling: this is
// now genuinely one shared refresh per TTL window globally (KV, not per
// colo), so 1800s (30 min) is conservative rather than merely hoped-to-be —
// see the file header. Cost: data can be up to 30 minutes old, an accepted
// trade given the site already frames itself as "recently shared", not
// real-time.
const DEFAULT_CACHE_SECONDS = 1800;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15000;
// The window now regularly needs 7-10+ pages (see fetchAllObservationsInWindow's
// header comment) — firing all of them back to back is a burst pattern that
// gets a client rate-limited by iNaturalist, which is exactly what started
// happening: refreshes started coming back 429, and once a colo's stale
// backup also aged out, that colo had nothing left to serve visitors but an
// empty list. Pacing pages ~1/second keeps every refresh under the ~1 req/s
// ceiling the rest of this file's comments already assume.
const DEFAULT_PAGE_DELAY_MS = 1000;
// A window this thin gives the client too little to display no matter how
// the pacing is tuned — no amount of clever pacing conjures moths that don't
// exist. When the default 24h window comes back below this count, widen the
// lookback to DEFAULT_SPARSE_LOOKBACK_HOURS (7 days) and use that instead,
// if it actually returns more. This never fires for the UK's current real
// volume (in the hundreds to low thousands per 24h) — it exists for a
// future lower-volume place_id, so per-country caching (see contractKey)
// isn't the only piece of multi-country support still to land.
const DEFAULT_SPARSE_OBSERVATION_THRESHOLD = 30;
const DEFAULT_SPARSE_LOOKBACK_HOURS = 24 * 7;
const USER_AGENT = "inat-moth-lights-adapter/1.0 (+https://github.com/tomaugust/inat-moth-lights-animation)";
// Cache keys are scoped by place_id so a future per-visitor country (see
// src/geolocation.js, not wired in yet) is additive — each country gets its
// own independently-refreshed KV entry, mirroring how the upstream query
// itself is already scoped per place_id, rather than one unscoped worldwide
// fetch (which would blow past MAX_WINDOW_PAGES and defeat the point of
// scoping by country at all).
function contractKey(placeId) {
  return `observations:${placeId}`;
}

// A second, much longer-lived copy of the last good response, written
// alongside the short-TTL entry above on every successful upstream fetch.
// The short entry alone can't serve stale-on-error once it has expired (a
// KV read past its expirationTtl is just a miss) — this backup is what lets
// the adapter keep answering with real data through an outage instead of an
// empty list, until this copy itself finally goes stale too.
//
// A week (not the original 6 hours) because the failure this exists for —
// iNaturalist rate-limiting or an extended upstream outage — has no promised
// recovery time; 6 hours meant a bad enough incident still ended in the
// empty-list 502 (staleFallback's other branch) well before anyone could
// investigate. A week trades staleness (a visitor could, in the worst case,
// see week-old "recent" sightings) for never falling all the way back to
// nothing, which is the more visible and more confusing failure mode of the
// two. src/fallback-observations.js is the next line of defense after this
// one — for a visitor whose very first load has no cache to fall back on at
// all (a brand new place_id, or an outage that outlasts even this).
function staleBackupKey(placeId) {
  return `observations:${placeId}:stale-backup`;
}
const STALE_BACKUP_SECONDS = 7 * 24 * 60 * 60;

function parseAllowedOrigins(envValue) {
  return (envValue || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(requestOrigin, allowedOrigins) {
  const headers = { Vary: "Origin" };
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }
  headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type";
  return headers;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

function log(event, fields = {}) {
  // Cloudflare captures console output per-request (dashboard "Logs" /
  // `wrangler tail`); this is intentionally just operational counts and
  // outcomes, never observation content or request metadata about callers.
  console.log(JSON.stringify({ event, ...fields }));
}

async function readContract(kv, key) {
  return kv.get(key, "json");
}

// A client-supplied place_id (?place_id=) overrides the env default so a
// visitor's own resolved country (see src/geolocation.js) can be served
// instead of always the fixed UK default — the KV cache key and every
// upstream query are already scoped by whichever placeId this resolves to
// (see contractKey/staleBackupKey), so a new country is just a new,
// independently-cached entry, not a redesign.
//
// Deliberately just a sanity bound (a positive integer, no absurd upper
// bound), not a curated allowlist of real iNaturalist place ids: this is a
// public, unauthenticated endpoint, so any caller can already request any
// placeId directly (CORS only restricts which origins a *browser* will let
// read the response, not who can request it at all) — an allowlist would
// need to be kept in sync with every country resolveUserPlace() might ever
// return, for a protection this validation already gives most of the
// practical benefit of (rejecting garbage that would otherwise waste an
// upstream request on a nonsense query). Revisit if real abuse shows up.
function resolvePlaceId(request, env) {
  const requested = Number(new URL(request.url).searchParams.get("place_id"));
  if (Number.isInteger(requested) && requested > 0) {
    return requested;
  }
  return Number(env.PLACE_ID) || DEFAULT_PLACE_ID;
}

function buildUpstreamOptions(env, placeId) {
  return {
    taxonId: Number(env.TAXON_ID) || DEFAULT_TAXON_ID,
    // Excludes butterflies (Papilionoidea, which nests skippers too — see
    // DEFAULT_WITHOUT_TAXON_ID's own comment in inaturalist-client.js) so the
    // feed is moths only. Mirrors TAXON_ID's own env-override pattern, but
    // (like SPARSE_OBSERVATION_THRESHOLD below) checks finiteness explicitly
    // rather than `Number(env.X) || DEFAULT`, since 0 is how an operator
    // would deliberately opt back into the full Lepidoptera order — `||`
    // would treat that as unset and silently restore the default instead.
    withoutTaxonId: Number.isFinite(Number(env.WITHOUT_TAXON_ID)) ? Number(env.WITHOUT_TAXON_ID) : DEFAULT_WITHOUT_TAXON_ID,
    placeId,
    photoLicenses: ["cc0", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa", "cc-by-nd", "cc-by-nc-nd"],
    pageSize: Number(env.PAGE_SIZE) || DEFAULT_PAGE_SIZE
  };
}

// One page's fetch: its own timeout/abort and the real User-Agent a browser
// fetch can't set (see the file header). Used as fetchAllObservationsInWindow's
// fetchImpl so every page of a multi-page refresh gets the same treatment.
async function fetchOnePage(url, env) {
  const controller = new AbortController();
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS) || DEFAULT_UPSTREAM_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Serves the last good cached contract marked stale, or a 502 with an empty
// (never fabricated) observation list if nothing has ever been cached yet.
// This is what keeps a caller usable through an upstream outage: it always
// gets a well-shaped contract response, never a hard failure it has to
// special-case.
async function staleFallback(kv, placeId, errorCode, extraHeaders) {
  const cachedContract = await readContract(kv, staleBackupKey(placeId));
  if (cachedContract) {
    return jsonResponse({ ...cachedContract, stale: true, error: errorCode }, { headers: extraHeaders });
  }
  return jsonResponse(
    { fetchedAt: new Date().toISOString(), stale: true, cursor: "", observations: [], error: errorCode },
    { status: 502, headers: extraHeaders }
  );
}

// Shared across concurrent requests hitting a cache miss in the same worker
// instance, so N callers landing in the same miss window cost exactly one
// upstream fetch instead of N — otherwise every one of them would race to
// refill the cache independently (see the file header). Never throws: it
// resolves to a discriminated result so every waiter can build its own
// response (its own CORS headers) without re-fetching. Keyed by placeId —
// now that a request can ask for any country, a single shared variable
// would let a concurrent miss for one country incorrectly wait on (and
// receive) another country's in-flight refresh.
const inFlightRefreshes = new Map();

async function refreshContract(env, kv, placeId) {
  const options = buildUpstreamOptions(env, placeId);

  const pageDelayMs = Number(env.PAGE_DELAY_MS) || DEFAULT_PAGE_DELAY_MS;

  let outcome;
  try {
    outcome = await fetchAllObservationsInWindow(options, (url) => fetchOnePage(url, env), undefined, pageDelayMs);
  } catch (error) {
    log("upstream-network-error", { message: error.message });
    return { ok: false, reason: "upstream-unavailable" };
  }

  if (!outcome.ok) {
    if (outcome.reason === "http-error") {
      if (outcome.response.status === 429) {
        const retryAfter = outcome.response.headers.get("Retry-After") || "60";
        log("upstream-rate-limited", { retryAfter, pagesFetched: outcome.pagesFetched });
        return { ok: false, reason: "rate-limited", retryAfter };
      }
      log("upstream-error", { status: outcome.response.status, pagesFetched: outcome.pagesFetched });
      return { ok: false, reason: "upstream-error" };
    }

    if (outcome.reason === "invalid-json") {
      log("upstream-invalid-json", { pagesFetched: outcome.pagesFetched });
      return { ok: false, reason: "invalid-upstream-response" };
    }

    log("upstream-unexpected-shape", { pagesFetched: outcome.pagesFetched });
    return { ok: false, reason: "unexpected-upstream-shape" };
  }

  // Unlike this file's other `Number(env.X) || DEFAULT` reads, 0 is a
  // legitimate real value here (explicitly disables widening) rather than
  // "unset" — `||` would treat it as falsy and silently fall back to the
  // default instead, so this checks finiteness explicitly.
  const rawSparseThreshold = Number(env.SPARSE_OBSERVATION_THRESHOLD);
  const sparseThreshold = Number.isFinite(rawSparseThreshold) ? rawSparseThreshold : DEFAULT_SPARSE_OBSERVATION_THRESHOLD;
  if (outcome.results.length < sparseThreshold) {
    const sparseLookbackHours = Number(env.SPARSE_LOOKBACK_HOURS) || DEFAULT_SPARSE_LOOKBACK_HOURS;
    const widenedOptions = { ...options, lookbackHours: sparseLookbackHours };
    try {
      const widenedOutcome = await fetchAllObservationsInWindow(widenedOptions, (url) => fetchOnePage(url, env), undefined, pageDelayMs);
      // Widening is an enhancement attempt, never a requirement: if it fails
      // or (implausibly, since it's a superset window) doesn't actually
      // return more, silently keep the narrower result that already
      // succeeded rather than failing or truncating a working response.
      if (widenedOutcome.ok && widenedOutcome.results.length > outcome.results.length) {
        log("sparse-window-widened", {
          narrowCount: outcome.results.length,
          widenedCount: widenedOutcome.results.length,
          sparseLookbackHours
        });
        outcome = widenedOutcome;
      }
    } catch (error) {
      log("sparse-widen-network-error", { message: error.message });
    }
  }

  const mapped = outcome.results.map(mapRawObservationToContract);
  const numericIds = outcome.results.map((raw) => Number(raw && raw.id)).filter((id) => Number.isFinite(id));
  const cursor = numericIds.length > 0 ? String(Math.max(...numericIds)) : "";

  const contract = {
    fetchedAt: new Date().toISOString(),
    stale: false,
    cursor,
    observations: parseObservationsResponse({ observations: mapped }).observations
  };

  const cacheSeconds = Number(env.CACHE_SECONDS) || DEFAULT_CACHE_SECONDS;
  const serialized = JSON.stringify(contract);
  await Promise.all([
    kv.put(contractKey(placeId), serialized, { expirationTtl: cacheSeconds }),
    kv.put(staleBackupKey(placeId), serialized, { expirationTtl: STALE_BACKUP_SECONDS })
  ]);

  log("cache-miss-refreshed", { count: contract.observations.length, pagesFetched: outcome.pagesFetched });
  return { ok: true, contract, cacheSeconds };
}

// The testable core: takes the KV instance explicitly instead of reading the
// Workers-global env.OBSERVATIONS_KV binding, so tests can pass a fake
// in-memory store without needing the real Workers runtime.
export async function handleRequest(request, env, kv) {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const requestOrigin = request.headers.get("Origin");
  const cors = corsHeaders(requestOrigin, allowedOrigins);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "method-not-allowed" }, { status: 405, headers: cors });
  }

  const placeId = resolvePlaceId(request, env);

  const cached = await readContract(kv, contractKey(placeId));
  if (cached) {
    log("cache-hit", { placeId });
    return jsonResponse(cached, { headers: { ...cors, "Cache-Control": `public, max-age=${Number(env.CACHE_SECONDS) || DEFAULT_CACHE_SECONDS}` } });
  }

  let inFlight = inFlightRefreshes.get(placeId);
  if (!inFlight) {
    inFlight = refreshContract(env, kv, placeId).finally(() => {
      inFlightRefreshes.delete(placeId);
    });
    inFlightRefreshes.set(placeId, inFlight);
  }
  const result = await inFlight;

  if (!result.ok) {
    const extraHeaders = result.retryAfter ? { ...cors, "Retry-After": result.retryAfter } : cors;
    return staleFallback(kv, placeId, result.reason, extraHeaders);
  }

  return jsonResponse(result.contract, { headers: { ...cors, "Cache-Control": `public, max-age=${result.cacheSeconds}` } });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env, env.OBSERVATIONS_KV);
  }
};
