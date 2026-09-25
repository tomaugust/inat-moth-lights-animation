import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getExitStartTime } from "../../src/animation-engine.js";
import {
  computeMothRings,
  findMothRingAt,
  IDLE_RING_MAX_RADIUS,
  IDLE_RING_MIN_RADIUS,
  RIPPLE_DURATION_SECONDS,
  RIPPLE_MAX_RADIUS,
  VIGNETTE_STOPS
} from "../../src/world-map.js";

const moth = (overrides = {}) => ({ entryTime: 100, exitTime: 160, noiseSeed: 12345, ...overrides });
const ripples = (rings) => rings.filter((ring) => ring.kind === "ripple");
const idle = (rings) => rings.filter((ring) => ring.kind === "idle");

describe("computeMothRings: arrival ripple", () => {
  it("has no rings before the moth arrives or after it has gone", () => {
    assert.deepEqual(computeMothRings(moth(), 99.9), []);
    assert.deepEqual(computeMothRings(moth(), 160.1), []);
  });

  it("is a single ring — never more than one at a time", () => {
    for (let t = 100; t <= 100 + RIPPLE_DURATION_SECONDS + 0.5; t += 0.02) {
      assert.ok(ripples(computeMothRings(moth(), t)).length <= 1, "more than one ripple ring at t=" + t.toFixed(2));
    }
    assert.equal(ripples(computeMothRings(moth(), 100)).length, 1, "it starts the moment the moth arrives");
  });

  it("lasts between 2.5 and 3 seconds", () => {
    assert.ok(RIPPLE_DURATION_SECONDS >= 2.5 && RIPPLE_DURATION_SECONDS <= 3, "duration was " + RIPPLE_DURATION_SECONDS);
    assert.equal(ripples(computeMothRings(moth(), 100 + RIPPLE_DURATION_SECONDS - 0.05)).length, 1, "still fading");
    assert.equal(ripples(computeMothRings(moth(), 100 + RIPPLE_DURATION_SECONDS + 0.05)).length, 0, "and then it's over");
  });

  it("spreads outward to about 100px, never beyond", () => {
    let widest = 0;
    for (let t = 100; t <= 100 + RIPPLE_DURATION_SECONDS; t += 0.02) {
      ripples(computeMothRings(moth(), t)).forEach((ring) => {
        assert.ok(ring.radius <= RIPPLE_MAX_RADIUS + 1e-9, "ring radius " + ring.radius);
        widest = Math.max(widest, ring.radius);
      });
    }
    assert.ok(widest > 95, "the ripple should reach about 100px, reached " + widest);
    assert.equal(RIPPLE_MAX_RADIUS, 100);
  });

  it("only ever grows and fades as it goes, and starts thick and bright", () => {
    let previous = null;
    for (let t = 100; t < 100 + RIPPLE_DURATION_SECONDS; t += 0.05) {
      const [ring] = ripples(computeMothRings(moth(), t));
      if (previous) {
        assert.ok(ring.radius >= previous.radius, "radius shrank");
        assert.ok(ring.alpha <= previous.alpha + 1e-9, "alpha grew");
        assert.ok(ring.lineWidth <= previous.lineWidth + 1e-9, "stroke thickened");
      }
      previous = ring;
    }
    const first = ripples(computeMothRings(moth(), 100))[0];
    assert.ok(first.lineWidth >= 3, "a thick stroke to begin with");
    assert.ok(first.alpha > 0.9, "bright to begin with");
  });
});

describe("computeMothRings: idle ring", () => {
  it("is a single small ring that stays for as long as the moth is in the animation", () => {
    for (let t = 105; t < getExitStartTime(moth()); t += 0.25) {
      const rings = computeMothRings(moth(), t);
      assert.equal(ripples(rings).length, 0, "no ripple left at t=" + t);
      assert.equal(idle(rings).length, 1, "expected exactly one idle ring at t=" + t);
    }
  });

  it("breathes: radius swings between its small and large sizes, slowly", () => {
    const radii = [];
    for (let t = 110; t < 130; t += 0.05) {
      radii.push(idle(computeMothRings(moth(), t))[0].radius);
    }
    assert.ok(Math.min(...radii) >= IDLE_RING_MIN_RADIUS - 1e-9);
    assert.ok(Math.max(...radii) <= IDLE_RING_MAX_RADIUS + 1e-9);
    assert.ok(Math.min(...radii) < IDLE_RING_MIN_RADIUS + 1, "it should contract to about its smallest");
    assert.ok(Math.max(...radii) > IDLE_RING_MAX_RADIUS - 1, "it should spread to about its largest");
    // "Slowly": consecutive samples 50ms apart differ by well under a pixel.
    for (let i = 1; i < radii.length; i += 1) {
      assert.ok(Math.abs(radii[i] - radii[i - 1]) < 0.5, "jumped " + Math.abs(radii[i] - radii[i - 1]));
    }
  });

  it("is a small ring, much smaller than the arrival ripple", () => {
    assert.ok(IDLE_RING_MAX_RADIUS < RIPPLE_MAX_RADIUS / 5);
  });

  it("fades in as the ripple dies away, so the location is never left unmarked", () => {
    for (let t = 100; t < 100 + 6; t += 0.05) {
      const rings = computeMothRings(moth(), t);
      const total = rings.reduce((sum, ring) => sum + ring.alpha, 0);
      assert.ok(total > 0.05, "nothing visible at age " + (t - 100).toFixed(2) + "s");
    }
  });

  it("fades out over the fly-out and is gone when the moth is", () => {
    const m = moth();
    const exitStart = getExitStartTime(m);
    const alphaAt = (t) => idle(computeMothRings(m, t))[0]?.alpha ?? 0;
    // Compare like with like: the breathing changes alpha too, so take the
    // envelope (largest alpha seen over one breathing period) around each moment.
    const envelope = (t) => Math.max(...Array.from({ length: 80 }, (_, i) => alphaAt(Math.min(m.exitTime, t + i * 0.05))));
    assert.ok(envelope(exitStart - 5) > 0.5);
    assert.ok(envelope(m.exitTime - 0.2) < envelope(exitStart - 5) / 2, "should be well faded before the moth is gone");
    assert.ok(alphaAt(m.exitTime) < 0.01);
  });

  it("gives each moth its own breathing phase, so they don't all pulse together", () => {
    const a = idle(computeMothRings(moth({ noiseSeed: 1 }), 120))[0].radius;
    const b = idle(computeMothRings(moth({ noiseSeed: 987654 }), 120))[0].radius;
    assert.notEqual(a, b);
  });

  it("carries on for a moth whose stay has been extended", () => {
    const held = moth({ exitTime: 400 });
    assert.equal(idle(computeMothRings(held, 300)).length, 1);
  });
});

