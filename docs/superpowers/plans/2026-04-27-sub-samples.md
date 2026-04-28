# Sub-Samples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a grow-as-you-go receive wizard in Accu-Mk1 that creates SENAITE `AnalysisRequestSecondary` sub-samples, captures one photo per vial, prints batch labels at the end, and exposes sub-sample data on parent detail pages.

**Architecture:** Accu-Mk1 backend talks directly to SENAITE for secondary creation; integration-service is untouched. Two new tables in `accumark_mk1` (SQLAlchemy) — a stub `samples` master table seeded lazily, and `sub_samples` FK'd to it. Browser-print to local Cab Mach 4S/600B via OS print spool — no Tauri or local agent. Sub-sample IDs flow through existing string-keyed analysis tables unchanged.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (Accu-Mk1 backend), React 19 + Zustand + TanStack Query (frontend), Vitest + Playwright (tests), JsBarcode (Code 39 SVG).

**Spec:** `docs/superpowers/specs/2026-04-27-sub-samples-design.md` (this repo).

**Branch:** `feat/sub-samples` (create at start of Task 1).

**Repo path (host):** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1`

**How to run tests:**
- Backend: `docker exec accu-mk1-backend python -m pytest backend/tests/<file> -v`
- Frontend unit: `npm run test -- <pattern>` (vitest)
- E2E: separate workspace at `e2e-tests/` — `npm run test:e2e -- <pattern>`

---

## File Structure

**Backend (new):**
- `backend/sub_samples/__init__.py` — package marker
- `backend/sub_samples/schemas.py` — Pydantic request/response models
- `backend/sub_samples/senaite.py` — `create_secondary`, `delete_secondary`, `update_secondary` SENAITE adapter
- `backend/sub_samples/service.py` — `ensure_sample_row`, `create_sub_sample`, `list_sub_samples`, `update_sub_sample`, `delete_sub_sample` business logic
- `backend/sub_samples/routes.py` — FastAPI router with 5 endpoints
- `backend/tests/test_sub_samples_service.py`
- `backend/tests/test_sub_samples_routes.py`
- `backend/tests/test_sub_samples_senaite.py`

**Backend (modified):**
- `backend/database.py` — append two `CREATE TABLE IF NOT EXISTS` entries to `_run_migrations()`
- `backend/models.py` — append `Sample` and `SubSample` ORM classes
- `backend/main.py` — `app.include_router(sub_samples_router)` near other routers

**Frontend (new):**
- `src/components/samples/SampleIdBadge.tsx`
- `src/components/samples/SampleIdBadge.test.tsx`
- `src/components/samples/SubSampleDetail.tsx` — route page
- `src/components/intake/ReceiveWizard/ReceiveWizard.tsx`
- `src/components/intake/ReceiveWizard/WizardSidebar.tsx`
- `src/components/intake/ReceiveWizard/VialPanel.tsx`
- `src/components/intake/ReceiveWizard/PrintStep.tsx`
- `src/components/intake/ReceiveWizard/LabelTemplate.tsx`
- `src/components/intake/ReceiveWizard/useReceiveWizard.ts` — state hook
- `src/components/intake/ReceiveWizard/__tests__/ReceiveWizard.test.tsx`
- `e2e-tests/tests/sub-samples.spec.ts`

**Frontend (modified):**
- `src/lib/api.ts` — sub-sample wrapper functions
- `src/components/intake/ReceiveSample.tsx` — wire wizard entry, add vial-count column
- `src/components/senaite/SampleDetails.tsx` — Sub-Samples + Sub-Sample Analyses sections, Add Sub-Sample button
- `src/App.tsx` (or wherever router lives) — register `/samples/:sampleId` route
- ~12 sites for `<SampleIdBadge>` swap-in (see Tasks 20-21)

---

## Task 1: Verify SENAITE secondary creation REST payload (spike)

**Files:** none committed; produces `docs/developer/senaite-secondary-api.md` (new) capturing the verified call shape.

This is a research task — block all later backend tasks until done. The spec flagged the exact REST payload as unverified.

- [ ] **Step 1: Spin up the local SENAITE container**

```bash
cd "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Senaite"
docker-compose up -d senaite
# wait for health: docker logs senaite | grep "ready"
```

- [ ] **Step 2: Get a parent sample UID to test against**

Open `http://localhost:8080/senaite` → log in → open `clients/client-8/P-0134` → copy the parent UID from the URL bar / metadata.

- [ ] **Step 3: Try the public `@@API/senaite/v1/create` endpoint**

```bash
curl -u admin:admin -X POST \
  http://localhost:8080/senaite/@@API/senaite/v1/create \
  -H "Content-Type: application/json" \
  -d '{
    "type": "AnalysisRequest",
    "parent_uid": "<CLIENT_UID>",
    "PrimaryAnalysisRequest": "<PARENT_AR_UID>",
    "Client": "<CLIENT_UID>",
    "Contact": "<CONTACT_UID>",
    "SampleType": "<SAMPLE_TYPE_UID>"
  }'
```

If response is `2xx` and the new AR ID matches `P-XXXX-S01`, this is the path. Document the exact payload shape.

- [ ] **Step 4: If public API does not produce a secondary, write a custom helper view**

Confirmed by reading `Senaite/idserver.py:48-53, 279-289` — the marker interface `IAnalysisRequestSecondary` is what triggers the `-SNN` suffix. If `@@API/senaite/v1/create` does not let us apply the marker, write a small Plone view in `senaite.accumark` that:
1. Accepts `parent_uid`, photo, remarks
2. Creates AR in client folder
3. Calls `alsoProvides(ar, IAnalysisRequestSecondary)` and `ar.setPrimaryAnalysisRequest(parent_object)`
4. Triggers reindex so SENAITE renames to `P-XXXX-SNN`
5. Returns `{uid, sample_id}`

If this path is needed, it adds work in the `Senaite/src/senaite.accumark/` package — out of scope for this Accu-Mk1 plan; spin up a separate ticket for the SENAITE-side helper and gate Task 5 behind it landing.

- [ ] **Step 5: Document the verified call**

Write `docs/developer/senaite-secondary-api.md` containing:
- Exact endpoint URL
- Headers
- Request payload (JSON, with placeholder `<UID>` values)
- Sample 200 response
- Error cases observed (400/404/500)
- Photo attachment call (re-verify against existing `receive-sample` endpoint flow at `backend/main.py:10912-10950`; should be unchanged)

- [ ] **Step 6: Commit the doc**

```bash
git checkout -b feat/sub-samples
git add docs/developer/senaite-secondary-api.md
git commit -m "docs: verify SENAITE secondary creation REST contract"
```

---

## Task 2: DB migration — `samples` and `sub_samples` tables

**Files:**
- Modify: `backend/database.py` — append entries to `_run_migrations()` list around line 181.

- [ ] **Step 1: Read the migration list location**

Read `backend/database.py:60-190` to confirm where to append.

- [ ] **Step 2: Append the two CREATE TABLE statements**

Add to the end of the `migrations` list in `_run_migrations()`:

```python
        # Sub-Samples feature: stub master table + sub-samples table
        """
        CREATE TABLE IF NOT EXISTS samples (
            id SERIAL PRIMARY KEY,
            sample_id VARCHAR(100) NOT NULL UNIQUE,
            external_lims_uid VARCHAR(100),
            external_lims_system VARCHAR(50) DEFAULT 'senaite',
            client_id VARCHAR(100),
            client_uid VARCHAR(100),
            contact_uid VARCHAR(100),
            sample_type VARCHAR(100),
            status VARCHAR(50),
            peptide_name VARCHAR(200),
            client_sample_id VARCHAR(200),
            date_sampled TIMESTAMP,
            date_received TIMESTAMP,
            is_retest BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_samples_external_lims_uid ON samples (external_lims_uid)",
        """
        CREATE TABLE IF NOT EXISTS sub_samples (
            id SERIAL PRIMARY KEY,
            parent_sample_pk INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
            external_lims_uid VARCHAR(100) NOT NULL UNIQUE,
            sample_id VARCHAR(100) NOT NULL UNIQUE,
            vial_sequence INTEGER NOT NULL,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            received_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            photo_external_uid VARCHAR(100),
            remarks TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uq_parent_vial_sequence UNIQUE (parent_sample_pk, vial_sequence)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_sub_samples_parent_pk ON sub_samples (parent_sample_pk)",
```

- [ ] **Step 3: Restart backend, verify tables exist**

```bash
docker exec accu-mk1-backend python -c "from database import engine; from sqlalchemy import inspect; print(inspect(engine).get_table_names())"
```

Expected: output includes `samples` and `sub_samples`.

- [ ] **Step 4: Commit**

```bash
git add backend/database.py
git commit -m "feat(sub-samples): add samples and sub_samples tables"
```

---

## Task 3: SQLAlchemy ORM models

**Files:**
- Modify: `backend/models.py` — append `Sample` and `SubSample` classes at end of file.

- [ ] **Step 1: Read existing model style**

Read `backend/models.py:1-50` for imports + Base, and any one model (e.g. `WorksheetItem` around line 606) to confirm the SQLAlchemy 2.0 typed-mapped style.

- [ ] **Step 2: Append the new models**

Append to `backend/models.py`:

```python
from datetime import datetime
from typing import Optional, List
from sqlalchemy import String, Integer, Boolean, DateTime, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class Sample(Base):
    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sample_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    external_lims_uid: Mapped[Optional[str]] = mapped_column(String(100), index=True)
    external_lims_system: Mapped[Optional[str]] = mapped_column(String(50), default="senaite")
    client_id: Mapped[Optional[str]] = mapped_column(String(100))
    client_uid: Mapped[Optional[str]] = mapped_column(String(100))
    contact_uid: Mapped[Optional[str]] = mapped_column(String(100))
    sample_type: Mapped[Optional[str]] = mapped_column(String(100))
    status: Mapped[Optional[str]] = mapped_column(String(50))
    peptide_name: Mapped[Optional[str]] = mapped_column(String(200))
    client_sample_id: Mapped[Optional[str]] = mapped_column(String(200))
    date_sampled: Mapped[Optional[datetime]] = mapped_column(DateTime)
    date_received: Mapped[Optional[datetime]] = mapped_column(DateTime)
    is_retest: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    sub_samples: Mapped[List["SubSample"]] = relationship(
        "SubSample", back_populates="parent_sample",
        cascade="all, delete-orphan", order_by="SubSample.vial_sequence",
    )


class SubSample(Base):
    __tablename__ = "sub_samples"
    __table_args__ = (UniqueConstraint("parent_sample_pk", "vial_sequence", name="uq_parent_vial_sequence"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    parent_sample_pk: Mapped[int] = mapped_column(Integer, ForeignKey("samples.id", ondelete="CASCADE"))
    external_lims_uid: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    sample_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    vial_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    received_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    photo_external_uid: Mapped[Optional[str]] = mapped_column(String(100))
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    parent_sample: Mapped["Sample"] = relationship("Sample", back_populates="sub_samples")
```

