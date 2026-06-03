# Mk1-Native Analyses Phase 3 — AnalysisTable Adapter (Read + Write)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the AnalysisTable's read + write paths over to Mk1 `lims_analyses` for sub-samples while leaving parent samples on the SENAITE proxy. Sub-sample bench techs now write results + state transitions to Mk1 rows (not SENAITE). UI looks identical. Parent samples are unchanged.

**Architecture:** Extend the existing `GET /api/lims-analyses` endpoint with an `?as=senaite_shape` flavor that returns rows in the existing `SenaiteAnalysis` TS-type shape (denormalized method/instrument/result options from the analysis_services catalog so the FE adapter stays thin). UIDs in this shape carry a `mk1:` prefix so the FE's existing result/transition lib functions can dispatch by prefix to Mk1 endpoints instead of the SENAITE proxy. `SampleDetails.tsx` picks the data source for the `.analyses` array via the existing sub-sample regex (`/-S\d{2,}$/`), then passes the rows down to `AnalysisTable.tsx` unchanged. Result-entry + transition lib functions in `src/lib/api.ts` get a thin dispatch shim: if the UID starts with `mk1:`, route to `/api/lims-analyses/{id}/transitions` (or the result endpoint to-be-added); otherwise, the existing SENAITE-proxy paths.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (backend), React + TypeScript + Vite + Vitest (frontend). No schema changes.

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md` §"Worksheet routing + result entry"
**Predecessors:** Phase 1 (lims_analyses schema + endpoints), Phase 2 (Receive Wizard + seeding), Phase 2.5 (photo storage).
**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (locked in; flag if you disagree before Task 1)

1. **Phase 3 = AnalysisTable read + write only. Worksheet inbox + `worksheet_items.lims_analysis_id` deferred to Phase 3.5.** Splitting matches the 2/2.5 pattern and lands the bench-tech wins (writing to Mk1) sooner. The SPEC's Phase 3 acceptance line "Worksheet drag-drop adds the vial's analyses via lims_analysis_id" lands in Phase 3.5.

2. **UID prefix scheme: `mk1:{id}`.** The Mk1 endpoint's `?as=senaite_shape` flavor returns UIDs like `mk1:144` (digit-id prefixed). FE lib functions detect the prefix and dispatch. Bench techs see the table unchanged because UIDs are opaque to them — they only see titles + result fields. Parent samples remain pure SENAITE-UID (32-char hex) and route to the proxy.

3. **Extend GET endpoint, don't add a new one.** Add `as=senaite_shape` query param to `GET /api/lims-analyses`. Default behavior unchanged (returns `AnalysisResponse[]` from Phase 1). When `as=senaite_shape`, returns `SenaiteAnalysis[]`-equivalent with denormalized catalog options. Single endpoint, two flavors — minimal surface increase.

4. **Method/instrument/result options come from the analysis_services catalog.** Phase 1's `lims_analyses` only stores `result_value`, `result_unit`, `method_id`, `instrument_id` (the chosen values). The OPTION arrays (`method_options`, `instrument_options`, `result_options`) for dropdowns get hydrated server-side from `analysis_services` + its `methods` JSON column + the `instruments` table. Phase 3 ships this denormalization in the new endpoint variant.

5. **Result entry is a transition kind, not a separate endpoint.** Phase 1's `POST /api/lims-analyses/{id}/transitions` already accepts `{kind: "submit", result_value: "98.55", reason: ...}`. The FE adapter sends a `submit` kind with the result inline. No new endpoint needed for result-entry. (A `set_result_only` flow without state transition would be possible but isn't needed yet — bench-tech result-entry naturally advances state from `assigned` → `to_be_verified`.)

6. **No frontend behavior changes for parent samples.** Anything not matching `/-S\d{2,}$/` routes via the existing SENAITE path. Zero risk to the parent-sample bench flow.

If any decision is wrong, redirect before Task 1.

---

## File Structure

**Backend (modified):**
- `backend/lims_analyses/schemas.py` — add `SenaiteShapeAnalysisResponse` Pydantic model mirroring the FE's `SenaiteAnalysis` interface.
- `backend/lims_analyses/service.py` — add `list_analyses_in_senaite_shape(db, host_kind, host_pk)` that hydrates option arrays from the catalog.
- `backend/lims_analyses/routes.py` — extend the existing `GET /` route with `?as=senaite_shape` flavor.
- `backend/tests/test_lims_analyses_routes.py` — add a test for the new flavor.
- `backend/tests/test_lims_analyses_service.py` — add a test for `list_analyses_in_senaite_shape`.

**Frontend (modified):**
- `src/lib/api.ts` (verify the path; per Explore the type is at `src/lib/api.ts` so on the host that's `src/lib/api.ts`) — add `listLimsAnalysesForSubSample(subSamplePk: number): Promise<SenaiteAnalysis[]>`. Update `setAnalysisResult(uid, result)` and `transitionAnalysis(uid, action)` (the actual function names per the Explore) to detect `mk1:` prefix and dispatch to Mk1 endpoints.
- `src/components/senaite/SampleDetails.tsx` — when `parentSampleId` is set (sub-sample regex match), fetch `.analyses` from Mk1 instead of the SENAITE lookup. Other fields of `data` continue to come from SENAITE.
- `src/components/senaite/__tests__/AnalysisTable.test.tsx` — if absent, create a minimal vitest test that verifies the table renders Mk1-shaped rows. (Optional; only if Vitest is wired for this component path.)

**Out of scope for this plan:**
- `worksheet_items.lims_analysis_id` column — Phase 3.5.
- Worksheet inbox query rewrite to source vial analyses from Mk1 — Phase 3.5.
- Drag-drop wiring that creates worksheet_items pointing at Mk1 IDs — Phase 3.5.
- `promote_to_parent` service + verification UI — Phase 4.
- Method/instrument PATCH endpoints — separate transition kind ("update_provenance"?); deferred until first concrete need.

---

## How to run tests

- Backend single file: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Backend full: same harness, `tests/`. Baseline: 13 failures, 436 passed at end of Phase 2.5.
- Frontend tests: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npm run test -- --run <filename>"` (if vitest is the runner).
- Frontend typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`. Baseline at end of Phase 2.5: 2 pre-existing TS errors.

---

## Task 1: Probe the existing FE → backend hook + lib function shape

Verification-only — no commit. Confirms the function/file refs the rest of the plan assumes.

- [ ] **Step 1: Locate the FE lib functions**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-frontend bash -c "grep -nE 'export (async )?function (setAnalysisResult|lookupSenaiteSample|listAnalysesForSubSample|executeTransition)' /app/src/lib/api.ts | head -10"
```

