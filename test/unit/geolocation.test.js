import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_PLACE_ID } from "../../src/inaturalist-client.js";
import { resolveUserPlace } from "../../src/geolocation.js";

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeGeolocation({ latitude = 51.5, longitude = -0.12, error } = {}) {
  return {
    getCurrentPosition(onSuccess, onError) {
      if (error) {
        onError(error);
        return;
      }
      onSuccess({ coords: { latitude, longitude } });
    }
  };
}

function nearbyResponse({ standard = [], community = [] } = {}) {
  return jsonResponse({ total_results: standard.length + community.length, results: { standard, community } });
}

describe("resolveUserPlace", () => {
  it("resolves to the country place covering the browser's reported coordinates", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return nearbyResponse({
        standard: [
          { id: 97391, name: "Europe", admin_level: -10 },
          { id: 6857, name: "United Kingdom", admin_level: 0 }
        ]
      });
    };

    const place = await resolveUserPlace({ geolocationImpl: fakeGeolocation(), fetchImpl });

    assert.deepEqual(place, { placeId: 6857, countryName: "United Kingdom", source: "geolocation" });
    assert.match(calls[0], /^https:\/\/api\.inaturalist\.org\/v1\/places\/nearby\?/);
    const params = new URL(calls[0]).searchParams;
    assert.equal(params.get("swlat"), "51.3");
    assert.equal(params.get("nelat"), "51.7");
    assert.equal(params.get("swlng"), "-0.32");
    assert.equal(params.get("nelng"), "0.08000000000000002");
  });

  it("falls back to community places when no standard place covers the point", async () => {
    const fetchImpl = async () => nearbyResponse({ community: [{ id: 12345, name: "Some Country", admin_level: 0 }] });

    const place = await resolveUserPlace({ geolocationImpl: fakeGeolocation(), fetchImpl });

    assert.deepEqual(place, { placeId: 12345, countryName: "Some Country", source: "geolocation" });
  });

  it("falls back to the UK when geolocation is unsupported", async () => {
    const place = await resolveUserPlace({ geolocationImpl: undefined, fetchImpl: async () => nearbyResponse() });
    assert.deepEqual(place, { placeId: DEFAULT_PLACE_ID, countryName: "United Kingdom", source: "unsupported" });
  });

  it("falls back to the UK when the user denies the permission prompt", async () => {
    const geolocationImpl = fakeGeolocation({ error: { code: 1, message: "User denied Geolocation" } });
    const place = await resolveUserPlace({ geolocationImpl, fetchImpl: async () => nearbyResponse() });
    assert.deepEqual(place, { placeId: DEFAULT_PLACE_ID, countryName: "United Kingdom", source: "denied" });
  });

  it("falls back to the UK when the device can't get a position in time", async () => {
    const geolocationImpl = fakeGeolocation({ error: { code: 3, message: "Timeout expired" } });
    const place = await resolveUserPlace({ geolocationImpl, fetchImpl: async () => nearbyResponse() });
    assert.deepEqual(place, { placeId: DEFAULT_PLACE_ID, countryName: "United Kingdom", source: "unavailable" });
  });

  it("falls back to the UK when places/nearby itself fails", async () => {
    const place = await resolveUserPlace({
      geolocationImpl: fakeGeolocation(),
      fetchImpl: async () => jsonResponse({}, { status: 500 })
    });
    assert.deepEqual(place, { placeId: DEFAULT_PLACE_ID, countryName: "United Kingdom", source: "lookup-failed" });
  });

  it("falls back to the UK when no place in the response is a country (admin_level 0)", async () => {
    const place = await resolveUserPlace({
      geolocationImpl: fakeGeolocation(),
      fetchImpl: async () => nearbyResponse({ standard: [{ id: 97391, name: "Europe", admin_level: -10 }] })
    });
    assert.deepEqual(place, { placeId: DEFAULT_PLACE_ID, countryName: "United Kingdom", source: "lookup-failed" });
  });
});
