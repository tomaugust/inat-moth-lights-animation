import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";
import { createMapProjector } from "../../src/robinson-projection.js";

const API_URL = "https://api.inaturalist.org/v2/observations";
const API_URL_PATTERN = `${API_URL}*`;

let site;
let browser;

before(async () => {
  site = await startStaticServer();
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}
  );
});

after(async () => {
  await browser.close();
  await site.close();
});

// A 1x1 transparent PNG, so a mocked observation's photo has something real
// to load instead of depending on the actual photo existing on iNaturalist's
// real CDN (photo id "1" doesn't) — that only surfaced as a genuine 404 in
// CI, which has real internet access; this sandbox's own inability to reach
// external domains at all had been masking it entirely.
const FAKE_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

async function mockPhotoHost(page) {
  await page.route("https://inaturalist-open-data.s3.amazonaws.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: FAKE_IMAGE_BYTES })
  );
}

// The production site talks directly to api.inaturalist.org — no server
// component sits in front of it (see README's Phase 14). Every test here
// intercepts that exact URL and answers with a canned raw-v2-shaped
// response, so nothing ever reaches the real iNaturalist API from CI.
async function mockObservationsApi(page, { results = [], status = 200 } = {}) {
  await mockPhotoHost(page);
  await page.route(API_URL_PATTERN, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ total_results: results.length, page: 1, per_page: 200, results })
    })
  );
}

// A raw iNaturalist v2 API result — the shape InatClient's mapRawObservationToContract
// expects, not the already-normalized contract shape the old Worker adapter used to
// hand back.
function rawObservation(overrides = {}) {
  const nowIso = new Date().toISOString();
  return {
    id: 999,
    created_at: nowIso,
    observed_on: nowIso.slice(0, 10),
    time_observed_at: nowIso,
    uri: "https://www.inaturalist.org/observations/999",
    quality_grade: "needs_id",
    place_guess: "Test Location, UK",
    location: "51.5074,-0.1278", // London — also exercises the world map's lat/lon plumbing by default
    taxon: { id: 54321, rank: "species", name: "Testus mothus", preferred_common_name: "Test Moth" },
    photos: [
      {
        id: 1,
        url: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg",
        attribution: "(c) Test Person, some rights reserved (CC BY-NC)",
        license_code: "cc-by-nc"
      }
    ],
    ...overrides
  };
}

