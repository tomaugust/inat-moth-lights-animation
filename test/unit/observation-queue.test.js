import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MothStore } from "../../src/moth-store.js";
import { DEFAULT_SOURCE_TIME_SCALE, ObservationQueue, selectDiverseSample } from "../../src/observation-queue.js";

function observation(id, createdAtMs, overrides = {}) {
  return { id, createdAtMs, taxonId: null, taxonRank: null, place: "", imageUrl: "", ...overrides };
}

function speciesObservation(id, createdAtMs, taxonId) {
  return observation(id, createdAtMs, { taxonId, taxonRank: "species" });
}

function createFakeStorage() {
  const backing = new Map();
  return {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value)
  };
}

describe("ObservationQueue.enqueue", () => {
  it("deduplicates by observation id", () => {
    const queue = new ObservationQueue();
    assert.equal(queue.enqueue([observation("a", 0)]), 1);
    assert.equal(queue.enqueue([observation("a", 0)]), 0);
    assert.equal(queue.pendingCount, 1);
  });

  it("sorts pending observations by createdAt regardless of insertion order", () => {
    const queue = new ObservationQueue();
    queue.enqueue([observation("b", 2000), observation("a", 1000), observation("c", 3000)]);
    assert.deepEqual(
      queue.pending.map((item) => item.id),
      ["a", "b", "c"]
    );
  });

  it("keeps the oldest observations and drops the newest excess on overflow, when everything is the same species", () => {
    // A single (or unidentified) species has only one diversity bucket, so
    // selectDiverseSample degrades to plain oldest-first truncation here.
    const queue = new ObservationQueue({ targetSampleSize: 3 });
    queue.enqueue([
      observation("a", 1),
      observation("b", 2),
      observation("c", 3),
      observation("d", 4),
      observation("e", 5)
    ]);
    assert.deepEqual(
      queue.pending.map((item) => item.id),
      ["a", "b", "c"]
    );
  });

  it("thins an overflowing multi-species batch to a diverse sample instead of favoring whichever species has the most records", () => {
    const queue = new ObservationQueue({ targetSampleSize: 3 });
    // Species A dominates (5 records); species B and C have one each. A
    // plain oldest-first truncation would show only species A.
    queue.enqueue([
      speciesObservation("a1", 1, 100),
      speciesObservation("a2", 2, 100),
      speciesObservation("b1", 3, 200),
      speciesObservation("a3", 4, 100),
      speciesObservation("c1", 5, 300),
      speciesObservation("a4", 6, 100),
      speciesObservation("a5", 7, 100)
    ]);

    const keptTaxonIds = new Set(queue.pending.map((item) => item.taxonId));
    assert.deepEqual([...keptTaxonIds].sort(), [100, 200, 300], "expected all three species represented");
    assert.equal(queue.pendingCount, 3);
  });
});

describe("selectDiverseSample", () => {
  it("is a no-op when the input is already at or under the target size", () => {
    const input = [observation("a", 1), observation("b", 2)];
    assert.equal(selectDiverseSample(input, 5), input);
  });

  it("round-robins across species buckets, then re-sorts chronologically", () => {
    const sample = selectDiverseSample(
      [
        speciesObservation("a1", 1, 100),
        speciesObservation("a2", 2, 100),
        speciesObservation("b1", 3, 200),
        speciesObservation("a3", 4, 100)
      ],
      2
    );

    // Round 0 takes the first available from each bucket in encounter order
    // (taxon 100 then taxon 200): a1, b1 — already chronological.
    assert.deepEqual(sample.map((item) => item.id), ["a1", "b1"]);
  });

  it("buckets anything short of species-level identification together as unknown, matching MothStore's own definition", () => {
    const sample = selectDiverseSample(
      [
        observation("genus1", 1, { taxonId: 999, taxonRank: "genus" }),
        speciesObservation("species1", 2, 100),
        observation("unidentified1", 3, { taxonId: null, taxonRank: null })
      ],
      2
    );

    // A genus-level record and a fully unidentified one collapse into the
    // same "unknown" bucket as each other (not two separate buckets), so a
    // target of 2 takes one from "unknown" and one from "taxon-100" rather
    // than treating this as three distinct species worth spreading across.
    const taxonKeys = sample.map((item) => (item.taxonRank === "species" ? `taxon-${item.taxonId}` : "unknown"));
    assert.deepEqual(taxonKeys.sort(), ["taxon-100", "unknown"]);
  });
});

