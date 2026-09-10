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

  it("shows a loading indicator until the first real response arrives, then hides it", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockPhotoHost(page);
    // A slow connection can take several seconds to fetch the full 24h
    // window — this reproduces exactly that: the scene must not look
    // silently broken (just the light, no feedback) while that's in flight.
    await page.route(WORKER_URL_PATTERN, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fetchedAt: new Date().toISOString(), stale: false, cursor: "999", observations: [liveObservation()] })
      });
    });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(1700);

    const loading = page.locator("#loading-status");
    assert.equal(await loading.isVisible(), true, "should still show loading before the delayed response arrives");
    assert.match(await loading.textContent(), /loading/i);

    await page.waitForTimeout(1000);
    assert.equal(
      await loading.evaluate((el) => el.classList.contains("is-hidden")),
      true,
      "should hide once the connection reports a real state"
    );

    await page.close();
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
});
