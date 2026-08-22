# OVO Brand Demand Engine v2

> **SUPERSEDED 2026-08-05 by Alex.** The "do not buy a new scraper" decision and
> the 24-useful-vs-369-weak finding below reflect the pre-2026-08 discovery
> stack, when discovery meant scraped company switchboard numbers. It is kept
> for history, not as current doctrine.
>
> What changed: discovery is now signal-based and free. Four merged lanes
> (HTTP Archive influencer-tech detection, Meta Ad Library, public ATS job
> postings, inbound footers) produce brands with a *proven paid influencer
> line item*, not scraped rows. Verified live: 17,827 US Shopify brands running
> influencer/affiliate software, at $0 in BigQuery free tier.
>
> Still true and worth carrying forward: first-party inbound converts best,
> reveal phones on the scored subset rather than the whole file, and rep dial
> capacity (~7,000 mobiles/caller-year) is the binding constraint, not data cost.

## Decision

Do not buy a new scraper or dialer. Keep Apollo and JustCall for a tightly controlled pilot, but stop treating a scraped company phone number as a sales lead.

First prove that OVO's first-party brand intent produces qualified conversations. Only then build the account-level demand engine inside OVO CRM. The target system turns first-party buying intent and verified spend signals into a small, ranked daily call queue, preserves every touch across email, LinkedIn, and calling, and learns from outcomes.

The important idea is simple:

> OVO's moat is not access to more company phone numbers. It is the proprietary graph of which brands are already emailing OVO creators, buying creator media, requesting usage rights, hiring influencer teams, and responding to OVO.

The scraper should add evidence to that graph. It should not create a parallel pile of rows.

### Sequencing decision

This is a two-stage bet:

1. **Demand proof:** work the 24 warm accounts manually through a small, auditable ledger. No broad enrichment, new call UI, or platform build.
2. **System proof:** if the warm cohort clears pre-committed business gates, build the smallest CRM slice needed for 50 signal-led cold accounts. Expand the target architecture only where the pilot exposes real constraints.

The first version of this document reversed those stages. An independent engineering review correctly flagged that as platform validation before demand validation.

## What the current system actually is

The board describes one coordinated account-level motion:

```text
brand signal -> qualified account -> verified stakeholders
             -> coordinated email + LinkedIn + calls
             -> discovery -> proposal -> close -> delivery
```

The live implementation is several disconnected stores:

```text
brand discovery SQLite (313 brands / 275 domains)
        |
        v
Apollo candidates JSON -> async Worker KV -> local phone cache
        |                                      |
        +--------------------+-----------------+
                             v
                   JustCall contact list
                             |
                             v
                 local call_outcomes.db

Separately:
Desktop/ovo-cold-call-list.csv (393 domains)
OVO CRM Postgres (brands, communications, calls)
Smartlead email state
```

There is no canonical account ID flowing through that diagram. The system tries to reconstruct identity later from a normalized phone number.

### Evidence from the current CSV

`/Users/alexweinstein/Desktop/ovo-cold-call-list.csv`, inspected 2026-07-19:

| Finding | Count |
|---|---:|
| Total rows | 393 |
| Warm accounts that previously emailed OVO | 24 |
| Cold accounts | 369 |
| Cold rows with a named person and title | 3 |
| Cold rows with a direct-contact email | 0 |
| Toll-free cold numbers | 166 |
| International numbers | 17 |
| Duplicate phone numbers | 1 |
| Domain overlap with the existing brand-discovery DB | 6 |

The 369 cold rows are mostly public switchboards, support lines, or toll-free numbers. They are account candidates, not call-ready leads.

The 24 warm rows are strategically different. They contain a real prior email, recency, a named stakeholder, and context. Mixing them with 369 cold switchboards destroys the signal and makes rep performance impossible to interpret.

## Verified technical defects

### P0 (confidence 10/10): active-looking secrets are committed as fallback defaults

`origin/main:ovo-outbound/call_outcomes.py:43-44` and `pull_apollo_reveals.py:31-34` contain real-looking API credentials as source-code fallbacks. The webhook key is also passed in the URL query string.

