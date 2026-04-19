# Peptide / Compound Testing Request — Design Spec

**Date:** 2026-04-17
**Status:** Draft — brainstorming complete, pending plan phase
**Touches:** WordPress customer plugin, integration-service, Accu-Mk1, ClickUp (new), SENAITE (during phase-out)

---

## 1. Scope & Summary

Customers on the WordPress site can submit a request for Accumark to add testing for a peptide or other compound that isn't yet in the catalog. The request is persisted as an entity in Accu-Mk1 (canonical record, Postgres) and surfaces in ClickUp as a task where the lab actually works it — ordering the reference standard, validating the method, and either completing or rejecting.

Status changes the tech makes in ClickUp flow back to Accu-Mk1 via webhook, and from Accu-Mk1 to WP via integration-service, so the customer sees live status on their `/portal/` account. On successful completion, Accu-Mk1 fires two side-effects:

1. **Peptide path only:** clone an existing SENAITE Analysis Service (template: BPC-157) with the naming convention `{compound_name} - Identity (HPLC)`, so the new peptide appears in the WP order-form dropdown on next sync.
2. **Both paths:** issue a single-use full-cart $250 coupon to the requesting customer, displayed on their request detail page.

Shipping approach: **big-bang v1** — everything lands together.

---

## 2. Architecture

```
[WP /portal/new-peptide-request/]
        │  POST request (HMAC signed + nonce)
        ▼
[integration-service]  ── thin pass-through: HMAC validation, nonce check,
        │                                     JWT for reads, internal auth forward
        │  POST /api/peptide-requests (internal service auth)
        ▼
[Accu-Mk1 backend]
    ├── Postgres: peptide_requests (canonical record)
    │             peptide_request_status_log (append-only audit)
    │             clickup_user_mapping
    ├── ClickUp client ─── POST /task ───▶ [ClickUp]
    │                                          │
    │                     status changes       │
    │   ◀── webhook POST (HMAC-SHA256 verified)┘
    │
    ├── Rule map (config): ClickUp column → entity.status enum
    ├── On status change → side-effect dispatcher (background job)
    │
    └── On status=Completed:
          · integration-service → WP coupon (WooCommerce REST)
          · if peptide_kind: integration-service → SENAITE service clone

[WP /portal/requests/] ── list + detail ──▶ integration-service ──▶ Accu-Mk1
```

### Key architectural decisions

- **Canonical record lives in Accu-Mk1 Postgres.** Not ClickUp, not integration-service. Accu-Mk1 is the primary LIMS.
- **ClickUp credentials live in Accu-Mk1 backend.** LIMS-operational external integrations belong inside the LIMS. integration-service is narrowly scoped to WordPress bridging.
- **ClickUp webhooks hit Accu-Mk1 directly** at a public signature-verified endpoint. The Accu-Mk1 web app is publicly reachable in production.
- **integration-service is a thin proxy** in both directions between WP and Accu-Mk1 for this feature. It owns HMAC/nonce/JWT and the WP + SENAITE adapters; it does not own peptide-request business logic.
- **ClickUp columns are the status UI source of truth.** Tech moves cards, webhook propagates to Accu-Mk1, which is the system of record. A config-driven rule map translates column names to an internal status enum so renaming columns is a config update, not a code change.
- **Side-effects on Completed are independent.** Coupon creation and SENAITE service clone are separate background jobs. One failing does not block the other.

---

## 3. Data model (Accu-Mk1 Postgres)

