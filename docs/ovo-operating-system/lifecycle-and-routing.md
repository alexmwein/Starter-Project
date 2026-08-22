# Lifecycle and Routing Rules

Status: canonical detail under [SYSTEM.md](./SYSTEM.md)

Version: 1.0

Effective: 2026-08-21

A record advances only when its exit evidence is stored. A feeling, verbal update, or calendar event is not a stage transition.

## Universal active-record contract

Every nonterminal record requires:

- stable record ID and object type;
- current state and state-entered timestamp;
- accountable seat and assigned person;
- backup or escalation route;
- next action and due time;
- last meaningful activity time;
- source and attribution;
- required economics for the object's current state;
- evidence links;
- risk, suppression, or legal hold state;
- terminal reason when closed, paused, rejected, or lost.

An active record missing owner, next action, due time, or required evidence enters the exception queue immediately.

## 1. Brand account state

The brand account is the durable company relationship. It does not move through the sales pipeline.

| State | Meaning | Accountable seat | Exit evidence |
|---|---|---|---|
| Prospect | Known company with no closed work | RevOps | First closed-won opportunity or explicit disqualification |
| Active | Executed relationship with live delivery, collection, renewal, or expansion work | Account Director | All work complete and no active renewal motion |
| Dormant | Prior relationship with no active commercial motion | Account Director | New opportunity opens or account exits |
| Exited | OVO will not pursue or service the account | Account Director | Terminal reason, obligations closed, access and data handling complete |

## 2. Brand opportunity pipeline

Owner: Brand Account Executive through Closed won/lost. The Account Director accepts the account handoff after Closed won.

| Stage | Entry | Required evidence | Exit | SLA |
|---|---|---|---|---|
| Target | Verified brand and plausible buyer exist | ICP reason, current signal, contact path, owner, next action | Personalized first touch logged | 1 business day after assignment |
| Engaged | A first touch is logged | Channel, message or call evidence, cadence, suppression recheck | Meaningful reply or sequence terminal state | Next action within 2 business days |
| Qualified | Buyer confirms a real problem | Outcome, authority, budget range, timing, decision process, current stack | Discovery complete and offer fit accepted | Accept/reject within 1 business day |
| Solution validated | OVO can solve the problem profitably | Scope, measurement, rights, assumptions, Jaci capacity approval, risk state, economics | Buyer requests or accepts a proposal | Capacity answer within 1 business day |
| Proposal | Written commercial offer delivered | Price, payment condition, costs, contribution, terms, expiry, approvals | Verbal commercial approval, explicit loss, or rework | Follow up within 2 business days |
| Contracting | Buyer gives commercial approval | Legal entity, signatory, redlines, payment schedule, unresolved terms | Executed agreement plus activation payment condition | Escalate after 5 business days stale |
| Closed won | Agreement and activation payment condition satisfied | Complete commercial handoff packet | Account Director accepts handoff and campaign enters Funding gate | Handoff accepted/rejected within 1 business day |
| Closed lost | Opportunity will not proceed | Loss reason, competitor when known, re-entry condition, next eligible date | Terminal | Record within 1 business day |

Required loss reasons: no budget, no urgency, wrong offer, capacity, pricing, trust, legal/compliance, competitor, procurement, no response, timing, fulfillment history, or other with note.

### Renewal and expansion

Renewal and material expansion create a new opportunity linked to the active account, prior opportunity, and campaign results. They do not reopen or mutate the historical opportunity.

## 3. Campaign pipeline

Accountable delivery seat: Campaign Operations. The Account Director owns brand communication; Talent Managers own creator-side execution.