Expected: shows the actual function names + line numbers. Capture them for Task 4. If `setAnalysisResult` / `executeTransition` are named something else, substitute in all later steps.

- [ ] **Step 2: Locate SampleDetails dispatch site**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-frontend bash -c "grep -n 'lookupSenaiteSample\|setAnalysisResult\|parentSampleId\|/-S' /app/src/components/senaite/SampleDetails.tsx | head -20"
```

Expected: line numbers for the analyses-fetch call (~1988-2002 per Explore), the sub-sample regex (~1774-1778), and any result-set / transition callbacks.

- [ ] **Step 3: Confirm the existing Mk1 lims-analyses route shape**

```bash
curl -sS "http://localhost:5530/openapi.json" 2>&1 | python -c "
import json, sys
spec = json.load(sys.stdin)
for p in sorted(spec['paths']):
    if 'lims-analyses' in p:
        for method, op in spec['paths'][p].items():
            print(f'  {method.upper():6s} {p}  params={[pp[\"name\"] for pp in op.get(\"parameters\", [])]}')"
```

Expected: lists 5 endpoints from Phase 1; the `GET /api/lims-analyses` lists `host_kind`, `host_pk`, `include_retests`. Phase 3 adds `as`.

---

## Task 2: Backend — `SenaiteShapeAnalysisResponse` schema

**Files:**
- Modify: `backend/lims_analyses/schemas.py`

- [ ] **Step 1: Append the new response model**

After `AnalysisWithTransitions` in `backend/lims_analyses/schemas.py`, add:

```python
# ─── SenaiteAnalysis-compatible response (Phase 3 adapter) ───────────────────


class SenaiteShapeMethodOption(BaseModel):
    """One method option in the dropdown. Matches SENAITE proxy shape."""
    uid: str
    title: str


class SenaiteShapeInstrumentOption(BaseModel):
    """One instrument option in the dropdown. Matches SENAITE proxy shape."""
    uid: str
    title: str


class SenaiteShapeResultOption(BaseModel):
    """One result option for selection-type analyses. Matches SENAITE shape."""
    value: str
    label: str


class SenaiteShapeAnalysisResponse(BaseModel):
    """lims_analyses row reshaped to match the FE's `SenaiteAnalysis` TS type.

    The FE (`src/lib/api.ts`) treats `uid` as opaque. We prefix Mk1 ids with
    `mk1:` so the FE's setAnalysisResult / transition dispatch functions can
    detect them and route to the Mk1 endpoints. SENAITE UIDs are 32-char hex
    and never carry the prefix, so the two address spaces don't collide.
    """
    uid: str                              # "mk1:144"
    keyword: Optional[str]
    title: str
    result: Optional[str]                 # the chosen result_value
    result_options: List[SenaiteShapeResultOption] = Field(default_factory=list)
    unit: Optional[str]
    method: Optional[str]
    method_uid: Optional[str]
    method_options: List[SenaiteShapeMethodOption] = Field(default_factory=list)
    instrument: Optional[str]
    instrument_uid: Optional[str]
    instrument_options: List[SenaiteShapeInstrumentOption] = Field(default_factory=list)
    analyst: Optional[str]
    due_date: Optional[str] = None        # not tracked in lims_analyses yet
    review_state: Optional[str]
    sort_key: Optional[int] = None        # FE uses for stable sort; we send keyword hash
    captured: Optional[str]               # ISO string of captured_at
    retested: bool
    service_group_id: Optional[int] = None
    service_group_name: Optional[str] = None
```

- [ ] **Step 2: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.schemas import (
    SenaiteShapeAnalysisResponse, SenaiteShapeMethodOption,
    SenaiteShapeInstrumentOption, SenaiteShapeResultOption,
)
print('imports ok')
print('fields:', sorted(SenaiteShapeAnalysisResponse.model_fields.keys()))
"
```

