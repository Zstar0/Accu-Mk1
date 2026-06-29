# Phase 1 — Order-First Check-in + Boxing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the front desk receive a whole order (all its samples + vials) in one session and group the order's vials into physical boxes with printed `{order}-{n}` labels.

**Architecture:** Additive. Backend gains a `lims_boxes` table (keyed by an `order_key` string) and a `box_id` link on `lims_sub_samples`, plus a small `/api/boxes` module (list / create / assign / print). Frontend gains a By-order/By-sample toggle on the existing Receive Samples page, an order-scoped session that walks each sample through today's `ReceiveWizard`, and a final order-level boxing stage that reuses the dnd-kit drag idiom. No existing behavior is removed — By-sample mode is the unchanged fallback.

**Tech Stack:** Backend FastAPI + SQLAlchemy 2.0 (`Mapped`/`mapped_column`), Pydantic v2, pytest (in-memory SQLite). Frontend React 19 + TypeScript + TanStack Query + @dnd-kit + Vitest/RTL. npm only.

## Global Constraints

- **Additive only** — never re-architect existing systems; a failing existing test defaults to "test is stale," not "code is wrong." No production-behavior change without sign-off.
- **`lims_` prefix** for all LIMS-side tables (`lims_boxes`).
- **npm only** for the frontend (never pnpm).
- **Mk1 migrations** = `create_all` + hand-rolled idempotent `ALTER TABLE … IF NOT EXISTS` strings in `backend/database.py:_run_migrations()` (Postgres prod). Tests use `Base.metadata.create_all()` and seed models directly — do **not** test raw ALTER strings under SQLite.
- **Box label code** = the order number rendered **verbatim** as the vial label renders it (`client_order_number`, e.g. `WP-20066`) + `-{n}`. Never prepend a second `WP-`.
- **Roles** are exactly `hplc` | `endo` | `ster` | `xtra`; only `hplc`/`endo`/`ster` are boxed (Xtra excluded).
- Run `npm run check:all` (frontend) and `pytest` (backend) before declaring a task done; net-new test failures only (≈19-failure baseline is known).
- ISO 17025: box create/assign/print record `created_by`/`created_at` and `printed_by`/`printed_at` (attribution).

---

## File Structure

**Backend (new module `backend/boxes/`):**
- `backend/models.py` — MODIFY: add `LimsBox` model; add `box_id` column + relationship to `LimsSubSample`.
- `backend/database.py` — MODIFY: add `CREATE TABLE lims_boxes` + `ALTER TABLE lims_sub_samples ADD COLUMN box_id` to `_run_migrations()`.
- `backend/boxes/__init__.py` — CREATE (empty package marker).
- `backend/boxes/schemas.py` — CREATE: Pydantic request/response models.
- `backend/boxes/service.py` — CREATE: box business logic (next-number, create, assign, print, list).
- `backend/boxes/routes.py` — CREATE: `/api/boxes` router.
- `backend/main.py` — MODIFY: `include_router(boxes_router)`.
- `backend/tests/test_boxes_service.py` — CREATE.
- `backend/tests/test_boxes_routes.py` — CREATE.

**Frontend:**
- `src/lib/api.ts` — MODIFY: add `LimsBox` type + `listOrderBoxes`/`createBox`/`assignVialsToBox`/`printBox` functions.
- `src/lib/inbox-orders.ts` — CREATE: client-side order grouping (mirror `inbox-families.ts`).
- `src/test/inbox-orders.test.ts` — CREATE.
- `src/components/intake/ReceiveSample.tsx` — MODIFY: By-order/By-sample toggle + order-grouped list.
- `src/components/intake/OrderReceiveSession.tsx` — CREATE: sample stepper around `ReceiveWizard` + boxing stage entry.
- `src/components/intake/ReceiveWizard/BoxStep.tsx` — CREATE: order-level boxing UI.
- `src/components/intake/ReceiveWizard/BoxLabelTemplate.tsx` — CREATE: box label render (reuse existing label CSS).
- `src/test/box-step.test.tsx` — CREATE.

---

## Task 1: Schema — `LimsBox` model, `box_id` on sub-sample, migrations

**Files:**
- Modify: `backend/models.py` (after `LimsSubSample`, ~line 807)
- Modify: `backend/database.py` (`_run_migrations()` list)
- Test: `backend/tests/test_boxes_schema.py` (create)

