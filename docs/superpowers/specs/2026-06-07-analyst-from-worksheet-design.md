# Analyst from Worksheet — Design

*2026-06-07 · branch `subvial/continue` · status: approved (Approach A, resolve-by-uid)*

## Problem

`lims_analyses.analyst_user_id` exists but vial-tier rows never get it (only promote
writes it, onto parent-tier rows), and the senaite-shape serializer hardcodes
`analyst=None` (`backend/lims_analyses/service.py:1000`) — so the Analyst column on
vial pages and the Vials Quick Look dialog always shows "—". The lab's intent:
**the analyst is whoever's worksheet the vial is on.** Assignment to a worksheet is
the attribution event, and it must show in the sample's activity log.

Companion finding (no code change): the Worksheets Inbox already serves Mk1
sub-samples correctly (verified live — P-0142 parent + 3 subs with `mk1:` analyses).
P-0142 "missing" was the **hide-test-orders filter** (`TEST_EMAILS` includes the
operator's email; toggle persisted in localStorage). Works as designed.

## User decisions

1. **Stamp scope:** only the vial's analyses in the **service group of the worksheet
   item** (HPLC worksheet → Analytics analyses; micro → Microbiology). Mixed-role
   vials get per-bench attribution.
2. **Lifecycle: follow the worksheet.** Add → stamp. Worksheet's effective analyst
   changes → re-stamp. Item removed → clear back to NULL. The column reflects
   current worksheet reality; the activity log keeps history.
3. **Approach A:** resolve vials by uid at stamp time. No schema changes.

## Architecture

### Resolution path (no new columns)

`WorksheetItem.sample_uid` (models.py:631) already carries the vial's
`external_lims_uid` — `mk1://…` for native vials, SENAITE hex for legacy
dual-written vials. Stamp-time resolution:

```
WorksheetItem(sample_uid, service_group_id)
  → LimsSubSample WHERE external_lims_uid == sample_uid   (no match → not a vial → no-op)
  → LimsAnalysis WHERE lims_sub_sample_pk == sub.id
      AND service of analysis ∈ item.service_group_id     (via analysis_services → service_groups mapping)
      AND review_state NOT IN ('retracted','rejected')    (dead rows keep nothing)
  → SET analyst_user_id = effective_analyst
```

**Effective analyst** mirrors the existing precedence (main.py:~14431):
`Worksheet.assigned_analyst_id` if set, else `WorksheetItem.assigned_analyst_id`,
else NULL (a worksheet with no analyst stamps NULL — same as cleared).

Parent ARs added to worksheets are untouched: their `sample_uid` is a SENAITE AR
uid that matches no `lims_sub_samples` row, so the resolver no-ops. Parent-tier
attribution stays SENAITE's concern until the Option-C migration.

### Stamping service (new module function, not inline in main.py)

`backend/lims_analyses/worksheet_analyst.py` (new file, keeps main.py from growing):

- `stamp_for_item(db, *, sample_uid, service_group_id, analyst_user_id, acting_user_id, worksheet_id) -> int`
  — resolves + updates as above; returns affected-row count; writes ONE
  `lims_sub_sample_events` row when count > 0 (see Events). Idempotent: re-running
  with the same analyst is a no-op (no duplicate events).
- `clear_for_item(...)` — same resolution, sets NULL, `worksheet_removed` event.
- `restamp_for_worksheet(db, *, worksheet_id, analyst_user_id, acting_user_id)`
  — iterates the worksheet's items, applies `stamp_for_item` per item with the new
  effective analyst, emits `worksheet_analyst_changed` events (one per affected vial).

### Hook points (call sites in main.py — exact handlers pinned at plan time)

1. **Item(s) added to worksheet** (`add_group_to_worksheet` flow, main.py:~14378):
   after item rows are created, call `stamp_for_item` per added item.
2. **Worksheet analyst assigned/changed** (the worksheet PATCH that sets
   `assigned_analyst_id`): call `restamp_for_worksheet`.
3. **Item removed from worksheet** (the item delete/reassign handlers, incl.
   `reassign` moving an item between worksheets — treat as remove + add):
   call `clear_for_item` then (for reassign) `stamp_for_item` on the target.
4. **Worksheet deleted/cancelled** (if such a handler exists — plan-time check):
   clear all items' stamps.

All hooks are best-effort within the same transaction as the host operation —
stamping failures must not break worksheet operations (log + continue), EXCEPT
plain DB errors which roll back naturally with the host transaction.

### Events (activity log)

New `lims_sub_sample_events` event types, written by the stamping service,
user-attributed via `acting_user_id`:

| event_type | payload (JSON detail) |
|---|---|
| `worksheet_assigned` | worksheet_id, analyst_user_id, analyst_name, group name, affected keyword list |
| `worksheet_removed` | worksheet_id, group name, affected keyword list |
| `worksheet_analyst_changed` | worksheet_id, old/new analyst names, affected keyword list |

The vial activity endpoint (main.py:~1060-1093) renders them like the existing
`role_assigned`/`remarks_updated` events (icon + "by @user" attribution — follow
the established Arc-6 styling). Parent-page activity already synthesizes
`added_to_worksheet` from `worksheet_items` directly; unchanged.

### Serializer: surface the analyst

`list_analyses_in_senaite_shape` (`lims_analyses/service.py:893`) stops hardcoding
`analyst=None`: bulk-load `users` for the rows' `analyst_user_id`s and emit the
user's display name (plan-time: match whatever name field the users model exposes —
fall back to email). One query, joined in the existing bulk-load section.

