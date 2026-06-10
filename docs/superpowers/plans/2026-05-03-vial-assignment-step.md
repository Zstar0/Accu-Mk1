# Vial Assignment Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third step to the Receive Sample wizard that buckets vials into HPLC / Microbiology(Endo + Sterility) / Xtra sections, persists `assignment_role` per vial, and prints the role short-name on each label.

**Architecture:** WP `services` dict (in IS's `order_submissions.payload`) is the source of truth. New IS read endpoint exposes it; Mk1 backend computes demand, runs auto-assign, persists to `lims_*_samples.assignment_role`. Frontend adds an `AssignStep` between capture and print using `@dnd-kit/core`.

**Tech Stack:** Python (FastAPI) + SQLAlchemy + pytest on backends; React + TypeScript + Vitest + Tailwind on Mk1 frontend; PostgreSQL.

**Reference spec:** `docs/superpowers/specs/2026-05-03-vial-assignment-step-design.md`

---

## File Structure

**Integration Service (IS):**
- `app/api/desktop.py` — add `GET /explorer/orders/sample-services` endpoint
- `tests/unit/test_api.py` — add tests for new endpoint

**Mk1 backend:**
- `backend/database.py:_run_migrations()` — add 3 migration entries
- `backend/models.py` — add `assignment_role` columns to `LimsSample` and `LimsSubSample`
- `backend/sub_samples/service.py` — add `derive_demand()`, `auto_assign()`, IS client helper
- `backend/sub_samples/routes.py` — add `vial-plan` GET and `assignment` PATCH
- `backend/sub_samples/schemas.py` — add response/request schemas
- `backend/tests/test_sub_samples_service.py` — pure-function tests for derive_demand + auto_assign
- `backend/tests/test_sub_samples_routes.py` — route tests for new endpoints

**Mk1 frontend:**
- `src/components/intake/ReceiveWizard/AssignStep.tsx` — NEW. Bucket layout + DnD
- `src/components/intake/ReceiveWizard/ReceiveWizard.tsx` — add `'assign'` phase
- `src/components/intake/ReceiveWizard/WizardSidebar.tsx` — role badge per vial
- `src/components/intake/ReceiveWizard/LabelTemplate.tsx` — render 3rd line + vial position
- `src/components/intake/ReceiveWizard/PrintStep.tsx` — pass role + position through
- `src/components/intake/ReceiveWizard/PrintStep.css` — `.label-role` rule
- `src/lib/api.ts` — typed wrappers for new Mk1 endpoints
- `package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`

---

### Task 1: IS — `GET /explorer/orders/sample-services` endpoint

**Files:**
- Modify: `integration-service/app/api/desktop.py`
- Test: `integration-service/tests/unit/test_api.py`

- [ ] **Step 1: Write the failing test**

Add to `integration-service/tests/unit/test_api.py`:

```python
import pytest
from httpx import AsyncClient
from app.main import app


@pytest.mark.asyncio
async def test_get_sample_services_returns_200_with_services_dict(
    db_session, mock_api_key
):
    """Existing order with BW-0006 in sample_results returns its services dict."""
    from app.models.persistence import OrderSubmissionRecord
    rec = OrderSubmissionRecord(
        order_id="3229",
        order_number="3229",
        status="submitted",
        samples_expected=3,
        payload={
            "samples": [
                {"services": {"hplcpurity_identity": True, "endotoxin": False, "sterility_pcr": False, "bac_water_panel": False, "samplevariance": False, "residualsolvents": False}, "analytical_test": "Single Peptide"},
                {"services": {"hplcpurity_identity": False, "endotoxin": True, "sterility_pcr": True, "bac_water_panel": True, "samplevariance": False, "residualsolvents": False}, "analytical_test": "Bacteriostatic Water"},
                {"services": {"hplcpurity_identity": False, "endotoxin": False, "sterility_pcr": False, "bac_water_panel": True, "samplevariance": False, "residualsolvents": False}, "analytical_test": "Bacteriostatic Water"},
            ]
        },
        sample_results={
            "1": {"senaite_id": "P-0139", "status": "created"},
            "2": {"senaite_id": "BW-0006", "status": "created"},
            "3": {"senaite_id": "BW-0007", "status": "created"},
        },
    )
    db_session.add(rec)
    await db_session.commit()

    async with AsyncClient(app=app, base_url="http://test") as ac:
        resp = await ac.get(
            "/explorer/orders/sample-services",
            params={"sample_id": "BW-0006"},
            headers={"X-API-Key": mock_api_key},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["services"]["endotoxin"] is True
    assert body["services"]["sterility_pcr"] is True
    assert body["services"]["bac_water_panel"] is True
    assert body["services"]["hplcpurity_identity"] is False
    assert body["analytical_test"] == "Bacteriostatic Water"
    assert body["wp_order_number"] == "3229"


@pytest.mark.asyncio
async def test_get_sample_services_404_when_sample_unknown(db_session, mock_api_key):
    async with AsyncClient(app=app, base_url="http://test") as ac:
        resp = await ac.get(
            "/explorer/orders/sample-services",
            params={"sample_id": "P-NOSUCH"},
            headers={"X-API-Key": mock_api_key},
        )
    assert resp.status_code == 404
```

If `mock_api_key` and `db_session` fixtures don't exist, look at the closest existing test that hits a `desktop.py` endpoint (search for `X-API-Key` in `tests/unit/`) and copy its fixture pattern. Each project has its own conftest setup.

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd integration-service
pytest tests/unit/test_api.py::test_get_sample_services_returns_200_with_services_dict -v
```

Expected: FAIL — endpoint returns 404 (not registered yet).

- [ ] **Step 3: Implement the endpoint**

In `integration-service/app/api/desktop.py`, after the existing `class` blocks at the top (alongside other response schemas around line 100), add:

```python
class SampleServicesResponse(BaseModel):
    services: dict
    analytical_test: str | None = None
    wp_order_number: str
```

Then add a new route handler (place after the existing `/orders/{order_id}` block — search for `@router.get("/orders/{order_id}"` to anchor):

```python
@router.get(
    "/orders/sample-services",
    response_model=SampleServicesResponse,
    dependencies=[Depends(verify_desktop_api_key)],
)
async def get_sample_services(
    sample_id: str = Query(..., description="SENAITE sample ID e.g. 'BW-0006'"),
    db: AsyncSession = Depends(get_db),
):
    """Resolve a SENAITE sample_id back to its WP order's per-sample services dict.

    Lookup: scan order_submissions.sample_results for the slot whose
    senaite_id matches, then return payload.samples[slot - 1].services plus
    a couple of context fields. Used by Accu-Mk1's receive wizard to compute
    vial demand for the assignment step.
    """
    stmt = (
        select(OrderSubmissionRecord)
        .where(
            OrderSubmissionRecord.sample_results.isnot(None),
            OrderSubmissionRecord.sample_results.cast(db_String).contains(sample_id),
        )
        .order_by(OrderSubmissionRecord.created_at.desc())
        .limit(5)
    )
    result = await db.execute(stmt)
    for rec in result.scalars():
        for slot_str, sr in (rec.sample_results or {}).items():
            if sr.get("senaite_id") != sample_id:
                continue
            try:
                slot = int(slot_str)
            except (TypeError, ValueError):
                continue
            samples = (rec.payload or {}).get("samples") or []
            if slot < 1 or slot > len(samples):
                continue
            sample_payload = samples[slot - 1] or {}
            return SampleServicesResponse(
                services=sample_payload.get("services") or {},
                analytical_test=sample_payload.get("analytical_test"),
                wp_order_number=rec.order_number,
            )
    raise HTTPException(
        status_code=404,
        detail=f"sample_id '{sample_id}' not found in any order submission",
    )
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
cd integration-service
pytest tests/unit/test_api.py -v -k sample_services
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add integration-service/app/api/desktop.py integration-service/tests/unit/test_api.py
git commit -m "feat(is): add /explorer/orders/sample-services for Mk1 receive wizard"
```

---

### Task 2: Mk1 — schema migration for `assignment_role` columns

**Files:**
- Modify: `Accu-Mk1/backend/database.py:_run_migrations()`

- [ ] **Step 1: Add migration entries**

In `Accu-Mk1/backend/database.py`, find `_run_migrations()` (around line 61) and append these entries to the `migrations` list (just before the closing `]` and the loop that runs them):

```python
        # Phase 25: vial assignment role columns
        # lims_samples: parent AR's role. Defaults to 'hplc' per the
        # "primary always HPLC for now" rule. Backfilled to 'hplc' for
        # all existing rows.
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS assignment_role VARCHAR(8) DEFAULT 'hplc'",
        "UPDATE lims_samples SET assignment_role = 'hplc' WHERE assignment_role IS NULL",
        # lims_sub_samples: nullable. NULL means "auto-assign hasn't run yet".
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS assignment_role VARCHAR(8)",
```

- [ ] **Step 2: Restart Mk1 backend container so migration runs**

```bash
docker compose restart accu-mk1-backend
docker logs accu-mk1-backend --tail 50 2>&1 | grep -iE "migration|alter|error" | head -20
```

Expected: no migration errors. The `_run_migrations()` log line (if any) should appear and the container should reach "Application startup complete".

- [ ] **Step 3: Verify columns exist in DB**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark_postgres psql -U postgres -d accumark_mk1 -c "\d lims_samples" | grep assignment_role
MSYS_NO_PATHCONV=1 docker exec accumark_postgres psql -U postgres -d accumark_mk1 -c "\d lims_sub_samples" | grep assignment_role
MSYS_NO_PATHCONV=1 docker exec accumark_postgres psql -U postgres -d accumark_mk1 -c "SELECT sample_id, assignment_role FROM lims_samples LIMIT 5;"
```

Expected: both `\d` calls show `assignment_role | character varying(8)` (with `'hplc'::character varying` default on lims_samples). The SELECT shows `hplc` for every existing row.

- [ ] **Step 4: Commit**

```bash
git add Accu-Mk1/backend/database.py
git commit -m "feat(mk1): add assignment_role columns to lims_samples and lims_sub_samples"
```

---

### Task 3: Mk1 — add `assignment_role` to ORM models

**Files:**
- Modify: `Accu-Mk1/backend/models.py`

- [ ] **Step 1: Find the `LimsSample` and `LimsSubSample` classes**

```bash
grep -n "class LimsSample\|class LimsSubSample" Accu-Mk1/backend/models.py
```

Expected: two line numbers. Note them.

- [ ] **Step 2: Add the columns**

In `Accu-Mk1/backend/models.py`, inside `class LimsSample`, add (alongside other Column declarations):

```python
    assignment_role = Column(String(8), nullable=False, server_default="hplc")
```

Inside `class LimsSubSample`, add:

```python
    assignment_role = Column(String(8), nullable=True)
```

Make sure `String` is already imported at the top of the file (it should be — `LimsSample.sample_id` uses it).

- [ ] **Step 3: Verify nothing crashes by importing**

```bash
docker exec accu-mk1-backend python -c "from models import LimsSample, LimsSubSample; print(LimsSample.assignment_role, LimsSubSample.assignment_role)"
```

Expected: prints two `Column(...)` reprs without error.

- [ ] **Step 4: Commit**

```bash
git add Accu-Mk1/backend/models.py
git commit -m "feat(mk1): add assignment_role attr to LimsSample and LimsSubSample"
```

---

### Task 4: Mk1 — IS client helper for sample-services

**Files:**
- Modify: `Accu-Mk1/backend/sub_samples/service.py`
- Test: `Accu-Mk1/backend/tests/test_sub_samples_service.py`

- [ ] **Step 1: Write the failing test**

Add to `Accu-Mk1/backend/tests/test_sub_samples_service.py`:

```python
from unittest.mock import patch, MagicMock
import pytest
from sub_samples import service


def _ok_response(json_body):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = json_body
    resp.raise_for_status = MagicMock()
    return resp


def _err_response(status_code):
    resp = MagicMock()
    resp.status_code = status_code
    resp.raise_for_status.side_effect = Exception(f"HTTP {status_code}")
    return resp


def test_fetch_sample_services_returns_dict(monkeypatch):
    monkeypatch.setenv("INTEGRATION_SERVICE_URL", "http://is.test")
    monkeypatch.setenv("INTEGRATION_SERVICE_API_KEY", "test-key")
    body = {
        "services": {"endotoxin": True, "sterility_pcr": True, "bac_water_panel": True, "hplcpurity_identity": False, "samplevariance": False, "residualsolvents": False},
        "analytical_test": "Bacteriostatic Water",
        "wp_order_number": "3229",
    }
    with patch("sub_samples.service.requests.get", return_value=_ok_response(body)) as gp:
        result = service.fetch_sample_services("BW-0006")
    assert result["services"]["endotoxin"] is True
    assert result["wp_order_number"] == "3229"
    gp.assert_called_once()
    call_args = gp.call_args
    assert "BW-0006" in str(call_args)
    assert call_args.kwargs["headers"]["X-API-Key"] == "test-key"


def test_fetch_sample_services_returns_none_on_404(monkeypatch):
    monkeypatch.setenv("INTEGRATION_SERVICE_URL", "http://is.test")
    monkeypatch.setenv("INTEGRATION_SERVICE_API_KEY", "test-key")
    resp = MagicMock()
    resp.status_code = 404
    with patch("sub_samples.service.requests.get", return_value=resp):
        result = service.fetch_sample_services("P-NOSUCH")
    assert result is None
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_service.py::test_fetch_sample_services_returns_dict -v
```

Expected: FAIL — `service.fetch_sample_services` doesn't exist.

- [ ] **Step 3: Add the helper**

In `Accu-Mk1/backend/sub_samples/service.py`, add at the top (after the existing imports):

```python
import os
import requests
```

(Both should already be imported in nearby files — confirm `requests` is in `service.py`'s imports; if not, add it.)

Then append at the end of the file:

```python
def fetch_sample_services(sample_id: str) -> Optional[dict]:
    """Fetch the WP `services` dict for a SENAITE sample by hitting IS.

    Returns None on 404 (sample not in any order_submissions row); raises on
    network error / non-2xx so the caller can surface 503 to the wizard.
    """
    base = os.environ.get("INTEGRATION_SERVICE_URL", "").rstrip("/")
    key = os.environ.get("INTEGRATION_SERVICE_API_KEY", "")
    if not base or not key:
        raise RuntimeError(
            "INTEGRATION_SERVICE_URL / INTEGRATION_SERVICE_API_KEY not configured"
        )
    resp = requests.get(
        f"{base}/explorer/orders/sample-services",
        params={"sample_id": sample_id},
        headers={"X-API-Key": key},
        timeout=15,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_service.py -v -k fetch_sample_services
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add Accu-Mk1/backend/sub_samples/service.py Accu-Mk1/backend/tests/test_sub_samples_service.py
git commit -m "feat(mk1): add fetch_sample_services IS client helper"
```

---

### Task 5: Mk1 — `derive_demand()` pure function

**Files:**
- Modify: `Accu-Mk1/backend/sub_samples/service.py`
- Test: `Accu-Mk1/backend/tests/test_sub_samples_service.py`

- [ ] **Step 1: Write failing tests**

Append to `Accu-Mk1/backend/tests/test_sub_samples_service.py`:

```python
def test_derive_demand_peptide_only():
    services = {"hplcpurity_identity": True, "endotoxin": False, "sterility_pcr": False, "bac_water_panel": False, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 1, "endo": 0, "ster": 0}


def test_derive_demand_bw_only():
    services = {"hplcpurity_identity": False, "endotoxin": False, "sterility_pcr": False, "bac_water_panel": True, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 1, "endo": 0, "ster": 0}


def test_derive_demand_endo_only():
    services = {"hplcpurity_identity": False, "endotoxin": True, "sterility_pcr": False, "bac_water_panel": False, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 0, "endo": 1, "ster": 0}


def test_derive_demand_ster_is_2_vials():
    services = {"hplcpurity_identity": False, "endotoxin": False, "sterility_pcr": True, "bac_water_panel": False, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 0, "endo": 0, "ster": 2}


def test_derive_demand_full_bw_all_addons():
    services = {"hplcpurity_identity": False, "endotoxin": True, "sterility_pcr": True, "bac_water_panel": True, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 1, "endo": 1, "ster": 2}


def test_derive_demand_handles_missing_keys():
    """Missing keys (older orders, partial WP responses) treat as False."""
    assert service.derive_demand({}) == {"hplc": 0, "endo": 0, "ster": 0}


def test_derive_demand_hplc_or_bw_panel():
    """HPLC bucket is satisfied by either flag; demand stays at 1 (not 2)."""
    services = {"hplcpurity_identity": True, "bac_water_panel": True, "endotoxin": False, "sterility_pcr": False, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 1, "endo": 0, "ster": 0}
```

- [ ] **Step 2: Run the tests — expect FAIL**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_service.py -v -k derive_demand
```

Expected: 7 FAILs — `service.derive_demand` doesn't exist.

- [ ] **Step 3: Implement `derive_demand`**

Append to `Accu-Mk1/backend/sub_samples/service.py`:

```python
def derive_demand(services: dict) -> dict:
    """Translate WP services dict to vial demand per bucket.

    HPLC is satisfied by either `hplcpurity_identity` or `bac_water_panel` —
    both result in chromatography vials. Sterility is the only bucket that
    needs more than one vial (2 per the lab's protocol).
    """
    hplc = bool(services.get("hplcpurity_identity") or services.get("bac_water_panel"))
    endo = bool(services.get("endotoxin"))
    ster = bool(services.get("sterility_pcr"))
    return {
        "hplc": 1 if hplc else 0,
        "endo": 1 if endo else 0,
        "ster": 2 if ster else 0,
    }
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_service.py -v -k derive_demand
```

Expected: 7 PASSes.

- [ ] **Step 5: Commit**

```bash
git add Accu-Mk1/backend/sub_samples/service.py Accu-Mk1/backend/tests/test_sub_samples_service.py
git commit -m "feat(mk1): derive_demand maps WP services to per-bucket vial counts"
```

---

### Task 6: Mk1 — `auto_assign()` pure function

**Files:**
- Modify: `Accu-Mk1/backend/sub_samples/service.py`
- Test: `Accu-Mk1/backend/tests/test_sub_samples_service.py`

- [ ] **Step 1: Write failing tests**

Append to `Accu-Mk1/backend/tests/test_sub_samples_service.py`:

```python
def _vial(sample_id, vial_seq, role=None, is_parent=False):
    return {
        "sample_id": sample_id,
        "vial_sequence": vial_seq,
        "is_parent": is_parent,
        "assignment_role": role,
    }


def test_auto_assign_full_bw_with_all_addons():
    """Parent → HPLC (already pinned), 3 sub-samples → ENDO, STER, STER."""
    demand = {"hplc": 1, "endo": 1, "ster": 2}
    vials = [
        _vial("BW-0006", 0, role="hplc", is_parent=True),
        _vial("BW-0006-S01", 1, role=None),
        _vial("BW-0006-S02", 2, role=None),
        _vial("BW-0006-S03", 3, role=None),
    ]
    result = service.auto_assign(vials, demand)
    assert [v["assignment_role"] for v in result] == ["hplc", "endo", "ster", "ster"]


def test_auto_assign_skips_existing_overrides():
    """A vial with an explicit role keeps it; demand is decremented if it
    matches a real bucket."""
    demand = {"hplc": 1, "endo": 1, "ster": 2}
    vials = [
        _vial("BW-0006", 0, role="hplc", is_parent=True),
        _vial("BW-0006-S01", 1, role="ster"),  # tech pre-assigned this to STER
        _vial("BW-0006-S02", 2, role=None),
        _vial("BW-0006-S03", 3, role=None),
    ]
    result = service.auto_assign(vials, demand)
    # S01 stays STER (user override), S02 fills remaining STER slot, S03 fills ENDO
    assert [v["assignment_role"] for v in result] == ["hplc", "ster", "ster", "endo"]


def test_auto_assign_surplus_vials_go_to_xtra():
    """Demand met → remaining vials land in xtra."""
    demand = {"hplc": 1, "endo": 0, "ster": 0}
    vials = [
        _vial("P-0139", 0, role="hplc", is_parent=True),
        _vial("P-0139-S01", 1, role=None),
        _vial("P-0139-S02", 2, role=None),
    ]
    result = service.auto_assign(vials, demand)
    assert [v["assignment_role"] for v in result] == ["hplc", "xtra", "xtra"]


def test_auto_assign_short_demand_leaves_unfilled():
    """If demand exceeds vials, the unfilled slots just... don't get a vial.
    auto_assign doesn't conjure phantom vials. (UI shows amber warning.)"""
    demand = {"hplc": 1, "endo": 1, "ster": 2}
    vials = [
        _vial("BW-0006", 0, role="hplc", is_parent=True),
        _vial("BW-0006-S01", 1, role=None),
    ]
    result = service.auto_assign(vials, demand)
    # Only 2 vials, but demand was 4. S01 → ENDO (priority order). HPLC met by parent.
    assert [v["assignment_role"] for v in result] == ["hplc", "endo"]
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_service.py -v -k auto_assign
```

Expected: 4 FAILs — `service.auto_assign` doesn't exist.

- [ ] **Step 3: Implement `auto_assign`**

Append to `Accu-Mk1/backend/sub_samples/service.py`:

```python
_BUCKET_PRIORITY = ("hplc", "endo", "ster")
_REAL_BUCKETS = {"hplc", "endo", "ster"}


def auto_assign(vials: list[dict], demand: dict) -> list[dict]:
    """Pure function: assign roles in-place to a list of vial dicts.

    Mutates vial['assignment_role'] for any vial where it is None. Vials
    whose role is already set are skipped — but their bucket counts toward
    decrementing demand so we don't double-fill.

    Vials are processed in input order (which the caller orders by
    vial_sequence with parent first).

    Vials that don't fit any remaining demand land in 'xtra'.
    """
    remaining = dict(demand)  # copy so we don't mutate caller's dict
    out = []
    for vial in vials:
        role = vial.get("assignment_role")
        if role in _REAL_BUCKETS and remaining.get(role, 0) > 0:
            remaining[role] -= 1
        elif role is None:
            assigned = None
            for bucket in _BUCKET_PRIORITY:
                if remaining.get(bucket, 0) > 0:
                    assigned = bucket
                    remaining[bucket] -= 1
                    break
            if assigned is None:
                assigned = "xtra"
            vial = {**vial, "assignment_role": assigned}
        # role is non-None and either xtra or matches a saturated bucket —
        # leave alone.
        out.append(vial)
    return out
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_service.py -v -k auto_assign
```

Expected: 4 PASSes.

- [ ] **Step 5: Commit**

```bash
git add Accu-Mk1/backend/sub_samples/service.py Accu-Mk1/backend/tests/test_sub_samples_service.py
git commit -m "feat(mk1): auto_assign computes role per vial respecting overrides"
```

---

### Task 7: Mk1 — `GET /api/sub-samples/{parent}/vial-plan` endpoint

**Files:**
- Modify: `Accu-Mk1/backend/sub_samples/service.py` (add DB-aware wrapper)
- Modify: `Accu-Mk1/backend/sub_samples/schemas.py`
- Modify: `Accu-Mk1/backend/sub_samples/routes.py`
- Test: `Accu-Mk1/backend/tests/test_sub_samples_routes.py`

- [ ] **Step 1: Add response schemas**

In `Accu-Mk1/backend/sub_samples/schemas.py`, append:

```python
class VialPlanItem(BaseModel):
    sample_id: str
    is_parent: bool
    vial_sequence: int
    assignment_role: Optional[str]


class VialPlanResponse(BaseModel):
    demand: dict
    wp_order_number: Optional[str] = None
    vials: list[VialPlanItem]
    is_unreachable: bool = False


class AssignmentPatchRequest(BaseModel):
    role: Optional[str]  # 'hplc' | 'endo' | 'ster' | 'xtra' | None
```

- [ ] **Step 2: Write the failing route test**

Add to `Accu-Mk1/backend/tests/test_sub_samples_routes.py`:

```python
def test_vial_plan_returns_full_layout():
    """GET /api/sub-samples/{parent}/vial-plan returns demand + per-vial roles."""
    parent = MagicMock()
    parent.sample_id = "BW-0006"
    parent.assignment_role = "hplc"
    sub1 = _mock_sub("BW-0006-S01", "BW-0006", vial_seq=1)
    sub1.assignment_role = None
    sub2 = _mock_sub("BW-0006-S02", "BW-0006", vial_seq=2)
    sub2.assignment_role = None
    sub3 = _mock_sub("BW-0006-S03", "BW-0006", vial_seq=3)
    sub3.assignment_role = None

    services_response = {
        "services": {"hplcpurity_identity": False, "endotoxin": True, "sterility_pcr": True, "bac_water_panel": True, "samplevariance": False, "residualsolvents": False},
        "analytical_test": "Bacteriostatic Water",
        "wp_order_number": "3229",
    }
    with patch("sub_samples.routes.service.compute_vial_plan", return_value={
        "demand": {"hplc": 1, "endo": 1, "ster": 2},
        "wp_order_number": "3229",
        "vials": [
            {"sample_id": "BW-0006",     "is_parent": True,  "vial_sequence": 0, "assignment_role": "hplc"},
            {"sample_id": "BW-0006-S01", "is_parent": False, "vial_sequence": 1, "assignment_role": "endo"},
            {"sample_id": "BW-0006-S02", "is_parent": False, "vial_sequence": 2, "assignment_role": "ster"},
            {"sample_id": "BW-0006-S03", "is_parent": False, "vial_sequence": 3, "assignment_role": "ster"},
        ],
        "is_unreachable": False,
    }):
        resp = client.get("/api/sub-samples/BW-0006/vial-plan")
    assert resp.status_code == 200
    body = resp.json()
    assert body["demand"] == {"hplc": 1, "endo": 1, "ster": 2}
    assert body["wp_order_number"] == "3229"
    assert len(body["vials"]) == 4
    assert body["vials"][0]["is_parent"] is True
    assert body["vials"][1]["assignment_role"] == "endo"


def test_vial_plan_returns_503_envelope_when_is_unreachable():
    with patch("sub_samples.routes.service.compute_vial_plan", return_value={
        "demand": {"hplc": 0, "endo": 0, "ster": 0},
        "wp_order_number": None,
        "vials": [
            {"sample_id": "BW-0006", "is_parent": True, "vial_sequence": 0, "assignment_role": "hplc"},
        ],
        "is_unreachable": True,
    }):
        resp = client.get("/api/sub-samples/BW-0006/vial-plan")
    assert resp.status_code == 200  # body envelope, not http 503 — wizard banner-renders
    body = resp.json()
    assert body["is_unreachable"] is True
    assert body["demand"] == {"hplc": 0, "endo": 0, "ster": 0}
```

- [ ] **Step 3: Run — expect FAIL**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_routes.py -v -k vial_plan
```

Expected: FAIL — endpoint not registered + `compute_vial_plan` doesn't exist.

- [ ] **Step 4: Implement `service.compute_vial_plan`**

In `Accu-Mk1/backend/sub_samples/service.py`, append:

```python
def compute_vial_plan(db: Session, parent_sample_id: str) -> dict:
    """Resolve services from IS, run auto-assign, persist new roles, return plan.

    Returns a dict matching VialPlanResponse. If IS is unreachable, returns
    `is_unreachable=True` with empty demand and all current roles preserved
    (no auto-assign mutation).
    """
    parent = ensure_sample_row(db, parent_sample_id)
    subs = list(parent.sub_samples)
    subs.sort(key=lambda s: s.vial_sequence)

    # Try IS — fail soft on any error (wizard handles via banner)
    try:
        services_resp = fetch_sample_services(parent_sample_id)
    except Exception as e:
        log.warning("vial_plan.is_fetch_failed parent=%s err=%s", parent_sample_id, e)
        services_resp = None

    if services_resp is None:
        return {
            "demand": {"hplc": 0, "endo": 0, "ster": 0},
            "wp_order_number": None,
            "is_unreachable": True,
            "vials": [
                {
                    "sample_id": parent.sample_id,
                    "is_parent": True,
                    "vial_sequence": 0,
                    "assignment_role": parent.assignment_role or "hplc",
                }
            ] + [
                {
                    "sample_id": s.sample_id,
                    "is_parent": False,
                    "vial_sequence": s.vial_sequence,
                    "assignment_role": s.assignment_role,
                }
                for s in subs
            ],
        }

    demand = derive_demand(services_resp.get("services") or {})

    # Build vial list with parent first, then sub-samples in vial_sequence order.
    # Parent's assignment_role is never NULL (default 'hplc' from migration).
    vials = [
        {
            "sample_id": parent.sample_id,
            "is_parent": True,
            "vial_sequence": 0,
            "assignment_role": parent.assignment_role or "hplc",
        }
    ] + [
        {
            "sample_id": s.sample_id,
            "is_parent": False,
            "vial_sequence": s.vial_sequence,
            "assignment_role": s.assignment_role,
        }
        for s in subs
    ]

    assigned = auto_assign(vials, demand)

    # Persist newly-set roles for sub-samples (parent never NULLs, so we never
    # write back to lims_samples here — Reset-to-auto goes through the PATCH endpoint).
    sub_by_id = {s.sample_id: s for s in subs}
    for v in assigned:
        if v["is_parent"]:
            continue
        original = sub_by_id.get(v["sample_id"])
        if original is None:
            continue
        if original.assignment_role != v["assignment_role"]:
            original.assignment_role = v["assignment_role"]
    db.commit()

    return {
        "demand": demand,
        "wp_order_number": services_resp.get("wp_order_number"),
        "is_unreachable": False,
        "vials": assigned,
    }
```

- [ ] **Step 5: Add the route**

In `Accu-Mk1/backend/sub_samples/routes.py`, after the existing `delete_sub_sample` handler, add:

```python
from sub_samples.schemas import (  # noqa: F401  -- extend the existing import
    VialPlanResponse, VialPlanItem, AssignmentPatchRequest,
)


@router.get("/{parent_sample_id}/vial-plan", response_model=VialPlanResponse)
def get_vial_plan(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Return per-vial assignment for the parent's full vial set.

    Side-effect: runs auto-assign for any sub-sample with NULL assignment_role,
    persisting the result. Subsequent calls with the same DB state are
    idempotent.
    """
    plan = service.compute_vial_plan(db, parent_sample_id)
    return VialPlanResponse(**plan)
```

(Make sure to also extend the existing `from sub_samples.schemas import (...)` block at the top with the three new symbols rather than adding a duplicate import.)

- [ ] **Step 6: Run route tests — expect PASS**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_routes.py -v -k vial_plan
```

Expected: both tests PASS.

- [ ] **Step 7: Commit**

```bash
git add Accu-Mk1/backend/sub_samples/
git commit -m "feat(mk1): add /api/sub-samples/{parent}/vial-plan endpoint"
```

---

### Task 8: Mk1 — `PATCH /api/sub-samples/{sample_id}/assignment` endpoint

**Files:**
- Modify: `Accu-Mk1/backend/sub_samples/service.py`
- Modify: `Accu-Mk1/backend/sub_samples/routes.py`
- Test: `Accu-Mk1/backend/tests/test_sub_samples_routes.py`

- [ ] **Step 1: Write failing tests**

Add to `Accu-Mk1/backend/tests/test_sub_samples_routes.py`:

```python
def test_assignment_patch_subsample_to_endo():
    sub = _mock_sub("BW-0006-S01", "BW-0006", vial_seq=1)
    sub.assignment_role = "ster"
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006-S01", "assignment_role": "endo"}
        resp = client.patch(
            "/api/sub-samples/BW-0006-S01/assignment",
            json={"role": "endo"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"sample_id": "BW-0006-S01", "assignment_role": "endo"}
    fn.assert_called_once()
    args, kwargs = fn.call_args
    assert kwargs.get("sample_id") or args[1] == "BW-0006-S01"
    assert kwargs.get("role") or args[2] == "endo"


def test_assignment_patch_subsample_null_resets():
    """null role on a sub-sample sets assignment_role=NULL (auto-assign on next plan call)."""
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006-S01", "assignment_role": None}
        resp = client.patch(
            "/api/sub-samples/BW-0006-S01/assignment",
            json={"role": None},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["assignment_role"] is None


def test_assignment_patch_parent_null_coerced_to_hplc():
    """null role on the parent AR is coerced to 'hplc' — preserves the
    'primary always HPLC' rule even after Reset-to-auto."""
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006", "assignment_role": "hplc"}
        resp = client.patch(
            "/api/sub-samples/BW-0006/assignment",
            json={"role": None},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["assignment_role"] == "hplc"
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_routes.py -v -k assignment_patch
```

Expected: FAIL — `service.set_assignment_role` doesn't exist + endpoint not registered.

- [ ] **Step 3: Implement `service.set_assignment_role`**

Append to `Accu-Mk1/backend/sub_samples/service.py`:

```python
_VALID_ROLES = {"hplc", "endo", "ster", "xtra"}


def set_assignment_role(db: Session, sample_id: str, role: Optional[str]) -> dict:
    """Set assignment_role on a sub-sample or parent. Routes by sample existence.

    For sub-samples: role can be None (resets, next /vial-plan auto-assigns).
    For parent (lims_samples): None is coerced to 'hplc' (parent never goes NULL).
    """
    if role is not None and role not in _VALID_ROLES:
        raise ValueError(f"Invalid role: {role!r}")

    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sub is not None:
        sub.assignment_role = role
        db.commit()
        return {"sample_id": sample_id, "assignment_role": role}

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise LookupError(f"No sample or sub-sample with sample_id={sample_id}")
    coerced = role if role in _VALID_ROLES else "hplc"
    parent.assignment_role = coerced
    db.commit()
    return {"sample_id": sample_id, "assignment_role": coerced}
```

(Add `from models import LimsSample, LimsSubSample` at the top if not already imported.)

- [ ] **Step 4: Add the route**

In `Accu-Mk1/backend/sub_samples/routes.py`, after the `vial-plan` handler:

```python
@router.patch("/{sample_id}/assignment")
def patch_assignment(
    sample_id: str,
    body: AssignmentPatchRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Set the assignment_role on a vial.

    - Sub-samples: role may be null (resets to auto-assign on next /vial-plan).
    - Parent AR: null role is coerced to 'hplc' (preserves "primary always HPLC").
    """
    try:
        return service.set_assignment_role(db, sample_id, body.role)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd Accu-Mk1
pytest backend/tests/test_sub_samples_routes.py -v -k assignment_patch
```

Expected: 3 PASSes.

- [ ] **Step 6: Commit**

```bash
git add Accu-Mk1/backend/sub_samples/
git commit -m "feat(mk1): add PATCH /api/sub-samples/{id}/assignment with parent null-coercion"
```

---

### Task 9: Frontend — typed API wrappers

**Files:**
- Modify: `Accu-Mk1/src/lib/api.ts`

- [ ] **Step 1: Add types and wrapper functions**

In `Accu-Mk1/src/lib/api.ts`, find the existing sub-sample types (search for `interface SubSample`) and add nearby:

```ts
export type AssignmentRole = 'hplc' | 'endo' | 'ster' | 'xtra'

export interface VialPlanItem {
  sample_id: string
  is_parent: boolean
  vial_sequence: number
  assignment_role: AssignmentRole | null
}

export interface VialPlanResponse {
  demand: { hplc: number; endo: number; ster: number }
  wp_order_number: string | null
  vials: VialPlanItem[]
  is_unreachable: boolean
}
```

Then add two wrapper functions (place near the existing `listSubSamples` / `createSubSample` exports):

```ts
export async function getVialPlan(parentSampleId: string): Promise<VialPlanResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/sub-samples/${encodeURIComponent(parentSampleId)}/vial-plan`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Vial plan fetch failed: ${response.status}`)
  }
  return response.json()
}

export async function patchVialAssignment(
  sampleId: string,
  role: AssignmentRole | null,
): Promise<{ sample_id: string; assignment_role: AssignmentRole | null }> {
  const response = await fetch(
    `${API_BASE_URL()}/sub-samples/${encodeURIComponent(sampleId)}/assignment`,
    {
      method: 'PATCH',
      headers: { ...getBearerHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Vial assignment update failed: ${response.status}`)
  }
  return response.json()
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd Accu-Mk1
docker exec accu-mk1-frontend npx tsc --noEmit
```

Expected: no new errors. (Pre-existing errors in unrelated files are fine.)

- [ ] **Step 3: Commit**

```bash
git add Accu-Mk1/src/lib/api.ts
git commit -m "feat(mk1-fe): add getVialPlan and patchVialAssignment client wrappers"
```

---

### Task 10: Frontend — install `@dnd-kit` and create `AssignStep`

**Files:**
- Modify: `Accu-Mk1/package.json`
- Create: `Accu-Mk1/src/components/intake/ReceiveWizard/AssignStep.tsx`
- Create: `Accu-Mk1/src/components/intake/ReceiveWizard/AssignStep.css`

- [ ] **Step 1: Install dnd-kit**

```bash
cd Accu-Mk1
docker exec accu-mk1-frontend npm install @dnd-kit/core @dnd-kit/sortable
```

Expected: package.json picks up both deps. Confirm with `grep dnd-kit Accu-Mk1/package.json`.

- [ ] **Step 2: Create AssignStep.tsx**

Create `Accu-Mk1/src/components/intake/ReceiveWizard/AssignStep.tsx`:

```tsx
import { useEffect, useState, useCallback } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core'
import { Loader2, RotateCcw } from 'lucide-react'
import {
  getVialPlan,
  patchVialAssignment,
  type VialPlanResponse,
  type VialPlanItem,
  type AssignmentRole,
} from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  parentSampleId: string
}

const ROLE_SHORT: Record<string, string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'STERYL',
  xtra: 'XTRA',
}

type BucketId = AssignmentRole

interface BucketSpec {
  id: BucketId
  label: string
  demandKey: 'hplc' | 'endo' | 'ster' | null  // null for xtra (no demand)
}

export function AssignStep({ parentSampleId }: Props) {
  const [plan, setPlan] = useState<VialPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getVialPlan(parentSampleId)
      setPlan(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [parentSampleId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (!plan) return
      const sampleId = String(event.active.id)
      const target = event.over?.id ? (String(event.over.id) as BucketId) : null
      if (!target) return
      // Optimistic update
      const next = {
        ...plan,
        vials: plan.vials.map(v =>
          v.sample_id === sampleId ? { ...v, assignment_role: target } : v
        ),
      }
      setPlan(next)
      try {
        await patchVialAssignment(sampleId, target)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        // Roll back by re-fetching
        void refresh()
      }
    },
    [plan, refresh],
  )

  const handleResetBucket = useCallback(
    async (bucket: BucketId) => {
      if (!plan) return
      const inBucket = plan.vials.filter(
        v => v.assignment_role === bucket && !v.is_parent
      )
      // Null each (PATCH null) — IS-side default coerces parent if it's caught here
      await Promise.all(
        inBucket.map(v => patchVialAssignment(v.sample_id, null))
      )
      void refresh()
    },
    [plan, refresh],
  )

  if (loading && !plan) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (error && !plan) {
    return <div className="p-6 text-destructive text-sm">Error: {error}</div>
  }
  if (!plan) return null

  // Build the bucket list. Microbiology section hidden if neither addon present.
  const showMicro = (plan.demand.endo + plan.demand.ster) > 0 ||
    plan.vials.some(v => v.assignment_role === 'endo' || v.assignment_role === 'ster')
  const showHplc = plan.demand.hplc > 0 ||
    plan.vials.some(v => v.assignment_role === 'hplc')
  // Xtra always shown when there are surplus vials, otherwise hidden
  const showXtra = plan.vials.some(v => v.assignment_role === 'xtra') || true

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="p-6">
        {plan.is_unreachable && (
          <div className="mb-4 p-3 rounded border border-amber-500/40 bg-amber-500/10 text-sm">
            Couldn't load order services from integration service — auto-assign skipped.
            Drag vials manually. Print still works.
          </div>
        )}
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `${showHplc ? '1fr ' : ''}${showMicro ? '1.2fr ' : ''}0.8fr`.trim(),
          }}
        >
          {showHplc && (
            <Bucket
              id="hplc"
              label="Analyses Dept."
              vials={plan.vials.filter(v => v.assignment_role === 'hplc')}
              demand={plan.demand.hplc}
              onReset={() => handleResetBucket('hplc')}
            />
          )}
          {showMicro && (
            <MicroBucket
              endo={plan.vials.filter(v => v.assignment_role === 'endo')}
              ster={plan.vials.filter(v => v.assignment_role === 'ster')}
              endoDemand={plan.demand.endo}
              sterDemand={plan.demand.ster}
              onResetEndo={() => handleResetBucket('endo')}
              onResetSter={() => handleResetBucket('ster')}
            />
          )}
          {showXtra && (
            <Bucket
              id="xtra"
              label="Xtra"
              vials={plan.vials.filter(v => v.assignment_role === 'xtra')}
              demand={null}
              onReset={null}
            />
          )}
        </div>
      </div>
    </DndContext>
  )
}

function Bucket({
  id, label, vials, demand, onReset,
}: {
  id: BucketId
  label: string
  vials: VialPlanItem[]
  demand: number | null
  onReset: (() => void) | null
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const isShort = demand !== null && vials.length < demand
  const isFull = demand !== null && vials.length === demand

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'border-2 rounded-lg p-3 min-h-[120px] transition-colors',
        isOver
          ? 'border-primary bg-primary/5'
          : isFull
          ? 'border-solid border-primary/45'
          : isShort
          ? 'border-dashed border-amber-500/55 bg-amber-500/5'
          : 'border-dashed border-muted-foreground/35'
      )}
    >
      <header className="flex justify-between items-baseline mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        <strong className="text-foreground font-semibold">{label}</strong>
        <div className="flex items-center gap-2">
          {demand !== null && (
            <span className={cn(isShort && 'text-amber-500')}>
              {vials.length} / {demand}
              {isShort && ` — need ${demand - vials.length} more`}
            </span>
          )}
          {demand === null && <span>{vials.length}</span>}
          {onReset && vials.length > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="text-[10px] underline hover:text-foreground"
              title="Reset to auto-assign"
            >
              <RotateCcw className="w-3 h-3 inline" /> reset
            </button>
          )}
        </div>
      </header>
      <div className="flex flex-wrap gap-2">
        {vials.length === 0 && (
          <p className="text-xs text-muted-foreground italic">empty</p>
        )}
        {vials.map(v => <DraggableVial key={v.sample_id} vial={v} />)}
      </div>
    </div>
  )
}

function MicroBucket({
  endo, ster, endoDemand, sterDemand, onResetEndo, onResetSter,
}: {
  endo: VialPlanItem[]
  ster: VialPlanItem[]
  endoDemand: number
  sterDemand: number
  onResetEndo: () => void
  onResetSter: () => void
}) {
  const totalAssigned = endo.length + ster.length
  const totalDemand = endoDemand + sterDemand
  const isShort = totalAssigned < totalDemand

  return (
    <div
      className={cn(
        'border-2 rounded-lg p-3 min-h-[120px]',
        totalAssigned === totalDemand && totalDemand > 0
          ? 'border-solid border-primary/45'
          : isShort
          ? 'border-dashed border-amber-500/55 bg-amber-500/5'
          : 'border-dashed border-muted-foreground/35'
      )}
    >
      <header className="flex justify-between items-baseline mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        <strong className="text-foreground font-semibold">Microbiology</strong>
        <span className={cn(isShort && 'text-amber-500')}>
          {totalAssigned} / {totalDemand}
        </span>
      </header>
      {endoDemand > 0 && (
        <SubDropZone
          id="endo"
          label="Endo"
          vials={endo}
          demand={endoDemand}
          onReset={onResetEndo}
        />
      )}
      {sterDemand > 0 && (
        <SubDropZone
          id="ster"
          label="Sterility"
          vials={ster}
          demand={sterDemand}
          onReset={onResetSter}
        />
      )}
      {endoDemand === 0 && sterDemand === 0 && (
        <p className="text-xs text-muted-foreground italic">no addons</p>
      )}
    </div>
  )
}

function SubDropZone({
  id, label, vials, demand, onReset,
}: {
  id: BucketId
  label: string
  vials: VialPlanItem[]
  demand: number
  onReset: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const isShort = vials.length < demand

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'pl-3 mt-2 border-l-2 transition-colors',
        isOver ? 'border-l-primary' : 'border-l-primary/25'
      )}
    >
      <div className={cn(
        'text-[10px] uppercase tracking-wide mb-1 flex justify-between',
        isShort ? 'text-amber-500' : 'text-muted-foreground'
      )}>
        <span>{label} · {vials.length} / {demand}{isShort && ' ⚠'}</span>
        {vials.length > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="underline hover:text-foreground"
          >
            <RotateCcw className="w-3 h-3 inline" /> reset
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {vials.map(v => <DraggableVial key={v.sample_id} vial={v} />)}
      </div>
    </div>
  )
}

function DraggableVial({ vial }: { vial: VialPlanItem }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: vial.sample_id,
  })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined
  const role = vial.assignment_role ?? 'xtra'
  const roleColor = (
    role === 'hplc' ? 'bg-sky-400/25 text-sky-300' :
    role === 'endo' || role === 'ster' ? 'bg-violet-400/25 text-violet-300' :
    'bg-pink-400/25 text-pink-300'
  )
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={cn(
        'inline-flex items-center gap-2 px-2 py-1 rounded border text-xs font-mono cursor-grab active:cursor-grabbing select-none',
        vial.is_parent
          ? 'bg-teal-500/10 border-teal-500/45'
          : 'bg-indigo-500/10 border-indigo-500/35',
        isDragging && 'opacity-40'
      )}
    >
      <span>{vial.sample_id}</span>
      <span className={cn('text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wide', roleColor)}>
        {ROLE_SHORT[role]}
      </span>
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd Accu-Mk1
docker exec accu-mk1-frontend npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add Accu-Mk1/package.json Accu-Mk1/package-lock.json Accu-Mk1/src/components/intake/ReceiveWizard/AssignStep.tsx
git commit -m "feat(mk1-fe): AssignStep with bucket layout and DnD via @dnd-kit"
```

---

### Task 11: Wire `'assign'` phase into ReceiveWizard

**Files:**
- Modify: `Accu-Mk1/src/components/intake/ReceiveWizard/ReceiveWizard.tsx`

- [ ] **Step 1: Update phase enum and conditional render**

Replace the contents of `Accu-Mk1/src/components/intake/ReceiveWizard/ReceiveWizard.tsx` with:

```tsx
import { useState } from 'react'
import { Printer, Check, ArrowRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useReceiveWizard, type ParentInfo } from './useReceiveWizard'
import { useParentSampleDetails } from './useParentSampleDetails'
import { WizardSidebar } from './WizardSidebar'
import { VialPanel } from './VialPanel'
import { PrintStep } from './PrintStep'
import { AssignStep } from './AssignStep'

interface Props {
  parent: ParentInfo
  onClose: () => void
}

type Phase = 'capture' | 'assign' | 'print'

export function ReceiveWizard({ parent, onClose }: Props) {
  const wiz = useReceiveWizard(parent)
  const parentDetails = useParentSampleDetails(parent.sample_id)
  const [phase, setPhase] = useState<Phase>('capture')
  const [editingSampleId, setEditingSampleId] = useState<string | null>(null)

  if (phase === 'assign') {
    return (
      <div className="grid grid-rows-[1fr_auto] h-full min-h-[500px]">
        <div className="overflow-y-auto">
          <AssignStep parentSampleId={parent.sample_id} />
        </div>
        <footer className="flex justify-between gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
          <Button type="button" variant="outline" onClick={() => setPhase('capture')}>
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Back
          </Button>
          <Button type="button" onClick={() => setPhase('print')}>
            <Printer className="w-4 h-4" aria-hidden="true" />
            Print labels
          </Button>
        </footer>
      </div>
    )
  }

  if (phase === 'print') {
    const printList = wiz.parentReceivedThisSession
      ? [{ sample_id: parent.sample_id }, ...wiz.sessionVials]
      : wiz.sessionVials
    return (
      <PrintStep
        parentSampleId={parent.sample_id}
        vials={printList}
        orderNumber={parentDetails.details?.client_order_number ?? null}
        onDone={onClose}
      />
    )
  }

  const editingSub = editingSampleId
    ? (wiz.vials.find(v => v.sub.sample_id === editingSampleId)?.sub ?? null)
    : null

  const hasSessionVials = wiz.sessionVials.length > 0 || wiz.parentReceivedThisSession

  return (
    <div className="grid grid-rows-[1fr_auto] h-full min-h-[500px]">
      <div className="grid grid-cols-[260px_1fr] min-h-0 overflow-hidden">
        <WizardSidebar
          vials={wiz.vials}
          parentVial={
            wiz.parentReceived
              ? {
                  sampleId: parent.sample_id,
                  receivedThisSession: wiz.parentReceivedThisSession,
                }
              : null
          }
          activeSampleId={editingSampleId}
          onSelect={setEditingSampleId}
          parentDetails={parentDetails.details}
          parentDetailsLoading={parentDetails.loading}
          parentDetailsError={parentDetails.error}
        />
        <VialPanel
          parentSampleId={parent.sample_id}
          parentDetails={parentDetails.details}
          editingSub={editingSub}
          loading={wiz.loading}
          error={wiz.error}
          onSaveNew={async (photoBytes, remarks) => {
            const sub = await wiz.saveNewVial(photoBytes, remarks)
            setEditingSampleId(null)
            return sub
          }}
          onSaveEdit={async (sid, photoBytes, remarks) => {
            await wiz.editSessionVial(sid, photoBytes, remarks)
            setEditingSampleId(null)
          }}
          onDelete={async sid => {
            await wiz.deleteSessionVial(sid)
            setEditingSampleId(null)
          }}
        />
      </div>
      <footer className="flex justify-end gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        <Button
          type="button"
          variant="outline"
          onClick={() => setPhase('assign')}
          disabled={!hasSessionVials}
          title={hasSessionVials ? undefined : 'Save at least one vial first'}
          className="disabled:opacity-50"
        >
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
          Continue
        </Button>
        <Button type="button" onClick={onClose}>
          <Check className="w-4 h-4" aria-hidden="true" />
          Finished
        </Button>
      </footer>
    </div>
  )
}
```

(Note: PrintStep now takes a new `parentSampleId` prop — that's added in Task 13.)

- [ ] **Step 2: Verify TypeScript still compiles after PrintStep prop is added**

This step's tsc check is deferred to Task 13 since `PrintStep`'s signature changes there.

- [ ] **Step 3: Commit**

```bash
git add Accu-Mk1/src/components/intake/ReceiveWizard/ReceiveWizard.tsx
git commit -m "feat(mk1-fe): wire 'assign' phase between capture and print in ReceiveWizard"
```

---

### Task 12: Sidebar — role badge per vial

**Files:**
- Modify: `Accu-Mk1/src/components/intake/ReceiveWizard/WizardSidebar.tsx`

- [ ] **Step 1: Add role badges**

In `Accu-Mk1/src/components/intake/ReceiveWizard/WizardSidebar.tsx`, modify the type and rendering:

Find the `WizardSidebarProps` interface and update the `vials` field type to include `assignment_role`:

```ts
interface WizardSidebarProps {
  vials: { sub: SubSample & { assignment_role?: string | null }; isThisSession: boolean }[]
  // ... rest unchanged
}
```

(If `SubSample` already includes `assignment_role` from a shared type, drop the intersection.)

Inside the `vials.map(v => ...)` rendering for editable vials, after the `<div className="text-xs text-muted-foreground">Vial {v.sub.vial_sequence + 1}</div>` line, add a role badge when present:

```tsx
                  <div className="text-xs text-muted-foreground">
                    Vial {v.sub.vial_sequence + 1}
                  </div>
                  {v.sub.assignment_role && (
                    <span className="inline-block mt-1 text-[9px] px-1.5 py-0.5 rounded bg-muted/50 uppercase tracking-wide font-mono">
                      {v.sub.assignment_role === 'ster' ? 'STERYL' : v.sub.assignment_role.toUpperCase()}
                    </span>
                  )}
```

Apply the same change inside the `read-only` branch a few lines below.

- [ ] **Step 2: Update `useReceiveWizard` to surface `assignment_role`**

Open `Accu-Mk1/src/components/intake/ReceiveWizard/useReceiveWizard.ts`. The hook already returns sub-samples that come from `listSubSamples` (api.ts). Confirm the API response includes `assignment_role`:

```bash
grep -n assignment_role Accu-Mk1/src/lib/api.ts
```

If the existing `SubSample` type in `api.ts` does NOT already have `assignment_role`, add it to the interface (search for `interface SubSample` in `api.ts`):

```ts
export interface SubSample {
  // ... existing fields
  assignment_role?: 'hplc' | 'endo' | 'ster' | 'xtra' | null
}
```

And ensure the Mk1 backend's `_serialize` in `sub_samples/routes.py` includes the field. Check `SubSampleResponse` in `sub_samples/schemas.py` — if it doesn't have `assignment_role`, add it:

```python
class SubSampleResponse(BaseModel):
    # ... existing fields
    assignment_role: Optional[str] = None
```

And update `_serialize`:

```python
def _serialize(sub) -> SubSampleResponse:
    return SubSampleResponse(
        # ... existing fields
        assignment_role=sub.assignment_role,
    )
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd Accu-Mk1
docker exec accu-mk1-frontend npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add Accu-Mk1/src/components/intake/ReceiveWizard/WizardSidebar.tsx Accu-Mk1/src/lib/api.ts Accu-Mk1/backend/sub_samples/schemas.py Accu-Mk1/backend/sub_samples/routes.py
git commit -m "feat(mk1): surface assignment_role on /sub-samples list and badge it in sidebar"
```

---

### Task 13: Labels — third line + vial position

**Files:**
- Modify: `Accu-Mk1/src/components/intake/ReceiveWizard/LabelTemplate.tsx`
- Modify: `Accu-Mk1/src/components/intake/ReceiveWizard/PrintStep.tsx`
- Modify: `Accu-Mk1/src/components/intake/ReceiveWizard/PrintStep.css`

- [ ] **Step 1: Extend LabelTemplate**

Replace `Accu-Mk1/src/components/intake/ReceiveWizard/LabelTemplate.tsx` with:

```tsx
import { QRCodeSVG } from 'qrcode.react'

const ROLE_SHORT: Record<string, string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'STERYL',
  xtra: 'XTRA',
}

interface Props {
  sampleId: string
  /** WP-XXXX style client order number, optional. */
  orderNumber?: string | null
  /** 1-based vial position within this parent's vial set; optional. */
  vialPosition?: number | null
  /** Total vials in this parent's set (parent + sub-samples); optional. */
  vialTotal?: number | null
  /** Role from assignment step. If present, renders as 3rd line. */
  role?: 'hplc' | 'endo' | 'ster' | 'xtra' | null
}

export function LabelTemplate({ sampleId, orderNumber, vialPosition, vialTotal, role }: Props) {
  const roleText = role ? ROLE_SHORT[role] : null
  return (
    <div className="label">
      <QRCodeSVG value={sampleId} size={96} level="M" marginSize={0} />
      <div className="label-text">
        <div className="label-id">{sampleId}</div>
        {orderNumber && (
          <div className="label-order">
            {orderNumber}
            {vialPosition && vialTotal && ` · Vial ${vialPosition}/${vialTotal}`}
          </div>
        )}
        {roleText && <div className="label-role">{roleText}</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Update PrintStep to pass the new props**

Replace `Accu-Mk1/src/components/intake/ReceiveWizard/PrintStep.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LabelTemplate } from './LabelTemplate'
import { getVialPlan, type VialPlanItem } from '@/lib/api'
import './PrintStep.css'

interface PrintLabel {
  sample_id: string
}

interface Props {
  parentSampleId: string
  vials: PrintLabel[]
  orderNumber?: string | null
  onDone: () => void
}

export function PrintStep({ parentSampleId, vials, orderNumber, onDone }: Props) {
  const [planByVial, setPlanByVial] = useState<Record<string, VialPlanItem>>({})
  const [vialTotal, setVialTotal] = useState<number | null>(null)

  // Pull vial-plan to enrich each label with assignment_role + vial position.
  // Soft fail: if plan isn't available, labels print without role/position.
  useEffect(() => {
    let cancelled = false
    void getVialPlan(parentSampleId)
      .then(plan => {
        if (cancelled) return
        const lookup: Record<string, VialPlanItem> = {}
        plan.vials.forEach(v => { lookup[v.sample_id] = v })
        setPlanByVial(lookup)
        setVialTotal(plan.vials.length)
      })
      .catch(() => {
        // intentional: print proceeds without role enrichment
      })
    return () => { cancelled = true }
  }, [parentSampleId])

  useEffect(() => {
    const t = setTimeout(() => window.print(), 200)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="p-6">
      <header className="screen-only flex justify-between items-center mb-4 gap-2">
        <h2 className="text-xl font-semibold">
          Print {vials.length} label{vials.length === 1 ? '' : 's'}
        </h2>
        <div className="flex gap-2">
          <Button type="button" onClick={() => window.print()} variant="default">
            Print
          </Button>
          <Button type="button" onClick={onDone} variant="outline">
            Skip — close
          </Button>
        </div>
      </header>

      <div className="print-area">
        {vials.map(v => {
          const planItem = planByVial[v.sample_id]
          const role = planItem?.assignment_role ?? null
          // vial_sequence is 0-based on the backend; +1 for display
          const position = planItem ? planItem.vial_sequence + 1 : null
          return (
            <LabelTemplate
              key={v.sample_id}
              sampleId={v.sample_id}
              orderNumber={orderNumber}
              vialPosition={position}
              vialTotal={vialTotal}
              role={role}
            />
          )
        })}
      </div>

      {vials.length === 0 && (
        <p className="text-muted-foreground screen-only">
          No vials in this session — nothing to print.
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Update PrintStep.css**

In `Accu-Mk1/src/components/intake/ReceiveWizard/PrintStep.css`, in the `@media screen` block, drop `.label-order` font-size to 6pt (so "Vial X/Y" suffix fits on one line) and add `.label-role`:

Find this block:
```css
  .label-order {
    font-family: ui-monospace, monospace;
    font-size: 6.5pt;
    color: #555;
    line-height: 1;
    letter-spacing: -0.04em;
    white-space: nowrap;
  }
```

Replace with:
```css
  .label-order {
    font-family: ui-monospace, monospace;
    font-size: 6pt;
    color: #555;
    line-height: 1;
    letter-spacing: -0.04em;
    white-space: nowrap;
  }
  .label-role {
    font-family: ui-monospace, monospace;
    font-weight: 700;
    font-size: 7pt;
    color: #000;
    line-height: 1;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
```

Apply the same two replacements inside the `@media print` block (find the second occurrence of `.label-order { ... }` and apply both changes).

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd Accu-Mk1
docker exec accu-mk1-frontend npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add Accu-Mk1/src/components/intake/ReceiveWizard/LabelTemplate.tsx Accu-Mk1/src/components/intake/ReceiveWizard/PrintStep.tsx Accu-Mk1/src/components/intake/ReceiveWizard/PrintStep.css
git commit -m "feat(mk1-fe): label 3rd line for service short-name + Vial X/Y on order line"
```

---

### Task 14: Manual smoke test on order #3229

- [ ] **Step 1: Restart frontend dev container if needed**

```bash
docker compose restart accu-mk1-frontend
```

Then open [http://localhost:3101/#senaite/receive-sample](http://localhost:3101/#senaite/receive-sample).

- [ ] **Step 2: Walk through the receive flow on BW-0006**

1. Look up sample `BW-0006` (parent of order #3229 sample 2 — has BW panel + Endo + Sterility per the handoff).
2. If it's already received with sub-samples, you'll see existing vials in the sidebar; add 1 new sub-sample for testing if the existing set is < 4.
3. Click **Continue →** in the footer. Expected: AssignStep loads.
4. Verify the layout:
   - **Analyses Dept.** column with `BW-0006` (parent, teal) labeled HPLC.
   - **Microbiology** column with Endo and Sterility sub-rows. 1 vial in Endo (ENDO badge), 2 in Sterility (STERYL badges).
   - **Xtra** column empty (or has surplus if more than 4 vials).
5. Drag a vial out of Endo into Xtra. Expected: optimistic update, banner stays put, no error in browser console.
6. Click the **reset** button in Xtra's bucket header. Expected: the vial moves back to Endo.
7. Click **Print labels →**. Expected: PrintStep loads, labels print with the third line reading HPLC / ENDO / STERYL / STERYL, and the order-number line shows `3229 · Vial X/Y`.

- [ ] **Step 3: Verify DB state**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark_postgres psql -U postgres -d accumark_mk1 -c "SELECT sample_id, assignment_role FROM lims_samples WHERE sample_id='BW-0006';"
MSYS_NO_PATHCONV=1 docker exec accumark_postgres psql -U postgres -d accumark_mk1 -c "SELECT sample_id, vial_sequence, assignment_role FROM lims_sub_samples WHERE sample_id LIKE 'BW-0006-S%' ORDER BY vial_sequence;"
```

Expected: parent shows `hplc`. Sub-samples show `endo` / `ster` / `ster` (or whatever you dragged them to).

- [ ] **Step 4: Edge case — peptide-only order**

Receive a vial on `P-0139` (single-peptide sample, no addons). At the AssignStep, expected: only the **Analyses Dept.** and **Xtra** columns render. Microbiology is hidden.

- [ ] **Step 5: Edge case — IS unreachable**

Stop IS: `docker compose stop integration-service`.

Open the AssignStep on a fresh parent sample. Expected: amber banner reading "Couldn't load order services...". All vials in Xtra. Print still works (every label says XTRA).

Restart IS: `docker compose start integration-service`.

- [ ] **Step 6: Commit smoke-test notes (optional)**

If you tweaked anything during smoke testing, commit. Otherwise, no commit needed for this task — it's pure verification.

---

## Self-Review

**Spec coverage:**
- ✅ Vial demand rules → Task 5 (`derive_demand`)
- ✅ Architecture (IS source-of-truth) → Tasks 1, 4
- ✅ Data model (assignment_role columns) → Tasks 2, 3
- ✅ IS endpoint → Task 1
- ✅ Mk1 endpoints (vial-plan + assignment) → Tasks 7, 8
- ✅ Auto-assign algorithm → Task 6
- ✅ AssignStep UI → Task 10
- ✅ Wizard phase wiring → Task 11
- ✅ Sidebar badge → Task 12
- ✅ Label changes (3rd line + Vial X/Y) → Task 13
- ✅ Edge cases (empty Microbio, short demand, IS unreachable, override sticky, parent reset coercion) → covered in tasks 6, 8, 10, 14
- ✅ Testing (unit + smoke) → covered throughout, Task 14 for manual

**Placeholder scan:** Looked through tasks for "TBD", "TODO", "fill in" — none found. Every step has actual code.

**Type consistency:**
- `AssignmentRole = 'hplc' | 'endo' | 'ster' | 'xtra'` — matches backend enum `_VALID_ROLES`
- `VialPlanResponse.demand` keys match across IS-side `derive_demand` output and frontend `Bucket` props
- `set_assignment_role()` and `compute_vial_plan()` signatures consistent with their callers in `routes.py`
- `LabelTemplate` props (`vialPosition`, `vialTotal`, `role`) align with what `PrintStep` constructs from `VialPlanItem`

---

## Execution Handoff

Plan complete and saved to `Accu-Mk1/docs/superpowers/plans/2026-05-03-vial-assignment-step.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
