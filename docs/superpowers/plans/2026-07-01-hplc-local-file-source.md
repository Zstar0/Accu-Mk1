# HPLC prep — local files as a second data source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Local files" source tab to the per-prep HPLC folder picker so a tech can pick a local folder of HPLC CSVs and process it through the exact same flow as the SharePoint path — plus a throttle nudge that points at the Local tab when SharePoint returns a 429.

**Architecture:** Frontend-only. Pure classification/read helpers live in one testable module. `HplcScanMatch` gains an additive `source`/`local_files` carrier. The override dialog becomes a two-tab shell (SharePoint | Local files); the Local tab reads the picked folder client-side into `local_files`. The flyout's `loadPeakData` gets one `source === 'local'` branch that supplies the already-read `{filename, content}` instead of downloading from SharePoint; everything downstream (parse → peaks → chromatogram → save) is unchanged.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, shadcn/ui (`Tabs`), sonner (toasts), lucide-react. npm only.

## Global Constraints

- **npm only** (never pnpm).
- **Frontend-only.** No backend, no DB, no API-contract change. Do not touch `backend/sharepoint.py` or its 429/503 retry.
- **File classification must mirror the backend exactly:** peak = name matches `/_PeakData\.csv$/i`; chromatogram trace = name matches `/_DAD1A\.csv$/i` (the `*.dx_DAD1A.CSV` DAD1A export). Everything else in the folder is ignored.
- **Additive to `HplcScanMatch`:** existing SharePoint matches must behave byte-identically. `source` absent OR `'sharepoint'` = today's path.
- **Local override is session-only, in-memory** (parity with the existing SharePoint override, which the dialog already labels "this session only; nothing is saved to the prep"). Processed *results* still save to the prep via the unchanged save path.
- **Zustand:** use selector syntax; never destructure the store. React Compiler handles memo — no manual `useMemo`/`useCallback` added for perf.
- Quality gate before shipping: `npm run check:all` (typecheck + lint + ast:lint + format + tests) passes.
- Spec: `docs/superpowers/specs/2026-07-01-hplc-local-file-source-design.md`.

---

### Task 1: Types + pure local-file helpers (the testable core)

**Files:**
- Modify: `src/lib/api.ts:3399-3410` (extend `HplcScanMatch`, add `LocalHplcFile`)
- Create: `src/components/hplc/hplc-local-files.ts`
- Test: `src/components/hplc/__tests__/hplc-local-files.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2–4):
  - `interface LocalHplcFile { filename: string; content: string; kind: 'peak' | 'chrom' }`
  - `HplcScanMatch.source?: 'sharepoint' | 'local'`, `HplcScanMatch.local_files?: LocalHplcFile[]`
  - `classifyHplcFile(name: string): 'peak' | 'chrom' | null`
  - `interface LocalFileLike { name: string; webkitRelativePath?: string; text(): Promise<string> }`
  - `deriveFolderName(files: LocalFileLike[]): string`
  - `readLocalHplcFolder(files: LocalFileLike[]): Promise<{ folderName: string; localFiles: LocalHplcFile[] }>`
  - `localDownloadedFiles(match: HplcScanMatch): { filename: string; content: string }[]`
  - `localPeakNames(match: HplcScanMatch): Set<string>`

- [ ] **Step 1: Extend the `HplcScanMatch` type**

In `src/lib/api.ts`, replace the `HplcScanMatch` interface (currently at 3399-3410) with:

```ts
export interface LocalHplcFile {
  filename: string
  content: string
  kind: 'peak' | 'chrom'
}

