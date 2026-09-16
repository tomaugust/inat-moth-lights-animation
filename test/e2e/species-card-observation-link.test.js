import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";

const API_URL = "https://api.inaturalist.org/v2/observations";
// The real client appends ?place_id=<resolved country> — see app.js's
// resolveUserPlace() wiring.
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

// The "has a thumbnail and a working link" case is already covered by
// site.test.js's live-moth test; this file focuses on the regression case —
// an observation with no photo (or an unlicensed one) must hide the
// thumbnail without breaking the observation link, which iNaturalist always
// provides regardless of whether there's a usable photo.
describe("active moth cards: hides the thumbnail (only) when an observation has no photo", () => {
  it("hides the thumbnail but still shows the observation link for a moth with no image/license data", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const nowIso = new Date().toISOString();
    await page.route(API_URL_PATTERN, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total_results: 1,
          page: 1,
          per_page: 200,
          results: [
            {
              id: 1,
              created_at: nowIso,
              observed_on: nowIso.slice(0, 10),
              time_observed_at: nowIso,
              uri: "https://www.inaturalist.org/observations/1",
              quality_grade: "needs_id",
              place_guess: "Test Location, UK",
              taxon: { id: 111, rank: "species", name: "Nomo photonis", preferred_common_name: "No Photo Moth" },
              photos: []
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
