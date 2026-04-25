# Peptide Request — HTTP Contracts

**Date:** 2026-04-17
**Status:** Draft — to be frozen before parallel agent execution begins
**Companion to:** `2026-04-17-peptide-request-design.md`

This document is the **single source of truth** for every HTTP surface in the peptide request feature. All three repos (Accu-Mk1, integration-service, accumarklabs/wpstar) reference these contracts directly. If anything here changes after the freeze point, all three agents must halt and re-align.

---

## Auth mechanisms (glossary)

| Name | Used where | Mechanism |
|---|---|---|
| **WP-JWT** | Customer-initiated WP → integration-service | Existing WP → integration-service JWT bearer; customer identity derived from token |
| **Service-Secret** | integration-service ↔ Accu-Mk1, and integration-service ↔ wpstar | Shared secret header `X-Service-Token`; rotated via env var |
| **ClickUp-Sig** | ClickUp → Accu-Mk1 webhook | `X-Signature` header, HMAC-SHA256(secret, raw_body), constant-time compare |
| **WC-REST** | integration-service → WooCommerce | Existing WooCommerce REST consumer key/secret |
| **SENAITE-Basic** | integration-service → SENAITE | Existing SENAITE basic auth / token, per existing adapter |

---

## Shared types

### `PeptideRequest` (canonical response shape)

Returned by Accu-Mk1 and passed through integration-service. WP sees the same shape (with sensitive/internal fields stripped — see `PeptideRequestForWP`).

```json
{
  "id": "018e9c20-9b0f-7b3a-9c1f-f7d3e9c3b1a2",
  "created_at": "2026-04-17T14:32:10Z",
  "updated_at": "2026-04-17T14:35:02Z",
  "submitted_by_wp_user_id": 4821,
  "submitted_by_email": "customer@example.com",
  "submitted_by_name": "Jane Customer",
  "compound_kind": "peptide",
  "compound_name": "Retatrutide",
  "vendor_producer": "PepMart Labs",
  "sequence_or_structure": "YAE(C6)GTFTSDLSKQMEEEAVRLFIEWLKAGGPSSGAPPPS-NH2",
  "molecular_weight": 4731.3,
  "cas_or_reference": "2381089-83-2",
  "vendor_catalog_number": "PML-RETA-001",
  "reason_notes": "Offering to customers in Q3",
  "expected_monthly_volume": 30,
  "status": "in_process",
  "previous_status": null,
  "rejection_reason": null,
  "sample_id": "S-7103",
  "clickup_task_id": "86a1m2z",
  "clickup_list_id": "901234567",
  "clickup_assignee_ids": ["cu_u_1234", "cu_u_5678"],
  "senaite_service_uid": null,
  "wp_coupon_code": null,
  "wp_coupon_issued_at": null,
  "completed_at": null,
  "rejected_at": null,
  "cancelled_at": null
}
```

### `PeptideRequestForWP` (WP-facing projection)

Strips internal fields. Used on all WP-facing responses.

```json
{
  "id": "018e9c20-9b0f-7b3a-9c1f-f7d3e9c3b1a2",
  "created_at": "2026-04-17T14:32:10Z",
  "updated_at": "2026-04-17T14:35:02Z",
  "compound_kind": "peptide",
  "compound_name": "Retatrutide",
  "vendor_producer": "PepMart Labs",
  "sequence_or_structure": "...",
  "molecular_weight": 4731.3,
  "cas_or_reference": "2381089-83-2",
  "vendor_catalog_number": "PML-RETA-001",
  "reason_notes": "Offering to customers in Q3",
  "expected_monthly_volume": 30,
  "status": "in_process",
  "rejection_reason": null,
  "wp_coupon_code": null,
  "completed_at": null,
  "rejected_at": null
}
```

**Stripped fields:** `submitted_by_*` (customer knows their own identity), `sample_id`, `clickup_*`, `senaite_service_uid`, `previous_status`, `cancelled_at`, `*_failed_at`.

### `Status` enum

```
new | approved | ordering_standard | sample_prep_created | in_process | on_hold | completed | rejected | cancelled
```

### `CompoundKind` enum

```
peptide | other
```

### Standard error envelope (all endpoints)

