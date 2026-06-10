# Promote → SENAITE Write-Back + Parent Provenance

**Date:** 2026-06-05
**Status:** Approved (design user-approved in session)
**Scope:** Mk1 backend (`lims_analyses` module + `main.py` activity endpoint) + FE parent page. No IS/coabuilder/WP changes.

## Problem

Promote (Phase 4a/4b) creates a verified parent-tier row in Mk1 only. The parent sample lives in SENAITE: its detail page, the COA pipeline (coabuilder reads SENAITE), and the inbox are all SENAITE-sourced. A promoted value is therefore invisible on the parent page and absent from generated COAs. Strategic decision: keep the parent SENAITE-authoritative for now (the "disconnect SENAITE" rework is parked); promotions must write back to SENAITE.

## Decisions (user-confirmed)

1. **Fail closed, SENAITE-first ordering.** The Mk1 promote commits only if the SENAITE write-back fully succeeds. Any SENAITE failure (missing analysis line, write error, silently-rejected transition) aborts the promote with a clear error. No queue, no pending-sync state.
2. **No backfill.** Existing Mk1-only promotes (P-0143 ENDO/STER) stay as-is. Escape hatch: retract the Mk1 parent row, re-promote (the re-promote then writes back).
3. **Provenance = badge + SENAITE remark.** The write-back stamps a remark on the SENAITE analysis; the parent page renders a badge from Mk1 promotion records.
4. Promotion events appear in the **parent's** activity log.

## Design

### 1. SENAITE write-back (backend)

New module `backend/lims_analyses/senaite_writeback.py`, following `sub_samples/senaite.py` conventions (sync `requests`, service-account auth via `SENAITE_USER`/`SENAITE_PASSWORD`, `SENAITE_BASE_URL`):

- `find_parent_analysis_line(parent_sample_id, keyword) -> {uid, review_state}` — `GET /Analysis?getRequestID={id}`, match `Keyword`. Missing line → `SenaiteWritebackError` ("parent AR has no {keyword} analysis").
- `writeback_promotion(parent_sample_id, keyword, result_value, remark) -> uid` orchestrator:
  1. find the line
  2. `POST /update/{uid}` with `{"Result": value, "Remarks": remark}`
  3. transition `submit` (skip if already `to_be_verified`), then `verify` — each transition validates the post-state (SENAITE silently rejects with 200; compare `review_state` to expected like main.py's `EXPECTED_POST_STATES` pattern). Already-`verified` line → error (conflict surfaced, not overwritten).

Remark format: `Promoted from {vial_id[, vial_id...]} (Accu-Mk1) by {user_email} on {YYYY-MM-DD}`.

**Route integration** (`lims_analyses/routes.py` `promote`): run `service.promote_to_parent` WITHOUT final commit (add `commit: bool = True` param to the service; route passes `False`), then `writeback_promotion(...)`, then `db.commit()`. Write-back failure → `db.rollback()` + HTTP 502 with the SENAITE error message. Both single-row and bulk dialogs inherit this (they share the endpoint).

Out of scope: method/instrument write-back; per-user SENAITE auth attribution (service account writes; attribution lives in the remark + Mk1 records).

### 2. Provenance badge (parent page)

- New endpoint `GET /api/lims-analyses/promotions?parent_sample_id=P-0143` → `[{keyword, parent_analysis_id, promoted_at, promoted_by_email, sources: [{sample_id, contribution_kind}]}]` from `lims_analysis_promotions` joined through parent-tier rows / source rows / sub-samples.
- FE: SampleDetails fetches it on parent pages; passes `promotionsByKeyword` map to AnalysisTable; new exported `PromotedFromBadge` renders next to the analysis title on matching rows: small ↑ + "from P-0143-S01" with tooltip (promoted_at, by). Mk1NativeBadge pattern. Works for pre-write-back promotes too (reads Mk1 records).

### 3. Parent activity log

`get_sample_activity` (main.py) gains a promotions block: for parent `sample_id`, query promotions (parent-tier `lims_analyses` rows for that sample → `lims_analysis_promotions` → source rows → vial sample_ids) and emit events: `{event: "analysis_promoted", label: "ENDO-LAL promoted from P-0143-S01", details: {keyword, result_value, by, sources}, source: "lims_analysis_promotions"}`.

### Testing

- Write-back helper: mocked HTTP (monkeypatched `requests`) — line found/missing, result write, submit skipped when already to_be_verified, verify silent-rejection detection, already-verified conflict.
- Route: monkeypatched `writeback_promotion` — success commits; failure → rollback (no parent row persisted) + 502.
- Promotions endpoint + activity events: DB-backed tests via existing fixtures.
- FE: `PromotedFromBadge` unit tests; typecheck.

### Out of scope

- Backfill of existing Mk1-only promotes.
- COA pipeline Mk1-awareness (future "disconnect SENAITE" phase).
- Method/instrument write-back; multiselect of SENAITE auth identity.
