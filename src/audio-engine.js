import { config } from "./config-store.js";
import { seededUnit } from "./animation-engine.js";
import { RIPPLE_DURATION_SECONDS, rippleIntensity } from "./world-map.js";

function noteToFrequency(note) {
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(note || ""));
  if (!match) {
    return 440;
  }

  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const letter = match[1].toUpperCase();
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const octave = Number(match[3]);
  const midi = (octave + 1) * 12 + semitones[letter] + accidental;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---------------------------------------------------------------------------
// The arrival "woooow": a deep, gliding tone that plays when a new moth enters,
// timed with the arrival ripple. Its loudness IS the ripple's own fade
// (world-map.js's rippleIntensity — the same function that sets the ring's
// brightness), after a very short attack, so it starts with the ring and dies
// away exactly as the expanding ring fades out. The pitch rises quickly (the
// "wo") and then sinks slowly (the "oooow") while a low-pass filter opens and
// then closes — the way a voice moves through "wooow".
//
// Everything that shapes the sound is a plain function of the moth's age (its
// seconds since arrival) so it can be unit-tested and rendered offline;
// createArrivalVoice turns those into Web Audio automation.
// ---------------------------------------------------------------------------
// Pentatonic and low (about 65-98Hz), an octave or more under the drone and
// chimes so it sits beneath them.
const ARRIVAL_NOTES = ["C2", "D2", "E2", "G2"];
const ARRIVAL_ATTACK_SECONDS = 0.15;
const ARRIVAL_RISE_SECONDS = 0.35;
const ARRIVAL_PEAK_GAIN = 0.55;
// A moth only gets a woooow if it's this fresh when first seen, so opening the
// sound partway through, or a tab catching up after being backgrounded,
// doesn't fire one for every moth already in the scene.
const ARRIVAL_START_WINDOW_SECONDS = 0.6;
const ARRIVAL_MAX_VOICES = 3;
const ARRIVAL_MIN_SPACING_SECONDS = 0.2;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

// 0..1: how loud the woooow is, `age` seconds after the moth arrived.
export function arrivalEnvelope(age) {
  if (age < 0 || age > RIPPLE_DURATION_SECONDS) {
    return 0;
  }
  return smoothstep(age / ARRIVAL_ATTACK_SECONDS) * rippleIntensity(age);
}

function riseAndFall(age) {
  return {
    rise: smoothstep(age / ARRIVAL_RISE_SECONDS),
    fall: clamp01((age - ARRIVAL_RISE_SECONDS) / (RIPPLE_DURATION_SECONDS - ARRIVAL_RISE_SECONDS))
  };
}

// Multiple of the base pitch: from a little under it, up to it quickly, then
// sinking slowly again.
export function arrivalPitchRatio(age) {
  const { rise, fall } = riseAndFall(age);
  return 0.88 + 0.12 * rise - 0.08 * fall;
}

// Low-pass cutoff in Hz: opens quickly, then closes slowly.
export function arrivalFilterHz(age) {
  const { rise, fall } = riseAndFall(age);
  return 160 + 460 * rise - 400 * fall;
}

export function pickArrivalNote(moth) {
  const unit = seededUnit(moth.noiseSeed || 0, 88);
  return ARRIVAL_NOTES[Math.min(ARRIVAL_NOTES.length - 1, Math.floor(unit * ARRIVAL_NOTES.length))];
}

// One woooow, as two oscillators (a sine for the body and a sawtooth an octave
// up for something to hear on small speakers) through a low-pass filter.
// apply(age, atTime, level) automates pitch, filter and loudness towards where
// they should be at that age, arriving at audio-clock time atTime; level
// (0..1) scales the loudness (used to hush it while the scene is frozen).
export function createArrivalVoice(audioContext, destination, frequency, startTime = audioContext.currentTime) {
  const body = audioContext.createOscillator();
  const overtone = audioContext.createOscillator();
  const bodyGain = audioContext.createGain();
  const overtoneGain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  const output = audioContext.createGain();

  body.type = "sine";
  overtone.type = "sawtooth";
  bodyGain.gain.value = 0.8;
  overtoneGain.gain.value = 0.22;
  filter.type = "lowpass";
  filter.Q.value = 1.2;

  body.frequency.setValueAtTime(frequency * arrivalPitchRatio(0), startTime);
  overtone.frequency.setValueAtTime(frequency * 2 * arrivalPitchRatio(0), startTime);
  filter.frequency.setValueAtTime(arrivalFilterHz(0), startTime);
  output.gain.setValueAtTime(0, startTime);

  body.connect(bodyGain);
  overtone.connect(overtoneGain);
  bodyGain.connect(filter);
  overtoneGain.connect(filter);
  filter.connect(output);
  output.connect(destination);
  body.start(startTime);
  overtone.start(startTime);

  return {
    apply(age, atTime, level = 1) {
      const ratio = arrivalPitchRatio(age);
      body.frequency.linearRampToValueAtTime(frequency * ratio, atTime);
      overtone.frequency.linearRampToValueAtTime(frequency * 2 * ratio, atTime);
      filter.frequency.linearRampToValueAtTime(arrivalFilterHz(age), atTime);
      output.gain.linearRampToValueAtTime(ARRIVAL_PEAK_GAIN * arrivalEnvelope(age) * level, atTime);
    },
    stop(atTime) {
      output.gain.linearRampToValueAtTime(0, atTime);
      body.stop(atTime + 0.05);
      overtone.stop(atTime + 0.05);
    }
  };
}

