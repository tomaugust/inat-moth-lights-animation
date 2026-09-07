import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { handleRequest } from "../../worker/src/index.js";

const ENV = {
  ALLOWED_ORIGINS: "https://tomaugust.github.io,http://localhost:8080",
  TAXON_ID: "47157",
  PLACE_ID: "6857",
  PAGE_SIZE: "200",
  CACHE_SECONDS: "45",
  UPSTREAM_TIMEOUT_MS: "15000"
};

// Mirrors just enough of the real Cache API for these tests: entries expire
// according to the Cache-Control: max-age header on the stored response,
// against an injectable clock (so tests don't need to wait on real time).
function createFakeCache({ now = () => Date.now() } = {}) {
  const store = new Map();
  return {
    async match(key) {
      const entry = store.get(String(key));
      if (!entry || now() >= entry.expiresAtMs) {
        return undefined;
      }
      return entry.response.clone();
    },
    async put(key, response) {
      const match = /max-age=(\d+)/.exec(response.headers.get("Cache-Control") || "");
      const maxAgeMs = match ? Number(match[1]) * 1000 : 0;
      store.set(String(key), { response, expiresAtMs: now() + maxAgeMs });
    },
    size() {
      return store.size;
    }
  };
}

function rawObservation(overrides = {}) {
  return {
    id: 123,
    created_at: "2026-07-13T10:46:30-03:00",
    time_observed_at: "2026-07-12T17:29:00-03:00",
    uri: "https://www.inaturalist.org/observations/123",
    quality_grade: "needs_id",
    place_guess: "Northern Europe",
    taxon: { id: 1650173, rank: "species", name: "Limochores mystic", preferred_common_name: "Long Dash" },
    photos: [{ url: "https://example.invalid/photos/1/square.jpg", attribution: "A. Person", license_code: "cc-by-nc" }],
    ...overrides
  };
}

function upstreamJson(body, init = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

let originalFetch;
let fetchCalls;
let fetchQueue;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  fetchQueue = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    const next = fetchQueue.shift();
    if (!next) {
      throw new Error("fake upstream fetch ran out of queued responses");
    }
    return typeof next === "function" ? next() : next;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function get(path = "/observations", init = {}) {
  return new Request(`https://adapter.example.invalid${path}`, { method: "GET", ...init });
}

describe("worker adapter: CORS and method handling", () => {
  it("answers OPTIONS with the CORS headers and no body", async () => {
    const cache = createFakeCache();
    const response = await handleRequest(
      get("/observations", { method: "OPTIONS", headers: { Origin: "https://tomaugust.github.io" } }),
      ENV,
      cache
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://tomaugust.github.io");
  });

  it("rejects non-GET/OPTIONS methods", async () => {
    const cache = createFakeCache();
    const response = await handleRequest(get("/observations", { method: "POST" }), ENV, cache);
    assert.equal(response.status, 405);
  });

  it("only reflects an allow-listed origin in Access-Control-Allow-Origin", async () => {
    const cache = createFakeCache();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    const allowed = await handleRequest(get("/observations", { headers: { Origin: "https://tomaugust.github.io" } }), ENV, cache);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://tomaugust.github.io");

    const cache2 = createFakeCache();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));
    const notAllowed = await handleRequest(get("/observations", { headers: { Origin: "https://evil.example" } }), ENV, cache2);
    assert.equal(notAllowed.headers.get("Access-Control-Allow-Origin"), null);
  });
});

