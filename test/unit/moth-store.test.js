import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { setConfig } from "../../src/config-store.js";
import { getExitStartTime, projectMoth } from "../../src/animation-engine.js";
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

describe("MothStore moth record", () => {
  it("carries the upload time and the record's own taxonomic rank, and no photographed time", () => {
    const store = new MothStore();
    store.addObservation(observation("a", { createdAtMs: 1234567, taxonRank: "family", taxonId: 555 }), 0, 800, 600);
    const [moth] = store.getActiveMoths();
    assert.equal(moth.createdAtMs, 1234567);
    assert.equal(moth.taxonRank, "family");
    assert.equal("observedAtMs" in moth, false);
  });

  it("admits a moth identified only to family level, as its own moth with its own name", () => {
    const store = new MothStore();
    const admitted = store.addObservation(
      observation("f", { taxonId: 777, taxonRank: "family", scientificName: "Noctuidae", commonName: "Owlet Moths" }),
      0, 800, 600
    );
    assert.equal(admitted, true);
    assert.equal(store.getActiveMoths()[0].speciesName, "Owlet Moths");
  });
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

  it("carries photo attribution, license, source link and raw taxon fields through to the rendered moth", () => {
    const store = new MothStore();
    store.addObservation(
      observation("a", {
        imageUrl: "https://example.invalid/medium.jpg",
        imageAttribution: "A. Person",
        imageLicense: "cc-by-nc",
        observationUrl: "https://www.inaturalist.org/observations/a",
        place: "Northern Europe",
        qualityGrade: "needs_id"
      }),
      0,
      800,
      600
    );
    const [moth] = store.getActiveMoths();

    assert.equal(moth.imageURL, "https://example.invalid/medium.jpg");
    assert.equal(moth.imageAttribution, "A. Person");
    assert.equal(moth.imageLicense, "cc-by-nc");
    assert.equal(moth.observationUrl, "https://www.inaturalist.org/observations/a");
    assert.equal(moth.place, "Northern Europe");
    assert.equal(moth.qualityGrade, "needs_id");
    assert.equal(moth.scientificName, "Example species");
    assert.equal(moth.commonName, "Example moth");
  });
});

describe("MothStore.removeExpired", () => {
  it("keeps a moth active until its exit time", () => {
    const store = new MothStore({ minMothDurationSeconds: 100, maxMothDurationSeconds: 100 });
    store.addObservation(observation("a"), 0, 800, 600);
    store.addObservation(observation("b"), 40, 800, 600); // outlives a: exits at 140, not 100
    store.removeExpired(50);
    assert.equal(store.activeCount, 2);
    store.removeExpired(120);
    assert.deepEqual(store.getActiveMoths().map((moth) => moth.id), ["b"]);
  });

  it("never removes the last moth in the scene, even past its exit time", () => {
    const store = new MothStore({ minMothDurationSeconds: 10, maxMothDurationSeconds: 10 });
    store.addObservation(observation("a"), 0, 800, 600);
    store.removeExpired(500);
    assert.equal(store.activeCount, 1);
  });

  it("removes only all-but-one when several moths are all past their exit time", () => {
    const store = new MothStore({ minMothDurationSeconds: 10, maxMothDurationSeconds: 10 });
    store.addObservation(observation("a"), 0, 800, 600);
    store.addObservation(observation("b"), 1, 800, 600);
    store.addObservation(observation("c"), 2, 800, 600);
    store.removeExpired(500);
    assert.equal(store.activeCount, 1, "the scene should never be emptied, even if everything is overdue");
  });

  it("keeps a focused moth alive past its exit time until focus clears", () => {
    const store = new MothStore({ minMothDurationSeconds: 10, maxMothDurationSeconds: 10 });
    store.addObservation(observation("a"), 0, 800, 600);
    store.addObservation(observation("b"), 5, 800, 600);
    store.focusMoth("a", 0);

    store.removeExpired(12); // a's natural exit (10) has passed; b (15) hasn't
    assert.equal(store.activeCount, 2, "focused moth should survive past its natural exit time");

    store.clearFocus();
    store.removeExpired(12);
    assert.deepEqual(store.getActiveMoths().map((moth) => moth.id), ["b"]);
  });

  it("force-removes a focused moth once the grace period elapses, to avoid a leak", () => {
    const store = new MothStore({
      minMothDurationSeconds: 10,
      maxMothDurationSeconds: 10,
      focusGracePeriodSeconds: 30
    });
    store.addObservation(observation("a"), 0, 800, 600);
    store.addObservation(observation("b"), 40, 800, 600); // still alive at 45
    store.focusMoth("a", 0);

    store.removeExpired(45); // 45s since focus started (0) is past the 30s grace period
    assert.deepEqual(store.getActiveMoths().map((moth) => moth.id), ["b"]);
    assert.equal(store.focusedId, null, "focus should clear once the moth is force-removed");
  });
});

