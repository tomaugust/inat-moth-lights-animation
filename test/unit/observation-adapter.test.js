import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import { normalizeObservation, parseObservationsResponse } from "../../src/observation-adapter.js";

const validRaw = {
  id: "inat-1",
  taxonId: 12345,
  scientificName: "Example species",
  commonName: "Example moth",
  taxonRank: "species",
  createdAt: "2026-07-13T10:46:30-03:00",
  observedAt: "2026-07-12T17:29:00-03:00",
  place: "Northern Europe",
  qualityGrade: "needs_id",
  imageUrl: "https://example.invalid/moth.jpg",
  imageAttribution: "Example attribution",
  imageLicense: "cc-by-nc",
  observationUrl: "https://www.inaturalist.org/observations/1"
};

describe("normalizeObservation", () => {
  it("normalizes a fully-populated observation", () => {
    const observation = normalizeObservation(validRaw);
    assert.equal(observation.id, "inat-1");
    assert.equal(observation.taxonId, 12345);
    assert.equal(observation.imageUrl, validRaw.imageUrl);
    assert.ok(Number.isFinite(observation.createdAtMs));
  });

  it("rejects a record with no id", () => {
    assert.equal(normalizeObservation({ ...validRaw, id: "" }), null);
    assert.equal(normalizeObservation({ ...validRaw, id: undefined }), null);
  });

  it("rejects a record with an invalid or missing createdAt", () => {
    assert.equal(normalizeObservation({ ...validRaw, createdAt: "not-a-date" }), null);
    assert.equal(normalizeObservation({ ...validRaw, createdAt: undefined }), null);
  });

  it("treats a missing or non-numeric taxon as unidentified rather than rejecting", () => {
    const missingTaxon = normalizeObservation({ ...validRaw, taxonId: undefined });
    assert.equal(missingTaxon.taxonId, null);

    const invalidTaxon = normalizeObservation({ ...validRaw, taxonId: "not-a-number" });
    assert.equal(invalidTaxon.taxonId, null);
  });

  it("falls back observedAt to createdAt when missing", () => {
    const observation = normalizeObservation({ ...validRaw, observedAt: undefined });
    assert.equal(observation.observedAtMs, observation.createdAtMs);
  });

  it("drops an incomplete photo instead of rendering a broken one", () => {
    const noAttribution = normalizeObservation({ ...validRaw, imageAttribution: "" });
    assert.equal(noAttribution.imageUrl, "");
    assert.equal(noAttribution.imageLicense, "");

    const noUrlAtAll = normalizeObservation({ ...validRaw, imageUrl: "", imageAttribution: "", imageLicense: "" });
    assert.equal(noUrlAtAll.imageUrl, "");
  });

  it("returns null for a non-object record", () => {
    assert.equal(normalizeObservation(null), null);
    assert.equal(normalizeObservation("inat-1"), null);
  });

  it("rejects an observation identified coarser than family level", () => {
    assert.equal(normalizeObservation({ ...validRaw, taxonRank: "order" }), null, "order (e.g. just \"Lepidoptera\") should be rejected");
    assert.equal(normalizeObservation({ ...validRaw, taxonRank: "superfamily" }), null);
    assert.equal(normalizeObservation({ ...validRaw, taxonRank: "suborder" }), null);
    assert.equal(normalizeObservation({ ...validRaw, taxonRank: "" }), null, "no taxon at all should be rejected, not treated as displayable");
    assert.equal(normalizeObservation({ ...validRaw, taxonRank: "not-a-real-rank" }), null, "an unrecognized rank name should be rejected, not silently admitted");
  });

  it("accepts family level and everything finer", () => {
    ["family", "subfamily", "tribe", "subtribe", "genus", "subgenus", "complex", "species", "subspecies"].forEach((rank) => {
      assert.notEqual(normalizeObservation({ ...validRaw, taxonRank: rank }), null, `expected ${rank} to be accepted`);
    });
  });

  it("carries a real lat/lon through, or null when absent/invalid", () => {
    const withLocation = normalizeObservation({ ...validRaw, lat: 51.5074, lon: -0.1278 });
    assert.equal(withLocation.lat, 51.5074);
    assert.equal(withLocation.lon, -0.1278);

    const withoutLocation = normalizeObservation({ ...validRaw, lat: undefined, lon: undefined });
    assert.equal(withoutLocation.lat, null);
    assert.equal(withoutLocation.lon, null);

    const withInvalidLocation = normalizeObservation({ ...validRaw, lat: "not-a-number", lon: null });
    assert.equal(withInvalidLocation.lat, null);
    assert.equal(withInvalidLocation.lon, null);
  });
});

describe("parseObservationsResponse", () => {
  it("normalizes every fixture file committed for Phase 0 without throwing", () => {
    ["observations-page-1.json", "observations-empty.json", "observations-error.json"].forEach((name) => {
      const payload = JSON.parse(fs.readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"));
      const parsed = parseObservationsResponse(payload);
      assert.ok(Array.isArray(parsed.observations));
    });
  });

  it("carries the stale/error markers through", () => {
    const payload = JSON.parse(
      fs.readFileSync(new URL("../../fixtures/observations-error.json", import.meta.url), "utf8")
    );
    const parsed = parseObservationsResponse(payload);
    assert.equal(parsed.stale, true);
    assert.equal(parsed.error, "fixture-upstream-unavailable");
    assert.deepEqual(parsed.observations, []);
  });

  it("filters out invalid records without rejecting the whole batch", () => {
    const parsed = parseObservationsResponse({
      fetchedAt: "2026-01-01T00:00:00Z",
      cursor: "abc",
      observations: [validRaw, { ...validRaw, id: "inat-2", createdAt: "garbage" }, { ...validRaw, id: "" }]
    });
    assert.equal(parsed.observations.length, 1);
    assert.equal(parsed.observations[0].id, "inat-1");
  });

  it("degrades gracefully for a missing or malformed payload", () => {
    assert.deepEqual(parseObservationsResponse(null).observations, []);
    assert.deepEqual(parseObservationsResponse({}).observations, []);
    assert.deepEqual(parseObservationsResponse({ observations: "not-an-array" }).observations, []);
  });
});
