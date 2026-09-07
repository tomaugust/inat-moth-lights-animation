// Resolves the visitor's browser geolocation to an iNaturalist place_id (see
// inaturalist-client.js's DEFAULT_PLACE_ID / buildQueryUrl) so the
// observations feed can be scoped to the visitor's own country instead of a
// fixed default. Every failure mode — geolocation unsupported, the permission
// prompt denied or ignored, a slow/unavailable device fix, or the
// places/nearby lookup itself failing — falls back to DEFAULT_PLACE_ID
// (United Kingdom) rather than leaving the caller without a place to query.
// resolveUserPlace() never rejects.
import { DEFAULT_PLACE_ID } from "./inaturalist-client.js";

const FALLBACK_COUNTRY_NAME = "United Kingdom";
const NEARBY_API_BASE = "https://api.inaturalist.org/v1/places/nearby";
// GET /places/nearby takes a bounding box, not a point, and returns whatever
// "standard" (curator-approved) and "community" places intersect it — there
// is no direct point-in-polygon lookup in the public API. This box is small
// enough (roughly 40km across) that it should only ever intersect the
// country the point is actually in, plus that country's own admin_level -10
// continent entry, while still comfortably containing the GPS/Wi-Fi fix's
// typical error margin.
const NEARBY_BOX_DEGREES = 0.2;
const COUNTRY_ADMIN_LEVEL = 0;

function getCurrentPosition(geolocationImpl, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!geolocationImpl || typeof geolocationImpl.getCurrentPosition !== "function") {
      reject(new Error("geolocation-unsupported"));
      return;
    }

    geolocationImpl.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: timeoutMs,
      maximumAge: 10 * 60 * 1000
    });
  });
}

function findCountryPlace(payload) {
  const results = (payload && payload.results) || {};
  const standard = Array.isArray(results.standard) ? results.standard : [];
  const community = Array.isArray(results.community) ? results.community : [];
  // Prefer a curator-approved ("standard") match; only fall through to a
  // community-maintained place if no standard one covers this point.
  return (
    standard.find((place) => place.admin_level === COUNTRY_ADMIN_LEVEL) ||
    community.find((place) => place.admin_level === COUNTRY_ADMIN_LEVEL) ||
    null
  );
}

async function resolveCountryFromCoordinates(latitude, longitude, fetchImpl) {
  const params = new URLSearchParams({
    swlat: String(latitude - NEARBY_BOX_DEGREES),
    swlng: String(longitude - NEARBY_BOX_DEGREES),
    nelat: String(latitude + NEARBY_BOX_DEGREES),
    nelng: String(longitude + NEARBY_BOX_DEGREES)
  });

  const response = await fetchImpl(`${NEARBY_API_BASE}?${params.toString()}`, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`places/nearby responded ${response.status}`);
  }

  const country = findCountryPlace(await response.json());
  if (!country) {
    throw new Error("no-country-place-found");
  }

  return {
    placeId: country.id,
    countryName: country.name || country.display_name || FALLBACK_COUNTRY_NAME,
    source: "geolocation"
  };
}

function fallbackPlace(source) {
  return { placeId: DEFAULT_PLACE_ID, countryName: FALLBACK_COUNTRY_NAME, source };
}

// Standard GeolocationPositionError codes: 1 PERMISSION_DENIED, 2
// POSITION_UNAVAILABLE, 3 TIMEOUT.
function fallbackSourceForPositionError(error) {
  return error && error.code === 1 ? "denied" : "unavailable";
}

// Resolves to { placeId, countryName, source }. source is "geolocation" only
// when a real position was obtained AND resolved to a country; otherwise one
// of "unsupported" | "denied" | "unavailable" | "lookup-failed", all of which
// carry the same UK fallback place.
export async function resolveUserPlace(options = {}) {
  const {
    geolocationImpl = typeof navigator !== "undefined" ? navigator.geolocation : undefined,
    fetchImpl = typeof fetch === "function" ? fetch.bind(globalThis) : undefined,
    timeoutMs = 8000
  } = options;

  if (!geolocationImpl) {
    return fallbackPlace("unsupported");
  }

  let position;
  try {
    position = await getCurrentPosition(geolocationImpl, timeoutMs);
  } catch (error) {
    return fallbackPlace(fallbackSourceForPositionError(error));
  }

  try {
    return await resolveCountryFromCoordinates(position.coords.latitude, position.coords.longitude, fetchImpl);
  } catch {
    return fallbackPlace("lookup-failed");
  }
}

export { FALLBACK_COUNTRY_NAME };