describe("ObservationQueue.peekDue / acknowledge", () => {
  it("paces release by the source createdAt gap", () => {
    const queue = new ObservationQueue({
      minReleaseIntervalSeconds: 1,
      maxReleaseIntervalSeconds: 30,
      releaseJitterMin: 1,
      releaseJitterMax: 1
    });
    queue.enqueue([observation("a", 0), observation("b", 1000), observation("c", 2000)]);

    let due = queue.peekDue(0);
    assert.deepEqual(due.map((item) => item.id), ["a"]);
    queue.acknowledge("a", 0);

    due = queue.peekDue(0.5);
    assert.deepEqual(due, [], "b should not be due yet at t=0.5 (1s gap from a)");

    due = queue.peekDue(1);
    assert.deepEqual(due.map((item) => item.id), ["b"]);
    queue.acknowledge("b", 1);

    due = queue.peekDue(2);
    assert.deepEqual(due.map((item) => item.id), ["c"]);
  });

  it("caps how many overdue observations are released per call", () => {
    const queue = new ObservationQueue({
      maxCatchUpObservations: 2,
      minReleaseIntervalSeconds: 0,
      maxReleaseIntervalSeconds: 30,
      releaseJitterMin: 1,
      releaseJitterMax: 1
    });
    queue.enqueue([
      observation("a", 0),
      observation("b", 0),
      observation("c", 0),
      observation("d", 0),
      observation("e", 0)
    ]);

    const due = queue.peekDue(1000);
    assert.equal(due.length, 2, "a large backlog should be paced out, not released all at once");
  });

  it("leaves an un-acknowledged observation pending for the next call", () => {
    const queue = new ObservationQueue({ releaseJitterMin: 1, releaseJitterMax: 1 });
    queue.enqueue([observation("a", 0)]);

    const firstPeek = queue.peekDue(0);
    assert.equal(firstPeek.length, 1);
    // Simulate the caller rejecting it (scene full): no acknowledge() call.
    assert.equal(queue.pendingCount, 1, "an un-acknowledged observation stays pending");

    const secondPeek = queue.peekDue(0);
    assert.equal(secondPeek.length, 1, "it is offered again on the next call");
  });
});

describe("ObservationQueue default pacing (one-minute-per-day time-lapse)", () => {
  it("compresses a full real day's gap exactly to the release-interval ceiling", () => {
    // 86400s (24h) * DEFAULT_SOURCE_TIME_SCALE (1/1440) = 60 pre-jitter —
    // still far above the 3s ceiling even after the widest jitter (x0.65),
    // so the clamped result is deterministically exactly 3s regardless of
    // which observation id lands on which jitter value.
    assert.equal(DEFAULT_SOURCE_TIME_SCALE * 86400, 60);

    const queue = new ObservationQueue();
    queue.enqueue([observation("a", 0), observation("b", 24 * 60 * 60 * 1000)]);

    const firstDue = queue.peekDue(0);
    assert.deepEqual(firstDue.map((item) => item.id), ["a"], "the first-ever release has no gap to pace");
    queue.acknowledge("a", 0);

    assert.deepEqual(queue.peekDue(2.99), [], "a full day's gap should not release before the 3s ceiling");
    assert.deepEqual(queue.peekDue(3).map((item) => item.id), ["b"]);
  });

  it("compresses a small real gap up to the release-interval floor", () => {
    // 10s * 1/1440 ≈ 0.0069s pre-jitter — still far below the 0.05s floor
    // even after the narrowest jitter (x1.35), so the clamped result is
    // deterministically exactly 0.05s regardless of jitter.
    const queue = new ObservationQueue();
    queue.enqueue([observation("a", 0), observation("b", 10000)]);

    const firstDue = queue.peekDue(0);
    assert.deepEqual(firstDue.map((item) => item.id), ["a"]);
    queue.acknowledge("a", 0);

    assert.deepEqual(queue.peekDue(0.049), [], "a 10s real gap should not release before the 0.05s floor");
    assert.deepEqual(queue.peekDue(0.05).map((item) => item.id), ["b"]);
  });
});

