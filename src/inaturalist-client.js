// Direct iNaturalist client. Talks to the v2 observations endpoint straight
// from the browser (the API allows cross-origin reads) and hands normalized
// batches to a caller-supplied onBatch(), which feeds them to the queue. This
// file only fetches and maps; it never touches the queue, store or renderer
// directly, so data acquisition and rendering stay independent.
//
// A known, accepted limitation: a browser fetch() cannot set a custom
// User-Agent header (browsers silently strip it), so this can never send the
// descriptive User-Agent iNaturalist's API etiquette asks for. Every visitor
// also queries iNaturalist independently, in exchange for needing no server.
import { parseObservationsResponse } from "./observation-adapter.js";

const API_BASE = "https://api.inaturalist.org/v2/observations";

const FIELDS =
  "(id:!t,uuid:!t,created_at:!t,uri:!t,quality_grade:!t," +
  "place_guess:!t,location:!t,taxon:(id:!t,rank:!t,name:!t,preferred_common_name:!t)," +
  "photos:(id:!t,url:!t,attribution:!t,license_code:!t))";

const DEFAULT_PHOTO_LICENSES = ["cc0", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa", "cc-by-nd", "cc-by-nc-nd"];

export const CONNECTION_STATES = Object.freeze({
  STARTING: "starting",
  LIVE: "live",
  QUIET: "quiet",
  STALE: "stale",
  OFFLINE: "offline",
  RATE_LIMITED: "rate-limited",
  FATAL_SCHEMA_ERROR: "fatal-schema-error"
});

// iNaturalist taxon id for Papilionoidea (superfamily "Butterflies"),
// confirmed against GET /v1/taxa?q=Papilionoidea&rank=superfamily — its
// preferred_common_name is literally "Butterflies", and it's a *child* of
// Lepidoptera (parent_id 47157, this file's taxonId), not a sibling, so
// excluding it removes only true butterflies and skippers. Skippers
// (Hesperiidae) are commonly mistaken for a separate group, but iNaturalist's
// current taxonomy nests them under this same superfamily (parent_id 47224 —
// confirmed via GET /v1/taxa?q=Hesperiidae&rank=family), so this one id is
// enough to exclude both without a second, harder-to-maintain family list.
// The feed is therefore moths only.
export const DEFAULT_WITHOUT_TAXON_ID = 47224;

// Every query this client builds MUST be bounded to
// a recent window — never "however far back per_page=200 happens to reach,"
// which drifts with upload volume and, worse, asks iNaturalist to sort
// through its full history on every single poll instead of a recent slice.
// created_d1 (lower bound on created_at) is the mechanism. This is
// intentionally a hardcoded default that is always applied, so it can never
// be left blank and silently reintroduce an unbounded query.
export const DEFAULT_LOOKBACK_HOURS = 24;

const DEFAULT_OPTIONS = {
  taxonId: 47157,
  withoutTaxonId: DEFAULT_WITHOUT_TAXON_ID,
  lookbackHours: DEFAULT_LOOKBACK_HOURS,
  // When set (minutes), the very first request — the one with no cursor yet —
  // only asks for uploads from this recent a window, instead of the full
  // lookbackHours. Every later request continues from the cursor (id_above),
  // so it only ever returns what's new, and keeps the wider lookbackHours as
  // its hard bound. A live feed wants this: the newest ~200 records of a
  // 24-hour window can be half an hour old, which then plays back as a
  // permanent lag behind "now".
  initialLookbackMinutes: null,
  photoLicenses: DEFAULT_PHOTO_LICENSES,
  pageSize: 200,
  pollIntervalSeconds: 60,
  requestTimeoutSeconds: 15,
  maxBackoffSeconds: 900,
  getCursor: () => null,
  onBatch: () => {},
  onStateChange: () => {}
};

// Rewrites the size token to medium.<ext>: v2 currently returns a square-sized url even when medium_url is requested.
function toMediumPhotoUrl(url) {
  if (!url) {
    return "";
  }
  return url.replace(/\/(square|thumb|small|medium|large|original)\.([A-Za-z0-9]+)$/, "/medium.$2");
}

// The v2 API's "location" field is a plain "lat,lon" string (confirmed
// against a live response — not documented alongside the structured
// "geojson" field it sits next to, which was the other candidate). Returns
// {lat, lon} or null — a small, real minority of observations have no
// location at all (obscured/private, or simply never set).
function parseLocation(raw) {
  if (!raw || typeof raw.location !== "string") {
    return null;
  }
  const parts = raw.location.split(",");
  if (parts.length !== 2) {
    return null;
  }
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

// Maps one raw v2 API result into the same project-owned contract shape
// observation-adapter.js already validates — this file never invents its
// own record shape.
export function mapRawObservationToContract(raw) {
  const taxon = raw && raw.taxon ? raw.taxon : null;
  const photo = raw && Array.isArray(raw.photos) ? raw.photos[0] : null;
  const location = parseLocation(raw);

  return {
    id: raw && raw.id != null ? `inat-${raw.id}` : "",
    taxonId: taxon ? taxon.id : null,
    scientificName: taxon ? taxon.name : "",
    // An observation identified only to order level (i.e. just "Lepidoptera")
    // has a preferred_common_name of literally "Butterflies and Moths" — true
    // of the order as a whole, but a confusing, generic thing to show as one
    // moth's name once the whole site's scope is moths only. Every finer rank
    // (genus, family, superfamily, ...) still has its own real, specific
    // common name, so this only needs to special-case "order" itself.
    commonName: taxon && taxon.rank !== "order" ? taxon.preferred_common_name : "",
    taxonRank: taxon ? taxon.rank : "",
    createdAt: raw ? raw.created_at : null,
    place: raw ? raw.place_guess : "",
    qualityGrade: raw ? raw.quality_grade : "",
    imageUrl: photo ? toMediumPhotoUrl(photo.url) : "",
    imageAttribution: photo ? photo.attribution : "",
    imageLicense: photo ? photo.license_code : "",
    observationUrl: raw ? raw.uri : "",
    lat: location ? location.lat : null,
    lon: location ? location.lon : null
  };
}

function setSharedParams(params, options, lookbackMsOverride = null) {
  params.set("taxon_id", String(options.taxonId));
  // Excludes butterflies (see DEFAULT_WITHOUT_TAXON_ID) so the feed is moths
  // only. Conditional (unlike taxon_id above) so a caller can still pass
  // withoutTaxonId: null/0 to opt back to the full Lepidoptera order, e.g. a
  // future test or a diagnostic query, without a magic "0 means unset" value
  // silently reaching the real API as without_taxon_id=0.
  if (options.withoutTaxonId) {
    params.set("without_taxon_id", String(options.withoutTaxonId));
  }
  // Unconditional and defensively defaulted (never skipped, never disabled
  // by a falsy/zero/missing option) — see DEFAULT_LOOKBACK_HOURS above.
  const lookbackHours = Number(options.lookbackHours) > 0 ? Number(options.lookbackHours) : DEFAULT_LOOKBACK_HOURS;
  const lookbackMs = lookbackMsOverride !== null ? lookbackMsOverride : lookbackHours * 60 * 60 * 1000;
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  params.set("created_d1", new Date(nowMs - lookbackMs).toISOString());
  params.set("photos", "true");
  params.set("photo_license", options.photoLicenses.join(","));
  params.set("per_page", String(options.pageSize));
  params.set("fields", FIELDS);
}

export function buildQueryUrl(options, cursor) {
  const params = new URLSearchParams();
  const initialLookbackMinutes = Number(options.initialLookbackMinutes);
  const useInitialLookback = !cursor && initialLookbackMinutes > 0;
  setSharedParams(params, options, useInitialLookback ? initialLookbackMinutes * 60 * 1000 : null);

  if (cursor) {
    params.set("id_above", String(cursor));
    params.set("order_by", "id");
    params.set("order", "asc");
  } else {
    params.set("order_by", "created_at");
    params.set("order", "desc");
  }

  return `${API_BASE}?${params.toString()}`;
}

export class InatClient {
  constructor(options = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      fetchImpl: typeof fetch === "function" ? fetch.bind(globalThis) : undefined,
      now: () => Date.now(),
      setTimeoutImpl: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeoutImpl: (handle) => clearTimeout(handle),
      ...options
    };

    this.state = CONNECTION_STATES.STARTING;
    this.isRunning = false;
    this.isPolling = false;
    this.backoffSeconds = 0;
    this.timeoutHandle = null;
    this.stats = { requestCount: 0, observationsReceived: 0, startedAtMs: null };
    // Why the most recent poll failed, or null after a success. A bare
    // connection state can't distinguish an HTTP error status from a CORS
    // rejection from a blocked/failed network request — they all land on
    // "stale" — which is exactly the distinction needed to debug a failure
    // that only reproduces on someone else's real device.
    this.lastError = null;

    this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
    this._handleOnline = this._handleOnline.bind(this);
    this._handleOffline = this._handleOffline.bind(this);
  }

  start() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.stats.startedAtMs = this.options.now();
    this._setState(CONNECTION_STATES.STARTING);

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this._handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this._handleOnline);
      window.addEventListener("offline", this._handleOffline);
    }

    this._pollNow();
  }

  stop() {
    this.isRunning = false;
    if (this.timeoutHandle !== null) {
      this.options.clearTimeoutImpl(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this._handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this._handleOnline);
      window.removeEventListener("offline", this._handleOffline);
    }
  }

  getStats() {
    const elapsedMinutes = this.stats.startedAtMs === null
      ? 0
      : Math.max(1 / 60, (this.options.now() - this.stats.startedAtMs) / 60000);

    return {
      requestCount: this.stats.requestCount,
      observationsReceived: this.stats.observationsReceived,
      observationsPerMinute: elapsedMinutes > 0 ? this.stats.observationsReceived / elapsedMinutes : 0
    };
  }

  _setState(state) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.options.onStateChange(state);
  }

  _scheduleNext(delaySeconds) {
    if (!this.isRunning) {
      return;
    }
    this.timeoutHandle = this.options.setTimeoutImpl(() => this._pollNow(), Math.max(0, delaySeconds) * 1000);
  }

  _handleVisibilityChange() {
    if (!this.isRunning || typeof document === "undefined" || document.visibilityState !== "visible") {
      return;
    }
    // A tab regaining focus should not stomp on an active rate-limit/error
    // backoff — that would hammer a server that just told us to slow down.
    // Only short-circuit the wait when we're on the normal poll interval.
    if (this.state === CONNECTION_STATES.RATE_LIMITED || this.state === CONNECTION_STATES.STALE) {
      return;
    }
    if (this.timeoutHandle !== null) {
      this.options.clearTimeoutImpl(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this._pollNow();
  }

  _handleOffline() {
    this._setState(CONNECTION_STATES.OFFLINE);
    if (this.timeoutHandle !== null) {
      this.options.clearTimeoutImpl(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
  }

  _handleOnline() {
    if (this.isRunning) {
      this._pollNow();
    }
  }

  _advanceBackoff(explicitSeconds) {
    if (explicitSeconds !== null) {
      this.backoffSeconds = Math.min(this.options.maxBackoffSeconds, explicitSeconds);
    } else {
      const base = this.backoffSeconds > 0 ? this.backoffSeconds * 2 : this.options.pollIntervalSeconds;
      const jitter = 0.75 + Math.random() * 0.5;
      this.backoffSeconds = Math.min(this.options.maxBackoffSeconds, base * jitter);
    }
    this._scheduleNext(this.backoffSeconds);
  }

  async _pollNow() {
    if (this.isPolling || !this.isRunning) {
      return;
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Stop polling entirely and wait for the browser's 'online' event
      // instead of guessing when connectivity might return.
      this._setState(CONNECTION_STATES.OFFLINE);
      return;
    }

    this.isPolling = true;
    this.stats.requestCount += 1;

    const cursor = this.options.getCursor();
    const url = buildQueryUrl(this.options, cursor);
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    this.currentAbortController = controller;
    const timeoutHandle = controller
      ? this.options.setTimeoutImpl(() => controller.abort(), this.options.requestTimeoutSeconds * 1000)
      : null;

    try {
      const response = await this.options.fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: controller ? controller.signal : undefined
      });

      if (response.status === 429) {
        const retryAfter = response.headers && typeof response.headers.get === "function"
          ? Number(response.headers.get("Retry-After"))
          : NaN;
        this.lastError = "http-429";
        this._setState(CONNECTION_STATES.RATE_LIMITED);
        this._advanceBackoff(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
        return;
      }

      if (!response.ok) {
        this.lastError = `http-${response.status}`;
        this._setState(CONNECTION_STATES.STALE);
        this._advanceBackoff(null);
        return;
      }

      const payload = await response.json();
      if (!Array.isArray(payload.results)) {
        this._setState(CONNECTION_STATES.FATAL_SCHEMA_ERROR);
        console.error("iNaturalist client: unexpected response shape, stopping ingestion.", payload);
        this.stop();
        return;
      }
      // Normalize here so onBatch always receives the validated contract
      // shape (see observation-adapter.js's normalizeObservation).
      const mapped = payload.results.map(mapRawObservationToContract);
      const observations = parseObservationsResponse({ observations: mapped }).observations;
      const numericIds = payload.results
        .map((raw) => Number(raw && raw.id))
        .filter((id) => Number.isFinite(id));
      const newCursor = numericIds.length > 0 ? Math.max(Number(cursor) || 0, ...numericIds) : cursor;

      this.stats.observationsReceived += observations.length;
      this.backoffSeconds = 0;
      this.lastError = null;
      this._setState(observations.length > 0 ? CONNECTION_STATES.LIVE : CONNECTION_STATES.QUIET);

      this.options.onBatch({
        fetchedAt: new Date(this.options.now()).toISOString(),
        stale: false,
        cursor: newCursor !== null && newCursor !== undefined ? String(newCursor) : "",
        observations
      });

      this._scheduleNext(this.options.pollIntervalSeconds);
    } catch (error) {
      // A browser reports a CORS rejection, a DNS/network block and a genuine
      // connection failure identically here, as an opaque TypeError — the
      // name/message is still the only signal separating those from an
      // AbortError (our own request timeout firing), so keep it.
      this.lastError = `${error.name}: ${error.message}`;
      // An in-flight fetch that fails because we've since gone offline
      // (_handleOffline aborts it) should leave the client waiting for the
      // 'online' event, not re-arm a backoff timer that fires while still
      // disconnected.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        this._setState(CONNECTION_STATES.OFFLINE);
      } else {
        this._setState(CONNECTION_STATES.STALE);
        this._advanceBackoff(null);
      }
    } finally {
      if (timeoutHandle !== null) {
        this.options.clearTimeoutImpl(timeoutHandle);
      }
      this.currentAbortController = null;
      this.isPolling = false;
    }
  }
}