- [ ] **Step 3: Smoke-test the import**

```bash
docker exec accu-mk1-backend python -c "from models import Sample, SubSample; print(Sample.__tablename__, SubSample.__tablename__)"
```

Expected: `samples sub_samples`.

- [ ] **Step 4: Commit**

```bash
git add backend/models.py
git commit -m "feat(sub-samples): add Sample and SubSample ORM models"
```

---

## Task 4: Pydantic schemas

**Files:**
- Create: `backend/sub_samples/__init__.py` (empty)
- Create: `backend/sub_samples/schemas.py`

- [ ] **Step 1: Create the package**

```bash
mkdir -p backend/sub_samples
touch backend/sub_samples/__init__.py
```

- [ ] **Step 2: Write `schemas.py`**

```python
"""Pydantic schemas for sub-samples API."""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class CreateSubSampleRequest(BaseModel):
    parent_sample_id: str = Field(..., description="Parent SENAITE sample ID, e.g. 'P-0134'")
    photo_base64: str = Field(..., description="Photo as base64-encoded JPEG/PNG")
    remarks: Optional[str] = None


class UpdateSubSampleRequest(BaseModel):
    photo_base64: Optional[str] = None
    remarks: Optional[str] = None


class SubSampleResponse(BaseModel):
    id: int
    sample_id: str
    parent_sample_id: str
    vial_sequence: int
    received_at: datetime
    received_by_user_id: Optional[int]
    photo_external_uid: Optional[str]
    remarks: Optional[str]

    class Config:
        from_attributes = True


class ParentSampleSummary(BaseModel):
    sample_id: str
    external_lims_uid: Optional[str]
    peptide_name: Optional[str]
    status: Optional[str]
    sub_sample_count: int
    last_synced_at: datetime

    class Config:
        from_attributes = True


class SubSampleListResponse(BaseModel):
    parent: ParentSampleSummary
    sub_samples: list[SubSampleResponse]
```

- [ ] **Step 3: Smoke-test**

```bash
docker exec accu-mk1-backend python -c "from sub_samples.schemas import CreateSubSampleRequest, SubSampleResponse; print('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add backend/sub_samples/__init__.py backend/sub_samples/schemas.py
git commit -m "feat(sub-samples): add Pydantic schemas"
```

---

## Task 5: SENAITE secondary adapter

**Files:**
- Create: `backend/sub_samples/senaite.py`
- Create: `backend/tests/test_sub_samples_senaite.py`

**Use the verified call shape from `docs/developer/senaite-secondary-api.md` (Task 1).** The spike surfaced several gotchas that change the code below from earlier drafts of this plan — the snippets in Steps 1 and 3 already incorporate them. Specifically:

- Payload field is `portal_type` (NOT `type`).
- `Client` and date fields must NOT be sent — SENAITE overrides.
- **Silent fallthrough on bad parent UID:** create returns 200 with a normal AR (no `-SNN` suffix). Caller MUST validate `^<parent_id>-S\d{2}$` and treat mismatch as failure.
- Photo upload is an HTML form (not JSON) at `<sample_path>/@@attachments_view/add` with CSRF preflight — copy the existing primary-flow at `backend/main.py:10912-10950`.
- `fetch_secondaries` cannot filter by `PrimaryAnalysisRequest` (silently dropped) — use `@@API/senaite/v1/search?portal_type=AnalysisRequest&q=<parent_id>` and filter client-side for `^<parent_id>-S\d{2}$`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_sub_samples_senaite.py`:

```python
import re
from unittest.mock import patch, MagicMock
import pytest
from sub_samples.senaite import (
    create_secondary, SecondaryCreateResult, SecondaryFalloutError,
)


def test_create_secondary_posts_correct_payload():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [{"uid": "SECONDARY_UID_ABC", "id": "P-0134-S01"}]}
    with patch("sub_samples.senaite._post_json", return_value=mock_resp) as m:
        result = create_secondary(
            parent_sample_id="P-0134",
            parent_uid="PARENT_UID_XYZ",
            client_uid="CLIENT_UID",
            contact_uid="CONTACT_UID",
            sample_type_uid="ST_UID",
        )
    assert isinstance(result, SecondaryCreateResult)
    assert result.uid == "SECONDARY_UID_ABC"
    assert result.sample_id == "P-0134-S01"
    payload = m.call_args.kwargs["json"]
    # Verified contract from docs/developer/senaite-secondary-api.md
    assert payload["portal_type"] == "AnalysisRequest"
    assert payload["parent_uid"] == "CLIENT_UID"
    assert payload["PrimaryAnalysisRequest"] == "PARENT_UID_XYZ"
    assert payload["Contact"] == "CONTACT_UID"
    assert payload["SampleType"] == "ST_UID"
    # MUST NOT send these — SENAITE overrides Client and inherits dates
    assert "Client" not in payload
    assert "DateSampled" not in payload
    assert "DateReceived" not in payload


def test_create_secondary_detects_silent_fallthrough_when_id_lacks_SNN():
    """If parent UID is bad, SENAITE returns 200 with a normal AR id (no -SNN).
    Caller MUST detect this and raise — see docs/developer/senaite-secondary-api.md §1."""
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [{"uid": "ORPHAN_UID", "id": "P-0135"}]}
    with patch("sub_samples.senaite._post_json", return_value=mock_resp), \
         patch("sub_samples.senaite.delete_secondary") as cleanup:
        with pytest.raises(SecondaryFalloutError):
            create_secondary(
                parent_sample_id="P-0134",
                parent_uid="WRONG_UID", client_uid="C", contact_uid="CT", sample_type_uid="ST",
            )
    cleanup.assert_called_once_with("ORPHAN_UID")


def test_create_secondary_raises_on_http_error():
    mock_resp = MagicMock(status_code=500, text="boom")
    with patch("sub_samples.senaite._post_json", return_value=mock_resp):
        with pytest.raises(RuntimeError, match="SENAITE create_secondary failed"):
            create_secondary(
                parent_sample_id="P-0134",
                parent_uid="X", client_uid="Y", contact_uid="Z", sample_type_uid="W",
            )


def test_fetch_secondaries_uses_search_and_filters_client_side():
    """The senaite.jsonapi v1 list endpoint cannot filter by parent UID.
    See docs/developer/senaite-secondary-api.md §3 — must use search?q=<id>."""
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "PARENT_UID", "id": "P-0134"},
        {"uid": "S01_UID", "id": "P-0134-S01"},
        {"uid": "S02_UID", "id": "P-0134-S02"},
        {"uid": "OTHER_UID", "id": "P-0134-R01"},  # retest, NOT a secondary
    ]}
    from sub_samples.senaite import fetch_secondaries
    with patch("sub_samples.senaite._get", return_value=mock_resp) as m:
        secondaries = fetch_secondaries("P-0134")
    assert m.call_args.kwargs["params"]["q"] == "P-0134"
    assert {s["id"] for s in secondaries} == {"P-0134-S01", "P-0134-S02"}
```

- [ ] **Step 2: Run the tests, see them fail**

```bash
docker exec accu-mk1-backend python -m pytest backend/tests/test_sub_samples_senaite.py -v
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

Create `backend/sub_samples/senaite.py`:

```python
"""SENAITE adapter for AnalysisRequestSecondary creation/upload/fetch/delete.

Verified payload shape: docs/developer/senaite-secondary-api.md
Critical contract — keep in sync with that doc:
  * Field names are PascalCase (PrimaryAnalysisRequest, SampleType, Contact).
  * portal_type, NOT type.
  * Client and date fields MUST NOT be sent — SENAITE overrides.
  * Bad PrimaryAnalysisRequest UID returns 200 with a normal AR — silent
    fallthrough. Caller validates `^<parent_id>-S\\d{2}$`.
  * The list endpoint cannot filter by parent UID — use search?q=<parent_id>.
  * Photo upload is an HTML form, not JSON — reuse the primary flow at
    backend/main.py:10912-10950 directly.
"""
import os
import re
import logging
from dataclasses import dataclass
from typing import Optional, List
import requests

log = logging.getLogger(__name__)

SENAITE_BASE_URL = os.environ.get("SENAITE_BASE_URL", "http://localhost:8080/senaite")
SENAITE_USER = os.environ.get("SENAITE_USER", "admin")
SENAITE_PASSWORD = os.environ.get("SENAITE_PASSWORD", "admin")


class SecondaryFalloutError(RuntimeError):
    """Raised when SENAITE silently created a normal AR instead of a secondary
    (because the PrimaryAnalysisRequest UID was bad). The orphan AR has been
    cleaned up before this is raised."""


@dataclass
class SecondaryCreateResult:
    uid: str
    sample_id: str


def _post_json(url: str, **kwargs) -> requests.Response:
    return requests.post(url, auth=(SENAITE_USER, SENAITE_PASSWORD), timeout=30, **kwargs)


def _get(url: str, **kwargs) -> requests.Response:
    return requests.get(url, auth=(SENAITE_USER, SENAITE_PASSWORD), timeout=30, **kwargs)


def create_secondary(
    parent_sample_id: str,
    parent_uid: str,
    client_uid: str,
    contact_uid: Optional[str],
    sample_type_uid: str,
) -> SecondaryCreateResult:
    """Create an AnalysisRequestSecondary tied to parent_uid.

    parent_sample_id is needed only to validate the response id pattern.
    """
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/create"
    payload = {
        "portal_type": "AnalysisRequest",
        "parent_uid": client_uid,                   # the Client folder owns the AR
        "PrimaryAnalysisRequest": parent_uid,       # exact spelling — silent fallthrough otherwise
        "SampleType": sample_type_uid,
    }
    if contact_uid:
        payload["Contact"] = contact_uid
    resp = _post_json(url, json=payload)
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE create_secondary failed ({resp.status_code}): {resp.text}")

    body = resp.json()
    items = body.get("items") or []
    if not items:
        raise RuntimeError(f"SENAITE create_secondary returned no items: {body}")
    item = items[0]
    new_uid, new_id = item["uid"], item["id"]

    # Silent-fallthrough guard: if the marker wasn't applied, SENAITE created a
    # normal AR. Delete the orphan and raise.
    expected = re.compile(rf"^{re.escape(parent_sample_id)}-S\d{{2}}$")
    if not expected.match(new_id):
        log.error(
            "sub_samples.silent_fallthrough parent=%s expected_pattern=%s got_id=%s",
            parent_sample_id, expected.pattern, new_id,
        )
        try:
            delete_secondary(new_uid)
        except Exception as e:
            log.error("sub_samples.orphan_cleanup_failed uid=%s err=%s", new_uid, e)
        raise SecondaryFalloutError(
            f"SENAITE silently created a normal AR ({new_id}) instead of a secondary of "
            f"{parent_sample_id}. Likely cause: bad PrimaryAnalysisRequest UID. Orphan deleted."
        )

    return SecondaryCreateResult(uid=new_uid, sample_id=new_id)


def upload_photo(secondary_path: str, photo_bytes: bytes, filename: str = "vial.jpg") -> None:
    """Upload a photo as a SENAITE attachment to the secondary AR.

    secondary_path is the SENAITE path returned in the create response (e.g.
    "/senaite/clients/client-8/P-0134-S01"). This call goes through the
    HTML form flow — the JSON API does NOT have a clean attachment route.
    Reuse the existing primary helper at backend/main.py:10912-10950 if it has
    been extracted into a callable function; otherwise inline the same logic
    here (CSRF preflight + multipart form post).
    """
    raise NotImplementedError(
        "Implement by extracting backend/main.py:10912-10950 into a "
        "shared helper, then call it with this AR's path."
    )


def update_remarks(secondary_uid: str, remarks: str) -> None:
    """Update Remarks via the JSON API. NOTE: not yet verified end-to-end —
    confirm against a live SENAITE before relying on it for edit flows."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/update"
    resp = _post_json(url, json={"uid": secondary_uid, "Remarks": remarks})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE update_remarks failed ({resp.status_code}): {resp.text}")


def delete_secondary(secondary_uid: str) -> None:
    """Delete via the JSON API. NOTE: not yet verified end-to-end — confirm
    against a live SENAITE before relying on it (used by the silent-fallthrough
    guard above and by user-initiated this-session delete)."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/delete"
    resp = _post_json(url, json={"uid": secondary_uid})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE delete_secondary failed ({resp.status_code}): {resp.text}")


def fetch_parent_metadata(parent_sample_id: str) -> dict:
    """Fetch parent AR metadata for lazy upsert into samples table.

    Use ?complete=true on the UID-path form to get full fields (Client UID,
    Contact UID, SampleType UID); the ?id= list-form returns a minimal
    projection. We do this in two steps: id-lookup → uid-lookup with complete.
    """
    list_url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest"
    resp = _get(list_url, params={"id": parent_sample_id})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE fetch_parent failed ({resp.status_code}): {resp.text}")
    items = resp.json().get("items", [])
    if not items:
        raise RuntimeError(f"SENAITE has no AR with id={parent_sample_id}")
    parent_uid = items[0]["uid"]

    detail_url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest/{parent_uid}"
    resp = _get(detail_url, params={"complete": "true"})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE fetch_parent detail failed ({resp.status_code}): {resp.text}")
    detail_items = resp.json().get("items", [])
    if not detail_items:
        raise RuntimeError(f"SENAITE detail empty for uid={parent_uid}")
    return detail_items[0]


def fetch_secondaries(parent_sample_id: str) -> List[dict]:
    """Fetch all secondaries for a parent. Drift reconciliation in service.

    The list endpoint can NOT filter by parent UID (see api doc §3). We use
    SearchableText `q=<parent_id>` and filter ids client-side for `-SNN`.
    """
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/search"
    resp = _get(url, params={"portal_type": "AnalysisRequest", "q": parent_sample_id})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE fetch_secondaries failed ({resp.status_code}): {resp.text}")
    pattern = re.compile(rf"^{re.escape(parent_sample_id)}-S\d{{2}}$")
    return [it for it in resp.json().get("items", []) if pattern.match(it.get("id", ""))]
```

