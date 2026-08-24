# Pocket retry, recovery, and send speed design

Date: 2026-08-23

## Goal

Make failed delivery actions work on the phone, make connection recovery immediate
and visible, and reduce ordinary send time without weakening delivery attribution or
duplicate-send protection.

## Measured baseline

The ten successful sends from the current phone shell have a 19,307 ms median,
22,359 ms p90, and 33,037 ms maximum. Median queue time is 42 ms. Median database
confirmation time is 446 ms. Accessibility automation consumes about 97.5 percent
of the normal send.

## Delivery action contract

A server-confirmed delivered result resolves the notice and permits no action. A
pending result returns the notice to its active delivery state. A terminal failed
result remains actionable. Retry still requires both `retrySafe` and
`definitelyUnsent`. Edit may recover text from any terminal failed result because
it sends nothing.

Only one terminal action may run for one notice at a time. The phone shows the
active action and disables sibling controls until verification and the atomic
IndexedDB claim finish. The existing claim remains the authority across Pocket
windows. Retry keeps the same idempotency key and increments the local attempt only
after the claim succeeds.

Manual Check performs one immediate authoritative status read. It reports delivered,
still sending, definitely not sent, or still unconfirmed without waiting behind the
two minute automatic recovery queue. Automatic recovery remains read only and never
resends.

## Connection recovery contract

A successful forced connection probe proves the private round trip, marks the relay
reachable, restarts the event stream, refreshes visible data, and rechecks ambiguous
deliveries. Run check again performs this work in the existing sheet with a visible
busy state.

The browser offline event marks Pocket offline immediately. The online event moves
Pocket to connecting, restarts the event stream, refreshes data, and rechecks pending
delivery state. A scheduled refresh followed by a forced flush produces one request,
not two.

## Send speed contract

The final send decision keeps both exact route proofs around the exact Send-control
resolution. The phone's required IndexedDB persist, durable server idempotency,
serialized Accessibility queue, physical-input lease, lock check, exact transcript
confirmation, and 400 ms attribution recheck remain unchanged.

The readiness wait does not need its own full route proof because it cannot press.
It proves the focused draft and exact enabled Send control, then the unchanged final
decision block performs both route proofs immediately before the press.

Outer AppleScript scans bulk-read roles, names, values, and class lists when macOS
returns complete aligned arrays. The current element-by-element path remains the
fallback. When the exact workspace and chat are already selected, the outer script
may skip its three delayed stability passes because the inner helper independently
acquires and verifies the route before typing. A route mutation keeps the full
stability window.

Missing-window recovery uses a real elapsed-time deadline. Accessibility query time
counts against the six second budget.

## Verification

Tests cover retryable failure, delivered elsewhere, pending delivery, non-retryable
failure, Edit, rapid double taps, immediate Check, connection probe recovery, offline
and online events, refresh collapse, exact final route proofs, bulk-read fallbacks,
selected-route stabilization, and the missing-window wall-clock bound.

No automated verification may send a real message. Release verification uses local
fixtures, the full Pocket suite, static asset coverage, browser checks, LaunchAgent
health, and byte comparison between the installed runtime and the release source.
