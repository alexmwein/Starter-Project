(() => {
  document.documentElement.classList.add("reveal-ready");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const menuButton = document.querySelector("[data-menu-trigger]");
  const mobileMenu = document.querySelector("[data-mobile-menu]");

  const closeMenu = () => {
    if (!menuButton || !mobileMenu) return;
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.textContent = "Menu";
    mobileMenu.dataset.open = "false";
    document.body.classList.remove("menu-open");
  };

  if (menuButton && mobileMenu) {
    menuButton.addEventListener("click", () => {
      const willOpen = menuButton.getAttribute("aria-expanded") !== "true";
      menuButton.setAttribute("aria-expanded", String(willOpen));
      menuButton.textContent = willOpen ? "Close" : "Menu";
      mobileMenu.dataset.open = String(willOpen);
      document.body.classList.toggle("menu-open", willOpen);
      if (willOpen) {
        mobileMenu.querySelector("a")?.focus();
      }
    });

    mobileMenu.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
  }

  const ledger = document.querySelector("[data-nav-ledger]");
  const nav = ledger?.parentElement;
  const current = nav?.querySelector('[aria-current="page"]');

  const moveLedger = (target) => {
    if (!ledger || !nav || !target) return;
    const navRect = nav.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    ledger.style.left = `${targetRect.left - navRect.left}px`;
    ledger.style.width = `${targetRect.width}px`;
  };

  if (ledger && nav) {
    requestAnimationFrame(() => moveLedger(current));
    nav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("mouseenter", () => moveLedger(link));
      link.addEventListener("focus", () => moveLedger(link));
    });
    nav.addEventListener("mouseleave", () => moveLedger(current));
    window.addEventListener("resize", () => moveLedger(current));
  }

  const revealTargets = document.querySelectorAll(".reveal, .rule-draw, [data-footer]");
  if (reducedMotion || !("IntersectionObserver" in window)) {
    revealTargets.forEach((target) => target.classList.add("is-visible"));
  } else {
    const observer = new IntersectionObserver(
      (entries, currentObserver) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          currentObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.16 }
    );
    revealTargets.forEach((target) => observer.observe(target));
  }

  const register = document.querySelector("[data-register]");
  if (register && !reducedMotion) {
    const finalText = register.textContent.trim();
    register.textContent = "";
    let index = 0;
    const timer = window.setInterval(() => {
      register.textContent = finalText.slice(0, index + 1);
      index += 1;
      if (index >= finalText.length) window.clearInterval(timer);
    }, 40);
  }

  const form = document.querySelector("[data-access-form]");
  if (!form) return;

  const button = form.querySelector("[data-download-button]");
  const confirmation = form.querySelector("[data-form-confirmation]");
  const commonDomains = new Set([
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
  ]);

  const getErrorElement = (field) => form.querySelector(`[data-error-for="${field.id}"]`);

  const setFieldError = (field, message) => {
    field.setAttribute("aria-invalid", message ? "true" : "false");
    const error = getErrorElement(field);
    if (error) error.textContent = message;
  };

  const validateField = (field) => {
    const value = field.type === "checkbox" ? field.checked : field.value.trim();
    let message = "";

    if (field.required && !value) {
      message = field.type === "checkbox" ? "Confirm this statement to prepare the file." : "Complete this field.";
    }

    if (!message && field.type === "email") {
      const domain = String(value).split("@")[1]?.toLowerCase();
      if (!domain || commonDomains.has(domain)) {
        message = "Enter an institutional email. We review domains, not names.";
      }
    }

    if (!message && field.id === "research-context" && String(value).length < 40) {
      message = "Describe the analytical context in at least 40 characters.";
    }

    setFieldError(field, message);
    return !message;
  };

  form.querySelectorAll("input, select, textarea").forEach((field) => {
    field.addEventListener("blur", () => validateField(field));
    field.addEventListener("input", () => {
      if (field.getAttribute("aria-invalid") === "true") validateField(field);
    });
  });

  const safeLine = (value) => String(value).replace(/[\r\n]+/g, " ").trim();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = [...form.querySelectorAll("input, select, textarea")];
    const valid = fields.map(validateField).every(Boolean);

    if (!valid) {
      fields.find((field) => field.getAttribute("aria-invalid") === "true")?.focus();
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = "Preparing…";
    }
    if (confirmation) confirmation.textContent = "";

    await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : 450));
    if (button) button.textContent = "Written locally";
    await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : 450));

    const data = new FormData(form);
    const lines = [
      "THIRD STANDARD: RESEARCH ACCESS FILE",
      "",
      `Prepared: ${new Date().toISOString()}`,
      `Organization: ${safeLine(data.get("organization"))}`,
      `Entity type: ${safeLine(data.get("entity_type"))}`,
      `Applicant: ${safeLine(data.get("name"))}`,
      `Role: ${safeLine(data.get("role"))}`,
      `Institutional email: ${safeLine(data.get("email"))}`,
      `Facility: ${safeLine(data.get("facility"))}`,
      `Purchasing authority: ${safeLine(data.get("authority"))}`,
      "",
      "Analytical context:",
      safeLine(data.get("research_context")),
      "",
      "Applicant statement:",
      "The requested access is for legitimate institutional analytical or research activity and not personal, household, clinical, therapeutic, veterinary, cosmetic, or resale use.",
      "",
      "This file was prepared locally. Nothing was transmitted.",
      "Preparing this file does not grant access or create a customer relationship.",
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const slug = safeLine(data.get("organization")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    link.href = url;
    link.download = `third-standard-access-${slug || "application"}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    if (confirmation) confirmation.textContent = "Access file prepared and downloaded. Nothing was sent.";
    if (button) {
      button.disabled = false;
      button.textContent = "Prepare access file";
    }
  });
})();
