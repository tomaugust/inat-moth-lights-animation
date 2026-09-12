import { config, setConfig } from "./config-store.js";
import { drawScene, projectMoth } from "./animation-engine.js";
import { setupAudio } from "./audio-engine.js";
import { ObservationQueue } from "./observation-queue.js";
import { MothStore } from "./moth-store.js";
import { CONNECTION_STATES, DEFAULT_PLACE_ID, InatClient } from "./inaturalist-client.js";
import { FALLBACK_COUNTRY_NAME, resolveUserPlace } from "./geolocation.js";
import { parseObservationsResponse } from "./observation-adapter.js";
import { FALLBACK_COUNTRY_NAME as FALLBACK_DATASET_COUNTRY, FALLBACK_OBSERVATIONS } from "./fallback-observations.js";

// The production site's one and only data source: the deployed Cloudflare
// Worker adapter (worker/src/index.js), never api.inaturalist.org directly —
// that's what gives every visitor a real User-Agent and a shared cache
// instead of N independent browsers hammering iNaturalist. The Worker
// caches per place_id (see contractKey() in worker/src/index.js), so each
// visitor's own resolved country (resolveUserPlace(), below) is its own
// independently-refreshed entry, not a redesign.
const WORKER_OBSERVATIONS_URL = "https://inat-moth-lights-adapter.tomaugust1985.workers.dev/observations";

// The last line of defense: a small, bundled-in-the-app dataset of real
// iNaturalist observations (see fallback-observations.js), shown only when a
// fresh page load can't get live data from anywhere — not the Worker's short
// cache, not its 7-day stale-backup either (worker/src/index.js). Normalized
// once here (module load), not per fallback trigger, since it never changes.
const FALLBACK_NORMALIZED_OBSERVATIONS = parseObservationsResponse({ observations: FALLBACK_OBSERVATIONS }).observations;

// The loading flicker/text always stays up at least this long, even if the
// real response comes back almost instantly — see startClientForPlace's
// hideLoadingNoSoonerThanMinimumDuration().
const MIN_LOADING_DURATION_MS = 3000;

function countryHeading(countryName) {
  return countryName === FALLBACK_COUNTRY_NAME ? "UK Moths" : `${countryName} Moths`;
}

function countryDescription(countryName) {
  const place = countryName === FALLBACK_COUNTRY_NAME ? "the United Kingdom" : countryName;
  return `A living view of moth sightings recently shared on iNaturalist across ${place} — recently shared records, not real-time abundance or movement.`;
}

// Shown in #debug-status purely so a screenshot from a real device proves
// which deployed build that browser is actually running, rather than leaving
// it ambiguous whether a cached older bundle is being served.
const BUILD_ID = "2026-09-09a";

// A failing fetch tells a browser page almost nothing: a CORS rejection, a
// DNS/filter block and a refused connection are all the same opaque
// TypeError. A no-cors request does distinguish them — it resolves (with an
// unreadable opaque response) whenever the request actually reached the
// server, and only rejects when the network itself couldn't. So: normal
// fetch fails + this succeeds => CORS; both fail => the host is unreachable
// from that device/network (worker.dev subdomains are a common target for
// DNS-level filtering). Read only through #debug-status.
async function probeAdapterReachability() {
  try {
    await fetch(WORKER_OBSERVATIONS_URL, { mode: "no-cors", cache: "no-store" });
    return "reachable-so-cors-blocked";
  } catch (error) {
    return `unreachable-${error.name}`;
  }
}

