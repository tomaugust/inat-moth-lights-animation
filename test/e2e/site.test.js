import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";
import { stubGeolocation } from "../helpers/geolocation.mjs";

const WORKER_URL = "https://inat-moth-lights-adapter.tomaugust1985.workers.dev/observations";
// The real client now appends ?place_id=<resolved country> (see app.js's
// resolveUserPlace() wiring) — a glob suffix matches that query string
// regardless of which country a given test's browser resolves to.
const WORKER_URL_PATTERN = `${WORKER_URL}*`;

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

// The production site talks only to the deployed Worker adapter, never
// api.inaturalist.org directly — every test here intercepts that exact URL
// and answers with a canned adapter-contract response, so nothing ever
// reaches the real Worker or the real iNaturalist API from CI.
async function mockWorkerAdapter(page, { observations = [], stale = false, status = 200 } = {}) {
  await mockPhotoHost(page);
  await page.route(WORKER_URL_PATTERN, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ fetchedAt: new Date().toISOString(), stale, cursor: "999", observations })
    })
  );
}

function liveObservation(overrides = {}) {
  const now = Date.now();
  return {
    id: "inat-999",
    taxonId: 54321,
    scientificName: "Testus mothus",
    commonName: "Test Moth",
    taxonRank: "species",
    createdAtMs: now,
    observedAtMs: now,
    place: "Test Location, UK",
    qualityGrade: "needs_id",
    imageUrl: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg",
    imageAttribution: "(c) Test Person, some rights reserved (CC BY-NC)",
    imageLicense: "cc-by-nc",
    observationUrl: "https://www.inaturalist.org/observations/999",
    ...overrides
  };
}

describe("UK Moths site", () => {
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
      if (!response.ok() && !response.url().endsWith("/favicon.ico") && !response.url().startsWith(WORKER_URL)) {
        unexpectedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await mockWorkerAdapter(page, { observations: [liveObservation()] });

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
    await mockWorkerAdapter(page, { observations: [liveObservation()] });

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

  it("freezes the whole scene while a moth is hovered/focused, and resumes once hover ends", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockWorkerAdapter(page, { observations: [liveObservation()] });

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

  it("still shows moths after a reload, even though the Worker always returns the same full-window batch", async () => {
    // Regression test: the Worker adapter is stateless and returns the
    // *entire* current 24h window on every request, never an incremental
    // delta (see mockWorkerAdapter's comment above). ObservationQueue used to
    // persist its seen-ID dedup to localStorage across page loads, which
    // meant a real visitor reloading (or simply revisiting) the site got
    // zero new observations on the second load — every ID had already been
    // marked "seen" on the first. The queue must not persist that dedup
    // across a real page reload for this Worker-backed page, or a returning
    // visitor sees nothing.
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockWorkerAdapter(page, { observations: [liveObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });
    assert.ok((await page.locator(".active-moths-card").count()) > 0, "expected a moth on the first load");

    // Same page context (same origin, same localStorage), same mocked
    // response — reproducing a real reload with the Worker's real behavior.
    await page.reload({ waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });
    assert.ok((await page.locator(".active-moths-card").count()) > 0, "expected a moth again after reload");

    await page.close();
  });

  it("starts with the UK default instantly, then switches to the visitor's real resolved country", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockPhotoHost(page);
    await stubGeolocation(page, { latitude: 48.8566, longitude: 2.3522 });
    // Delayed so there's a reliable window to observe the UK default before
    // the switch — resolveUserPlace() normally resolves fast enough (real
    // permission already granted, or mocked as here) that the two states
    // would otherwise race within a single test assertion.
    await page.route("https://api.inaturalist.org/v1/places/nearby**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total_results: 1,
          results: { standard: [{ id: 424242, name: "Testland", admin_level: 0 }], community: [] }
        })
      });
    });
    // One handler, keyed by the request's own place_id — the UK default
    // starts immediately (before geolocation resolves) and must see UK data;
    // the switch that follows must see Testland's, never a mix of the two.
    await page.route(WORKER_URL_PATTERN, (route) => {
      const placeId = new URL(route.request().url()).searchParams.get("place_id");
      const observation =
        placeId === "424242"
          ? liveObservation({ id: "inat-testland", commonName: "Testland Moth", observationUrl: "https://www.inaturalist.org/observations/111" })
          : liveObservation();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fetchedAt: new Date().toISOString(), stale: false, cursor: "1", observations: [observation] })
      });
    });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    // Comfortably before the delayed places/nearby response resolves (see
    // above), even after the panel-open interaction below spends its own
    // real wall-clock time — so this reliably observes the pre-switch UK
    // default rather than racing the switch.
    await page.waitForTimeout(1200);

    assert.equal(await page.textContent("#animation-title"), "UK Moths", "should start with the UK default immediately");
    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });
    assert.equal(await page.locator(".active-moths-card__name").first().textContent(), "Test Moth");

    await page.waitForFunction(() => document.getElementById("animation-title")?.textContent === "Testland Moths", {
      timeout: 5000
    });
    await page.waitForFunction(
      () => document.querySelector(".active-moths-card__name")?.textContent === "Testland Moth",
      { timeout: 5000 }
    );
    const cardNames = await page.locator(".active-moths-card__name").allTextContents();
    assert.deepEqual(cardNames, ["Testland Moth"], "the UK moth should be gone after switching, not left alongside Testland's");

    await page.close();
  });

  it("shows a loading indicator for at least 3 seconds even when the real response arrives almost instantly, then hides it", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockWorkerAdapter(page, { observations: [liveObservation()] }); // resolves essentially immediately

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
    await page.route(WORKER_URL_PATTERN, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fetchedAt: new Date().toISOString(), stale: false, cursor: "999", observations: [] })
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
    await mockWorkerAdapter(page, { observations: [liveObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    assert.equal(await page.locator("#debug-status").isVisible(), false, "should stay hidden without ?debug");
    assert.equal(await page.locator("#debug-status").textContent(), "", "should never even be populated without ?debug");

    await page.close();

    const debugPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockWorkerAdapter(debugPage, { observations: [liveObservation()] });

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

    await mockWorkerAdapter(page, { observations: [liveObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(500);
    await page.click("#sound-toggle");
    await page.waitForTimeout(500);

    assert.deepEqual(errors, []);
    await page.close();
  });

  it("degrades gracefully (no thrown errors, light still renders) when the adapter is unreachable", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Only pageerror (uncaught exceptions) is checked here, not console: a
    // deliberate non-2xx response makes Chromium itself log a benign
    // "failed to load resource" console entry that isn't an app error.
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await mockWorkerAdapter(page, { status: 502 });

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

  it("shows the Colombia fallback set with an explanatory banner when the very first load can't get live data at all", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await stubGeolocation(page); // keeps this on the UK default, so nothing switches mid-test
    await mockWorkerAdapter(page, { status: 502 });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");

    const fallbackStatus = page.locator("#fallback-status");
    await page.waitForFunction(
      () => !document.getElementById("fallback-status")?.classList.contains("is-hidden"),
      { timeout: 5000 }
    );
    assert.match(await fallbackStatus.textContent(), /Colombia/, "expected the banner to name where the substitute moths are from");

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
    await stubGeolocation(page);

    let callCount = 0;
    await mockPhotoHost(page);
    await page.route(WORKER_URL_PATTERN, (route) => {
      callCount += 1;
      // First poll fails outright (trips fallback mode); the retry that
      // follows the client's own backoff succeeds with one real observation.
      if (callCount === 1) {
        return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "upstream-error" }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fetchedAt: new Date().toISOString(), stale: false, cursor: "999", observations: [liveObservation()] })
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
