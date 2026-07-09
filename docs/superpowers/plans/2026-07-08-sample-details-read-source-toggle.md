# Sample-Details Read-Source Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin flip the sample-details page's AR basic-info between live SENAITE and the Accu-Mk1 registry (`lims_samples`), from a toggle in the readout overlay, with per-field source visibility. Registry-first, SENAITE-fallback per field. Analyses stay SENAITE.

**Architecture:** A small **wrapper endpoint** `GET /registry/sample/{sample_id}/details` calls the existing `lookup_senaite_sample` **unchanged** (full SENAITE payload incl. analyses), then **overlays** registry basic-info onto the scalar fields it holds, tagging each field's real source. Zero surgery to the existing lookup path (refinement of the spec's `source=` param idea — the spec named this wrapper as the alternative; chosen for additivity). FE: a `sessionStorage` toggle in `SampleRegistryDebug` switches `resolveSampleData` (parent pages only) to the wrapper endpoint and surfaces the source tags.

**Tech Stack:** Python/FastAPI/SQLAlchemy, React/TS/vitest. Builds on `feat/registry-debug-panel` (the overlay). Branch: `feat/registry-read-toggle`.

## Global Constraints

- **Overlay endpoint:** `GET /registry/sample/{sample_id}/details`, gated `admin=Depends(require_admin)`. Returns the `SenaiteLookupResult` shape **plus** `read_source: "mk1"`, `registry_missing: bool`, `field_sources: dict[str, "mk1"|"senaite"]`.
- **Overlay is registry-first, per field:** for each OVERLAY field, if the registry row supplies a value → use it, `field_sources[field]="mk1"`; else keep the SENAITE value, `field_sources[field]="senaite"`.
- **OVERLAY fields (this slice):** `sample_uid, client, contact, sample_type, date_received, date_sampled, client_order_number, client_sample_id, client_lot, review_state, declared_weight_mg, analytes`. **Never overlaid** (always SENAITE): `analyses, attachments, remarks, published_coa, profiles, coa, senaite_url`. (`coa` overlay is a deliberate follow-up — nested model; out of this slice.)
- **No registry row** → return the SENAITE result unchanged, `registry_missing=True`, every `field_sources` entry `"senaite"`.
- **Registry column null/absent** → that field is NOT overlaid (stays SENAITE). Never emit empty-string over a real SENAITE value.
- **FE toggle:** `sessionStorage['registryReadSource']`, values `'senaite'|'mk1'`, **default `'senaite'`**. Parent sample pages only; sub-sample pages ignore it. Changing it re-fetches the current sample.
- **Additive/dormant:** default off = zero behavior change. Non-admins never get the toggle and cannot call the endpoint. Read-only — no writes, no change to dual-write/reconcile.
- **Frontend is npm only.** Backend tests: `docker exec accu-mk1-panel-test python -m pytest tests/<file> -q` (container mounts this worktree's `backend/`). Frontend: `npm run test:run -- <file>` and `npm run typecheck` from the worktree root.

---

### Task 1: Registry → display-field mapper

**Files:**
- Create: `backend/sub_samples/registry_read.py`
- Test: `backend/tests/test_registry_read.py`

**Interfaces:**
- Produces: `OVERLAY_FIELDS: tuple[str, ...]` and `registry_row_to_display(row: LimsSample) -> dict[str, Any]` — returns a dict keyed by `SenaiteLookupResult` field names, containing **only** the fields the registry row actually supplies (a null/None column → key omitted). Consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_registry_read.py`:

```python
"""Registry-row -> SenaiteLookupResult display mapper (read-source toggle)."""
import json
from datetime import datetime
import pytest
from models import LimsSample
from sub_samples.registry_read import registry_row_to_display, OVERLAY_FIELDS


def _row(**kw):
    return LimsSample(sample_id="PB-0073", **kw)


def test_scalar_fields_map_to_lookup_shape():
    row = _row(external_lims_uid="U1", client_title="Acme", contact_title="Jane Doe",
               sample_type_title="Peptide Blend", client_order_number="WP-1", client_sample_id="CS-9",
               client_lot="L1", status="sample_received")
    out = registry_row_to_display(row)
    assert out["sample_uid"] == "U1"
    assert out["client"] == "Acme"
    assert out["contact"] == "Jane Doe"
    assert out["sample_type"] == "Peptide Blend"
    assert out["client_order_number"] == "WP-1"
    assert out["client_sample_id"] == "CS-9"
    assert out["client_lot"] == "L1"
    assert out["review_state"] == "sample_received"


def test_dates_render_iso():
    row = _row(date_received=datetime(2026, 3, 8, 3, 42, 17),
               date_sampled=datetime(2026, 3, 7, 8, 0, 0))
    out = registry_row_to_display(row)
    assert out["date_received"] == "2026-03-08T03:42:17"
    assert out["date_sampled"] == "2026-03-07T08:00:00"


def test_declared_weight_parses_float_else_omitted():
    assert registry_row_to_display(_row(declared_total_quantity="10.00"))["declared_weight_mg"] == 10.0
    assert "declared_weight_mg" not in registry_row_to_display(_row(declared_total_quantity="n/a"))
    assert "declared_weight_mg" not in registry_row_to_display(_row(declared_total_quantity=None))


def test_analytes_json_unpacks_to_list():
    row = _row(analytes=json.dumps([
        {"name": "KPV - Identity (HPLC)", "declared_quantity": "2.00"},
        {"name": "GHK-Cu - Identity (HPLC)", "declared_quantity": "3.00"},
    ]))
    out = registry_row_to_display(row)
    assert [a["name"] for a in out["analytes"]] == ["KPV - Identity (HPLC)", "GHK-Cu - Identity (HPLC)"]
    assert out["analytes"][0]["declared_quantity"] == "2.00"


def test_malformed_analytes_omitted_not_raised():
    assert "analytes" not in registry_row_to_display(_row(analytes="{not json"))
    assert "analytes" not in registry_row_to_display(_row(analytes=None))


def test_null_columns_are_omitted():
    out = registry_row_to_display(_row())  # everything None
    for f in ("client", "contact", "sample_type", "client_lot", "review_state"):
        assert f not in out


def test_overlay_fields_covers_mapper_keys():
    # Every key the mapper can emit must be declared in OVERLAY_FIELDS (so field_sources is complete).
    row = _row(external_lims_uid="U", client_title="C", contact_title="Ct", sample_type_title="T",
               date_received=datetime(2026, 1, 1), date_sampled=datetime(2026, 1, 1),
               client_order_number="O", client_sample_id="CS", client_lot="L", status="s",
               declared_total_quantity="1.0", analytes=json.dumps([{"name": "x", "declared_quantity": "1"}]))
    assert set(registry_row_to_display(row)).issubset(set(OVERLAY_FIELDS))
```

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read.py -q`
Expected: FAIL — `ModuleNotFoundError: sub_samples.registry_read`.

- [ ] **Step 3: Implement the mapper**

Create `backend/sub_samples/registry_read.py`:

```python
"""Map a lims_samples registry row into the SenaiteLookupResult field shape,
for the sample-details read-source toggle. Only fields the registry actually
supplies are emitted (a null column is omitted, so the overlay layer keeps the
SENAITE value + tags the field 'senaite')."""
import json
from typing import Any
from models import LimsSample

# Every SenaiteLookupResult field this mapper can populate. The overlay's
# field_sources map is built over exactly this set.
OVERLAY_FIELDS: tuple[str, ...] = (
    "sample_uid", "client", "contact", "sample_type",
    "date_received", "date_sampled", "client_order_number",
    "client_sample_id", "client_lot", "review_state",
    "declared_weight_mg", "analytes",
)


def registry_row_to_display(row: LimsSample) -> dict[str, Any]:
    out: dict[str, Any] = {}

    def put(key: str, value: Any) -> None:
        if value is not None and value != "":
            out[key] = value

    put("sample_uid", row.external_lims_uid)
    put("client", row.client_title)
    put("contact", row.contact_title)
    put("sample_type", row.sample_type_title)
    put("client_order_number", row.client_order_number)
    put("client_sample_id", row.client_sample_id)
    put("client_lot", row.client_lot)
    put("review_state", row.status)
    if row.date_received is not None:
        out["date_received"] = row.date_received.isoformat()
    if row.date_sampled is not None:
        out["date_sampled"] = row.date_sampled.isoformat()

    if row.declared_total_quantity not in (None, ""):
        try:
            out["declared_weight_mg"] = float(row.declared_total_quantity)
        except (ValueError, TypeError):
            pass

    if row.analytes:
        try:
            parsed = json.loads(row.analytes)
            if isinstance(parsed, list):
                out["analytes"] = parsed
        except (ValueError, TypeError):
            pass

    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read.py -q`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/registry_read.py backend/tests/test_registry_read.py
git commit -m "feat(read-toggle): registry-row -> display-field mapper"
```

---

### Task 2: Registry-overlay read endpoint

**Files:**
- Modify: `backend/main.py` (add response model + endpoint near the other `/registry/*` or `/debug/sample-registry` routes, e.g. after `get_sample_registry_debug` ~line 16792)
- Test: `backend/tests/test_registry_read_endpoint.py`

**Interfaces:**
- Consumes: `registry_row_to_display`, `OVERLAY_FIELDS` (Task 1); the existing `lookup_senaite_sample(id, no_cache, db, _current_user)` (`main.py:12058`); `require_admin`; `LimsSample`.
- Produces: `GET /registry/sample/{sample_id}/details` → `RegistrySampleReadResult` (= `SenaiteLookupResult` + `read_source`, `registry_missing`, `field_sources`). Consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_registry_read_endpoint.py`. Use the repo's established endpoint-test idiom (FastAPI `TestClient`, sqlite fixture with `StaticPool`, admin auth override) — mirror `tests/test_registry_debug_endpoint.py` for fixture + admin-auth setup. Mock `lookup_senaite_sample` to return a `SenaiteLookupResult` with known SENAITE values, seed a `LimsSample`, and assert:

```python
# Behaviors to assert (fill in with the repo's TestClient+admin idiom from
# test_registry_debug_endpoint.py):
#
# 1. overlay_applies_registry_over_senaite:
#    SENAITE result.client="SenaiteCo", registry client_title="RegistryCo"
#    -> response.client == "RegistryCo"; field_sources["client"] == "mk1"
# 2. fallback_keeps_senaite_where_registry_null:
#    registry client_lot=None, SENAITE client_lot="L-SEN"
#    -> response.client_lot == "L-SEN"; field_sources["client_lot"] == "senaite"
# 3. analyses_never_overlaid:
#    SENAITE result.analyses has 2 rows -> response.analyses unchanged (still 2, SENAITE)
# 4. missing_row_returns_senaite_and_flag:
#    no LimsSample for the id -> registry_missing True, every field_sources value "senaite",
#    response basic-info == SENAITE values
# 5. field_sources_covers_overlay_fields:
#    set(field_sources.keys()) == set(OVERLAY_FIELDS)
# 6. non_admin_rejected:
#    without the admin override -> 401/403 (require_admin gate)
```

Write these as real `TestClient` tests (not comments) following `test_registry_debug_endpoint.py`; patch `main.lookup_senaite_sample` with an `AsyncMock` returning a `SenaiteLookupResult`.

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read_endpoint.py -q`
Expected: FAIL — 404 (route not defined) / import error.

- [ ] **Step 3: Add the response model + endpoint**

In `backend/main.py`, add the model near `SenaiteLookupResult` (~line 11836):

```python
class RegistrySampleReadResult(SenaiteLookupResult):
    """SenaiteLookupResult with basic-info overlaid from the Accu-Mk1 registry.
    field_sources records, per overlay field, whether the value shown came from
    the registry ('mk1') or fell back to SENAITE ('senaite')."""
    read_source: str = "mk1"
    registry_missing: bool = False
    field_sources: dict[str, str] = {}
```

Add the endpoint (near the other registry/debug routes, ~after 16792). It reuses `lookup_senaite_sample` wholesale:

```python
@app.get("/registry/sample/{sample_id}/details", response_model=RegistrySampleReadResult)
async def get_sample_read_from_registry(
    sample_id: str,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """Admin diagnostic read path: the sample-details basic-info sourced
    registry-first (Accu-Mk1 lims_samples) with per-field SENAITE fallback.
    Analyses and everything else come from the unchanged SENAITE lookup."""
    from sub_samples.registry_read import registry_row_to_display, OVERLAY_FIELDS

    base = await lookup_senaite_sample(id=sample_id, no_cache=True, db=db, _current_user=admin)
    payload = base.model_dump()

    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id.strip().upper())
    ).scalar_one_or_none()

    field_sources = {f: "senaite" for f in OVERLAY_FIELDS}
    if row is None:
        return RegistrySampleReadResult(**payload, read_source="mk1",
                                        registry_missing=True, field_sources=field_sources)

    overlay = registry_row_to_display(row)
    for field, value in overlay.items():
        payload[field] = value
        field_sources[field] = "mk1"

    return RegistrySampleReadResult(**payload, read_source="mk1",
                                    registry_missing=False, field_sources=field_sources)
```

Note for the implementer: confirm `SenaiteLookupResult` is a Pydantic v2 model (`.model_dump()`); if the repo is on Pydantic v1 here, use `.dict()`. Confirm `select` and `LimsSample` are already imported at module top (they are used elsewhere in main.py).

- [ ] **Step 4: Run to verify pass**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read_endpoint.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_registry_read_endpoint.py
git commit -m "feat(read-toggle): registry-overlay read endpoint (mk1-first, senaite fallback)"
```

---

### Task 3: Read-source store + overlay toggle control

**Files:**
- Create: `src/lib/read-source.ts` (tiny store/hook)
- Modify: `src/components/senaite/SampleRegistryDebug.tsx` (add the toggle to the header)
- Test: `src/lib/__tests__/read-source.test.ts`

**Interfaces:**
- Produces: `useReadSource(): { source: 'senaite'|'mk1', setSource: (s) => void }` backed by `sessionStorage['registryReadSource']` (default `'senaite'`), with a subscribe mechanism so `SampleDetails` (Task 4) and the overlay stay in sync. Consumed by Task 4 + Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/read-source.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { getReadSource, setReadSource } from '@/lib/read-source'

describe('read-source', () => {
  beforeEach(() => sessionStorage.clear())

  it('defaults to senaite', () => {
    expect(getReadSource()).toBe('senaite')
  })

  it('persists a set value in sessionStorage', () => {
    setReadSource('mk1')
    expect(getReadSource()).toBe('mk1')
    expect(sessionStorage.getItem('registryReadSource')).toBe('mk1')
  })

  it('ignores a garbage stored value and returns the default', () => {
    sessionStorage.setItem('registryReadSource', 'nonsense')
    expect(getReadSource()).toBe('senaite')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run -- src/lib/__tests__/read-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store + hook**

Create `src/lib/read-source.ts`:

```typescript
import { useSyncExternalStore } from 'react'

export type ReadSource = 'senaite' | 'mk1'
const KEY = 'registryReadSource'
const listeners = new Set<() => void>()

export function getReadSource(): ReadSource {
  return sessionStorage.getItem(KEY) === 'mk1' ? 'mk1' : 'senaite'
}

export function setReadSource(source: ReadSource): void {
  sessionStorage.setItem(KEY, source)
  listeners.forEach((l) => l())
}

/** React hook: current read source + setter, shared across components. */
export function useReadSource(): { source: ReadSource; setSource: (s: ReadSource) => void } {
  const source = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    getReadSource,
    () => 'senaite',
  )
  return { source, setSource: setReadSource }
}
```

- [ ] **Step 4: Add the toggle to the overlay**

In `src/components/senaite/SampleRegistryDebug.tsx`: import `useReadSource`, and in the header button row (next to the reconcile/refresh/close buttons, ~line 105-115) add a segmented control:

```tsx
// near the other header buttons:
const { source, setSource } = useReadSource()
// ...
<div className="flex items-center gap-0.5 rounded border border-zinc-800 p-0.5 mr-1">
  {(['senaite', 'mk1'] as const).map((s) => (
    <button key={s} onClick={() => setSource(s)}
      className={cn('px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors',
        source === s ? 'bg-emerald-600/30 text-emerald-300' : 'text-zinc-600 hover:text-zinc-300')}>
      {s === 'senaite' ? 'SENAITE' : 'Accu-Mk1'}
    </button>
  ))}