### Table `peptide_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `created_at`, `updated_at` | timestamptz | |
| `idempotency_key` | text | Client-supplied from WP; unique per submission |
| `submitted_by_wp_user_id` | int | WP user ID |
| `submitted_by_email`, `submitted_by_name` | text | Snapshot at submission; don't re-fetch |
| `compound_kind` | enum `peptide \| other` | Chosen on form; drives automation path at Completed |
| `compound_name` | text NOT NULL | |
| `vendor_producer` | text NOT NULL | Where the customer is buying the material from |
| `sequence_or_structure` | text NULL | |
| `molecular_weight` | numeric NULL | |
| `cas_or_reference` | text NULL | |
| `vendor_catalog_number` | text NULL | |
| `reason_notes` | text NULL | |
| `expected_monthly_volume` | int NULL | Samples per month |
| `status` | enum NOT NULL | See status enum below |
| `previous_status` | enum NULL | Where to return from `on_hold` |
| `rejection_reason` | text NULL | Free text (no picklist) |
| `sample_id` | text NULL | Accu-Mk1 internal sample ID, linked by tech at/after `sample_prep_created`. `text`, not FK, until sample catalog moves into Accu-Mk1 Postgres. |
| `clickup_task_id` | text NULL | |
| `clickup_list_id` | text NOT NULL | Config-driven |
| `clickup_assignee_ids` | jsonb | Array of ClickUp user IDs currently assigned; updated on webhook |
| `senaite_service_uid` | text NULL | Populated on Completed (peptide path only) |
| `wp_coupon_code` | text NULL | Populated on Completed |
| `wp_coupon_issued_at` | timestamptz NULL | |
| `completed_at`, `rejected_at`, `cancelled_at` | timestamptz NULL | |
| `clickup_create_failed_at` | timestamptz NULL | After retry exhaustion |
| `coupon_failed_at` | timestamptz NULL | After retry exhaustion |
| `senaite_clone_failed_at` | timestamptz NULL | After retry exhaustion |
| `wp_relay_failed_at` | timestamptz NULL | After retry exhaustion |

**Unique index:** `(submitted_by_wp_user_id, idempotency_key)` — dedupes duplicate WP submissions.

### Status enum

`new` → `approved` → `ordering_standard` → `sample_prep_created` → `in_process` → `completed`

Off-ramps (reachable from any active state):
- `on_hold` (reversible; uses `previous_status` to return)
- `rejected` (terminal)
- `cancelled` (terminal)

### Table `peptide_request_status_log` (append-only)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `peptide_request_id` | UUID FK → peptide_requests | |
| `from_status`, `to_status` | enum | |
| `source` | enum `clickup \| accumk1_admin \| system` | |
| `clickup_event_id` | text NULL | Dedup key for webhook events |
| `actor_clickup_user_id` | text NULL | From webhook `history_items[].user.id` |
| `actor_accumk1_user_id` | UUID NULL | Resolved at log-write time via `clickup_user_mapping`; snapshotted |
| `note` | text NULL | Comment snapshot or rejection reason |
| `created_at` | timestamptz | |

**Unique index:** `(clickup_event_id)` where not null — webhook idempotency.

### Table `clickup_user_mapping`

| Column | Type | Notes |
|---|---|---|
| `clickup_user_id` | text PK | |
| `accumk1_user_id` | UUID FK (users) NULL | Null = unmapped |
| `clickup_username` | text | Display snapshot |
| `clickup_email` | text | Used for auto-matching |
| `auto_matched` | bool | True if resolved by email; false if admin-set |
| `created_at`, `updated_at`, `last_seen_at` | timestamptz | |

**Lazy-creation flow:** On each webhook, look up by `clickup_user_id`. If not found, insert a row, attempt email auto-match against `users.email`; if matched, set `accumk1_user_id` and `auto_matched = true`. If no match, leave `accumk1_user_id` NULL. Admin reconciles unmapped rows via `/admin/clickup-users/`.

### Config (application-level, not DB)

```
CLICKUP_WORKSPACE_ID = "<id>"
CLICKUP_LIST_ID = "<id>"
CLICKUP_API_TOKEN = "<secret>"
CLICKUP_WEBHOOK_SECRET = "<secret>"

CLICKUP_COLUMN_MAP = {
  "New":                  "new",
  "Approved":             "approved",
  "Ordering Standard":    "ordering_standard",
  "Sample Prep Created":  "sample_prep_created",
  "In Process":           "in_process",
  "On Hold":              "on_hold",
  "Completed":            "completed",
  "Rejected":             "rejected",
  "Cancelled":            "cancelled",
}

SENAITE_PEPTIDE_TEMPLATE_KEYWORD = "BPC157-ID"
```

