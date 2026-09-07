// Phase 3 proof: a development-only direct iNaturalist client feeding the
// same ObservationQueue/MothStore/animation-engine pipeline Phase 2 already
// proved against recorded fixtures. This page makes real network requests to
// https://api.inaturalist.org — it is not part of the deployed production
// site (see .github/workflows/pages.yml, and the warning on the page itself)
// and exists only to demonstrate and exercise inat_website.txt's Phase 3
// exit criteria: new records appear without refreshing, records are not
// replayed after every poll, offline/429 handling recovers automatically,
// and the frontend stays usable while the API is unavailable.
import { setConfig } from "./config-store.js";
import { drawScene } from "./animation-engine.js";
import { ObservationQueue } from "./observation-queue.js";
import { MothStore } from "./moth-store.js";
import { InatClient } from "./inaturalist-client.js";
import { resolveUserPlace } from "./geolocation.js";

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Human-readable line for the status readout, distinguishing an actually
// resolved location from every fallback reason so a visitor (or a developer
// watching this page) can tell why they're seeing UK records instead of
// their own.
function formatLocationSummary(place) {
  if (place.source === "geolocation") {
    return `location: ${place.countryName} (from your browser's location)`;
  }

  const fallbackReasons = {
    unsupported: "geolocation isn't supported here",
    denied: "location permission was denied",
    unavailable: "location unavailable",
    "lookup-failed": "couldn't resolve a country for your location"
  };
  const reason = fallbackReasons[place.source] || "location unavailable";
  return `location: ${place.countryName} (default — ${reason})`;
}

async function main() {
  const configResponse = await fetch("config/site-config.json");
  if (!configResponse.ok) {
    throw new Error(`Failed to load config/site-config.json: ${configResponse.status}`);
  }
  setConfig(await configResponse.json());

  const canvas = document.getElementById("orbit-canvas");
  const context = canvas.getContext("2d");
  const statusElement = document.getElementById("demo-status");

  if (statusElement) {
    statusElement.textContent = "finding your location…";
  }
  const place = await resolveUserPlace();
  const locationSummary = formatLocationSummary(place);

  const queue = new ObservationQueue({ storage: getStorage(), storageKey: "inat-moth-lights:live-demo-queue" });
  const store = new MothStore();

  let connectionState = "starting";
  let lastFetchSummary = "waiting for the first response…";

  const client = new InatClient({
    placeId: place.placeId,
    getCursor: () => queue.cursor || null,
    onStateChange: (state) => {
      connectionState = state;
    },
    onBatch: (payload) => {
      // InatClient already delivers validated, contract-shaped observations
      // here regardless of upstreamShape — re-parsing them would assume the
      // raw pre-normalization shape and silently drop every record.
      const added = queue.enqueue(payload.observations, payload.cursor);
      lastFetchSummary = `+${added} new of ${payload.observations.length} in this page`;
    }
  });

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * scale));
    canvas.height = Math.max(1, Math.floor(rect.height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function tick(timestampMs) {
    const nowSeconds = timestampMs / 1000;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    const due = queue.peekDue(nowSeconds);
    due.forEach((observation) => {
      if (store.addObservation(observation, nowSeconds, width, height)) {
        queue.acknowledge(observation.id, nowSeconds);
      }
    });

    store.removeExpired(nowSeconds);
    drawScene(context, store.getActiveMoths(), width, height, timestampMs, nowSeconds);

    if (statusElement) {
      const stats = client.getStats();
      statusElement.textContent = [
        locationSummary,
        `connection: ${connectionState}`,
        `active moths: ${store.activeCount}`,
        `queue pending: ${queue.pendingCount}`,
        `requests so far: ${stats.requestCount}`,
        // Phase 0 measured ~25-41 new Lepidoptera observations/minute
        // globally (research/phase-0-measurements.json) — compare against
        // that here rather than assuming the same rate holds.
        `observed rate: ${stats.observationsPerMinute.toFixed(1)}/min (Phase 0 measured ~25-41/min)`,
        lastFetchSummary
      ].join("\n");
    }

    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  client.start();
  requestAnimationFrame(tick);
}

main();
