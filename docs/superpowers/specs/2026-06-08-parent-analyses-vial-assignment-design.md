# Spec: Parent analyses table — assigned-vial link + Mk1 Method/Instrument/Analyst overlay

*2026-06-08. On the parent sample-details page, each analysis row shows which vial
it's currently assigned to (inline link) and sources Method / Instrument / Analyst
from that vial's Accu-Mk1 analysis — the same Mk1 data the sub-sample view shows.
Additive field overlay; the parent rows' result / status / verification / promotion
stay untouched. FE-only (no backend). Continues `subvial/continue` (PR #9).*

## What & why

The parent analyses table (`SampleDetails` → `AnalysisTable`) currently renders
**SENAITE** parent-AR analyses. Method / Instrument / Analyst on those rows reflect
SENAITE, not the work the lab actually did on the vials — so on `P-0142` every row
shows Analyst "—", Status "Unassigned", and instruments that don't match the vials'
Mk1 state. The lab works analyses on **vials** (sub-samples), where the Mk1 record
holds the real method / instrument / analyst.

This feature overlays, per parent analysis row:
1. **Assigned-vial link** — which vial currently runs this analysis, inline by the
   analysis name (beside the existing "promoted from" badge), reading
   `Vial N — P-XXXX-SNN`, click → navigate to that vial.
2. **Method + Instrument** — sourced from the assigned vial's Mk1 analysis,
   **editable**, routed to that vial's `mk1:` record (the exact write path the
   sub-sample view uses).
3. **Analyst** — the Mk1-resolved display name (display-only; it's plain text even
   on sub-sample pages).

**Approach: field overlay (not a row swap).** The parent rows keep their identity
(result, Status, Verified/Pending counts, promotion, Actions/transitions all stay
parent-level and untouched). We overlay only the three fields + the link. A full
"extend the sub-sample swap wholesale" approach was rejected — it would replace
result/status/verification on the COA surface, violating the additive-only rule.

**FE-only.** The vial data comes from a family fan-out (`listSubSamples` + per-vial
`listLimsAnalysesForSubSample`, the pattern `VialsQuickLookDialog` already uses). We
know each vial's `sample_id` from the query, so no backend field or endpoint is needed.

## Current state (verified against the live stack)

- Parent page analyses come from `lookupSenaiteSample(id)` (`SampleDetails.tsx:2069`,
  via the non-`-SNN` branch of `resolveSampleData` 2055-2070). The Mk1-swap effect
  is gated `if (!parentSampleId) return` (`:2138`) — **parent analyses are 100%
  SENAITE today; nothing overlays Mk1.** "HPLC 1290a" etc. are SENAITE instrument
  titles (`main.py:11106-11141`).
- `SenaiteAnalysis` (`api.ts:3333-3361`) carries `uid, keyword, title, method,
  method_uid, method_options, instrument, instrument_uid, instrument_options,
  analyst, review_state, result, …`. It does **not** carry `category`, so identity
  classification (below) is by keyword/title shape, not category.
- Mk1 vial analyses (`listLimsAnalysesForSubSample(subPk)` →
  `GET /api/lims-analyses?host_kind=sub_sample&host_pk=<id>&as=senaite_shape&include_retests=true`,
  `api.ts:4894-4906`) return the SAME `SenaiteAnalysis` shape with `mk1:{id}` UIDs and
  Mk1 method/instrument/analyst + **int-as-string** option uids (`service.py:998-1020`).
- `setAnalysisMethodInstrument(uid, methodUid, instrumentUid)` (`api.ts:3676-3724`):
  when `uid` starts with `mk1:`, PATCHes `/api/lims-analyses/{id}/method-instrument`
  with `{method_id, instrument_id}` as ints (parses int-as-string option uids). With a
  SENAITE hex uid it routes to the SENAITE path.
- `EditableSelectCell` (`AnalysisTable.tsx:653-780`) reads
  `analysis.method/method_uid/method_options` (and instrument), gates editing on
  `analysis.uid && EDITABLE_STATES.has(analysis.review_state)`, and on save calls
  `setAnalysisMethodInstrument(analysis.uid, …)`.
- Rows are grouped `AnalysisGroup[]` by title; each row gets `analysis={group.current}`
  (`AnalysisTable.tsx:1697`), so `analysis.keyword` + the full object are available
  per row. The overlay keys on `analysis.keyword`, exactly like `promotionsByKeyword`
  already does (`:1121`).
- `SampleDetails` already builds `promotionsByKeyword` (`:1884-1893`) and passes it to
  `AnalysisTable` (`:3589`). The new overlay map is wired identically.
- Navigation: `useUIStore.getState().navigateToSample(vialSampleId)` (vial `sample_id`
  string; same call the inbox + Quick-Look use).
- `listSubSamples(parentId)` → `{ parent: { sub_sample_count }, sub_samples: [{ id,
  sample_id, external_lims_uid, vial_sequence, assignment_role }] }`. Family label
  M = `sub_sample_count + 1`; a vial's position = `vial_sequence + 1`.

### Verified join data (live DB, P-0142 family — BPC-157, one analyte)

