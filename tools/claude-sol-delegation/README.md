# Claude Sol Delegation

This Claude Code plugin makes Claude the orchestration layer and routes multi-step
non-visual work to `gpt-5.6-sol` through the Codex CLI.

It adds:

- An always-on context hook that tells Claude when and how to delegate.
- A `/claude-sol-delegation:delegate` skill for explicit delegation.
- A `delegate-sol` command with foreground, background, status, wait, and log modes.
- Guards against Claude-model subagent fan-out and the unsupported `ultra` effort tier.

Claude still owns task framing, judgment, visual direction, review of the returned
evidence, and the final answer. Sol owns implementation, debugging, repository
inspection, research, tests, data work, infrastructure, and other multi-step
non-visual execution.

## Requirements

- A current Claude Code release with plugin support.
- The Codex CLI installed and authenticated.
- Access to the `gpt-5.6-sol` model.

## Install

Install for the normal personal Claude profile:

```bash
./install.sh
```

Install across `~/.claude` and every directory under `~/.claude-profiles`:

```bash
./install.sh --all-profiles
```

The general default uses the Codex CLI with the `workspace-write` sandbox. A
machine that already has a quota-aware `sol` launcher can opt into it:

```bash
./install.sh --all-profiles --runner sol --sandbox danger-full-access
```

Existing installations are moved to timestamped directories under the target
profile's `backups/claude-sol-delegation/` folder before a new copy is installed.
Start a new Claude session or run `/reload-plugins` afterward.

## Verify

```bash
claude plugin validate .
delegate-sol doctor
delegate-sol --foreground --effort low -- "Print DELEGATION_OK and stop."
```

For local development without installing:

```bash
claude --plugin-dir .
```

## Safety

`delegate-sol` defaults to `workspace-write`. Use `--sandbox read-only` for
review or research and `--sandbox danger-full-access` only when the delegated
task actually requires unrestricted local access. The wrapper rejects `ultra`;
supported effort tiers are `low`, `medium`, `high`, `xhigh`, and `max`. Task
briefs and logs are stored with user-only permissions under the local state
directory, so never include credentials, secrets, or private production records
in a delegation prompt.
