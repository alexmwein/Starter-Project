# Peptide content intelligence pipeline

Generates the data behind the **Content Intel** board
(`biologix-strategy-board/content-intel/`, view 09).

## What it answers

Which peptide / GLP-1 affiliate content actually performs, and how much of that
performance a compliant Biologix affiliate could reproduce.

## Collection: no paid API

ScrapeCreators is **out of credits** (HTTP 402, verified 2026-07-24), so nothing
here uses it. All three lanes are keyless:

| Lane | Method | Notes |
|---|---|---|
| YouTube | `yt-dlp` search + per-video `--dump-json` | full description, where affiliate links live |
| TikTok | `yt-dlp` on the user feed | **must run from a residential IP**; cloud IPs get CAPTCHA'd |
| Instagram | public `web_profile_info` endpoint | bio + all bio_links; sleep 4s between handles |

Requires `yt-dlp` on PATH (`export PATH=/opt/homebrew/bin:$PATH`).
macOS has no `timeout` binary; the scripts use `--socket-timeout` instead.

## Run

```bash
cd .context/peptide-content-intel          # collectors write raw/ here (gitignored)
export PATH=/opt/homebrew/bin:$PATH

node collect_youtube.mjs                   # resumable; caches under cache/
node collect_tiktok.mjs
node collect_instagram.mjs
node analyze.mjs                           # -> content-intel/intel-data.js
```

`collect_youtube.mjs` is resumable and cache-backed. If it is interrupted,
re-run `ONLY=detail,build node collect_youtube.mjs`. Note `ONLY=build` alone
does **not** load the detail cache; use `detail,build`.

Then `npm run build && npx wrangler deploy` from the repo root.

## Data honesty rules baked in

- A metric the platform does not expose is `null`, never `0`, and likes are never
  substituted for views.
- The composite score renormalises over available dimensions, so a platform is
  not docked for a field it cannot return.
- **A post with no view count gets no score and is never rank-eligible.** 55 of
  the 100 score weight derives from views; scoring without them produced
  confident-looking numbers that outranked a measured 1.4M-view video.
- Claim-risk and replication-fit are judged on the **hook**, not the full
  description. Descriptions are mostly disclaimers and link lists, so scanning
  them rejected almost everything.
- Claim-risk rules are deliberately broad and word-order-independent. Requiring
  adjacency ("how to inject") produced false negatives on the two highest-risk
  videos in the set. On a compliance surface a false negative costs more than a
  false positive.
- `recon-structured.json` is the earlier **hand-collected** research, tagged
  `provenance: "hand_collected"` and never mixed into API-measured statistics.