```json
{
  "error": {
    "code": "validation_error",
    "message": "compound_name is required",
    "details": {
      "field": "compound_name"
    }
  }
}
```

Error `code` values used in this feature:
- `validation_error` (400)
- `unauthorized` (401)
- `forbidden` (403)
- `not_found` (404)
- `conflict` (409) — e.g., idempotency key mismatch
- `rate_limited` (429)
- `upstream_unavailable` (502) — downstream service down (ClickUp, SENAITE, WC)
- `internal_error` (500)

---

## integration-service endpoints (WP-facing)

Base URL: `https://integration.accumarklabs.com`

### POST `/v1/peptide-requests`

Submit a new request. Customer-initiated; called from wpstar portal form submit handler.

**Auth:** WP-JWT
**Headers:**
- `Authorization: Bearer <jwt>`
- `Idempotency-Key: <uuid>` (REQUIRED — client-generated per submit click)
- `Content-Type: application/json`

**Request body:**

```json
{
  "compound_kind": "peptide",
  "compound_name": "Retatrutide",
  "vendor_producer": "PepMart Labs",
  "sequence_or_structure": "YAE(C6)GTFTSDLSKQMEEEAVRLFIEWLKAGGPSSGAPPPS-NH2",
  "molecular_weight": 4731.3,
  "cas_or_reference": "2381089-83-2",
  "vendor_catalog_number": "PML-RETA-001",
  "reason_notes": "Offering to customers in Q3",
  "expected_monthly_volume": 30
}
```

**Field rules:**
- `compound_kind`: required, enum `peptide | other`
- `compound_name`: required, 1..200 chars, trim whitespace
- `vendor_producer`: required, 1..200 chars, trim whitespace
- `sequence_or_structure`: optional, ≤4000 chars
- `molecular_weight`: optional, number, > 0, ≤ 100000
- `cas_or_reference`: optional, ≤200 chars
- `vendor_catalog_number`: optional, ≤200 chars
- `reason_notes`: optional, ≤2000 chars
- `expected_monthly_volume`: optional, integer, 0..100000

**Success (201):** returns `PeptideRequestForWP`.

**Success (200) on idempotent replay:** same body returned.

**Errors:**
- 400 `validation_error`
- 401 `unauthorized` (bad JWT)
- 409 `conflict` (idempotency key reused with different payload)
- 502 `upstream_unavailable` (Accu-Mk1 unreachable)

### GET `/v1/peptide-requests`

List the authenticated customer's requests.

**Auth:** WP-JWT
**Query params:**
- `status`: optional, single status or comma-separated list
- `limit`: optional, 1..100, default 50
- `offset`: optional, default 0

**Success (200):**

```json
{
  "total": 12,
  "limit": 50,
  "offset": 0,
  "items": [ /* array of PeptideRequestForWP */ ]
}
```

### GET `/v1/peptide-requests/{id}`

Detail for a specific request. Ownership checked — 404 if the authenticated customer doesn't own it.

**Auth:** WP-JWT
**Success (200):** `PeptideRequestForWP`
**Errors:** 404 `not_found`

---

## integration-service endpoints (internal, called by Accu-Mk1)

Base URL: same. All require `X-Service-Token: <secret>`.

### POST `/v1/internal/wp/peptide-request-status`

Relay status change to WP so it updates the customer's portal and sends an email.

**Request body:**

```json
{
  "peptide_request_id": "018e9c20-9b0f-7b3a-9c1f-f7d3e9c3b1a2",
  "wp_user_id": 4821,
  "new_status": "approved",
  "previous_status": "new",
  "rejection_reason": null,
  "compound_name": "Retatrutide",
  "send_email": true
}
```

**`send_email` policy:** Accu-Mk1 sets `true` only for transitions into `approved`, `rejected`, `completed`. Always false for other transitions (the field is set by the caller, not inferred by integration-service).

**Success (200):**

```json
{
  "wp_accepted": true,
  "email_queued": true
}
```

**Errors:**
- 401 `unauthorized`
- 502 `upstream_unavailable` (WP unreachable)

### POST `/v1/internal/wp/coupons/single-use`

Issue a single-use full-cart coupon via WooCommerce.

**Request body:**