export interface HplcScanMatch {
  prep_id: number
  senaite_sample_id: string
  folder_name: string
  folder_id: string
  folder_web_url?: string | null
  peak_files: SharePointItem[]
  chrom_files: SharePointItem[]
  /** TRUE when the folder was hand-picked via the per-prep override (not
   *  found by the name-prefix scan). Display hint only. */
  is_override?: boolean
  /** Data source. Absent/'sharepoint' = files fetched from SharePoint by id.
   *  'local' = files were read client-side; see `local_files`. */
  source?: 'sharepoint' | 'local'
  /** Present only when source === 'local': the already-read file content.
   *  peak_files/chrom_files are [] for local matches. */
  local_files?: LocalHplcFile[]
}
```

- [ ] **Step 2: Write the failing test**

Create `src/components/hplc/__tests__/hplc-local-files.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  classifyHplcFile,
  deriveFolderName,
  readLocalHplcFolder,
  localDownloadedFiles,
  localPeakNames,
  type LocalFileLike,
} from '../hplc-local-files'
import type { HplcScanMatch } from '@/lib/api'

// Fake File — only the fields the helpers read.
function f(name: string, content = '', dir = 'RunFolder'): LocalFileLike {
  return { name, webkitRelativePath: `${dir}/${name}`, text: async () => content }
}

describe('classifyHplcFile', () => {
  it('classifies PeakData as peak (case-insensitive)', () => {
    expect(classifyHplcFile('P-0416_Inj_1_Std_PeakData.csv')).toBe('peak')
    expect(classifyHplcFile('x_PEAKDATA.CSV')).toBe('peak')
  })
  it('classifies DAD1A traces as chrom (case-insensitive)', () => {
    expect(classifyHplcFile('P-0309_Std_250.dx_DAD1A.CSV')).toBe('chrom')
    expect(classifyHplcFile('a_dad1a.csv')).toBe('chrom')
  })
  it('ignores everything else', () => {
    expect(classifyHplcFile('notes.txt')).toBeNull()
    expect(classifyHplcFile('summary.csv')).toBeNull()
  })
})

describe('deriveFolderName', () => {
  it('uses the top-level dir of webkitRelativePath', () => {
    expect(deriveFolderName([f('a_PeakData.csv', '', 'Batch12')])).toBe('Batch12')
  })
  it('falls back when no relative path', () => {
    expect(deriveFolderName([{ name: 'a_PeakData.csv', text: async () => '' }])).toBe('Local folder')
  })
})

describe('readLocalHplcFolder', () => {
  it('reads + classifies only HPLC csvs, keeping content', async () => {
    const res = await readLocalHplcFolder([
      f('P1_PeakData.csv', 'peakbytes'),
      f('P1.dx_DAD1A.CSV', 'chrombytes'),
      f('readme.txt', 'nope'),
    ])
    expect(res.folderName).toBe('RunFolder')
    expect(res.localFiles).toEqual([
      { filename: 'P1_PeakData.csv', content: 'peakbytes', kind: 'peak' },
      { filename: 'P1.dx_DAD1A.CSV', content: 'chrombytes', kind: 'chrom' },
    ])
  })
})

describe('local resolution helpers', () => {
  const local: HplcScanMatch = {
    prep_id: 1, senaite_sample_id: 'P-1', folder_name: 'F', folder_id: '',
    peak_files: [], chrom_files: [], is_override: true, source: 'local',
    local_files: [
      { filename: 'a_PeakData.csv', content: 'x', kind: 'peak' },
      { filename: 'b_PeakData.csv', content: 'y', kind: 'peak' },
      { filename: 'c.dx_DAD1A.CSV', content: 'z', kind: 'chrom' },
    ],
  }
  it('localDownloadedFiles mirrors downloadSharePointFiles shape', () => {
    expect(localDownloadedFiles(local)).toEqual([
      { filename: 'a_PeakData.csv', content: 'x' },
      { filename: 'b_PeakData.csv', content: 'y' },
      { filename: 'c.dx_DAD1A.CSV', content: 'z' },
    ])
  })
  it('localPeakNames returns only peak filenames', () => {
    expect(localPeakNames(local)).toEqual(new Set(['a_PeakData.csv', 'b_PeakData.csv']))
  })
})
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `npm run test:run -- src/components/hplc/__tests__/hplc-local-files.test.ts`
Expected: FAIL — `Cannot find module '../hplc-local-files'`.

- [ ] **Step 4: Implement the helper module**

Create `src/components/hplc/hplc-local-files.ts`:

```ts
/**
 * Pure helpers for the "Local files" HPLC source. Classification mirrors the
 * backend SharePoint folder match: peak = *_PeakData.csv, chrom = *_DAD1A.csv.
 */
import type { HplcScanMatch, LocalHplcFile } from '@/lib/api'

const PEAK_RE = /_PeakData\.csv$/i
const CHROM_RE = /_DAD1A\.csv$/i

export function classifyHplcFile(name: string): 'peak' | 'chrom' | null {
  if (PEAK_RE.test(name)) return 'peak'
  if (CHROM_RE.test(name)) return 'chrom'
  return null
}

/** File-like shape the read path needs (real DOM File satisfies this). */
export interface LocalFileLike {
  name: string
  webkitRelativePath?: string
  text(): Promise<string>
}

export function deriveFolderName(files: LocalFileLike[]): string {
  for (const f of files) {
    const rel = f.webkitRelativePath
    if (rel && rel.includes('/')) return rel.split('/')[0]
  }
  return 'Local folder'
}

export async function readLocalHplcFolder(
  files: LocalFileLike[],
): Promise<{ folderName: string; localFiles: LocalHplcFile[] }> {
  const folderName = deriveFolderName(files)
  const localFiles: LocalHplcFile[] = []
  for (const f of files) {
    const kind = classifyHplcFile(f.name)
    if (!kind) continue
    const content = await f.text()
    localFiles.push({ filename: f.name, content, kind })
  }
  return { folderName, localFiles }
}

/** {filename, content}[] for a local match — same shape downloadSharePointFiles returns. */
export function localDownloadedFiles(
  match: HplcScanMatch,
): { filename: string; content: string }[] {
  return (match.local_files ?? []).map(f => ({ filename: f.filename, content: f.content }))
}

export function localPeakNames(match: HplcScanMatch): Set<string> {
  return new Set(
    (match.local_files ?? []).filter(f => f.kind === 'peak').map(f => f.filename),
  )
}
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `npm run test:run -- src/components/hplc/__tests__/hplc-local-files.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/components/hplc/hplc-local-files.ts src/components/hplc/__tests__/hplc-local-files.test.ts
git commit -m "feat(hplc): local-file source types + classification/read helpers"
```

---

### Task 2: `LocalHplcFolderPicker` component

**Files:**
- Create: `src/components/hplc/LocalHplcFolderPicker.tsx`
- Test: `src/components/hplc/__tests__/LocalHplcFolderPicker.test.tsx`

**Interfaces:**
- Consumes (Task 1): `readLocalHplcFolder`, `type LocalHplcFile`.
- Produces (Task 3): default-exported `LocalHplcFolderPicker` with props
  `{ onSelected: (folderName: string, localFiles: LocalHplcFile[]) => void; disabled?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `src/components/hplc/__tests__/LocalHplcFolderPicker.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LocalHplcFolderPicker } from '../LocalHplcFolderPicker'

function fileWith(name: string, content: string): File {
  const file = new File([content], name, { type: 'text/csv' })
  Object.defineProperty(file, 'webkitRelativePath', { value: `Batch7/${name}` })
  // jsdom File.text() exists; ensure deterministic
  Object.defineProperty(file, 'text', { value: async () => content })
  return file
}

describe('LocalHplcFolderPicker', () => {
  it('calls onSelected with folder name + classified local files', async () => {
    const onSelected = vi.fn()
    render(<LocalHplcFolderPicker onSelected={onSelected} />)
    const input = screen.getByTestId('local-folder-input') as HTMLInputElement
    const files = [fileWith('P1_PeakData.csv', 'peak'), fileWith('P1.dx_DAD1A.CSV', 'chrom')]
    Object.defineProperty(input, 'files', { value: files })
    fireEvent.change(input)
    await waitFor(() => expect(onSelected).toHaveBeenCalledTimes(1))
    expect(onSelected).toHaveBeenCalledWith('Batch7', [
      { filename: 'P1_PeakData.csv', content: 'peak', kind: 'peak' },
      { filename: 'P1.dx_DAD1A.CSV', content: 'chrom', kind: 'chrom' },
    ])
  })

  it('does not call onSelected when the folder has no PeakData', async () => {
    const onSelected = vi.fn()
    render(<LocalHplcFolderPicker onSelected={onSelected} />)
    const input = screen.getByTestId('local-folder-input') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [fileWith('notes.txt', 'x')] })
    fireEvent.change(input)
    await waitFor(() => expect(screen.getByText(/No .*PeakData/i)).toBeInTheDocument())
    expect(onSelected).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npm run test:run -- src/components/hplc/__tests__/LocalHplcFolderPicker.test.tsx`
Expected: FAIL — cannot find `../LocalHplcFolderPicker`.

- [ ] **Step 3: Implement the component**

Create `src/components/hplc/LocalHplcFolderPicker.tsx`:

```tsx
/**
 * Local-folder source for HPLC prep processing. Pick a folder; its
 * *_PeakData.csv / *_DAD1A.csv files are read client-side (no upload) and
 * handed to the caller as LocalHplcFile[]. Web file API — works on the desktop
 * app (webview) and the web app alike.
 */
import { useRef, useState } from 'react'
import { FolderOpen, Loader2, AlertCircle, HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { readLocalHplcFolder, type LocalHplcFile } from './hplc-local-files'

interface Props {
  onSelected: (folderName: string, localFiles: LocalHplcFile[]) => void
  disabled?: boolean
}

export function LocalHplcFolderPicker({ onSelected, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files
    if (!list || list.length === 0) return
    setReading(true)
    setError(null)
    try {
      const { folderName, localFiles } = await readLocalHplcFolder(Array.from(list))
      const peakCount = localFiles.filter(f => f.kind === 'peak').length
      if (peakCount === 0) {
        setError(`No *_PeakData.csv files in "${folderName}". Pick a folder with HPLC PeakData exports.`)
        return
      }
      onSelected(folderName, localFiles)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read the selected folder')
    } finally {
      setReading(false)
      if (inputRef.current) inputRef.current.value = '' // allow re-picking the same folder
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 text-emerald-500" />
          <CardTitle className="text-base">Local files</CardTitle>
        </div>
        <CardDescription>
          Choose a folder on this machine — its PeakData / DAD1A CSVs are read here and pinned to the prep (this session only; nothing is uploaded).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* webkitdirectory is non-standard; cast to satisfy TS */}
        <input
          ref={inputRef}
          data-testid="local-folder-input"
          type="file"
          className="hidden"
          multiple
          onChange={handleChange}
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        />
        <Button
          variant="outline"
          disabled={disabled || reading}
          onClick={() => inputRef.current?.click()}
        >
          {reading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FolderOpen className="h-4 w-4 mr-2" />}
          Choose folder…
        </Button>
        {error && (
          <div className="flex items-center gap-2 p-3 mt-3 rounded-md bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npm run test:run -- src/components/hplc/__tests__/LocalHplcFolderPicker.test.tsx`
Expected: PASS.

> If jsdom lacks `File.prototype.text`, the test's `Object.defineProperty(file, 'text', …)` already supplies it; no polyfill needed.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors.
```bash
git add src/components/hplc/LocalHplcFolderPicker.tsx src/components/hplc/__tests__/LocalHplcFolderPicker.test.tsx
git commit -m "feat(hplc): LocalHplcFolderPicker — read a local folder into LocalHplcFile[]"
```

---

### Task 3: Tab shell + `applyLocalOverride` in `SamplePreps.tsx`

**Files:**
- Modify: `src/components/hplc/SamplePreps.tsx` (imports; new state; `applyLocalOverride`; override `Dialog` body 608-637; count labels)

**Interfaces:**
- Consumes: `LocalHplcFolderPicker` (Task 2); `matchPeakCount`/`matchChromCount`, `type LocalHplcFile` (Task 1); shadcn `Tabs`.
- Produces: local matches in the existing `scanMatches` map (`source: 'local'`), consumed by the flyout in Task 4.

- [ ] **Step 1: Add imports**

At the top of `src/components/hplc/SamplePreps.tsx`, add to the icon import (line 2-14): `HardDrive`, `Cloud`. Add after the `SharePointBrowser` import (line 40):

```ts
import { LocalHplcFolderPicker } from './LocalHplcFolderPicker'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
```

Add `type LocalHplcFile` to the existing `@/lib/api` type import block (line 33-35).

- [ ] **Step 2: Add tab state**

Next to `const [overrideTarget, setOverrideTarget] = useState<SamplePrep | null>(null)` (line 214), add:

```ts
const [overrideTab, setOverrideTab] = useState<'sharepoint' | 'local'>('sharepoint')
```

- [ ] **Step 3: Add `applyLocalOverride`**

Immediately after `applyFolderOverride` (after line 362), add:

```ts
  function applyLocalOverride(prep: SamplePrep, folderName: string, localFiles: LocalHplcFile[]) {
    const peakCount = localFiles.filter(f => f.kind === 'peak').length
    if (peakCount === 0) {
      toast.error(`No *_PeakData.csv files in "${folderName}"`, {
        description: 'Pick a folder containing HPLC PeakData exports.',
      })
      return
    }
    const match: HplcScanMatch = {
      prep_id: prep.id,
      senaite_sample_id: prep.senaite_sample_id ?? prep.sample_id,
      folder_name: folderName,
      folder_id: '',
      peak_files: [],
      chrom_files: [],
      is_override: true,
      source: 'local',
      local_files: localFiles,
    }
    setScanMatches(prev => new Map(prev).set(prep.id, match))
    setOverrideTarget(null)
    const chromCount = localFiles.filter(f => f.kind === 'chrom').length
    toast.success(`"${folderName}" pinned to ${prep.senaite_sample_id ?? prep.sample_id}`, {
      description: `${peakCount} PeakData, ${chromCount} chromatogram file(s) — use Process HPLC.`,
    })
  }
```

- [ ] **Step 4: Replace the override dialog body with tabs**

Replace the `Dialog` block (lines 608-637, the `HPLC data folder override picker`) with:

```tsx
      {/* HPLC data folder override picker — SharePoint or Local files */}
      <Dialog open={overrideTarget !== null} onOpenChange={v => { if (!v && !overrideLoading) { setOverrideTarget(null); setOverrideTab('sharepoint') } }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Pick HPLC data folder — {overrideTarget?.senaite_sample_id ?? overrideTarget?.sample_id}
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">
            Pin a folder&apos;s PeakData/chromatogram CSVs to this prep for processing
            (this session only; nothing is saved to the prep).
          </p>
          {overrideLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning folder for PeakData CSVs…
            </div>
          )}
          {overrideTarget && (
            <Tabs value={overrideTab} onValueChange={v => setOverrideTab(v as 'sharepoint' | 'local')}>
              <TabsList>
                <TabsTrigger value="sharepoint"><Cloud className="h-4 w-4 mr-1" />SharePoint</TabsTrigger>
                <TabsTrigger value="local"><HardDrive className="h-4 w-4 mr-1" />Local files</TabsTrigger>
              </TabsList>
              <TabsContent value="sharepoint">
                <SharePointBrowser
                  allowSelectAnyFolder
                  disabled={overrideLoading}
                  onThrottled={() => setOverrideTab('local')}
                  onFolderSelected={(path, folderName) =>
                    void applyFolderOverride(overrideTarget, path, folderName)
                  }
                />
              </TabsContent>
              <TabsContent value="local">
                <LocalHplcFolderPicker
                  disabled={overrideLoading}
                  onSelected={(folderName, localFiles) =>
                    applyLocalOverride(overrideTarget, folderName, localFiles)
                  }
                />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>
```

> `onThrottled` is added to `SharePointBrowser` in Task 5. If you implement out of order, add the prop there first or TS will error.

- [ ] **Step 5: Make the "Process HPLC" tooltip source-aware (same file)**

In the Process-HPLC button title (line 547-549), so a local pin reads clearly, replace with:

```tsx
                              title={match.is_override
                                ? `Process HPLC data from ${match.source === 'local' ? 'local folder' : 'override folder'}: ${match.folder_name}`
                                : 'Process HPLC data'}
```

(Display-only string change; no behavior change.)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: one error — `Property 'onThrottled' does not exist on SharePointBrowser props` — resolved by Task 5. If doing tasks strictly in order, implement Task 5 before re-running. Otherwise proceed.

- [ ] **Step 7: Commit**

```bash
git add src/components/hplc/SamplePreps.tsx
git commit -m "feat(hplc): source tabs (SharePoint | Local files) in the prep override picker"
```

---

### Task 4: Flyout `loadPeakData` local branch + history-mode guard

**Files:**
- Modify: `src/components/hplc/SamplePrepHplcFlyout.tsx` (import; `isHistoryMode` at 879; live-mode block 976-998; header origin label)

**Interfaces:**
- Consumes (Task 1): `localDownloadedFiles`, `localPeakNames`. Match carries `source: 'local'` + `local_files` from Task 3.

- [ ] **Step 1: Add import**

In `src/components/hplc/SamplePrepHplcFlyout.tsx`, add near the other `./` imports (around line 55, the `type HplcScanMatch` import from `@/lib/api` is already there):

```ts
import { localDownloadedFiles, localPeakNames } from './hplc-local-files'
```

- [ ] **Step 2: Guard history-mode against local matches**

At line 879, replace:

```ts
    const isHistoryMode = match.peak_files.length === 0 && !match.folder_id
```

with:

```ts
    const isLocal = match.source === 'local'
    // A local match has peak_files:[] and folder_id:'' — do NOT treat it as
    // history mode; its content lives in match.local_files.
    const isHistoryMode = !isLocal && match.peak_files.length === 0 && !match.folder_id
```

- [ ] **Step 3: Branch the live-mode download on source**

Replace the block at lines 979-998 (from `try {` through the `chromFiles` line) — i.e. replace:

```ts
    try {
      let chromItems = match.chrom_files
      if (chromItems.length === 0 && match.folder_id) {
        try {
          chromItems = await getFolderChromFiles(match.folder_id)
        } catch {
          // non-fatal — chromatogram just won't show
        }
      }

      const allFiles = [...match.peak_files, ...chromItems]
      const ids = allFiles.map(f => f.id)
      const downloaded = await downloadSharePointFiles(ids)

      // Phase 13.5: Archive all downloaded files for source-file audit trail
      downloadedFilesRef.current = downloaded.map(d => ({ filename: d.filename, content: d.content }))

      const peakFileNames = new Set(match.peak_files.map(f => f.name))
      const peakFiles   = downloaded.filter(d => peakFileNames.has(d.filename))
      const chromFiles  = downloaded.filter(d => !peakFileNames.has(d.filename))
```

with:

```ts
    try {
      let downloaded: { filename: string; content: string }[]
      let peakFileNames: Set<string>
      if (isLocal) {
        // Local source: content already in hand — no SharePoint round-trip.
        downloaded = localDownloadedFiles(match)
        peakFileNames = localPeakNames(match)
      } else {
        let chromItems = match.chrom_files
        if (chromItems.length === 0 && match.folder_id) {
          try {
            chromItems = await getFolderChromFiles(match.folder_id)
          } catch {
            // non-fatal — chromatogram just won't show
          }
        }
        const allFiles = [...match.peak_files, ...chromItems]
        const ids = allFiles.map(f => f.id)
        downloaded = await downloadSharePointFiles(ids)
        peakFileNames = new Set(match.peak_files.map(f => f.name))
      }

      // Phase 13.5: Archive all downloaded files for source-file audit trail
      downloadedFilesRef.current = downloaded.map(d => ({ filename: d.filename, content: d.content }))

      const peakFiles   = downloaded.filter(d => peakFileNames.has(d.filename))
      const chromFiles  = downloaded.filter(d => !peakFileNames.has(d.filename))
```

(The remainder of the block — `parseHPLCFiles(peakFiles…)`, chromatogram traces, `catch`/`finally` — is unchanged.)

- [ ] **Step 4: Add a provenance label in the flyout header (ISO 7.5.1)**

Find the flyout header where `match.folder_name` / the source is shown (search the file for `folder_name`). Add, adjacent to the folder name, a small origin badge so a local-sourced result is visibly distinguishable on review:

```tsx
{match.source === 'local' && (
  <span className="ml-2 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
    <HardDrive className="h-3 w-3" /> Local files: {match.folder_name}
  </span>
)}
```

Add `HardDrive` to the file's `lucide-react` import. If the header does not currently render `folder_name`, place this badge next to the sample id in the header row instead.

- [ ] **Step 5: Typecheck + run flyout-adjacent tests**

Run: `npx tsc --noEmit` → no errors (assuming Task 5's `onThrottled` is in place, or Task 5 done next).
Run: `npm run test:run -- src/components/hplc/__tests__/hplc-local-files.test.ts`
Expected: still PASS (the helpers are now exercised by real callers).

- [ ] **Step 6: Commit**

```bash
git add src/components/hplc/SamplePrepHplcFlyout.tsx
git commit -m "feat(hplc): flyout processes local matches (skip SharePoint download) + origin label"
```

---

### Task 5: Throttle nudge in `SharePointBrowser`

**Files:**
- Modify: `src/components/hplc/SharePointBrowser.tsx` (props 33-44; `loadFolder` catch 105-117; error box 223-236)
- Test: `src/components/hplc/__tests__/sharepoint-throttle.test.ts`

**Interfaces:**
- Produces: `SharePointBrowserProps.onThrottled?: () => void` (consumed by Task 3).
- Produces: `isThrottleError(message: string): boolean` (exported pure helper, tested here).

- [ ] **Step 1: Write the failing test**

Create `src/components/hplc/__tests__/sharepoint-throttle.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isThrottleError } from '../SharePointBrowser'

describe('isThrottleError', () => {
  it('matches 429 and throttle-shaped messages', () => {
    expect(isThrottleError('SharePoint browse failed: 429 — Too Many Requests')).toBe(true)
    expect(isThrottleError('request was throttled')).toBe(true)
    expect(isThrottleError('rate limit exceeded')).toBe(true)
    expect(isThrottleError('Retry-After: 30')).toBe(true)
  })
  it('does not match ordinary errors', () => {
    expect(isThrottleError('SharePoint browse failed: 404 — Not Found')).toBe(false)
    expect(isThrottleError('Failed to load folder')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm run test:run -- src/components/hplc/__tests__/sharepoint-throttle.test.ts`
Expected: FAIL — `isThrottleError` is not exported.

- [ ] **Step 3: Export `isThrottleError` + add the prop + nudge**

In `src/components/hplc/SharePointBrowser.tsx`:

(a) Add near the top (after imports), an exported helper:

```ts
export function isThrottleError(message: string): boolean {
  return /\b429\b/.test(message) || /throttl|rate.?limit|retry-after/i.test(message)
}
```

(b) Extend the props interface (33-44):

```ts
  /** Called when a browse call fails with a throttle-shaped error (HTTP 429).
   *  Lets the host offer the local-files source instead. */
  onThrottled?: () => void
```

and add `onThrottled` to the destructured params on the `export function SharePointBrowser({ … })` line.

(c) In the error box (223-236), after the existing Retry `Button`, add a throttle-only nudge:

```tsx
            {onThrottled && isThrottleError(error) && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onThrottled}
              >
                SharePoint&apos;s throttled — use Local files instead →
              </Button>
            )}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npm run test:run -- src/components/hplc/__tests__/sharepoint-throttle.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors (Task 3's `onThrottled` usage now resolves).
```bash
git add src/components/hplc/SharePointBrowser.tsx src/components/hplc/__tests__/sharepoint-throttle.test.ts
git commit -m "feat(hplc): throttle nudge — offer Local files when SharePoint 429s"
```

---

### Task 6: Version bump, changelog, full gate

**Files:**
- Modify: `package.json` (version), `src-tauri/tauri.conf.json` (version), `CHANGELOG.md`

**Interfaces:** none.

- [ ] **Step 1: Bump versions**

`package.json`: `"version": "1.0.14"` → `"version": "1.0.15"`.
`src-tauri/tauri.conf.json`: `"version": "1.0.14"` → `"version": "1.0.15"`.

- [ ] **Step 2: Changelog entry**

Prepend under the `# Changelog` header in `CHANGELOG.md`:

```markdown
## v1.0.15 — 2026-07-01

### Added

- **Local files as a second HPLC data source.** The per-prep HPLC folder picker now has a **SharePoint** tab and a **Local files** tab. The Local tab lets a tech pick a folder on their machine; its `*_PeakData.csv` / `*_DAD1A.csv` files are read in the browser (nothing is uploaded) and processed through the exact same parse/peak/chromatogram/save flow as SharePoint. When a SharePoint browse call is throttled (429), the error offers a one-click switch to the Local tab. A "Local files: <folder>" badge marks local-sourced results for review. Frontend-only; no change to result/purity math.
```

- [ ] **Step 3: Full quality gate**

Run: `npm run check:all`
Expected: typecheck + lint + ast:lint + format + tests all pass. Fix anything it flags (e.g. an unused import in `SamplePreps.tsx` — remove `matchPeakCount`/`matchChromCount` there if the flyout owns the header counts).

- [ ] **Step 4: Commit**

```bash
git add package.json src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore(release): Mk1 1.0.15 — HPLC local-file source"
```

---

## Manual verification (before deploy)

On a running dev build (`npm run dev`, ask the Handler to run):
1. Open Sample Preps → a prep's **Pick HPLC data folder** (FolderSearch) → the dialog shows **SharePoint** and **Local files** tabs, defaulting to SharePoint (unchanged behavior).
2. **SharePoint tab** still pins a folder and processes exactly as before (regression check).
3. **Local tab** → Choose folder → pick a real folder of `*_PeakData.csv` (+ optional `*_DAD1A.csv`) → toast "N PeakData…" → **Process HPLC** → peaks, purity/quantity, and chromatogram render; results save to the prep; header shows "Local files: <folder>".
4. **Parity:** the same folder processed via SharePoint vs Local yields identical parsed peaks/purity.
5. **Throttle nudge:** if SharePoint is throttled (or simulate a 429), the SharePoint tab's error shows the "use Local files instead" button and it switches tabs.
6. Folder with no `*_PeakData.csv` → rejected with the toast, no match created.

## Deployment (hotfix)

- Full `deploy.sh` (version bump forces both images; `--frontend` alone 404s the pinned backend tag). No backend/DB change, JWT unchanged.
- Invoke the `accumark-deploy` skill; health-check `https://accumk1.valenceanalytical.com/api/health` = `1.0.15`; reconcile `hotfix/hplc-local-file-source` → master (PR).
- Desktop rebuild optional (no desktop-specific change).

## Self-review notes

- **Spec coverage:** tab shell (T3) ✓; local folder picker + classify + read (T1/T2) ✓; `HplcScanMatch` extension (T1) ✓; flyout branch + history-mode guard (T4) ✓; throttle nudge (T5) ✓; provenance label / ISO 7.5.1 (T4) ✓; validation parity (T2/T3) ✓; version/changelog/deploy (T6) ✓; non-goals (no Tauri dialog, no upload, no backend) respected ✓.
- **Ordering note:** Task 3 references `onThrottled` (added in Task 5). Either implement 5 before 3, or accept one known transient TS error until 5 lands. Called out in T3 Step 6.
- **Type consistency:** `LocalHplcFile { filename, content, kind }` used identically in T1/T2/T3/T4; `localDownloadedFiles`/`localPeakNames`/`readLocalHplcFolder`/`classifyHplcFile`/`isThrottleError` signatures match their call sites. No helper is exported without a consumer (avoids knip/lint dead-code failures in T6).
