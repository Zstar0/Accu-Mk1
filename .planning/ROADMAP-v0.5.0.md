# Roadmap: Order Explorer Enhancement (v0.5.0)

## Overview

Expand the Order Explorer from a basic order list into a full-featured debugging and browsing tool. The Integration Service has 7 active database tables but only 3 explorer endpoints are exposed. This milestone adds backend API coverage for all tables and builds a rich tabbed detail view in the frontend with external links to WordPress and SENAITE.

**Two repos involved:**
- **integration-service** — New explorer API endpoints (Phase 1)
- **Accu-Mk1** — Frontend UI enhancements (Phases 2-4)

## Phases

- [x] **Phase 1: Backend Explorer API Expansion** — Add endpoints for attempts, COA generations, sample events, access logs; enhance orders endpoint
- [x] **Phase 2: Order Detail View & Core UX** — Tabbed detail panel (Summary, Ingestions), external links, status filters, pagination
- [x] **Phase 3: COA & Event Tabs** — COA Generations tab, Submission Attempts tab, Sample Events tab (merged into Phase 2)
- [x] **Phase 4: Access Logs & Signed URLs** — Access logs viewing, S3 signed-url integration for COA/chromatogram downloads

## Phase Details

### Phase 1: Backend Explorer API Expansion
**Goal**: Integration Service exposes all data through explorer endpoints (API Key auth)
**Depends on**: Nothing (first phase)
**Requirements**: EXPLORER-API-01, EXPLORER-API-02, EXPLORER-API-03, EXPLORER-API-04, EXPLORER-API-05
**Repo**: integration-service
**Success Criteria** (what must be TRUE):
  1. `GET /explorer/orders/{order_id}/attempts` returns submission attempts with status, error, samples_processed
  2. `GET /explorer/orders/{order_id}/coa-generations` returns COA records with generation_number, verification_code, anchor_status, chromatogram_s3_key
  3. `GET /explorer/orders/{order_id}/sample-events` returns status events with transition, new_status, wp_notified, timestamps
  4. `GET /explorer/orders/{order_id}/access-logs` returns access logs with action, requester_ip, user_agent, timestamp
  5. `GET /explorer/orders` supports optional `status` filter param and returns total_count in response metadata
  6. All new endpoints use existing API Key authentication (X-API-Key header)
  7. All new endpoints have Pydantic response schemas
**Research**: Unlikely (follows existing desktop.py patterns)
**Plans**: TBD

### Phase 2: Order Detail View & Core UX
**Goal**: Replace flat ingestions panel with tabbed detail view; add status filters, pagination, external links
**Depends on**: Phase 1
**Requirements**: DETAIL-01, DETAIL-02, DETAIL-03, LINKS-01, LINKS-02, LINKS-03, UX-01, UX-02, UX-03
**Repo**: Accu-Mk1
**Success Criteria** (what must be TRUE):
  1. Clicking an order opens a tabbed detail panel (not just ingestions card)
  2. Summary tab shows order metadata, status badge, dates, sample count (delivered/expected), error message
  3. Ingestions tab shows existing data plus clickable SENAITE sample links and verification code links
  4. WordPress admin link in Summary tab opens order in external browser
  5. Status filter dropdown filters orders by status (all/pending/processing/accepted/failed)
  6. Pagination controls (next/prev) navigate through orders using limit/offset
  7. Order count displayed in header area
  8. Frontend API client (`api.ts`) has typed functions for all new endpoints
**Research**: Unlikely (standard shadcn/ui tab patterns)
**Plans**: TBD

### Phase 3: COA & Event Tabs
**Goal**: Add COA Generations, Submission Attempts, and Sample Events tabs to detail view
**Depends on**: Phase 2
**Requirements**: DETAIL-04, DETAIL-05, DETAIL-06
**Repo**: Accu-Mk1
**Success Criteria** (what must be TRUE):
  1. COA Generations tab shows version history per sample (generation_number, verification_code, content_hash, anchor_status with tx_hash link, published/superseded badge)
  2. Submission Attempts tab shows retry history (attempt_number, status, error, samples_processed/created/failed, timestamp)
  3. Sample Events tab shows timeline of status transitions (sample_id, transition arrow, new_status, wp_notified indicator, timestamp)
  4. All tabs load data on-demand (lazy fetch when tab selected)
  5. Empty states handled gracefully for each tab
**Research**: Unlikely
**Plans**: TBD

### Phase 4: Access Logs & Signed URLs
**Goal**: View access logs and enable COA/chromatogram downloads via S3 signed URLs
**Depends on**: Phase 3
**Requirements**: LINKS-04
**Repo**: Accu-Mk1
**Success Criteria** (what must be TRUE):
  1. Access Logs section (either as a tab or within COA Generations) shows download/verification audit trail
  2. "Download COA" button on ingestions/COA generations uses `/v1/service/coa/signed-url` to generate presigned URL
  3. "View Chromatogram" button uses `/v1/service/chromatogram/signed-url` for chromatogram image
  4. Signed URL requests use JWT authentication (separate from explorer API key auth)
**Research**: Likely (JWT auth flow from frontend, signed URL handling)
**Research topics**: JWT token acquisition for service endpoints, opening presigned URLs, chromatogram image display
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Backend Explorer API | 1/1 | Complete | 2026-02-09 |
| 2. Order Detail View & Core UX | 1/1 | Complete | 2026-02-09 |
| 3. COA & Event Tabs | - | Merged into Phase 2 | 2026-02-09 |
| 4. Access Logs & Signed URLs | 1/1 | Complete | 2026-02-09 |
