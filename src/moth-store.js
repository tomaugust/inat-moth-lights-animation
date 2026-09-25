// A live, mutable replacement for the old fixed-timeline config.moths array
// (see inat_website.txt section 6.3). Observations are added continuously,
// each gets an independent orbit/entry/exit lifecycle from a monotonic clock
// (pass performance.now() / 1000, not Date.now()), and completed moths are
// dropped so a display left open for days stays bounded. The output shape
// matches what animation-engine.js's createMoths() used to produce, so
// projectMoth()/drawScene() need no changes to consume it.
import { getExitStartTime, hashString, sampleBiasedApproachAngle, seededUnit } from "./animation-engine.js";
import { getSpeciesStyle } from "./species-style.js";

// Lowered from 50 concurrent moths at 4-10s each after a real abundant-data
// review: they flew by too fast to read. 10 at once is a deliberate legibility
// choice, not a technical limit. Each moth then stayed 8-20s, and Phase 17
// tripled that to 24-60s (average 42s) because, with the live feed's real
// pace (a handful of uploads a minute), 8-20s left the scene sparse. Longer
// stays mean more moths at once (about 0.24 admitted per second at most,
// 10 / 42s, still comfortably above the live feed's ~0.1/s) — see
// observation-queue.js's targetSampleSize, sized against these numbers.
const DEFAULT_OPTIONS = {
  maxActiveMoths: 10,
  minMothDurationSeconds: 24,
  maxMothDurationSeconds: 60,
  orbitRadiusScale: 0.92,
  // How long a focused (hovered/tapped) moth is kept alive past its natural
  // exit time before it is force-removed regardless of focus, so a forgotten
  // focus can never leak a moth forever.
  focusGracePeriodSeconds: 30
};

// See MothStore.holdLastMoth(): how far ahead of a moth's fly-out we check
// whether anyone else would still be in the scene, and how much a held moth's
// life is extended by each time it's kept.
const HOLD_LOOKAHEAD_SECONDS = 0.25;
const HOLD_EXTENSION_SECONDS = 2;
const HOLD_MAX_EXTENSIONS_PER_CALL = 200;

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
    // Real wall-clock time the observation was uploaded (created_at) — the
    // only time this site uses. entryTime/exitTime are monotonic seconds on
    // the animation's own clock (no fixed relationship to a calendar time),
    // so UI showing an actual time to the visitor (the cards, the pop-out)
    // needs this instead.
    createdAtMs: observation.createdAtMs ?? null,
    entryAngle: (sampleBiasedApproachAngle(seed, 173) * Math.PI) / 180,
    entryTime: entryTimeSeconds,
    erraticness: style.erraticness,
    exitAngle: (sampleBiasedApproachAngle(seed, 211) * Math.PI) / 180,
    exitTime: entryTimeSeconds + duration,
    id: observation.id,
    imageURL: observation.imageUrl,
    imageAttribution: observation.imageAttribution,
    imageLicense: observation.imageLicense,
    inclinationDriftSpeed: style.inclinationDriftSpeed,
    label,
    lat: observation.lat ?? null,
    lon: observation.lon ?? null,
    nodeDriftSpeed: style.nodeDriftSpeed,
    noiseSeed: seed,
    observationUrl: observation.observationUrl,
    orbitDirection: seededUnit(seed, 131) < 0.5 ? -1 : 1,
    place: observation.place,
    qualityGrade: observation.qualityGrade,
    radius,
    scientificName: observation.scientificName,
    commonName: observation.commonName,
    // The record's own taxonomic resolution ("species", "genus", "family"…) —
    // shown on the card and pop-out, so a moth identified only to family
    // still gets a card that says exactly that.
    taxonRank: observation.taxonRank,
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

  // Keeps the animation from ever going empty: a moth is only allowed to
  // leave while at least one other moth is still in the scene and staying.
  //
  // "Leaving" starts at the moth's fly-out (getExitStartTime), well before
  // it's removed, and it fades out as it goes — so waiting until removal to
  // check would already be too late; the scene would have been visibly empty
  // for the length of the fly-out. Instead, whenever a moth is within
  // HOLD_LOOKAHEAD_SECONDS of starting to leave (or already past that point,
  // e.g. after a backgrounded tab's clock jump) and nobody else is staying
  // beyond that same horizon, its life is pushed later. It keeps being
  // pushed until a newly admitted moth (or another that's further from
  // leaving) takes over, at which point it's free to go on its next call.
  //
  // Two moths about to leave together can't both leave together: the one
  // with the most life left is checked first, so it's the one that's kept
  // (now "staying"), which lets the other go — rather than rescuing a moth
  // that's already halfway through flying out, which would snap it back into
  // orbit. The roles then simply repeat until a replacement arrives.
  holdLastMoth(nowSeconds) {
    const horizon = nowSeconds + HOLD_LOOKAHEAD_SECONDS;
    const latestExitFirst = [...this.moths.values()].sort((a, b) => getExitStartTime(b) - getExitStartTime(a));

    latestExitFirst.forEach((moth) => {
      const othersStaying = () => {
        for (const other of this.moths.values()) {
          if (other !== moth && getExitStartTime(other) > horizon) {
            return true;
          }
        }
        return false;
      };

      let extensions = 0;
      while (getExitStartTime(moth) <= horizon && !othersStaying() && extensions < HOLD_MAX_EXTENSIONS_PER_CALL) {
        moth.exitTime += HOLD_EXTENSION_SECONDS;
        extensions += 1;
      }
    });
  }

  // Drops moths whose exit time has passed — but never the last one in the
  // scene (holdLastMoth normally makes sure that can't come up; this is the
  // backstop). A focused moth is kept alive past its exit until focus clears
  // or the grace period elapses, whichever is first. Returns the list of
  // removed ids.
  removeExpired(nowSeconds) {
    const removedIds = [];

    this.moths.forEach((moth, id) => {
      if (nowSeconds < moth.exitTime) {
        return;
      }

      if (this.moths.size <= 1) {
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
