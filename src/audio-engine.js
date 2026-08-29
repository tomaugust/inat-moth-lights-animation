import { config } from "./config-store.js";
import { seededUnit } from "./animation-engine.js";

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

function setupAudio(moths) {
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

  if (!button || !enabledByConfig) {
    if (button) {
      button.hidden = true;
    }

    return {
      update: () => {}
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

  function pickSpeciesNote(species) {
    const notes = Array.isArray(species.chimeNotes) && species.chimeNotes.length > 0
      ? species.chimeNotes
      : species.chimeNote ? [species.chimeNote] : [];

    if (notes.length < 1) {
      return "";
    }

    return notes[Math.floor(Math.random() * notes.length)];
  }

  function activeSpeciesCountsAt(animationTime) {
    const activeSpeciesCounts = new Map();
    moths.forEach((moth) => {
      if (animationTime >= moth.entryTime && animationTime <= moth.exitTime) {
        activeSpeciesCounts.set(moth.species, (activeSpeciesCounts.get(moth.species) || 0) + 1);
      }
    });
    return activeSpeciesCounts;
  }

  function update(animationTime, deltaSeconds) {
    if (!isEnabled || !audioContext || audioContext.state !== "running") {
      return;
    }

    const activeSpeciesCounts = activeSpeciesCountsAt(animationTime);
    const probability = Math.max(0, settings.chimeProbability ?? 0.3);
    const minInterval = Math.max(0.05, settings.minInterval ?? 0.85);

    config.species.forEach((species) => {
      const note = pickSpeciesNote(species);
      const activeCount = activeSpeciesCounts.get(species.id) || 0;
      if (activeCount < 1 || !note) {
        return;
      }

      const audioTime = audioContext.currentTime;
      const earliest = nextChimeAt.get(species.id) || 0;
      if (audioTime < earliest) {
        return;
      }

      const countMultiplier = Math.min(12, activeCount);
      const chance = 1 - Math.exp(-probability * countMultiplier * Math.max(0, deltaSeconds));
      if (Math.random() < chance) {
        const size = Math.max(1, species.size || 6);
        const intensity = Math.max(0.35, Math.min(1, 8 / size));
        playChime(note, intensity);
        nextChimeAt.set(species.id, audioTime + minInterval + Math.random() * minInterval * 2.2);
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
    update
  };
}

export { setupAudio };
