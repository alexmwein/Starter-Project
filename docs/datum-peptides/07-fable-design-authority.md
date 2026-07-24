# Datum Peptides — Fable 5 Design Authority

*Direction authored by Claude Fable 5 on July 24, 2026. Final rendered release review remains required.*

## Authority

Claude Fable 5 (`claude-fable-5`) is the sole outward-facing design authority for Datum.

Fable must author or explicitly review:

- layout and hierarchy;
- navigation and search;
- component composition;
- typography and color;
- spacing and responsive behavior;
- interactions;
- loading, empty, error, success, disabled, and focus states.

Implementation may preserve and test the contract but may not silently replace its visual direction.

## Chosen direction: Bench Light

Datum is a contemporary ecommerce store informed by a clean research bench—not a museum exhibit, luxury editorial, pharmacy imitation, or gray-market bodybuilding site.

The name is **Datum Peptides**. Do not use Foundry or any ledger or record-room language.

## Brand system

### Colors

```css
--bg: #F6F7F9;
--surface: #FFFFFF;
--ink: #101317;
--secondary: #5B6472;
--cobalt: #1F3FCF;
--cobalt-deep: #1832A8;
--cobalt-tint: #EEF1FD;
```

### Typography

- Primary: Inter.
- Technical metadata: IBM Plex Mono.
- No display serif.
- Product names use clear sans-serif hierarchy, not editorial ornament.
- Technical metadata remains small but never falls below readable contrast or size.

### Geometry

- Crisp surfaces with modest radius.
- Fine neutral borders.
- Dense but breathable grids.
- Cobalt reserved for primary action, focus, active state, and useful emphasis.
- No gradients, glass, pseudo-medical chrome, neon cyberpunk, or laboratory stock-photo collage.

### Rhythm

- Core section rhythm: approximately 48px, adjusted for content density.
- Store header and category navigation remain compact.
- Homepage hero is approximately 440px on desktop.
- First product row begins within the first 1000px desktop viewport.
- Mobile prioritizes two complete product cards per typical viewport.

## Global shell

### Fiction banner

- Thin dark strip above the header.
- Plain sentence, not promotional styling.
- Exact copy:

> Fictional concept storefront. Nothing here is real, stocked, or for sale.

- The banner must remain visible on every public route.

### Header

- Sticky white store header.
- Datum Peptides wordmark.
- Persistent search input.
- Primary links: Shop, Bundles, Testing & COAs, Learn.
- Cart control with local concept count.
- Secondary category row: Shop All, GLP-1 & Metabolic, Research Peptides, Growth Hormone Research, Blends.

### Mobile navigation

- Compact wordmark, search, menu, and cart.
- Menu opens a functional overlay/drawer.
- Focus enters the menu, remains trapped, closes on Escape/outside action, and returns to the trigger.
- Category navigation remains reachable without hiding search.

## Homepage contract

### 1. Hero

- Approximately 440px desktop height.
- Cool, bright bench-vial image.
- Clear statement of what Datum is.
- Primary Shop action and secondary Testing & COAs action.
- Overlapping product and testing-state cards may support the visual composition.
- Above-fold hero image is not lazy-loaded and receives explicit priority.

### 2. Interface-truth strip

Use only facts visible in the prototype:

- Search by product or code.
- Testing state beside every decision.
- Local demo cart; no checkout.

Do not use purity, customer, shipping, laboratory, support, or quality claims.

### 3. Category tiles

- Four visual category entries.
- Clear labels and product counts based on concept data.
- Entire tile is interactive.

### 4. Product row

- Four-up desktop.
- Two-up mobile.
- Complete card anatomy.
- First row arrives early; do not bury the catalog below brand storytelling.

### 5. Testing feature

- Document-like interface, not a fake certificate.
- Visible “No result reported.”
- Explicit missing fields.
- Link to Testing & COAs.

### 6. Concept sets

- Show included item names.
- Concept price and Add control.
- No outcome-based stack names, protocols, or savings urgency.

### 7. Learn

- Compact, source-aware cards.
- One useful question per article.
- Clear route into the relevant product or testing surface.

### 8. Newsletter demo

- Functional local success state.
- State that nothing was transmitted.
- No fake subscriber count or cadence promise.

### 9. Footer

- Compact route map.
- Fiction and no-commerce state.
- No trust-badge wallpaper.

## Product-card contract

Every card includes, in this order:

1. product image;
2. category;
3. product name and concept format;
4. neutral descriptor;
5. testing state;
6. concept price;
7. full-width Add control.

Rules:

- Four cards per row on standard desktop.
- Two complete cards per row on mobile.
- Product image uses a consistent aspect ratio.
- Names must not truncate into ambiguity.
- Add is a real local interaction.
- No stars, review count, discount badge, stock, urgency, shipping, purity, or bestseller label.