describe("worker adapter: upstream fetch, mapping and caching", () => {
  it("scopes the upstream request to PLACE_ID via place_id, not a lat/lng bounding box", async () => {
    const cache = createFakeCache();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    await handleRequest(get(), ENV, cache);

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /place_id=6857/);
    assert.doesNotMatch(fetchCalls[0].url, /swlat|swlng|nelat|nelng/);
  });

  it("fetches upstream, maps to the contract shape, and caches it", async () => {
    const cache = createFakeCache();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));

    const response = await handleRequest(get(), ENV, cache);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.observations.length, 1);
    assert.equal(body.observations[0].id, "inat-123");
    assert.equal(body.stale, false);
    assert.match(response.headers.get("Cache-Control"), /max-age=45/);
    assert.equal(cache.size(), 2, "the short-TTL entry plus the longer-lived stale-fallback backup");
  });

  it("sets a descriptive User-Agent and never a custom header a browser fetch could set", async () => {
    const cache = createFakeCache();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    await handleRequest(get(), ENV, cache);

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].init.headers["User-Agent"], /inat-moth-lights-adapter/);
  });

  it("serves every caller within the cache window from one shared cached response", async () => {
    const cache = createFakeCache();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));

    await handleRequest(get(), ENV, cache);
    await handleRequest(get(), ENV, cache);
    await handleRequest(get(), ENV, cache);

    assert.equal(fetchCalls.length, 1, "three callers within the TTL should cost exactly one upstream request");
  });

  it("does not query per client cursor: always requests the freshest seed page", async () => {
    const cache = createFakeCache();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    await handleRequest(get(), ENV, cache);

    assert.match(fetchCalls[0].url, /order_by=created_at/);
    assert.doesNotMatch(fetchCalls[0].url, /id_above/);
  });

  it("coalesces concurrent cache-miss requests into a single upstream fetch", async () => {
    const cache = createFakeCache();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));

    const responses = await Promise.all([
      handleRequest(get(), ENV, cache),
      handleRequest(get(), ENV, cache),
      handleRequest(get(), ENV, cache)
    ]);

    assert.equal(fetchCalls.length, 1, "concurrent callers hitting a cache miss together should share one upstream fetch");
    responses.forEach((response) => assert.equal(response.status, 200));
    const bodies = await Promise.all(responses.map((response) => response.json()));
    bodies.forEach((body) => assert.equal(body.observations.length, 1));
  });
});

describe("worker adapter: upstream failure handling", () => {
  it("falls back to the last good cached contract, marked stale, once the cache expires and upstream then fails", async () => {
    let currentMs = 0;
    const cache = createFakeCache({ now: () => currentMs });
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));
    await handleRequest(get(), ENV, cache); // populates the cache with a good response

    currentMs += 46000; // past the 45s Cache-Control: max-age
    fetchQueue.push(new Response(null, { status: 503 }));
    const response = await handleRequest(get(), ENV, cache);
    const body = await response.json();

    assert.equal(response.status, 200, "a stale-but-real fallback should not read as a hard failure");
    assert.equal(body.stale, true);
    assert.equal(body.error, "upstream-error");
    assert.equal(body.observations.length, 1, "should reuse the previously cached observation, not fabricate an empty one");
  });

  it("returns a stale 429 fallback with Retry-After when nothing has ever been cached yet", async () => {
    const cache = createFakeCache();
    fetchQueue.push(new Response(null, { status: 429, headers: { "Retry-After": "30" } }));
    const response = await handleRequest(get(), ENV, cache);
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.stale, true);
    assert.equal(body.error, "rate-limited");
    assert.equal(response.headers.get("Retry-After"), "30");
  });

  it("returns a stale 502 with an empty (never fabricated) list when upstream is down and nothing is cached", async () => {
    const cache = createFakeCache();
    fetchQueue.push(() => {
      throw new Error("network unreachable");
    });

    const response = await handleRequest(get(), ENV, cache);
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.stale, true);
    assert.equal(body.error, "upstream-unavailable");
    assert.deepEqual(body.observations, []);
  });

  it("falls back to stale instead of throwing on an unexpected upstream shape", async () => {
    const cache = createFakeCache();
    fetchQueue.push(upstreamJson({ unexpected: "shape" }));

    const response = await handleRequest(get(), ENV, cache);
    const body = await response.json();

    assert.equal(body.stale, true);
    assert.equal(body.error, "unexpected-upstream-shape");
  });
});
