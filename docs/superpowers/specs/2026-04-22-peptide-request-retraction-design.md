# Peptide Request Retraction — Design

**Date:** 2026-04-22
**Scope:** Allow a customer to hard-delete their own peptide request while it's still pre-approval (or post-rejection), with a ClickUp breadcrumb so the lab team can decide what to do.
**Branch:** `feat/peptide-request-v1` (additive — same big-bang cutover as the rest of the feature)
**Repos touched:** `Accu-Mk1`, `integration-service`, `accumarklabs` (wpstar)

---

## Goals

- Customer can retract an eligible peptide request from the detail page.
- Retraction is a **hard delete** in Accu-Mk1 (and in the wpstar snapshot).
- ClickUp task is **not** deleted; instead, a comment is dropped so the lab team sees the customer retracted and can decide whether to close the card or follow up.
- Retraction is blocked once real lab work is in motion.

## Non-goals

- No soft-delete/archive semantics. No audit table for retracted requests.
- No customer-facing or staff-facing email on retraction (ClickUp comment is the only signal).
- No ClickUp column move on retraction (card stays where it was).
- No "undo retract" / restore flow.
- No rate limiting beyond what already applies to the portal.

## Deletion gate

Retraction allowed iff `peptide_requests.status ∈ {"new", "rejected"}`.

Rationale: `new` is the internal pre-approval value (ClickUp column `requested` maps to it via `DEFAULT_COLUMN_MAP` in `backend/peptide_request_config.py`); it's the state the customer asked for. `rejected` is a terminal state where letting the customer declutter their list is harmless. Anything else (`approved`, `ordering_standard`, `sample_prep_created`, `in_process`, `on_hold`, `completed`, `cancelled`) means staff action has begun or finished, so the customer can't remove the record unilaterally.

Gate is enforced **authoritatively in Accu-Mk1** on every request. wpstar pre-hides the button based on the local snapshot status, but that's cosmetic — a stale snapshot letting a customer click through yields a 409 from Accu-Mk1, surfaced as a friendly "This request can no longer be retracted" message with a page reload.

## User flow

On `/portal/peptide-request/?id={uuid}`:

1. If `status ∈ {"new", "rejected"}`, render a **"Retract this request"** button below the status card. Destructive styling: red outline, not filled, to discourage accidental clicks.
2. Click → modal: `Retract this request? This cannot be undone.` + optional textarea labeled `Reason (optional)` (≤500 chars) + `Cancel` / `Retract` buttons.
3. `Retract` → `POST /wp-json/accumark/v1/peptide-requests/{id}/retract` with `{reason?: string}`.
4. On 200 → redirect to `/portal/peptide-requests/` with flash: `Request retracted.`
5. On 409 → modal swaps to `This request can no longer be retracted` + `Close`; closing reloads the page to show current state.
6. On other errors → modal shows a generic error, `Retract` button stays enabled for retry.

## API surface

### wpstar — `POST /wp-json/accumark/v1/peptide-requests/{id}/retract`

- Auth: logged-in WP user (reject anonymous with 401).
- Body: `{reason?: string}` — trim, cap at 500 chars, reject request with 400 if longer.
- Load snapshot row by `{id}`. 404 if missing. 403 if `wp_user_id != get_current_user_id()`.
- Mint HS256 JWT (same helper as the submit proxy).
- Forward to integration-service `POST /v1/peptide-requests/{id}/retract`.
- On 200: `DELETE FROM wp_peptide_request_status WHERE request_id = %s`, return `{ok: true}`.
- On 4xx/5xx from upstream: pass the error envelope straight through with the same status code.

### integration-service — `POST /v1/peptide-requests/{id}/retract`

- JWT-verified (same middleware as submit endpoint).
- Body passthrough: `{reason?: string}`.
- Forwards to Accu-Mk1 `POST /peptide-requests/{id}/retract` with:
  - `X-Service-Token: ${ACCUMK1_INTERNAL_SERVICE_TOKEN}`
  - `Idempotency-Key: {id}:retract`
- Error envelope is the standard global envelope already added in commit `a0d7ec8`.

