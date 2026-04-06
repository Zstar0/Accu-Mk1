---
phase: 15-foundation
plan: "04"
status: complete
started: 2026-03-31
completed: 2026-03-31
---

# Plan 15-04: SENAITE Analyst Field Verification — Summary

## Result

**ANLY-03 resolved:** SENAITE's `Analyst` field on Analysis objects is **read-only**. It returns `"Not allowed to set the field 'Analyst'"` on direct update attempts. The field is only set when an analysis is added to a SENAITE Worksheet with an assigned analyst.

Since AccuMark replaces SENAITE worksheets entirely, analyst assignment will live in AccuMark's local `worksheet_items` table (Phase 16 data model). No SENAITE push needed.

## Changes

### Removed (cleanup after verification)
- `POST /senaite/analyses/{uid}/analyst` — assignment endpoint (SENAITE rejects writes)
- `POST /senaite/analyses/{uid}/analyst-test` — diagnostic endpoint (no longer needed)
- `AnalystAssignRequest` schema
- `AnalystTestRequest` schema
- `setAnalysisAnalyst()` frontend function

### Updated
- `GET /senaite/analysts` — now returns `uid` field alongside `username` and `fullname`
- `SenaiteAnalyst` TypeScript interface — added `uid` field

## Key Decision

Analyst assignment is **local-only** (AccuMark PostgreSQL). This aligns with the long-term direction of phasing out SENAITE. The `GET /senaite/analysts` endpoint remains as a read-only source for analyst dropdown options.

## Commits

- `919017a` — feat(15-04): add analyst format diagnostic endpoint (Task 1)
- `ff88c34` — refactor(15): remove SENAITE analyst push — assignment stays local

## Self-Check: PASSED

- [x] ANLY-03 resolved (field format question answered: read-only, use local assignment)
- [x] Unused code removed
- [x] GET analysts endpoint returns uid for identification
