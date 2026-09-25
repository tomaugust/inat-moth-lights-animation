import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  arrivalEnvelope,
  arrivalFilterHz,
  arrivalPitchRatio,
  noteToFrequency,
  pickArrivalNote
} from "../../src/audio-engine.js";
import { computeMothRings, RIPPLE_DURATION_SECONDS, rippleIntensity } from "../../src/world-map.js";

describe("noteToFrequency", () => {
  it("resolves A4 to concert pitch", () => {
    assert.equal(noteToFrequency("A4"), 440);
  });

  it("resolves C4 to middle C", () => {
    assert.ok(Math.abs(noteToFrequency("C4") - 261.6255653005986) < 1e-9);
  });

  it("respects sharps and flats", () => {
    assert.ok(noteToFrequency("C#4") > noteToFrequency("C4"));
    assert.ok(noteToFrequency("Db4") === noteToFrequency("C#4"));
  });

  it("falls back to 440Hz for unparseable input", () => {
    assert.equal(noteToFrequency(""), 440);
    assert.equal(noteToFrequency("not-a-note"), 440);
    assert.equal(noteToFrequency(undefined), 440);
  });
});

describe("the arrival woooow's shape", () => {
  it("is silent outside the ripple, and fades in over a fraction of a second", () => {
    assert.equal(arrivalEnvelope(-0.1), 0);
    assert.equal(arrivalEnvelope(RIPPLE_DURATION_SECONDS + 0.01), 0);
    assert.equal(arrivalEnvelope(0), 0, "no click: it starts from nothing");
    assert.ok(arrivalEnvelope(0.05) > 0 && arrivalEnvelope(0.05) < 0.3);
    assert.ok(arrivalEnvelope(0.2) > 0.85, "and is (nearly) at full strength within about 0.2s");
  });

  it("fades out exactly as the ripple ring fades, ending when it ends", () => {
    for (let age = 0.3; age <= RIPPLE_DURATION_SECONDS; age += 0.05) {
      // Past the very short attack the sound IS the ring's own fade.
      assert.ok(Math.abs(arrivalEnvelope(age) - rippleIntensity(age)) < 1e-9, "out of step with the ring at " + age.toFixed(2) + "s");
    }
    assert.equal(arrivalEnvelope(RIPPLE_DURATION_SECONDS), 0, "silent the instant the ring is gone");
    // ...and the ring the user sees is drawn from the very same function.
    const m = { entryTime: 10, exitTime: 100, noiseSeed: 1 };
    [0.5, 1.2, 2.0, 2.8].forEach((age) => {
      const ripple = computeMothRings(m, 10 + age).find((ring) => ring.kind === "ripple");
      assert.ok(Math.abs(ripple.alpha / 0.95 - rippleIntensity(age)) < 1e-9, "ring brightness should be the ripple's intensity");
    });
  });

  it("only ever gets quieter once past its peak", () => {
    let previous = Infinity;
    for (let age = 0.25; age <= RIPPLE_DURATION_SECONDS; age += 0.01) {
      const value = arrivalEnvelope(age);
      assert.ok(value <= previous + 1e-12, "got louder at " + age.toFixed(2));
      previous = value;
    }
  });

  it("swoops like a voice saying wooow: pitch rises fast then sinks slowly, filter opens fast then closes", () => {
    assert.ok(arrivalPitchRatio(0.35) > arrivalPitchRatio(0), "rises at first");
    assert.ok(arrivalPitchRatio(RIPPLE_DURATION_SECONDS) < arrivalPitchRatio(0.35), "then sinks");
    assert.ok(arrivalFilterHz(0.35) > arrivalFilterHz(0), "opens at first");
    assert.ok(arrivalFilterHz(RIPPLE_DURATION_SECONDS) < arrivalFilterHz(0.35), "then closes");
    for (let age = 0; age <= RIPPLE_DURATION_SECONDS; age += 0.01) {
      assert.ok(arrivalPitchRatio(age) > 0.8 && arrivalPitchRatio(age) <= 1.0001, "pitch ratio " + arrivalPitchRatio(age));
      assert.ok(arrivalFilterHz(age) >= 150 && arrivalFilterHz(age) <= 650, "filter " + arrivalFilterHz(age));
    }
  });

  it("is deep: the base notes are all under about 100Hz, and a moth always gets the same one", () => {
    for (let seed = 1; seed < 200; seed += 1) {
      const note = pickArrivalNote({ noiseSeed: seed });
      assert.ok(noteToFrequency(note) < 100, note + " is not deep");
      assert.equal(pickArrivalNote({ noiseSeed: seed }), note);
    }
    const notes = new Set([...Array(200).keys()].map((seed) => pickArrivalNote({ noiseSeed: seed })));
    assert.ok(notes.size >= 3, "moths should get a mix of notes: " + [...notes]);
  });
});
