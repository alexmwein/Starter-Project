# Scorecard and Weekly Review Specification

Status: canonical detail under [SYSTEM.md](./SYSTEM.md)

Version: 1.0

Effective: 2026-08-21

## Metric truth rules

Every metric requires:

- stable metric ID;
- fixed definition, unit, numerator, and denominator;
- one accountable seat;
- named source and query/report link;
- as-of timestamp and freshness limit;
- comparison period when a trend is shown;
- explicit Green, Yellow, Red, Unknown, and Stale behavior;
- one mandatory action when Red.

`Unknown` means no valid current value exists. `Stale` means a previously valid value exceeded its freshness limit. Neither is Green. Historical proof is labeled historical and stays outside the current scorecard.

## Threshold semantics

- **Minimum:** higher is better. Green at or above target; Yellow between warning and target; Red below warning.
- **Maximum:** lower is better. Green at or below target; Yellow above target through warning; Red above warning.
- **Range:** both too little and too much can be bad. Use explicit lower and upper bounds.
- **Boolean gate:** pass only when current evidence satisfies the definition.
- **Report-only:** no invented color until a baseline and decision threshold are approved.

The browser prototype must not infer Yellow as “60% of target” for every metric. Thresholds are part of the metric definition.

## Executive scorecard

| ID | Metric | Definition | Owner | Source | Freshness | Thresholds | Red action |
|---|---|---|---|---|---|---|---|
| `exec_contribution` | Monthly OVO contribution | Settled cash less refunds, fees, creator payout, direct cost, direct labor, and earned variable incentives | CEO | Reconciled finance ledger | 7 days | Report-only until three reconciled months | Reconcile before any capital-allocation decision |
| `exec_forecast_30d` | Forecasted 30-day contribution | Sum of open opportunity expected contribution x observed/provisional stage probability, plus contracted uncollected contribution shown separately | Brand AE | CRM opportunity report | 7 days | Report-only during calibration | Audit stage evidence and next actions |
| `exec_founder_ops_hours` | Founder routine-ops hours/week | Alex time spent routing, chasing, routine fulfillment, reconciliation, or standard approvals | CEO | Calendar + time log | 7 days | Green <=5; Yellow >5 to 10; Red >10 | Convert the top repeated interruption into a rule, owner, automation, or stop |
| `exec_concentration` | Largest-customer contribution share | Largest brand contribution / total brand contribution, trailing 3 months | Account Director | Finance ledger | 31 days | Green <50%; Yellow 50-70%; Red >70% | Open concentration-reduction plan and freeze dependency-increasing commitments |
| `exec_cash_runway` | Cash runway | Unrestricted cash / trailing normalized monthly cash burn | RevOps + Finance | Bank + finance ledger | 7 days | Green >=6 months; Yellow 3-6; Red <3 | CEO cash-preservation review within 1 business day |
| `exec_data_freshness` | Scorecard current | Required weekly metrics valid inside freshness limit / required weekly metrics | RevOps | Metric registry | 7 days | Green 100%; Yellow 90-99%; Red <90% | Review data failures before discussing performance |

## Brand acquisition

| ID | Metric | Definition | Owner | Source | Freshness | Thresholds | Red action |
|---|---|---|---|---|---|---|---|
| `brand_recurring_accounts` | Active recurring brands | Active brand accounts with settled cash and a live or renewing recurring commitment | Account Director | CRM + finance | 7 days | Green >=2; Yellow 1; Red 0 | CEO and Brand AE run a focused recurring-offer review |
| `brand_qualified_pipeline` | Qualified pipeline contribution | Expected monthly contribution from Qualified-or-later open opportunities | Brand AE | CRM | 7 days | Report-only until baseline | Audit account quality before adding volume |
| `brand_held_meetings` | Held qualified meetings | Held meetings that satisfy the qualification definition | Brand AE | CRM + calendar evidence | 7 days | Target set per active source cohort | Review signal, buyer, and script by cohort |
| `brand_win_rate` | Qualified win rate | Closed-won / all resolved Qualified-or-later opportunities | Brand AE | CRM | 31 days | Report-only until >=30 resolved opportunities | Inspect losses by reason; do not change weights to hide performance |
| `brand_cycle_time` | Qualified-to-close days | Median days from Qualified entry to Closed won/lost | Brand AE | CRM event history | 31 days | Baseline first | Remove stalled stages or weak qualification |
| `brand_inbound_sla` | Qualified inbound SLA | Qualified inbound acknowledged inside 2 supported business hours / qualified inbound | Brand AE | Communications + SLA log | 7 days | Green >=95%; Yellow 90-94.9%; Red <90% | Activate backup coverage and review missed alerts |

