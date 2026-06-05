# Result Type & Options on Analysis Services — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each analysis service's result type + options locally (synced from SENAITE, local-wins), surface them in the Mk1 senaite-shape response so the result cell renders the right input (dropdown for sterility), and add a management UI in the Analysis Services flyout to curate them.

**Architecture:** Two additive columns on `analysis_services` (`result_type`, `result_options`). The SENAITE service sync seeds them only when NULL (local-wins). `list_analyses_in_senaite_shape` populates them from the joined service. The existing `EditableResultCell` already renders a dropdown when `result_options` is non-empty, so the response wiring alone makes sterility work; a small refinement adds `numeric → number input`. A new `PATCH /analysis-services/{id}/result-type` endpoint + a flyout editor let the lab manage them.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (backend); React + TypeScript + vitest (frontend). Tests run in containers (`accumark-subvial-accu-mk1-backend` / `-frontend`).

**Spec:** `docs/superpowers/specs/2026-06-04-result-type-options-design.md`.

**Branch:** `subvial/continue` (worktree at `C:/tmp/Accu-Mk1-subvial`).

---

## File Structure

- Modify `backend/models.py` — `AnalysisService`: add `result_type`, `result_options`.
- Modify `backend/database.py` — idempotent `ALTER TABLE` for the two columns.
- Modify `backend/main.py` — `sync_analysis_services` (seed-only); new `PATCH /analysis-services/{id}/result-type` + its request schema.
- Modify `backend/lims_analyses/schemas.py` — `SenaiteShapeAnalysisResponse`: add `result_type`.
- Modify `backend/lims_analyses/service.py` — `list_analyses_in_senaite_shape`: populate `result_type` + `result_options` from the joined service.
- Modify `src/lib/api.ts` — add `result_type` + `result_options` to the FE `AnalysisService` type; add `result_type` to `SenaiteAnalysis`; add `updateAnalysisServiceResultType` client.
- Modify `src/components/senaite/AnalysisTable.tsx` — `EditableResultCell`: `numeric → number input` refinement.
- Create `src/components/hplc/ResultOptionsEditor.tsx` — the options list editor.
- Modify `src/components/hplc/AnalysisServicesPage.tsx` — flyout section wiring the type select + editor + Save.
- Tests: `backend/tests/test_analysis_service_result_type.py`, `src/test/result-options-editor.test.tsx`.

**Test commands:**
- Backend: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -v"`
- Frontend: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run <path>"`
- FE typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"` → expect ONLY the 2 known pre-existing errors (`WorksheetsInboxPage.tsx(356,38)`, `SampleDetails.tsx ... subSamples ... never read`).

---

## Task 1: Schema — `result_type` + `result_options` on `analysis_services`

**Files:**
- Modify: `backend/models.py` (`AnalysisService`, ~line 145-164)
- Modify: `backend/database.py` (lightweight-migrations ALTER block, ~line 127-145)
- Test: `backend/tests/test_analysis_service_result_type.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_analysis_service_result_type.py
"""Result type + options on AnalysisService (analysis_services)."""
from __future__ import annotations

from models import AnalysisService


def test_analysis_service_result_type_columns(db_session):
    svc = AnalysisService(
        title="Rapid Sterility Screening (PCR)",
        keyword="STER-PCR",
        result_type="select",
        result_options=[
            {"value": "1", "label": "Conforms"},
            {"value": "0", "label": "Does Not Conform"},
        ],
    )
    db_session.add(svc)
    db_session.commit()
    db_session.refresh(svc)

    assert svc.result_type == "select"
    assert svc.result_options == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]


def test_analysis_service_result_type_defaults_none(db_session):
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PUR")
    db_session.add(svc)
    db_session.commit()
    db_session.refresh(svc)
    assert svc.result_type is None
    assert svc.result_options is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_analysis_service_result_type.py -v"`
Expected: FAIL — `AnalysisService` has no `result_type` (TypeError on the kwarg / AttributeError).

- [ ] **Step 3: Add the columns to the model**

In `backend/models.py`, `AnalysisService` (after the `unit` / `methods` columns, ~line 156-157), add:

