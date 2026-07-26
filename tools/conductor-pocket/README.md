# Conductor Pocket

Conductor Pocket is a private, installable iPhone web app for reading and
steering the Conductor chats that already run on this Mac.

It is deliberately not a second agent client:

- Conductor stays the source of truth.
- Every existing Claude, Codex, Cursor, or ACP session keeps the account,
  model, permissions, working directory, and branch Conductor assigned to it.
- Transcript reads use SQLite's read-only mode.
- Sends go through Conductor's real on-screen composer and are acknowledged
  only after its Send control clears the draft.
- No transcript, credential, or agent token is uploaded to a hosting service.

## What “live” means

The relay watches Conductor's SQLite WAL and emits an event within roughly
60 ms of a write. The phone then requests only rows after its last cursor.
On a healthy tailnet, replies normally appear a few hundred milliseconds
after Conductor saves them.

Phone sends are serialized through macOS Accessibility. Selecting the target
workspace/chat, setting its real draft, and confirming submit typically takes
1–3 seconds. A draft already present on the Mac produces a conflict sheet;
Pocket never overwrites or merges it silently.

## Security model

The production setup is defense in depth:

1. The Node relay binds only to `127.0.0.1`.
2. Tailscale **Serve** provides private tailnet HTTPS. Funnel is refused.
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
- The Mac awake and online. Conductor can continue working with its window in
  the background, but it must have a window available for phone sends.
- One-time macOS Accessibility permission for the relay's Node executable.

## Setup

From this directory:

```sh
npm install
npm run setup
npm run install:relay
npm run doctor
```

`npm run setup` prints two values:

- a single-use pairing URL to open on the iPhone;
- a six-character verification code that must match the phone.

The installer refuses to continue if any Tailscale Funnel exists or if a
Serve configuration would be overwritten. It creates a user LaunchAgent and
a private Serve proxy only after those checks. It first copies the audited
runtime into `~/.config/conductor-pocket/runtimes/`, so archiving or deleting
this source workspace cannot break the installed relay.

Open the pairing URL on the iPhone while Tailscale is connected, compare the
code, enroll Face ID, then use Safari's Share → Add to Home Screen.

To pair another phone later:

```sh
npm run pair
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