### Accu-Mk1 — `POST /peptide-requests/{id}/retract` (authoritative)

- Auth: `X-Service-Token` required (matches existing internal-service middleware).
- Body: `{reason?: string}`.
- Flow:
  1. `SELECT * FROM peptide_requests WHERE id = %s` — 404 envelope if missing.
  2. Gate — if `status ∉ {"new", "rejected"}`, return `409 {error: "request_not_retractable", message: "This request can no longer be retracted.", current_status: "<status>"}`.
  3. ClickUp comment (best-effort, non-blocking) — see ClickUp section.
  4. `DELETE FROM peptide_requests WHERE id = %s`.
  5. Return `200 {ok: true}`.

### Why POST, not DELETE

Body payload (reason) + matches existing `/peptide-requests` POST+headers auth middleware. DELETE-with-body works but some proxies and HTTP clients strip it. Not worth the interop risk for a low-volume endpoint.

## Authorization chain

| Layer | Verifies | Notes |
|---|---|---|
| wpstar | WP session + `wp_user_id` matches snapshot row owner | Only layer that knows customer identity |
| integration-service | HS256 JWT from wpstar | Trusts wpstar's ownership check |
| Accu-Mk1 | `X-Service-Token` | Treats service token as trusted internal caller |

No new primitives — this is the same auth chain as the existing submit flow.

## ClickUp integration

**Comment template** (posted via existing ClickUp client in Accu-Mk1):

```
Customer retracted this request on 2026-04-22.
Reason: {reason}
```

The `Reason:` line is omitted entirely when `reason` is empty/absent.

**Timing & failure posture:**

1. Load row + gate check.
2. `POST https://api.clickup.com/api/v2/task/{task_id}/comment` with a 2-second timeout.
3. On success → log `clickup_retraction_comment_posted` (info) with `task_id`, `request_id`.
4. On failure (timeout, 4xx, 5xx, network) → log `clickup_retraction_comment_failed` (warn) with `task_id`, `request_id`, `error_class`. **Do not raise.**
5. Hard-delete the `peptide_requests` row.
6. Return 200.

**Idempotency:** the integration-service `Idempotency-Key: {id}:retract` dedupes retries at that layer. At Accu-Mk1, once the row is gone a retry falls through to 404 `{error: "request_not_found"}` — no double-comment because step 1 fails before the ClickUp call. Intentional and correct for hard delete.

**ClickUp card status:** moved to the RETRACTED column via PUT /task/{task_id} {"status": "retracted"}. Best-effort (2s timeout); on failure we log and proceed — the row is already deleted, so the ghost is an out-of-sync card the team can move manually. The column exists on the list and is mapped in DEFAULT_COLUMN_MAP.