| Stage | Entry | Required evidence | Exit | SLA |
|---|---|---|---|---|
| Funding gate | Closed-won opportunity exists | Agreement, activation payment condition, scope, collection schedule, account handoff | Gate passed or campaign held | Same business day |
| Planned | Gate passed | Brief, success measure, milestones, rights, approvals, budget, margin plan, risks | Staffing request published | 1 business day |
| Staffed | Creator requirements exist | Named creators, fit rationale, primary TM, backup capacity, rates | All required creator decisions received | 1 business day per request |
| Production | Explicit creator assignments accepted | Deliverables, terms, dates, owner, proof route | Assets submitted for brand approval | Risk raised at least 72 hours before miss |
| Brand approval | Assets submitted | Submission evidence, feedback owner, revision clock, compliance evidence | Written approval or authorized rejection | Per contract; timer recorded |
| Live | Approved content or deliverable published | URL/file, timestamp, required disclosure, QA proof | Reporting inputs complete | Same day proof capture |
| Reconciled | Delivery complete | Brand acceptance, report, settled cash, creator payouts, direct costs, commission, contribution | Renewal opportunity, dormant account, or terminal close | Within 5 business days of final settlement |
| Cancelled | Campaign stops before reconciliation | Authority, reason, financial treatment, creator communication, remaining obligations | Terminal | Immediate record update |

## 4. Creator relationship pipeline

Accountable seat: primary Talent Manager after claim. Jaci owns qualification and activation during the interim Pod Lead period.

| Stage | Entry | Required evidence | Exit | SLA |
|---|---|---|---|---|
| Candidate | Creator identity and source recorded | Normalized handles, audience, niche, geography, funded-use-case hypothesis | Duplicate and initial fit checks pass | 2 business days |
| Claimable | Fit and duplicate checks pass | No active claim, suppression clear, capacity available | Logged manual first touch creates lease | Until claimed or signal expires |
| Claimed | Provider send evidence exists | Owner, lease expiry, cadence, next action | Reply, terminal cadence, or lease expiry | D0/D2/D5/D10 default |
| Engaged | Creator replies | Response, needs, next action, two-hour clock | Qualification accepted/rejected | Human response within 2 supported business hours |
| Qualified | A funded use case and relationship fit exist | Fit, rates, availability, risk, responsiveness, use case | Defined offer accepted or rejected | 1 business day |
| Contracted | Executed non-exclusive terms exist | Agreement, rights, exclusions, payout terms | Activation checklist complete | 2 business days |
| Activated | Identity, payout, profile, alias, primary and backup, onboarding, and next action complete | Checklist and three-way onboarding evidence | First approved campaign work or InnerDM launch | Same day as assignment |
| Productive | Creator generates approved, attributable activity | Revenue, cost, payout, delivery, attribution | D60 relationship review | Monthly review |
| Retained | D60 relationship remains healthy and contribution-positive | Relationship health, availability, economics, next use case | Continue, transfer, pause, or exit | Quarterly portfolio review |
| Inactive | No current funded use case or relationship exits | Reason, future eligibility, obligations and access closed | New funded use case or terminal exit | Review date required |

A signed creator is not activated. An activated creator is not productive. Report the stages separately.

## 5. Campaign assignment state

A creator relationship does not create a campaign obligation. Every campaign assignment has its own state.

| State | Rule |
|---|---|
| Requested | Exact work, rate, rights, dates, approval path, and payment condition sent |
| Accepted | Creator explicitly accepts the exact assignment |
| In progress | Required production work has started |
| Submitted | Evidence is delivered for review |
| Approved | Brand or authorized approver accepts the work |
| Completed | Publication/delivery proof and creator-side obligations are complete |
| Replaced | Capacity owner activates backup and records reason |
| Cancelled | Authorized cancellation and financial treatment are recorded |

Silence is not acceptance. A general OVO agreement is not campaign acceptance.

## 6. InnerDM cohort pipeline

Accountable seat: CEO + InnerDM Product. Jaci owns launch readiness and operating labor.

| Stage | Entry | Required evidence | Exit |
|---|---|---|---|
| Nominated | Creator relationship and audience hypothesis exist | Audience demand, ignored-DM evidence, promotion hypothesis | Qualification complete |
| Qualified | Fit, willingness, content, reputation, and cohort capacity pass | Qualification sheet and cohort slot | Commercial terms presented |
| Commercial | Terms presented | Economics, responsibilities, executed agreement | Readiness work begins |
| Launch ready | Identity, payout, content, promotion, pricing, support, moderation, and access pass | Successful canary purchase and refund path | Product goes live |
| Live | Fans can pay and creator is promoting | Payment, entitlement, support, promotion, incident telemetry | D30 review matures |
| D30 learning | First 30 days measured | MRR, GMV, platform revenue, contribution, payer behavior, promotion, labor, incidents | D60 review matures |
| D60 decision | D60 evidence complete | Retention, contribution, refunds/chargebacks, labor, creator intent | Scale, maintain, pause, or churn decision |