</div>
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test:run -- src/lib/__tests__/read-source.test.ts && npm run typecheck`
Expected: PASS (3 tests) + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/read-source.ts src/lib/__tests__/read-source.test.ts src/components/senaite/SampleRegistryDebug.tsx
git commit -m "feat(read-toggle): read-source store + overlay toggle control"
```

---

### Task 4: Wire the read path to the registry endpoint

**Files:**
- Modify: `src/lib/api.ts` (`lookupSenaiteSample` + the `SenaiteLookupResult` FE type)
- Modify: `src/components/senaite/SampleDetails.tsx` (`resolveSampleData` parent branch + re-fetch on toggle change)
- Test: `src/lib/__tests__/lookup-source.test.ts`

**Interfaces:**
- Consumes: `getReadSource`/`useReadSource` (Task 3); the endpoint `GET /registry/sample/{id}/details` (Task 2).
- Produces: `lookupSenaiteSample(sampleId, noCache?, source?)` — when `source==='mk1'`, fetches `/registry/sample/{id}/details`; FE `SenaiteLookupResult` type gains optional `field_sources?`, `read_source?`, `registry_missing?`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/lookup-source.test.ts` — mock `fetch`, call `lookupSenaiteSample('PB-0073', true, 'mk1')`, assert the request URL is `/registry/sample/PB-0073/details` (not `/wizard/senaite/lookup`); call with `'senaite'` (or omitted) and assert it hits `/wizard/senaite/lookup`. Follow the repo's existing api.ts test idiom for mocking `fetch` + `API_BASE_URL`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run -- src/lib/__tests__/lookup-source.test.ts`
Expected: FAIL — `source` param not handled; both call the SENAITE URL.

