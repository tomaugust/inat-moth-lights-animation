import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";

const WORKER_URL = "https://inat-moth-lights-adapter.tomaugust1985.workers.dev/observations";
// The real client now appends ?place_id=<resolved country> — see app.js's
// resolveUserPlace() wiring.
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

// The "has a thumbnail and a working link" case is already covered by
// site.test.js's live-moth test; this file focuses on the regression case —
// an observation with no photo (or an unlicensed one) must hide the
// thumbnail without breaking the observation link, which iNaturalist always
// provides regardless of whether there's a usable photo.
describe("active moth cards: hides the thumbnail (only) when an observation has no photo", () => {
  it("hides the thumbnail but still shows the observation link for a moth with no image/license data", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const now = Date.now();
    await page.route(WORKER_URL_PATTERN, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          fetchedAt: new Date().toISOString(),
          stale: false,
          cursor: "1",
          observations: [
            {
              id: "inat-1",
              taxonId: 111,
              scientificName: "Nomo photonis",
              commonName: "No Photo Moth",
              taxonRank: "species",
              createdAtMs: now,
              observedAtMs: now,
              place: "Test Location, UK",
              qualityGrade: "needs_id",
              imageUrl: "",
              imageAttribution: "",
              imageLicense: "",
              observationUrl: "https://www.inaturalist.org/observations/1"
            }
          ]
        })
      })
    );

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    assert.equal(await page.locator(".active-moths-card__thumb:not([hidden])").count(), 0, "no photo should mean no thumbnail");

    const link = page.locator(".active-moths-card__link:not([hidden])").first();
    assert.equal(await link.getAttribute("href"), "https://www.inaturalist.org/observations/1", "the observation link should still show");

    await page.close();
  });
});
