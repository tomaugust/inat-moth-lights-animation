import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { setConfig } from "../../src/config-store.js";
import { projectMoth } from "../../src/animation-engine.js";
import { MothStore } from "../../src/moth-store.js";
import { clearSpeciesStyleCache } from "../../src/species-style.js";
import { createSampleConfig } from "../fixtures/sample-config.mjs";

function observation(id, overrides = {}) {
  return {
    id,
    taxonId: 12345,
    scientificName: "Example species",
    commonName: "Example moth",
    taxonRank: "species",
    createdAtMs: Date.now(),
    observedAtMs: Date.now(),
    place: "Northern Europe",
    qualityGrade: "needs_id",
    imageUrl: "",
    imageAttribution: "",
    imageLicense: "",
    observationUrl: "",
    ...overrides
  };
}

beforeEach(() => {
  clearSpeciesStyleCache();
});

describe("MothStore.addObservation", () => {
  it("admits a new observation", () => {
    const store = new MothStore();
    const admitted = store.addObservation(observation("a"), 0, 800, 600);
    assert.equal(admitted, true);
    assert.equal(store.activeCount, 1);
  });

  it("rejects a duplicate id instead of replacing the moth", () => {
    const store = new MothStore();
    store.addObservation(observation("a"), 0, 800, 600);
    const admittedAgain = store.addObservation(observation("a"), 5, 800, 600);
    assert.equal(admittedAgain, false);
    assert.equal(store.activeCount, 1);
  });

  it("rejects new observations once the scene is at capacity", () => {
    const store = new MothStore({ maxActiveMoths: 2 });
    assert.equal(store.addObservation(observation("a"), 0, 800, 600), true);
    assert.equal(store.addObservation(observation("b"), 0, 800, 600), true);
    assert.equal(store.addObservation(observation("c"), 0, 800, 600), false);
    assert.equal(store.activeCount, 2);
  });

  it("assigns an unknown-taxon moth the 'unknown' species key", () => {
    const store = new MothStore();
    store.addObservation(observation("a", { taxonId: null }), 0, 800, 600);
    assert.equal(store.getActiveMoths()[0].species, "unknown");
  });

  it("treats a coarser-than-species identification (e.g. genus) as unknown too", () => {
    const store = new MothStore();
    store.addObservation(observation("a", { taxonId: 118929, taxonRank: "genus" }), 0, 800, 600);
    const [moth] = store.getActiveMoths();
    assert.equal(moth.species, "unknown");
    assert.equal(moth.color, "#919191");
  });
});

describe("MothStore.removeExpired", () => {
  it("keeps a moth active until its exit time", () => {
    const store = new MothStore({ minMothDurationSeconds: 100, maxMothDurationSeconds: 100 });
    store.addObservation(observation("a"), 0, 800, 600);
    store.removeExpired(50);
    assert.equal(store.activeCount, 1);
    store.removeExpired(150);
    assert.equal(store.activeCount, 0);
  });

  it("keeps a focused moth alive past its exit time until focus clears", () => {
    const store = new MothStore({ minMothDurationSeconds: 10, maxMothDurationSeconds: 10 });
    store.addObservation(observation("a"), 0, 800, 600);
    store.focusMoth("a", 0);

    store.removeExpired(20);
    assert.equal(store.activeCount, 1, "focused moth should survive past its natural exit time");

    store.clearFocus();
    store.removeExpired(20);
    assert.equal(store.activeCount, 0);
  });

  it("force-removes a focused moth once the grace period elapses, to avoid a leak", () => {
    const store = new MothStore({
      minMothDurationSeconds: 10,
      maxMothDurationSeconds: 10,
      focusGracePeriodSeconds: 30
    });
    store.addObservation(observation("a"), 0, 800, 600);
    store.focusMoth("a", 0);

    store.removeExpired(45); // 45s since focus started (0) is past the 30s grace period
    assert.equal(store.activeCount, 0);
    assert.equal(store.focusedId, null, "focus should clear once the moth is force-removed");
  });
});

describe("MothStore focus and removal API", () => {
  it("focusMoth/clearFocus/removeMoth behave as a small controller API", () => {
    const store = new MothStore();
    store.addObservation(observation("a"), 0, 800, 600);

    assert.equal(store.focusMoth("does-not-exist", 0), false);
    assert.equal(store.focusMoth("a", 0), true);
    assert.equal(store.focusedId, "a");

    store.clearFocus();
    assert.equal(store.focusedId, null);

    assert.equal(store.removeMoth("a"), true);
    assert.equal(store.activeCount, 0);
  });
});

describe("MothStore output compatibility with the animation engine", () => {
  it("produces moths that projectMoth can render without error", () => {
    setConfig(createSampleConfig());
    const store = new MothStore();
    store.addObservation(observation("a"), 0, 800, 600);
    const [moth] = store.getActiveMoths();

    const projected = projectMoth(moth, 1, 800, 600, 400, 330);
    assert.ok(projected);
    assert.ok(Number.isFinite(projected.x));
    assert.ok(Number.isFinite(projected.y));
    assert.ok(projected.opacity >= 0 && projected.opacity <= 1);
  });
});
