import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FALLBACK_OBSERVATIONS } from "../../src/fallback-observations.js";
import { isAtLeastFamilyLevel, parseObservationsResponse } from "../../src/observation-adapter.js";

describe("fallback-observations: the last-resort static dataset", () => {
  it("is a non-trivial, diverse set of real, displayable observations", () => {
    assert.ok(Array.isArray(FALLBACK_OBSERVATIONS));
    assert.ok(FALLBACK_OBSERVATIONS.length >= 100, "expected enough entries to fill the scene for a while");

    const ids = new Set(FALLBACK_OBSERVATIONS.map((observation) => observation.id));
    assert.equal(ids.size, FALLBACK_OBSERVATIONS.length, "expected every id to be unique");

    // A real, unedited slice of a live feed (unlike a hand-curated
    // one-per-species set) naturally has some repeat species — a common
    // moth can easily be reported by several different observers within the
    // same 15-minute window — so this only guards against something clearly
    // degenerate (e.g. the same handful of species repeated throughout),
    // not perfect diversity.
    const taxonIds = new Set(FALLBACK_OBSERVATIONS.map((observation) => observation.taxonId));
    assert.ok(
      taxonIds.size > FALLBACK_OBSERVATIONS.length * 0.4,
      `expected a genuinely diverse set of species, saw only ${taxonIds.size} distinct taxa across ${FALLBACK_OBSERVATIONS.length} observations`
    );
  });

  it("every entry survives normalization with a real, usable photo — nothing silently dropped or blank", () => {
    const { observations } = parseObservationsResponse({ observations: FALLBACK_OBSERVATIONS });

    assert.equal(observations.length, FALLBACK_OBSERVATIONS.length, "expected no entry to fail normalizeObservation's validity checks");
    observations.forEach((observation) => {
      assert.ok(observation.imageUrl, `expected a photo for ${observation.id}`);
      assert.ok(observation.imageAttribution, `expected attribution for ${observation.id}`);
      assert.ok(observation.imageLicense, `expected a license for ${observation.id}`);
      assert.ok(observation.observationUrl.startsWith("https://www.inaturalist.org/observations/"), `expected a real observation link for ${observation.id}`);
    });
  });

  // This dataset was picked to maximize volume (the busiest 15-minute window
  // in a scanned 24h period — see the file header), not identification
  // purity, so unlike the earlier hand-curated, all-species set this
  // replaced, a large minority here is only identified to a coarser rank
  // (genus, family, or occasionally just order — often one batch of trap
  // photos uploaded together, a realistic pattern for a live feed's freshest,
  // not-yet-community-confirmed observations). MothStore already handles
  // that gracefully (isIdentifiedToSpecies buckets them into the shared
  // "unknown" profile, same as any live observation would be), so this only
  // guards against something clearly degenerate (near-zero identified
  // observations), not a majority requirement.
  it("has a substantial number of species-level identifications", () => {
    const speciesCount = FALLBACK_OBSERVATIONS.filter((observation) => observation.taxonRank === "species").length;
    assert.ok(
      speciesCount > 50,
      `expected a substantial number of species-level entries, saw ${speciesCount} of ${FALLBACK_OBSERVATIONS.length}`
    );
  });

  // Every observation, live or fallback, is meant to be identified at least
  // to family level (see observation-adapter.js's isAtLeastFamilyLevel) — an
  // ID of just "Lepidoptera" (order) or a superfamily grouping tells a
  // viewer nothing recognizable about the actual moth. This dataset was
  // filtered to that rule when it was captured (see the file header), so
  // this guards against a coarser entry slipping back in on a future
  // regeneration.
  it("never includes anything coarser than family level", () => {
    FALLBACK_OBSERVATIONS.forEach((observation) => {
      assert.ok(isAtLeastFamilyLevel(observation.taxonRank), `expected ${observation.id}'s rank (${observation.taxonRank}) to be family level or finer`);
    });
  });

  it("ids are namespaced so they can never collide with a real live observation's id", () => {
    FALLBACK_OBSERVATIONS.forEach((observation) => {
      assert.match(observation.id, /^fallback-inat-\d+$/);
    });
  });

  // Backfilled (Phase 15) by re-querying the same captured window with the
  // location field added, so the world map can plot the fallback set at real
  // reported locations, not just play it through the light. A real minority
  // has no location at all (obscured/private, or never set) — those are left
  // null, which world-map.js already treats as "no known point", not a bug.
  it("carries a real lat/lon for the large majority of entries", () => {
    const withLocation = FALLBACK_OBSERVATIONS.filter(
      (observation) => Number.isFinite(observation.lat) && Number.isFinite(observation.lon)
    );
    assert.ok(
      withLocation.length > FALLBACK_OBSERVATIONS.length * 0.9,
      `expected the large majority to have a real lat/lon, saw ${withLocation.length} of ${FALLBACK_OBSERVATIONS.length}`
    );
  });
});
