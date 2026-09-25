import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { startStaticServer } from "../helpers/static-server.mjs";
import { hashString, seededUnit } from "../../src/animation-engine.js";
import { MothStore } from "../../src/moth-store.js";
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

describe("moths.live site", () => {
  it("shows just the description on the main screen — no heading — and moths.live as the page title", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [] });
    await page.goto(site.url, { waitUntil: "networkidle" });

    assert.equal(await page.title(), "moths.live");
    assert.equal(await page.locator("h1").count(), 0, "there should be no visible heading");
    assert.equal(await page.locator("#animation-title").count(), 0);
    assert.equal(
      await page.locator("#animation-description").textContent(),
      "This animation shows observations of moths around the world in real time. Each moth represents a real moth observed on iNaturalist somewhere in the world"
    );

    await page.close();
  });

  it("links the author credit and the favicon", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [] });
    await page.goto(site.url, { waitUntil: "networkidle" });

    assert.equal(await page.locator(".credit").textContent(), "Created by Tom August");
    assert.equal(await page.locator(".credit a").getAttribute("href"), "https://www.ceh.ac.uk/staff/tom-august");
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "favicon.svg");
    const favicon = await page.request.get(new URL("favicon.svg", site.url).href);
    assert.equal(favicon.status(), 200);
    assert.equal(favicon.headers()["content-type"], "image/svg+xml");

    await page.close();
  });

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

  it("shows on each side-panel card the upload time, identification level, place and credit, with a large photo — and ignores when the moth was photographed", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const uploaded = new Date();
    const photographedEarlier = new Date(uploaded.getTime() - 3 * 24 * 60 * 60 * 1000);
    await mockObservationsApi(page, {
      results: [
        rawObservation({
          created_at: uploaded.toISOString(),
          time_observed_at: photographedEarlier.toISOString(),
          observed_on: photographedEarlier.toISOString().slice(0, 10)
        })
      ]
    });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);
    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    const card = page.locator(".active-moths-card").first();
    assert.match(await card.locator(".active-moths-card__name").textContent(), /Test Moth/);
    const clock = (date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const shown = await card.locator(".active-moths-card__uploaded").textContent();
    assert.ok(
      shown === "Uploaded " + clock(uploaded) || shown === "Uploaded " + clock(new Date(uploaded.getTime() + 60000)),
      "expected the upload time (" + clock(uploaded) + "), saw " + shown
    );
    assert.equal(await card.locator(".active-moths-card__identification").textContent(), "Identified to species");
    assert.equal(await card.locator(".active-moths-card__place").textContent(), "Observed near Test Location, UK");
    assert.equal(await card.locator(".active-moths-card__credit").textContent(), "CC-BY-NC · (c) Test Person, some rights reserved (CC BY-NC)");
    assert.doesNotMatch(await card.textContent(), /photographed/i, "the photographed time should not appear anywhere");

    const thumb = await card.locator(".active-moths-card__thumb").boundingBox();
    assert.ok(thumb.width >= 250 && thumb.height >= 150, "the photo should be large, saw " + thumb.width + "x" + thumb.height);

    await page.close();
  });

  it("gives every moth a card, including one identified only to family level, showing exactly that", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, {
      results: [
        rawObservation({
          id: 5001,
          taxon: { id: 47254, rank: "family", name: "Noctuidae", preferred_common_name: "Owlet Moths" }
        })
      ]
    });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);
    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    const card = page.locator(".active-moths-card").first();
    assert.equal(await card.locator(".active-moths-card__name").textContent(), "Owlet Moths");
    assert.equal(await card.locator(".active-moths-card__identification").textContent(), "Identified to family");

    await page.close();
  });

  it("never squashes cards when several are open: each keeps all its content and the list gets a visible vertical scrollbar", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const now = Date.now();
    const results = [8, 6, 4, 2].map((secondsAgo, index) =>
      rawObservation({ id: 6000 + index, created_at: new Date(now - secondsAgo * 1000).toISOString() })
    );
    await mockObservationsApi(page, { results });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);
    await page.click("#active-moths-toggle");
    await page.mouse.move(5, 5); // hovering a card would freeze the scene
    await page.waitForFunction(() => document.querySelectorAll(".active-moths-card:not(.is-leaving)").length >= 3, null, { timeout: 30000 });
    await page.waitForTimeout(1200); // let the entry transition finish

    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll(".active-moths-card:not(.is-leaving)")]
        .filter((card) => card.scrollHeight > card.clientHeight + 1)
        .map((card) => card.dataset.mothId + " (content " + card.scrollHeight + "px in a card " + card.clientHeight + "px tall)")
    );
    assert.deepEqual(clipped, [], "cards were squashed so their content is cut off");

    // ...and the overflow is handled by a visible vertical scrollbar on the list.
    const list = await page.evaluate(() => {
      const el = document.getElementById("active-moths-list");
      const style = window.getComputedStyle(el);
      return { scrollable: el.scrollHeight > el.clientHeight, overflowY: style.overflowY, scrollbarWidth: style.scrollbarWidth };
    });
    assert.equal(list.scrollable, true, "with several tall cards the list should be taller than the panel and scroll");
    assert.equal(list.overflowY, "scroll", "the scrollbar should always be shown");
    assert.equal(list.scrollbarWidth, "auto", "a full-size scrollbar, not the barely-visible thin one");

    await page.close();
  });

  it("darkens the map towards its edges (the map only), leaving its middle untouched", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [] });
    await page.goto(site.url, { waitUntil: "networkidle" });

    // Render the map layer directly, twice — with and without the vignette —
    // and compare the same land pixels (read from the map's own canvas, so
    // the light's glow and the moths can't affect the result). Land is
    // #161616 (22) on a #050505 (5) background.
    const result = await page.evaluate(async () => {
      const world = await import("/src/world-map.js");
      const { createMapProjector } = await import("/src/robinson-projection.js");
      const borders = await world.loadWorldBorders();
      const width = 1280;
      const height = 800;
      const projector = createMapProjector({ width, height, offsetX: width / 2, offsetY: height * 0.56, padding: 24 });
      const withVignette = world.renderMapToOffscreenCanvas(borders, projector, width, height);
      const withoutVignette = world.renderMapToOffscreenCanvas(borders, projector, width, height, { vignette: false });
      const sample = (canvas, lon, lat) => {
        const { x, y } = projector.project([lon, lat]);
        const data = canvas.getContext("2d").getImageData(Math.round(x) - 2, Math.round(y) - 2, 5, 5).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += data[i];
        return sum / 25;
      };
      return {
        centreWith: sample(withVignette, 20, 5), // central Africa
        centreWithout: sample(withoutVignette, 20, 5),
        edgeWith: sample(withVignette, -152, 64), // Alaska, near the map's edge
        edgeWithout: sample(withoutVignette, -152, 64)
      };
    });

    assert.ok(result.edgeWithout > 15 && result.centreWithout > 15, "expected both sample points to be land: " + JSON.stringify(result));
    assert.ok(result.edgeWith < result.edgeWithout * 0.5, "land near the edge should be darkened: " + JSON.stringify(result));
    assert.ok(Math.abs(result.centreWith - result.centreWithout) < 1, "the middle of the map should be untouched: " + JSON.stringify(result));

    await page.close();
  });

  it("flaps the moths' wings even when the system asks for reduced motion", async () => {
    // A machine with Windows animations switched off reports "prefers-reduced-
    // motion: reduce"; the wings once stood still under it, so on such a
    // machine the moths never flapped at all.
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    assert.equal(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    await page.addInitScript(() => {
      window.__wingScales = [];
      const scale = window.CanvasRenderingContext2D.prototype.scale;
      window.CanvasRenderingContext2D.prototype.scale = function (x, y) {
        // A wing is drawn under scale(1, thickness): its height folds and opens as it
        // flaps. (The body's own scale is (facing, 1), so it never matches.)
        if (x === 1 && y !== 1) {
          window.__wingScales.push(y);
        }
        return scale.call(this, x, y);
      };
    });
    await mockObservationsApi(page, { results: [rawObservation()] });
    await page.goto(site.url, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    await page.click("#launch-switch");
    await page.waitForFunction(() => document.querySelector("#loading-status").classList.contains("is-hidden"));
    await page.waitForTimeout(3000); // let the moth arrive and start orbiting
    await page.evaluate(() => {
      window.__wingScales = [];
    });
    await page.waitForTimeout(1500);

    // Each wing is drawn with a vertical scale that swings from about +1 (raised)
    // through 0 (folded flat against the body) to about -0.6 (hanging below it).
    const wingScales = await page.evaluate(() => window.__wingScales);
    assert.ok(wingScales.length > 20, "expected the moth's wings to be drawn, saw " + wingScales.length + " wing draws");
    const distinct = new Set(wingScales.map((y) => y.toFixed(3))).size;
    assert.ok(distinct > 20, "the wings should be flapping, but saw only " + distinct + " distinct wing heights: they are held still");
    assert.ok(Math.max(...wingScales) - Math.min(...wingScales) > 1, "the flap should be a big fold-and-open");

    await page.close();
  });

  it("renders the arrival woooow as a deep tone that fades out as the ripple ring does", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [] });
    await page.goto(site.url, { waitUntil: "networkidle" });

    // Render one voice offline in the browser's real Web Audio engine, driven
    // exactly as the app drives it (age 0 to a little past the ripple), and
    // measure the samples.
    const measured = await page.evaluate(async () => {
      const audio = await import("/src/audio-engine.js");
      const world = await import("/src/world-map.js");
      const sampleRate = 22050;
      const context = new window.OfflineAudioContext(1, sampleRate * 4, sampleRate);
      const voice = audio.createArrivalVoice(context, context.destination, audio.noteToFrequency("C2"), 0);
      for (let age = 0; age <= world.RIPPLE_DURATION_SECONDS + 0.4; age += 0.01) {
        voice.apply(age, age, 1);
      }
      voice.stop(world.RIPPLE_DURATION_SECONDS + 0.5);
      const data = (await context.startRendering()).getChannelData(0);
      const rms = (from, to) => {
        let sum = 0;
        const a = Math.floor(from * sampleRate);
        const b = Math.floor(to * sampleRate);
        for (let i = a; i < b; i += 1) sum += data[i] * data[i];
        return Math.sqrt(sum / (b - a));
      };
      let crossings = 0;
      const start = Math.floor(0.3 * sampleRate);
      const end = Math.floor(1.3 * sampleRate);
      for (let i = start + 1; i < end; i += 1) if ((data[i - 1] < 0) !== (data[i] < 0)) crossings += 1;
      let peak = 0;
      for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
      return {
        first20ms: rms(0, 0.02),
        early: rms(0.15, 0.4),
        middle: rms(1.0, 1.3),
        late: rms(2.0, 2.3),
        end: rms(2.85, 3.0),
        after: rms(3.2, 3.9),
        crossingsPerSecond: crossings / 1.0,
        peak,
        duration: world.RIPPLE_DURATION_SECONDS
      };
    });

    assert.ok(measured.early > 0.02, "should be clearly audible: " + JSON.stringify(measured));
    assert.ok(measured.first20ms < measured.early * 0.4, "should swell in, not click: " + JSON.stringify(measured));
    assert.ok(measured.middle < measured.early && measured.late < measured.middle && measured.end < measured.late, "should keep fading: " + JSON.stringify(measured));
    assert.ok(measured.after < 0.002, "silent once the ring has gone: " + JSON.stringify(measured));
    assert.ok(measured.crossingsPerSecond < 700, "should be a deep tone, not a high one: " + JSON.stringify(measured));
    assert.ok(measured.peak < 0.9, "should not clip: " + JSON.stringify(measured));

    await page.close();
  });

  it("plays the arrival woooow when a new moth appears with the sound on (and nothing before it is on)", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      // The woooow is the only thing that uses a sawtooth oscillator (the chimes
      // and the drone are sines): count them.
      window.__sawtoothStarts = 0;
      const start = window.OscillatorNode.prototype.start;
      window.OscillatorNode.prototype.start = function (...args) {
        if (this.type === "sawtooth") window.__sawtoothStarts += 1;
        return start.apply(this, args);
      };
    });
    await mockPhotoHost(page);
    await page.route(API_URL_PATTERN, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500)); // the moth arrives well after we switch sound on
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total_results: 1, page: 1, per_page: 200, results: [rawObservation()] })
      });
    });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2200);
    assert.equal(await page.evaluate(() => window.__sawtoothStarts), 0, "nothing plays before the sound is on");
    await page.click("#sound-toggle");
    await page.waitForFunction(() => document.querySelector("#loading-status").classList.contains("is-hidden"), null, { timeout: 8000 });
    await page.waitForTimeout(1000);
    assert.ok((await page.evaluate(() => window.__sawtoothStarts)) >= 1, "expected a woooow when the moth arrived with the sound on");

    await page.close();
  });

  it("keeps every line of the hover pop-out inside its box, however long the name, place and credit are", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, {
      results: [
        rawObservation({
          id: 5002,
          place_guess: "A Very Long Place Name, With Many Parts, In Some Remote Region, Of Some Far Away Country",
          taxon: { id: 61234, rank: "species", name: "Extraordinarius longissimus", preferred_common_name: "Extraordinarily Long-Winged Speckled Brown Woodland Moth" },
          photos: [
            {
              id: 1,
              url: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg",
              attribution: "(c) Bartholomew-Christopherson-Wolfeschlegelsteinhausenbergerdorff, some rights reserved (CC BY-NC-SA)",
              license_code: "cc-by-nc-sa"
            }
          ]
        })
      ]
    });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);
    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    // Record, from inside the page, the pop-out's box edges and every line of
    // text drawn on top of it. Its box is the one filled with this exact
    // translucent black; its four corners are quadratic curves whose control
    // points sit on the box's edges.
    await page.evaluate(() => {
      const proto = window.CanvasRenderingContext2D.prototype;
      const state = { quads: [], boxes: [], texts: [] };
      window.__popout = state;
      const { beginPath, quadraticCurveTo, fill, fillText } = proto;
      proto.beginPath = function () {
        state.quads = [];
        return beginPath.call(this);
      };
      proto.quadraticCurveTo = function (cx, cy, x, y) {
        state.quads.push([cx, cy, x, y]);
        return quadraticCurveTo.call(this, cx, cy, x, y);
      };
      proto.fill = function (...args) {
        if (this.fillStyle === "rgba(8, 8, 10, 0.72)" && state.quads.length === 4) {
          const xs = state.quads.map((q) => q[0]);
          const ys = state.quads.map((q) => q[1]);
          state.boxes = [{ left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }];
          state.texts = [];
        }
        return fill.apply(this, args);
      };
      proto.fillText = function (text, x, y, ...rest) {
        if (state.boxes.length > 0) {
          state.texts.push({ text, x, y, width: this.measureText(text).width });
        }
        return fillText.call(this, text, x, y, ...rest);
      };
    });

    await page.locator(".active-moths-card").first().hover();
    await page.waitForTimeout(800);

    const { boxes, texts } = await page.evaluate(() => window.__popout);
    assert.equal(boxes.length, 1, "expected the pop-out to have been drawn");
    const box = boxes[0];
    assert.ok(texts.length >= 4, "expected several lines of text in the pop-out, saw " + texts.length);
    for (const line of texts) {
      assert.ok(line.x >= box.left, JSON.stringify(line.text) + " starts left of the box");
      assert.ok(
        line.x + line.width <= box.right - 8,
        JSON.stringify(line.text) + " runs out of the box (right edge " + box.right + ", text ends at " + (line.x + line.width) + ")"
      );
      assert.ok(line.y <= box.bottom, JSON.stringify(line.text) + " is below the box");
    }

    await page.close();
  });

  it("never lets the scene go empty: the only moth stays instead of leaving, even well past its stay", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // A moth's stay is fixed per observation id (between the store's min and
    // max, 24-60s), so use an id whose stay is very nearly the shortest
    // possible rather than waiting out a whole minute. The check below is
    // what tells you if the store's numbers change and this needs a new id.
    const SHORT_STAY_ID = 8583;
    const { minMothDurationSeconds, maxMothDurationSeconds } = new MothStore().options;
    const stayLimit = minMothDurationSeconds + (maxMothDurationSeconds - minMothDurationSeconds) * seededUnit(hashString("inat-" + SHORT_STAY_ID), 999);
    assert.ok(stayLimit < minMothDurationSeconds + 2, "id " + SHORT_STAY_ID + " no longer has a short stay (" + stayLimit.toFixed(1) + "s) — pick another");
    await mockObservationsApi(page, { results: [rawObservation({ id: SHORT_STAY_ID })] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForTimeout(2000);
    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });

    // Hovering a card freezes the whole scene (so nothing could leave for
    // the wrong reason): move the pointer well clear of the panel first.
    await page.mouse.move(5, 5);
    assert.equal(await page.locator(".active-moths-card").first().evaluate((el) => el.classList.contains("is-focused")), false);

    // With nothing to replace it, it must still be here — visible, not
    // mid-exit — well after its stay is up.
    await page.waitForTimeout((Math.ceil(stayLimit) + 8) * 1000);
    const cards = page.locator(".active-moths-card:not(.is-leaving)");
    assert.equal(await cards.count(), 1, "the only moth should still be in the scene");

    await page.close();
  });

  // A moth's origin is marked on the map by its rings (the arrival ripple, then a
  // small breathing ring); hovering one focuses the same moth as its card. The
  // ring's exact screen position is computed here with the same
  // createMapProjector() app.js itself uses (same viewport size, same
  // centerYRatio from config/site-config.json, same padding), rather than
  // assumed or eyeballed.
  it("hovering a moth's ring on the world map focuses the same moth as its card", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [rawObservation()] });

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");
    await page.waitForFunction(() => document.querySelector("#loading-status").classList.contains("is-hidden"));
    await page.click("#active-moths-toggle");
    await page.waitForSelector(".active-moths-card", { timeout: 5000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(3600); // the arrival ripple is over; the small breathing ring is what remains

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

    assert.equal(await page.locator(".active-moths-card").first().evaluate((el) => el.classList.contains("is-focused")), false, "not focused before hovering");
    await page.mouse.move(canvasRect.left + point.x, canvasRect.top + point.y);
    await page.waitForTimeout(300);

    assert.equal(
      await page.locator(".active-moths-card").first().evaluate((el) => el.classList.contains("is-focused")),
      true,
      "expected hovering the moth's ring to focus the same moth as its card"
    );

    // Moving off it lets go again.
    await page.mouse.move(canvasRect.left + 30, canvasRect.top + canvasRect.height - 30);
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".active-moths-card").first().evaluate((el) => el.classList.contains("is-focused")), false);

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

  it("ends the loading state as soon as the first response arrives — there is no minimum display time", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mockObservationsApi(page, { results: [rawObservation()] }); // resolves essentially immediately

    await page.goto(site.url, { waitUntil: "networkidle" });
    await page.click("#launch-switch");

    // The old 3s minimum would still have this up well past 2s.
    await page.waitForSelector("#loading-status.is-hidden", { timeout: 2000 });
    assert.equal(await page.locator(".canvas-shell").evaluate((el) => el.classList.contains("is-loading")), false);

    await page.close();
  });

  it("greys out the scene and shows a spinner around the light while loading — the light does not flicker — then restores everything once data arrives", async () => {
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

    const styleOf = (selector, property) =>
      page.evaluate(([sel, prop]) => window.getComputedStyle(document.querySelector(sel))[prop], [selector, property]);

    // The spinner and its caption only appear once the launch animation has
    // finished revealing the controls.
    await page.waitForFunction(() => parseFloat(window.getComputedStyle(document.getElementById("loading-spinner")).opacity) > 0.99, null, { timeout: 5000 });
    assert.equal(await page.locator(".canvas-shell").evaluate((el) => el.classList.contains("is-loading")), true);
    assert.match(await styleOf("#orbit-canvas", "filter"), /grayscale/, "the whole scene should be greyed out while loading");
    assert.match(await page.locator("#loading-status").textContent(), /loading/i);

    // The spinner is a ring around the light: centred on the bulb (horizontal
    // centre, centerYRatio 0.56 down the screen) and wider than the bulb.
    const box = await page.locator("#loading-spinner").boundingBox();
    assert.ok(Math.abs(box.x + box.width / 2 - 640) < 2 && Math.abs(box.y + box.height / 2 - 448) < 2, "spinner should be centred on the light, saw " + JSON.stringify(box));
    assert.ok(box.width > 36 + 20, "the ring should be clearly wider than the 36px bulb, saw " + box.width);

    // No flashing: the light's centre pixel (the bulb itself, which the
    // ambient shimmer never touches) stays put across a full second of
    // samples, where the old loading effect swung it by hundreds.
    const samples = [];
    for (let i = 0; i < 20; i += 1) {
      samples.push(
        await page.evaluate(() => {
          const canvas = document.getElementById("orbit-canvas");
          const [r, g, b] = canvas.getContext("2d").getImageData(Math.round(canvas.width / 2), Math.round(canvas.height * 0.56), 1, 1).data;
          return r + g + b;
        })
      );
      await page.waitForTimeout(50);
    }
    const range = Math.max(...samples) - Math.min(...samples);
    assert.ok(range < 30, "expected a steady light while loading, saw range " + range + " (samples: " + samples + ")");

    // Data arrives: everything is restored.
    await page.waitForSelector("#loading-status.is-hidden", { timeout: 9000 });
    assert.equal(await page.locator(".canvas-shell").evaluate((el) => el.classList.contains("is-loading")), false);
    await page.waitForFunction(() => window.getComputedStyle(document.getElementById("orbit-canvas")).filter === "none", null, { timeout: 3000 });
    await page.waitForFunction(() => parseFloat(window.getComputedStyle(document.getElementById("loading-spinner")).opacity) < 0.01, null, { timeout: 3000 });

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
