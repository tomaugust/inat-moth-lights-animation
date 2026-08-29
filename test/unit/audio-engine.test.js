import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noteToFrequency } from "../../src/audio-engine.js";

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
