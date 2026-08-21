---
title: "Native Parent Analyses Table — the Accu-Mk1 Analyses card becomes the shared AnalysisTable with parent-legal verbs"
date: 2026-08-04
status: draft
authors: [ZeroSignal, forrestp]
depends_on: "spec 2 native COA sections (parent-tier promote); catalog-driven bench (spec 4); admin un-promote (Mk1 PR #41, deploy pending)"
part_of: "SENAITE phase-out — parent-page UX parity for native families"
---

# Native Parent Analyses Table

## Summary

The parent sample-details page's "Accu-Mk1 Analyses" card (`NativeParentAnalysesCard`,
`src/components/senaite/SampleDetails.tsx:3345`) is a read-only Task-5b stopgap: name, keyword,
result, state badge, nothing else. This spec replaces its internals with the shared
`AnalysisTable` component — the same 2,100-line table that renders both the SENAITE Analyses
section and the sub-sample native section — so native parent-tier rows get the identical look,
interactions, and verb machinery, restricted to the verbs that are true at the parent tier.

**Handler ruling (2026-08-04):** same component, same look and interactions, parent-legal verb
set. Result entry and submit stay at the vial tier exactly as the sub-sample section does today;
the parent row menu offers only what is true at that tier.

## Why approach A (separate section, shared component)

- **B — merge into the main Analyses table** is the eventual phase-out end-state, but the main
  table is the senaite-vs-Mk1 parity surface: the side-by-side burn-in is RUNNING and the
  read-flip is one lab ruling from green. Injecting origin='mk1' rows with no SENAITE
  counterpart into that data path mid-burn-in invites phantom diffs. Revisit at phase-out
  slice 2, not now.
- **C — grow the bespoke card** duplicates AnalysisTable's state maps, bulk logic, and badges.
  Rejected outright; the ruling was reuse.
- **A** is additive: the card keeps its identity (heading, provenance tooltip, self-contained
  gated query — the `PackagingAttachmentsGroup` pattern) and swaps only its body for the real
  table. The main Analyses table is untouched.

## Current state (verified in code)

- `AnalysisTable.tsx` is already dual-mode: editable-state rules distinguish Mk1 vial rows from
  SENAITE rows (`AnalysisTable.tsx:139-177`), the transition maps carry
  `verified: ['retest']`, and the vial-side comments already point corrections at the parent
  ("Corrections must start at the PARENT (retest there …)" — the parent→sub cascade is named at
  `AnalysisTable.tsx:164-171`).
- Backend `lims_analyses/service.py` is tier-aware: `apply_transition` handles parent rows
  (`row.lims_sub_sample_pk is None` branches at :352/:442), explicitly rejects
  `variance_verify` at the parent ("the parent acting as a vial always PROMOTES"), and
  `cascade_parent_retest_to_sources` (:1237) implements parent-retest → un-promote + retract of
  promoted vial sources, never touching published.
- The read-source flip already adapts Mk1-sourced rows into the `SenaiteAnalysis` shape the
  table consumes (`SampleDetails.tsx:4181` idiom) — the same adapter approach this spec reuses.
- The read endpoint behind `getNativeParentAnalyses` (`src/lib/api.ts:5919`) returns
  title/keyword/result/unit/review_state only — not enough for the table.

## Design

### Data read

Extend the native parent-analyses read (the endpoint behind `getNativeParentAnalyses`) to return
per row what the table consumes: the native row id (same uid form the vial tier uses), title,
keyword, `result_value`/`result_unit`, `review_state`, method/instrument labels + ids, retest
lineage (`retest_of_id`, retested/superseded flags), and promoted-from provenance (source vial
sample_id + row id) so `PromotedFromBadge` renders identically to the sub-sample section.
Additive response change: existing consumers of the current fields are unaffected.

### Frontend

`NativeParentAnalysesCard` keeps heading + tooltip + gated query and renders `<AnalysisTable>`:

- **Adapter:** native parent rows → `SenaiteAnalysis` shape, same idiom as the read-source rows.
- **Read-only results:** `resultsReadOnly` — the parent tier never edits a result. The tooltip
  copy updates from "Read-only here" to describing the parent-legal lifecycle.
- **Parent-tier verb map:** `verified → ['retest']`; retracted/superseded lineage rows
  display-only; no `submit`, no `verify`, no variance verbs (backend rejects them at this tier),
  no Manage Analyses (parent membership is derived from promotion), no reject/cancel (native
  cancel origination is a separate punch-list item).