```python
    # Result type + options, synced from SENAITE (local-wins) or curated locally.
    # result_type stores SENAITE's value verbatim (numeric/select/multiselect/string/...).
    # result_options is a list of {"value": str, "label": str} (select/multiselect only).
    result_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result_options: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
```

(`Text`, `JSON`, `Mapped`, `mapped_column`, `Optional` are already imported in models.py — confirm at the top; `JSON` is used by `AnalysisService.methods` already.)

- [ ] **Step 4: Add the idempotent migration**

In `backend/database.py`, find the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` list (~line 133-143) and append:

```python
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS result_type TEXT",
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS result_options JSONB",
```

- [ ] **Step 5: Run the test — should pass**

Run: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_analysis_service_result_type.py -v"`
Expected: 2 passed. (SQLite `create_all` builds the columns for the test DB; the ALTER covers the live Postgres.)

If it errors on a missing live column, restart the backend so `init_db` runs the ALTER: `docker compose -p accumark-subvial restart accu-mk1-backend && docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio`.

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_analysis_service_result_type.py
git commit -m "feat(analysis-services): result_type + result_options columns

Phase: result-type, Task 1. Two additive columns on analysis_services
(result_type TEXT, result_options JSONB) to hold SENAITE-synced or
locally-curated result type + dropdown options.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Sync — seed result type/options only when NULL (local-wins)

**Files:**
- Modify: `backend/main.py` (`sync_analysis_services`, ~line 2503-2594)
- Test: `backend/tests/test_analysis_service_result_type.py` (append)

**Context:** `sync_analysis_services` loops SENAITE service `item`s. The `existing` branch (main.py:2572-2577) currently only back-fills `category`; the `else` creates a new `AnalysisService(...)` (2579-2588). SENAITE service objects expose `ResultType` / `getResultType` and `ResultOptions` / `getResultOptions` (options are `[{ResultValue, ResultText}, ...]`).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_analysis_service_result_type.py`:

```python
from main import _parse_service_result_options, _apply_service_result_type


def test_parse_service_result_options_maps_value_label():
    raw = [
        {"ResultValue": 1, "ResultText": "Conforms"},
        {"ResultValue": 0, "ResultText": "Does Not Conform"},
    ]
    assert _parse_service_result_options(raw) == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]


def test_parse_service_result_options_handles_empty():
    assert _parse_service_result_options(None) == []
    assert _parse_service_result_options([]) == []


def test_apply_seeds_when_result_type_null(db_session):
    svc = AnalysisService(title="Ster", keyword="STER-PCR")  # result_type is None
    db_session.add(svc)
    db_session.flush()
    item = {"ResultType": "select", "ResultOptions": [{"ResultValue": 1, "ResultText": "Conforms"}]}

    _apply_service_result_type(svc, item)

    assert svc.result_type == "select"
    assert svc.result_options == [{"value": "1", "label": "Conforms"}]


def test_apply_does_not_overwrite_existing(db_session):
    svc = AnalysisService(
        title="Ster", keyword="STER-PCR",
        result_type="numeric", result_options=[{"value": "x", "label": "y"}],
    )
    db_session.add(svc)
    db_session.flush()
    item = {"ResultType": "select", "ResultOptions": [{"ResultValue": 1, "ResultText": "Conforms"}]}

    _apply_service_result_type(svc, item)  # local-wins: unchanged

    assert svc.result_type == "numeric"
    assert svc.result_options == [{"value": "x", "label": "y"}]
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_analysis_service_result_type.py -v -k 'parse or apply'"`
Expected: FAIL — `cannot import name '_parse_service_result_options'`.

- [ ] **Step 3: Add the two helpers**

In `backend/main.py`, just above `sync_analysis_services` (~line 2503), add:

```python
def _parse_service_result_options(raw) -> list[dict]:
    """SENAITE ResultOptions [{ResultValue, ResultText}] -> [{value, label}]."""
    out: list[dict] = []
    if raw and isinstance(raw, list):
        for opt in raw:
            if isinstance(opt, dict) and opt.get("ResultValue") is not None:
                out.append({
                    "value": str(opt["ResultValue"]),
                    "label": str(opt.get("ResultText", opt["ResultValue"])),
                })
    return out


def _apply_service_result_type(svc, item: dict) -> None:
    """Seed svc.result_type / result_options from a SENAITE service item, but
    ONLY when svc.result_type is NULL (local-wins). No-op otherwise."""
    if svc.result_type is not None:
        return
    rtype = item.get("ResultType") or item.get("getResultType")
    if not rtype:
        return
    svc.result_type = str(rtype)
    svc.result_options = _parse_service_result_options(
        item.get("ResultOptions") or item.get("getResultOptions") or []
    ) or None
```

- [ ] **Step 4: Call it from both sync branches**

In `sync_analysis_services`, the `existing` branch (after the category back-fill, ~line 2576) — add before `continue`:

```python
        if existing:
            # Back-fill category if it was missing
            if not existing.category and category:
                existing.category = category
                updated += 1
            _apply_service_result_type(existing, item)  # local-wins seed
            continue
```

And for new services, after `db.add(svc)` (~line 2589):

```python
        db.add(svc)
        _apply_service_result_type(svc, item)
        created += 1
```

(`svc.result_type` is None on a fresh `AnalysisService`, so `_apply_service_result_type` seeds it.)

- [ ] **Step 5: Run the tests — should pass**

Run: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_analysis_service_result_type.py -v"`
Expected: all passed (Task 1's 2 + these 4).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_analysis_service_result_type.py
git commit -m "feat(analysis-services): seed result type/options from SENAITE (local-wins)

Phase: result-type, Task 2. sync_analysis_services now seeds
result_type/result_options from SENAITE ResultType/ResultOptions, but
only when the local result_type is NULL — manual edits and prior seeds
are never overwritten.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Response wiring — carry result_type + options into the senaite-shape

**Files:**
- Modify: `backend/lims_analyses/schemas.py` (`SenaiteShapeAnalysisResponse`, ~line 169-203)
- Modify: `backend/lims_analyses/service.py` (`list_analyses_in_senaite_shape`, ~line 558-579)
- Test: `backend/tests/test_lims_analyses_service.py` (append) OR a new `backend/tests/test_senaite_shape_result_type.py`

**This is the task that makes the sterility dropdown work** — the FE cell already renders a dropdown when `result_options` is non-empty.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_senaite_shape_result_type.py`:

```python
"""senaite-shape response carries result_type + result_options from the service."""
from __future__ import annotations

from models import AnalysisService, LimsSample, LimsSubSample, LimsAnalysis
from lims_analyses.service import list_analyses_in_senaite_shape


def _setup(db_session):
    svc = AnalysisService(
        title="Rapid Sterility Screening (PCR)", keyword="STER-PCR",
        result_type="select",
        result_options=[{"value": "1", "label": "Conforms"},
                        {"value": "0", "label": "Does Not Conform"}],
    )
    db_session.add(svc)
    db_session.flush()
    parent = LimsSample(sample_id="RT-0001", external_lims_uid="uid-RT-0001")
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://x",
                        sample_id="RT-0001-S01", vial_sequence=1)
    db_session.add(sub)
    db_session.flush()
    a = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                     keyword="STER-PCR", title="Rapid Sterility Screening (PCR)",
                     review_state="to_be_verified", result_value=None)
    db_session.add(a)
    db_session.commit()
    return sub


def test_shape_carries_result_type_and_options(db_session):
    sub = _setup(db_session)
    rows = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id, include_retests=False,
    )
    assert len(rows) == 1
    r = rows[0]
    assert r.result_type == "select"
    assert [o.model_dump() for o in r.result_options] == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_senaite_shape_result_type.py -v"`
Expected: FAIL — `SenaiteShapeAnalysisResponse` has no `result_type`, and `result_options` is `[]`.

- [ ] **Step 3: Add `result_type` to the response schema**

In `backend/lims_analyses/schemas.py`, `SenaiteShapeAnalysisResponse` (after `promoted_to_parent_id`, ~line 203), add:

```python
    # Result type + dropdown options, sourced from the analysis_service.
    result_type: Optional[str] = None
```

(`result_options: List[SenaiteShapeResultOption]` already exists at ~line 182.)

- [ ] **Step 4: Populate from the joined service**

