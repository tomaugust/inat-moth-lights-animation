import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SAMPLE_IMAGE_URL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7";
const SAMPLE_OBSERVATION_URL = "https://www.inaturalist.org/observations/999999";

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

describe("active moth cards: iNaturalist thumbnail and observation link", () => {
  it("shows the observation's thumbnail and links through to it when a moth carries that data", async () => {
    const config = JSON.parse(await fs.readFile(path.join(rootDir, "config/site-config.json"), "utf8"));
    config.moths = config.moths.map((moth, index) =>
      index === 0
        ? { ...moth, entryTime: 0, exitTime: 500, imageURL: SAMPLE_IMAGE_URL, observationUrl: SAMPLE_OBSERVATION_URL }
        : moth
    );

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/config/site-config.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) })
    );

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(6000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card__thumb:not([hidden])", { timeout: 5000 });

    const thumbSrc = await page.getAttribute(".active-moths-card__thumb:not([hidden])", "src");
    assert.equal(thumbSrc, SAMPLE_IMAGE_URL);

    const link = page.locator(".active-moths-card__link:not([hidden])").first();
    assert.equal(await link.getAttribute("href"), SAMPLE_OBSERVATION_URL);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");

    await page.close();
  });

  it("hides the thumbnail and link for moths with no observation data, e.g. the default demo config", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(6000);

    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    assert.equal(await page.locator(".active-moths-card__thumb:not([hidden])").count(), 0);
    assert.equal(await page.locator(".active-moths-card__link:not([hidden])").count(), 0);

    await page.close();
  });
});