Unmapped column names arriving via webhook: log + alert admin; return 200 (do not NACK). Changing the map is a config deploy.

---

## 4. Flows

### Flow A — Submission (customer → Accu-Mk1 → ClickUp)

1. Customer logged into WP, navigates to `/portal/new-peptide-request/`, fills form.
2. WP plugin generates UUID idempotency key, POSTs to `https://integration.accumarklabs.com/v1/peptide-requests` using the existing WP → integration-service auth pattern (JWT-authenticated customer request, with nonce/replay protection on the endpoint).
3. integration-service: validate auth, reject replays, verify the authenticated WP user matches the payload's `submitted_by_wp_user_id`.
4. integration-service → Accu-Mk1: `POST /api/peptide-requests` with internal service auth.
5. Accu-Mk1 transaction:
   - Check unique `(wp_user_id, idempotency_key)`; if exists, return prior ID.
   - Insert `peptide_requests` row with `status = 'new'`, `clickup_task_id = NULL`.
   - Commit.
6. Accu-Mk1 → ClickUp: create task in `CLICKUP_LIST_ID`. Title: `[{compound_kind}] {compound_name} — {vendor_producer}`. Description: templated from form fields with deep link back to Accu-Mk1 request detail.
7. On ClickUp success: update row with `clickup_task_id`, append status log entry (`source = 'system'`).
8. Return 201 to integration-service → 201 to WP with request ID.

**Failure modes:**
- **ClickUp down / rate-limited (step 6):** row exists with `clickup_task_id = NULL`. The `create_clickup_task_retry` background job finds these, retries with backoff. Customer still sees their request on WP at status `new`.
- **Accu-Mk1 down:** integration-service returns 502. WP shows retry-able error.
- **Duplicate submission:** WP idempotency key + unique index prevents duplicates. Returning the prior ID is a 200, not a 201.

### Flow B — Status sync (ClickUp → Accu-Mk1 → WP)

1. Tech moves card from `Approved` to `Ordering Standard` in ClickUp.
2. ClickUp POSTs to `https://accumk1.accumarklabs.com/webhooks/clickup` with `X-Signature-Sha256` header.
3. Webhook handler:
   - Verify HMAC-SHA256 signature against `CLICKUP_WEBHOOK_SECRET` using constant-time comparison. Bad sig → 401, no retry.
   - Dedup: if `clickup_event_id` already in `peptide_request_status_log`, return 200 without action.
   - Resolve actor via `clickup_user_mapping` (lazy-create if unseen; attempt email auto-match).
   - Dispatch by event type:
     - **`taskStatusUpdated`:** extract new column name. Map column → status enum. If unmapped: log + alert admin; return 200. Update `peptide_requests.status`, `updated_at`. On transition *into* `on_hold`: set `previous_status`. On transition to terminal state: set the relevant `*_at` column. Append status log entry with actor, event ID, comment snapshot (if rejection, the comment becomes `rejection_reason`).
     - **`taskAssigneeUpdated`:** replace `peptide_requests.clickup_assignee_ids` with the new assignee list from the payload. No status log entry (audit is status-focused).
     - **Other event types:** ignored for now; return 200.
4. Fire side-effects asynchronously via background jobs:
   - On `approved` / `rejected` / `completed`: enqueue `relay_status_to_wp`.
   - On `completed`: enqueue `fire_completion_side_effects` (Flow C).

**Failure modes:**
- **Bad signature:** 401, no retry from ClickUp.
- **Unmapped column:** 200 + alert. Status stays stale until admin updates config.
- **WP relay failure:** retry with exponential backoff (1m, 5m, 15m, 1h, 4h). After exhaustion, set `wp_relay_failed_at`, alert admin, surface in admin UI.
- **Missed webhook:** accepted risk for v1. Mitigation (v2): periodic reconciliation job diffs ClickUp list state against Accu-Mk1.

