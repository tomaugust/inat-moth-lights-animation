import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { setConfig } from "../../src/config-store.js";
import {
  clampAnimationTime,
  colorWithAlpha,
  createMoths,
  easeInOut,
  formatClockTime,
  formatIdentification,
  formatPhotoCredit,
  getExitStartTime,
  getMothSprite,
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

describe("getExitStartTime", () => {
  it("is when the fly-out begins: the transition length before exitTime, and matches projectMoth's phases", () => {
    setConfig(createSampleConfig());
    const moth = { entryTime: 0, exitTime: 10, angle: 0, speed: 1, radius: 100, size: 3, shadowBlur: 0, erraticness: 0, orbitDirection: 1, inclinationDriftSpeed: 0, nodeDriftSpeed: 0, noiseSeed: 1, entryAngle: 0, exitAngle: 0 };
    const exitStart = getExitStartTime(moth);
    assert.ok(exitStart > 7 && exitStart < 9, "a 10s moth flies out for ~2s: " + exitStart);
    assert.equal(projectMoth(moth, exitStart - 0.1, 800, 600, 400, 330, false).phase, "orbiting");
    assert.equal(projectMoth(moth, exitStart + 0.1, 800, 600, 400, 330, false).phase, "exiting");
  });

  it("never starts before the moth entered", () => {
    assert.equal(getExitStartTime({ entryTime: 5, exitTime: 5.5 }), 5);
  });
});

describe("formatPhotoCredit", () => {
  it("joins the upper-cased license code and the photographer", () => {
    assert.equal(formatPhotoCredit({ imageLicense: "cc-by-nc", imageAttribution: "A. Person" }), "CC-BY-NC · A. Person");
  });

  it("is empty without an attribution, since a photo is never shown without one", () => {
    assert.equal(formatPhotoCredit({ imageLicense: "cc-by", imageAttribution: "" }), "");
    assert.equal(formatPhotoCredit({}), "");
  });

  it("still shows the attribution when the license is missing", () => {
    assert.equal(formatPhotoCredit({ imageLicense: "", imageAttribution: "A. Person" }), "A. Person");
  });
});

describe("formatIdentification", () => {
  it("states the record's own taxonomic resolution", () => {
    assert.equal(formatIdentification({ taxonRank: "species" }), "Identified to species");
    assert.equal(formatIdentification({ taxonRank: "genus" }), "Identified to genus");
    assert.equal(formatIdentification({ taxonRank: "family" }), "Identified to family");
  });

  it("is empty when the rank isn't known", () => {
    assert.equal(formatIdentification({ taxonRank: "" }), "");
    assert.equal(formatIdentification({}), "");
  });
});

describe("getMothSprite (the side-on flapping moth)", () => {
  const moth = (overrides = {}) => ({ size: 3, noiseSeed: 4242, trail: [], ...overrides });
  const degrees = (radians) => (radians * 180) / Math.PI;
  const trailFrom = (x0, y0, dx, dy) => [0, 1, 2, 3, 4].map((i) => ({ x: x0 + dx * i, y: y0 + dy * i }));

  it("is big enough to read as a moth, and bigger for bigger species", () => {
    const small = getMothSprite(moth({ size: 2 }), 0).length;
    const large = getMothSprite(moth({ size: 5 }), 0).length;
    assert.ok(small >= 15, "smallest was " + small);
    assert.ok(large > small);
    assert.ok(large <= 25, "largest was " + large);
  });

  it("flaps through a big swing: wings raised high at the top of the stroke, and hanging below the body at the bottom", () => {
    const angles = [];
    for (let t = 0; t < 2; t += 0.005) {
      angles.push(degrees(getMothSprite(moth(), t).wingAngle));
    }
    const up = Math.max(...angles);
    const down = Math.min(...angles);
    assert.ok(up > 75 && up <= 80 + 1e-6, "top of the upstroke was " + up);
    assert.ok(down < -75 && down >= -80 - 1e-6, "bottom of the downstroke was " + down);
    assert.ok(up - down > 150, "the swing should be big enough to read as a flap: " + (up - down) + " degrees");
    assert.ok(Math.abs(up + down) < 5, "and symmetric: as far below the body as above it (" + up + " / " + down + ")");
  });

  it("flaps at a readable rate — a few beats a second, not a blur", () => {
    const beats = (seed) => {
      let count = 0;
      let previous = getMothSprite(moth({ noiseSeed: seed }), 0).wingAngle;
      let rising = false;
      for (let t = 0.001; t < 4; t += 0.001) {
        const value = getMothSprite(moth({ noiseSeed: seed }), t).wingAngle;
        if (value > previous) rising = true;
        else if (rising && value < previous) {
          count += 1;
          rising = false;
        }
        previous = value;
      }
      return count / 4;
    };
    [1, 99, 12345, 777777].forEach((seed) => {
      const hz = beats(seed);
      assert.ok(hz >= 4.75 && hz <= 9.5, "seed " + seed + " flaps at " + hz + " Hz");
    });
  });

  it("folds rather than hinges: the wing's height is squashed as it swings down to the body, then opens out below it", () => {
    const squashes = [];
    for (let t = 0; t < 2; t += 0.001) {
      const sprite = getMothSprite(moth(), t);
      assert.ok(Math.abs(sprite.wingSquash - Math.sin(sprite.wingAngle)) < 1e-12, "squash should be sin(elevation)");
      squashes.push(sprite.wingSquash);
    }
    assert.ok(Math.max(...squashes) > 0.97, "fully raised should be (nearly) full height: " + Math.max(...squashes));
    assert.ok(Math.min(...squashes) < -0.97, "it should hang fully below the body at the bottom, as high as it goes above: " + Math.min(...squashes));
    assert.ok(Math.min(...squashes.map(Math.abs)) < 0.03, "it should pass through (nearly) flat against the body");
    for (let i = 1; i < squashes.length; i += 1) {
      assert.ok(Math.abs(squashes[i] - squashes[i - 1]) < 0.09, "squash jumped: " + squashes[i - 1] + " -> " + squashes[i]);
    }
    // Both sides of the body get used, and it's the sign that says which.
    assert.ok(squashes.some((q) => q > 0.3) && squashes.some((q) => q < -0.3));
  });

  it("makes some moths broad-winged and some narrow-winged, each within a believable range", () => {
    const ratios = [1, 2, 3, 99, 4242, 12345, 777777, 31337, 271828].map((seed) => getMothSprite(moth({ noiseSeed: seed }), 0).wingRatio);
    ratios.forEach((ratio) => assert.ok(ratio >= 0.8 && ratio <= 1.1 + 1e-9, "wing ratio " + ratio));
    assert.ok(Math.max(...ratios) - Math.min(...ratios) > 0.1, "wings should differ between moths: " + ratios.map((r) => r.toFixed(2)));
    assert.equal(getMothSprite(moth({ noiseSeed: 5 }), 0).wingRatio, getMothSprite(moth({ noiseSeed: 5 }), 9).wingRatio, "but stay the same for one moth");
  });

  it("bobs the body as it flaps: down on the upstroke, up on the downstroke, only a little", () => {
    let highestWing = null;
    let lowestWing = null;
    for (let t = 0; t < 1; t += 0.001) {
      const sprite = getMothSprite(moth(), t);
      assert.ok(Math.abs(sprite.bob) <= 0.04 + 1e-9, "bob was " + sprite.bob);
      if (!highestWing || sprite.wingAngle > highestWing.wingAngle) highestWing = sprite;
      if (!lowestWing || sprite.wingAngle < lowestWing.wingAngle) lowestWing = sprite;
    }
    assert.ok(highestWing.bob > 0.03, "body should be at its lowest when the wings are at the top: " + highestWing.bob);
    assert.ok(lowestWing.bob < -0.03, "and at its highest when they're at the bottom: " + lowestWing.bob);
  });

  it("gives each moth its own rhythm, so they don't all flap in step", () => {
    const a = getMothSprite(moth({ noiseSeed: 1 }), 0.3).wingAngle;
    const b = getMothSprite(moth({ noiseSeed: 987654 }), 0.3).wingAngle;
    assert.notEqual(a, b);
  });

  it("is a pure function of the scene clock, so a hover-freeze holds the wings still", () => {
    assert.deepEqual(getMothSprite(moth(), 12.34), getMothSprite(moth(), 12.34));
  });

  it("flaps regardless of any 'reduce motion' setting — there is no still-wing mode", () => {
    // getMothSprite takes only the moth and the clock; the wings move with the clock.
    assert.equal(getMothSprite.length, 2);
    const angles = new Set();
    for (let t = 0; t < 1; t += 0.02) {
      angles.add(getMothSprite(moth(), t).wingAngle);
    }
    assert.ok(angles.size > 30, "only " + angles.size + " distinct wing angles over a second");
  });

  it("faces right when travelling right and left when travelling left — mirrored, never upside down", () => {
    assert.equal(getMothSprite(moth({ trail: trailFrom(0, 0, 5, 0) }), 0).facing, 1);
    assert.equal(getMothSprite(moth({ trail: trailFrom(50, 0, -5, 0) }), 0).facing, -1);
    assert.equal(getMothSprite(moth(), 0).facing, 1, "faces right before it has moved");
  });

  it("turns through edge-on, gradually, as its horizontal direction reverses — it does not flip in one step", () => {
    // Horizontal travel across the trail window sweeping from fast-right to fast-left (6px or more is fully turned).
    const facings = [];
    for (let dx = 8; dx >= -8; dx -= 0.05) {
      facings.push(getMothSprite(moth({ trail: trailFrom(100, 0, dx / 3, 0) }), 0).facing);
    }
    assert.equal(facings[0], 1, "starts fully facing right");
    assert.equal(facings[facings.length - 1], -1, "ends fully facing left");
    for (let i = 1; i < facings.length; i += 1) {
      assert.ok(facings[i] <= facings[i - 1] + 1e-12, "should only ever turn one way");
      assert.ok(Math.abs(facings[i] - facings[i - 1]) < 0.1, "flipped abruptly: " + facings[i - 1] + " -> " + facings[i]);
    }
    assert.ok(facings.some((f) => Math.abs(f) < 0.05), "it should pass through (nearly) edge-on");
    assert.ok(facings.some((f) => f > 0.3 && f < 0.7), "and be seen partly turned along the way");
  });

  it("is edge-on when it has no sideways travel at all, e.g. moving straight down", () => {
    assert.equal(getMothSprite(moth({ trail: trailFrom(0, 0, 0, 5) }), 0).facing, 0);
  });

  it("tilts nose-up when climbing and nose-down when diving, the same whichever way it faces", () => {
    const level = getMothSprite(moth({ trail: trailFrom(0, 0, 5, 0) }), 0).pitch;
    const divingRight = getMothSprite(moth({ trail: trailFrom(0, 0, 5, 3) }), 0).pitch;
    const divingLeft = getMothSprite(moth({ trail: trailFrom(50, 0, -5, 3) }), 0).pitch;
    const climbingRight = getMothSprite(moth({ trail: trailFrom(0, 0, 5, -3) }), 0).pitch;
    assert.equal(level, 0);
    assert.ok(divingRight > 0 && climbingRight < 0);
    assert.ok(Math.abs(divingRight - divingLeft) < 1e-9, "diving is nose-down whichever way it faces");
  });

  it("never tilts past about 30 degrees, however steep the climb or dive", () => {
    const steep = getMothSprite(moth({ trail: trailFrom(0, 0, 0.1, 50) }), 0).pitch;
    assert.ok(Math.abs(degrees(steep)) <= 32, "pitch was " + degrees(steep));
  });
});
