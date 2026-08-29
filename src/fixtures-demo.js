// Phase 2 proof: recorded fixtures flowing through ObservationQueue and
// MothStore into the unmodified animation-engine renderer. This is a
// deliberately minimal page (no launch screen, audio, hover cards or
// timeline — that polish is Phase 5) whose only job is to demonstrate the
// exit criteria from inat_website.txt's Phase 2 section: fixture
// observations enter, orbit and exit continuously; unknown/coarse taxa and
// missing fields never break rendering; active-moth and queue sizes stay
// bounded over a long soak instead of growing without limit.
//
// There is still no live iNaturalist API call anywhere in this file — it
// only ever reads the three fixtures/observations-*.json files already
// committed for Phase 0.
import { setConfig } from "./config-store.js";
import { drawScene } from "./animation-engine.js";
import { parseObservationsResponse } from "./observation-adapter.js";
import { ObservationQueue } from "./observation-queue.js";
import { MothStore } from "./moth-store.js";

const FIXTURE_SEQUENCE = ["observations-page-1.json", "observations-empty.json", "observations-error.json"];
// Real production polling is once a minute (see config/phase-0-decisions.json);
// this demo polls much faster purely so the "continuous" and "bounded over a
// long soak" exit criteria are observable in minutes rather than hours.
const FIXTURE_POLL_INTERVAL_MS = 20000;

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
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

  const queue = new ObservationQueue({ storage: getStorage() });
  const store = new MothStore();

  let fixtureIndex = 0;
  let fixtureCycle = 0;
  let lastFetchSummary = "loading…";

  async function pollNextFixture() {
    const name = FIXTURE_SEQUENCE[fixtureIndex % FIXTURE_SEQUENCE.length];
    fixtureIndex += 1;
    if (fixtureIndex % FIXTURE_SEQUENCE.length === 0) {
      fixtureCycle += 1;
    }

    try {
      const response = await fetch(`fixtures/${name}`);
      const payload = await response.json();
      const parsed = parseObservationsResponse(payload);

      // Demo-only: a recorded fixture is finite, but a live feed isn't. On
      // every replay after the first, relabel ids and shift createdAt
      // forward so the same handful of recorded observations can stand in
      // for a continuous, never-repeating stream.
      const observations = fixtureCycle === 0
        ? parsed.observations
        : parsed.observations.map((observation) => ({
          ...observation,
          id: `${observation.id}-cycle-${fixtureCycle}`,
          createdAtMs: observation.createdAtMs + fixtureCycle * 60000
        }));

      const added = queue.enqueue(observations, parsed.cursor);
      lastFetchSummary = parsed.error
        ? `fetch ${name}: upstream error (${parsed.error}), showing stale data`
        : `fetch ${name}: +${added} new of ${observations.length}`;
    } catch (error) {
      lastFetchSummary = `fetch ${name} failed: ${error.message}`;
    }

    window.setTimeout(pollNextFixture, FIXTURE_POLL_INTERVAL_MS);
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * scale));
    canvas.height = Math.max(1, Math.floor(rect.height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  let rejectedThisSecond = 0;

  function tick(timestampMs) {
    const nowSeconds = timestampMs / 1000;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    const due = queue.peekDue(nowSeconds);
    rejectedThisSecond = 0;
    due.forEach((observation) => {
      const admitted = store.addObservation(observation, nowSeconds, width, height);
      if (admitted) {
        queue.acknowledge(observation.id, nowSeconds);
      } else {
        rejectedThisSecond += 1;
      }
    });

    store.removeExpired(nowSeconds);
    drawScene(context, store.getActiveMoths(), width, height, timestampMs, nowSeconds);

    if (statusElement) {
      statusElement.textContent = [
        `active moths: ${store.activeCount}`,
        `queue pending: ${queue.pendingCount}${rejectedThisSecond > 0 ? ` (${rejectedThisSecond} waiting for room)` : ""}`,
        `fixture cycle: ${fixtureCycle}`,
        lastFetchSummary
      ].join("\n");
    }

    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  pollNextFixture();
  requestAnimationFrame(tick);
}

main();
