// A live, mutable replacement for the old fixed-timeline config.moths array
// (see inat_website.txt section 6.3). Observations are added continuously,
// each gets an independent orbit/entry/exit lifecycle from a monotonic clock
// (pass performance.now() / 1000, not Date.now()), and completed moths are
// dropped so a display left open for days stays bounded. The output shape
// matches what animation-engine.js's createMoths() used to produce, so
// projectMoth()/drawScene() need no changes to consume it.
import { hashString, sampleBiasedApproachAngle, seededUnit } from "./animation-engine.js";
import { getSpeciesStyle } from "./species-style.js";

const DEFAULT_OPTIONS = {
  maxActiveMoths: 50,
  minMothDurationSeconds: 4,
  maxMothDurationSeconds: 10,
  orbitRadiusScale: 0.92,
  // How long a focused (hovered/tapped) moth is kept alive past its natural
  // exit time before it is force-removed regardless of focus, so a forgotten
  // focus can never leak a moth forever.
  focusGracePeriodSeconds: 30
};

// species-style.js guarantees speed/size stay within these bounds for every
// taxon, so orbit radius can be derived per-moth instead of relative to
// whatever else happens to be active right now (unlike the old batch-relative
// createMoths() formula, which assumed a fixed, immutable moth list).
const SPEED_RANGE = [0.4, 1.8];
const MAX_STYLE_SIZE = 5;

function lerp(min, max, unit) {
  return min + (max - min) * unit;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// A taxon id alone isn't enough: iNaturalist observations are routinely
// identified only to genus, family or coarser. Per inat_website.txt 6.5,
// anything short of species level gets the same subdued "unknown" profile as
// an observation with no taxon at all, rather than a style that looks
// specific but isn't.
function isIdentifiedToSpecies(observation) {
  return observation.taxonId !== null && observation.taxonRank === "species";
}

function buildLiveMoth(observation, style, isUnknown, entryTimeSeconds, canvasWidth, canvasHeight, options) {
  const seed = hashString(observation.id);
  const usableRadius = Math.max(
    32,
    (Math.min(canvasWidth, canvasHeight) * 0.48 - MAX_STYLE_SIZE - 18) * options.orbitRadiusScale
  );
  const minRadius = Math.min(72, usableRadius);
  const radiusRange = Math.max(0, usableRadius - minRadius);
  const speedRatio = clamp01((style.speed - SPEED_RANGE[0]) / (SPEED_RANGE[1] - SPEED_RANGE[0]));
  const baseRadius = minRadius + (1 - speedRatio) * radiusRange;
  const offset = (seededUnit(seed, 7) - 0.5) * radiusRange * 0.08;
  const radius = Math.max(minRadius, Math.min(usableRadius, baseRadius + offset));
  const duration = lerp(options.minMothDurationSeconds, options.maxMothDurationSeconds, seededUnit(seed, 999));
  const label = observation.commonName || observation.scientificName || "Unidentified";

  return {
    angle: (seededUnit(seed, 0) * 360 * Math.PI) / 180,
    chimeNote: style.chimeNote,
    chimeNotes: style.chimeNotes,
    color: style.color,
    entryAngle: (sampleBiasedApproachAngle(seed, 173) * Math.PI) / 180,
    entryTime: entryTimeSeconds,
    erraticness: style.erraticness,
    exitAngle: (sampleBiasedApproachAngle(seed, 211) * Math.PI) / 180,
    exitTime: entryTimeSeconds + duration,
    id: observation.id,
    imageURL: observation.imageUrl,
    inclinationDriftSpeed: style.inclinationDriftSpeed,
    label,
    nodeDriftSpeed: style.nodeDriftSpeed,
    noiseSeed: seed,
    orbitDirection: seededUnit(seed, 131) < 0.5 ? -1 : 1,
    radius,
    shadowBlur: style.shadowBlur,
    shadowColor: style.shadowColor,
    size: style.size,
    species: isUnknown ? "unknown" : `taxon-${observation.taxonId}`,
    speciesDescription: observation.place ? `Observed near ${observation.place}` : "",
    speciesName: label,
    speed: style.speed,
    trailLength: style.trailLength
  };
}

export class MothStore {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.moths = new Map();
    this.focusedId = null;
    this.focusedSinceSeconds = null;
  }

  get activeCount() {
    return this.moths.size;
  }

  get isFull() {
    return this.moths.size >= this.options.maxActiveMoths;
  }

  // Returns true if the observation was admitted, false if it was rejected
  // (already active, or the scene is at capacity) — callers should leave a
  // rejected observation in the ObservationQueue to retry later.
  addObservation(observation, nowSeconds, canvasWidth, canvasHeight) {
    if (this.moths.has(observation.id) || this.isFull) {
      return false;
    }

    const isUnknown = !isIdentifiedToSpecies(observation);
    const style = getSpeciesStyle(isUnknown ? null : observation.taxonId);
    const moth = buildLiveMoth(observation, style, isUnknown, nowSeconds, canvasWidth, canvasHeight, this.options);
    this.moths.set(moth.id, moth);
    return true;
  }

  // Drops moths whose exit time has passed. A focused moth is kept alive
  // past its exit until focus clears or the grace period elapses, whichever
  // is first. Returns the list of removed ids.
  removeExpired(nowSeconds) {
    const removedIds = [];

    this.moths.forEach((moth, id) => {
      if (nowSeconds < moth.exitTime) {
        return;
      }

      const isFocused = id === this.focusedId;
      const graceExpired = !isFocused
        || this.focusedSinceSeconds === null
        || nowSeconds - this.focusedSinceSeconds > this.options.focusGracePeriodSeconds;

      if (isFocused && !graceExpired) {
        return;
      }

      this.moths.delete(id);
      removedIds.push(id);
      if (isFocused) {
        this.clearFocus();
      }
    });

    return removedIds;
  }

  removeMoth(id) {
    if (id === this.focusedId) {
      this.clearFocus();
    }
    return this.moths.delete(id);
  }

  focusMoth(id, nowSeconds) {
    if (!this.moths.has(id)) {
      return false;
    }
    this.focusedId = id;
    this.focusedSinceSeconds = nowSeconds;
    return true;
  }

  clearFocus() {
    this.focusedId = null;
    this.focusedSinceSeconds = null;
  }

  getActiveMoths() {
    return [...this.moths.values()];
  }
}
