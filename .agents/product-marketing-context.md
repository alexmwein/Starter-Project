# Product Marketing Context

*Last updated: July 24, 2026*

## Product overview

**Working name:** Datum Peptides

**One-liner:** A fictional peptide ecommerce storefront that makes products fast to find and decision-critical facts easy to compare.

**Current reality:** Datum Peptides is a concept website. It has no company operations, inventory, material, customers, testing, laboratory relationship, fulfillment, payment, checkout, or commerce. A thin notice at the top of every page states that nothing shown is real, stocked, or for sale.

**What the website demonstrates:** A complete ecommerce information architecture: persistent predictive search, four catalog categories, ten product pages, three catalog sets, testing-status lookup, product comparison fields, educational guides, responsive navigation, a browser-local cart, explicit empty/error/success states, and event instrumentation.

**Concept category:** Peptide research-product ecommerce

**Product type:** Fictional brand, ecommerce prototype, and strategic company package

## Current catalog

| Code | Product | Category | Strength | Concept price |
|---|---|---|---:|---:|
| DP-001 | Retatrutide | GLP-1 & Metabolic | 10 mg | $105 |
| DP-002 | Tirzepatide | GLP-1 & Metabolic | 10 mg | $100 |
| DP-003 | Semaglutide | GLP-1 & Metabolic | 10 mg | $90 |
| DP-004 | Cagrilintide | GLP-1 & Metabolic | 10 mg | $89 |
| DP-005 | BPC-157 | Research Peptides | 10 mg | $60 |
| DP-006 | TB-500 | Research Peptides | 10 mg | $68 |
| DP-007 | CJC-1295 | Growth Hormone Research | 5 mg | $52 |
| DP-008 | Ipamorelin | Growth Hormone Research | 5 mg | $45 |
| DP-009 | CJC-1295 + Ipamorelin | Peptide Blends | 10 mg | $92 |
| DP-010 | BPC-157 + TB-500 | Peptide Blends | 20 mg | $118 |

The three concept sets are:

- Metabolic Reference Set
- Peptide Pair Set
- Secretagogue Reference Set

Every product and set must preserve the same evidence boundary:

- no material, inventory, or availability exists;
- no laboratory, testing method, result, certificate, or purity figure is represented;
- nothing can be checked out, paid for, ordered, shipped, or reserved;
- no ratings, reviews, popularity, scarcity, or urgency claims are fabricated;
- no dosing, preparation, administration, safety, efficacy, outcome, or human-use information appears.

## Primary user journeys

1. **Search directly:** Use the persistent search field to find a molecule or catalog code and open the canonical product page.
2. **Browse by category:** Choose one of four research areas, filter the collection, sort by name or concept price, and compare complete cards in place.
3. **Evaluate a product:** See the product identity, strength, format, price, testing state, quantity, and add-to-cart action in one decision block.
4. **Inspect testing status:** Search by product name or code and see what each analytical field would mean, including an explicit “No result reported” state.
5. **Build a local cart:** Add, update, remove, clear, and inspect a subtotal. The interaction ends before checkout and remains in browser storage.
6. **Learn:** Read short guides about product comparison and the scope and limits of testing documents.

## Audience and job to be done

**Prototype audience:** Ecommerce operators, brand builders, designers, and category researchers evaluating how a serious peptide storefront could merchandise a focused catalog.

**Potential future audience, only after independent legal and operating clearance:** Qualified organizations seeking research catalog products.

**Core job:** “Help me find the exact catalog entry, compare the facts that matter, and understand what evidence is actually reported.”

## Positioning

**Positioning statement:** Peptides, without the mystery.

**Value proposition:** A focused catalog with clear formats, testing status beside every product, and a fast path from search to cart.

**Differentiation:**

- search and categories are visible before brand theater;
- product cards expose complete decision fields;
- each molecule has its own canonical product page;
- testing status sits beside the decision rather than in a detached document library;
- empty evidence remains visibly empty;
- the cart gives precise feedback and stops honestly before checkout.

