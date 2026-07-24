# Third Standard: Fable 5 Design Authority

*Authored by Claude Fable 5 on July 23, 2026. Peptide catalog extension authored on July 24, 2026. This is the locked visual contract for the outward-facing site.*

## Peptide catalog extension

The fiction notice is a static strip above the header. It is not sticky and does not behave like a promotion. Use `--field`, one bottom hairline, ink text, and 11px uppercase mono. The exact notice is:

> Fictional concept. Nothing described here exists, is stocked, or is offered for sale.

The primary catalog label is **Peptides**. The homepage may preview three records; the peptide index contains eight. Entries use ruled editorial rows, never commerce cards, product renders, prices, stock signals, badges, or promotional imagery.

The homepage registration line is `Peptide research materials · Lot documentation`. Eligibility remains a secondary route: it appears in the mobile overlay and footer, while the desktop primary navigation preserves the five-item hierarchy.

Each named dossier follows one stable hierarchy:

1. name, program code, material class, and current state;
2. a five-row status ledger for identity, specification, characterization, lot, and availability;
3. the planned record structure;
4. the evidence boundary;
5. one research-profile action;
6. related named dossiers.

The evidence state is part of the product interface. No visual treatment may imply a released lot, completed test, certificate, inventory state, reservation, or commercial offer. Missing proof is written as a direct state, not hidden behind an empty card or disabled control.

At narrow widths the notice may wrap, peptide rows collapse to one column, identity cells stack, and the status ledger becomes a readable vertical record. No essential evidence state disappears.

## Brand verdict

Keep **Third Standard**. The name reads as metrology to the intended audience and as quiet ambition to everyone else. Never compress it or abbreviate it to “3S.”

The wordmark is `Third Standard` in the display serif, title case, 0.18em tracking, weight 400, with no symbol. On the homepage only, a hairline and the registration line `Analytical reference materials · Lot documentation` appear below it in 11px mono. The typography is the mark. Title case was explicitly approved in the rendered Fable review because it is more distinctive at display scale and is applied consistently.

## Tokens

```css
--paper: #f4f1eb;
--ink: #1a1814;
--rule: #c9c2b4;
--accent: #7a2e1d;
--muted: #6e675c;
--field: #ede9e0;
```

- Display: Cormorant Garamond 400/500.
- Editorial text: Source Serif 4 400/400 italic/600.
- Interface and metadata: IBM Plex Mono 400/500.
- Type scale: hero clamps to 82px desktop and 46px mobile; H2 clamps to 54px desktop and 40px mobile; H3 is 26px; body is 17/1.65; mono metadata is 11/1.45.
- Spacing scale: 8, 16, 24, 40, 64, 104, 168.
- Desktop sections: 168px top, 104px bottom.
- Mobile sections: 64px top, 40px bottom.
- Grid: 12 columns, 1200px max, 32px gutters, 40px desktop margins.
- Hairlines: 1px `--rule`.
- Motion: `cubic-bezier(0.2, 0, 0, 1)`; 160ms hover, 420ms reveal.
- Scroll reveals: opacity 0→1 and translateY 12px→0, once.
- Nothing loops, bounces, or parallaxes.

## Homepage architecture and copy

1. Full-viewport hero: pre-launch status, thesis, one access CTA, archival ampoule image.
2. Problem: “A certificate is a claim. Documentation is a defense.”
3. Lot Record: interactive ruled specimen with the permanent disclaimer `Schema preview — not a certificate or available lot.`
4. Access: “Controlled access, by design.”
5. Evidence Notes: a restrained editorial docket.
6. Colophon footer with the pre-launch, no-offer disclaimer.

## Page-level copy

| Page | Headline | Subhead | CTA |
|---|---|---|---|
| Catalog | The catalog opens with access. | Material classes under development are listed by analytical family. Availability claims are made only when lots exist. | Request research access |
| Lot Record | Built to be audited. | The full schema of a Third Standard lot record: every field, its source, and why a reviewer would ask for it. | Read the schema |
| Research Access | Access is reviewed, not sold. | Tell us who you are and what you defend your data to. Prepare an access file you keep. | Prepare access file |
| Evidence Notes | Evidence Notes. | Occasional papers on reference materials, uncertainty, and documentation. No cadence promised. | Read the latest |
| Company | A standards company, third of its name. | Who we are, what we will and will not claim, and how we intend to be measured. | Read the claims policy |
| Eligibility | Who we onboard. | Published criteria for research access. If you do not meet them yet, we say so plainly. | Check your institution |

## State contract

- Inputs use mono labels, field-colored backgrounds, and square geometry.
- Inline validation appears on blur with a specific correction.
- Empty state: “Nothing is listed yet. We do not publish placeholders.”
- A completed access file is downloaded locally. The confirmation must state: “Access file prepared and downloaded. Nothing was sent.”
- Focus is always visible: 2px accent outline with 2px offset.
- 404: “This page is not in the record.”
- Reduced motion renders every element in its final state with zero-duration transitions.

## Responsive contract

At 375px the page is single-column. The nav becomes the wordmark plus the word `Menu`; the overlay uses 26px serif links. Hero type is 46/1.05. The image moves beneath the copy and bleeds to the viewport edges. Tables become definition lists when possible. Tap targets are at least 44px.

## Signature moments

1. The pre-launch register line types once in mono, then stops.
2. Hairlines draw left-to-right on first intersection.
3. Lot Record rows reveal a margin annotation explaining why the field exists.
4. The active nav underline moves like a ledger index.
5. Access-file preparation steps through `Preparing` and `Written locally` before download.
6. The footer wordmark reaches full opacity only at the document’s end.

## Enforcement

- No gradient declarations.
- No glass or backdrop filters.
- No border radius above zero.
- No icon-font or generic feature-icon system.
- No urgency, consumer, medical, or transformation language.
- No unverified proof.
- No sentence that would sound evasive when read aloud in an audit.

## Final rendered review

On July 24, 2026, Fable reviewed the implemented homepage, peptide index, mobile menu, and Retatrutide dossier at 1440px and 375px.

The first review held the narrow-width release because the desktop second-column width leaked into stacked schema rows. The mobile stylesheet now explicitly gives the second cell `width: 100%`. Re-rendered dossier and homepage Lot Record evidence measured 327px cells inside 327px rows, with a 375px document width and no horizontal overflow.

**Final verdict: SHIP.** Fable approves the outward-facing release at both 1440px and 375px.