function setupAudio() {
  const button = document.getElementById("sound-toggle");
  const settings = config.audio || {};
  const enabledByConfig = settings.enabled !== false;
  let audioContext = null;
  let masterGain = null;
  let delay = null;
  let delayGain = null;
  let droneGain = null;
  let droneStarted = false;
  let isEnabled = false;
  const nextChimeAt = new Map();
  // The woooow voices currently sounding, by moth id, plus what's needed to
  // pace new ones and to notice a frozen scene.
  const arrivalVoices = new Map();
  let nextArrivalAt = 0;
  let lastSceneTime = null;

  if (!button || !enabledByConfig) {
    if (button) {
      button.hidden = true;
    }

    return {
      update: () => {},
      updateArrivals: () => {}
    };
  }

  function initialiseAudio() {
    if (audioContext) {
      return;
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      button.hidden = true;
      return;
    }

    audioContext = new AudioContextConstructor();
    masterGain = audioContext.createGain();
    delay = audioContext.createDelay(4);
    delayGain = audioContext.createGain();
    droneGain = audioContext.createGain();

    masterGain.gain.value = Math.max(0, Math.min(0.35, settings.volume ?? 0.12));
    delay.delayTime.value = 0.34;
    delayGain.gain.value = 0.16;
    droneGain.gain.value = 0;

    masterGain.connect(audioContext.destination);
    masterGain.connect(delay);
    delay.connect(delayGain);
    delayGain.connect(audioContext.destination);
    droneGain.connect(audioContext.destination);
  }

  function audioLevel(value, fallback, maximum) {
    const numeric = Number(value ?? fallback);
    const scaled = Number.isFinite(numeric) && numeric > 1 ? numeric / 100 : numeric;
    return Math.max(0, Math.min(maximum, Number.isFinite(scaled) ? scaled : fallback));
  }

  function levelMultiplier(value, fallback, baseLevel, maximumMultiplier = 8) {
    const numeric = Number(value ?? fallback);
    const multiplier = Number.isFinite(numeric) ? numeric : fallback;
    return Math.max(0, Math.min(maximumMultiplier, multiplier)) * baseLevel;
  }

  function setChimesActive(active) {
    if (!audioContext || !masterGain || !delayGain) {
      return;
    }

    const now = audioContext.currentTime;
    const target = active ? audioLevel(settings.volume, 0.12, 0.35) : 0;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(target, now);
    delayGain.gain.cancelScheduledValues(now);
    delayGain.gain.setValueAtTime(active ? 0.16 : 0, now);
  }

  function startDrone() {
    if (!audioContext || !droneGain || droneStarted || settings.droneEnabled !== true) {
      return;
    }

    const notes = Array.isArray(settings.droneNotes) && settings.droneNotes.length > 0
      ? settings.droneNotes
      : ["D2", "A2", "D3"];
    const variation = Math.max(0, Math.min(1, settings.droneVariation ?? 0.65));
    const brightness = Math.max(0, Math.min(1, settings.droneBrightness ?? 0.45));
    const baseFilterFrequency = 260 + brightness * 980;

    notes.forEach((note, index) => {
      const frequency = noteToFrequency(note);
      const now = audioContext.currentTime;
      const voiceBus = audioContext.createGain();
      const lowpass = audioContext.createBiquadFilter();
      const filterLfo = audioContext.createOscillator();
      const filterLfoGain = audioContext.createGain();
      const layers = [
        { ratio: 1, type: "sine", gain: 0.42, drift: 0, driftAmount: 0 },
        { ratio: 2, type: "sine", gain: 0.04, drift: 0, driftAmount: 0.16 },
        { ratio: 4, type: "sine", gain: 0.008, drift: 0, driftAmount: 0.08 }
      ];

      voiceBus.gain.setValueAtTime(0.0001, now);
      voiceBus.gain.linearRampToValueAtTime(1, now + 1.8);
      lowpass.type = "lowpass";
      lowpass.frequency.setValueAtTime(baseFilterFrequency + index * 90, now);
      lowpass.Q.value = 0.5 + brightness * 0.35;
      filterLfo.frequency.value = 0.018 + index * 0.006;
      filterLfoGain.gain.value = baseFilterFrequency * 0.045 * variation;
      filterLfo.connect(filterLfoGain);
      filterLfoGain.connect(lowpass.frequency);
      voiceBus.connect(lowpass);
      lowpass.connect(droneGain);
      filterLfo.start(now);

      layers.forEach((layer, layerIndex) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const detuneLfo = audioContext.createOscillator();
        const detuneLfoGain = audioContext.createGain();
        const layerGain = layer.gain / Math.max(1, notes.length);

        oscillator.type = layer.type;
        oscillator.frequency.setValueAtTime(frequency * layer.ratio, now);
        oscillator.detune.setValueAtTime(layer.drift, now);

        gain.gain.value = layerGain * (1 - variation * 0.16);
        detuneLfo.frequency.value = 0.012 + index * 0.004 + layerIndex * 0.003;
        detuneLfoGain.gain.value = layer.driftAmount * variation;
        detuneLfo.connect(detuneLfoGain);
        detuneLfoGain.connect(oscillator.detune);

        oscillator.connect(gain);
        gain.connect(voiceBus);
        oscillator.start(now);
        detuneLfo.start(now);
      });
    });

    droneStarted = true;
  }

  function setDroneActive(active) {
    if (!audioContext || !droneGain || settings.droneEnabled !== true) {
      return;
    }

    startDrone();
    const now = audioContext.currentTime;
    const target = active ? levelMultiplier(settings.droneVolume, 1, 0.38) : 0;
    droneGain.gain.cancelScheduledValues(now);
    if (active) {
      droneGain.gain.setTargetAtTime(target, now, 0.9);
    } else {
      droneGain.gain.setValueAtTime(0, now);
    }
  }

  function setButtonState() {
    button.classList.toggle("is-on", isEnabled);
    button.setAttribute("aria-label", isEnabled ? "Disable sound" : "Enable sound");
  }

  function playChime(note, intensity) {
    if (!audioContext || !masterGain || !isEnabled) {
      return;
    }

    const now = audioContext.currentTime;
    const decay = Math.max(0.45, settings.noteDecay ?? 2.8);
    const frequency = noteToFrequency(note);
    const partials = [
      { ratio: 1, gain: 0.24, decay: 1 },
      { ratio: 2.005, gain: 0.085, decay: 0.78 },
      { ratio: 3.01, gain: 0.038, decay: 0.52 },
      { ratio: 4.02, gain: 0.018, decay: 0.34 },
      { ratio: 1.505, gain: 0.026, decay: 0.62 }
    ];

    partials.forEach((partial, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const filter = audioContext.createBiquadFilter();
      const detune = (seededUnit(Math.round(frequency * 100), index + 91) - 0.5) * 6;
      const partialDecay = Math.max(0.28, decay * partial.decay);

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency * partial.ratio, now);
      oscillator.detune.setValueAtTime(detune, now);
      oscillator.detune.linearRampToValueAtTime(detune * 0.25, now + partialDecay);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.min(4200, frequency * 5.8), now);
      filter.Q.value = 0.45;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(partial.gain * intensity, now + 0.04 + index * 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + partialDecay);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain);
      oscillator.start(now);
      oscillator.stop(now + partialDecay + 0.08);
    });

    const noiseDuration = 0.075;
    const noiseBuffer = audioContext.createBuffer(1, Math.max(1, Math.floor(audioContext.sampleRate * noiseDuration)), audioContext.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noiseData.length; index += 1) {
      const fade = 1 - index / noiseData.length;
      noiseData[index] = (Math.random() * 2 - 1) * fade;
    }

    const noise = audioContext.createBufferSource();
    const noiseFilter = audioContext.createBiquadFilter();
    const noiseGain = audioContext.createGain();
    noise.buffer = noiseBuffer;
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(Math.min(3200, frequency * 4.2), now);
    noiseFilter.Q.value = 1.6;
    noiseGain.gain.setValueAtTime(0.009 * intensity, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + noiseDuration);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(masterGain);
    noise.start(now);
    noise.stop(now + noiseDuration);
  }

  function pickMothNote(moth) {
    const notes = Array.isArray(moth.chimeNotes) && moth.chimeNotes.length > 0
      ? moth.chimeNotes
      : moth.chimeNote ? [moth.chimeNote] : [];

    if (notes.length < 1) {
      return "";
    }

    return notes[Math.floor(Math.random() * notes.length)];
  }

  function countBySpecies(activeMoths) {
    const counts = new Map();
    activeMoths.forEach((moth) => {
      counts.set(moth.species, (counts.get(moth.species) || 0) + 1);
    });
    return counts;
  }

  // Driven by whatever moths are actually active right now (each one already
  // carries its own chimeNote(s), assigned deterministically per taxon by
  // species-style.js) rather than a fixed species list cross-referenced by
  // id — a live feed's taxa are unbounded, so there is no fixed list to
  // cross-reference against.
  function update(activeMoths, deltaSeconds) {
    if (!isEnabled || !audioContext || audioContext.state !== "running") {
      return;
    }

    const counts = countBySpecies(activeMoths);
    const probability = Math.max(0, settings.chimeProbability ?? 0.3);
    const minInterval = Math.max(0.05, settings.minInterval ?? 0.85);
    const consideredSpecies = new Set();

    activeMoths.forEach((moth) => {
      // One chime roll per distinct species per tick, not one per moth.
      if (consideredSpecies.has(moth.species)) {
        return;
      }
      consideredSpecies.add(moth.species);

      const note = pickMothNote(moth);
      const activeCount = counts.get(moth.species) || 0;
      if (activeCount < 1 || !note) {
        return;
      }

      const audioTime = audioContext.currentTime;
      const earliest = nextChimeAt.get(moth.species) || 0;
      if (audioTime < earliest) {
        return;
      }

      const countMultiplier = Math.min(12, activeCount);
      const chance = 1 - Math.exp(-probability * countMultiplier * Math.max(0, deltaSeconds));
      if (Math.random() < chance) {
        const size = Math.max(1, moth.size || 6);
        const intensity = Math.max(0.35, Math.min(1, 8 / size));
        playChime(note, intensity);
        nextChimeAt.set(moth.species, audioTime + minInterval + Math.random() * minInterval * 2.2);
      }
    });
  }

  function endArrivalVoice(id, fadeSeconds = 0.15) {
    const voice = arrivalVoices.get(id);
    if (voice && audioContext) {
      voice.stop(audioContext.currentTime + fadeSeconds);
    }
    arrivalVoices.delete(id);
  }

  // Starts a woooow for each moth that has just arrived, and steers each
  // voice from its moth's age on the scene clock — so it follows the ripple
  // ring exactly. sceneTime is the same clock the animation runs on, which
  // stops while a moth is hovered: the woooow is hushed then (and comes back
  // when the scene moves again) instead of droning on beside a frozen ring.
  function updateArrivals(activeMoths, sceneTime) {
    const previousSceneTime = lastSceneTime;
    lastSceneTime = sceneTime;

    const active = isEnabled && audioContext && audioContext.state === "running" && settings.arrivalEnabled !== false;
    if (!active) {
      arrivalVoices.forEach((voice, id) => endArrivalVoice(id, 0.05));
      return;
    }

    const advancing = previousSceneTime !== null && sceneTime > previousSceneTime + 1e-6;
    const now = audioContext.currentTime;
    const at = now + (advancing ? 0.03 : 0.12);
    // 1 by default; arrivalVolume in the audio config scales it (0-2).
    const configuredVolume = Number(settings.arrivalVolume ?? 1);
    const volume = Number.isFinite(configuredVolume) ? Math.max(0, Math.min(2, configuredVolume)) : 1;
    const level = advancing ? volume : 0;
    const activeIds = new Set();

    activeMoths.forEach((moth) => {
      activeIds.add(moth.id);
      const age = sceneTime - moth.entryTime;

      if (!arrivalVoices.has(moth.id)) {
        const canStart = age >= 0 && age <= ARRIVAL_START_WINDOW_SECONDS
          && arrivalVoices.size < ARRIVAL_MAX_VOICES
          && now >= nextArrivalAt;
        if (!canStart) {
          return;
        }
        arrivalVoices.set(moth.id, createArrivalVoice(audioContext, masterGain, noteToFrequency(pickArrivalNote(moth))));
        nextArrivalAt = now + ARRIVAL_MIN_SPACING_SECONDS;
      }

      if (age > RIPPLE_DURATION_SECONDS) {
        endArrivalVoice(moth.id);
        return;
      }
      arrivalVoices.get(moth.id).apply(age, at, level);
    });

    arrivalVoices.forEach((voice, id) => {
      if (!activeIds.has(id)) {
        endArrivalVoice(id);
      }
    });
  }

  button.addEventListener("click", async () => {
    initialiseAudio();
    if (!audioContext) {
      return;
    }

    isEnabled = !isEnabled;

    if (isEnabled && audioContext.state !== "running") {
      await audioContext.resume();
    }

    setChimesActive(isEnabled);
    setDroneActive(isEnabled);

    setButtonState();
  });

  setButtonState();

  return {
    update,
    updateArrivals
  };
}

export { noteToFrequency, setupAudio };