| Parent row (keyword) | Vial(s) carrying it | Match |
|---|---|---|
| Peptide Purity (HPLC) = `HPLC-PUR` | S02 `HPLC-PUR` | exact ✅ |
| Endotoxin = `ENDO-LAL` | S01 `ENDO-LAL` | exact ✅ |
| Rapid Sterility Screening (PCR) = `STER-PCR` | S02 **and** S03 `STER-PCR` | exact, **multi-vial** |
| BPC-157 - Identity (HPLC) = `ID_BPC157` | S02 `HPLC-ID` (generic) | **type-bridge** (ID_* ↔ HPLC-ID) |
| Peptide Total Quantity = `PEPT-Total` | none | **no vial by design** |

`ID_BPC157` is category "Peptide Identity", `peptide_id=10`; generic `HPLC-ID` is
"Peptide Analysis", no peptide link, **no clone/template FK** — so identity is bridged
by type, not a lookup. (Seed note: P-0142's S02 has `assignment_role='ster'` yet
carries HPLC analyses — synthetic-data noise; the join logic must not depend on
`assignment_role`.)

## Design

### A. Pure join helper — `src/lib/vial-assignment.ts` (new, unit-tested)

No React. This is the logic worth testing.

```ts
import type { SenaiteAnalysis } from '@/lib/api'

export interface VialMatch {
  vialSampleId: string   // 'P-0142-S02'
  vialLabel: string      // 'Vial 3'  (vial_sequence + 1)
  mk1Analysis: SenaiteAnalysis
}
export interface VialAssignment {
  matches: VialMatch[]   // ≥1 when present; omitted from map when 0
  editable: boolean      // true only when matches.length === 1
}

// A vial/parent analysis is "identity-type" if its keyword/title marks it identity.
// Parent uses per-peptide ID_* (e.g. ID_BPC157); vials use generic HPLC-ID.
export function isIdentityAnalysis(a: { keyword?: string|null; title?: string|null }): boolean

// Build keyword -> assignment for the parent's analyses.
//   exact keyword match first;
//   identity type-bridge (ID_* ↔ HPLC-ID) ONLY in single-peptide families
//     (exactly one identity analysis on the parent side AND one identity-type
//      vial analysis family-wide) — else no identity match (defer multi-peptide);
//   no match -> keyword absent from the map (row renders unchanged).
// `vials` is the fan-out result: one entry per vial with its live Mk1 analyses.
export function buildVialAssignmentMap(
  parentAnalyses: SenaiteAnalysis[],
  vials: { sampleId: string; label: string; analyses: SenaiteAnalysis[] }[],
): Map<string, VialAssignment>   // keyed by the PARENT analysis keyword
```

Rules baked in:
- **Live rows only:** when building the vial side, drop retest/dead rows — keep the
  current row per `(vial, keyword)` (the fan-out uses `include_retests=true`).
- **Exact match:** vial analyses whose `keyword === parentAnalysis.keyword`.
- **Multi-vial:** all matching vials become `matches` (e.g. STER-PCR → S02 + S03);
  `editable = matches.length === 1`.
- **Identity bridge:** if a parent analysis `isIdentityAnalysis` and has no exact
  match, match it to the vials' identity-type analyses — **only when** the parent has
  exactly one identity-type analysis AND the family exposes exactly one distinct
  identity-type vial keyword (i.e. a single-peptide family). The `matches` are the
  vials carrying that identity-type row (usually one → editable). If the parent has
  two or more identity-type analyses (multi-peptide), skip the bridge for all of them
  (ambiguous mapping). Exact-keyword matches are never affected by this rule.
- **No match (e.g. `PEPT-Total`):** keyword not added → row unchanged.

### B. Fan-out + map in `SampleDetails.tsx`

Mirror the `promotionsByKeyword` wiring and the `VialsQuickLookDialog` fan-out
(`VialsQuickLookDialog.tsx:89-111`):

1. `useQuery(['parent-overlay-subs', sampleId], () => listSubSamples(sampleId),
   { enabled: parentSampleId === null && !!sampleId })`.
2. `useQueries` over the vials: `['parent-overlay-vial-analyses', v.id] →
   listLimsAnalysesForSubSample(v.id)`, `enabled` same gate.
3. Build `vialAssignmentByKeyword = useMemo(() => buildVialAssignmentMap(
   data.analyses, vials.map(v => ({ sampleId: v.sample_id,
   label: 'Vial ' + (v.vial_sequence + 1), analyses: <its query data ?? []> }))),
   [data?.analyses, …queries])`.
4. Pass to `AnalysisTable`:
   `vialAssignmentByKeyword={parentSampleId === null ? vialAssignmentByKeyword : undefined}`
   (next to the existing `promotionsByKeyword` prop, `:3589`).
5. On a successful method/instrument save (`onMethodInstrumentSaved`, `:3604-3618`),
   invalidate the `parent-overlay-vial-analyses` queries so the row re-reads Mk1.

Gating on `parentSampleId === null` means sub-sample pages never pay for the fan-out
(they already do their own full Mk1 swap).

