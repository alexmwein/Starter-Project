# Pocket Conductor transactional send design

Date: 2026-08-31

## Goal

Pocket should let the operator write a message once, queue more messages, and trust
the Mac to deliver each one to the intended Conductor chat. A composer redraw,
relay restart, browser timeout, device revocation, or delayed status response must
not create a duplicate, send to another chat, lose a photo, reorder a chat, or trap
the phone in an endless recovery loop.

This work keeps the current Pocket interface and durable receipt model. It replaces
the remaining gaps between accepted work, Accessibility automation, and delivery
settlement with one explicit transaction.

## Evidence

The current release recovered the original repeated composer redraw failure and its
full test suite passed. A deeper timing audit found several states that the previous
tests did not model:

1. A route and database check can become stale while Accessibility reacquires the
   window and input lease. A local Mac action in that gap can cause a duplicate or a
   press in a same-named replacement chat.
2. Device revocation can return success while an already accepted Accessibility
   operation is still walking toward Send.
3. The relay records `automating` before any transport starts. A restart in that
   preparation window is treated as an ambiguous send even though Conductor was
   never touched.
4. Photos retained before transport can remain retained forever after that restart.
5. Same-chat predecessor ordering exists only in memory and is lost on restart.
6. The new three-attempt loop can reach a fourth transport through the separate
   composer certificate branch.
7. The relay can allow 75 seconds of automation, while shutdown begins forcing the
   process out earlier.
8. A persistent delivery-status outage can restart the phone's 120 second recovery
   window every eight seconds forever.

These are timing and authority defects. Adding more blind retries would make them
worse.

## Chosen approach

Every send uses one bounded attempt controller, one prepress authorization
handshake, and one durable lifecycle. The server owns the final authorization to
type and press. The Accessibility helper owns the Mac input and route lease while
that authorization is decided.

The transaction remains fail closed. If Pocket cannot prove the target and the
absence of a prior send, it preserves the message for Check, Edit, or Delete. It
does not guess.

## Attempt controller

All initial, generic recovery, and composer certificate attempts pass through one
controller.

- A delivery receives at most three transport attempts total.
- The total automation budget remains 75 seconds.
- The controller owns the only attempt counter and deadline.
- A certified composer failure returns to preparation and consumes one attempt.
- The special composer certificate becomes evidence for the next attempt. It is no
  longer a separate path that can create attempt four.
- No attempt starts without the minimum time needed for route proof, composer proof,
  and a useful press window.
- Each new attempt repeats authentication, route, cursor, user-row, attachment, and
  input checks.

The healthy path still performs one attempt. The extra work runs only after a
certified prepress failure.

## Prepress authorization handshake

Each attempt gets a private temporary directory with owner-only permissions and a
random nonce. Its files contain only the nonce, timestamps, and state markers. They
never contain message text, attachment data, repository names, chat titles, or
credentials.

The flow is:

1. The server starts one Accessibility helper in prepare mode.
2. The helper selects the repository, workspace, and chat, proves one composer,
   acquires the physical input lease, records the current HID counters, and holds
   the route lease.
3. The helper writes a ready marker and waits for a bounded authorization marker. It
   does not focus, type, or press while waiting.
4. While that exact helper still owns the leases, the server rechecks the device
   session, exact database route by session ID, monotonic cursor, absence of any new
   user row, attachment scope, and the attempt deadline.
5. The server persists the transport phase, then writes the authorization marker.
6. The helper rechecks its route lease and HID counters, focuses the composer,
   validates the exact draft, and performs at most one Send press.

If the server exits before step five, the helper times out without changing the
composer. If the server exits after authorization, restart recovery remains
conservative because a press may have occurred.

This closes the practical race caused by local keyboard, mouse, tab, or chat actions
between the server's final database check and the press. Absolute atomic identity
inside Conductor still requires a native Conductor route API or an Accessibility
session identifier. If Conductor replaces a chat internally without any observable
route or HID change, Pocket must continue to rely on database confirmation and fail
closed.

## Durable lifecycle

The delivery ledger records these phases atomically:

1. `queued`, accepted and waiting for its turn.
2. `preparing`, checks or a helper may be running, but no helper is authorized to
   mutate the Conductor composer.
3. `transporting`, authorization has been issued and the helper may type or press.
4. `confirming`, the press returned and Pocket is attributing the database row.
5. `delivered`, one exact user row passed confirmation and the immediate rejection
   check.
6. `failed`, terminal evidence and allowed actions are recorded.
7. `discarded`, the operator explicitly removed or replaced this exact attempt.

On restart, `queued` and `preparing` are known not to have crossed the transport
boundary. They can become a retry-safe interrupted result. `transporting` and
`confirming` remain ambiguous until transcript and ledger evidence settles them.

After every certified prepress failure, the phase returns to `preparing` before the
next set of checks. The phase changes to `transporting` immediately before the
authorization marker is written, not at the start of general request preparation.

