import { config, setConfig } from "./config-store.js";
import {
  clampAnimationTime,
  createMoths,
  drawScene,
  formatClockTime,
  normalizeAnimationTime,
  projectMoth
} from "./animation-engine.js";
import { setupAudio } from "./audio-engine.js";

function setupOrbitAnimation(initialPresentationMode = "normal") {
  const canvas = document.getElementById("orbit-canvas");
  const context = canvas.getContext("2d");
  const scrubber = document.getElementById("timeline-scrubber");
  const timeReadout = document.getElementById("time-readout");
  const activeMothsToggle = document.getElementById("active-moths-toggle");
  const activeMothsPanel = document.getElementById("active-moths-panel");
  const activeMothsList = document.getElementById("active-moths-list");
  const audio = setupAudio(config.moths);
  let moths = [];
  let animationTime = 0;
  let lastTimestamp = null;
  let isPlaying = config.animation.autoplay && initialPresentationMode !== "light-only";
  let wasPlayingBeforeScrub = false;
  let wasPlayingBeforeHover = false;
  let isScrubbing = false;
  let isHoverPaused = false;
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

  function updateTimelineControls() {
    scrubber.max = String(config.animation.duration);
    scrubber.value = String(animationTime);
    timeReadout.textContent = formatClockTime(animationTime);
  }

  function activeProjectedKnownMoths() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;

    return moths
      .map((moth) => projectMoth(moth, animationTime, width, height, cx, cy, false))
      .filter((moth) => moth && moth.species !== "unknown" && moth.opacity > 0.02)
      .sort((a, b) => a.entryTime - b.entryTime);
  }

  function setFocusedMoth(mothId, pausePlayback = true) {
    hoverState.hoveredMothId = mothId;
    canvas.style.cursor = mothId ? "pointer" : "default";

    if (mothId && pausePlayback && !isHoverPaused && !isScrubbing) {
      wasPlayingBeforeHover = isPlaying;
      isPlaying = false;
      isHoverPaused = true;
      lastTimestamp = null;
    }

    if (!mothId && isHoverPaused && !isScrubbing) {
      isPlaying = wasPlayingBeforeHover;
      lastTimestamp = null;
      isHoverPaused = false;
    }
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
      drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
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
      time.textContent = formatClockTime(moth.entryTime) + " - " + formatClockTime(moth.exitTime);
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
    moths = createMoths(config, rect.width, rect.height);
  }

  function preloadSpeciesImages() {
    config.species.forEach((species) => {
      const imageURL = species.imageURL;
      if (!imageURL || hoverState.imageCache.has(imageURL)) {
        return;
      }

      const image = new Image();
      const record = {
        image,
        loaded: false,
        failed: false
      };

      hoverState.imageCache.set(imageURL, record);
      image.crossOrigin = "anonymous";
      image.addEventListener("load", () => {
        record.loaded = true;
        drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
      });
      image.addEventListener("error", () => {
        record.failed = true;
      });
      image.src = imageURL;
    });
  }

  function tick(timestamp) {
    if (lastTimestamp === null) {
      lastTimestamp = timestamp;
    }

    const deltaSeconds = ((timestamp - lastTimestamp) / 1000) * config.animation.playbackSpeed;
    lastTimestamp = timestamp;

    if (isPlaying) {
      animationTime = normalizeAnimationTime(animationTime + deltaSeconds);
      audio.update(animationTime, deltaSeconds);
    }

    drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, timestamp, animationTime, hoverState, presentationMode);
    updateTimelineControls();
    updateActiveMothsPanel();
    requestAnimationFrame(tick);
  }

  function findHoveredMoth(pointerX, pointerY) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cx = width / 2;
    const cy = height * config.scene.centerYRatio;

    return moths
      .map((moth) => projectMoth(moth, animationTime, width, height, cx, cy, false))
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

  function clearHover() {
    hoverState.hoveredMothId = null;
    canvas.style.cursor = "default";

    if (isHoverPaused && !isScrubbing) {
      isPlaying = wasPlayingBeforeHover;
      lastTimestamp = null;
    }

    isHoverPaused = false;
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
      drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
      return;
    }

    setFocusedMoth(tappedMoth.id);

    drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
  }

  scrubber.addEventListener("pointerdown", () => {
    isScrubbing = true;
    wasPlayingBeforeScrub = isHoverPaused ? wasPlayingBeforeHover : isPlaying;
    isPlaying = false;
  });

  scrubber.addEventListener("input", () => {
    animationTime = clampAnimationTime(Number(scrubber.value));
    drawScene(context, moths, canvas.clientWidth, canvas.clientHeight, performance.now(), animationTime, hoverState, presentationMode);
    updateTimelineControls();
  });

  scrubber.addEventListener("pointerup", () => {
    isScrubbing = false;
    if (hoverState.hoveredMothId) {
      wasPlayingBeforeHover = wasPlayingBeforeScrub;
      isPlaying = false;
      isHoverPaused = true;
    } else {
      isPlaying = wasPlayingBeforeScrub;
      isHoverPaused = false;
    }

    lastTimestamp = null;
  });

  scrubber.addEventListener("change", () => {
    animationTime = clampAnimationTime(Number(scrubber.value));
    isScrubbing = false;
    if (hoverState.hoveredMothId) {
      wasPlayingBeforeHover = wasPlayingBeforeScrub;
      isPlaying = false;
      isHoverPaused = true;
    } else {
      isPlaying = wasPlayingBeforeScrub;
      isHoverPaused = false;
    }

    lastTimestamp = null;
  });

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
  preloadSpeciesImages();
  updateTimelineControls();
  requestAnimationFrame(tick);

  return {
    setPresentationMode(mode) {
      presentationMode = mode;
      if (mode !== "light-only" && !isScrubbing && !isHoverPaused) {
        isPlaying = config.animation.autoplay;
        lastTimestamp = null;
      }
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