## Brand delivery and retention

| ID | Metric | Definition | Owner | Source | Freshness | Thresholds | Red action |
|---|---|---|---|---|---|---|---|
| `delivery_on_time` | On-time approved delivery | Deliverables approved by contractual due time / due deliverables | Campaign Operations | Campaign milestones | 7 days | Green >=95%; Yellow 90-94.9%; Red <90% | Freeze new capacity promises and run campaign recovery |
| `delivery_buffer` | Staffing coverage | Confirmed creator capacity / required creator capacity | Campaign Operations | Campaign assignments | 1 day | Green >=120%; Yellow 100-119.9%; Red <100% | Activate replacement sourcing before production risk |
| `brand_margin` | Brand contribution margin | Brand contribution / settled brand cash | Account Director | Reconciled finance ledger | 7 days | Green >=25%; Yellow 20-24.9%; Red <20% | Stop discount/custom scope and reprice or exit |
| `brand_collection_lag` | Collection lag | Median days from contractual due date to settled receipt | RevOps + Finance | Invoice + bank ledger | 7 days | Green <=0; Yellow 1-7; Red >7 | Escalate overdue accounts and block unfunded expansion |
| `brand_surprises` | Brand-side surprises | Material misses first learned by the brand before OVO's Account Director | Account Director | Incident log | 7 days | Green 0; Yellow 1; Red >=2 in 30 days | CEO incident review and ownership correction |
| `brand_renewal_forecast` | Renewal coverage | Recurring accounts ending in 60 days with a dated renewal plan / eligible accounts | Account Director | CRM | 7 days | Green 100%; Yellow 80-99%; Red <80% | Open missing renewal opportunities immediately |

## Creator network

| ID | Metric | Definition | Owner | Source | Freshness | Thresholds | Red action |
|---|---|---|---|---|---|---|---|
| `creator_dual_coverage` | Active creator continuity | Contracted active creators with primary, backup, shared history, and current next action / contracted active creators | Creator Pod Lead; Jaci interim | Creator CRM | 7 days | Green 100%; Yellow 95-99.9%; Red <95% | Block new activation and repair coverage |
| `creator_response_sla` | Engaged creator response SLA | Engaged creator replies answered inside 2 supported business hours / engaged replies | Creator Pod Lead; Jaci interim | Communications + SLA log | 7 days | Green >=95%; Yellow 90-94.9%; Red <90% | Rebalance portfolio and activate backups |
| `creator_obligation_on_time` | Creator obligations on time | Creator assignments completed on time / due assignments | Talent Manager seat | Campaign assignments | 7 days | Green >=95%; Yellow 90-94.9%; Red <90% | Reduce portfolio and activate campaign replacement path |
| `creator_d60_retention` | D60 relationship retention | Creators still active and healthy at D60 / eligible activated creators | Creator Pod Lead; Jaci interim | Creator lifecycle | 31 days | Green >=90%; Yellow 80-89.9%; Red <80% | Inspect fit, trust, payout, and manager quality |
| `creator_contribution` | Contribution per retained creator | Attributable OVO contribution / retained active creators | RevOps + Finance | Finance + attribution | 31 days | Report-only until baseline | Stop recruiting ahead of profitable use cases |
| `creator_overdue_claims` | Overdue prospect claims | Active claims past next action plus grace period | Creator Pod Lead; Jaci interim | Claim ledger | 1 day | Green 0; Yellow 1-5; Red >5 | Recycle claims and reduce owner capacity |

## InnerDM

