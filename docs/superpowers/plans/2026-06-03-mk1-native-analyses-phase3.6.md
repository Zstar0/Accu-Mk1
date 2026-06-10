# Mk1-Native Analyses Phase 3.6 — Method/Instrument Editing on Mk1 Vials

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bench techs can pick a method + instrument for a Mk1-sourced sub-sample analysis the same way they do today for SENAITE analyses. Adds a Mk1 PATCH endpoint, populates the method/instrument option arrays in the `as=senaite_shape` response so the FE dropdowns render, and shims the existing `setAnalysisMethodInstrument` FE function to dispatch by UID prefix.

**Architecture:** Add `PATCH /api/lims-analyses/{id}/method-instrument` that accepts `{method_id, instrument_id}` (nullable ints), updates the lims_analyses row, and writes an `auto` audit transition with a `method_id=X,instrument_id=Y` reason — same pattern as Phase 1's `set_reportable`. Extend `list_analyses_in_senaite_shape` to bulk-load all `hplc_methods` rows + all `instruments` rows and serialize them as option arrays (uid = int-as-string, title from `name`). FE shim parses the `mk1:` prefix from the analysis UID, parses the method/instrument uid strings back to ints, and PATCHes the Mk1 endpoint.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (backend), React + TypeScript (frontend). No schema changes.

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md` §"Worksheet routing + result entry" (method/instrument PATCH was flagged Phase 3.6 fodder in Phase 3 + 3.5 plans).
**Predecessors:** Phase 3 (AnalysisTable adapter), Phase 3.5 (worksheet inbox source switch).
**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (locked in; flag if you disagree before Task 1)

1. **All hplc_methods + all instruments shown as options on every Mk1 vial.** Today's SENAITE catalog has per-service method lists (`AnalysisService.methods` JSON column), but the UIDs there are SENAITE UIDs that don't correspond to Mk1's `hplc_methods.id` integer keys — there's no cross-table mapping. Going wider (all methods/instruments) keeps the work small. If bench techs end up with too many options to pick from cleanly, a per-service-group filter is a Phase 3.7 add-on.

2. **Option UIDs are int-as-string** (e.g. `"1"`, `"2"`). The FE dropdowns key by uid string. We use `str(hplc_methods.id)` so the Mk1 PATCH can parse back to int. SENAITE UIDs are 32-char hex; the namespaces don't collide for the SENAITE-vialUUID path.

3. **Method/instrument PATCH writes an audit row** with `transition_kind="auto"` and reason `method_id=X,instrument_id=Y` — same shape as `set_reportable`'s audit. Not a state-machine transition.

4. **Setting either field to None is allowed.** Bench techs may pick a method but leave instrument blank, or vice versa. The PATCH accepts nullable ints in both slots.

5. **Service-layer set_method_instrument is the one place that mutates these fields.** The existing `create_analysis` service still accepts method_id / instrument_id at create-time; that's unchanged.

6. **No new ORM relationship.** `lims_analyses.method_id` and `instrument_id` are already FKs at the DB layer per Phase 1's migration. We just bulk-load by id and never expose a `LimsAnalysis.method` relationship — keeps the model file lean.

If any decision is wrong, redirect before Task 1.

---

## File Structure

**Backend (modified):**
- `backend/lims_analyses/schemas.py` — add `SetMethodInstrumentRequest` Pydantic model.
- `backend/lims_analyses/service.py` — add `set_method_instrument(db, analysis_id, method_id, instrument_id, user_id) -> LimsAnalysis`. Extend `list_analyses_in_senaite_shape` to populate `method_options` + `instrument_options` from bulk-loaded `HplcMethod` + `Instrument` rows.
- `backend/lims_analyses/routes.py` — add `PATCH /{analysis_id}/method-instrument`.
- `backend/tests/test_lims_analyses_service.py` — 1 test for set_method_instrument + audit row.
- `backend/tests/test_lims_analyses_routes.py` — 2 tests (PATCH happy path + 404 on bad analysis id).

**Frontend (modified):**
- `src/lib/api.ts` — `setAnalysisMethodInstrument`: dispatch on `mk1:` prefix; parse method/instrument uid strings to ints; PATCH the Mk1 endpoint.

**Out of scope:**
- Per-service-group filtering of method options (Phase 3.7 if needed).
- Method/instrument FK relationships in the ORM model.
- Backend reverse-resolution of SENAITE-uid → hplc_methods.id (no mapping data).
- Frontend tests — the existing dropdowns continue to render the new options without per-component test changes.

---

## How to run tests

- Single file: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Full backend: same harness, `tests/`. Baseline at end of Phase 3.5: 440 passed, 27 skipped, 13 failed.
- FE typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`. Baseline: 2 pre-existing errors.

