# Flag Multi-Flag Creation Affordances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make raising a second flag on an entity discoverable (context-aware flyout Add Flag, a "+" next to the flagged pill) and restyle the >1 count as a floating circle badge.

**Architecture:** Purely frontend + one spec edit. A new ui-store stack (`activeFlagEntityStack`) tracks "the entity page you're on"; detail surfaces push/pop it via a tiny hook. The flyout's un-scoped Add Flag reads the stack top (hidden when empty). `EntityFlagButton` gains a secondary `+` compose trigger. Count badges float over the flag icon. **No backend/API changes.**

**Tech Stack:** React 19 + TypeScript, Zustand (devtools, selector syntax enforced by ast-grep), TanStack Query, shadcn/ui, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-01-flag-multi-flag-creation-affordances-design.md`

## Global Constraints

- Laptop worktree `C:/tmp/flag-ui` (branch `feat/flag-system-frontend`) is the edit surface; it has **no node_modules** — all checks run in the devbox flagsfe stack.
- **SYNC** (run after each commit): `git push` on the laptop, then
  `ssh forrestparker@100.73.137.3 'cd ~/worktrees/Accu-Mk1-flagsfe && git fetch -q && git reset --hard -q origin/feat/flag-system-frontend'`
- **TEST** = `ssh forrestparker@100.73.137.3 'cd ~/worktrees/Accu-Mk1-flagsfe && docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npx vitest run src/components/flags src/store/ui-store.test.ts src/hooks/__tests__" </dev/null'`
- **TYPECHECK** = same ssh/exec shape with `npm run typecheck`; **BUILD** = with `npm run build`.
- RED commits are normal on this branch (`test(flags): … (RED)` precedent exists). Commit the failing test, SYNC, TEST to observe the failure, then implement.
- npm only. Zustand `useUIStore(state => state.field)` selector syntax. Do not use `Array.prototype.findLastIndex` (lib target); `.at(-1)` is fine.
- `npm run check:all` aggregate is red at baseline (~19 unrelated failures) — gate ONLY on TYPECHECK + flag/store vitest + BUILD.
- All commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Spec amendment + `activeFlagEntityStack` in ui-store

**Files:**
- Modify: `docs/superpowers/specs/2026-07-01-flag-multi-flag-creation-affordances-design.md` (registering-surfaces table)
- Modify: `src/store/ui-store.ts` (interface ~line 180, defaults ~line 223, actions after `clearFlagsSamplesFilter`)
- Test: `src/store/ui-store.test.ts` (append a describe block)

**Interfaces:**
- Produces: `activeFlagEntityStack: ActiveFlagEntity[]` where `ActiveFlagEntity = { type: string; id: string; label: string }`; actions `pushActiveFlagEntity(entry: ActiveFlagEntity): void`, `popActiveFlagEntity(entry: { type: string; id: string }): void`. Consumers read the top via `useUIStore(state => state.activeFlagEntityStack.at(-1) ?? null)`.

- [ ] **Step 1: Amend the spec's registering-surfaces table**

In the spec, replace the three-row surface table + its lead-in sentence with:

```markdown
Registering surfaces:

| Surface | Entity |
|---|---|
| `SampleDetails` (parent page) | `sample` |
| `SampleDetails` (vial page, `isParent=false`) | `sub_sample` (vial) |
| `WorksheetDrawerHeader` | `worksheet` |

