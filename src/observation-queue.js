// Decouples API/fixture bursts from the calm visual entry cadence.
//
// Responsibilities (see inat_website.txt section 6.4):
// - deduplicate by observation ID against a bounded recently-seen window;
// - sort newly queued records deterministically (oldest createdAt first);
// - release observations paced by their source createdAt gaps, scaled and
//   deterministically jittered, clamped to a configured interval range;
// - cap how many overdue observations are released in a single call so a
//   backlog (a pause, a large upload batch) catches up gradually instead of
//   dumping everything into one frame;
// - keep the oldest observations and drop newer ones first when the pending
//   queue itself overflows;
// - persist the cursor and seen-ID window so a page refresh does not replay
//   the same batch, recovering safely if storage is unavailable or corrupt.
import { hashString, seededUnit } from "./animation-engine.js";

const DEFAULT_OPTIONS = {
  seenIdCapacity: 2000,
  maxQueuedObservations: 500,
  minReleaseIntervalSeconds: 0.75,
  maxReleaseIntervalSeconds: 30,
  releaseJitterMin: 0.65,
  releaseJitterMax: 1.35,
  sourceTimeScale: 1,
  maxCatchUpObservations: 50,
  storage: null,
  storageKey: "inat-moth-lights:observation-queue"
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deterministicJitter(id, min, max) {
  return min + seededUnit(hashString(id), 17) * (max - min);
}

export class ObservationQueue {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.pending = [];
    this.seenIds = new Set();
    this.seenIdOrder = [];
    this.cursor = "";
    this.lastReleasedAtSeconds = null;
    this.lastReleasedCreatedAtMs = null;

    this.loadState();
  }

  get pendingCount() {
    return this.pending.length;
  }

  _markSeen(id) {
    if (this.seenIds.has(id)) {
      return;
    }
    this.seenIds.add(id);
    this.seenIdOrder.push(id);
    while (this.seenIdOrder.length > this.options.seenIdCapacity) {
      const evicted = this.seenIdOrder.shift();
      this.seenIds.delete(evicted);
    }
  }

  // Adds a batch of already-normalized observations (see
  // observation-adapter.js). Duplicates (already seen, or already pending)
  // are dropped. Returns the number of observations actually enqueued.
  enqueue(observations, cursor = null) {
    let added = 0;

    observations.forEach((observation) => {
      if (this.seenIds.has(observation.id)) {
        return;
      }
      if (this.pending.some((pendingObservation) => pendingObservation.id === observation.id)) {
        return;
      }

      this.pending.push(observation);
      this._markSeen(observation.id);
      added += 1;
    });

    this.pending.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));

    if (this.pending.length > this.options.maxQueuedObservations) {
      // Keep the oldest (soonest-due) observations; drop the newest excess
      // rather than favoring any one species or location.
      this.pending.length = this.options.maxQueuedObservations;
    }

    if (cursor) {
      this.cursor = cursor;
    }

    this.saveState();
    return added;
  }

  // Returns the observations that are due to be released by nowSeconds (a
  // monotonic clock such as performance.now() / 1000), without removing them
  // from the queue yet. At most maxCatchUpObservations are returned per call
  // so a large backlog is paced out over several calls instead of releasing
  // all at once. Call acknowledge(id) for each one actually admitted by the
  // caller (e.g. once MothStore has room for it); un-acknowledged items stay
  // pending and are reconsidered on the next call.
  peekDue(nowSeconds) {
    const due = [];
    let cursorAtSeconds = this.lastReleasedAtSeconds;
    let cursorCreatedAtMs = this.lastReleasedCreatedAtMs;

    for (const observation of this.pending) {
      if (due.length >= this.options.maxCatchUpObservations) {
        break;
      }

      let dueAtSeconds;
      if (cursorAtSeconds === null || cursorCreatedAtMs === null) {
        dueAtSeconds = nowSeconds;
      } else {
        const sourceGapSeconds = Math.max(
          0,
          ((observation.createdAtMs - cursorCreatedAtMs) / 1000) * this.options.sourceTimeScale
        );
        const jitter = deterministicJitter(
          observation.id,
          this.options.releaseJitterMin,
          this.options.releaseJitterMax
        );
        const gapSeconds = clamp(
          sourceGapSeconds * jitter,
          this.options.minReleaseIntervalSeconds,
          this.options.maxReleaseIntervalSeconds
        );
        dueAtSeconds = cursorAtSeconds + gapSeconds;
      }

      if (dueAtSeconds > nowSeconds) {
        break;
      }

      due.push(observation);
      cursorAtSeconds = dueAtSeconds;
      cursorCreatedAtMs = observation.createdAtMs;
    }

    return due;
  }

  // Removes a released observation from the pending queue and advances the
  // pacing cursor. Call this once the observation has actually been admitted
  // (e.g. handed to MothStore) so a rejected observation (scene full) is
  // retried instead of silently lost.
  acknowledge(id, nowSeconds) {
    const index = this.pending.findIndex((observation) => observation.id === id);
    if (index === -1) {
      return;
    }

    const [observation] = this.pending.splice(index, 1);
    this.lastReleasedAtSeconds = nowSeconds;
    this.lastReleasedCreatedAtMs = observation.createdAtMs;
    this.saveState();
  }

  saveState() {
    const storage = this.options.storage;
    if (!storage) {
      return;
    }

    try {
      storage.setItem(
        this.options.storageKey,
        JSON.stringify({ cursor: this.cursor, seenIds: this.seenIdOrder })
      );
    } catch {
      // Storage unavailable (quota, privacy mode, etc.) — persistence is a
      // nice-to-have, never a hard requirement.
    }
  }

  loadState() {
    const storage = this.options.storage;
    if (!storage) {
      return;
    }

    try {
      const raw = storage.getItem(this.options.storageKey);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      if (typeof parsed.cursor === "string") {
        this.cursor = parsed.cursor;
      }
      if (Array.isArray(parsed.seenIds)) {
        parsed.seenIds.forEach((id) => {
          if (typeof id === "string") {
            this._markSeen(id);
          }
        });
      }
    } catch {
      // Corrupt or unreadable storage: start from an empty, valid state
      // rather than throwing.
      this.seenIds = new Set();
      this.seenIdOrder = [];
      this.cursor = "";
    }
  }
}