```json
{
  "wp_user_id": 4821,
  "amount_usd": 250,
  "peptide_request_id": "018e9c20-9b0f-7b3a-9c1f-f7d3e9c3b1a2"
}
```

**Success (200):**

```json
{
  "coupon_code": "PEPT-7K3M-9X2Q",
  "issued_at": "2026-04-17T15:22:10Z"
}
```

Coupon config baked into the WC call: `discount_type: fixed_cart`, `amount: 250.00`, `individual_use: true`, `usage_limit: 1`, `usage_limit_per_user: 1`, no date restrictions (no expiry), no product restrictions. WC generates the code.

**Errors:**
- 401 `unauthorized`
- 502 `upstream_unavailable` (WC unreachable)

### POST `/v1/internal/senaite/services/clone`

Clone a SENAITE Analysis Service for a new peptide.

**Request body:**

```json
{
  "template_keyword": "BPC157-ID",
  "new_name": "Retatrutide - Identity (HPLC)",
  "new_keyword": "RETA-ID"
}
```

**`new_keyword` policy:** caller generates (e.g. `{UPPER(first 4 chars of compound_name, stripped of non-alnum)}-ID`). If duplicate in SENAITE, the endpoint returns 409 and caller retries with a suffix.

**Success (200):**

```json
{
  "service_uid": "9f3a2b1c8d4e5f6a7b8c9d0e1f2a3b4c",
  "title": "Retatrutide - Identity (HPLC)",
  "keyword": "RETA-ID"
}
```

**Errors:**
- 401 `unauthorized`
- 404 `not_found` (template_keyword missing in SENAITE)
- 409 `conflict` (new_keyword already exists)
- 502 `upstream_unavailable`

---

## Accu-Mk1 backend endpoints

Base URL: Accu-Mk1 production backend (e.g. `https://accumk1.accumarklabs.com`).

### POST `/api/peptide-requests`

Called by integration-service only.

