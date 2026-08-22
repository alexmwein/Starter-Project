# OVO Operating System Contract

Status: canonical

Version: 1.0

Effective: 2026-08-21

System owner: Alex, CEO

Operating steward: the RevOps seat

This file defines how OVO makes, records, and reviews operating decisions. It is the source of truth when another operating document, dashboard, playbook, or diagram disagrees.

## 1. Authority and change control

The document hierarchy is:

1. `SYSTEM.md`: company model, seats, objects, invariants, decision rights, and gates.
2. `lifecycle-and-routing.md`: stage definitions, exit evidence, routing, and SLAs.
3. `scorecard-spec.md`: metric definitions, sources, thresholds, and red actions.
4. Product and channel playbooks, including `brand-outbound-icp.md`.
5. `ARCHITECTURE.md`, visual maps, and the local command-center prototype.
6. Historical or proposed artifacts, including superseded technical plans and unsigned compensation term sheets.

Every operating change needs an effective date, one decider, the affected records or metrics, and a reason. Changes are prospective. A dashboard cannot silently redefine a metric or stage.

## 2. Company thesis

OVO is one creator-monetization company with two commercial engines and one shared capability layer:

1. **Brand Partnerships** produces near-term cash and demand. It sells and delivers recurring creator programs.
2. **InnerDM** is the owned product bet. It earns investment through retained, contribution-positive creator cohorts.
3. **Creator Network + Academy** supplies trusted creators and trained operators to the two engines. Academy is internal infrastructure during the current proof cycle, not an independent growth mandate.

The company objective is:

> Increase monthly contribution from retained creator relationships while reducing founder routing hours.

Both halves matter. Contribution without retention is transactional. Retention that still depends on Alex remembering, chasing, approving, or rescuing routine work is not an operating asset.

## 3. The operating loop

Every engine uses the same six-step loop:

```text
detect signal
    -> qualify against a funded use case
    -> commit only after capacity, economics, and risk gates
    -> deliver against explicit obligations
    -> reconcile cash, cost, evidence, and attribution
    -> retain, stop, or allocate the next unit of capacity
```

The system is designed around this loop, not around departments or software screens.

## 4. Non-negotiable invariants

1. **Canonical identity.** Every active brand, person, creator, opportunity, campaign, cohort member, and operator has one stable ID.
2. **One accountable seat.** Every active object has one accountable seat. Contributors and approvers may be many; accountability is singular.
3. **Visible clock.** Every nonterminal object has a next action, owner, and due time.
4. **Evidence before movement.** A stage changes only when its exit evidence is recorded.
5. **No unfunded commitments.** OVO does not promise creator work before payment terms, capacity, expected contribution, and required risk approval are recorded.
6. **Cash truth.** Contract value, billings, GMV, revenue, gross profit, and contribution are separate values. Only settled cash is “collected.”
7. **Company-held operating record.** OVO retains the shared record, attribution, agreements, and communication history created through its systems. Creators remain non-exclusive and retain their identity and independent relationships.
8. **Two-human continuity.** Every contracted, active creator has a primary Talent Manager and a named backup before activation.
9. **No silent founder fallback.** A miss remains with its accountable seat until it is explicitly reassigned, stopped, or escalated under a written rule.
10. **Human authority.** Automation may collect, summarize, route, remind, and flag. It may not independently approve pricing, legal terms, creator commitments, medical or regulated claims, payouts, or exceptions.
11. **Immediate suppression.** A do-not-contact, payment restriction, safety issue, or account restriction stops the affected action before external provider synchronization.
12. **Auditable override.** Any manual override records the actor, time, reason, prior state, new state, and approving authority.

## 5. Seat model

Seats are stable. People can change. All lifecycle, metric, and automation rules refer to seats first; the assignment register maps people to those seats.

