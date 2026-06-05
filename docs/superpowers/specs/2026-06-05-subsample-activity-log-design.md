# Sub-Sample Activity Log

**Date:** 2026-06-05 · **Status:** Approved in session · **Scope:** Mk1 backend (`main.py` activity endpoint, `sub_samples`/`lims_analyses` services, one new table). FE unchanged (existing Activity Log sheet renders whatever the endpoint returns).

## Problem

`GET /samples/{id}/activity` is empty for sub-samples. The lab needs the vial timeline: analysis seeding, role assignment + changes, transitions (submit/verify/retract/reject/retest), promotions, remarks edits, Manage Analyses add/remove — all attributed to the acting user.

## Design

**A. Derive from existing audit tables (no new writes needed):**
- `lims_analysis_transitions` joined through `lims_analyses` → `lims_sub_samples.sample_id` covers: seeding/manual add (`from_state IS NULL` "initial insert" rows → label "Analysis added: {keyword}"), every workflow transition (label "{keyword}: {from}→{to}" with kind/reason), retest links.
- `lims_analysis_promotions` (vial side via `source_analysis_id`) → "Promoted {keyword} to parent" events.
- User attribution: `user_id` on both tables → email join.

**B. New lightweight event table for un-audited actions** — `lims_sub_sample_events(id, sub_sample_pk FK, event TEXT, details JSONB, user_id FK nullable, created_at)`, created via the idempotent migration block + model. Writers (all additive, same transaction as the action):
- `set_assignment_role` → event `role_assigned` {from, to} (service gains a `user_id` param; route passes the current user).
- sub-sample remarks update (native path) → event `remarks_updated` {preview: first 120 chars}.
- `delete_pristine_analysis` → event `analysis_removed` {keyword} (the hard-delete erases the analysis audit; this preserves the fact).

**C. Activity endpoint:** in `get_sample_activity`, when `sample_id` matches a `lims_sub_samples` row, emit events from A + B in the standard `{timestamp, event, label, details, source}` shape alongside existing blocks. Parent pages keep current behavior (plus already-shipped `analysis_promoted`).

## Out of scope
FE changes; backfilling events for actions that predate the table; SENAITE-side action mirroring; activity for legacy (SENAITE-secondary) vial actions performed in SENAITE UI.

## Testing
Service tests for the three new writers (event row written with user + details); activity endpoint test for a sub-sample id covering: seeded analysis (initial-insert), a transition, a promotion, a role change, an analysis_removed event — all present, reverse-chronological, user-attributed. Live E2E on P-0144-S01.