**Auth:** Service-Secret
**Headers:**
- `X-Service-Token: <secret>`
- `Idempotency-Key: <uuid>` (forwarded from WP's Idempotency-Key)
- `Content-Type: application/json`

**Request body:** same as integration-service's WP-facing POST body, plus:

```json
{
  "submitted_by_wp_user_id": 4821,
  "submitted_by_email": "customer@example.com",
  "submitted_by_name": "Jane Customer",
  "... all other fields from the WP submit ..."
}
```

**Success (201):** returns `PeptideRequest` (full shape, not the WP projection).

**Success (200) on idempotent replay:** same body returned.

**Errors:**
- 400 `validation_error`
- 401 `unauthorized`
- 409 `conflict` (idempotency key mismatch)
- 500 `internal_error`

### GET `/api/peptide-requests`

Called by integration-service. Filter by `wp_user_id`.

**Auth:** Service-Secret
**Query params:**
- `wp_user_id`: required
- `status`: optional
- `limit`: optional, default 50
- `offset`: optional, default 0

**Success (200):**

```json
{
  "total": 12,
  "limit": 50,
  "offset": 0,
  "items": [ /* array of PeptideRequest */ ]
}
```

### GET `/api/peptide-requests/{id}`

**Auth:** Service-Secret
**Success (200):** `PeptideRequest`
**Errors:** 404 `not_found`

### POST `/webhooks/clickup`

Public webhook endpoint. Called by ClickUp.

**Auth:** ClickUp-Sig
**Headers:**
- `X-Signature: <sha256_hex>` (HMAC-SHA256 of the raw request body using `CLICKUP_WEBHOOK_SECRET`)
- `Content-Type: application/json`

**Request body:** ClickUp's webhook payload. Relevant event types (others are ignored):

**`taskStatusUpdated`:**

```json
{
  "event": "taskStatusUpdated",
  "task_id": "86a1m2z",
  "history_items": [
    {
      "id": "event_018e9c...",
      "field": "status",
      "before": {"status": "approved", "type": "custom"},
      "after":  {"status": "ordering standard", "type": "custom"},
      "user": {"id": "cu_u_1234", "username": "jane.tech", "email": "jane@lab.com"},
      "date": "1713367890000"
    }
  ]
}
```

The handler uses `history_items[0].id` as `clickup_event_id` for dedup. `history_items[0].after.status` is the new column name (matched against `CLICKUP_COLUMN_MAP` case-insensitively with whitespace collapsed).

**`taskAssigneeUpdated`:**

```json
{
  "event": "taskAssigneeUpdated",
  "task_id": "86a1m2z",
  "assignees": [
    {"id": "cu_u_1234", "username": "jane.tech", "email": "jane@lab.com"},
    {"id": "cu_u_5678", "username": "bob.tech", "email": "bob@lab.com"}
  ],
  "history_items": [ /* one entry per assignee change; used for actor resolution */ ]
}
```

The handler overwrites `clickup_assignee_ids` with the full new list from `assignees[].id`.

**Success (200):** always, including on:
- Signature pass + unmapped column (logged + alerted, not retried)
- Signature pass + dedup hit (idempotent)
- Signature pass + unknown event type (silently ignored)

**Failure:**
- 401 `unauthorized` (bad signature)
- 500 `internal_error` (only for genuine handler faults — DB down, etc; ClickUp will retry)

---

## wpstar (accumarklabs) endpoints

Base URL: `https://accumarklabs.com`.

### POST `/wp-json/accumark/v1/internal/peptide-request-status`

Called by integration-service on status change. Stores the snapshot for portal rendering and triggers the email template.

**Auth:** Service-Secret (header `X-Service-Token`)
**Request body:** same as integration-service's `/v1/internal/wp/peptide-request-status` body (pass-through).

**Success (200):**

```json
{
  "stored": true,
  "email_queued": true
}
```

**Storage mechanism:** wpstar persists this snapshot to a custom table `wp_peptide_request_status` (or equivalent) keyed by `peptide_request_id`. The portal pages render from this snapshot; they do NOT call integration-service on every page view.

**Email templates:** the WP side owns the actual email templates. Template selection is by `new_status`:
- `approved` → "Your new peptide request has been approved" template
- `rejected` → "Update on your peptide request" template (includes `rejection_reason`)
- `completed` → "Your peptide is now available" template (includes `wp_coupon_code` fetched from portal data)

**Errors:**
- 401 `unauthorized`
- 500 `internal_error`

### Coupon creation — uses existing WC REST

integration-service calls `POST /wp-json/wc/v3/coupons` directly on WP, using existing WC consumer credentials. No new wpstar endpoint needed. Request body follows WC REST v3 coupon schema, as specified in the `/v1/internal/wp/coupons/single-use` section above.

---

## External: ClickUp API (adapter shape, called by Accu-Mk1)

Accu-Mk1's ClickUp client uses the ClickUp v2 API directly. Reference shape only — full API docs at [developer.clickup.com](https://developer.clickup.com).

### Create task

`POST https://api.clickup.com/api/v2/list/{CLICKUP_LIST_ID}/task`

**Headers:**
- `Authorization: <CLICKUP_API_TOKEN>`
- `Content-Type: application/json`

**Request body (our template):**

```json
{
  "name": "[peptide] Retatrutide — PepMart Labs",
  "description": "Submitted via WP.\n\n**Customer:** Jane Customer <customer@example.com>\n**Kind:** peptide\n**Vendor/producer:** PepMart Labs\n**Sequence/structure:** YAE(C6)...\n**Molecular weight:** 4731.3\n**CAS/reference:** 2381089-83-2\n**Vendor catalog #:** PML-RETA-001\n**Expected monthly volume:** 30\n**Reason/notes:** Offering to customers in Q3\n\n[Open in Accu-Mk1](https://accumk1.accumarklabs.com/requests/018e9c20-...)",
  "status": "New",
  "assignees": [],
  "priority": null
}
```

`assignees: []` implements the "unassigned — techs pull from New" default decision. Change if the open item on assignee policy is overridden in plan phase.

**Response (201):** `{"id": "86a1m2z", "url": "https://app.clickup.com/t/86a1m2z", ...}`. Accu-Mk1 stores `id` as `clickup_task_id`.

---

## Freeze point

**Before plan execution begins, this document must be marked frozen.** Any agent that proposes a deviation must halt and surface it — schema changes during parallel execution will cause silent integration failures.

Frozen signoff: **approved 2026-04-17** — any deviation by an executing agent must halt and surface the proposed change for re-alignment.
