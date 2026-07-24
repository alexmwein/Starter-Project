# Third Standard — Operating Model

## Customer journey

1. Visitor reads evidence-led content.
2. Visitor reviews qualification criteria.
3. Applicant submits entity, role, facility, research context, and purchasing authority.
4. Operations reviews the application and documents the decision.
5. Approved account sees only materials within the approved scope.
6. Buyer reviews specification and current Lot Record.
7. Purchase order or approved payment method is reconciled to the account.
8. Fulfillment ships a released lot and records the lot-to-customer map.
9. Customer receives documentation and support contacts.
10. Reorder preserves lot preference and project context.

## Supplier qualification

- Legal entity and beneficial owners.
- Manufacturing site and actual manufacturer.
- Quality agreements and change notification.
- Raw material and synthesis records.
- Analytical methods and original data availability.
- Import and customs classification.
- Batch size, lead time, and continuity.
- Complaint, deviation, and recall cooperation.
- Sanctions and restricted-party screening.
- Insurance and indemnity.

No supplier receives production volume based only on a sample COA.

## Release architecture

Each lot has:

- internal lot ID;
- supplier lot and manufacturer lot;
- receipt date and custody events;
- ordered and received quantity;
- storage requirement;
- specification version;
- required release tests;
- original third-party reports;
- reviewer and release decision;
- deviations and disposition;
- inventory balance;
- customer shipment map;
- withdrawal or recall state.

## Team

### Before revenue

- Founder/CEO: strategy, capital, partnerships.
- Fractional quality lead: release system and deviations.
- Operations lead: suppliers, inventory, fulfillment, support.
- Outside counsel: FDA/FDCA, customs, contracts, privacy.
- Fractional controller: order-to-cash and inventory accounting.

### After 25 active accounts

- Full-time quality/operations lead.
- Customer research support.
- Content/editorial lead.
- Software contractor or founding engineer for Lot Records.

## Technology

### Pilot

- Structured account-qualification database.
- Inventory and lot ledger.
- Document store with version history.
- CRM for account and project context.
- Reconciled order, settlement, and shipment ledger.
- Incident and deviation log.

### Scale

- Role-based customer portal.
- Lot Record event stream.
- Supplier and test-lab integrations.
- Purchase-order and invoice workflow.
- Controlled content and claims library.
- Audit exports.

## Financial controls

- No owner calculates “net” from a storefront screenshot.
- Reconcile order → fee → refund → settlement → bank deposit.
- Capitalize inventory and track landed cost by lot.
- Reserve cash for tax, chargeback, recall, and quality events.
- Measure contribution after material, testing, freight, fulfillment, support, payments, and expected exceptions.
- Close monthly before distributions.
