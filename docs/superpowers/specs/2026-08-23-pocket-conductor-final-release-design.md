# Pocket Conductor final release design

Date: 2026-08-23

## Goal

Pocket Conductor must be dependable enough to use away from the Mac. The phone should open on recent chats, send quickly, explain failures, preserve recoverable text, expose GPT account usage, and stay reachable while the Mac is awake.

## Scope

This release covers five connected areas:

1. Shared delivery and draft authority across Pocket windows.
2. A recent chats first phone experience.
3. GPT usage, loading failures, touch targets, and restrained view motion.
4. Send timing and readiness probe improvements.
5. Service worker, runtime retention, release, and live verification.

Permission prompts, Wake on LAN, remote process termination controls, and new outbound automation are outside this release. The release must not send a real prompt during testing.

## Delivery authority

IndexedDB remains the durable client authority for pending deliveries. Its snapshot gains bounded terminal tombstones keyed by message identity, delivery attempt, and delivery key. Edit and delete actions write a tombstone when they remove a delivery. A stale window cannot recreate a delivery covered by a tombstone. Existing array snapshots migrate on read.

Manual and automatic delivery checks reread shared authority before changing state. A BroadcastChannel announces delivery mutations so another open window can cancel stale local recovery quickly. IndexedDB remains the authority if the broadcast is delayed or unavailable.

Editing uses two phases. The client claims the failed delivery without removing its text, writes the recovered draft, confirms that draft persistence succeeded, and only then removes the delivery and writes its tombstone. A draft storage failure releases the claim and leaves the failed delivery available.

Drafts gain a persisted revision. Sending atomically claims that session revision in IndexedDB before creating the delivery. A second window with the same old revision cannot submit it again. A new edit creates a newer revision and can be sent normally. Claims expire if a window dies before transport begins, while consumed revisions remain bounded long enough to reject a stale duplicate.

## Phone experience

Recent Chats becomes the default route and the back destination from a transcript. Each row leads with the chat title and uses the workspace name as a quiet subtitle. Repository and branch details stay out of the primary list. Workspaces remain available as a secondary action for creating or finding a chat.

The transcript chat strip exposes four actionable states from data already held in memory. A gently pulsing copper dot means the agent is working. A still ring means the agent is waiting for operator input. A red marker means the chat failed. A static number means a finished response is unread. Working, waiting, and error take priority over unread state. The unread number disappears only after the existing read receipt flow confirms the response was read. The pulse is CSS opacity only, adds no timer or request, and is disabled by Reduced Motion.

Workspaces, sessions, and recent chats use explicit loading, loaded, empty, and error states. A failed request shows a Retry action and keeps usable cached data on screen.

The connection control receives a 44 point hit area without changing its visual weight. Panel changes use a short opacity and position transition that does not animate layout dimensions. Reduced motion disables the transition.

## GPT usage

The header glance selects the active GPT account first and shows percentage plus freshness. One shared in flight promise serves simultaneous usage requests. A short time to live refreshes data while Pocket stays open. A forced refresh joins an existing request instead of returning an empty result. The full account sheet can show every returned account without invoking another model or paid API.

## Speed and diagnostics

Failed delivery timing rows include the same content free phase durations as successful rows. This records where a failure spent time without recording prompt text.

The accessibility readiness loop uses a cheap child probe when the bulk probe is unreadable. Full control resolution is rate limited during that condition. The final two route proofs remain mandatory before a send is reported as delivered.

Recent chat navigation starts cache and network work during the existing exit motion, then commits results only when that navigation is still current.

## Release ownership

The service worker cache name derives from the shell revision. A revision change therefore cannot ship with the old cache generation. Tests prove installation failure preserves the prior worker and successful activation removes only Pocket owned old caches.

The relay installer creates and verifies a new immutable runtime, switches launchd to it, verifies health, then retains the active runtime plus one previous rollback runtime. It only removes conforming runtime directories beneath the configured runtime root. Symlinks and unrelated entries are never removed.

The release is integrated with current `origin/main`, reviewed twice by independent GPT-5.6 Sol passes, merged through GitHub, installed from the merged tree, and verified through loopback plus the private HTTPS URL. The Mac uses an idle sleep inhibitor tied to the Pocket relay so Pocket stays reachable while the relay is alive.

## Failure behavior

Delivery state fails closed. Missing shared authority, a held draft revision, or a storage error blocks mutation and leaves recoverable text intact. Loading and usage failures stay visible and retryable. A failed new runtime does not replace the active runtime or remove rollback files.

## Verification

Regression tests must cover legacy snapshot migration, tombstone rejection, two client edit and delete races, draft persistence failure, duplicate draft claims, usage request coalescing, time to live refresh, GPT account selection, loading retries, service worker cache derivation, runtime retention safety, failure timings, and unreadable readiness probes.

The final gate is the full Pocket test suite, static asset coverage, two independent read only reviews, byte comparison between merged source and the live runtime, loopback health, private HTTPS health, account usage read, and phone sized browser checks. No verification step submits a message.
