import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";

const WORKER_URL = "https://inat-moth-lights-adapter.tomaugust1985.workers.dev/observations";

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

// The production site talks only to the deployed Worker adapter, never
// api.inaturalist.org directly — every test here intercepts that exact URL
// and answers with a canned adapter-contract response, so nothing ever
// reaches the real Worker or the real iNaturalist API from CI.
async function mockWorkerAdapter(page, { observations = [], stale = false, status = 200 } = {}) {
  await page.route(WORKER_URL, (route) =>
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
      if (!response.ok() && !response.url().endsWith("/favicon.ico") && response.url() !== WORKER_URL) {
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

  it("shows a loading indicator until the first real response arrives, then hides it", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // A slow connection can take several seconds to fetch the full 24h
    // window — this reproduces exactly that: the scene must not look
    // silently broken (just the light, no feedback) while that's in flight.
    await page.route(WORKER_URL, async (route) => {
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