- [ ] **Step 4: Run the tests, see them pass**

```bash
docker exec accu-mk1-backend python -m pytest backend/tests/test_sub_samples_senaite.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Verify update / delete shapes against live SENAITE**

The `update_remarks` and `delete_secondary` REST shapes were NOT verified by the Task 1 spike. Before the wider plan depends on them (Task 6 service uses them), spike them quickly:

```bash
# Pick a test secondary uid from a previous create
curl -u admin:<pw> -X POST http://localhost:8080/senaite/@@API/senaite/v1/update \
  -H "Content-Type: application/json" \
  -d '{"uid": "<UID>", "Remarks": "test"}'

curl -u admin:<pw> -X POST http://localhost:8080/senaite/@@API/senaite/v1/delete \
  -H "Content-Type: application/json" \
  -d '{"uid": "<UID>"}'
```

If either differs from the planned shape, update both `senaite.py` and `docs/developer/senaite-secondary-api.md` to match, and re-run tests.

- [ ] **Step 6: Commit**

```bash
git add backend/sub_samples/senaite.py backend/tests/test_sub_samples_senaite.py
git commit -m "feat(sub-samples): SENAITE secondary adapter"
```

---

## Task 6: Service layer — lazy upsert + atomic create

**Files:**
- Create: `backend/sub_samples/service.py`
- Create: `backend/tests/test_sub_samples_service.py`

The vial-sequence collision protection lives here. Use `SELECT ... FOR UPDATE` on the parent's `samples` row to serialize concurrent creates.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_sub_samples_service.py`:

```python
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timedelta
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import Sample, SubSample
from sub_samples.service import ensure_sample_row, create_sub_sample
from sub_samples.senaite import SecondaryCreateResult


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def test_ensure_sample_row_creates_when_missing(db):
    fake_meta = {
        "uid": "PARENT_UID",
        "ClientUID": "C_UID",
        "ClientID": "C_ID",
        "ContactUID": "CT_UID",
        "SampleType": "Liquid",
        "Title": "P-0134",
    }
    with patch("sub_samples.service.fetch_parent_metadata", return_value=fake_meta):
        row = ensure_sample_row(db, "P-0134")
    assert row.sample_id == "P-0134"
    assert row.external_lims_uid == "PARENT_UID"
    assert row.contact_uid == "CT_UID"


def test_ensure_sample_row_returns_existing(db):
    db.add(Sample(sample_id="P-0134", external_lims_uid="PARENT_UID"))
    db.commit()
    with patch("sub_samples.service.fetch_parent_metadata") as m:
        row = ensure_sample_row(db, "P-0134")
    assert row.sample_id == "P-0134"
    m.assert_not_called()


def test_create_sub_sample_assigns_sequential_vial_numbers(db):
    fake_meta = {"uid": "PARENT_UID", "ClientUID": "C", "ClientID": "C",
                 "ContactUID": "CT", "SampleType": "L", "Title": "P-0134"}
    fake_create_1 = SecondaryCreateResult(uid="UID1", sample_id="P-0134-S01")
    fake_create_2 = SecondaryCreateResult(uid="UID2", sample_id="P-0134-S02")

    with patch("sub_samples.service.fetch_parent_metadata", return_value=fake_meta), \
         patch("sub_samples.service.senaite.create_secondary", return_value=fake_create_1), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None):
        ss1 = create_sub_sample(db, parent_sample_id="P-0134",
                                photo_bytes=b"abc", photo_filename="vial.jpg",
                                remarks=None, user_id=1)
    assert ss1.vial_sequence == 1

    with patch("sub_samples.service.fetch_parent_metadata", return_value=fake_meta), \
         patch("sub_samples.service.senaite.create_secondary", return_value=fake_create_2), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None):
        ss2 = create_sub_sample(db, parent_sample_id="P-0134",
                                photo_bytes=b"def", photo_filename="vial.jpg",
                                remarks=None, user_id=1)
    assert ss2.vial_sequence == 2


def test_create_sub_sample_rolls_back_on_senaite_failure(db):
    fake_meta = {"uid": "PARENT_UID", "ClientUID": "C", "ClientID": "C",
                 "ContactUID": "CT", "SampleType": "L", "Title": "P-0134"}
    with patch("sub_samples.service.fetch_parent_metadata", return_value=fake_meta), \
         patch("sub_samples.service.senaite.create_secondary", side_effect=RuntimeError("boom")):
        with pytest.raises(RuntimeError):
            create_sub_sample(db, parent_sample_id="P-0134",
                              photo_bytes=b"abc", photo_filename="vial.jpg",
                              remarks=None, user_id=1)
    assert db.query(SubSample).count() == 0
```

- [ ] **Step 2: Run, see fail**

```bash
docker exec accu-mk1-backend python -m pytest backend/tests/test_sub_samples_service.py -v
```

Expected: ImportError.

- [ ] **Step 3: Write the service**

Create `backend/sub_samples/service.py`:

