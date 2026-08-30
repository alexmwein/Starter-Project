# Pocket Conductor send stall recovery design

Date: 2026-08-30

## Problem

Three live phone sends reached Pocket, navigated to the intended chat, and wrote the complete draft into Conductor. Pocket then waited until its 40 second helper deadline without pressing Send. Diagnostics reported `press-wait; last inner: none recorded`.

The readiness loop calls a cheap Accessibility probe before it calls the authoritative Send resolver. The cheap probe returns false when any composer child class list is unreadable. Conductor can replace an unrelated child while streaming or under load, so the probe can remain false even when the unique Send control is usable. Because the authoritative resolver is never called, the attempt consumes the entire retry budget. The draft remains unpressed, but the deadline result is not certified as safe to retry.

## Outcome

Pocket should recover from a false readiness probe without slowing the healthy send path or weakening the final press proof. A genuine missing or ambiguous Send control must remain unpressed. An attempt that cannot recover must preserve the exact draft and return a retry safe result only after revalidating the chat route, input ownership, draft value, and absence of any press.

## Design

The existing cheap probe remains the fast path. The wait loop periodically runs the existing authoritative resolver after a bounded streak of false probe results. A fallback success only ends the wait. It does not authorize a press. The existing focused composer validation, unique Send resolution, input lease, pinned route checks, and single press action remain mandatory at the decision point.

The press wait receives its own bounded recovery window inside the transport deadline. If neither the cheap path nor the authoritative fallback resolves a Send control, it fails with `send_unavailable` while time remains. The existing prepress certificate then rereads the route and draft twice and proves that the exact or partial draft is still present and no press occurred. The server may use that certificate for its existing single automatic retry. A failed certificate remains ambiguous and cannot retry automatically.

The happy path performs no additional structural work. Fallback structural reads are rate limited so a busy Conductor window cannot create a hot loop.

## Failure invariants

- Never press from the cheap probe result alone.
- Never press after a route, draft, focus, lock, or physical input change.
- Never retry automatically after any press attempt.
- Never retry automatically without the existing signed process, route, input, and draft certificate.
- Preserve the Mac draft and phone delivery record when recovery fails.
- Keep queued phone sends serialized through the existing mutation queue.

## Verification

Regression tests cover a false cheap probe followed by a successful authoritative resolution, a genuinely missing control, an ambiguous control, a route or draft change, a physical input change, a bounded prepress timeout, retry certificate handling, and no duplicate press. The focused Accessibility and server suites run before the full Pocket suite. Release verification includes syntax checks, AppleScript compilation, installer fixtures, a versioned live runtime cutover, loopback and private HTTPS verification, and a read only live composer readiness check. No verification sends a prompt.

## Scope

This changes only Pocket Conductor local delivery recovery and its tests. It does not use a paid API, change credentials, send a test prompt, alter GPT account usage, or touch any OVO outbound worker.
