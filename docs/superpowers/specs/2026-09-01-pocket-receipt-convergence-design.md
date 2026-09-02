# Pocket receipt convergence and motion design

## Goal

Make a delivered Pocket message settle exactly once without leaving an old
`Delivered · Syncing…` notice, repeatedly redrawing the transcript, or weakening
delivery and cancellation safety.

## Verified failure

A delivered receipt whose exact Mac row has left the retained transcript window
is both missing and unreconciled. The missing receipt check reads the same
authoritative delivered status and settles it as if it were new. That settlement
clears the existing observation timestamp, persists the receipt, renders the
transcript, and forces a full refresh. The visible app backstop repeats every
eight seconds, while safe receipt observation needs ten uninterrupted seconds.
The cleanup clock therefore never finishes.

An observation that was interrupted by an offline or background interval has a
second liveness hole. The timestamp remains persisted, but the unreconciled path
does not restart its observer. A receipt older than the server ledger can also
enter a zero delay status loop after its observation deadline.

## Design

1. Route every unreconciled delivered receipt through both existing recovery
   entry points. Their guards select exactly one operation. A receipt with an
   observation timestamp resumes its bounded observer. A never observed receipt
   uses the existing stalled verification path.
2. Make delivered status handling idempotent. When a missing receipt check gets
   the same message and row identity it already holds, preserve the observation
   timestamp and do not run fresh settlement or a full transcript refresh.
   Terminal cancellation still wins. A changed delivered identity fails closed.
3. End receipt observation at its deadline when status is absent, unknown, or
   otherwise nonterminal. Never issue a zero delay polling loop.
4. Treat a missing or invalid delivered timestamp as immediately eligible for
   read only stalled verification instead of abandoning it forever.
5. Offer a compact Dismiss action only when a delivered notice has remained
   unresolved beyond the bounded automatic path. Dismiss writes the existing
   atomic resolved tombstone. It never sends, retries, edits, or deletes a Mac
   transcript row.
6. Preserve the existing in place transcript node reconciliation, synchronous
   scroll anchoring, fixed delivery metadata geometry, and chat strip anchoring.
   The verified jump comes from the repeated receipt settlement loop, so a wider
   animation rewrite is not justified.

## Safety invariants

- A status identity mismatch never clears or rebinds a receipt.
- A terminal cancellation replaces delivered state before expiry.
- Cross window expiry or dismissal remains atomic and cannot resurrect a receipt.
- No automatic path resends a message.
- Authorization, route, cursor, transcript identity, and cancellation checks stay
  unchanged.
- The status endpoint remains authoritative during the cancellation observation
  window.

## Verification

- Reproduce the eight second refresh versus ten second observation race with a
  deterministic lifecycle test.
- Prove an identical delivered status preserves the observation timestamp and
  avoids fresh settlement and full refresh.
- Prove an interrupted persisted observation resumes and expires only after an
  authoritative delivered status.
- Prove cancellation wins, identity mismatch fails closed, and two windows create
  one tombstone without resurrection.
- Prove absent status performs a bounded probe with no hot loop.
- Prove an invalid delivered timestamp still starts read only verification.
- Run receipt, stream, transcript, motion, client performance, server, shell, and
  full project checks.
- Verify the installed loopback and private Tailscale origin serve the new shell
  revision. Do not send a live message during verification.
