# Peptide Request Flow

End-to-end reference for the peptide/compound testing request feature: WP submission → Accu-Mk1 entity → ClickUp task → lab workflow → on-completion side effects (WooCommerce coupon + SENAITE Analysis Service clone).

## Overview

A customer on the WordPress site fills out a form requesting that Accumark add testing for a new peptide (or other compound). That form submission becomes:

1. A canonical **peptide request** record in Accu-Mk1 Postgres.
2. A **ClickUp task** in the lab's workflow list.
3. Lab staff move the task through ClickUp columns as work progresses.
4. On `completed`, Accu-Mk1 issues a WooCommerce discount coupon to the customer and clones the SENAITE Analysis Service template so the new compound is immediately testable.

The customer sees status updates on the WP site; the lab operates entirely in ClickUp; Accu-Mk1 is the source of truth for the record and fires the side effects.

## Architecture

Three systems participate:

| System                | Role                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| WordPress (WP)        | Customer-facing form + status display + WooCommerce coupon issuance  |
| `integration-service` | Narrowly scoped bridge: relays WP ↔ Accu-Mk1 HTTP calls              |
| Accu-Mk1              | Canonical entity store, ClickUp integration, SENAITE integration     |

**Canonical record lives in Accu-Mk1 Postgres.** WP and ClickUp are views / workflow surfaces. The **status source of truth is the ClickUp column** for the task, mapped to a Postgres enum value via configuration. Column renames don't break the system — the mapping does.

`integration-service` has no domain logic for peptide requests. It forwards validated WP payloads to Accu-Mk1's internal API and relays status updates back to WP. All LIMS-facing integrations (ClickUp, SENAITE, WooCommerce coupon API) live in Accu-Mk1.

## Postgres Tables

Three tables, all in the default schema.

### `peptide_requests`

The main entity.

- `id` (UUID, pk)
- `idempotency_key` (text, unique) — derived from WP form submission; dedupes retries
- Submitter fields: `wp_user_id`, `submitter_email`, `submitter_name`
- Compound fields: `compound_name`, `compound_kind` (`peptide` | `other`), `molecular_weight`, `sequence`, `notes`
- `status` (enum, see below), `previous_status` (for `on_hold` restoration)
- `clickup_task_id` (text, nullable until inline create succeeds)
- `senaite_service_uid` (text, nullable until completion)
- `wp_coupon_code` (text, nullable until completion)
- Four **terminal timestamp** columns: `approved_at`, `completed_at`, `rejected_at`, `cancelled_at`
- Four **failure timestamp** columns: `clickup_create_failed_at`, `wp_relay_failed_at`, `coupon_failed_at`, `senaite_clone_failed_at`
- Standard `created_at`, `updated_at`

### `peptide_request_status_log`

Append-only audit log of every status transition.

- Row per status change with `from_status`, `to_status`, `changed_at`, `source` (`clickup` | `admin` | `system`), actor details
- `clickup_event_id` (text, nullable) with a **unique partial index** — dedupes replayed ClickUp webhooks while still allowing non-ClickUp log rows

### `clickup_user_mapping`

Reconciles ClickUp users to Accu-Mk1 users. Populated automatically when email matches, otherwise flagged for manual admin reconciliation.

- `clickup_user_id`, `clickup_username`, `clickup_email`
- `accumk1_user_id` (`INTEGER`, fk to `users.id`, `ON DELETE SET NULL`)
- `mapped_at`, `mapped_by`, `mapping_source` (`auto` | `manual`)

## API Endpoints

All internal endpoints are gated by the `X-Service-Token` header (shared secret with `integration-service`). ClickUp webhooks use HMAC instead.

