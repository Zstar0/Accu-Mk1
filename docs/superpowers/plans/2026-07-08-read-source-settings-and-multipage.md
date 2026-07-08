# Read-Source Settings & Multi-Page Read-from-Accu-Mk1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the binary, admin-only, per-tab sample-details read-source toggle into a persisted, per-page, org-controllable capability with a bidirectional label, extended to the samples-list page (fast registry read + progressive SENAITE backfill).

**Architecture:** A per-page global default lives in the existing `/settings` KV store; a per-page tri-state override lives in `sessionStorage`. One `useEffectiveReadSource(pageKey)` hook resolves `override ?? globalDefault[page] ?? 'senaite'`. A new `GET /registry/samples` serves the samples-list from `lims_samples`; per-row SENAITE queries backfill analytes/live values.

**Tech Stack:** React + TypeScript + Vite + react-query + zustand + vitest (frontend, **npm only**); FastAPI + SQLAlchemy + pytest (backend).

**Spec:** `C:\tmp\Accu-Mk1-panel\docs\superpowers\specs\2026-07-08-read-source-settings-and-multipage-design.md`

## Global Constraints

- **Frontend package manager: npm only.** Frontend tests: `cd C:/tmp/Accu-Mk1-panel && npm run test:run -- <file>`. Typecheck: `npm run typecheck`.
- **Backend tests:** `docker exec accu-mk1-panel-test python -m pytest tests/<file> -q` (that container is the read-toggle backend at `C:\tmp\Accu-Mk1-panel\backend`, pytest already installed).
- **Additive only.** Do not break existing tests: `src/lib/__tests__/read-source.test.ts`, `src/lib/__tests__/lookup-source.test.ts`, `src/components/senaite/__tests__/ReadSourceBanner.test.tsx`, `backend/tests/test_registry_read*.py`. A failing existing test defaults to "update the test to the new API," not "the code is wrong" — but confirm intent.
- **Types (verbatim):** `type ReadSource = 'senaite' | 'mk1'`; `type PageKey = 'sample_details' | 'samples_list'`; default source is `'senaite'`.
- **Setting key:** `registry_read_source`, value = JSON string of `Partial<Record<PageKey, ReadSource>>`.
- **sessionStorage key:** keep `registryReadSource`; value migrates from a bare `'senaite'|'mk1'` string to a JSON `Partial<Record<PageKey, ReadSource>>` map.
- **Branch:** work on `feat/read-source-settings-multipage`, created off `feat/registry-read-toggle` (HEAD `a47cf74`). Explicit `git add <files>`, never `-A`.
- **Commit message trailer:** none required by repo; keep messages conventional (`feat:`/`test:`/`refactor:`).

---

### Task 0: Branch setup

**Files:** none (git only).

- [ ] **Step 1: Create the feature branch off the read-toggle branch**

```bash
cd C:/tmp/Accu-Mk1-panel
git checkout feat/registry-read-toggle
git checkout -b feat/read-source-settings-multipage
git add docs/superpowers/specs/2026-07-08-read-source-settings-and-multipage-design.md docs/superpowers/plans/2026-07-08-read-source-settings-and-multipage.md
git commit -m "docs: read-source settings + multipage design + plan"
```

Expected: new branch `feat/read-source-settings-multipage`, spec + plan committed.

---

### Task 1: Precedence core — tri-state override + global default + `useEffectiveReadSource`

Rewrites `read-source.ts` from a single binary sessionStorage value into a per-page tri-state override store plus a resolution hook. Pure helpers are unit-tested without react-query.

**Files:**
- Modify: `src/lib/read-source.ts`
- Modify (tests): `src/lib/__tests__/read-source.test.ts`
- Test (new): `src/lib/__tests__/effective-read-source.test.ts`

**Interfaces — Produces:**
```ts
export type ReadSource = 'senaite' | 'mk1'
export type PageKey = 'sample_details' | 'samples_list'
export const DEFAULT_READ_SOURCE: ReadSource // 'senaite'
export function getOverride(page: PageKey): ReadSource | null
export function setOverride(page: PageKey, source: ReadSource | null): void  // null clears → follow global
export function useReadSourceOverride(page: PageKey): { override: ReadSource | null; setOverride: (s: ReadSource | null) => void }
export function parseGlobalReadSource(rawValue: string | undefined | null): Partial<Record<PageKey, ReadSource>>
export function resolveEffective(page: PageKey, override: ReadSource | null, globalMap: Partial<Record<PageKey, ReadSource>>): ReadSource
export function useEffectiveReadSource(page: PageKey): { effective: ReadSource; override: ReadSource | null; setOverride: (s: ReadSource | null) => void; globalDefault: ReadSource }
```
**Consumes:** `getSettings` + `Setting` from `@/lib/api`; `useQuery` from `@tanstack/react-query`.

