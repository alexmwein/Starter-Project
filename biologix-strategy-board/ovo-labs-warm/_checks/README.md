# Checks

Four harnesses that measure this storefront instead of judging it. Every one of them
caught a real defect that source-reading had missed.

| file | what it measures | what it caught |
|---|---|---|
| `design-probe.mjs` | spacing, type, colour, contrast, tap targets, per-component fingerprints across 30 page/width combos | 55 type pairs, 18 text colours, 143 contrast failures, h1 rendering 61px on one page and 72px on another |
| `layout-guard.mjs` | horizontal overflow and collapsed containers on 9 routes at 390 and 1440 | the mobile homepage rendering with a 0px-wide copy column and 126px of sideways scroll |
| `alignment.mjs` | distance from the shell edge to every block of copy | five different content insets (0, 17, 25, 32, 48) so nothing shared an axis |
| `functional.mjs` | add to cart, sell gate under DOM bypass, full 5-step checkout, card-data leakage, search | the sell gate is re-attacked by re-enabling a disabled button and clicking it |

## Run

    cd <a directory with playwright installed>
    node <path>/design-probe.mjs      # writes .context/defects.json
    node <path>/layout-guard.mjs      # prints CLEAN or the offending routes
    node <path>/alignment.mjs         # prints per-page axis report
    node <path>/functional.mjs        # prints all-green or the failures

The site must be served first:

    cd biologix-strategy-board/ovo-labs-warm && python3 -m http.server 8965 --bind 127.0.0.1

## Why these exist

Auditing by reading source kept missing what was obvious on screen. Analytical values
rendered white-on-white at 1.00:1 and the grep-based passes called it fixed. A drawer left
196px of dead space. The mobile homepage was structurally broken while every source check
reported clean.

Measure the rendered page. Do not trust a name, a flag, or a previous claim.