function formatObservedTime(observedAtMs) {
  if (!Number.isFinite(observedAtMs)) {
    return "";
  }
  return new Date(observedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setupOrbitAnimation(initialPresentationMode = "normal") {
  const canvas = document.getElementById("orbit-canvas");
  const context = canvas.getContext("2d");
  const activeMothsToggle = document.getElementById("active-moths-toggle");
  const activeMothsPanel = document.getElementById("active-moths-panel");
  const activeMothsList = document.getElementById("active-moths-list");
  const loadingStatus = document.getElementById("loading-status");
  const fallbackStatus = document.getElementById("fallback-status");
  // Hidden by default — this diagnostic readout was added to debug a real
  // production incident and was never meant for every visitor to see. Opt
  // in with ?debug on the URL for troubleshooting a future report.
  const debugStatus = new URLSearchParams(window.location.search).has("debug")
    ? document.getElementById("debug-status")
    : null;
  const animationTitle = document.getElementById("animation-title");
  const animationDescription = document.getElementById("animation-description");
  const audio = setupAudio();

  // Deliberately in-memory only (no storage option) — the Worker adapter is
  // stateless and returns the *entire* current 24h window on every poll,
  // never an incremental delta. ObservationQueue's seen-ID dedup already
  // (correctly) prevents re-enqueuing the same observation across polls
  // within this one page's lifetime; persisting that dedup to localStorage
  // across page loads (the option other callers use for a resumable
  // cursor-based feed) would instead permanently blacklist every
  // observation this browser has ever been shown, since the rolling 24h
  // window mostly re-returns the same IDs on a later visit — silently
  // starving a returning visitor of almost everything. A fresh load should
  // replay the current window from scratch, matching the intended
  // "living view" experience.
  // Reassigned (not just mutated) if resolveUserPlace() later swaps to a
  // different country than the default this starts with — see below. `let`
  // rather than `const` because every downstream reader (tick, the side
  // panel, hit-testing) closes over this binding, so reassigning it here is
  // what makes them all pick up the fresh queue/store on their next call.
  let queue = new ObservationQueue();
  let store = new MothStore();
  // A false autoplay is the one remaining kill-switch: the scene loads (just
  // the light, in whichever presentation mode) but never admits a moth. Real
  // network polling still runs in the background regardless — see the
  // launch-screen note on why that's deliberate.
  const isLive = config.animation.autoplay !== false;

  let lastTimestamp = null;
  // Set while a moth is hovered/focused (canvas or side-panel card — both
  // funnel through hoverState.hoveredMothId), holding the render clock at
  // the instant focus began so the whole scene visibly stops rather than
  // just keeping the focused moth alive a little longer past its exit.
  // Real data ingestion (the network poll, ObservationQueue) is untouched —
  // only rendering and moth admission/expiry pause; anything that arrives
  // while frozen is simply admitted the moment focus clears.
  let frozenTimestamp = null;
  let frozenSeconds = null;
  // performance.now() (and therefore nowSeconds()) never actually stops —
  // "frozen" only ever meant "keep returning this one constant value" above,
  // not "the clock itself paused". So the instant a freeze ended, the live
  // clock had already run on ahead by however long the hover lasted, and the
  // very next frame jumped straight to that real elapsed time — every active
  // moth's position/age (all computed from currentSceneSeconds() minus its
  // own entryTime, which was stamped before the freeze) suddenly leapt
  // forward by the freeze's real duration instead of resuming smoothly from
  // where it visibly stopped.
  //
  // Fixed with a running offset: every completed freeze adds its own real
  // duration to freezeOffsetSeconds/Ms, and currentSceneSeconds()/
  // currentRenderTimestamp() subtract that offset from the live clock
  // whenever not currently frozen. freezeBeganAtRealSeconds/Ms mark when the
  // *current* freeze (if any) started, purely to compute that duration once
  // it ends — see tick()'s isFrozen handling.
  let freezeOffsetSeconds = 0;
  let freezeOffsetMs = 0;
  let freezeBeganAtRealSeconds = null;
  let freezeBeganAtRealMs = null;
  // Captured at the same instant as frozenTimestamp/frozenSeconds (see
  // tick()) so a freeze that happens to straddle the loading→loaded
  // transition still holds the light's appearance constant too — isLoading
  // isn't driven by the frozen render clock (it's read straight off the DOM,
  // see isLoadingData() below), so without capturing it here specifically, a
  // scene could still visibly change while "frozen" at the exact moment the
  // loading indicator's minimum display duration (see startClientForPlace)
  // elapses mid-hover.
  let frozenIsLoading = null;
  let presentationMode = initialPresentationMode;
  const canHover = window.matchMedia
    ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
    : true;
  const hoverState = {
    hoveredMothId: null,
    imageCache: new Map()
  };
  const activeCardRecords = new Map();
  const cardExitDelay = 1600;

  function nowSeconds() {
    return performance.now() / 1000;
  }

  // Derived from loadingStatus's own visibility rather than a separate flag,
  // so the light's flicker (see drawScene's isLoading) can never drift out
  // of sync with the loading text — both a country switch showing it again
  // and the initial load before any client exists (no "is-hidden" class yet)
  // are naturally "loading" by this same definition.
  function isLoadingData() {
    return Boolean(loadingStatus && !loadingStatus.classList.contains("is-hidden"));
  }

  // The single source of truth for "what instant is the scene showing right
  // now" — every reader of scene state (rendering, hit-testing, the side
  // panel list) must agree on this, or a frozen canvas would visibly
  // disagree with hover hit-testing or the panel list still reordering
  // underneath it. Live time whenever nothing is focused; held at the
  // instant focus began for as long as it stays focused (see tick()).
  function currentSceneSeconds() {
    return frozenSeconds !== null ? frozenSeconds : nowSeconds() - freezeOffsetSeconds;
  }

  function currentRenderTimestamp() {
    return frozenTimestamp !== null ? frozenTimestamp : performance.now() - freezeOffsetMs;
  }

  // See frozenIsLoading's own comment above for why this can't just be
  // isLoadingData() directly while frozen.
  function currentIsLoading() {
    return frozenIsLoading !== null ? frozenIsLoading : isLoadingData();
  }

  function activeProjectedKnownMoths() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;
    const t = currentSceneSeconds();

    return store.getActiveMoths()
      .map((moth) => projectMoth(moth, t, width, height, cx, cy, false))
      .filter((moth) => moth && moth.species !== "unknown" && moth.opacity > 0.02)
      .sort((a, b) => a.entryTime - b.entryTime);
  }

  // Hovering/focusing a moth (canvas or side-panel card) freezes the whole
  // scene at the instant focus began — see tick()'s isFrozen handling and
  // currentSceneSeconds() above, which every other reader of "now" (hit-
  // testing, the side panel list, this redraw) also goes through so nothing
  // visibly disagrees with what's actually frozen on screen.
  function setFocusedMoth(mothId) {
    hoverState.hoveredMothId = mothId;
    canvas.style.cursor = mothId ? "pointer" : "default";
    if (mothId) {
      store.focusMoth(mothId, nowSeconds());
    }
  }

  function clearHover() {
    hoverState.hoveredMothId = null;
    canvas.style.cursor = "default";
    store.clearFocus();
  }

  function redrawNow() {
    drawScene(context, store.getActiveMoths(), canvas.clientWidth, canvas.clientHeight, currentRenderTimestamp(), currentSceneSeconds(), hoverState, presentationMode, currentIsLoading());
  }

  // The card is a wrapper around two independent controls, not one big
  // button: `.active-moths-card__focus` toggles the moth's highlight in the
  // scene (the card's original behavior), while `.active-moths-card__link`
  // navigates to the iNaturalist observation when one is known. An <a> can't
  // be nested inside a <button> (invalid content model, and unreliable
  // focus/click handling across browsers), so the two live as siblings
  // instead, with the whole card's hover area still setting scene focus.
  function createActiveMothCard(moth) {
    const card = document.createElement("div");
    card.className = "active-moths-card is-entering";
    card.dataset.mothId = moth.id;

    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.className = "active-moths-card__focus";

    const thumb = document.createElement("img");
    thumb.className = "active-moths-card__thumb";
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.hidden = true;

    const swatch = document.createElement("span");
    swatch.className = "active-moths-card__swatch";
    swatch.style.background = moth.color;
    swatch.style.color = moth.color;

    const name = document.createElement("span");
    name.className = "active-moths-card__name";
    name.textContent = moth.speciesName || moth.label || moth.id;

    const time = document.createElement("span");
    time.className = "active-moths-card__time";

    focusButton.append(thumb, swatch, name, time);

    const link = document.createElement("a");
    link.className = "active-moths-card__link";
    link.textContent = "View observation ↗";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.hidden = true;
    // Clicking through to iNaturalist is a separate action from focusing the
    // moth in the scene, so it must not also trigger the card's own
    // pointerenter/click handling below.
    link.addEventListener("pointerdown", (event) => event.stopPropagation());
    link.addEventListener("click", (event) => event.stopPropagation());

    card.append(focusButton, link);

    card.addEventListener("pointerenter", () => {
      setFocusedMoth(card.dataset.mothId);
    });
    card.addEventListener("pointerleave", () => {
      if (hoverState.hoveredMothId === card.dataset.mothId) {
        clearHover();
      }
    });
    focusButton.addEventListener("focus", () => {
      setFocusedMoth(card.dataset.mothId);
    });
    focusButton.addEventListener("blur", () => {
      if (hoverState.hoveredMothId === card.dataset.mothId) {
        clearHover();
      }
    });
    focusButton.addEventListener("click", () => {
      if (hoverState.hoveredMothId === card.dataset.mothId) {
        clearHover();
      } else {
        setFocusedMoth(card.dataset.mothId);
      }
      redrawNow();
    });

    requestAnimationFrame(() => card.classList.remove("is-entering"));
    return card;
  }

  function updateActiveMothCard(card, moth) {
    const focusButton = card.querySelector(".active-moths-card__focus");
    const name = card.querySelector(".active-moths-card__name");
    const time = card.querySelector(".active-moths-card__time");
    const swatch = card.querySelector(".active-moths-card__swatch");
    const thumb = card.querySelector(".active-moths-card__thumb");
    const link = card.querySelector(".active-moths-card__link");
    const isFocused = hoverState.hoveredMothId === moth.id;
    const displayName = moth.speciesName || moth.label || moth.id;

    card.classList.toggle("is-focused", isFocused);
    if (focusButton) {
      focusButton.setAttribute("aria-pressed", isFocused ? "true" : "false");
      focusButton.setAttribute("aria-label", "Focus " + displayName);
    }

    if (name) {
      name.textContent = displayName;
    }
    if (time) {
      time.textContent = formatObservedTime(moth.observedAtMs);
    }
    if (swatch) {
      swatch.style.background = moth.color;
      swatch.style.color = moth.color;
    }

    // dataset-guarded so a plain observation photo/link isn't re-applied on
    // every animation frame (updateActiveMothsPanel runs once per tick).
    if (thumb) {
      const nextImageUrl = moth.imageURL || "";
      if (thumb.dataset.src !== nextImageUrl) {
        thumb.dataset.src = nextImageUrl;
        if (nextImageUrl) {
          thumb.src = nextImageUrl;
          thumb.alt = displayName;
          thumb.hidden = false;
        } else {
          thumb.removeAttribute("src");
          thumb.hidden = true;
        }
      }
    }

    if (link) {
      const nextObservationUrl = moth.observationUrl || "";
      if (link.dataset.href !== nextObservationUrl) {
        link.dataset.href = nextObservationUrl;
        if (nextObservationUrl) {
          link.href = nextObservationUrl;
          link.hidden = false;
        } else {
          link.removeAttribute("href");
          link.hidden = true;
        }
      }
    }
  }

  function updateActiveMothsPanel() {
    if (!activeMothsList) {
      return;
    }

    const previousRects = new Map();
    activeCardRecords.forEach((record, mothId) => {
      if (record.card.parentElement && !record.card.classList.contains("is-leaving")) {
        previousRects.set(mothId, record.card.getBoundingClientRect());
      }
    });

    const activeMoths = activeProjectedKnownMoths();
    const activeIds = new Set(activeMoths.map((moth) => moth.id));

    activeMoths.forEach((moth, index) => {
      let record = activeCardRecords.get(moth.id);
      if (!record) {
        const card = createActiveMothCard(moth);
        record = {
          card,
          exitTimer: null
        };
        activeCardRecords.set(moth.id, record);
      }

      if (record.exitTimer) {
        clearTimeout(record.exitTimer);
        record.exitTimer = null;
      }
      record.card.classList.remove("is-leaving");
      updateActiveMothCard(record.card, moth);
      record.card.style.order = String(index);
      if (!record.card.parentElement) {
        activeMothsList.append(record.card);
      }
    });

    activeCardRecords.forEach((record, mothId) => {
      if (activeIds.has(mothId) || record.exitTimer) {
        return;
      }

      record.card.classList.add("is-leaving");
      record.exitTimer = window.setTimeout(() => {
        record.card.remove();
        activeCardRecords.delete(mothId);
        if (hoverState.hoveredMothId === mothId) {
          clearHover();
        }
      }, cardExitDelay);
    });

    requestAnimationFrame(() => {
      activeCardRecords.forEach((record, mothId) => {
        if (!record.card.parentElement || record.card.classList.contains("is-leaving") || record.card.classList.contains("is-entering")) {
          return;
        }

        const previousRect = previousRects.get(mothId);
        const currentRect = record.card.getBoundingClientRect();
        if (!previousRect) {
          return;
        }

        const deltaY = previousRect.top - currentRect.top;
        if (deltaY !== 0) {
          record.card.style.transform = `translateY(${deltaY}px)`;
          record.card.getBoundingClientRect();
          requestAnimationFrame(() => {
            record.card.style.transform = "";
          });
        }
      });
    });
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * scale));
    canvas.height = Math.max(1, Math.floor(rect.height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  // Preloads one real observation photo the first time it's admitted (rather
  // than a fixed species list, which live taxa have no relationship to), so
  // the canvas-drawn hover popout's thumbnail is ready by the time anyone
  // actually hovers it. iNaturalist's photo host sends CORS headers
  // (confirmed against inaturalist-open-data.s3.amazonaws.com), so
  // crossOrigin="anonymous" loads it without tainting the canvas.
  function preloadMothImage(imageURL) {
    if (!imageURL || hoverState.imageCache.has(imageURL)) {
      return;
    }

    const image = new Image();
    const record = { image, loaded: false, failed: false };
    hoverState.imageCache.set(imageURL, record);
    image.crossOrigin = "anonymous";
    image.addEventListener("load", () => {
      record.loaded = true;
      redrawNow();
    });
    image.addEventListener("error", () => {
      record.failed = true;
    });
    image.src = imageURL;
  }

  let lastDebugUpdateSeconds = 0;
  let probeResult = null;
  let probeStarted = false;
  // Assigned synchronously by startClientForPlace() below (called
  // immediately, before tick()/updateDebugStatus() ever run) and reassigned
  // if resolveUserPlace() later swaps to a different country.
  let client = null;
  // Handle for the pending "hide the loading indicator" timeout scheduled by
  // startClientForPlace() below — kept at this outer scope (not inside that
  // function) so a country switch can cancel a still-pending one from the
  // previous client generation before it fires and hides the *new* country's
  // still-genuinely-loading indicator early.
  let hideLoadingTimeoutHandle = null;

  function updateDebugStatus(t) {
    if (!debugStatus || !client || t - lastDebugUpdateSeconds < 0.5) {
      return;
    }
    lastDebugUpdateSeconds = t;

    const stats = client.getStats();
    const lines = [
      `build=${BUILD_ID} state=${client.state} reqs=${stats.requestCount} obs=${stats.observationsReceived}`,
      `pending=${queue.pendingCount} seen=${queue.seenIds.size} active=${store.getActiveMoths().length}`
    ];
    if (client.lastError) {
      lines.push(`err=${client.lastError}`);
    }
    if (probeResult) {
      lines.push(`probe=${probeResult}`);
    }
    debugStatus.textContent = lines.join("\n");
  }

  // Run the reachability probe once, the first time a poll actually fails —
  // never on the happy path, so a working page makes no extra request.
  function runReachabilityProbeOnce() {
    if (probeStarted) {
      return;
    }
    probeStarted = true;
    probeAdapterReachability().then((result) => {
      probeResult = result;
    });
  }

  function tick(timestamp) {
    if (lastTimestamp === null) {
      lastTimestamp = timestamp;
    }
    const realDeltaSeconds = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    const isFrozen = hoverState.hoveredMothId !== null;
    if (isFrozen && frozenTimestamp === null) {
      // Freeze just began: capture the current (already offset-adjusted)
      // scene time as the constant to hold, and remember the real clock
      // reading it started at so this freeze's own duration can be measured
      // once it ends (see the !isFrozen branch below).
      freezeBeganAtRealMs = timestamp;
      freezeBeganAtRealSeconds = nowSeconds();
      frozenTimestamp = timestamp - freezeOffsetMs;
      frozenSeconds = freezeBeganAtRealSeconds - freezeOffsetSeconds;
      frozenIsLoading = isLoadingData();
    } else if (!isFrozen && frozenTimestamp !== null) {
      // Freeze just ended: fold its real duration into the running offset
      // so the live clock (nowSeconds()/performance.now() minus this
      // offset — see currentSceneSeconds()/currentRenderTimestamp())
      // continues from exactly frozenSeconds/frozenTimestamp instead of
      // jumping straight to wherever the un-adjusted real clock has since
      // reached, which is what made the scene visibly leap forward by the
      // hover's own duration the instant it ended.
      freezeOffsetMs += timestamp - freezeBeganAtRealMs;
      freezeOffsetSeconds += nowSeconds() - freezeBeganAtRealSeconds;
      freezeBeganAtRealMs = null;
      freezeBeganAtRealSeconds = null;
      frozenTimestamp = null;
      frozenSeconds = null;
      frozenIsLoading = null;
    }
    const renderTimestamp = currentRenderTimestamp();
    const t = currentSceneSeconds();
    const deltaSeconds = isFrozen ? 0 : realDeltaSeconds;

    if (isLive && !isFrozen) {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const due = queue.peekDue(t);
      due.forEach((observation) => {
        if (store.addObservation(observation, t, width, height)) {
          queue.acknowledge(observation.id, t);
          preloadMothImage(observation.imageUrl);
        }
      });
      store.removeExpired(t);
    }

    drawScene(context, store.getActiveMoths(), canvas.clientWidth, canvas.clientHeight, renderTimestamp, t, hoverState, presentationMode, currentIsLoading());
    audio.update(store.getActiveMoths(), deltaSeconds);
    updateActiveMothsPanel();
    updateDebugStatus(t);
    requestAnimationFrame(tick);
  }

  function findHoveredMoth(pointerX, pointerY) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;
    const t = currentSceneSeconds();

    return store.getActiveMoths()
      .map((moth) => projectMoth(moth, t, width, height, cx, cy, false))
      .filter((moth) => moth && moth.species !== "unknown" && moth.opacity > 0.05)
      .map((moth) => {
        const distance = Math.hypot(pointerX - moth.x, pointerY - moth.y);
        const hitRadius = Math.max(14, moth.size * 2.4 + moth.shadowBlur * 0.12);
        return {
          distance,
          hitRadius,
          moth
        };
      })
      .filter((candidate) => candidate.distance <= candidate.hitRadius)
      .sort((a, b) => {
        if (Math.abs(a.distance - b.distance) > 0.1) {
          return a.distance - b.distance;
        }

        return b.moth.depth - a.moth.depth;
      })[0]?.moth || null;
  }

  function updateHover(event) {
    if (!canHover) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const hoveredMoth = findHoveredMoth(pointerX, pointerY);

    if (!hoveredMoth) {
      clearHover();
      return;
    }

    setFocusedMoth(hoveredMoth.id);
  }

  function handleTapFocus(event) {
    if (canHover && event.pointerType === "mouse") {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const tappedMoth = findHoveredMoth(pointerX, pointerY);

    event.preventDefault();

    if (!tappedMoth || tappedMoth.id === hoverState.hoveredMothId) {
      clearHover();
      redrawNow();
      return;
    }

    setFocusedMoth(tappedMoth.id);
    redrawNow();
  }

  if (activeMothsToggle && activeMothsPanel) {
    activeMothsToggle.addEventListener("click", () => {
      const isOpen = !activeMothsPanel.classList.contains("is-open");
      activeMothsPanel.classList.toggle("is-open", isOpen);
      activeMothsToggle.classList.toggle("is-open", isOpen);
      activeMothsToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      activeMothsToggle.setAttribute("aria-label", isOpen ? "Hide active moths" : "Show active moths");
      updateActiveMothsPanel();
    });
  }

  if (canHover) {
    canvas.addEventListener("pointermove", updateHover);
    canvas.addEventListener("pointerleave", clearHover);
  }

  canvas.addEventListener("pointerdown", handleTapFocus);
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // Constructs and starts the InatClient for a given place_id. Called once
  // immediately below (the UK default — matching this page's behavior
  // before per-country support existed, so a real visitor's very first
  // paint and first fetch are exactly as fast as they always were) and
  // again later if resolveUserPlace() finds a different country (see the
  // IIFE below) — never awaited before starting, since real geolocation
  // permission prompts a visitor doesn't respond to make resolveUserPlace()
  // take its full ~8s fallback timeout, and most first-time visitors never
  // interact with that prompt at all. Blocking the initial start on it
  // would turn an instant start into an ~8s wait for most visitors, not an
  // edge case — confirmed by this exact symptom during testing (a real,
  // unanswered permission prompt in a real browser).
  function startClientForPlace(placeId) {
    // Scoped to this client generation, not module/outer state — a country
    // switch below starts a fresh client (and a fresh queue/store) that must
    // get its own fresh chance at live data, never inherit an earlier
    // client's already-tripped fallback.
    let hasReceivedLiveData = false;
    let fallbackActive = false;
    const loadingStartedAtMs = performance.now();

    // The loading flicker/text must stay up for at least MIN_LOADING_DURATION_MS
    // even if the very first response comes back almost instantly (a warm
    // cache, or a fast connection) — a flash of flicker lasting a few hundred
    // milliseconds reads as a glitch, not a deliberate "still loading" cue,
    // and is more likely to be jarring than a longer, calmer one. Cancels
    // and replaces any timeout already pending from an earlier call so only
    // the latest client generation's own minimum applies.
    function hideLoadingNoSoonerThanMinimumDuration() {
      if (!loadingStatus) {
        return;
      }
      if (hideLoadingTimeoutHandle !== null) {
        window.clearTimeout(hideLoadingTimeoutHandle);
      }
      const elapsedMs = performance.now() - loadingStartedAtMs;
      const remainingMs = Math.max(0, MIN_LOADING_DURATION_MS - elapsedMs);
      hideLoadingTimeoutHandle = window.setTimeout(() => {
        hideLoadingTimeoutHandle = null;
        loadingStatus.classList.add("is-hidden");
      }, remainingMs);
    }

    function enterFallbackModeIfNeeded() {
      if (hasReceivedLiveData || fallbackActive) {
        return;
      }
      fallbackActive = true;
      queue.enqueue(FALLBACK_NORMALIZED_OBSERVATIONS);
      if (fallbackStatus) {
        fallbackStatus.textContent =
          `It looks like live data is temporarily unavailable. While we wait, here's a look at ${FALLBACK_DATASET_COUNTRY} — one of the most moth-rich countries on Earth.`;
        fallbackStatus.classList.remove("is-hidden");
      }
    }

    client = new InatClient({
      buildUrl: () => `${WORKER_OBSERVATIONS_URL}?place_id=${placeId}`,
      upstreamShape: "adapter-contract",
      getCursor: () => queue.cursor || null,
      // InatClient's own default (15s) is too tight for this adapter: a
      // cold-cache Worker refresh now paces up to 4 sequential upstream pages
      // a second apart (see PAGE_DELAY_MS in worker/src/index.js) before
      // returning a ~300-400KB response, measured at ~7-8s even from a fast
      // connection — a real mobile connection can easily push that past 15s,
      // aborting the fetch and leaving the scene empty until the next
      // ~60s-backed-off retry. 45s mirrors the same margin already used for
      // this exact scenario in .github/workflows/deploy-worker.yml's smoke test.
      requestTimeoutSeconds: 45,
      onStateChange: (state) => {
        // STARTING is the synchronous initial state set the instant
        // client.start() runs, before any network activity — only a later,
        // real state (success or failure) means the first fetch has actually
        // resolved, which is what "no longer loading" should mean here.
        if (state !== CONNECTION_STATES.STARTING) {
          hideLoadingNoSoonerThanMinimumDuration();
        }
        if (state === CONNECTION_STATES.STALE || state === CONNECTION_STATES.OFFLINE) {
          runReachabilityProbeOnce();
        }
        if (state === CONNECTION_STATES.FATAL_SCHEMA_ERROR) {
          console.error("iNaturalist adapter returned an unexpected response shape; live updates have stopped.");
        }
        // Every failure state, not just STALE/OFFLINE above (RATE_LIMITED and
        // FATAL_SCHEMA_ERROR are just as much "no live data" from this
        // visitor's point of view) — but only while this client has never
        // once succeeded. Once real data has ever arrived, later failures
        // fall back to the Worker's own stale-cache (worker/src/index.js),
        // which is real (if aging) data rather than a static substitute.
        if (
          state === CONNECTION_STATES.STALE ||
          state === CONNECTION_STATES.OFFLINE ||
          state === CONNECTION_STATES.RATE_LIMITED ||
          state === CONNECTION_STATES.FATAL_SCHEMA_ERROR
        ) {
          enterFallbackModeIfNeeded();
        }
      },
      onBatch: (payload) => {
        hasReceivedLiveData = true;
        // A real batch just arrived — even an empty (QUIET) one is real data
        // from a working adapter, unlike the substitute fallback set. Swap
        // back to a clean queue/store rather than mixing static Colombia
        // moths in with live ones, which would be confusing (a card claiming
        // to be a UK sighting sitting right next to one that was posted years
        // ago in Colombia).
        if (fallbackActive) {
          fallbackActive = false;
          queue = new ObservationQueue();
          store = new MothStore();
          if (fallbackStatus) {
            fallbackStatus.classList.add("is-hidden");
          }
        }
        queue.enqueue(payload.observations, payload.cursor);
      }
    });
    client.start();
  }

  startClientForPlace(DEFAULT_PLACE_ID);

  // Resolves the visitor's real country in the background; if it turns out
  // to be somewhere other than the UK default just started above, cut over
  // to it — a fresh queue/store (a different country is a different feed,
  // not a continuation) and the loading indicator reappears until the new
  // client's first real fetch resolves. If it resolves to the UK anyway
  // (a real UK visitor, or any failure's fallback — both already showing
  // exactly this), there's nothing to switch and no visible change at all.
  // client.stop() doesn't abort an in-flight request (InatClient has no
  // abort-on-stop), so a UK response already in flight at the moment of a
  // switch can still land afterward and enqueue a handful of real UK
  // observations alongside the new country's — a minor, self-limited,
  // accepted edge case rather than deeper surgery on InatClient itself.
  (async () => {
    const { placeId, countryName } = await resolveUserPlace();
    if (placeId === DEFAULT_PLACE_ID) {
      return;
    }

    if (animationTitle) {
      animationTitle.textContent = countryHeading(countryName);
    }
    if (animationDescription) {
      animationDescription.textContent = countryDescription(countryName);
    }
    document.title = countryHeading(countryName);

    client.stop();
    queue = new ObservationQueue();
    store = new MothStore();
    // Cancel a still-pending "hide the loading indicator" timeout from the
    // client generation just stopped — left to fire, it would hide the *new*
    // country's indicator on the old generation's schedule, possibly before
    // the new one has even had its own MIN_LOADING_DURATION_MS.
    if (hideLoadingTimeoutHandle !== null) {
      window.clearTimeout(hideLoadingTimeoutHandle);
      hideLoadingTimeoutHandle = null;
    }
    if (loadingStatus) {
      loadingStatus.classList.remove("is-hidden");
    }
    // The default client's own fallback banner (if it had tripped one before
    // this resolved) belongs to a client generation that's being replaced —
    // the new one gets its own fresh attempt at live data, per
    // startClientForPlace's fallbackActive being scoped to each call.
    if (fallbackStatus) {
      fallbackStatus.classList.add("is-hidden");
    }
    startClientForPlace(placeId);
  })();

  requestAnimationFrame(tick);

  return {
    setPresentationMode(mode) {
      presentationMode = mode;
    }
  };
}

function setupLaunchScreen() {
  const launchScreen = document.getElementById("launch-screen");
  const launchSwitch = document.getElementById("launch-switch");
  const launchText = document.getElementById("launch-text");
  const launchScreenEnabled = config.animation.launchScreenEnabled === true || config.animation.launchScreenEnabled === "true";
  let orbitStarted = false;
  let orbitController = null;

  function startAnimation(initialPresentationMode = "normal") {
    if (orbitStarted) {
      return orbitController;
    }
    orbitController = setupOrbitAnimation(initialPresentationMode);
    orbitStarted = true;
    return orbitController;
  }

  function removeLaunchScreenWhenHidden() {
    if (!launchScreen) {
      return;
    }

    launchScreen.classList.add("launch-screen--hidden");
    launchScreen.addEventListener("transitionend", function onTransitionEnd(event) {
      if (event.propertyName !== "opacity") {
        return;
      }
      launchScreen.removeEventListener("transitionend", onTransitionEnd);
      launchScreen.remove();
    });
  }

  function revealMainAnimation() {
    const controller = startAnimation("light-only");
    document.body.classList.add("launch-light-visible");
    removeLaunchScreenWhenHidden();

    window.setTimeout(() => {
      if (controller) {
        controller.setPresentationMode("normal");
      }
      document.body.classList.add("launch-controls-visible");

      window.setTimeout(() => {
        document.body.classList.remove("launch-screen-active", "launch-light-visible", "launch-controls-visible");
      }, 700);
    }, 1000);
  }

  function activateLaunchScreen() {
    if (!launchScreen || !launchSwitch || launchSwitch.classList.contains("is-on")) {
      return;
    }
    launchSwitch.classList.add("is-on");
    launchScreen.classList.add("launch-screen--switch-hidden");
    if (launchText) {
      launchText.textContent = "Turning on...";
    }
    setTimeout(revealMainAnimation, 320);
  }

  if (!launchScreenEnabled) {
    if (launchScreen) {
      launchScreen.remove();
    }
    setupOrbitAnimation();
    return;
  }

  if (launchScreen && launchSwitch) {
    document.body.classList.add("launch-screen-active");
    launchSwitch.addEventListener("click", (event) => {
      event.stopPropagation();
      activateLaunchScreen();
    });
    launchSwitch.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateLaunchScreen();
      }
    });
  } else {
    setupOrbitAnimation();
  }
}

async function bootstrap() {
  const response = await fetch("config/site-config.json");
  if (!response.ok) {
    throw new Error("Failed to load config/site-config.json: " + response.status);
  }
  setConfig(await response.json());
  setupLaunchScreen();
}

bootstrap();
