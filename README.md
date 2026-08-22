# OVO Operating System

OVO's operating contract and browser-local command center for focus, ownership, pipeline control, evidence-backed metrics, and weekly review.

## Surfaces

- [Command center](./index.html) — focus, organization, scorecard, pipelines, role boundaries, and the weekly operating review.
- [Operating flow](./operating-flow.html) — interactive map of acquisition, creator supply, delivery, InnerDM, and the shared control plane.
- [Canonical system contract](./docs/ovo-operating-system/SYSTEM.md) — the source of truth whenever another artifact disagrees.
- [Implementation architecture](./docs/ovo-operating-system/ARCHITECTURE.md) — production boundary, state model, route plan, security controls, and build sequence.
- [Installation plan](./docs/ovo-operating-system/implementation-plan.md) — the four-week path from documented rules to operating adoption.

## Truth boundary

The HTML app is a planning prototype, not a live CRM or finance ledger. Scorecard values are stored only in the current browser. A value is valid only when it has a named source and current as-of date; missing and expired evidence fails closed as `Unknown` or `Stale`.

## Run locally

No install or build step is required. Open `index.html` directly, use Conductor's Run action, or serve the repository with any static HTTP server:

```sh
python3 -m http.server 8000
```

Then open <http://127.0.0.1:8000/>.

## Validate

```sh
node scripts/validate-ovo-operating-system.mjs
```

The validator locks the 38-metric scorecard to the canonical specification, checks pipeline and operating invariants, exercises threshold boundaries, and guards the prototype's data-truth and accessibility contracts.

## Live site

The merged `main` revision is published at <https://alexmwein.github.io/Starter-Project/>.