describe("World Moths site", () => {
  it("boots the animation with no console or page errors", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    const unexpectedResponses = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("404")) {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("response", (response) => {
      if (!response.ok() && !response.url().endsWith("/favicon.ico") && !response.url().startsWith(API_URL)) {
        unexpectedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await mockObservationsApi(page, { results: [rawObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    const canvasHasContent = await page.evaluate(() => {
      const canvas = document.getElementById("orbit-canvas");
      const context = canvas.getContext("2d");
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) {
          return true;
        }
      }
      return false;
    });
    assert.ok(canvasHasContent, "expected the canvas to have drawn non-black pixels");

    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedResponses, []);
    await page.close();
  });

  it("lists a live moth in the side panel, with its real thumbnail and observation link", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [rawObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });
    const cardCount = await page.locator(".active-moths-card").count();
    assert.ok(cardCount > 0, "expected at least one active moth card");

    const thumb = page.locator(".active-moths-card__thumb:not([hidden])").first();
    assert.equal(await thumb.getAttribute("src"), "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg");

    const link = page.locator(".active-moths-card__link:not([hidden])").first();
    assert.equal(await link.getAttribute("href"), "https://www.inaturalist.org/observations/999");
    assert.equal(await link.getAttribute("target"), "_blank");

    await page.close();
  });

  // The world map (Phase 15) plots each active moth at its own real reported
  // location (rawObservation()'s default "location" field — London) and
  // hover-links that marker to the same moth's card/orbit position. The
  // marker's exact screen position is computed here with the same
  // createMapProjector() app.js itself uses (same viewport size, same
  // centerYRatio from config/site-config.json, same padding), rather than
  // assumed or eyeballed.
  it("hovering a moth's marker on the world map focuses the same moth as its card", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [rawObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    const canvasRect = await page.evaluate(() => {
      const canvas = document.getElementById("orbit-canvas");
      const rect = canvas.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: canvas.clientWidth, height: canvas.clientHeight };
    });
    const projector = createMapProjector({
      width: canvasRect.width,
      height: canvasRect.height,
      offsetX: canvasRect.width / 2,
      offsetY: canvasRect.height * 0.56, // config/site-config.json's scene.centerYRatio
      padding: 24
    });
    const point = projector.project([-0.1278, 51.5074]); // rawObservation()'s default location, lon/lat order

    await page.mouse.move(canvasRect.left + point.x, canvasRect.top + point.y);
    await page.waitForTimeout(300);

    assert.equal(
      await page.locator(".active-moths-card").first().evaluate((el) => el.classList.contains("is-focused")),
      true,
      "expected hovering the moth's map marker to focus the same moth as its card"
    );

    await page.close();
  });

  it("freezes the whole scene while a moth is hovered/focused, and resumes once hover ends", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [rawObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    function canvasSnapshot() {
      return page.evaluate(() => document.getElementById("orbit-canvas").toDataURL());
    }

    await page.locator(".active-moths-card").first().hover();
    await page.waitForTimeout(300);
    const frozenA = await canvasSnapshot();
    await page.waitForTimeout(700);
    const frozenB = await canvasSnapshot();
    assert.equal(frozenA, frozenB, "the scene should not change at all while a moth is hovered");

    await page.mouse.move(5, 5); // outside the side panel — clears hover
    await page.waitForTimeout(300);
    const resumedA = await canvasSnapshot();
    await page.waitForTimeout(700);
    const resumedB = await canvasSnapshot();
    assert.notEqual(resumedA, resumedB, "the scene should resume moving once hover ends");

    await page.close();
  });

  it("resumes exactly where it left off after a long hover, instead of jumping forward by the hover's own real duration", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Several concurrently orbiting moths, not just one — a single moth's
    // own (randomized per-id) speed and orbit radius make its motion alone
    // too noisy a signal to calibrate a reliable threshold against; several
    // at once average that out.
    const manyResults = Array.from({ length: 8 }, (_, index) =>
      rawObservation({
        id: 900 + index,
        taxon: { id: 50000 + index, rank: "species", name: "Testus mothus", preferred_common_name: "Test Moth" }
      })
    );
    await mockObservationsApi(page, { results: manyResults });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    // Past the 3s minimum loading duration, so the scene is fully settled
    // into its normal steady-state animation before any of this measures it.
    await page.waitForTimeout(3500);

    // A coarse grid of sampled pixels (not a single point) so a moth moving
    // anywhere on the canvas registers, whichever direction it happens to be
    // orbiting toward.
    function canvasFingerprint() {
      return page.evaluate(() => {
        const canvas = document.getElementById("orbit-canvas");
        const context = canvas.getContext("2d");
        const cols = 24;
        const rows = 18;
        const values = [];
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const x = Math.round((col + 0.5) * (canvas.width / cols));
            const y = Math.round((row + 0.5) * (canvas.height / rows));
            const [r, g, b] = context.getImageData(x, y, 1, 1).data;
            values.push(r + g + b);
          }
        }
        return values;
      });
    }

    function fingerprintDiff(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i += 1) {
        sum += Math.abs(a[i] - b[i]);
      }
      return sum;
    }

    // Baseline from ordinary, never-frozen playback: how much the scene
    // normally changes per millisecond, used below to size the "normal
    // motion" budget the actual freeze/resume check allows for. Measured
    // over one longer (~2.5s) window rather than a short one deliberately —
    // an early version of this test measured a separate ~500ms window and
    // compared the two, but a window that short is dominated by whatever
    // single moment it happens to catch (this scene deliberately varies
    // speed/position per moth), making its own rate too noisy to calibrate
    // against; a real 429-brightness-unit swing measured in one run's
    // 500ms window, versus a legitimately much calmer ~2s stretch measured
    // right after it in the same run, was exactly what made this test flaky
    // — not a real jump, just a short window's own sampling noise. The
    // longer window averages that out. Real elapsed wall-clock time (not
    // the nominal 2000ms asked for) is measured too and used to compute the
    // rate, since a busy/shared runner — including a heavily CPU-contended
    // machine running several e2e files' browsers at once — can turn a
    // nominal wait into something considerably longer.
    const baselineStart = await canvasFingerprint();
    const baselineWindowStartedAtMs = Date.now();
    await page.waitForTimeout(2000);
    const baselineLong = await canvasFingerprint();
    const baselineWindowElapsedMs = Date.now() - baselineWindowStartedAtMs;
    const longGapDiff = fingerprintDiff(baselineStart, baselineLong);
    const motionRatePerMs = longGapDiff / baselineWindowElapsedMs;
    // A weak sanity check on purpose: only rules out a scene that's
    // completely stalled (nothing moving at all, which would make every
    // assertion below vacuously pass regardless of whether the freeze/resume
    // fix actually works), not a specific "how much" threshold.
    assert.ok(
      longGapDiff > 20,
      `expected the scene to visibly move at all over ~2s of ordinary playback (saw a diff of only ${longGapDiff} over ${baselineWindowElapsedMs}ms) — otherwise this test can't tell a jump from normal motion`
    );

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    // Hovering/focusing also toggles its own visual chrome (the hover
    // popout, a focused/dimmed style swap on the moths themselves) that has
    // nothing to do with time passing — measured here with a deliberately
    // brief hover (short enough that any position jump, buggy or not, is
    // negligible) so it can be told apart from real jumped-forward motion
    // below, rather than conflating the two.
    const card = page.locator(".active-moths-card").first();
    await card.hover();
    await page.waitForTimeout(80);
    const brieflyHoveredFingerprint = await canvasFingerprint();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(60);
    const brieflyResumedFingerprint = await canvasFingerprint();
    const hoverUiOnlyDiff = fingerprintDiff(brieflyHoveredFingerprint, brieflyResumedFingerprint);

    await card.hover();
    await page.waitForTimeout(300); // let the freeze actually take hold
    const frozenFingerprint = await canvasFingerprint();
    await page.waitForTimeout(2500); // hold the hover for as long as baselineLong above

    await page.mouse.move(5, 5); // outside the side panel — clears hover
    // Sampled almost immediately after unhover (one settle-tick, not the
    // ~500ms+ used elsewhere) — long enough for the next animation frame to
    // actually run, short enough that any real jump-forward (this hover
    // lasted ~2.8s total) would still be almost entirely un-recovered from.
    const resumeWindowStartedAtMs = Date.now();
    await page.waitForTimeout(60);
    const justResumedFingerprint = await canvasFingerprint();
    const resumeWindowElapsedMs = Date.now() - resumeWindowStartedAtMs;
    const resumeDiff = fingerprintDiff(frozenFingerprint, justResumedFingerprint);

    // resumeDiff is expected to include roughly hoverUiOnlyDiff (the popout/
    // style toggle, present here too) plus only a modest amount of normal
    // motion — but hoverUiOnlyDiff itself isn't a fixed constant. The popout
    // is a sizeable box (title, description, sometimes a thumbnail) that
    // covers a real chunk of the canvas, so its measured diff also picks up
    // whatever ambient motion happens to pass behind that specific patch at
    // that instant — a spatially concentrated effect, distinct from (and not
    // reliably predicted by) longGapDiff's own whole-canvas average. Repeated
    // real runs put this "toggle, wherever it happens to land" cost anywhere
    // from several hundred to ~1600, fairly independent of how calm the rest
    // of the canvas is, so the budget floors its own variance allowance at
    // 1800 (comfortably above every such run observed) rather than scaling
    // it off hoverUiOnlyDiff's own single sample, which can itself land on
    // the low end. A normal-motion allowance sized against longGapDiff
    // directly is added on top — the one number in this test actually
    // measured over a long (~2s), well-sampled window — rather than by
    // extrapolating motionRatePerMs (itself derived from that same long
    // window) back out over this resume window's own ~60ms sample:
    // multiplying a per-ms rate by a tiny, timing-jittery elapsed value is
    // its own source of instability, and was what made an earlier version of
    // this budget swing wildly run to run even with a 5x safety multiplier.
    // A real jump-forward bug skips the scene ahead by the ~2.8s the hover
    // actually lasted, which is comparable to (if not more than) the ~2s
    // longGapDiff itself, added on top of hoverUiOnlyDiff — clearly past
    // this budget even with the added toggle-cost slack, except during a
    // coincidentally near-motionless baseline window where this test can't
    // tell a jump from normal motion regardless (see the sanity check above).
    const toggleCostAllowance = Math.max(hoverUiOnlyDiff, 1800);
    const normalMotionBudget = toggleCostAllowance + longGapDiff * 0.5 + 20;
    assert.ok(
      resumeDiff < hoverUiOnlyDiff + normalMotionBudget,
      `expected the scene to resume from almost exactly where it froze (hover-chrome-only diff=${hoverUiOnlyDiff}, plus a budget of ${normalMotionBudget.toFixed(1)} covering that same toggle cost's own variance plus half of the ~2s baseline's longGapDiff=${longGapDiff}), not jump forward by the ~2.8s the hover actually lasted (a real jump would add on the order of longGapDiff on top, well past this budget) — saw resumeDiff=${resumeDiff} (resume window ${resumeWindowElapsedMs}ms, motionRatePerMs=${motionRatePerMs.toFixed(3)})`
    );

    await page.close();
  });

  it("still shows moths after a reload", async () => {
    // Regression test: ObservationQueue used to persist its seen-ID dedup to
    // localStorage across page loads, which meant a real visitor reloading
    // (or simply revisiting) the site got zero new observations on the
    // second load — every ID had already been marked "seen" on the first.
    // The production queue must not persist that dedup across a real page
    // reload, or a returning visitor sees nothing.
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [rawObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });
    assert.ok((await page.locator(".active-moths-card").count()) > 0, "expected a moth on the first load");

    // Same page context (same origin, same localStorage), same mocked
    // response — reproducing a real reload.
    await page.reload({ waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });
    assert.ok((await page.locator(".active-moths-card").count()) > 0, "expected a moth again after reload");

    await page.close();
  });

  it("shows a loading indicator for at least 3 seconds even when the real response arrives almost instantly, then hides it", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [rawObservation()] }); // resolves essentially immediately

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(1800); // well past the fast response, still short of the 3s minimum

    const loading = page.locator("#loading-status");
    assert.equal(
      await loading.evaluate((el) => el.classList.contains("is-hidden")),
      false,
      "the minimum display duration should keep this visible even though real data already arrived"
    );
    assert.match(await loading.textContent(), /loading/i);

    await page.waitForSelector("#loading-status.is-hidden", { timeout: 2500 });

    await page.close();
  });

  it("flickers the light slowly and smoothly while loading — no fast strobing — then holds steady once data arrives", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockPhotoHost(page);
    // Long enough that the real response (not just the 3s minimum display
    // duration) is what's keeping the scene in "loading" for the whole
    // sampling window below.
    await page.route(API_URL_PATTERN, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total_results: 0, page: 1, per_page: 200, results: [] })
      });
    });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(500);

    // Sampled at the light's own center pixel (not the surrounding glow),
    // which the always-on ambient shimmer never touches (see drawLight) —
    // any real swing here can only be the loading-only broken-bulb effect.
    function lightBrightness() {
      return page.evaluate(() => {
        const canvas = document.getElementById("orbit-canvas");
        const context = canvas.getContext("2d");
        const cx = Math.round(canvas.width / 2);
        const cy = Math.round(canvas.height * 0.56);
        const [r, g, b] = context.getImageData(cx, cy, 1, 1).data;
        return r + g + b;
      });
    }

    // SAFETY: sampled close together (50ms apart — 20x/second, denser than
    // any real display refresh a viewer would perceive as separate frames),
    // no consecutive pair should differ by a large amount. A fast strobe
    // (the actual bug report this fix addresses) would show huge consecutive
    // deltas here; a slow, smooth drift — confirmed at ~44 max in manual
    // measurement against this exact implementation — never does.
    const fineSamples = [];
    for (let i = 0; i < 20; i += 1) {
      fineSamples.push(await lightBrightness());
      await page.waitForTimeout(50);
    }
    let maxConsecutiveDelta = 0;
    for (let i = 1; i < fineSamples.length; i += 1) {
      maxConsecutiveDelta = Math.max(maxConsecutiveDelta, Math.abs(fineSamples[i] - fineSamples[i - 1]));
    }
    assert.ok(
      maxConsecutiveDelta < 150,
      `expected only gradual, smooth changes 50ms apart (no strobing), saw a jump of ${maxConsecutiveDelta} (samples: ${fineSamples})`
    );

    // STILL VISIBLY FLICKERING: sampled over a much longer window (6s) than
    // the fine-grained safety check above, since a full dim-and-brighten
    // cycle now takes seconds, not milliseconds. brokenLightFlicker maps its
    // wave continuously to brightness (no flat plateau at either extreme —
    // an earlier version clamped out its positive half, which sat completely
    // flat at full brightness for up to 2 real seconds at a stretch,
    // confirmed by measurement, and was reported as "the flicker doesn't
    // seem to work" for a visit whose loading window landed in one of those
    // stretches), so any few-second window reliably shows real, continuous
    // movement regardless of when the page happened to start relative to it.
    const coarseSamples = [];
    for (let i = 0; i < 24; i += 1) {
      coarseSamples.push(await lightBrightness());
      await page.waitForTimeout(250);
    }
    const coarseRange = Math.max(...coarseSamples) - Math.min(...coarseSamples);
    assert.ok(
      coarseRange > 150,
      `expected a real (if slow) brightness swing while loading, saw range ${coarseRange} (samples: ${coarseSamples})`
    );

    await page.waitForSelector("#loading-status.is-hidden", { timeout: 6000 });

    const steadySamples = [];
    for (let i = 0; i < 5; i += 1) {
      steadySamples.push(await lightBrightness());
      await page.waitForTimeout(150);
    }
    const steadyRange = Math.max(...steadySamples) - Math.min(...steadySamples);
    assert.ok(
      steadyRange < 60,
      `expected the light to hold roughly steady once loaded, saw range ${steadyRange} (samples: ${steadySamples})`
    );

    await page.close();
  });

  it("keeps the debug readout hidden unless ?debug is on the URL", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [rawObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    assert.equal(await page.locator("#debug-status").isVisible(), false, "should stay hidden without ?debug");
    assert.equal(await page.locator("#debug-status").textContent(), "", "should never even be populated without ?debug");

    await page.close();

    const debugPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(debugPage, { results: [rawObservation()] });

    await debugPage.goto(`${site.url}?debug`, { waitUntil: "networkidle" });
    await debugPage.click("#launch-switch");
    await debugPage.waitForFunction(() => document.getElementById("debug-status")?.textContent, { timeout: 5000 });

    assert.match(await debugPage.locator("#debug-status").textContent(), /state=/, "should populate with ?debug present");

    await debugPage.close();
  });

  it("toggles sound without throwing", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await mockObservationsApi(page, { results: [rawObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(500);
    await page.click("#sound-toggle");
    await page.waitForTimeout(500);

    assert.deepEqual(errors, []);
    await page.close();
  });

  it("degrades gracefully (no thrown errors, light still renders) when iNaturalist is unreachable", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Only pageerror (uncaught exceptions) is checked here, not console: a
    // deliberate non-2xx response makes Chromium itself log a benign
    // "failed to load resource" console entry that isn't an app error.
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await mockObservationsApi(page, { status: 502 });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(1500);

    const canvasHasContent = await page.evaluate(() => {
      const canvas = document.getElementById("orbit-canvas");
      const context = canvas.getContext("2d");
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) {
          return true;
        }
      }
      return false;
    });
    assert.ok(canvasHasContent, "the light itself should still render even with no moth data");

    assert.deepEqual(errors, []);
    await page.close();
  });

  it("shows the global fallback set with an explanatory banner when the very first load can't get live data at all", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await mockObservationsApi(page, { status: 502 });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");

    const fallbackStatus = page.locator("#fallback-status");
    await page.waitForFunction(
      () => !document.getElementById("fallback-status")?.classList.contains("is-hidden"),
      { timeout: 5000 }
    );
    assert.match(await fallbackStatus.textContent(), /around the world/, "expected the banner to explain what's being shown");

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });
    const card = page.locator(".active-moths-card").first();
    const link = await card.locator(".active-moths-card__link:not([hidden])").getAttribute("href");
    assert.match(link, /^https:\/\/www\.inaturalist\.org\/observations\/\d+$/, "expected a real fallback observation link, not a live one");

    assert.deepEqual(errors, []);
    await page.close();
  });

  it("clears the fallback set and its banner the moment real data actually arrives", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    let callCount = 0;
    await mockPhotoHost(page);
    await page.route(API_URL_PATTERN, (route) => {
      callCount += 1;
      // First poll fails outright (trips fallback mode); the retry that
      // follows the client's own backoff succeeds with one real observation.
      if (callCount === 1) {
        return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "upstream-error" }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total_results: 1, page: 1, per_page: 200, results: [rawObservation()] })
      });
    });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");

    await page.waitForFunction(
      () => !document.getElementById("fallback-status")?.classList.contains("is-hidden"),
      { timeout: 5000 }
    );

    // The client's real retry sits behind a ~60s backoff after a failure —
    // far too slow for a test. A real visitor's browser regaining
    // connectivity fires exactly this event, and InatClient already reacts
    // to it by polling immediately regardless of any pending backoff (see
    // its 'online' handler) — using it here is exercising real client
    // behavior, not a test-only shortcut.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await page.waitForFunction(
      () => document.getElementById("fallback-status")?.classList.contains("is-hidden"),
      { timeout: 5000 }
    );

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 10000 });
    const links = await page.locator(".active-moths-card__link:not([hidden])").evaluateAll((elements) => elements.map((el) => el.getAttribute("href")));
    assert.ok(links.includes("https://www.inaturalist.org/observations/999"), "expected the real live observation to be showing");
    assert.ok(
      links.every((href) => !href.match(/inaturalist\.org\/observations\/\d+$/) || href === "https://www.inaturalist.org/observations/999"),
      "expected no leftover fallback moths once real data arrived"
    );

    await page.close();
  });
});
