import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUploadedTime, formatWhen } from "../../src/observation-time.js";

// Local-time constructors, so these hold in whatever timezone/locale the test
// happens to run in; expected clock text is produced the same way the module
// produces it rather than hard-coded.
const NOW = new Date(2026, 8, 25, 15, 0).getTime();
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("formatWhen", () => {
  it("shows just the clock time for something from today", () => {
    const earlierToday = new Date(2026, 8, 25, 14, 32).getTime();
    assert.equal(formatWhen(earlierToday, NOW), clock(earlierToday));
  });

  it("includes the date for anything from a previous day, so it doesn't look like it just happened", () => {
    const lastNight = new Date(2026, 8, 24, 22, 10).getTime();
    const text = formatWhen(lastNight, NOW);
    assert.notEqual(text, clock(lastNight));
    assert.ok(text.endsWith(clock(lastNight)), `expected the clock time at the end of "${text}"`);
    assert.ok(text.includes("24"), `expected the day of the month in "${text}"`);
  });

  it("adds the year once it isn't this year", () => {
    const longAgo = new Date(2025, 2, 3, 9, 5).getTime();
    assert.ok(formatWhen(longAgo, NOW).includes("2025"));
    assert.ok(!formatWhen(new Date(2026, 2, 3, 9, 5).getTime(), NOW).includes("2026"));
  });

  it("returns an empty string for an unknown time", () => {
    assert.equal(formatWhen(null, NOW), "");
    assert.equal(formatWhen(undefined, NOW), "");
    assert.equal(formatWhen(Number.NaN, NOW), "");
  });
});

describe("formatUploadedTime", () => {
  it("labels the upload time, and uses nothing else on the moth", () => {
    const uploaded = new Date(2026, 8, 25, 14, 55).getTime();
    const text = formatUploadedTime({ createdAtMs: uploaded, observedAtMs: new Date(2020, 0, 1).getTime() }, NOW);
    assert.equal(text, "Uploaded " + clock(uploaded));
  });

  it("is blank when the upload time is unknown, rather than guessing", () => {
    assert.equal(formatUploadedTime({ createdAtMs: null }, NOW), "");
    assert.equal(formatUploadedTime({}, NOW), "");
  });
});
