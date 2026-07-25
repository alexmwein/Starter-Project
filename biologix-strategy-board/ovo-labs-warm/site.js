(() => {
  "use strict";

  const body = document.body;
  const root = document.querySelector("#site-root");
  if (!root) return;

  const BASE = body.dataset.base || ".";
  const PAGE = body.dataset.page || "home";
  const PRODUCT_SLUG = body.dataset.product || "";
  const CART_KEY = "ovo-labs-demo-cart-v2";
  const RECENT_KEY = "ovo-labs-recent-products-v1";
  const ORDER_KEY = "ovo-labs-orders-v1";
  const CHECKOUT_KEY = "ovo-labs-checkout-draft-v1";
  const MAX_QUANTITY = 10;

  const CHECKOUT_STEPS = [
    { key: "contact", label: "Contact" },
    { key: "shipping", label: "Shipping" },
    { key: "delivery", label: "Delivery" },
    { key: "payment", label: "Payment" },
    { key: "review", label: "Review" },
  ];

  const SHIPPING_METHODS = [
    { id: "standard", name: "Standard", detail: "3 to 5 business days", note: "Insulated mailer", price: 12 },
    { id: "express", name: "Express", detail: "2 business days", note: "Insulated mailer, tracked", price: 18 },
    { id: "cold", name: "Cold chain overnight", detail: "Next business day by 12:00", note: "Gel pack, temperature logger", price: 45 },
  ];

  const PROMO_CODES = {
    "OVO-FIRST": { label: "First order", type: "percent", value: 10 },
    "COLDCHAIN": { label: "Free cold chain", type: "shipping", value: 100 },
  };

  const TAX_RATE = 0.0725;
  const FREE_SHIPPING_THRESHOLD = 500;

  const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];

  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  const PRODUCTS = [
    {
      slug: "retatrutide",
      code: "OVO-001",
      name: "Retatrutide",
      category: "GLP-1 & Metabolic",
      categoryKey: "metabolic",
      strength: "10 mg",
      format: "Lyophilized vial",
      price: 105,
      descriptor: "Synthetic triple-agonist incretin-class research compound.",
      facts: ["10 mg labeled amount", "Single-vial format", "No result reported"],
      overview:
        "A focused catalog entry for retatrutide research reference work. Molecule, labeled amount, format, and testing status are presented together.",
    },
    {
      slug: "tirzepatide",
      code: "OVO-002",
      name: "Tirzepatide",
      category: "GLP-1 & Metabolic",
      categoryKey: "metabolic",
      strength: "10 mg",
      format: "Lyophilized vial",
      price: 100,
      descriptor: "Synthetic dual incretin-receptor agonist research compound.",
      facts: ["10 mg labeled amount", "Single-vial format", "No result reported"],
      overview:
        "A clear catalog entry for tirzepatide reference research, with labeled amount, product identity, format, and testing status in one decision block.",
    },
    {
      slug: "semaglutide",
      code: "OVO-003",
      name: "Semaglutide",
      category: "GLP-1 & Metabolic",
      categoryKey: "metabolic",
      strength: "10 mg",
      format: "Lyophilized vial",
      price: 90,
      descriptor: "Synthetic GLP-1 receptor agonist research compound.",
      facts: ["10 mg labeled amount", "Single-vial format", "No result reported"],
      overview:
        "A structured semaglutide catalog entry with direct access to the product’s testing status and comparison-ready product facts.",
    },
    {
      slug: "cagrilintide",
      code: "OVO-004",
      name: "Cagrilintide",
      category: "GLP-1 & Metabolic",
      categoryKey: "metabolic",
      strength: "10 mg",
      format: "Lyophilized vial",
      price: 89,
      descriptor: "Long-acting amylin-analogue research compound.",
      facts: ["10 mg labeled amount", "Single-vial format", "No result reported"],
      overview:
        "A cagrilintide research catalog entry organized around identity, labeled amount, format, and testing status.",
    },
    {
      slug: "bpc-157",
      code: "OVO-005",
      name: "BPC-157",
      category: "Research Peptides",
      categoryKey: "research",
      strength: "10 mg",
      format: "Lyophilized vial",
      price: 60,
      descriptor: "Synthetic pentadecapeptide research compound.",
      facts: ["10 mg labeled amount", "Single-vial format", "No result reported"],
      overview:
        "A BPC-157 catalog entry with a compact, neutral specification surface and visible testing status.",
    },
    {
      slug: "tb-500",
      code: "OVO-006",
      name: "TB-500",
      category: "Research Peptides",
      categoryKey: "research",
      strength: "10 mg",
      format: "Lyophilized vial",
      price: 68,
      descriptor: "Synthetic thymosin beta-4 fragment research compound.",
      facts: ["10 mg labeled amount", "Single-vial format", "No result reported"],
      overview:
        "A TB-500 catalog entry that puts identity, labeled amount, format, price, and testing status in a single decision layout.",
    },
    {
      slug: "cjc-1295",
      code: "OVO-007",
      name: "CJC-1295",
      category: "Growth Hormone Research",
      categoryKey: "growth",
      strength: "5 mg",
      format: "Lyophilized vial",
      price: 52,
      descriptor: "Synthetic GHRH-analogue research compound.",
      facts: ["5 mg labeled amount", "Single-vial format", "No result reported"],
      overview:
        "A CJC-1295 catalog entry built to make the exact product easy to find, compare, and inspect.",
    },
    {
      slug: "ipamorelin",
      code: "OVO-008",
      name: "Ipamorelin",
      category: "Growth Hormone Research",
      categoryKey: "growth",
      strength: "5 mg",
      format: "Lyophilized vial",
      price: 45,
      descriptor: "Synthetic growth-hormone secretagogue research compound.",
      facts: ["5 mg labeled amount", "Single-vial format", "No result reported"],
      overview:
        "An ipamorelin research catalog entry with simple product identification, comparable specifications, and visible testing status.",
    },
    {
      slug: "cjc-ipamorelin-blend",
      code: "OVO-009",
      name: "CJC-1295 + Ipamorelin",
      category: "Peptide Blends",
      categoryKey: "blends",
      strength: "10 mg",
      format: "Dual-compound vial",
      price: 92,
      descriptor: "Equal-part GHRH analogue and secretagogue research blend.",
      facts: ["5 mg + 5 mg labeled", "Single-vial blend format", "No result reported"],
      overview:
        "A two-compound blend shown as its own product, with each constituent and the testing status kept explicit.",
    },
    {
      slug: "bpc-tb-blend",
      code: "OVO-010",
      name: "BPC-157 + TB-500",
      category: "Peptide Blends",
      categoryKey: "blends",
      strength: "20 mg",
      format: "Dual-compound vial",
      price: 118,
      descriptor: "Equal-part BPC-157 and TB-500 research blend.",
      facts: ["10 mg + 10 mg labeled", "Single-vial blend format", "No result reported"],
      overview:
        "A two-compound blend with its own product identity, labeled composition, and testing status.",
    },
  ];

  const BUNDLES = [
    {
      slug: "metabolic-reference-set",
      code: "OVO-S01",
      name: "Metabolic Reference Set",
      category: "Curated Set",
      strength: "2 vials",
      format: "Retatrutide + Cagrilintide",
      price: 169,
      descriptor: "Two distinct incretin and amylin-class research references.",
      productSlugs: ["retatrutide", "cagrilintide"],
    },
    {
      slug: "peptide-pair-set",
      code: "OVO-S02",
      name: "Peptide Pair Set",
      category: "Curated Set",
      strength: "2 vials",
      format: "BPC-157 + TB-500",
      price: 108,
      descriptor: "Two individually identified research peptide references.",
      productSlugs: ["bpc-157", "tb-500"],
    },
    {
      slug: "secretagogue-reference-set",
      code: "OVO-S03",
      name: "Secretagogue Reference Set",
      category: "Curated Set",
      strength: "2 vials",
      format: "CJC-1295 + Ipamorelin",
      price: 82,
      descriptor: "Two separate growth-hormone research references.",
      productSlugs: ["cjc-1295", "ipamorelin"],
    },
  ];

  const CATEGORIES = [
    { key: "all", name: "Shop All", note: `${PRODUCTS.length} catalog entries` },
    { key: "metabolic", name: "GLP-1 & Metabolic", note: "4 individual compounds" },
    { key: "research", name: "Research Peptides", note: "2 individual compounds" },
    { key: "growth", name: "Growth Hormone Research", note: "2 individual compounds" },
    { key: "blends", name: "Peptide Blends", note: "2 defined blends" },
  ];

  const ARTICLES = [
    {
      slug: "reading-testing-status",
      title: "How to read a testing status",
      summary: "A result, a specification, and an unreported field are three different things.",
    },
    {
      slug: "choosing-by-molecule",
      title: "Shop by molecule, not by hype",
      summary: "A practical catalog framework for comparing identity, strength, format, and evidence state.",
    },
    {
      slug: "coa-boundaries",
      title: "What a COA can and cannot show",
      summary: "Why a document’s method and scope matter more than the letters at the top.",
    },
  ];

  const ALL_CART_ITEMS = [...PRODUCTS, ...BUNDLES];

  const icons = {
    menu:
      '<svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    cart:
      '<svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 4h2l2.4 10.1a2 2 0 0 0 2 1.5h7.8a2 2 0 0 0 1.9-1.4L21 8H7"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg>',
    arrow: '<span aria-hidden="true">→</span>',
  };

  function path(relative) {
    return `${BASE}/${relative}`.replace(/\/\.\//g, "/");
  }

  function productPath(product) {
    return path(`peptides/${product.slug}.html`);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function track(event, properties = {}) {
    const payload = {
      event,
      page_type: PAGE,
      timestamp: new Date().toISOString(),
      ...properties,
    };
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
    window.dispatchEvent(new CustomEvent("ovolabs:analytics", { detail: payload }));
  }

  window.OvoLabsAnalytics = {
    events: () => [...(window.dataLayer || [])],
    clear: () => {
      window.dataLayer = [];
    },
  };

  function activePage(name) {
    if (name === "shop" && ["collection", "product"].includes(PAGE)) return true;
    if (name === "testing" && PAGE === "testing") return true;
    if (name === "bundles" && PAGE === "bundles") return true;
    if (name === "learn" && ["learn", "article"].includes(PAGE)) return true;
    if (name === "about" && ["about", "policy"].includes(PAGE)) return true;
    return false;
  }

  function header() {
    const nav = [
      ["shop", "Shop", "catalog.html"],
      ["bundles", "Bundles", "bundles.html"],
      ["testing", "Testing & COAs", "testing.html"],
      ["learn", "Learn", "notes.html"],
    ];
    const categoryLinks = CATEGORIES.map(
      (category) =>
        `<a href="${path(`catalog.html${category.key === "all" ? "" : `?category=${category.key}`}`)}">${category.name}</a>`,
    ).join("");

    return `
      <a class="skip-link" href="#main-content">Skip to content</a>
      <div class="concept-banner" role="note">
        Fictional concept storefront. Nothing here is real, stocked, or for sale.
      </div>
      <header class="site-header">
        <div class="shell header-main">
          <a class="wordmark" href="${path("index.html")}" aria-label="OVO Labs home">
            <span class="wordmark-mark" aria-hidden="true">O</span>
            <span class="wordmark-copy">
              <span class="wordmark-name">OVO Labs</span>
              <span class="wordmark-category">PEPTIDES</span>
            </span>
          </a>
          <nav class="primary-nav" aria-label="Primary navigation">
            ${nav
              .map(
                ([key, label, href]) =>
                  `<a href="${path(href)}"${activePage(key) ? ' aria-current="page"' : ""}>${label}</a>`,
              )
              .join("")}
          </nav>
          <div class="search-wrap">
            <span class="search-icon" aria-hidden="true"></span>
            <label class="sr-only" for="site-search">Search products and product codes</label>
            <input
              class="search-input"
              id="site-search"
              type="search"
              role="combobox"
              placeholder="Search molecule or code"
              autocomplete="off"
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls="search-results"
              aria-expanded="false"
            >
            <span class="search-shortcut" aria-hidden="true">⌘K</span>
            <div class="search-results" id="search-results" role="listbox" hidden></div>
          </div>
          <div class="header-actions">
            <button class="icon-button mobile-menu-button" type="button" data-menu-open aria-label="Open menu">
              ${icons.menu}
            </button>
            <button class="icon-button" type="button" data-cart-open aria-label="Open cart">
              ${icons.cart}
              <span class="cart-count" data-cart-count hidden>0</span>
            </button>
          </div>
        </div>
        <div class="category-nav-wrap">
          <nav class="shell category-nav" aria-label="Shop by category">${categoryLinks}</nav>
        </div>
      </header>
    `;
  }

  function footer() {
    return `
      <footer class="site-footer">
        <div class="shell">
          <div class="footer-grid">
            <div class="footer-brand">
              <a class="wordmark" href="${path("index.html")}" aria-label="OVO Labs home">
                <span class="wordmark-mark" aria-hidden="true">O</span>
                <span class="wordmark-copy">
                  <span class="wordmark-name">OVO Labs</span>
                  <span class="wordmark-category">PEPTIDES</span>
                </span>
              </a>
              <p>Clear product data, focused categories, and visible testing status at the point of choice.</p>
            </div>
            <div class="footer-column">
              <h2>Shop</h2>
              <a href="${path("catalog.html")}">All products</a>
              <a href="${path("catalog.html?category=metabolic")}">GLP-1 & metabolic</a>
              <a href="${path("catalog.html?category=research")}">Research peptides</a>
              <a href="${path("catalog.html?category=blends")}">Peptide blends</a>
            </div>
            <div class="footer-column">
              <h2>Information</h2>
              <a href="${path("testing.html")}">Testing & COAs</a>
              <a href="${path("notes.html")}">Learn</a>
              <a href="${path("faq.html")}">FAQ</a>
              <a href="${path("company.html")}">About OVO Labs</a>
              <a href="${path("policies.html")}">Site policies</a>
            </div>
            <div class="footer-column">
              <h2>Popular entries</h2>
              <a href="${productPath(PRODUCTS[0])}">Retatrutide 10 mg</a>
              <a href="${productPath(PRODUCTS[1])}">Tirzepatide 10 mg</a>
              <a href="${productPath(PRODUCTS[4])}">BPC-157 10 mg</a>
              <a href="${productPath(PRODUCTS[8])}">CJC-1295 + Ipamorelin</a>
            </div>
          </div>
          <div class="footer-bottom">
            <div>© 2026 OVO Labs.</div>
            <span>This catalog does not provide medical advice or human-use instructions.</span>
          </div>
        </div>
      </footer>
    `;
  }

  function drawers() {
    return `
      <div class="drawer-backdrop" data-drawer-backdrop data-open="false"></div>
      <aside class="cart-drawer" data-cart-drawer data-open="false" aria-hidden="true" aria-labelledby="cart-title">
        <div class="drawer-head">
          <h2 id="cart-title">Your cart</h2>
          <button class="drawer-close" type="button" data-cart-close aria-label="Close cart">×</button>
        </div>
        <div class="cart-items" data-cart-items></div>
        <div class="cart-footer" data-cart-footer></div>
      </aside>
      <aside class="mobile-drawer" data-mobile-drawer data-open="false" aria-hidden="true" aria-labelledby="menu-title">
        <div class="drawer-head">
          <h2 id="menu-title">Menu</h2>
          <button class="drawer-close" type="button" data-menu-close aria-label="Close menu">×</button>
        </div>
        <nav class="mobile-nav" aria-label="Mobile navigation">
          <a href="${path("catalog.html")}">Shop all</a>
          <a href="${path("bundles.html")}">Bundles</a>
          <a href="${path("testing.html")}">Testing & COAs</a>
          <a href="${path("notes.html")}">Learn</a>
          <a href="${path("faq.html")}">FAQ</a>
          <a href="${path("company.html")}">About OVO Labs</a>
          <a href="${path("policies.html")}">Site policies</a>
        </nav>
      </aside>
      <div class="toast" data-toast aria-live="polite" data-open="false"></div>
    `;
  }

  function layout(main) {
    root.innerHTML = `${header()}<main id="main-content">${main}</main>${footer()}${drawers()}`;
  }

  function productImage(product, eager = false) {
    return `
      <img
        src="${path("assets/ovo-vial-front.webp")}"
        alt="OVO Labs vial for ${escapeHtml(product.name)}"
        width="1024"
        height="1024"
        ${eager ? 'fetchpriority="high"' : 'loading="lazy"'}
      >
      <span class="product-image-label" aria-hidden="true">
        <strong>${escapeHtml(product.name)}</strong>
        <span>${escapeHtml(product.strength)} · ${escapeHtml(product.code)}</span>
      </span>
    `;
  }

  function productCard(product, options = {}) {
    const { eager = false } = options;
    return `
      <article class="product-card" data-product-card="${product.slug}">
        <a class="product-image-wrap" href="${productPath(product)}" data-product-link="${product.slug}">
          ${productImage(product, eager)}
        </a>
        <div class="product-card-body">
          <p class="product-category">${escapeHtml(product.category)}</p>
          <h3 class="product-name"><a href="${productPath(product)}" data-product-link="${product.slug}">${escapeHtml(product.name)} · ${escapeHtml(product.strength)}</a></h3>
          <p class="product-description">${escapeHtml(product.descriptor)}</p>
          <div class="testing-micro">
            <span><span class="testing-micro-dot" aria-hidden="true"></span>Testing status · No result reported</span>
            <a href="${path(`testing.html?product=${product.code}`)}">View status</a>
          </div>
          <div class="product-buy-row">
            <div>
              <span class="price">${money.format(product.price)}</span>
            </div>
            <button class="add-button" type="button" data-add-product="${product.slug}">Add to cart</button>
          </div>
        </div>
      </article>
    `;
  }

  function categoryRail() {
    return `
      <div class="category-rail" aria-label="Shop by research area">
        ${CATEGORIES.slice(1)
          .map(
            (category) => `
              <a class="category-tile" href="${path(`catalog.html?category=${category.key}`)}">
                <span>
                  <strong>${category.name}</strong>
                  <span>${category.note}</span>
                </span>
                <span class="category-arrow" aria-hidden="true">→</span>
              </a>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function bundleCard(bundle) {
    const items = bundle.productSlugs.map((slug) => PRODUCTS.find((product) => product.slug === slug));
    return `
      <article class="bundle-card">
        <div class="bundle-image">
          <img src="${path("assets/ovo-set-pair.webp")}" alt="Two OVO Labs amber peptide vials for ${escapeHtml(bundle.name)}" width="1536" height="1024" loading="lazy">
          <span class="bundle-count">2 products</span>
        </div>
        <div class="bundle-body">
          <p class="product-category">Catalog set</p>
          <h3>${escapeHtml(bundle.name)}</h3>
          <p>${escapeHtml(bundle.descriptor)}</p>
          <ul class="bundle-items">
            ${items
              .map(
                (product) =>
                  `<li><a href="${productPath(product)}">${escapeHtml(product.name)}</a><span>${escapeHtml(product.strength)}</span></li>`,
              )
              .join("")}
          </ul>
          <div class="bundle-footer">
            <div>
              <span class="price-label">Set price</span>
              <span class="price">${money.format(bundle.price)}</span>
            </div>
            <button class="add-button" type="button" data-add-product="${bundle.slug}">Add set to cart</button>
          </div>
        </div>
      </article>
    `;
  }

  function newsletter() {
    return `
      <section class="section-tight">
        <div class="shell newsletter">
          <div>
            <h2>Get the catalog brief.</h2>
            <p>Get catalog additions, document updates, and practical explainers. No dosing or medical-use content.</p>
          </div>
          <form class="newsletter-form" data-newsletter novalidate>
            <label class="sr-only" for="newsletter-email">Email address</label>
            <input id="newsletter-email" name="email" type="email" placeholder="you@example.com" required>
            <button type="submit">Get updates</button>
          </form>
          <p class="newsletter-success" data-newsletter-success hidden role="status"></p>
        </div>
      </section>
    `;
  }

  function homePage() {
    return `
      <section class="home-hero">
        <div class="shell hero-grid">
          <div class="hero-copy">
            <p class="eyebrow">Peptide research catalog</p>
            <h1>Peptides, <span>without the mystery.</span></h1>
            <p>A focused catalog with clear formats, testing status beside every product, and a fast path from search to cart.</p>
            <div class="hero-actions">
              <a class="button button-primary" href="${path("catalog.html")}">Shop peptides ${icons.arrow}</a>
              <a class="button button-secondary" href="${path("testing.html")}">View testing & COAs</a>
            </div>
          </div>
          <div class="hero-visual">
            <img src="${path("assets/ovo-hero-still.webp")}" alt="An OVO Labs amber peptide vial with a gold cap resting on a travertine ledge in warm window light" width="1536" height="1024" fetchpriority="high">
            <a class="hero-product-chip" href="${productPath(PRODUCTS[0])}">
              <span>Featured catalog entry</span>
              <strong>Retatrutide · 10 mg</strong>
              <p>${money.format(PRODUCTS[0].price)} · View product →</p>
            </a>
            <a class="hero-coa-card" href="${path("testing.html")}">
              <span>Testing status</span>
              <div class="hero-coa-row">
                <span>Reported result</span>
                <strong>None</strong>
              </div>
              <div class="hero-coa-row">
                <span>Method scope</span>
                <strong>See framework</strong>
              </div>
            </a>
          </div>
        </div>
      </section>
      <div class="trust-strip" aria-label="Store principles">
        <div class="trust-item"><span class="trust-dot" aria-hidden="true"></span><strong>10 focused products</strong></div>
        <div class="trust-item"><span class="trust-dot" aria-hidden="true"></span><strong>4 clear categories</strong></div>
        <div class="trust-item"><span class="trust-dot" aria-hidden="true"></span><strong>Search by name or code</strong></div>
        <div class="trust-item"><span class="trust-dot" aria-hidden="true"></span><strong>Testing status on every item</strong></div>
      </div>
      <section class="section">
        <div class="shell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Shop peptides</p>
              <h2>Start with the catalog.</h2>
            </div>
            <a class="text-link" href="${path("catalog.html")}">View all products ${icons.arrow}</a>
          </div>
          <div class="product-grid">
            ${PRODUCTS.slice(0, 4)
              .map((product, index) => productCard(product, { eager: index < 2 }))
              .join("")}
          </div>
          <div class="section-head category-section-head">
            <div>
              <p class="eyebrow">Shop by category</p>
              <h2>Browse the catalog your way.</h2>
            </div>
            <p>Use broad categories when you are exploring. Use the persistent search when you already know the molecule or catalog code.</p>
          </div>
          ${categoryRail()}
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell testing-feature">
          <div class="testing-feature-copy">
            <p class="eyebrow">Testing & COAs</p>
            <h2>See what is reported. See what is not.</h2>
            <p>Every product carries a testing status beside the decision. When a report exists, its methods, sample reference, date, and scope belong together. When it does not, the page says so.</p>
            <a class="button button-secondary" href="${path("testing.html")}">Browse testing records</a>
          </div>
          <div class="testing-document" aria-label="Example testing-status document">
            <div class="document-head">
              <div>
                <strong>OVO-001 · Retatrutide</strong>
                <span>TESTING STATUS</span>
              </div>
              <span class="document-tag">NO RESULT REPORTED</span>
            </div>
            <div class="document-row"><strong>Identity</strong><span>Method not assigned · Result not reported</span></div>
            <div class="document-row"><strong>Content / mass</strong><span>Method not assigned · Result not reported</span></div>
            <div class="document-row"><strong>Purity profile</strong><span>Method not assigned · Result not reported</span></div>
            <div class="document-row"><strong>Sterility / endotoxin</strong><span>Not represented · Result not reported</span></div>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="shell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Curated paths</p>
              <h2>Reference sets</h2>
            </div>
            <a class="text-link" href="${path("bundles.html")}">Explore every set ${icons.arrow}</a>
          </div>
          <div class="bundle-grid">${BUNDLES.map(bundleCard).join("")}</div>
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Read before comparing</p>
              <h2>Three useful buying lenses</h2>
            </div>
            <a class="text-link" href="${path("notes.html")}">Open the learning center ${icons.arrow}</a>
          </div>
          <div class="education-grid">
            ${ARTICLES.map(
              (article) => `
                <article class="education-card">
                  <div>
                    <p class="product-category">4 minute guide</p>
                    <h3>${escapeHtml(article.title)}</h3>
                    <p>${escapeHtml(article.summary)}</p>
                  </div>
                  <a class="text-link" href="${path(`notes/${article.slug}.html`)}">Read the guide ${icons.arrow}</a>
                </article>
              `,
            ).join("")}
          </div>
        </div>
      </section>
      ${newsletter()}
    `;
  }

  function collectionPage() {
    return `
      <section class="page-hero">
        <div class="shell">
          <p class="eyebrow">The full catalog</p>
          <h1>Find the exact peptide entry.</h1>
          <p>Filter by research area, search by molecule or product code, then compare strength, format, testing status, and price without leaving the grid.</p>
        </div>
      </section>
      <section class="section">
        <div class="shell collection-layout">
          <aside class="filter-panel" aria-label="Filter products">
            <h2>Research area</h2>
            ${CATEGORIES.map(
              (category) => `
                <button class="filter-button" type="button" data-filter="${category.key}" aria-pressed="${category.key === "all"}">
                  ${category.name}
                  <span>${category.key === "all" ? PRODUCTS.length : PRODUCTS.filter((product) => product.categoryKey === category.key).length}</span>
                </button>
              `,
            ).join("")}
          </aside>
          <div class="collection-main">
            <div class="collection-toolbar">
              <label class="sr-only" for="collection-search">Search within the catalog</label>
              <input class="collection-search" id="collection-search" type="search" placeholder="Search name, code, category, or strength">
              <label class="sr-only" for="collection-sort">Sort products</label>
              <select class="collection-sort" id="collection-sort">
                <option value="featured">Sort: Featured</option>
                <option value="name-asc">Name: A–Z</option>
                <option value="price-asc">Price: Low–high</option>
                <option value="price-desc">Price: High–low</option>
              </select>
            </div>
            <p class="result-summary" data-result-summary aria-live="polite">${PRODUCTS.length} catalog entries</p>
            <div class="product-grid" data-collection-grid>
              ${PRODUCTS.map((product) => productCard(product)).join("")}
            </div>
          </div>
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Not sure where to start?</p>
              <h2>Use the testing state as a filter.</h2>
            </div>
            <p>Every entry currently shows the same clear state: no analytical result has been reported. The testing page explains what each method would and would not establish.</p>
          </div>
          <a class="button button-primary" href="${path("testing.html")}">Review testing & COAs ${icons.arrow}</a>
        </div>
      </section>
    `;
  }

  function testingPage() {
    return `
      <section class="page-hero">
        <div class="shell">
          <p class="eyebrow">Testing & COAs</p>
          <h1>Testing status belongs beside the product.</h1>
          <p>Search an OVO Labs product name or code to see the exact testing status. No certificate, laboratory relationship, result, or release claim is implied.</p>
          <form class="testing-lookup" data-testing-lookup>
            <label class="sr-only" for="testing-search">Search product name or code</label>
            <input id="testing-search" name="query" type="search" placeholder="Try OVO-001 or Retatrutide" autocomplete="off">
            <button class="button button-primary" type="submit">Check status</button>
          </form>
          <div class="lookup-results" data-lookup-results aria-live="polite"></div>
        </div>
      </section>
      <section class="section">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">The framework</p>
            <h2>Four fields. Four different questions.</h2>
            <p class="article-lede">A single number cannot answer identity, amount, composition, and microbiological questions at once.</p>
          </div>
          <div class="testing-table">
            <div class="testing-row"><strong>Identity</strong><span>Does the observed analytical profile match the intended compound?</span><span class="status-pill">NO RESULT</span></div>
            <div class="testing-row"><strong>Content / mass</strong><span>How much material is reported under the selected method?</span><span class="status-pill">NO RESULT</span></div>
            <div class="testing-row"><strong>Purity profile</strong><span>What relative composition is reported under the selected method?</span><span class="status-pill">NO RESULT</span></div>
            <div class="testing-row"><strong>Sterility / endotoxin</strong><span>Were separate microbiological methods represented?</span><span class="status-pill">NOT REPRESENTED</span></div>
          </div>
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Catalog status</p>
              <h2>Every current entry</h2>
            </div>
            <p>Every status is intentionally explicit instead of dressing absence up as proof.</p>
          </div>
          <div class="testing-table">
            ${PRODUCTS.map(
              (product) => `
                <a class="testing-row" href="${productPath(product)}">
                  <strong>${escapeHtml(product.code)} · ${escapeHtml(product.name)}</strong>
                  <span>${escapeHtml(product.strength)} · ${escapeHtml(product.format)}</span>
                  <span class="status-pill">NO RESULT REPORTED</span>
                </a>
              `,
            ).join("")}
          </div>
        </div>
      </section>
      <section class="section">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">Read the document</p>
            <h2>What a COA can and cannot show</h2>
          </div>
          <div>
            ${accordion([
              [
                "Does a purity result prove identity?",
                "Not by itself. Identity and relative purity answer different questions and may require different analytical methods.",
              ],
              [
                "Does a reported result prove every vial is the same?",
                "No. A result applies only to the identified sample and method scope. Sampling, chain of custody, and lot linkage remain separate questions.",
              ],
              [
                "Does a COA establish suitability for human use?",
                "No. OVO Labs does not present human-use, safety, efficacy, clinical, administration, or preparation information.",
              ],
              [
                "Why show fields with no result?",
                "Because a visible empty state is more informative than a badge that leaves the scope ambiguous. Missing evidence should remain visibly missing.",
              ],
            ])}
          </div>
        </div>
      </section>
    `;
  }

  function bundlesPage() {
    return `
      <section class="page-hero">
        <div class="shell">
          <p class="eyebrow">Catalog bundles</p>
          <h1>Shop catalog bundles.</h1>
          <p>Related products grouped for simpler browsing and one cart action. Every item remains linked to its own product and testing page.</p>
        </div>
      </section>
      <section class="section">
        <div class="shell">
          <div class="bundle-grid">${BUNDLES.map(bundleCard).join("")}</div>
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">Why sets exist</p>
            <h2>Reduce search work without creating ambiguity.</h2>
          </div>
          <div class="value-grid">
            <article class="value-card"><div><h3>Separate identities</h3><p>Every molecule keeps its own code, strength, product page, and testing state.</p></div></article>
            <article class="value-card"><div><h3>One cart action</h3><p>The set enters the cart as one clearly labeled item with its included products listed.</p></div></article>
            <article class="value-card"><div><h3>No false savings</h3><p>The set price is shown directly without fabricated list prices or countdown offers.</p></div></article>
          </div>
        </div>
      </section>
      ${newsletter()}
    `;
  }

  function learnPage() {
    return `
      <section class="page-hero">
        <div class="shell">
          <p class="eyebrow">Learning center</p>
          <h1>Read the facts behind the catalog.</h1>
          <p>Short guides for comparing peptide catalog entries, interpreting testing states, and understanding what a document’s scope does and does not establish.</p>
        </div>
      </section>
      <section class="section">
        <div class="shell">
          <div class="education-grid">
            ${ARTICLES.map(
              (article, index) => `
                <article class="education-card">
                  <div>
                    <p class="product-category">Guide 0${index + 1}</p>
                    <h3>${escapeHtml(article.title)}</h3>
                    <p>${escapeHtml(article.summary)}</p>
                  </div>
                  <a class="text-link" href="${path(`notes/${article.slug}.html`)}">Read the guide ${icons.arrow}</a>
                </article>
              `,
            ).join("")}
          </div>
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">Fast answers</p>
            <h2>Catalog FAQ</h2>
          </div>
          <div>
            ${accordion([
              ["Is OVO Labs a real company?", "No. It is a fictional, non-operational storefront concept. Nothing is stocked, sold, shipped, tested, or transacted."],
              ["Why show concept prices?", "Prices make the ecommerce prototype complete enough to evaluate its hierarchy, cart states, sorting, and merchandising. They are not offers for sale."],
              ["Why are there no ratings?", "No customers or reviews exist. Empty or invented social proof would make the interface less trustworthy, not more."],
              ["Can I check out?", "Yes. Cart, contact, shipping, delivery method, payment review, and order confirmation all work end to end. The payment step is the one exception: no card is collected and no charge is possible."],
            ])}
          </div>
        </div>
      </section>
      ${newsletter()}
    `;
  }

  function faqPage() {
    return `
      <section class="page-hero">
        <div class="shell">
          <p class="eyebrow">Help & details</p>
          <h1>Questions, answered plainly.</h1>
          <p>What the catalog shows, what “No result reported” means, how browser storage works, and exactly where this fictional store stops.</p>
        </div>
      </section>
      <section class="section">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">OVO Labs FAQ</p>
            <h2>The complete store boundary.</h2>
          </div>
          <div>
            ${accordion([
              ["Can I place an order?", "You can complete the checkout and receive an order reference, which is recorded in this browser. Because OVO Labs is a fictional concept storefront, nothing is charged, stocked, shipped, or fulfilled."],
              ["What does “No result reported” mean?", "It means no testing result is published for that catalog item. It does not mean the item passed, failed, or is waiting on a promised result."],
              ["Does a COA prove a product is safe, effective, or sterile?", "No. A document supports only the measurements, sample, method, date, and scope it identifies. Unreported attributes should not be inferred."],
              ["Why are there no purity percentages?", "No verified testing report exists for these catalog items. OVO Labs does not invent percentages or testing claims to make a product page feel complete."],
              ["Does this catalog provide human-use information?", "No dosing, preparation, administration, safety, efficacy, medical, or human-use guidance is provided."],
              ["Are the product descriptions medical advice?", "No. They identify proposed catalog references and formats only."],
              ["How does search work?", "Search by peptide name, category, blend name, or catalog code such as OVO-001. Keyboard users can move through predictive results with the arrow keys."],
              ["Why are there no customer reviews?", "There are no customers or order history. OVO Labs does not fabricate ratings, testimonials, or purchase activity."],
              ["What information does this site store?", "Cart contents and recently viewed product codes can be stored locally in your browser. Nothing is transmitted to a company or server."],
              ["How do I remove locally saved information?", "Use Clear cart in the cart drawer. You can also clear this site’s browser storage to remove all local state."],
            ])}
          </div>
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell newsletter">
          <div><h2>Ready to browse?</h2><p>Search all ten entries or inspect the testing framework first.</p></div>
          <div class="hero-actions">
            <a class="button button-secondary" href="${path("catalog.html")}">Shop all peptides</a>
            <a class="button button-secondary" href="${path("testing.html")}">View testing & COAs</a>
          </div>
        </div>
      </section>
    `;
  }

  function aboutPage() {
    return `
      <section class="page-hero">
        <div class="shell">
          <p class="eyebrow">About OVO Labs</p>
          <h1>A peptide store designed around finding and deciding.</h1>
          <p>OVO Labs is designed around a simple idea: product information should be easy to scan, and missing evidence should be impossible to miss.</p>
        </div>
      </section>
      <section class="section">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">The premise</p>
            <h2>Retail clarity can do more work than scientific theater.</h2>
          </div>
          <div>
            <p class="article-lede">The strongest specialist stores help people find the right entry quickly, compare it in place, and understand the next action. OVO Labs applies that discipline without inventing operations or proof.</p>
            <div class="spec-table">
              <div class="spec-row"><strong>Catalog model</strong><span>Focused selection, stable product codes, and flat product routes</span></div>
              <div class="spec-row"><strong>Discovery model</strong><span>Persistent search, visual category paths, filters, and related entries</span></div>
              <div class="spec-row"><strong>Product model</strong><span>Identity, labeled amount, format, price, and testing status in one decision block</span></div>
              <div class="spec-row"><strong>Proof model</strong><span>Only substantiated facts; no invented ratings, laboratories, results, or popularity</span></div>
            </div>
          </div>
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Operating principles</p>
              <h2>What the brand refuses to fake</h2>
            </div>
          </div>
          <div class="value-grid">
            <article class="value-card"><div><h3>No decorative proof</h3><p>No badges, reviews, lab names, purity figures, certificates, or quality claims exist without evidence.</p></div></article>
            <article class="value-card"><div><h3>No urgency machinery</h3><p>No stock countdown, sale timer, crossed-out anchor price, or invented best-seller ranking pushes the click.</p></div></article>
            <article class="value-card"><div><h3>No fake transaction</h3><p>The full purchase path is here to evaluate, from cart to order confirmation. Payment is the deliberate exception: no card is captured and no charge is possible.</p></div></article>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="shell">
          <div class="newsletter">
            <div><h2>See the full catalog system.</h2><p>Ten product entries, three sets, a testing lookup, and a complete local cart flow.</p></div>
            <a class="button button-secondary" href="${path("catalog.html")}">Browse all products ${icons.arrow}</a>
          </div>
        </div>
      </section>
    `;
  }

  function policyPage() {
    return `
      <section class="page-hero">
        <div class="shell">
          <p class="eyebrow">Concept boundaries</p>
          <h1>This storefront demonstrates an interface, not an operation.</h1>
          <p>OVO Labs has no company operations, products, inventory, customers, testing, fulfillment, payments, or ordering capability.</p>
        </div>
      </section>
      <article class="article-shell">
        <h2>What the prototype does</h2>
        <p>It demonstrates ecommerce information architecture: product discovery, category filtering, predictive search, product pages, testing-status presentation, a learning center, and a browser-local demo cart.</p>
        <h2>What the prototype does not do</h2>
        <ul>
          <li>It does not offer, sell, reserve, quote, or ship material.</li>
          <li>It does not collect payment, customer accounts, addresses, or submitted email data.</li>
          <li>It does not claim a laboratory, certificate, result, purity level, stock state, delivery time, or customer experience.</li>
          <li>It does not provide dosing, preparation, administration, clinical, therapeutic, safety, efficacy, or human-use information.</li>
        </ul>
        <div class="article-callout"><strong>The cart is local.</strong> Its contents and any order reference are stored only in this browser. Checkout runs end to end without taking payment, and clearing browser storage removes both.</div>
        <h2>Why the banner stays visible</h2>
        <p>The thin top notice keeps the concept status clear on every route while allowing the rest of the prototype to be evaluated as a real ecommerce design.</p>
        <p><a class="text-link" href="${path("catalog.html")}">Return to the concept catalog ${icons.arrow}</a></p>
      </article>
    `;
  }

  function productPage(product) {
    if (!product) return notFoundPage();
    const related = PRODUCTS.filter(
      (candidate) => candidate.slug !== product.slug && candidate.categoryKey === product.categoryKey,
    ).slice(0, 4);
    const fallbackRelated = related.length >= 3 ? related : PRODUCTS.filter((candidate) => candidate.slug !== product.slug).slice(0, 4);

    return `
      <div class="product-page">
        <div class="shell breadcrumb" aria-label="Breadcrumb">
          <a href="${path("index.html")}">Home</a><span aria-hidden="true">/</span>
          <a href="${path(`catalog.html?category=${product.categoryKey}`)}">${escapeHtml(product.category)}</a><span aria-hidden="true">/</span>
          <span aria-current="page">${escapeHtml(product.name)}</span>
        </div>
        <section class="shell pdp-grid">
          <div class="pdp-gallery">
            <div class="pdp-main-image" data-main-media>
              ${productImage(product, true)}
            </div>
            <div class="pdp-thumbnails" aria-label="Product concept views">
              <button class="pdp-thumb" type="button" data-media-view="front" data-media-zoom="1" data-media-src="${path("assets/ovo-vial-front.webp")}" data-media-alt="Front view for ${escapeHtml(product.name)}" aria-label="Show front view" aria-current="true">
                <img src="${path("assets/ovo-vial-front.webp")}" alt="" width="1024" height="1024">
              </button>
              <button class="pdp-thumb" type="button" data-media-view="scale" data-media-zoom="1" data-media-src="${path("assets/ovo-set-pair.webp")}" data-media-alt="Scale view for ${escapeHtml(product.name)}" aria-label="Show scale view" aria-current="false">
                <img src="${path("assets/ovo-set-pair.webp")}" alt="" width="1536" height="1024">
              </button>
              <button class="pdp-thumb" type="button" data-media-view="label" data-media-zoom="1.35" data-media-src="${path("assets/ovo-vial-front.webp")}" data-media-alt="Label view for ${escapeHtml(product.name)}" aria-label="Show label view" aria-current="false">
                <img src="${path("assets/ovo-vial-front.webp")}" alt="" width="1024" height="1024" style="transform:scale(1.35)">
              </button>
            </div>
          </div>
          <div class="pdp-buybox">
            <p class="product-category">${escapeHtml(product.category)}</p>
            <h1>${escapeHtml(product.name)}</h1>
            <span class="pdp-code">${escapeHtml(product.code)} · ${escapeHtml(product.format)}</span>
            <a class="pdp-testing-link" href="${path(`testing.html?product=${product.code}`)}">
              <span>Testing status: no result reported</span><span aria-hidden="true">→</span>
            </a>
            <p class="pdp-description">${escapeHtml(product.overview)}</p>
            <div class="pdp-price">
              <strong>${money.format(product.price)}</strong>
            </div>
            <p class="selection-label"><span>Strength</span><span data-selected-strength>${escapeHtml(product.strength)}</span></p>
            <div class="buy-controls">
              <div class="quantity-control">
                <button type="button" data-pdp-quantity-change="-1" aria-label="Decrease quantity">−</button>
                <label class="sr-only" for="pdp-quantity">Quantity</label>
                <input id="pdp-quantity" type="number" value="1" min="1" max="${MAX_QUANTITY}" inputmode="numeric">
                <button type="button" data-pdp-quantity-change="1" aria-label="Increase quantity">+</button>
              </div>
              <button class="pdp-add" type="button" data-pdp-add="${product.slug}">Add to cart</button>
            </div>
            <div class="buybox-cues">
              <div class="buybox-cue"><strong>${escapeHtml(product.code)}</strong><span>Product code</span></div>
              <div class="buybox-cue"><strong>${escapeHtml(product.strength)}</strong><span>Labeled amount</span></div>
              <div class="buybox-cue"><strong>No result</strong><span>Testing state</span></div>
            </div>
            <p class="pdp-note">Adds this item to a browser-only cart. No order, payment, or shipment is created.</p>
          </div>
        </section>
      </div>
      <section class="detail-section">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">Product facts</p>
            <h2>The comparison fields, up front.</h2>
          </div>
          <div class="spec-table">
            <div class="spec-row"><strong>Product name</strong><span>${escapeHtml(product.name)}</span></div>
            <div class="spec-row"><strong>Catalog code</strong><span>${escapeHtml(product.code)}</span></div>
            <div class="spec-row"><strong>Research area</strong><span>${escapeHtml(product.category)}</span></div>
            <div class="spec-row"><strong>Labeled amount</strong><span>${escapeHtml(product.strength)}</span></div>
            <div class="spec-row"><strong>Format</strong><span>${escapeHtml(product.format)}</span></div>
            <div class="spec-row"><strong>Analytical state</strong><span>No result reported</span></div>
          </div>
        </div>
      </section>
      <section class="detail-section section-surface">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">Testing status</p>
            <h2>Every missing result stays visible.</h2>
          </div>
          <div class="testing-table">
            <div class="testing-row"><strong>Identity</strong><span>Method not assigned</span><span class="status-pill">NO RESULT</span></div>
            <div class="testing-row"><strong>Content / mass</strong><span>Method not assigned</span><span class="status-pill">NO RESULT</span></div>
            <div class="testing-row"><strong>Purity profile</strong><span>Method not assigned</span><span class="status-pill">NO RESULT</span></div>
            <div class="testing-row"><strong>Sterility / endotoxin</strong><span>Not represented</span><span class="status-pill">NOT REPORTED</span></div>
          </div>
        </div>
      </section>
      <section class="detail-section">
        <div class="shell detail-grid">
          <div>
            <p class="eyebrow">Product questions</p>
            <h2>Know what this page means.</h2>
          </div>
          <div>
            ${accordion([
              ["Is this product available?", "No. This storefront is fictional and has no material, inventory, availability, ordering, or fulfillment."],
              ["What does the listed price mean?", "It lets the storefront demonstrate sorting, merchandising, cart totals, and product hierarchy. It is not an offer or quote."],
              ["Has this entry been tested?", "No testing or laboratory relationship is represented. Every analytical field on the page explicitly says that no result has been reported."],
              ["Where is administration information?", "It is intentionally absent. OVO Labs does not provide dosing, preparation, administration, human-use, safety, efficacy, or outcome information."],
            ])}
          </div>
        </div>
      </section>
      <section class="section section-surface">
        <div class="shell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Keep comparing</p>
              <h2>Related catalog entries</h2>
            </div>
            <a class="text-link" href="${path("catalog.html")}">View the full catalog ${icons.arrow}</a>
          </div>
          <div class="product-grid">${fallbackRelated.slice(0, 4).map((item) => productCard(item)).join("")}</div>
        </div>
      </section>
      <button class="mobile-cart-bar" type="button" data-mobile-add="${product.slug}" data-visible="false">
        <span>Add ${escapeHtml(product.name)} · ${escapeHtml(product.strength)}</span>
        <strong>${money.format(product.price)}</strong>
      </button>
    `;
  }

  function articlePage(slug) {
    const content = {
      "reading-testing-status": {
        eyebrow: "Testing guide · 4 minutes",
        title: "How to read a testing status",
        lede: "Start with the question the method is meant to answer. Then check whether a result is actually reported.",
        sections: [
          ["A specification is not a result", "A specification describes an intended target or acceptance rule. A result describes what was observed for an identified sample under a stated method. One should never be styled as the other."],
          ["Identity, amount, and composition are separate", "An identity method asks whether the observed profile matches the intended compound. A content or mass method asks how much is reported. A purity method describes relative composition under its method conditions. None automatically answers the others."],
          ["“No result reported” is useful information", "An explicit empty state prevents a shopper from assuming that a badge, document icon, or quality headline stands in for evidence. It keeps the unknown visible at the moment of comparison."],
        ],
      },
      "choosing-by-molecule": {
        eyebrow: "Catalog guide · 4 minutes",
        title: "Shop by molecule, not by hype",
        lede: "A clean catalog starts with product identity, then narrows by strength, format, code, and evidence state.",
        sections: [
          ["Start with the exact entry", "Separate compounds should have separate product pages. A selector is useful for genuine strengths of the same item, not for hiding unrelated molecules inside one high-traffic page."],
          ["Compare the same fields every time", "Product name, code, strength, format, price concept, and testing status should appear in predictable positions. Consistency turns a grid into a comparison tool."],
          ["Use categories as a shortcut", "Research-area categories help exploration, while exact-name and product-code search help returning or expert shoppers. Both paths should reach the same canonical product page."],
        ],
      },
      "coa-boundaries": {
        eyebrow: "Document guide · 5 minutes",
        title: "What a COA can and cannot show",
        lede: "The value of a certificate depends on the identified sample, the method, the result, and the scope. The title alone proves very little.",
        sections: [
          ["Read the scope before the number", "A reported purity figure does not automatically establish identity, total content, sterility, endotoxin state, stability, or suitability for a particular use."],
          ["Check the sample link", "A result is only useful when the document identifies the tested sample and the catalog can explain how that sample relates to the represented item."],
          ["Do not fill gaps with design", "A green badge, seal, laboratory photograph, or download icon cannot replace a reported result. If a field is missing, the interface should say so directly."],
        ],
      },
    }[slug];

    if (!content) return notFoundPage();
    return `
      <article class="article-shell">
        <p class="eyebrow">${escapeHtml(content.eyebrow)}</p>
        <h1>${escapeHtml(content.title)}</h1>
        <p class="article-lede">${escapeHtml(content.lede)}</p>
        <div class="article-callout">This guide describes document and catalog structure. It does not provide medical, clinical, preparation, administration, or human-use information.</div>
        ${content.sections
          .map(([heading, copy]) => `<h2>${escapeHtml(heading)}</h2><p>${escapeHtml(copy)}</p>`)
          .join("")}
        <h2>Continue through the store</h2>
        <p>Use the testing page to inspect current concept states, or return to the catalog to compare entries using the same fields.</p>
        <p>
          <a class="button button-primary" href="${path("testing.html")}">Explore testing & COAs</a>
          <a class="button button-secondary" href="${path("catalog.html")}">Browse products</a>
        </p>
      </article>
      <section class="section section-surface">
        <div class="shell">
          <div class="section-head"><div><p class="eyebrow">More from OVO Labs</p><h2>Related guides</h2></div></div>
          <div class="education-grid">
            ${ARTICLES.filter((article) => article.slug !== slug)
              .map(
                (article) => `<article class="education-card"><div><h3>${escapeHtml(article.title)}</h3><p>${escapeHtml(article.summary)}</p></div><a class="text-link" href="${path(`notes/${article.slug}.html`)}">Read the guide ${icons.arrow}</a></article>`,
              )
              .join("")}
          </div>
        </div>
      </section>
    `;
  }

  function notFoundPage() {
    return `
      <section class="page-hero">
        <div class="shell">
          <p class="eyebrow">404 · Page not found</p>
          <h1>This catalog path does not exist.</h1>
          <p>Search for a molecule, return to the product grid, or use one of the main research-area categories.</p>
          <div class="hero-actions">
            <a class="button button-primary" href="${path("catalog.html")}">Browse all products</a>
            <a class="button button-secondary" href="${path("index.html")}">Return home</a>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="shell">
          ${categoryRail()}
          <div class="product-grid">${PRODUCTS.slice(0, 4).map((product) => productCard(product)).join("")}</div>
        </div>
      </section>
    `;
  }

  function cartPage() {
    const breakdown = priceBreakdown(readCheckoutDraft());

    if (cart.length === 0) {
      return `
        <section class="page-hero">
          <div class="shell">
            <p class="eyebrow">Cart</p>
            <h1>Your cart is empty.</h1>
            <p>Add a compound or a defined blend from the catalog and it will appear here.</p>
            <div class="hero-actions">
              <a class="button button-primary" href="${path("catalog.html")}">Browse the catalog</a>
              <a class="button button-secondary" href="${path("bundles.html")}">See bundles</a>
            </div>
          </div>
        </section>
        <section class="section">
          <div class="shell">
            <div class="section-head">
              <div>
                <p class="eyebrow">Start here</p>
                <h2>Most ordered.</h2>
              </div>
              <a class="text-link" href="${path("catalog.html")}">View all products ${icons.arrow}</a>
            </div>
            <div class="product-grid">${PRODUCTS.slice(0, 4).map((product) => productCard(product)).join("")}</div>
          </div>
        </section>
      `;
    }

    const rows = cart
      .map((line) => {
        const item = cartItemData(line.slug);
        if (!item) return "";
        return `
          <article class="cart-row" data-cart-row="${item.slug}">
            <a class="cart-row-image" href="${item.productSlugs ? path("bundles.html") : path(`peptides/${item.slug}.html`)}">
              <img src="${path(item.productSlugs ? "assets/ovo-set-pair.webp" : "assets/ovo-vial-front.webp")}" alt="" width="120" height="135">
            </a>
            <div class="cart-row-body">
              <div class="cart-row-head">
                <div>
                  <h3>${escapeHtml(item.name)}</h3>
                  <p class="cart-row-meta">${escapeHtml(item.code)} · ${escapeHtml(item.strength)}</p>
                </div>
                <span class="cart-row-price">${money.format(item.price * line.quantity)}</span>
              </div>
              <p class="cart-row-status"><span class="status-dot" aria-hidden="true"></span> In stock · ships from the fulfillment partner</p>
              <div class="cart-row-controls">
                <div class="mini-quantity" aria-label="Quantity for ${escapeHtml(item.name)}">
                  <button type="button" data-cart-quantity="${item.slug}" data-delta="-1" aria-label="Decrease ${escapeHtml(item.name)} quantity">−</button>
                  <span>${line.quantity}</span>
                  <button type="button" data-cart-quantity="${item.slug}" data-delta="1" aria-label="Increase ${escapeHtml(item.name)} quantity">+</button>
                </div>
                <span class="cart-row-unit">${money.format(item.price)} each</span>
                <button class="remove-item" type="button" data-remove-product="${item.slug}">Remove</button>
              </div>
            </div>
          </article>
        `;
      })
      .join("");

    /* Both this bar and the summary shipping line derive from the same
       threshold, so they can never contradict each other on screen. */
    const freeShipBar = breakdown.freeShippingRemaining > 0
      ? `<p class="ship-progress">Add <strong>${money.format(breakdown.freeShippingRemaining)}</strong> for free standard shipping.</p>`
      : `<p class="ship-progress is-met"><span class="status-dot" aria-hidden="true"></span> Standard shipping is free on this order.</p>`;

    return `
      <section class="page-hero is-compact">
        <div class="shell">
          <p class="eyebrow">Cart</p>
          <h1>Your cart</h1>
        </div>
      </section>
      <section class="section">
        <div class="shell cart-layout">
          <div class="cart-main">
            ${freeShipBar}
            <div class="cart-rows">${rows}</div>
            <div class="cart-actions">
              <a class="button button-secondary button-small" href="${path("catalog.html")}">Continue shopping</a>
              <button class="remove-item" type="button" data-clear-cart>Clear cart</button>
            </div>
          </div>
          <div class="cart-aside">
            ${orderSummaryPanel(breakdown, {
              showItems: false,
              cta: `<a class="button button-primary checkout-cta" href="${path("checkout.html")}">Checkout · ${money.format(breakdown.total)}</a>`,
            })}
            <form class="promo-form" data-promo-form>
              <label for="promo-input">Discount code</label>
              <div class="promo-input-row">
                <input id="promo-input" name="promo" type="text" autocomplete="off" placeholder="Enter code" value="${escapeHtml(readCheckoutDraft().promo || "")}">
                <button class="button button-secondary button-small" type="submit">Apply</button>
              </div>
              <p class="promo-hint">Try <button type="button" class="link-button" data-fill-promo="OVO-FIRST">OVO-FIRST</button></p>
              <p class="promo-feedback" data-promo-feedback role="status">${breakdown.promo ? `Applied: ${escapeHtml(breakdown.promo.label)}` : ""}</p>
            </form>
          </div>
        </div>
      </section>
    `;
  }

  function checkoutField(id, label, options = {}) {
    const { type = "text", autocomplete = "", placeholder = "", required = true, width = "full", value = "" } = options;
    return `
      <div class="field is-${width}">
        <label for="${id}">${escapeHtml(label)}${required ? "" : ` <span class="field-optional">optional</span>`}</label>
        <input id="${id}" name="${id}" type="${type}" ${autocomplete ? `autocomplete="${autocomplete}"` : ""} ${placeholder ? `placeholder="${escapeHtml(placeholder)}"` : ""} ${required ? "required" : ""} value="${escapeHtml(value)}">
        <p class="field-error" data-error-for="${id}"></p>
      </div>
    `;
  }

  function checkoutPage() {
    if (cart.length === 0) {
      return `
        <section class="page-hero">
          <div class="shell">
            <p class="eyebrow">Checkout</p>
            <h1>There is nothing to check out.</h1>
            <p>Your cart is empty, so there is no order to complete.</p>
            <div class="hero-actions">
              <a class="button button-primary" href="${path("catalog.html")}">Browse the catalog</a>
            </div>
          </div>
        </section>
      `;
    }

    const draft = readCheckoutDraft();
    const breakdown = priceBreakdown(draft);

    const steps = CHECKOUT_STEPS.map(
      (step, index) => `
        <li class="step" data-step-indicator="${step.key}">
          <span class="step-index">${index + 1}</span>
          <span class="step-label">${escapeHtml(step.label)}</span>
        </li>
      `,
    ).join("");

    const deliveryOptions = SHIPPING_METHODS.map((method) => {
      const free = breakdown.subtotal >= FREE_SHIPPING_THRESHOLD && method.id === "standard";
      return `
        <label class="choice" data-choice>
          <input type="radio" name="shippingMethod" value="${method.id}" ${(draft.shippingMethod || "standard") === method.id ? "checked" : ""}>
          <span class="choice-body">
            <span class="choice-title">${escapeHtml(method.name)}<span class="choice-price">${free || method.price === 0 ? "Free" : money.format(method.price)}</span></span>
            <span class="choice-detail">${escapeHtml(method.detail)} · ${escapeHtml(method.note)}</span>
          </span>
        </label>
      `;
    }).join("");

    return `
      <section class="page-hero is-compact">
        <div class="shell">
          <p class="eyebrow">Checkout</p>
          <h1>Complete your order</h1>
          <ol class="stepper" data-stepper>${steps}</ol>
        </div>
      </section>
      <section class="section">
        <div class="shell checkout-layout">
          <form class="checkout-main" data-checkout-form novalidate>

            <fieldset class="checkout-step" data-step="contact">
              <legend><span>1</span> Contact</legend>
              <p class="step-hint">Order confirmation and tracking are sent here.</p>
              <div class="field-grid">
                ${checkoutField("email", "Email address", { type: "email", autocomplete: "email", placeholder: "you@company.com", value: draft.email || "" })}
                ${checkoutField("phone", "Phone", { type: "tel", autocomplete: "tel", placeholder: "(555) 010-0199", value: draft.phone || "" })}
              </div>
              <div class="step-actions">
                <a class="button button-secondary" href="${path("cart.html")}">Back to cart</a>
                <button class="button button-primary" type="button" data-next="contact">Continue to shipping</button>
              </div>
            </fieldset>

            <fieldset class="checkout-step" data-step="shipping" hidden>
              <legend><span>2</span> Shipping address</legend>
              <div class="field-grid">
                ${checkoutField("firstName", "First name", { autocomplete: "given-name", width: "half", value: draft.firstName || "" })}
                ${checkoutField("lastName", "Last name", { autocomplete: "family-name", width: "half", value: draft.lastName || "" })}
                ${checkoutField("address1", "Address", { autocomplete: "address-line1", value: draft.address1 || "" })}
                ${checkoutField("address2", "Apartment, suite, unit", { autocomplete: "address-line2", required: false, value: draft.address2 || "" })}
                ${checkoutField("city", "City", { autocomplete: "address-level2", width: "half", value: draft.city || "" })}
                <div class="field is-quarter">
                  <label for="state">State</label>
                  <select id="state" name="state" required>
                    <option value="">Select</option>
                    ${US_STATES.map((s) => `<option value="${s}" ${draft.state === s ? "selected" : ""}>${s}</option>`).join("")}
                  </select>
                  <p class="field-error" data-error-for="state"></p>
                </div>
                ${checkoutField("zip", "ZIP code", { autocomplete: "postal-code", placeholder: "94107", width: "quarter", value: draft.zip || "" })}
              </div>
              <div class="step-actions">
                <button class="button button-secondary" type="button" data-back="contact">Back</button>
                <button class="button button-primary" type="button" data-next="shipping">Continue to delivery</button>
              </div>
            </fieldset>

            <fieldset class="checkout-step" data-step="delivery" hidden>
              <legend><span>3</span> Delivery method</legend>
              <p class="step-hint">Lyophilized vials are shipped in an insulated mailer. Cold chain adds a gel pack and a temperature logger.</p>
              <div class="choice-group" data-delivery-group>${deliveryOptions}</div>
              <div class="step-actions">
                <button class="button button-secondary" type="button" data-back="shipping">Back</button>
                <button class="button button-primary" type="button" data-next="delivery">Continue to payment</button>
              </div>
            </fieldset>

            <fieldset class="checkout-step" data-step="payment" hidden>
              <legend><span>4</span> Payment</legend>
              <div class="demo-payment-notice">
                <strong>This storefront cannot take payment.</strong>
                <p>The card below is a locked placeholder. No card number is collected, nothing is transmitted, and no charge is possible. Every other part of this checkout behaves normally.</p>
              </div>
              <div class="field-grid">
                <div class="field is-full">
                  <label for="cardNumber">Card number</label>
                  <input id="cardNumber" name="cardNumber" type="text" value="4242 4242 4242 4242" readonly aria-readonly="true">
                  <p class="field-note">Placeholder value · input disabled</p>
                </div>
                <div class="field is-half">
                  <label for="cardExpiry">Expiry</label>
                  <input id="cardExpiry" name="cardExpiry" type="text" value="04 / 30" readonly aria-readonly="true">
                </div>
                <div class="field is-half">
                  <label for="cardCvc">CVC</label>
                  <input id="cardCvc" name="cardCvc" type="text" value="•••" readonly aria-readonly="true">
                </div>
              </div>
              <label class="checkbox-row">
                <input type="checkbox" name="billingSame" checked>
                <span>Billing address is the same as shipping</span>
              </label>
              <div class="step-actions">
                <button class="button button-secondary" type="button" data-back="delivery">Back</button>
                <button class="button button-primary" type="button" data-next="payment">Review order</button>
              </div>
            </fieldset>

            <fieldset class="checkout-step" data-step="review" hidden>
              <legend><span>5</span> Review</legend>
              <div class="review-blocks" data-review-blocks></div>
              <label class="checkbox-row" data-terms-row>
                <input type="checkbox" name="terms" ${draft.terms ? "checked" : ""}>
                <span>I have read the <a href="${path("policies.html")}">policies</a> and the <a href="${path("eligibility.html")}">eligibility terms</a>.</span>
              </label>
              <p class="field-error" data-error-for="terms"></p>
              <div class="step-actions">
                <button class="button button-secondary" type="button" data-back="payment">Back</button>
                <button class="button button-primary" type="button" data-place-order>Place order · ${money.format(breakdown.total)}</button>
              </div>
              <p class="step-hint">Placing the order records it in this browser and issues a reference number. It does not charge a card or ship anything.</p>
            </fieldset>

          </form>
          <div class="checkout-aside" data-checkout-summary>
            ${orderSummaryPanel(breakdown)}
          </div>
        </div>
      </section>
    `;
  }

  function confirmationPage() {
    const orders = readOrders();
    const order = orders[0];

    if (!order) {
      return `
        <section class="page-hero">
          <div class="shell">
            <p class="eyebrow">Order</p>
            <h1>No recent order found.</h1>
            <p>Orders are recorded in this browser. If you cleared your storage, the reference is gone.</p>
            <div class="hero-actions">
              <a class="button button-primary" href="${path("catalog.html")}">Browse the catalog</a>
            </div>
          </div>
        </section>
      `;
    }

    const lines = order.items
      .map(
        (line) => `
          <div class="summary-line">
            <img src="${path(line.isBundle ? "assets/ovo-set-pair.webp" : "assets/ovo-vial-front.webp")}" alt="" width="48" height="54">
            <div>
              <strong>${escapeHtml(line.name)}</strong>
              <span>${escapeHtml(line.code)} · ${escapeHtml(line.strength)} · Qty ${line.quantity}</span>
            </div>
            <span class="summary-line-price">${money.format(line.price * line.quantity)}</span>
          </div>
        `,
      )
      .join("");

    const rows = [
      ["Subtotal", money.format(order.totals.subtotal)],
      ...(order.totals.discount > 0 ? [["Discount", `-${money.format(order.totals.discount)}`]] : []),
      [`Shipping · ${escapeHtml(order.shippingMethodName)}`, order.totals.shipping === 0 ? "Free" : money.format(order.totals.shipping)],
      ["Tax", money.format(order.totals.tax)],
    ]
      .map(([l, v]) => `<div class="summary-row"><span>${l}</span><span>${v}</span></div>`)
      .join("");

    return `
      <section class="page-hero is-compact">
        <div class="shell">
          <p class="eyebrow">Order ${escapeHtml(order.reference)}</p>
          <h1>Thank you, ${escapeHtml(order.firstName)}.</h1>
          <p>Your order is recorded. A confirmation would be sent to <strong>${escapeHtml(order.email)}</strong>.</p>
        </div>
      </section>
      <section class="section">
        <div class="shell confirmation-layout">
          <div class="confirmation-main">
            <ol class="tracker">
              <li class="is-done"><span></span>Order placed<em>${escapeHtml(order.placedLabel)}</em></li>
              <li><span></span>Preparing<em>Within 1 business day</em></li>
              <li><span></span>Shipped<em>${escapeHtml(order.shippingMethodDetail)}</em></li>
              <li><span></span>Delivered<em>Estimated ${escapeHtml(order.etaLabel)}</em></li>
            </ol>

            <div class="detail-grid">
              <div class="detail-card">
                <h3>Shipping to</h3>
                <p>${escapeHtml(order.firstName)} ${escapeHtml(order.lastName)}<br>
                ${escapeHtml(order.address1)}${order.address2 ? `<br>${escapeHtml(order.address2)}` : ""}<br>
                ${escapeHtml(order.city)}, ${escapeHtml(order.state)} ${escapeHtml(order.zip)}</p>
              </div>
              <div class="detail-card">
                <h3>Delivery method</h3>
                <p>${escapeHtml(order.shippingMethodName)}<br>${escapeHtml(order.shippingMethodDetail)}</p>
              </div>
              <div class="detail-card">
                <h3>Payment</h3>
                <p>Not collected.<br>No charge was made for this order.</p>
              </div>
              <div class="detail-card">
                <h3>Contact</h3>
                <p>${escapeHtml(order.email)}<br>${escapeHtml(order.phone)}</p>
              </div>
            </div>
          </div>

          <aside class="order-summary">
            <h2>Order ${escapeHtml(order.reference)}</h2>
            <div class="summary-lines">${lines}</div>
            <div class="summary-rows">${rows}</div>
            <div class="summary-total"><strong>Total</strong><strong>${money.format(order.totals.total)}</strong></div>
            <a class="button button-secondary checkout-cta" href="${path("catalog.html")}">Continue shopping</a>
          </aside>
        </div>
      </section>
    `;
  }

  function accordion(items) {
    const instance = ++accordion.counter;
    return `
      <div class="accordion">
        ${items
          .map(
            ([question, answer], index) => `
              <div class="accordion-item">
                <button class="accordion-trigger" type="button" aria-expanded="${index === 0}" aria-controls="accordion-${instance}-${index}">
                  ${escapeHtml(question)}
                </button>
                <div class="accordion-panel" id="accordion-${instance}-${index}"${index === 0 ? "" : " hidden"}>
                  ${escapeHtml(answer)}
                </div>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
  }
  accordion.counter = 0;

  function renderPage() {
    const pages = {
      home: homePage,
      collection: collectionPage,
      testing: testingPage,
      bundles: bundlesPage,
      learn: learnPage,
      faq: faqPage,
      about: aboutPage,
      policy: policyPage,
      product: () => productPage(PRODUCTS.find((product) => product.slug === PRODUCT_SLUG)),
      article: () => articlePage(body.dataset.article || ""),
      cart: cartPage,
      checkout: checkoutPage,
      confirmation: confirmationPage,
      404: notFoundPage,
    };
    const renderer = pages[PAGE] || notFoundPage;
    layout(renderer());
  }

  function readCart() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item) => ALL_CART_ITEMS.some((candidate) => candidate.slug === item.slug))
        .map((item) => ({
          slug: item.slug,
          quantity: Math.max(1, Math.min(MAX_QUANTITY, Number.parseInt(item.quantity, 10) || 1)),
        }));
    } catch {
      return [];
    }
  }

  let cart = readCart();
  let lastFocusedElement = null;
  let toastTimer = null;

  function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    renderCart();
  }

  function cartItemData(slug) {
    return ALL_CART_ITEMS.find((item) => item.slug === slug);
  }

  function cartTotal() {
    return cart.reduce((total, line) => {
      const item = cartItemData(line.slug);
      return total + (item ? item.price * line.quantity : 0);
    }, 0);
  }

  function cartCount() {
    return cart.reduce((total, line) => total + line.quantity, 0);
  }

  function readCheckoutDraft() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHECKOUT_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function writeCheckoutDraft(draft) {
    try {
      localStorage.setItem(CHECKOUT_KEY, JSON.stringify(draft));
    } catch (error) {
      /* storage unavailable; the draft simply does not persist */
    }
  }

  function readOrders() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function shippingMethod(id) {
    return SHIPPING_METHODS.find((method) => method.id === id) || SHIPPING_METHODS[0];
  }

  /* Single source of truth for money. The cart page, every checkout step, the
     review table and the confirmation receipt all read from this, so a number
     can never disagree with itself between screens. */
  function priceBreakdown(draft = {}) {
    const subtotal = cartTotal();
    const method = shippingMethod(draft.shippingMethod);
    const promo = PROMO_CODES[(draft.promo || "").toUpperCase()] || null;

    let discount = 0;
    if (promo && promo.type === "percent") discount = Math.round(subtotal * (promo.value / 100));

    const discounted = Math.max(0, subtotal - discount);
    let shipping = method.price;
    if (subtotal >= FREE_SHIPPING_THRESHOLD && method.id === "standard") shipping = 0;
    if (promo && promo.type === "shipping") shipping = Math.max(0, Math.round(shipping * (1 - promo.value / 100)));

    const tax = Math.round(discounted * TAX_RATE);
    return {
      subtotal,
      discount,
      shipping,
      tax,
      total: discounted + shipping + tax,
      promo,
      method,
      freeShippingRemaining: Math.max(0, FREE_SHIPPING_THRESHOLD - subtotal),
    };
  }

  function summaryRows(breakdown) {
    const rows = [[`Subtotal (${cartCount()} ${cartCount() === 1 ? "item" : "items"})`, money.format(breakdown.subtotal), ""]];
    if (breakdown.discount > 0) {
      rows.push([`Discount · ${escapeHtml(breakdown.promo.label)}`, `-${money.format(breakdown.discount)}`, "is-credit"]);
    }
    rows.push([`Shipping · ${escapeHtml(breakdown.method.name)}`, breakdown.shipping === 0 ? "Free" : money.format(breakdown.shipping), ""]);
    rows.push(["Estimated tax", money.format(breakdown.tax), ""]);
    return rows
      .map(([label, value, cls]) => `<div class="summary-row ${cls}"><span>${label}</span><span>${value}</span></div>`)
      .join("");
  }

  function orderSummaryPanel(breakdown, options = {}) {
    const { showItems = true } = options;
    const items = showItems
      ? cart
          .map((line) => {
            const item = cartItemData(line.slug);
            if (!item) return "";
            return `
              <div class="summary-line">
                <img src="${path(item.productSlugs ? "assets/ovo-set-pair.webp" : "assets/ovo-vial-front.webp")}" alt="" width="48" height="54">
                <div>
                  <strong>${escapeHtml(item.name)}</strong>
                  <span>${escapeHtml(item.code)} · ${escapeHtml(item.strength)} · Qty ${line.quantity}</span>
                </div>
                <span class="summary-line-price">${money.format(item.price * line.quantity)}</span>
              </div>
            `;
          })
          .join("")
      : "";

    return `
      <aside class="order-summary" aria-label="Order summary">
        <h2>Order summary</h2>
        ${items ? `<div class="summary-lines">${items}</div>` : ""}
        <div class="summary-rows">${summaryRows(breakdown)}</div>
        <div class="summary-total"><strong>Total</strong><strong>${money.format(breakdown.total)}</strong></div>
        ${options.cta || ""}
        <p class="summary-note">Prices in USD. Tax is estimated at ${(TAX_RATE * 100).toFixed(2)}% until an address is confirmed.</p>
      </aside>
    `;
  }

  function renderCart() {
    const count = cart.reduce((total, item) => total + item.quantity, 0);
    document.querySelectorAll("[data-cart-count]").forEach((element) => {
      element.textContent = String(count);
      element.hidden = count === 0;
    });

    const itemsRoot = document.querySelector("[data-cart-items]");
    const footerRoot = document.querySelector("[data-cart-footer]");
    if (!itemsRoot || !footerRoot) return;

    if (cart.length === 0) {
      itemsRoot.innerHTML = `
        <div class="cart-empty">
          <div>
            <strong>Your cart is empty.</strong>
            <p>Browse the catalog to add a peptide or bundle.</p>
            <a class="button button-primary button-small" href="${path("catalog.html")}">Shop products</a>
          </div>
        </div>
      `;
      footerRoot.innerHTML = `
        <p class="cart-terminus">Nothing here is stocked or shippable. You can still walk the full checkout.</p>
      `;
      return;
    }

    itemsRoot.innerHTML = cart
      .map((line) => {
        const item = cartItemData(line.slug);
        if (!item) return "";
        return `
          <article class="cart-item">
            <img src="${path(item.productSlugs ? "assets/ovo-set-pair.webp" : "assets/ovo-vial-front.webp")}" alt="" width="96" height="108">
            <div>
              <div class="cart-item-top">
                <h3>${escapeHtml(item.name)}</h3>
                <span class="cart-item-price">${money.format(item.price * line.quantity)}</span>
              </div>
              <p class="cart-item-meta">${escapeHtml(item.code)} · ${escapeHtml(item.strength)}</p>
              <div class="cart-item-controls">
                <div class="mini-quantity" aria-label="Quantity for ${escapeHtml(item.name)}">
                  <button type="button" data-cart-quantity="${item.slug}" data-delta="-1" aria-label="Decrease ${escapeHtml(item.name)} quantity">−</button>
                  <span>${line.quantity}</span>
                  <button type="button" data-cart-quantity="${item.slug}" data-delta="1" aria-label="Increase ${escapeHtml(item.name)} quantity">+</button>
                </div>
                <button class="remove-item" type="button" data-remove-product="${item.slug}">Remove</button>
              </div>
            </div>
          </article>
        `;
      })
      .join("");

    footerRoot.innerHTML = `
      <div class="cart-subtotal"><strong>Subtotal</strong><strong>${money.format(cartTotal())}</strong></div>
      <a class="button button-primary cart-checkout" href="${path("checkout.html")}">Checkout</a>
      <a class="button button-secondary cart-view" href="${path("cart.html")}">View cart</a>
      <p class="cart-terminus">Cart is stored in this browser. Checkout runs end to end but cannot take payment.</p>
    `;
  }

  function addToCart(slug, quantity = 1) {
    const item = cartItemData(slug);
    if (!item) return;
    const safeQuantity = Math.max(1, Math.min(MAX_QUANTITY, Number.parseInt(quantity, 10) || 1));
    const existing = cart.find((line) => line.slug === slug);
    if (existing) {
      existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + safeQuantity);
    } else {
      cart.push({ slug, quantity: safeQuantity });
    }
    saveCart();
    openDrawer("cart");
    track("add_to_cart", {
      item_id: item.code,
      item_name: item.name,
      item_category: item.category,
      price: item.price,
      quantity: safeQuantity,
      demo_only: true,
    });
  }

  function changeCartQuantity(slug, delta) {
    const line = cart.find((item) => item.slug === slug);
    const product = cartItemData(slug);
    if (!line || !product) return;
    line.quantity = Math.max(0, Math.min(MAX_QUANTITY, line.quantity + delta));
    if (line.quantity === 0) {
      cart = cart.filter((item) => item.slug !== slug);
      track("remove_from_cart", { item_id: product.code, item_name: product.name, demo_only: true });
    } else {
      track("cart_quantity_changed", {
        item_id: product.code,
        item_name: product.name,
        quantity: line.quantity,
        demo_only: true,
      });
    }
    saveCart();
  }

  function showToast(message) {
    const toast = document.querySelector("[data-toast]");
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.open = "true";
    toastTimer = window.setTimeout(() => {
      toast.dataset.open = "false";
    }, 2800);
  }

  function drawerElements(type) {
    const drawer = document.querySelector(type === "cart" ? "[data-cart-drawer]" : "[data-mobile-drawer]");
    const other = document.querySelector(type === "cart" ? "[data-mobile-drawer]" : "[data-cart-drawer]");
    return { drawer, other };
  }

  function openDrawer(type) {
    const { drawer, other } = drawerElements(type);
    const backdrop = document.querySelector("[data-drawer-backdrop]");
    if (!drawer || !backdrop) return;
    lastFocusedElement = document.activeElement;
    other.dataset.open = "false";
    other.setAttribute("aria-hidden", "true");
    drawer.dataset.open = "true";
    drawer.setAttribute("aria-hidden", "false");
    backdrop.dataset.open = "true";
    body.classList.add("drawer-open");
    drawer.querySelector("button, a")?.focus();
    if (type === "cart") {
      track("view_cart", { item_count: cart.reduce((sum, item) => sum + item.quantity, 0), demo_only: true });
    }
  }

  function closeDrawers() {
    const backdrop = document.querySelector("[data-drawer-backdrop]");
    document.querySelectorAll("[data-cart-drawer], [data-mobile-drawer]").forEach((drawer) => {
      drawer.dataset.open = "false";
      drawer.setAttribute("aria-hidden", "true");
    });
    if (backdrop) backdrop.dataset.open = "false";
    body.classList.remove("drawer-open");
    if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
  }

  function initDrawersAndCart() {
    renderCart();
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-drawer-backdrop]")) {
        closeDrawers();
        return;
      }
      const target = event.target.closest("button, a");
      if (!target) return;

      if (target.matches("[data-cart-open]")) openDrawer("cart");
      if (target.matches("[data-cart-close], [data-menu-close]")) closeDrawers();
      if (target.matches("[data-menu-open]")) openDrawer("menu");

      if (target.dataset.addProduct) {
        addToCart(target.dataset.addProduct);
      }

      if (target.dataset.pdpAdd) {
        const quantity = document.querySelector("#pdp-quantity")?.value || 1;
        addToCart(target.dataset.pdpAdd, quantity);
      }

      if (target.dataset.mobileAdd) {
        const quantity = document.querySelector("#pdp-quantity")?.value || 1;
        addToCart(target.dataset.mobileAdd, quantity);
      }

      if (target.dataset.cartQuantity) {
        changeCartQuantity(target.dataset.cartQuantity, Number(target.dataset.delta));
      }

      if (target.dataset.removeProduct) {
        const item = cartItemData(target.dataset.removeProduct);
        cart = cart.filter((line) => line.slug !== target.dataset.removeProduct);
        saveCart();
        if (item) {
          showToast(`${item.name} removed from the cart.`);
          track("remove_from_cart", { item_id: item.code, item_name: item.name, demo_only: true });
        }
      }

      if (target.matches("[data-clear-cart]")) {
        cart = [];
        saveCart();
        showToast("Cart cleared.");
        track("cart_cleared", { demo_only: true });
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDrawers();
      if (event.key !== "Tab") return;
      const openDrawerElement = document.querySelector(
        '[data-cart-drawer][data-open="true"], [data-mobile-drawer][data-open="true"]',
      );
      if (!openDrawerElement) return;
      const focusable = [
        ...openDrawerElement.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function searchMatches(query) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return PRODUCTS.slice(0, 5);
    return PRODUCTS.filter((product) =>
      [product.name, product.code, product.category, product.strength, product.descriptor]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    ).slice(0, 6);
  }

  function initSearch() {
    const input = document.querySelector("#site-search");
    const results = document.querySelector("#search-results");
    if (!input || !results) return;
    let activeIndex = -1;

    const close = () => {
      results.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      activeIndex = -1;
    };

    const open = () => {
      const matches = searchMatches(input.value);
      results.setAttribute("role", matches.length ? "listbox" : "status");
      results.innerHTML = matches.length
        ? matches
            .map(
              (product, index) => `
                <a class="search-result" id="search-option-${index}" href="${productPath(product)}" role="option" aria-selected="false" data-search-result="${product.slug}">
                  <span class="search-result-image"><img src="${path("assets/ovo-vial-front.webp")}" alt="" width="52" height="52"></span>
                  <span><strong>${escapeHtml(product.name)} · ${escapeHtml(product.strength)}</strong><span>${escapeHtml(product.code)} · ${escapeHtml(product.category)}</span></span>
                  <span class="search-result-price">${money.format(product.price)}</span>
                </a>
              `,
            )
            .join("")
        : `<div class="empty-state"><strong>No matching catalog entry.</strong><p>Try a molecule name, product code, or research area.</p><a class="text-link" href="${path("catalog.html")}">Browse all products →</a></div>`;
      results.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };

    input.addEventListener("focus", open);
    input.addEventListener("input", () => {
      activeIndex = -1;
      open();
      if (input.value.trim()) track("search", { search_term: input.value.trim().toLowerCase(), result_count: searchMatches(input.value).length });
    });

    input.addEventListener("keydown", (event) => {
      const options = [...results.querySelectorAll('[role="option"]')];
      if (event.key === "Escape") {
        close();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key) || options.length === 0) return;
      if (event.key === "Enter" && activeIndex >= 0) {
        event.preventDefault();
        options[activeIndex].click();
        return;
      }
      if (event.key === "Enter") return;
      event.preventDefault();
      activeIndex =
        event.key === "ArrowDown"
          ? Math.min(options.length - 1, activeIndex + 1)
          : Math.max(0, activeIndex - 1);
      options.forEach((option, index) => option.setAttribute("aria-selected", String(index === activeIndex)));
      input.setAttribute("aria-activedescendant", options[activeIndex].id);
      options[activeIndex].scrollIntoView({ block: "nearest" });
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search-wrap")) close();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.focus();
      }
    });
    results.addEventListener("click", (event) => {
      const link = event.target.closest("[data-search-result]");
      if (!link) return;
      const product = PRODUCTS.find((item) => item.slug === link.dataset.searchResult);
      track("select_item", {
        item_id: product?.code,
        item_name: product?.name,
        item_list_name: "predictive_search",
      });
    });
  }

  function initCollection() {
    const grid = document.querySelector("[data-collection-grid]");
    if (!grid) return;
    const search = document.querySelector("#collection-search");
    const sort = document.querySelector("#collection-sort");
    const summary = document.querySelector("[data-result-summary]");
    const buttons = [...document.querySelectorAll("[data-filter]")];
    const params = new URLSearchParams(window.location.search);
    let category = CATEGORIES.some((item) => item.key === params.get("category")) ? params.get("category") : "all";

    const updateUrl = () => {
      const next = new URL(window.location.href);
      if (category === "all") next.searchParams.delete("category");
      else next.searchParams.set("category", category);
      if (search.value.trim()) next.searchParams.set("q", search.value.trim());
      else next.searchParams.delete("q");
      window.history.replaceState({}, "", next);
    };

    const render = () => {
      const query = search.value.trim().toLowerCase();
      let filtered = PRODUCTS.filter((product) => {
        const categoryMatch = category === "all" || product.categoryKey === category;
        const queryMatch =
          !query ||
          [product.name, product.code, product.category, product.strength, product.descriptor]
            .join(" ")
            .toLowerCase()
            .includes(query);
        return categoryMatch && queryMatch;
      });

      if (sort.value === "name-asc") filtered.sort((a, b) => a.name.localeCompare(b.name));
      if (sort.value === "price-asc") filtered.sort((a, b) => a.price - b.price);
      if (sort.value === "price-desc") filtered.sort((a, b) => b.price - a.price);

      grid.innerHTML = filtered.length
        ? filtered.map((product) => productCard(product)).join("")
        : `
          <div class="empty-state">
            <h2>No catalog entries match.</h2>
            <p>Clear the search or show every research area.</p>
            <button class="button button-primary" type="button" data-reset-collection>Show all products</button>
          </div>
        `;
      summary.textContent = `${filtered.length} ${filtered.length === 1 ? "catalog entry" : "catalog entries"}${category === "all" ? "" : ` in ${CATEGORIES.find((item) => item.key === category).name}`}`;
      buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === category)));
      updateUrl();
    };

    search.value = params.get("q") || "";
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        category = button.dataset.filter;
        render();
        track("filter_apply", { filter_name: "research_area", filter_value: category });
      });
    });
    search.addEventListener("input", render);
    search.addEventListener("change", () => {
      track("search", { search_term: search.value.trim().toLowerCase(), surface: "collection" });
    });
    sort.addEventListener("change", () => {
      render();
      track("sort_changed", { sort_value: sort.value });
    });
    grid.addEventListener("click", (event) => {
      if (!event.target.closest("[data-reset-collection]")) return;
      category = "all";
      search.value = "";
      sort.value = "featured";
      render();
      search.focus();
    });
    render();
  }

  function initProduct() {
    if (PAGE !== "product") return;
    const product = PRODUCTS.find((item) => item.slug === PRODUCT_SLUG);
    if (!product) return;
    track("view_item", {
      item_id: product.code,
      item_name: product.name,
      item_category: product.category,
      price: product.price,
      demo_only: true,
    });

    try {
      const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter((slug) => slug !== product.slug);
      localStorage.setItem(RECENT_KEY, JSON.stringify([product.slug, ...recent].slice(0, 6)));
    } catch {
      localStorage.setItem(RECENT_KEY, JSON.stringify([product.slug]));
    }

    const quantity = document.querySelector("#pdp-quantity");
    const normalizeQuantity = () => {
      quantity.value = String(Math.max(1, Math.min(MAX_QUANTITY, Number.parseInt(quantity.value, 10) || 1)));
    };
    document.querySelectorAll("[data-pdp-quantity-change]").forEach((button) => {
      button.addEventListener("click", () => {
        quantity.value = String(Number(quantity.value || 1) + Number(button.dataset.pdpQuantityChange));
        normalizeQuantity();
      });
    });
    quantity?.addEventListener("change", normalizeQuantity);

    document.querySelectorAll("[data-media-src]").forEach((button) => {
      button.addEventListener("click", () => {
        const media = document.querySelector("[data-main-media]");
        if (!media) return;
        media.innerHTML = productImage(product, true);
        const image = media.querySelector("img");
        const label = media.querySelector(".product-image-label");
        image.src = button.dataset.mediaSrc;
        image.alt = button.dataset.mediaAlt;
        image.style.transform = `scale(${button.dataset.mediaZoom || "1"})`;
        image.style.transformOrigin = button.dataset.mediaView === "label" ? "center 40%" : "center";
        if (label) label.hidden = button.dataset.mediaView === "scale";
        document.querySelectorAll("[data-media-src]").forEach((thumb) => thumb.setAttribute("aria-current", String(thumb === button)));
        track("product_media_selected", { item_id: product.code, media_label: button.getAttribute("aria-label") });
      });
    });

    const mainAdd = document.querySelector("[data-pdp-add]");
    const mobileBar = document.querySelector("[data-mobile-add]");
    if (mainAdd && mobileBar && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver(([entry]) => {
        const hasScrolledPastPrimaryAction = !entry.isIntersecting && entry.boundingClientRect.top < 0;
        mobileBar.dataset.visible = String(
          hasScrolledPastPrimaryAction && window.matchMedia("(max-width: 640px)").matches,
        );
      });
      observer.observe(mainAdd);
    }
  }

  function initAccordions() {
    document.querySelectorAll(".accordion-trigger").forEach((button) => {
      button.addEventListener("click", () => {
        const expanded = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!expanded));
        const panel = document.querySelector(`#${CSS.escape(button.getAttribute("aria-controls"))}`);
        if (panel) panel.hidden = expanded;
      });
    });
  }

  function initTestingLookup() {
    const form = document.querySelector("[data-testing-lookup]");
    if (!form) return;
    const input = form.querySelector("input");
    const results = document.querySelector("[data-lookup-results]");
    const params = new URLSearchParams(window.location.search);
    if (params.get("product")) input.value = params.get("product");

    const run = () => {
      const query = input.value.trim().toLowerCase();
      const matches = PRODUCTS.filter((product) => `${product.name} ${product.code}`.toLowerCase().includes(query));
      if (!query) {
        results.innerHTML = `<div class="lookup-card"><h3>Enter a product name or code.</h3><p>Examples: Retatrutide, OVO-001, or BPC-157.</p></div>`;
      } else if (matches.length === 0) {
        results.innerHTML = `<div class="lookup-card"><h3>No matching OVO Labs code.</h3><p>Try a product name, a code from OVO-001 through OVO-010, or browse the full testing table below.</p></div>`;
      } else {
        results.innerHTML = matches
          .map(
            (product) => `
              <div class="lookup-card">
                <p class="product-category">${escapeHtml(product.code)} · ${escapeHtml(product.category)}</p>
                <h3>${escapeHtml(product.name)} · ${escapeHtml(product.strength)}</h3>
                <p><strong>Testing status:</strong> No result reported for identity, content / mass, purity profile, sterility, or endotoxin.</p>
                <p><a class="text-link" href="${productPath(product)}">Open the product page ${icons.arrow}</a></p>
              </div>
            `,
          )
          .join("");
      }
      track("quality_lookup", { search_term: query, result_count: matches.length });
    };

    form.addEventListener("click", (event) => {
      const fill = event.target.closest("[data-fill-promo]");
      if (!fill) return;
      event.preventDefault();
      form.querySelector("#promo-input").value = fill.getAttribute("data-fill-promo");
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run();
    });
    if (input.value) run();
  }

  function initNewsletter() {
    document.querySelectorAll("[data-newsletter]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = form.querySelector('input[type="email"]');
        if (!input.checkValidity()) {
          input.reportValidity();
          return;
        }
        form.hidden = true;
        const success = form.parentElement.querySelector("[data-newsletter-success]");
        success.hidden = false;
        success.textContent = "Preference saved on this device. Nothing was transmitted, and no email will be sent.";
        track("newsletter_demo_completed", { storage: "none", transmitted: false });
      });
    });
  }

  function initLinkTracking() {
    document.addEventListener("click", (event) => {
      const productLink = event.target.closest("[data-product-link]");
      if (!productLink) return;
      const product = PRODUCTS.find((item) => item.slug === productLink.dataset.productLink);
      track("select_item", {
        item_id: product?.code,
        item_name: product?.name,
        item_list_name: PAGE,
      });
    });

    if (PAGE === "collection") {
      track("view_item_list", {
        item_list_name: "catalog",
        item_count: PRODUCTS.length,
      });
    }
  }

  function initCartPage() {
    if (PAGE !== "cart") return;

    /* Quantity and remove are handled by the shared cart handlers, which only
       repaint the drawer. On the cart page the summary, the free-shipping bar
       and the Checkout total all read from the same cart, so they must repaint
       too or the page shows a stale total. Deferred so the shared handler has
       already written the cart before we re-render from it. */
    document.addEventListener("click", (event) => {
      if (!event.target.closest("[data-cart-quantity], [data-remove-product], [data-clear-cart]")) return;
      setTimeout(() => {
        renderPage();
        initCartPage();
        renderCart();
      }, 0);
    });

    const form = document.querySelector("[data-promo-form]");
    if (!form) return;

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = form.querySelector("#promo-input");
      const feedback = form.querySelector("[data-promo-feedback]");
      const code = (input.value || "").trim().toUpperCase();
      const draft = readCheckoutDraft();

      if (!code) {
        delete draft.promo;
        writeCheckoutDraft(draft);
        feedback.textContent = "";
        feedback.classList.remove("is-error");
        renderPage();
        initCartPage();
        return;
      }

      if (!PROMO_CODES[code]) {
        feedback.textContent = `${code} is not a valid code.`;
        feedback.classList.add("is-error");
        return;
      }

      draft.promo = code;
      writeCheckoutDraft(draft);
      track("promo_applied", { code });
      renderPage();
      initCartPage();
    });
  }

  function initCheckout() {
    if (PAGE !== "checkout") return;

    const form = document.querySelector("[data-checkout-form]");
    if (!form) return;

    let current = "contact";

    const stepEl = (key) => form.querySelector(`[data-step="${key}"]`);
    const setError = (name, message) => {
      const el = form.querySelector(`[data-error-for="${name}"]`);
      if (el) el.textContent = message || "";
      const input = form.querySelector(`#${name}`) || form.querySelector(`[name="${name}"]`);
      if (input) input.classList.toggle("has-error", Boolean(message));
    };

    function paintStepper() {
      const order = CHECKOUT_STEPS.map((s) => s.key);
      const idx = order.indexOf(current);
      document.querySelectorAll("[data-step-indicator]").forEach((el, i) => {
        el.classList.toggle("is-current", i === idx);
        el.classList.toggle("is-done", i < idx);
      });
    }

    function show(key) {
      current = key;
      CHECKOUT_STEPS.forEach((s) => {
        const el = stepEl(s.key);
        if (el) el.hidden = s.key !== key;
      });
      paintStepper();
      if (key === "review") paintReview();
      window.scrollTo({ top: 0, behavior: "smooth" });
      track("checkout_step", { step: key });
    }

    function collect() {
      const data = readCheckoutDraft();
      new FormData(form).forEach((value, key) => {
        if (key === "cardNumber" || key === "cardExpiry" || key === "cardCvc") return; // never persisted
        data[key] = typeof value === "string" ? value.trim() : value;
      });
      const terms = form.querySelector('[name="terms"]');
      if (terms) data.terms = terms.checked;
      return data;
    }

    function persist() {
      writeCheckoutDraft(collect());
    }

    const RULES = {
      contact: [
        ["email", (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v), "Enter a valid email address."],
        ["phone", (v) => v.replace(/\D/g, "").length >= 10, "Enter a phone number with at least 10 digits."],
      ],
      shipping: [
        ["firstName", (v) => v.length >= 1, "Enter a first name."],
        ["lastName", (v) => v.length >= 1, "Enter a last name."],
        ["address1", (v) => v.length >= 4, "Enter a street address."],
        ["city", (v) => v.length >= 2, "Enter a city."],
        ["state", (v) => v.length === 2, "Select a state."],
        ["zip", (v) => /^\d{5}(-\d{4})?$/.test(v), "Enter a 5 digit ZIP code."],
      ],
      delivery: [],
      payment: [],
    };

    function validate(key) {
      const rules = RULES[key] || [];
      let ok = true;
      rules.forEach(([name, test, message]) => {
        const input = form.querySelector(`#${name}`) || form.querySelector(`[name="${name}"]`);
        const value = input ? String(input.value || "").trim() : "";
        if (!test(value)) {
          setError(name, message);
          if (ok && input) input.focus();
          ok = false;
        } else {
          setError(name, "");
        }
      });
      return ok;
    }

    function refreshSummary() {
      const holder = document.querySelector("[data-checkout-summary]");
      if (holder) holder.innerHTML = orderSummaryPanel(priceBreakdown(collect()));
      const total = priceBreakdown(collect()).total;
      const place = form.querySelector("[data-place-order]");
      if (place) place.textContent = `Place order · ${money.format(total)}`;
    }

    function paintReview() {
      const d = collect();
      const b = priceBreakdown(d);
      const holder = form.querySelector("[data-review-blocks]");
      if (!holder) return;
      const block = (title, bodyHtml, target) => `
        <div class="review-block">
          <div class="review-block-head">
            <h3>${escapeHtml(title)}</h3>
            <button class="link-button" type="button" data-edit="${target}">Edit</button>
          </div>
          <p>${bodyHtml}</p>
        </div>
      `;
      holder.innerHTML = [
        block("Contact", `${escapeHtml(d.email || "")}<br>${escapeHtml(d.phone || "")}`, "contact"),
        block(
          "Ship to",
          `${escapeHtml(d.firstName || "")} ${escapeHtml(d.lastName || "")}<br>${escapeHtml(d.address1 || "")}${d.address2 ? `<br>${escapeHtml(d.address2)}` : ""}<br>${escapeHtml(d.city || "")}, ${escapeHtml(d.state || "")} ${escapeHtml(d.zip || "")}`,
          "shipping",
        ),
        block("Delivery", `${escapeHtml(b.method.name)} · ${escapeHtml(b.method.detail)}`, "delivery"),
        block("Payment", "Not collected. This storefront cannot charge a card.", "payment"),
      ].join("");
    }

    form.addEventListener("input", () => {
      persist();
      refreshSummary();
    });
    form.addEventListener("change", () => {
      persist();
      refreshSummary();
    });

    form.addEventListener("click", (event) => {
      const next = event.target.closest("[data-next]");
      const back = event.target.closest("[data-back]");
      const edit = event.target.closest("[data-edit]");
      const place = event.target.closest("[data-place-order]");

      if (next) {
        const key = next.getAttribute("data-next");
        if (!validate(key)) return;
        persist();
        const order = CHECKOUT_STEPS.map((s) => s.key);
        show(order[order.indexOf(key) + 1]);
      }
      if (back) show(back.getAttribute("data-back"));
      if (edit) show(edit.getAttribute("data-edit"));
      if (place) placeOrder();
    });

    function placeOrder() {
      const terms = form.querySelector('[name="terms"]');
      if (terms && !terms.checked) {
        setError("terms", "Please confirm you have read the policies.");
        terms.focus();
        return;
      }
      setError("terms", "");

      const d = collect();
      const b = priceBreakdown(d);
      const now = new Date();
      const eta = new Date(now.getTime() + (b.method.id === "cold" ? 1 : b.method.id === "express" ? 2 : 5) * 86400000);
      const fmt = { month: "short", day: "numeric" };

      const order = {
        reference: `OVO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${Math.floor(1000 + Math.random() * 9000)}`,
        placedAt: now.toISOString(),
        placedLabel: now.toLocaleDateString("en-US", fmt),
        etaLabel: eta.toLocaleDateString("en-US", fmt),
        email: d.email || "",
        phone: d.phone || "",
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        address1: d.address1 || "",
        address2: d.address2 || "",
        city: d.city || "",
        state: d.state || "",
        zip: d.zip || "",
        shippingMethodName: b.method.name,
        shippingMethodDetail: b.method.detail,
        items: cart
          .map((line) => {
            const item = cartItemData(line.slug);
            if (!item) return null;
            return {
              slug: item.slug, name: item.name, code: item.code,
              strength: item.strength, price: item.price,
              quantity: line.quantity, isBundle: Boolean(item.productSlugs),
            };
          })
          .filter(Boolean),
        totals: { subtotal: b.subtotal, discount: b.discount, shipping: b.shipping, tax: b.tax, total: b.total },
      };

      try {
        localStorage.setItem(ORDER_KEY, JSON.stringify([order, ...readOrders()].slice(0, 10)));
      } catch (error) {
        /* storage full or blocked; the confirmation page will report no order */
      }

      cart = [];
      saveCart();
      localStorage.removeItem(CHECKOUT_KEY);
      track("order_placed", { reference: order.reference, value: order.totals.total });
      window.location.href = path("order-confirmation.html");
    }

    show("contact");
    refreshSummary();
  }

  renderPage();
  initCartPage();
  initCheckout();
  initDrawersAndCart();
  initSearch();
  initCollection();
  initProduct();
  initAccordions();
  initTestingLookup();
  initNewsletter();
  initLinkTracking();
  track("page_view", { page_title: document.title, page_path: window.location.pathname });
})();