---

## Task 1: `SetMethodInstrumentRequest` Pydantic schema

**Files:**
- Modify: `backend/lims_analyses/schemas.py`

- [ ] **Step 1: Append the model**

After `SetReportableRequest` in `backend/lims_analyses/schemas.py`, add:

```python
class SetMethodInstrumentRequest(BaseModel):
    """Phase 3.6: bench-tech picks a method + instrument for a Mk1 analysis.

    Either field may be None — caller can clear a previously-set choice or
    set just one. Field types match the FK columns on lims_analyses
    (Integer references to hplc_methods.id / instruments.id).
    """
    method_id: Optional[int] = None
    instrument_id: Optional[int] = None
```

- [ ] **Step 2: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.schemas import SetMethodInstrumentRequest
print('imports ok; fields:', sorted(SetMethodInstrumentRequest.model_fields.keys()))
"
```

Expected: `imports ok; fields: ['instrument_id', 'method_id']`.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/schemas.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): SetMethodInstrumentRequest Pydantic model"
```

---

## Task 2: `set_method_instrument` service function

**Files:**
- Modify: `backend/lims_analyses/service.py`

- [ ] **Step 1: Append the service function**

After `set_reportable` in `backend/lims_analyses/service.py`, add (BEFORE the Phase 3 adapter section):

```python
def set_method_instrument(
    db: Session,
    *,
    analysis_id: int,
    method_id: Optional[int],
    instrument_id: Optional[int],
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Phase 3.6: update method_id + instrument_id on a lims_analyses row.

    Either may be None (clear). No-op + early-return if both match the
    current row state. Writes an 'auto' audit transition with a
    machine-parseable reason — same pattern as set_reportable.
    """
    row = get_analysis(db, analysis_id)

    # No-op short-circuit — avoid spurious audit rows
    if row.method_id == method_id and row.instrument_id == instrument_id:
        return row

    row.method_id = method_id
    row.instrument_id = instrument_id
    row.updated_at = datetime.utcnow()

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=row.review_state,
        to_state=row.review_state,
        transition_kind="auto",
        user_id=user_id,
        reason=f"method_id={method_id},instrument_id={instrument_id}",
    ))
    db.commit()
    db.refresh(row)
    return row
```

- [ ] **Step 2: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.service import set_method_instrument
print('imports ok; callable:', callable(set_method_instrument))
"
```

Expected: `imports ok; callable: True`.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): set_method_instrument service function"
```

---

## Task 3: Extend `list_analyses_in_senaite_shape` to populate option arrays

**Files:**
- Modify: `backend/lims_analyses/service.py` (the `list_analyses_in_senaite_shape` function)

- [ ] **Step 1: Bulk-load instruments + methods at the top of the function**

Find `list_analyses_in_senaite_shape` in `backend/lims_analyses/service.py`. After the existing per-row bulk loads of `services_by_id`, `methods_by_id`, `instruments_by_id` (which only fetch the FKs actually referenced), ALSO load the full catalog for option arrays:

Change the section that builds `methods_by_id` + `instruments_by_id` from "only-referenced" to "all":

Find these lines:

```python
    # Bulk-load chosen method/instrument display names (only for the FKs
    # actually referenced by these rows — typically empty for new vials)
    method_ids = {r.method_id for r in rows if r.method_id}
    methods_by_id = {}
    if method_ids:
        methods_by_id = {
            m.id: m
            for m in db.execute(
                select(HplcMethod).where(HplcMethod.id.in_(method_ids))
            ).scalars().all()
        }
    instrument_ids = {r.instrument_id for r in rows if r.instrument_id}
    instruments_by_id = {}
    if instrument_ids:
        instruments_by_id = {
            i.id: i
            for i in db.execute(
                select(Instrument).where(Instrument.id.in_(instrument_ids))
            ).scalars().all()
        }
```

