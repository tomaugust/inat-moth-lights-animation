// Phase 4 shared cache / API adapter (inat_website.txt section 6, Phase 4).
//
// Sits between every visitor's browser and the real iNaturalist API. Instead
// of caching per visitor cursor (which wouldn't collapse concurrent
// requests), it always asks upstream for the freshest page of the configured
// taxon scope and caches that ONE response for every caller for a short,
// shared TTL — so N concurrent browsers within that window cost exactly one
// upstream request, not N. Each client's own ObservationQueue (see
// src/observation-queue.js) already deduplicates by observation id, so
// repeatedly handing out "the latest snapshot" is exactly what a shared,
// recently-uploaded-observations feed should do.
//
// Reuses the same raw-v2-to-contract mapping and query-building the Phase 3
// direct client uses, and the same validation/normalization the frontend
// already trusts, so the contract can't drift between the two paths.
import { buildQueryUrl, mapRawObservationToContract } from "../../src/inaturalist-client.js";
import { parseObservationsResponse } from "../../src/observation-adapter.js";

const DEFAULT_TAXON_ID = 47157;
const DEFAULT_PAGE_SIZE = 200;
// research/phase-0.md: "A 30 to 60 second shared cache is much more
// conservative than the approximately one-request-per-second recommended
// maximum."
const DEFAULT_CACHE_SECONDS = 45;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15000;
const USER_AGENT = "inat-moth-lights-adapter/1.0 (+https://github.com/tomaugust/inat-moth-lights-animation)";
const CACHE_KEY_URL = "https://inat-moth-lights-adapter.internal/observations";
// A second, much longer-lived copy of the last good response, written
// alongside the short-TTL entry above on every successful upstream fetch.
// The short entry alone can't serve stale-on-error once it has expired (a
// Cache API match on an expired entry is just a miss) — this backup is what
// lets the adapter keep answering with real data through an outage instead
// of an empty list, until this copy itself finally goes stale too.
const STALE_BACKUP_KEY_URL = "https://inat-moth-lights-adapter.internal/observations?stale-backup";
const STALE_BACKUP_SECONDS = 6 * 60 * 60;

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

async function readContract(cache, key) {
  const cached = await cache.match(key);
  if (!cached) {
    return null;
  }
  return cached.json();
}

async function fetchUpstream(env) {
  const options = {
    taxonId: Number(env.TAXON_ID) || DEFAULT_TAXON_ID,
    photoLicenses: ["cc0", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa", "cc-by-nd", "cc-by-nc-nd"],
    pageSize: Number(env.PAGE_SIZE) || DEFAULT_PAGE_SIZE
  };
  // Always the freshest-first seed query (never id_above): the point of this
  // adapter is one shared "latest snapshot" for every caller, not per-client
  // incremental pagination — see the file header.
  const upstreamUrl = buildQueryUrl(options, null);

  const controller = new AbortController();
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS) || DEFAULT_UPSTREAM_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(upstreamUrl, {
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
async function staleFallback(cache, errorCode, extraHeaders) {
  const cachedContract = await readContract(cache, STALE_BACKUP_KEY_URL);
  if (cachedContract) {
    return jsonResponse({ ...cachedContract, stale: true, error: errorCode }, { headers: extraHeaders });
  }
  return jsonResponse(
    { fetchedAt: new Date().toISOString(), stale: true, cursor: "", observations: [], error: errorCode },
    { status: 502, headers: extraHeaders }
  );
}

// The testable core: takes the cache instance explicitly instead of reading
// the Workers-global `caches`, so tests can pass a fake in-memory cache
// without needing the real Workers runtime.
export async function handleRequest(request, env, cache) {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const requestOrigin = request.headers.get("Origin");
  const cors = corsHeaders(requestOrigin, allowedOrigins);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "method-not-allowed" }, { status: 405, headers: cors });
  }

  const cached = await readContract(cache, CACHE_KEY_URL);
  if (cached) {
    log("cache-hit");
    return jsonResponse(cached, { headers: { ...cors, "Cache-Control": `public, max-age=${Number(env.CACHE_SECONDS) || DEFAULT_CACHE_SECONDS}` } });
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchUpstream(env);
  } catch (error) {
    log("upstream-network-error", { message: error.message });
    return staleFallback(cache, "upstream-unavailable", cors);
  }

  if (upstreamResponse.status === 429) {
    const retryAfter = upstreamResponse.headers.get("Retry-After") || "60";
    log("upstream-rate-limited", { retryAfter });
    return staleFallback(cache, "rate-limited", { ...cors, "Retry-After": retryAfter });
  }

  if (!upstreamResponse.ok) {
    log("upstream-error", { status: upstreamResponse.status });
    return staleFallback(cache, "upstream-error", cors);
  }

  let payload;
  try {
    payload = await upstreamResponse.json();
  } catch {
    log("upstream-invalid-json");
    return staleFallback(cache, "invalid-upstream-response", cors);
  }

  if (!Array.isArray(payload.results)) {
    log("upstream-unexpected-shape");
    return staleFallback(cache, "unexpected-upstream-shape", cors);
  }

  const mapped = payload.results.map(mapRawObservationToContract);
  const numericIds = payload.results.map((raw) => Number(raw && raw.id)).filter((id) => Number.isFinite(id));
  const cursor = numericIds.length > 0 ? String(Math.max(...numericIds)) : "";

  const contract = {
    fetchedAt: new Date().toISOString(),
    stale: false,
    cursor,
    observations: parseObservationsResponse({ observations: mapped }).observations
  };

  const cacheSeconds = Number(env.CACHE_SECONDS) || DEFAULT_CACHE_SECONDS;
  const cacheableResponse = jsonResponse(contract, { headers: { "Cache-Control": `public, max-age=${cacheSeconds}` } });
  const staleBackupResponse = jsonResponse(contract, { headers: { "Cache-Control": `public, max-age=${STALE_BACKUP_SECONDS}` } });
  await Promise.all([
    cache.put(CACHE_KEY_URL, cacheableResponse.clone()),
    cache.put(STALE_BACKUP_KEY_URL, staleBackupResponse.clone())
  ]);

  log("cache-miss-refreshed", { count: contract.observations.length });
  return jsonResponse(contract, { headers: { ...cors, "Cache-Control": `public, max-age=${cacheSeconds}` } });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env, caches.default);
  }
};
