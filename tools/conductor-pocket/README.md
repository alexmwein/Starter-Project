# Conductor Pocket

Conductor Pocket is a private, installable iPhone web app for reading and
steering the Conductor chats that already run on this Mac.

It is deliberately not a second agent client:

- Conductor stays the source of truth.
- Every existing Claude, Codex, Cursor, or ACP session keeps the account,
  model, permissions, working directory, and branch Conductor assigned to it.
- Transcript reads use SQLite's read-only mode.
- Sends go through Conductor's real on-screen composer and are acknowledged
  only after the exact new user-message row appears in Conductor's database.
- No transcript, credential, or agent token is uploaded to a hosting service.

## What “live” means

The relay watches Conductor's SQLite WAL and emits an event within roughly
60 ms of a write. The phone then requests only rows after its last cursor.
On a healthy tailnet, replies normally appear a few hundred milliseconds
after Conductor saves them.

Phone sends are serialized through macOS Accessibility. Selecting the target
workspace/chat, entering and verifying its real draft, pressing Conductor's
enabled Send control, and confirming the exact database row typically takes a
few seconds and briefly brings Conductor to the foreground. A draft already
present on the Mac produces a conflict sheet; Pocket never overwrites or merges
it silently. Physical keyboard or pointer input on the Mac aborts entry rather
than risking text in the wrong app, so pause Mac input briefly while a phone
message is being sent. Before offering a retry after an interruption, Pocket
waits for Conductor's database; it retries only when no new user row appeared.

The Mac login session must be unlocked and Conductor must have a visible
window for phone sends. macOS removes locked apps from the Accessibility tree,
so Pocket fails closed at the lock screen; it never disables or bypasses the
Mac's lock. Transcript reads can continue while the Mac is locked.

## Security model

The production setup is defense in depth:

1. The Node relay binds only to `127.0.0.1`.
2. A dedicated user-mode Tailscale node gives Pocket its own hostname, IP,
   certificate, browser origin, and **Serve** configuration. Funnel is refused.
3. Tailscale's authenticated identity header is captured at pairing and must
   match on every request.
4. A 192-bit, single-use pairing link expires after 15 minutes and stays in
   the URL fragment so it is not sent in HTTP request logs.
5. Pairing enrolls a WebAuthn platform passkey. Unlock requires user
   verification (Face ID on iPhone).
6. The device session is a random `Secure`, `HttpOnly`, `SameSite=Strict`,
   `__Host-` cookie stored only as a SHA-256 digest on the Mac.
7. Every mutation requires an exact Origin match and a device-specific CSRF
   proof. Sends additionally require an idempotency key.
8. The app uses a restrictive CSP, has no CDN/fonts/analytics, and never
   caches `/api/` responses in its service worker.
9. A server-side five-minute idle deadline requires Face ID again even if iOS
   kills the PWA; a one-hour absolute deadline caps continuously active use.
10. Cached transcript snapshots stay in the PWA's device-local IndexedDB,
   render only after Face ID unlock, retain at most 50 events per visited
   chat, and can be cleared from Security & Devices.

See [SECURITY.md](./SECURITY.md) for trust boundaries and failure behavior.

## Requirements

- macOS with Conductor installed and running.
- Node 22.5 or newer.
- Tailscale signed into the same tailnet on the Mac and iPhone.
- Homebrew's open-source `tailscale` formula for the dedicated Pocket node.
  Its background service must remain disabled; Pocket owns a private
  user-level daemon, state directory, and Unix socket.
- The Mac awake and online. Conductor can continue working with its window in
  the background, but it must have a window available for phone sends.
- One-time macOS Accessibility permission for the relay's Node executable.

## Setup

From this directory:

```sh
npm install
brew install tailscale
npm run sidecar:install
npm run sidecar:login
npm run setup
npm run install:relay
npm run sidecar:cutover
npm run doctor
```

`sidecar:login` opens a one-time Tailscale authorization URL in the Mac browser
and exits as soon as the private daemon owns the request; it does not need an
open terminal while you approve it. If the command or chat is interrupted,
rerun it to recover the still-pending URL from the private socket. If browser
opening is unavailable, explicitly print the secret with
`npm run sidecar:login -- --print-url`. After approving the URL, rerun the
command once to verify the node is authenticated. It creates a separate node
named `conductor-pocket`; it does not log out, rename, or replace the Mac's
normal Tailscale connection. Never run `brew services start tailscale` for
this setup.

`npm run setup` prints two values:

- a single-use pairing URL to open on the iPhone;
- a six-character verification code that must match the phone.

The relay installer first copies the audited runtime into
`~/.config/conductor-pocket/runtimes/`, so archiving or deleting this source
workspace cannot break the installed relay. The sidecar installer creates a
separate user LaunchAgent with a `0700` state directory and an explicit private
socket. Cutover refuses an unexpected daemon process or launch argument,
unsafe Tailscale preferences, extra Serve handlers, enabled Funnel state, a
different tailnet, a reused Mac node identity, or an origin mismatch.

Open the pairing URL on the iPhone while Tailscale is connected, compare the
code, enroll Face ID, then use Safari's Share → Add to Home Screen.

To pair another phone later:

```sh
npm run pair
```

## Migrating from the old shared Mac hostname

The old path-based setup must be retired, not reused. Paths on one hostname
share cookies, WebAuthn authority, IndexedDB, Cache Storage, localStorage, and
service workers.

1. Install and authenticate the dedicated sidecar.
2. Run `npm run install:relay` to install the versioned retirement client.
3. Run `npm run sidecar:cutover` once. This arms server-enforced retirement
   and disables new pairing on the old origin.
4. On every old phone, fully close and reopen Pocket while online. In Security
   & Devices, confirm the App row says `client 0.2.0`, then sign out **that
   same phone**. Close every other Pocket window first. The client sets an
   origin tombstone, stops sibling contexts, verifies it is the only remaining
   browser window, and erases IndexedDB, Pocket-owned Cache Storage, and the
   Pocket root service worker before the Mac records retirement.
5. Remove the old Pocket Home Screen icon.
6. Run `npm run sidecar:cutover` again.
7. Open the new one-time link, enroll a new Face ID passkey, and add the new
   dedicated address to the Home Screen.

Cutover rotates the CSRF secret, pairing secret, RP ID, and public origin,
requires a versioned self-purge receipt from every original device, verifies
the exact live config revision over both loopback and HTTPS, and removes only
Pocket's old `/` handler. Remote revocation cannot satisfy retirement. Other
handlers and listeners on the Mac's normal Tailscale hostname are checked
against the complete pre-cutover Serve document and preserved exactly.

If a legacy config already has no paired devices and no retirement record,
cutover refuses to guess. Only when the origin was never paired or every old
copy was independently erased may you explicitly run:

```sh
npm run sidecar:cutover -- --attest-no-old-devices
```

## Development

An insecure loopback-only mode exists for automated browser tests:

```sh
npm run setup -- --development --config /tmp/conductor-pocket-test/config.json
npm start -- --config /tmp/conductor-pocket-test/config.json
```

Development mode disables Tailscale identity enforcement and accepts HTTP
only on loopback. Never use it for phone access.

## Known v1 limits

- Agent permission prompts remain Mac-only.
- Stop, new-chat, and open-Conductor controls are absent because the relay
  cannot yet prove those capabilities safely.
- Attachments are read-only metadata; phone uploads are not implemented.
- The Mac must not be asleep. A future Wake-on-LAN helper can improve this,
  but it is intentionally outside the security boundary of v1.
