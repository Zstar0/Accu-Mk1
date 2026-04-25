# Handoff — Peptide / Compound Request Feature

**Last updated:** 2026-04-19
**Status:** Accu-Mk1 half **shipped as PR — HOLD on merge.** integration-service + wpstar halves not started.

---

## TL;DR for next session

1. Accu-Mk1 is done end-to-end on `feat/peptide-request-v1` and open as **PR #1**: <https://github.com/Zstar0/Accu-Mk1/pull/1> (OPEN, MERGEABLE, 58 files, +7773/-41).
2. **Do not merge PR #1 yet.** Big-bang shipping: all three repos must go green together.
3. Next work is **integration-service** (10 tasks), then **wpstar** (10 tasks). Both branches `feat/peptide-request-v1` already exist with plans committed.
4. Frozen contracts (don't drift): `docs/superpowers/specs/2026-04-17-peptide-request-contracts.md` in Accu-Mk1. Any contract deviation during integration-service/wpstar implementation must halt and surface.

## What we're building

Customers on the WordPress site can submit a request for Accumark to add testing for a peptide or compound that isn't yet in the catalog. The request becomes an Accu-Mk1 entity (canonical Postgres record), a ClickUp task the lab works in, and — on completion — a new SENAITE Analysis Service (peptide path only) plus a one-time $250 WooCommerce coupon issued to the requesting customer.

## Repos & branches

| Repo | Path | Branch | State |
|---|---|---|---|
| Accu-Mk1 | `Accumark-Workspace/Accu-Mk1/` | `feat/peptide-request-v1` | ✅ Implemented, PR #1 open, holding for align |
| integration-service | `Accumark-Workspace/integration-service/` | `feat/peptide-request-v1` | ⏭ Next — 10 tasks planned |
| accumarklabs (wpstar theme) | `\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs\` | `feat/peptide-request-v1` | ⏭ After integration-service — 10 tasks planned |

## Artifacts (committed on each feature branch)

**In Accu-Mk1:**
- `docs/superpowers/specs/2026-04-17-peptide-request-design.md` — full design spec
- `docs/superpowers/specs/2026-04-17-peptide-request-contracts.md` — **frozen** HTTP contracts across all three systems
- `docs/superpowers/plans/2026-04-17-peptide-request.md` — Accu-Mk1 implementation plan (22 tasks, all complete)
- `docs/developer/peptide-request-flow.md` — architecture + ops reference (shipped on PR)

**In integration-service:**
- `docs/superpowers/plans/2026-04-17-peptide-request.md` — 10 tasks

**In wpstar:**
- `wp-content/themes/wpstar/docs/superpowers/plans/2026-04-17-peptide-request.md` — 10 tasks

## Pinned decisions (don't re-litigate)

- **Shipping strategy:** big-bang v1 — all three repos ship together.
- **Canonical record:** Accu-Mk1 Postgres. Not ClickUp, not integration-service.
- **ClickUp credentials:** in Accu-Mk1 backend. ClickUp webhooks land on Accu-Mk1's public endpoint.
- **integration-service role:** thin proxy between WP and Accu-Mk1. Owns HMAC/nonce/JWT validation and WP + SENAITE + WC adapters. No peptide-request business logic.
- **Status source of truth:** ClickUp columns. Accu-Mk1 maps column names → entity status enum via config-driven rule map.
- **Status enum (9 values):** `new` → `approved` → `ordering_standard` → `sample_prep_created` → `in_process` → `completed`. Off-ramps: `on_hold` (reversible), `rejected` (terminal), `cancelled` (terminal).
- **Peptide path on completion:** auto-clone `BPC157-ID` SENAITE Analysis Service, rename to `{Name} - Identity (HPLC)` — load-bearing naming.
- **Non-peptide path on completion:** skip SENAITE automation (manual lab work), still issue the coupon.
- **Coupon:** single-use, full-cart, $250, no expiry, via WooCommerce REST. Shown on the WP customer's request detail page.
- **Customer notifications:** email on Approved / Rejected / Completed only.
- **Form placement:** new `/portal/new-peptide-request/` page + CTA link from existing peptide order wizard.
- **No attachments** (explicitly removed from scope).

---

## Accu-Mk1 (shipped — what landed)

**PR #1:** <https://github.com/Zstar0/Accu-Mk1/pull/1> — `feat: peptide / compound testing requests (v1) — Accu-Mk1 half`

### Data layer
- 3 Postgres tables: `peptide_requests`, `peptide_request_status_log`, `clickup_user_mapping`
- 3 repositories with race-safe `INSERT ... ON CONFLICT DO NOTHING RETURNING *` + SELECT fallback idempotency
- Pydantic models + TypeScript types mirroring the frozen contract

### Backend API — two auth surfaces
- **Integration-service path** (`X-Service-Token`): `POST /api/peptide-requests`, `GET /api/peptide-requests[/{id}]`, admin endpoints — consumed by integration-service on WP's behalf
- **LIMS UI path** (JWT via `get_current_user`): `/api/lims/peptide-requests[/{id}[/history]]`, `/api/lims/admin/clickup-users/*` (admin routes also require `require_admin`)

### Webhook
- `POST /webhooks/clickup` with HMAC-SHA256 signature verify
- Dispatcher: `taskStatusUpdated` (column→status config map, dedup via unique partial index on `clickup_event_id`, `on_hold` preserves `previous_status`) + `taskAssigneeUpdated`

### Background jobs (daemon threads — no scheduler in the codebase)
- Relay status → WP via integration-service with exponential retry + `wp_relay_failed_at` terminal marker
- Completion side-effects: $250 coupon + SENAITE clone (`{compound_name} - Identity (HPLC)` from `BPC157-ID`), failures isolated per function
- ClickUp create retry sweep (manual `run_once`) + inline best-effort on POST

### LIMS UI
- Zustand section switching (no react-router in this Tauri shell)
- List page with Active/Closed tabs
- Detail page with status timeline and back nav
- Admin ClickUp user mapping page

### Tests
- Schema, repo, API, webhook dispatch, job tests
- E2E happy-path: POST → inline ClickUp → webhook → status transition → side-effects → final GET

### Six pre-merge items closed on the branch
1. Dependency pins in `backend/requirements.txt`: added `requests>=2.32.0`, changed `pydantic` → `pydantic[email]`.
2. `PeptideRequestRepository.create` idempotency race fixed with `INSERT ... ON CONFLICT DO NOTHING RETURNING *` + SELECT fallback.
3. `molecular_weight` truthy-check swapped to `is not None` (was dropping `0.0` silently).
4. Parallel JWT-gated LIMS endpoints added so the UI doesn't need the shared service token.
5. `accumk1_user_id` migrated from UUID → `INTEGER REFERENCES users(id) ON DELETE SET NULL` on both `clickup_user_mapping` and `peptide_request_status_log` (forward-only DO-block migration; `users.id` is INTEGER).
6. `require_admin` role gate applied on LIMS admin routes.

### Known follow-ups (non-blocking, documented in PR body)
- **JWT fixture gap:** no integration tests on `/api/lims/*` routes. Hook-level tests mock the API. Unblock by adding a JWT fixture (seeded `User` + bcrypt + access token) — unlocks E2E for the JWT-gated paths. Track for v1.1 unless reviewer blocks.
- `test_relay_status_to_wp.py::test_relay_posts_to_integration_service` has pre-existing env-sensitivity (module-level `os.environ.setdefault`) — unrelated to this branch.

---

## What integration-service will expose / consume

**Accu-Mk1 endpoints integration-service will call:**
- `POST /api/peptide-requests` — `X-Service-Token` auth, `Idempotency-Key` header
- `GET /api/peptide-requests?wp_user_id=X&status=csv` — service token
- `GET /api/peptide-requests/{id}` — service token

**Endpoints integration-service must expose (Accu-Mk1 calls these):**
- `POST /v1/internal/wp/peptide-request-status` — status relay callback
- `POST /v1/internal/wp/coupons/single-use` — coupon issuance
- `POST /v1/internal/senaite/services/clone` — SENAITE Analysis Service clone

Exact shapes, headers, and auth are in the frozen contracts doc.

---

## Resume instructions

### For integration-service (do this next)

```
cd Accumark-Workspace/integration-service   # branch feat/peptide-request-v1 already exists
```

1. Read `docs/superpowers/plans/2026-04-17-peptide-request.md` — 10 tasks.
2. Invoke `superpowers:subagent-driven-development`.
3. Dispatch tasks in order: implementer → spec reviewer → code quality reviewer → mark complete → next.
4. Keep execution serial (no parallel implementers within the plan — avoids git conflicts).
5. Surface any contract deviation immediately — halt and flag before deviating from `2026-04-17-peptide-request-contracts.md`. (Accu-Mk1 execution surfaced 6 architectural pre-merge items — expect similar friction here.)
6. When done, open a PR and **hold on merge**.

### For wpstar (after integration-service is green)

```
cd Accumark-Workspace/accumarklabs/wp-content/themes/wpstar
```

- Plan: `docs/superpowers/plans/2026-04-17-peptide-request.md` (10 tasks).
- Same subagent-driven loop. Same HOLD on merge.

### Merge order (when all three are green)

1. Accu-Mk1 first (PR #1) — backend must be live before WP traffic.
2. integration-service second — proxy layer.
3. wpstar last — consumer.

Verify each deploy before advancing.

---

## Context notes

- **Architectural memory** lives in `~/.claude/projects/C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace/memory/` and auto-loads in any new session (Accu-Mk1 as primary LIMS, integration-service narrow scope, SENAITE naming, non-peptide support).
- **Accu-Mk1 AGENTS.md** mandates GitNexus impact analysis before editing symbols. Subagent tasks in that repo reference this.
- **Accu-Mk1 default branch is `master`, not `main`.**
- **Visual brainstorm session data** lives in `.superpowers/` — gitignored, not committed.

---

## Session 2026-04-20/21 follow-up

After PR #1 opened, the feature got a second pass against the live sandbox. The original
22-task plan covered the happy path only; sandbox use surfaced a chunk of additive work
(bidirectional sync, manual-origin tasks, field drift, lifecycle signals). None of this
was a fix to a PR-review comment — all new surface area, committed to the same
`feat/peptide-request-v1` branch so the PR grows rather than stacking a second PR.

### What landed beyond the original 22-task scope

**ClickUp webhook coverage — five event types, not one.**
Originally only `taskStatusUpdated` + `taskAssigneeUpdated`. Added:
- `taskCreated` → materialize a manual ClickUp task as an Accu-Mk1 `peptide_requests`
  row with `source='manual'`, so lab-initiated work shows up in the LIMS UI
  (`5e97658 feat(webhook): handle taskCreated to materialize manual ClickUp tasks`).
- `taskDeleted` → retire the corresponding Accu-Mk1 row — soft-delete via `retired_at`
  timestamp, not a physical delete. Retired rows hide from the Active tab and show a
  badge in Closed (`0332241`, `a9af57f`, `882388e`, `8e2b4ed`).
- `taskUpdated` → handles both name changes and custom-field edits, feeding into the
  field-drift resolution flow (`c30e20d`, `6f79f81`, `c87b6a4`).

**Bidirectional field sync — the `field_drift` bucket.**
Sandbox usage showed that lab staff edit `compound_name`, `molecular_weight`, `sequence`,
`notes`, and (new) `sample_id` in ClickUp custom fields. Needed a way to pull those back
into Postgres without blindly overwriting LIMS-side edits. Added:
- ClickUp custom-field IDs in config (`9222a53`) — 8 constants (4 `CLICKUP_FIELD_*` for field
  UUIDs + 4 `CLICKUP_OPT_*` for enum option IDs on `compound_kind`).
- `compute_diff` + `apply_actions` sync service (`8b31eda`) with a `field_drift` bucket
  alongside `new_in_clickup` and `missing_in_clickup`.
- `resolve_field_drift` lets a human pick DB-or-ClickUp per field instead of an automatic
  winner (`aa67cc9`).
- LIMS UI: "Sync from ClickUp" button on the list page opens a modal with actionable
  checkboxes per bucket (`9357e1e`, `18c4719`, `aa3d18c`) plus a field-drift section that
  renders a DB-vs-ClickUp picker (`ffdc699`).
- `repo.update_fields` + config reverse-mapping helpers to convert UI selections back
  into writes on both sides (`c279763`).
- Custom fields are populated on task create + can be updated post-hoc via
  `set_custom_field` (`bcf32bc`).

**`sample_id` as a first-class bidirectional field.**
- New `sample_id` column on `peptide_requests`.
- Editable inline on the detail page (`3bd809e`), with a PATCH endpoint that updates the
  row and pushes the change to ClickUp as a custom-field edit (`b57c846`).

**Lifecycle / provenance columns.**
- `source` column — `wp` (customer-submitted, default) or `manual` (lab-created via
  ClickUp `taskCreated`). Rows marked `manual` get a visual indicator in the list
  (`592c181`, `f9eca4f`).
- `retired_at` column (already noted above in the taskDeleted work).

**Config + convention alignment.**
- ClickUp column map aligned to the actual sandbox list (`bfc5a7d`) — the pre-sandbox
  map had column names that didn't match production.
- Don't hardcode status on ClickUp task create — let ClickUp's list default win
  (`b2548a7`). Previously we were forcing `new` and getting rejected when the sandbox
  list used a different starter column.
- Project convention is no `/api` prefix on backend routes; peptide-request routes
  originally violated this. Refactored (`a861511`) and fixed the frontend hooks to match
  (`ebc72a5`).
- Runtime imports had leftover `backend.` prefixes from the implementer's dev setup that
  broke inside the Docker container (`645f8db`, `d540d97`).

**Feature flags for big-bang ship safety.**
- `PEPTIDE_COUPON_ENABLED` (`35f2340`) and `PEPTIDE_SENAITE_CLONE_ENABLED` (`cade8e4`)
  gate the two completion side-effects. Default off. integration-service side effects
  can be enabled independently of each other once production creds are wired.

**Test alignment.**
- ClickUp fixtures retargeted at the sandbox column map (`9f1cc60`).
- Env-overrides forced in integration-service tests (`3090fc4`) to stop module-level
  env bleed.
- Wizard test expectation fix for `actual_peptide_mg` key in `calc_stock_prep` result
  (`107f62e`).
- Repository fixture updated for the new `retired_at` column (`8e2b4ed`).

### Net delta vs. PR #1 as originally opened

PR #1 was 58 files / +7773/-41 at open. This session added:

- 4 new DB columns (`source`, `retired_at`, `sample_id`, config reverse-mapping helpers).
- 3 new webhook event handlers (`taskCreated`, `taskDeleted`, `taskUpdated`).
- 1 new sync service + 2 new API endpoints + hooks + modal UI.
- 8 new env vars for ClickUp custom-field IDs.
- 2 feature flags.
- Round of config-alignment fixes against the live sandbox.

The PR now reflects all of this on the same branch.

### What didn't land this session

- **No push, no merge.** Still holding per the big-bang strategy. integration-service
  half wrapping up in parallel; wpstar half not yet started.
- **JWT fixture gap** from the original handoff is still open — no integration tests on
  `/api/lims/*` routes. Hook-level tests mock the API. Unchanged from Session 1.
- **GitNexus index is stale** as of this session (last indexed: `35f2340`, 32 commits
  behind HEAD). Run `npx gitnexus analyze` before the next symbol-editing session. This
  session was docs-only so no impact analysis was required.
- `.gitignore`, `AGENTS.md`, `CLAUDE.md` on this repo have pending unrelated modifications
  from earlier in the day — intentionally left alone; not part of this feature and not
  part of this commit.
