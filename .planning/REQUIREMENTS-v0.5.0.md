# Requirements: Order Explorer Enhancement (v0.5.0)

**Defined:** 2026-02-09
**Core Value:** Full visibility into Integration Service data — orders, COA generations, sample events, access logs — with cross-links to WordPress and SENAITE for debugging and order management.

## v0.5.0 Requirements

### Backend Explorer API (Integration Service)

- [ ] **EXPLORER-API-01**: `GET /explorer/orders/{order_id}/attempts` — Return submission attempts (retry audit trail) for an order
- [ ] **EXPLORER-API-02**: `GET /explorer/orders/{order_id}/coa-generations` — Return COA generation records linked to an order (via ingestion → order_submission_id, or via sample_id matching)
- [ ] **EXPLORER-API-03**: `GET /explorer/orders/{order_id}/sample-events` — Return sample status events (receive, submit, verify transitions) for samples in an order
- [ ] **EXPLORER-API-04**: `GET /explorer/orders/{order_id}/access-logs` — Return COA access/download logs for samples in an order
- [ ] **EXPLORER-API-05**: Enhance `GET /explorer/orders` with status filter parameter and pagination metadata (total count)

### Frontend: Order Detail View

- [ ] **DETAIL-01**: Tabbed order detail panel replaces current flat ingestions card — tabs: Summary, Ingestions, COA Generations, Attempts, Sample Events
- [ ] **DETAIL-02**: Summary tab shows order metadata (ID, number, status, dates, sample counts, error message if any) in a clean card layout
- [ ] **DETAIL-03**: Ingestions tab shows existing ingestion data (sample_id, version, status, verification code link, processing time) — enhanced from current IngestionsPanel
- [ ] **DETAIL-04**: COA Generations tab shows version history per sample with generation number, verification code, content hash, blockchain anchor status, chromatogram link, and published/superseded status
- [ ] **DETAIL-05**: Submission Attempts tab shows retry history per order (attempt number, status, error, samples processed/created/failed, timestamp)
- [ ] **DETAIL-06**: Sample Events tab shows sample workflow timeline (status transitions: receive → submit → verify → complete) with WordPress notification status

### Frontend: External Links & Navigation

- [ ] **LINKS-01**: WordPress order link in order summary — opens `{wordpressUrl}/wp-admin/post.php?post={order_id}&action=edit` in external browser
- [ ] **LINKS-02**: SENAITE sample links from ingestions/events — opens SENAITE sample URL for each sample_id
- [ ] **LINKS-03**: Verification code links open the WordPress verification page `{wordpressUrl}/verify?code={code}`
- [ ] **LINKS-04**: S3 COA/chromatogram viewing — use signed-url service endpoints to generate download links

### Frontend: UX Improvements

- [ ] **UX-01**: Order status filter dropdown in the orders list header (all, pending, processing, accepted, failed)
- [ ] **UX-02**: Pagination controls for orders list (the backend supports limit/offset)
- [ ] **UX-03**: Order count and summary stats in the header area (total orders, by status breakdown)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Editing order data | Explorer is read-only — data modifications happen via webhooks |
| Re-triggering webhooks | Would require write endpoints; out of scope for browsing tool |
| COA PDF rendering in-app | Use external links to download/view PDFs |
| Real-time websocket updates | Polling/manual refresh is sufficient for debugging |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXPLORER-API-01 | Phase 1 | Pending |
| EXPLORER-API-02 | Phase 1 | Pending |
| EXPLORER-API-03 | Phase 1 | Pending |
| EXPLORER-API-04 | Phase 1 | Pending |
| EXPLORER-API-05 | Phase 1 | Pending |
| DETAIL-01 | Phase 2 | Pending |
| DETAIL-02 | Phase 2 | Pending |
| DETAIL-03 | Phase 2 | Pending |
| DETAIL-04 | Phase 3 | Pending |
| DETAIL-05 | Phase 3 | Pending |
| DETAIL-06 | Phase 3 | Pending |
| LINKS-01 | Phase 2 | Pending |
| LINKS-02 | Phase 2 | Pending |
| LINKS-03 | Phase 2 | Pending |
| LINKS-04 | Phase 4 | Pending |
| UX-01 | Phase 2 | Pending |
| UX-02 | Phase 2 | Pending |
| UX-03 | Phase 2 | Pending |

**Coverage:**
- v0.5.0 requirements: 18 total
- Mapped to phases: 18
- Unmapped: 0

---
*Requirements defined: 2026-02-09*