If these values are still active, rotate them before the next run. After rotation, require environment secrets and fail closed. Never put webhook secrets in source, query strings, logs, or committed examples.

### P1 (confidence 10/10): the JustCall parser reads the wrong fields

`call_outcomes.py:103-106` prefers `call_info.status` over `call_info.type`. JustCall's current call object defines `status` as Archived/Unarchived and `type` as Answered/Unanswered. The classifier is therefore reading archive state as call outcome.

`call_outcomes.py:109-123` looks for `total`, `seconds`, `billed`, and `friendly_seconds`. JustCall documents `total_duration` and `conversation_time`. Real calls can be classified from zero duration even when talk time exists.

The 11 tests pass because their fixtures reproduce the script's assumed payload, not the provider's documented payload. This is a contract-test failure, not a unit-test failure.

Official reference: [JustCall Call Object](https://developer.justcall.io/docs/justcall-call-object).

### P1 (confidence 10/10): phone number is being used as identity

`call_outcomes.py:16-18` explicitly joins provider calls to leads by normalized phone. This breaks when:

- two contacts share a company switchboard;
- a contact changes numbers;
- an international number is formatted differently;
- a number is recycled;
- a rep calls an off-list number;
- the same account has several stakeholders.

Use OVO `brand_id`, `person_id`/`brand_employment_id`, call-task ID, and JustCall `call_sid`/`id`. Bind the CRM task to the provider call through a verified provider-contract method, then store both IDs on ingestion. Phone is a contact method, never the primary key.

Prior learning applied: `payout-reconcile-canonical-provider-id-and-period` (confidence 10/10). OVO has already seen fuzzy identity matching reuse the wrong financial record. The same design error is present here with phone numbers.

### P1 (confidence 9/10): Apollo returns the first phone-bearing person, not the right buyer

`enrich_calling_leads.py:70-86` returns the first Apollo result with `has_direct_phone`. It does not rank function, seniority, company size, current-employer certainty, geography, or evidence that the person owns creator spend.

Apollo's domain filter can match a current or previous employer. The code does not verify current employment before spending credits and pushing the contact to JustCall. CEO/founder is also in the same broad search as influencer marketing and partnerships, even for large accounts.

Apollo supports seniority, location, domain, and organization filters. People Search itself does not return contact details and does not consume credits; enrichment is the paid step. [Apollo People Search](https://docs.apollo.io/reference/people-api-search).

### P1 (confidence 10/10): a public company number poisons the named-contact cache

`phone_finder.py:201-215` scrapes a company website first. If it finds any phone, it writes that company number under the named person's cache key and returns before Apollo enrichment.

This erases the distinction between:

- direct business line;
- personal mobile;
- company switchboard;
- customer-support line;
- toll-free line.

That distinction changes the script, expected connect rate, lawful-use evidence, and what a failed call teaches the system.

### P1 (confidence 9/10): provider webhooks are not treated as an event stream

The Apollo Worker stores arbitrary payloads in KV, lists at most 100, and deletes them after the local drain. There is no durable request row, signature verification, schema version, replay ledger, dead-letter state, or CRM ID.

JustCall explicitly says webhook events can arrive out of order and more than once. It recommends provider object IDs plus event type for deduplication, signature validation, and API reconciliation for missing objects. [JustCall webhook behavior](https://developer.justcall.io/docs/webhook-events).

### P2 (confidence 9/10): discovery scoring is a story, not a measured model

The brand scorer asks Gemini to infer spend, size, accessibility, and pitch quality from sparse summaries. The heuristic fallback defaults recency to 8, size to 6, and fitness fit to 7. A brand can look qualified because missing data received optimistic defaults.

The system needs explicit evidence and an unknown state. Unknown is not six out of ten.

### P2 (confidence 10/10): the most valuable source is underused

The current list proves the point: the 24 useful records came from companies that already emailed OVO. The 369 weak records came from broad company/phone discovery.

The architecture board already names creator inboxes as brand-demand sensors. That first-party signal should be the top of the queue, not a note inside a CSV.

## The target system, earned in stages

### Source order

Rank sources by information advantage, not row volume:

1. **First-party intent:** creator opportunity inboxes, prior brand emails, prior deals, referrals, inbound forms, and prior positive replies.
2. **Observed spend:** recent creator sponsorships, current UGC ads, active ambassador programs, and influencer/creator-team hiring.
3. **Closed-won lookalikes:** accounts similar to profitable OVO customers, using features learned from actual outcomes.
4. **Broad discovery:** directories, search results, and generic databases. These create account candidates only.

```text
creator inboxes ----+
prior email/deals --+--> canonical brand account --> evidence ledger
ad/sponsor signals -+                              |
jobs/referrals -----+                              v
                                         deterministic gate
                                                   |
                                                   v
                                      stakeholder map (1-3 people)
                                                   |
                                                   v
                                      selective phone enrichment
                                                   |
                                                   v
                                        ranked daily call task
```

### Canonical records after demand proof

Reuse the existing Postgres `brands`, `team_members`, `deals`, and `communications` tables. The migration chain is authoritative; update the bootstrap `schema.sql` in the same change so a fresh database and an upgraded database converge to the same schema.

Do not put a single unique domain directly on `brands`. Add `brand_domains` with canonical, alias, regional, former, parent, and agency-sender relationships plus effective dates and merge-audit records. Exact verified domains can propose an account match; ambiguous domains require operator approval.

Add only the records the measured workflow needs:

#### `people` and `brand_employments`

- `people`: durable human identity, name, verified LinkedIn URL, and provider person IDs
- `brand_employments`: `person_id`, `brand_id`, normalized title, function, seniority, start/end dates, current-employer evidence, and `verified_at`
- Apollo person and organization IDs
- merge/supersession audit for duplicate people without rewriting historical employment

Unique identities should prefer a verified LinkedIn URL or provider person ID. Job changes close one immutable employment record and open another; they never move old communications to a new employer.

#### `brand_contact_points`

- `id`, optional `person_id`, optional `brand_employment_id`, and optional `brand_id` for a company switchboard
- type: email, direct business line, mobile, switchboard, toll-free, LinkedIn
- normalized value plus display value
- source/provider record ID and source URL
- confidence, verification state, verified/revealed timestamps
- timezone and jurisdiction-confidence fields for phones
- validity state: active, wrong, disconnected, stale, superseded

One contact can have several contact points. A switchboard belongs to the account unless there is evidence that it routes to a named person.

#### `contact_suppressions`

- scope: account, person, or exact contact point
- channel: all, phone, email, LinkedIn, or SMS
- reason, source, actor, evidence, and effective timestamp
- optional expiry only for temporary operational holds; DNC has no automatic expiry

Every dispatch path performs the same suppression lookup immediately before acting. A cached queue decision is not enough because a DNC request can arrive after the queue was built.

#### `brand_signals`

- `id`, `brand_id`
- type: inbound email, creator request, paid social, sponsored creator, job post, referral, prior deal, manual research
- observed timestamp and expiry timestamp
- immutable evidence reference plus source URL/provider ID
- optional `creator_id`, `communication_id`, `deal_id`, campaign/ad ID, and source account
- structured facts, not a model's prose summary
- confidence and verification state

Signals expire. A six-month-old job post should not keep an account “hot” forever.

#### `brand_call_tasks`

- `id`, `brand_id`, optional `brand_employment_id`
- owner and backup
- `claimed_by`, `claimed_at`, and lease expiry
- state, priority band, reason codes
- next action and due time
- attempt cap and attempt count
- local calling window
- sequence/cohort ID
- terminal reason
- optimistic-lock version

There must be only one active calling sequence per account. Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`, an expiring lease, and an account-level partial unique constraint so two reps cannot call different people at the same company concurrently.

#### `outbound_call_attempts`

- OVO task/person/employment/account IDs
- JustCall call ID and `call_sid`
- provider event timestamps and rep
- normalized disposition enum
- provider status/type, conversation duration, recording/notes pointers
- next action and due time
- raw provider payload reference

#### `integration_events`

A durable inbox for Apollo and JustCall:

- provider, provider event ID when available, provider object ID, event type, and provider request ID
- signature validation result
- raw payload, received time, processed time
- processing status, retry count, next-attempt time, lease owner/expiry, and last error
- uniqueness on `(provider, provider_event_id)` when supplied; otherwise a non-null canonical payload fingerprint

Events are reduced idempotently by version/timestamp rules, because several legitimate updates can share an object and event type. A database-backed worker claims events with `SKIP LOCKED`, uses bounded exponential backoff, dead-letters permanent failures, and is deployed with the CRM API. The table is durable storage; the worker is the consumer. No new queue product is needed for the first 1,000 accounts.

Raw provider payloads contain phone numbers, emails, names, call notes, and possibly recording links. Restrict them to the integration worker role, encrypt storage/backups, redact application logs, keep normalized fields for operations, and delete raw payloads on a documented retention schedule after reconciliation. Add a read-access audit event/table; the existing insert/update/delete audit constraint cannot represent payload reads.

Extend `communications` with optional `person_id`, `brand_employment_id`, `call_attempt_id`, and provider-event references. Add an `outbound_attribution` record linking source signal, cohort, task, call attempt, opportunity/deal, proposal contribution, and collected payment. “Opportunity created” must resolve to an existing OVO deal state or an explicitly added opportunity record; it cannot be a diagram-only noun.

### Qualification is a gate, then a ranking

Do not ask a model for one magic score. Use a hard gate followed by explicit reason-coded bands.

An account becomes call-ready only when all are true:

- canonical domain and company identity verified;
- account is in the target market and can plausibly buy the minimum profitable campaign;
- at least one non-expired spend or intent signal exists;
- no account, contact, email, or phone suppression exists;
- a current stakeholder or an explicitly labeled switchboard path exists;
- phone type, source, and evidence are stored;
- local calling window can be determined conservatively;
- owner, next action, and script angle are present.

Then rank call-ready work lexicographically:

1. warm first-party intent;
2. strength and recency of spend evidence;
3. stakeholder relevance and contact confidence;
4. expected contribution potential;
5. oldest due next action.

This stays explainable. A rep can see exactly why an account is first.

### Stakeholder mapping

Search for up to three roles per account, but reveal one phone at a time:

1. influencer/creator partnerships owner;
2. brand/social/performance marketing owner;
3. CMO/founder only when company size makes that role plausible.

Rank candidates deterministically:

```text
exact function match
  > current-employer proof
  > manager/head/director decision proximity
  > geography and calling-window confidence
  > direct business line
  > company switchboard
  > personal mobile requiring extra compliance review
```

Never spend a second reveal until the first contact is wrong, unreachable after cadence, or explicitly refers OVO elsewhere.

Apollo's current waterfall returns enrichment results asynchronously and includes request status, source attempts, final values, and credit consumption. Before spending another credit, persist a local reveal request and bind the provider request ID returned by the accepted request. Correlate the webhook by that ID; name/domain matching can only create an operator-review candidate, never an automatic attachment. [Apollo waterfall enrichment](https://docs.apollo.io/docs/enrich-phone-and-email-using-data-waterfall).

### Call task state machine

```text
ACCOUNT_CANDIDATE
      |
      v
QUALIFIED_ACCOUNT -----> DISQUALIFIED
      |
      v
CONTACT_MAPPED --------> RESEARCH_REQUIRED
      |
      v
ENRICHMENT_PENDING ----> ENRICHMENT_FAILED / NO_PHONE
      |
      v
CALL_READY ------------> SUPPRESSED
      |
      v
IN_SEQUENCE
  |   |   |   \
  |   |   |    +------> WRONG_PERSON -> CONTACT_MAPPED
  |   |   +-----------> CALLBACK_DUE -> CALL_READY at due time
  |   +---------------> NO_CONNECT -> CALL_READY at cadence / EXHAUSTED
  +-------------------> CONNECTED
                           |   |    \
                           |   |     +-> DO_NOT_CONTACT
                           |   +-------> NURTURE / DISQUALIFIED
                           +-----------> MEETING_BOOKED -> opportunity
```

Transitions are explicit and validated. Free-text dispositions can be stored as notes, but they cannot control queue state.

### Provider event flow

```text
JustCall webhook
    |
    +-> verify SHA-256 signature and timestamp
    +-> insert integration_events (unique key, acknowledge fast)
            |
            +-> normalize call by call_sid / call ID
            +-> attach OVO IDs from a verified correlation method
            +-> upsert attempt
            +-> apply latest valid state transition
            +-> write communications timeline
            +-> schedule next action

nightly reconciliation
    +-> fetch calls updated since cursor
    +-> repair missed/out-of-order webhook data
    +-> alert on unresolved provider objects
```

The JustCall correlation method is an explicit provider-contract spike, not an assumption. Preferred order: CRM-initiated call returning a provider call ID; supported external/custom metadata; then a manual operator confirmation. A time/rep/phone heuristic may propose a match but must never commit attribution automatically.

### Outcome taxonomy

Use a small enum with one meaning each:

- `no_answer`
- `voicemail`
- `busy`
- `failed_provider`
- `wrong_number`
- `switchboard_no_route`
- `wrong_person`
- `gatekeeper_referral`
- `connected_unqualified`
- `connected_nurture`
- `callback_requested`
- `meeting_booked`
- `do_not_contact`

Require the rep to choose a disposition after every connected call. When the provider has not yet delivered an updated disposition event, show `awaiting_disposition`; do not guess “connected” from a 20-second duration and silently move the pipeline.

### Multichannel coordination

One account record owns suppression across all channels:

- a positive inbound or email reply pauses cold calls until an owner chooses the next action;
- `do_not_contact` suppresses the exact person and contact methods immediately, with account-level suppression when requested;
- a booked meeting pauses Smartlead, LinkedIn, and call tasks;
- a wrong person opens a referral/research task instead of exhausting the account;
- each channel writes to `communications` with the same `brand_id` and contact when known.

“Atomic” applies only to OVO's local decision: commit the suppression first, and make every sender check it again immediately before dispatch. Pausing Smartlead, LinkedIn, and JustCall is an asynchronous outbox job with retries and visible provider-sync status. Postgres cannot atomically commit external provider state, so the system never claims that guarantee.

This is what the board means by one coordinated sales motion.

Counsel owns the calling-policy matrix. Before Cohort B, counsel supplies the initial policy version, effective jurisdictions/contact-point classes, required evidence, and failure behavior. The task stores the approving policy version; no valid policy means not call-ready. Code does not invent legal rules from phone geography. FTC guidance says most B2B calls to a business are exempt from National DNC provisions, while the 2024 rule expanded prohibitions against misrepresentation in B2B telemarketing. That does not resolve state law or personal-mobile use. [FTC B2B DNC guidance](https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0), [FTC 2024 update](https://www.ftc.gov/news-events/news/press-releases/2024/03/ftc-implements-new-protections-businesses-against-telemarketing-fraud-affirms-protections-against-ai).

## Rep experience

The caller should not open a CSV. The daily screen should show one card at a time:

- company, stakeholder, title, timezone, and verified phone type;
- why now, with source links and dates;
- prior OVO emails, calls, LinkedIn touches, creator requests, and deals;
- one sentence account hypothesis and the correct script lane;
- last outcome, attempt number, and required disposition buttons;
- book, callback, referral, wrong person, not fit, and do-not-contact actions.

Warm inbound, named direct contact, and switchboard calls are separate lanes with different scripts and metrics.

## The first pilot

Do not enrich all 369 cold rows. Reclassify them as account candidates and preserve them.

### Stage A: prove demand with the 24 warm accounts

- Import and deduplicate the 24 companies that already emailed OVO.
- Verify current employment and direct contact details manually.
- Load the full prior email context, creator requested, source message ID, observed date, and account hypothesis.
- Call with a contextual expansion thesis, not a generic agency pitch.
- Record task ID, provider call ID, outcome, next action, caller minutes, and any created deal in a small Postgres experiment ledger.
- Do not build a new rep UI; use a reviewed CRM/admin view for these 24 records.

Before the first dial, the CEO and sales owner lock the economic pass/fail gate. Recommended initial gate: from 24 attempted accounts, at least three qualified conversations and one held meeting within 21 days, with no unresolved DNC or attribution errors. Also report qualified conversations per caller hour and projected contribution versus fully loaded caller/enrichment cost. If the cohort misses, review positioning, signal quality, and offer before building infrastructure.

### Stage B: prove the system with 50 signal-led cold accounts

Start only after Stage A clears its gate:

- Select 50 accounts with the freshest verified creator-spend evidence.
- Map one current stakeholder per account.
- Audit the first 30 contact matches manually before revealing the rest.
- Reveal one phone per account and label its type.
- Run a fixed cadence and script for two weeks.

### Pilot gates

Before expanding:

- 100% of attempts attached to canonical account and contact IDs;
- 100% of do-not-contact requests suppressed across all active channels;
- at least 95% of provider events ingested within five minutes and 100% eventually reconciled or explicitly dead-lettered;
- at least 26 of the 30 audited contacts are confirmed current and role-relevant;
- phone reachability, live-connect rate, qualified-conversation rate, booked-meeting rate, show rate, and cost per qualified conversation reported by source and phone type;
- no unexplained Apollo credit spend;
- no rep can dial a record without a reason, owner, local window, and next-action state.

Stage B also needs a business gate locked before launch: minimum qualified conversations per caller hour, held meetings, and pipeline contribution relative to fully loaded cost. Establish OVO's baseline, then require each new cohort or source to beat it. Technical correctness alone cannot pass the pilot.

## Metrics that matter

### Supply quality

- accounts discovered by source;
- percentage passing qualification;
- current-stakeholder match rate;
- usable-phone yield and credit cost by provider;
- correct-person rate from rep dispositions;
- stale/expired-signal rate.

### Calling

- attempts and unique accounts attempted;
- live connects per caller hour;
- correct-person connects per caller hour;
- qualified conversations per caller hour;
- meetings booked per qualified conversation;
- callbacks completed on time;
- DNC and wrong-number rates by source and phone type;
- number reputation and carrier failure rate.

### Revenue

- meetings held;
- opportunities created;
- proposal contribution value;
- collected contribution;
- collected contribution per source, rep, and caller hour;
- days from first signal to collected cash.

Raw dials are a capacity metric, not success.

## Implementation plan

### Phase 0: contain the current failure modes

1. Rotate any still-active committed JustCall and Apollo webhook secrets.
2. Remove source-code credential fallbacks and query-string administration keys.
3. Replace JustCall fixtures with captured, redacted provider-contract fixtures and correct `type`/duration parsing.
4. Stop caching a company switchboard as a named person's phone.
5. Quarantine previously cached company numbers and JustCall contacts whose provenance/type is unknown; do not silently reuse poisoned rows.
6. Freeze bulk Apollo reveals until contact correctness is measured.
7. Verify one supported JustCall correlation path and one Apollo request/webhook correlation path in a sandbox. Document the exact provider fields before implementation.

### Phase 1: Stage A demand proof

1. Create the minimal experiment ledger and attribution link needed for the 24 warm accounts; reuse `brands`, `communications`, `deals`, and `team_members`.
2. Import only those 24 with an apply-capable, checkpointed importer: dry-run report, operator approval for ambiguous matches, apply mode, and repeat-run idempotency.
3. Manually verify people, employment, phone type, prior context, and suppression state.
4. Run the calls, require structured outcomes/next actions, and publish the pre-committed business gate.

Stop here if demand does not clear the gate. No call UI or broad signal engine is justified yet.

### Phase 2: Stage B canonical slice

1. Implement `brand_domains`, people/employments, contact points, suppressions, signals with provenance, call tasks/leases, attempts, communications references, and outbound attribution in narrowly scoped migrations.
2. Build first-party signal ingestion for creator inboxes, prior communications/deals, and referrals before generating a queue. Add observed-spend adapters only after that path works.
3. Import 50 approved signal-led accounts with the same dry-run/approve/apply/checkpoint workflow.
4. Add the deterministic qualification gate, account-level claim lease, and queue view.
5. Obtain and encode the first counsel-approved calling-policy version before any Stage B task becomes call-ready.

### Phase 3: provider events and rep workflow

1. Add signed Apollo and JustCall webhook endpoints plus the leased database worker, bounded retries, reconciliation cursors, and dead-letter alerts.
2. Bind Apollo accepted requests and JustCall calls using the provider-contract methods proven in Phase 0.
3. Add the one-card call workspace only after reps complete Stage A; require structured disposition and next action.
4. Write attempts to the shared communications timeline and attribution chain.
5. Commit local suppression first, enforce it at every sender's dispatch boundary, then sync external provider pauses through an outbox.

### Phase 4: feedback loop

1. Report the pilot metrics by cohort, signal, phone source/type, rep, attempt number, caller hour, and fully loaded cost.
2. Link created deals and collected payments back to signal, cohort, task, and call attempt.
3. Promote or demote discovery sources from observed correct-person and qualified-conversation yield.
4. Use model assistance only for summaries and research extraction. Keep qualification gates and state transitions deterministic.

## Test plan

```text
DISCOVERY / IMPORT
  [unit] normalize domain, email, phone, provider IDs
  [unit] exact + ambiguous duplicate handling
  [unit] account/person/contact-point suppression precedence
  [unit] unknown evidence never receives a positive default
  [integration] dry-run -> approve -> apply -> resume is repeatable
  [integration] second import creates no duplicate account/contact/task

DEMAND PROOF / SIGNALS
  [integration] each warm account retains source message, creator, date, and context
  [integration] creator inbox/prior communication becomes a provenance-linked signal
  [unit] expired or unverified evidence cannot enter the Stage B queue
  [report] qualified conversations, held meetings, caller hours, and cost drive stop/go

APOLLO
  [unit] deterministic stakeholder rank for company-size/title cases
  [unit] current vs former employer validation
  [unit] one reveal at a time and credit cap
  [integration] accepted -> webhook success / not-found / malformed / timeout
  [integration] duplicate and out-of-order webhook events

JUSTCALL
  [contract] redacted official call payload fields
  [unit] Answered/Unanswered and total_duration/conversation_time
  [integration] completed arrives before updated disposition
  [integration] duplicate events and missing call ID with call_sid fallback
  [integration] signature failure and stale timestamp rejection
  [integration] nightly reconciliation repairs a missed event

QUEUE / SUPPRESSION
  [unit] every allowed and forbidden state transition
  [unit] attempt cap, callback due time, and local calling window
  [integration] DNC commits locally before next dispatch; provider pause retries to convergence
  [concurrency] two reps cannot claim or dial simultaneous tasks at the same account

REP FLOW
  [E2E] warm account -> call -> callback -> meeting booked
  [E2E] wrong person -> referral -> new contact -> call ready
  [E2E] DNC -> all channels paused with visible evidence
  [E2E] provider outage -> clear error, no duplicate call task
```

### Failure-mode table

| Production failure | Required behavior | Test |
|---|---|---|
| Apollo accepts reveal but webhook never arrives | task stays pending, reconciliation/expiry alerts, no repeat credit spend | integration |
| Apollo returns a former employee | reject current-employer gate, open research task | unit + integration |
| JustCall completed event precedes disposition | store partial attempt, updated event completes it | integration |
| JustCall sends a duplicate | provider event ID/fingerprint and idempotent reducer prevent duplicate effects | integration |
| Provider event is missed | cursor reconciliation fetches and repairs it | integration |
| Two reps open the same task | atomic claim permits one owner | concurrency |
| DNC and email send race | local suppression commits first; sender rechecks at dispatch; provider sync is retried | integration |
| Contact changes jobs | supersede contact, preserve history, never move history to new employer | unit + integration |
| Generic switchboard is shared | attempts stay attached by task/contact ID, not phone | contract + integration |
| Scraped signal becomes stale | expiry removes it from call-ready gate | unit |

## Performance review

At this scale, Postgres is enough. The first version should use:

- indexed queue predicates on task state, due time, owner, and priority band;
- partial unique indexes for verified domain aliases, account-level active calling sequence, provider IDs, and active contact points;
- unique provider-event keys for O(1) deduplication;
- bulk Apollo search/enrichment requests where credit policy allows;
- webhook acknowledgement after durable insert, before downstream processing;
- cursor-based reconciliation rather than rescanning all provider history;
- batched source imports and database upserts instead of one-file-per-contact cache reads.

No Kafka, Temporal, vector database, or new data warehouse. Those would solve imaginary scale while the real system still cannot identify who answered the phone.

## What already exists and should be reused

| Existing asset | Reuse decision |
|---|---|
| `brand_pipeline.py` and discovery adapters | Keep as source adapters; make outputs evidence records, not final leads. |
| `brands.db` with 313 brands | Migrate once, reconcile, then retire as source of truth. |
| Apollo People Search and waterfall | Keep provider; add ranking, identity, cost, and async controls. |
| JustCall | Keep dialer for pilot; use signed webhooks plus reconciliation. |
| OVO CRM `brands` | Canonical account record. |
| OVO CRM `communications` | Shared cross-channel timeline. |
| OVO CRM `team_members` | Ownership and attribution. |
| Existing `calls` table | Keep for recorded sales/discovery calls; do not force outbound attempts into its meeting-analysis state machine. |
| `call_outcomes.py` tests | Preserve useful normalization cases, replace provider-shape fixtures and local-DB architecture. |
| creator opportunity inboxes and prior emails | Promote to primary demand source. |

## NOT in scope

- Replacing Apollo before its correct-person and usable-phone yield is measured.
- Replacing JustCall before event ingestion and rep workflow are fixed.
- Parallel, predictive, prerecorded, ringless-voicemail, or AI-voice dialing.
- Buying another broad lead database to create more unowned rows.
- International scale before jurisdiction and local-time policy is reviewed.
- A model that automatically promises pricing, scope, results, or legal terms.
- Rebuilding the full OVO CRM frontend before the canonical data contract works.
- Training a predictive lead model before at least several hundred labeled outcomes exist.

## Parallel implementation lanes

Do not parallelize past Phase 0 until Stage A proves demand. After Stage A clears its business gate:

| Lane | Work | Dependency |
|---|---|---|
| A | Narrow Postgres schema, signal import, queue, attribution | Stage A gate; lands first |
| B | Apollo + JustCall event adapters and contract tests | Lane A contract + Phase 0 provider spike |
| C | Rep call workspace and communications timeline | Lane A contract + observed Stage A rep workflow |
| D | Smartlead/LinkedIn outbox sync and analytics | Lanes A and B |

Run B and C in parallel workspaces after A merges. Run D after B. Do not split schema ownership across workspaces.

## Acceptance criteria

The redesign is complete when:

- a brand, person, signal, phone, task, call, and outcome are traceable by stable IDs;
- a provider replay or out-of-order event cannot duplicate or regress state;
- a rep cannot call without context, reason, owner, local window, and required next action;
- warm inbound, direct stakeholder, and switchboard motions are visibly separate;
- DNC and booked-meeting state suppress every active outbound channel;
- every Apollo credit can be tied to a request, result, source, and downstream outcome;
- the CEO view reports qualified conversations and collected contribution by source, not scraped rows and raw dials.

That is a cold-calling system. The current CSV is just a list of phone numbers.

---

## GSTACK REVIEW REPORT

- Review mode: full engineering plan review plus independent Codex outside voice
- Initial result: 19 issues found — 3 P0, 11 P1, 4 P2, and 1 strategic sequencing flaw
- Final result: all 19 addressed in this revision; no unresolved critical gap in the plan
- Key correction: demand proof with 24 warm accounts now precedes the platform build
- Test plan: `~/.gstack/projects/meltylabs-Quickstart/scaling-strategy-eng-review-test-plan-20260720-025317.md`
- Implementation readiness: **9/10** for Phase 0 and Stage A; later phases remain deliberately gated on measured demand and verified provider contracts