Expected: `imports ok` plus a sorted list of ~17 field names matching the FE `SenaiteAnalysis` interface.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/schemas.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): SenaiteShapeAnalysisResponse Pydantic model for Phase 3 adapter"
```

---

## Task 3: Backend — `list_analyses_in_senaite_shape` service function

**Files:**
- Modify: `backend/lims_analyses/service.py`

- [ ] **Step 1: Inspect the analysis_services catalog shape**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import AnalysisService
db = SessionLocal()
svc = db.execute(select(AnalysisService).where(AnalysisService.keyword == 'HPLC-PUR')).scalar_one_or_none()
if svc:
    print(f'keyword={svc.keyword} title={svc.title} unit={svc.unit}')
    print(f'methods={svc.methods!r}')
db.close()
"
```

Expected: shows `methods` is a JSON column (likely a list of `{uid, title}` dicts) or None. Confirms the option-shape source.

- [ ] **Step 2: Inspect the instruments table**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import Instrument
db = SessionLocal()
rows = db.execute(select(Instrument).limit(5)).scalars().all()
print(f'{len(rows)} instruments; columns:')
for r in rows[:3]:
    print(f'  id={r.id} name={getattr(r, \"name\", None)!r} senaite_uid={getattr(r, \"senaite_uid\", None)!r}')
db.close()
"
```

Expected: shows the instrument shape. We need a `uid`-like field + a display name. If columns differ, adapt the code in Step 3 to match.

- [ ] **Step 3: Add the service function**

Append to `backend/lims_analyses/service.py` (after `set_reportable`):

```python
# ─── Phase 3 adapter: SenaiteAnalysis-shape projection ──────────────────────


from typing import Dict, Tuple

from models import AnalysisService, Instrument, HplcMethod
from lims_analyses.schemas import (
    SenaiteShapeAnalysisResponse,
    SenaiteShapeInstrumentOption,
    SenaiteShapeMethodOption,
)


def list_analyses_in_senaite_shape(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    include_retests: bool = False,
) -> List[SenaiteShapeAnalysisResponse]:
    """List analyses for a host, projected to the FE's SenaiteAnalysis shape.

    Hydrates method_options + instrument_options from the catalog so the
    FE's dropdowns work without a second round-trip. Result options are
    not yet supported (lims_analyses has no select-type analyses). UID
    carries the `mk1:` prefix so the FE can dispatch transitions to the
    Mk1 endpoints.
    """
    rows = list_analyses_for_host(
        db, host_kind=host_kind, host_pk=host_pk,
        include_retests=include_retests,
    )
    if not rows:
        return []

    # Bulk-load the analysis_services for all referenced rows so we don't
    # do N queries.
    service_ids = {r.analysis_service_id for r in rows}
    services_by_id: Dict[int, AnalysisService] = {
        s.id: s
        for s in db.execute(
            select(AnalysisService).where(AnalysisService.id.in_(service_ids))
        ).scalars().all()
    }

    # Bulk-load instruments for option dropdowns. There's no per-service
    # filter today (all techs see all instruments); refine later if needed.
    instruments = list(db.execute(select(Instrument)).scalars().all())
    instrument_options = [
        SenaiteShapeInstrumentOption(
            uid=str(i.id), title=getattr(i, "name", None) or f"Instrument {i.id}",
        )
        for i in instruments
    ]
    instruments_by_id = {i.id: i for i in instruments}

    # HPLC methods table (per-service filtering not modeled at the FK level
    # — the service's `methods` JSON column lists the allowed UIDs).
    methods = list(db.execute(select(HplcMethod)).scalars().all())
    methods_by_id = {m.id: m for m in methods}

    out: List[SenaiteShapeAnalysisResponse] = []
    for r in rows:
        svc = services_by_id.get(r.analysis_service_id)
        # Per-service method options come from svc.methods (JSON list of
        # {uid, title} per the catalog convention).
        method_opts: List[SenaiteShapeMethodOption] = []
        if svc and isinstance(svc.methods, list):
            for entry in svc.methods:
                if isinstance(entry, dict) and entry.get("uid") and entry.get("title"):
                    method_opts.append(
                        SenaiteShapeMethodOption(uid=str(entry["uid"]), title=str(entry["title"]))
                    )

        # Method/instrument display name from the chosen FK
        method_name = None
        if r.method_id and r.method_id in methods_by_id:
            method_name = getattr(methods_by_id[r.method_id], "name", None)
        instrument_name = None
        if r.instrument_id and r.instrument_id in instruments_by_id:
            instrument_name = getattr(instruments_by_id[r.instrument_id], "name", None)

        out.append(SenaiteShapeAnalysisResponse(
            uid=f"mk1:{r.id}",
            keyword=r.keyword,
            title=r.title,
            result=r.result_value,
            result_options=[],  # lims_analyses has no select-type today
            unit=r.result_unit or (svc.unit if svc else None),
            method=method_name,
            method_uid=str(r.method_id) if r.method_id else None,
            method_options=method_opts,
            instrument=instrument_name,
            instrument_uid=str(r.instrument_id) if r.instrument_id else None,
            instrument_options=instrument_options,
            analyst=None,  # display name TODO (Phase 5 — join users)
            review_state=r.review_state,
            sort_key=None,
            captured=r.captured_at.isoformat() if r.captured_at else None,
            retested=r.retested,
            service_group_id=None,  # Phase 3.5 — join service_groups
            service_group_name=None,
        ))
    return out