- [ ] **Step 1: Write failing tests for the pure helpers + tri-state store**

Replace `src/lib/__tests__/read-source.test.ts` contents with tests for the new API (keep the file; it's in the existing-test allowlist):

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getOverride, setOverride, parseGlobalReadSource, resolveEffective, DEFAULT_READ_SOURCE,
} from '@/lib/read-source'

beforeEach(() => sessionStorage.clear())

describe('tri-state per-page override store', () => {
  it('defaults to null (follow global) when unset', () => {
    expect(getOverride('sample_details')).toBeNull()
  })
  it('sets and reads a per-page override independently', () => {
    setOverride('sample_details', 'mk1')
    expect(getOverride('sample_details')).toBe('mk1')
    expect(getOverride('samples_list')).toBeNull()
  })
  it('clears an override with null', () => {
    setOverride('sample_details', 'mk1')
    setOverride('sample_details', null)
    expect(getOverride('sample_details')).toBeNull()
  })
  it('migrates a legacy bare value to a sample_details override', () => {
    sessionStorage.setItem('registryReadSource', 'mk1')
    expect(getOverride('sample_details')).toBe('mk1')
    // and rewrites it as JSON so subsequent reads are the new shape
    expect(JSON.parse(sessionStorage.getItem('registryReadSource')!)).toEqual({ sample_details: 'mk1' })
  })
})

describe('parseGlobalReadSource', () => {
  it('returns {} for undefined/empty/garbage', () => {
    expect(parseGlobalReadSource(undefined)).toEqual({})
    expect(parseGlobalReadSource('')).toEqual({})
    expect(parseGlobalReadSource('not json')).toEqual({})
  })
  it('parses a valid map and drops invalid values', () => {
    expect(parseGlobalReadSource('{"sample_details":"mk1","samples_list":"nope"}'))
      .toEqual({ sample_details: 'mk1' })
  })
})

describe('resolveEffective precedence', () => {
  it('override wins over global', () => {
    expect(resolveEffective('sample_details', 'senaite', { sample_details: 'mk1' })).toBe('senaite')
  })
  it('falls back to global when no override', () => {
    expect(resolveEffective('sample_details', null, { sample_details: 'mk1' })).toBe('mk1')
  })
  it('falls back to default when neither set', () => {
    expect(resolveEffective('samples_list', null, {})).toBe(DEFAULT_READ_SOURCE)
    expect(DEFAULT_READ_SOURCE).toBe('senaite')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:run -- src/lib/__tests__/read-source.test.ts`
Expected: FAIL (new exports not defined).

- [ ] **Step 3: Rewrite `src/lib/read-source.ts`**

```ts
import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSettings } from '@/lib/api'

export type ReadSource = 'senaite' | 'mk1'
export type PageKey = 'sample_details' | 'samples_list'
export const DEFAULT_READ_SOURCE: ReadSource = 'senaite'
export const READ_SOURCE_SETTING_KEY = 'registry_read_source'

const KEY = 'registryReadSource'
const PAGE_KEYS: readonly PageKey[] = ['sample_details', 'samples_list']
const listeners = new Set<() => void>()
const isSource = (v: unknown): v is ReadSource => v === 'senaite' || v === 'mk1'
const isPage = (v: unknown): v is PageKey => PAGE_KEYS.includes(v as PageKey)

/** Read the sessionStorage override map, migrating a legacy bare string. */
function readOverrideMap(): Partial<Record<PageKey, ReadSource>> {
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return {}
  // Legacy: a bare 'senaite'|'mk1' string means a sample_details override.
  if (isSource(raw)) {
    const migrated = { sample_details: raw }
    sessionStorage.setItem(KEY, JSON.stringify(migrated))
    return migrated
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      const out: Partial<Record<PageKey, ReadSource>> = {}
      for (const [k, v] of Object.entries(parsed)) if (isPage(k) && isSource(v)) out[k] = v
      return out
    }
  } catch { /* fall through */ }
  return {}
}

export function getOverride(page: PageKey): ReadSource | null {
  return readOverrideMap()[page] ?? null
}

export function setOverride(page: PageKey, source: ReadSource | null): void {
  const map = readOverrideMap()
  if (source === null) delete map[page]
  else map[page] = source
  sessionStorage.setItem(KEY, JSON.stringify(map))
  listeners.forEach((l) => l())
}

export function parseGlobalReadSource(rawValue: string | undefined | null): Partial<Record<PageKey, ReadSource>> {
  if (!rawValue) return {}
  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<Record<PageKey, ReadSource>> = {}
    for (const [k, v] of Object.entries(parsed)) if (isPage(k) && isSource(v)) out[k] = v
    return out
  } catch { return {} }
}

export function resolveEffective(
  page: PageKey, override: ReadSource | null, globalMap: Partial<Record<PageKey, ReadSource>>,
): ReadSource {
  return override ?? globalMap[page] ?? DEFAULT_READ_SOURCE
}

export function useReadSourceOverride(page: PageKey) {
  const override = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => getOverride(page),
    (): ReadSource | null => null,
  )
  return { override, setOverride: (s: ReadSource | null) => setOverride(page, s) }
}

