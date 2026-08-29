import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";

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

// This suite never makes a real request to api.inaturalist.org: every route
// to it is intercepted and answered with a canned response, so it stays fast,
// deterministic, and doesn't hit iNaturalist's real servers from CI.
async function mockInatApi(page) {
  let requestCount = 0;
  await page.route("https://api.inaturalist.org/**", async (route) => {
    requestCount += 1;
    const url = new URL(route.request().url());
    const idAbove = url.searchParams.get("id_above");
    const baseId = idAbove ? Number(idAbove) + 1 : 1000;

    const results = [1, 2, 3].map((offset) => ({
      id: baseId + offset,
      created_at: new Date(Date.now() - offset * 1000).toISOString(),
      time_observed_at: new Date(Date.now() - offset * 2000).toISOString(),
      uri: `https://www.inaturalist.org/observations/${baseId + offset}`,
      quality_grade: "needs_id",
      place_guess: "Test Region",
      taxon: { id: 100 + offset, rank: "species", name: `Testus species${offset}`, preferred_common_name: `Test Moth ${offset}` },
      photos: []
    }));

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ total_results: results.length, page: 1, per_page: 200, results })
    });
  });
  return () => requestCount;
}

describe("Phase 3 live demo (network mocked)", () => {
  it("polls the (mocked) API, admits and draws moths, and reports a live connection", async () => {
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
      if (!response.ok() && !response.url().endsWith("/favicon.ico")) {
        unexpectedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    const getRequestCount = await mockInatApi(page);

    await page.goto(`${site.url}live-demo.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("demo-status")?.textContent.includes("connection: live"), {
      timeout: 5000
    });
    await page.waitForTimeout(2000);

    const statusText = await page.textContent("#demo-status");
    assert.match(statusText, /connection: live/);
    assert.match(statusText, /active moths: [1-9]/, "expected at least one moth admitted from the mocked batch");
    assert.equal(getRequestCount(), 1, "only the first poll should have fired within this short window");

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
    assert.ok(canvasHasContent);

    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedResponses, []);
    await page.close();
  });

  it("recovers to a quiet/live state after a mocked 429, without crashing", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let requestCount = 0;
    await page.route("https://api.inaturalist.org/**", async (route) => {
      requestCount += 1;
      if (requestCount === 1) {
        await route.fulfill({ status: 429, headers: { "Retry-After": "1" }, body: "" });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total_results: 0, page: 1, per_page: 200, results: [] })
      });
    });

    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${site.url}live-demo.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("demo-status")?.textContent.includes("connection: rate-limited"), {
      timeout: 5000
    });

    assert.deepEqual(errors, [], "a rate-limited response should not throw");
    await page.close();
  });
});
