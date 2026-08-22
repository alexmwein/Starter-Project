# Four-Week Installation Plan

Status: active rollout plan under [SYSTEM.md](./SYSTEM.md)

Start: first Monday after CEO adoption

Owner: Alex for adoption; RevOps for installation

The goal is not to publish more documents. The goal is to make routine work move, reconcile, and stop without Alex routing it.

## Preflight: adoption decision

Before Week 1, Alex records one decision that:

- adopts `SYSTEM.md` as the authority;
- confirms the current seat register and interim assignments;
- names the supported-hours calendars and backups;
- sets the proof-cycle start and end dates;
- quarantines unsigned or conflicting compensation plans from operating calculations;
- freezes new business lines for the cycle.

## Week 1: establish one truth

### RevOps

- Configure the five canonical pipelines and supporting objects.
- Map every old stage to a new stage or terminal reason.
- Add accountable seat, assigned person, backup, next action, due time, source, and evidence fields.
- Add source, as-of, and freshness fields to the metric registry.
- Create exception types, severity, resolver, due time, and override audit.
- Produce dry-run import and duplicate reports before changing active records.

### Alex

- Confirm seat outcomes, decision rights, control limits, and stop-doing list.
- Lock the Brand Partnerships and InnerDM proof gates.
- Name the independent approver for Patricia's own financial exceptions.
- Put product, key-close, and operating-review blocks on the calendar.

### Kennedy, Brand AE

- Reconcile every open brand opportunity to the canonical stages.
- Add current buyer, signal, qualification evidence, economics, and next action.
- Separate opportunities from active accounts, campaigns, and invoices.
- Close false pipeline with a reason.

### Patricia, Account Director + interim RevOps/Finance

- Reconcile active accounts, renewal dates, invoices, receipts, payouts, commissions, and contribution.
- Establish the handoff-acceptance view and collection exceptions.
- Mark any value without source or current evidence Unknown.
- Document the interim seat split trigger and independent-approval path.

### Jaci, Campaign Operations

- Reconcile every sold campaign to the canonical campaign stages.
- Record required capacity, confirmed capacity, backup capacity, milestones, approvals, and risk.
- Separate creator relationships from campaign assignments.
- Block work that has no funding, explicit creator acceptance, or required compliance approval.

## Week 2: test the state machines

Run ten representative records through each applicable path:

1. Target -> Qualified -> Proposal -> Contracting -> Closed won/lost.
2. Closed won -> accepted handoff -> campaign Funding gate.
3. Campaign Planned -> Staffed -> Production -> Approved -> Live -> Reconciled.
4. Creator Candidate -> Claimed -> Engaged -> Contracted -> Activated -> Productive.
5. InnerDM Nominated -> Launch ready -> canary -> Live -> review timer.
6. Operator Applicant -> Certified -> Capacity assigned.

For each path, test:

- missing evidence blocks movement;
- SLA creates backup and exception events;
- override records actor, reason, and authority;
- no routine failure silently becomes Alex's task;
- terminal records preserve history and attribution.

Fix the contract or implementation when a reasonable operator cannot tell what to do next. Do not train around a broken workflow.

## Week 3: make economics and exceptions visible

- Publish separate Brand Partnerships and InnerDM P&Ls.
- Link settled receipts and direct costs to opportunity, campaign, creator, operator, and source where applicable.
- Turn on payout and commission eligibility only after reconciliation passes.
- Populate the scorecard from named reports or queries; no copied number without source and as-of time.
- Activate stale-metric, missing-owner, overdue-action, capacity, margin, payment, relationship-risk, and provider-sync exceptions.
- Measure qualified conversations, delivery, retention, contribution, and founder routing hours. Do not optimize raw dials, messages, headcount, or GMV.

## Week 4: remove founder routing

- Audit every Alex interruption from the prior seven days.
- Convert each repeated interruption into a rule, seat assignment, checklist, control, automation, or stopped activity.
- Confirm Kennedy can run the qualified opportunity forecast and standard close.
- Confirm Patricia can accept handoffs, run accounts, renewals, collections, and interim finance control.
- Confirm Jaci can run capacity, assignments, delivery, evidence, and campaign reconciliation.
- Confirm primary and backup Talent Managers can transfer one creator relationship without information loss.
- Run the first scorecard review with freshness checked before performance.

## Migration sequence

1. Export and back up current records and configuration.
2. Create canonical object types and stage dictionaries.
3. Add controls and required fields without blocking users.
4. Dry-run identity and stage mapping; review ambiguous records.
5. Apply in checkpointed batches with idempotent imports.
6. Assign seats, people, backups, next actions, and due times.
7. Attach agreements, delivery, payment, and attribution evidence.
8. Enable warnings; observe for three business days.
9. Enable stage blockers and dispatch-time suppression.
10. Validate reports against source ledgers.
11. Remove or archive old views only after reconciliation.

## Rollback conditions

Pause or roll back a control when it:

- can lose or misattribute a payment, payout, suppression, agreement, or communication;
- prevents a required safety or account-restriction stop;
- changes historical state rather than appending a correction;
- produces duplicate external actions;
- cannot explain which rule and evidence caused a transition.

Operational inconvenience is not a reason to bypass a control. Repair the workflow and record any temporary manual path as an audited override.

## Installation acceptance

Installation is complete only when:

- active records use the five canonical pipelines and supporting objects;
- every active record has accountable seat, person, state, next action, due time, economics, and evidence;
- all required current metrics have source and as-of time;
- ten test records pass each relevant state machine and handoff;
- do-not-contact and red incidents stop locally before provider synchronization;
- no compensation statement uses an unsigned or conflicting plan;
- at least 90% of routine decisions happen without Alex; and
- Alex records fewer than five routine-operations hours per week for two consecutive weeks.
