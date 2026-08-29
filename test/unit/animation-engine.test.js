import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { setConfig } from "../../src/config-store.js";
import {
  clampAnimationTime,
  colorWithAlpha,
  createMoths,
  easeInOut,
  formatClockTime,
  hashString,
  normalizeAnimationTime,
  projectMoth,
  seededUnit
} from "../../src/animation-engine.js";
import { createSampleConfig } from "../fixtures/sample-config.mjs";

beforeEach(() => {
  setConfig(createSampleConfig());
});

describe("easeInOut", () => {
  it("clamps and smooths the 0..1 range", () => {
    assert.equal(easeInOut(0), 0);
    assert.equal(easeInOut(1), 1);
    assert.equal(easeInOut(0.5), 0.5);
    assert.equal(easeInOut(-1), 0);
    assert.equal(easeInOut(2), 1);
  });
});

describe("hashString", () => {
  it("is deterministic and unsigned", () => {
    assert.equal(hashString("moth-1"), 3549840143);
    assert.equal(hashString("moth-1"), hashString("moth-1"));
    assert.ok(hashString("moth-1") >= 0);
  });

  it("hashes different strings differently", () => {
    assert.notEqual(hashString("moth-1"), hashString("moth-2"));
  });
});

describe("seededUnit", () => {
  it("is deterministic for a given seed and salt", () => {
    assert.equal(seededUnit(42, 7), 0.5033537232092008);
    assert.equal(seededUnit(0, 0), seededUnit(0, 0));
  });

  it("stays within [0, 1)", () => {
    for (let salt = 0; salt < 20; salt += 1) {
      const value = seededUnit(12345, salt);
      assert.ok(value >= 0 && value < 1, `seededUnit out of range: ${value}`);
    }
  });
});

describe("colorWithAlpha", () => {
  it("converts 6-digit hex colors", () => {
    assert.equal(colorWithAlpha("#ffffff", 0.5), "rgba(255, 255, 255, 0.5)");
  });

  it("expands 3-digit hex colors", () => {
    assert.equal(colorWithAlpha("#fff", 1), "rgba(255, 255, 255, 1)");
  });

  it("clamps alpha to [0, 1]", () => {
    assert.equal(colorWithAlpha("#000000", 5), "rgba(0, 0, 0, 1)");
    assert.equal(colorWithAlpha("#000000", -5), "rgba(0, 0, 0, 0)");
  });

  it("replaces the alpha channel of an existing rgba color", () => {
    assert.equal(colorWithAlpha("rgba(10, 20, 30, 0.9)", 0.2), "rgba(10, 20, 30, 0.2)");
  });

  it("returns unrecognized color strings unchanged", () => {
    assert.equal(colorWithAlpha("currentColor", 0.5), "currentColor");
  });
});

describe("clampAnimationTime", () => {
  it("clamps into [0, duration]", () => {
    const config = createSampleConfig();
    setConfig(config);
    assert.equal(clampAnimationTime(-10), 0);
    assert.equal(clampAnimationTime(1000), config.animation.duration);
    assert.equal(clampAnimationTime(40), 40);
  });
});

describe("normalizeAnimationTime", () => {
  it("wraps within [0, duration) when looping", () => {
    const config = createSampleConfig();
    config.animation.loop = true;
    config.animation.duration = 80;
    setConfig(config);

    assert.equal(normalizeAnimationTime(90), 10);
    assert.equal(normalizeAnimationTime(-10), 70);
    assert.equal(normalizeAnimationTime(40), 40);
  });

  it("clamps into [0, duration] when not looping", () => {
    const config = createSampleConfig();
    config.animation.loop = false;
    config.animation.duration = 80;
    setConfig(config);

    assert.equal(normalizeAnimationTime(90), 80);
    assert.equal(normalizeAnimationTime(-10), 0);
  });
});

describe("formatClockTime", () => {
  it("advances from the configured start time", () => {
    const config = createSampleConfig();
    config.animation.startClockTime = "00:00";
    setConfig(config);

    assert.equal(formatClockTime(0), "00:00");
    assert.equal(formatClockTime(90), "01:30");
  });

  it("wraps past midnight", () => {
    const config = createSampleConfig();
    config.animation.startClockTime = "23:50";
    setConfig(config);

    assert.equal(formatClockTime(20), "00:10");
  });
});

describe("createMoths", () => {
  it("returns one entry per configured moth", () => {
    const config = createSampleConfig();
    setConfig(config);

    const moths = createMoths(config, 800, 600);
    assert.equal(moths.length, config.moths.length);
  });

  it("is deterministic given the same config and dimensions", () => {
    const config = createSampleConfig();
    setConfig(config);

    const first = createMoths(config, 800, 600);
    const second = createMoths(config, 800, 600);
    assert.deepEqual(first, second);
  });

  it("keeps orbit radius within the usable canvas area", () => {
    const config = createSampleConfig();
    setConfig(config);

    const moths = createMoths(config, 800, 600);
    moths.forEach((moth) => {
      assert.ok(moth.radius > 0, "radius should be positive");
      assert.ok(Number.isFinite(moth.radius), "radius should be finite");
    });
  });
});

describe("projectMoth", () => {
  it("returns null before the moth has entered", () => {
    const config = createSampleConfig();
    setConfig(config);
    const [moth] = createMoths(config, 800, 600);

    assert.equal(projectMoth(moth, -1, 800, 600, 400, 330), null);
  });

  it("returns null after the moth has exited", () => {
    const config = createSampleConfig();
    setConfig(config);
    const [moth] = createMoths(config, 800, 600);

    assert.equal(projectMoth(moth, moth.exitTime + 1, 800, 600, 400, 330), null);
  });

  it("returns a projected point with valid opacity while active", () => {
    const config = createSampleConfig();
    setConfig(config);
    const [moth] = createMoths(config, 800, 600);
    const midTime = (moth.entryTime + moth.exitTime) / 2;

    const projected = projectMoth(moth, midTime, 800, 600, 400, 330);
    assert.ok(projected);
    assert.ok(Number.isFinite(projected.x));
    assert.ok(Number.isFinite(projected.y));
    assert.ok(projected.opacity >= 0 && projected.opacity <= 1);
  });
});
