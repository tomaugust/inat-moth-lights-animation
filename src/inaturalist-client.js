// Development-only direct iNaturalist client (inat_website.txt section 10,
// Phase 3). Talks to the real v2 observations endpoint straight from the
// browser — the Phase 0 spike confirmed CORS allows this for a prototype —
// and hands normalized batches to a caller-supplied onBatch(), which is
// expected to feed them through observation-adapter.js's
// parseObservationsResponse() exactly like the recorded fixtures did in
// Phase 2. This file only fetches and maps; it never touches the queue,
// store or renderer directly (see 6.2: data acquisition and rendering stay
// independent).
//
// This is explicitly NOT the production architecture. A browser fetch()
// cannot set a custom User-Agent header (browsers silently strip it), so the
// "set a descriptive User-Agent" requirement from section 5.2 can only be
// met once a server-side adapter (Phase 4's Cloudflare Worker) makes the
// request instead of the browser.
import { parseObservationsResponse } from "./observation-adapter.js";

const API_BASE = "https://api.inaturalist.org/v2/observations";

const FIELDS =
  "(id:!t,uuid:!t,created_at:!t,observed_on:!t,time_observed_at:!t,uri:!t,quality_grade:!t," +
  "place_guess:!t,taxon:(id:!t,rank:!t,name:!t,preferred_common_name:!t)," +
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

// iNaturalist place_id for the United Kingdom (admin_level 0), confirmed
// against GET /v1/places/autocomplete?q=United%20Kingdom. Scopes the feed to
// UK records instead of the unfiltered global stream. Exported so
// geolocation.js can fall back to the same place when it can't resolve the
// visitor's own country.
export const DEFAULT_PLACE_ID = 6857;

const DEFAULT_OPTIONS = {
  taxonId: 47157,
  placeId: DEFAULT_PLACE_ID,
  photoLicenses: DEFAULT_PHOTO_LICENSES,
  pageSize: 200,
  pollIntervalSeconds: 60,
  requestTimeoutSeconds: 15,
  maxBackoffSeconds: 900,
  getCursor: () => null,
  onBatch: () => {},
  onStateChange: () => {},
  // How to build the request URL and interpret its response. Defaults to
  // talking directly to the real iNaturalist v2 API (Phase 3). Pass
  // upstreamShape: "adapter-contract" (with a buildUrl pointed at a deployed
  // Phase 4 worker) to talk through the shared cache/adapter instead — its
  // response is already the project-owned contract, not a raw v2 page, so it
  // needs no client-side mapping.
  buildUrl: buildQueryUrl,
  upstreamShape: "inat-v2"
};

// Matches the medium.<ext> rewrite from research/phase-0.md: v2 currently
// returns a square-sized url even when medium_url is requested.
function toMediumPhotoUrl(url) {
  if (!url) {
    return "";
  }
  return url.replace(/\/(square|thumb|small|medium|large|original)\.([A-Za-z0-9]+)$/, "/medium.$2");
}

// Maps one raw v2 API result into the same project-owned contract shape
// observation-adapter.js already validates — this file never invents its
// own record shape.
export function mapRawObservationToContract(raw) {
  const taxon = raw && raw.taxon ? raw.taxon : null;
  const photo = raw && Array.isArray(raw.photos) ? raw.photos[0] : null;

  return {
    id: raw && raw.id != null ? `inat-${raw.id}` : "",
    taxonId: taxon ? taxon.id : null,
    scientificName: taxon ? taxon.name : "",
    commonName: taxon ? taxon.preferred_common_name : "",
    taxonRank: taxon ? taxon.rank : "",
    createdAt: raw ? raw.created_at : null,
    observedAt: raw ? raw.time_observed_at || raw.observed_on : null,
    place: raw ? raw.place_guess : "",
    qualityGrade: raw ? raw.quality_grade : "",
    imageUrl: photo ? toMediumPhotoUrl(photo.url) : "",
    imageAttribution: photo ? photo.attribution : "",
    imageLicense: photo ? photo.license_code : "",
    observationUrl: raw ? raw.uri : ""
  };
}

export function buildQueryUrl(options, cursor) {
  const params = new URLSearchParams();
  params.set("taxon_id", String(options.taxonId));
  // place_id (not a lat/lng bounding box) is the documented way to scope
  // /v1/observations to a place: "Must be observed within the place with
  // this ID" — see GET /v1/observations in the iNaturalist API docs.
  if (options.placeId) {
    params.set("place_id", String(options.placeId));
  }
  params.set("photos", "true");
  params.set("photo_license", options.photoLicenses.join(","));
  params.set("per_page", String(options.pageSize));
  params.set("fields", FIELDS);

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
    const url = this.options.buildUrl(this.options, cursor);
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
        this._setState(CONNECTION_STATES.RATE_LIMITED);
        this._advanceBackoff(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
        return;
      }

      if (!response.ok) {
        this._setState(CONNECTION_STATES.STALE);
        this._advanceBackoff(null);
        return;
      }

      const payload = await response.json();
      let observations;
      let newCursor;

      if (this.options.upstreamShape === "adapter-contract") {
        if (!Array.isArray(payload.observations)) {
          this._setState(CONNECTION_STATES.FATAL_SCHEMA_ERROR);
          console.error("iNaturalist client: unexpected adapter response shape, stopping ingestion.", payload);
          this.stop();
          return;
        }
        observations = payload.observations;
        newCursor = payload.cursor || cursor;
      } else {
        if (!Array.isArray(payload.results)) {
          this._setState(CONNECTION_STATES.FATAL_SCHEMA_ERROR);
          console.error("iNaturalist client: unexpected response shape, stopping ingestion.", payload);
          this.stop();
          return;
        }
        // Normalize here too so onBatch always receives the same validated
        // contract shape adapter-contract mode already delivers — callers
        // must not have to know or care which upstream shape produced a
        // batch (see observation-adapter.js's normalizeObservation).
        const mapped = payload.results.map(mapRawObservationToContract);
        observations = parseObservationsResponse({ observations: mapped }).observations;
        const numericIds = payload.results
          .map((raw) => Number(raw && raw.id))
          .filter((id) => Number.isFinite(id));
        newCursor = numericIds.length > 0 ? Math.max(Number(cursor) || 0, ...numericIds) : cursor;
      }

      this.stats.observationsReceived += observations.length;
      this.backoffSeconds = 0;
      this._setState(observations.length > 0 ? CONNECTION_STATES.LIVE : CONNECTION_STATES.QUIET);

      this.options.onBatch({
        fetchedAt: new Date(this.options.now()).toISOString(),
        stale: false,
        cursor: newCursor !== null && newCursor !== undefined ? String(newCursor) : "",
        observations
      });

      this._scheduleNext(this.options.pollIntervalSeconds);
    } catch {
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