## Research-backed design principles

The 2025–2026 research package supports these implementation choices:

- Exposed predictive search and rich results for known-item discovery.
- Visual category shortcuts for exploratory discovery.
- Two-column mobile product grids with complete cards.
- Applied category state, result counts, clear search recovery, and predictable sorting.
- Product-first PDPs with image, identity, strength, format, price, testing status, quantity, and one CTA.
- Vertical detail sections and accordions rather than horizontal tabs.
- Exact add-to-cart feedback, editable quantity, remove, subtotal, and a clear terminal state.
- Eager loading and explicit dimensions for above-the-fold media.
- No ratings when review evidence does not exist.
- No autoplay, 3D, decorative scientific motion, fake urgency, or proof-badge clutter.

## Site architecture

```text
/datum-peptides/
├── catalog.html
├── bundles.html
├── testing.html
├── notes.html
│   ├── notes/reading-testing-status.html
│   ├── notes/choosing-by-molecule.html
│   └── notes/coa-boundaries.html
├── company.html
├── faq.html
├── policies.html
├── peptides/
│   ├── [10 canonical product pages]
└── 404.html
```

Legacy routes redirect:

- `/third-standard/` → `/datum-peptides/`
- `lot-record.html` → `testing.html`
- `access.html` → `catalog.html`
- `eligibility.html` remains a compatibility alias for the policy page.

## Brand voice

**Tone:** Clear, direct, technically literate, modern retail.

**Personality:** Focused, confident, useful, and honest.

**Use:** product, category, code, strength, format, testing status, result, method, scope, sample, cart.

**Avoid:** dossier, archive, institutional access, eligibility gate, release, protocol, dose, transformation, medical-grade, pharmacy-grade, guaranteed, best seller.

## Visual authority

Claude Fable 5 is the sole outward-facing design authority.

The locked “Bench Light” system uses:

- Inter for the retail interface and IBM Plex Mono for codes and small technical labels;
- `#F6F7F9` page background, white surfaces, `#101317` ink, `#5B6472` secondary copy;
- cobalt `#1F3FCF` for actions and active states;
- compact retail density, 48–68 px section rhythm, thin borders, restrained radii;
- a thin dark fiction banner;
- a sticky white header with exposed search and category subnav;
- a compact product-first hero and a first product row within the opening desktop viewport;
- four-up desktop and two-up narrow-width product grids;
- a cart drawer and mobile sticky product action.

## Proof rules

No claim is published without direct support.

| Claim type | Current state |
|---|---|
| Customers or testimonials | None |
| Ratings or popularity | None |
| Laboratory relationship | None |
| Identity, purity, content, sterility, or endotoxin result | No result reported |
| Inventory or availability | None |
| Fulfillment or delivery | None |
| Checkout or payment | None |
| Medical, clinical, or human-use guidance | Excluded |

## Measurement

The prototype writes non-PII events to `window.dataLayer` and exposes them through `window.DatumAnalytics.events()` for QA.

Core events:

- `page_view`
- `view_item_list`
- `search`
- `filter_apply`
- `sort_changed`
- `select_item`
- `view_item`
- `product_media_selected`
- `quality_lookup`
- `add_to_cart`
- `view_cart`
- `cart_quantity_changed`
- `remove_from_cart`
- `cart_cleared`
- `newsletter_demo_completed`

These events measure usability only. No prototype event is a purchase or commercial conversion.

## Goals

**Current goal:** Demonstrate a high-converting peptide ecommerce experience while remaining unmistakably fictional and non-transactional.

**Primary quality gates:**

- every reachable route loads without console errors;
- every visible control works;
- no broken internal links or orphan pages;
- keyboard completion for search, navigation, accordions, product quantity, and cart;
- rendered Fable approval at desktop and narrow width;
- no fabricated product, quality, customer, shipping, or operational claim;
- exact pushed commit deployed through the connected Sites project.