describe("ObservationQueue persistence", () => {
  it("restores the cursor and seen-id window from storage", () => {
    const storage = createFakeStorage();
    const first = new ObservationQueue({ storage });
    first.enqueue([observation("a", 0)], "cursor-1");

    const second = new ObservationQueue({ storage });
    assert.equal(second.cursor, "cursor-1");
    assert.equal(second.enqueue([observation("a", 0)]), 0, "id seen by a previous session is still deduplicated");
  });

  it("recovers from corrupt storage instead of throwing", () => {
    const storage = {
      getItem: () => "{not valid json",
      setItem: () => {}
    };

    assert.doesNotThrow(() => {
      const queue = new ObservationQueue({ storage });
      assert.equal(queue.cursor, "");
      assert.equal(queue.pendingCount, 0);
    });
  });

  it("works with no storage configured at all", () => {
    assert.doesNotThrow(() => {
      const queue = new ObservationQueue();
      queue.enqueue([observation("a", 0)]);
    });
  });
});

// The pacing app.js's createQueue() configures for the live feed (real time,
// with release-interval clamps sized for real time rather than the
// compressed time-lapse defaults).
const REAL_TIME_OPTIONS = { sourceTimeScale: 1, minReleaseIntervalSeconds: 0.75, maxReleaseIntervalSeconds: 30 };

function seededShuffle(items, seed) {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("ObservationQueue real-time entry order", () => {
  it("admits moths strictly in upload (created_at) order, however the batches arrive and whatever the scene's capacity", () => {
    const queue = new ObservationQueue({ ...REAL_TIME_OPTIONS, targetSampleSize: 1000 });
    const store = new MothStore();

    // 60 observations spread irregularly over ~13 real minutes, delivered the
    // way successive polls do: each batch is a newer slice than the last
    // (with a few repeats at the seam, which the queue must drop), and within
    // a batch the API's own order can be anything.
    const all = Array.from({ length: 60 }, (_, index) =>
      speciesObservation("obs-" + index, 1_000_000 + index * 13_000 + (index % 7) * 900, 100 + (index % 9))
    );
    const batches = [
      seededShuffle(all.slice(0, 25), 42),
      seededShuffle(all.slice(20, 45), 7),
      seededShuffle(all.slice(40), 99)
    ];

    const admitted = [];
    let nextBatch = 0;
    for (let t = 0; t < 2400; t += 0.05) {
      if (nextBatch < batches.length && t >= nextBatch * 300) {
        queue.enqueue(batches[nextBatch]);
        nextBatch += 1;
      }
      queue.peekDue(t).forEach((item) => {
        if (store.addObservation(item, t, 800, 600)) {
          queue.acknowledge(item.id, t);
          admitted.push(item);
        }
      });
      store.holdLastMoth(t);
      store.removeExpired(t);
    }

    assert.equal(admitted.length, 60, "every observation should be admitted exactly once");
    for (let i = 1; i < admitted.length; i += 1) {
      assert.ok(
        admitted[i].createdAtMs >= admitted[i - 1].createdAtMs,
        "out of order: " + admitted[i - 1].id + " then " + admitted[i].id
      );
    }
  });

  it("paces a real gap at close to that gap, not squashed to a few seconds", () => {
    const queue = new ObservationQueue(REAL_TIME_OPTIONS);
    queue.enqueue([observation("a", 0), observation("b", 20_000)]);

    queue.acknowledge(queue.peekDue(0)[0].id, 0);
    assert.equal(queue.peekDue(10).length, 0, "b was posted 20s after a, so it shouldn't be due after 10s");
    assert.equal(queue.peekDue(20 * 0.65 - 0.01).length, 0, "even with the most jitter it can't be due before 13s");
    assert.equal(queue.peekDue(20 * 1.35 + 0.01).length, 1);
  });
});
