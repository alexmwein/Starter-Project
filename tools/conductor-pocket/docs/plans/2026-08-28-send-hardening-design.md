# Pocket send hardening design

## Goal

Make phone sends reliable across every local Conductor repository while reducing the time spent driving the Mac UI.

## Route authority

Every operation carries the immutable session ID plus repository, workspace, title, and duplicate-title ordinal. The server refreshes that route after the operation reaches the front of the queue. Accessibility matching is scoped to the matching repository block and uses one label policy for exact names, diff badges, and owner prefixes.

## Delivery authority

The database row remains the delivery proof. Pocket also checks for an immediate Conductor rejection tied to that row and turn. A rejected steer is reported as failed, never delivered. Sends and UI controls share one serialized coordinator so controls cannot overtake accepted messages.

## Speed

Successful route locations are cached only as hints. The next operation validates the hinted repository, workspace, session, and tree shape directly. Any mismatch falls back to the full scan. The final press still requires fresh route, draft, physical input, lock, and unique send-control proofs.

## Recovery

Sleep, restart, and response-loss paths keep their idempotency record and database reconciliation. Proven stale chats are not reset automatically because a false positive could interrupt a real turn. Pocket exposes an explicit recovery action when the state is conclusive.

## Verification

Regression coverage includes owner prefixes, deletion-only badges, duplicate workspace names across repositories, renamed queued chats, immediate steer rejection, rapid message ordering, controls between sends, sleep and restart phases, and validated route-hint fallback.
