# Conductor Pocket security

## Protected assets

- Conductor transcript content and tool activity.
- The ability to inject a user message into an existing agent session.
- Session/account selection, workspace paths, branches, and model metadata.
- Device passkeys and relay session tokens.

Codex, Claude, GitHub, and other provider credentials are not copied into
Pocket. They remain inside the processes and profiles Conductor already owns.

## Trust boundaries

### Trusted

- Alex's logged-in macOS account and its local files.
- The installed Conductor application.
- The loopback interface.
- The authenticated Tailscale Serve proxy after its identity header is
  matched to the paired identity.
- The iPhone platform authenticator after WebAuthn user verification.

### Not trusted

- The public internet.
- The LAN.
- Other tailnet users or shared-device users.
- Browser origins other than the configured tailnet HTTPS origin.
- User-controlled transcript content, workspace names, chat titles, and
  message text.
- Requests replayed after uncertain network failures.

## Controls

### Network

The HTTP server refuses non-loopback binds in config validation. It validates
the Host header and accepts only the configured tailnet host or explicit
loopback development hosts. Tailscale Serve strips spoofed identity headers
before adding authenticated values. The installer refuses all nonempty
Funnel configurations and will not replace an existing Serve configuration.

### Authentication

Pairing uses a random 192-bit secret stored only as a hash. The secret is
carried in a URL fragment, expires in 15 minutes, and is consumed after a
successful passkey registration. A short authentication cookie protects the
registration ceremony.

Each paired device gets a WebAuthn credential and a separate 256-bit session
token. Only the token digest and public credential key are persisted. The
server forgets unlock state on restart. Face ID unlocks for at most one hour
and expires after five minutes without a heartbeat from a visible app. SSE
heartbeats never extend that deadline. The PWA stops its stream while hidden
and adds an opaque privacy shield before iOS takes an app-switcher snapshot.

### Authorization and request integrity

- Every protected request binds the cookie to its original Tailscale login.
- Mutations require the exact configured Origin.
- Mutations require an HMAC-derived, device-specific CSRF token.
- Send requests require an idempotency key and are serialized globally so
  concurrent UI automation cannot target different chats at once.
- An explicit retry reuses its original idempotency key, so a lost HTTP
  response does not normally create a second Conductor message.
- Pairing attempts are rate-limited.
- Input bodies and user messages have hard byte limits.

### Conductor integrity

The relay opens Conductor's SQLite database with `readOnly: true` and
`PRAGMA query_only = ON`. It does not insert queue rows, edit session state,
or connect to Conductor's sidecar socket.

A send uses macOS Accessibility to:

1. select the database-resolved workspace;
2. select the database-resolved session title and duplicate ordinal;
3. refuse a differing Mac draft;
4. set the real composer value;
5. identify the rightmost enabled Send control inside that composer group;
6. press it;
7. report delivery only after the composer clears.

If any check fails, the phone sees a specific failure code and the message
remains available for explicit retry. Reconnect never auto-sends a draft.

### Browser

The CSP allows only same-origin code, styles, images, and connections.
Framing, object embedding, referrers, camera, microphone, location, payment,
USB, and serial access are disabled. The UI builds transcript nodes with
`textContent`; transcript Markdown is never injected as HTML.

The service worker caches only the app shell and explicitly excludes `/api/`.
Device-local transcript snapshots are bounded and are not rendered until
after Face ID unlock. Revocation instructs the connected client to purge
them; a device that never reconnects remains protected by iOS Data
Protection and the app's Face ID gate.

## Residual risks

- A process already running as Alex can read the Conductor database or use
  macOS UI automation. Pocket does not claim to defend against compromise of
  the Mac user account.
- macOS Accessibility permission is broad. The relay's Node executable must
  be trusted and should not be replaced by an untrusted binary.
- UI automation depends on Conductor's accessible structure. Version changes
  fail closed: a missing workspace, session, composer, or enabled Send
  control produces an error rather than a guessed click.
- Idempotency history is held in relay memory. An unlikely relay restart after
  Conductor accepts a message but before the phone receives the response can
  still make an explicit retry ambiguous; Pocket never retries automatically.
- Tailscale users with access to the Mac's Serve endpoint can reach the
  unauthenticated app shell and pairing endpoint, but cannot pair without the
  high-entropy one-time link and matching identity.
- Device-local browser storage cannot be remotely erased while the iPhone is
  permanently offline. Revoke plus iOS device security is the recovery path.