## Attachment recovery

Retained attachments store an opaque proof derived from the delivery key. The proof
contains no message text, route, device name, or file contents.

If restart recovery finds a matching delivery in `queued` or `preparing`, the
attachment manager releases those files back to staged and deletable state before
the phone receives the retry-safe result. Attachments for `transporting` or
`confirming` stay retained until delivery evidence resolves. Resolution clears the
recovery proof without weakening the existing attachment ownership checks.

## Durable same-chat order

Every accepted send stores an opaque predecessor proof for its chat. A later send
cannot enter preparation until its predecessor is delivered or explicitly
discarded. This relationship survives relay restart.

Retrying the later message does not bypass the predecessor. Sending a new third
message does not erase the chain. Edit and Delete send an authenticated action for
the exact failed attempt. That action marks the attempt discarded and releases the
next delivery. The ledger stores key proofs instead of raw idempotency keys or
message content.

The phone copy for this state is: "An earlier message in this chat needs Retry,
Edit, or Delete first." The existing card geometry remains fixed so this status
does not move the message bubble.

## Revocation ordering

Device revocation runs through the same global mutation queue as sends and tab
actions. A revocation accepted after a send waits for that already accepted
operation to finish. The successful revocation response therefore means no earlier
operation from that device remains in flight. A later queued send rechecks the
device session before preparation and never starts transport.

This design does not try to kill an arbitrary Accessibility child during a press.
The current automation process is global, not safely owned by one device, so forced
preemption could interrupt another authorized operation.

## Shutdown timing

One shared timing module defines the release and shutdown bounds:

- Automation budget: 75 seconds.
- Database confirmation reserve: 5 seconds.
- Result persistence and cleanup reserve: 5 seconds.
- Graceful drain: 85 seconds.
- Forced relay exit: 90 seconds.
- LaunchAgent exit timeout: 95 seconds.
- Installer removal wait: 100 seconds.

The CLI, installer, LaunchAgent template, and shutdown tests read or derive these
values from the same source. A normal update can wait for the longest valid send and
its durable result before replacing the runtime. The forced boundary remains finite
if Accessibility itself is stuck.

## Bounded phone recovery

The phone runs one automatic delivery-status epoch for an ambiguous receipt. The
epoch lasts at most 120 seconds. If status remains unavailable, Pocket shows a
stable Delivery unknown card and records that automatic recovery is exhausted.

The eight-second transcript backstop continues to refresh visible chat data, but it
does not immediately start another status epoch. Recovery can start again only
after a meaningful event:

- the operator taps Check;
- the page returns to the foreground;
- the device comes back online;
- the event stream reconnects; or
- a new event for the active chat arrives.

Each event increments a recovery generation once. Repeated timer ticks in the same
generation cannot restart polling. Transcript identity can still settle a receipt
without the status endpoint.

## Tests

Implementation starts with failing regressions for every state below:

- Two certified composer failures followed by one successful attempt.
- A certificate on attempt three cannot create attempt four.
- No typing or press occurs before the authorization marker.
- Device, route, cursor, user-row, attachment, or HID changes between ready and
  authorization block transport.
- A server exit before authorization leaves no composer mutation and reloads as
  retry safe.
- A server exit after authorization reloads as ambiguous.
- A retained pretransport photo is released and deletable after restart.
- Sends A and B keep A before B across restart, retry, Edit, and Delete.
- A new send C cannot silently clear the A to B dependency.
- Revocation waits for an earlier accepted transport and blocks later sends.
- Shutdown constants cover the full operation budget and installer wait.
- A 120 second status outage stops automatic polling until a meaningful event.
- Three to five rapid messages preserve acceptance order without duplicate
  transport.
- Different chats and repositories still route independently while Mac UI mutation
  remains serialized.

Tests use fake Accessibility helpers, isolated ledgers, fixture databases, fake
timers, and mounted mobile browser state. They do not send a real prompt.

## Release gate

The release requires JavaScript syntax checks, AppleScript compilation, focused
state-machine and fault tests, the full Pocket suite, mounted phone tests, installer
and rollback tests, and two independent dry reviews. The shell revision changes if
any public asset changes.

After commit and push, the installer creates a new immutable runtime and retains the
current runtime as rollback. Verification compares source and runtime bytes, checks
the LaunchAgent, runs doctor, checks loopback and private HTTPS health, and performs
read-only route readiness. It does not send a prompt, use a paid API, change a
credential, or alter Mac power settings.

## Scope and limits

This work changes Pocket Conductor, its installer, and its tests. It does not change
Conductor, Tailscale ownership, GPT accounts, OVO workers, credentials, Jolt, or Mac
sleep settings.

Pocket still requires the Mac to be awake, unlocked, connected, and running
Conductor. Accessibility structure changes can still stop a send, but they must stop
before a press and leave an actionable message. A native Conductor API with stable
session IDs would be the only way to remove the last internal identity limitation.