```python
"""Sub-sample business logic.

Ordering rule: SENAITE write succeeds before any local DB row lands.
Vial sequence assignment uses row-level lock on the parent samples row.
"""
import logging
from datetime import datetime, timedelta
from typing import Optional, Tuple, List
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from models import Sample, SubSample
from sub_samples import senaite
from sub_samples.senaite import fetch_parent_metadata


CACHE_FRESHNESS = timedelta(minutes=5)
log = logging.getLogger(__name__)


def ensure_sample_row(db: Session, parent_sample_id: str) -> Sample:
    """Lazy upsert: return existing samples row, or fetch from SENAITE and insert."""
    existing = db.execute(
        select(Sample).where(Sample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if existing:
        return existing

    meta = fetch_parent_metadata(parent_sample_id)
    row = Sample(
        sample_id=parent_sample_id,
        external_lims_uid=meta.get("uid"),
        external_lims_system="senaite",
        client_uid=meta.get("ClientUID"),
        client_id=meta.get("ClientID"),
        contact_uid=meta.get("ContactUID"),
        sample_type=meta.get("SampleType"),
        status=meta.get("review_state"),
        peptide_name=meta.get("Analyte1Peptide"),
        client_sample_id=meta.get("ClientSampleID"),
        last_synced_at=datetime.utcnow(),
    )
    db.add(row)
    db.flush()
    return row


def _next_vial_sequence(db: Session, parent_pk: int) -> int:
    """Assign vial_sequence under a row lock to prevent concurrent collisions."""
    db.execute(
        select(Sample).where(Sample.id == parent_pk).with_for_update()
    ).scalar_one()
    current_max = db.execute(
        select(func.coalesce(func.max(SubSample.vial_sequence), 0))
        .where(SubSample.parent_sample_pk == parent_pk)
    ).scalar_one()
    return current_max + 1


def create_sub_sample(
    db: Session,
    parent_sample_id: str,
    photo_bytes: bytes,
    photo_filename: str,
    remarks: Optional[str],
    user_id: int,
) -> SubSample:
    """Create a sub-sample atomically: SENAITE first, local row second.

    Order of SENAITE calls (per docs/developer/senaite-secondary-api.md):
      1. create_secondary — POST JSON, validates -SNN suffix, raises on fallthrough
      2. upload_photo    — HTML form to <secondary_path>/@@attachments_view/add
      3. update_remarks  — only if remarks provided (separate JSON call)
    The first call is the only one that creates state; if (2) or (3) fail after
    (1) succeeded, the sub-sample exists in SENAITE but local insert is rolled
    back. Callers can retry — the next attempt will discover the orphan via
    drift reconciliation, OR we can compensate by deleting on (2)/(3) failure.
    For v1: we compensate on (2) failure only (photo is mandatory); (3) failure
    leaves remarks unset and is logged as a warning.
    """
    parent = ensure_sample_row(db, parent_sample_id)
    is_first_vial = db.execute(
        select(func.count(SubSample.id)).where(SubSample.parent_sample_pk == parent.id)
    ).scalar_one() == 0

    # 1. Create secondary in SENAITE (raises SecondaryFalloutError on silent fallthrough)
    create_result = senaite.create_secondary(
        parent_sample_id=parent_sample_id,
        parent_uid=parent.external_lims_uid,
        client_uid=parent.client_uid,
        contact_uid=parent.contact_uid,
        sample_type_uid=parent.sample_type or "",
    )

    # 2. Upload photo via HTML form (mandatory). Compensate on failure.
    secondary_path = f"/senaite/clients/{parent.client_id}/{create_result.sample_id}"
    try:
        senaite.upload_photo(secondary_path, photo_bytes, photo_filename)
    except Exception:
        try:
            senaite.delete_secondary(create_result.uid)
        except Exception as cleanup_err:
            log.error("sub_samples.photo_upload_orphan uid=%s cleanup_err=%s",
                      create_result.uid, cleanup_err)
        raise

    # 3. Set remarks if provided. Best-effort.
    if remarks:
        try:
            senaite.update_remarks(create_result.uid, remarks)
        except Exception as e:
            log.warning("sub_samples.remarks_set_failed uid=%s err=%s", create_result.uid, e)

    # Local insert under row lock
    vial_seq = _next_vial_sequence(db, parent.id)
    sub = SubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=create_result.uid,
        sample_id=create_result.sample_id,
        vial_sequence=vial_seq,
        received_by_user_id=user_id,
        # photo_external_uid is repurposed as "where to fetch the photo from".
        # The HTML form upload doesn't return an attachment UID, so we store the
        # AR's path and let a backend proxy resolve attachments on demand.
        photo_external_uid=secondary_path,
        remarks=remarks,
    )
    db.add(sub)

    # Drive parent receive transition on the very first vial (best-effort).
    pre_received_states = (None, "sample_due", "sample_registered", "to_be_sampled")
    if is_first_vial and parent.status in pre_received_states:
        try:
            from main import _do_senaite_parent_receive
            _do_senaite_parent_receive(parent.external_lims_uid, parent.sample_id, photo_base64=photo_base64)
            parent.status = "sample_received"
        except Exception as e:
            log.warning("sub_samples.parent_transition_failed parent=%s err=%s", parent.sample_id, e)

    parent.last_synced_at = datetime.utcnow()
    db.commit()
    db.refresh(sub)
    return sub


def list_sub_samples(db: Session, parent_sample_id: str) -> Tuple[Optional[Sample], List[SubSample]]:
    parent = db.execute(
        select(Sample).where(Sample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        return None, []

    if datetime.utcnow() - parent.last_synced_at > CACHE_FRESHNESS:
        _reconcile_from_senaite(db, parent)

    return parent, list(parent.sub_samples)


def _reconcile_from_senaite(db: Session, parent: Sample) -> None:
    """SENAITE is canonical; insert SENAITE-only sub-samples missing locally.

    Never deletes local rows based on absence in SENAITE — surface to a human via WARN log.
    """
    if not parent.external_lims_uid:
        return
    remote = senaite.fetch_secondaries(parent.external_lims_uid)
    local_uids = {s.external_lims_uid for s in parent.sub_samples}
    remote_uids = set()

    for item in remote:
        remote_uids.add(item["uid"])
        if item["uid"] in local_uids:
            continue
        log.warning(
            "sub_samples.drift: SENAITE-only secondary discovered parent=%s remote_uid=%s sample_id=%s",
            parent.sample_id, item["uid"], item.get("id"),
        )
        next_seq = (db.execute(
            select(func.coalesce(func.max(SubSample.vial_sequence), 0))
            .where(SubSample.parent_sample_pk == parent.id)
        ).scalar_one()) + 1
        db.add(SubSample(
            parent_sample_pk=parent.id,
            external_lims_uid=item["uid"],
            sample_id=item["id"],
            vial_sequence=next_seq,
        ))

    local_only = local_uids - remote_uids
    if local_only:
        log.warning(
            "sub_samples.drift: Accu-Mk1 has sub-samples not in SENAITE parent=%s uids=%s",
            parent.sample_id, local_only,
        )

    parent.last_synced_at = datetime.utcnow()
    db.flush()


def update_sub_sample(
    db: Session,
    sample_id: str,
    photo_base64: Optional[str],
    remarks: Optional[str],
) -> SubSample:
    sub = db.execute(
        select(SubSample).where(SubSample.sample_id == sample_id)
    ).scalar_one()
    if remarks is not None:
        senaite.update_remarks(sub.external_lims_uid, remarks)
        sub.remarks = remarks
    if photo_base64 is not None:
        new_photo_uid = senaite.upload_photo(sub.external_lims_uid, photo_base64)
        sub.photo_external_uid = new_photo_uid
    sub.parent_sample.last_synced_at = datetime.utcnow()
    db.commit()
    db.refresh(sub)
    return sub


def delete_sub_sample(db: Session, sample_id: str) -> None:
    sub = db.execute(
        select(SubSample).where(SubSample.sample_id == sample_id)
    ).scalar_one()
    senaite.delete_secondary(sub.external_lims_uid)
    parent = sub.parent_sample
    db.delete(sub)
    parent.last_synced_at = datetime.utcnow()
    db.commit()
```

**Note:** This task assumes `_do_senaite_parent_receive` will exist as a helper extracted from `backend/main.py:10821-11054`. If not yet extracted, do that refactor as part of Step 4 below — split the existing endpoint into a callable helper plus the FastAPI route that calls it. Endpoint behavior must remain unchanged.

- [ ] **Step 4: Extract `_do_senaite_parent_receive` from main.py if needed**

Open `backend/main.py:10821-11054`. The current shape is one big `@app.post("/wizard/senaite/receive-sample")` function. Refactor:

```python
def _do_senaite_parent_receive(
    sample_uid: str,
    sample_id: str,
    image_base64: Optional[str] = None,
    remarks: Optional[str] = None,
) -> None:
    """The SENAITE-side work: fetch CSRF, upload image, add remarks, transition.

    Extracted from /wizard/senaite/receive-sample for reuse by sub-samples.
    """
    # ... existing body of the endpoint, minus FastAPI request/response handling ...


@app.post("/wizard/senaite/receive-sample", response_model=SenaiteReceiveSampleResponse)
def receive_sample(req: SenaiteReceiveSampleRequest, ...):
    _do_senaite_parent_receive(req.sample_uid, req.sample_id, req.image_base64, req.remarks)
    return SenaiteReceiveSampleResponse(status="received")
```

Make sure existing tests for the receive-sample endpoint still pass after the refactor.

- [ ] **Step 5: Run service tests, see them pass**

```bash
docker exec accu-mk1-backend python -m pytest backend/tests/test_sub_samples_service.py -v
```

Expected: 4 passed (or more, if you added the parent-transition tests below).

- [ ] **Step 6: Add parent-transition tests**

Append to `test_sub_samples_service.py`:

```python
def test_first_vial_transitions_parent_when_pre_received(db):
    fake_meta = {"uid": "PARENT_UID", "ClientUID": "C", "ClientID": "C",
                 "ContactUID": "CT", "SampleType": "L", "Title": "P-0134",
                 "review_state": "sample_registered"}
    fake_create = SecondaryCreateResult(uid="UID1", sample_id="P-0134-S01")
    with patch("sub_samples.service.fetch_parent_metadata", return_value=fake_meta), \
         patch("sub_samples.service.senaite.create_secondary", return_value=fake_create), \
         patch("sub_samples.service.senaite.upload_photo", return_value="ATT"), \
         patch("main._do_senaite_parent_receive") as transition:
        create_sub_sample(db, "P-0134", "abc", None, 1)
    transition.assert_called_once()


def test_subsequent_vial_does_not_re_transition_parent(db):
    db.add(Sample(sample_id="P-0134", external_lims_uid="PUID", client_uid="C",
                  contact_uid="CT", sample_type="L", status="sample_received"))
    db.commit()
    fake_create = SecondaryCreateResult(uid="UID2", sample_id="P-0134-S02")
    with patch("sub_samples.service.senaite.create_secondary", return_value=fake_create), \
         patch("sub_samples.service.senaite.upload_photo", return_value="ATT"), \
         patch("main._do_senaite_parent_receive") as transition:
        # Pre-seed one sub-sample so this is "second vial"
        db.add(SubSample(parent_sample_pk=1, external_lims_uid="UID1",
                         sample_id="P-0134-S01", vial_sequence=1))
        db.commit()
        create_sub_sample(db, "P-0134", "abc", None, 1)
    transition.assert_not_called()
```

- [ ] **Step 7: Commit**

```bash
git add backend/sub_samples/service.py backend/main.py backend/tests/test_sub_samples_service.py
git commit -m "feat(sub-samples): service layer with lazy upsert, atomic create, parent transition"
```

---

## Task 7: API endpoints — write and list

**Files:**
- Create: `backend/sub_samples/routes.py`
- Create: `backend/tests/test_sub_samples_routes.py`
- Modify: `backend/main.py` — register the router.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_sub_samples_routes.py`:

```python
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
from datetime import datetime
from main import app

client = TestClient(app)


def test_create_sub_sample_returns_201():
    fake_sub = MagicMock(
        id=1, sample_id="P-0134-S01", vial_sequence=1, received_at=datetime.utcnow(),
        received_by_user_id=1, photo_external_uid="ATT", remarks=None,
    )
    fake_sub.parent_sample = MagicMock(sample_id="P-0134")
    with patch("sub_samples.routes.service.create_sub_sample", return_value=fake_sub):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "abc", "remarks": None},
            headers={"Authorization": "Bearer fake"},
        )
    assert resp.status_code == 201
    body = resp.json()
    assert body["sample_id"] == "P-0134-S01"
    assert body["vial_sequence"] == 1


def test_list_sub_samples_returns_parent_and_children():
    fake_parent = MagicMock(
        sample_id="P-0134", external_lims_uid="UID", peptide_name="BPC-157",
        status="sample_received", last_synced_at=datetime.utcnow(),
    )
    fake_sub = MagicMock(
        id=1, sample_id="P-0134-S01", vial_sequence=1, received_at=datetime.utcnow(),
        received_by_user_id=1, photo_external_uid="ATT", remarks=None,
    )
    fake_sub.parent_sample = fake_parent
    with patch("sub_samples.routes.service.list_sub_samples", return_value=(fake_parent, [fake_sub])):
        resp = client.get("/api/sub-samples?parent_sample_id=P-0134")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"]["sample_id"] == "P-0134"
    assert len(body["sub_samples"]) == 1