`VialsQuickLookDialog` registers **nothing**: it lists all of a parent's vials
(one flag button per row), so there is no single "vial you're on"; the parent
sample's context (registered by SampleDetails underneath) stays active.
```

- [ ] **Step 2: Write the failing store test**

Append to `src/store/ui-store.test.ts`:

```ts
describe('UIStore active flag entity stack', () => {
  beforeEach(() => {
    useUIStore.setState({ activeFlagEntityStack: [] })
  })

  it('defaults to an empty stack', () => {
    expect(useUIStore.getState().activeFlagEntityStack).toEqual([])
  })

  it('push adds to the top; overlays stack in order', () => {
    useUIStore
      .getState()
      .pushActiveFlagEntity({ type: 'sample', id: 'P-0071', label: 'P-0071' })
    useUIStore
      .getState()
      .pushActiveFlagEntity({ type: 'worksheet', id: '9', label: 'WS Alpha' })
    const stack = useUIStore.getState().activeFlagEntityStack
    expect(stack).toHaveLength(2)
    expect(stack.at(-1)).toEqual({ type: 'worksheet', id: '9', label: 'WS Alpha' })
  })

  it('pop removes the LAST matching entry and restores the one beneath', () => {
    useUIStore
      .getState()
      .pushActiveFlagEntity({ type: 'sample', id: 'P-0071', label: 'P-0071' })
    useUIStore
      .getState()
      .pushActiveFlagEntity({ type: 'worksheet', id: '9', label: 'WS Alpha' })
    useUIStore.getState().popActiveFlagEntity({ type: 'worksheet', id: '9' })
    const stack = useUIStore.getState().activeFlagEntityStack
    expect(stack).toHaveLength(1)
    expect(stack.at(-1)?.id).toBe('P-0071')
  })

  it('pop of a non-top entry removes just that entry (unmount order safety)', () => {
    useUIStore
      .getState()
      .pushActiveFlagEntity({ type: 'sample', id: 'P-0071', label: 'P-0071' })
    useUIStore
      .getState()
      .pushActiveFlagEntity({ type: 'worksheet', id: '9', label: 'WS Alpha' })
    useUIStore.getState().popActiveFlagEntity({ type: 'sample', id: 'P-0071' })
    const stack = useUIStore.getState().activeFlagEntityStack
    expect(stack).toHaveLength(1)
    expect(stack.at(-1)?.type).toBe('worksheet')
  })

  it('pop of an unknown entry is a no-op', () => {
    useUIStore
      .getState()
      .pushActiveFlagEntity({ type: 'sample', id: 'P-0071', label: 'P-0071' })
    useUIStore.getState().popActiveFlagEntity({ type: 'sample', id: 'NOPE' })
    expect(useUIStore.getState().activeFlagEntityStack).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Commit (RED), SYNC, TEST — expect the new describe block to FAIL** (`pushActiveFlagEntity is not a function`)

```bash
git add -A && git commit -m "test(flags): active flag entity stack store tests (RED)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Then SYNC + TEST.

- [ ] **Step 4: Implement the store slice**

In `src/store/ui-store.ts`, inside the `UIState` interface after `clearFlagsSamplesFilter` (~line 178):

```ts
  // Multi-flag affordances (spec 2026-07-01): the entity detail surfaces the
  // user currently has open, top = "the page you're on". A stack so overlays
  // compose (worksheet drawer over a sample page); closing one restores the
  // one beneath. Drives the un-scoped flyout's context-aware Add Flag.
  activeFlagEntityStack: { type: string; id: string; label: string }[]
  pushActiveFlagEntity: (entry: {
    type: string
    id: string
    label: string
  }) => void
  popActiveFlagEntity: (entry: { type: string; id: string }) => void
```

In the defaults block (after `flagsSamplesFilter: null,` ~line 223):

```ts
      activeFlagEntityStack: [],
```

With the other flag actions (after `clearFlagsSamplesFilter`'s implementation, ~line 554):

```ts
      pushActiveFlagEntity: entry =>
        set(
          state => ({
            activeFlagEntityStack: [...state.activeFlagEntityStack, entry],
          }),
          undefined,
          'pushActiveFlagEntity'
        ),

      popActiveFlagEntity: entry =>
        set(
          state => {
            const stack = state.activeFlagEntityStack
            // Remove the LAST matching entry (not necessarily the top —
            // React unmount order isn't guaranteed to mirror mount order).
            let i = -1
            for (let j = stack.length - 1; j >= 0; j--) {
              const e = stack[j]
              if (e && e.type === entry.type && e.id === entry.id) {
                i = j
                break
              }
            }
            if (i === -1) return {}
            return {
              activeFlagEntityStack: [
                ...stack.slice(0, i),
                ...stack.slice(i + 1),
              ],
            }
          },
          undefined,
          'popActiveFlagEntity'
        ),
```

- [ ] **Step 5: Commit, SYNC, TEST + TYPECHECK — expect PASS**

```bash
git add -A && git commit -m "feat(flags-ui): activeFlagEntityStack — page-entity context for flag creation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `useRegisterActiveFlagEntity` hook + surface wiring

**Files:**
- Create: `src/components/flags/use-active-flag-entity.ts`
- Test: `src/components/flags/__tests__/use-active-flag-entity.test.tsx`
- Modify: `src/components/senaite/SampleDetails.tsx` (~line 2920, right after the `flagEntityType`/`flagEntityId` consts)
- Modify: `src/components/hplc/WorksheetDrawerHeader.tsx` (top of component body)

**Interfaces:**
- Consumes: Task 1's `pushActiveFlagEntity`/`popActiveFlagEntity`.
- Produces: `useRegisterActiveFlagEntity(type: string | null | undefined, id: string | null | undefined, label?: string | null): void` — registers while mounted, no-op when type/id falsy, label defaults to `entityLabel(type, id)`.

- [ ] **Step 1: Write the failing hook test**

`src/components/flags/__tests__/use-active-flag-entity.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUIStore } from '@/store/ui-store'
import { useRegisterActiveFlagEntity } from '@/components/flags/use-active-flag-entity'

describe('useRegisterActiveFlagEntity', () => {
  beforeEach(() => {
    useUIStore.setState({ activeFlagEntityStack: [] })
  })

  it('pushes on mount and pops on unmount', () => {
    const { unmount } = renderHook(() =>
      useRegisterActiveFlagEntity('sample', 'P-0071', 'P-0071')
    )
    expect(useUIStore.getState().activeFlagEntityStack).toEqual([
      { type: 'sample', id: 'P-0071', label: 'P-0071' },
    ])
    unmount()
    expect(useUIStore.getState().activeFlagEntityStack).toEqual([])
  })

  it('is a no-op while type/id are missing, registers once they resolve', () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useRegisterActiveFlagEntity('sample', id, id),
      { initialProps: { id: null as string | null } }
    )
    expect(useUIStore.getState().activeFlagEntityStack).toEqual([])
    rerender({ id: 'P-0071' })
    expect(useUIStore.getState().activeFlagEntityStack).toHaveLength(1)
  })

  it('re-registers (replace, not accumulate) when the entity changes', () => {
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useRegisterActiveFlagEntity('sample', id, id),
      { initialProps: { id: 'P-0071' } }
    )
    rerender({ id: 'P-0072' })
    const stack = useUIStore.getState().activeFlagEntityStack
    expect(stack).toHaveLength(1)
    expect(stack.at(-1)?.id).toBe('P-0072')
  })

  it('defaults the label from entityLabel when omitted', () => {
    renderHook(() => useRegisterActiveFlagEntity('sub_sample', '42'))
    expect(useUIStore.getState().activeFlagEntityStack.at(-1)?.label).toBe(
      'Vial 42'
    )
  })
})
```

- [ ] **Step 2: Commit (RED), SYNC, TEST — expect FAIL** (module not found)

```bash
git add -A && git commit -m "test(flags): useRegisterActiveFlagEntity hook tests (RED)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 3: Implement the hook**

`src/components/flags/use-active-flag-entity.ts`:

```ts
import { useEffect } from 'react'
import { useUIStore } from '@/store/ui-store'
import { entityLabel } from '@/components/flags/flag-entity'

/**
 * Registers the mounted detail surface's entity as "the page you're on" for
 * flag creation (spec 2026-07-01 multi-flag creation affordances). Pushes on
 * mount / pops on unmount so overlays compose — a worksheet drawer over a
 * sample page stacks, and closing it restores the sample context beneath.
 * No-op while `type`/`id` are missing (e.g. SampleDetails before data
 * resolves); registers when they appear.
 */
export function useRegisterActiveFlagEntity(
  type: string | null | undefined,
  id: string | null | undefined,
  label?: string | null
) {
  useEffect(() => {
    if (!type || !id) return
    const entry = { type, id, label: label || entityLabel(type, id) }
    useUIStore.getState().pushActiveFlagEntity(entry)
    return () => useUIStore.getState().popActiveFlagEntity(entry)
  }, [type, id, label])
}
```

- [ ] **Step 4: SYNC, TEST — expect PASS** (no commit yet; wiring next)

- [ ] **Step 5: Wire the two surfaces**

`src/components/senaite/SampleDetails.tsx` — import (with the other flags import, ~line 154):

```ts
import { useRegisterActiveFlagEntity } from '@/components/flags/use-active-flag-entity'
```

Immediately after the `flagEntityId` const (~line 2920):

```ts
  // Multi-flag affordances: while this page is mounted it is "the page you're
  // on" — the un-scoped flyout's Add Flag targets it. Human sample/vial id is
  // the label ("P-0144" / "P-0144-S01").
  useRegisterActiveFlagEntity(
    flagEntityId ? flagEntityType : null,
    flagEntityId || null,
    sampleId ?? null
  )
```

`src/components/hplc/WorksheetDrawerHeader.tsx` — import:

```ts
import { useRegisterActiveFlagEntity } from '@/components/flags/use-active-flag-entity'
```

Top of the component body (after props destructure):

```ts
  // Multi-flag affordances: the open worksheet drawer is "the page you're on".
  useRegisterActiveFlagEntity(
    'worksheet',
    String(worksheet.id),
    worksheet.title || `Worksheet ${worksheet.id}`
  )
```

- [ ] **Step 6: Commit, SYNC, TEST + TYPECHECK — expect PASS**

```bash
git add -A && git commit -m "feat(flags-ui): useRegisterActiveFlagEntity + sample/worksheet wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Context-aware flyout Add Flag (hidden with no context)

**Files:**
- Modify: `src/components/flags/RaiseFlagButton.tsx` (add `targetLabel` prop)
- Modify: `src/components/flags/FlagsFlyout.tsx` (un-scoped header, ~lines 263–278)
- Test: `src/components/flags/__tests__/FlagsFlyout.test.tsx` (append a describe block)

**Interfaces:**
- Consumes: `activeFlagEntityStack` (Task 1).
- Produces: `RaiseFlagButton` accepts `targetLabel?: string` (renders "on {label}" under the compose heading). Un-scoped flyout Add Flag: preset to stack top when present, absent when stack empty.

- [ ] **Step 1: Write the failing flyout tests**

Append to `src/components/flags/__tests__/FlagsFlyout.test.tsx` (reuse the file's existing mocks/`flag()` helper; seed the stack via `useUIStore.setState`):

```tsx
describe('FlagsFlyout context-aware Add Flag', () => {
  beforeEach(() => {
    useFlagsList.mockReset()
    useFlagsList.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    useUIStore.setState({
      flagsFlyoutOpen: true,
      flagsThreadId: null,
      flagsEntityFilter: null,
      flagsSamplesFilter: null,
      activeFlagEntityStack: [],
    })
  })

  it('hides Add Flag when no entity page is active', async () => {
    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)
    await screen.findByRole('tab', { name: 'Assigned to me' })
    expect(
      screen.queryByRole('button', { name: /add flag/i })
    ).not.toBeInTheDocument()
  })

  it('shows Add Flag preset to the active entity (no manual id form)', async () => {
    useUIStore.setState({
      activeFlagEntityStack: [
        { type: 'sample', id: 'P-0071', label: 'P-0071' },
      ],
    })
    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    await userEvent.click(
      await screen.findByRole('button', { name: /add flag/i })
    )
    // Compose targets the page entity: label line present, no raw-id input.
    expect(await screen.findByText('on P-0071')).toBeInTheDocument()
    expect(screen.queryByText('Entity id')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Commit (RED), SYNC, TEST — expect the two new tests to FAIL** (Add Flag currently always renders; no "on P-0071" line)

```bash
git add -A && git commit -m "test(flags): context-aware flyout Add Flag (RED)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 3: Implement**

`RaiseFlagButton.tsx` — add the prop (after `trigger` in the props type and destructure):

```ts
  /** Human label of the preset target — renders "on {label}" under the
   *  compose heading so it's obvious what the flag will attach to. */
  targetLabel?: string
```

Replace the popover heading line (`<p className="text-sm font-semibold">Raise a flag</p>`) with:

```tsx
        <div>
          <p className="text-sm font-semibold">Raise a flag</p>
          {targetLabel && (
            <p className="text-xs text-muted-foreground">on {targetLabel}</p>
          )}
        </div>
```

`FlagsFlyout.tsx` — selector with the other store reads (~line 98):

```ts
  const activeEntity = useUIStore(
    state => state.activeFlagEntityStack.at(-1) ?? null
  )
```

Replace the un-scoped header's `<RaiseFlagButton trigger={...Add Flag...} />` block (~lines 267–277) with:

```tsx
                    {activeEntity && (
                      <RaiseFlagButton
                        entityType={activeEntity.type}
                        entityId={activeEntity.id}
                        targetLabel={activeEntity.label}
                        trigger={
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1.5"
                            title={`Add flag on ${activeEntity.label}`}
                          >
                            <Plus className="h-3.5 w-3.5" /> Add Flag
                          </Button>
                        }
                      />
                    )}
```

(The manual entity-type/ID form in `RaiseFlagButton`'s generic mode stays in code but nothing renders it — per spec.)

- [ ] **Step 4: Commit, SYNC, TEST + TYPECHECK — expect PASS**

```bash
git add -A && git commit -m "feat(flags-ui): flyout Add Flag targets the page you're on (hidden without one)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: "Raise another flag" + on the flagged EntityFlagButton

**Files:**
- Modify: `src/components/flags/EntityFlagButton.tsx` (flagged branch, ~lines 146–197)
- Test: `src/components/flags/__tests__/EntityFlagButton.test.tsx` (append tests; reuse the file's existing `useEntityFlags` mock pattern)

**Interfaces:**
- Consumes: `RaiseFlagButton` + `targetLabel` (Task 3), `entityLabel` (existing).
- Produces: flagged state renders the pill PLUS an adjacent icon button `aria-label="Raise another flag"` that opens the compose preset to this entity. Pill behavior unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/flags/__tests__/EntityFlagButton.test.tsx`, following that file's existing mock setup for `useEntityFlags` (seed it to return one open flag, then two):

```tsx
  it('flagged: renders a Raise-another-flag + next to the pill', async () => {
    // seed useEntityFlags → one open flag (reuse the file's helper/mock)
    render(<EntityFlagButton entityType="sample" entityId="P-0071" />)
    expect(
      await screen.findByRole('button', { name: 'Raise another flag' })
    ).toBeInTheDocument()
  })

  it('the + opens the compose preset to this entity (pill untouched)', async () => {
    render(<EntityFlagButton entityType="sample" entityId="P-0071" />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Raise another flag' })
    )
    expect(await screen.findByText('on Sample P-0071')).toBeInTheDocument()
    // Pill still present and unchanged.
    expect(screen.getByText('Flagged')).toBeInTheDocument()
  })
```

Adapt the seeding lines to the file's actual mock helpers (it already mocks `@/hooks/use-flags`); keep assertions verbatim.

- [ ] **Step 2: Commit (RED), SYNC, TEST — expect FAIL** (no "Raise another flag" button)

```bash
git add -A && git commit -m "test(flags): raise-another + on flagged EntityFlagButton (RED)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 3: Implement**

`EntityFlagButton.tsx` — add imports:

```ts
import { Flag, Plus } from 'lucide-react'
import { entityLabel } from '@/components/flags/flag-entity'
```

Wrap the flagged-branch return: keep the existing pill `<Button>` exactly as-is but move `className` off the pill onto a new wrapper, and add the `+`:

```tsx
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <Button
        type="button"
        onClick={handleClick}
        aria-label={label}
        title={label}
        style={
          {
            backgroundColor: def.color,
            '--flag-glow-color': def.color,
          } as CSSProperties
        }
        className={cn(
          'flags-entity-glow h-auto items-center gap-2 border-0 py-1.5 font-bold text-white shadow-sm transition-transform hover:brightness-110 active:scale-95',
          lg ? 'px-3.5' : 'px-2.5'
        )}
      >
        {/* …existing pill children unchanged… */}
      </Button>
      {/* Multi-flag affordances: the discoverable "add another" — the pill
          views existing flags; this raises a new one on the same entity. */}
      <RaiseFlagButton
        entityType={entityType}
        entityId={entityId}
        targetLabel={entityLabel(entityType, entityId)}
        trigger={
          <Button
            variant="outline"
            size="icon"
            aria-label="Raise another flag"
            title="Raise another flag"
            className={cn(
              'shrink-0 text-muted-foreground hover:text-foreground',
              lg ? 'h-9 w-9' : 'h-8 w-8'
            )}
          >
            <Plus className={lg ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
          </Button>
        }
      />
    </span>
  )
```

- [ ] **Step 4: Commit, SYNC, TEST + TYPECHECK — expect PASS**

```bash
git add -A && git commit -m "feat(flags-ui): raise-another-flag + beside the flagged pill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Floating count-circle badge (EntityFlagButton + FlagIndicator)

**Files:**
- Modify: `src/components/flags/EntityFlagButton.tsx` (pill children: icon + inline count chip)
- Modify: `src/components/flags/FlagIndicator.tsx` (icon + inline count, ~lines 114–123)
- Test: existing `__tests__/EntityFlagButton.test.tsx` + `__tests__/FlagIndicator.test.tsx` — count-text assertions must still pass (badge keeps the same text content, e.g. `2`, `99+`)

**Interfaces:**
- Consumes: nothing new. Behavior (click → scoped list → drill in) unchanged; only presentation moves.

- [ ] **Step 1: EntityFlagButton — float the count over the icon**

Replace the pill's `<Flag …/>` and DELETE the inline `count > 1 && (…)` chip inside the "Flagged" row, so the icon block becomes:

```tsx
      <span className="relative shrink-0">
        <Flag
          className={cn(lg ? 'h-4 w-4' : 'h-3.5 w-3.5')}
          fill="currentColor"
        />
        {count > 1 && (
          <span
            className={cn(
              'absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-0.5 font-bold leading-none tabular-nums shadow-sm',
              lg ? 'text-[10px]' : 'text-[9px]'
            )}
            style={{ color: def.color }}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
```

(The "Flagged" text keeps its row; only the count chip moves onto the icon.)

- [ ] **Step 2: FlagIndicator — same treatment**

Replace lines 114–123 (`<Flag …/>` + the inline count span) with:

```tsx
      <span className="relative inline-flex shrink-0">
        <Flag
          className="h-3.5 w-3.5 shrink-0"
          fill={flagged ? 'currentColor' : 'none'}
        />
        {flagged && rollup.count > 1 && (
          <span
            className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-bold leading-none text-white tabular-nums"
            style={{ backgroundColor: color }}
          >
            {rollup.count > 99 ? '99+' : rollup.count}
          </span>
        )}
      </span>
```

- [ ] **Step 3: SYNC, TEST + TYPECHECK — all flag tests still PASS** (count text content unchanged; fix any layout-coupled assertions if they break — assertions on text like `'2'` must keep passing)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "style(flags-ui): floating count-circle badge on flag icons

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Gates, prettier, live verification

**Files:**
- No new code — verification + formatting only.

- [ ] **Step 1: Full gate run on the devbox** — TYPECHECK, TEST (expect prior 71 + new tests, all green), BUILD

- [ ] **Step 2: Prettier pass (CRLF gotcha)** — in the container `npx prettier --check src/` ; if laptop-committed files drifted, `npx prettier --write` them **in the container**, commit from the devbox worktree (`git -c user.name="Zstar0" -c user.email="forrestp@outlook.com" commit -aqm "style(flags-ui): prettier-format multi-flag affordance files" </dev/null`), push, then on the laptop `git pull --ff-only` (or `git reset --hard origin/feat/flag-system-frontend`)

- [ ] **Step 3: Live check at http://100.73.137.3:5552** (admin@accumark.local / flagsdemo2026):
  1. Open a sample details page → open the flyout from the header Flags button → **Add Flag shows and presets that sample** ("on P-…" in the compose).
  2. Navigate to a dashboard/list page → flyout → **Add Flag absent**.
  3. On a flagged sample: **+ button next to the pill** opens the compose preset; raise a 2nd flag → pill count badge floats over the icon; click pill → scoped list of both; drill into one.
  4. Worksheet drawer open → flyout Add Flag targets the worksheet; close drawer → falls back to the page beneath.

- [ ] **Step 4: Report for visual sign-off** — summarize at `:5552`, list the tweaks; PR #28 merge still HELD for explicit user OK.

---

## Self-review notes

- Spec coverage: §1 stack → Task 1–2; §2 flyout Add Flag/hidden-A → Task 3; §3 "+" → Task 4; §4 badge → Task 5; testing section → per-task tests + Task 6 gates; spec table amendment → Task 1 Step 1.
- Types: `ActiveFlagEntity` shape `{type,id,label}` consistent across Tasks 1–3; pop takes `{type,id}` only (label irrelevant to identity) — hook passes the full entry, which structurally satisfies it.
- No placeholders: Task 4 Step 1 asks the executor to adapt seeding lines to the existing mock file — the assertions and component usage are fully specified; the mock helpers already exist in that file.
