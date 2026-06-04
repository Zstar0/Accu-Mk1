# Mk1-Native Indicator on AnalysisTable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small muted `Database` icon (tooltip "Stored in Accu-Mk1") on each AnalysisTable line item whose result is served from a Mk1 `lims_analyses` row (`uid` starts with `mk1:`).

**Architecture:** Frontend-only. Extract a tiny exported pure component `Mk1NativeBadge({ uid })` in `AnalysisTable.tsx`, render it in the main row's title cell, unit-test it directly. The `mk1:` provenance is already in `analysis.uid` — no backend, no schema, no API change.

**Tech Stack:** React + TypeScript + lucide-react + vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-03-mk1-native-analysis-indicator-design.md`.

**Branch:** `subvial/continue` (worktree at `C:/tmp/Accu-Mk1-subvial`).

---

## File Structure

- Modify: `src/components/senaite/AnalysisTable.tsx` — add `Database` to the lucide import; add the exported `Mk1NativeBadge` component; render it in the main row's title cell (~line 873).
- Create: `src/test/analysis-mk1-indicator.test.tsx` — unit tests for `Mk1NativeBadge`.

Tests run on the HOST (vitest), not in Docker. From `C:/tmp/Accu-Mk1-subvial`:
```
npx vitest run src/test/analysis-mk1-indicator.test.tsx
```
(If `npx vitest` isn't wired, check `package.json` scripts — likely `npm test` or `npm run test`. Use the file-scoped form the repo's other `src/test/*.test.tsx` use.)

---

## Task 1: Mk1NativeBadge component + render + test

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx`
- Create: `src/test/analysis-mk1-indicator.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/test/analysis-mk1-indicator.test.tsx`. Mirror the import/setup style of `src/test/analysis-sla-cell.test.tsx` (check that file for the exact `render`/`screen` imports and any test-setup needed).

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Mk1NativeBadge } from '../components/senaite/AnalysisTable'

describe('Mk1NativeBadge', () => {
  it('renders the Mk1 icon + tooltip for an mk1: uid', () => {
    const { container, getByLabelText } = render(<Mk1NativeBadge uid="mk1:669" />)
    // icon present via aria-label
    expect(getByLabelText('Stored in Accu-Mk1')).toBeTruthy()
    // tooltip on the wrapping span
    expect(container.querySelector('[title="Stored in Accu-Mk1 (no SENAITE record)"]')).toBeTruthy()
  })

  it('renders nothing for a SENAITE hex uid', () => {
    const { container } = render(<Mk1NativeBadge uid="a8c27e69bfa84ff1bf16a3e370a44456" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for an undefined uid', () => {
    const { container } = render(<Mk1NativeBadge uid={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/analysis-mk1-indicator.test.tsx`
Expected: FAIL — `Mk1NativeBadge` is not exported from `AnalysisTable.tsx` (import error).

- [ ] **Step 3: Add `Database` to the lucide import**

In `src/components/senaite/AnalysisTable.tsx`, find the existing `lucide-react` import (it already pulls `ChevronDown`, `ChevronRight`, etc.) and add `Database`:

```tsx
import { /* ...existing icons..., */ ChevronDown, ChevronRight, Database } from 'lucide-react'
```

(Keep the existing icons; just add `Database` to the same import list. Do not create a second `lucide-react` import line.)

- [ ] **Step 4: Add the exported `Mk1NativeBadge` component**

Add near the other small helper components in the file (e.g. just above the main row component around line 800-820, or beside `formatAnalysisTitle`). It MUST be exported (the test imports it):

```tsx
export function Mk1NativeBadge({ uid }: { uid?: string }) {
  if (!uid?.startsWith('mk1:')) return null
  return (
    <span title="Stored in Accu-Mk1 (no SENAITE record)" className="inline-flex shrink-0">
      <Database size={10} className="text-muted-foreground/60" aria-label="Stored in Accu-Mk1" />
    </span>
  )
}
```

- [ ] **Step 5: Render it in the main row's title cell**

In the main analysis row's title cell (`AnalysisTable.tsx:873`, the `<div className="flex items-center gap-1.5 flex-wrap">`), add the badge immediately after the closing `</span>` of the title span (line ~884) and before the `{!!historyCount && (` history button block:

```tsx
          </span>
          <Mk1NativeBadge uid={analysis.uid} />
          {!!historyCount && (
```

(Insert ONLY the `<Mk1NativeBadge uid={analysis.uid} />` line. Do not touch the title span or the history button.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/test/analysis-mk1-indicator.test.tsx`
Expected: 3 passed.

- [ ] **Step 7: Typecheck — no new errors**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`
Expected: only the 2 pre-existing errors documented in the handoff. No new error referencing `AnalysisTable.tsx` or the new test.

- [ ] **Step 8: Commit**

```bash
git add src/components/senaite/AnalysisTable.tsx src/test/analysis-mk1-indicator.test.tsx
git commit -m "feat(analysis-table): Mk1-native indicator on mk1: line items

A muted lucide Database icon (tooltip 'Stored in Accu-Mk1') marks
analysis rows served from a Mk1 lims_analyses row (uid starts with
'mk1:') vs legacy SENAITE analyses. Extracted exported Mk1NativeBadge
helper; 3 unit tests. Frontend-only, no backend change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Discriminator `uid.startsWith('mk1:')` → Step 4. ✓
- lucide `Database` icon, size 10, muted, tooltip → Step 4. ✓
- Placement in main-row title cell after the title span → Step 5. ✓
- Exported helper for testability → Step 4. ✓
- Option A (always-on every mk1: row) → the component has no mixed-table logic; renders whenever uid is mk1:. ✓
- NOT on superseded sub-rows → Step 5 only edits the main row cell; the superseded sub-row (lines 652-696) is untouched. ✓
- 3 test cases (mk1: → present, hex → empty, undefined → empty) → Step 1. ✓

**2. Placeholder scan:** None. The "check analysis-sla-cell.test.tsx for exact render imports" note is a real instruction (test-setup conventions vary), not a placeholder — the test body is complete.

**3. Type consistency:** `Mk1NativeBadge({ uid }: { uid?: string })` defined in Step 4, imported in Step 1, rendered as `<Mk1NativeBadge uid={analysis.uid} />` in Step 5. `analysis.uid` is `string | undefined` on the `SenaiteAnalysis` type (the file already does `analysis.uid?.startsWith('mk1:')` at line 721), matching the `uid?: string` prop. Consistent.

---

## Execution

Inline execution (user-selected). Proceed with executing-plans.
