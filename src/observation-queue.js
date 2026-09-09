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
// - when the pending queue holds more than a comfortably displayable amount,
//   thin it down with a species-diversity-aware sample rather than a plain
//   oldest-first truncation (see selectDiverseSample below) — an abundant
//   window's raw volume can vastly exceed what MothStore can ever display,
//   and simply keeping the oldest N would let one common species crowd out
//   everything else;
// - persist the cursor and seen-ID window so a page refresh does not replay
//   the same batch, recovering safely if storage is unavailable or corrupt.
import { hashString, seededUnit } from "./animation-engine.js";

// A taxon id alone isn't enough for a meaningful diversity bucket: iNaturalist
// observations are routinely identified only to genus, family or coarser.
// Mirrors moth-store.js's own isIdentifiedToSpecies — anything short of
// species level is bucketed together as "unknown", the same generic group
// MothStore itself already treats those observations as.
function speciesBucketKey(observation) {
  return observation.taxonId !== null && observation.taxonRank === "species"
    ? `taxon-${observation.taxonId}`
    : "unknown";
}

// Thins a chronologically-sorted list down to targetSize by round-robining
// one observation per distinct species per pass, so a sample of an abundant
// window represents as many different species as are actually available
// rather than however many of whichever species happened to be uploaded
// most that day. Each species' own observations stay in their original
// (chronological) relative order; the final result is re-sorted
// chronologically since round-robining interleaves species arrival order.
// A no-op (returns the input as-is) whenever there's nothing to thin.
export function selectDiverseSample(observations, targetSize) {
  if (observations.length <= targetSize) {
    return observations;
  }

  const buckets = new Map();
  observations.forEach((observation) => {
    const key = speciesBucketKey(observation);
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(observation);
  });

  const bucketArrays = [...buckets.values()];
  const selected = [];
  for (let round = 0; selected.length < targetSize; round += 1) {
    const before = selected.length;
    for (const bucket of bucketArrays) {
      if (selected.length >= targetSize) {
        break;
      }
      if (bucket[round]) {
        selected.push(bucket[round]);
      }
    }
    if (selected.length === before) {
      break; // every bucket exhausted
    }
  }

  return selected.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
}

// Compresses the ~24h created_at span the Worker now fetches in full (see
// fetchAllObservationsInWindow in inaturalist-client.js) into about one
// minute of animation time: a real day plays out as a one-minute time-lapse
// rather than at 1:1 real-time pace, which at today's ~1,300-1,400
// records/24h would otherwise take the better part of a day to fully drain.
// 1/1440 = 60 animation-seconds / 86400 real-seconds-per-day.
export const DEFAULT_SOURCE_TIME_SCALE = 1 / 1440;

const DEFAULT_OPTIONS = {
  seenIdCapacity: 2000,
  // Sized against moth-store.js's maxActiveMoths (10) and its 8-20s duration
  // range (avg 14s): sustainable throughput is roughly maxActiveMoths /
  // averageDurationSeconds ≈ 0.71/s, so a comfortable ~60s cycle drains
  // about 43 observations — 45 keeps a small, deliberate buffer rather than
  // ever running the display dry. Must be updated together with those two
  // moth-store.js values if either changes, or an abundant window's backlog
  // will again take far longer than the intended cycle time to fully drain.
  targetSampleSize: 45,
  // Absolute floor/ceiling on the *compressed* gap, after sourceTimeScale
  // and jitter are applied. These must scale down together with
  // DEFAULT_SOURCE_TIME_SCALE — the previous 1:1-real-time defaults (0.75s
  // floor, 30s ceiling) were sized for un-scaled real-time gaps; left as-is
  // they would swallow almost every compressed gap into the 0.75s floor
  // (a typical real ~30s gap compresses to ~0.02s) and stretch a nominal
  // one-minute replay back out to 15-20+ minutes, defeating the scale-down
  // above entirely.
  minReleaseIntervalSeconds: 0.05,
  maxReleaseIntervalSeconds: 3,
  releaseJitterMin: 0.65,
  releaseJitterMax: 1.35,
  sourceTimeScale: DEFAULT_SOURCE_TIME_SCALE,
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
    this.pending = selectDiverseSample(this.pending, this.options.targetSampleSize);

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
