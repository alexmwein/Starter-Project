# Pipeline, Automation, and Control Design

Status: canonical detail under [SYSTEM.md](./SYSTEM.md)

Version: 1.0

Effective: 2026-08-21

## One system, separate objects

OVO uses one canonical operating database with five pipelines:

1. Brand opportunities
2. Campaigns
3. Creator relationships
4. InnerDM cohorts
5. Operator capacity

Brand accounts, people/employments, campaign assignments, financial events, tasks, signals, and evidence are related objects, not extra pipelines.

Combining these objects destroys stage meaning. A brand can be an active account while one campaign is in production, one invoice is overdue, and a renewal opportunity is still in Proposal. Those states must coexist.

## Required data controls

- Stable IDs for every canonical object.
- Stage transitions enforced against the exit criteria in `lifecycle-and-routing.md`.
- One accountable seat and assigned person per active object.
- One next action and due time per active object.
- Full assignment, merge, override, and stage-transition history.
- Gross value, settled cash, creator payout, refunds, fees, direct cost, labor, commission, and contribution stored separately.
- Source, as-of timestamp, freshness, and evidence links on metrics and signals.
- Account-, person-, and contact-point-level suppression checked at dispatch time.
- Role-based access and immediate offboarding.
- Unknown data stored as unknown, never a positive default.

## Automation order

Build controls before convenience.

1. **Canonical capture.** Normalize identities, deduplicate, preserve source, and attach immutable evidence.
2. **Required-state validation.** Refuse stage movement when exit evidence is missing.
3. **Next-action clock.** Put any active record without an action or due time into the owner's exception queue.
4. **Suppression and incident stop.** Commit the local stop first, then synchronize external providers with retries.
5. **Handoff packet.** Create and validate the Brand AE -> Account Director -> Campaign Operations packet.
6. **Capacity gate.** Block proposal and campaign-start actions until Jaci records capacity and expected contribution.
7. **Financial reconciliation.** Link invoices, receipts, refunds, payouts, costs, and commissions to the originating objects.
8. **Cohort timers.** Create D7, D30, and D60 tasks from the actual InnerDM launch time.
9. **Relationship continuity.** Enforce primary and backup creator coverage and test transfer readiness.
10. **Metric freshness.** Mark values stale after their configured limit and open a data-quality exception.
11. **Exception summaries.** Use automation to summarize evidence and rank risk after deterministic controls work.

Do not automate valuable-account outreach, pricing, promises, creator acceptance, payouts, compliance decisions, or exception waivers.

## Event and task model

Every material change creates an event:

- object ID and type;
- event type and prior/new state;
- effective timestamp and received timestamp;
- actor or provider identity;
- evidence reference;
- idempotency key;
- policy or rule version;
- correlation and causation IDs.

Provider webhooks are a durable event stream. Verify signatures, store once, reduce idempotently, retry with bounded backoff, reconcile from provider cursors, and keep unresolved failures visible. An external synchronization is never assumed atomic with the local transaction.

Every task includes:

- parent object;
- accountable seat and assigned resolver;
- action, due time, and supported-hours calendar;
- severity and escalation path;
- completion evidence;
- terminal reason.

## Commercial controls

### Opportunity forecast

Forecast from expected contribution, not contract value. Until OVO has 30 resolved qualified opportunities, use conservative provisional weights:

| Opportunity stage | Provisional probability |
|---|---:|
| Target | 2% |
| Engaged | 5% |
| Qualified | 20% |
| Solution validated | 35% |
| Proposal | 50% |
| Contracting | 75% |

Closed-won value is not forecast. It moves into contracted obligations, financial events, and campaign capacity. Replace provisional weights with observed conversion by segment once the sample is large enough; never edit weights to make a forecast look better.

### Proposal control

The system blocks proposal delivery without:

- required qualification evidence;
- scope and measurement;
- capacity approval;
- risk/compliance state;
- payment condition;
- expected contribution waterfall;
- approved term set or recorded exception.

### Deal desk

The Brand AE may approve a standard new deal when it uses approved terms, creates no custom product/legal work, and meets the approved contribution floor.