```

- [ ] **Step 4: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.service import list_analyses_in_senaite_shape
print('imports ok; callable:', callable(list_analyses_in_senaite_shape))
"
```

Expected: `imports ok; callable: True`. If the `from models import` line errors on `Instrument` or `HplcMethod`, those classes may be named differently — open `backend/models.py` and search for the actual class names, then fix the import.

- [ ] **Step 5: Smoke-call against a real vial**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import LimsSubSample
from lims_analyses.service import list_analyses_in_senaite_shape
db = SessionLocal()
sub = db.execute(select(LimsSubSample).where(LimsSubSample.sample_id == 'PB-0075-S01')).scalar_one_or_none()
if sub:
    rows = list_analyses_in_senaite_shape(db, host_kind='sub_sample', host_pk=sub.id)
    print(f'{len(rows)} analyses for {sub.sample_id}:')
    for r in rows:
        print(f'  uid={r.uid} keyword={r.keyword} title={r.title} state={r.review_state} method_options={len(r.method_options)} instrument_options={len(r.instrument_options)}')
else:
    print('no PB-0075-S01 in DB')
db.close()
"
```

Expected: at least 1 row with `uid='mk1:144'` (or similar Mk1 id) and `keyword='ENDO-LAL'` per the Phase 2.5 smoke. `instrument_options` count > 0 (proves the bulk load works).

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): list_analyses_in_senaite_shape — adapter projection for FE"
```

---

## Task 4: Backend — wire `?as=senaite_shape` into the GET route

**Files:**
- Modify: `backend/lims_analyses/routes.py:list_for_host` (around line 97 — find via grep)

- [ ] **Step 1: Read the current GET handler**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "grep -nA 20 '@router.get..,' /app/lims_analyses/routes.py | head -30"
```

Note the exact signature of `list_for_host` (or whatever the list endpoint function is called).

- [ ] **Step 2: Add the `as` query parameter + dispatch**

In `backend/lims_analyses/routes.py`, find the existing `list_for_host` route and modify:

```python
from typing import List, Literal, Union

# Add to imports section near the top
from lims_analyses.schemas import (
    AnalysisResponse,
    AnalysisWithTransitions,
    CreateAnalysisRequest,
    HostKind,
    SenaiteShapeAnalysisResponse,
    SetReportableRequest,
    TransitionInfo,
    TransitionRequest,
)

