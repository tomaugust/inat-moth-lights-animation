import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";
import { stubGeolocation } from "../helpers/geolocation.mjs";

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

// Neither test ever makes a real request to api.inaturalist.org: the
// observations poll and the places/nearby lookup are both intercepted and
// answered with canned responses, same as the rest of the live-demo suite.
async function mockObservations(page) {
  await page.route("https://api.inaturalist.org/v2/observations**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ total_results: 0, page: 1, per_page: 200, results: [] })
    });
  });
}

async function mockPlacesNearby(page, { standard = [], community = [] } = {}) {
  await page.route("https://api.inaturalist.org/v1/places/nearby**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total_results: standard.length + community.length,
        page: 1,
        per_page: 20,
        results: { standard, community }
      })
    });
  });
}

describe("live demo: geolocation-resolved country", () => {
  it("shows the country resolved from the browser's granted location", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await stubGeolocation(page, { latitude: 51.5074, longitude: -0.1278 });
    await mockPlacesNearby(page, {
      standard: [
        { id: 97391, name: "Europe", admin_level: -10 },
        { id: 6857, name: "United Kingdom", admin_level: 0 }
      ]
    });
    await mockObservations(page);

    await page.goto(`${site.url}live-demo.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("demo-status")?.textContent.includes("location:"), {
      timeout: 5000
    });

    const statusText = await page.textContent("#demo-status");
    assert.match(statusText, /location: United Kingdom \(from your browser's location\)/);

    await page.close();
  });

  it("falls back to the UK default when the location permission is denied", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await stubGeolocation(page, { error: { code: 1, message: "User denied Geolocation" } });
    await mockPlacesNearby(page);
    await mockObservations(page);

    await page.goto(`${site.url}live-demo.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("demo-status")?.textContent.includes("location:"), {
      timeout: 5000
    });

    const statusText = await page.textContent("#demo-status");
    assert.match(statusText, /location: United Kingdom \(default — location permission was denied\)/);

    await page.close();
  });
});
