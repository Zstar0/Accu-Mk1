# Native-Aware Manage Analyses

**Date:** 2026-06-05 · **Status:** Approved in session · **Scope:** Mk1 backend (`main.py` explorer-proxy endpoints + `lims_analyses`). FE unchanged (same endpoints).

## Problem

"Manage Analyses" add/remove proxies to IS→SENAITE and is broken for native (`mk1://`) vials (no SENAITE AR → 404). Mk1 has no remove path. Reassigned vials (e.g. endo vial later sent to hplc) need a manual way to add services beyond the role auto-seed — especially for tests the WP order didn't include (the auto-seed gate skips those).

## Decisions (user-confirmed)

1. **Old analyses stay on the vial** — multi-department vials are legitimate (endo result, then hplc). No cleanup on role change. Role auto-seed + WP gate unchanged.
2. Manage Analyses becomes the manual override, made native-aware **in the backend proxies** so the existing FE keeps working unmodified.

## Design

`POST /explorer/samples/{sample_id}/analyses` and `DELETE /explorer/samples/{sample_id}/analyses/{keyword}` (main.py, currently pure IS proxies) gain a native branch BEFORE proxying:

- **Native detection:** `sample_id` matches a `lims_sub_samples` row whose `external_lims_uid` starts with `mk1://`. Non-native (parents, legacy vials): proxy unchanged.
- **Add (native):** resolve the `AnalysisService` by the request's service uid — match `analysis_services.senaite_uid` first, fall back to keyword if the payload carries one. Create via `lims_analyses.service.create_analysis(host_kind="sub_sample", host_pk=sub.id, ...)` (idempotent guard: 409 if an active non-retest row with that keyword already exists on the vial). Response shape mirrors what the FE expects from the proxy (inspect + match).
- **Remove (native):** look up the vial's active `lims_analyses` row by keyword. If `review_state == "unassigned"` AND `result_value IS NULL` → hard-delete the row + its audit transitions (mistake correction). Otherwise → 409 with "analysis has activity — retract it instead".

## Out of scope

Role-change cleanup; WP-gate changes; FE changes; bulk add; parent-sample native add (parents stay SENAITE).

## Testing

Route tests (TestClient + snapshot/restore overrides pattern): native add creates row (and 409 on duplicate); native remove deletes pristine row; remove with result/state → 409; non-native sample falls through to the IS proxy (monkeypatch the proxy call, assert untouched behavior). Live E2E: add HPLC-PUR to an endo native vial on P-0144 via the UI/API; remove it; re-add.