**Interfaces:**
- Produces: `LimsBox(id, order_key, box_number, role, vial_count→derived, created_by_user_id, created_at, printed_at, printed_by_user_id)`; `LimsSubSample.box_id: Optional[int]` FK → `lims_boxes.id`; relationship `LimsBox.vials` ↔ `LimsSubSample.box`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_boxes_schema.py`:
```python
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsSample, LimsSubSample, LimsBox


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_box_holds_vials_across_two_samples_of_same_order(db):
    # Two parents that share one order_key, one HPLC vial each.
    p1 = LimsSample(sample_id="P-0500", external_lims_uid="u-500")
    p2 = LimsSample(sample_id="P-0501", external_lims_uid="u-501")
    db.add_all([p1, p2])
    db.flush()
    box = LimsBox(order_key="WP-20066", box_number=1, role="hplc")
    db.add(box)
    db.flush()
    v1 = LimsSubSample(parent_sample_pk=p1.id, external_lims_uid="mk1://a",
                       sample_id="P-0500-S01", vial_sequence=1,
                       assignment_role="hplc", box_id=box.id)
    v2 = LimsSubSample(parent_sample_pk=p2.id, external_lims_uid="mk1://b",
                       sample_id="P-0501-S01", vial_sequence=1,
                       assignment_role="hplc", box_id=box.id)
    db.add_all([v1, v2])
    db.commit()

    assert {v.sample_id for v in box.vials} == {"P-0500-S01", "P-0501-S01"}
    assert v1.box.order_key == "WP-20066"
    assert v1.box.box_number == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_boxes_schema.py -v`
Expected: FAIL with `ImportError: cannot import name 'LimsBox'`.

- [ ] **Step 3: Add the `LimsBox` model and `box_id` column**

In `backend/models.py`, immediately after the `LimsSubSample` class (after the `parent_sample` relationship, ~line 807), add:
```python
class LimsBox(Base):
    """A physical check-in box/bin holding an order's vials of one test type.

    Keyed by `order_key` (the order number string as shown on labels, e.g.
    'WP-20066'; falls back to a parent sample_id for order-less receives).
    `box_number` runs 1..N per order_key across all of the order's samples.
    A box holds vials of exactly one role (color-coded bin).
    """
    __tablename__ = "lims_boxes"
    __table_args__ = (UniqueConstraint("order_key", "box_number", name="uq_lims_box_order_number"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_key: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    box_number: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(8), nullable=False)  # hplc | endo | ster
    created_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    printed_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    printed_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))

    vials: Mapped[List["LimsSubSample"]] = relationship("LimsSubSample", back_populates="box")
```

In the `LimsSubSample` class, add the `box_id` column (after `assignment_kind`, before `in_variance_set`):
```python
    box_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("lims_boxes.id", ondelete="SET NULL"))
