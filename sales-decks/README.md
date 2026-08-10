# OVO Talent sales decks

Open the live presentation room to generate a creator-specific proposal, generate a brand-specific deck, or launch either presentation:

- `creator.html` — personalized creator partnership and signing conversation
- `brands.html` — personalized brand campaign, client-workspace, and past-work conversation
- `fitia-portal.html` — full interactive Fitia campaign-workspace demo for live screen sharing

The static deck engine and fallback assets live under `assets/`. Personalized creator proposals require an internet connection for the signed server-side Instagram lookup. Personalized brand decks use a signed 90-day link generated from a brand name, optional public domain, and optional campaign label.

## Live URLs

- Presentation room: `https://decks.ovotalent.com/`
- Creator deck: `https://decks.ovotalent.com/creator.html`
- Brand deck: `https://decks.ovotalent.com/brands.html`
- Fitia workspace demo: `https://decks.ovotalent.com/fitia-portal.html#overview`

The isolated Vercel project is `ovotalent/ovo-sales-decks`; it does not modify the public OVO site.

## Generate a personalized creator proposal

1. Open the presentation room.
2. Enter the OVO presentation access code and an Instagram handle or profile URL.
3. Optionally set the first two campaign lanes and write one specific sentence explaining why OVO invited the creator.
4. Select **Generate + open live deck**.
5. Screen share the signed URL that opens. Use **Copy shareable URL** if the creator needs the link afterward.

The access code is stored only in that browser tab's session storage and is not included in the proposal URL. Generated links are signed for the exact creator and campaign copy, expire after 90 days, and are marked `noindex`.

The enrichment endpoint makes one server-side ScrapeCreators request for the creator's public profile and a sample of up to 12 recent posts. It normalizes profile details, selects three high-signal recent posts when the provider returns them, calculates clearly labeled sample averages, and infers positioning hints. When Instagram exposes profile-level data but no feed edges, the deck switches to a deliberate profile-led layout instead of repeating or inventing creator imagery. It does not claim to download the creator's entire Instagram history or private Insights.

The second slide uses the same compact Instagram-profile UI as the Inner DM proposal and previews the personalized OVO relationship email that would be created during week-one setup. The next slide presents 300+ signed creator partnerships and shows July 20, 2026 public profile snapshots for Paula Vidal (`@paulaa_vidaal`), Daria Bakcheieva (`@ddfi.t`), and Veronica-signed two-million-follower creator Juan Cortez (`@juan.cortez3`) alongside their active OVO aliases. Snapshot avatars are stored locally so the roster-proof slide stays reliable during live calls.

The environment variables used by the production project are:

- `SCRAPECREATORS_API_KEY`
- `PROPOSAL_ACCESS_CODE`
- `PROPOSAL_SIGNING_SECRET`
- `ACADEMY_BRIDGE_ACCESS_CODE`
- `ACADEMY_PROFILE_BRIDGE_SECRET`

All five stay server-side. `ACADEMY_PROFILE_BRIDGE_SECRET` is an independent, rotatable credential used only when the deck service falls back to Academy's private profile provider. The paid profile endpoint only accepts canonical, signed proposal requests and caches successful pulls at the edge. Instagram media is delivered through a short-lived, signed, same-origin image proxy so the proposal can display the selected profile and post imagery reliably without exposing the API key or accepting arbitrary remote URLs.

Academy uses the same public-profile provider through the private
`/api/crm-instagram-profile` bridge to verify a managed creator's exact assigned
OVO email in their live Instagram bio. The bridge returns only the normalized
handle, public bio, follower count, and safe profile image URL. It is protected
by `ACADEMY_BRIDGE_ACCESS_CODE`, never accepts browser credentials, and is not a
public profile lookup endpoint. If the deck project's provider is unavailable,
it may call Academy's separately authenticated, rate-limited fallback; that
fallback returns a bounded normalized public-profile shape rather than the raw
provider envelope.

## Generate a personalized brand deck

1. Open the presentation room.
2. Enter the OVO presentation access code and the prospect’s brand name.
3. Optionally add the brand’s public website/domain and a campaign label.
4. Select **Generate + open live deck**.
5. Screen share the signed URL or copy it for follow-up.

The cover, presentation chrome, approval-workspace preview, and close are personalized without changing OVO’s verified client proof. Known brand identities use verified local logo assets. Unknown brands use a deterministic monogram, so an unvetted browser favicon never appears in a premium presentation.

Slide 11 recreates the real OVO brand-portal workflow as a presentation-safe miniature: draft versioning, exact-frame feedback, one revision thread, approve/request-revisions controls, deadlines, and campaign health. Plain `brands.html#11` shows the Fitia example. Personalized links configure that preview around the prospect. The sample draft and comments are explicitly illustrative; they are not represented as historical Fitia approvals or feedback.

The slide now launches `fitia-portal.html`, a full responsive demonstration with overview, deliverables, calendar, creator, performance/source, and campaign-brief views. The portal uses ten locally cached thumbnails from official Fitia YouTube Shorts and links every item back to its public source. Public view/like values are labeled as an August 8, 2026 snapshot and are never attributed to OVO. Creator roster labels, campaign dates, statuses, version history, comments, approvals, and targets are explicitly simulated. Demo interactions persist under the local-storage key `fitia-portal-demo-v1`; **Reset demo** restores the original state.