| Method | Path                                                  | Purpose                                            |
| ------ | ----------------------------------------------------- | -------------------------------------------------- |
| POST   | `/api/peptide-requests`                               | `integration-service` submits on behalf of WP       |
| GET    | `/api/peptide-requests?wp_user_id=X&status=csv`       | List for a customer (status filter CSV, optional)   |
| GET    | `/api/peptide-requests/{id}`                          | Detail                                              |
| GET    | `/api/peptide-requests/{id}/history`                  | Status log entries for a request                    |
| POST   | `/webhooks/clickup`                                   | ClickUp webhook receiver (HMAC-signed)              |
| GET    | `/api/admin/clickup-users/unmapped`                   | List ClickUp users awaiting reconciliation          |
| POST   | `/api/admin/clickup-users/{id}/map`                   | Admin maps a ClickUp user to an Accu-Mk1 user       |

Frozen HTTP shapes: see [`docs/superpowers/specs/2026-04-17-peptide-request-contracts.md`](../superpowers/specs/2026-04-17-peptide-request-contracts.md).

## Webhook Dispatch Flow

`POST /webhooks/clickup` handler:

1. **Signature verify** — reject if HMAC doesn't match `CLICKUP_WEBHOOK_SECRET`.
2. **Parse body** — extract event type, task id, payload.
3. **Dispatch** — `dispatch_event` routes on event type:
   - `taskStatusUpdated` → status transition path
   - `taskCreated` → **manual-origin materialization** — creates a new `peptide_requests` row with `source='manual'` when a lab staffer creates a task directly in ClickUp (not via the WP form). Pulls `compound_name` / `molecular_weight` / `sequence` / `notes` / `sample_id` from custom fields if present. Marked with a visual badge in the LIMS list so they're distinguishable from WP-originated rows.
   - `taskDeleted` → **retire** the corresponding Accu-Mk1 row by writing `retired_at = NOW()`. Soft-delete only — the row stays in Postgres but hides from the Active tab and shows a "Retired" badge on Closed. Never physically deletes.
   - `taskUpdated` → **field sync** — handles two sub-cases: task-name changes (updates `compound_name` if different) and custom-field edits (writes into the matching `peptide_requests` column). Feeds the field-drift resolution flow below.
   - `taskAssigneeUpdated` → assignee sync (no state change on the request itself)
   - Unknown event → log and 200
4. **Status transition**:
   - Map the new ClickUp column to a peptide request status via `DEFAULT_COLUMN_MAP`. Unmapped columns log `ERROR` and return 200 (no state change — safer than 4xx which ClickUp retries).
   - Update `peptide_requests.status`, append `peptide_request_status_log` row.
   - **Dedup**: the unique partial index on `clickup_event_id` means replayed webhooks short-circuit at INSERT.
   - On successful transition, enqueue `relay_status_to_wp` (daemon thread).
   - If new status is `completed`, also enqueue `completion_side_effects` (daemon thread).

## Bidirectional Field Sync

`taskUpdated` handles one edit at a time (push from ClickUp → Postgres). For detecting
rows that are already out of sync — e.g. because the webhook was missed, or a batch of
edits was made while the service was down — there's a manual reconciliation flow.

**UI entry point:** "Sync from ClickUp" button on the peptide requests list page opens a
modal (`SyncFromClickUpModal`) that calls `GET /sync/diff` and renders three buckets:

| Bucket               | Meaning                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `new_in_clickup`     | Task exists in ClickUp but not in Postgres → create row (same outcome as a missed `taskCreated`)   |
| `missing_in_clickup` | Row exists in Postgres but the ClickUp task is gone → retire row (same outcome as `taskDeleted`)   |
| `field_drift`        | Row + task both exist but individual fields disagree → **human picks** DB or ClickUp value per field |

The `field_drift` bucket is deliberately non-automatic. Automatic last-write-wins is the
wrong policy when lab staff edit both surfaces concurrently. The modal renders a
DB-vs-ClickUp picker per field; `POST /sync/apply` commits the chosen values in both
directions (Postgres via `repo.update_fields`, ClickUp via `set_custom_field`).

### Inline editing

The detail page also supports inline editing of `sample_id` — the PATCH endpoint updates
the row and pushes the change to ClickUp as a custom-field write in the same request.
Saves an extra round-trip through the sync modal for the most common edit.