- [ ] **Step 3: Extend `lookupSenaiteSample` + the type**

In `src/lib/api.ts`:
- Extend the FE `SenaiteLookupResult` type (find its declaration — the return type of `lookupSenaiteSample`) with:
  ```typescript
  field_sources?: Record<string, 'mk1' | 'senaite'>
  read_source?: 'mk1'
  registry_missing?: boolean
  ```
- Add a `source` parameter and branch the URL:
  ```typescript
  export async function lookupSenaiteSample(
    sampleId: string,
    noCache = true,
    source: 'senaite' | 'mk1' = 'senaite',
  ): Promise<SenaiteLookupResult> {
    const url = source === 'mk1'
      ? `${API_BASE_URL()}/registry/sample/${encodeURIComponent(sampleId)}/details`
      : `${API_BASE_URL()}/wizard/senaite/lookup?id=${encodeURIComponent(sampleId)}&no_cache=${noCache}`
    // ...existing senaiteLimiter/fetch/timeout body, using `url`...
  }
  ```
  Keep the existing limiter/abort/error handling; only the URL is conditional.

- [ ] **Step 4: Branch `resolveSampleData` + re-fetch on toggle**

In `src/components/senaite/SampleDetails.tsx`:
- Import `useReadSource`; call it in the component: `const { source: readSource } = useReadSource()`.
- In `resolveSampleData` (`~3880`), for the **parent** branch (where `parentId` is undefined → `return lookupSenaiteSample(id)`), pass the source: `return lookupSenaiteSample(id, true, readSource)`. Leave the sub-sample branch untouched.
- Ensure `readSource` is in `resolveSampleData`'s `useCallback` dependency array, and that the effect calling `resolveSampleData` re-runs when it changes (so flipping the toggle re-fetches the open sample).

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test:run -- src/lib/__tests__/lookup-source.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/components/senaite/SampleDetails.tsx src/lib/__tests__/lookup-source.test.ts
git commit -m "feat(read-toggle): route parent reads to the registry endpoint when toggled"
```

---

### Task 5: Source visibility — per-field tags + summary

**Files:**
- Modify: `src/components/senaite/SampleRegistryDebug.tsx` (per-field source column when `read_source==='mk1'`)
- Modify: `src/components/senaite/SampleDetails.tsx` (a mode banner + N/M summary chip)
- Test: `src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` (extend)

**Interfaces:**
- Consumes: `field_sources`/`read_source`/`registry_missing` on the sample data (Task 4); the toggle state (Task 3).

- [ ] **Step 1: Extend the overlay test**

In `SampleRegistryDebug.test.tsx`, add a case: when the passed data has `read_source: 'mk1'` and `field_sources: { client: 'mk1', client_lot: 'senaite' }`, the panel renders a source marker for those fields (assert both an `mk1` and a `sen`/`senaite` marker appear). Follow the existing test's mock+render idiom.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run -- src/components/senaite/__tests__/SampleRegistryDebug.test.tsx`
Expected: FAIL — no source markers rendered.

