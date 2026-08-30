import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ObservationQueue } from "../../src/observation-queue.js";

function observation(id, createdAtMs) {
  return { id, createdAtMs, taxonId: null, place: "", imageUrl: "" };
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

  it("keeps the oldest observations and drops the newest excess on overflow", () => {
    const queue = new ObservationQueue({ maxQueuedObservations: 3 });
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