## Collection contract

- Compact title and result count.
- Visible search-within-results.
- Desktop filters are immediately understandable.
- Mobile filters open a bottom sheet.
- Applied filters are visible and resettable.
- Sort options have a clear current value.
- Zero-results state preserves context and provides reset/category paths.
- Grid remains stable during filter/sort changes.

## PDP contract

### First-screen decision block

- Breadcrumb.
- Name and product code.
- Category and concept format.
- Neutral descriptor.
- Concept price.
- Testing state.
- Full-width primary Add control at narrow widths.

### Below the decision

- Gallery with consistent, non-claiming imagery.
- Testing/document region.
- Concept specification table.
- Question-led accordions.
- Related products.
- Mobile sticky local-cart action where useful, without resembling checkout.

No required decision information may be hidden only inside an accordion.

## Testing & COAs contract

- Search by product name or code.
- Search always returns identity before evidence state.
- “No result reported” is the dominant status.
- Missing laboratory, method, sample, lot, date, and result are shown plainly.
- A future-record field list may appear.
- Do not render a fake signature, chromatogram, seal, report number, or laboratory brand.

## Cart contract

- Right-side drawer on desktop; appropriate full-height sheet on narrow screens.
- Item image, name, concept format, quantity, line total, remove.
- Clear subtotal.
- Working clear-all.
- Add opens the cart drawer, moves focus into its labeled controls, and restores focus to the originating Add control on close. Do not duplicate that confirmation with a simultaneous toast.
- Exact terminal explanation:

> This is where the demo ends. Nothing is stocked, sold, or shippable.

- No Checkout, Buy now, Reserve, Get quote, or payment control.

## Interaction states

### Search

- Idle, focus, typing, results, zero results, and escape/close.
- Keyboard arrows and Enter operate predictable result selection.
- Search terms are not lost when the panel closes unexpectedly.

### Add

- Default, hover, focus, pressed, focus-managed cart confirmation.
- Repeat adds update quantity.

### Newsletter demo

- Idle, validation error, preparing, local success.
- Success copy: “Preference saved on this device. Nothing was transmitted, and no email will be sent.”

### Loading

The static concept should rarely require loading UI. If introduced, loading states preserve layout and never simulate inventory or test retrieval.

### Error

Errors state what failed and the next action. No silent failure.

## Accessibility contract

- WCAG 2.2 AA target.
- Visible 2px cobalt focus treatment with offset.
- Primary controls target at least 44 × 44px; secondary inline links meet the WCAG 2.2 AA 24 × 24px minimum target or spacing exception.
- Logical heading hierarchy.
- Form labels persist outside placeholders.
- Drawers and dialogs trap and restore focus.
- Status changes use an appropriate live region or a focus-managed labeled drawer.
- Color never carries the only meaning.
- Reduced motion removes nonessential transitions.
- Images use accurate alt text or empty alt when decorative.

## Performance contract

- Above-fold image: WebP/AVIF where practical, explicit dimensions, no lazy loading, high fetch priority.
- Below-fold images: lazy-load with dimensions.
- No carousel dependency.
- No app pileup for basic search, cart, filters, or disclosure behavior.
- Target p75: LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 where field data exists.
- Build budgets: no unreviewed third-party script, font, or animation.

## Responsive checkpoints

Review at minimum:

- 1440 × 1000;
- 1280 × 800;
- 768 × 1024;
- 390 × 844;
- 375 × 812;
- 320 × 568.

At narrow widths:

- Search remains directly reachable.
- Two product cards fit without broken names or controls.
- Add controls stay full-width within cards.
- Filters use a bottom sheet.
- PDP primary action is reachable.
- Cart and menu do not create horizontal overflow.

## Prohibited visual patterns

- Serif-led luxury editorial.
- Museum or record-room vocabulary.
- Excessive whitespace that delays products.
- Fake scientific seals and badges.
- Fake documents.
- Syringes, injection preparation, body imagery, transformations, or clinical treatment scenes.
- Countdown timers, stock counters, pulsing urgency, or discount confetti.
- Empty rating rows.
- No-op controls.

## Rendered release review

Before shipment, Fable 5 must receive:

- desktop homepage;
- narrow-width homepage;
- desktop and mobile collection;
- desktop and mobile PDP;
- Testing & COAs state;
- open mobile menu;
- open demo cart;
- zero-result search/filter state.

Fable’s output must be one of:

- **SHIP** — no blocking visual changes;
- **HOLD** — named blocking changes and required evidence.

The current final-release verdict is pending the implemented render review. An approval for any prior concept is not approval for Datum.