- [ ] **Step 3: Render per-field source in the overlay**

In `SampleRegistryDebug.tsx`, when the sample data carries `read_source === 'mk1'`, render a small per-field source tag (`mk1` emerald / `sen` zinc) derived from `field_sources[field]`, in the field-diff rows. (The overlay already lists fields; add the tag inline.) Guard so nothing renders in `senaite` mode (backward compatible).

- [ ] **Step 4: Add the main-page summary**

In `SampleDetails.tsx`, when the resolved sample has `read_source === 'mk1'`, render a subtle banner near the sample header:
- If `registry_missing`: `"reading from Accu-Mk1 — no registry row, showing SENAITE"`.
- Else: `"reading basic-info from Accu-Mk1 — N/M fields"` where `N = count(field_sources==='mk1')`, `M = Object.keys(field_sources).length`.
Keep it visually subtle (small, mono, dimmed); render nothing in `senaite` mode.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test:run -- src/components/senaite/__tests__/SampleRegistryDebug.test.tsx && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/senaite/SampleRegistryDebug.tsx src/components/senaite/SampleDetails.tsx src/components/senaite/__tests__/SampleRegistryDebug.test.tsx
git commit -m "feat(read-toggle): per-field source tags + reading-from-mk1 summary"
```

---

## Self-Review

**Spec coverage:** toggle in overlay (Task 3) ✓; registry-first/SENAITE-fallback per field (Task 2) ✓; field_sources + source tags + N/M summary (Task 2 + 5) ✓; parent-only, sub-sample unchanged (Task 4) ✓; analyses stay SENAITE (Task 2 — never overlaid) ✓; no-registry-row + malformed-JSON fallback (Task 1 + 2) ✓; admin-gated (Task 2) ✓; default-off (Task 3) ✓.

**Deviation from spec (noted):** backend is a wrapper endpoint (`/registry/sample/{id}/details`) rather than a `source=` param on the lookup — the spec's stated alternative, chosen for additivity. `coa` overlay deferred (nested model) — a follow-up; `coa` stays SENAITE this slice.

**Placeholder scan:** Tasks 1 & 3 carry complete code. Tasks 2, 4, 5 carry complete new-code blocks plus explicit "follow existing idiom X at anchor Y" for the parts that must match repo test/render conventions (TestClient+admin fixture, fetch-mock, field render sites) — the implementer reads the named neighbor file for the idiom.

**Type consistency:** `field_sources: dict[str,str]` (backend) ↔ `Record<string,'mk1'|'senaite'>` (FE); `read_source`/`registry_missing` consistent across Tasks 2/4/5; `getReadSource/setReadSource/useReadSource` consistent Tasks 3/4/5; `OVERLAY_FIELDS` shared Task 1/2.