# Modify the existing GET handler:
@router.get("", response_model=Union[List[AnalysisResponse], List[SenaiteShapeAnalysisResponse]])
def list_for_host(
    host_kind: HostKind = Query(...),
    host_pk: int = Query(...),
    include_retests: bool = Query(True),
    as_: Literal["default", "senaite_shape"] = Query("default", alias="as"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        if as_ == "senaite_shape":
            return service.list_analyses_in_senaite_shape(
                db, host_kind=host_kind, host_pk=host_pk,
                include_retests=include_retests,
            )
        rows = service.list_analyses_for_host(
            db, host_kind=host_kind, host_pk=host_pk,
            include_retests=include_retests,
        )
        return [AnalysisResponse.model_validate(r) for r in rows]
    except Exception as e:
        raise _handle_service_error(e)
```

- [ ] **Step 3: Restart backend and verify OpenAPI shows the new param**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
curl -sS "http://localhost:5530/openapi.json" | python -c "
import json, sys
spec = json.load(sys.stdin)
op = spec['paths']['/api/lims-analyses'].get('get', {})
params = [(p['name'], p.get('schema', {}).get('default', '<none>')) for p in op.get('parameters', [])]
print('GET /api/lims-analyses params:', params)
"
```

Expected: `[('host_kind', '<none>'), ('host_pk', '<none>'), ('include_retests', True), ('as', 'default')]`.

- [ ] **Step 4: HTTP smoke against the new flavor**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && cat > /tmp/_smoke_p3_route.py << 'PYEOF'
from sqlalchemy import select
from database import SessionLocal
from main import app
from auth import get_current_user
from models import LimsSubSample
from fastapi.testclient import TestClient

db = SessionLocal()
sub = db.execute(select(LimsSubSample).where(LimsSubSample.sample_id == 'PB-0075-S01')).scalar_one_or_none()
if sub is None:
    print('no PB-0075-S01 in DB; pick another vial with seeded lims_analyses')
    import sys; sys.exit(1)
db.close()

class _U: id = 1
app.dependency_overrides[get_current_user] = lambda: _U()
with TestClient(app) as c:
    r_def = c.get(f'/api/lims-analyses?host_kind=sub_sample&host_pk={sub.id}')
    r_sen = c.get(f'/api/lims-analyses?host_kind=sub_sample&host_pk={sub.id}&as=senaite_shape')
print(f'default → {r_def.status_code}, keys={set(r_def.json()[0].keys()) if r_def.json() else None}')
print(f'senaite_shape → {r_sen.status_code}, keys={set(r_sen.json()[0].keys()) if r_sen.json() else None}')
if r_sen.status_code == 200 and r_sen.json():
    first = r_sen.json()[0]
    print(f'  uid={first[\"uid\"]} keyword={first[\"keyword\"]} method_options_count={len(first[\"method_options\"])}')
    assert first['uid'].startswith('mk1:'), 'expected mk1: prefix on UID'
    print('OK: shape OK and UID carries mk1: prefix')
PYEOF
python /tmp/_smoke_p3_route.py && rm /tmp/_smoke_p3_route.py"
```

Expected:
- `default → 200, keys` includes `id, keyword, review_state` etc. (Phase 1 shape).
- `senaite_shape → 200, keys` includes `uid, method_options, instrument_options` etc. (FE shape).
- `uid=mk1:144` (or similar), `OK: shape OK ...`.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): GET /api/lims-analyses?as=senaite_shape — FE adapter flavor"
```

---

## Task 5: Backend — Mk1 transition endpoint accepts SENAITE-vocab transition names

Phase 1's `POST /api/lims-analyses/{id}/transitions` accepts `{kind, result_value, reason}` with `kind ∈ {assign, submit, verify, retract, reject, retest, publish, reset, auto}`. SENAITE-vocab transitions the FE sends are the same words (`submit`, `verify`, etc.) so the kinds line up 1:1. No code change needed — but verify with a focused HTTP test.

- [ ] **Step 1: Confirm FE-vocab transition names match Phase 1's kinds**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-frontend bash -c "grep -rhoE 'transition[\\s:=]+[\"\\\']?[a-z_]+[\"\\\']?' /app/src/components/senaite/AnalysisTable.tsx /app/src/lib/api.ts 2>/dev/null | sort -u | head -10"
```

Expected: lists transition strings like `'submit', 'verify', 'retract', 'reject'`. All should be in `_TIER_ALLOWED_KINDS[TIER_VIAL]` from Phase 1's state machine (`assign, submit, retract, reject, reset, verify, auto`). If FE uses transitions outside that set, flag here.

- [ ] **Step 2: HTTP smoke — POST a submit + verify against a Mk1 vial**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && cat > /tmp/_smoke_p3_tx.py << 'PYEOF'
from sqlalchemy import select, delete
from database import SessionLocal
from main import app
from auth import get_current_user
from models import LimsSubSample, LimsAnalysis, LimsAnalysisTransition
from sub_samples.photo_storage import get_storage
from sub_samples import service as ss, senaite
from fastapi.testclient import TestClient

# Create a fresh smoke vial (need a clean state) then walk a transition
db = SessionLocal()
parent_sid = 'BW-0013'
from models import LimsSample
parent = db.execute(select(LimsSample).where(LimsSample.sample_id == parent_sid)).scalar_one()
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000004949454e44ae426082')
sub = ss.create_sub_sample(db, parent_sid, png, 'tx_smoke.png', 'P3 TX', 1)
ss.set_assignment_role(db, sub.sample_id, 'endo')
db.refresh(sub)
analyses = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == sub.id)).scalars().all()
print(f'seeded {len(analyses)} analyses on {sub.sample_id}')
target = analyses[0]
print(f'target analysis id={target.id} keyword={target.keyword} state={target.review_state}')
db.close()

class _U: id = 1
app.dependency_overrides[get_current_user] = lambda: _U()
with TestClient(app) as c:
    # 1. assign
    r1 = c.post(f'/api/lims-analyses/{target.id}/transitions', json={'kind': 'assign', 'reason': 'P3 smoke'})
    print(f'assign → {r1.status_code} state={r1.json().get(\"review_state\") if r1.status_code == 200 else r1.json()}')
    # 2. submit with result_value
    r2 = c.post(f'/api/lims-analyses/{target.id}/transitions', json={'kind': 'submit', 'result_value': '0.42', 'reason': 'P3 smoke'})
    print(f'submit → {r2.status_code} state={r2.json().get(\"review_state\") if r2.status_code == 200 else r2.json()}')
    # 3. verify
    r3 = c.post(f'/api/lims-analyses/{target.id}/transitions', json={'kind': 'verify', 'reason': 'P3 smoke'})
    print(f'verify → {r3.status_code} state={r3.json().get(\"review_state\") if r3.status_code == 200 else r3.json()}')

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
python /tmp/_smoke_p3_tx.py && rm /tmp/_smoke_p3_tx.py"
```

Expected: `assign → 200 state=assigned`, `submit → 200 state=to_be_verified`, `verify → 200 state=verified`. `CLEAN`.

No commit (verification-only). If any of the kinds 400/409, the FE vocab doesn't match Phase 1's matrix — flag before continuing.

---

## Task 6: Frontend — `listLimsAnalysesForSubSample` lib function

**Files:**
- Modify: `src/lib/api.ts` (per Explore, FE root is `src/` and host path is `src/` under the worktree; verify in Task 1 Step 1)

- [ ] **Step 1: Find the existing lookupSenaiteSample function for reference**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-frontend bash -c "grep -nA 10 'export async function lookupSenaiteSample' /app/src/lib/api.ts | head -15"
```

Note its signature + how it calls `apiFetch` or similar. The new function mirrors that pattern.

- [ ] **Step 2: Add the new lib function**

Append to `src/lib/api.ts` (or wherever sub-samples lib functions live; per Explore `listSubSamples` exists somewhere in the same file or nearby):

```typescript
/**
 * Phase 3: fetch lims_analyses rows for a sub-sample, projected to the
 * SenaiteAnalysis shape so the existing AnalysisTable renders them
 * unchanged. UIDs carry a `mk1:` prefix so setAnalysisResult /
 * transitionAnalysis can dispatch to the Mk1 endpoints.
 */
export async function listLimsAnalysesForSubSample(
  subSamplePk: number,
): Promise<SenaiteAnalysis[]> {
  const url = new URL(
    `${API_BASE_URL}/api/lims-analyses`,
  )
  url.searchParams.set("host_kind", "sub_sample")
  url.searchParams.set("host_pk", String(subSamplePk))
  url.searchParams.set("as", "senaite_shape")
  url.searchParams.set("include_retests", "false")
  const resp = await apiFetch(url.toString())
  if (!resp.ok) {
    throw new Error(
      `listLimsAnalysesForSubSample: ${resp.status} ${resp.statusText}`,
    )
  }
  return (await resp.json()) as SenaiteAnalysis[]
}
```

(The exact name of the fetch helper (`apiFetch`, `fetchWithAuth`, etc.) and the `API_BASE_URL` constant depend on the existing module's idiom. Read 5 lines above the function you grepped in Step 1 to match.)

- [ ] **Step 3: Add a dispatch shim to setAnalysisResult**

Find `setAnalysisResult` in the same file. Wrap with a `mk1:` dispatch:

```typescript
export async function setAnalysisResult(uid: string, result: string): Promise<AnalysisResultResponse> {
  if (uid.startsWith("mk1:")) {
    const limsId = parseInt(uid.slice("mk1:".length), 10)
    const resp = await apiFetch(
      `${API_BASE_URL}/api/lims-analyses/${limsId}/transitions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "submit", result_value: result, reason: "bench-tech result entry" }),
      },
    )
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ detail: resp.statusText }))
      throw new Error(`setAnalysisResult(mk1): ${resp.status} ${JSON.stringify(body)}`)
    }
    const row = await resp.json()
    return {
      success: true,
      message: "Result submitted via Mk1",
      new_review_state: row.review_state,
      keyword: row.keyword,
    }
  }
  // …existing SENAITE-proxy body unchanged…
}
```

The existing function body before this dispatch should be preserved. If the body is long, factor the SENAITE path into a private `_setAnalysisResultSenaite` and call it from the else branch. Keep the exported signature stable.

- [ ] **Step 4: Add a dispatch shim to the transition function**

Find the transition function (per Explore "transition.executeTransition" — likely `executeTransition(uid, action)` or similar). Wrap with:

```typescript
export async function executeTransition(uid: string, action: string): Promise<AnalysisResultResponse> {
  if (uid.startsWith("mk1:")) {
    const limsId = parseInt(uid.slice("mk1:".length), 10)
    const resp = await apiFetch(
      `${API_BASE_URL}/api/lims-analyses/${limsId}/transitions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: action, reason: `bench-tech ${action}` }),
      },
    )
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ detail: resp.statusText }))
      throw new Error(`executeTransition(mk1): ${resp.status} ${JSON.stringify(body)}`)
    }
    const row = await resp.json()
    return {
      success: true,
      message: `Transition '${action}' applied via Mk1`,
      new_review_state: row.review_state,
      keyword: row.keyword,
    }
  }
  // …existing SENAITE-proxy body unchanged…
}
```

(Same pattern as Step 3 — preserve the SENAITE body, dispatch by UID prefix.)

- [ ] **Step 5: Typecheck**

```bash
docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -15"
```

Expected: 2 pre-existing errors (per Phase 2.5 baseline), no NEW errors.

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/lib/api.ts
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1-fe): listLimsAnalysesForSubSample + mk1: dispatch in setAnalysisResult/executeTransition"
```