Replace with:

```python
    # Phase 3.6: bulk-load ALL hplc_methods + instruments for the option
    # arrays the FE dropdowns render. Wider scope than the per-row chosen
    # FK lookup — but the catalog is small (~3-10 of each in practice), so
    # the full load is cheap.
    methods_by_id = {
        m.id: m
        for m in db.execute(select(HplcMethod)).scalars().all()
    }
    instruments_by_id = {
        i.id: i
        for i in db.execute(select(Instrument)).scalars().all()
    }

    # Pre-build option arrays — shared across all rows
    method_options = [
        SenaiteShapeMethodOption(uid=str(m.id), title=getattr(m, "name", None) or f"Method {m.id}")
        for m in sorted(methods_by_id.values(), key=lambda m: (m.id))
    ]
    instrument_options = [
        SenaiteShapeInstrumentOption(uid=str(i.id), title=getattr(i, "name", None) or f"Instrument {i.id}")
        for i in sorted(instruments_by_id.values(), key=lambda i: (i.id))
    ]
```

Also update the imports at the top of the function (or top of the file if cleaner) to include `SenaiteShapeMethodOption` + `SenaiteShapeInstrumentOption`:

```python
    from lims_analyses.schemas import (
        SenaiteShapeAnalysisResponse,
        SenaiteShapeInstrumentOption,
        SenaiteShapeMethodOption,
    )
```

- [ ] **Step 2: Plumb the options into each row's response**

Find the loop body where each row is appended. Change:

```python
            method_options=[],          # Phase 3.5: lift method editing
            ...
            instrument_options=[],      # Phase 3.5: lift instrument editing
```

to:

```python
            method_options=method_options,
            ...
            instrument_options=instrument_options,
```

- [ ] **Step 3: Restart backend + smoke**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio 2>&1 | tail -1
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import LimsSubSample
from lims_analyses.service import list_analyses_in_senaite_shape
db = SessionLocal()
sub = db.execute(select(LimsSubSample).where(LimsSubSample.sample_id == 'PB-0075-S01')).scalar_one_or_none()
if sub:
    rows = list_analyses_in_senaite_shape(db, host_kind='sub_sample', host_pk=sub.id)
    for r in rows:
        print(f'  uid={r.uid} kw={r.keyword} method_options={len(r.method_options)} instrument_options={len(r.instrument_options)}')
        if r.method_options[:1]:
            print(f'    method[0]: uid={r.method_options[0].uid} title={r.method_options[0].title!r}')
        if r.instrument_options[:1]:
            print(f'    instrument[0]: uid={r.instrument_options[0].uid} title={r.instrument_options[0].title!r}')
db.close()
"
```

Expected: `method_options` and `instrument_options` counts > 0; first method/instrument shows an int-as-string `uid` and a real `name`.

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): populate method_options + instrument_options in senaite_shape"
```

---

## Task 4: `PATCH /api/lims-analyses/{id}/method-instrument` route

**Files:**
- Modify: `backend/lims_analyses/routes.py`

- [ ] **Step 1: Add the route after `patch_reportable`**

Find `patch_reportable` in `backend/lims_analyses/routes.py`. After it, add:

```python
@router.patch("/{analysis_id}/method-instrument", response_model=AnalysisResponse)
def patch_method_instrument(
    analysis_id: int,
    req: SetMethodInstrumentRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.set_method_instrument(
            db,
            analysis_id=analysis_id,
            method_id=req.method_id,
            instrument_id=req.instrument_id,
            user_id=getattr(current_user, "id", None),
        )
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)
```

Add `SetMethodInstrumentRequest` to the imports at the top of the file:

```python
from lims_analyses.schemas import (
    AnalysisResponse,
    AnalysisWithTransitions,
    CreateAnalysisRequest,
    HostKind,
    SenaiteShapeAnalysisResponse,
    SetMethodInstrumentRequest,
    SetReportableRequest,
    TransitionInfo,
    TransitionRequest,
)
```

- [ ] **Step 2: Restart + verify OpenAPI**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio 2>&1 | tail -1
curl -sS http://localhost:5530/openapi.json | python -c "
import json, sys
spec = json.load(sys.stdin)
for p in sorted(spec['paths']):
    if 'lims-analyses' in p and 'method' in p:
        print(p, list(spec['paths'][p].keys()))
