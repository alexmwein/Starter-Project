# Pocket watchdog

Pocket watchdog is a read-only preflight for the Mac behind Conductor Pocket.
It checks the relay, phone session, Conductor sidebar, Codex seat registry,
disk, and sustained system load every ten minutes.

Run the same checks without sending a message:

```sh
npm run doctor
```

Install the versioned runtime and its `com.ovo.pocket-watchdog` LaunchAgent:

```sh
npm run install:agent
```

The installed doctor is `~/.local/bin/pocket-doctor`. The scheduled run sends
only through `~/.local/bin/safe-imessage --recipient alex --message ...`.
Distinct issues have a six-hour cooldown. A recovered issue sends one recovery
message, and a green run sends nothing. State is stored privately at
`~/.config/pocket-watchdog/state.json`.

For a safe installation inspection that writes the candidate plist outside
`~/Library/LaunchAgents` and does not arm outbound alerts, use:

```sh
npm run install:agent -- --prepare-only
```