- **Bulk toolbar:** reduced to bulk retest over selected verified rows.
- **Same affordances as the SENAITE instance where they apply:** state badges, method column,
  row expansion, SLA chips (`analysisSlaMap` is keyword-keyed and already computed on the page).
- **Retest confirm:** destructive-confirm dialog naming the blast radius — "retracts N promoted
  source result(s) on vial(s) X, Y" — count fetched from the provenance the read now returns.

### Verbs

Row/bulk retest calls the existing native transition endpoint into `apply_transition` →
`cascade_parent_retest_to_sources`. This spec exposes existing, tested semantics — it does not
reimplement them. Published samples are unaffected (the cascade never touches published; COA
regeneration gates remain upstream). Admin un-promote (PR #41) surfaces as a row verb ONLY if
its endpoint exists on the base branch at build time; otherwise it stays in the admin flow and
is out of scope here.

### What does not change

- The main SENAITE-sourced Analyses table and its swap effect, the side-by-side comparison
  path, and the read-flip program surfaces.
- Vial-tier behavior: result entry, submit, promote, variance flows live where they live today.
- No SENAITE writes anywhere in this feature.
- The promote/un-promote lifecycle itself — the card is a window onto it, not a second author.

## Testing

- FE vitest: card renders the shared table for native parent rows; verb gating per state
  (verified shows retest only; superseded rows show no verbs; no result editing anywhere);
  retest fires the transition API and refreshes; confirm dialog names the source count.
- Backend: cascade tests exist; add a route-level test for parent-tier retest through the
  transition endpoint only if that exact path lacks one; extend the parent-analyses read test
  for the new fields.
- Gates: Mk1 backend failure-set diff vs baseline; FE `npx tsc --noEmit` + targeted vitest
  files (never `npm run check:all` in the worktree).

## Risks

| Risk | Mitigation |
|---|---|
| Bulk/row retest cascade surprises a tech (vial results retracted) | Destructive-confirm naming the exact source rows; existing server semantics unchanged |
| Adapter drift between native-row shape and SenaiteAnalysis expectations | Single adapter function with a unit test pinning the field mapping |
| Table's SENAITE-only affordances leak into the native instance (method EDIT writes senaite paths, Manage Analyses) | Explicit prop gating in the card instance + a test asserting the gated verbs are absent |
| Interference with sbs burn-in | None by construction — separate section, separate query, main table untouched |

## Open questions

1. **Remarks at the parent tier** — the sub-sample section surfaces row remarks; the native
   parent read doesn't return them today. Include if the field is already on the row (cheap),
   else defer.
2. **PR #41 un-promote** — surfaced here only if merged into the base branch by build time;
   confirm at planning.

## Planning corrections (2026-08-04, recon on `feat/s2s-catalog-keys` @ `838ebec`)

Behavior as ruled is unchanged; three mechanisms this spec assumed were corrected during
planning (see `docs/superpowers/plans/2026-08-04-native-parent-analyses-table.md`):

1. **Retest does NOT go through the existing transition endpoint.**
   `state_machine._TIER_ALLOWED_KINDS[TIER_PARENT]` is `{publish, retract, auto}` — a parent-tier
   `retest` 409s with `tier_mismatch`, and `apply_transition` never calls
   `cascade_parent_retest_to_sources` (its only caller is the SENAITE proxy, `main.py:15299`).
   The plan adds a dedicated additive route `POST /api/lims-analyses/parent/{sample_id}/retest`
   fronting the existing cascade, fail-closed on non-verified parents. The state machine is not
   touched.
2. **No FE adapter function.** The sub-sample "adapter" is a server-side `senaite_shape`
   projection (`_serialize_senaite_shape_rows`, shared helper); the plan extends the native
   parent read with `?as=senaite_shape` through the same serializer — parity by construction.
3. **The page's `analysisSlaMap` cannot serve the card** — it's keyed off the SENAITE
   `lookup.analyses`, which never contain native keywords. The card computes its own map from
   a synthetic lookup (`{...lookup, analyses: nativeRows}`), the `VialsQuickLookDialog` pattern.

Open questions resolved: **remarks deferred** (`lims_analyses` has no remarks column);
**PR #41 un-promote out of scope** (no un-promote endpoint exists on the base branch).