export function useEffectiveReadSource(page: PageKey) {
  const { override, setOverride: set } = useReadSourceOverride(page)
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const raw = settings?.find((s) => s.key === READ_SOURCE_SETTING_KEY)?.value
  const globalMap = parseGlobalReadSource(raw)
  const globalDefault = globalMap[page] ?? DEFAULT_READ_SOURCE
  return { effective: resolveEffective(page, override, globalMap), override, setOverride: set, globalDefault }
}
```

- [ ] **Step 4: Run tests to verify they pass + typecheck**

Run: `npm run test:run -- src/lib/__tests__/read-source.test.ts && npm run typecheck`
Expected: PASS + clean typecheck. (Typecheck will surface every stale `useReadSource` importer — those are fixed in Tasks 4 & 6. If typecheck fails only in `SampleDetails.tsx`/`SampleRegistryDebug.tsx`, that's expected here; note it and continue. If you prefer green typecheck at each task, keep a thin back-compat `useReadSource` re-export that maps to `useReadSourceOverride('sample_details')` and remove it in Task 4.)

- [ ] **Step 5: Add a hook-level test for `useEffectiveReadSource`**

Create `src/lib/__tests__/effective-read-source.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffectiveReadSource } from '@/lib/read-source'
import * as api from '@/lib/api'
import { vi } from 'vitest'

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => sessionStorage.clear())

it('resolves global default then override', async () => {
  vi.spyOn(api, 'getSettings').mockResolvedValue([
    { key: 'registry_read_source', value: '{"sample_details":"mk1"}' } as api.Setting,
  ])
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { result } = renderHook(() => useEffectiveReadSource('sample_details'), { wrapper: wrapper(qc) })
  // global default resolves to mk1 once settings load
  await vi.waitFor(() => expect(result.current.effective).toBe('mk1'))
  // per-page override wins
  act(() => result.current.setOverride('senaite'))
  expect(result.current.effective).toBe('senaite')
})
```

Run: `npm run test:run -- src/lib/__tests__/effective-read-source.test.ts`
Expected: PASS. (If `Setting` isn't exported from api, import the type via `import type { Setting } from '@/lib/api'` — it is exported per DataPipelinePane usage.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/read-source.ts src/lib/__tests__/read-source.test.ts src/lib/__tests__/effective-read-source.test.ts
git commit -m "feat(read-source): per-page tri-state override + global-default resolution hook"
```

---

### Task 2: `ReadSourceIndicator` bidirectional label

**Files:**
- Create: `src/components/senaite/ReadSourceIndicator.tsx`
- Test: `src/components/senaite/__tests__/ReadSourceIndicator.test.tsx`

**Interfaces — Produces:** `ReadSourceIndicator({ source, className }: { source: ReadSource; className?: string })`
**Consumes:** `ReadSource` from `@/lib/read-source`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { ReadSourceIndicator } from '@/components/senaite/ReadSourceIndicator'