"
```

Expected: `/api/lims-analyses/{analysis_id}/method-instrument ['patch']`.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): PATCH /api/lims-analyses/{id}/method-instrument"
```

---

## Task 5: Backend tests

**Files:**
- Modify: `backend/tests/test_lims_analyses_service.py`
- Modify: `backend/tests/test_lims_analyses_routes.py`

- [ ] **Step 1: Service test**

Append to `backend/tests/test_lims_analyses_service.py`:

```python
def test_set_method_instrument_persists_and_writes_audit(db, sub_sample, analysis_service):
    from lims_analyses.service import set_method_instrument
    from models import HplcMethod, Instrument
    row = _create(db, sub_sample, analysis_service)
    method = db.execute(select(HplcMethod)).scalars().first()
    instrument = db.execute(select(Instrument)).scalars().first()
    if method is None or instrument is None:
        pytest.skip("no hplc_methods / instruments in this env")
    updated = set_method_instrument(
        db, analysis_id=row.id,
        method_id=method.id, instrument_id=instrument.id,
    )
    assert updated.method_id == method.id
    assert updated.instrument_id == instrument.id
    # Audit chain: initial 'auto' + the new 'auto' for method/instrument
    txns = db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == row.id)
        .order_by(LimsAnalysisTransition.occurred_at)
    ).scalars().all()
    assert len(txns) == 2
    assert txns[-1].transition_kind == "auto"
    assert f"method_id={method.id}" in (txns[-1].reason or "")
    assert f"instrument_id={instrument.id}" in (txns[-1].reason or "")


def test_set_method_instrument_is_noop_when_unchanged(db, sub_sample, analysis_service):
    from lims_analyses.service import set_method_instrument
    row = _create(db, sub_sample, analysis_service)
    # Both fields None on a fresh row — setting to None should be a no-op
    set_method_instrument(db, analysis_id=row.id, method_id=None, instrument_id=None)
    txns = db.execute(
        select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == row.id)
    ).scalars().all()
    # Just the initial 'auto' — no spurious second audit row
    assert len(txns) == 1
```

- [ ] **Step 2: Route tests**

Append to `backend/tests/test_lims_analyses_routes.py`:

```python
def test_patch_method_instrument_happy_path(sub_sample, analysis_service):
    from models import HplcMethod, Instrument
    db = SessionLocal()
    method = db.execute(select(HplcMethod)).scalars().first()
    instrument = db.execute(select(Instrument)).scalars().first()
    db.close()
    if method is None or instrument is None:
        pytest.skip("no hplc_methods / instruments in this env")
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    r = client.patch(
        f"/api/lims-analyses/{aid}/method-instrument",
        json={"method_id": method.id, "instrument_id": instrument.id},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["method_id"] == method.id
    assert body["instrument_id"] == instrument.id


def test_patch_method_instrument_404_on_missing_analysis():
    r = client.patch(
        "/api/lims-analyses/99999999/method-instrument",
        json={"method_id": None, "instrument_id": None},
    )
    assert r.status_code == 404
```

- [ ] **Step 3: Run tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_service.py tests/test_lims_analyses_routes.py -v -k 'method_instrument' 2>&1 | tail -10"
```

Expected: 4 new passed (2 service + 2 route).

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_lims_analyses_service.py backend/tests/test_lims_analyses_routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "test(mk1): set_method_instrument + PATCH endpoint coverage"
```

---

## Task 6: FE `setAnalysisMethodInstrument` dispatch shim

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the mk1: dispatch branch**

Find `setAnalysisMethodInstrument` in `src/lib/api.ts` (around line 3636). Wrap the body with a `mk1:` prefix check matching the pattern from `setAnalysisResult` / `transitionAnalysis`:

```typescript
export async function setAnalysisMethodInstrument(
  uid: string,
  methodUid: string | null,
  instrumentUid: string | null
): Promise<AnalysisResultResponse> {
  // Phase 3.6: route mk1:<id> UIDs to the Mk1 method-instrument PATCH
  // endpoint. The Mk1 option uids are int-as-string (e.g. "1", "2");
  // parse them back to integers for the request body. Either may be
  // null (clear). The SENAITE-uid code path below is unchanged.
  if (uid.startsWith('mk1:')) {
    const limsId = parseInt(uid.slice('mk1:'.length), 10)
    const body = {
      method_id: methodUid ? parseInt(methodUid, 10) : null,
      instrument_id: instrumentUid ? parseInt(instrumentUid, 10) : null,
    }
    const response = await fetch(
      `${API_BASE_URL()}/api/lims-analyses/${limsId}/method-instrument`,
      {
        method: 'PATCH',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify(body),
      }
    )
    if (!response.ok) {
      const err = await response.json().catch(() => null)
      throw new Error(err?.detail || `Set method/instrument (mk1) failed: ${response.status}`)
    }
    const row = await response.json()
    return {
      success: true,
      message: 'Method/instrument updated via Mk1',
      new_review_state: row.review_state ?? null,
      keyword: row.keyword ?? null,
    }
  }
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/analyses/${encodeURIComponent(uid)}/method-instrument`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ method_uid: methodUid, instrument_uid: instrumentUid }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Set method/instrument failed: ${response.status}`)
  }
  return response.json()
}
```

- [ ] **Step 2: Typecheck**

```bash
docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"
```

Expected: 2 pre-existing errors only, no new ones.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/lib/api.ts
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1-fe): mk1: dispatch in setAnalysisMethodInstrument"
```

---

## Task 7: Full suite + live acceptance smoke

Verification-only — no commit.

- [ ] **Step 1: Full backend suite**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/ -q --tb=no 2>&1 | tail -5"
```

Expected: 444 passed (was 440 at end of Phase 3.5), 13 baseline failures, zero new regressions.

- [ ] **Step 2: End-to-end HTTP smoke through the live uvicorn**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && cat > /tmp/_smoke_p36.py << 'PYEOF'
from sqlalchemy import select, delete
from database import SessionLocal
from main import app
from auth import get_current_user
from models import LimsSample, LimsSubSample, LimsAnalysis, LimsAnalysisTransition, HplcMethod, Instrument
from sub_samples.photo_storage import get_storage
from sub_samples import service as ss, senaite
from fastapi.testclient import TestClient

db = SessionLocal()
parent = db.execute(select(LimsSample).where(LimsSample.sample_id == 'BW-0013')).scalar_one()
method = db.execute(select(HplcMethod)).scalars().first()
instrument = db.execute(select(Instrument)).scalars().first()
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000004949454e44ae426082')
sub = ss.create_sub_sample(db, parent.sample_id, png, 'p36.png', 'P3.6', 1)
ss.set_assignment_role(db, sub.sample_id, 'endo')
db.refresh(sub)
analysis = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == sub.id)).scalars().first()
print(f'setup: {sub.sample_id}, analysis id={analysis.id}, method={method.id} instrument={instrument.id}')
db.close()

class _U:
    id = 1
app.dependency_overrides[get_current_user] = lambda: _U()
with TestClient(app) as c:
    # 1. Confirm senaite_shape response now has option arrays
    r_shape = c.get(f'/api/lims-analyses?host_kind=sub_sample&host_pk={sub.id}&as=senaite_shape')
    j = r_shape.json()[0]
    print(f'senaite_shape methods={len(j[\"method_options\"])} instruments={len(j[\"instrument_options\"])}')

    # 2. PATCH method+instrument via Mk1 endpoint
    r_patch = c.patch(
        f'/api/lims-analyses/{analysis.id}/method-instrument',
        json={'method_id': method.id, 'instrument_id': instrument.id},
    )
    print(f'PATCH → {r_patch.status_code} method_id={r_patch.json().get(\"method_id\")} instrument_id={r_patch.json().get(\"instrument_id\")}')

    # 3. Re-fetch the senaite_shape — chosen method/instrument should reflect
    r_shape2 = c.get(f'/api/lims-analyses?host_kind=sub_sample&host_pk={sub.id}&as=senaite_shape')
    j2 = r_shape2.json()[0]
    print(f'after PATCH: method_uid={j2[\"method_uid\"]!r} method={j2[\"method\"]!r} instrument_uid={j2[\"instrument_uid\"]!r} instrument={j2[\"instrument\"]!r}')