### Flow C — Completion side-effects (Accu-Mk1 → SENAITE + WP coupon)

Triggered by status transition into `completed`. Runs as a background job; coupon and SENAITE clone are independent sub-steps.

**Coupon (both peptide and non-peptide paths):**
1. Accu-Mk1 → integration-service: `POST /v1/internal/wp/coupons/single-use` with `{wp_user_id, amount_usd: 250, scope: 'full_cart', peptide_request_id}`.
2. integration-service → WP: `POST /wp-json/wc/v3/coupons` with existing WooCommerce credentials. Single-use full-cart coupon, no expiry, no product restriction.
3. WC returns a unique coupon code. integration-service returns it to Accu-Mk1.
4. Accu-Mk1 stores `wp_coupon_code`, `wp_coupon_issued_at`.

**SENAITE service clone (peptide path only):**
1. Accu-Mk1 → integration-service: `POST /v1/internal/senaite/services/clone` with `{template_keyword: 'BPC157-ID', new_name: '{compound_name} - Identity (HPLC)'}`.
2. integration-service → SENAITE: fetch BPC-157 service, clone, rename per the naming convention, publish. (This naming pattern is load-bearing — existing systems recognize peptides by it.)
3. Returns service UID. Accu-Mk1 stores `senaite_service_uid`.
4. On next WP peptide sync (existing `/v1/service/peptides`), the new peptide appears in the WP order-form dropdown automatically.

**Completion email:** delivered via Flow B's `relay_status_to_wp` when status is `completed`. WP email template embeds the coupon code and, for peptide path, confirms the peptide is now orderable.

**Failure modes:**
- **Coupon create fails:** retry 5× with backoff (1m, 5m, 15m, 1h, 4h). After exhaustion, set `coupon_failed_at`, alert admin, customer sees "Your coupon is being prepared."
- **SENAITE clone fails (peptide path):** retry 3× with backoff. After exhaustion, set `senaite_clone_failed_at`, alert admin. Flagged for manual intervention in Accu-Mk1 admin UI.
- **Non-peptide completion:** SENAITE step skipped entirely. Accu-Mk1 surfaces "Manual catalog setup required" banner on the admin detail page.

---

## 5. Surfaces

### WP customer surface (new plugin code, follows existing `/portal/` patterns)

- **Nav:** new left-nav item in `/portal/` → "New Peptide Request." Also CTA from the existing peptide order wizard: *"Don't see your peptide? Request we add it."*
- **`/portal/new-peptide-request/`** — form. Fields: compound kind (peptide/other radio), name (required), vendor/producer (required), sequence/structure, molecular weight, CAS/reference, vendor catalog number, reason/notes, expected monthly testing volume. Client + server validation. No attachments.
- **`/portal/requests/`** — list, two tabs: **Active** (`new`, `approved`, `ordering_standard`, `sample_prep_created`, `in_process`, `on_hold`) and **Closed** (`completed`, `rejected`, `cancelled`). Columns: compound name, kind, status, submitted date.
- **`/portal/requests/{id}/`** — detail. Current status, the customer's submitted fields (read-only), status history (timestamps only — no internal actor names), coupon code with "Use at checkout" button when `completed`, rejection reason when `rejected`. Emails link here.

### Accu-Mk1 LIMS surface

- **`/requests/`** — list with **Active** / **Closed** tabs. Filters: status, kind, assignee (resolved via mapping), date range. Search by compound name.
- **`/requests/{id}/`** — detail:
  - Customer block (name, email, WP user ID, link to customer profile if present).
  - Submission block (all form fields, read-only).
  - Status block: current status pill; full status timeline showing actor (via `clickup_user_mapping`), source, timestamp, note snapshot.
  - Links: "Open in ClickUp" (deep link using `clickup_task_id`), linked `sample_id` with link to sample detail.
  - Admin actions (role-gated): force-transition status, cancel, edit rejection reason, retry failed coupon, retry failed SENAITE clone.
  - Completion block (when `completed`): `senaite_service_uid` (linked to SENAITE), coupon code + issued timestamp.
