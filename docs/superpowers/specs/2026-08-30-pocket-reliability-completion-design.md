# Pocket Conductor reliability completion design

Date: 2026-08-30

## Goal

Pocket Conductor must accept phone work quickly, preserve it across browser and
relay failures, deliver it to the exact Conductor chat, and keep the interface
steady while state changes. A green connection must describe operational truth,
not only process reachability.

## Evidence behind this release

The current live release is reachable and its files match source, but one of its
last three sends failed after 52.1 seconds. The first attempt spent 37.8 seconds
navigating, then the retry inherited too little budget to pass its own 15 second
reserve. The next two sends succeeded in 27.2 and 23.4 seconds.

Mounted UI fixtures also proved that transcript refresh detaches every message
control, a connection banner can shift a touched transcript by 60 pixels, and a
never-connected event stream can remain in Reconnecting forever. Source review
proved that queued row updates can remain stale, the recent strip freezes old
order, New Chat has no timeout, and attachment and delivery state do not converge
between Pocket windows.

## Approaches considered

### Patch each symptom

Keep the long phone request and add isolated timeout, scroll, and rendering fixes.
This is the smallest change, but the browser remains responsible for surviving a
20 to 50 second Mac operation. It does not close the phone termination or relay
restart boundaries.

### Mac-owned durable queue, recommended

Persist accepted work on the Mac before acknowledging the phone. The phone then
observes delivery through receipts while a serialized Mac worker drives Conductor.
Pair that authority change with in-place UI reconciliation and explicit freshness.
This preserves the existing route and database proofs while removing the browser
from the long critical path.

### Write directly to Conductor storage

Avoid Accessibility and insert commands into Conductor internals. This would be
fast but relies on an unsupported mutation contract and could corrupt sessions or
bypass Conductor state. It is rejected.

## Delivery authority

The Mac delivery ledger is the authority after acceptance. A message moves through
these durable phases:

1. `queued`, accepted and safe to start or resume.
2. `automating`, the exact route and composer are being acquired.
3. `press_intent`, every prepress proof passed and a press may happen.
4. `confirming`, the press was invoked and the database row is being attributed.
5. `delivered`, the exact database row and immediate rejection check passed.
6. `failed`, terminal evidence and retry authority are recorded.

The server persists `queued` before returning acceptance. A relay restart resumes
only queued work automatically. Any restart at `press_intent` or later reconciles
against the exact session baseline and message identity before allowing another
press. Absence must be observed for a bounded recovery window before a send can be
certified as definitely unsent.

The phone keeps its draft until the Mac acknowledges durable acceptance. It then
clears text and photos only with the existing revision and attachment fingerprint
guards. Closing Safari after acceptance cannot lose the operation. Closing Safari
before acceptance leaves the draft intact and creates no ambiguous delivery.

Each automation attempt receives a complete usable budget. A retry starts only if
the full minimum route, composer, and confirmation reserve remains. A depleted
shared deadline can never launch an attempt that is guaranteed to fail.

Messages remain globally serialized for Mac UI safety. Within one chat, a later
message waits when an earlier message fails before delivery. The operator can retry,
edit, or delete the failed predecessor before the dependent message resumes. Other
chats may continue when their routes are independent and the global mutation lease
is available.

## Route speed and readiness

Successful repository, workspace, and session locations remain hints, never
authority. A hint must validate repository scope, workspace identity, session ID,
title ordinal, and current AX tree identity before use. A failed hint falls back
once to the bounded full scan.

Readiness reports separate relay reachability, Conductor process state, database
access, event stream state, and exact routed composer readiness. If Conductor is not
running when work is queued, Pocket launches it once, waits within a fixed startup
window, and then continues or returns a clear failure. It never loops launches.

## Stable phone interface

Transcript reconciliation mutates the mounted list directly. Unchanged rows remain
connected, preserve focus, and keep an active touch target. Changed rows replace
only themselves. Removed rows are deleted only after desired order is reconciled.

Scroll anchoring is measured before banners, composer dimensions, or transcript
content change. A reader pinned to the bottom remains pinned. A reader who moved by
hand keeps the same visible content. The Latest control appears whenever content is
obscured by a connection banner.

Queued state is part of the render identity. While any visible Mac row is queued,
Pocket performs a bounded full reconciliation so a later `sent_at` update can
replace Queued with Delivered even though its database row ID did not change.

Recent chats use the newest of user activity, assistant activity, and session
updates. The strip follows that order. Reordering anchors the selected chip at the
same screen coordinate, so newest-first behavior does not create a visual jump.

Attachment drafts and pending-delivery mutations publish a lightweight local
change event. Other open Pocket windows reread durable state instead of trusting the
event payload. Text, photos, terminal cards, and ownership claims therefore
converge without weakening IndexedDB authority.

## New Chat and live updates

New Chat has a bounded request timeout, an idempotency key, visible failure copy,
and a durable status lookup. A workspace-level create path can create the first chat
without an existing session anchor. A lost response never causes a second chat when
the operator retries with the same key.

The event stream records when each connection attempt starts. A stream that has
never received its first event is rebuilt after the same bounded watchdog used for
a previously live stream. Data refresh remains deduplicated and only runs while the
page is visible.

## Usage truth

Usage rows show provider, account label, source, sample age, and stale state. Pocket
does not claim that a SwiftBar account is the account attached to a particular
Conductor chat. Missing or stale data remains visible and never falls back to a paid
API or reads an API key.

## Failure behavior

Wrong-route, ambiguous-press, storage, and identity failures fail closed. Recoverable
text and photos remain available. A definitely-unsent operation can retry. An
ambiguous operation can only check, edit, or delete until Mac evidence resolves it.
Internal error identifiers are mapped to plain phone copy while diagnostics retain
the exact code without message content.

## Verification

Every behavior change begins with a failing regression. Required fault fixtures
cover depleted retry budgets, relay termination in every durable phase, browser
termination before and after acceptance, same-chat predecessor failure, delayed
database row updates, control focus during refresh, banner insertion, newest chat
reordering, first-stream failure, New Chat timeout and response loss, empty
workspaces, cross-window photo and delivery changes, stale usage, and Conductor
startup.

The release gate includes JavaScript syntax checks, AppleScript compilation, the
full Pocket suite, mounted mobile browser fixtures, service-worker and installer
tests, two dry adversarial review passes, immutable runtime installation, source to
runtime byte comparison, loopback health, private HTTPS health, and exact read-only
route readiness. Automated verification does not send a real prompt, use a paid
API, change credentials, or alter power settings.

## Scope boundary

This release changes only Pocket Conductor, its local runtime, and its tests. It does
not change Conductor itself, any OVO outbound worker, Tailscale ownership, account
credentials, Mac sleep settings, or Jolt.