# Cleanup
db = SessionLocal()
get_storage().delete_photo(sub.photo_external_uid[len('mk1://'):])
aids = db.execute(select(LimsAnalysis.id).where(LimsAnalysis.lims_sub_sample_pk == sub.id)).scalars().all()
if aids:
    db.execute(delete(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id.in_(aids)))
    db.execute(delete(LimsAnalysis).where(LimsAnalysis.id.in_(aids)))
db.execute(delete(LimsSubSample).where(LimsSubSample.id == sub.id))
db.commit()
try:
    senaite.delete_secondary(sub.external_lims_uid)
except Exception:
    pass
db.close()
print('CLEAN')
PYEOF
python /tmp/_smoke_p36.py && rm /tmp/_smoke_p36.py"
```

Expected:
- `senaite_shape methods=N instruments=M` (both > 0)
- `PATCH → 200 method_id=X instrument_id=Y`
- `after PATCH: method_uid='X' method='Method 1' instrument_uid='Y' instrument='HPLC 1260a'` (with real names)
- `CLEAN`

- [ ] **Step 3: Live UI verification**

```
1. http://localhost:5532
2. sessionStorage.setItem('accu_mk1_api_url_override', 'http://localhost:5530'); location.reload()
3. Log in as forrest@valenceanalytical.com / test123
4. Navigate to http://localhost:5532/#senaite/sample-details?id=PB-0075-S01
5. On the AnalysisTable, the method + instrument dropdowns now show options.
6. Pick a method + instrument. Network tab fires PATCH /api/lims-analyses/146/method-instrument with the int ids.
7. Refresh — the chosen method/instrument persists.
```

---

## Verification (Phase 3.6 acceptance)

- [ ] **`SetMethodInstrumentRequest` schema imports + validates** (Task 1)
- [ ] **`set_method_instrument` service writes the row + audit + is no-op when unchanged** (Task 5 service tests)
- [ ] **`PATCH /api/lims-analyses/{id}/method-instrument` returns 200 with updated row, 404 on missing id** (Task 5 route tests)
- [ ] **`senaite_shape` GET response now carries non-empty method_options + instrument_options** (Task 3 Step 3 + Task 7 Step 2)
- [ ] **FE `setAnalysisMethodInstrument` dispatches on mk1: prefix** (Task 6 typecheck + Task 7 UI step)
- [ ] **Method/instrument selection on a Mk1 vial persists round-trip** (Task 7 Step 2 line 3)
- [ ] **Full backend suite: 444 passed, 13 baseline failures, zero regressions** (Task 7 Step 1)
- [ ] **FE typecheck: 2 pre-existing errors only** (Task 6 Step 2)

---

## Risks and unknowns

- **All-methods option list may be too wide for some bench techs** if the lab adds many methods. Phase 3.7 can add per-service-group filtering — needs a junction table (or a JSON column on `hplc_methods`) linking methods → service_groups. Out of scope here.

- **The catalog's `analysis_services.methods` JSON column is now unused for Mk1 vials.** That's the intentional trade-off — its UIDs are SENAITE-side and don't map to `hplc_methods.id`. The catalog continues to drive SENAITE-vial method options (parent samples) unchanged.

- **No SENAITE → Mk1 method reconciliation.** If a method is added in SENAITE but not in Mk1's `hplc_methods` table, it won't appear on Mk1 vials. The `hplc_methods` table is the source of truth for Mk1; cross-system sync is out of scope.

- **`method_uid` / `instrument_uid` in the senaite_shape response carry int-as-string values** (e.g. `"1"`). The FE existing dropdown logic keys by uid string; it won't care that the values aren't 32-char hex. If any FE code does a regex match on uid format (e.g. assumes hex), that'd break — but the existing pattern just compares uids verbatim.

- **The audit row reason format `method_id=X,instrument_id=Y`** is greppable for downstream reporting. If we later want a structured audit (JSON column?), that's a separate refactor.

## Open questions (carried forward)

1. **Per-service-group method filtering** — Phase 3.7 candidate. Defer until first complaint.
2. **Retest mechanism on Mk1 vials** — out of scope; deferred.

## Out of scope (carried forward)

- `promote_to_parent` service + verification UI — Phase 4.
- COA resolver default-path simplification — Phase 5.
- Family-state derivation + WP signaling — Phase 5.
- Drop the SENAITE secondary AR entirely — Phase 5 cleanup.
- Prelim-COA opt-in customer flow — Phase 6.