In `backend/lims_analyses/service.py`, `list_analyses_in_senaite_shape`, inside the `for r in rows:` loop (`svc = services_by_id.get(r.analysis_service_id)` already exists at ~line 550), build the options before the append:

```python
        svc = services_by_id.get(r.analysis_service_id)
        svc_options = [
            SenaiteShapeResultOption(value=o["value"], label=o["label"])
            for o in (getattr(svc, "result_options", None) or [])
            if isinstance(o, dict) and "value" in o and "label" in o
        ]
        # ... method_name / instrument_name unchanged ...
```

Then change the `SenaiteShapeAnalysisResponse(...)` call: replace `result_options=[],` (line ~563) with `result_options=svc_options,` and add `result_type=getattr(svc, "result_type", None),`.

Ensure `SenaiteShapeResultOption` is imported in service.py (it's in `lims_analyses.schemas` — add to the existing import if missing).

- [ ] **Step 5: Run the test — should pass**

Run: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_senaite_shape_result_type.py -v"`
Expected: 1 passed.

- [ ] **Step 6: Live wiring check (manual, optional but recommended)**

Set the sterility service's options directly, re-fetch, confirm a native ster row carries them:
```bash
docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "UPDATE analysis_services SET result_type='select', result_options='[{\"value\":\"1\",\"label\":\"Conforms\"},{\"value\":\"0\",\"label\":\"Does Not Conform\"}]'::jsonb WHERE keyword='STER-PCR';"
```
Then in the UI, refresh a native ster vial (e.g. P-0143-S03) → the result cell should now show the **Conforms / Does Not Conform** dropdown.

- [ ] **Step 7: Commit**

```bash
git add backend/lims_analyses/schemas.py backend/lims_analyses/service.py backend/tests/test_senaite_shape_result_type.py
git commit -m "feat(lims-analyses): surface result_type + options in senaite-shape

Phase: result-type, Task 3. list_analyses_in_senaite_shape now populates
result_type + result_options from the row's analysis_service instead of
[]. The result cell already renders a dropdown when options are present,
so sterility now shows Conforms / Does Not Conform on native vials.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: FE type + numeric-input refinement

**Files:**
- Modify: `src/lib/api.ts` (`SenaiteAnalysis` type; `AnalysisService` type)
- Modify: `src/components/senaite/AnalysisTable.tsx` (`EditableResultCell`)

**Context:** The cell already renders a dropdown when `result_options` is non-empty and a text input otherwise. This task only adds the `result_type` field to the FE types (needed by the management UI + future) and a `numeric → number input` nicety. Select/string/multiselect/unknown already render acceptably (dropdown or text).

- [ ] **Step 1: Add `result_type` to the FE types**

In `src/lib/api.ts`, find the `SenaiteAnalysis` interface and add (near `result_options`):

```typescript
  result_type?: string | null
```

And find the `AnalysisService` interface (imported by AnalysisServicesPage) and add:

```typescript
  result_type?: string | null
  result_options?: { value: string; label: string }[] | null
```

- [ ] **Step 2: Typecheck (no test — type-only change)**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`
Expected: only the 2 pre-existing errors.

- [ ] **Step 3: numeric → number input refinement**

In `src/components/senaite/AnalysisTable.tsx` `EditableResultCell`, the autoEdit text `<Input>` (the `else` branch, ~line 360-372, `type="text"`) — make it a number input when the service type is numeric. Add near the top of the component (after `const hasOptions = ...`, ~line 293):

```typescript
  const isNumeric = analysis.result_type === 'numeric'
```

Then on the fallback `<Input>` elements in this component (the autoEdit one ~line 361 and the edit-mode one further down), change `type="text"` to `type={isNumeric ? 'number' : 'text'}`. (Leave the dropdown branches untouched.)

- [ ] **Step 4: Typecheck again**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`
Expected: only the 2 pre-existing errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/components/senaite/AnalysisTable.tsx
git commit -m "feat(analysis-table): result_type on FE types + numeric number-input

Phase: result-type, Task 4. Adds result_type to SenaiteAnalysis +
AnalysisService FE types; numeric services render a number input. Select
already renders a dropdown via result_options; multiselect/unknown fall
back to text (deferred per spec).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Backend PATCH endpoint for result type/options

**Files:**
- Modify: `backend/main.py` (new request schema + `PATCH /analysis-services/{id}/result-type`, beside `update_analysis_service_peptide` ~line 2472)
- Test: `backend/tests/test_analysis_service_result_type.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_analysis_service_result_type.py`:

```python
def test_update_result_type_endpoint(client, db_session):
    # `client` is the FastAPI TestClient fixture used by other route tests
    # (see tests/test_sub_samples_routes.py for the auth-override pattern).
    svc = AnalysisService(title="Ster", keyword="STER-PCR")
    db_session.add(svc)
    db_session.commit()

    resp = client.patch(
        f"/analysis-services/{svc.id}/result-type",
        json={"result_type": "select",
              "result_options": [{"value": "1", "label": "Conforms"}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["result_type"] == "select"
    assert body["result_options"] == [{"value": "1", "label": "Conforms"}]
```

If the test file has no `client` fixture, mirror the TestClient + `app.dependency_overrides[get_current_user]` setup from `tests/test_sub_samples_routes.py` (lines ~20-26) in a local fixture.

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_analysis_service_result_type.py -v -k update_result_type"`
Expected: FAIL — 404 (route doesn't exist).

- [ ] **Step 3: Add the request schema**

In `backend/main.py`, near `AnalysisServicePeptideUpdate` (search for that class), add:

```python
class AnalysisServiceResultTypeUpdate(BaseModel):
    result_type: Optional[str] = None
    result_options: Optional[list] = None
```

- [ ] **Step 4: Add the endpoint**

In `backend/main.py`, right after `update_analysis_service_peptide` (~line 2502), add (mirroring its shape):

```python
@app.patch("/analysis-services/{service_id}/result-type", response_model=AnalysisServiceResponse)
async def update_analysis_service_result_type(
    service_id: int,
    data: AnalysisServiceResultTypeUpdate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Set a service's result type + options (local-authoritative once set)."""
    service = db.execute(
        select(AnalysisService).where(AnalysisService.id == service_id)
    ).scalar_one_or_none()
    if not service:
        raise HTTPException(404, f"Analysis service {service_id} not found")
    service.result_type = data.result_type
    service.result_options = data.result_options
    db.commit()
    db.refresh(service)
    return AnalysisServiceResponse.model_validate(service)
```

Ensure `AnalysisServiceResponse` exposes `result_type` + `result_options` — find that Pydantic class (near the peptide endpoint) and add the two fields if missing:

```python
    result_type: Optional[str] = None
    result_options: Optional[list] = None
```

- [ ] **Step 5: Run the test — should pass**

Run: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_analysis_service_result_type.py -v"`
Expected: all passed.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_analysis_service_result_type.py
git commit -m "feat(analysis-services): PATCH result-type endpoint

Phase: result-type, Task 5. PATCH /analysis-services/{id}/result-type
sets result_type + result_options. Setting them makes the service
locally authoritative (non-NULL -> sync skips it).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Management UI — type select + options editor in the flyout

**Files:**
- Create: `src/components/hplc/ResultOptionsEditor.tsx`
- Modify: `src/lib/api.ts` (add `updateAnalysisServiceResultType` client)
- Modify: `src/components/hplc/AnalysisServicesPage.tsx` (flyout section)
- Test: `src/test/result-options-editor.test.tsx`

- [ ] **Step 1: Write the failing test for the editor**

```tsx
// src/test/result-options-editor.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ResultOptionsEditor } from '@/components/hplc/ResultOptionsEditor'

describe('ResultOptionsEditor', () => {
  it('renders existing rows', () => {
    const { getByDisplayValue } = render(
      <ResultOptionsEditor
        options={[{ value: '1', label: 'Conforms' }]}
        onChange={() => {}}
      />,
    )
    expect(getByDisplayValue('1')).toBeTruthy()
    expect(getByDisplayValue('Conforms')).toBeTruthy()
  })

  it('adds a row on Add option', () => {
    const onChange = vi.fn()
    const { getByText } = render(
      <ResultOptionsEditor options={[]} onChange={onChange} />,
    )
    fireEvent.click(getByText('Add option'))
    expect(onChange).toHaveBeenCalledWith([{ value: '', label: '' }])
  })

  it('removes a row', () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(
      <ResultOptionsEditor
        options={[{ value: '1', label: 'Conforms' }]}
        onChange={onChange}
      />,
    )
    fireEvent.click(getByLabelText('Remove option 1'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('edits a value', () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(
      <ResultOptionsEditor
        options={[{ value: '1', label: 'Conforms' }]}
        onChange={onChange}
      />,
    )
    fireEvent.change(getByLabelText('Option 1 value'), { target: { value: '2' } })
    expect(onChange).toHaveBeenCalledWith([{ value: '2', label: 'Conforms' }])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/result-options-editor.test.tsx"`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the editor component**

```tsx
// src/components/hplc/ResultOptionsEditor.tsx
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { X, Plus } from 'lucide-react'

export interface ResultOption {
  value: string
  label: string
}

/** Add / edit / remove list of {value, label} result options. Controlled. */
export function ResultOptionsEditor({
  options,
  onChange,
}: {
  options: ResultOption[]
  onChange: (next: ResultOption[]) => void
}) {
  const setRow = (i: number, patch: Partial<ResultOption>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)))
  const removeRow = (i: number) => onChange(options.filter((_, j) => j !== i))
  const addRow = () => onChange([...options, { value: '', label: '' }])

  return (
    <div className="space-y-2">
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="h-8 w-24 font-mono text-sm"
            value={o.value}
            placeholder="value"
            aria-label={`Option ${i + 1} value`}
            onChange={e => setRow(i, { value: e.target.value })}
          />
          <Input
            className="h-8 flex-1 text-sm"
            value={o.label}
            placeholder="label"
            aria-label={`Option ${i + 1} label`}
            onChange={e => setRow(i, { label: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={`Remove option ${o.value || i + 1}`}
            onClick={() => removeRow(i)}
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus size={14} className="mr-1" /> Add option
      </Button>
    </div>
  )
}
```

(Confirm `@/components/ui/input` and `@/components/ui/button` export `Input`/`Button` — both are used across the codebase, e.g. AnalysisServicesPage already imports UI primitives.)

- [ ] **Step 4: Run the editor tests — should pass**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/result-options-editor.test.tsx"`
Expected: 4 passed.

- [ ] **Step 5: Add the API client**

In `src/lib/api.ts`, near `updateAnalysisServicePeptide`, add:

```typescript
export async function updateAnalysisServiceResultType(
  serviceId: number,
  body: { result_type: string | null; result_options: { value: string; label: string }[] | null },
): Promise<AnalysisService> {
  const response = await fetch(`${API_BASE_URL()}/analysis-services/${serviceId}/result-type`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`updateAnalysisServiceResultType failed: ${response.status}`)
  return response.json()
}
```

- [ ] **Step 6: Wire the flyout section**

In `src/components/hplc/AnalysisServicesPage.tsx`, in the service detail panel (after the `Methods` section, ~line 367), add a "Result Type" section. Use local state for `result_type` + `result_options` seeded from `service`, a type `<Select>` (numeric / select / multiselect / string), the `ResultOptionsEditor` shown only when type is `select`/`multiselect`, and a **Save** button calling `updateAnalysisServiceResultType(service.id, {...})` then refreshing the service list (reuse whatever refetch the peptide editor triggers — follow the `onPeptideChange` handler at line 246-250 which calls the client then refetches).

```tsx
// Inside the detail panel component, with the other hooks:
const [rtType, setRtType] = useState<string>(service.result_type ?? '')
const [rtOptions, setRtOptions] = useState<ResultOption[]>(service.result_options ?? [])
const [rtSaving, setRtSaving] = useState(false)

// ...in the JSX, after the Methods block:
<div className="border-t pt-4">
  <h4 className="mb-3 text-sm font-semibold text-muted-foreground">Result Type</h4>
  <div className="space-y-3">
    <Select value={rtType || 'unset'} onValueChange={v => setRtType(v === 'unset' ? '' : v)}>
      <SelectTrigger className="w-full max-w-xs"><SelectValue placeholder="Result type…" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="unset">— None —</SelectItem>
        <SelectItem value="numeric">Numeric</SelectItem>
        <SelectItem value="select">Select (dropdown)</SelectItem>
        <SelectItem value="multiselect">Multiselect</SelectItem>
        <SelectItem value="string">String</SelectItem>
      </SelectContent>
    </Select>
    {(rtType === 'select' || rtType === 'multiselect') && (
      <ResultOptionsEditor options={rtOptions} onChange={setRtOptions} />
    )}
    <Button
      size="sm"
      disabled={rtSaving}
      onClick={async () => {
        setRtSaving(true)
        try {
          await updateAnalysisServiceResultType(service.id, {
            result_type: rtType || null,
            result_options: (rtType === 'select' || rtType === 'multiselect') ? rtOptions : null,
          })
          onSaved?.()  // refetch services — wire to the same refetch the peptide editor uses
        } finally {
          setRtSaving(false)
        }
      }}
    >
      {rtSaving ? 'Saving…' : 'Save result type'}
    </Button>
  </div>
</div>
```

Import `ResultOptionsEditor` + `ResultOption` from `'@/components/hplc/ResultOptionsEditor'` and `updateAnalysisServiceResultType` from `'@/lib/api'`. Wire `onSaved` to the detail panel's existing refetch (the peptide handler at line 246 already does `await updateAnalysisServicePeptide(...)` then refreshes — match that; if the panel receives a refetch/`onPeptideChange`-style prop, thread an analogous `onSaved`).

- [ ] **Step 7: Typecheck + editor tests**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/result-options-editor.test.tsx && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`
Expected: 4 passed; typecheck only the 2 pre-existing errors.

- [ ] **Step 8: Live check**

In the Analysis Services page, open STER-PCR's flyout → set Result Type = Select, add `1/Conforms` + `0/Does Not Conform`, Save. Then on a native ster vial, the result cell shows the dropdown. (This curates the value the same way the Task 3 SQL did, but via UI.)

- [ ] **Step 9: Commit**

```bash
git add src/components/hplc/ResultOptionsEditor.tsx src/lib/api.ts src/components/hplc/AnalysisServicesPage.tsx src/test/result-options-editor.test.tsx
git commit -m "feat(analysis-services): result type + options management UI

Phase: result-type, Task 6. ResultOptionsEditor + a Result Type section
in the Analysis Services flyout, saving via PATCH .../result-type. Lets
the lab curate result types + dropdown options; saving makes the service
locally authoritative.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Schema (result_type + result_options, idempotent ALTER) → Task 1. ✓
- Sync seed-when-NULL (local-wins) → Task 2. ✓
- Response wiring (result_type on shape + populate from service) → Task 3. ✓
- Cell rendering by type (numeric→number; select→dropdown already; multiselect/unknown→text fallback) → Task 4 (+ existing cell). ✓
- Management UI (type select + options editor + Save + PATCH endpoint) → Tasks 5 + 6. ✓
- Local-authoritative via non-NULL (no override flag) → Task 5 endpoint sets values; Task 2 sync skips non-NULL. ✓
- Testing (sync seed logic, response carries options, PATCH, editor, cell) → covered. ✓

**2. Placeholder scan:** No TBD/TODO. The `onSaved`/refetch wiring in Task 6 Step 6 references the existing peptide-editor refetch pattern (line 246) with exact anchor — not a placeholder, a "match this existing pattern" instruction with the location given.

**3. Type consistency:**
- Option shape `{value, label}` consistent across backend (`SenaiteShapeResultOption.value/label`), sync (`_parse_service_result_options`), JSON storage, FE (`ResultOption`), and the editor. ✓
- `result_type: Optional[str]` / `result_options: Optional[list]` consistent (model, schema, endpoint, FE types). ✓
- Helper names `_parse_service_result_options`, `_apply_service_result_type` consistent (defined Task 2, no later rename). ✓
- `updateAnalysisServiceResultType` consistent (client Task 6 Step 5, call Task 6 Step 6). ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-04-result-type-options.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.

**2. Inline Execution** — execute tasks in this session with checkpoints.

**Which approach?**
