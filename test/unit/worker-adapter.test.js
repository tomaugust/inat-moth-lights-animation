import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { handleRequest } from "../../worker/src/index.js";

const ENV = {
  ALLOWED_ORIGINS: "https://tomaugust.github.io,http://localhost:8080",
  TAXON_ID: "47157",
  PLACE_ID: "6857",
  PAGE_SIZE: "200",
  CACHE_SECONDS: "45",
  UPSTREAM_TIMEOUT_MS: "15000",
  // Real inter-page pacing is a production concern (see worker/src/index.js);
  // tests exercise multi-page accumulation and should run at full speed.
  PAGE_DELAY_MS: "0",
  // Disabled by default (0 observations is never < 0) so ordinary tests'
  // small mock result sets don't unexpectedly trigger a second "widening"
  // fetch the test didn't queue a response for. The "sparse-window
  // widening" describe block below re-enables it with its own env override.
  SPARSE_OBSERVATION_THRESHOLD: "0"
};

// Mirrors just enough of the real Workers KV binding for these tests: get/put
// with expirationTtl, against an injectable clock (so tests don't need to
// wait on real time). Real KV is eventually consistent across locations —
// deliberately not modeled here, since this fake represents a single
// location's view, which is all handleRequest's own logic needs to be
// correct about; the cross-location replication behavior isn't code this
// project owns.
function createFakeKv({ now = () => Date.now() } = {}) {
  const store = new Map();
  return {
    async get(key, type) {
      const entry = store.get(String(key));
      if (!entry || now() >= entry.expiresAtMs) {
        return null;
      }
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    async put(key, value, { expirationTtl } = {}) {
      const ttlMs = Number(expirationTtl) > 0 ? Number(expirationTtl) * 1000 : Infinity;
      store.set(String(key), { value, expiresAtMs: now() + ttlMs });
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
    const kv = createFakeKv();
    const response = await handleRequest(
      get("/observations", { method: "OPTIONS", headers: { Origin: "https://tomaugust.github.io" } }),
      ENV,
      kv
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://tomaugust.github.io");
  });

  it("rejects non-GET/OPTIONS methods", async () => {
    const kv = createFakeKv();
    const response = await handleRequest(get("/observations", { method: "POST" }), ENV, kv);
    assert.equal(response.status, 405);
  });

  it("only reflects an allow-listed origin in Access-Control-Allow-Origin", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    const allowed = await handleRequest(get("/observations", { headers: { Origin: "https://tomaugust.github.io" } }), ENV, kv);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://tomaugust.github.io");

    const kv2 = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));
    const notAllowed = await handleRequest(get("/observations", { headers: { Origin: "https://evil.example" } }), ENV, kv2);
    assert.equal(notAllowed.headers.get("Access-Control-Allow-Origin"), null);
  });
});

