# Mk1-Native Indicator on AnalysisTable — Design

*Created 2026-06-03.*

## Purpose

During the SENAITE → Accu-Mk1 transition, give lab staff an at-a-glance visual cue for which analysis line items in the AnalysisTable are served from a Mk1 `lims_analyses` row (Mk1-owned) versus a legacy SENAITE analysis. This makes the cutover legible while both data sources coexist on the same sample-detail page.

## Scope

**Frontend-only.** No backend, no schema, no API change. The provenance signal already exists in the data: `SenaiteShapeAnalysisResponse.uid` is `mk1:<id>` for Mk1 rows and a 32-char SENAITE hex UID otherwise. The frontend already relies on this exact distinction (`AnalysisTable.tsx:721`, `analysis.uid?.startsWith('mk1:')`, for the Promote affordance).

Files:
- Modify: `src/components/senaite/AnalysisTable.tsx` — the main analysis row's title cell.
- Create: `src/test/analysis-mk1-indicator.test.tsx` — vitest unit test.

## Discriminator

A row is Mk1-native iff `analysis.uid?.startsWith('mk1:')`.

- True → the displayed result is served from a Mk1 `lims_analyses` row → show the indicator.
- False (32-char SENAITE hex UID, or missing uid) → legacy SENAITE analysis → no indicator.

## Behavior — option A (always-on)

The indicator renders on **every** main analysis row whose `uid` is `mk1:`-prefixed. No mixed-vs-uniform table logic. On a sub-sample table (all Mk1) every row shows it; on a parent table (mixed Mk1 + legacy SENAITE) only the Mk1 rows show it. This is the literal reading of "mark any line item stored only in Mk1." It becomes redundant once all analyses migrate to Mk1 — a one-line removal at that point, out of scope here.

## Rendering

Extract a tiny, pure, named component co-located in `AnalysisTable.tsx` (this makes it directly unit-testable without standing up the full stateful table):

```tsx
function Mk1NativeBadge({ uid }: { uid?: string }) {
  if (!uid?.startsWith('mk1:')) return null
  return (
    <span title="Stored in Accu-Mk1 (no SENAITE record)" className="inline-flex shrink-0">
      <Database size={10} className="text-muted-foreground/60" aria-label="Stored in Accu-Mk1" />
    </span>
  )
}
```

Render it in the main row's title-cell flex container (`AnalysisTable.tsx:873`, `<div className="flex items-center gap-1.5 flex-wrap">`), immediately after the title `<span>` (and before the "N prev" history button):

```tsx
<Mk1NativeBadge uid={analysis.uid} />
```

`Database` is imported from `lucide-react` (already a dependency; the file already imports `ChevronDown`/`ChevronRight` from it — add `Database` to that existing import). The tooltip uses a `title` attribute on a wrapping `<span>`, consistent with the `wasRenamed`/`historyCount` tooltip idiom already in this cell.

## Scope of rows

- **Main analysis row only** — the primary, currently-visible analysis line.
- **NOT** the collapsed "Superseded" retest sub-rows (`AnalysisTable.tsx:652-696`). They are already heavily de-emphasized (line-through, reduced opacity); adding the icon there is noise.

## Testing

Vitest unit test (`src/test/analysis-mk1-indicator.test.tsx`), mirroring the existing `src/test/analysis-sla-cell.test.tsx` / `analysis-sla.test.tsx` patterns. Test the extracted `Mk1NativeBadge` component directly (it must be exported from `AnalysisTable.tsx` for the test to import it):

1. `<Mk1NativeBadge uid="mk1:669" />` → asserts an element with `aria-label="Stored in Accu-Mk1"` renders, and the wrapping element carries `title="Stored in Accu-Mk1 (no SENAITE record)"`.
2. `<Mk1NativeBadge uid="a8c27e69bfa84ff1bf16a3e370a44456" />` (SENAITE hex) → asserts it renders nothing (`container` is empty).
3. `<Mk1NativeBadge uid={undefined} />` → asserts it renders nothing.

## Out of scope

- Backend changes of any kind.
- The "mixed-only" behavior (option B).
- Indicator on superseded/retest history sub-rows.
- Any indicator on the variance summary, COA, or other surfaces — this is AnalysisTable-only.
- Removal logic for when the transition completes (a later one-line cleanup).