```

And add the inverse relationship (after the existing `parent_sample` relationship):
```python
    box: Mapped[Optional["LimsBox"]] = relationship("LimsBox", back_populates="vials")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/test_boxes_schema.py -v`
Expected: PASS.

- [ ] **Step 5: Add the prod (Postgres) migrations**

In `backend/database.py`, inside the `migrations = [ … ]` list in `_run_migrations()`, append:
```python
        """
        CREATE TABLE IF NOT EXISTS lims_boxes (
            id SERIAL PRIMARY KEY,
            order_key VARCHAR(100) NOT NULL,
            box_number INTEGER NOT NULL,
            role VARCHAR(8) NOT NULL,
            created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            printed_at TIMESTAMP,
            printed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            CONSTRAINT uq_lims_box_order_number UNIQUE (order_key, box_number)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_boxes_order_key ON lims_boxes (order_key)",
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS box_id INTEGER REFERENCES lims_boxes(id) ON DELETE SET NULL",
```

- [ ] **Step 6: Run the full schema test once more + commit**

Run: `cd backend && pytest tests/test_boxes_schema.py -v`
Expected: PASS.
```bash
git add backend/models.py backend/database.py backend/tests/test_boxes_schema.py
git commit -m "feat(boxes): add lims_boxes table + sub_sample.box_id"
```

---

## Task 2: Box service + `/api/boxes` routes

**Files:**
- Create: `backend/boxes/__init__.py`, `backend/boxes/schemas.py`, `backend/boxes/service.py`, `backend/boxes/routes.py`
- Modify: `backend/main.py` (include router)
- Test: `backend/tests/test_boxes_service.py`, `backend/tests/test_boxes_routes.py`

**Interfaces:**
- Consumes: `LimsBox`, `LimsSubSample` (Task 1); `get_db`, `get_current_user` deps (existing).
- Produces:
  - `service.next_box(db, order_key, role, user_id) -> LimsBox`
  - `service.assign_vials(db, box_id, sub_sample_ids) -> LimsBox` (raises `ValueError` on role mismatch, `LookupError` if missing)
  - `service.mark_printed(db, box_id, user_id) -> LimsBox`
  - `service.list_for_order(db, order_key) -> list[LimsBox]`
  - `box_label_code(box) -> str` = `f"{box.order_key}-{box.box_number}"`
  - Routes: `GET /api/boxes?order_key=`, `POST /api/boxes`, `POST /api/boxes/{box_id}/assign`, `POST /api/boxes/{box_id}/print`
  - `BoxResponse{id, order_key, box_number, role, label_code, vial_count, printed_at}`

- [ ] **Step 1: Write the failing service test**

Create `backend/tests/test_boxes_service.py`:
```python
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsSample, LimsSubSample
from boxes import service


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _vial(db, parent, seq, role):
    sub = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid=f"mk1://{parent.sample_id}-{seq}",
        sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq, assignment_role=role,
    )
    db.add(sub)
    db.flush()
    return sub


def test_next_box_numbers_run_per_order(db):
    b1 = service.next_box(db, "WP-20066", "hplc", user_id=1)
    b2 = service.next_box(db, "WP-20066", "ster", user_id=1)
    b3 = service.next_box(db, "WP-20071", "hplc", user_id=1)
    assert (b1.box_number, b2.box_number) == (1, 2)   # running across bins for one order
    assert b3.box_number == 1                          # separate order restarts
    assert service.box_label_code(b2) == "WP-20066-2"


def test_assign_rejects_role_mismatch(db):
    p = LimsSample(sample_id="P-0600", external_lims_uid="u-600")
    db.add(p); db.flush()
    endo_vial = _vial(db, p, 1, "endo")
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    with pytest.raises(ValueError):
        service.assign_vials(db, box.id, [endo_vial.sample_id])


def test_assign_then_print_records_membership_and_stamp(db):
    p = LimsSample(sample_id="P-0601", external_lims_uid="u-601")
    db.add(p); db.flush()
    v = _vial(db, p, 1, "hplc")
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    service.assign_vials(db, box.id, [v.sample_id])
    assert v.box_id == box.id
    printed = service.mark_printed(db, box.id, user_id=7)
    assert printed.printed_at is not None
    assert printed.printed_by_user_id == 7
    assert len(service.list_for_order(db, "WP-20066")) == 1
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && pytest tests/test_boxes_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'boxes'`.

- [ ] **Step 3: Create the package, schemas, and service**

Create `backend/boxes/__init__.py` (empty file).

Create `backend/boxes/schemas.py`:
```python
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel


class CreateBoxRequest(BaseModel):
    order_key: str
    role: str  # hplc | endo | ster


class AssignVialsRequest(BaseModel):
    sub_sample_ids: List[str]


class BoxResponse(BaseModel):
    id: int
    order_key: str
    box_number: int
    role: str
    label_code: str
    vial_count: int
    printed_at: Optional[datetime] = None

    class Config:
        from_attributes = True
```

Create `backend/boxes/service.py`:
```python
from datetime import datetime
from typing import List

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from models import LimsBox, LimsSubSample

BOXABLE_ROLES = {"hplc", "endo", "ster"}


def box_label_code(box: LimsBox) -> str:
    """Verbatim order key + running number; never adds a 'WP-' prefix."""
    return f"{box.order_key}-{box.box_number}"


def vial_count(db: Session, box_id: int) -> int:
    return db.scalar(
        select(func.count()).select_from(LimsSubSample).where(LimsSubSample.box_id == box_id)
    ) or 0


def next_box(db: Session, order_key: str, role: str, user_id: int) -> LimsBox:
    if role not in BOXABLE_ROLES:
        raise ValueError(f"role {role!r} is not boxable")
    current_max = db.scalar(
        select(func.max(LimsBox.box_number)).where(LimsBox.order_key == order_key)
    )
    box = LimsBox(
        order_key=order_key,
        box_number=(current_max or 0) + 1,
        role=role,
        created_by_user_id=user_id,
    )
    db.add(box)
    db.commit()
    db.refresh(box)
    return box


def assign_vials(db: Session, box_id: int, sub_sample_ids: List[str]) -> LimsBox:
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    subs = db.scalars(
        select(LimsSubSample).where(LimsSubSample.sample_id.in_(sub_sample_ids))
    ).all()
    found = {s.sample_id for s in subs}
    missing = set(sub_sample_ids) - found
    if missing:
        raise LookupError(f"sub-samples not found: {sorted(missing)}")
    for s in subs:
        if s.assignment_role != box.role:
            raise ValueError(
                f"vial {s.sample_id} role {s.assignment_role!r} != box role {box.role!r}"
            )
    for s in subs:
        s.box_id = box.id
    db.commit()
    db.refresh(box)
    return box


def mark_printed(db: Session, box_id: int, user_id: int) -> LimsBox:
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    box.printed_at = datetime.utcnow()
    box.printed_by_user_id = user_id
    db.commit()
    db.refresh(box)
    return box


def list_for_order(db: Session, order_key: str) -> List[LimsBox]:
    return list(
        db.scalars(
            select(LimsBox).where(LimsBox.order_key == order_key).order_by(LimsBox.box_number)
        ).all()
    )
```

- [ ] **Step 4: Run the service test to verify it passes**

Run: `cd backend && pytest tests/test_boxes_service.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing routes test**

Create `backend/tests/test_boxes_routes.py`:
```python
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user  # adjust import to match existing route tests


@pytest.fixture(autouse=True)
def override_auth():
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield
    app.dependency_overrides.pop(get_current_user, None)


client = TestClient(app)


def test_create_box_returns_label_code():
    fake = MagicMock(id=3, order_key="WP-20066", box_number=2, role="hplc", printed_at=None)
    with patch("boxes.routes.service.next_box", return_value=fake), \
         patch("boxes.routes.service.box_label_code", return_value="WP-20066-2"), \
         patch("boxes.routes.service.vial_count", return_value=0):
        resp = client.post("/api/boxes", json={"order_key": "WP-20066", "role": "hplc"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["label_code"] == "WP-20066-2"
    assert body["box_number"] == 2


def test_assign_role_mismatch_is_400():
    with patch("boxes.routes.service.assign_vials", side_effect=ValueError("role mismatch")):
        resp = client.post("/api/boxes/3/assign", json={"sub_sample_ids": ["P-0600-S01"]})
    assert resp.status_code == 400
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd backend && pytest tests/test_boxes_routes.py -v`
Expected: FAIL (no `/api/boxes` route → 404, or import error for router).

- [ ] **Step 7: Create the router and register it**

Create `backend/boxes/routes.py`:
```python
import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user  # match the import used by sub_samples/routes.py

from . import service
from .schemas import BoxResponse, CreateBoxRequest, AssignVialsRequest

router = APIRouter(prefix="/api/boxes", tags=["boxes"])


def _serialize(db: Session, box) -> BoxResponse:
    return BoxResponse(
        id=box.id,
        order_key=box.order_key,
        box_number=box.box_number,
        role=box.role,
        label_code=service.box_label_code(box),
        vial_count=service.vial_count(db, box.id),
        printed_at=box.printed_at,
    )


@router.get("", response_model=list[BoxResponse])
def list_boxes(order_key: str = Query(...), db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    return [_serialize(db, b) for b in service.list_for_order(db, order_key)]


@router.post("", response_model=BoxResponse, status_code=201)
def create_box(body: CreateBoxRequest, db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    try:
        box = service.next_box(db, body.order_key, body.role, user_id=user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _serialize(db, box)


@router.post("/{box_id}/assign", response_model=BoxResponse)
def assign(box_id: int, body: AssignVialsRequest, db: Session = Depends(get_db),
           user=Depends(get_current_user)):
    try:
        box = service.assign_vials(db, box_id, body.sub_sample_ids)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _serialize(db, box)


@router.post("/{box_id}/print", response_model=BoxResponse)
def print_box(box_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        box = service.mark_printed(db, box_id, user_id=user.id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _serialize(db, box)
```

In `backend/main.py`, near the other `include_router` calls, add:
```python
from boxes.routes import router as boxes_router
app.include_router(boxes_router)
```
(Place the import with the other route-module imports; if sub_samples is imported as `from sub_samples.routes import router as sub_samples_router`, mirror that style and location.)

- [ ] **Step 8: Run both box test files to verify they pass**

Run: `cd backend && pytest tests/test_boxes_service.py tests/test_boxes_routes.py -v`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add backend/boxes backend/main.py backend/tests/test_boxes_service.py backend/tests/test_boxes_routes.py
git commit -m "feat(boxes): /api/boxes list/create/assign/print"
```

---

## Task 3: Frontend API client + box type

**Files:**
- Modify: `src/lib/api.ts` (add near other receive/sub-sample functions)
- Test: covered indirectly via Task 6's component test; no standalone test needed (thin fetch wrappers mirror existing `patchVialAssignment`).

**Interfaces:**
- Consumes: `/api/boxes` routes (Task 2); existing `apiFetch`/`getBearerHeaders`/`API_BASE_URL`.
- Produces:
  - `interface LimsBox { id; order_key; box_number; role: 'hplc'|'endo'|'ster'; label_code; vial_count; printed_at }`
  - `listOrderBoxes(orderKey): Promise<LimsBox[]>`
  - `createBox(orderKey, role): Promise<LimsBox>`
  - `assignVialsToBox(boxId, subSampleIds): Promise<LimsBox>`
  - `printBox(boxId): Promise<LimsBox>`

- [ ] **Step 1: Add the type and functions**

In `src/lib/api.ts`, add (near `patchVialAssignment`):
```typescript
export interface LimsBox {
  id: number
  order_key: string
  box_number: number
  role: 'hplc' | 'endo' | 'ster'
  label_code: string
  vial_count: number
  printed_at: string | null
}

export async function listOrderBoxes(orderKey: string): Promise<LimsBox[]> {
  return apiFetch<LimsBox[]>(`/api/boxes?order_key=${encodeURIComponent(orderKey)}`)
}

export async function createBox(
  orderKey: string,
  role: 'hplc' | 'endo' | 'ster',
): Promise<LimsBox> {
  return apiFetch<LimsBox>('/api/boxes', {
    method: 'POST',
    body: JSON.stringify({ order_key: orderKey, role }),
  })
}

export async function assignVialsToBox(
  boxId: number,
  subSampleIds: string[],
): Promise<LimsBox> {
  return apiFetch<LimsBox>(`/api/boxes/${boxId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ sub_sample_ids: subSampleIds }),
  })
}

export async function printBox(boxId: number): Promise<LimsBox> {
  return apiFetch<LimsBox>(`/api/boxes/${boxId}/print`, { method: 'POST' })
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run -s typecheck` (or `npx tsc --noEmit`)
Expected: no new errors referencing `api.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(boxes): frontend api client for /api/boxes"
```

---

## Task 4: Order grouping helper (`inbox-orders.ts`)

**Files:**
- Create: `src/lib/inbox-orders.ts`
- Test: `src/test/inbox-orders.test.ts`

**Interfaces:**
- Consumes: `SenaiteSample` (from `@/lib/api`) — the due-list row type carrying `id`, `client_id`, `client_order_number`.
- Produces:
  - `interface OrderGroup { orderKey: string | null; orderLabel: string; clientId: string | null; samples: SenaiteSample[] }`
  - `groupSamplesByOrder(samples: SenaiteSample[]): OrderGroup[]` — null/empty order number collapses into a single `orderKey: null` ("No order") group sorted last.

- [ ] **Step 1: Write the failing test**

Create `src/test/inbox-orders.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { groupSamplesByOrder } from '@/lib/inbox-orders'
import type { SenaiteSample } from '@/lib/api'

function s(id: string, order: string | null, client = 'RTD'): SenaiteSample {
  return { uid: id, id, client_order_number: order, client_id: client } as SenaiteSample
}

describe('groupSamplesByOrder', () => {
  it('groups samples sharing an order number', () => {
    const groups = groupSamplesByOrder([
      s('P-0500', 'WP-20066'),
      s('P-0501', 'WP-20066'),
      s('P-0502', 'WP-20071'),
    ])
    expect(groups).toHaveLength(2)
    const wp66 = groups.find(g => g.orderKey === 'WP-20066')!
    expect(wp66.samples.map(x => x.id)).toEqual(['P-0500', 'P-0501'])
    expect(wp66.orderLabel).toBe('WP-20066')
  })

  it('collapses order-less samples into a single "No order" group sorted last', () => {
    const groups = groupSamplesByOrder([s('P-0600', null), s('P-0700', 'WP-20066')])
    expect(groups[groups.length - 1].orderKey).toBeNull()
    expect(groups[groups.length - 1].orderLabel).toBe('No order')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/test/inbox-orders.test.ts`
Expected: FAIL — cannot resolve `@/lib/inbox-orders`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/inbox-orders.ts`:
```typescript
import type { SenaiteSample } from '@/lib/api'

export interface OrderGroup {
  orderKey: string | null
  orderLabel: string
  clientId: string | null
  samples: SenaiteSample[]
}

export function groupSamplesByOrder(samples: SenaiteSample[]): OrderGroup[] {
  const byOrder = new Map<string | null, SenaiteSample[]>()
  for (const sample of samples) {
    const key = sample.client_order_number || null
    const list = byOrder.get(key)
    if (list) list.push(sample)
    else byOrder.set(key, [sample])
  }
  const groups: OrderGroup[] = Array.from(byOrder.entries()).map(([orderKey, group]) => ({
    orderKey,
    orderLabel: orderKey ?? 'No order',
    clientId: group[0]?.client_id ?? null,
    samples: group,
  }))
  groups.sort((a, b) => {
    if ((a.orderKey === null) !== (b.orderKey === null)) return a.orderKey === null ? 1 : -1
    return (a.orderKey ?? '').localeCompare(b.orderKey ?? '', undefined, { numeric: true })
  })
  return groups
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/test/inbox-orders.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/inbox-orders.ts src/test/inbox-orders.test.ts
git commit -m "feat(receive): client-side order grouping helper"
```

---

## Task 5: By-order / By-sample toggle + order list on `ReceiveSample.tsx`

**Files:**
- Modify: `src/components/intake/ReceiveSample.tsx`
- Test: manual + existing tests stay green (`npm run check:all`)

**Interfaces:**
- Consumes: `groupSamplesByOrder`/`OrderGroup` (Task 4); existing `dueSamples`, `filteredSamples`, `setWizardParent` state.
- Produces: a `receiveMode: 'order' | 'sample'` UI state; selecting an order sets `selectedOrder: OrderGroup | null` → opens `OrderReceiveSession` (Task 6).

- [ ] **Step 1: Add mode + selected-order state**

In `ReceiveSample.tsx`, near the other `useState` calls (after `showTestSamples`, ~line 234), add:
```typescript
  const [receiveMode, setReceiveMode] = useState<'order' | 'sample'>('order')
  const [selectedOrder, setSelectedOrder] = useState<OrderGroup | null>(null)
```
Add imports at the top:
```typescript
import { groupSamplesByOrder, type OrderGroup } from '@/lib/inbox-orders'
import { OrderReceiveSession } from '@/components/intake/OrderReceiveSession'
```

- [ ] **Step 2: Derive order groups from the already-filtered list**

After the `sortedSamples` declaration (~line 276), add:
```typescript
  const orderGroups = groupSamplesByOrder(filteredSamples)
```

- [ ] **Step 3: Add the toggle control**

In the Step-1 header block, next to the "Show Test Samples" checkbox (~line 511), add a segmented toggle:
```tsx
        <div className="inline-flex rounded-md border p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setReceiveMode('order')}
            className={cn('px-3 py-1 rounded', receiveMode === 'order' && 'bg-accent font-semibold')}
          >
            By order
          </button>
          <button
            type="button"
            onClick={() => setReceiveMode('sample')}
            className={cn('px-3 py-1 rounded', receiveMode === 'sample' && 'bg-accent font-semibold')}
          >
            By sample
          </button>
        </div>
```

- [ ] **Step 4: Render the order list in 'order' mode**

Wrap the existing `<Table>` (the flat sample list) so it only renders when `receiveMode === 'sample'`. When `receiveMode === 'order'`, render order cards instead:
```tsx
        {receiveMode === 'order' ? (
          <div className="flex flex-col gap-2">
            {orderGroups.map(group => {
              const vialTotal = group.samples.length // refined to vial counts later if needed
              return (
                <button
                  key={group.orderKey ?? '__none__'}
                  type="button"
                  onClick={() => setSelectedOrder(group)}
                  className="flex items-center justify-between rounded-lg border p-3 text-left hover:bg-muted/40"
                >
                  <span className="font-mono font-semibold">{group.orderLabel}</span>
                  <span className="text-sm text-muted-foreground">
                    {group.clientId ?? '—'} · {group.samples.length} sample
                    {group.samples.length !== 1 ? 's' : ''}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          /* existing <Table>…</Table> flat sample list goes here, unchanged */
        )}
```

- [ ] **Step 5: Mount the order session**

After the existing `{wizardParent && ( … )}` Dialog block (~line 1037), add:
```tsx
      {selectedOrder && (
        <OrderReceiveSession
          order={selectedOrder}
          onClose={() => {
            setSelectedOrder(null)
            void loadDueSamples()
          }}
        />
      )}
```

- [ ] **Step 6: Verify the page compiles and existing tests pass**

Run: `npm run check:all`
Expected: typecheck/lint pass; no net-new test failures vs. the known baseline.

- [ ] **Step 7: Commit**

```bash
git add src/components/intake/ReceiveSample.tsx
git commit -m "feat(receive): By-order/By-sample toggle + order list"
```

---

## Task 6: `OrderReceiveSession` — sample stepper + boxing stage entry

**Files:**
- Create: `src/components/intake/OrderReceiveSession.tsx`
- Test: manual (drives existing `ReceiveWizard`); logic-level coverage via Task 7.

**Interfaces:**
- Consumes: `OrderGroup` (Task 4); `ReceiveWizard` + `ParentInfo` (existing); `BoxStep` (Task 7).
- Produces: a Dialog that iterates `order.samples` (sample stepper) then shows `BoxStep` for the order.

- [ ] **Step 1: Create the session component**

Create `src/components/intake/OrderReceiveSession.tsx`:
```tsx
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ReceiveWizard } from '@/components/intake/ReceiveWizard/ReceiveWizard'
import { BoxStep } from '@/components/intake/ReceiveWizard/BoxStep'
import type { OrderGroup } from '@/lib/inbox-orders'

interface Props {
  order: OrderGroup
  onClose: () => void
}

export function OrderReceiveSession({ order, onClose }: Props) {
  // index 0..n-1 = walking samples; index === n = order-level boxing stage
  const [index, setIndex] = useState(0)
  const total = order.samples.length
  const onBoxing = index >= total
  const current = order.samples[Math.min(index, total - 1)]

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-w-6xl w-full p-0 sm:max-w-6xl h-[90vh] overflow-hidden">
        <DialogHeader className="px-6 pt-4 pb-2 border-b">
          <DialogTitle>
            Receive {order.orderLabel}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {onBoxing ? 'Boxing' : `Sample ${index + 1} of ${total} — ${current.id}`}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="h-[calc(90vh-7rem)] overflow-hidden">
          {onBoxing ? (
            <BoxStep
              orderKey={order.orderKey ?? current.id}
              orderLabel={order.orderLabel}
              clientId={order.clientId}
              sampleIds={order.samples.map(s => s.id)}
            />
          ) : (
            <ReceiveWizard
              key={current.uid}
              parent={{ uid: current.uid, sample_id: current.id, status: current.review_state ?? null }}
              onClose={onClose}
            />
          )}
        </div>

        <footer className="flex justify-between gap-2 px-6 py-3 border-t bg-muted/20">
          <Button
            type="button"
            variant="outline"
            disabled={index === 0}
            onClick={() => setIndex(i => Math.max(0, i - 1))}
          >
            Back
          </Button>
          {onBoxing ? (
            <Button type="button" onClick={onClose}>Done</Button>
          ) : (
            <Button type="button" onClick={() => setIndex(i => i + 1)}>
              {index === total - 1 ? 'Continue to boxing' : 'Next sample'}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Verify compile**

Run: `npm run -s typecheck`
Expected: only errors are the not-yet-created `BoxStep` import — resolved in Task 7. (If executing strictly TDD, do Task 7 before re-running.)

- [ ] **Step 3: Commit**

```bash
git add src/components/intake/OrderReceiveSession.tsx
git commit -m "feat(receive): order-scoped receive session with sample stepper"
```

---

## Task 7: `BoxStep` (order-level boxing UI) + `BoxLabelTemplate` + print

**Files:**
- Create: `src/components/intake/ReceiveWizard/BoxStep.tsx`
- Create: `src/components/intake/ReceiveWizard/BoxLabelTemplate.tsx`
- Test: `src/test/box-step.test.tsx`

**Interfaces:**
- Consumes: `listOrderBoxes`/`createBox`/`assignVialsToBox`/`printBox`/`LimsBox` (Task 3); existing per-sample vial data via `listSubSamples` (existing in `@/lib/api`); dnd-kit (`DndContext`, `useDraggable`, `useDroppable`, `PointerSensor`) per AssignStep idiom; `usePrintLabel` print pattern.
- Produces: `boxLabelLines(box, clientName): string[]` (pure, tested), and the `BoxStep` component.

- [ ] **Step 1: Write the failing unit test for the label content**

Create `src/test/box-step.test.tsx`:
```typescript
import { describe, it, expect } from 'vitest'
import { boxLabelLines } from '@/components/intake/ReceiveWizard/BoxStep'
import type { LimsBox } from '@/lib/api'

const box: LimsBox = {
  id: 1, order_key: 'WP-20066', box_number: 3, role: 'ster',
  label_code: 'WP-20066-3', vial_count: 4, printed_at: null,
}

describe('boxLabelLines', () => {
  it('uses the label_code verbatim (no double WP- prefix) and names the bin', () => {
    const lines = boxLabelLines(box, 'RTD Biosciences')
    expect(lines[0]).toBe('WP-20066-3')
    expect(lines).toContain('RTD Biosciences')
    expect(lines.join(' ')).toMatch(/STER/i)
    expect(lines.join(' ')).toMatch(/4 vials/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/test/box-step.test.tsx`
Expected: FAIL — cannot resolve `BoxStep` / `boxLabelLines`.

- [ ] **Step 3: Create `BoxLabelTemplate` (reuse existing label styling)**

Create `src/components/intake/ReceiveWizard/BoxLabelTemplate.tsx`:
```tsx
import { QRCodeSVG } from 'qrcode.react'

const ROLE_SHORT: Record<string, string> = { hplc: 'HPLC', endo: 'ENDO', ster: 'STERYL' }

interface Props {
  labelCode: string            // e.g. "WP-20066-3" (verbatim; never prefixed)
  clientName: string | null
  role: 'hplc' | 'endo' | 'ster'
  vialCount: number
}

export function BoxLabelTemplate({ labelCode, clientName, role, vialCount }: Props) {
  return (
    <div className="label">
      <QRCodeSVG value={labelCode} size={96} level="M" marginSize={0} />
      <div className="label-text">
        <div className="label-id">{labelCode}</div>
        <div className="label-meta">
          {clientName && <span>{clientName}</span>}
          <span className="label-meta-sep">·</span>
          <span>{vialCount} vials</span>
        </div>
        <div className="label-role">{ROLE_SHORT[role]}</div>
      </div>
    </div>
  )
}
```
(Reuses the same `.label`/`.label-*` classes as `LabelTemplate`/`PrintStep.css` — existing media size, no new `@page`.)

- [ ] **Step 4: Create `BoxStep` with the pure helper + dnd boxing UI**

Create `src/components/intake/ReceiveWizard/BoxStep.tsx`:
```tsx
import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, PointerSensor, useSensor, useSensors, useDroppable, useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core'
import { Button } from '@/components/ui/button'
import { usePrintLabel } from '@/components/samples/usePrintLabel'
import { BoxLabelTemplate } from './BoxLabelTemplate'
import {
  listOrderBoxes, createBox, assignVialsToBox, printBox,
  listSubSamples, type LimsBox,
} from '@/lib/api'

type BoxRole = 'hplc' | 'endo' | 'ster'
const ROLE_LABEL: Record<BoxRole, string> = { hplc: 'HPLC', endo: 'Endotoxin', ster: 'Sterility' }

/** Pure: the lines printed on a box label. Tested directly. */
export function boxLabelLines(box: LimsBox, clientName: string | null): string[] {
  const lines = [box.label_code]
  if (clientName) lines.push(clientName)
  lines.push(`${ROLE_LABEL[box.role as BoxRole]} · ${box.vial_count} vials`)
  return lines
}

interface Props {
  orderKey: string
  orderLabel: string
  clientId: string | null
  sampleIds: string[]
}

export function BoxStep({ orderKey, orderLabel, clientId, sampleIds }: Props) {
  const qc = useQueryClient()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const boxesQ = useQuery({ queryKey: ['order-boxes', orderKey], queryFn: () => listOrderBoxes(orderKey) })

  // The order's vials across all its samples (each sample's vials loaded once).
  const vialsQ = useQuery({
    queryKey: ['order-vials', orderKey, sampleIds],
    queryFn: async () => {
      const lists = await Promise.all(sampleIds.map(id => listSubSamples(id)))
      return lists.flatMap(l => l.sub_samples)
    },
  })

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const subSampleId = String(event.active.id)
    const boxId = event.over?.id ? Number(event.over.id) : null
    if (!boxId) return
    await assignVialsToBox(boxId, [subSampleId])
    await qc.invalidateQueries({ queryKey: ['order-boxes', orderKey] })
    await qc.invalidateQueries({ queryKey: ['order-vials', orderKey] })
  }, [qc, orderKey])

  const addBox = async (role: BoxRole) => {
    await createBox(orderKey, role)
    await qc.invalidateQueries({ queryKey: ['order-boxes', orderKey] })
  }

  if (boxesQ.isLoading || vialsQ.isLoading) return <div className="p-6">Loading…</div>
  const boxes = boxesQ.data ?? []
  const vials = (vialsQ.data ?? []).filter(v => v.assignment_role && v.assignment_role !== 'xtra')

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="p-6 grid grid-cols-3 gap-4 overflow-y-auto h-full">
        {(['hplc', 'endo', 'ster'] as BoxRole[]).map(role => (
          <div key={role} className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{ROLE_LABEL[role]}</h3>
              <Button size="sm" variant="outline" onClick={() => void addBox(role)}>+ Add box</Button>
            </div>
            <UnboxedTray
              role={role}
              vials={vials.filter(v => v.assignment_role === role && !v.box_id)}
            />
            {boxes.filter(b => b.role === role).map(b => (
              <BoxCard key={b.id} box={b} clientName={clientId} />
            ))}
          </div>
        ))}
      </div>
    </DndContext>
  )
}

function UnboxedTray({ role, vials }: { role: BoxRole; vials: { sample_id: string }[] }) {
  return (
    <div className="rounded border border-dashed p-2 min-h-12">
      <div className="text-xs text-muted-foreground mb-1">Unboxed {ROLE_LABEL[role]}</div>
      <div className="flex flex-wrap gap-1">
        {vials.map(v => <VialChip key={v.sample_id} id={v.sample_id} />)}
      </div>
    </div>
  )
}

function VialChip({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id })
  return (
    <span ref={setNodeRef} {...listeners} {...attributes}
      className="cursor-grab rounded bg-muted px-2 py-0.5 font-mono text-xs">
      {id}
    </span>
  )
}

function BoxCard({ box, clientName }: { box: LimsBox; clientName: string | null }) {
  const { setNodeRef, isOver } = useDroppable({ id: String(box.id) })
  const { printLabel } = usePrintLabel()
  return (
    <div ref={setNodeRef}
      className={`rounded border p-2 ${isOver ? 'ring-2 ring-primary' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono font-semibold">{box.label_code}</span>
        <Button size="sm" variant="ghost"
          onClick={() => { void printBox(box.id); printLabel(
            <BoxLabelTemplate labelCode={box.label_code} clientName={clientName}
              role={box.role} vialCount={box.vial_count} />,
          ) }}>
          {box.printed_at ? 'Reprint' : 'Print label'}
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">{box.vial_count} vials</div>
    </div>
  )
}
```
> Note for the implementer: confirm `usePrintLabel`'s call signature against `src/components/samples/usePrintLabel.ts` — it currently prints from `{ sampleId, orderNumber }`. If it does not already accept a React node, add a thin `printNode(node: React.ReactNode)` export to that hook (off-screen `position: fixed; left: -9999px` + `window.print()`, mirroring its existing implementation) and call that here. This is the one place the box label diverges from the strip-label print path; keep the existing media size/CSS.

- [ ] **Step 5: Run the label-content test to verify it passes**

Run: `npx vitest run src/test/box-step.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full gate**

Run: `npm run check:all`
Expected: typecheck + lint + tests pass; no net-new failures vs. baseline.

- [ ] **Step 7: Commit**

```bash
git add src/components/intake/ReceiveWizard/BoxStep.tsx src/components/intake/ReceiveWizard/BoxLabelTemplate.tsx src/test/box-step.test.tsx
git commit -m "feat(boxes): order-level boxing stage + box label print"
```

---

## Self-Review

**Spec coverage (Phase 1 sections of the design doc):**
- §1a By-order/By-sample toggle + order grouping → Tasks 4, 5. ✓
- §1b order-scoped session (sample stepper) → Task 6. ✓
- §1c order-level boxing stage (add box, drag vials, print) → Task 7. ✓
- Box label = verbatim order number + `-{n}`, existing format → Task 7 (`boxLabelLines`, `BoxLabelTemplate`). ✓
- Data model `lims_boxes` (order_key, box_number, role, attribution) + `box_id` → Tasks 1, 2. ✓
- Role-match validation, running-per-order numbering → Task 2 service tests. ✓
- 17025 attribution (created_by/at, printed_by/at) → Task 1 columns + Task 2 service. ✓
- Incremental receive (box_number keeps climbing) → Task 2 `next_box` (max+1). ✓

**Deferred to later plans (out of Phase 1 scope, noted here so they aren't forgotten):**
- Phase 2 inbox order tier + order drag.
- Phase 3 worksheet boxes-to-grab + `worksheet_items.order_number`/`role` stamping.
- Phase 4 SOP guide updates.
- Vial→box move history beyond `box_id` overwrite (spec open question; v2).
- Receive-list 50-row pagination (spec open question) — revisit if order volumes approach the limit.

**Placeholder scan:** none — every code step contains real code; the one implementer note (Task 7 `usePrintLabel`) points to a concrete file with a concrete fallback, not a TODO.

**Type consistency:** `LimsBox` (api.ts) ↔ `BoxResponse` (backend) fields match (`order_key`, `box_number`, `role`, `label_code`, `vial_count`, `printed_at`). `boxLabelLines`/`BoxLabelTemplate` consume `LimsBox` verbatim. `OrderGroup` (Task 4) consumed by Tasks 5–6 with matching field names (`orderKey`, `orderLabel`, `clientId`, `samples`). `groupSamplesByOrder` returns what `ReceiveSample.tsx` renders.