| ID | Metric | Definition | Owner | Source | Freshness | Thresholds | Red action |
|---|---|---|---|---|---|---|---|
| `idm_live_creators` | Creators live under executed terms | Live non-test creators with executed terms and passing readiness evidence | CEO + Product | Cohort ledger | 7 days | Current gate: Green >=5; Yellow 3-4; Red <3 at gate date | Fix launch readiness before adding nominations |
| `idm_d60_proven` | D60 proven creators | D60 retained and contribution-positive creators from first five | CEO + Product | Cohort + finance | 7 days | Green >=3; Yellow 2; Red <2 at gate date | Pause acquisition and fix/contain the product |
| `idm_strict_mrr` | Strict subscription MRR | Current non-test recurring subscription commitments, excluding unlocks | CEO + Product | Subscription ledger | 1 day | Report-only until baseline | Reconcile subscription state before product decision |
| `idm_total_gmv` | Total monthly GMV | Non-refunded subscription and usage/unlock fan payments | CEO + Product | Payment ledger | 1 day | Initial gate >=$5,000 | Inspect creator promotion, conversion, and pricing |
| `idm_platform_revenue` | Platform revenue | OVO contractual share after defined deductions | RevOps + Finance | Payment + contract ledger | 7 days | Report-only | Reconcile contract and payment allocations |
| `idm_contribution` | InnerDM contribution | Platform revenue less direct labor, software, support, moderation, fraud loss, and earned incentives | CEO + Product | Product P&L | 7 days | Green >$0; Yellow $0; Red <$0 at D60 gate | Pause cohort expansion and fix unit economics |
| `idm_payer_d60` | D60 payer retention | First-30-day payers paying again in days 31-60 / eligible first-30-day payers | CEO + Product | Payment cohort ledger | 7 days | Baseline first | Diagnose offer, creator promotion, and payer value |
| `idm_labor` | Hours per retained creator/month | Direct recurring operator hours / retained live creators | Campaign Operations | Time log | 7 days | Green <=4h; Yellow >4-8h; Red >8h | Productize, narrow service, or stop scaling |
| `idm_chargebacks` | Chargeback rate | Chargeback amount / settled fan cash | RevOps + Finance | Payment ledger | 1 day | Green <1%; Yellow 1-1.99%; Red >=2% | Pause risky traffic and review payments/fraud immediately |

## Operator capacity

| ID | Metric | Definition | Owner | Source | Freshness | Thresholds | Red action |
|---|---|---|---|---|---|---|---|
| `ops_capacity_backed` | Active capacity-backed operators | Certified operators with named profitable inventory and supervised owner | Academy Program | Operator + assignment ledger | 7 days | Range 1-5 during initial proof; 0 Unknown until capacity plan; >5 Red | Stop intake or add documented profitable capacity |
| `ops_productive_rate` | D30 productive rate | Operators producing collected contribution or defined service output inside 30 days / eligible active operators | Operating lead | Operator + finance ledger | 7 days | Green >=60%; Yellow 40-59.9%; Red <40% | Stop intake and fix certification/assignment |
| `ops_time_to_productive` | Days to first productive output | Median days from capacity assignment to first qualifying output | Operating lead | Operator event history | 31 days | Target <=30 days | Reduce training scope or improve assignment quality |
| `ops_d60_retention` | D60 productive retention | Productive operators still productive at D60 / eligible productive operators | Operating lead | Operator lifecycle | 31 days | Green >=60%; Yellow 40-59.9%; Red <40% | Audit role fit, manager quality, economics, and workload |
| `ops_contribution_per` | Contribution per active operator | Attributable contribution / active capacity-backed operators | RevOps + Finance | Finance + attribution | 31 days | Green >$0 by D30; Red <=$0 after D30 | Recycle inventory and remove or redesign the seat |

## Weekly review protocol

### 0. Freshness first

Do not discuss performance until required values are valid. Assign any Unknown/Stale metric to its data owner with a same-day repair action.

### 1. Numbers

- What is Red?
- Is the number reconciled?
- What changed versus the comparison period?
- Is the change signal, noise, or a definition problem?

### 2. Commitments

- Which commitments completed with evidence?
- Which missed?
- Was the miss capacity, capability, clarity, or accountability?

### 3. Customer behavior

- What did one brand actually do?
- What did one creator actually do?
- What did one paying fan actually do?
- Which belief changed because of behavior rather than opinion?

### 4. Decisions

Record decision, decider, effective date, deadline, reversible/irreversible class, and evidence. If no decision is needed, keep it out of Alex's queue.

### 5. Start, stop, continue

- Start at most one experiment.
- Stop at least one low-value activity when capacity is constrained.
- Continue only work tied to a current gate or scoreboard metric.

## Commitment format

> **Seat / person** will move **metric or record** from **current evidence-backed state** to **target state** by **date**, evidenced by **link or artifact**.

Bad: “Work on brands.”

Good: “Brand AE / Kennedy will move two named opportunities from Qualified to Proposal by Friday, each with capacity approval, a contribution waterfall, and a linked proposal.”

Bad: “Recruit more creators.”

Good: “Talent Manager / owner will deliver ten funded-use-case creator profiles by Thursday 17:00, each with duplicate check, source evidence, risk state, and next action in the Creator pipeline.”
