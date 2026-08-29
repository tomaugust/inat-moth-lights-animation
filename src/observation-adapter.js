// Validates and normalizes the project-owned observation contract (see
// research/phase-0.md and fixtures/observations-*.json) into records the rest
// of the app can trust. Nothing here talks to the network — it only shapes
// whatever payload it is handed (a fixture today, a live adapter response in
// Phase 3+) so that missing or malformed fields never reach the renderer.

function toTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toFiniteTaxonId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toValidTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Returns a normalized observation, or null if the record is unusable (no id,
// or no valid creation time to schedule it by). Every other field degrades to
// a safe default instead of rejecting the record.
export function normalizeObservation(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = toTrimmedString(raw.id);
  if (!id) {
    return null;
  }

  const createdAtMs = toValidTimestamp(raw.createdAt);
  if (createdAtMs === null) {
    return null;
  }

  const observedAtMs = toValidTimestamp(raw.observedAt) ?? createdAtMs;
  const imageUrl = toTrimmedString(raw.imageUrl);
  const imageAttribution = toTrimmedString(raw.imageAttribution);
  const imageLicense = toTrimmedString(raw.imageLicense);

  return {
    id,
    taxonId: toFiniteTaxonId(raw.taxonId),
    scientificName: toTrimmedString(raw.scientificName),
    commonName: toTrimmedString(raw.commonName),
    taxonRank: toTrimmedString(raw.taxonRank),
    createdAtMs,
    observedAtMs,
    place: toTrimmedString(raw.place) || "Unknown location",
    qualityGrade: toTrimmedString(raw.qualityGrade),
    // An observation only "has" a photo once all three fields are present;
    // a URL with no attribution/license is not safe to display.
    imageUrl: imageUrl && imageAttribution && imageLicense ? imageUrl : "",
    imageAttribution: imageUrl && imageAttribution && imageLicense ? imageAttribution : "",
    imageLicense: imageUrl && imageAttribution && imageLicense ? imageLicense : "",
    observationUrl: toTrimmedString(raw.observationUrl)
  };
}

// Validates a whole adapter/fixture response. Never throws: an empty or
// malformed payload just yields no observations.
export function parseObservationsResponse(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const rawObservations = Array.isArray(source.observations) ? source.observations : [];

  return {
    fetchedAt: toTrimmedString(source.fetchedAt),
    stale: source.stale === true,
    cursor: toTrimmedString(source.cursor),
    error: typeof source.error === "string" && source.error ? source.error : null,
    observations: rawObservations
      .map(normalizeObservation)
      .filter((observation) => observation !== null)
  };
}
