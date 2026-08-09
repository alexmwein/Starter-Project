(() => {
  "use strict";

  const slides = [...document.querySelectorAll(".slide")];
  const progress = document.querySelector(".progress-bar");
  const currentLabel = document.querySelector("[data-current-slide]");
  const totalLabel = document.querySelector("[data-total-slides]");
  const notesPanel = document.querySelector(".speaker-notes");
  const notesBody = document.querySelector("[data-notes-body]");
  const overview = document.querySelector(".overview-panel");
  const overviewGrid = document.querySelector(".overview-grid");
  const help = document.querySelector(".help-panel");
  const blank = document.querySelector(".blank-screen");
  const stage = document.querySelector(".stage");
  const curtain = document.querySelector(".loading-curtain");
  const deckKey = document.body.dataset.deck || "ovo-deck";

  let current = 0;
  let previous = -1;
  let transitionTimer = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let preparedText = new Map();
  let relayoutQueued = false;

  const pad = (value) => String(value).padStart(2, "0");
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function slideFromHash() {
    const raw = Number.parseInt(window.location.hash.replace("#", ""), 10);
    return Number.isFinite(raw) ? clamp(raw - 1, 0, slides.length - 1) : 0;
  }

  function updateMedia() {
    slides.forEach((slide, index) => {
      slide.querySelectorAll("video").forEach((video) => {
        if (index === current) {
          const playAttempt = video.play();
          if (playAttempt && typeof playAttempt.catch === "function") playAttempt.catch(() => {});
        } else {
          video.pause();
        }
      });
    });
  }

  function updateNotes() {
    if (!notesBody) return;
    const source = slides[current]?.querySelector(".notes");
    notesBody.innerHTML = source?.innerHTML || "<p>No notes for this slide.</p>";
  }

  function updateOverview() {
    overviewGrid?.querySelectorAll(".overview-card").forEach((card, index) => {
      card.setAttribute("aria-current", index === current ? "true" : "false");
    });
  }

  function goTo(index, { replaceHash = false } = {}) {
    const next = clamp(index, 0, slides.length - 1);
    if (next === current && slides[current]?.classList.contains("is-active")) return;

    window.clearTimeout(transitionTimer);
    previous = current;
    current = next;

    slides.forEach((slide, slideIndex) => {
      slide.classList.remove("is-active", "was-active");
      slide.setAttribute("aria-hidden", slideIndex === current ? "false" : "true");
    });

    if (previous !== current && slides[previous]) slides[previous].classList.add("was-active");
    slides[current]?.classList.add("is-active");

    transitionTimer = window.setTimeout(() => {
      slides.forEach((slide, slideIndex) => {
        if (slideIndex !== current) slide.classList.remove("was-active");
      });
    }, 760);

    if (currentLabel) currentLabel.textContent = pad(current + 1);
    if (progress) progress.style.width = `${((current + 1) / slides.length) * 100}%`;
    document.title = `${slides[current]?.dataset.title || "Presentation"} · OVO Talent`;

    const nextHash = `#${current + 1}`;
    if (window.location.hash !== nextHash) {
      const method = replaceHash ? "replaceState" : "pushState";
      window.history[method](null, "", nextHash);
    }

    updateMedia();
    updateNotes();
    updateOverview();
  }

  function next() {
    goTo(current + 1);
  }

  function previousSlide() {
    goTo(current - 1);
  }

  function closePanels(except = null) {
    [notesPanel, overview, help].forEach((panel) => {
      if (panel && panel !== except) panel.classList.remove("is-open");
    });
  }

  function togglePanel(panel) {
    if (!panel) return;
    const willOpen = !panel.classList.contains("is-open");
    closePanels(panel);
    panel.classList.toggle("is-open", willOpen);
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (_) {
      // Fullscreen can be blocked when the deck is embedded. The presentation still works.
    }
  }

  function runAction(action) {
    const actions = {
      next,
      previous: previousSlide,
      fullscreen: toggleFullscreen,
      notes: () => togglePanel(notesPanel),
      overview: () => togglePanel(overview),
      help: () => togglePanel(help),
      blank: () => blank?.classList.toggle("is-open"),
    };
    actions[action]?.();
  }

  function isEditing() {
    return document.activeElement?.isContentEditable;
  }

  function handleKeydown(event) {
    if (isEditing()) {
      if (event.key === "Escape") document.activeElement.blur();
      return;
    }

    const key = event.key.toLowerCase();

    if (blank?.classList.contains("is-open")) {
      if (key === "b" || key === "escape") blank.classList.remove("is-open");
      return;
    }

    if (key === "escape") {
      closePanels();
      return;
    }

    if (["arrowright", "arrowdown", "pagedown", " "].includes(key)) {
      event.preventDefault();
      next();
    } else if (["arrowleft", "arrowup", "pageup"].includes(key)) {
      event.preventDefault();
      previousSlide();
    } else if (key === "home") {
      event.preventDefault();
      goTo(0);
    } else if (key === "end") {
      event.preventDefault();
      goTo(slides.length - 1);
    } else if (key === "f") {
      toggleFullscreen();
    } else if (key === "n") {
      togglePanel(notesPanel);
    } else if (key === "o") {
      togglePanel(overview);
    } else if (key === "b") {
      blank?.classList.add("is-open");
    } else if (key === "?" || key === "h") {
      togglePanel(help);
    }
  }

  function buildOverview() {
    if (!overviewGrid) return;
    const fragment = document.createDocumentFragment();

    slides.forEach((slide, index) => {
      const card = document.createElement("button");
      card.className = "overview-card";
      card.type = "button";
      card.innerHTML = `
        <span class="overview-num">${pad(index + 1)}</span>
        <strong>${slide.dataset.title || `Slide ${index + 1}`}</strong>
        <span>${slide.dataset.section || "OVO Talent"}</span>
      `;
      card.addEventListener("click", () => {
        goTo(index);
        overview.classList.remove("is-open");
      });
      fragment.appendChild(card);
    });

    overviewGrid.replaceChildren(fragment);
  }

  function fontShorthand(element) {
    const style = window.getComputedStyle(element);
    return style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} / ${style.lineHeight} ${style.fontFamily}`;
  }

  function prepareTextElement(element) {
    if (!window.Pretext?.prepare) return;
    const text = element.innerText.trim();
    if (!text) return;
    preparedText.set(element, window.Pretext.prepare(text, fontShorthand(element)));
  }

  function relayoutText() {
    relayoutQueued = false;
    if (!window.Pretext?.layout) return;

    preparedText.forEach((handle, element) => {
      if (!element.isConnected || element.clientWidth <= 0) return;
      element.style.minHeight = "";
      const naturalHeight = Math.ceil(element.scrollHeight);
      const style = window.getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.1;
      const result = window.Pretext.layout(handle, element.clientWidth, lineHeight);
      if (Number.isFinite(result.height) && result.height > 0) {
        const measuredHeight = Math.min(Math.ceil(result.height), naturalHeight + 1);
        element.style.minHeight = `${measuredHeight}px`;
      }
    });
  }

  function scheduleRelayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    window.requestAnimationFrame(relayoutText);
  }

  function wirePretext() {
    const elements = [...document.querySelectorAll("[data-pretext]")];
    elements.forEach((element) => {
      prepareTextElement(element);
      element.setAttribute("contenteditable", "true");
      element.setAttribute("spellcheck", "false");

      new MutationObserver(() => {
        prepareTextElement(element);
        scheduleRelayout();
      }).observe(element, { characterData: true, subtree: true, childList: true });
    });

    const resizeObserver = new ResizeObserver(scheduleRelayout);
    resizeObserver.observe(stage || document.body);
    scheduleRelayout();
  }

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.action));
  });

  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("hashchange", () => goTo(slideFromHash(), { replaceHash: true }));

  stage?.addEventListener("pointermove", (event) => {
    const rect = stage.getBoundingClientRect();
    stage.style.setProperty("--pointer-x", `${((event.clientX - rect.left) / rect.width) * 100}%`);
    stage.style.setProperty("--pointer-y", `${((event.clientY - rect.top) / rect.height) * 100}%`);
  });

  stage?.addEventListener("touchstart", (event) => {
    touchStartX = event.changedTouches[0]?.clientX || 0;
    touchStartY = event.changedTouches[0]?.clientY || 0;
  }, { passive: true });

  stage?.addEventListener("touchend", (event) => {
    const endX = event.changedTouches[0]?.clientX || 0;
    const endY = event.changedTouches[0]?.clientY || 0;
    const deltaX = endX - touchStartX;
    const deltaY = endY - touchStartY;
    if (Math.abs(deltaX) > 54 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX < 0) next();
      else previousSlide();
    }
  }, { passive: true });

  document.addEventListener("click", (event) => {
    if (event.target.closest(".help-panel, .speaker-notes, .overview-panel, .controls")) return;
    closePanels();
  });

  if (totalLabel) totalLabel.textContent = pad(slides.length);
  buildOverview();
  current = slideFromHash();
  slides.forEach((slide) => slide.classList.remove("is-active", "was-active"));
  previous = -1;
  goTo(current, { replaceHash: true });

  const personalizationReady = Promise.resolve(window.OVOProfileReady || window.OVOBrandReady).catch(() => null);
  const personalizationDeadline = new Promise((resolve) => window.setTimeout(resolve, 14_000));

  Promise.allSettled([
    Promise.resolve(document.fonts?.ready),
    Promise.race([personalizationReady, personalizationDeadline]),
  ])
    .then(wirePretext)
    .finally(() => {
      window.setTimeout(() => curtain?.classList.add("is-ready"), 260);
    });

  window.OVODeck = { goTo, next, previous: previousSlide, deckKey };
})();
