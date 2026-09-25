import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { clearSpeciesStyleCache, getSpeciesStyle, PALETTE } from "../../src/species-style.js";

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

describe("the moth colour palette", () => {
  it("is exactly the five chosen colours: white, pine blue, french blue, jungle green, yellow green", () => {
    assert.deepEqual([...PALETTE], ["#ffffff", "#387d7a", "#334195", "#26a96c", "#97cc04"]);
  });

  it("colours every identified moth with one of those five, and uses all of them", () => {
    const seen = new Set();
    for (let taxonId = 1; taxonId <= 300; taxonId += 1) {
      const { color } = getSpeciesStyle(taxonId);
      assert.ok(PALETTE.includes(color), "unexpected colour " + color + " for taxon " + taxonId);
      seen.add(color);
    }
    assert.equal(seen.size, PALETTE.length, "every colour should turn up: " + [...seen]);
  });

  it("keeps unidentified moths grey, outside the palette", () => {
    assert.ok(!PALETTE.includes(getSpeciesStyle(null).color));
  });

  it("gives each moth a glow in its own colour, so the darker blues stay visible on the dark map", () => {
    const expected = {
      "#ffffff": "rgba(255, 255, 255, 0.55)",
      "#387d7a": "rgba(56, 125, 122, 0.55)",
      "#334195": "rgba(51, 65, 149, 0.55)",
      "#26a96c": "rgba(38, 169, 108, 0.55)",
      "#97cc04": "rgba(151, 204, 4, 0.55)"
    };
    for (let taxonId = 1; taxonId <= 60; taxonId += 1) {
      const style = getSpeciesStyle(taxonId);
      assert.equal(style.shadowColor, expected[style.color], "glow for " + style.color);
    }
  });
});