The Account Director may approve a standard renewal or expansion under the same constraints.

Alex approval is required for:

- expected value above $25,000 per month;
- expected contribution below 25% or the current approved floor;
- discount above 10%;
- exclusivity, guaranteed views/results, nonstandard refunds, or unusual payment timing;
- custom product work or creator rights;
- material regulatory, platform, safety, or reputation exposure.

Jaci has a capacity veto. A seller cannot override physical delivery capacity.

## Financial controls

Use the waterfall in `SYSTEM.md` for proposals, forecasts, commission statements, and scorecards.

- A signed agreement creates no collected revenue.
- An invoice creates a receivable, not cash.
- A settled receipt creates collected cash.
- Creator pass-through and InnerDM GMV are not OVO revenue.
- Commissions become eligible only after cash settles, delivery evidence exists where required, direct costs reconcile, attribution is valid, and any refund window clears.
- The financial controller cannot approve their own exception or compensation item.
- Adjustments above $500 require an independent approver until a different materiality policy is signed.

## Creator claim controls

- One active claim per creator across every account and channel.
- A claim requires verified manual-send evidence.
- The default cadence is D0, D2, D5, and D10 unless the relationship state requires something else.
- Positive reply response target is two supported business hours.
- The engaged-record lease renews through completed next actions.
- A missed action opens an exception; after the configured 24-hour grace period the record recycles with history intact.
- A trainee starts with at most 25 open prospect claims.
- A contracted creator never returns to the prospect pool.

Daily forced follow-ups are prohibited unless the creator expects them. The system rewards the correct next action, not raw activity.

## Communication and suppression

All channels write to one communications timeline with the account, person, creator, opportunity, campaign, and assignment IDs when known.

- A positive reply or booked meeting pauses conflicting sequences.
- Do-not-contact applies at the requested account, person, or exact contact-point scope.
- The local suppression commits before any new dispatch.
- Email, LinkedIn, calling, or messaging providers synchronize through a visible outbox with retries.
- A provider-sync failure never removes the local stop.
- Private communication analysis requires approved disclosure, access, retention, and redaction rules.

## Exception queues

The command center should prioritize these queues:

1. Safety, payment restriction, account restriction, legal/compliance hold.
2. Campaign miss likely inside 72 hours.
3. Unreconciled cash, payout, or commission variance.
4. Qualified commercial or engaged creator response SLA breach.
5. Missing owner, next action, due time, or exit evidence.
6. Capacity below sold obligation plus buffer.
7. Metric or signal stale past its freshness limit.
8. External provider event unresolved after retry/reconciliation.

Queue order is deterministic. A model may summarize why an item matters but cannot change severity or waive the rule.

## Data hygiene

### Daily

- Resolve identity collisions and external-provider failures.
- Review red incidents, overdue actions, and missing owners.
- Reconcile newly settled cash and required pauses.

### Weekly

- Merge duplicate brands by verified domain relationship and creators by normalized identity evidence.
- Close or re-plan stale active records.
- Reconcile receipts, payouts, costs, and commission eligibility.
- Review access changes and orphaned records.
- Mark expired signals and scorecard values stale.

### Monthly

- Review stage conversion and time-in-stage by source, owner, and segment.
- Audit ten random closed records against agreement, communication, delivery, and payment evidence.
- Recalculate contribution by brand, campaign, creator, operator, and engine.
- Test one creator-owner transfer and one provider-event replay.
- Remove access for inactive operators and offboarded users.

## Acceptance tests

The system is not complete until it passes:

- opportunity -> closed won -> accepted handoff -> campaign funding gate;
- campaign -> creator assignments -> delivery -> financial reconciliation;
- creator claim -> response -> contract -> primary/backup activation -> transfer;
- InnerDM launch -> canary -> D30 -> D60 decision;
- operator certification -> capacity assignment -> D30 productivity -> D60 decision;
- duplicate event replay without duplicate state change;
- do-not-contact racing a queued external send;
- missing source or expired as-of date producing Unknown/Stale, never Green;
- independent approval for a financial controller's own exception;
- ten routine records reaching terminal state without Alex routing them.