- **`/admin/clickup-users/`** — mapping admin. Shows unmapped and auto-matched users; admin confirms matches or assigns manually.

### integration-service new endpoints

WP-facing (HMAC + nonce signed, JWT for authenticated reads):

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/peptide-requests` | Submit new request |
| GET | `/v1/peptide-requests?wp_user_id=X` | Customer's list |
| GET | `/v1/peptide-requests/{id}` | Customer's detail (ownership-checked) |

Internal (service auth, Accu-Mk1 → integration-service):

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/internal/wp/peptide-request-status` | Relay status to WP (email + page update) |
| POST | `/v1/internal/wp/coupons/single-use` | Issue WC coupon |
| POST | `/v1/internal/senaite/services/clone` | Clone SENAITE Analysis Service |

### Accu-Mk1 backend new endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/peptide-requests` | Internal service token | Called by integration-service (Flow A) |
| GET | `/api/peptide-requests?wp_user_id=X` | Internal service token | Called by integration-service (WP list) |
| GET | `/api/peptide-requests/{id}` | Internal service token | Called by integration-service (WP detail) |
| POST | `/webhooks/clickup` | Public, HMAC signature | ClickUp → Accu-Mk1 (Flow B) |

### WP plugin new handlers

- `POST /wp-json/accumark/v1/internal/peptide-request-status` — integration-service → WP; stores status snapshot (postmeta or custom table); triggers email templates.
- Coupon: integration-service calls WP's native `/wp-json/wc/v3/coupons` directly with existing WC REST credentials (no new plugin endpoint needed).
- Portal pages: read cached status snapshot locally; only fetch live on form submit, so pages stay up if integration-service is down.

---

## 6. Cross-cutting concerns

### Idempotency

- **Submission (WP → integration-service):** WP plugin generates UUID idempotency key per submit click. integration-service stores in Redis (TTL 10 min) and returns prior response on replay.
- **Accu-Mk1 insert:** unique index on `(submitted_by_wp_user_id, idempotency_key)` prevents duplicate rows.
- **ClickUp webhook:** `clickup_event_id` unique index in `peptide_request_status_log`.
- **Side-effects:** before firing coupon, check `wp_coupon_code` is null. Before firing SENAITE clone, check `senaite_service_uid` is null. Re-runs are safe.

### Retries & background jobs (Accu-Mk1's existing job queue — no new infra)

| Job | Trigger | Backoff |
|---|---|---|
| `create_clickup_task_retry` | every 5 min | 60s min age between attempts |
| `fire_completion_side_effects` | event (status→completed) | 1m, 5m, 15m, 1h, 4h |
| `relay_status_to_wp` | event (status→approved/rejected/completed) | 1m, 5m, 15m, 1h, 4h |

After final backoff exhaustion: set the relevant `*_failed_at` column, alert admin, surface in admin UI. No silent data loss.

### Consistency (dual-write Accu-Mk1 + ClickUp)

Ordering:
1. DB write first (inside transaction).
2. ClickUp call second, outside the transaction.
3. If ClickUp fails, row exists with `clickup_task_id = NULL`; retry job picks it up.

No distributed transactions. Customer sees their request immediately as `new`; ClickUp card may lag by a few minutes in the failure path.

### Security

- **WP → integration-service:** existing HMAC + nonce pattern.
- **integration-service → Accu-Mk1:** shared secret service token, rotated via env var.
- **ClickUp → Accu-Mk1 webhook:** HMAC-SHA256 of raw body using `CLICKUP_WEBHOOK_SECRET`, constant-time comparison. Bad signatures → 401 (no ClickUp retry on 401).
- **Coupon codes:** generated by WooCommerce (high entropy). Stored in Accu-Mk1 for display only.
- **No attachments** means no file-type or malware surface for v1.