---

## Task 7: Frontend — SampleDetails dispatches by sub-sample regex

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (around line 1988-2002 + line 1774-1778 per Explore — verify in Task 1 Step 2)

- [ ] **Step 1: Locate the analyses-fetch site**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-frontend bash -c "grep -nB 2 -A 6 'lookupSenaiteSample' /app/src/components/senaite/SampleDetails.tsx | head -30"
```

Find the call that populates `data.analyses`. Note the surrounding state shape — likely an `useEffect` + `useState`.

- [ ] **Step 2: Find the sub-sample sub_pk lookup**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-frontend bash -c "grep -nB 1 -A 3 'parentSampleId\|listSubSamples\|sub_sample.*pk' /app/src/components/senaite/SampleDetails.tsx | head -20"
```

The component already fetches the parent's sub-samples via `listSubSamples(parentSampleId)`. The current sub-sample's `id` (pk) is in that list, matched by `sample_id`.

- [ ] **Step 3: Wire the Mk1 fetch when sample is a sub-sample**

In SampleDetails.tsx, find the existing `useEffect` that calls `lookupSenaiteSample(sampleId)` and stores the result in `data`. After it completes (or alongside it), if the sample is a sub-sample, fetch analyses from Mk1 and overwrite `data.analyses`:

```typescript
// Inside the existing useEffect block that loads `data`, after the
// lookupSenaiteSample call resolves, add:
useEffect(() => {
  if (!parentSampleId || !data || !sampleId) return
  // We're on a sub-sample. Fetch its Mk1 analyses and replace the SENAITE
  // ones in `data.analyses`. The Mk1 endpoint returns the same shape
  // (SenaiteAnalysis[]), so AnalysisTable renders without changes.
  let cancelled = false
  ;(async () => {
    try {
      // Find the sub-sample's pk via the already-loaded sub-samples list
      const subSamples = await listSubSamples(parentSampleId)
      const me = subSamples.subSamples.find((s) => s.sample_id === sampleId)
      if (!me) return
      const mk1Analyses = await listLimsAnalysesForSubSample(me.id)
      if (cancelled) return
      setData((prev) => prev ? { ...prev, analyses: mk1Analyses } : prev)
    } catch (e) {
      console.error("Phase 3: failed to load Mk1 analyses for sub-sample", sampleId, e)
      // Keep the SENAITE-sourced analyses; degrade gracefully.
    }
  })()
  return () => { cancelled = true }
}, [parentSampleId, sampleId, data?.uid])  // data?.uid as a stable trigger after initial load
```