The brand deck now follows one clean sales spine: risk, standard, proof, method, control, close. Slide 2 is the only risk slide. Slide 5 is the verified Fitia result anchor. Slide 6 is an interactive proof rail for Cal AI, AYBL, and BeHard; press `1`, `2`, or `3` on that slide to switch cases. Slide 7 explains precision casting, slide 8 is the positive white-glove creator experience, and slide 9 shows creator-by-creator agreement alignment through OVO’s specialist legal partner. The legal slide describes OVO’s process, not guaranteed compliance or a transfer of the brand’s legal responsibility. Never describe the function as in-house counsel unless that exact relationship is verified for the prospect.

## Controls

- Arrow keys or space: navigate
- `F`: fullscreen
- `N`: speaker notes
- `O`: slide index
- `B`: black screen
- `1` / `2` / `3`: switch cases while slide 6 is open
- `Home` / `End`: first or last slide

Hover near the lower-right corner to reveal on-screen controls. Each slide’s number is also reflected in the URL hash, so links such as `creator.html#7` open on a specific slide.

## Presenting

For the sharpest Zoom share, use a 16:9 browser window and press `F` before sharing. Speaker notes are built into every slide but appear inside the shared tab, so review them before the meeting and close them with `N` once the call starts.

To preview the generic static decks locally from this directory:

```sh
python3 -m http.server 4178 --bind 127.0.0.1
```

Then open `http://127.0.0.1:4178/`.

The local static server cannot execute the Vercel API functions, so creator profile enrichment should be tested against the deployed presentation room.

## Claims discipline

The main proof slides use conservative, traceable language. “300+” refers to signed partnership agreement records across representation, campaigns, and repeat brand collaborations, not 300 unique active creators. The moving casting ledger intentionally repeats creator imagery with different agreement IDs to represent repeat collaborations.

Fitia proof is based on 59 executed creator agreements covering 51 unique creators and 65 de-duplicated public Instagram Reels. The public counters total 12,834,702 views, with a 174,502-view median; 51 of 65 crossed 100K, 27 crossed 200K, and three crossed 500K. Metrics were captured Aug 7–9, 2026, except one manually recorded Jun 25. Public views are not native reach, impressions, installs, revenue, or conversion attribution.

Cal AI proof covers seven unique signed creators and 60+ documented deliverables. The 13.4M figure is a 29-post public-counter subset: 17 recorded public view counts plus stored public Instagram play-count snapshots for 12 different posts. The 60+ program count combines 52+ de-duplicated live placements with eight completed Kiara workflow rows. Counters were captured on different dates and are not native reach, installs, conversions, or attributed revenue.

AYBL and BeHard are presented as operating cases, not performance cases. AYBL shows five executed creator partnerships and 44 tracked posted workflow rows. BeHard shows eight signed creators, a seven-week first-to-eighth agreement window, and recurring two-post monthly structures. Neither case presents public reach or performance counters.

Nike, Celsius, Gatorade, and Gymshark are confirmed direct OVO clients and are presented that way in the brand deck. Fitia is used to demonstrate the authentic client-workspace model, but the visible draft content and comments are illustrative. Keep any campaign-performance claims tied to source material rather than improvising numbers on the call.

The brand deck’s public-risk example is the FTC’s 2016 Lord & Taylor Design Lab matter. The FTC reported that 50 paid and gifted creator posts reached 11.4 million people and generated 328,000 brand engagements, and that the featured dress sold out, while its complaint alleged the agreements and approved posts omitted the material-connection disclosure. Present the matter as FTC allegations followed by a settlement and final consent order, not an admission, fine, creator failure, or commercially failed campaign. Primary sources: the [FTC announcement](https://www.ftc.gov/news-events/news/press-releases/2016/03/lord-taylor-settles-ftc-charges-it-deceived-consumers-through-paid-article-online-fashion-magazine), [complaint](https://www.ftc.gov/system/files/documents/cases/160523lordtaylorcmpt.pdf), and [case docket](https://www.ftc.gov/legal-library/browse/cases-proceedings/152-3181-c4576-lord-taylor-llc-matter).

Valid signed brand links personalize the cover, presentation chrome, operating-layer slide, casting context, creator-service slide, specialist legal-partner slide, workflow illustration, and close. The generic static fallback says “your brand.” The live portal link remains an explicitly labeled Fitia public-source workflow demo; the prospect token is never passed into that route.

The casting slide renders 126 visible agreement cards bleeding past the canvas to imply the larger 300+ signed archive. Repeated creator imagery represents repeat agreements. It does not claim 300 unique active creators, current availability, or a committed shortlist.

The two creator campaign lanes are outbound targets selected by the OVO operator. They are not represented as already-open brand briefs. The 30-day slide commits to operating cadence, with week-one setup followed by three weeks of active outbound. It is not a guarantee that a paid deal closes inside 30 days.