### Observability

- Structured JSON logs at every boundary with `peptide_request_id`, `clickup_task_id`, `event_type`, `actor_clickup_user_id`.
- Metrics: submission count, ClickUp create failure rate, webhook dedup rate, side-effect retry count, unmapped-column warnings, coupon failure count, SENAITE clone failure count.
- Alerts: any `*_failed_at` populated → admin page. Unmapped ClickUp column name → admin page (indicates config drift).

### Testing strategy

**Unit (each repo, existing patterns):**
- Accu-Mk1: status transition validation, ClickUp column mapper, webhook signature verification, background job logic.
- integration-service: pass-through validation, HMAC round-trip, request/response schemas.
- WP plugin: form validation, portal page rendering, coupon display logic.

**Integration:**
- Accu-Mk1: webhook handler against real Postgres + fake ClickUp client; exercises dedup, unmapped columns, all happy transitions.
- integration-service: contract tests against WooCommerce REST + SENAITE REST with recorded fixtures.

**E2E (single happy path, CI on main):**
- Submit via WP test env → verify Accu-Mk1 row + ClickUp card → simulate `Completed` webhook → verify coupon created, SENAITE clone, WP status propagation, completion email.

**Manual QA checklist in the plan phase:** rejection flow, non-peptide flow, on-hold flow, cancellation (admin-initiated), admin mapping reconciliation, admin retry buttons, malformed/replayed webhooks.

---

## 7. Out of scope, open items, risks

### Explicitly out of scope for v1

- Customer-initiated cancellation from WP (internal-only cancellation).
- Reporting / analytics dashboards.
- Bulk admin operations.
- Field format validation beyond basic length/type (no sequence-format, MW sanity, or CAS checksum).
- Intake deduplication against existing catalog (tech rejects in ClickUp).
- Peptide name normalization (stored verbatim; tech edits before SENAITE clone if needed).
- Email template localization (English-only).
- Historical backfill of prior informal requests.
- Admin UI for editing the ClickUp column → status map (config file only; deploy required to change).
- Customer attachments (explicitly removed from scope).

### Open items (decide in plan phase, not blockers for spec)

1. **ClickUp assignee at task creation.** Default proposal: **unassigned** — techs pull from `New` column. Alternatives: lab manager always, or round-robin.
2. **integration-service internal auth for Accu-Mk1 calls.** Default proposal: **shared secret token**. Alternative: mutual TLS if already running mTLS elsewhere.
3. **Exact WP email templates** — wording, branding, link paths. Handled in implementation, not design.
4. **ClickUp list + column setup.** One-time manual setup outside code; spec assumes list and column names exist as specified.

### Known follow-ups (phase-out and tech debt)

- `sample_id` is `text`, not FK. Convert to FK when sample catalog migrates from SENAITE to Accu-Mk1 Postgres.
- SENAITE Analysis Service clone depends on BPC-157 template and SENAITE runtime. When SENAITE is decommissioned, this step becomes a direct Accu-Mk1 catalog entry.
- `CLICKUP_COLUMN_MAP` is config-driven to make a future move to a DB-backed admin UI cheap.

### Risks worth flagging

- **ClickUp webhook delivery.** Known delays and occasional drops. Dedup handles duplicates; missed events are the unmitigated risk. v2 mitigation: periodic reconciliation job diffs ClickUp list against Accu-Mk1.
- **BPC-157 template brittleness.** If BPC-157's SENAITE service is edited/deleted/renamed, every new peptide clone breaks. Mitigation: protect via SENAITE permissions or document as load-bearing.
- **Coupon abuse.** Single-use, full-cart, no expiry, no product restriction is simple but unprotected. $250 ceiling bounds the damage. Accepted risk for v1.
