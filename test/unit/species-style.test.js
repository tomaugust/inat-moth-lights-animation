import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { clearSpeciesStyleCache, getSpeciesStyle } from "../../src/species-style.js";

beforeEach(() => {
  clearSpeciesStyleCache();
});

describe("getSpeciesStyle", () => {
  it("returns the same grey profile for every unidentified observation", () => {
    const a = getSpeciesStyle(null);
    const b = getSpeciesStyle(undefined);
    const c = getSpeciesStyle("not-a-number");
    assert.equal(a.color, "#919191");
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });

  it("is deterministic for the same taxon id", () => {
    const first = getSpeciesStyle(48662);
    clearSpeciesStyleCache();
    const second = getSpeciesStyle(48662);
    assert.deepEqual(first, second);
  });

  it("gives different taxa different styles most of the time", () => {
    const a = getSpeciesStyle(48662);
    const b = getSpeciesStyle(118929);
    assert.notDeepEqual(a, b);
  });

  it("stays within the documented bounds", () => {
    for (let taxonId = 1; taxonId <= 50; taxonId += 1) {
      const style = getSpeciesStyle(taxonId);
      assert.ok(style.speed >= 0.4 && style.speed <= 1.8);
      assert.ok(style.size >= 2 && style.size <= 5);
      assert.ok(style.erraticness >= 1.2 && style.erraticness <= 3.2);
      assert.ok(style.trailLength >= 5 && style.trailLength <= 10);
      assert.ok(style.chimeNotes.length >= 2 && style.chimeNotes.length <= 4);
      assert.ok(style.chimeNotes.includes(style.chimeNote));
    }
  });

  it("returns a fresh copy each time so callers can't mutate the cache", () => {
    const first = getSpeciesStyle(48662);
    first.chimeNotes.push("Z9");
    const second = getSpeciesStyle(48662);
    assert.ok(!second.chimeNotes.includes("Z9"));
  });
});