(Names: `setData`, `listSubSamples`, `data.uid` — adapt to whatever the file actually uses. The Explore says `lookupSenaiteSample` returns `data` with `.analyses`; mirror those names.)

Add `listLimsAnalysesForSubSample` to the import statement at the top of the file.

- [ ] **Step 4: Typecheck**

```bash
docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -15"
```

Expected: 2 pre-existing errors only.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/senaite/SampleDetails.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1-fe): SampleDetails fetches Mk1 analyses for sub-samples"
```

---

## Task 8: Backend tests — service + route

**Files:**
- Modify: `backend/tests/test_lims_analyses_service.py`
- Modify: `backend/tests/test_lims_analyses_routes.py`

- [ ] **Step 1: Service test**

Append to `backend/tests/test_lims_analyses_service.py`:

```python
# ── Phase 3 adapter ─────────────────────────────────────────────────────────


def test_list_analyses_in_senaite_shape_returns_mk1_prefixed_uids(db, sub_sample, analysis_service):
    from lims_analyses.service import list_analyses_in_senaite_shape
    # Create one analysis via service layer
    row = _create(db, sub_sample, analysis_service)
    rows = list_analyses_in_senaite_shape(
        db, host_kind="sub_sample", host_pk=sub_sample.id,
    )
    matching = [r for r in rows if r.uid == f"mk1:{row.id}"]
    assert matching, f"expected uid=mk1:{row.id}; got uids={[r.uid for r in rows]}"
    r = matching[0]
    assert r.keyword == row.keyword
    assert r.title == row.title
    assert r.review_state == "unassigned"


def test_list_analyses_in_senaite_shape_returns_empty_for_unknown_host(db):
    from lims_analyses.service import list_analyses_in_senaite_shape
    rows = list_analyses_in_senaite_shape(
        db, host_kind="sub_sample", host_pk=99_999_999,
    )
    assert rows == []
```

- [ ] **Step 2: Route test**

Append to `backend/tests/test_lims_analyses_routes.py`:

```python
def test_list_for_host_default_flavor_returns_phase1_shape(sub_sample, analysis_service):
    create_resp = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service))
    assert create_resp.status_code == 201
    r = client.get(f"/api/lims-analyses?host_kind=sub_sample&host_pk={sub_sample.id}")
    assert r.status_code == 200
    rows = r.json()
    assert rows
    # Default shape has `id` (Phase 1)
    assert "id" in rows[0]
    assert "uid" not in rows[0]  # not the senaite_shape


def test_list_for_host_senaite_shape_returns_phase3_shape(sub_sample, analysis_service):
    create_resp = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service))
    assert create_resp.status_code == 201
    r = client.get(f"/api/lims-analyses?host_kind=sub_sample&host_pk={sub_sample.id}&as=senaite_shape")
    assert r.status_code == 200
    rows = r.json()
    assert rows
    # FE shape has `uid` with mk1: prefix
    assert rows[0]["uid"].startswith("mk1:")
    assert "method_options" in rows[0]
    assert "instrument_options" in rows[0]
    assert "review_state" in rows[0]
```

- [ ] **Step 3: Run tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_service.py tests/test_lims_analyses_routes.py -v -k 'senaite_shape or default_flavor' 2>&1 | tail -10"
```

Expected: 4 new passed.

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_lims_analyses_service.py backend/tests/test_lims_analyses_routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "test(mk1): senaite_shape flavor — service + route"
```

---

## Task 9: Live verification through the wizard

Verification-only — no commit.

- [ ] **Step 1: Open the wizard frontend on a sub-sample with seeded Mk1 analyses**

```
1. http://localhost:5532
2. sessionStorage.setItem('accu_mk1_api_url_override', 'http://localhost:5530'); location.reload()
3. Log in as forrest@valenceanalytical.com / test123
4. Navigate to: http://localhost:5532/#senaite/sample-details?id=PB-0075-S01
5. Open the browser Network tab BEFORE loading.
```

- [ ] **Step 2: Confirm the Mk1 endpoint is called**

In the Network tab, you should see a request to:
```
GET /api/lims-analyses?host_kind=sub_sample&host_pk=45&as=senaite_shape&include_retests=false
```

(host_pk number depends on the vial's `lims_sub_samples.id`.)

Expected response: 200, JSON array with `uid: "mk1:NN"` entries.

- [ ] **Step 3: Confirm the AnalysisTable renders the Mk1 rows**

Visually confirm the table shows the seeded analyses (e.g. ENDO-LAL for PB-0075-S01 / endo role). Look identical to today's display.

- [ ] **Step 4: Test result entry**

Enter a result value (e.g. `0.42`) in one row and trigger submit. Network tab should show:

```
POST /api/lims-analyses/{id}/transitions
body: {"kind":"submit","result_value":"0.42","reason":"bench-tech result entry"}
```

Response: 200, `review_state: "to_be_verified"`. The row's state pill should update.

- [ ] **Step 5: Test verify transition**

Trigger Verify from the same row. Network tab:

```
POST /api/lims-analyses/{id}/transitions
body: {"kind":"verify","reason":"bench-tech verify"}
```

Response: 200, `review_state: "verified"`. State pill updates.

- [ ] **Step 6: Sanity-check the parent path is untouched**

Navigate to `/#senaite/sample-details?id=PB-0075` (the parent). The Network tab should NOT show any `/api/lims-analyses` calls — the parent flow continues to hit `/wizard/senaite/lookup` only. Analyses render from SENAITE as before.

