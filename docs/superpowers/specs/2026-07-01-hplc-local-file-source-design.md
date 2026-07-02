# HPLC prep processing — local files as a second data source

**Date:** 2026-07-01
**Status:** design approved, pre-implementation
**Ships as:** hotfix (frontend-only; Accu-Mk1 web + backend image rebuild for the version bump, no backend code/DB change)

## Problem

The per-prep "browse" button on Sample Preps (commit `317284c`, "per-prep HPLC data
folder override") opens `SharePointBrowser` and lets a tech pin a SharePoint LIMS-CSV
folder to a prep for HPLC processing. It is the **only** source. When SharePoint / MS
Graph throttled the tenant (429), techs had no way to process a prep whose PeakData CSVs
they already have locally. The component that `SharePointBrowser` replaced was in fact a
local drag-and-drop file picker — so "local" was a first-class source before and was
dropped when the SharePoint browser landed.

## Goal

Give the per-prep picker a **second source tab: Local files** — pick a folder from the
machine, read its HPLC CSVs client-side, and feed them into the *same* processing flow the
SharePoint path uses. Plus a **throttle nudge**: when a SharePoint browse call fails with a
throttle-shaped error, point the user at the Local tab.

## Non-goals (YAGNI)

- **No native OS / Explorer dialog.** The frontend has no `@tauri-apps` FS/dialog plugins
  and no Tauri detection; even the desktop app runs web file APIs. A web folder picker
  (`webkitdirectory`) works on web *and* desktop. Native dialogs are a separate, desktop-only
  effort — shelved.
- **No upload** of local files to SharePoint or the backend. Local files are read in the
  browser and processed in memory.
- **No change** to the SharePoint browse/download path or its existing 429/503 retry logic
  (`backend/sharepoint.py`).

## Current architecture (what exists)

- `src/components/hplc/SamplePreps.tsx` — the preps list. `applyFolderOverride(prep, path,
  folderName)` calls `getHplcFolderMatch(path)`, builds an `HplcScanMatch`
  (`folder_id`, `peak_files: SharePointItem[]`, `chrom_files: SharePointItem[]`,
  `is_override: true`), stores it in the in-memory `scanMatches` map, then the user clicks
  **Process HPLC** → `openFlyout(prep, match)`.
- `src/components/hplc/SamplePrepHplcFlyout.tsx` — `loadPeakData()` collects the match's
  peak + chrom file ids, calls `downloadSharePointFiles(ids)` → `{ filename, content }[]`,
  splits peak vs chrom by name, runs `parseHPLCFiles(peakFiles)` → injections/peaks, then
  renders the peak table / console / chromatogram and saves results to the prep.
- `src/components/hplc/NewAnalysis.tsx` — an existing, working **local** pipeline:
  drag-drop / file input → `file.text()` → `parseHPLCFiles(fileData)`. This is the reuse
  anchor for the Local tab.
- **File classification (mirror exactly):** peak = name matches `/_PeakData\.csv$/i`;
  chromatogram trace = name matches `/_DAD1A\.csv$/i` (the `*.dx_DAD1A.CSV` DAD1A export).

Everything downstream of "collect `{filename, content}`" is source-agnostic — the parser
does not care where the bytes came from. That is what makes this additive.

## Design

### 1. Tabbed picker shell
The override picker (today rendering only `SharePointBrowser` inside a `Dialog`) becomes a
two-tab shell:
- **SharePoint** — existing `SharePointBrowser` → `applyFolderOverride` (unchanged).
- **Local files** — new `LocalHplcFolderPicker` (below).

The active tab is local component state on the dialog; default **SharePoint** (preserves
current muscle memory).

### 2. `LocalHplcFolderPicker` (new component)
- A folder picker: `<input type="file" webkitdirectory />` (label styled as a button:
  "Choose folder…"). On desktop and web this opens the OS folder chooser and returns every
  file under the folder (with `webkitRelativePath`).
- Classify the returned files by the patterns above into peak / chrom; ignore everything
  else. Derive `folderName` from the common top-level directory of `webkitRelativePath`.
- **Validation parity:** if zero `*_PeakData.csv`, reject with the same toast as SharePoint
  ("No `*_PeakData.csv` files in the selected folder — pick a folder with HPLC PeakData
  exports.") and do not create a match.
- Read each classified file with `file.text()` → build `local_files`.
- Call a new `applyLocalOverride(prep, folderName, localFiles)` that builds a **local**
  `HplcScanMatch` and stores it in `scanMatches` (same map, same "Process HPLC" affordance).

### 3. `HplcScanMatch` extension (one additive field + content carrier)
```ts
source?: 'sharepoint' | 'local'   // absent/'sharepoint' = today's behavior
local_files?: { filename: string; content: string; kind: 'peak' | 'chrom' }[]
```
- SharePoint match: `source` omitted (or `'sharepoint'`), `peak_files`/`chrom_files`
  carry ids as today; `local_files` absent.
- Local match: `source: 'local'`, `peak_files`/`chrom_files` = `[]`, `local_files` carries
  the already-read content, `folder_name` = picked folder, `folder_id: ''`,
  `folder_web_url` absent, `is_override: true`.
- Count/label rendering in the preps list becomes source-aware via a small helper:
  `source === 'local' ? local_files.filter(f => f.kind === 'peak').length : peak_files.length`
  (and likewise for chrom), so the existing "N PeakData, M chromatogram" labels work for both.

### 4. Flyout `loadPeakData` branch
One branch at the top of the download step:
```ts
let downloaded: { filename: string; content: string }[]
if (match.source === 'local') {
  downloaded = match.local_files!.map(f => ({ filename: f.filename, content: f.content }))
} else {
  const ids = /* existing: peak + chrom ids */
  downloaded = await downloadSharePointFiles(ids)
}
// unchanged from here: split peak/chrom by name, parseHPLCFiles(peakFiles), render, save
```
Peak/chrom split downstream already keys on filename patterns, so it works identically for
local files.

### 5. Throttle nudge (in `SharePointBrowser`)
`SharePointBrowser` already has an error state with a Retry button. Add an optional
`onThrottled?: () => void` prop. When `loadFolder` catches an error whose message matches a
throttle shape (`429`, `/throttl/i`, `/rate limit/i`, `/Retry-After/i`), render an extra
button in the error box — **"SharePoint's throttled — use Local files instead →"** — that
calls `onThrottled()`, which the tab shell wires to switch the active tab to **Local**.
Non-throttle errors keep only Retry. No change to backend error text is required; we match on
the message the API layer already surfaces (`SharePoint browse failed: <status> — <detail>`).

## Data-flow asymmetry (accepted, documented)

- **SharePoint override** is a *re-resolvable pointer* — the pinned folder can be re-opened
  and re-processed anytime; the match survives because the content lives server-side.
- **Local override** is a *one-time in-memory import* — the browser cannot re-read the
  chosen files later, so the `local_files` content lives only for this session's match.
  Re-processing after a reload means re-picking the folder.
- Processed **results still persist to the prep normally** (peaks, purity/quantity,
  chromatogram image) — only the *source pointer* is non-persistent. This is the right
  tradeoff for a fallback/convenience source; local is not a system of record.

## Error handling & edge cases

- Empty / wrong folder → validation toast (parity with SharePoint), no match created.
- Folder with PeakData but no DAD1A traces → allowed (chrom is optional; chromatogram image
  step already tolerates missing traces, same as today).
- Large chromatogram CSVs → text, read into memory; a prep's folder is a handful of files,
  well within memory. No streaming needed.
- Non-CSV / stray files in the folder → ignored by classification.
- Reading a file fails (`file.text()` rejects) → toast the filename, abort the import.
- User cancels the OS dialog → no-op (empty `FileList`).

## Testing

- **Unit (vitest):** classification helper (peak vs chrom vs ignore across case variants);
  `local_files` builder from a mocked `FileList`; source-aware count helper.
- **Component:** tab shell switches SharePoint↔Local; Local picker rejects a folder with no
  PeakData; throttle nudge appears for a 429-shaped error and switches tabs.
- **Manual (hotfix smoke):** pin a real local folder to a prep → Process HPLC → peaks +
  purity match the same folder processed via SharePoint (byte-for-byte on the parsed result).

## ISO 17025 alignment

- **7.5.1 (record attribution / origin):** a local import must be visibly distinguishable
  from a SharePoint-sourced result. The prep match records `source: 'local'` and the picked
  `folder_name`; surface a small "Local files: `<folder>`" origin label in the flyout header
  and any saved-result metadata so the data's provenance is unambiguous on review.
- **7.11 (data integrity):** local files are read-only and parsed by the *same* validated
  parser as the SharePoint path — no separate calculation path, so conformance/purity math is
  identical regardless of source.
- Storage-condition monitoring (7.4.4) — not applicable to this change.

## Deployment (hotfix)

- Frontend-only change; no backend code or migration. Bump `package.json` +
  `src-tauri/tauri.conf.json` (patch), CHANGELOG entry.
- Per the deploy-state gotcha, a version bump forces **both** frontend + backend images
  (prod compose pins both to `VERSION`), so deploy is a full `deploy.sh` (not `--frontend`).
  JWT unchanged, no migration. Desktop rebuild optional (no desktop-specific change).
- Standard `accumark-deploy` flow → health check → reconcile master.

## Files touched

| File | Change |
|---|---|
| `src/components/hplc/SamplePreps.tsx` | tab shell in the override dialog; `applyLocalOverride`; source-aware count helper |
| `src/components/hplc/LocalHplcFolderPicker.tsx` | **new** — folder picker + classify + read |
| `src/components/hplc/SharePointBrowser.tsx` | `onThrottled` prop + throttle-nudge button |
| `src/components/hplc/SamplePrepHplcFlyout.tsx` | `source === 'local'` branch in `loadPeakData`; local origin label |
| `src/lib/api.ts` | extend `HplcScanMatch` (defined at `api.ts:3399`) with `source` + `local_files` |
| tests | classification / builder / tab-switch / nudge |
