# Vials Quick Look Overlay — Design

*2026-06-05 · branch `subvial/continue` · status: approved (Approach A)*

## Problem

On a parent sample page, reviewing the vials' analyses means navigating into each
sub-sample page one at a time. The lab wants an at-a-glance view: every vial of the
parent and its analysis services, with the same fields the sample details page shows,
without leaving the parent page.

## Decision summary (user-approved)

- **Fully interactive** — not read-only. Inline result editing, method/instrument
  selects, transitions, retest chains, locking all behave exactly as on the vial pages.
- **Wide stacked dialog** — one modal (~90vw), vials stacked vertically, each with its
  own `AnalysisTable`. Not a tabbed sheet.
- **Approach A: frontend-only aggregation.** No new backend endpoints. One
  `listSubSamples(parent)` + N parallel `listLimsAnalysesForSubSample(pk)` + one shared
  `listParentLineStates(parent)`.
- **Button lives in the Analyses section** header row of the parent page, next to
  Manage Analyses.

## Architecture

### New component: `src/components/senaite/VialsQuickLookDialog.tsx`

Props:

```ts
interface VialsQuickLookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentSampleId: string            // e.g. "P-0144"
  analyteNameMap: Map<number, string>
  onNavigateToVial: (sampleId: string) => void  // closes dialog + navigates
}
```

Internal data flow (TanStack Query):

1. `useQuery(['sub-samples', parentSampleId], listSubSamples)` — vial list. The parent
   page already holds this query; the dialog shares the cache key so it is warm.
2. `useQueries` — one query per vial calling `listLimsAnalysesForSubSample(id)`
   (senaite-shape, `include_retests=true`). **The query key MUST be the exact key the
   vial page uses for the same data** (read it from SampleDetails' vial-mode
   useQuery at plan time — do not invent a new key) so saves made in the dialog and
   on the vial page invalidate each other.
3. `useQuery(['parent-line-states', parentSampleId], listParentLineStates)` — shared
   across all vials for parent-verified locking.

Queries are `enabled: open` — nothing fetches until the dialog opens.

### Per-vial section

Header (collapsible, default expanded; chevron toggle):

- Vial sample ID — clickable, calls `onNavigateToVial` (lab UX: clickable IDs)
- Role badge with existing role tint (hplc/endo/ster/xtra), same colors as the
  sub-sample pages
- Vial status badge (review state from the sub-sample record)
- Analysis count, e.g. "3 analyses"

Body: the existing `AnalysisTable`, passed per-vial props mirroring what
`SampleDetails` passes in vial mode (source of truth: the vial-mode wiring around
`SampleDetails.tsx:3585`):

- `analyses` — that vial's lines (retest folding handled by `include_retests` +
  AnalysisTable's existing chain UI)
- `analyteNameMap` — passed through from the parent page
- `onResultSaved` / `onTransitionComplete` / `onMethodInstrumentSaved` — invalidate
  that vial's `lims-analyses` query (and parent-line-states after transitions, since
  promote/retest can change parent rows)
- `parentLineStates` — the shared query result (lock icons on parent-verified lines)
- `primaryAnalysisUids` / `primaryRole` — computed per vial from its
  `assignment_role`, reusing the same matching logic the vial page uses (extract the
  existing computation into a small exported helper if it is currently inline; the
  helper move is mechanical, not a refactor of behavior)
- SLA props (`analysisSlaMap` etc.) — **omitted** in v1. AnalysisTable already treats
  them as optional; the SLA column renders its loading/absent state. If this reads
  poorly in UAT, a follow-up can wire per-vial SLA queries.

States:

- **Loading:** per-vial skeleton rows under each header.
- **Error:** per-vial inline error with retry; one vial failing must not blank the
  others.
- **Empty vial:** header + "No analyses assigned".
- **No vials:** button is disabled (see below), so the dialog never opens empty.

### Dialog shell

shadcn `Dialog`, `DialogContent` with `max-w-[90vw] xl:max-w-[1400px]`,
`max-h-[85vh]`, internal `overflow-y-auto`. Title: `Vials — {parentSampleId}`.
Follows BulkPromoteDialog's structure (header / scrollable body), just wider.

### Button

In the Analyses section header row next to Manage Analyses
(`SampleDetails.tsx:~3480`):

- Label: **Vials Quick Look**, `Eye` icon, `variant="outline" size="sm"` matching
  Manage Analyses
- Rendered on **parent pages only** (`parentSampleId === null` guard, same gate the
  sub-samples section uses)
- Disabled with tooltip "No vials yet" when `subSamples.length === 0`

## Out of scope (explicit)

- No backend changes (Approach B parked; revisit only if vial counts grow).
- No extraction of a shared `VialAnalysesPanel` (Approach C — conflicts with
  additive-only; the only allowed move is exporting the existing primary-role helper
  if it is inline).
- No SLA wiring in v1.
- No bulk actions *across* vials (each AnalysisTable's selection/bulk bar stays
  scoped to its own vial, as it is today).

## Testing (vitest, `src/test/vials-quicklook.test.tsx`)

1. Button renders on parent page, absent on sub-sample page.
2. Button disabled when no vials.
3. Open dialog → one section per vial, ordered by `vial_sequence`, role badges shown.
4. Vial with no analyses shows the empty state.
5. One vial's query failing renders its error state while siblings render rows.
6. Result save invalidates that vial's `lims-analyses` query key (spy on
   queryClient).
7. Vial ID click calls `onNavigateToVial` with the vial sample ID and closes.

Follow the established TestClient/mock patterns in `src/test/` (mock `@/lib/api`,
not fetch). Keep the new fixture self-contained — remember the auth-override
snapshot/restore lesson from the backend suite applies conceptually: never mutate
shared module state without restoring it.

## Risks / gotchas

- **Query-key mismatch** is the main correctness risk: if the dialog's per-vial key
  differs from the vial page's, edits in one surface look stale in the other. Pin the
  key by importing/reusing the same key-builder if one exists, else match literally
  and add a test.
- N parallel calls: fine at current vial counts (≤8). No batching in v1.
- `AnalysisTable` was built for one-table-per-page; verify its internal dialogs
  (BulkPromoteDialog etc.) behave when multiple instances mount under one Dialog
  (shadcn nested dialogs are supported; test transition flows in UAT).