describe("VIGNETTE_STOPS", () => {
  it("run from the map's centre (0) out to its edge (1), in order", () => {
    assert.equal(VIGNETTE_STOPS[0][0], 0);
    assert.equal(VIGNETTE_STOPS[VIGNETTE_STOPS.length - 1][0], 1);
    for (let i = 1; i < VIGNETTE_STOPS.length; i += 1) {
      assert.ok(VIGNETTE_STOPS[i][0] > VIGNETTE_STOPS[i - 1][0], "stops out of order");
    }
  });

  it("leave the middle of the map untouched and darken steadily towards the edge", () => {
    const alphaAt = (distance) => {
      const upper = VIGNETTE_STOPS.findIndex(([stop]) => stop >= distance);
      if (upper <= 0) return VIGNETTE_STOPS[Math.max(upper, 0)][1];
      const [s0, a0] = VIGNETTE_STOPS[upper - 1];
      const [s1, a1] = VIGNETTE_STOPS[upper];
      return a0 + ((a1 - a0) * (distance - s0)) / (s1 - s0);
    };
    assert.equal(alphaAt(0), 0);
    assert.equal(alphaAt(0.4), 0, "the middle keeps its full detail");
    let previous = 0;
    for (let d = 0; d <= 1; d += 0.05) {
      assert.ok(alphaAt(d) >= previous - 1e-9, "the vignette got lighter moving outwards at " + d.toFixed(2));
      previous = alphaAt(d);
    }
    assert.ok(alphaAt(1) >= 0.85, "the very edge should be nearly the background colour");
    assert.ok(alphaAt(1) < 1, "but not a hard black-out");
  });
});

describe("findMothRingAt (hovering the rings)", () => {
  // A stand-in projector: longitude/latitude map straight onto pixels.
  const projector = { project: ([lon, lat]) => ({ x: lon, y: lat }) };
  const at = (lon, lat, overrides = {}) => moth({ id: "m-" + lon + "-" + lat, lon, lat, ...overrides });

  it("hits the small breathing ring — as a disc — on the moth's own spot", () => {
    const a = at(300, 200);
    assert.equal(findMothRingAt(projector, [a], 110, 300, 200), a, "dead centre");
    assert.equal(findMothRingAt(projector, [a], 110, 300 + 15, 200), a, "just outside the ring's edge");
    assert.equal(findMothRingAt(projector, [a], 110, 300 + 60, 200), null, "well away from it");
  });

  it("hits the expanding arrival ripple where the ring itself is, but not the empty space inside it", () => {
    const a = at(300, 200);
    const [ripple] = computeMothRings(a, 101).filter((ring) => ring.kind === "ripple");
    assert.equal(findMothRingAt(projector, [a], 101, 300 + ripple.radius, 200), a, "on the ring");
    assert.equal(findMothRingAt(projector, [a], 101, 300, 200 + ripple.radius + 3), a, "on the ring, another direction");
    assert.equal(findMothRingAt(projector, [a], 101, 300 + ripple.radius / 2, 200), null, "in the middle of the ripple");
    assert.equal(findMothRingAt(projector, [a], 101, 300 + ripple.radius + 40, 200), null, "outside it");
  });

  it("can't hit a ring that has faded away, or a moth that isn't there", () => {
    const a = at(300, 200);
    assert.equal(findMothRingAt(projector, [a], 99, 300, 200), null, "before it arrives");
    assert.equal(findMothRingAt(projector, [a], 161, 300, 200), null, "after it has gone");
    // At the very end of the fly-out the idle ring has all but faded.
    const nearlyGone = getExitStartTime(a) + (a.exitTime - getExitStartTime(a)) * 0.98;
    assert.equal(findMothRingAt(projector, [a], nearlyGone, 300, 200), null);
  });

  it("picks the closest moth when rings overlap, and ignores moths with no known location", () => {
    const near = at(300, 200);
    const far = at(310, 200);
    const noLocation = moth({ id: "nowhere", lat: null, lon: null });
    assert.equal(findMothRingAt(projector, [far, near, noLocation], 110, 302, 200), near);
    assert.equal(findMothRingAt(projector, [far, near, noLocation], 110, 309, 200), far);
    assert.equal(findMothRingAt(projector, [noLocation], 110, 0, 0), null);
  });

  it("uses the scene clock it is given, so a frozen scene keeps its rings where they were", () => {
    const a = at(300, 200);
    const first = findMothRingAt(projector, [a], 105.4, 300, 200 + computeMothRings(a, 105.4).find((r) => r.kind === "idle").radius);
    const second = findMothRingAt(projector, [a], 105.4, 300, 200 + computeMothRings(a, 105.4).find((r) => r.kind === "idle").radius);
    assert.equal(first, a);
    assert.equal(second, a);
  });
});