- [ ] **Step 7: DB inspection**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import LimsAnalysis, LimsAnalysisTransition
db = SessionLocal()
a = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == 45).limit(1)).scalar_one()
print(f'id={a.id} keyword={a.keyword} state={a.review_state} result={a.result_value!r}')
txns = db.execute(select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == a.id).order_by(LimsAnalysisTransition.occurred_at)).scalars().all()
for t in txns:
    print(f'  {t.from_state} -> {t.to_state} kind={t.transition_kind} reason={t.reason!r}')
db.close()
"
```

Expected: row's state is `verified` (after Steps 4 + 5), result_value is `'0.42'`, audit chain has `auto, submit, verify` (plus any other transitions you triggered).

---

## Verification (Phase 3 acceptance)

- [ ] **GET endpoint returns Phase 1 shape by default + senaite_shape with `as=senaite_shape`** (Task 4 Step 4)
- [ ] **Mk1 UIDs carry `mk1:` prefix in senaite_shape** (Task 4 Step 4 + Task 8)
- [ ] **AnalysisTable renders Mk1 analyses for sub-samples** (Task 9 Steps 2-3)
- [ ] **Result entry on a sub-sample analysis writes to `lims_analyses` and advances state** (Task 9 Step 4 + Step 7)
- [ ] **Verify transition on a sub-sample analysis moves state to `verified`** (Task 9 Step 5)
- [ ] **Parent sample analyses continue to render from SENAITE — no `/api/lims-analyses` calls** (Task 9 Step 6)
- [ ] **Full backend suite has no NEW regressions beyond the 13-failure baseline.** Run + compare.
- [ ] **Frontend typecheck shows 2 pre-existing errors only** (Task 6 Step 5 + Task 7 Step 4)

---

## Risks and unknowns

- **`Instrument` / `HplcMethod` ORM class names** may differ from what Task 3 imports. The grep in Step 4 catches this; substitute the actual names. If the project has a different table layout for instruments (e.g. embedded in a JSON column on `analysis_services`), the bulk-load in `list_analyses_in_senaite_shape` simplifies — drop the secondary query and read from `svc.methods` / a parallel field.

- **`apiFetch` / `API_BASE_URL` naming** in the FE — verify Task 1 Step 1 then match. If the project uses a fetch hook (e.g. `useApi()`) instead of a bare function, adapt the new lib function to the same pattern.

- **AnalysisTable consumes options arrays** for the method/instrument dropdowns. If `method_options` is empty (e.g. `svc.methods` is null in the catalog for an analysis), the dropdown will be empty too — same shape as a SENAITE row with no methods configured. Bench techs see "no method selectable" — already the documented behavior; not Phase 3's problem to solve.

- **`service_group_id` / `service_group_name` left as None in senaite_shape.** The FE uses these for role-color tinting (per Phase 1's `2d2c4a7` analysis title tinting commit). For Phase 3 the tint comes from the role badge on the sub-sample header (sample-level, not analysis-level). If the tint goes missing on titles, fold service_group resolution into Task 3 — bulk-load `service_group_members` + `service_groups` and populate the fields.

- **The plan's FE file paths assume the worktree mirrors the in-container `/app` layout.** Per Phase 2.5 we know the worktree's `backend/` → container `/app/`; the FE source layout is `src/` at the worktree root for the FE container. If your worktree puts FE files under `src/`, adjust the host-side paths. Plan steps use `/app/src/` inside the container, which is the canonical reference.

- **AnalysisTable's "title role tinting" (commit `2d2c4a7`)** keys off `service_group_id` per the prior commit. Phase 3's senaite_shape leaves it None to defer the catalog join. If tinting goes missing in Task 9 Step 3, populate it in Task 3 before declaring Phase 3 done. Or accept the regression as Phase 3.5 fodder.

## Open questions (carried forward)

1. **Worksheet inbox + worksheet_items.lims_analysis_id** — Phase 3.5. Will lift bench-tech drag-drop to point at Mk1 IDs.
2. **`promote_to_parent` service + verification UI** — Phase 4.
3. **Method/instrument PATCH endpoints on Mk1** — out of scope; bench techs continue to set method/instrument via the existing flow (which currently hits SENAITE for parents and is a no-op for sub-sample Mk1 rows in Phase 3). Surface as Phase 3.5 if needed.

## Out of scope (carried forward)

- Speculative seeding for XTRA vials (SPEC §Open Question 1; deferred).
- COA resolver default-path simplification — Phase 5.
- Family-state derivation + WP signaling — Phase 5.
- Prelim-COA opt-in customer flow — Phase 6.
- Drop the SENAITE secondary AR entirely — Phase 5 cleanup.
