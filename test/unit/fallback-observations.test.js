import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FALLBACK_COUNTRY_NAME, FALLBACK_OBSERVATIONS } from "../../src/fallback-observations.js";
import { parseObservationsResponse } from "../../src/observation-adapter.js";

describe("fallback-observations: the last-resort static dataset", () => {
  it("names a country", () => {
    assert.equal(typeof FALLBACK_COUNTRY_NAME, "string");
    assert.ok(FALLBACK_COUNTRY_NAME.length > 0);
  });

  it("is a non-trivial, diverse set of real, displayable observations", () => {
    assert.ok(Array.isArray(FALLBACK_OBSERVATIONS));
    assert.ok(FALLBACK_OBSERVATIONS.length >= 20, "expected enough entries to fill the scene for a while");

    const ids = new Set(FALLBACK_OBSERVATIONS.map((observation) => observation.id));
    assert.equal(ids.size, FALLBACK_OBSERVATIONS.length, "expected every id to be unique");

    const taxonIds = new Set(FALLBACK_OBSERVATIONS.map((observation) => observation.taxonId));
    assert.ok(taxonIds.size > FALLBACK_OBSERVATIONS.length * 0.9, "expected the set to be species-diverse, not the same handful repeated");
  });

  it("every entry survives normalization with a real, usable photo — nothing silently dropped or blank", () => {
    const { observations } = parseObservationsResponse({ observations: FALLBACK_OBSERVATIONS });

    assert.equal(observations.length, FALLBACK_OBSERVATIONS.length, "expected no entry to fail normalizeObservation's validity checks");
    observations.forEach((observation) => {
      assert.ok(observation.imageUrl, `expected a photo for ${observation.id}`);
      assert.ok(observation.imageAttribution, `expected attribution for ${observation.id}`);
      assert.ok(observation.imageLicense, `expected a license for ${observation.id}`);
      assert.ok(observation.observationUrl.startsWith("https://www.inaturalist.org/observations/"), `expected a real observation link for ${observation.id}`);
      assert.equal(observation.taxonRank, "species", `expected ${observation.id} to be identified to species so it doesn't render as "unknown"`);
    });
  });

  it("ids are namespaced so they can never collide with a real live observation's id", () => {
    FALLBACK_OBSERVATIONS.forEach((observation) => {
      assert.match(observation.id, /^fallback-inat-\d+$/);
    });
  });
});