The default (non-senaite-shape) `AnalysisResponse` already carries
`analyst_user_id` (schemas.py:147) — unchanged.

## Out of scope (explicit)

- Method/Instrument stamping from Sample Preps + preps×sub-samples — **project B**,
  its own spec (next arc).
- Parent-tier (SENAITE) analyst attribution.
- Changing the inbox test-order filter or TEST_EMAILS.
- Backfilling stamps for items already sitting on open worksheets (manual
  re-assign of the worksheet analyst will restamp them via hook 2 — acceptable
  migration path; note it in the release notes).
- Any worksheet UI changes — this is backend + activity rendering only.

## Testing (backend pytest, new file `tests/test_worksheet_analyst_stamp.py`)

1. Add vial item → matching-group analyses stamped, other-group analyses untouched,
   `worksheet_assigned` event written with acting user.
2. Mixed-role vial (HPLC analyses on a ster vial, the P-0142-S02 shape): HPLC
   worksheet item stamps only Analytics-group analyses.
3. Worksheet-level analyst overrides item-level (precedence).
4. Re-stamp on worksheet analyst change → values updated + `worksheet_analyst_changed`
   event; idempotent re-run writes no duplicate event.
5. Remove item → analyst cleared, `worksheet_removed` event.
6. Parent-AR item (SENAITE uid) → no-op, no event.
7. Retracted/rejected analyses never stamped.
8. Serializer returns analyst display name for stamped rows, None for unstamped.

Known suite baseline: 13 flag-off backend failures (see 2026-06-05 handoff filter
list) — don't chase. New TestClient fixtures must use the auth-override
snapshot/restore pattern.

## Risks / gotchas

- **Legacy vials' `external_lims_uid` is a SENAITE hex uid** — same namespace as
  parent AR uids. The resolver must match against `lims_sub_samples.external_lims_uid`
  (exact string), which is unique per vial; a parent AR uid simply won't match. No
  ambiguity, but the no-op-on-no-match behavior must be tested (test 6).
- The `reassign` endpoint moves items between worksheets — if treated only as "add",
  stale stamps from the source worksheet would linger with the wrong analyst when
  worksheet-level analysts differ. Hook 3's remove+add semantics covers it.
- Stamping NULL when a worksheet has no analyst: deliberate (decision 2 — the column
  mirrors worksheet reality). The activity event still records the assignment with
  analyst "unassigned".
