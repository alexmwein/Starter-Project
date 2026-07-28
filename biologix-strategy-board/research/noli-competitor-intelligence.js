(function () {
  "use strict";

  const data = window.NOLI_COMPETITOR_INTELLIGENCE;
  const root = document.getElementById("noli-competitor-intelligence");
  if (!data || !root) return;

  const stats = root.querySelector("[data-ci-stats]");
  const caseStudies = root.querySelector("[data-ci-cases]");
  const search = root.querySelector("[data-ci-search]");
  const filter = root.querySelector("[data-ci-filter]");
  const sort = root.querySelector("[data-ci-sort]");
  const resultCount = root.querySelector("[data-ci-count]");
  const list = root.querySelector("[data-ci-list]");
  const loadMore = root.querySelector("[data-ci-more]");
  const PAGE_SIZE = 12;
  let visibleCount = PAGE_SIZE;
  const catalogPromises = new Map();
  const catalogViews = new Map();

  const escapeHtml = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  const safeUrl = (value) => {
    if (!value) return null;
    try {
      const parsed = new URL(String(value), window.location.href);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
    } catch (_error) {
      return null;
    }
  };

  const link = (url, label) => {
    const safe = safeUrl(url);
    if (!safe) return "";
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  };

  const integer = (value) =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value))
      : "Unknown";

  const compact = (value) =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: Number(value) < 10_000 ? 1 : 0,
        }).format(Number(value))
      : "Unknown";

  const money = (value, currency = "USD", compactValue = false) => {
    if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) {
      return "Unknown";
    }
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency === "MIXED" ? "USD" : currency || "USD",
        notation: compactValue ? "compact" : "standard",
        maximumFractionDigits: compactValue ? 1 : 2,
      }).format(Number(value));
    } catch (_error) {
      return `${currency || "USD"} ${Number(value).toFixed(2)}`;
    }
  };

  const percent = (value) =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? `${Math.round(Number(value) * 100)}%`
      : "Unknown";

  const rows = Object.entries(data.audits || {}).map(([domain, audit]) => ({
    domain,
    ...audit,
  }));

  function renderStats() {
    const values = [
      [data.stats.coreCompetitorDomains, "competitors"],
      [data.stats.verifiedDomainAges, "domain ages verified"],
      [data.stats.trafficModeledDomains, "traffic models"],
      [data.stats.fullyEnumeratedCatalogs, "full public catalogs"],
      [data.stats.normalizedCatalogOffers, "deduped offers"],
      [data.stats.screenshotScoredDomains, "UI scores"],
    ];
    stats.innerHTML = values
      .map(([value, label]) => `<div><strong>${escapeHtml(integer(value))}</strong><span>${escapeHtml(label)}</span></div>`)
      .join("");
  }

  function renderCases() {
    const northline = data.caseStudies?.["northlinelabs.org"];
    const biologix = data.caseStudies?.["biologixlabsresearch.com"];
    if (!northline || !biologix) return;

    const northlineCurrentGross = Math.round(
      Number(northline.commercial.currentMonthlyVisitsModel || 0) * 0.0179 * 190,
    );
    const privateSignal = biologix.commercial.caseStudy?.observedPrivateSignal || {};

    caseStudies.innerHTML = `
      <article>
        <span>Northline / public model</span>
        <strong>${escapeHtml(integer(northline.commercial.trailing30VisitsModel))} trailing visits · ${escapeHtml(integer(northline.commercial.currentMonthlyVisitsModel))} current pace</strong>
        <p>${escapeHtml(money(northline.commercial.gmvBase, "USD", true))} trailing base checkout model · ${escapeHtml(money(northlineCurrentGross, "USD", true))} current-pace model.</p>
        <small>Modeled gross checkout, not measured revenue or profit.</small>
      </article>
      <article>
        <span>Biologix / private screen</span>
        <strong>${escapeHtml(money(privateSignal.dailyGrossDisplayed))} · ${escapeHtml(integer(privateSignal.dailyOrdersDisplayed))} orders shown</strong>
        <p>${escapeHtml(money(privateSignal.displayedAov))} displayed AOV · ${escapeHtml(money(privateSignal.sustained30DayGrossIllustration, "USD", true))} only if that exact day repeated for 30 days.</p>
        <small>Strong private signal; not an audited settlement or public traffic measurement.</small>
      </article>
    `;
  }

  function filteredRows() {
    const query = String(search.value || "").trim().toLowerCase();
    const mode = filter.value;
    const order = sort.value;
    const matched = rows.filter((row) => {
      const searchable = [
        row.domain,
        row.catalog?.coverage,
        row.catalog?.retaOffers?.map((offer) => `${offer.title} ${offer.options || ""}`).join(" "),
        row.design?.strongestLesson,
        row.design?.biggestFailure,
        row.design?.reasons?.join(" "),
      ].join(" ").toLowerCase();
      if (query && !searchable.includes(query)) return false;
      if (mode === "traffic" && row.commercial?.trafficBasisVisitsModel == null) return false;
      if (mode === "catalog" && !/^complete_/i.test(row.catalog?.coverage || "")) return false;
      if (mode === "reta" && !Number(row.catalog?.retaVariantCount || 0)) return false;
      if (mode === "ui" && row.design?.overall == null) return false;
      return true;
    });

    matched.sort((left, right) => {
      if (order === "catalog") {
        return (right.catalog?.variantCount || 0) - (left.catalog?.variantCount || 0) ||
          left.domain.localeCompare(right.domain);
      }
      if (order === "gmv") {
        return (right.commercial?.gmvBase || -1) - (left.commercial?.gmvBase || -1) ||
          left.domain.localeCompare(right.domain);
      }
      if (order === "reta") {
        return (right.catalog?.retaVariantCount || 0) - (left.catalog?.retaVariantCount || 0) ||
          left.domain.localeCompare(right.domain);
      }
      if (order === "age") {
        return (right.commercial?.domainAgeDays || -1) - (left.commercial?.domainAgeDays || -1) ||
          left.domain.localeCompare(right.domain);
      }
      if (order === "ui") {
        return (right.design?.overall || -1) - (left.design?.overall || -1) ||
          left.domain.localeCompare(right.domain);
      }
      return (right.commercial?.trafficBasisVisitsModel || -1) -
        (left.commercial?.trafficBasisVisitsModel || -1) ||
        left.domain.localeCompare(right.domain);
    });
    return matched;
  }

  function retaOfferMarkup(row) {
    const offers = row.catalog?.retaOffers || [];
    if (!offers.length) return `<p class="ci-empty">No Reta offer captured in the anonymous public catalog.</p>`;
    return `
      <div class="ci-reta-list">
        ${offers.slice(0, 10).map((offer) => `
          <div>
            <span>${escapeHtml([offer.title, offer.options].filter(Boolean).join(" · "))}</span>
            <strong>${escapeHtml(money(offer.currentPrice, offer.currency))}</strong>
            ${offer.url ? link(offer.url, "Open ↗") : ""}
          </div>
        `).join("")}
      </div>
      ${offers.length > 10 ? `<small>${escapeHtml(integer(offers.length - 10))} more Reta variants are in the full catalog.</small>` : ""}
    `;
  }

  function modelEvidenceMarkup(row) {
    const commercial = row.commercial || {};
    const design = row.design || {};
    const panels = commercial.externalPanels || [];
    const panelMarkup = panels.length
      ? panels.map((panel) => {
          const label = `${panel.provider}: ${integer(panel.monthlyVisits)}/mo${panel.period ? ` (${panel.period})` : ""}`;
          return panel.sourceUrl ? link(panel.sourceUrl, label) : escapeHtml(label);
        }).join(" · ")
      : "No independent public panel captured.";
    const assumptions = [
      commercial.cvrLow || commercial.cvrBase || commercial.cvrHigh
        ? `CVR ${[commercial.cvrLow, commercial.cvrBase, commercial.cvrHigh].filter(Boolean).join(" / ")}`
        : null,
      commercial.aovLow != null || commercial.aovBase != null || commercial.aovHigh != null
        ? `AOV ${[commercial.aovLow, commercial.aovBase, commercial.aovHigh]
          .filter((value) => value != null)
          .map((value) => money(value))
          .join(" / ")}`
        : null,
      commercial.ordersBase != null ? `${integer(commercial.ordersBase)} base-case orders` : null,
    ].filter(Boolean).join(" · ") || "No checkout model.";
    const uiParts = [
      design.overall == null ? null : `${design.overall}/10 overall`,
      design.mobileUsability == null ? null : `${design.mobileUsability}/10 mobile`,
      design.accessStatus ? `Access: ${design.accessStatus}` : null,
      design.confidence ? `Confidence: ${design.confidence}` : null,
      design.strongestLesson ? `Lesson: ${design.strongestLesson}` : null,
      design.biggestFailure ? `Watch: ${design.biggestFailure}` : null,
      !design.strongestLesson && !design.biggestFailure && design.reasons?.length
        ? `Findings: ${design.reasons.slice(0, 2).join(" / ")}`
        : null,
    ].filter(Boolean);

    return `
      <details class="ci-method">
        <summary>Model assumptions and UI evidence</summary>
        <ul>
          <li><strong>Public traffic panels:</strong> ${panelMarkup}</li>
          <li><strong>Checkout scenario:</strong> ${escapeHtml(assumptions)}</li>
          <li><strong>UI review:</strong> ${escapeHtml(uiParts.join(" · ") || "Not scored.")} ${design.scoredUrl ? link(design.scoredUrl, "Scored page ↗") : ""}</li>
        </ul>
      </details>
    `;
  }

  function rowMarkup(row) {
    const commercial = row.commercial || {};
    const catalog = row.catalog || {};
    const design = row.design || {};
    const visits = commercial.trafficBasisVisitsModel;
    const gmv = commercial.gmvBase;
    const coverageLabel = /^complete_/i.test(catalog.coverage || "")
      ? "Full public catalog"
      : /^partial_/i.test(catalog.coverage || "")
        ? "Partial public catalog"
        : "Catalog unknown/gated";

    return `
      <details class="ci-company" data-domain="${escapeHtml(row.domain)}">
        <summary>
          <span>
            <strong>${escapeHtml(row.domain)}</strong>
            <small>${escapeHtml(coverageLabel)}</small>
          </span>
          <span><b>${escapeHtml(compact(visits))}</b><small>modeled visits</small></span>
          <span><b>${escapeHtml(integer(catalog.variantCount))}</b><small>offers</small></span>
          <span><b>${escapeHtml(design.overall == null ? "—" : `${design.overall}/10`)}</b><small>UI</small></span>
        </summary>
        <div class="ci-company-body">
          <div class="ci-company-metrics">
            <div><span>Age</span><strong>${commercial.domainCreated ? `${escapeHtml(commercial.domainCreated)} · ${escapeHtml(integer(commercial.domainAgeDays))} days` : "Unknown"}</strong></div>
            <div><span>Traffic</span><strong>${visits == null ? "No public model" : `${escapeHtml(integer(visits))}/mo · ${escapeHtml(commercial.trafficConfidence)}`}</strong></div>
            <div><span>Gross checkout</span><strong>${gmv == null ? "Not modeled" : `${escapeHtml(money(commercial.gmvLow, "USD", true))}–${escapeHtml(money(commercial.gmvHigh, "USD", true))}`}</strong></div>
            <div><span>Catalog</span><strong>${escapeHtml(integer(catalog.productCount))} products · ${escapeHtml(integer(catalog.variantCount))} offers</strong></div>
            <div><span>Price</span><strong>${catalog.priceMedian == null ? "Unknown" : `${escapeHtml(money(catalog.priceMin, catalog.currency))}–${escapeHtml(money(catalog.priceMax, catalog.currency))} · median ${escapeHtml(money(catalog.priceMedian, catalog.currency))}`}</strong></div>
            <div><span>Reta</span><strong>${escapeHtml(integer(catalog.retaProductCount))} products · ${escapeHtml(integer(catalog.retaVariantCount))} offers</strong></div>
            <div><span>Public stock</span><strong>${escapeHtml(integer(catalog.visibleStockRecords))} binary records · ${escapeHtml(percent(catalog.visibleInStockRate))} shown in stock</strong></div>
            <div><span>Exact quantity</span><strong>${escapeHtml(integer(catalog.exactQuantityRecords))} positive public fields</strong></div>
          </div>
          <div class="ci-company-links">
            ${link(commercial.storefrontUrl, "Website ↗")}
            ${link(commercial.domainAgeSource, "Domain age ↗")}
            ${link(commercial.rankSource, "Rank history ↗")}
          </div>
          ${modelEvidenceMarkup(row)}
          <details class="ci-reta">
            <summary>Reta products and prices</summary>
            ${retaOfferMarkup(row)}
          </details>
          <div class="ci-full-catalog">
            <button type="button" data-ci-catalog="${escapeHtml(row.domain)}">Load full catalog</button>
            <a href="./noli-competitor-catalog-2026-07-27.csv">Open master CSV</a>
            <div data-ci-catalog-target="${escapeHtml(row.domain)}" aria-live="polite"></div>
          </div>
          <p class="ci-boundary"><strong>Boundary:</strong> ${escapeHtml(commercial.caveat)} ${escapeHtml(catalog.caveat)}</p>
        </div>
      </details>
    `;
  }

  function render() {
    const matched = filteredRows();
    const visible = matched.slice(0, visibleCount);
    resultCount.textContent = `${integer(matched.length)} companies`;
    list.innerHTML = visible.length
      ? visible.map(rowMarkup).join("")
      : `<p class="ci-empty">No companies match those filters.</p>`;
    loadMore.hidden = visible.length >= matched.length;
    loadMore.textContent = `Show ${Math.min(PAGE_SIZE, matched.length - visible.length)} more`;
  }

  async function getCatalogRows(domain) {
    if (!catalogPromises.has(domain)) {
      const safeDomain = encodeURIComponent(domain);
      const promise = fetch(`./noli-competitor-catalogs/${safeDomain}.json`, {
        credentials: "same-origin",
      }).then((response) => {
        if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
        return response.json();
      }).then((payload) => payload.offers || []).catch((error) => {
        catalogPromises.delete(domain);
        throw error;
      });
      catalogPromises.set(domain, promise);
    }
    return catalogPromises.get(domain);
  }

  function renderCatalogRows(domain, target, allRows) {
    const state = catalogViews.get(domain) || { limit: 50, query: "" };
    catalogViews.set(domain, state);
    const query = state.query.toLowerCase();
    const matched = allRows.filter((row) =>
      !query ||
      [
        row.productTitle,
        row.options,
        row.category,
        row.publicSkuId,
      ].join(" ").toLowerCase().includes(query)
    );
    const visible = matched.slice(0, state.limit);
    target.innerHTML = `
      <div class="ci-catalog-controls">
        <label>
          <span>Search this catalog</span>
          <input type="search" value="${escapeHtml(state.query)}" data-ci-catalog-search="${escapeHtml(domain)}" placeholder="Product, strength, SKU">
        </label>
        <small>${escapeHtml(integer(matched.length))} matching offers</small>
      </div>
      <div class="ci-catalog-table-wrap">
        <table class="ci-catalog-table">
          <thead><tr><th>Product</th><th>Option</th><th>Price</th><th>Stock</th><th>Exact qty</th><th>Source</th></tr></thead>
          <tbody>
            ${visible.map((row) => `
              <tr>
                <td>${escapeHtml(row.productTitle)}</td>
                <td>${escapeHtml(row.options || "—")}</td>
                <td>${escapeHtml(money(row.currentPrice, row.currency))}</td>
                <td>${escapeHtml(row.stockStatus || "unknown")}</td>
                <td>${escapeHtml(row.exactPublicQuantity == null ? "—" : integer(row.exactPublicQuantity))}</td>
                <td>${row.canonicalUrl ? link(row.canonicalUrl, "PDP ↗") : row.sourceUrl ? link(row.sourceUrl, "Evidence ↗") : "—"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      ${visible.length < matched.length
        ? `<button type="button" class="ci-catalog-more" data-ci-catalog-more="${escapeHtml(domain)}">Show ${escapeHtml(integer(Math.min(50, matched.length - visible.length)))} more</button>`
        : ""}
    `;
  }

  root.addEventListener("click", async (event) => {
    const catalogButton = event.target.closest("[data-ci-catalog]");
    if (catalogButton) {
      const domain = catalogButton.dataset.ciCatalog;
      const target = root.querySelector(`[data-ci-catalog-target="${CSS.escape(domain)}"]`);
      if (!target) return;
      catalogButton.disabled = true;
      catalogButton.textContent = "Loading catalog…";
      try {
        const offers = await getCatalogRows(domain);
        renderCatalogRows(domain, target, offers);
        catalogButton.hidden = true;
      } catch (error) {
        target.innerHTML = `<p class="ci-empty">The inline catalog could not load. <a href="./noli-competitor-catalog-2026-07-27.csv">Open the master CSV instead.</a></p>`;
        catalogButton.disabled = false;
        catalogButton.textContent = "Retry full catalog";
      }
      return;
    }

    const moreButton = event.target.closest("[data-ci-catalog-more]");
    if (moreButton) {
      const domain = moreButton.dataset.ciCatalogMore;
      const state = catalogViews.get(domain) || { limit: 50, query: "" };
      state.limit += 50;
      catalogViews.set(domain, state);
      const offers = await getCatalogRows(domain);
      const target = root.querySelector(`[data-ci-catalog-target="${CSS.escape(domain)}"]`);
      if (target) renderCatalogRows(domain, target, offers);
    }
  });

  root.addEventListener("input", async (event) => {
    const catalogSearch = event.target.closest("[data-ci-catalog-search]");
    if (!catalogSearch) return;
    const domain = catalogSearch.dataset.ciCatalogSearch;
    const state = catalogViews.get(domain) || { limit: 50, query: "" };
    state.query = catalogSearch.value;
    state.limit = 50;
    catalogViews.set(domain, state);
    const offers = await getCatalogRows(domain);
    const target = root.querySelector(`[data-ci-catalog-target="${CSS.escape(domain)}"]`);
    if (target) renderCatalogRows(domain, target, offers);
    requestAnimationFrame(() => {
      const replacement = root.querySelector(`[data-ci-catalog-search="${CSS.escape(domain)}"]`);
      replacement?.focus();
      replacement?.setSelectionRange(replacement.value.length, replacement.value.length);
    });
  });

  [search, filter, sort].forEach((control) => {
    control.addEventListener(control === search ? "input" : "change", () => {
      visibleCount = PAGE_SIZE;
      render();
    });
  });

  loadMore.addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    render();
  });

  renderStats();
  renderCases();
  render();
})();
