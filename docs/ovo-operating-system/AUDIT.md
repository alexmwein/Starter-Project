# OVO Operating System Audit

Audit date: 2026-08-21

Scope: operating documents, command-center prototype, system-flow map, metrics, roles, lifecycle, compensation, and implementation plan

Result: redesigned with one canonical contract; one compensation decision remains intentionally quarantined

## Executive finding

The draft had strong local ideas: contribution over vanity revenue, explicit stop rules, two-human creator coverage, capacity before selling, evidence before automation, and founder-hour tracking.

The failure was structural. Different files described different companies. A reader could not tell whether Kennedy ran Academy or closed brands, whether Patricia sold or only retained accounts, whether there were four or five pipelines, or whether a July value on the dashboard was current. That ambiguity would recreate the exact founder-routing problem the system is meant to remove.

The redesign makes `SYSTEM.md` authoritative, separates stable seats from people, gives commercial objects independent state machines, and makes missing or stale data fail closed.

## Findings and resolutions

| Severity | Finding | Evidence | Resolution |
|---|---|---|---|
| P0 | Role authority contradicted itself | `README.md` assigned brand pipeline and proposals to Patricia; `organization-and-claim-system.md` and `index.html` assigned close to Kennedy and post-close ownership to Patricia; the Kennedy term sheet described an Academy role | Created a seat register in `SYSTEM.md`. Kennedy is Brand AE, Patricia is Account Director plus interim RevOps/Finance, and Academy has no independent growth quota during the proof cycle. Personal compensation remains noncanonical until reconciled. |
| P0 | The dashboard could present stale values as current truth | `index.html` hardcoded July cash, Fitia profit, InnerDM MRR, and Academy sales while only a note warned that they needed reconciliation | Replaced live-looking headline claims with gates and historical-proof labels. Scorecard values now require source and as-of fields; missing or expired evidence renders Unknown or Stale. |
| P0 | One brand pipeline mixed sales, fulfillment, collection, and retention | `lifecycle-and-routing.md` moved a brand from Target through Fulfillment, Collection, and Renewal; `index.html` used a different sequence | Split durable brand account, opportunity, campaign, financial event, and renewal objects. Renewal is a linked new opportunity, not the final sales stage. |
| P1 | Pipeline count and names disagreed | `pipeline-and-automation.md` required four pipelines; the command center showed five and added Campaigns | Standardized five operating pipelines: brand opportunities, campaigns, creator relationships, InnerDM cohorts, and operator capacity. |
| P1 | Metric health logic could mark failure green | The prototype treated every “max” metric as good below a ceiling; zero active operators therefore appeared healthy even when capacity was needed | Added explicit metric modes and per-metric green/yellow/red semantics. Capacity is a range, not a generic maximum. |
| P1 | Current values lacked provenance and freshness | Scorecard inputs stored only value and note in browser local storage | Added source, as-of time, freshness limit, Unknown, and Stale states. The browser remains a planning prototype, not the source ledger. |
| P1 | Academy strategy and Academy compensation pulled in opposite directions | The company strategy called Academy internal infrastructure with a five-person capacity gate; the proposed term sheet modeled 170 paid seats plus 15 sponsored operators annually | Marked the term sheet proposed and noncanonical. No Academy quota or external growth plan becomes active until the CEO approves the business decision and counsel/payroll review a role-aligned plan. |
| P1 | “OVO owns every relationship” was too broad | `organization-and-claim-system.md` used ownership language despite non-exclusive creator relationships | Narrowed the invariant to company-held operating records, attribution, agreements, and system-created commercial opportunities. Creators retain their identity and independent relationships. |
| P1 | Accountability could silently fall back to Alex | Several SLA paths named Alex as the final recipient without a complete resolver contract | Added a no-silent-founder-fallback invariant. Alex receives only defined red exceptions, irreversible decisions, capital allocation, key closes, and product decisions. |
| P1 | Handoffs did not have one acceptance contract | Sales, account, and campaign documents each implied different transfer moments | Defined a single closed-won gate and a one-business-day Brand AE -> Account Director acceptance packet. Campaign Operations owns delivery throughout. |
| P1 | No document authority or change-control rule existed | Overlapping files could silently redefine stages, owners, metrics, and targets | Added a hierarchy, version, effective date, system owner, steward, decisions log, and prospective change rule. |
| P2 | Founder allocation disagreed across artifacts | The earlier strategy allocated 50% to InnerDM and 25% to brands; the latest command center showed 30% InnerDM and 45% brands | Reframed allocation as gate-driven. The current pre-proof posture favors brand demand; passing the InnerDM D60 gate earns a higher product allocation. |
| P2 | The cold-call plan was still prominent after being superseded | `README.md` linked the superseded v2 document as a detailed current spec | Moved it to historical reference and kept its still-valid identity, suppression, provider-event, and demand-proof lessons. |
| P2 | Meetings risked becoming status theater | The draft mandated Monday, Wednesday, and Friday meetings regardless of exception state | Wednesday is now conditional on a red metric, unresolved cross-seat handoff, or capacity conflict. Normal work runs from queues and SLAs. |

## Final QA closure

The continuation review found and closed four implementation-level drift risks before delivery:

| Risk | Closure |
|---|---|
| Dashboard metric IDs, labels, owners, sources, and freshness limits had diverged from `scorecard-spec.md` | Replaced all 38 UI definitions with the canonical contract, preserved every prior browser ID as a migration alias, and made the validator compare the rendered registry to the Markdown specification exactly. |
| Several exclusive threshold boundaries were evaluated inclusively | Added explicit boundary semantics and regression checks for concentration, InnerDM contribution, chargebacks, capacity-backed operators, time to productivity, GMV, and contribution per operator. |
| The flow map invented a `$4K` contribution floor and used the unregistered seat name “Closing AE” | Replaced the amount with the approved contribution-floor rule and standardized the accountable seat as Brand AE. The validator rejects either stale claim. |
| Mobile navigation, map details, and scorecard evidence were not fully usable from keyboard or phone layouts | Added inert/ARIA state, focus restoration, Escape behavior, 44px controls, reduced-motion handling, real fit-to-width, and serialized mobile metric cards. |

## What was deliberately preserved

- Contribution margin and settled cash remain the core financial truth.
- Fitia or the current anchor account remains the proof that Brand Partnerships can fund the company.
- InnerDM remains the highest-upside asset, but it earns scale through D60 retention, contribution, and labor gates.
- Creator activation still requires primary and backup coverage.
- Prospect ownership remains a lease earned by completed work, never a permanent claim.
- Capacity and compliance remain vetoes before a proposal or campaign commitment.
- Automation remains an observer and coordinator, not a commercial or legal authority.
- The first-party brand-intent and signal-led outbound thesis remains intact.

## Residual concern

`kennedy-compensation-plan.md` is a proposed employment artifact with legal and payroll consequences. This audit did not rewrite its economics or declare it active. It is explicitly outside operating authority until the current Brand AE assignment, Academy scope, quota math, classification, work location, and counsel/payroll review are reconciled in a signed plan.

That concern does not block the operating model. It blocks using the old term sheet to calculate or promise pay.

## Verification standard

The design is ready to operate when:

1. All active records are migrated into the five canonical pipelines.
2. Ten records complete each relevant handoff with the required evidence.
3. Every current scorecard value has a source and as-of timestamp.
4. The CEO confirms the seat register and interim-seat split triggers.
5. No compensation statement is calculated from a noncanonical proposal.
6. Alex stays below five routine-routing hours for two consecutive weeks.
