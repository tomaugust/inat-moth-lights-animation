import { config, setConfig } from "./config-store.js";
import { drawScene, projectMoth } from "./animation-engine.js";
import { setupAudio } from "./audio-engine.js";
import { ObservationQueue } from "./observation-queue.js";
import { MothStore } from "./moth-store.js";
import { CONNECTION_STATES, InatClient } from "./inaturalist-client.js";

// The production site's one and only data source: the deployed Cloudflare
// Worker adapter (worker/src/index.js), never api.inaturalist.org directly —
// that's what gives every visitor a real User-Agent and a shared cache
// instead of N independent browsers hammering iNaturalist. The Worker is
// currently UK-only (its PLACE_ID is a fixed deploy-time value, not
// per-request), so this site is UK-only for now too; per-visitor country
// (src/geolocation.js) needs the Worker to accept and cache by place_id
// first — see README.md.
const WORKER_OBSERVATIONS_URL = "https://inat-moth-lights-adapter.tomaugust1985.workers.dev/observations";

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
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
  const audio = setupAudio();

  const queue = new ObservationQueue({ storage: getStorage(), storageKey: "inat-moth-lights:live-queue" });
  const store = new MothStore();
  // A false autoplay is the one remaining kill-switch: the scene loads (just
  // the light, in whichever presentation mode) but never admits a moth. Real
  // network polling still runs in the background regardless — see the
  // launch-screen note on why that's deliberate.
  const isLive = config.animation.autoplay !== false;

  let lastTimestamp = null;
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

  function activeProjectedKnownMoths() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;
    const t = nowSeconds();

    return store.getActiveMoths()
      .map((moth) => projectMoth(moth, t, width, height, cx, cy, false))
      .filter((moth) => moth && moth.species !== "unknown" && moth.opacity > 0.02)
      .sort((a, b) => a.entryTime - b.entryTime);
  }

  // Hovering/focusing a moth no longer pauses a global clock (there isn't
  // one) — it uses MothStore's own focus/grace-period mechanism so the
  // specific moth being inspected is kept alive a little past its natural
  // exit, while every other moth (and the live feed itself) keeps moving.
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
    drawScene(context, store.getActiveMoths(), canvas.clientWidth, canvas.clientHeight, performance.now(), nowSeconds(), hoverState, presentationMode);
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

  function tick(timestamp) {
    if (lastTimestamp === null) {
      lastTimestamp = timestamp;
    }
    const deltaSeconds = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;
    const t = nowSeconds();

    if (isLive) {
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

    drawScene(context, store.getActiveMoths(), canvas.clientWidth, canvas.clientHeight, timestamp, t, hoverState, presentationMode);
    audio.update(store.getActiveMoths(), deltaSeconds);
    updateActiveMothsPanel();
    requestAnimationFrame(tick);
  }

  function findHoveredMoth(pointerX, pointerY) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;
    const t = nowSeconds();

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

  // Real network polling starts as soon as the scene is constructed —
  // including during the brief light-only preview before the launch screen
  // finishes fading — so there's already a backlog of real observations
  // ready to render the instant presentationMode flips to "normal", rather
  // than starting the fetch only after that reveal completes.
  const client = new InatClient({
    buildUrl: () => WORKER_OBSERVATIONS_URL,
    upstreamShape: "adapter-contract",
    getCursor: () => queue.cursor || null,
    onStateChange: (state) => {
      // STARTING is the synchronous initial state set the instant
      // client.start() runs, before any network activity — only a later,
      // real state (success or failure) means the first fetch has actually
      // resolved, which is what "no longer loading" should mean here.
      if (loadingStatus && state !== CONNECTION_STATES.STARTING) {
        loadingStatus.classList.add("is-hidden");
      }
      if (state === CONNECTION_STATES.FATAL_SCHEMA_ERROR) {
        console.error("iNaturalist adapter returned an unexpected response shape; live updates have stopped.");
      }
    },
    onBatch: (payload) => {
      queue.enqueue(payload.observations, payload.cursor);
    }
  });
  client.start();

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
