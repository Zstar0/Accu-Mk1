# Sample Registry Debug Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-gated console panel on the sample details page that shows whether the local `lims_samples` registry record exists, agrees with live SENAITE, and where it drifts — making the behind-the-scenes dual-write registry observable.

**Architecture:** A pure backend diff function reuses `_populate_basic_info`'s exact mapping (by populating a throwaway `LimsSample` from the SENAITE meta and comparing attributes) so the comparison is authoritative. A non-mutating admin endpoint reads the raw row (never through the reconcile path), fetches fresh SENAITE meta, and returns a structured diff plus linkage/origin/vial diagnostics. A React console Sheet — cloned from `SampleActivityLog`'s aesthetic — renders it, opened by an admin-only header icon.

**Tech Stack:** Mk1 backend (FastAPI + SQLAlchemy 2.0), pytest (sqlite in-memory); Mk1 frontend (React + TanStack Query + Zustand + shadcn/ui Sheet), vitest + tsc.

**Spec:** `C:\tmp\canonical-basic-info\docs\superpowers\specs\2026-07-07-sample-registry-debug-panel-design.md` (approved 2026-07-07). Spec wins on any ambiguity.

## Global Constraints

- **Worktree:** `C:\tmp\canonical-basic-info`, branch `feat/registry-debug-panel` (exists, off current master). All paths relative to this root.
- **Additive / read-only observability.** No change to how the page loads or displays data. The GET endpoint **must not mutate** (no `ensure_sample_row`, no `list_sub_samples`, no `_reconcile_from_senaite`) — reading through the mutating path auto-heals drift and defeats the tool. Only the explicit `POST …/refresh` mutates.
- **Admin-only, both layers.** Backend endpoints use `admin=Depends(require_admin)`; the frontend icon renders only when `useAuthStore(s => s.user?.role === 'admin')`.
- **Diff is authoritative by reuse, not duplication.** The compare derives "what SENAITE says" by running `_populate_basic_info(throwaway_row, meta)` and reading its attributes — never a re-implemented mapping.
- **Frontend package manager is npm only** (never pnpm/yarn) — per repo CLAUDE.md.
- **Git hygiene:** explicit file paths, never `git add -A`. No Claude co-author trailer (repo history doesn't use it).
- **Backend test loop:** `docker exec canonical-basic-info-test python -m pytest tests/<file> -q` (persistent container, worktree `backend/` mounted at `/app`, pytest installed; no Postgres — `test_container_mode.py` 4F/7E is known baseline, plus ~19 repo-wide baseline reds).
- **Frontend test loop:** deps are installed in the worktree (`node_modules` present). Run `npm run test:run -- <file>` for a targeted vitest file and `npm run typecheck` for tsc. If `node_modules` is somehow missing, `npm install --no-audit --no-fund` first (one-time, ~2 min).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/sub_samples/registry_debug.py` | Create | pure `diff_registry_vs_senaite(row, meta)` + `_classify` + `_COMPARED_FIELDS` |
| `backend/main.py` | Modify | `_build_registry_debug_response(db, sample_id)` helper; `GET /debug/sample-registry/{sample_id}`; `POST /debug/sample-registry/{sample_id}/refresh`; two Pydantic response hints (or `dict`) |
| `backend/tests/test_registry_debug.py` | Create | pure-diff unit tests |
| `backend/tests/test_registry_debug_endpoint.py` | Create | endpoint unit tests (admin gate, non-mutation, linkage, refresh) |
| `src/lib/api.ts` | Modify | `SampleRegistryDebug` type + `getSampleRegistryDebug` / `refreshSampleRegistry` |
| `src/components/senaite/SampleRegistryDebug.tsx` | Create | console Sheet renderer |
| `src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` | Create | component render tests |
| `src/components/senaite/SampleDetails.tsx` | Modify | admin-only header icon + open state |

---

### Task 1: Pure diff function

**Files:**
- Create: `backend/sub_samples/registry_debug.py`
- Test: `backend/tests/test_registry_debug.py`

**Interfaces:**
- Consumes: `models.LimsSample`; `sub_samples.service._populate_basic_info`.
- Produces: `diff_registry_vs_senaite(row: LimsSample, meta: dict) -> dict` returning `{"fields": [{"field","registry","senaite","status"}], "summary": {"agree","drift","registry_null","senaite_null"}}`. Task 2 calls it.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_registry_debug.py`:

```python
"""Pure registry-vs-SENAITE diff (2026-07-07 debug-panel spec)."""
import json
from datetime import datetime
from models import LimsSample
from sub_samples.registry_debug import diff_registry_vs_senaite


def _meta(**over):
    m = {
        "uid": "AR_UID", "ClientID": "client-8", "getClientTitle": "acme@x.com",
        "ContactFullName": "Ada L", "ContactEmail": "ada@x.com",
        "ClientUID": "C_UID", "ContactUID": "CT_UID", "SampleType": "ST_UID",
        "getSampleTypeTitle": "Peptide", "ClientSampleID": "CS-1",
        "ClientOrderNumber": "WP-1", "VerificationCode": "AB12-CD34",
        "Analyte1Peptide": "BPC-157", "Analyte1DeclaredQuantity": "10.00",
        "DeclaredTotalQuantity": "10.00", "ClientLot": "L1", "ClientReference": "r1",
        "CompanyLogoUrl": "/logo.jpg", "CoaCompanyName": "Acme",
        "DateReceived": "2026-05-01T10:00:00+00:00",
        "DateSampled": "2026-04-30T00:00:00+00:00",
        "created": "2026-04-29T00:00:00+00:00", "review_state": "sample_received",
    }
    m.update(over)
    return m


def _row_from(meta):
    """A row that already matches the meta (the in-sync baseline)."""
    from sub_samples.service import _populate_basic_info
    r = LimsSample(sample_id="P-1")
    _populate_basic_info(r, meta)
    return r


def _status_of(result, field):
    return next(f["status"] for f in result["fields"] if f["field"] == field)


def test_all_agree_when_row_matches_meta():
    meta = _meta()
    res = diff_registry_vs_senaite(_row_from(meta), meta)
    assert res["summary"]["drift"] == 0
    assert res["summary"]["registry_null"] == 0
    assert res["summary"]["senaite_null"] == 0
    assert res["summary"]["agree"] == len(res["fields"])


def test_drift_on_client_sample_id():
    """The real drift source: SENAITE-side Replace-Analyte edits ClientSampleID."""
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(ClientSampleID="CS-CHANGED"))
    assert _status_of(res, "client_sample_id") == "drift"
    assert res["summary"]["drift"] == 1


def test_registry_null_when_row_missing_a_field():
    row = _row_from(_meta())
    row.sample_type_title = None          # reconcile-fill candidate
    res = diff_registry_vs_senaite(row, _meta())
    assert _status_of(res, "sample_type_title") == "registry_null"


def test_senaite_null_when_meta_missing_a_field():
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(ClientLot=None))
    assert _status_of(res, "client_lot") == "senaite_null"


def test_analyte_structural_drift():
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(Analyte1Peptide="TB-500"))
    assert _status_of(res, "analytes") == "drift"


def test_coa_meta_map_drift():
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(CoaCompanyName="NewCo"))
    assert _status_of(res, "coa_meta") == "drift"


def test_date_formatting_is_not_drift():
    """Offset string vs stored naive-UTC must compare equal, not drift."""
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(DateReceived="2026-05-01T06:00:00-04:00"))
    assert _status_of(res, "date_received") == "agree"   # same instant
```

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_debug.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'sub_samples.registry_debug'`

- [ ] **Step 3: Implement**

Create `backend/sub_samples/registry_debug.py`:

```python
"""Pure registry-vs-SENAITE comparison for the admin debug panel
(2026-07-07-sample-registry-debug-panel-design.md).

Authoritative by reuse: the "what SENAITE says" side is computed by running
the real _populate_basic_info onto a throwaway LimsSample and reading its
attributes, so the diff can never drift from the population mapping. No I/O,
no session — pure."""
import json
from datetime import datetime
from typing import Any
from models import LimsSample
from sub_samples.service import _populate_basic_info

# The SENAITE-sourced basic-info fields to compare. Excludes local bookkeeping
# (last_synced_at) and the always-"senaite" discriminator (external_lims_system),
# neither of which is a SENAITE value to agree/drift on.
_COMPARED_FIELDS = (
    "external_lims_uid", "client_id", "client_uid", "contact_uid", "sample_type",
    "client_sample_id", "peptide_name", "date_received", "date_sampled", "status",
    "client_title", "contact_title", "contact_email", "sample_type_title",
    "date_created", "verification_code", "client_order_number", "analytes",
    "declared_total_quantity", "client_lot", "client_reference",
    "company_logo_url", "coa_meta",
)
# Fields stored as JSON strings — compare parsed structures so key/quote
# formatting never reads as drift.
_JSON_FIELDS = frozenset({"analytes", "coa_meta"})


def _norm(field: str, value: Any) -> Any:
    if value is None:
        return None
    if field in _JSON_FIELDS:
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value
    return value


def _display(value: Any) -> Any:
    """JSON-safe scalar for the wire (datetimes → iso)."""
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _classify(stored: Any, want: Any) -> str:
    if stored is None and want is None:
        return "agree"
    if stored is None:
        return "registry_null"
    if want is None:
        return "senaite_null"
    return "agree" if stored == want else "drift"


def diff_registry_vs_senaite(row: LimsSample, meta: dict) -> dict:
    derived = LimsSample()
    _populate_basic_info(derived, meta)  # reuse the exact mapping

    fields = []
    summary = {"agree": 0, "drift": 0, "registry_null": 0, "senaite_null": 0}
    for f in _COMPARED_FIELDS:
        stored = getattr(row, f)
        want = getattr(derived, f)
        status = _classify(_norm(f, stored), _norm(f, want))
        summary[status] += 1
        fields.append({
            "field": f,
            "registry": _display(stored),
            "senaite": _display(want),
            "status": status,
        })
    return {"fields": fields, "summary": summary}
```

- [ ] **Step 4: Run to verify they pass**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_debug.py -q`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/registry_debug.py backend/tests/test_registry_debug.py
git commit -m "feat(registry-debug): pure registry-vs-SENAITE diff (reuses populate mapping)"
```

---

### Task 2: Read endpoint + response builder

**Files:**
- Modify: `backend/main.py` (new endpoint near the other sample/debug routes; grep `require_admin` for the cluster)
- Test: `backend/tests/test_registry_debug_endpoint.py` (create)

**Interfaces:**
- Consumes: `diff_registry_vs_senaite` (Task 1); `senaite.fetch_parent_metadata`, `senaite.fetch_secondaries`; `LimsSample`, `LimsSubSample`; `require_admin`, `get_db`.
- Produces: `_build_registry_debug_response(db, sample_id) -> dict` (Task 3 reuses it); `GET /debug/sample-registry/{sample_id}` returning the full response dict. Task 5's TS type mirrors this shape.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_registry_debug_endpoint.py`:

```python
"""Admin registry-debug endpoint: gate, non-mutation, linkage, errors."""
import pytest
from datetime import datetime, timedelta
from unittest.mock import patch
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base, get_db
from models import LimsSample
import main
from auth import require_admin, get_current_user


@pytest.fixture
def client():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[require_admin] = lambda: {"email": "a@x", "role": "admin"}
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()


def _meta(**over):
    m = {"uid": "AR_UID", "ClientID": "c", "getClientTitle": "acme@x.com",
         "ClientSampleID": "CS-1", "review_state": "sample_received"}
    m.update(over)
    return m


def _seed(client, **kw):
    db = client._Session()
    row = LimsSample(sample_id="P-1", external_lims_uid="AR_UID",
                     last_synced_at=datetime(2026, 1, 1), **kw)
    db.add(row)
    db.commit()
    db.close()


def test_requires_admin():
    # No override → real require_admin → unauthenticated request rejected.
    from database import Base as B
    eng = create_engine("sqlite:///:memory:"); B.metadata.create_all(eng)
    c = TestClient(main.app)
    r = c.get("/debug/sample-registry/P-1")
    assert r.status_code in (401, 403)


def test_missing_row_returns_exists_false(client):
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("no AR")):
        r = client.get("/debug/sample-registry/NOPE")
    assert r.status_code == 200
    assert r.json()["load"]["exists"] is False


def test_get_does_not_mutate_last_synced_at(client):
    _seed(client)
    with patch.object(main.senaite, "fetch_parent_metadata", return_value=_meta()), \
         patch.object(main.senaite, "fetch_secondaries", return_value=[]):
        client.get("/debug/sample-registry/P-1")
    db = client._Session()
    row = db.query(LimsSample).filter_by(sample_id="P-1").one()
    assert row.last_synced_at == datetime(2026, 1, 1)   # untouched — the anti-reconcile guarantee
    db.close()


def test_linkage_mismatch_flagged(client):
    _seed(client)   # stored uid = AR_UID
    with patch.object(main.senaite, "fetch_parent_metadata", return_value=_meta(uid="DIFFERENT_UID")), \
         patch.object(main.senaite, "fetch_secondaries", return_value=[]):
        r = client.get("/debug/sample-registry/P-1")
    assert r.json()["linkage"]["status"] == "mismatch"


def test_senaite_error_returns_row_half(client):
    _seed(client)
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("senaite down")):
        r = client.get("/debug/sample-registry/P-1")
    body = r.json()
    assert body["load"]["exists"] is True
    assert body["senaite_error"] is not None
    assert body["fields"] == []


def test_origin_inference(client):
    _seed(client, native_id="aP-0001")   # native_id + senaite system → creation-signal
    with patch.object(main.senaite, "fetch_parent_metadata", return_value=_meta()), \
         patch.object(main.senaite, "fetch_secondaries", return_value=[]):
        r = client.get("/debug/sample-registry/P-1")
    assert r.json()["origin"] == "creation-signal"
```

Note: `main.senaite` must be the imported senaite module reference used by the endpoint — implement the endpoint to call `senaite.fetch_parent_metadata(...)` via a module-level `from sub_samples import senaite` import in main.py (grep to confirm main.py already imports it that way; if it imports specific names, add the module import so the patch target exists, and say so in the report).

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_debug_endpoint.py -q`
Expected: FAIL — 404 on the route / endpoint not defined.

- [ ] **Step 3: Implement**

Confirm main.py has `from sub_samples import senaite` (grep; add if absent). Add near the other `require_admin` sample routes:

```python
from sub_samples.registry_debug import diff_registry_vs_senaite


def _registry_origin(row) -> str:
    if row.external_lims_system == "mk1":
        return "native"
    if row.native_id:
        return "creation-signal"
    return "lazy-or-backfill"


def _build_registry_debug_response(db: Session, sample_id: str) -> dict:
    """Assemble the registry-debug payload. NON-MUTATING: reads the raw row
    directly (never ensure_sample_row / list_sub_samples / reconcile), so
    drift is observable instead of auto-healed."""
    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()

    if row is None:
        return {
            "sample_id": sample_id,
            "load": {"exists": False, "native_id": None, "external_lims_system": None,
                     "last_synced_at": None, "age_seconds": None, "reconcile_due": None},
            "linkage": None, "origin": None, "container": None,
            "fields": [], "summary": None, "vials": None,
            "verdict": None, "senaite_error": None, "raw": None,
        }

    age = None
    reconcile_due = None
    if row.last_synced_at:
        age = int((datetime.utcnow() - row.last_synced_at).total_seconds())
        reconcile_due = age > 300  # CACHE_FRESHNESS = 5 min
    load = {
        "exists": True, "native_id": row.native_id,
        "external_lims_system": row.external_lims_system,
        "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "age_seconds": age, "reconcile_due": reconcile_due,
    }
    container = {"container_mode": row.container_mode, "assignment_role": row.assignment_role}

    meta = None
    senaite_error = None
    try:
        meta = senaite.fetch_parent_metadata(sample_id)
    except Exception as e:
        senaite_error = str(e)

    if meta is None:
        return {
            "sample_id": sample_id, "load": load,
            "linkage": {"registry_uid": row.external_lims_uid, "senaite_uid": None,
                        "status": "senaite_missing"},
            "origin": _registry_origin(row), "container": container,
            "fields": [], "summary": None, "vials": None, "verdict": None,
            "senaite_error": senaite_error,
            "raw": {"registry": _row_to_dict(row), "senaite": None},
        }

    diff = diff_registry_vs_senaite(row, meta)
    senaite_uid = meta.get("uid")
    linkage_status = ("match" if row.external_lims_uid == senaite_uid
                      else "senaite_missing" if not senaite_uid else "mismatch")

    vials = None
    try:
        local_ct = db.execute(
            select(func.count()).select_from(LimsSubSample)
            .where(LimsSubSample.parent_sample_pk == row.id)
        ).scalar_one()
        senaite_ct = len(senaite.fetch_secondaries(sample_id))
        vstatus = ("in_sync" if local_ct == senaite_ct
                   else "local_extra" if local_ct > senaite_ct else "senaite_extra")
        vials = {"local": local_ct, "senaite": senaite_ct, "status": vstatus}
    except Exception:
        vials = None

    return {
        "sample_id": sample_id, "load": load,
        "linkage": {"registry_uid": row.external_lims_uid, "senaite_uid": senaite_uid,
                    "status": linkage_status},
        "origin": _registry_origin(row), "container": container,
        "fields": diff["fields"], "summary": diff["summary"], "vials": vials,
        "verdict": {"linkage_ok": linkage_status == "match",
                    "vials_ok": (vials or {}).get("status") == "in_sync" if vials else None,
                    "drift": diff["summary"]["drift"],
                    "registry_null": diff["summary"]["registry_null"]},
        "senaite_error": None,
        "raw": {"registry": _row_to_dict(row), "senaite": meta},
    }


def _row_to_dict(row) -> dict:
    """Registry row → JSON-safe dict for the raw panel."""
    out = {}
    for col in row.__table__.columns:
        v = getattr(row, col.name)
        out[col.name] = v.isoformat() if isinstance(v, datetime) else v
    return out


@app.get("/debug/sample-registry/{sample_id}")
async def get_sample_registry_debug(
    sample_id: str,
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin registry diagnostic — non-mutating registry-vs-SENAITE compare."""
    return _build_registry_debug_response(db, sample_id)
```

Verify `select`, `func`, `datetime`, `Session`, `LimsSubSample` are imported in main.py (grep); add any missing to the existing import lines.

- [ ] **Step 4: Run to verify they pass**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_debug_endpoint.py -q`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/main.py backend/tests/test_registry_debug_endpoint.py
git commit -m "feat(registry-debug): non-mutating admin read endpoint + response builder"
```

---

### Task 3: Refresh action endpoint

**Files:**
- Modify: `backend/main.py` (next to the GET route)
- Test: `backend/tests/test_registry_debug_endpoint.py` (extend)

**Interfaces:**
- Consumes: `_build_registry_debug_response` (Task 2); `sub_samples.service._refresh_parent_from_senaite`.
- Produces: `POST /debug/sample-registry/{sample_id}/refresh` returning the same shape, re-diffed after a forced reconcile.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_registry_debug_endpoint.py`:

```python
def test_refresh_mutates_and_rediffs(client):
    _seed(client)   # last_synced_at = 2026-01-01
    fresh = _meta(ClientSampleID="CS-UPDATED")
    with patch.object(main.senaite, "fetch_parent_metadata", return_value=fresh), \
         patch.object(main.senaite, "fetch_secondaries", return_value=[]):
        r = client.post("/debug/sample-registry/P-1/refresh")
    assert r.status_code == 200
    # after a forced refresh the row now matches SENAITE → no drift on that field
    body = r.json()
    csid = next(f for f in body["fields"] if f["field"] == "client_sample_id")
    assert csid["status"] == "agree"
    db = client._Session()
    row = db.query(LimsSample).filter_by(sample_id="P-1").one()
    assert row.last_synced_at != datetime(2026, 1, 1)   # mutated, as intended
    assert row.client_sample_id == "CS-UPDATED"
    db.close()


def test_refresh_missing_row_is_noop_exists_false(client):
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("x")):
        r = client.post("/debug/sample-registry/NOPE/refresh")
    assert r.status_code == 200
    assert r.json()["load"]["exists"] is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_debug_endpoint.py::test_refresh_mutates_and_rediffs -q`
Expected: FAIL — 404 (route not defined)

- [ ] **Step 3: Implement**

Add after the GET route in `backend/main.py`:

```python
@app.post("/debug/sample-registry/{sample_id}/refresh")
async def refresh_sample_registry_debug(
    sample_id: str,
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin action: force a SENAITE reconcile of the registry row, then
    return the re-diffed debug payload so drift can be watched resolving.
    Distinct POST verb because it mutates."""
    from sub_samples.service import _refresh_parent_from_senaite
    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if row is not None:
        try:
            _refresh_parent_from_senaite(db, row)
            db.commit()
        except Exception:
            db.rollback()
    return _build_registry_debug_response(db, sample_id)
```

- [ ] **Step 4: Run to verify they pass**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_debug_endpoint.py -q`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/main.py backend/tests/test_registry_debug_endpoint.py
git commit -m "feat(registry-debug): admin refresh action endpoint (forced reconcile + re-diff)"
```

---

### Task 4: Frontend API client + types

**Files:**
- Modify: `src/lib/api.ts` (add near `getSampleActivity`, ~line 5010)

**Interfaces:**
- Consumes: `apiFetch<T>` (existing generic — bearer auth + JSON + error throw).
- Produces: `SampleRegistryDebug` type + `getSampleRegistryDebug(sampleId)` / `refreshSampleRegistry(sampleId)`. Task 5 imports all three.

- [ ] **Step 1: Add the type + functions**

In `src/lib/api.ts`, after `getSampleActivity` (~line 5017):

```typescript
// ─── Registry Debug Panel (admin) ────────────────────────────────────────────

export type RegistryFieldStatus = 'agree' | 'drift' | 'registry_null' | 'senaite_null'

export interface RegistryDebugField {
  field: string
  registry: unknown
  senaite: unknown
  status: RegistryFieldStatus
}

export interface SampleRegistryDebug {
  sample_id: string
  load: {
    exists: boolean
    native_id: string | null
    external_lims_system: string | null
    last_synced_at: string | null
    age_seconds: number | null
    reconcile_due: boolean | null
  }
  linkage: { registry_uid: string | null; senaite_uid: string | null; status: string } | null
  origin: string | null
  container: { container_mode: boolean; assignment_role: string } | null
  fields: RegistryDebugField[]
  summary: { agree: number; drift: number; registry_null: number; senaite_null: number } | null
  vials: { local: number; senaite: number; status: string } | null
  verdict: { linkage_ok: boolean; vials_ok: boolean | null; drift: number; registry_null: number } | null
  senaite_error: string | null
  raw: { registry: Record<string, unknown> | null; senaite: Record<string, unknown> | null } | null
}

export async function getSampleRegistryDebug(sampleId: string): Promise<SampleRegistryDebug> {
  return apiFetch<SampleRegistryDebug>(`/debug/sample-registry/${encodeURIComponent(sampleId)}`)
}

export async function refreshSampleRegistry(sampleId: string): Promise<SampleRegistryDebug> {
  return apiFetch<SampleRegistryDebug>(
    `/debug/sample-registry/${encodeURIComponent(sampleId)}/refresh`,
    { method: 'POST' },
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no new errors (pre-existing errors, if any, unchanged — capture the baseline count first with `npm run typecheck 2>&1 | grep -c error` on the untouched tree if unsure).

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add src/lib/api.ts
git commit -m "feat(registry-debug): api client + types for the registry debug panel"
```

---

### Task 5: Console Sheet component

**Files:**
- Create: `src/components/senaite/SampleRegistryDebug.tsx`
- Test: `src/components/senaite/__tests__/SampleRegistryDebug.test.tsx`

**Interfaces:**
- Consumes: `getSampleRegistryDebug`, `refreshSampleRegistry`, `SampleRegistryDebug`, `RegistryFieldStatus` (Task 4); shadcn `Sheet` primitives; `SampleActivityLog`'s visual shell (clone, don't import).
- Produces: `export function SampleRegistryDebug({ open, onClose, sampleId }: Props)`. Task 6 mounts it.

- [ ] **Step 1: Write the failing test**

Create `src/components/senaite/__tests__/SampleRegistryDebug.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SampleRegistryDebug } from '@/components/senaite/SampleRegistryDebug'
import * as api from '@/lib/api'

const base: api.SampleRegistryDebug = {
  sample_id: 'P-1',
  load: { exists: true, native_id: 'aP-0007', external_lims_system: 'senaite',
          last_synced_at: '2026-07-01T00:00:00', age_seconds: 60, reconcile_due: false },
  linkage: { registry_uid: 'U1', senaite_uid: 'U1', status: 'match' },
  origin: 'creation-signal',
  container: { container_mode: true, assignment_role: 'hplc' },
  fields: [
    { field: 'client_sample_id', registry: 'CS-1', senaite: 'CS-2', status: 'drift' },
    { field: 'client_title', registry: 'a@x.com', senaite: 'a@x.com', status: 'agree' },
    { field: 'sample_type_title', registry: null, senaite: 'Peptide', status: 'registry_null' },
  ],
  summary: { agree: 1, drift: 1, registry_null: 1, senaite_null: 0 },
  vials: { local: 2, senaite: 2, status: 'in_sync' },
  verdict: { linkage_ok: true, vials_ok: true, drift: 1, registry_null: 1 },
  senaite_error: null,
  raw: { registry: { sample_id: 'P-1' }, senaite: { uid: 'U1' } },
}

beforeEach(() => vi.restoreAllMocks())

describe('SampleRegistryDebug', () => {
  it('renders fields with their status and the drift value', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue(base)
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText('client_sample_id')).toBeInTheDocument())
    expect(screen.getByText(/CS-2/)).toBeInTheDocument()
    expect(screen.getByText('creation-signal')).toBeInTheDocument()
  })

  it('shows the missing-record state', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({
      ...base, load: { ...base.load, exists: false }, fields: [], summary: null,
    })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-9" />)
    await waitFor(() => expect(screen.getByText(/no registry record/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run -- src/components/senaite/__tests__/SampleRegistryDebug.test.tsx`
Expected: FAIL — cannot resolve `SampleRegistryDebug`.

- [ ] **Step 3: Implement**

Create `src/components/senaite/SampleRegistryDebug.tsx`. Clone `SampleActivityLog`'s shell (Sheet, `w-[600px]`, title bar with traffic-light dots + `$ accumark registry-inspect --sample {sampleId}`, refresh + close buttons, `bg-[#0d0d0d]` mono body, footer) and render the debug sections. Use this exact structure:

```tsx
/**
 * SampleRegistryDebug — admin diagnostic panel.
 * Terminal-styled Sheet (matches SampleActivityLog) showing the local
 * lims_samples registry record vs live SENAITE: existence, linkage, origin,
 * freshness, field-by-field agreement/drift, and vial-count sanity.
 */
import { useState, useEffect } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { X, RefreshCw, RotateCw } from 'lucide-react'
import {
  getSampleRegistryDebug, refreshSampleRegistry,
  type SampleRegistryDebug as DebugData, type RegistryFieldStatus,
} from '@/lib/api'

const statusGlyph: Record<RegistryFieldStatus, string> = {
  agree: '✔', drift: '⚠', registry_null: '○', senaite_null: '—',
}
const statusColor: Record<RegistryFieldStatus, string> = {
  agree: 'text-emerald-400', drift: 'text-amber-400',
  registry_null: 'text-zinc-500', senaite_null: 'text-zinc-500',
}

function val(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

interface Props { open: boolean; onClose: () => void; sampleId: string }

export function SampleRegistryDebug({ open, onClose, sampleId }: Props) {
  const [data, setData] = useState<DebugData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  async function load() {
    setLoading(true); setError(null)
    try { setData(await getSampleRegistryDebug(sampleId)) }
    catch (e) { setError(e instanceof Error ? e.message : 'failed') }
    finally { setLoading(false) }
  }
  async function reconcile() {
    setLoading(true); setError(null)
    try { setData(await refreshSampleRegistry(sampleId)) }
    catch (e) { setError(e instanceof Error ? e.message : 'failed') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (open && sampleId) load() }, [open, sampleId])

  const line = 'font-mono text-[12px] leading-relaxed whitespace-pre-wrap'

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent side="right" className="w-[600px] sm:max-w-[600px] p-0 border-l-0 bg-transparent [&>button]:hidden">
        <SheetHeader className="sr-only"><SheetTitle>Registry Debug — {sampleId}</SheetTitle></SheetHeader>
        <div className="m-3 flex flex-1 h-[calc(100%-24px)] flex-col rounded-lg overflow-hidden border border-zinc-800/80 shadow-2xl shadow-black/90">
          <div className="bg-zinc-900 border-b border-zinc-800/80 px-3 py-2 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex gap-1.5 shrink-0">
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              </div>
              <span className="text-[11px] text-zinc-500 font-mono truncate">
                <span className="text-zinc-600">$</span> accumark registry-inspect --sample {sampleId}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={reconcile} disabled={loading} title="force reconcile"
                className="text-amber-600/70 hover:text-amber-400 transition-colors disabled:opacity-30">
                <RotateCw size={12} />
              </button>
              <button onClick={load} disabled={loading}
                className="text-zinc-600 hover:text-zinc-300 transition-colors disabled:opacity-30">
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              </button>
              <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                <X size={13} />
              </button>
            </div>
          </div>

          <div className="bg-[#0d0d0d] px-3 py-3 flex-1 overflow-y-auto">
            {loading && !data && (
              <div className="flex items-center gap-2 py-8 justify-center">
                <Spinner className="size-3" />
                <span className="font-mono text-[11px] text-zinc-600">inspecting {sampleId}...</span>
              </div>
            )}
            {error && <div className="font-mono text-[11px] text-red-400 py-2">error: {error}</div>}

            {data && !data.load.exists && (
              <div className="font-mono text-[12px] text-amber-400 py-4">
                no registry record for {sampleId} — lims_samples row not created yet
              </div>
            )}

            {data && data.load.exists && (
              <div className="space-y-2">
                {/* status block */}
                <div className={cn(line, 'text-zinc-300')}>
                  <span className="text-zinc-600">load</span>   exists=<span className="text-emerald-400">true</span>{'  '}
                  native_id={data.load.native_id ?? '∅'}{'  '}system={data.load.external_lims_system}
                </div>
                {data.linkage && (
                  <div className={cn(line)}>
                    <span className="text-zinc-600">link</span>   uid {data.linkage.registry_uid ?? '∅'} vs {data.linkage.senaite_uid ?? '∅'}{'  '}
                    <span className={data.linkage.status === 'match' ? 'text-emerald-400' : 'text-red-400'}>{data.linkage.status}</span>
                  </div>
                )}
                <div className={cn(line, 'text-zinc-300')}>
                  <span className="text-zinc-600">orig</span>   {data.origin}{'   '}
                  <span className="text-zinc-600">sync</span> {data.load.last_synced_at ?? '∅'}
                  {data.load.reconcile_due ? <span className="text-amber-400">  (reconcile due)</span> : null}
                </div>
                {data.container && (
                  <div className={cn(line, 'text-zinc-400')}>
                    <span className="text-zinc-600">cont</span>   container_mode={String(data.container.container_mode)}{'  '}role={data.container.assignment_role}
                  </div>
                )}

                {data.senaite_error && (
                  <div className={cn(line, 'text-red-400')}>senaite_error: {data.senaite_error}</div>
                )}

                {/* field diff */}
                {data.fields.length > 0 && (
                  <div className="pt-2">
                    <div className="font-mono text-[11px] text-zinc-700 pb-1">{'─'.repeat(3)} fields {'─'.repeat(40)}</div>
                    {data.fields.map(f => (
                      <div key={f.field} className={cn(line, statusColor[f.status])}>
                        <span className={statusColor[f.status]}>{statusGlyph[f.status]}</span>{'  '}
                        <span className="text-zinc-400">{f.field.padEnd(22)}</span>
                        <span className="text-zinc-500" title={val(f.registry)}>{val(f.registry).slice(0, 22).padEnd(24)}</span>
                        <span className="text-zinc-600" title={val(f.senaite)}>{val(f.senaite).slice(0, 22)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {data.vials && (
                  <div className={cn(line, data.vials.status === 'in_sync' ? 'text-zinc-400' : 'text-amber-400')}>
                    <span className="text-zinc-600">vial</span>   local={data.vials.local} senaite={data.vials.senaite}{'  '}{data.vials.status}
                  </div>
                )}

                {/* raw toggle */}
                <button onClick={() => setShowRaw(v => !v)} className="font-mono text-[11px] text-zinc-600 hover:text-zinc-400 pt-2">
                  {showRaw ? '▾' : '▸'} raw json
                </button>
                {showRaw && data.raw && (
                  <pre className="font-mono text-[10px] text-zinc-500 whitespace-pre-wrap bg-black/40 rounded p-2 overflow-x-auto">
                    {JSON.stringify(data.raw, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>

          {/* verdict footer */}
          <div className="bg-[#0a0a0a] border-t border-zinc-900 px-3 py-2 font-mono text-[10px] flex items-center justify-between shrink-0">
            <span className="text-emerald-500/70">
              {data?.summary ? `${data.summary.agree} agree · ${data.summary.drift} drift · ${data.summary.registry_null} null` : 'registry-inspect'}
            </span>
            <span className="text-zinc-700">{data?.verdict?.linkage_ok === false ? 'LINKAGE MISMATCH' : 'esc to close'}</span>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:run -- src/components/senaite/__tests__/SampleRegistryDebug.test.tsx`
Expected: 2 passed

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (no new errors), then:

```bash
cd C:/tmp/canonical-basic-info
git add src/components/senaite/SampleRegistryDebug.tsx src/components/senaite/__tests__/SampleRegistryDebug.test.tsx
git commit -m "feat(registry-debug): console Sheet panel (registry-vs-SENAITE)"
```

---

### Task 6: Header icon (admin-gated)

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx`

**Interfaces:**
- Consumes: `SampleRegistryDebug` component (Task 5); `useAuthStore`; existing header toolbar + `activityLogOpen` pattern.
- Produces: user-visible admin icon that opens the panel.

- [ ] **Step 1: Add imports + state**

At the top imports of `SampleDetails.tsx`: add `Radar` to the existing `lucide-react` import, `import { SampleRegistryDebug } from '@/components/senaite/SampleRegistryDebug'`, and confirm `useAuthStore` is imported (add `import { useAuthStore } from '@/store/auth-store'` if not present — grep first).

Near the `activityLogOpen` state (~line 3229):

```tsx
  const [registryDebugOpen, setRegistryDebugOpen] = useState(false)
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
```

- [ ] **Step 2: Add the icon button**

Immediately after the Activity `<Button>` in the header toolbar (the block ending `</Button>` around line 4642), add:

```tsx
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 px-0 cursor-pointer"
                  title="Registry debug (admin)"
                  onClick={() => setRegistryDebugOpen(true)}
                >
                  <Radar size={12} />
                </Button>
              )}
```

- [ ] **Step 3: Mount the panel**

Next to the `<SampleActivityLog … />` mount (~line 6247), add:

```tsx
      <SampleRegistryDebug
        open={registryDebugOpen}
        onClose={() => setRegistryDebugOpen(false)}
        sampleId={sampleId ?? ''}
      />
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add src/components/senaite/SampleDetails.tsx
git commit -m "feat(registry-debug): admin-only header icon opens the registry panel"
```

---

### Task 7: Regression gate + push + PR

- [ ] **Step 1: Backend regression**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_debug.py tests/test_registry_debug_endpoint.py tests/test_registry_signal.py tests/test_lims_sample_basic_info.py tests/test_sub_samples_service.py -q`
Expected: all pass (known `test_container_mode` baseline is not in this set).

- [ ] **Step 2: Frontend checks**

Run: `npm run test:run -- src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` and `npm run typecheck`
Expected: component tests pass; typecheck shows no new errors vs baseline.

- [ ] **Step 3: Push + PR**

```bash
cd C:/tmp/canonical-basic-info && git push -u origin feat/registry-debug-panel
gh pr create --repo Zstar0/Accu-Mk1 --base master --head feat/registry-debug-panel \
  --title "feat: admin sample-registry debug panel (dual-write observability)" \
  --body "$(cat <<'BODY'
Admin-gated console panel on the sample details page showing the local lims_samples record vs live SENAITE — existence, linkage, origin, freshness, field-by-field agreement/drift, vial-count sanity. Makes the behind-the-scenes dual-write registry observable.

- Pure diff reuses `_populate_basic_info`'s mapping (authoritative by construction)
- GET endpoint is non-mutating (reads the raw row, never the reconcile path) so drift is visible; POST `/refresh` is the explicit mutate-and-rediff action
- Admin-gated both layers (`require_admin` + `role === 'admin'`)
- Comparison-only now; per-field source badge lands with the Slice 2 read cutover

Backend: N passed. Frontend: component tests pass, typecheck clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 4: Report** test counts + PR URL.

---

## Self-Review (completed)

- **Spec coverage:** pure diff → T1; non-mutating endpoint + load/linkage/origin/container/vials/verdict/raw → T2; refresh action → T3; api client + types → T4; console Sheet (status/fields/vials/verdict/raw-toggle/reconcile button) → T5; admin header icon → T6; tests per task + gate → T7. The non-mutation guarantee has an explicit test (T2 `test_get_does_not_mutate_last_synced_at`). Source-badge deferral is honored (fields carry no `source` yet; type is extensible).
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `diff_registry_vs_senaite(row, meta) -> {fields, summary}` (T1 def == T2 call); `_build_registry_debug_response(db, sample_id)` (T2 def == T3 reuse); `SampleRegistryDebug` TS shape (T4) == endpoint dict (T2/T3) == component prop (T5); `RegistryFieldStatus` glyph/color maps cover all four statuses.
- **Reuse-not-duplicate check:** the diff derives the SENAITE side via `_populate_basic_info` on a throwaway row — no re-implemented mapping, so it cannot drift from population. `_COMPARED_FIELDS` deliberately excludes `last_synced_at` and `external_lims_system` (not SENAITE values).
