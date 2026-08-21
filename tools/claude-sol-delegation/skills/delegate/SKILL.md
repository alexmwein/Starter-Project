---
name: delegate-to-sol
description: Delegate implementation, debugging, repository inspection, research, tests, data work, infrastructure, and other multi-step non-visual execution from Claude to GPT-5.6 Sol. Use automatically when the work is more than a single trivial operation, or explicitly when the user asks Claude, Opus, or another Claude model to delegate to Codex or GPT-5.6 Sol.
---

# Delegate to Sol

Keep orchestration, judgment, visual direction, review, and the final user-facing
answer in Claude. Send multi-step non-visual execution to GPT-5.6 Sol.

## Route the work

Delegate implementation, debugging, repository inspection, research, tests,
data work, infrastructure, CI/CD, scripting, and log analysis. Do not delegate
a one-command check when the delegation round trip costs more than the work.

Use these effort tiers:

- `low`: mechanical micro-task.
- `medium`: default execution or bounded research.
- `high`: specified build or change.
- `xhigh`: debugging, security review, or audit-grade work.
- `max`: hardest single-agent knot.

Never use `ultra`.

## Frame the delegation

Give Sol a self-contained brief with:

1. The exact objective and working directory.
2. Relevant facts, files, constraints, and user decisions.
3. What is in scope and explicitly out of scope.
4. Required validation.
5. A concrete completion receipt: changed files, tests, remaining risks, and
   any action that still needs Claude or the user.

Tell Sol not to widen scope, overwrite unrelated work, or claim success without
evidence. Never put credentials, secrets, private customer records, or other
sensitive values in the task brief; delegation task text and logs are stored on
disk for job monitoring.

## Run it

Use foreground mode for bounded work whose answer is needed immediately:

```bash
delegate-sol --foreground --effort medium --workdir "$PWD" -- "<task brief>"
```

Use background mode for longer work:

```bash
delegate-sol --effort high --workdir "$PWD" -- "<task brief>"
```

The command prints a job ID and log path. Inspect it with:

```bash
delegate-sol status <job-id>
delegate-sol active
delegate-sol tail <job-id>
delegate-sol wait <job-id> --timeout 60
```

Prefer `--sandbox read-only` for inspection. The default is `workspace-write`.
Use `--sandbox danger-full-access` only when the task requires it and the user or
environment policy permits it.

## Review the return

Read Sol's result and verify its evidence. Claude remains accountable for the
final judgment. Do not present a background start, process exit, or unreviewed
log as completed work.