it('labels Accu-Mk1', () => {
  render(<ReadSourceIndicator source="mk1" />)
  expect(screen.getByText(/Read from Accu-Mk1/i)).toBeInTheDocument()
})
it('labels SENAITE', () => {
  render(<ReadSourceIndicator source="senaite" />)
  expect(screen.getByText(/Read from SENAITE/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npm run test:run -- src/components/senaite/__tests__/ReadSourceIndicator.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the component**

```tsx
import { cn } from '@/lib/utils'
import { Database, FlaskConical } from 'lucide-react'
import type { ReadSource } from '@/lib/read-source'

/** Small always-on badge stating where the page's basic-info is read from. */
export function ReadSourceIndicator({ source, className }: { source: ReadSource; className?: string }) {
  const mk1 = source === 'mk1'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono',
        mk1 ? 'bg-emerald-600/15 text-emerald-500' : 'bg-muted text-muted-foreground',
        className,
      )}
      title={mk1 ? 'Basic-info sourced from the Accu-Mk1 registry' : 'Basic-info sourced live from SENAITE'}
    >
      {mk1 ? <Database size={11} /> : <FlaskConical size={11} />}
      {mk1 ? 'Read from Accu-Mk1' : 'Read from SENAITE'}
    </span>
  )
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:run -- src/components/senaite/__tests__/ReadSourceIndicator.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/ReadSourceIndicator.tsx src/components/senaite/__tests__/ReadSourceIndicator.test.tsx
git commit -m "feat(read-source): bidirectional ReadSourceIndicator badge"
```

---

### Task 3: "Data Source" Preferences pane (global defaults, admin-gated)

Adds a pane that reads/writes the `registry_read_source` global map. Follows the `DataPipelinePane` pattern (`getSettings` query → local state → `updateSetting` mutation → invalidate `['settings']`). Editing is gated to admins in the UI.

**Files:**
- Create: `src/components/preferences/panes/DataSourcePane.tsx`
- Modify: `src/components/preferences/PreferencesDialog.tsx` (register pane)
- Modify: `src/i18n/locales/en.json` (or wherever `preferences.*` keys live — grep `"dataPipeline"` to locate) — add `preferences.dataSource` label
- Test: `src/components/preferences/panes/__tests__/DataSourcePane.test.tsx`

**Interfaces — Consumes:** `getSettings`, `updateSetting`, `Setting` from `@/lib/api`; `READ_SOURCE_SETTING_KEY`, `parseGlobalReadSource`, `PageKey`, `ReadSource` from `@/lib/read-source`; `useAuthStore` (`s.user?.role === 'admin'`).

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'
import { DataSourcePane } from '@/components/preferences/panes/DataSourcePane'
import * as api from '@/lib/api'

vi.mock('@/store/auth-store', () => ({ useAuthStore: (sel: any) => sel({ user: { role: 'admin' } }) }))

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><DataSourcePane /></QueryClientProvider>)
}

it('saves the per-page global map', async () => {
  vi.spyOn(api, 'getSettings').mockResolvedValue([
    { key: 'registry_read_source', value: '{"sample_details":"senaite","samples_list":"senaite"}' } as api.Setting,
  ])
  const put = vi.spyOn(api, 'updateSetting').mockResolvedValue({} as api.Setting)
  renderPane()
  await waitFor(() => screen.getByText(/sample details/i))
  await userEvent.click(screen.getByRole('button', { name: /sample details:.*Accu-Mk1/i }))
  await userEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(put).toHaveBeenCalledWith('registry_read_source', expect.stringContaining('"sample_details":"mk1"')))
})
```

(Confirm the auth store module path with `grep -rn "useAuthStore" src/store` — adjust the `vi.mock` path if it's `@/store/auth-store` vs another name.)

- [ ] **Step 2: Run to verify fail**

Run: `npm run test:run -- src/components/preferences/panes/__tests__/DataSourcePane.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `DataSourcePane.tsx`**

Model it on `src/components/preferences/panes/DataPipelinePane.tsx`. Requirements:
- `useQuery(['settings'], getSettings)`; derive the current map with `parseGlobalReadSource(settingsMap.get('registry_read_source'))`.
- Local `useState<Record<PageKey, ReadSource>>` seeded from the fetched map (missing keys default `'senaite'`), synced via the render-time `prevSettings` pattern used in DataPipelinePane.
- One `SettingsSection` per page (`sample_details` → "Sample details", `samples_list` → "Samples list") with a 2-button segmented control (`SENAITE` / `Accu-Mk1`) whose buttons have accessible names like `Sample details: SENAITE` / `Sample details: Accu-Mk1`.
- `const isAdmin = useAuthStore(s => s.user?.role === 'admin')`; when `!isAdmin`, render the toggles disabled + a "Only admins can change this" note, and hide the Save button.
- Save: `updateSetting('registry_read_source', JSON.stringify(localMap))` then `queryClient.invalidateQueries({ queryKey: ['settings'] })` + success toast.
- Include copy: "Applies to all users. Anyone can override per page." and a note on the `samples_list` row: "Samples-list Accu-Mk1 is preview-only until freshness sync ships — leave on SENAITE for everyone."

- [ ] **Step 4: Register the pane in `PreferencesDialog.tsx`**

- Add `'dataSource'` to the `PreferencePane` union (after `'dataPipeline'`).
- Add to `navigationItems`: `{ id: 'dataSource' as const, labelKey: 'preferences.dataSource', icon: DatabaseZap }` (import `DatabaseZap` from `lucide-react`).
- Import `DataSourcePane` and add `{activePane === 'dataSource' && <DataSourcePane />}` to the render switch.
- Add `"dataSource": "Data Source"` to the `preferences` block of the en locale file.

- [ ] **Step 5: Run test + typecheck**

Run: `npm run test:run -- src/components/preferences/panes/__tests__/DataSourcePane.test.tsx && npm run typecheck`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/preferences/panes/DataSourcePane.tsx src/components/preferences/PreferencesDialog.tsx src/components/preferences/panes/__tests__/DataSourcePane.test.tsx src/i18n/locales/en.json
git commit -m "feat(preferences): Data Source pane — per-page global read-source default"
```

---

### Task 4: sample-details integration + widen details endpoint auth

Switch sample-details from the admin-gated binary resolution to `useEffectiveReadSource('sample_details')`, add a visible tri-state override control (all users) + the indicator, and widen the details endpoint so non-admins can actually read from the registry. **No new analytes backfill here:** `/registry/sample/{id}/details` already calls `lookup_senaite_sample` as its base, so SENAITE analytes are present in that response (the registry just doesn't overlay them). Backfill is a samples-list concern (Task 6).

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (around 3308–3322, 4605, and add the header control)
- Modify: `backend/main.py:16836` (`/registry/sample/{sample_id}/details` auth)
- Modify: `backend/tests/test_registry_read_endpoint.py` (auth expectation)

**Interfaces — Consumes:** `useEffectiveReadSource` from `@/lib/read-source`; `ReadSourceIndicator`.

- [ ] **Step 1 (backend): update the endpoint auth test first**

In `backend/tests/test_registry_read_endpoint.py`, change the auth-gate expectation: a normal authenticated (non-admin) user must now get `200`/`404` (not `403`) from `GET /registry/sample/{id}/details`; unauthenticated still `401`. (Find the test that asserts admin-gating and adjust it to assert `get_current_user`-level access. If the suite has no non-admin case, add one using the same auth fixture pattern the other endpoint tests use.)

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read_endpoint.py -q`
Expected: FAIL on the changed auth assertion.

- [ ] **Step 2 (backend): widen the endpoint**

In `backend/main.py`, change `get_sample_read_from_registry`'s dependency from `admin=Depends(require_admin)` to `current_user=Depends(get_current_user)` and rename the local use (`_current_user=current_user` passed to `lookup_senaite_sample`). Keep the "auth gate resolved before db" ordering. Rationale comment: read-only projection of data the user already sees; see spec Access-control.

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read_endpoint.py -q`
Expected: PASS.

- [ ] **Step 3 (frontend): swap resolution to the hook**

In `SampleDetails.tsx`:
- Replace the import `import { useReadSource } from '@/lib/read-source'` with `import { useEffectiveReadSource } from '@/lib/read-source'` and add `import { ReadSourceIndicator } from '@/components/senaite/ReadSourceIndicator'`.
- Replace lines ~3318–3322:
```ts
  const { source: readSource } = useReadSource()
  ...
  const effectiveReadSource = isAdmin ? readSource : 'senaite'
```
with:
```ts
  const { effective: effectiveReadSource, override, setOverride } = useEffectiveReadSource('sample_details')
```
(`isAdmin` at 3308 stays for other uses; the read-source is no longer admin-gated — that's the point of D2.)

- [ ] **Step 4 (frontend): add the visible tri-state override control + indicator in the page header**

Near the sample-details header (co-locate with where the title/actions render; the debug-overlay trigger at ~4786 is a reference point), add:
```tsx
<div className="flex items-center gap-2">
  <ReadSourceIndicator source={effectiveReadSource} />
  <div className="flex items-center gap-0.5 rounded border p-0.5">
    {([['follow', null], ['senaite', 'senaite'], ['mk1', 'mk1']] as const).map(([label, val]) => (
      <button
        key={label}
        onClick={() => setOverride(val)}
        className={cn('px-1.5 py-0.5 text-[10px] font-mono rounded',
          override === val ? 'bg-emerald-600/30 text-emerald-400' : 'text-muted-foreground hover:text-foreground')}
      >
        {label === 'follow' ? 'Follow default' : label === 'senaite' ? 'SENAITE' : 'Accu-Mk1'}
      </button>
    ))}
  </div>
</div>
```
Keep the existing `<ReadSourceBanner>` at ~4605 (its "N/M fields" detail still applies when reading mk1).

- [ ] **Step 5 (frontend): fix the debug overlay's toggle**

`SampleRegistryDebug.tsx` imports `useReadSource` (now removed). Update it to `useReadSourceOverride('sample_details')` (binary→tri-state is unnecessary in the diagnostic; a SENAITE/Accu-Mk1 pair that calls `setOverride(page, s)` is fine — map its two buttons to `setOverride('senaite'|'mk1')`).

- [ ] **Step 6: Run frontend typecheck + affected tests**

Run: `npm run typecheck && npm run test:run -- src/components/senaite`
Expected: clean typecheck (all `useReadSource` importers now migrated) + green.

- [ ] **Step 7: Commit**

```bash
git add src/components/senaite/SampleDetails.tsx src/components/senaite/SampleRegistryDebug.tsx backend/main.py backend/tests/test_registry_read_endpoint.py
git commit -m "feat(read-source): sample-details effective-source + visible override; widen details endpoint to authenticated users"
```

---

### Task 5: Backend `GET /registry/samples` + `registry_rows_to_list()`

Serves the samples-list from `lims_samples` in the `SenaiteSamplesResponse` shape, authenticated (not admin-only).

**Files:**
- Create: `backend/sub_samples/registry_list.py`
- Modify: `backend/main.py` (add the route near the details endpoint ~16876)
- Test: `backend/tests/test_registry_list.py`

**Interfaces — Produces:**
- `registry_rows_to_list(rows: list[LimsSample]) -> list[dict]` (each dict matches `SenaiteSample`: `uid,id,title,client_id,client_order_number,date_created,date_received,date_sampled,review_state,sample_type,contact,verification_code,analytes`).
- `GET /registry/samples?review_state=&limit=&b_start=&search=&search_field=` → `SenaiteSamplesResponse` (`{items, total, b_start}`), `Depends(get_current_user)`.
**Consumes:** `LimsSample` (models), `SenaiteSamplesResponse` (existing response model), `select`, `get_db`, `get_current_user`.

- [ ] **Step 1: Write the failing resolver + endpoint tests**

Create `backend/tests/test_registry_list.py` (mirror the fixture/setup style of `test_registry_read_endpoint.py`):

```python
import json
from sub_samples.registry_list import registry_rows_to_list
from models import LimsSample

def _row(**kw):
    r = LimsSample(sample_id=kw.get('sample_id', 'P-1'))
    for k, v in kw.items(): setattr(r, k, v)
    return r

def test_maps_core_fields_and_parses_analytes():
    row = _row(sample_id='P-9', external_lims_uid='u9', client_order_number='WP-1',
               status='sample_due', sample_type_title='Peptide', contact_title='Acme',
               analytes=json.dumps([{'name': 'DSIP - Identity (HPLC)', 'declared_quantity': None}]))
    [out] = registry_rows_to_list([row])
    assert out['id'] == 'P-9'
    assert out['uid'] == 'u9'
    assert out['client_order_number'] == 'WP-1'
    assert out['review_state'] == 'sample_due'
    assert out['sample_type'] == 'Peptide'
    assert out['contact'] == 'Acme'
    assert out['analytes'] == ['DSIP - Identity (HPLC)']

def test_analytes_empty_when_missing_or_bad_json():
    assert registry_rows_to_list([_row(analytes=None)])[0]['analytes'] == []
    assert registry_rows_to_list([_row(analytes='not json')])[0]['analytes'] == []
```

Add an endpoint test (TestClient) asserting: authenticated user → `200` with `{items,total,b_start}`; `review_state` filter narrows; unauthenticated → `401`. Reuse the auth/client fixtures from `test_registry_read_endpoint.py`.

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_list.py -q`
Expected: FAIL (module/route missing).

- [ ] **Step 2: Implement `registry_list.py`**

```python
"""Map lims_samples rows into the SenaiteSample list shape for GET /registry/samples."""
import json
from typing import Any
from models import LimsSample


def _analyte_names(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    names: list[str] = []
    for a in parsed:
        if isinstance(a, dict) and a.get("name"):
            names.append(str(a["name"]))
    return names


def registry_rows_to_list(rows: list[LimsSample]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append({
            "uid": r.external_lims_uid,
            "id": r.sample_id,
            "title": r.sample_id,
            "client_id": r.client_id,
            "client_order_number": r.client_order_number,
            "date_created": r.date_created.isoformat() if r.date_created else None,
            "date_received": r.date_received.isoformat() if r.date_received else None,
            "date_sampled": r.date_sampled.isoformat() if r.date_sampled else None,
            "review_state": r.status or "",
            "sample_type": r.sample_type_title,
            "contact": r.contact_title,
            "verification_code": r.verification_code,
            "analytes": _analyte_names(r.analytes),
        })
    return out
```

- [ ] **Step 3: Add the route in `main.py`** (after `get_sample_read_from_registry`, ~16876)

```python
@app.get("/registry/samples", response_model=SenaiteSamplesResponse)
async def list_samples_from_registry(
    review_state: str | None = None,
    limit: int = 50,
    b_start: int = 0,
    search: str | None = None,
    search_field: str | None = None,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Samples-list read sourced from the local lims_samples registry (no SENAITE
    round-trip). Live/SENAITE-only fields (analytes, current review_state) are
    refreshed per-row on the client via progressive backfill."""
    from sub_samples.registry_list import registry_rows_to_list

    stmt = select(LimsSample)
    if review_state:
        stmt = stmt.where(LimsSample.status == review_state)
    if search:
        s = f"%{search.strip()}%"
        if search_field == "order_number":
            stmt = stmt.where(LimsSample.client_order_number.ilike(s))
        elif search_field == "verification_code":
            stmt = stmt.where(LimsSample.verification_code.ilike(s))
        else:
            stmt = stmt.where(LimsSample.sample_id.ilike(s))
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = db.execute(
        stmt.order_by(LimsSample.id.desc()).offset(b_start).limit(limit)
    ).scalars().all()
    return SenaiteSamplesResponse(items=registry_rows_to_list(rows), total=total, b_start=b_start)
```

(Confirm `func` is imported in main.py — it is used elsewhere; if not, add `from sqlalchemy import func`.)

- [ ] **Step 4: Run tests**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_list.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/registry_list.py backend/main.py backend/tests/test_registry_list.py
git commit -m "feat(registry): GET /registry/samples list read from lims_samples"
```

---

### Task 6: samples-list integration — source switch + indicator + override + progressive backfill

Wire `SenaiteDashboard` (the `samples` subsection) to fetch from `/registry/samples` when effective source is `mk1`, show the indicator + tri-state override, and backfill each row's analytes + live review_state from SENAITE.

**Files:**
- Modify: `src/lib/api.ts` (add `getRegistrySamples`, same signature/return as `getSenaiteSamples`)
- Modify: `src/components/senaite/SenaiteDashboard.tsx` (source switch, header controls, per-row backfill)
- Create: `src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx`

**Interfaces — Consumes:** `useEffectiveReadSource('samples_list')`, `ReadSourceIndicator`, `getSenaiteSamples`/`getRegistrySamples`, `useParentSampleDetails` (or a lighter per-row query).

- [ ] **Step 1: Add `getRegistrySamples` in `api.ts`** (next to `getSenaiteSamples`, ~4085)

```ts
export async function getRegistrySamples(
  reviewState?: string, limit = 50, bStart = 0, search?: string,
  searchField?: 'verification_code' | 'order_number',
): Promise<SenaiteSamplesResponse> {
  const params = new URLSearchParams({ limit: String(limit), b_start: String(bStart) })
  if (reviewState) params.set('review_state', reviewState)
  if (search) params.set('search', search)
  if (searchField) params.set('search_field', searchField)
  const response = await fetch(`${API_BASE_URL()}/registry/samples?${params}`, { headers: getBearerHeaders() })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Registry samples failed: ${response.status}`)
  }
  return response.json()
}
```

- [ ] **Step 2: Write the failing integration test**

`src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx` — mock `getSettings` to return `{"samples_list":"mk1"}`, spy on `getRegistrySamples` and `getSenaiteSamples`, render the dashboard inside a `QueryClientProvider`, and assert: in **mk1** mode BOTH `getRegistrySamples` (fast render) AND `getSenaiteSamples` (one background refresh) are called, the "Read from Accu-Mk1" indicator renders, and a row's `review_state` updates to the refresh value once it resolves. Inverse: global `senaite` → only `getSenaiteSamples` is called, `getRegistrySamples` is NOT.

Run: `npm run test:run -- src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Switch the list fetch by effective source**

In `SenaiteDashboard.tsx`: add `const { effective, override, setOverride } = useEffectiveReadSource('samples_list')`. Change the samples `useQuery` so its `queryKey` includes `effective` and its `queryFn` calls `effective === 'mk1' ? getRegistrySamples(...) : getSenaiteSamples(...)` with identical args. Render `<ReadSourceIndicator source={effective} />` + the same tri-state override control markup as Task 4 (extract it to a shared `src/components/senaite/ReadSourceControls.tsx` in this step and reuse it in SampleDetails to avoid duplication — DRY).

- [ ] **Step 4: BATCHED progressive SENAITE refresh (only when `effective === 'mk1'`)**

**Do NOT fetch per-row.** A per-row `lookupSenaiteSample` on a 50-row list re-creates the `/wizard/senaite/lookup` flood removed in PR #49 and can take down the single-Zope SENAITE instance (documented 15-min outage). Instead, fire **one** background call — the same `getSenaiteSamples(...)` the SENAITE-mode list would make — and merge its live fields into the registry rows by `id`. It returns both `review_state` and `analytes` for all rows in a single request, which is exactly the SENAITE-authoritative set we want to refresh.

At the list level (not per row):
```ts
const registryQ = useQuery({
  queryKey: ['samples', 'registry', reviewState, limit, bStart, search, searchField],
  queryFn: () => getRegistrySamples(reviewState, limit, bStart, search, searchField),
  enabled: effective === 'mk1',
})
// One background SENAITE call refreshes review_state + analytes for the whole page.
const refreshQ = useQuery({
  queryKey: ['samples', 'senaite-refresh', reviewState, limit, bStart, search, searchField],
  queryFn: () => getSenaiteSamples(reviewState, limit, bStart, search, searchField),
  enabled: effective === 'mk1',
  staleTime: 60_000,
})
const liveById = new Map((refreshQ.data?.items ?? []).map(s => [s.id, s]))
const rows = (registryQ.data?.items ?? []).map(r => {
  const live = liveById.get(r.id)
  return live ? { ...r, review_state: live.review_state, analytes: live.analytes } : r
})
const refreshing = refreshQ.isFetching && !refreshQ.data
```
Render `rows` immediately (registry values); when `refreshQ` lands, `review_state`/`analytes` update in place. Show a subtle page-level "refreshing from SENAITE…" affordance while `refreshing`. Errors on `refreshQ` are swallowed (the registry render stands). When `effective === 'senaite'`, use the existing `getSenaiteSamples` path unchanged and no refresh query.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test:run -- src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx && npm run typecheck`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/components/senaite/SenaiteDashboard.tsx src/components/senaite/ReadSourceControls.tsx src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx
git commit -m "feat(read-source): samples-list registry read + indicator/override + progressive SENAITE backfill"
```

---

### Task 7: Full-suite gate + stack validation

**Files:** none (validation only).

- [ ] **Step 1: Run the affected suites + typecheck**

```bash
cd C:/tmp/Accu-Mk1-panel
npm run typecheck
npm run test:run -- src/lib/__tests__/read-source.test.ts src/lib/__tests__/effective-read-source.test.ts src/lib/__tests__/lookup-source.test.ts src/components/senaite
docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read.py tests/test_registry_read_endpoint.py tests/test_registry_list.py -q
```
Expected: green (modulo the known baseline failures — gate on the normalized failure-set diff, not absolute pass).

- [ ] **Step 2: Deploy the branch to the registry stack + eyeball**

Push the branch; on the devbox worktree `~/worktrees/Accu-Mk1-registry` (`test/nid-mirror-panel`): `git fetch origin && git merge origin/feat/read-source-settings-multipage --no-edit`, then `docker compose -p accumark-registry restart accu-mk1-backend accu-mk1-frontend`. Verify: Preferences → Data Source pane flips `sample_details` global; `http://100.73.137.3:5652/#senaite/samples` shows the indicator + override and (via override → Accu-Mk1) a fast registry render with analytes backfilling; `curl http://localhost:5650/registry/samples` returns `401` unauth / `200` with a token.

- [ ] **Step 3: Request review** — use `superpowers:requesting-code-review` for a whole-branch review before PR.

## Self-review notes (coverage against spec)

- Precedence (§1) → Task 1. Global-default pane (§2) → Task 3. Bidirectional label (§3) → Task 2 + used in 4/6. sample-details (§4) → Task 4 (backfill correctly omitted there — base lookup already includes SENAITE analytes; documented). samples-list + endpoint (§5) → Tasks 5/6. Progressive backfill (§6) → Task 6. Access-control widening (sign-off item) → Task 4/5 (`get_current_user`). Testing (§7) → each task + Task 7.
- **Deviation from spec, intentional:** spec §4/§6 said backfill "applies to both pages"; the plan scopes backfill to the samples-list only, because `/registry/sample/{id}/details` already returns SENAITE analytes via its base `lookup_senaite_sample` call — a sample-details backfill would be redundant. Flagged for the reviewer.
- **Confirm-at-execution:** auth-store import path (Task 3 Step 1); i18n locale file path (Task 3 Step 4); `func` import in main.py (Task 5 Step 3); exact `SenaiteDashboard` query location (Task 6).