describe("worker adapter: upstream fetch, mapping and caching", () => {
  it("scopes the upstream request to PLACE_ID via place_id, not a lat/lng bounding box", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    await handleRequest(get(), ENV, kv);

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /place_id=6857/);
    assert.doesNotMatch(fetchCalls[0].url, /swlat|swlng|nelat|nelng/);
  });

  it("always bounds the upstream request with created_d1 — never a temporally unbounded query", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    await handleRequest(get(), ENV, kv);

    assert.equal(fetchCalls.length, 1);
    const params = new URL(fetchCalls[0].url).searchParams;
    assert.ok(params.has("created_d1"), "expected created_d1 to always be present");
    assert.ok(!Number.isNaN(Date.parse(params.get("created_d1"))), "created_d1 should be a valid date");
  });

  it("fetches upstream, maps to the contract shape, and caches it", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));

    const response = await handleRequest(get(), ENV, kv);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.observations.length, 1);
    assert.equal(body.observations[0].id, "inat-123");
    assert.equal(body.stale, false);
    assert.match(response.headers.get("Cache-Control"), /max-age=45/);
    assert.equal(kv.size(), 2, "the short-TTL entry plus the longer-lived stale-fallback backup");
  });

  it("caches under a place_id-scoped key, so different countries never collide", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));

    await handleRequest(get(), ENV, kv);

    const cached = await kv.get("observations:6857", "json");
    assert.ok(cached, "expected the contract cached under a key scoped by PLACE_ID");
    assert.equal(cached.observations.length, 1);
  });

  it("sets a descriptive User-Agent and never a custom header a browser fetch could set", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    await handleRequest(get(), ENV, kv);

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].init.headers["User-Agent"], /inat-moth-lights-adapter/);
  });

  it("serves every caller within the cache window from one shared cached response", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));

    await handleRequest(get(), ENV, kv);
    await handleRequest(get(), ENV, kv);
    await handleRequest(get(), ENV, kv);

    assert.equal(fetchCalls.length, 1, "three callers within the TTL should cost exactly one upstream request");
  });

  it("does not query per client cursor: every refresh starts the window from its beginning", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));

    await handleRequest(get(), ENV, kv);

    assert.match(fetchCalls[0].url, /order_by=id/);
    assert.match(fetchCalls[0].url, /order=asc/);
    assert.doesNotMatch(fetchCalls[0].url, /id_above/);
  });

  it("paginates through every page of the window instead of stopping at the first page's worth", async () => {
    const kv = createFakeKv();
    const firstPage = Array.from({ length: 200 }, (_, index) => rawObservation({ id: 1000 + index }));
    const secondPage = [rawObservation({ id: 5000 })];
    fetchQueue.push(upstreamJson({ total_results: 201, results: firstPage }));
    fetchQueue.push(upstreamJson({ total_results: 201, results: secondPage }));

    const response = await handleRequest(get(), ENV, kv);
    const body = await response.json();

    assert.equal(fetchCalls.length, 2, "a full first page should trigger a second page fetch");
    assert.match(fetchCalls[1].url, /id_above=1199/, "the second page should continue from the first page's last id");
    assert.equal(body.observations.length, 201, "results from both pages should be combined into one contract");
  });

  it("coalesces concurrent cache-miss requests into a single upstream fetch", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));

    const responses = await Promise.all([
      handleRequest(get(), ENV, kv),
      handleRequest(get(), ENV, kv),
      handleRequest(get(), ENV, kv)
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
    const kv = createFakeKv({ now: () => currentMs });
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));
    await handleRequest(get(), ENV, kv); // populates the cache with a good response

    currentMs += 46000; // past the 45s CACHE_SECONDS TTL
    fetchQueue.push(new Response(null, { status: 503 }));
    const response = await handleRequest(get(), ENV, kv);
    const body = await response.json();

    assert.equal(response.status, 200, "a stale-but-real fallback should not read as a hard failure");
    assert.equal(body.stale, true);
    assert.equal(body.error, "upstream-error");
    assert.equal(body.observations.length, 1, "should reuse the previously cached observation, not fabricate an empty one");
  });

  it("still serves the stale-backup contract just under a week after it was cached (the long-lived outage guard)", async () => {
    let currentMs = 0;
    const kv = createFakeKv({ now: () => currentMs });
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));
    await handleRequest(get(), ENV, kv); // populates the cache with a good response

    currentMs += 46000; // past the 45s CACHE_SECONDS TTL, so the short entry is gone
    currentMs += 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000; // ~6 days 23 hours later — just under the 7-day backup TTL
    fetchQueue.push(new Response(null, { status: 503 }));
    const response = await handleRequest(get(), ENV, kv);
    const body = await response.json();

    assert.equal(response.status, 200, "the week-old backup should still answer with real data, not the empty 502 fallback");
    assert.equal(body.stale, true);
    assert.equal(body.observations.length, 1);
  });

  it("finally falls through to the empty 502 fallback once the 7-day backup itself expires", async () => {
    let currentMs = 0;
    const kv = createFakeKv({ now: () => currentMs });
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation()] }));
    await handleRequest(get(), ENV, kv);

    currentMs += 46000 + 8 * 24 * 60 * 60 * 1000; // past both the short TTL and the 7-day backup TTL
    fetchQueue.push(new Response(null, { status: 503 }));
    const response = await handleRequest(get(), ENV, kv);
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.deepEqual(body.observations, []);
  });

  it("returns a stale 429 fallback with Retry-After when nothing has ever been cached yet", async () => {
    const kv = createFakeKv();
    fetchQueue.push(new Response(null, { status: 429, headers: { "Retry-After": "30" } }));
    const response = await handleRequest(get(), ENV, kv);
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.stale, true);
    assert.equal(body.error, "rate-limited");
    assert.equal(response.headers.get("Retry-After"), "30");
  });

  it("returns a stale 502 with an empty (never fabricated) list when upstream is down and nothing is cached", async () => {
    const kv = createFakeKv();
    fetchQueue.push(() => {
      throw new Error("network unreachable");
    });

    const response = await handleRequest(get(), ENV, kv);
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.stale, true);
    assert.equal(body.error, "upstream-unavailable");
    assert.deepEqual(body.observations, []);
  });

  it("falls back to stale instead of throwing on an unexpected upstream shape", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ unexpected: "shape" }));

    const response = await handleRequest(get(), ENV, kv);
    const body = await response.json();

    assert.equal(body.stale, true);
    assert.equal(body.error, "unexpected-upstream-shape");
  });
});

