(function () {
  "use strict";

  const data = window.NOLI_RETATRUTIDE_VENDOR_UNIVERSE;
  const list = document.getElementById("vendor-radar-list");
  if (!data || !list) return;

  const search = document.getElementById("vendor-search");
  const evidenceFilter = document.getElementById("vendor-evidence-filter");
  const paymentFilter = document.getElementById("vendor-payment-filter");
  const sort = document.getElementById("vendor-sort");
  const resultCount = document.getElementById("vendor-result-count");
  const loadMore = document.getElementById("vendor-load-more");
  const stats = document.getElementById("vendor-radar-stats");

  const PAGE_SIZE = 24;
  let visibleCount = PAGE_SIZE;

  const escapeHtml = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character]));

  const safeUrl = (value) => {
    if (!value) return null;
    try {
      const parsed = new URL(String(value), window.location.href);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
    } catch (_error) {
      return null;
    }
  };

  const link = (url, label, className = "") => {
    const safe = safeUrl(url);
    if (!safe) return "";
    const classAttribute = className ? ` class="${escapeHtml(className)}"` : "";
    return `<a${classAttribute} href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  };

  const parseRecentDate = (value) => {
    if (!value) return 0;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  };

  const paymentHaystack = (vendor) =>
    [
      ...(vendor.payments || []),
      vendor.paymentEvidence,
      vendor.paymentNote
    ].filter(Boolean).join(" ").toLowerCase();

  function matchesEvidence(vendor, filter) {
    if (filter === "all") return true;
    if (filter === "audited") return vendor.payments.length > 0;
    if (filter === "confirmed-retail") return vendor.retailStatus === "Confirmed US storefront";
    if (filter === "probable-retail") {
      return vendor.retailStatus === "Probable or gated US storefront";
    }
    if (filter === "listed-active") return vendor.statusBucket === "Listed active";
    if (filter === "search-discovered") return vendor.statusBucket === "Search-discovered";
    if (filter === "unavailable") {
      return ["Inactive", "Not found", "Payment problems"].includes(vendor.statusBucket);
    }
    return true;
  }

  function matchesPayment(vendor, filter) {
    if (filter === "all") return true;
    const haystack = paymentHaystack(vendor);
    if (filter === "bank") {
      return /(bank|ach|echeck|e-check|wire|plaid|link money|paynote|seamless)/.test(haystack);
    }
    if (filter === "crypto") {
      return /(crypto|bitcoin|btc|ethereum|eth|usdt|usdc|blockonomics|depay|opennode|btcpay|forum)/.test(haystack);
    }
    if (filter === "p2p") {
      return /(zelle|venmo|cash app|apple cash|p2p|manual|chime)/.test(haystack);
    }
    if (filter === "card") {
      return /(card|nmi|authorize|stripe|quantum|chargeanywhere|tagada|circoflows|mnet|paygate|idem)/.test(haystack);
    }
    return haystack.includes(filter);
  }

  function vendorHaystack(vendor) {
    return [
      vendor.name,
      vendor.domain,
      vendor.platform,
      vendor.status,
      vendor.statusBucket,
      vendor.retailStatus,
      vendor.source.join(" "),
      paymentHaystack(vendor)
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function filteredVendors() {
    const query = search.value.trim().toLowerCase();
    const evidence = evidenceFilter.value;
    const payment = paymentFilter.value;
    const order = sort.value;

    const filtered = data.vendors.filter((vendor) =>
      (!query || vendorHaystack(vendor).includes(query)) &&
      matchesEvidence(vendor, evidence) &&
      matchesPayment(vendor, payment)
    );

    filtered.sort((left, right) => {
      if (order === "name") return left.name.localeCompare(right.name);
      if (order === "tests") {
        return right.testCount - left.testCount || left.name.localeCompare(right.name);
      }
      if (order === "newest") {
        return parseRecentDate(right.latestTest) - parseRecentDate(left.latestTest) ||
          right.testCount - left.testCount;
      }
      const leftAudit = left.payments.length > 0 ? 1 : 0;
      const rightAudit = right.payments.length > 0 ? 1 : 0;
      return rightAudit - leftAudit ||
        right.testCount - left.testCount ||
        left.name.localeCompare(right.name);
    });

    return filtered;
  }

  function statusClass(vendor) {
    if (vendor.retailStatus === "Confirmed US storefront") return "is-active";
    if (vendor.retailStatus === "Probable or gated US storefront") return "is-discovered";
    if (vendor.retailStatus === "Excluded from current US retail") return "is-muted";
    if (vendor.statusBucket === "Listed active") return "is-active";
    if (vendor.statusBucket === "Search-discovered") return "is-discovered";
    if (vendor.statusBucket === "Payment problems") return "is-warning";
    return "is-muted";
  }

  function renderVendor(vendor) {
    const primaryUrl = vendor.productUrl || vendor.url;
    const paymentMarkup = vendor.payments.length
      ? `
        <div class="vendor-payment-list" aria-label="Observed or claimed payment methods">
          ${vendor.payments.map((method) => `<span>${escapeHtml(method)}</span>`).join("")}
        </div>
        <p class="vendor-payment-proof"><strong>${escapeHtml(vendor.paymentEvidence || "Payment evidence")}</strong>${vendor.paymentNote ? ` · ${escapeHtml(vendor.paymentNote)}` : ""}</p>
      `
      : `<p class="vendor-payment-empty">Checkout not yet deep-audited.</p>`;

    const facts = [
      vendor.retailStatus && vendor.retailStatus !== "Vendor identity not retail-classified"
        ? `<span>${escapeHtml(vendor.retailStatus)}</span>`
        : "",
      vendor.platform ? `<span>${escapeHtml(vendor.platform)}</span>` : "",
      vendor.testCount ? `<span>${escapeHtml(vendor.testCount)} Reta tests</span>` : "",
      vendor.latestTest ? `<span>Latest ${escapeHtml(vendor.latestTest)}</span>` : "",
      vendor.pricePerMg ? `<span>${escapeHtml(vendor.pricePerMg)} / mg observed</span>` : ""
    ].filter(Boolean).join("");

    return `
      <article class="vendor-radar-card">
        <header>
          <div>
            <span class="vendor-status ${statusClass(vendor)}">${escapeHtml(
              vendor.retailStatus && vendor.retailStatus !== "Vendor identity not retail-classified"
                ? vendor.retailStatus
                : vendor.statusBucket
            )}</span>
            <h3>${primaryUrl ? link(primaryUrl, vendor.name) : escapeHtml(vendor.name)}</h3>
            <p>${escapeHtml(vendor.domain || "No public domain")}</p>
          </div>
          ${vendor.payments.length ? `<span class="vendor-audit-badge">Checkout audited</span>` : ""}
        </header>
        <div class="vendor-facts">${facts || "<span>Directory record only</span>"}</div>
        ${paymentMarkup}
        <footer>
          ${vendor.productUrl ? link(vendor.productUrl, "Product ↗") : ""}
          ${vendor.url ? link(vendor.url, "Website ↗") : ""}
          ${vendor.finnrickUrl ? link(vendor.finnrickUrl, "Test history ↗") : ""}
        </footer>
      </article>
    `;
  }

  function renderStats() {
    if (!stats) return;
    const cards = [
      [data.stats.total, "public vendor identities"],
      [data.stats.finnrickRetatrutideVendors, "with Reta test history"],
      [data.stats.linkedWebsites, "linked public profiles"],
      [`${data.stats.checkoutAudited}+`, "checkout paths audited"]
    ];
    stats.innerHTML = cards.map(([value, label]) => `
      <div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>
    `).join("");
  }

  function render() {
    const vendors = filteredVendors();
    const visible = vendors.slice(0, visibleCount);
    list.innerHTML = visible.length
      ? visible.map(renderVendor).join("")
      : `
        <div class="vendor-radar-empty">
          <strong>No matching vendors.</strong>
          <p>Clear a filter or try a broader term.</p>
        </div>
      `;
    resultCount.textContent = `Showing ${visible.length.toLocaleString()} of ${vendors.length.toLocaleString()} matching vendors`;
    loadMore.hidden = visible.length >= vendors.length;
  }

  function resetAndRender() {
    visibleCount = PAGE_SIZE;
    render();
  }

  [search, evidenceFilter, paymentFilter, sort].forEach((control) => {
    control.addEventListener(control === search ? "input" : "change", resetAndRender);
  });

  loadMore.addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    render();
  });

  renderStats();
  render();
})();