```

- [ ] **Step 2: Run, see fail**

```bash
docker exec accu-mk1-backend python -m pytest backend/tests/test_sub_samples_routes.py -v
```

Expected: 404 / module not found.

- [ ] **Step 3: Write the routes**

Create `backend/sub_samples/routes.py`:

```python
"""Sub-samples FastAPI router."""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from database import get_db
from auth import get_current_user
from sub_samples import service
from sub_samples.schemas import (
    CreateSubSampleRequest, UpdateSubSampleRequest,
    SubSampleResponse, SubSampleListResponse, ParentSampleSummary,
)


router = APIRouter(prefix="/api/sub-samples", tags=["sub-samples"])


def _serialize(sub) -> SubSampleResponse:
    return SubSampleResponse(
        id=sub.id,
        sample_id=sub.sample_id,
        parent_sample_id=sub.parent_sample.sample_id,
        vial_sequence=sub.vial_sequence,
        received_at=sub.received_at,
        received_by_user_id=sub.received_by_user_id,
        photo_external_uid=sub.photo_external_uid,
        remarks=sub.remarks,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=SubSampleResponse)
def create_sub_sample(
    body: CreateSubSampleRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    try:
        sub = service.create_sub_sample(
            db, body.parent_sample_id, body.photo_base64, body.remarks, user.id,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"SENAITE error: {e}")
    return _serialize(sub)


@router.get("", response_model=SubSampleListResponse)
def list_sub_samples(parent_sample_id: str, db: Session = Depends(get_db)):
    parent, subs = service.list_sub_samples(db, parent_sample_id)
    if not parent:
        return SubSampleListResponse(
            parent=ParentSampleSummary(
                sample_id=parent_sample_id,
                external_lims_uid=None, peptide_name=None, status=None,
                sub_sample_count=0,
                last_synced_at=datetime.utcnow(),
            ),
            sub_samples=[],
        )
    return SubSampleListResponse(
        parent=ParentSampleSummary(
            sample_id=parent.sample_id,
            external_lims_uid=parent.external_lims_uid,
            peptide_name=parent.peptide_name,
            status=parent.status,
            sub_sample_count=len(subs),
            last_synced_at=parent.last_synced_at,
        ),
        sub_samples=[_serialize(s) for s in subs],
    )


@router.patch("/{sample_id}", response_model=SubSampleResponse)
def update_sub_sample(
    sample_id: str,
    body: UpdateSubSampleRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    try:
        sub = service.update_sub_sample(db, sample_id, body.photo_base64, body.remarks)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"SENAITE error: {e}")
    return _serialize(sub)


@router.delete("/{sample_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sub_sample(
    sample_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    try:
        service.delete_sub_sample(db, sample_id)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"SENAITE error: {e}")
    return None
```

- [ ] **Step 4: Register the router**

In `backend/main.py`, find where other routers are included (search for `app.include_router`) and add:

```python
from sub_samples.routes import router as sub_samples_router
app.include_router(sub_samples_router)
```

- [ ] **Step 5: Run tests, see pass**

```bash
docker exec accu-mk1-backend python -m pytest backend/tests/test_sub_samples_routes.py -v
```

Expected: 2 passed (fix any auth-fixture mismatches surfaced).

- [ ] **Step 6: Smoke-curl**

```bash
curl http://localhost:8000/api/sub-samples?parent_sample_id=P-0134
```

Expected: 200 with empty list.

- [ ] **Step 7: Commit**

```bash
git add backend/sub_samples/routes.py backend/tests/test_sub_samples_routes.py backend/main.py
git commit -m "feat(sub-samples): API endpoints for create/list/update/delete"
```

---

## Task 8: Frontend API client wrappers

**Files:**
- Modify: `src/lib/api.ts` — append wrappers in the same style as existing `getSenaiteSamples` etc.

- [ ] **Step 1: Read the existing API client style**

Open `src/lib/api.ts` and skim around the existing sample-related wrappers (e.g. `getSenaiteSamples` ~line 3472) to match the auth/header/error handling pattern. Note the wrapper used (likely a `fetchJson`/`apiFetch` helper).

- [ ] **Step 2: Append the wrappers**

```typescript
// Sub-samples
export interface SubSample {
  id: number
  sample_id: string
  parent_sample_id: string
  vial_sequence: number
  received_at: string
  received_by_user_id: number | null
  photo_external_uid: string | null
  remarks: string | null
}

export interface ParentSampleSummary {
  sample_id: string
  external_lims_uid: string | null
  peptide_name: string | null
  status: string | null
  sub_sample_count: number
  last_synced_at: string
}

export interface SubSampleListResponse {
  parent: ParentSampleSummary
  sub_samples: SubSample[]
}

export async function listSubSamples(parentSampleId: string): Promise<SubSampleListResponse> {
  const res = await apiFetch(`/api/sub-samples?parent_sample_id=${encodeURIComponent(parentSampleId)}`)
  if (!res.ok) throw new Error(`listSubSamples failed: ${res.status}`)
  return res.json()
}

export async function createSubSample(args: {
  parentSampleId: string
  photoBase64: string
  remarks?: string
}): Promise<SubSample> {
  const res = await apiFetch('/api/sub-samples', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent_sample_id: args.parentSampleId,
      photo_base64: args.photoBase64,
      remarks: args.remarks ?? null,
    }),
  })
  if (!res.ok) throw new Error(`createSubSample failed: ${res.status}`)
  return res.json()
}