**Missing `clickup_task_id`:** if the row has no task_id (shouldn't happen in prod but possible on manually-seeded rows), skip the ClickUp step entirely, log `clickup_retraction_comment_skipped_no_task_id`, and proceed to delete.

## Error envelope

Uses the existing global envelope. Retraction-specific error codes:

| Code | HTTP | Meaning |
|---|---|---|
| `request_not_found` | 404 | No row with that id (or already deleted) |
| `request_not_retractable` | 409 | Status not in `{"new", "rejected"}`; includes `current_status` field |
| `unauthorized` | 401 | Missing/invalid service token or JWT |
| `forbidden` | 403 | wpstar: current user doesn't own the snapshot row |

## Testing

### Accu-Mk1 (`tests/test_peptide_request_retract.py`)

1. Happy path — `status=new` row → ClickUp comment posted → row deleted → 200.
2. Reason included in ClickUp comment body when provided.
3. Reason omitted from comment body when empty/absent.
4. Gate — `status=approved` → 409, row not deleted, no ClickUp call.
5. Gate — `status=rejected` is retractable (symmetric happy path).
6. ClickUp failure — mock ClickUp raises → row still deleted, 200 returned, warn log emitted.
7. Auth — missing/bad `X-Service-Token` → 401.

Existing suite stays green (165 → ~172 passed).

### integration-service (`tests/test_peptide_request_retract.py`)

1. Forwards to Accu-Mk1 with `X-Service-Token` + `Idempotency-Key: {id}:retract`.
2. JWT required — missing/invalid → 401, no upstream call.
3. Error envelope pass-through — 409 from Accu-Mk1 surfaces as 409 with same envelope.

### wpstar

No test suite. Verification plan:

- PHP lint via `php8.2 -l` on every modified file.
- Manual E2E via Playwright:
  - (a) Submit request → click Retract → confirm → disappears from list, detail page 404s.
  - (b) Submit request → approve via ClickUp drag → detail page re-renders without a Retract button.
  - (c) Stale snapshot — force status=approved on Accu-Mk1 without relaying → click Retract on wpstar → expect the "can no longer be retracted" modal + page reload.
  - (d) Reason flow — retract with a typed reason → verify the reason shows up in the ClickUp task's comments.

## Observability

Structured log events in Accu-Mk1 (no new metrics, no new alerts):

- `peptide_request_retracted` (info) — `request_id`, `prior_status`, `had_reason` (bool).
- `clickup_retraction_comment_posted` (info) — `request_id`, `clickup_task_id`.
- `clickup_retraction_comment_failed` (warn) — `request_id`, `clickup_task_id`, `error_class`.
- `clickup_retraction_comment_skipped_no_task_id` (warn) — `request_id` (defensive, shouldn't fire in prod).
- `clickup_retraction_status_moved` (info) — `request_id`, `clickup_task_id`.
- `clickup_retraction_status_move_failed` (warn) — `request_id`, `clickup_task_id`, `error_class`.
- `clickup_retraction_client_init_failed` (warn) — `request_id`, `clickup_task_id`.

Rationale: retraction is low-volume, and failure of the ClickUp comment is recoverable (ghost card is visible in the UI and staff can delete it manually).

## File change estimate

### Accu-Mk1
- `backend/main.py` — add the new `POST /peptide-requests/{request_id}/retract` route handler alongside the existing peptide-request routes (~line 12612).
- `backend/peptide_request_repo.py` — add `delete_by_id(request_id)` helper.
- `backend/clickup_client.py` — add `post_task_comment(task_id, body, timeout=2)` method (no comment method exists today).
- `backend/tests/test_api_peptide_requests_retract.py` — new file, 7 tests (follows the existing `test_api_peptide_requests_create.py` pattern).

### integration-service
- `app/api/peptide_requests.py` — add new `POST /v1/peptide-requests/{id}/retract` route.
- `app/services/peptide_request.py` — add `retract(customer, request_id, reason)` method.
- `app/adapters/accumk1.py` — add `retract_peptide_request(request_id, body)` adapter method.
- `app/models/peptide_request.py` — add `PeptideRequestRetract` input model (just `reason: str | None`).
- `tests/unit/test_peptide_request_retract_api.py` — new file, 3 tests.
- `tests/unit/test_peptide_request_retract_service.py` — new file, 2 tests.

### wpstar (accumarklabs theme)
- `wp-content/themes/wpstar/includes/peptide-requests/rest-proxy.php` — add `register_retract_route()` + `handle_retract()` alongside the existing submit handler.
- `wp-content/themes/wpstar/includes/peptide-requests/db.php` — add `delete_snapshot($request_id)` helper.
- `wp-content/themes/wpstar/templates/portal-peptide-request-detail.php` — conditional Retract button + modal markup (status gate: `new` or `rejected`).
- `wp-content/themes/wpstar/assets/js/peptide-request-retract.js` (new) — modal wiring, fetch(), flash handling.
- `wp-content/themes/wpstar/assets/css/portal-peptide-request.css` (may already exist; extend) — button + modal styling.
- `wp-content/themes/wpstar/functions.php` or appropriate bootstrap — enqueue the new JS on the detail-page template.

## Rollout

Additive; no schema changes in Accu-Mk1 or wpstar. Ships with the big-bang cutover alongside the rest of `feat/peptide-request-v1`. No feature flag — the deletion gate is the feature flag (0% of approved requests can trigger it).

## Open questions

None. All resolved during brainstorming.
