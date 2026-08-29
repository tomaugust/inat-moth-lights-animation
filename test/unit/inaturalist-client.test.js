import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONNECTION_STATES, InatClient, buildQueryUrl, mapRawObservationToContract } from "../../src/inaturalist-client.js";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : null) },
    json: async () => body
  };
}

function createFakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) {
        throw new Error("fake fetch ran out of queued responses");
      }
      return next;
    }
  };
}

function createFakeScheduler() {
  let nextHandle = 1;
  const scheduled = new Map();
  return {
    setTimeoutImpl: (callback, delayMs) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeoutImpl: (handle) => {
      scheduled.delete(handle);
    },
    lastDelayMs() {
      const handles = [...scheduled.keys()];
      const entry = scheduled.get(handles[handles.length - 1]);
      return entry ? entry.delayMs : undefined;
    },
    pendingCount() {
      return scheduled.size;
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

function createClient(overrides = {}) {
  const fake = createFakeFetch(overrides.responses || []);
  const scheduler = createFakeScheduler();
  const batches = [];
  const states = [];
  let cursor = null;

  const client = new InatClient({
    fetchImpl: fake.fetchImpl,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: overrides.now || (() => 0),
    getCursor: () => cursor,
    onBatch: (payload) => {
      cursor = payload.cursor;
      batches.push(payload);
    },
    onStateChange: (state) => states.push(state),
    pollIntervalSeconds: 60,
    ...overrides.options
  });

  return { client, fake, scheduler, batches, states, getCursor: () => cursor };
}

describe("mapRawObservationToContract", () => {
  it("maps a full v2 result into the project-owned contract shape", () => {
    const mapped = mapRawObservationToContract(rawObservation());
    assert.equal(mapped.id, "inat-123");
    assert.equal(mapped.taxonId, 1650173);
    assert.equal(mapped.taxonRank, "species");
    assert.equal(mapped.imageUrl, "https://example.invalid/photos/1/medium.jpg");
    assert.equal(mapped.imageAttribution, "A. Person");
  });

  it("degrades gracefully when taxon or photos are absent", () => {
    const mapped = mapRawObservationToContract(rawObservation({ taxon: null, photos: [] }));
    assert.equal(mapped.taxonId, null);
    assert.equal(mapped.imageUrl, "");
  });
});

describe("buildQueryUrl", () => {
  const options = { taxonId: 47157, photoLicenses: ["cc0", "cc-by"], pageSize: 200 };

  it("seeds with order_by=created_at when there is no cursor yet", () => {
    const url = buildQueryUrl(options, null);
    assert.match(url, /order_by=created_at/);
    assert.match(url, /order=desc/);
    assert.doesNotMatch(url, /id_above/);
  });

  it("uses id_above for incremental pages once a cursor exists", () => {
    const url = buildQueryUrl(options, "123456");
    assert.match(url, /id_above=123456/);
    assert.match(url, /order_by=id/);
    assert.match(url, /order=asc/);
  });
});

describe("InatClient polling", () => {
  it("fetches, maps and delivers a batch, then schedules the next poll", async () => {
    const { client, batches, states, scheduler } = createClient({
      responses: [jsonResponse({ total_results: 1, results: [rawObservation()] })]
    });

    client.isRunning = true;
    await client._pollNow();

    assert.equal(batches.length, 1);
    assert.equal(batches[0].observations.length, 1);
    assert.equal(batches[0].observations[0].id, "inat-123");
    assert.equal(batches[0].cursor, "123");
    assert.ok(states.includes(CONNECTION_STATES.LIVE));
    assert.equal(scheduler.lastDelayMs(), 60000);
  });

  it("reports the quiet state when a poll returns no new observations", async () => {
    const { client, states } = createClient({
      responses: [jsonResponse({ total_results: 0, results: [] })]
    });

    client.isRunning = true;
    await client._pollNow();

    assert.ok(states.includes(CONNECTION_STATES.QUIET));
  });

  it("advances the cursor so the next request does not replay the same page", async () => {
    const { client, fake, getCursor } = createClient({
      responses: [
        jsonResponse({ total_results: 1, results: [rawObservation({ id: 100 })] }),
        jsonResponse({ total_results: 1, results: [rawObservation({ id: 250 })] })
      ]
    });

    client.isRunning = true;
    await client._pollNow();
    assert.equal(getCursor(), "100");

    await client._pollNow();

    assert.equal(fake.calls.length, 2);
    assert.doesNotMatch(fake.calls[0].url, /id_above/);
    assert.match(fake.calls[1].url, /id_above=100/);
    assert.equal(getCursor(), "250");
  });

  it("never allows overlapping polls", async () => {
    const { client, fake } = createClient({
      responses: [jsonResponse({ total_results: 1, results: [rawObservation()] })]
    });

    client.isRunning = true;
    const first = client._pollNow();
    const second = client._pollNow(); // fired before the first has resolved

    assert.equal(fake.calls.length, 1, "a second poll started while one was in flight should be a no-op");
    await Promise.all([first, second]);
  });
});

describe("InatClient error recovery", () => {
  it("backs off using Retry-After on a 429 and does not deliver a batch", async () => {
    const { client, batches, states, scheduler } = createClient({
      responses: [jsonResponse(null, { status: 429, headers: { "Retry-After": "5" } })]
    });

    client.isRunning = true;
    await client._pollNow();

    assert.equal(batches.length, 0);
    assert.ok(states.includes(CONNECTION_STATES.RATE_LIMITED));
    assert.equal(scheduler.lastDelayMs(), 5000);
  });

  it("falls back to jittered exponential backoff on a 429 with no Retry-After header", async () => {
    const { client, scheduler } = createClient({
      responses: [jsonResponse(null, { status: 429 })],
      options: { pollIntervalSeconds: 10 }
    });

    client.isRunning = true;
    await client._pollNow();

    const delaySeconds = scheduler.lastDelayMs() / 1000;
    assert.ok(delaySeconds >= 10 * 0.75 && delaySeconds <= 10 * 1.25, `unexpected backoff: ${delaySeconds}s`);
  });

  it("marks the connection stale on a server error, then recovers automatically on the next successful poll", async () => {
    const { client, batches, states } = createClient({
      responses: [
        jsonResponse(null, { status: 503 }),
        jsonResponse({ total_results: 1, results: [rawObservation()] })
      ]
    });

    client.isRunning = true;
    await client._pollNow();
    assert.ok(states.includes(CONNECTION_STATES.STALE));
    assert.equal(batches.length, 0, "the frontend should keep showing existing data, not an empty batch");

    client.isRunning = true;
    await client._pollNow();
    assert.equal(batches.length, 1);
    assert.equal(client.backoffSeconds, 0, "backoff resets after a successful response");
  });

  it("recovers automatically from a network error (e.g. offline fetch rejection)", async () => {
    const { client, states } = createClient({});
    client.options.fetchImpl = async () => {
      throw new Error("network request failed");
    };

    client.isRunning = true;
    await client._pollNow();
    assert.ok(states.includes(CONNECTION_STATES.STALE));
  });

  it("stops ingestion on a fatal schema error but leaves the scene alone", async () => {
    const { client, batches, states } = createClient({
      responses: [jsonResponse({ unexpected: "shape" })]
    });

    client.isRunning = true;
    await client._pollNow();

    assert.ok(states.includes(CONNECTION_STATES.FATAL_SCHEMA_ERROR));
    assert.equal(batches.length, 0);
    assert.equal(client.isRunning, false, "ingestion should stop rather than keep hitting a broken schema");
  });
});

describe("InatClient offline/online handling", () => {
  it("stops polling on offline and resumes immediately on online", async () => {
    const { client, states, fake } = createClient({
      responses: [jsonResponse({ total_results: 1, results: [rawObservation()] })]
    });

    client.isRunning = true;
    client._handleOffline();
    assert.ok(states.includes(CONNECTION_STATES.OFFLINE));

    client._handleOnline();
    // _handleOnline fires _pollNow() without awaiting; give it a tick.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fake.calls.length, 1, "coming back online should trigger an immediate poll");
  });
});

describe("InatClient.getStats", () => {
  it("computes an observations-per-minute rate from the injected clock", async () => {
    let currentMs = 0;
    const { client } = createClient({
      responses: [jsonResponse({ total_results: 2, results: [rawObservation({ id: 1 }), rawObservation({ id: 2 })] })],
      now: () => currentMs
    });

    // Set up what start() would, but call _pollNow() directly and await it —
    // start() fires _pollNow() without awaiting it, which races this test.
    client.isRunning = true;
    client.stats.startedAtMs = currentMs;
    await client._pollNow();

    currentMs = 30000; // 30 seconds later
    const stats = client.getStats();
    assert.equal(stats.observationsReceived, 2);
    assert.equal(stats.observationsPerMinute, 4); // 2 observations / 0.5 minutes
  });
});