export async function updateSubSample(sampleId: string, args: {
  photoBase64?: string
  remarks?: string
}): Promise<SubSample> {
  const res = await apiFetch(`/api/sub-samples/${encodeURIComponent(sampleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      photo_base64: args.photoBase64 ?? null,
      remarks: args.remarks ?? null,
    }),
  })
  if (!res.ok) throw new Error(`updateSubSample failed: ${res.status}`)
  return res.json()
}

export async function deleteSubSample(sampleId: string): Promise<void> {
  const res = await apiFetch(`/api/sub-samples/${encodeURIComponent(sampleId)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 204) throw new Error(`deleteSubSample failed: ${res.status}`)
}
```

Replace `apiFetch` with whatever the existing wrapper is named — check existing functions in `api.ts` before pasting.

- [ ] **Step 3: Type-check**

```bash
npm run check:all
```

Expected: no new TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(sub-samples): frontend API client wrappers"
```

---

## Task 9: SampleIdBadge component

**Files:**
- Create: `src/components/samples/SampleIdBadge.tsx`
- Create: `src/components/samples/SampleIdBadge.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/samples/SampleIdBadge.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { SampleIdBadge } from './SampleIdBadge'

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('SampleIdBadge', () => {
  it('renders bare ID with no hierarchy', () => {
    wrap(<SampleIdBadge id="P-0089" />)
    expect(screen.getByText('P-0089')).toBeInTheDocument()
  })

  it('renders parent linkage when given parentId', () => {
    wrap(<SampleIdBadge id="P-0134-S02" parentId="P-0134" vialSequence={2} />)
    expect(screen.getByText('P-0134-S02')).toBeInTheDocument()
    expect(screen.getByText(/child of/)).toBeInTheDocument()
  })

  it('renders vial count when parent has children', () => {
    wrap(<SampleIdBadge id="P-0134" hasChildren={3} />)
    expect(screen.getByText('P-0134')).toBeInTheDocument()
    expect(screen.getByText(/3 vials/)).toBeInTheDocument()
  })

  it('parent ID link navigates to parent detail', () => {
    wrap(<SampleIdBadge id="P-0134-S02" parentId="P-0134" vialSequence={2} />)
    const link = screen.getByRole('link', { name: /P-0134/ })
    expect(link).toHaveAttribute('href', '/samples/P-0134')
  })
})
```

- [ ] **Step 2: Run, see fail**

```bash
npm run test -- SampleIdBadge
```

Expected: FAIL.

- [ ] **Step 3: Implement the component**

Create `src/components/samples/SampleIdBadge.tsx`:

```typescript
import { Link } from 'react-router-dom'

interface Props {
  id: string
  parentId?: string
  vialSequence?: number
  hasChildren?: number
}

export function SampleIdBadge({ id, parentId, vialSequence, hasChildren }: Props) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-sm">
      <span>{id}</span>
      {parentId && (
        <span className="text-muted-foreground">
          ↳ child of <Link to={`/samples/${parentId}`} className="underline hover:text-foreground">{parentId}</Link>
          {vialSequence != null && <span className="ml-1 text-xs">(vial {vialSequence})</span>}
        </span>
      )}
      {hasChildren != null && hasChildren > 0 && (
        <span className="ml-1 text-xs text-muted-foreground">({hasChildren} vials)</span>
      )}
    </span>
  )
}
```

- [ ] **Step 4: Run, see pass**

```bash
npm run test -- SampleIdBadge
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/samples/SampleIdBadge.tsx src/components/samples/SampleIdBadge.test.tsx
git commit -m "feat(sub-samples): SampleIdBadge shared component"
```

---

## Task 10: Sub-sample detail route

**Files:**
- Create: `src/components/samples/SubSampleDetail.tsx`
- Modify: `src/App.tsx` (or whichever file owns the router) — register `/samples/:sampleId`.

- [ ] **Step 1: Find the router file**

```bash
grep -rn "<Routes>" src/ | head
```

Identify the file owning `<Routes>`.

- [ ] **Step 2: Create the page**

Create `src/components/samples/SubSampleDetail.tsx`:

```typescript
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listSubSamples } from '@/lib/api'
import { SampleIdBadge } from './SampleIdBadge'

export function SubSampleDetail() {
  const { sampleId = '' } = useParams<{ sampleId: string }>()
  // sampleId may be either a parent ("P-0134") or a sub-sample ("P-0134-S02").
  const parentId = sampleId.match(/-S\d+$/) ? sampleId.replace(/-S\d+$/, '') : sampleId
  const isSubSample = parentId !== sampleId

  const { data, isLoading, error } = useQuery({
    queryKey: ['sub-samples', parentId],
    queryFn: () => listSubSamples(parentId),
  })

  if (isLoading) return <div>Loading…</div>
  if (error) return <div>Error: {String(error)}</div>
  if (!data) return null

  if (!isSubSample) {
    return <div>This is a parent sample. <Link to={`/sample/${parentId}`}>Open parent detail</Link></div>
  }

  const sub = data.sub_samples.find(s => s.sample_id === sampleId)
  if (!sub) return <div>Sub-sample {sampleId} not found.</div>

  return (
    <div className="p-6 space-y-4">
      <header>
        <h1 className="text-2xl font-mono">{sub.sample_id}</h1>
        <SampleIdBadge id={sub.sample_id} parentId={parentId} vialSequence={sub.vial_sequence} />
      </header>
      <section>
        <h2 className="font-semibold">Vial details</h2>
        <dl className="grid grid-cols-2 gap-2">
          <dt>Received at</dt><dd>{sub.received_at}</dd>
          <dt>Vial number</dt><dd>{sub.vial_sequence}</dd>
          <dt>Remarks</dt><dd>{sub.remarks ?? '—'}</dd>
        </dl>
      </section>
      <section>
        <h2 className="font-semibold">Photo</h2>
        {sub.photo_external_uid ? (
          <img alt="vial" src={`/api/senaite/attachment/${sub.photo_external_uid}`} className="max-w-md rounded" />
        ) : <p>No photo on record.</p>}
      </section>
      <section>
        <h2 className="font-semibold">Analyses</h2>
        <p className="text-muted-foreground">No analyses on this sub-sample. (Worksheet vial-to-test assignment is a future phase.)</p>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Register the route**

In the routes file:

```tsx
<Route path="/samples/:sampleId" element={<SubSampleDetail />} />
```

- [ ] **Step 4: Smoke-check**

Visit `http://localhost:5173/samples/P-0134-S02` in a browser pointed at a backend that has at least one sub-sample. Verify the page renders without console errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/samples/SubSampleDetail.tsx src/App.tsx
git commit -m "feat(sub-samples): /samples/:sampleId detail route"
```

---

## Task 11: Receive wizard — state hook + container

**Files:**
- Create: `src/components/intake/ReceiveWizard/useReceiveWizard.ts`
- Create: `src/components/intake/ReceiveWizard/ReceiveWizard.tsx`
- Create: stub files for `WizardSidebar.tsx`, `VialPanel.tsx`, `PrintStep.tsx`, `LabelTemplate.tsx` (filled in later tasks).

- [ ] **Step 1: Create the directory and stub files**

```bash
mkdir -p src/components/intake/ReceiveWizard
```

Create each of these as a 3-line stub for now:

```typescript
// WizardSidebar.tsx
export function WizardSidebar(_: any) { return null }
```

(repeat for VialPanel, PrintStep, LabelTemplate)

- [ ] **Step 2: Write the state hook**

Create `useReceiveWizard.ts`:

```typescript
import { useState, useCallback } from 'react'
import { listSubSamples, createSubSample, updateSubSample, deleteSubSample, SubSample } from '@/lib/api'

interface SessionVial {
  sub: SubSample
  isThisSession: boolean
}

export function useReceiveWizard(parentSampleId: string) {
  const [vials, setVials] = useState<SessionVial[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listSubSamples(parentSampleId)
      setVials(prev => {
        const sessionUids = new Set(prev.filter(v => v.isThisSession).map(v => v.sub.external_lims_uid))
        return data.sub_samples.map(s => ({
          sub: s,
          isThisSession: sessionUids.has(s.external_lims_uid),
        }))
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [parentSampleId])

  const saveNewVial = useCallback(async (photoBase64: string, remarks?: string) => {
    const sub = await createSubSample({ parentSampleId, photoBase64, remarks })
    setVials(prev => [...prev, { sub, isThisSession: true }])
    return sub
  }, [parentSampleId])

  const editSessionVial = useCallback(async (sampleId: string, photoBase64?: string, remarks?: string) => {
    const sub = await updateSubSample(sampleId, { photoBase64, remarks })
    setVials(prev => prev.map(v => v.sub.sample_id === sampleId ? { sub, isThisSession: true } : v))
    return sub
  }, [])

  const deleteSessionVial = useCallback(async (sampleId: string) => {
    await deleteSubSample(sampleId)
    setVials(prev => prev.filter(v => v.sub.sample_id !== sampleId))
  }, [])

  const sessionVials = vials.filter(v => v.isThisSession)

  return {
    vials, sessionVials, loading, error,
    refresh, saveNewVial, editSessionVial, deleteSessionVial,
  }
}
```

- [ ] **Step 3: Write the wizard container**

Create `ReceiveWizard.tsx`:

```typescript
import { useEffect, useState } from 'react'
import { useReceiveWizard } from './useReceiveWizard'
import { WizardSidebar } from './WizardSidebar'
import { VialPanel } from './VialPanel'
import { PrintStep } from './PrintStep'

interface Props {
  parentSampleId: string
  onClose: () => void
}

export function ReceiveWizard({ parentSampleId, onClose }: Props) {
  const wiz = useReceiveWizard(parentSampleId)
  const [phase, setPhase] = useState<'capture' | 'print'>('capture')
  const [editingSampleId, setEditingSampleId] = useState<string | null>(null)

  useEffect(() => { wiz.refresh() }, [wiz.refresh])

  if (phase === 'print') {
    return <PrintStep vials={wiz.sessionVials.map(v => v.sub)} onDone={onClose} />
  }

  return (
    <div className="grid grid-cols-[260px_1fr] h-full">
      <WizardSidebar
        vials={wiz.vials}
        activeSampleId={editingSampleId}
        onSelect={setEditingSampleId}
      />
      <VialPanel
        parentSampleId={parentSampleId}
        editingSub={editingSampleId ? wiz.vials.find(v => v.sub.sample_id === editingSampleId)?.sub ?? null : null}
        onSaveNew={async (photo, remarks) => { await wiz.saveNewVial(photo, remarks); setEditingSampleId(null) }}
        onSaveEdit={async (sid, photo, remarks) => { await wiz.editSessionVial(sid, photo, remarks); setEditingSampleId(null) }}
        onDelete={async (sid) => { await wiz.deleteSessionVial(sid); setEditingSampleId(null) }}
        onDone={() => setPhase('print')}
      />
    </div>
  )
}
```

- [ ] **Step 4: Verify it compiles**

```bash
npm run check:all
```

- [ ] **Step 5: Commit**

```bash
git add src/components/intake/ReceiveWizard/
git commit -m "feat(sub-samples): wizard scaffolding"
```

---

## Task 12: Wizard sidebar

**Files:**
- Modify: `src/components/intake/ReceiveWizard/WizardSidebar.tsx`

- [ ] **Step 1: Implement**

```typescript
import { Link } from 'react-router-dom'
import { SubSample } from '@/lib/api'

interface Vial { sub: SubSample; isThisSession: boolean }

interface Props {
  vials: Vial[]
  activeSampleId: string | null
  onSelect: (sampleId: string | null) => void
}

export function WizardSidebar({ vials, activeSampleId, onSelect }: Props) {
  return (
    <aside className="border-r p-3 overflow-y-auto">
      <h3 className="font-semibold mb-2">Vials received</h3>
      <button
        className="w-full text-left p-2 mb-2 rounded border-2 border-dashed hover:bg-muted"
        onClick={() => onSelect(null)}
      >
        + New vial
      </button>
      <ul className="space-y-2">
        {vials.map(v => (
          <li key={v.sub.sample_id}>
            <button
              className={`w-full text-left p-2 rounded ${activeSampleId === v.sub.sample_id ? 'bg-primary/10' : 'hover:bg-muted'}`}
              onClick={() => v.isThisSession ? onSelect(v.sub.sample_id) : undefined}
              disabled={!v.isThisSession}
              title={v.isThisSession ? 'Edit this vial' : 'Received in a prior session — read-only'}
            >
              <div className="font-mono text-sm">{v.sub.sample_id}</div>
              <div className="text-xs text-muted-foreground">
                Vial {v.sub.vial_sequence} {!v.isThisSession && '· read-only'}
              </div>
              {!v.isThisSession && (
                <Link
                  to={`/samples/${v.sub.sample_id}`}
                  className="text-xs underline"
                  onClick={e => e.stopPropagation()}
                >
                  View details
                </Link>
              )}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
```

- [ ] **Step 2: Type-check, commit**

```bash
npm run check:all
git add src/components/intake/ReceiveWizard/WizardSidebar.tsx
git commit -m "feat(sub-samples): wizard sidebar"
```

---

## Task 13: Vial panel — capture, save, edit, delete

**Files:**
- Modify: `src/components/intake/ReceiveWizard/VialPanel.tsx`

- [ ] **Step 1: Implement**

```typescript
import { useState, useRef, useEffect } from 'react'
import { SubSample } from '@/lib/api'

interface Props {
  parentSampleId: string
  editingSub: SubSample | null
  onSaveNew: (photoBase64: string, remarks?: string) => Promise<void>
  onSaveEdit: (sampleId: string, photoBase64?: string, remarks?: string) => Promise<void>
  onDelete: (sampleId: string) => Promise<void>
  onDone: () => void
}

export function VialPanel({ parentSampleId, editingSub, onSaveNew, onSaveEdit, onDelete, onDone }: Props) {
  const [photo, setPhoto] = useState<string | null>(null)
  const [remarks, setRemarks] = useState(editingSub?.remarks ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [cameraOk, setCameraOk] = useState(true)

  useEffect(() => {
    setRemarks(editingSub?.remarks ?? '')
    setPhoto(null)
  }, [editingSub])

  useEffect(() => {
    let stream: MediaStream | null = null
    navigator.mediaDevices?.getUserMedia({ video: true })
      .then(s => { stream = s; if (videoRef.current) videoRef.current.srcObject = s })
      .catch(() => setCameraOk(false))
    return () => { stream?.getTracks().forEach(t => t.stop()) }
  }, [])

  const capture = () => {
    if (!videoRef.current || !canvasRef.current) return
    const v = videoRef.current, c = canvasRef.current
    c.width = v.videoWidth; c.height = v.videoHeight
    c.getContext('2d')!.drawImage(v, 0, 0)
    setPhoto(c.toDataURL('image/jpeg', 0.85))
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    const r = new FileReader()
    r.onload = () => setPhoto(String(r.result))
    r.readAsDataURL(f)
  }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const photoB64 = photo ? photo.replace(/^data:image\/[^;]+;base64,/, '') : undefined
      if (editingSub) {
        await onSaveEdit(editingSub.sample_id, photoB64, remarks || undefined)
      } else {
        if (!photoB64) { setError('Photo is required'); setBusy(false); return }
        await onSaveNew(photoB64, remarks || undefined)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="p-6 flex flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-xl">{editingSub ? `Editing ${editingSub.sample_id}` : `New vial for ${parentSampleId}`}</h2>
        <button onClick={onDone} className="text-sm underline">Done — print labels</button>
      </header>

      {cameraOk ? (
        <div>
          <video ref={videoRef} autoPlay playsInline className="w-full max-w-md rounded bg-black" />
          <canvas ref={canvasRef} className="hidden" />
          <button onClick={capture} disabled={busy} className="mt-2 btn">Capture photo</button>
        </div>
      ) : (
        <div>
          <p>Camera unavailable. Upload a file instead:</p>
          <input ref={fileRef} type="file" accept="image/*" onChange={onPick} />
        </div>
      )}

      {photo && <img src={photo} alt="captured" className="max-w-md rounded border" />}
      {editingSub?.photo_external_uid && !photo && (
        <img src={`/api/senaite/attachment/${editingSub.photo_external_uid}`} className="max-w-md rounded border" />
      )}

      <label className="block">
        <span className="block text-sm">Remarks (optional)</span>
        <textarea value={remarks} onChange={e => setRemarks(e.target.value)} className="w-full max-w-md border rounded p-2" rows={3} />
      </label>

      {error && <p className="text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button onClick={save} disabled={busy} className="btn-primary">
          {busy ? 'Saving…' : (editingSub ? 'Save changes' : 'Save vial')}
        </button>
        {editingSub && (
          <button
            onClick={async () => { if (confirm('Delete this vial?')) await onDelete(editingSub.sample_id) }}
            disabled={busy}
            className="btn-danger"
          >
            Delete vial
          </button>
        )}
      </div>
    </main>
  )
}
```

(`btn`, `btn-primary`, `btn-danger` are placeholder class names — match existing project conventions for buttons; check `src/components/ui/` for the actual primitives.)

- [ ] **Step 2: Smoke**

Open the wizard via the entry point added in Task 15 — verify the camera prompts for permission, capture works, save round-trips through the backend, sidebar updates.

- [ ] **Step 3: Commit**

```bash
git add src/components/intake/ReceiveWizard/VialPanel.tsx
git commit -m "feat(sub-samples): wizard vial panel with camera capture, save, edit, delete"
```

---

## Task 14: Print step + label template

**Files:**
- Modify: `src/components/intake/ReceiveWizard/PrintStep.tsx`
- Modify: `src/components/intake/ReceiveWizard/LabelTemplate.tsx`
- Add CSS: `src/components/intake/ReceiveWizard/PrintStep.css`
- Add dependency: `npm install jsbarcode`

- [ ] **Step 1: Install JsBarcode**

```bash
npm install jsbarcode
npm install --save-dev @types/jsbarcode
```

- [ ] **Step 2: Implement `LabelTemplate.tsx`**

```typescript
import { useEffect, useRef } from 'react'
import JsBarcode from 'jsbarcode'

export function LabelTemplate({ sampleId }: { sampleId: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (ref.current) {
      JsBarcode(ref.current, sampleId, {
        format: 'CODE39',
        width: 1.4,
        height: 30,
        displayValue: false,
        margin: 0,
      })
    }
  }, [sampleId])
  return (
    <div className="label">
      <svg ref={ref} />
      <div className="label-id">{sampleId}</div>
    </div>
  )
}
```

- [ ] **Step 3: Implement `PrintStep.tsx`**

```typescript
import { useEffect } from 'react'
import { SubSample } from '@/lib/api'
import { LabelTemplate } from './LabelTemplate'
import './PrintStep.css'

interface Props { vials: SubSample[]; onDone: () => void }

export function PrintStep({ vials, onDone }: Props) {
  useEffect(() => {
    // Auto-trigger print dialog 200ms after mount so the page renders first.
    const t = setTimeout(() => window.print(), 200)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className="p-6">
      <header className="screen-only flex justify-between mb-4">
        <h2>Print {vials.length} label{vials.length === 1 ? '' : 's'}</h2>
        <div className="flex gap-2">
          <button onClick={() => window.print()} className="btn-primary">Print</button>
          <button onClick={onDone} className="btn">Skip — close</button>
        </div>
      </header>
      <div className="print-area">
        {vials.map(v => <LabelTemplate key={v.sample_id} sampleId={v.sample_id} />)}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add `PrintStep.css`**

Create alongside:

```css
@media screen {
  .print-area .label {
    display: inline-block;
    border: 1px dashed #ccc;
    padding: 4px;
    margin: 2px;
    width: 50.8mm;
    height: 6.35mm;
  }
  .print-area .label-id {
    font-family: ui-monospace, monospace;
    font-size: 8pt;
    text-align: center;
  }
}

@media print {
  .screen-only { display: none; }
  body { margin: 0; }
  @page { size: 50.8mm 6.35mm; margin: 0; }
  .label { page-break-after: always; padding: 0; margin: 0; }
  .label svg { width: 48mm; height: 4mm; display: block; margin: 0 auto; }
  .label-id { font-family: ui-monospace, monospace; font-size: 6pt; text-align: center; }
}
```

**Note:** `@page` size is the assumed physical media size from the spec's open-items. Adjust at smoke-test time once the actual stock is measured against SENAITE's "Code 39 40×20mm" template.

- [ ] **Step 5: Smoke-test on receiver workstation**

Run wizard end-to-end, hit Done — verify:
1. Print preview opens automatically
2. Cab printer is selectable from the dialog
3. Output prints with readable barcode + ID

If alignment/density wrong: tune CSS sizes; do not switch to WebUSB unless it's a real blocker.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/components/intake/ReceiveWizard/PrintStep.tsx src/components/intake/ReceiveWizard/LabelTemplate.tsx src/components/intake/ReceiveWizard/PrintStep.css
git commit -m "feat(sub-samples): batch label print step with Code 39 barcode"
```

---

## Task 15: Wire wizard into intake list (first-receive entry)

**Files:**
- Modify: `src/components/intake/ReceiveSample.tsx` — replace existing receive trigger with wizard launch.

- [ ] **Step 1: Read existing entry pattern**

Open `src/components/intake/ReceiveSample.tsx` and find the row-click / receive-button onClick.

- [ ] **Step 2: Add wizard state and launch**

Near the top of the component:

```typescript
import { ReceiveWizard } from './ReceiveWizard/ReceiveWizard'
const [wizardParent, setWizardParent] = useState<string | null>(null)
```

In JSX, replace the existing receive button onClick with `setWizardParent(row.sample_id)`. After the table:

```tsx
{wizardParent && (
  <Modal onClose={() => { setWizardParent(null); refetch() }}>
    <ReceiveWizard parentSampleId={wizardParent} onClose={() => { setWizardParent(null); refetch() }} />
  </Modal>
)}
```

(Replace `Modal` and `refetch` with the conventions in this file — likely an existing Dialog primitive and a TanStack Query refetch.)

- [ ] **Step 3: Smoke**

Open intake list, click receive on a parent — wizard mounts, save a vial, verify the sample shows as received and a sub-sample exists.

- [ ] **Step 4: Commit**

```bash
git add src/components/intake/ReceiveSample.tsx
git commit -m "feat(sub-samples): launch wizard from intake list"
```

---

## Task 16: SampleDetails — Sub-Samples + Sub-Sample Analyses sections

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` — append two sections after existing analyses display.

- [ ] **Step 1: Locate insertion point**

Open `src/components/senaite/SampleDetails.tsx` and find the bottom of the existing analyses section (around the area near line 388 referenced in the spec).

- [ ] **Step 2: Add the print-via-portal helper**

We need to reprint a single label without using `document.write` (security/perf). Approach: render `<LabelTemplate>` in a hidden iframe via React portal, call `iframe.contentWindow.print()`.

Create `src/components/intake/ReceiveWizard/usePrintLabel.ts`:

```typescript
import { createRoot } from 'react-dom/client'
import { LabelTemplate } from './LabelTemplate'

export function printSingleLabel(sampleId: string) {
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument!
  // Copy our print stylesheet into the iframe via a <link> element — built safely with DOM APIs.
  const link = doc.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/print.css'  // serve PrintStep.css at /print.css or import via inline <style>
  doc.head.appendChild(link)

  const mount = doc.createElement('div')
  doc.body.appendChild(mount)

  const root = createRoot(mount)
  root.render(<LabelTemplate sampleId={sampleId} />)

  // Give React + barcode SVG a tick to render
  setTimeout(() => {
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    setTimeout(() => {
      root.unmount()
      iframe.remove()
    }, 1000)
  }, 200)
}
```

If serving `print.css` at a stable URL is awkward, inline the styles into the iframe via `doc.createElement('style')` + `style.textContent = '...'` (still a safe DOM approach).

- [ ] **Step 3: Add the SampleDetails sections**

In the JSX of `SampleDetails.tsx`, append:

```tsx
import { useQuery } from '@tanstack/react-query'
import { listSubSamples } from '@/lib/api'
import { ReceiveWizard } from '@/components/intake/ReceiveWizard/ReceiveWizard'
import { printSingleLabel } from '@/components/intake/ReceiveWizard/usePrintLabel'
import { useState } from 'react'

// Inside component, near other hooks:
const [wizardOpen, setWizardOpen] = useState(false)
const { data: subData, refetch: refetchSubs } = useQuery({
  queryKey: ['sub-samples', sampleId],
  queryFn: () => listSubSamples(sampleId),
  enabled: !!sampleId,
})

// In JSX, append below existing analyses display:
<section className="mt-8">
  <header className="flex items-baseline justify-between">
    <h2 className="text-lg font-semibold">Sub-Samples ({subData?.parent.sub_sample_count ?? 0})</h2>
    <button onClick={() => setWizardOpen(true)} className="btn">+ Add Sub-Sample</button>
  </header>
  {subData?.sub_samples.length === 0 ? (
    <p className="text-muted-foreground">No sub-samples yet.</p>
  ) : (
    <table className="w-full mt-2">
      <thead>
        <tr><th>Vial</th><th>ID</th><th>Photo</th><th>Received</th><th>By</th><th></th></tr>
      </thead>
      <tbody>
        {subData?.sub_samples.map(s => (
          <tr key={s.sample_id}>
            <td>{s.vial_sequence}</td>
            <td className="font-mono">{s.sample_id}</td>
            <td>
              {s.photo_external_uid && (
                <img src={`/api/senaite/attachment/${s.photo_external_uid}`} className="h-12 rounded" alt="vial" />
              )}
            </td>
            <td>{new Date(s.received_at).toLocaleString()}</td>
            <td>{s.received_by_user_id ?? '—'}</td>
            <td>
              <Link to={`/samples/${s.sample_id}`} className="underline">View</Link>
              <button onClick={() => printSingleLabel(s.sample_id)} className="ml-2 underline">Print Label</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</section>

<section className="mt-8">
  <h2 className="text-lg font-semibold">Sub-Sample Analyses</h2>
  <p className="text-muted-foreground">
    Per-sub-sample analyses appear here once the worksheet vial-to-test assignment phase ships.
    No analyses are routed to sub-samples in v1.
  </p>
</section>

{wizardOpen && (
  <Modal onClose={() => { setWizardOpen(false); refetchSubs() }}>
    <ReceiveWizard parentSampleId={sampleId} onClose={() => { setWizardOpen(false); refetchSubs() }} />
  </Modal>
)}
```

- [ ] **Step 4: Smoke**

Open a parent sample with sub-samples — verify both sections render, Add Sub-Sample opens wizard, View navigates correctly, Print Label triggers print dialog.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/SampleDetails.tsx src/components/intake/ReceiveWizard/usePrintLabel.ts
git commit -m "feat(sub-samples): SampleDetails Sub-Samples and Sub-Sample Analyses sections"
```

---

## Task 17: Intake list vial-count column

**Files:**
- Modify: `src/components/intake/ReceiveSample.tsx` — add a column.

- [ ] **Step 1: Fetch counts**

For each row (parent), fetch `listSubSamples(row.sample_id).parent.sub_sample_count`. Two options:
- **Lazy per-row:** TanStack Query per row — simple, fine for ≤50 rows.
- **Batch endpoint:** Add `GET /api/sub-samples/counts?parent_sample_ids=A,B,C` returning `{A: 2, B: 0, C: 3}`. Worth doing if the intake list grows past 50 parents.

Start with lazy per-row.

- [ ] **Step 2: Render**

Add a "Vials" column: `{count > 0 ? `${count} received` : '—'}`.

- [ ] **Step 3: Commit**

```bash
git add src/components/intake/ReceiveSample.tsx
git commit -m "feat(sub-samples): vial-count column on intake list"
```

---

## Task 18: SampleIdBadge swap-in — sample/order pages

**Files:** modify each, swap raw `{sample_id}` renders for `<SampleIdBadge>`.

- Modify: `src/components/senaite/SampleDetails.tsx:388, 2040, 2042`
- Modify: `src/components/COAExplorer.tsx:324`
- Modify: `src/components/explorer/OrderDetailPanel.tsx:364, 616, 924, 1033`
- Modify: `src/components/OrderStatusPage.tsx:248, 719, 1155, 1173`
- Modify: `src/components/explorer/AddSamplesModal.tsx:134`

- [ ] **Step 1: Confirm exact line numbers via grep**

```bash
grep -nE "\{[a-zA-Z_.]*sample[_-]?id[^}]*\}" src/components/senaite/SampleDetails.tsx src/components/COAExplorer.tsx src/components/explorer/OrderDetailPanel.tsx src/components/OrderStatusPage.tsx src/components/explorer/AddSamplesModal.tsx
```

(Spec line numbers may have drifted; use current grep results.)

- [ ] **Step 2: Replace each match with `<SampleIdBadge>`**

Pattern:

```tsx
// before
<span>{row.sample_id}</span>

// after
<SampleIdBadge
  id={row.sample_id}
  parentId={row.parent_sample_id}     // may be undefined; component handles it
  vialSequence={row.vial_sequence}    // may be undefined
  hasChildren={row.sub_sample_count}  // may be undefined
/>
```

The row data may not yet carry `parent_sample_id` / `vial_sequence` / `sub_sample_count`. Per file:
- If the row already has the data, pass it.
- If not, fall back to bare `<SampleIdBadge id={row.sample_id} />` and add a TODO comment to thread the parent info through the API. (Threading the API responses to include hierarchy is a follow-up — outside this plan's scope.)

- [ ] **Step 3: Visual smoke per file** — open each page in the browser, confirm IDs still render and clicks still work.

- [ ] **Step 4: Commit**

```bash
git add src/components/senaite/SampleDetails.tsx src/components/COAExplorer.tsx src/components/explorer/OrderDetailPanel.tsx src/components/OrderStatusPage.tsx src/components/explorer/AddSamplesModal.tsx
git commit -m "feat(sub-samples): SampleIdBadge swap-in for sample/order pages"
```

---

## Task 19: SampleIdBadge swap-in — HPLC/worksheet/report pages

**Files:**
- Modify: `src/components/hplc/SamplePreps.tsx`
- Modify: `src/components/hplc/SamplePrepHplcFlyout.tsx:346, 1006, 1303, 1331`
- Modify: `src/components/hplc/WorksheetDrawerItems.tsx:239, 404`
- Modify: `src/components/hplc/WorksheetsInboxPage.tsx:337`
- Modify: `src/components/AnalysisResults.tsx:152`
- Modify: `src/components/CalibrationPanel.tsx:287, 543, 764`
- Modify: `src/components/reports/PurityTrendView.tsx:59`

- [ ] **Step 1: Confirm exact line numbers via grep** — same approach as Task 18.

- [ ] **Step 2: Same swap pattern as Task 18.**

- [ ] **Step 3: Visual smoke per file.**

- [ ] **Step 4: Commit**

```bash
git add src/components/hplc/ src/components/AnalysisResults.tsx src/components/CalibrationPanel.tsx src/components/reports/PurityTrendView.tsx
git commit -m "feat(sub-samples): SampleIdBadge swap-in for HPLC/worksheet/report pages"
```

---

## Task 20: Backend integration tests against SENAITE container

**Files:**
- Create: `backend/tests/test_sub_samples_integration.py`

Slower tests requiring a live SENAITE; mark them so they don't run by default.

- [ ] **Step 1: Write the integration tests**

```python
import pytest
import os

pytestmark = pytest.mark.integration

SENAITE_BASE_URL = os.environ.get("SENAITE_BASE_URL", "http://localhost:8080/senaite")


def test_create_three_secondaries_yields_S01_S02_S03(db_session, parent_p_test):
    """Hits live SENAITE."""
    from sub_samples import service
    photo = "iVBORw0KGgo="  # tiny placeholder PNG base64
    s1 = service.create_sub_sample(db_session, parent_p_test.sample_id, photo, None, user_id=1)
    s2 = service.create_sub_sample(db_session, parent_p_test.sample_id, photo, None, user_id=1)
    s3 = service.create_sub_sample(db_session, parent_p_test.sample_id, photo, None, user_id=1)
    assert s1.sample_id.endswith("-S01")
    assert s2.sample_id.endswith("-S02")
    assert s3.sample_id.endswith("-S03")


def test_secondary_against_retest_parent_strips_suffix(db_session, parent_with_retest_suffix):
    # Parent with id like P-0134-R01 — secondary should be P-0134-S01, not P-0134-R01-S01.
    from sub_samples import service
    s1 = service.create_sub_sample(db_session, parent_with_retest_suffix.sample_id, "iVBOR", None, 1)
    base = parent_with_retest_suffix.sample_id.replace("-R01", "")
    assert s1.sample_id == f"{base}-S01"


def test_after_the_fact_does_not_regress_parent_state(db_session, already_received_parent):
    """Adding a vial to an already-received parent does not change parent state."""
    from sub_samples import service
    state_before = already_received_parent.status
    service.create_sub_sample(db_session, already_received_parent.sample_id, "iVBOR", None, 1)
    db_session.refresh(already_received_parent)
    assert already_received_parent.status == state_before
```

Add fixtures (`parent_p_test`, `parent_with_retest_suffix`, `already_received_parent`) in `conftest.py` that seed SENAITE with the required state via the existing test infrastructure.

- [ ] **Step 2: Run only when SENAITE is up**

```bash
docker exec accu-mk1-backend python -m pytest backend/tests/test_sub_samples_integration.py -v -m integration
```

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_sub_samples_integration.py backend/tests/conftest.py
git commit -m "test(sub-samples): integration tests against live SENAITE"
```

---

## Task 21: E2E happy-path Playwright

**Files:**
- Create: `e2e-tests/tests/sub-samples.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
import { test, expect } from '@playwright/test'

test('receive 2 vials, print, then add a third after-the-fact', async ({ page, context }) => {
  await context.grantPermissions(['camera'])

  await page.goto('/intake')
  await page.getByRole('row', { name: /P-TEST/ }).getByRole('button', { name: /receive/i }).click()

  // Vial 1
  await page.getByRole('button', { name: /capture photo/i }).click()
  await page.getByLabel(/remarks/i).fill('vial 1')
  await page.getByRole('button', { name: /save vial/i }).click()
  await expect(page.getByText(/P-TEST-S01/)).toBeVisible()

  // Vial 2
  await page.getByRole('button', { name: /\+ new vial/i }).click()
  await page.getByRole('button', { name: /capture photo/i }).click()
  await page.getByRole('button', { name: /save vial/i }).click()
  await expect(page.getByText(/P-TEST-S02/)).toBeVisible()

  // Print step
  await page.getByRole('button', { name: /done — print labels/i }).click()
  await expect(page.getByText(/print 2 labels/i)).toBeVisible()
  await page.getByRole('button', { name: /skip — close/i }).click()

  // After-the-fact
  await page.goto('/sample/P-TEST')
  await page.getByRole('button', { name: /add sub-sample/i }).click()
  await page.getByRole('button', { name: /capture photo/i }).click()
  await page.getByRole('button', { name: /save vial/i }).click()
  await expect(page.getByText(/P-TEST-S03/)).toBeVisible()

  // Direct URL
  await page.goto('/samples/P-TEST-S02')
  await expect(page.getByRole('heading', { name: /P-TEST-S02/ })).toBeVisible()
})
```

- [ ] **Step 2: Run**

```bash
cd e2e-tests
npm run test:e2e -- sub-samples.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add e2e-tests/tests/sub-samples.spec.ts
git commit -m "test(sub-samples): e2e happy path"
```

---

## Task 22: Manual smoke checklist + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Optional: `docs/userguide/userguide.md` — receive flow update.

- [ ] **Step 1: Receiver workstation smoke**

On the actual lab receiver workstation:
1. Open Accu-Mk1 in browser
2. Receive a real test parent through the wizard with 2 vials
3. Print labels — verify on Cab Mach 4S/600B:
   - Alignment correct
   - Density readable
   - Code 39 barcode scans cleanly with the lab scanner
4. Reprint one label from the parent detail page — verify identical output
5. Add a third vial via "Add Sub-Sample" — verify it appears at vial_sequence 3
6. Open `/samples/P-XXXX-S02` directly — verify detail page loads

If any step fails, fix and re-run.

- [ ] **Step 2: Update CHANGELOG**

Add under Unreleased:

```
### Added
- Sub-Samples: receive multiple vials per parent sample as native SENAITE secondaries (P-XXXX-S01, etc.) via a new grow-as-you-go wizard with photo capture and batch label printing.
- Parent sample detail page now shows a Sub-Samples section listing each child with photo and vial sequence; an "Add Sub-Sample" button allows after-the-fact additions.
- New /samples/:sampleId route for direct navigation to any sample (parent or sub-sample); supports barcode-scan landing.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for sub-samples feature"
```

---

## Final review checklist (before opening PR)

- [ ] All unit tests pass: `npm run check:all` and `docker exec accu-mk1-backend python -m pytest backend/tests/ -v`
- [ ] Integration tests pass against local SENAITE
- [ ] E2E happy path passes
- [ ] Manual smoke on receiver workstation completed
- [ ] No lingering TODOs in code (all resolved or filed as follow-up tickets)
- [ ] Spec file references match what's actually built
- [ ] Sub-Sample Analyses section renders correctly with zero rows (per spec — empty in v1)