## Provenance: `source` and `retired_at`

Two columns on `peptide_requests` capture lifecycle provenance:

| Column       | Values                         | Meaning                                                              |
| ------------ | ------------------------------ | -------------------------------------------------------------------- |
| `source`     | `wp` (default) \| `manual`     | `wp` = customer submitted via form; `manual` = lab created via ClickUp `taskCreated` |
| `retired_at` | timestamp \| NULL              | Set when ClickUp task is deleted. Non-null = hidden from Active tab. |

The Active tab filters on `retired_at IS NULL`. The Closed tab shows everything else and
renders a "Retired" badge on rows with `retired_at IS NOT NULL`. Manual-origin rows
(`source='manual'`) are flagged with a separate badge in both tabs so they're
distinguishable from WP customer submissions.

## Status Enum

Nine values:

| Status                  | Meaning                                           |
| ----------------------- | ------------------------------------------------- |
| `new`                   | Submitted, not yet triaged                        |
| `approved`              | Lab accepted the request                          |
| `ordering_standard`     | Reference standard being ordered                  |
| `sample_prep_created`   | Sample prep logged in LIMS                        |
| `in_process`            | Active lab work                                   |
| `on_hold`               | Paused — `previous_status` preserves restore point |
| `completed`             | Terminal, triggers coupon + SENAITE clone         |
| `rejected`              | Terminal, lab declined                            |
| `cancelled`             | Terminal, customer withdrew                       |

`on_hold` is the only non-terminal status that restores the prior status on resume; `previous_status` is written when entering `on_hold` and read when leaving.

## Config / Env Vars

| Variable                           | Purpose                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `CLICKUP_LIST_ID`                  | ClickUp list where peptide request tasks are created                   |
| `CLICKUP_API_TOKEN`                | ClickUp API personal token                                             |
| `CLICKUP_WEBHOOK_SECRET`           | HMAC secret for webhook signature verification                         |
| `ACCUMK1_INTERNAL_SERVICE_TOKEN`   | Shared secret with `integration-service` (inbound `X-Service-Token`)   |
| `INTEGRATION_SERVICE_URL`          | Base URL for outbound WP-relay calls                                   |
| `INTEGRATION_SERVICE_TOKEN`        | Bearer for outbound calls to `integration-service`                     |
| `SENAITE_PEPTIDE_TEMPLATE_KEYWORD` | SENAITE template keyword to clone (default: `BPC157-ID`)               |
| `ACCUMK1_BASE_URL`                 | Base URL injected into ClickUp task descriptions for deep links        |
| `MK1_DB_HOST`                      | Postgres host — `localhost` in dev, `host.docker.internal` in prod     |
| `CLICKUP_FIELD_COMPOUND_KIND`      | ClickUp custom-field UUID for `compound_kind` (dropdown)               |
| `CLICKUP_FIELD_MOLECULAR_WEIGHT`   | ClickUp custom-field UUID for `molecular_weight` (number)              |
| `CLICKUP_FIELD_SEQUENCE`           | ClickUp custom-field UUID for `sequence` (short text)                  |
| `CLICKUP_FIELD_SAMPLE_ID`          | ClickUp custom-field UUID for `sample_id` (short text)                 |
| `CLICKUP_OPT_PEPTIDE`              | ClickUp option ID for `compound_kind=peptide` in the dropdown field    |
| `CLICKUP_OPT_OTHER`                | ClickUp option ID for `compound_kind=other` in the dropdown field      |
| `CLICKUP_OPT_PENDING`              | ClickUp option ID for any intake-pending dropdown state (reserved)     |
| `CLICKUP_OPT_VERIFIED`             | ClickUp option ID for verified/confirmed dropdown state (reserved)     |
| `PEPTIDE_SENAITE_CLONE_ENABLED`    | Feature flag (default `false`) — gates the SENAITE clone side-effect   |
| `PEPTIDE_COUPON_ENABLED`           | Feature flag (default `false`) — gates the WooCommerce coupon issue    |

