// Deterministic per-taxon visual/audio styling, generated from the taxon ID
// instead of a hand-maintained species list. A global live stream will
// constantly encounter taxa nobody curated in advance, so every finite taxon
// ID hashes to one of the five colours in PALETTE below, and every
// unidentified or coarse-rank observation gets one subdued grey profile
// instead.
import { hashString, seededUnit } from "./animation-engine.js";

// The moths' colours: white, pine blue, french blue, jungle green and yellow
// green. Exported so a test (and anything else that needs to know) can check
// against the one list.
export const PALETTE = Object.freeze(["#ffffff", "#387d7a", "#334195", "#26a96c", "#97cc04"]);

// The soft glow round a moth, in its own colour. It was one fixed cream for
// every moth when the palette was all pale; with two fairly dark blues in the
// palette a colour-matched glow is what keeps them legible against the dark
// map.
const GLOW_ALPHA = 0.55;

function glowColor(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${GLOW_ALPHA})`;
}

// A C-major-pentatonic-ish note pool across a few octaves, matching the notes
// used by the original hand-authored species config.
const NOTE_POOL = ["C3", "G3", "D4", "E4", "G4", "A4", "C5", "E5", "G5", "A5", "C6"];

const UNKNOWN_STYLE = Object.freeze({
  color: "#919191",
  chimeNote: "E5",
  chimeNotes: Object.freeze(["E5", "G5", "A5", "C6"]),
  speed: 1.75,
  size: 4,
  trailLength: 5,
  erraticness: 3.2,
  shadowBlur: 7,
  shadowColor: "rgba(120, 124, 130, 0.18)",
  inclinationDriftSpeed: 0.35,
  nodeDriftSpeed: 0.35
});

const styleCache = new Map();

function lerp(min, max, unit) {
  return min + (max - min) * unit;
}

function pickFrom(list, seed, salt) {
  const index = Math.floor(seededUnit(seed, salt) * list.length) % list.length;
  return list[index];
}

function buildStyleForTaxon(seed) {
  const noteCount = 2 + Math.floor(seededUnit(seed, 2) * 3); // 2..4 notes
  const chimeNotes = [];
  for (let index = 0; chimeNotes.length < noteCount && index < NOTE_POOL.length * 2; index += 1) {
    const note = pickFrom(NOTE_POOL, seed, 10 + index);
    if (!chimeNotes.includes(note)) {
      chimeNotes.push(note);
    }
  }

  const color = pickFrom(PALETTE, seed, 1);

  return {
    color,
    chimeNote: chimeNotes[0],
    chimeNotes,
    speed: lerp(0.4, 1.8, seededUnit(seed, 3)),
    size: lerp(2, 5, seededUnit(seed, 4)),
    trailLength: Math.round(lerp(5, 10, seededUnit(seed, 5))),
    erraticness: lerp(1.2, 3.2, seededUnit(seed, 6)),
    shadowBlur: Math.round(lerp(7, 9, seededUnit(seed, 7))),
    shadowColor: glowColor(color),
    inclinationDriftSpeed: lerp(0.1, 0.5, seededUnit(seed, 8)),
    nodeDriftSpeed: lerp(0.1, 0.5, seededUnit(seed, 9))
  };
}

// taxonId may be a finite number, or null/undefined/non-numeric for an
// observation with no identification at the configured taxonomic level.
export function getSpeciesStyle(taxonId) {
  const numericTaxonId = Number(taxonId);
  if (taxonId === null || taxonId === undefined || !Number.isFinite(numericTaxonId)) {
    return { ...UNKNOWN_STYLE, chimeNotes: [...UNKNOWN_STYLE.chimeNotes] };
  }

  const cacheKey = String(numericTaxonId);
  if (!styleCache.has(cacheKey)) {
    styleCache.set(cacheKey, buildStyleForTaxon(hashString(cacheKey)));
  }

  const cached = styleCache.get(cacheKey);
  return { ...cached, chimeNotes: [...cached.chimeNotes] };
}

export function clearSpeciesStyleCache() {
  styleCache.clear();
}