describe("MothStore.holdLastMoth", () => {
  const lifetime = { minMothDurationSeconds: 10, maxMothDurationSeconds: 10 };

  beforeEach(() => {
    setConfig(createSampleConfig());
  });

  it("extends a lone moth's life just before it would start to leave", () => {
    const store = new MothStore(lifetime);
    store.addObservation(observation("a"), 0, 800, 600);
    const [moth] = store.getActiveMoths();
    assert.ok(getExitStartTime(moth) < 8, "sanity: a 10s moth starts leaving before 8s");

    store.holdLastMoth(7.7); // within the lookahead of its fly-out at ~7.8
    assert.ok(getExitStartTime(moth) > 7.7 + 0.25, "the fly-out should have been pushed back");
    assert.equal(projectMoth(moth, 7.9, 800, 600, 400, 330).phase, "orbiting");
  });

  it("does not extend a moth while another is staying", () => {
    const store = new MothStore(lifetime);
    store.addObservation(observation("a"), 0, 800, 600);
    store.addObservation(observation("b"), 5, 800, 600);
    const a = store.getActiveMoths()[0];
    const exitBefore = a.exitTime;

    store.holdLastMoth(7.7);
    assert.equal(a.exitTime, exitBefore, "b is staying until ~12.8, so a is free to leave");
  });

  it("holds the second of two moths that are about to leave together (they never both go)", () => {
    const store = new MothStore(lifetime);
    store.addObservation(observation("a"), 0, 800, 600);
    store.addObservation(observation("b"), 0.1, 800, 600);

    store.holdLastMoth(7.75);
    const exitStarts = store.getActiveMoths().map(getExitStartTime);
    assert.ok(
      exitStarts.some((exitStart) => exitStart > 7.75 + 0.25),
      "at least one of them must have been kept, not both left to fly out"
    );
  });

  it("handles a clock that jumped well past a moth's exit (e.g. a backgrounded tab)", () => {
    const store = new MothStore(lifetime);
    store.addObservation(observation("a"), 0, 800, 600);
    const [moth] = store.getActiveMoths();

    store.holdLastMoth(50);
    store.removeExpired(50);
    assert.equal(store.activeCount, 1);
    assert.ok(getExitStartTime(moth) > 50.25);
    assert.equal(projectMoth(moth, 50, 800, 600, 400, 330).phase, "orbiting");
  });

  it("never leaves the scene visibly empty across a long run, and lets a held moth go once a replacement arrives", () => {
    const store = new MothStore(lifetime);
    store.addObservation(observation("a"), 0, 800, 600);
    const seenExiting = new Set();

    for (let t = 0.05; t < 120; t += 0.05) {
      if (Math.abs(t - 30) < 1e-9 || (t > 29.99 && t < 30.01)) {
        store.addObservation(observation("c"), t, 800, 600);
      }
      store.holdLastMoth(t);
      store.removeExpired(t);

      const moths = store.getActiveMoths();
      assert.ok(moths.length >= 1, "the store was emptied at t=" + t.toFixed(2));
      assert.ok(
        moths.some((moth) => t < getExitStartTime(moth)),
        "every moth was already flying out at t=" + t.toFixed(2)
      );

      // A moth that has started flying out is never pulled back into orbit.
      moths.forEach((moth) => {
        const projected = projectMoth(moth, t, 800, 600, 400, 330, false);
        if (!projected) {
          return;
        }
        if (projected.phase === "exiting") {
          seenExiting.add(moth.id);
        } else if (seenExiting.has(moth.id)) {
          assert.fail(moth.id + " snapped back from flying out to " + projected.phase + " at t=" + t.toFixed(2));
        }
      });
    }

    assert.deepEqual(store.getActiveMoths().map((moth) => moth.id), ["c"], "a should have left once c arrived");
  });
});