**Feature flags:** Both completion side-effects ship gated off. Flip `PEPTIDE_COUPON_ENABLED=true`
once the WooCommerce REST creds are wired through integration-service. Flip
`PEPTIDE_SENAITE_CLONE_ENABLED=true` only after the SENAITE clone endpoint is implemented
on integration-service (currently deferred — lab tech clones the `BPC157-ID` template
manually; see handoff note for rationale).

**ClickUp custom-field IDs:** The `CLICKUP_FIELD_*` UUIDs are list-scoped — they're
re-issued if you clone the ClickUp list or move to a different workspace. Pull the
current values from the ClickUp API's `/list/{id}/field` endpoint and re-inject into
`.env` after any list migration.

## Adding a New ClickUp Column

Two options:

1. Edit `DEFAULT_COLUMN_MAP` in `backend/peptide_request_config.py` (source default).
2. Or override via the runtime config mechanism — the config value wins over the default.

Unmapped columns are **not** fatal: the webhook handler logs an `ERROR` with the column name and returns 200. No state change occurs. Fix the map, then manually replay if needed.

## SENAITE Naming — Load-Bearing

On `completed`, Accu-Mk1 clones the SENAITE Analysis Service whose keyword matches `SENAITE_PEPTIDE_TEMPLATE_KEYWORD` (default `BPC157-ID`), then renames the clone.

**Naming rule:**

- Service **name**: `{compound_name} - Identity (HPLC)` (e.g. `Retatrutide - Identity (HPLC)`)
- Service **keyword**: `{first 4 alphanumerics of compound_name, uppercased}-ID` (e.g. `RETA-ID`)

This pattern is load-bearing — downstream Senaite scripts, reports, and the reset-verified-analyses runbook all rely on the `{Name} - Identity (HPLC)` convention. Do not alter the format without auditing consumers.

## Non-Peptide Path

When `compound_kind='other'`, the SENAITE clone step is skipped. The coupon still issues. An Accumark staffer must manually configure the SENAITE catalog entries for non-peptide testing. The request flows through ClickUp identically.

## Retry Strategy

Three failure surfaces, each handled independently so one failure never blocks the others.

### Inline ClickUp create + sweeper

- `POST /api/peptide-requests` attempts ClickUp task creation inline.
- If inline creation fails, the row is still persisted with `clickup_task_id = NULL`.
- A background `run_once` job (manual-invoke for v1) sweeps rows matching:
  `clickup_task_id IS NULL AND clickup_create_failed_at IS NULL AND created_at < NOW() - 60 seconds`
- After **24 hours** of retry failures, `clickup_create_failed_at` is set and the row is left for manual intervention.

### WP relay (outbound status push)

- On-dispatch **daemon thread** with delay schedule: `[0, 60, 300, 900, 3600, 14400]` seconds.
- On exhaustion, sets `wp_relay_failed_at` and gives up. WP eventually polls and reconciles.

### Completion side effects

- Daemon thread runs `issue_coupon()` and `clone_senaite_service()` **independently** — a failure in one does not block the other.
- Failures set `coupon_failed_at` or `senaite_clone_failed_at` respectively.
- Both are manually re-runnable from the admin UI.

## Known Issues / Pre-Merge Decisions

All pre-merge items resolved. LIMS admin endpoints are gated on `require_admin` (role check) as of this commit.

## Integration Test Entry Point

`backend/tests/test_e2e_peptide_request.py::test_happy_path` exercises the full flow with mocked HTTP (WP submit → Accu-Mk1 persist → ClickUp create → webhook replay → status transitions → completion side effects). Start there when adding coverage for a new branch.

## Related Docs

- HTTP contracts: [`docs/superpowers/specs/2026-04-17-peptide-request-contracts.md`](../superpowers/specs/2026-04-17-peptide-request-contracts.md)
- SENAITE reset runbook (adjacent ops): [`senaite-reset-verified-analyses.md`](./senaite-reset-verified-analyses.md)
- Architecture overview: [`architecture-guide.md`](./architecture-guide.md)