### C. `AnalysisTable` / `AnalysisRow` consumption

1. **Prop:** add `vialAssignmentByKeyword?: Map<string, VialAssignment>` to the
   `AnalysisTable` props (`:1342-1392`) and thread it into `AnalysisRow`
   (`:1696-1722`, beside `promotionsByKeyword`), then into `AnalysisRow` props
   (`:1048-1070`). Per row: `const vialAssign = analysis.keyword ?
   vialAssignmentByKeyword?.get(analysis.keyword) : undefined`.

2. **Inline vial link** (title cell, beside `PromotedFromBadge`, `:1121`): when
   `vialAssign`, render one small link per match:
   `Vial N — P-XXXX-SNN`, `onClick → e.stopPropagation();
   navigateToSample(match.vialSampleId)`. Multiple matches → render each (comma-sep).
   Style to match `PromotedFromBadge` (muted, `text-[10px]`, `shrink-0`).

3. **Method / Instrument overlay** (the two `EditableSelectCell`s, `:1144-1157`):
   pass an overlay so the cell reads + writes Mk1 **only when `editable`** (single
   match):
   - Add to `EditableSelectCell` an optional `mk1Override?: { uid: string; method: string|null;
     method_uid: string|null; method_options: …; instrument: …(same); review_state: string|null }`
     (or pass the matched `mk1Analysis` + a flag). When present and editable:
     - read value/uid/**options** from `mk1Override` (options MUST be the Mk1
       int-as-string arrays, never SENAITE hex — else the PATCH int-parse corrupts);
     - write via `setAnalysisMethodInstrument(mk1Override.uid, …)` (routes to the
       vial's `mk1:` record);
     - gate `canEdit` on the **vial** Mk1 `review_state`, not the parent's.
   - **Replace-only-when-the-vial-row-has-a-value:** if the matched Mk1 analysis's
     method/instrument is null, leave the SENAITE display value (don't blank a real
     SENAITE instrument like "HPLC 1290a").
   - **Multi-vial (`editable === false`):** display the Mk1 value (read-only, from the
     deterministic first match by `vial_sequence`) — do NOT offer an editable cell
     (ambiguous target); the per-vial links let the user open the right vial to edit.

4. **Analyst overlay** (analyst cell, `:1158`): display
   `vialAssign?.matches[0]?.mk1Analysis.analyst ?? analysis.analyst ?? '—'`
   (display-only; the Mk1 analyst is already a resolved name server-side).

## Behavior notes

- Rows with **no vial match** (e.g. `PEPT-Total`, legacy SENAITE-only) render exactly
  as today — no link, SENAITE M/I/A. Purely additive.
- **Identity** links/overlays only in single-peptide families this version;
  multi-peptide identity is deferred (ambiguous which generic `HPLC-ID` maps to which
  per-peptide row).
- Overlay refreshes with the fan-out queries; editing a vial's method/instrument from
  the parent row re-reads Mk1 (step B5).
- The fan-out is N+1 (`listSubSamples` + one per vial, ~2-5 vials). Acceptable and it
  only runs on parent pages.

## Testing

- **Unit (vitest):** `src/lib/__tests__/vial-assignment.test.ts` — `isIdentityAnalysis`
  (HPLC-ID, ID_BPC157, title-based, negatives) and `buildVialAssignmentMap`:
  exact match; multi-vial (STER-PCR → 2 vials, `editable:false`); identity bridge in a
  single-peptide family (ID_BPC157 ↔ HPLC-ID, `editable:true`); identity NOT bridged in
  a multi-peptide family; no-match keyword absent; retest/dead vial rows excluded.
  This carries the join risk; cover it well.
- **Typecheck:** `tsc --noEmit` clean (baseline: the one known
  `WorksheetsInboxPage.tsx` `prev` error — don't regress further).
- **Manual smoke** on `:5532` (P-0142): Purity/Endotoxin/Sterility/Identity rows show a
  `Vial N — P-…` link; Sterility shows two links (S02 + S03) and a read-only M/I;
  single-match rows allow editing Method/Instrument and the change persists to the vial
  (verify on the vial page); Analyst shows the Mk1 name where stamped; Quantity row
  unchanged; result/Status/verification untouched throughout.

## Files

- `src/lib/vial-assignment.ts` (new) — join helper.
- `src/lib/__tests__/vial-assignment.test.ts` (new) — unit tests.
- `src/components/senaite/SampleDetails.tsx` — fan-out, map, prop wiring, refetch-on-save.
- `src/components/senaite/AnalysisTable.tsx` — prop, inline vial link, M/I overlay +
  `mk1Override` on `EditableSelectCell`, analyst display overlay.

## Out of scope

- Any backend / API / schema change (data is already served per-vial).
- Multi-peptide identity bridging (deferred — ambiguous mapping).
- Quantity (`PEPT-Total`) vial assignment — no per-vial row exists by design.
- Editing Method/Instrument on multi-vial rows (read-only; edit on the vial).
- Changing result / Status / verification / promotion on the parent (untouched).
- Replacing the row wholesale (the rejected "extend the swap" approach).