describe("worker adapter: sparse-window widening", () => {
  const SPARSE_ENV = { ...ENV, SPARSE_OBSERVATION_THRESHOLD: "30" };

  it("widens the window when the narrow result is below the sparse threshold, and uses it if it has more", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 2, results: [rawObservation({ id: 1 }), rawObservation({ id: 2 })] }));
    fetchQueue.push(
      upstreamJson({ total_results: 5, results: [1, 2, 3, 4, 5].map((id) => rawObservation({ id })) })
    );

    const response = await handleRequest(get(), SPARSE_ENV, kv);
    const body = await response.json();

    assert.equal(fetchCalls.length, 2, "expected a narrow fetch, then a widened one");
    const narrowCreatedD1 = new URL(fetchCalls[0].url).searchParams.get("created_d1");
    const widenedCreatedD1 = new URL(fetchCalls[1].url).searchParams.get("created_d1");
    assert.ok(
      Date.parse(widenedCreatedD1) < Date.parse(narrowCreatedD1),
      "the widened fetch should reach further back in time than the narrow one"
    );
    assert.equal(response.status, 200);
    assert.equal(body.stale, false);
    assert.equal(body.observations.length, 5, "expected the widened (larger) result set to be used");
  });

  it("keeps the narrow result if the widening attempt itself fails", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 2, results: [rawObservation({ id: 1 }), rawObservation({ id: 2 })] }));
    fetchQueue.push(() => {
      throw new Error("network unreachable");
    });

    const response = await handleRequest(get(), SPARSE_ENV, kv);
    const body = await response.json();

    assert.equal(fetchCalls.length, 2, "expected the widening attempt to actually be made (and then fail)");
    assert.equal(response.status, 200, "a failed widening attempt should not fail an otherwise-successful request");
    assert.equal(body.stale, false);
    assert.equal(body.observations.length, 2, "should fall back to the narrow result that already succeeded");
  });

  it("does not attempt widening when the narrow result already meets the threshold", async () => {
    const kv = createFakeKv();
    const results = Array.from({ length: 30 }, (_, index) => rawObservation({ id: index + 1 }));
    fetchQueue.push(upstreamJson({ total_results: 30, results }));

    await handleRequest(get(), SPARSE_ENV, kv);

    assert.equal(fetchCalls.length, 1, "30 already meets the configured threshold — no widening fetch should happen");
  });

  it("does not widen at all when the threshold is disabled (0), even for a tiny result", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation({ id: 1 })] }));

    await handleRequest(get(), ENV, kv);

    assert.equal(fetchCalls.length, 1, "the shared test ENV disables widening by default");
  });
});

describe("worker adapter: multi-country place_id support", () => {
  it("uses the client-supplied place_id instead of the env default when provided", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation({ id: 1 })] }));

    await handleRequest(get("/observations?place_id=6448"), ENV, kv);

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /place_id=6448/);
    const cached = await kv.get("observations:6448", "json");
    assert.ok(cached, "expected the contract cached under the client-supplied place_id, not the env default (6857)");
  });

  it("falls back to the env default when place_id is missing or not a valid positive integer", async () => {
    for (const badValue of [null, "abc", "-5", "0", "3.5"]) {
      const kv = createFakeKv();
      fetchQueue.push(upstreamJson({ total_results: 0, results: [] }));
      const path = badValue === null ? "/observations" : `/observations?place_id=${badValue}`;

      await handleRequest(get(path), ENV, kv);

      assert.match(fetchCalls.at(-1).url, /place_id=6857/, `expected the env default for place_id=${badValue}`);
    }
  });

  it("caches different place_ids independently, with no cross-country collision", async () => {
    const kv = createFakeKv();
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation({ id: 1 })] })); // UK
    fetchQueue.push(upstreamJson({ total_results: 1, results: [rawObservation({ id: 2 })] })); // France

    const ukResponse = await handleRequest(get("/observations?place_id=6857"), ENV, kv);
    const frResponse = await handleRequest(get("/observations?place_id=6753"), ENV, kv);

    const ukBody = await ukResponse.json();
    const frBody = await frResponse.json();
    assert.equal(ukBody.observations[0].id, "inat-1");
    assert.equal(frBody.observations[0].id, "inat-2");
    assert.equal(fetchCalls.length, 2, "each place_id should trigger its own upstream fetch");
  });

  it("does not let a concurrent cache-miss for one place_id wait on (and receive) another place_id's in-flight refresh", async () => {
    const kv = createFakeKv();
    // Responds based on the requested URL's own place_id rather than queue
    // order, since two concurrent refreshes interleave their page requests
    // unpredictably — this is the scenario the old single shared
    // inFlightRefresh variable would have gotten wrong.
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      const placeId = new URL(String(url)).searchParams.get("place_id");
      return placeId === "6857"
        ? upstreamJson({ total_results: 1, results: [rawObservation({ id: 100 })] })
        : upstreamJson({ total_results: 1, results: [rawObservation({ id: 200 })] });
    };

    const [ukResponse, frResponse] = await Promise.all([
      handleRequest(get("/observations?place_id=6857"), ENV, kv),
      handleRequest(get("/observations?place_id=6753"), ENV, kv)
    ]);

    const ukBody = await ukResponse.json();
    const frBody = await frResponse.json();
    assert.equal(ukBody.observations[0].id, "inat-100", "the UK request should get UK data, not France's");
    assert.equal(frBody.observations[0].id, "inat-200", "the France request should get France's data, not the UK's");
  });
});