## 7. Operator-capacity pipeline

Accountable seat: Academy Program through certification; operating lead after capacity assignment.

| Stage | Entry | Exit evidence |
|---|---|---|
| Applicant | Contact, source, work eligibility or contractor path, and fit evidence recorded | Screen passes |
| Screened | Capacity-backed cohort exists | Accepted into common core |
| Common core | Systems, data, communication, compliance, and economics training begins | Required exercises pass |
| Live audition | Supervised real or simulated work begins | One-track rubric passes |
| Certified | Candidate can safely execute one defined lane | Agreement, access, and named capacity assignment |
| Capacity assigned | Profitable accounts, creators, or campaign work assigned | First attributable collected contribution or service output |
| D30 productive | Seat meets contribution and SLA definition within 30 days | D60 retention review |
| D60 retained | Two productive months and quality gates pass | Continue, promote, transfer, or exit |
| Exited | Seat does not continue | Inventory transferred, access removed, obligations and compensation reconciled |

## 8. Routing order

Apply the most specific rule first:

1. Existing active brand account goes to its Account Director.
2. Active opportunity goes to its Brand AE.
3. Creator-alias inbound preserves creator and Talent Manager attribution, opens or links the brand account, and routes the commercial opportunity to the Brand AE.
4. Renewal or material expansion goes to the Account Director as originator and a new opportunity; the Brand AE joins when closing work is required.
5. Creator prospect goes to the operator who created the verified first touch, subject to claim capacity and duplicate controls.
6. Jaci controls creator qualification and activation until a Creator Pod Lead is installed.
7. InnerDM-qualified creators enter only an available cohort slot; Alex decides admission, not routine setup.
8. Operator applicants enter only an open, capacity-backed cohort.
9. Unowned brand and financial records route to RevOps, creator records to Jaci, and operator records to Academy Program.

## 9. Service levels and escalation

“Supported business hours” must be configured by timezone and coverage schedule. A clock without a calendar is not an SLA.

| Event | Primary | Backup trigger | Red escalation |
|---|---|---|---|
| Qualified commercial inbound | Human acknowledgment within 2 supported business hours | Backup notified at 90 minutes | Brand AE leader after primary and backup miss |
| Opportunity qualification | Accept/reject within 1 business day | RevOps exception at due time | CEO only for defined strategic exception |
| Creator engaged reply | Human response within 2 supported business hours | Named backup at 90 minutes | Pod Lead/Jaci after miss |
| Campaign request | Accept/decline within 1 business day | Backup TM at due time | Jaci activates replacement capacity |
| Fulfillment risk | Raise at least 72 hours before expected miss | Jaci immediately | Account Director and CEO for material brand risk |
| Overdue customer cash | Exception opens on day 1 | Finance backup | CEO at configured materiality threshold |
| Safety, payment restriction, account restriction, or reputation incident | Stop immediately | Named incident resolver | CEO and counsel/compliance as applicable |

Missing an SLA does not silently transfer the work to Alex. The accountable seat remains responsible until an explicit reassignment, stop, or escalation is recorded.

## 10. Handoff packet

The Brand AE -> Account Director handoff requires:

- executed agreement and activation payment evidence;
- brand and stakeholder identities;
- desired outcome, scope, measurement, rights, exclusions, and approval path;
- promises, open questions, risks, and nonstandard terms;
- price, cost plan, contribution, collection schedule, and commission attribution;
- Jaci-approved capacity plan;
- kickoff, renewal date, next action, and due time.

Patricia accepts or rejects the packet within one business day. Rejection names the missing evidence and leaves the opportunity with the Brand AE. Acceptance activates the Account Director relationship; it does not make Patricia the campaign operator.
