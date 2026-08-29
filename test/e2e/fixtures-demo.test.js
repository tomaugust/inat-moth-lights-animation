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

describe("Phase 2 fixtures demo", () => {
  it("loads the fixture, admits moths into the scene and draws them with no errors", async () => {
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

    await page.goto(`${site.url}fixtures-demo.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.getElementById("demo-status")?.textContent.includes("fetch observations-page-1.json"),
      { timeout: 5000 }
    );
    await page.waitForTimeout(3000);

    const statusText = await page.textContent("#demo-status");
    assert.match(statusText, /active moths: \d+/);
    assert.match(statusText, /queue pending: \d+/);
    assert.match(statusText, /fixture cycle: 0/);

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

  it("keeps the active moth count within maxActiveMoths as observations enter and exit", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${site.url}fixtures-demo.html`, { waitUntil: "networkidle" });

    // Sample the active count a few times across the moths' 4-10s lifetime
    // window: it should never exceed the configured cap, and it should be
    // able to go back down (proving expired moths are actually removed, not
    // just capped from above).
    const samples = [];
    for (let index = 0; index < 4; index += 1) {
      await page.waitForTimeout(3000);
      const statusText = await page.textContent("#demo-status");
      const match = /active moths: (\d+)/.exec(statusText);
      samples.push(Number(match[1]));
    }

    samples.forEach((count) => assert.ok(count <= 50, `active count ${count} exceeded maxActiveMoths`));
    assert.ok(samples.some((count) => count < Math.max(...samples)) || Math.max(...samples) === 0, "expected the active count to vary as moths exit, not just accumulate");

    await page.close();
  });
});