| Seat | Current assignment | Primary outcome | Authority | Backup or escalation |
|---|---|---|---|---|
| CEO + InnerDM Product | Alex | Capital and product attention go to the highest-value proven constraint | Strategy, product roadmap, capital, nonstandard exceptions | No routine-work backup; operating seats must resolve routine work |
| Brand Account Executive | Kennedy | Qualified recurring-brand opportunities close with clean economics and handoff | Discovery, standard proposals, negotiation, close | Alex only for defined high-value or nonstandard exceptions |
| Account Director | Patricia | Closed brand accounts retain, renew, and expand without surprises | Client relationship, kickoff, renewal, standard expansion | CEO for material reputation or commercial exception |
| Campaign Operations | Jaci | Sold work is staffed, delivered, evidenced, and reconciled profitably | Capacity veto, campaign plan, milestones, quality, delivery close | Named Campaign Coordinator when assigned; CEO only for red incident |
| RevOps + Finance Control | Patricia, interim seat | The record, cash, payouts, and commissions reconcile | Data integrity, collection status, payout and commission eligibility | CEO approval for Patricia's own exception or any variance above the control limit |
| Talent Manager | Certified operators | A finite creator portfolio remains responsive, productive, and retained | Creator-side execution inside approved terms | Named backup Talent Manager or Creator Pod Lead |
| Creator Pod Lead | Vacant until a Senior Talent Manager passes the gate | Talent Managers perform and creator relationships survive transfers | Portfolio capacity, coaching, backup coverage, routine reassignment | Jaci during the interim period |
| Academy Program | Time-boxed operating project, no independent growth quota | Capacity-backed candidates become certified for one real seat | Admissions only against documented capacity; certification with operating owner | CEO stops intake when no profitable inventory exists |
| Compliance Approver | Named per regulated campaign | Risky work advances only with documented authority and substantiation | Approve, hold, or reject regulated claims and campaign structure | Qualified counsel for material or uncertain issues |

### Seat rules

- One person may temporarily wear two seats, but the seats keep separate outcomes and controls.
- A temporary assignment needs an owner, start date, split trigger, and review date.
- No one approves their own compensation, payout exception, or unreconciled financial adjustment.
- “Help Alex,” “grow OVO,” and “manage creators” are not seats. A seat has one outcome, bounded authority, and a scoreboard.

## 6. Canonical objects

The old draft mixed accounts, opportunities, campaigns, collection, and renewal inside one “brand pipeline.” That makes ownership and forecasting unreliable. The canonical model separates them.

| Object | What it represents | Accountable seat | Terminal evidence |
|---|---|---|---|
| Brand account | Durable company identity and relationship | Account Director once active; RevOps before activation | Active, dormant, or exited with reason |
| Person + employment | A durable person and time-bounded relationship to a brand | RevOps | Verified, stale, or superseded evidence |
| Signal | Time-bounded evidence of intent, spend, fit, or risk | Source owner; RevOps validates | Used, expired, rejected, or superseded |
| Brand opportunity | One commercial buying motion | Brand AE | Closed-won or closed-lost with reason |
| Campaign | One sold delivery obligation | Campaign Operations | Reconciled or cancelled with evidence |
| Creator relationship | OVO's non-exclusive operating relationship with one creator | Primary Talent Manager | Retained, paused, transferred, or exited |
| Campaign assignment | A creator's explicit obligation to one campaign | Talent Manager; Campaign Operations controls the plan | Accepted work completed, replaced, or cancelled |
| InnerDM cohort membership | One creator's product experiment and economics | CEO + InnerDM Product | Scale, maintain, pause, or churn decision at D60 |
| Operator record | Applicant-to-productive-seat journey | Academy Program until assignment; operating lead after | Retained, promoted, or exited |
| Financial event | Invoice, receipt, refund, payout, fee, commission, or adjustment | RevOps + Finance Control | Settled and reconciled |
| Task / exception | A required next action or a breached operating condition | Seat owning the parent object | Completed, reassigned, waived with evidence, or stopped |

### Pipeline boundaries

1. **Brand opportunity:** Target -> Engaged -> Qualified -> Solution validated -> Proposal -> Contracting -> Closed won/lost.
2. **Campaign:** Funding gate -> Planned -> Staffed -> Production -> Brand approval -> Live -> Reconciled.
3. **Creator relationship:** Candidate -> Claimed -> Engaged -> Qualified -> Contracted -> Activated -> Productive -> Retained/inactive.
4. **InnerDM cohort:** Nominated -> Qualified -> Commercial -> Launch ready -> Live -> D30 learning -> D60 decision.
5. **Operator capacity:** Applicant -> Screened -> Common core -> Live audition -> Certified -> Capacity assigned -> D30 productive -> D60 retained/exited.

Collection is a financial state, not a sales stage. Renewal or material expansion is a new opportunity linked to the active brand account and prior campaign.

## 7. Commitment gates

### Brand proposal gate

A proposal cannot be issued until the record contains:

- buyer problem, authority, budget range, timing, and decision process;
- exact scope, measurement, rights, exclusions, and assumptions;
- Jaci-approved delivery capacity with a 20% replacement buffer where creator volume creates risk;
- expected collected cash, direct costs, payout exposure, variable labor, commission, and contribution;
- payment structure and collection condition;
- compliance state and named approval path when required.

### Closed-won gate

“Closed won” requires an executed agreement plus the contract's activation payment condition. Verbal approval alone remains Contracting.

### Campaign-start gate

Production cannot start until:

- the brand activation condition is satisfied;
- the campaign record, owner, brief, milestones, and approval path exist;
- each creator has explicitly accepted that campaign's work and terms;
- backup capacity and escalation paths are recorded;
- any regulated claim, audience, jurisdiction, or disclosure approval is attached.

### Creator-activation gate

Activation requires executed terms, identity and payout readiness, a complete profile, primary and backup coverage, three-way onboarding, verified communication routing, and a dated next action.

### InnerDM launch gate

Launch requires executed creator terms, identity and payout readiness, pricing, content and promotion plan, support and moderation readiness, a successful canary purchase, refund handling, and sufficient operator capacity.

### Operator-intake gate

No cohort opens without named profitable inventory, a certification owner, supervised work, support capacity, and a written D30 productivity definition.

## 8. Commercial handoff contract

The Brand AE owns the opportunity through close. The Account Director owns the retained brand relationship. Campaign Operations owns delivery. A handoff is accepted only when the following packet is complete:

- executed scope and activation payment evidence;
- buyer, stakeholders, decision history, and communication preferences;
- desired outcome, deliverables, rights, exclusions, measurement, and approvals;
- price, direct-cost plan, expected contribution, and collection schedule;
- risk, open questions, promises already made, and nonstandard terms;
- kickoff date, renewal date, next action, and due time.

The Account Director accepts or rejects the handoff within one business day. Rejection keeps accountability with the Brand AE and names the missing evidence. Acceptance never transfers campaign delivery ownership away from Jaci.

## 9. Decision rights

| Decision | Decider | Required input | Escalation |
|---|---|---|---|
| Standard new-brand proposal | Brand AE | Capacity, economics, risk state | CEO for nonstandard term or threshold breach |
| Standard renewal or expansion | Account Director | Results, capacity, economics | CEO for material scope or threshold breach |
| Campaign capacity and staffing | Campaign Operations | Creator availability and backup plan | Capacity veto is final until facts change |
| Creator relationship qualification | Creator Pod Lead; Jaci interim | Funded use case, fit, risk, capacity | CEO only for reputation exception |
| InnerDM cohort admission and D60 decision | CEO + InnerDM Product | Readiness, cohort capacity, economics, labor | Pause if evidence is incomplete |
| Routine payout and commission eligibility | RevOps + Finance Control | Settled cash, delivery evidence, reconciled costs | Independent approval for own item or variance above $500 |
| Regulated campaign approval | Named Compliance Approver | Product, claim, audience, jurisdiction, disclosure evidence | Counsel for material uncertainty |
| Product roadmap | CEO + InnerDM Product | Cohort evidence and repeated user need | Custom one-creator work does not enter roadmap by default |

Silence is never approval. Outside-standard work stays in its current stage until the named decider records a decision.

## 10. Economics contract

Every product and campaign uses one waterfall:

```text
settled customer or fan cash
- refunds, disputes, taxes collected for remittance, and payment fees
- creator payout
- pass-through production and fulfillment costs
- direct operating labor and variable software
= product gross contribution before origination
- earned originator, recruiter, and manager incentives
= OVO contribution
```

Brand Partnerships and InnerDM keep separate product P&Ls. Shared costs use a documented allocation rule. InnerDM reports strict subscription MRR, subscription GMV, usage/unlock GMV, total GMV, platform revenue, direct costs, and contribution separately.

## 11. Metric truth contract

A scorecard value is valid only when it has:

- a fixed definition and unit;
- one accountable seat;
- a named source and source link or query;
- an as-of timestamp;
- a freshness limit;
- green, yellow, and red thresholds;
- a written action when red.

Missing or stale data displays **unknown** or **stale**, never green. Historical proof is labeled historical and never presented as a current operating metric. Targets, limits, and current values are separate fields.

The full registry lives in `scorecard-spec.md`.

## 12. Exception system

The normal path should be quiet. The command center exists to show exceptions:

- overdue next action;
- SLA breach;
- missing evidence or owner;
- capacity shortfall;
- margin below floor;
- payment overdue or payout mismatch;
- regulated work without approval;
- creator relationship risk;
- provider synchronization or attribution failure;
- metric stale past its freshness limit;
- founder interruption caused by a missing rule or owner.

Every exception has severity, parent object, accountable seat, resolver, opened time, due time, evidence, and terminal resolution. Alex sees only red exceptions, irreversible decisions, capital allocation, key closes, and product decisions.

## 13. Operating cadence

### Continuous

Owners work from due actions and exception queues. Red safety, payment, account-restriction, and reputation incidents stop immediately and route to the named resolver.

### Monday, 40 minutes

- collected and expected cash;
- campaign capacity and next seven days of obligations;
- brand opportunities likely to change state;
- InnerDM launches and cohort decisions;
- no more than three measurable commitments per owner.

### Wednesday, 20 minutes only when needed

Meet only if a red metric, cross-seat handoff, or capacity conflict cannot be resolved asynchronously. Resolve, reassign, stop, or escalate. Do not create a recurring status meeting out of habit.

### Friday, 60 minutes

- freshness check, then scorecard;
- forecast accuracy and contribution changes;
- one piece of brand, creator, and payer behavior;
- decisions with decider and deadline;
- missed commitments classified as capacity, capability, clarity, or accountability;
- start at most one experiment and explicitly stop low-value work.

### Monthly, 90 minutes

Allocate capital and founder time using contribution, retention, labor leverage, concentration, and evidence of compounding value. Do not change strategy because of one emotional week.

## 14. Current proof-cycle gates

### Brand Partnerships

- Deliver Fitia or its current anchor account at the contracted quality and margin without Alex in routine fulfillment.
- Collect one additional recurring brand account using the standard offer and handoff.
- Keep any one brand below 50% of trailing-three-month OVO Talent contribution, then work toward 30%.
- Freeze new selling if on-time approved delivery stays below 90% or contribution stays below the floor for two review periods.

### InnerDM

- Launch five qualified creators under one playbook and executed terms.
- Scale only if at least three of the first five are retained and contribution-positive at D60.
- Keep ongoing direct labor below four hours per retained creator per month; above eight is red.
- Pause acquisition if payments, refunds, moderation, support, or attribution cannot reconcile.

### Creator Network + Academy

- Open operator capacity only against funded work.
- Require at least 60% of active operators to become contribution-positive inside 30 days.
- Academy remains internal until at least three graduates produce collected contribution for two consecutive months.
- External tuition growth, sponsored-seat expansion, or a separate Academy quota requires a new CEO decision and a reconciled compensation plan.

### Founder dependency

- Alex spends fewer than five hours per week on routine routing for two consecutive weeks.
- Every repeated Alex interruption becomes a rule, assignment, checklist, automation, or stopped activity.
- No new business line during the proof cycle.

## 15. Access, privacy, and audit

- Use least-privilege access by seat and remove access immediately on exit or transfer.
- Agreements, identity documents, payouts, private communications, and raw provider payloads require restricted access and documented retention.
- Communications may be summarized by approved automation only with reviewed disclosure and data handling.
- Export, merge, reassignment, suppression, payout, commission, stage override, and access changes create audit events.
- Provider events are idempotent and reconciled; external synchronization failure stays visible until repaired.

## 16. Installation is complete when

- all current seat assignments and backups are confirmed in the register;
- every active object is in the canonical system with owner, state, next action, due time, economics, and evidence;
- the five pipelines use the definitions in this contract;
- current scorecard values have sources and as-of timestamps;
- ten test records pass every relevant handoff without Alex routing them;
- at least 90% of routine decisions are made by the named seat;
- founder routine-operations time is below five hours for two consecutive weeks;
- the dashboard, docs, and CRM use the same stage and metric names.

## 17. Decisions log

| Effective date | Decision | Reason |
|---|---|---|
| 2026-08-21 | Establish `SYSTEM.md` as the canonical operating contract | The prior draft contained conflicting role, pipeline, and metric definitions |
| 2026-08-21 | Separate brand accounts, opportunities, campaigns, financial events, and renewals | One mixed “brand pipeline” obscured ownership, forecast, and delivery state |
| 2026-08-21 | Treat Academy as internal capacity during the proof cycle | External seat growth conflicts with the company focus and capacity gate |
| 2026-08-21 | Require source, as-of time, and freshness for every current metric | The prototype displayed old baselines as if they were live operating truth |
