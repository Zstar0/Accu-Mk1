# PCR Worksheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn any Mk1 worksheet holding only PCR vials into Dennis's qPCR plate builder: plate map with frozen wells, reagent prep, QuantStudio file, plate map and well list CSVs, one printed page per plate, run status ticks, and a PCR run log rail.

**Architecture:** Two nullable well columns on `worksheet_items` and one JSON settings column on `worksheets`; a freeze endpoint pins wells the client laid out and never moves a pinned one. Every layout and reagent figure is computed once in `src/lib/pcr-plate.ts` (a port of `calc.js` with freezing added) and rendered by the flyout view, a standalone print document and the exports, so screen, paper, the QuantStudio file and the CSVs never disagree. The endo run-log rail becomes a per-kind rail.

**Tech Stack:** FastAPI + SQLAlchemy (boot ALTER migrations in `database.py`), React 19 + TanStack Query + Tailwind + vitest, Python `pytest` with in-memory SQLite.

**Spec:** `docs/superpowers/specs/2026-09-22-pcr-worksheet-design.md`

## Global Constraints

- Additive only: no existing column, key, route or behaviour changes. New GET keys ride handlers with no `response_model`.
- Formulas and layout byte-for-byte as in the spec §3; the workbook vectors in `calc.test.js` are the tests.
- No em dashes anywhere, code, strings or tests included. Use a colon or comma.
- Frontend package manager is npm only. Plain English strings, no i18n.
- Commit with explicit pathspecs (`git commit -- <paths>`); the stash and index are shared across worktrees.
- Backend tests run in a stack container or with `backend/.venv`; never the full suite concurrently with another session.
- No deploy, no prod write.

---

### Task 1: Bench kind, well and settings columns, serializer, PUT

**Files:**
- Modify: `backend/main.py` (`_ROLE_BENCH_KIND` ~23799; `WorksheetUpdate` + `update_worksheet` ~23909; `_serialize_worksheets` item dict ~23750 and worksheet dict ~23701)
- Modify: `backend/models.py` (`Worksheet` after `print_count`; `WorksheetItem` after `ran_by_user_id`)
- Modify: `backend/database.py` (ALTER list after the `print_count` ALTER, line 324)
- Test: `backend/tests/test_worksheet_pcr_wells.py`

**Interfaces:**
- Produces: `Worksheet.bench_config: Optional[dict]`; `WorksheetItem.plate_no | well_pos: Optional[int]`; GET keys `bench_config`, `plate_no`, `well_pos`; PUT body key `bench_config`.

- [ ] **Step 1: Write the failing tests**

```python
"""PCR plate wells and run settings on worksheets (spec 2026-09-22-pcr-worksheet-design).

`plate_no` / `well_pos` freeze a vial's well once the plate is loaded; `bench_config`
holds the run's settings. In-memory SQLite + dependency overrides, no live stack.
"""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import AuditLog, LimsSample, LimsSubSample, Worksheet, WorksheetItem


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db, roles=("pcr", "ster"), status="open"):
    """One parent, one vial per role, all on one worksheet. Returns (ws, items)."""
    parent = LimsSample(sample_id="P-3001", external_lims_uid="SEN-P-3001",
                        client_order_number="WP-8120", peptide_name="BPC-157")
    db.add(parent)
    db.flush()
    ws = Worksheet(title="PCR 09/22/2026", status=status)
    db.add(ws)
    db.flush()
    items = []
    for n, role in enumerate(roles, start=1):
        sub = LimsSubSample(sample_id=f"P-3001-S0{n}", parent_sample_pk=parent.id,
                            vial_sequence=n, external_lims_uid=f"mk1://pcr-{n}",
                            assignment_role=role)
        db.add(sub)
        item = WorksheetItem(worksheet_id=ws.id, sample_uid=sub.external_lims_uid,
                             sample_id=sub.sample_id, sort_order=n)
        db.add(item)
        items.append(item)
    db.commit()
    return ws, items


def test_ster_vials_are_pcr_work_in_the_bench_log(client, db):
    ws, _ = _seed(db)
    rows = client.get("/worksheets/bench-log?kind=pcr").json()
    assert [r["id"] for r in rows] == [ws.id]
    assert client.get("/worksheets/bench-log?kind=sterility").json() == []


def test_items_carry_their_frozen_well_and_the_worksheet_its_settings(client, db):
    ws, (a, b) = _seed(db)
    a.plate_no, a.well_pos = 1, 3
    db.commit()
    body = client.get(f"/worksheets/{ws.id}").json()
    assert body["bench_config"] is None
    by_id = {it["id"]: it for it in body["items"]}
    assert (by_id[a.id]["plate_no"], by_id[a.id]["well_pos"]) == (1, 3)
    assert (by_id[b.id]["plate_no"], by_id[b.id]["well_pos"]) == (None, None)


def test_put_replaces_bench_config_whole(client, db):
    ws, _ = _seed(db)
    r = client.put(f"/worksheets/{ws.id}",
                   json={"bench_config": {"overage": 1.4, "curve": "Quantitative"}})
    assert r.status_code == 200, r.text
    assert client.get(f"/worksheets/{ws.id}").json()["bench_config"] == {
        "overage": 1.4, "curve": "Quantitative"}
    client.put(f"/worksheets/{ws.id}", json={"bench_config": {"overage": 1.1}})
    assert client.get(f"/worksheets/{ws.id}").json()["bench_config"] == {"overage": 1.1}
    # A title-only update leaves the settings alone.
    client.put(f"/worksheets/{ws.id}", json={"title": "Renamed"})
    assert client.get(f"/worksheets/{ws.id}").json()["bench_config"] == {"overage": 1.1}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_worksheet_pcr_wells.py -q`
Expected: 3 failures (`bench-log` returns the ster worksheet under `sterility`; `KeyError: 'bench_config'`; PUT ignores `bench_config`).

- [ ] **Step 3: Models and boot migration**

`backend/models.py`, class `Worksheet`, after `print_count`:

```python
    # Per-bench run settings (Worksheets 2.0). Free-form JSON keyed by the
    # bench kind's own names; PCR stores overage / curve / plate_type /
    # sort_by_order (spec 2026-09-22-pcr-worksheet-design). Replaced whole
    # by PUT, never merged.
    bench_config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
```

class `WorksheetItem`, after `ran_by_user_id`:

```python
    # PCR plate map (spec 2026-09-22-pcr-worksheet-design): the well this vial
    # was printed / exported in, frozen because the plate is loaded by then.
    # plate_no is 1-based; well_pos is 0..47, column-major within the
    # bacterial block (row = pos % 8, col = pos // 8 + 1; the fungal mirror is
    # col + 6). NULL = not frozen yet; the layout is free to move the row.
    plate_no: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    well_pos: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
```

`backend/database.py`, after the `print_count` ALTER:

```python
        # PCR plate map: frozen wells + per-bench run settings (2026-09-22)
        "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS plate_no INTEGER",
        "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS well_pos INTEGER",
        "ALTER TABLE worksheets ADD COLUMN IF NOT EXISTS bench_config JSON",
```

- [ ] **Step 4: Kind, serializer and PUT in `backend/main.py`**

`_ROLE_BENCH_KIND`: change `"ster": "sterility"` to `"ster": "pcr"` and update the comment above it:

```python
# Which bench a worksheet item belongs to. A faithful port of
# src/lib/worksheet-kind.ts (benchKindForItem): the vial's catalog role wins;
# an item with no mapped role (a bare parent id on a legacy "<order> E"
# worksheet has no lims_sub_samples row at all) falls back to the first
# analysis keyword that names a bench. Keep the two in step. `ster` is the
# legacy rapid-sterility PCR vial (STER-PCR), the same plate as `pcr`
# (ruling 2026-09-22); only usp71 is plated sterility.
_ROLE_BENCH_KIND = {
    "endo": "endo", "endo85": "endo", "pcr": "pcr", "ster": "pcr",
    "usp71": "sterility", "hm": "hm", "hplc": "hplc", "fentanyl": "hplc",
}
```

`WorksheetUpdate` and `update_worksheet`:

```python
class WorksheetUpdate(BaseModel):
    title: Optional[str] = None
    assigned_analyst: Optional[int] = None
    notes: Optional[str] = None
    # Per-bench run settings, replaced whole (PCR: overage, curve, plate_type,
    # sort_by_order). Omitted = untouched.
    bench_config: Optional[dict] = None
```

after the `if data.notes is not None:` block:

```python
    if data.bench_config is not None:
        ws.bench_config = data.bench_config
```

`_serialize_worksheets`: worksheet dict, after `"print_count"`:

```python
            "bench_config": ws.bench_config,
```

item dict, after `"ran_by_user_id"`:

```python
                    # PCR plate map: the frozen well, or null while the row may still move.
                    "plate_no": it.plate_no,
                    "well_pos": it.well_pos,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_worksheet_pcr_wells.py tests/test_worksheet_endo_prep.py tests/test_worksheets_list_sync.py -q`
Expected: all pass (the endo bench-log tests still pass because `ster` never appears there).

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/main.py backend/tests/test_worksheet_pcr_wells.py
git commit -m "feat(worksheets): PCR bench kind, frozen well columns, bench_config" -- backend/models.py backend/database.py backend/main.py backend/tests/test_worksheet_pcr_wells.py
```

---

### Task 2: Freeze and unfreeze endpoints

**Files:**
- Modify: `backend/main.py` (after `record_worksheet_printed`, ~24607)
- Test: `backend/tests/test_worksheet_pcr_wells.py`

**Interfaces:**
- Produces: `POST /worksheets/{id}/freeze-wells` body `{"wells": [{"item_id": int, "plate_no": int, "well_pos": int}]}` -> `{"status": "frozen", "frozen": n}`; `DELETE /worksheets/{id}/frozen-wells` -> `{"status": "cleared", "cleared": n}`. 404 unknown worksheet or item, 409 completed worksheet or taken well, 400 out of range.

- [ ] **Step 1: Write the failing tests** (append to `test_worksheet_pcr_wells.py`)

```python
# --- Freezing wells --------------------------------------------------------


def _freeze(client, ws, wells):
    return client.post(f"/worksheets/{ws.id}/freeze-wells", json={"wells": wells})


def test_freeze_pins_unfrozen_items_and_never_moves_a_frozen_one(client, db):
    ws, (a, b) = _seed(db)
    r = _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 0}])
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "frozen", "frozen": 1}
    db.refresh(a)
    assert (a.plate_no, a.well_pos) == (1, 0)

    # A second layout that would move a onto well 5 leaves it where it was and
    # only pins b. The audit row counts what was pinned.
    r = _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 5},
                             {"item_id": b.id, "plate_no": 1, "well_pos": 1}])
    assert r.json()["frozen"] == 1
    db.refresh(a)
    db.refresh(b)
    assert (a.plate_no, a.well_pos) == (1, 0)
    assert (b.plate_no, b.well_pos) == (1, 1)
    rows = db.query(AuditLog).filter(AuditLog.operation == "worksheet_wells_frozen").all()
    assert [(r.entity_id, r.details["frozen"], r.details["user_id"]) for r in rows] == [
        (str(ws.id), 1, 1), (str(ws.id), 1, 1)]


def test_freeze_refuses_a_taken_well_and_bad_input(client, db):
    ws, (a, b) = _seed(db)
    _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 0}])
    r = _freeze(client, ws, [{"item_id": b.id, "plate_no": 1, "well_pos": 0}])
    assert r.status_code == 409
    db.refresh(b)
    assert b.well_pos is None
    assert _freeze(client, ws, [{"item_id": b.id, "plate_no": 0, "well_pos": 0}]).status_code == 400
    assert _freeze(client, ws, [{"item_id": b.id, "plate_no": 1, "well_pos": 48}]).status_code == 400
    assert _freeze(client, ws, [{"item_id": 99999, "plate_no": 1, "well_pos": 2}]).status_code == 404
    # Two new items on the same well in one request: neither lands.
    r = _freeze(client, ws, [{"item_id": b.id, "plate_no": 2, "well_pos": 0},
                             {"item_id": b.id, "plate_no": 2, "well_pos": 0}])
    assert r.status_code == 409
    db.refresh(b)
    assert b.well_pos is None


def test_unfreeze_releases_every_well_once(client, db):
    ws, (a, b) = _seed(db)
    _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 0},
                         {"item_id": b.id, "plate_no": 1, "well_pos": 1}])
    r = client.delete(f"/worksheets/{ws.id}/frozen-wells")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "cleared", "cleared": 2}
    db.refresh(a)
    db.refresh(b)
    assert a.well_pos is None and a.plate_no is None and b.well_pos is None
    assert client.delete(f"/worksheets/{ws.id}/frozen-wells").json()["cleared"] == 0
    assert db.query(AuditLog).filter(AuditLog.operation == "worksheet_wells_unfrozen").count() == 1


def test_wells_are_locked_on_a_completed_worksheet(client, db):
    ws, (a, _) = _seed(db, status="completed")
    assert _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 0}]).status_code == 409
    assert client.delete(f"/worksheets/{ws.id}/frozen-wells").status_code == 409
    assert client.post("/worksheets/99999/freeze-wells", json={"wells": []}).status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_worksheet_pcr_wells.py -q`
Expected: the four new tests fail with 404 (route missing) or 405.

- [ ] **Step 3: Implement the endpoints** (in `backend/main.py`, after `record_worksheet_printed`)

```python
class WorksheetWellFreeze(BaseModel):
    item_id: int
    plate_no: int
    well_pos: int


class WorksheetFreezeWells(BaseModel):
    wells: list[WorksheetWellFreeze]


# 8 rows x 6 columns of the bacterial block; the fungal mirror is col + 6.
_PLATE_WELLS = 48


@app.post("/worksheets/{worksheet_id}/freeze-wells")
def freeze_worksheet_wells(
    worksheet_id: int,
    data: WorksheetFreezeWells,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """PCR plate map: pin each item to the well the client laid it out in, the
    moment the plate is printed or exported for the QuantStudio (ruling
    2026-09-22). A well already frozen never moves, whatever the client sends:
    the plate is loaded by then, and a moved well would credit results to the
    wrong sample. Two items can never share a well on a plate. The NPC is not
    an item and is never frozen; the client keeps it after the last sample."""
    ws = db.execute(select(Worksheet).where(Worksheet.id == worksheet_id)).scalar_one_or_none()
    if not ws or ws.status == "staging":
        raise HTTPException(404, "Worksheet not found")
    if ws.status == "completed":
        raise HTTPException(409, "Worksheet is completed")
    items = {
        it.id: it for it in db.execute(
            select(WorksheetItem).where(WorksheetItem.worksheet_id == worksheet_id)
        ).scalars()
    }
    taken = {(it.plate_no, it.well_pos) for it in items.values() if it.well_pos is not None}
    to_pin: list[tuple["WorksheetItem", int, int]] = []
    for w in data.wells:
        item = items.get(w.item_id)
        if item is None:
            raise HTTPException(404, f"Item {w.item_id} is not on this worksheet")
        if w.plate_no < 1 or not (0 <= w.well_pos < _PLATE_WELLS):
            raise HTTPException(400, "Well out of range")
        if item.well_pos is not None:
            continue  # frozen wells never move
        key = (w.plate_no, w.well_pos)
        if key in taken:
            raise HTTPException(409, f"Well {w.well_pos} on plate {w.plate_no} is already taken")
        taken.add(key)
        to_pin.append((item, w.plate_no, w.well_pos))
    for item, plate_no, well_pos in to_pin:
        item.plate_no = plate_no
        item.well_pos = well_pos
    if to_pin:
        db.add(AuditLog(
            operation="worksheet_wells_frozen",
            entity_type="worksheet",
            entity_id=str(ws.id),
            details={"user_id": _current_user.id, "frozen": len(to_pin)},
        ))
    db.commit()
    return {"status": "frozen", "frozen": len(to_pin)}


@app.delete("/worksheets/{worksheet_id}/frozen-wells")
def unfreeze_worksheet_wells(
    worksheet_id: int,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Release every frozen well: a deliberate re-layout of a plate that was
    printed too early. Audited, because a loaded plate may be on the bench."""
    ws = db.execute(select(Worksheet).where(Worksheet.id == worksheet_id)).scalar_one_or_none()
    if not ws or ws.status == "staging":
        raise HTTPException(404, "Worksheet not found")
    if ws.status == "completed":
        raise HTTPException(409, "Worksheet is completed")
    items = db.execute(
        select(WorksheetItem).where(
            WorksheetItem.worksheet_id == worksheet_id, WorksheetItem.well_pos.isnot(None)
        )
    ).scalars().all()
    for item in items:
        item.plate_no = None
        item.well_pos = None
    if items:
        db.add(AuditLog(
            operation="worksheet_wells_unfrozen",
            entity_type="worksheet",
            entity_id=str(ws.id),
            details={"user_id": _current_user.id, "cleared": len(items)},
        ))
    db.commit()
    return {"status": "cleared", "cleared": len(items)}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_worksheet_pcr_wells.py -q`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(worksheets): freeze / unfreeze PCR plate wells" -- backend/main.py backend/tests/test_worksheet_pcr_wells.py
```

---

### Task 3: Frontend plumbing: kind, API types and calls, drawer mutations

**Files:**
- Modify: `src/lib/worksheet-kind.ts:14` and `src/lib/__tests__/worksheet-kind.test.ts:17`
- Modify: `src/lib/api.ts` (`WorksheetListItem` ~6088; `updateWorksheet` ~6206; after `bulkWorksheetBenchTicks` ~6346)
- Modify: `src/hooks/use-worksheet-drawer.ts` (`updateMutation` ~95; after `bulkTicksMutation` ~292; the return object)
- Modify: `src/lib/endo-bench-sheet.ts:379` (export `csvField`)

**Interfaces:**
- Produces: `WorksheetListItem.bench_config?: Record<string, unknown> | null`; item keys `plate_no?: number | null`, `well_pos?: number | null`; `updateWorksheet(id, { title?, assigned_analyst?, notes?, bench_config? })`; `freezeWorksheetWells(id, wells: WorksheetWellFreeze[])`; `unfreezeWorksheetWells(id)`; hook fields `freezeWellsMutation`, `unfreezeWellsMutation`; `csvField(v: string): string` exported from endo-bench-sheet.

- [ ] **Step 1: Fix the kind test first**

In `src/lib/__tests__/worksheet-kind.test.ts` change line 17 to:

```ts
    expect(benchKindForItem(item('ster'))).toBe('pcr')
```

Run: `npx vitest run src/lib/__tests__/worksheet-kind.test.ts`
Expected: FAIL (`ster` still gives `sterility`).

- [ ] **Step 2: Kind map**

`src/lib/worksheet-kind.ts`: change `ster: 'sterility',` to `ster: 'pcr', // legacy STER-PCR vial, same plate as pcr (ruling 2026-09-22)`.

Run: `npx vitest run src/lib/__tests__/worksheet-kind.test.ts`
Expected: PASS.

- [ ] **Step 3: API types and calls**

In `WorksheetListItem`, after `print_count?: number`:

```ts
  /** Per-bench run settings (PCR: overage, curve, plate_type, sort_by_order). */
  bench_config?: Record<string, unknown> | null
```

In the item type, after `ran_by_user_id?: number | null`:

```ts
    /** PCR plate map: the frozen well (1-based plate, 0..47 column-major
     *  position), or null while the layout may still move the row. */
    plate_no?: number | null
    well_pos?: number | null
```

`updateWorksheet` signature:

```ts
export async function updateWorksheet(
  worksheetId: number,
  data: {
    title?: string
    assigned_analyst?: number
    notes?: string
    bench_config?: Record<string, unknown>
  }
): Promise<void> {
```

After `bulkWorksheetBenchTicks`:

```ts
export interface WorksheetWellFreeze {
  item_id: number
  plate_no: number
  well_pos: number
}

/** Pin every unfrozen PCR item to the well it was laid out in (a frozen well
 *  never moves). Called before a print or a QuantStudio export. */
export async function freezeWorksheetWells(
  worksheetId: number,
  wells: WorksheetWellFreeze[]
): Promise<{ frozen: number }> {
  const response = await fetch(
    `${API_BASE_URL()}/worksheets/${worksheetId}/freeze-wells`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ wells }),
    }
  )
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    throw new Error(detail?.detail ?? `Freeze wells failed: ${response.status}`)
  }
  return response.json()
}

/** Release every frozen well so the plate can be laid out again. */
export async function unfreezeWorksheetWells(
  worksheetId: number
): Promise<{ cleared: number }> {
  const response = await fetch(
    `${API_BASE_URL()}/worksheets/${worksheetId}/frozen-wells`,
    { method: 'DELETE', headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`Unfreeze wells failed: ${response.status}`)
  return response.json()
}
```

- [ ] **Step 4: Drawer hook**

Imports: add `freezeWorksheetWells, unfreezeWorksheetWells` to the value import and `WorksheetWellFreeze` to the type import.

`updateMutation` data type becomes:

```ts
      data: {
        title?: string
        assigned_analyst?: number
        notes?: string
        bench_config?: Record<string, unknown>
      }
```

After `bulkTicksMutation`:

```ts
  // PCR plate map: the wells are pinned the moment the sheet leaves for the
  // bench (print or QuantStudio export). Unfreezing is a deliberate re-layout.
  const freezeWellsMutation = useMutation({
    mutationFn: ({
      worksheetId,
      wells,
    }: {
      worksheetId: number
      wells: WorksheetWellFreeze[]
    }) => freezeWorksheetWells(worksheetId, wells),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
    },
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Freeze wells failed'),
  })

  const unfreezeWellsMutation = useMutation({
    mutationFn: (worksheetId: number) => unfreezeWorksheetWells(worksheetId),
    onSuccess: res => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
      toast.success(`Released ${res.cleared} well${res.cleared === 1 ? '' : 's'}`)
    },
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Unfreeze wells failed'),
  })
```

Add both to the returned object after `bulkTicksMutation`.

- [ ] **Step 5: Export `csvField`**

`src/lib/endo-bench-sheet.ts`: change `function csvField(v: string): string {` to `export function csvField(v: string): string {` (the PCR CSVs defuse formulas the same way).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git commit -m "feat(worksheets): PCR kind, well freeze API and drawer mutations" -- src/lib/worksheet-kind.ts src/lib/__tests__/worksheet-kind.test.ts src/lib/api.ts src/hooks/use-worksheet-drawer.ts src/lib/endo-bench-sheet.ts
```

---

### Task 4: `pcr-plate.ts`: reagent prep, assessment, layout with freezing

**Files:**
- Create: `src/lib/pcr-plate.ts`
- Test: `src/lib/__tests__/pcr-plate.test.ts`

**Interfaces:**
- Consumes: `shortLabDate` from `@/lib/endo-worksheet`.
- Produces: `PROTOCOL`, `CAPACITY = 48`, `SAMPLE_CAPACITY = 47`, `DEFAULT_OVERAGE = 1.4`, `NPC_ID`, `NPC_IDENTITY`; `fractions(parts)`, `fmt2(v)`, `calculatePrep(n, overage): PrepCalc`; `assess(due, runDate, priority): PcrAssessment`; types `PcrSample`, `PcrPlacement`, `PcrPlate`, `PcrListRow`, `PcrLayout`, `PlateCell`, `OrderGroup`, `PcrSummary`; `orderKey(order)`, `layoutPlates(samples, { sortByOrder? }): PcrLayout`, `wellName(pos)`, `wellsOf(placement, plateCount)`, `plateGrid(plate)`, `orderGroups(plates)`, `summarize(layout)`, `freezePayload(layout)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import {
  CAPACITY,
  PROTOCOL,
  SAMPLE_CAPACITY,
  assess,
  calculatePrep,
  fmt2,
  fractions,
  freezePayload,
  layoutPlates,
  orderGroups,
  plateGrid,
  summarize,
  wellsOf,
  type PcrSample,
} from '@/lib/pcr-plate'

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9)

function sample(
  id: string,
  order = '9001',
  extra: Partial<PcrSample> = {}
): PcrSample {
  return {
    itemId: Number(id.replace(/\D/g, '')),
    id,
    order,
    identity: 'Examplerelin',
    received: null,
    priority: 'normal',
    assessment: assess(null, null, 'normal'),
    frozen: null,
    ...extra,
  }
}
const fake = (n: number, order = '9001', from = 101) =>
  Array.from({ length: n }, (_, i) =>
    sample(`P-${String(from + i).padStart(4, '0')}`, order)
  )
const ids = (L: ReturnType<typeof layoutPlates>, plate = 0) =>
  L.plates[plate].placements.map(p => `${p.id}@${p.row}${p.col}`)

/* --- reaction and reagent volumes (the workbook's own numbers) --- */

describe('calculatePrep', () => {
  it('reaction: 10 + 1 + 2.4 + 6.6 = 20 uL per well (Template!K20:N20)', () => {
    expect(PROTOCOL.rxn).toEqual({ mm: 10, assayMix: 1, ipcMix: 2.4, template: 6.6 })
    close(calculatePrep(1, 1).perWell.total, 20)
  })

  it('mix ratios become the workbook fractions (Template!Q37:T37, K37:M37)', () => {
    expect(fractions(PROTOCOL.assayMixParts)).toEqual({
      'F Primer': 0.09, 'R Primer': 0.09, Probe: 0.05, H2O: 0.77,
    })
    expect(fractions(PROTOCOL.ipcMixParts)).toEqual({ IPC: 0.5, 'IPC DNA': 0.1, H2O: 0.4 })
  })

  it('well counts: 2N+4 for MM and IPC, N+2 for BAC and FUN (Template!D39:G39)', () => {
    expect(PROTOCOL.wellCounts(0)).toEqual({ mm: 4, bac: 2, fun: 2, ipc: 4 })
    expect(PROTOCOL.wellCounts(48)).toEqual({ mm: 100, bac: 50, fun: 50, ipc: 100 })
    expect(CAPACITY).toBe(48)
    expect(SAMPLE_CAPACITY).toBe(47)
  })

  it('the filled run: 48 wells at 1.4x reproduces Plate Map!E16:H16 and K16:M16', () => {
    const c = calculatePrep(48, 1.4)
    expect(c.bulk).toEqual({ mm: 1000, bac: 50, fun: 50, ipc: 240 })
    expect(c.bac.map(r => fmt2(r.pipette))).toEqual(['6.3', '6.3', '3.5', '53.9'])
    expect(c.fun.map(r => fmt2(r.pipette))).toEqual(['6.3', '6.3', '3.5', '53.9'])
    expect(c.ipc.map(r => fmt2(r.pipette))).toEqual(['168', '33.6', '134.4'])
    expect(c.bac.map(r => fmt2(r.base))).toEqual(['4.5', '4.5', '2.5', '38.5'])
    expect(c.ipc.map(r => fmt2(r.base))).toEqual(['120', '24', '96'])
  })

  it('the blank template: 0 samples at 1.1x reproduces Template!E16:H16, K16:M16', () => {
    const c = calculatePrep(0, 1.1)
    expect(c.bulk).toEqual({ mm: 40, bac: 2, fun: 2, ipc: 9.6 })
    ;[0.18, 0.18, 0.1, 1.54].forEach((v, i) => close(c.bac[i].base, v))
    ;[0.198, 0.198, 0.11, 1.694].forEach((v, i) => close(c.bac[i].pipette, v))
    ;[4.8, 0.96, 3.84].forEach((v, i) => close(c.ipc[i].base, v))
    ;[5.28, 1.056, 4.224].forEach((v, i) => close(c.ipc[i].pipette, v))
  })

  it('master mix is never scaled by the overage', () => {
    expect(calculatePrep(20, 1.4).bulk.mm).toBe(calculatePrep(20, 1).bulk.mm)
    expect(calculatePrep(20, 1.4).bulk.mm).toBe(10 * (2 * 20 + 4))
  })

  it('fmt2 trims float noise to two decimals', () => {
    expect(fmt2(6.300000000000001)).toBe('6.3')
    expect(fmt2(33.599999999999994)).toBe('33.6')
    expect(fmt2(11.858)).toBe('11.86')
  })
})

/* --- priority and turnaround --- */

describe('assess', () => {
  it('flags overdue, due today, and a marked priority', () => {
    expect(assess('2026-09-11', '2026-09-16', 'normal')).toEqual({
      due: '2026-09-11', urgency: 'overdue', flagged: true,
      reasons: ['Overdue, was due Sep 11'],
    })
    expect(assess('2026-09-16', '2026-09-16', 'normal')).toEqual({
      due: '2026-09-16', urgency: 'today', flagged: true, reasons: ['Due today'],
    })
    expect(assess('2026-09-18', '2026-09-16', 'normal').flagged).toBe(false)
    expect(assess('2026-09-18', '2026-09-16', 'expedited').reasons).toEqual(['Expedited'])
    expect(assess('2026-09-18', '2026-09-16', 'high').reasons).toEqual(['High priority'])
    expect(assess(null, '2026-09-16', 'normal')).toEqual({
      due: null, urgency: '', flagged: false, reasons: [],
    })
  })
})

/* --- layout --- */

describe('layoutPlates', () => {
  it('fills column-major, mirrors into the fungal block, NPC after the last sample', () => {
    const L = layoutPlates(fake(9))
    expect(L.plateCount).toBe(1)
    expect(ids(L).slice(0, 9).map(s => s.split('@')[1])).toEqual([
      'A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'A2',
    ])
    expect(ids(L)[9]).toBe('NPC@B2')
    expect(L.plates[0].placements[9].isControl).toBe(true)
    expect(L.plates[0].n).toBe(10)
    const map = plateGrid(L.plates[0])
    expect(map.get('A1')?.placement.id).toBe('P-0101')
    expect(map.get('A7')?.placement.id).toBe('P-0101')
    expect(map.get('A1')?.assay).toBe('bac')
    expect(map.get('A7')?.assay).toBe('fun')
    expect(map.get('B8')?.placement.id).toBe('NPC')
    expect(wellsOf(L.plates[0].placements[0], 1)).toBe('A1 / A7')
    expect(wellsOf(L.plates[0].placements[0], 2)).toBe('P1 A1 / A7')
    expect(L.list.length).toBe(10)
    expect(L.list.at(-1)?.isControl).toBe(true)
  })

  it('an empty worksheet is one empty plate with no NPC', () => {
    const L = layoutPlates([])
    expect(L.plateCount).toBe(1)
    expect(L.plates[0].placements).toEqual([])
    expect(L.list).toEqual([])
  })

  it('a full plate: 47 samples + NPC puts the NPC in H6 and H12, as the workbook does', () => {
    const L = layoutPlates(fake(47))
    expect(L.plateCount).toBe(1)
    const npc = L.plates[0].placements.find(p => p.isControl)
    expect(`${npc?.row}${npc?.col}`).toBe('H6')
    expect(plateGrid(L.plates[0]).get('H12')?.placement.id).toBe('NPC')
  })

  it('48 samples spill onto a second, complete plate with its own NPC', () => {
    const L = layoutPlates(fake(48))
    expect(L.plateCount).toBe(2)
    expect(L.plates.map(pl => pl.sampleCount)).toEqual([47, 1])
    expect(ids(L, 1)).toEqual(['P-0148@A1', 'NPC@B1'])
    expect(L.list.length).toBe(49)
    expect(L.list.at(-1)?.placements.length).toBe(2)
  })

  it('well order: by order number, then the worksheet order; no order last', () => {
    const s = [
      sample('A-1', '7500'), sample('A-2', '7400'), sample('A-3', '7500'),
      sample('A-4', ''), sample('B-1', '7100'), sample('B-2', '7000'),
    ]
    const only = (L: ReturnType<typeof layoutPlates>) =>
      L.plates[0].placements.filter(p => !p.isControl).map(p => p.id)
    expect(only(layoutPlates(s))).toEqual(['B-2', 'B-1', 'A-2', 'A-1', 'A-3', 'A-4'])
    expect(only(layoutPlates(s, { sortByOrder: false }))).toEqual([
      'A-1', 'A-2', 'A-3', 'A-4', 'B-1', 'B-2',
    ])
    const groups = orderGroups(layoutPlates(s).plates)
    expect(groups.map(g => [g.order, g.from, g.to, g.count])).toEqual([
      ['7000', 'A1', 'A1', 1], ['7100', 'B1', 'B1', 1], ['7400', 'C1', 'C1', 1],
      ['7500', 'D1', 'E1', 2], ['', 'F1', 'F1', 1], ['', 'G1', 'G1', 1],
    ])
    expect(groups.at(-1)?.isControl).toBe(true)
  })

  it('summarize counts flags against the run date', () => {
    const run = '2026-09-16'
    const s = [
      sample('P-1', '1', { assessment: assess('2026-09-11', run, 'normal') }),
      sample('P-2', '1', { assessment: assess('2026-09-16', run, 'normal') }),
      sample('P-3', '1', { priority: 'expedited', assessment: assess('2026-09-18', run, 'expedited') }),
      sample('P-4', '1', { assessment: assess('2026-09-18', run, 'normal') }),
    ]
    const S = summarize(layoutPlates(s))
    expect([S.samples, S.n, S.overdue, S.today, S.marked, S.flagged]).toEqual([4, 5, 1, 1, 1, 3])
    expect(S.earliestDue).toBe('2026-09-11')
    expect(S.prioText).toBe('3: 1 marked, 1 overdue, 1 due today')
    expect(summarize(layoutPlates([])).prioText).toBe('-')
  })
})

/* --- frozen wells (ruling 2026-09-22) --- */

describe('layoutPlates with frozen wells', () => {
  const frozenAt = (s: PcrSample, plate: number, pos: number): PcrSample => ({
    ...s, frozen: { plate, pos },
  })

  it('frozen samples stay where they were printed, whatever the sort says', () => {
    // Printed with 9002 before 9001 (sort was off); a re-sort must not move them.
    const s = [frozenAt(sample('P-1', '9002'), 1, 0), frozenAt(sample('P-2', '9001'), 1, 1)]
    expect(ids(layoutPlates(s))).toEqual(['P-1@A1', 'P-2@B1', 'NPC@C1'])
    expect(freezePayload(layoutPlates(s))).toEqual([])
  })

  it('late additions take the wells after the last frozen one and the NPC stays last', () => {
    const s = [
      frozenAt(sample('P-1', '9002'), 1, 0),
      frozenAt(sample('P-2', '9002'), 1, 1),
      sample('P-3', '9001'), // would sort first, but the plate is loaded
    ]
    const L = layoutPlates(s)
    expect(ids(L)).toEqual(['P-1@A1', 'P-2@B1', 'P-3@C1', 'NPC@D1'])
    expect(L.plates[0].placements.map(p => p.frozen)).toEqual([true, true, false, false])
    expect(freezePayload(L)).toEqual([{ item_id: 3, plate_no: 1, well_pos: 2 }])
    expect(L.frozenCount).toBe(2)
  })

  it('a removed sample leaves its well empty; it is never re-issued', () => {
    const s = [frozenAt(sample('P-1'), 1, 0), frozenAt(sample('P-3'), 1, 2), sample('P-4')]
    const L = layoutPlates(s)
    expect(ids(L)).toEqual(['P-1@A1', 'P-3@C1', 'P-4@D1', 'NPC@E1'])
    expect(plateGrid(L.plates[0]).has('B1')).toBe(false)
  })

  it('a full frozen plate spills late additions to the next plate', () => {
    const s = fake(47).map((x, i) => frozenAt(x, 1, i)).concat(fake(2, '9001', 200))
    const L = layoutPlates(s)
    expect(L.plateCount).toBe(2)
    expect(ids(L, 0).at(-1)).toBe('NPC@H6')
    expect(ids(L, 1)).toEqual(['P-0200@A1', 'P-0201@B1', 'NPC@C1'])
    expect(freezePayload(L)).toEqual([
      { item_id: 200, plate_no: 2, well_pos: 0 },
      { item_id: 201, plate_no: 2, well_pos: 1 },
    ])
  })

  it('order groups follow the wells as laid out, across a plate boundary', () => {
    const s = fake(46, '9001').concat(fake(3, '9002', 300))
    const groups = orderGroups(layoutPlates(s).plates).filter(g => !g.isControl)
    expect(groups.map(g => [g.plate, g.order, g.count])).toEqual([
      [1, '9001', 46], [1, '9002', 1], [2, '9002', 2],
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/pcr-plate.test.ts`
Expected: FAIL, cannot resolve `@/lib/pcr-plate`.

- [ ] **Step 3: Write `src/lib/pcr-plate.ts`** (the exports section is appended in Task 5)

```ts
/**
 * qPCR plate builder: the 96-well 16S / 18S layout, reagent prep and export
 * layouts for a rapid-sterility PCR run.
 *
 * Ported from tools-dennis/tools/qpcr-plate-builder/calc.js (Dennis's plate
 * builder, in daily use since 2026-09-14). Every constant names the workbook
 * cell it came from (qPCR_PlateMap_09-11-2026.xlsx, Template tab). Pure: no
 * DOM, no fetch, no storage. Not ported: the CSV intake (the inbox is the
 * intake), the holiday calendar (the SLA engine owns due dates), run ids (the
 * worksheet id) and the hand-added NTC (never used in a filed run).
 *
 * Frozen wells (ruling 2026-09-22): once a plate has been printed or exported
 * for the QuantStudio it is loaded at the bench, so the wells it was printed
 * with never move. A sample carries its frozen (plate, pos); the layout keeps
 * every frozen sample where it is, deals the rest into the wells after the
 * last frozen one, and puts the NPC after the last sample on every plate.
 *
 * Spec: docs/superpowers/specs/2026-09-22-pcr-worksheet-design.md
 */
import { shortLabDate } from '@/lib/endo-worksheet'

export const PROTOCOL = {
  /** Per-well reaction, uL. Template!K20:N20 (20 uL total, Reagent List!L6). */
  rxn: { mm: 10, assayMix: 1, ipcMix: 2.4, template: 6.6 },
  /** Assay mix (16S and 18S alike), parts by volume. Template!Q36:T36. */
  assayMixParts: { 'F Primer': 9, 'R Primer': 9, Probe: 5, H2O: 77 },
  /** IPC mix, parts by volume. Template!K36:M36; run at 0.6x (Template!P14). */
  ipcMixParts: { IPC: 20, 'IPC DNA': 4, H2O: 16 },
  /** Well counts carry a fixed buffer over the wells on the plate. Template!D39:G39. */
  wellCounts: (n: number) => ({
    mm: 2 * n + 4,
    bac: n + 2,
    fun: n + 2,
    ipc: 2 * n + 4,
  }),
  /** Plate geometry: Template!C5:C12 (A..H) by Template!D4:O4 (1..12). */
  rows: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  cols: 12,
  /** Reagent List!B4:C13, printed for reference. */
  reagents: [
    ['16S-F', '200 µM'],
    ['16S-R', '200 µM'],
    ['18S-F', '200 µM'],
    ['18S-R', '200 µM'],
    ['16S Probe', '100 µM'],
    ['18S Probe', '100 µM'],
    ['Master Mix', '2x'],
    ['10x exo IPC mix', '10x'],
    ['50x exo IPC DNA', '50x'],
    ['10x block-exp IPC', '10x'],
  ] as [string, string][],
}

/** 8 rows x 6 bacterial columns: 48 wells per assay block. */
export const CAPACITY = 48
/** One well on every plate is the NPC's, after the last sample. */
export const SAMPLE_CAPACITY = CAPACITY - 1
/** Plate Map!E16 = K44 * 1.4: the filled run's factor on the mix components. */
export const DEFAULT_OVERAGE = 1.4
export const NPC_ID = 'NPC'
export const NPC_IDENTITY = 'No-template control'

const sum = (o: Record<string, number>) =>
  Object.values(o).reduce((a, b) => a + b, 0)

/** Parts by volume to fractions of the whole. Template!Q37:T37 and K37:M37. */
export function fractions(
  parts: Record<string, number>
): Record<string, number> {
  const total = sum(parts)
  return Object.fromEntries(
    Object.entries(parts).map(([k, v]) => [k, v / total])
  )
}

/** Two decimals, float noise trimmed: 6.300000000000001 -> "6.3". */
export function fmt2(v: number): string {
  return String(Math.round(v * 100) / 100)
}

export interface MixRow {
  name: string
  base: number
  pipette: number
}

export interface PrepCalc {
  wells: { mm: number; bac: number; fun: number; ipc: number }
  perWell: {
    mm: number
    assayMix: number
    ipcMix: number
    template: number
    total: number
  }
  bulk: { mm: number; bac: number; fun: number; ipc: number }
  bac: MixRow[]
  fun: MixRow[]
  ipc: MixRow[]
}

/**
 * Full prep for one plate of n wells at the given overage. Bulk = per-well
 * volume x wells of that kind (Template!D32:G32); each mix is split into its
 * components by the fractions (K32:N32, Q32:T32, D36:F36) and scaled by the
 * overage for the pipetting column (E16:H16, K16:M16, E20:H20). Master mix
 * is not scaled, matching the workbook. Volumes in uL.
 */
export function calculatePrep(n: number, overage: number): PrepCalc {
  const wells = PROTOCOL.wellCounts(n)
  const { rxn } = PROTOCOL
  const bulk = {
    mm: rxn.mm * wells.mm,
    bac: rxn.assayMix * wells.bac,
    fun: rxn.assayMix * wells.fun,
    ipc: rxn.ipcMix * wells.ipc,
  }
  const split = (frac: Record<string, number>, volume: number): MixRow[] =>
    Object.entries(frac).map(([name, f]) => ({
      name,
      base: f * volume,
      pipette: f * volume * overage,
    }))
  const assayFrac = fractions(PROTOCOL.assayMixParts)
  const ipcFrac = fractions(PROTOCOL.ipcMixParts)
  return {
    wells,
    perWell: { ...rxn, total: sum(rxn) },
    bulk,
    bac: split(assayFrac, bulk.bac),
    fun: split(assayFrac, bulk.fun),
    ipc: split(ipcFrac, bulk.ipc),
  }
}

/* ---------------- priority and turnaround ---------------- */

export type Urgency = 'overdue' | 'today' | 'later' | ''

export interface PcrAssessment {
  /** YYYY-MM-DD lab date from the SLA engine, or null. */
  due: string | null
  urgency: Urgency
  flagged: boolean
  reasons: string[]
}

/** A sample against the run date: overdue, due today, or marked priority. */
export function assess(
  due: string | null,
  runDate: string | null,
  priority: string | null | undefined
): PcrAssessment {
  let urgency: Urgency = ''
  if (due && runDate)
    urgency = due < runDate ? 'overdue' : due === runDate ? 'today' : 'later'
  const reasons: string[] = []
  const p = (priority ?? '').toLowerCase()
  if (p === 'expedited') reasons.push('Expedited')
  else if (p === 'high') reasons.push('High priority')
  if (urgency === 'overdue')
    reasons.push(`Overdue, was due ${shortLabDate(due)}`)
  if (urgency === 'today') reasons.push('Due today')
  return { due, urgency, flagged: reasons.length > 0, reasons }
}

/* ---------------- samples and layout ---------------- */

export interface PcrSample {
  itemId: number
  id: string
  /** Order number without the WP- prefix; '' when unknown. */
  order: string
  identity: string
  /** YYYY-MM-DD lab date, or null. */
  received: string | null
  priority: string
  assessment: PcrAssessment
  /** Set once the plate was printed or exported: this well never moves. */
  frozen: { plate: number; pos: number } | null
}

export interface PcrPlacement {
  /** null for the NPC. */
  sample: PcrSample | null
  id: string
  identity: string
  order: string
  /** 1-based plate number. */
  plate: number
  /** 0..47, column-major within the bacterial block. */
  pos: number
  row: string
  /** Bacterial column 1..6; the fungal mirror is col + 6. */
  col: number
  /** Contiguous run of one order number; the NPC trails as its own group. */
  group: number
  isControl: boolean
  frozen: boolean
  assessment: PcrAssessment | null
}

export interface PcrPlate {
  plate: number
  /** Samples by well, then the NPC. */
  placements: PcrPlacement[]
  sampleCount: number
  /** Wells used on this plate, NPC included: the N of the reagent prep. */
  n: number
}

export interface PcrListRow {
  sample: PcrSample | null
  isControl: boolean
  group: number
  /** One placement for a sample; one per plate for the NPC. */
  placements: PcrPlacement[]
}

export interface PcrLayout {
  plates: PcrPlate[]
  plateCount: number
  /** Samples in run order (plate, then well), then the NPC once. */
  list: PcrListRow[]
  frozenCount: number
}

/** Numeric where possible, else the raw text; null when blank. */
export function orderKey(order: string): number | string | null {
  const raw = order.trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : raw
}

/**
 * Ordering rule with "Order wells by order #" on: samples carrying an order
 * number first, ascending; samples with no order number after them; the
 * worksheet's own order within one order number (the lab's practice, asked
 * for by Dennis 2026-09-15).
 */
function compareByOrder(
  a: { s: PcrSample; i: number },
  b: { s: PcrSample; i: number }
): number {
  const ka = orderKey(a.s.order)
  const kb = orderKey(b.s.order)
  if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1
  if (ka !== null && kb !== null && ka !== kb) {
    if (typeof ka === 'number' && typeof kb === 'number') return ka - kb
    return String(ka).localeCompare(String(kb), undefined, { numeric: true })
  }
  return a.i - b.i
}

export const wellName = (pos: number): string =>
  `${PROTOCOL.rows[pos % 8]}${Math.floor(pos / 8) + 1}`

/**
 * Deal a run's samples onto plates. Frozen samples keep their wells. The next
 * free well on a plate is one past its highest frozen well (a well once
 * issued is never re-issued, even after its sample was removed), and a plate
 * takes samples up to SAMPLE_CAPACITY so the NPC always has the last well.
 * Loose samples fill plate 1's free wells, then plate 2's, then new plates.
 * Within a plate the fill is column-major, A1..H1 then A2..H2 (Template!D5
 * = B10, D6 = B11 ... E5 = B18); every well mirrors into the fungal block at
 * col + 6 (Template!J5 = B10 ...).
 */
export function layoutPlates(
  samples: PcrSample[],
  opts: { sortByOrder?: boolean } = {}
): PcrLayout {
  const sortByOrder = opts.sortByOrder !== false
  const wells = new Map<number, Map<number, PcrSample>>()
  const place = (plate: number, pos: number, s: PcrSample) => {
    let m = wells.get(plate)
    if (!m) {
      m = new Map()
      wells.set(plate, m)
    }
    m.set(pos, s)
  }
  let frozenCount = 0
  for (const s of samples)
    if (s.frozen) {
      place(s.frozen.plate, s.frozen.pos, s)
      frozenCount++
    }
  const nextFree = (plate: number) => {
    const m = wells.get(plate)
    return m ? Math.max(-1, ...m.keys()) + 1 : 0
  }
  const loose = samples.map((s, i) => ({ s, i })).filter(x => !x.s.frozen)
  if (sortByOrder) loose.sort(compareByOrder)
  let plate = 1
  let next = nextFree(plate)
  for (const { s } of loose) {
    while (next >= SAMPLE_CAPACITY) {
      plate++
      next = nextFree(plate)
    }
    place(plate, next, s)
    next++
  }

  const plateCount = Math.max(1, ...wells.keys())
  const plates: PcrPlate[] = []
  let group = -1
  let prevKey: number | string | null | undefined
  for (let p = 1; p <= plateCount; p++) {
    const m = wells.get(p) ?? new Map<number, PcrSample>()
    const positions = [...m.keys()].sort((a, b) => a - b)
    const placements: PcrPlacement[] = positions.map(pos => {
      const s = m.get(pos) as PcrSample
      const key = orderKey(s.order)
      if (group < 0 || key !== prevKey) group++
      prevKey = key
      return {
        sample: s,
        id: s.id,
        identity: s.identity,
        order: s.order,
        plate: p,
        pos,
        row: PROTOCOL.rows[pos % 8],
        col: Math.floor(pos / 8) + 1,
        group,
        isControl: false,
        frozen: !!s.frozen,
        assessment: s.assessment,
      }
    })
    plates.push({
      plate: p,
      placements,
      sampleCount: positions.length,
      n: positions.length,
    })
  }
  // The NPC: one trailing group for the whole run, the well after the last
  // sample on every plate that has one (H6 / H12 on a full plate).
  const ctrlGroup = group + 1
  const npcs: PcrPlacement[] = []
  for (const pl of plates) {
    if (!pl.sampleCount) continue
    const pos = pl.placements[pl.placements.length - 1].pos + 1
    const npc: PcrPlacement = {
      sample: null,
      id: NPC_ID,
      identity: NPC_IDENTITY,
      order: '',
      plate: pl.plate,
      pos,
      row: PROTOCOL.rows[pos % 8],
      col: Math.floor(pos / 8) + 1,
      group: ctrlGroup,
      isControl: true,
      frozen: false,
      assessment: null,
    }
    pl.placements.push(npc)
    pl.n = pl.placements.length
    npcs.push(npc)
  }
  const list: PcrListRow[] = []
  for (const pl of plates)
    for (const pc of pl.placements)
      if (!pc.isControl)
        list.push({
          sample: pc.sample,
          isControl: false,
          group: pc.group,
          placements: [pc],
        })
  if (npcs.length)
    list.push({ sample: null, isControl: true, group: ctrlGroup, placements: npcs })
  return { plates, plateCount, list, frozenCount }
}

/** "A1 / A7" for a placement; with the plate when the run has several. */
export function wellsOf(p: PcrPlacement, plateCount: number): string {
  const w = `${p.row}${p.col} / ${p.row}${p.col + 6}`
  return plateCount > 1 ? `P${p.plate} ${w}` : w
}

export interface PlateCell {
  placement: PcrPlacement
  assay: 'bac' | 'fun'
}

/** "A1" -> cell, for both the bacterial block and its mirror at col + 6. */
export function plateGrid(plate: PcrPlate): Map<string, PlateCell> {
  const map = new Map<string, PlateCell>()
  for (const p of plate.placements) {
    map.set(`${p.row}${p.col}`, { placement: p, assay: 'bac' })
    map.set(`${p.row}${p.col + 6}`, { placement: p, assay: 'fun' })
  }
  return map
}

export interface OrderGroup {
  plate: number
  group: number
  order: string
  isControl: boolean
  count: number
  flagged: number
  from: string
  to: string
}

/** Contiguous order groups per plate, with the well span each one occupies. */
export function orderGroups(plates: PcrPlate[]): OrderGroup[] {
  const groups: OrderGroup[] = []
  for (const pl of plates)
    for (const p of pl.placements) {
      const well = `${p.row}${p.col}`
      const flagged = p.assessment?.flagged ? 1 : 0
      const last = groups[groups.length - 1]
      if (last && last.plate === pl.plate && last.group === p.group) {
        last.count++
        last.flagged += flagged
        last.to = well
      } else {
        groups.push({
          plate: pl.plate,
          group: p.group,
          order: p.order,
          isControl: p.isControl,
          count: 1,
          flagged,
          from: well,
          to: well,
        })
      }
    }
  return groups
}

export interface PcrSummary {
  /** Rows on the run list: samples plus the NPC. */
  n: number
  samples: number
  plateCount: number
  overdue: number
  today: number
  marked: number
  flagged: number
  earliestDue: string | null
  prioText: string
}

/** Run-wide figures, shared by the header readouts and the printed run strip. */
export function summarize(L: PcrLayout): PcrSummary {
  const real = L.list.filter(r => !r.isControl).map(r => r.sample as PcrSample)
  const dues = real
    .map(s => s.assessment.due)
    .filter((d): d is string => !!d)
    .sort()
  const overdue = real.filter(s => s.assessment.urgency === 'overdue').length
  const today = real.filter(s => s.assessment.urgency === 'today').length
  const marked = real.filter(s => /^(expedited|high)$/i.test(s.priority)).length
  const flagged = real.filter(s => s.assessment.flagged).length
  const parts: string[] = []
  if (marked) parts.push(`${marked} marked`)
  if (overdue) parts.push(`${overdue} overdue`)
  if (today) parts.push(`${today} due today`)
  return {
    n: L.list.length,
    samples: real.length,
    plateCount: L.plateCount,
    overdue,
    today,
    marked,
    flagged,
    earliestDue: dues[0] ?? null,
    prioText: flagged
      ? `${flagged}: ${parts.join(', ')}`
      : real.length
        ? 'none'
        : '-',
  }
}

/** The wells to pin: every sample not frozen yet, where the layout put it. */
export function freezePayload(
  L: PcrLayout
): { item_id: number; plate_no: number; well_pos: number }[] {
  return L.plates.flatMap(pl =>
    pl.placements
      .filter(p => p.sample && !p.frozen)
      .map(p => ({
        item_id: (p.sample as PcrSample).itemId,
        plate_no: p.plate,
        well_pos: p.pos,
      }))
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/pcr-plate.test.ts`
Expected: 17 passed.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pcr): plate layout with frozen wells and reagent prep (calc.js port)" -- src/lib/pcr-plate.ts src/lib/__tests__/pcr-plate.test.ts
```

---

### Task 5: `pcr-plate.ts` exports: plate map CSV, well list CSV, prep rows, QuantStudio file

**Files:**
- Modify: `src/lib/pcr-plate.ts` (append; add `import { csvField } from '@/lib/endo-bench-sheet'`)
- Test: `src/lib/__tests__/pcr-plate.test.ts` (append)

**Interfaces:**
- Consumes: `csvField` (Task 3).
- Produces: `PcrRunMeta`, `metaHeaderRows(meta, L)`, `plateMapRows(L)`, `WELL_LIST_HEADER`, `wellListRows(L)`, `prepRows(L, overage)`, `QS_ATTRIBUTES`, `QuantStudioFile`, `quantStudioFiles(L, { runId, date })`, `toCsv(rows)`.

- [ ] **Step 1: Write the failing tests** (append to `pcr-plate.test.ts`; extend the import with `metaHeaderRows, plateMapRows, prepRows, quantStudioFiles, toCsv, wellListRows, QS_ATTRIBUTES, WELL_LIST_HEADER`)

```ts
/* --- exports --- */

describe('exports', () => {
  const meta = {
    runId: 'WS-24', runName: 'PCR 09/22/2026', date: '2026-09-22', analyst: 'Guian',
    curve: 'Quantitative', plateType: '8-Well Strip', instrument: 'QuantStudio 6 Flex',
    overage: 1.4,
  }

  it('well list: one row per occupied well in both blocks, the NPC as task NTC', () => {
    const rows = wellListRows(layoutPlates(fake(2)))
    expect(rows[0]).toEqual(WELL_LIST_HEADER)
    expect(rows.length).toBe(1 + 3 * 2)
    const npc = rows.filter(r => r[2] === 'NPC')
    expect(npc.map(r => [r[1], r[8], r[9], r[10]])).toEqual([
      ['C1', 'Bacterial', '16S', 'NTC'], ['C7', 'Fungal', '18S', 'NTC'],
    ])
    expect(rows[1][10]).toBe('UNKNOWN')
  })

  it('plate map: two 8 x 12 grids per plate, ids then identities', () => {
    const rows = plateMapRows(layoutPlates(fake(1)))
    expect(rows[0]).toEqual(['Plate 1 of 1: Sample ID'])
    expect(rows[1]).toEqual(['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
    expect(rows[2][1]).toBe('P-0101')
    expect(rows[2][7]).toBe('P-0101')
    expect(rows[3][1]).toBe('NPC')
    expect(rows[11]).toEqual(['Plate 1 of 1: Sample identity'])
    expect(rows[13][1]).toBe('Examplerelin')
    expect(rows[14][7]).toBe('No-template control')
  })

  it('the run header leads the plate map CSV', () => {
    const rows = metaHeaderRows(meta, layoutPlates(fake(1)))
    expect(rows[0]).toEqual(['Run ID', 'WS-24'])
    expect(rows[7]).toEqual(['Samples', '1'])
    expect(rows[9]).toEqual(['Overage', '1.4x'])
    expect(rows.at(-1)).toEqual([])
  })

  it('prepRows carries the calculation cards for every plate', () => {
    const rows = prepRows(layoutPlates(fake(8)), 1.4)
    expect(rows[1]).toEqual(['1', 'Wells', 'Wells on plate (N)', '9', ''])
    expect(rows[2]).toEqual(['1', 'Wells', 'Master mix wells', '22', ''])
    const h2o = rows.find(r => r[1] === 'BAC mix' && r[2] === 'H2O')
    expect(h2o).toEqual(['1', 'BAC mix', 'H2O', '8.47', '11.86'])
  })

  it('QuantStudio file: tab-delimited, Sample Name first, 7 attributes, one row per well pair, no tabs in values', () => {
    const s = sample('P-0101', '9001', {
      identity: 'Exam\tplerelin', received: '2026-09-11',
      assessment: assess('2026-09-16', '2026-09-16', 'normal'),
    })
    const files = quantStudioFiles(layoutPlates([s]), { runId: 'WS-24', date: '2026-09-16' })
    expect(files.length).toBe(1)
    const lines = files[0].text.split('\r\n')
    expect(lines[0]).toBe(['Sample Name', ...QS_ATTRIBUTES].join('\t'))
    expect(QS_ATTRIBUTES.length).toBe(7)
    expect(lines[1]).toBe('P-0101\t9001\tExam plerelin\t2026-09-11\t2026-09-16\tDue today\t1\tA1; A7')
    expect(lines[2]).toBe('NPC\t\tNo-template control\t\t\t\t1\tB1; B7')
    expect(lines[3]).toBe('')
    expect(files[0].filename).toBe('quantstudio-WS-24-2026-09-16.txt')
    const two = quantStudioFiles(layoutPlates(fake(48)), { runId: 'WS-24', date: '2026-09-16' })
    expect(two.map(f => f.filename)).toEqual([
      'quantstudio-WS-24-plate1-2026-09-16.txt', 'quantstudio-WS-24-plate2-2026-09-16.txt',
    ])
  })

  it('toCsv quotes where needed and defuses a formula cell', () => {
    expect(toCsv([['a', 'x, y'], ['=1+1', ''], []])).toBe('a,"x, y"\r\n"\'=1+1",\r\n\r\n')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/pcr-plate.test.ts`
Expected: the 6 new tests fail (missing exports).

- [ ] **Step 3: Append to `src/lib/pcr-plate.ts`**

```ts
/* ---------------- exports ---------------- */

export interface PcrRunMeta {
  /** "WS-24": the worksheet id stands in for Dennis's R-YYYYMMDD-n. */
  runId: string
  runName: string
  /** YYYY-MM-DD lab date the run was made. */
  date: string
  analyst: string
  curve: string
  plateType: string
  instrument: string
  overage: number
}

/** The run header that leads the plate map CSV. */
export function metaHeaderRows(meta: PcrRunMeta, L: PcrLayout): string[][] {
  return [
    ['Run ID', meta.runId],
    ['Run name', meta.runName],
    ['Date', meta.date],
    ['Analyst', meta.analyst],
    ['Curve', meta.curve],
    ['Plate type', meta.plateType],
    ['QuantStudio', meta.instrument],
    ['Samples', String(L.list.filter(r => !r.isControl).length)],
    ['Plates', String(L.plateCount)],
    ['Overage', `${meta.overage}x`],
    [],
  ]
}

/** Two 8 x 12 grids per plate: sample ids, then sample identities. */
export function plateMapRows(L: PcrLayout): string[][] {
  const rows: string[][] = []
  const colHead = [
    '',
    ...Array.from({ length: PROTOCOL.cols }, (_, i) => String(i + 1)),
  ]
  const grid = (
    map: Map<string, PlateCell>,
    pick: (c: PlateCell | undefined) => string
  ) =>
    PROTOCOL.rows.map(r => [
      r,
      ...Array.from({ length: PROTOCOL.cols }, (_, i) =>
        pick(map.get(`${r}${i + 1}`))
      ),
    ])
  for (const pl of L.plates) {
    const map = plateGrid(pl)
    const label = `Plate ${pl.plate} of ${L.plateCount}`
    rows.push(
      [`${label}: Sample ID`],
      colHead,
      ...grid(map, c => c?.placement.id ?? ''),
      []
    )
    rows.push(
      [`${label}: Sample identity`],
      colHead,
      ...grid(map, c => c?.placement.identity ?? ''),
      []
    )
  }
  return rows
}

export const WELL_LIST_HEADER = [
  'Plate', 'Well', 'Sample Name', 'Order', 'Identity', 'Received', 'Due',
  'Priority', 'Assay', 'Target', 'Task',
]

/** One row per occupied well, both assay blocks. Task NTC for the control. */
export function wellListRows(L: PcrLayout): string[][] {
  const rows: string[][] = [WELL_LIST_HEADER]
  for (const pl of L.plates) {
    const map = plateGrid(pl)
    for (const r of PROTOCOL.rows)
      for (let c = 1; c <= PROTOCOL.cols; c++) {
        const cell = map.get(`${r}${c}`)
        if (!cell) continue
        const p = cell.placement
        const a = p.assessment
        rows.push([
          String(pl.plate),
          `${r}${c}`,
          p.id,
          p.order,
          p.identity,
          p.sample?.received ?? '',
          a?.due ?? '',
          a?.flagged ? a.reasons.join('; ') : '',
          cell.assay === 'bac' ? 'Bacterial' : 'Fungal',
          cell.assay === 'bac' ? '16S' : '18S',
          p.isControl ? 'NTC' : 'UNKNOWN',
        ])
      }
  }
  return rows
}

/** The calculation cards as rows, one block per plate. */
export function prepRows(L: PcrLayout, overage: number): string[][] {
  const rows: string[][] = [
    ['Plate', 'Table', 'Item', 'Calculated (uL)', `Pipette x${overage} (uL)`],
  ]
  for (const pl of L.plates) {
    const p = String(pl.plate)
    const c = calculatePrep(pl.n, overage)
    rows.push([p, 'Wells', 'Wells on plate (N)', String(pl.n), ''])
    rows.push([p, 'Wells', 'Master mix wells', String(c.wells.mm), ''])
    rows.push([p, 'Wells', 'BAC wells', String(c.wells.bac), ''])
    rows.push([p, 'Wells', 'FUN wells', String(c.wells.fun), ''])
    rows.push([p, 'Wells', 'IPC wells', String(c.wells.ipc), ''])
    rows.push([p, 'Per well', 'Master mix', fmt2(c.perWell.mm), ''])
    rows.push([p, 'Per well', 'Assay mix', fmt2(c.perWell.assayMix), ''])
    rows.push([p, 'Per well', 'IPC mix', fmt2(c.perWell.ipcMix), ''])
    rows.push([p, 'Per well', 'Template', fmt2(c.perWell.template), ''])
    rows.push([p, 'Per well', 'Total per well', fmt2(c.perWell.total), ''])
    rows.push([p, 'Bulk', 'Master mix', fmt2(c.bulk.mm), ''])
    rows.push([p, 'Bulk', 'BAC mix', fmt2(c.bulk.bac), ''])
    rows.push([p, 'Bulk', 'FUN mix', fmt2(c.bulk.fun), ''])
    rows.push([p, 'Bulk', 'IPC mix', fmt2(c.bulk.ipc), ''])
    const tables: [string, MixRow[]][] = [
      ['BAC mix', c.bac],
      ['FUN mix', c.fun],
      ['IPC mix', c.ipc],
    ]
    for (const [table, comps] of tables) {
      for (const r of comps)
        rows.push([p, table, r.name, fmt2(r.base), fmt2(r.pipette)])
      rows.push([
        p,
        table,
        'Total',
        fmt2(comps.reduce((a, r) => a + r.base, 0)),
        fmt2(comps.reduce((a, r) => a + r.pipette, 0)),
      ])
    }
  }
  return rows
}

/* QuantStudio 6/7 Flex "Import Sample File": tab-delimited, header row first,
 * the first column named exactly `Sample Name`, at most 32 attribute columns
 * after it, attribute names under 256 characters, no tabs or line breaks in a
 * value. One file per plate (each plate is its own experiment), every sample
 * listed once (the fungal mirror is the same sample in another well). The
 * NPC rides as a sample named NPC; the task is set on the instrument. */
export const QS_ATTRIBUTES = [
  'Order', 'Identity', 'Received', 'Due', 'Priority', 'Plate', 'Wells',
]

export interface QuantStudioFile {
  plate: number
  label: string
  filename: string
  text: string
}

export function quantStudioFiles(
  L: PcrLayout,
  meta: { runId: string; date: string }
): QuantStudioFile[] {
  const clean = (v: string | null | undefined) =>
    String(v ?? '')
      .replace(/[\t\r\n]+/g, ' ')
      .trim()
  return L.plates.map(pl => {
    const rows = [['Sample Name', ...QS_ATTRIBUTES]]
    for (const p of pl.placements) {
      const a = p.assessment
      rows.push([
        clean(p.id),
        clean(p.order),
        clean(p.identity),
        clean(p.sample?.received),
        clean(a?.due),
        clean(a?.flagged ? a.reasons.join('; ') : ''),
        String(pl.plate),
        `${p.row}${p.col}; ${p.row}${p.col + 6}`,
      ])
    }
    const suffix = L.plateCount > 1 ? `-plate${pl.plate}` : ''
    return {
      plate: pl.plate,
      label:
        L.plateCount > 1
          ? `Plate ${pl.plate} of ${L.plateCount} (${pl.n} wells)`
          : `Plate (${pl.n} wells)`,
      filename: `quantstudio-${meta.runId || 'run'}${suffix}-${meta.date || 'undated'}.txt`.replace(
        /[^\w.-]+/g,
        '-'
      ),
      text: rows.map(r => r.join('\t')).join('\r\n') + '\r\n',
    }
  })
}

/** Rows to CSV: CRLF, quoted where needed, formula cells defused (csvField). */
export function toCsv(rows: string[][]): string {
  return rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/pcr-plate.test.ts`
Expected: 23 passed.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pcr): plate map, well list, prep and QuantStudio exports" -- src/lib/pcr-plate.ts src/lib/__tests__/pcr-plate.test.ts
```

---

### Task 6: Worksheet glue and the printed bench sheet

**Files:**
- Create: `src/lib/pcr-worksheet.ts`
- Create: `src/lib/pcr-bench-sheet.ts`
- Test: `src/lib/__tests__/pcr-worksheet.test.ts`, `src/lib/__tests__/pcr-bench-sheet.test.ts`

**Interfaces:**
- Consumes: `benchKindForItem`; `labDate`, `LabCalendar` (endo-prep); `endoIdentityFor`, `shortOrder`, `WorksheetItemRow` (endo-worksheet); `escapeHtml` (endo-bench-sheet); everything from `pcr-plate`.
- Produces (`pcr-worksheet.ts`): `isPcrWorksheetItem(item)`, `plateLabel(id)`, `PcrConfig`, `DEFAULT_PCR_CONFIG`, `pcrConfigOf(ws)`, `pcrConfigToWire(cfg)`, `pcrRunDate(ws, cal)`, `pcrSamplesFor(items, dueAtByItemId, cal, runDate)`, `stampedInstrument(items)`, `PcrRunDoc`, `PcrRunOptions`, `buildPcrRunDoc(ws, opts)`.
- Produces (`pcr-bench-sheet.ts`): `buildPcrBenchSheetHtml(doc, { preview? })`, `buildPcrPlateMapCsv(doc)`, `buildPcrWellListCsv(doc)`.

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/pcr-worksheet.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { WorksheetListItem } from '@/lib/api'
import type { LabCalendar } from '@/lib/endo-prep'
import {
  buildPcrRunDoc,
  pcrConfigOf,
  pcrConfigToWire,
  pcrRunDate,
  pcrSamplesFor,
  plateLabel,
} from '@/lib/pcr-worksheet'

const cal: LabCalendar = {
  timezone: 'America/Los_Angeles',
  workingDays: [0, 1, 2, 3, 4],
  holidays: new Map(),
}

function item(
  id: number,
  overrides: Partial<WorksheetListItem['items'][number]> = {}
): WorksheetListItem['items'][number] {
  return {
    id,
    sample_id: `P-3001-S0${id}`,
    sample_uid: `mk1://pcr-${id}`,
    service_group_id: null,
    department_id: 3,
    department_name: 'Microbiology',
    group_name: '-',
    group_color: 'zinc',
    priority: 'normal',
    added_at: '2026-09-21T16:00:00Z',
    date_received: '2026-09-21T16:00:00Z',
    instrument_uid: null,
    instrument_id: null,
    assigned_analyst_id: null,
    assigned_analyst_email: null,
    notes: null,
    peptide_id: null,
    method_name: null,
    stamped_method_name: null,
    stamped_instrument_name: null,
    lims_sub_sample_pk: id,
    assignment_role: 'pcr',
    box_id: null,
    box_label: null,
    analyses: [{ title: 'Rapid Sterility Screening (PCR)', keyword: 'STERILITY-PCR', peptide_name: null, method: null }],
    prep_status: 'ready',
    client_order_number: 'WP-8120',
    sample_identity: 'BPC-157',
    ...overrides,
  }
}

function worksheet(items: WorksheetListItem['items'], extra: Partial<WorksheetListItem> = {}): WorksheetListItem {
  return {
    id: 24,
    title: 'PCR 09/22/2026',
    status: 'open',
    notes: null,
    assigned_analyst: null,
    assigned_analyst_email: null,
    item_count: items.length,
    created_at: '2026-09-22T15:00:00Z',
    completed_at: null,
    items,
    ...extra,
  }
}

describe('pcrConfigOf', () => {
  it('reads bench_config with defaults for anything missing or bad', () => {
    expect(pcrConfigOf({ bench_config: null })).toEqual({
      overage: 1.4, curve: '', plateType: '', sortByOrder: true,
    })
    expect(pcrConfigOf({ bench_config: { overage: 'x', curve: 'P/A', plate_type: 7, sort_by_order: false } })).toEqual({
      overage: 1.4, curve: 'P/A', plateType: '', sortByOrder: false,
    })
    expect(pcrConfigToWire({ overage: 1.1, curve: 'Q', plateType: 'S', sortByOrder: true })).toEqual({
      overage: 1.1, curve: 'Q', plate_type: 'S', sort_by_order: true,
    })
  })
})

describe('pcrSamplesFor', () => {
  it('turns PCR items into samples with lab dates, order, identity and the frozen well', () => {
    const due = new Map([[1, '2026-09-24T22:59:00Z'], [2, null]])
    const [a, b] = pcrSamplesFor(
      [item(1, { plate_no: 1, well_pos: 5 }), item(2, { assignment_role: 'ster' }), item(3, { assignment_role: 'endo' })],
      due, cal, '2026-09-22'
    )
    expect(a).toMatchObject({
      itemId: 1, id: 'P-3001-S01', order: '8120', identity: 'BPC-157', received: '2026-09-21',
      frozen: { plate: 1, pos: 5 },
    })
    expect(a.assessment).toMatchObject({ due: '2026-09-24', urgency: 'later', flagged: false })
    expect(b.frozen).toBeNull()
    expect(b.assessment.due).toBeNull()
  })

  it('runs are judged against today while open and the completion day once completed', () => {
    expect(pcrRunDate(worksheet([]), cal)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(pcrRunDate(worksheet([], { status: 'completed', completed_at: '2026-09-23T03:00:00Z' }), cal)).toBe('2026-09-22')
    expect(pcrRunDate(worksheet([]), null)).toBeNull()
  })

  it('plateLabel drops a vial suffix for the well only', () => {
    expect(plateLabel('P-3001-S02')).toBe('P-3001')
    expect(plateLabel('BW-0105-S03')).toBe('BW-0105')
    expect(plateLabel('NPC')).toBe('NPC')
  })
})

describe('buildPcrRunDoc', () => {
  it('lays the worksheet out and counts the run status', () => {
    const ws = worksheet(
      [item(1, { made_at: '2026-09-22T16:00:00Z', ran_at: '2026-09-22T17:00:00Z', stamped_instrument_name: 'QuantStudio 6 Flex' }), item(2, { made_at: '2026-09-22T16:00:00Z' })],
      { bench_config: { overage: 1.1, curve: 'Quantitative' } }
    )
    const doc = buildPcrRunDoc(ws, {
      analystName: 'Guian', calendar: cal, printedAt: 'Sep 22, 2026, 10:04 AM',
      dueAtByItemId: new Map(), notes: 'lot 42',
    })
    expect(doc.meta).toMatchObject({ runId: 'WS-24', runName: 'PCR 09/22/2026', date: '2026-09-22', curve: 'Quantitative', overage: 1.1, instrument: 'QuantStudio 6 Flex' })
    expect(doc.layout.plates[0].placements.map(p => p.id)).toEqual(['P-3001-S01', 'P-3001-S02', 'NPC'])
    expect(doc.status).toEqual({ made: 2, ran: 1, total: 2 })
    expect(doc.summary.samples).toBe(2)
    expect(doc.notes).toBe('lot 42')
  })
})
```

`src/lib/__tests__/pcr-bench-sheet.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildPcrBenchSheetHtml, buildPcrPlateMapCsv, buildPcrWellListCsv } from '@/lib/pcr-bench-sheet'
import { assess, layoutPlates, summarize, type PcrSample } from '@/lib/pcr-plate'
import type { PcrRunDoc } from '@/lib/pcr-worksheet'

const sample = (n: number, order = '9001', identity = 'Examplerelin'): PcrSample => ({
  itemId: n, id: `P-${String(n).padStart(4, '0')}`, order, identity, received: '2026-09-21',
  priority: 'normal', assessment: assess('2026-09-24', '2026-09-22', 'normal'), frozen: null,
})

function doc(samples: PcrSample[], notes = ''): PcrRunDoc {
  const layout = layoutPlates(samples)
  return {
    title: 'PCR 09/22/2026',
    meta: { runId: 'WS-24', runName: 'PCR 09/22/2026', date: '2026-09-22', analyst: 'Guian', curve: 'Quantitative', plateType: '8-Well Strip', instrument: 'QuantStudio 6 Flex', overage: 1.4 },
    layout, summary: summarize(layout), printedAt: 'Sep 22, 2026, 10:04 AM',
    status: { made: 0, ran: 0, total: samples.length }, notes, sortByOrder: true,
  }
}

describe('buildPcrBenchSheetHtml', () => {
  it('prints one landscape page per plate with the strip, the map and the calculations', () => {
    const html = buildPcrBenchSheetHtml(doc(Array.from({ length: 48 }, (_, i) => sample(i + 1)), 'lot 42'))
    expect(html.match(/<section class="page">/g)?.length).toBe(2)
    expect(html).toContain('Plate 1 of 2')
    expect(html).toContain('Plate 2 of 2')
    expect(html).toContain('size:letter landscape')
    // The NPC sits in H6 and H12 on the full plate; the notes print once, on the last page.
    expect(html).toContain('>NPC<')
    expect(html.match(/lot 42/g)?.length).toBe(1)
    expect(html.lastIndexOf('lot 42')).toBeGreaterThan(html.lastIndexOf('Plate 2 of 2'))
    // The workbook's 48-well figures ride on plate 1 (48 wells: 47 samples + NPC).
    expect(html).toContain('>53.9<')
  })

  it('escapes every value and marks the preview as paper', () => {
    const html = buildPcrBenchSheetHtml(doc([sample(1, '<b>', '<script>alert(1)</script>')]), { preview: true })
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('background:#E7ECEC')
  })
})

describe('CSVs', () => {
  it('lead the plate map with the run header and write the well list with CRLF', () => {
    const d = doc([sample(1)])
    expect(buildPcrPlateMapCsv(d).startsWith('Run ID,WS-24\r\nRun name,PCR 09/22/2026\r\n')).toBe(true)
    expect(buildPcrWellListCsv(d).split('\r\n')[0]).toBe('Plate,Well,Sample Name,Order,Identity,Received,Due,Priority,Assay,Target,Task')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/pcr-worksheet.test.ts src/lib/__tests__/pcr-bench-sheet.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Write `src/lib/pcr-worksheet.ts`**

```ts
/**
 * Glue between worksheet items and the PCR bench: which items are PCR work,
 * the run's settings, the samples the plate builder lays out, and the run
 * document the screen, the printed sheet and the exports all build from.
 * Due dates arrive from the SLA engine (`due_at` on /sla/status) keyed by
 * item id, as on the endo sheet.
 * Spec: docs/superpowers/specs/2026-09-22-pcr-worksheet-design.md
 */
import type { WorksheetListItem } from '@/lib/api'
import { labDate, type LabCalendar } from '@/lib/endo-prep'
import {
  endoIdentityFor,
  shortOrder,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet'
import {
  assess,
  DEFAULT_OVERAGE,
  layoutPlates,
  summarize,
  type PcrLayout,
  type PcrRunMeta,
  type PcrSample,
  type PcrSummary,
} from '@/lib/pcr-plate'
import { benchKindForItem } from '@/lib/worksheet-kind'

export type { WorksheetItemRow }

export function isPcrWorksheetItem(
  item: Pick<WorksheetItemRow, 'assignment_role' | 'analyses'>
): boolean {
  return benchKindForItem(item) === 'pcr'
}

/** The well shows the base id: a vial suffix carries no meaning at the bench
 *  (Dennis, 2026-09-16). The full id stays in the list and every export. */
export function plateLabel(id: string): string {
  return id.replace(/-S\d+$/i, '')
}

export interface PcrConfig {
  overage: number
  curve: string
  plateType: string
  sortByOrder: boolean
}

export const DEFAULT_PCR_CONFIG: PcrConfig = {
  overage: DEFAULT_OVERAGE,
  curve: '',
  plateType: '',
  sortByOrder: true,
}

/** The run's settings from worksheets.bench_config (free-form JSON shared by
 *  every bench kind); anything missing or malformed falls back to the default. */
export function pcrConfigOf(
  ws: Pick<WorksheetListItem, 'bench_config'>
): PcrConfig {
  const c = (ws.bench_config ?? {}) as Record<string, unknown>
  const overage = Number(c.overage)
  return {
    overage:
      Number.isFinite(overage) && overage > 0 ? overage : DEFAULT_OVERAGE,
    curve: typeof c.curve === 'string' ? c.curve : '',
    plateType: typeof c.plate_type === 'string' ? c.plate_type : '',
    sortByOrder: c.sort_by_order !== false,
  }
}

export function pcrConfigToWire(c: PcrConfig): Record<string, unknown> {
  return {
    overage: c.overage,
    curve: c.curve,
    plate_type: c.plateType,
    sort_by_order: c.sortByOrder,
  }
}

/** The date a run is judged against for overdue / due today: today in lab
 *  time while the worksheet is open, its completion day once completed. */
export function pcrRunDate(
  ws: Pick<WorksheetListItem, 'status' | 'completed_at'>,
  cal: LabCalendar | null
): string | null {
  if (!cal) return null
  return ws.status === 'completed' && ws.completed_at
    ? labDate(ws.completed_at, cal)
    : labDate(new Date().toISOString(), cal)
}

/** PCR items in worksheet order as plate-builder samples. */
export function pcrSamplesFor(
  items: WorksheetItemRow[],
  dueAtByItemId: Map<number, string | null>,
  cal: LabCalendar | null,
  runDate: string | null
): PcrSample[] {
  return items.filter(isPcrWorksheetItem).map(item => {
    const due = cal ? labDate(dueAtByItemId.get(item.id), cal) : null
    return {
      itemId: item.id,
      id: item.sample_id,
      order: shortOrder(item.client_order_number),
      identity: endoIdentityFor(item),
      received: cal ? labDate(item.date_received, cal) : null,
      priority: item.priority,
      assessment: assess(due, runDate, item.priority),
      frozen:
        item.plate_no != null && item.well_pos != null
          ? { plate: item.plate_no, pos: item.well_pos }
          : null,
    }
  })
}

/** The instrument the Ran tick stamped on the run's rows ('' until then). */
export function stampedInstrument(items: WorksheetItemRow[]): string {
  const names = new Set(
    items
      .map(i => i.stamped_instrument_name)
      .filter((n): n is string => !!n && n !== 'mixed')
  )
  return [...names].join(', ')
}

export interface PcrRunDoc {
  title: string
  meta: PcrRunMeta
  layout: PcrLayout
  summary: PcrSummary
  printedAt: string
  /** Run status: rows Made / Ran out of the PCR rows. */
  status: { made: number; ran: number; total: number }
  notes: string
  sortByOrder: boolean
}

export interface PcrRunOptions {
  analystName: string
  calendar: LabCalendar | null
  printedAt: string
  /** SLA `due_at` per item id (null when the item has no received date). */
  dueAtByItemId: Map<number, string | null>
  notes: string
}

/** The run document: the worksheet's PCR items laid out on plates with the
 *  run's settings. Without a calendar the dates are blank rather than wrong. */
export function buildPcrRunDoc(
  ws: WorksheetListItem,
  opts: PcrRunOptions
): PcrRunDoc {
  const cal = opts.calendar
  const cfg = pcrConfigOf(ws)
  const items = ws.items.filter(isPcrWorksheetItem)
  const samples = pcrSamplesFor(
    items,
    opts.dueAtByItemId,
    cal,
    pcrRunDate(ws, cal)
  )
  const layout = layoutPlates(samples, { sortByOrder: cfg.sortByOrder })
  return {
    title: ws.title,
    meta: {
      runId: `WS-${ws.id}`,
      runName: ws.title,
      date: (cal ? labDate(ws.created_at, cal) : null) ?? '',
      analyst: opts.analystName,
      curve: cfg.curve,
      plateType: cfg.plateType,
      instrument: stampedInstrument(items),
      overage: cfg.overage,
    },
    layout,
    summary: summarize(layout),
    printedAt: opts.printedAt,
    status: {
      made: items.filter(i => i.made_at).length,
      ran: items.filter(i => i.ran_at).length,
      total: items.length,
    },
    notes: opts.notes,
    sortByOrder: cfg.sortByOrder,
  }
}
```

- [ ] **Step 4: Write `src/lib/pcr-bench-sheet.ts`**

```ts
/**
 * The qPCR bench sheet: one landscape Letter page per plate, as Dennis's
 * builder prints it. A run strip across the top (title, plate number, the
 * run's fields and the two status boxes), the plate map on the left, that
 * plate's calculations in a 358 px column on the right, the internal notes
 * under the last plate's map. Widths are load-bearing on paper: 12 cells of
 * ~48 px cap the well id at ~0.70 rem; the calculations column holds two card
 * tracks of ~165 px min-content each. Nothing printed is below 7.7 pt.
 *
 * Pure string building; every value goes through escapeHtml. Printed through
 * printHtmlDocument (an isolated iframe) so the app's label print CSS never
 * applies. Spec: docs/superpowers/specs/2026-09-22-pcr-worksheet-design.md
 */
import { escapeHtml } from '@/lib/endo-bench-sheet'
import {
  calculatePrep,
  fmt2,
  metaHeaderRows,
  plateGrid,
  plateMapRows,
  PROTOCOL,
  toCsv,
  wellListRows,
  type MixRow,
  type PcrPlate,
} from '@/lib/pcr-plate'
import { plateLabel, type PcrRunDoc } from '@/lib/pcr-worksheet'

const SHEET_CSS = [
  '@page{size:letter landscape;margin:8mm}',
  '*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
  ":root{--mono:Consolas,'Cascadia Mono',ui-monospace,Menlo,monospace}",
  "body{margin:0;background:#fff;color:#000;font:13px/1.45 Aptos,Calibri,'Segoe UI',system-ui,sans-serif}",
  '.page{page-break-after:always;break-after:page}',
  '.page:last-of-type{page-break-after:auto;break-after:auto}',
  '.strip{display:grid;grid-template-columns:auto 1fr;grid-template-areas:"title status" "meta meta";align-items:baseline;column-gap:1rem;margin:0 0 .3rem;padding:.16rem .4rem .2rem;background:#e7e6e6;border:1px solid #000}',
  '.strip-title{grid-area:title;font-size:.84rem;font-weight:700;display:flex;gap:.6rem;align-items:baseline}',
  '.strip-name{font-weight:600;color:#595959}',
  '.strip-plate{background:#000;color:#fff;padding:0 .3rem;font-size:.72rem}',
  '.strip-status{grid-area:status;justify-self:end;display:flex;gap:0 .9rem;font-size:.68rem}',
  '.box{display:inline-flex;align-items:center;gap:.25rem}',
  '.box i{display:inline-block;width:.8em;height:.8em;border:1px solid #000;background:#fff;font-style:normal;font-size:.7em;line-height:.8em;text-align:center}',
  '.strip-meta{grid-area:meta;display:flex;flex-wrap:wrap;gap:0 .7rem;font-size:.68rem;line-height:1.4}',
  '.pair b{font-weight:700}.pair b::after{content:" "}',
  '.pair.overdue span,.pair.flagged span{color:#c00000;font-weight:700}.pair.today span{color:#bf6a00;font-weight:700}',
  '.body{display:grid;grid-template-columns:minmax(0,1fr) 358px;gap:.45rem;align-items:start}',
  '.panel{border:1px solid #000}',
  'h2{margin:0;background:#ed7d31;color:#fff;font-size:.8rem;font-weight:700;text-align:center;text-transform:uppercase;letter-spacing:.08em;padding:.2rem;border-bottom:1px solid #000}',
  '.pb{padding:.4rem .45rem .45rem}',
  '.legend{display:flex;flex-wrap:wrap;gap:.15rem .7rem;font-size:.64rem;color:#595959;margin-bottom:.3rem}',
  '.legend span{display:flex;align-items:center;gap:.35rem}',
  '.sw{width:1.4rem;height:.7rem;display:inline-block;border:1px solid #808080}',
  'table.plate{border-collapse:collapse;width:100%;table-layout:fixed;font-family:var(--mono)}',
  'table.plate th{font-size:.68rem;font-weight:700;background:#ededed;border:1px solid #808080;padding:.1rem;text-align:center;font-family:Aptos,Calibri,sans-serif}',
  'table.plate th.rh{width:1.15rem}',
  'table.plate td{height:3.45rem;border:1px solid #808080;text-align:center;font-size:.7rem;padding:.1rem .03rem;overflow:hidden;background:#fff;position:relative}',
  'td .wid{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.4}',
  'td .wo,td .wd{display:block;font-size:.68rem;color:#595959;line-height:1.35}',
  'td .wd.overdue{color:#c00000;font-weight:700}td .wd.today{color:#bf6a00;font-weight:700}',
  'td.bac{background:#deeaf6}td.fun{background:#fff2cc}td.bac.alt{background:#bdd7ee}td.fun.alt{background:#ffe699}',
  'td.ctrl{background:#d9d9d9;font-weight:700}',
  "td.prio::after{content:'';position:absolute;top:0;right:0;border-style:solid;border-width:0 .6rem .6rem 0;border-color:transparent #c00000 transparent transparent}",
  'td.prio.overdue .wid{color:#c00000;font-weight:700}',
  'td.ob-t{border-top:2px solid #44546a}td.ob-b{border-bottom:2px solid #44546a}td.ob-l{border-left:2px solid #44546a}td.ob-r{border-right:2px solid #44546a}',
  'td.bs,td.bs.ob-l,th.bs{border-left:3px solid #000}',
  '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.3rem}',
  '.card{border:1px solid #000}',
  '.card h3{margin:0;background:#ededed;border-bottom:1px solid #000;font-size:.7rem;font-weight:700;padding:.1rem .3rem;display:flex;justify-content:space-between}',
  '.card .u{font-weight:400;color:#595959;font-size:.62rem}',
  'table.kv,table.mix{width:100%;border-collapse:collapse;font-size:.78rem}',
  'table.kv th,table.mix tbody th{text-align:left;font-weight:400;padding:.05rem .25rem;border:1px solid #808080;line-height:1.2}',
  'table.kv td,table.mix td{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;padding:.05rem .25rem;border:1px solid #808080;line-height:1.2}',
  'table.mix thead th{background:#ededed;font-size:.64rem;font-weight:700;text-transform:uppercase;padding:.05rem .25rem;border:1px solid #808080;text-align:right}',
  'table.mix thead th:first-child{text-align:left}',
  'table.mix td.s{font-weight:700;background:#f2e8e1}',
  'tr.total th,tr.total td{font-weight:700;border-top:2px solid #000}',
  'table.kv tr.total td{background:#f2e8e1}',
  '.card.reag{grid-column:1/-1}.card.reag table.kv{display:grid;grid-template-columns:1fr auto 1fr auto}.card.reag table.kv tr{display:contents}',
  '.notes{margin-top:.3rem;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:#595959}',
  '.notes div{font-weight:400;text-transform:none;letter-spacing:0;font-size:.7rem;color:#000;border:1px solid #808080;min-height:2rem;padding:.12rem .3rem;white-space:pre-wrap;margin-top:.2rem}',
  '.foot{margin-top:.25rem;font-size:.62rem;color:#595959;display:flex;justify-content:space-between}',
].join('')

// Preview: the very document Print hands over, shown as paper (landscape
// Letter, the @page margins as padding).
const PREVIEW_CSS =
  'body{background:#E7ECEC;padding:16px 0}' +
  '.page{width:1056px;min-height:816px;padding:30px;background:#fff;' +
  'margin:0 auto 16px;box-shadow:0 1px 8px rgba(0,0,0,.28);' +
  'page-break-after:auto;break-after:auto}'

/** "09/22/2026" from YYYY-MM-DD, as the workbook prints dates. */
function usDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${m}/${d}/${y}` : iso
}

/** "9/22" for a well. */
function shortDue(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return m && d ? `${m}/${d}` : iso
}

function stripHtml(doc: PcrRunDoc, pl: PcrPlate): string {
  const { layout: L, summary: S, meta: m } = doc
  const pair = (k: string, v: string, cls = '') =>
    v
      ? `<span class="pair ${cls}"><b>${escapeHtml(k)}</b><span>${escapeHtml(v)}</span></span>`
      : ''
  const box = (label: string, on: boolean) =>
    `<span class="box"><i>${on ? '&#10003;' : ''}</i>${label}</span>`
  const all = doc.status.total > 0
  return (
    '<div class="strip"><div class="strip-title"><strong>qPCR Experimental Setup</strong>' +
    (m.runName ? `<span class="strip-name">${escapeHtml(m.runName)}</span>` : '') +
    (L.plateCount > 1
      ? `<span class="strip-plate">Plate ${pl.plate} of ${L.plateCount}</span>`
      : '') +
    '</div><div class="strip-status">' +
    box('Plate Made', all && doc.status.made === doc.status.total) +
    box('Ran on QuantStudio', all && doc.status.ran === doc.status.total) +
    '</div><div class="strip-meta">' +
    pair('Run', m.runId) +
    pair('Analyst', m.analyst) +
    pair('Date', m.date ? usDate(m.date) : '') +
    pair('Curve', m.curve) +
    pair('Plate', m.plateType) +
    pair('QuantStudio', m.instrument) +
    pair('Wells', String(pl.n)) +
    pair('Run samples', String(S.samples)) +
    pair(
      'Earliest due',
      S.earliestDue ? usDate(S.earliestDue) : '',
      S.overdue ? 'overdue' : S.today ? 'today' : ''
    ) +
    pair('Priority', S.prioText, S.flagged ? 'flagged' : '') +
    pair('Overage', `${m.overage}x`) +
    pair('Printed', doc.printedAt) +
    '</div></div>'
  )
}

function plateTableHtml(pl: PcrPlate, outlineGroups: boolean): string {
  const map = plateGrid(pl)
  const groupAt = (ri: number, c: number): number | null =>
    ri < 0 || ri > 7 || c < 1 || c > PROTOCOL.cols
      ? null
      : (map.get(`${PROTOCOL.rows[ri]}${c}`)?.placement.group ?? null)
  let html = '<table class="plate"><thead><tr><th class="rh"></th>'
  for (let c = 1; c <= PROTOCOL.cols; c++)
    html += `<th${c === 7 ? ' class="bs"' : ''}>${c}</th>`
  html += '</tr></thead><tbody>'
  PROTOCOL.rows.forEach((r, ri) => {
    html += `<tr><th class="rh">${r}</th>`
    for (let c = 1; c <= PROTOCOL.cols; c++) {
      const cell = map.get(`${r}${c}`)
      const cls: string[] = c === 7 ? ['bs'] : []
      if (!cell) {
        html += `<td class="${cls.join(' ')}"></td>`
        continue
      }
      const p = cell.placement
      cls.push(p.isControl ? 'ctrl' : cell.assay)
      if (outlineGroups) {
        const g = p.group
        if (g % 2 === 1) cls.push('alt')
        if (groupAt(ri - 1, c) !== g) cls.push('ob-t')
        if (groupAt(ri + 1, c) !== g) cls.push('ob-b')
        if (c === 1 || c === 7 || groupAt(ri, c - 1) !== g) cls.push('ob-l')
        if (c === 6 || c === 12 || groupAt(ri, c + 1) !== g) cls.push('ob-r')
      }
      const a = p.assessment
      if (a?.flagged) cls.push('prio')
      if (a?.urgency === 'overdue') cls.push('overdue')
      html +=
        `<td class="${cls.join(' ')}"><span class="wid">${escapeHtml(plateLabel(p.id))}</span>` +
        (p.order ? `<span class="wo">${escapeHtml(p.order)}</span>` : '') +
        (a?.due
          ? `<span class="wd ${a.urgency}">${escapeHtml(shortDue(a.due))}</span>`
          : '') +
        '</td>'
    }
    html += '</tr>'
  })
  return html + '</tbody></table>'
}

const LEGEND =
  '<div class="legend">' +
  '<span><i class="sw" style="background:#deeaf6;border-color:#5b9bd5"></i>Bacterial assay (16S), cols 1 to 6</span>' +
  '<span><i class="sw" style="background:#fff2cc;border-color:#bf9000"></i>Fungal assay (18S), cols 7 to 12</span>' +
  '<span><i class="sw" style="background:#d9d9d9"></i>Control</span>' +
  '<span><i class="sw" style="background:#deeaf6;border:2px solid #44546a"></i><i class="sw" style="background:#bdd7ee;border:2px solid #44546a"></i>Each boxed block is one order</span>' +
  '<span>Red corner: priority, overdue or due today</span>' +
  '</div>'

function kvHtml(rows: [string, string][], total?: [string, string]): string {
  const tr = ([k, v]: [string, string], cls = '') =>
    `<tr${cls ? ` class="${cls}"` : ''}><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`
  return (
    '<table class="kv">' +
    rows.map(r => tr(r)).join('') +
    (total ? tr(total, 'total') : '') +
    '</table>'
  )
}

function mixHtml(rows: MixRow[], overage: number): string {
  const body = rows
    .map(
      r =>
        `<tr><th>${escapeHtml(r.name)}</th><td>${fmt2(r.base)}</td><td class="s">${fmt2(r.pipette)}</td></tr>`
    )
    .join('')
  const total = `<tr class="total"><th>Total</th><td>${fmt2(rows.reduce((a, r) => a + r.base, 0))}</td><td class="s">${fmt2(rows.reduce((a, r) => a + r.pipette, 0))}</td></tr>`
  return `<table class="mix"><thead><tr><th>Component</th><th>Calc</th><th>x ${overage}</th></tr></thead><tbody>${body}${total}</tbody></table>`
}

function card(title: string, unit: string, body: string, cls = ''): string {
  return `<div class="card${cls ? ` ${cls}` : ''}"><h3>${title}${unit ? `<span class="u">${unit}</span>` : ''}</h3>${body}</div>`
}

function calcCardsHtml(pl: PcrPlate, overage: number): string {
  const c = calculatePrep(pl.n, overage)
  return (
    '<div class="grid">' +
    card(
      'Well Counts',
      '',
      kvHtml([
        ['Wells on plate (N)', String(pl.n)],
        ['Master mix wells', String(c.wells.mm)],
        ['BAC wells', String(c.wells.bac)],
        ['FUN wells', String(c.wells.fun)],
        ['IPC wells', String(c.wells.ipc)],
      ])
    ) +
    card(
      'Volume per Well',
      '&micro;L',
      kvHtml(
        [
          ['Master mix', fmt2(c.perWell.mm)],
          ['Assay mix', fmt2(c.perWell.assayMix)],
          ['IPC mix', fmt2(c.perWell.ipcMix)],
          ['Template', fmt2(c.perWell.template)],
        ],
        ['Total per well', fmt2(c.perWell.total)]
      )
    ) +
    card('BAC Mix: 16S', '&micro;L', mixHtml(c.bac, overage)) +
    card('FUN Mix: 18S', '&micro;L', mixHtml(c.fun, overage)) +
    card(
      'Bulk Volumes Needed',
      '&micro;L',
      kvHtml([
        ['Master mix', fmt2(c.bulk.mm)],
        ['BAC mix', fmt2(c.bulk.bac)],
        ['FUN mix', fmt2(c.bulk.fun)],
        ['IPC mix', fmt2(c.bulk.ipc)],
      ])
    ) +
    card('IPC Mix', '&micro;L', mixHtml(c.ipc, overage)) +
    card('Reagent Reference', '', kvHtml(PROTOCOL.reagents), 'reag') +
    '</div>'
  )
}

export function buildPcrBenchSheetHtml(
  doc: PcrRunDoc,
  opts: { preview?: boolean } = {}
): string {
  const L = doc.layout
  const title = escapeHtml(doc.title)
  const multi = L.plateCount > 1
  let out =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${title} qPCR plate</title><style>${SHEET_CSS}${opts.preview ? PREVIEW_CSS : ''}</style></head><body>`
  L.plates.forEach((pl, i) => {
    const last = i === L.plates.length - 1
    const of = multi ? `: Plate ${pl.plate} of ${L.plateCount}` : ''
    out +=
      '<section class="page">' +
      stripHtml(doc, pl) +
      '<div class="body">' +
      `<div class="panel"><h2>Plate Map${of}</h2><div class="pb">${LEGEND}${plateTableHtml(pl, doc.sortByOrder)}` +
      (last && doc.notes
        ? `<div class="notes">Internal Notes<div>${escapeHtml(doc.notes)}</div></div>`
        : '') +
      '</div></div>' +
      `<div class="panel"><h2>Calculations${of}</h2><div class="pb">${calcCardsHtml(pl, doc.meta.overage)}</div></div>` +
      '</div>' +
      `<div class="foot"><span>${title} &middot; ${escapeHtml(doc.meta.runId)}${doc.meta.analyst ? ` &middot; ${escapeHtml(doc.meta.analyst)}` : ''}</span>` +
      `<span>Page ${i + 1} of ${L.plates.length}</span></div>` +
      '</section>'
  })
  return out + '</body></html>'
}

/** The run header, then two 8 x 12 grids per plate (ids, identities). */
export function buildPcrPlateMapCsv(doc: PcrRunDoc): string {
  return toCsv([...metaHeaderRows(doc.meta, doc.layout), ...plateMapRows(doc.layout)])
}

/** One row per occupied well in both blocks. */
export function buildPcrWellListCsv(doc: PcrRunDoc): string {
  return toCsv(wellListRows(doc.layout))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/pcr-worksheet.test.ts src/lib/__tests__/pcr-bench-sheet.test.ts`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(pcr): run document, settings glue and the printed plate sheet" -- src/lib/pcr-worksheet.ts src/lib/pcr-bench-sheet.ts src/lib/__tests__/pcr-worksheet.test.ts src/lib/__tests__/pcr-bench-sheet.test.ts
```

---

### Task 7: Run log by kind, the calculation cards and the plate map

**Files:**
- Rename: `src/components/hplc/EndoRunLog.tsx` -> `src/components/hplc/BenchRunLog.tsx` (`git mv`)
- Modify: `src/components/hplc/WorksheetDrawer.tsx:38,307-316`
- Create: `src/components/hplc/PcrCalculations.tsx`
- Create: `src/components/hplc/PcrPlateMap.tsx`

**Interfaces:**
- Produces: `BenchRunLog({ kind, label, tickLabels, activeId, users, onSelect })`; `PcrCalculations({ wells, overage })`; `PcrPlateMap({ plate, plateCount, outlineGroups, frozenCount, isCompleted, onUnfreeze })`.

- [ ] **Step 1: Generalise the run log**

```bash
git mv src/components/hplc/EndoRunLog.tsx src/components/hplc/BenchRunLog.tsx
```

Replace the file's contents:

```tsx
import { useQuery } from '@tanstack/react-query'
import { getWorksheetBenchLog, type WorksheetUser } from '@/lib/api'
import { shortName } from '@/lib/user-display'
import type { BenchKind } from '@/lib/worksheet-kind'

/**
 * Dennis's run log, as one bench's worksheet history: the newest worksheets
 * of that kind (open and completed), one button each, with the analyst, the
 * sample count and a two-bar meter that fills when every row carries the
 * bench's two ticks (Made / MCS on the endo bench, Plate made / Ran on the
 * PCR bench). Lean summaries from /worksheets/bench-log; the full worksheet
 * loads only when one is picked.
 */
export function BenchRunLog({
  kind,
  label,
  tickLabels,
  activeId,
  users,
  onSelect,
}: {
  kind: BenchKind
  /** The bench's name over the rail, e.g. Endotoxin. */
  label: string
  /** The two tick columns' names for the meter tooltip, e.g. Made / MCS. */
  tickLabels: [string, string]
  activeId: number | null
  users: WorksheetUser[]
  onSelect: (worksheetId: number) => void
}) {
  // Under the 'worksheets-list' prefix on purpose: every worksheet mutation
  // already invalidates that prefix, so ticks and completions refresh the log.
  const { data: runs = [], isLoading } = useQuery({
    queryKey: ['worksheets-list', 'bench-log', kind],
    queryFn: () => getWorksheetBenchLog(kind),
    staleTime: 30_000,
  })

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r bg-card">
      <div className="flex flex-col gap-0.5 border-b px-4 pb-3 pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-700 dark:text-teal-300">
          {label}
        </span>
        <h2 className="text-lg font-semibold leading-tight">Run log</h2>
        <span className="text-xs text-muted-foreground">
          {isLoading
            ? 'Loading…'
            : `${runs.length} ${runs.length === 1 ? 'worksheet' : 'worksheets'}`}
        </span>
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {runs.map(run => {
          const analyst = users.find(u => u.id === run.assigned_analyst)
          const full = (n: number) => run.item_count > 0 && n === run.item_count
          return (
            <li key={run.id}>
              <button
                type="button"
                aria-current={run.id === activeId}
                onClick={() => onSelect(run.id)}
                className={`grid w-full grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-[5px] border px-2.5 py-2 text-left ${
                  run.id === activeId
                    ? 'border-teal-500/30 bg-teal-500/10'
                    : 'border-transparent hover:bg-muted/60'
                }`}
              >
                <span
                  className={`truncate text-[13px] font-medium ${run.status === 'completed' ? 'text-muted-foreground' : ''}`}
                  title={run.title}
                >
                  {run.title}
                </span>
                <span
                  className="row-span-2 flex gap-0.5"
                  title={`${tickLabels[0]} ${run.made_count}/${run.item_count} · ${tickLabels[1]} ${run.ran_count}/${run.item_count}`}
                >
                  {[run.made_count, run.ran_count].map((n, i) => (
                    <i
                      key={i}
                      className={`block h-4 w-1 rounded-[1px] ${full(n) ? 'bg-emerald-500' : 'bg-border'}`}
                    />
                  ))}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {analyst ? shortName(analyst) : 'unassigned'} ·{' '}
                  {run.item_count} {run.item_count === 1 ? 'sample' : 'samples'}
                  {run.status === 'completed' ? ' · done' : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

export default BenchRunLog
```

In `WorksheetDrawer.tsx`: `import { BenchRunLog } from './BenchRunLog'` replaces the EndoRunLog import, and the endo branch renders

```tsx
              <BenchRunLog
                kind="endo"
                label="Endotoxin"
                tickLabels={['Made', 'MCS']}
                activeId={activeWorksheet.id}
                users={users}
                onSelect={id => {
                  // The log spans every analyst; drop the filter so an open
                  // worksheet of someone else's is not bounced off.
                  setAnalystFilter('all')
                  setActiveId(id)
                }}
              />
```

Run: `npm run typecheck && npx vitest run src/components/hplc/__tests__/WorksheetDrawer.test.tsx`
Expected: clean; the drawer test passes as before.

- [ ] **Step 2: `src/components/hplc/PcrCalculations.tsx`**

```tsx
import type { ReactNode } from 'react'
import { calculatePrep, fmt2, PROTOCOL, type MixRow } from '@/lib/pcr-plate'

const TH = 'px-2.5 py-1 text-left text-[12px] font-normal text-foreground/80'
const TD = 'px-2.5 py-1 text-right font-mono text-[12px] tabular-nums'

/**
 * The seven calculation cards for one plate, as on Dennis's screen: well
 * counts, the reaction, the two assay mixes, bulk volumes, the IPC mix and
 * the reagent reference. Every figure comes from calculatePrep; the pipetting
 * column (x overage) is the one the analyst draws against.
 */
export function PcrCalculations({
  wells,
  overage,
}: {
  /** Wells on the plate, NPC included. */
  wells: number
  overage: number
}) {
  const c = calculatePrep(wells, overage)
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
      <Card title="Well counts" note="MM and IPC = 2N + 4 · BAC and FUN = N + 2">
        <Kv
          rows={[
            ['Wells on plate (N)', String(wells)],
            ['Master mix wells', String(c.wells.mm)],
            ['BAC wells', String(c.wells.bac)],
            ['FUN wells', String(c.wells.fun)],
            ['IPC wells', String(c.wells.ipc)],
          ]}
        />
      </Card>
      <Card title="Volume per well" unit="µL">
        <Kv
          rows={[
            ['Master mix', fmt2(c.perWell.mm)],
            ['Assay mix', fmt2(c.perWell.assayMix)],
            ['IPC mix', fmt2(c.perWell.ipcMix)],
            ['Template', fmt2(c.perWell.template)],
          ]}
          total={['Total per well', fmt2(c.perWell.total)]}
        />
      </Card>
      <Card title="BAC mix: 16S" unit="µL">
        <Mix rows={c.bac} overage={overage} />
      </Card>
      <Card title="FUN mix: 18S" unit="µL">
        <Mix rows={c.fun} overage={overage} />
      </Card>
      <Card title="Bulk volumes needed" unit="µL" note="Bulk = volume per well × wells of that kind">
        <Kv
          rows={[
            ['Master mix', fmt2(c.bulk.mm)],
            ['BAC mix', fmt2(c.bulk.bac)],
            ['FUN mix', fmt2(c.bulk.fun)],
            ['IPC mix', fmt2(c.bulk.ipc)],
          ]}
        />
      </Card>
      <Card
        title="IPC mix"
        unit="µL"
        note="IPC runs at 0.6× rather than 1× to preserve reagent, previously validated as fit for purpose."
      >
        <Mix rows={c.ipc} overage={overage} />
      </Card>
      <Card title="Reagent reference">
        <Kv rows={PROTOCOL.reagents} />
      </Card>
    </div>
  )
}

function Card({
  title,
  unit,
  note,
  children,
}: {
  title: string
  unit?: string
  note?: string
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-[5px] border bg-card">
      <h4 className="flex items-baseline justify-between gap-2 border-b bg-muted/60 px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {title}
        {unit && <span className="font-mono text-[10px] font-normal normal-case tracking-normal">{unit}</span>}
      </h4>
      {children}
      {note && (
        <p className="border-t bg-muted/30 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">
          {note}
        </p>
      )}
    </section>
  )
}

function Kv({
  rows,
  total,
}: {
  rows: [string, string][]
  total?: [string, string]
}) {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b border-border/60 last:border-b-0">
            <th className={TH}>{k}</th>
            <td className={TD}>{v}</td>
          </tr>
        ))}
        {total && (
          <tr className="border-t-2 font-semibold">
            <th className={TH}>{total[0]}</th>
            <td className={`${TD} bg-teal-500/[0.06]`}>{total[1]}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function Mix({ rows, overage }: { rows: MixRow[]; overage: number }) {
  const HEAD =
    'px-2.5 py-1 text-right text-[9.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground'
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b bg-muted/40">
          <th className={`${HEAD} text-left`}>Component</th>
          <th className={HEAD}>Calculated</th>
          <th className={`${HEAD} bg-teal-500/10 text-teal-800 dark:text-teal-200`}>× {overage}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.name} className="border-b border-border/60">
            <th className={TH}>{r.name}</th>
            <td className={TD}>{fmt2(r.base)}</td>
            <td className={`${TD} bg-teal-500/[0.06] font-semibold`}>{fmt2(r.pipette)}</td>
          </tr>
        ))}
        <tr className="border-t-2 font-semibold">
          <th className={TH}>Total</th>
          <td className={TD}>{fmt2(rows.reduce((a, r) => a + r.base, 0))}</td>
          <td className={`${TD} bg-teal-500/[0.06]`}>{fmt2(rows.reduce((a, r) => a + r.pipette, 0))}</td>
        </tr>
      </tbody>
    </table>
  )
}

export default PcrCalculations
```

- [ ] **Step 3: `src/components/hplc/PcrPlateMap.tsx`**

```tsx
import { Lock, Unlock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { plateGrid, PROTOCOL, type PcrPlate } from '@/lib/pcr-plate'
import { plateLabel } from '@/lib/pcr-worksheet'
import { useUIStore } from '@/store/ui-store'

// The workbook's fills: Office accent5 / accent4 tints for the two assay
// blocks, gray for the control. Paper colours, so the ink stays dark in both
// themes; the plate is printed as often as it is read.
const FILL = {
  bac: 'bg-[#deeaf6]',
  bacAlt: 'bg-[#bdd7ee]',
  fun: 'bg-[#fff2cc]',
  funAlt: 'bg-[#ffe699]',
  ctrl: 'bg-[#d9d9d9] font-bold',
  empty: 'bg-white dark:bg-zinc-100',
}
const GROUP = '#44546a'
const TH =
  'border border-zinc-400 bg-zinc-100 px-0.5 py-0.5 text-center font-sans text-[11px] font-bold text-zinc-800'
const BLOCK = 'border-l-[3px] border-l-zinc-900'
const COLS = Array.from({ length: PROTOCOL.cols }, (_, i) => i + 1)

/**
 * One 96-well plate as Dennis draws it: the bacterial block in columns 1 to
 * 6, its fungal mirror in 7 to 12, each well labelled with the sample id, the
 * order number and the due date; each order outlined as one region with
 * alternating tints; a red corner on a priority well. Locked wells (printed
 * or exported) are announced in the header and can be released on purpose.
 */
export function PcrPlateMap({
  plate,
  plateCount,
  outlineGroups,
  frozenCount,
  isCompleted,
  onUnfreeze,
}: {
  plate: PcrPlate
  plateCount: number
  outlineGroups: boolean
  /** Locked wells across the run (the badge is per run, not per plate). */
  frozenCount: number
  isCompleted: boolean
  onUnfreeze: () => void
}) {
  const map = plateGrid(plate)
  const groupAt = (ri: number, c: number): number | null =>
    ri < 0 || ri > 7 || c < 1 || c > PROTOCOL.cols
      ? null
      : (map.get(`${PROTOCOL.rows[ri]}${c}`)?.placement.group ?? null)

  return (
    <section className="overflow-hidden rounded-[5px] border bg-card shadow-sm">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/60 px-3.5 py-2">
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
          Plate map{plateCount > 1 ? `: plate ${plate.plate} of ${plateCount}` : ''}
        </h3>
        <Legend />
        <span className="flex-1" />
        {frozenCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-[3px] border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
            title="Printed or exported: these wells never move. Late additions take the wells after them; the NPC stays last."
          >
            <Lock className="h-3 w-3" />
            {frozenCount} well{frozenCount === 1 ? '' : 's'} locked
          </span>
        )}
        {frozenCount > 0 && !isCompleted && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            title="Release every locked well and lay the plate out again. Only for a plate that was printed too early: a loaded plate would no longer match."
            onClick={onUnfreeze}
          >
            <Unlock className="h-3 w-3" />
            Unlock wells
          </Button>
        )}
      </header>
      <div className="overflow-x-auto p-3">
        <table className="w-full min-w-[760px] table-fixed border-collapse font-mono text-[11px] text-zinc-900">
          <thead>
            <tr>
              <th className={`${TH} w-7`} />
              {COLS.map(c => (
                <th key={c} className={`${TH} ${c === 7 ? BLOCK : ''}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PROTOCOL.rows.map((r, ri) => (
              <tr key={r}>
                <th className={`${TH} w-7`}>{r}</th>
                {COLS.map(c => {
                  const cell = map.get(`${r}${c}`)
                  const base = `relative h-[52px] overflow-hidden border border-zinc-400 px-0.5 py-0.5 text-center align-middle ${c === 7 ? BLOCK : ''}`
                  if (!cell) return <td key={c} className={`${base} ${FILL.empty}`} />
                  const p = cell.placement
                  const g = p.group
                  const fill = p.isControl
                    ? FILL.ctrl
                    : cell.assay === 'bac'
                      ? outlineGroups && g % 2 === 1
                        ? FILL.bacAlt
                        : FILL.bac
                      : outlineGroups && g % 2 === 1
                        ? FILL.funAlt
                        : FILL.fun
                  const edges = outlineGroups
                    ? {
                        borderTopColor: groupAt(ri - 1, c) !== g ? GROUP : undefined,
                        borderTopWidth: groupAt(ri - 1, c) !== g ? 2 : undefined,
                        borderBottomColor: groupAt(ri + 1, c) !== g ? GROUP : undefined,
                        borderBottomWidth: groupAt(ri + 1, c) !== g ? 2 : undefined,
                        borderLeftColor:
                          c !== 7 && (c === 1 || groupAt(ri, c - 1) !== g) ? GROUP : undefined,
                        borderLeftWidth:
                          c !== 7 && (c === 1 || groupAt(ri, c - 1) !== g) ? 2 : undefined,
                        borderRightColor:
                          c === 6 || c === 12 || groupAt(ri, c + 1) !== g ? GROUP : undefined,
                        borderRightWidth:
                          c === 6 || c === 12 || groupAt(ri, c + 1) !== g ? 2 : undefined,
                      }
                    : undefined
                  const a = p.assessment
                  const dueClass =
                    a?.urgency === 'overdue'
                      ? 'font-bold text-[#c00000]'
                      : a?.urgency === 'today'
                        ? 'font-bold text-[#bf6a00]'
                        : 'text-zinc-600'
                  const title = [
                    `${r}${c}`,
                    p.id,
                    p.identity,
                    p.order ? `Order ${p.order}` : '',
                    a?.due ? `Due ${a.due}` : '',
                    ...(a?.reasons ?? []),
                    cell.assay === 'bac' ? '16S' : '18S',
                    p.frozen ? 'Locked' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <td
                      key={c}
                      className={`${base} ${fill} ${p.sample ? 'cursor-pointer hover:brightness-95' : ''}`}
                      style={edges}
                      title={title}
                      onClick={
                        p.sample
                          ? () => useUIStore.getState().navigateToSample(p.id)
                          : undefined
                      }
                    >
                      {a?.flagged && (
                        <span
                          aria-hidden
                          className="absolute right-0 top-0 h-0 w-0 border-[0.4rem] border-transparent border-r-[#c00000] border-t-[#c00000]"
                        />
                      )}
                      <span
                        className={`block truncate leading-[1.4] ${a?.urgency === 'overdue' && a.flagged ? 'font-bold text-[#c00000]' : ''}`}
                      >
                        {plateLabel(p.id)}
                      </span>
                      {p.order && (
                        <span className="block text-[9.5px] leading-tight text-zinc-600">
                          {p.order}
                        </span>
                      )}
                      {a?.due && (
                        <span className={`block text-[9.5px] leading-tight ${dueClass}`}>
                          {a.due.slice(5).replace(/^0/, '').replace('-0', '/').replace('-', '/')}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Legend() {
  const sw = (cls: string, extra = '') => (
    <i className={`inline-block h-2.5 w-5 border border-zinc-400 ${cls} ${extra}`} />
  )
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground">
      <span className="flex items-center gap-1">{sw(FILL.bac)} 16S, cols 1 to 6</span>
      <span className="flex items-center gap-1">{sw(FILL.fun)} 18S, cols 7 to 12</span>
      <span className="flex items-center gap-1">{sw(FILL.ctrl)} Control</span>
      <span className="flex items-center gap-1">
        {sw(FILL.bac, 'border-2 border-[#44546a]')}
        {sw(FILL.bacAlt, 'border-2 border-[#44546a]')} one order per box
      </span>
      <span className="flex items-center gap-1">
        <i className="inline-block h-0 w-0 border-[5px] border-transparent border-r-[#c00000] border-t-[#c00000]" />
        priority, overdue or due today
      </span>
    </span>
  )
}

export default PcrPlateMap
```

- [ ] **Step 4: Typecheck, lint and commit**

Run: `npm run typecheck && npx eslint src/components/hplc/BenchRunLog.tsx src/components/hplc/PcrCalculations.tsx src/components/hplc/PcrPlateMap.tsx src/components/hplc/WorksheetDrawer.tsx`
Expected: clean.

```bash
git commit -m "feat(pcr): run log by bench kind, calculation cards and plate map" -- src/components/hplc/EndoRunLog.tsx src/components/hplc/BenchRunLog.tsx src/components/hplc/PcrCalculations.tsx src/components/hplc/PcrPlateMap.tsx src/components/hplc/WorksheetDrawer.tsx
```

---

### Task 8: Samples panel, exports and print, the PCR view, drawer wiring

**Files:**
- Modify: `src/components/hplc/EndoWorksheetTable.tsx` (export `FlagCell`; add exported `PriorityChip`)
- Create: `src/components/hplc/PcrSampleList.tsx`
- Create: `src/components/hplc/PcrWorksheetActions.tsx`
- Create: `src/components/hplc/PcrWorksheetView.tsx`
- Modify: `src/components/hplc/WorksheetDrawer.tsx` (kind resolution ~131-135, the bench branch ~304-377, `handleUpdateWorksheet` ~209)

**Interfaces:**
- Consumes: everything from Tasks 3 to 7; `useSlaForSubjects`, `worksheetItemSlaSubjects`, `useLabCalendar`, `SampleIdBadge`, `SlaAgeIndicator`, `ReassignButton`, `EntityFlagButton`, `useRegisterActiveFlagEntity`, `printHtmlDocument`, `downloadTextFile`, `recordWorksheetPrinted`.
- Produces: `PriorityChip({ priority })`, `PcrSampleList`, `PcrWorksheetActions`, `PcrWorksheetView`; the drawer renders the PCR view for an all-PCR worksheet.

- [ ] **Step 1: Share the flag cell and the priority chip**

In `EndoWorksheetTable.tsx`: `function FlagCell(` becomes `export function FlagCell(`. Replace the inline priority span in the endo row

```tsx
                  <td className={TD}>
                    <span
                      className={`inline-block rounded-[3px] border px-1.5 py-0.5 text-xs ${PRIORITY_CHIP[priority] ?? PRIORITY_CHIP.normal}`}
                    >
                      {PRIORITY_LABEL[priority] ?? priority}
                    </span>
                  </td>
```

with `<td className={TD}><PriorityChip priority={item.priority} /></td>`, drop the now-unused `const priority = ...` line, and add after the `PRIORITY_LABEL` map:

```tsx
/** The priority as a chip, in the same words as the inbox. */
export function PriorityChip({ priority }: { priority: string | null | undefined }) {
  const key = (priority ?? 'normal').toLowerCase()
  return (
    <span
      className={`inline-block rounded-[3px] border px-1.5 py-0.5 text-xs ${PRIORITY_CHIP[key] ?? PRIORITY_CHIP.normal}`}
    >
      {PRIORITY_LABEL[key] ?? key}
    </span>
  )
}
```

- [ ] **Step 2: `src/components/hplc/PcrSampleList.tsx`**

```tsx
import { X } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { SampleIdBadge } from '@/components/samples/SampleIdBadge'
import { SlaAgeIndicator } from '@/components/hplc/SlaAgeIndicator'
import { FlagCell, PriorityChip } from '@/components/hplc/EndoWorksheetTable'
import { ReassignButton } from '@/components/hplc/ReassignButton'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
import type { WorksheetListItem } from '@/lib/api'
import { labTime, type LabCalendar } from '@/lib/endo-prep'
import { shortLabDate, type WorksheetItemRow } from '@/lib/endo-worksheet'
import { orderGroups, wellsOf } from '@/lib/pcr-plate'
import type { PcrRunDoc } from '@/lib/pcr-worksheet'

const TH =
  'sticky top-0 z-[2] bg-muted/60 px-2 pb-[7px] pt-2 text-left align-bottom text-[9.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground whitespace-nowrap border-b'
const TD = 'border-b border-border/60 px-2 py-[5px] align-middle text-[13px]'
const MONO = 'font-mono text-[12.5px] tabular-nums'
const SUBTIME = 'block text-[10px] font-normal leading-tight text-muted-foreground'

/**
 * Dennis's Samples panel: the run list in well order (order chips above it),
 * one row per sample with its order, id, identity, received and due dates,
 * priority, the wells it sits in on the plate, a flag, and the worksheet
 * actions. The NPC closes the list as a control row. Rows of one order share
 * a tint with their block on the plate.
 */
export function PcrSampleList({
  doc,
  items,
  calendar,
  slaByKey,
  slaLoading,
  slaError,
  isCompleted,
  otherWorksheets,
  onRemove,
  onReassign,
}: {
  doc: PcrRunDoc
  items: WorksheetItemRow[]
  calendar: LabCalendar | null
  slaByKey: Map<string, SlaSubjectSnapshot>
  slaLoading: boolean
  slaError: boolean
  isCompleted: boolean
  otherWorksheets: WorksheetListItem[]
  onRemove: (itemId: number) => void
  onReassign: (itemId: number, targetWorksheetId: number) => void
}) {
  const L = doc.layout
  const byId = new Map(items.map(it => [it.id, it]))
  const groups = doc.sortByOrder
    ? orderGroups(L.plates).filter(g => g.order || g.isControl)
    : []

  return (
    <section className="overflow-hidden rounded-[5px] border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b bg-muted/60 px-3.5 py-2">
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
          Samples
        </h3>
        <span className="text-xs text-muted-foreground">
          {doc.summary.samples} sample{doc.summary.samples === 1 ? '' : 's'}
          {L.plateCount > 1 &&
            ` on ${L.plateCount} plates (${L.plates.map(pl => pl.sampleCount).join(' + ')}); the NPC sits on every plate`}
        </span>
      </header>
      {groups.length >= 2 && (
        <div className="flex flex-wrap gap-1 border-b px-3.5 py-2">
          {groups.map(g => {
            const span = g.from === g.to ? g.from : `${g.from}-${g.to}`
            return (
              <span
                key={`${g.plate}-${g.group}`}
                className={`inline-flex items-baseline gap-1 rounded-[3px] border border-[#44546a]/60 px-1.5 py-0.5 text-[11px] text-zinc-900 ${
                  g.isControl ? 'bg-[#d9d9d9]' : g.group % 2 === 1 ? 'bg-[#bdd7ee]' : 'bg-[#deeaf6]'
                }`}
                title={`${g.isControl ? 'Controls' : `Order ${g.order}`}${L.plateCount > 1 ? ` · plate ${g.plate}` : ''} · wells ${span}${g.flagged ? ` · ${g.flagged} priority` : ''}`}
              >
                {L.plateCount > 1 && (
                  <b className="bg-[#44546a] px-1 text-[9px] text-white">P{g.plate}</b>
                )}
                <b className="font-mono">{g.isControl ? 'Controls' : g.order}</b>
                <span className="font-mono">{span}</span>
                <span className="text-zinc-600">×{g.count}</span>
                {g.flagged > 0 && (
                  <span className="rounded-[2px] bg-[#c00000] px-1 text-[10px] font-bold text-white">
                    !{g.flagged > 1 ? g.flagged : ''}
                  </span>
                )}
              </span>
            )
          })}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={`${TH} w-[34px]`} />
              <th className={TH}>Order #</th>
              <th className={TH}>Sample ID</th>
              <th className={TH}>Sample identity</th>
              <th className={TH}>Received</th>
              <th className={`${TH} bg-teal-500/10 text-teal-800 dark:text-teal-200`}>
                Due
                <span className="block font-mono text-[10px] font-normal normal-case tracking-[0.04em] opacity-80">
                  SLA
                </span>
              </th>
              <th className={TH}>Priority</th>
              <th className={TH}>Wells</th>
              <th className={`${TH} text-center`}>Flag</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {L.list.map((row, i) => {
              const s = row.sample
              const item = s ? byId.get(s.itemId) : undefined
              const a = s?.assessment
              const tint = row.isControl
                ? 'bg-[#d9d9d9]/60 dark:bg-zinc-700/60 font-semibold'
                : doc.sortByOrder && row.group % 2 === 1
                  ? 'bg-[#deeaf6]/40 dark:bg-sky-900/20'
                  : ''
              const wells =
                row.isControl && L.plateCount > 1
                  ? 'every plate'
                  : row.placements[0]
                    ? wellsOf(row.placements[0], L.plateCount)
                    : '-'
              const dueTime =
                s && calendar
                  ? labTime(slaByKey.get(String(s.itemId))?.status.due_at, calendar)
                  : null
              const receivedTime =
                item && calendar ? labTime(item.date_received, calendar) : null
              return (
                <tr key={s ? s.itemId : `npc-${i}`} className={`group/item hover:bg-teal-500/[0.04] ${tint}`}>
                  <td
                    className={`${TD} relative pl-3 pr-1.5 text-right font-mono text-[11px] text-muted-foreground before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${a?.flagged ? 'before:bg-[#c00000]' : 'before:bg-transparent'}`}
                    title={a?.reasons.join('; ') || undefined}
                  >
                    {i + 1}
                  </td>
                  <td className={`${TD} ${MONO}`}>{s?.order || '-'}</td>
                  <td className={TD}>
                    {s && item ? (
                      <button
                        className="text-left transition-colors hover:text-primary hover:underline"
                        onClick={() => useUIStore.getState().navigateToSample(s.id)}
                      >
                        <SampleIdBadge
                          stacked
                          id={s.id}
                          variance={item.assignment_kind === 'variance'}
                        />
                      </button>
                    ) : (
                      <span className="font-mono text-[12.5px]">{row.placements[0]?.id ?? 'NPC'}</span>
                    )}
                  </td>
                  <td className={`${TD} max-w-[180px]`}>
                    <span className="block truncate" title={s?.identity ?? row.placements[0]?.identity}>
                      {s ? s.identity || '-' : row.placements[0]?.identity}
                    </span>
                  </td>
                  <td className={`${TD} ${MONO} whitespace-nowrap`}>
                    {s ? shortLabDate(s.received) : ''}
                    {receivedTime && <span className={SUBTIME}>{receivedTime}</span>}
                  </td>
                  <td className={`${TD} bg-teal-500/[0.06] font-medium whitespace-nowrap`}>
                    {s && (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`${MONO} ${a?.urgency === 'overdue' ? 'font-bold text-[#c00000]' : a?.urgency === 'today' ? 'font-bold text-[#bf6a00]' : ''}`}
                        >
                          {shortLabDate(a?.due ?? null)}
                          {dueTime && <span className={SUBTIME}>{dueTime}</span>}
                        </span>
                        <SlaAgeIndicator
                          snapshot={slaByKey.get(String(s.itemId)) ?? null}
                          isLoading={slaLoading}
                          isError={slaError}
                          compact
                        />
                      </span>
                    )}
                  </td>
                  <td className={TD}>{s && <PriorityChip priority={s.priority} />}</td>
                  <td
                    className={`${TD} ${MONO} whitespace-nowrap text-muted-foreground`}
                    title={row.placements.map(p => `Plate ${p.plate}: ${p.row}${p.col} / ${p.row}${p.col + 6}${p.frozen ? ' (locked)' : ''}`).join('\n')}
                  >
                    {wells}
                    {row.placements[0]?.frozen && (
                      <span className="ml-1 text-[10px] text-amber-600" title="Locked well">
                        locked
                      </span>
                    )}
                  </td>
                  <td className={`${TD} text-center`}>{item && <FlagCell item={item} />}</td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    {item && !isCompleted && (
                      <span className="inline-flex items-center gap-1">
                        <ReassignButton
                          item={item}
                          otherWorksheets={otherWorksheets}
                          onReassign={onReassign}
                        />
                        <button
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100 focus-visible:opacity-100"
                          aria-label={`Remove ${item.sample_id} from worksheet`}
                          title={
                            row.placements[0]?.frozen
                              ? 'Remove this sample (its locked well stays empty; it goes back to the inbox)'
                              : 'Remove this sample (it goes back to the inbox)'
                          }
                          onClick={() => onRemove(item.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                    {row.isControl && (
                      <span
                        className="rounded-[2px] border bg-muted px-1 text-[9.5px] font-bold uppercase tracking-[0.05em] text-muted-foreground"
                        title="The NPC is always on the plate, after the last sample. It is added for you and cannot be removed."
                      >
                        auto
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default PcrSampleList
```

- [ ] **Step 3: `src/components/hplc/PcrWorksheetActions.tsx`**

```tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, FileDown, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { recordWorksheetPrinted, type WorksheetWellFreeze } from '@/lib/api'
import {
  buildPcrBenchSheetHtml,
  buildPcrPlateMapCsv,
  buildPcrWellListCsv,
} from '@/lib/pcr-bench-sheet'
import { freezePayload, quantStudioFiles } from '@/lib/pcr-plate'
import type { PcrRunDoc } from '@/lib/pcr-worksheet'
import { downloadTextFile, printHtmlDocument } from '@/lib/print-document'

/**
 * Dennis's run actions: the QuantStudio sample file (one per plate), the
 * plate map and well list CSVs, Preview and Print. Print and the QuantStudio
 * export are what load the plate, so both freeze the wells first (ruling
 * 2026-09-22) and print is recorded like the endo sheet: the first print is
 * the run's start on the bench.
 */
export function PcrWorksheetActions({
  worksheetId,
  buildDoc,
  ready,
  isCompleted,
  onFreeze,
}: {
  worksheetId: number
  /** Builds the run document at click time, so it carries the print stamp. */
  buildDoc: () => PcrRunDoc
  /** False until the lab calendar has loaded (dates would print blank). */
  ready: boolean
  isCompleted: boolean
  /** Pins the wells; resolves once the server has them. */
  onFreeze: (wells: WorksheetWellFreeze[]) => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  // The browser never says whether the print dialog was confirmed, so the
  // click is what gets recorded. A failed record must not block the printout.
  const recordPrint = useMutation({
    mutationFn: () => recordWorksheetPrinted(worksheetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
    },
  })
  const waiting = ready ? undefined : 'Loading the lab calendar…'

  /** Freeze the wells this layout shows, then hand the doc on. A refused
   *  freeze (a well taken by a concurrent edit) stops the export. */
  async function loaded(doc: PcrRunDoc): Promise<boolean> {
    if (isCompleted) return true
    const wells = freezePayload(doc.layout)
    if (!wells.length) return true
    try {
      await onFreeze(wells)
      return true
    } catch {
      return false
    }
  }

  async function print() {
    const doc = buildDoc()
    if (!(await loaded(doc))) return
    printHtmlDocument(buildPcrBenchSheetHtml(doc))
    recordPrint.mutate()
  }

  async function quantStudio(plate?: number) {
    const doc = buildDoc()
    if (!(await loaded(doc))) return
    const files = quantStudioFiles(doc.layout, {
      runId: doc.meta.runId,
      date: doc.meta.date,
    })
    for (const f of files)
      if (plate === undefined || f.plate === plate)
        downloadTextFile(f.filename, f.text, 'text/plain;charset=utf-8')
  }

  const doc = buildDoc()
  const stem = doc.title.replace(/[^A-Za-z0-9._-]+/g, '_')
  const plates = doc.layout.plateCount

  return (
    <>
      {plates > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!ready} title={waiting ?? 'One file per plate for Plate Setup, Define Samples, Import'}>
              <FileDown className="h-3.5 w-3.5" />
              QuantStudio file
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {doc.layout.plates.map(pl => (
              <DropdownMenuItem key={pl.plate} onSelect={() => void quantStudio(pl.plate)}>
                Plate {pl.plate} of {plates} ({pl.n} wells)
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={!ready}
          title={waiting ?? 'Tab-delimited sample file for Plate Setup, Define Samples, Import'}
          onClick={() => void quantStudio()}
        >
          <FileDown className="h-3.5 w-3.5" />
          QuantStudio file
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        title={waiting ?? 'Two 8 x 12 grids per plate: ids, then identities'}
        onClick={() => downloadTextFile(`${stem}_plate-map.csv`, buildPcrPlateMapCsv(buildDoc()))}
      >
        <Download className="h-3.5 w-3.5" />
        Plate map CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        title={waiting ?? 'One row per occupied well in both blocks'}
        onClick={() => downloadTextFile(`${stem}_well-list.csv`, buildPcrWellListCsv(buildDoc()))}
      >
        <Download className="h-3.5 w-3.5" />
        Well list CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        title={waiting ?? 'See the pages as they will print'}
        onClick={() => setPreviewHtml(buildPcrBenchSheetHtml(buildDoc(), { preview: true }))}
      >
        <Eye className="h-3.5 w-3.5" />
        Preview
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        title={waiting ?? 'Print one page per plate; locks the wells'}
        onClick={() => void print()}
      >
        <Printer className="h-3.5 w-3.5" />
        Print
      </Button>

      <Dialog
        open={previewHtml !== null}
        onOpenChange={open => {
          if (!open) setPreviewHtml(null)
        }}
      >
        <DialogContent className="flex h-[92vh] w-[1160px] max-w-[96vw] flex-col gap-0 p-0 sm:max-w-[96vw]">
          <div className="flex items-center gap-3 border-b px-4 py-2.5 pr-12">
            <DialogTitle className="text-sm font-semibold">Print preview</DialogTitle>
            <DialogDescription className="font-mono text-[11.5px]">
              {doc.title} · landscape Letter, one page per plate
            </DialogDescription>
            <span className="flex-1" />
            <Button
              size="sm"
              className="bg-teal-600 text-white hover:bg-teal-600/90"
              onClick={() => {
                setPreviewHtml(null)
                void print()
              }}
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </Button>
          </div>
          {previewHtml !== null && (
            <iframe
              title="Plate sheet preview"
              sandbox=""
              srcDoc={previewHtml}
              className="min-h-0 w-full flex-1 border-0 bg-[#E7ECEC]"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export default PcrWorksheetActions
```

- [ ] **Step 4: `src/components/hplc/PcrWorksheetView.tsx`**

```tsx
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  WorksheetListItem,
  WorksheetUser,
  WorksheetWellFreeze,
} from '@/lib/api'
import { labDate } from '@/lib/endo-prep'
import { shortLabDate } from '@/lib/endo-worksheet'
import {
  buildPcrRunDoc,
  isPcrWorksheetItem,
  pcrConfigOf,
  pcrConfigToWire,
  type PcrConfig,
} from '@/lib/pcr-worksheet'
import { displayName, shortName } from '@/lib/user-display'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { useSlaForSubjects } from '@/services/sla-subjects'
import { EntityFlagButton } from '@/components/flags/EntityFlagButton'
import { useRegisterActiveFlagEntity } from '@/components/flags/use-active-flag-entity'
import { PcrCalculations } from './PcrCalculations'
import { PcrPlateMap } from './PcrPlateMap'
import { PcrSampleList } from './PcrSampleList'
import { PcrWorksheetActions } from './PcrWorksheetActions'

const MONO = 'font-mono text-[12.5px] tabular-nums'
const FIELD =
  'h-6 w-full rounded-[3px] border border-transparent bg-transparent px-1 text-sm font-medium hover:border-border focus:border-teal-500 focus:outline-none'

/**
 * The main column of the flyout for a PCR worksheet, laid out as Dennis's
 * plate builder: the run title and its actions, the run header (fields, run
 * status, run parameters), the samples panel beside the plate map(s) with a
 * calculations panel under each plate, and the notes. The generic header and
 * item list stay in charge of every other kind of worksheet.
 */
export function PcrWorksheetView({
  worksheet,
  users,
  userNotes,
  isCompleted,
  otherWorksheets,
  applyBar,
  completeAction,
  onAddSamples,
  onUpdate,
  onRemove,
  onReassign,
  onTickAll,
  onFreeze,
  onUnfreeze,
}: {
  worksheet: WorksheetListItem
  users: WorksheetUser[]
  userNotes: string
  isCompleted: boolean
  otherWorksheets: WorksheetListItem[]
  applyBar: ReactNode
  completeAction: ReactNode
  onAddSamples: () => void
  onUpdate: (data: {
    title?: string
    assigned_analyst?: number
    notes?: string
    bench_config?: Record<string, unknown>
  }) => void
  onRemove: (itemId: number) => void
  onReassign: (itemId: number, targetWorksheetId: number) => void
  onTickAll: (data: { made?: boolean; ran?: boolean }) => void
  onFreeze: (wells: WorksheetWellFreeze[]) => Promise<unknown>
  onUnfreeze: () => void
}) {
  useRegisterActiveFlagEntity(
    'worksheet',
    String(worksheet.id),
    worksheet.title || `Worksheet ${worksheet.id}`
  )
  const { calendar } = useLabCalendar()
  const pcrItems = worksheet.items.filter(isPcrWorksheetItem)
  const {
    byKey: slaByKey,
    isLoading: slaLoading,
    isError: slaError,
  } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      pcrItems,
      isCompleted ? (worksheet.completed_at ?? null) : null
    )
  )
  const analyst = users.find(u => u.id === worksheet.assigned_analyst)
  const analystName = analyst
    ? displayName(analyst)
    : (worksheet.assigned_analyst_email ?? '')
  const cfg = pcrConfigOf(worksheet)
  const buildDoc = () =>
    buildPcrRunDoc(worksheet, {
      analystName,
      calendar,
      printedAt: new Date().toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      dueAtByItemId: new Map(
        pcrItems.map(it => [
          it.id,
          slaByKey.get(String(it.id))?.status.due_at ?? null,
        ])
      ),
      notes: userNotes,
    })
  const doc = buildDoc()
  const L = doc.layout
  const setConfig = (patch: Partial<PcrConfig>) =>
    onUpdate({ bench_config: pcrConfigToWire({ ...cfg, ...patch }) })

  // Enter saves; Escape or clicking away cancels (see EndoWorksheetView for
  // why nothing saves on blur).
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  function saveTitle() {
    const next = (titleDraft ?? '').trim()
    setTitleDraft(null)
    if (next && next !== worksheet.title) onUpdate({ title: next })
  }

  const printedBy = users.find(u => u.id === worksheet.printed_by_user_id)
  const printed = worksheet.printed_at
    ? `printed ${new Date(worksheet.printed_at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}${printedBy ? ` by ${shortName(printedBy)}` : ''}${
        (worksheet.print_count ?? 0) > 1 ? ` (${worksheet.print_count}x)` : ''
      }`
    : 'not printed yet'
  const total = doc.status.total
  const allMade = total > 0 && doc.status.made === total
  const allRan = total > 0 && doc.status.ran === total

  return (
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-6 pb-8 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {titleDraft === null ? (
            <h2 className="truncate text-[23px] font-semibold leading-tight tracking-tight">
              {worksheet.title}
            </h2>
          ) : (
            <input
              autoFocus
              aria-label="Worksheet title"
              className="w-[22rem] max-w-full rounded-[5px] border bg-background px-2 py-1 text-xl font-semibold focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={() => setTitleDraft(null)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveTitle()
                if (e.key === 'Escape') setTitleDraft(null)
              }}
            />
          )}
          <span className="font-mono text-xs tracking-wide text-muted-foreground">
            WS-{worksheet.id} · {worksheet.status} · {printed}
            {L.frozenCount > 0 && ` · ${L.frozenCount} well${L.frozenCount === 1 ? '' : 's'} locked`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EntityFlagButton entityType="worksheet" entityId={String(worksheet.id)} />
          <PcrWorksheetActions
            worksheetId={worksheet.id}
            buildDoc={buildDoc}
            ready={!!calendar}
            isCompleted={isCompleted}
            onFreeze={onFreeze}
          />
          {!isCompleted && (
            <>
              <Button variant="outline" size="sm" onClick={() => setTitleDraft(worksheet.title)}>
                Rename
              </Button>
              {completeAction}
              <Button
                size="sm"
                className="bg-teal-600 text-white hover:bg-teal-600/90"
                onClick={onAddSamples}
              >
                Add samples
              </Button>
            </>
          )}
        </div>
      </div>

      {applyBar && (
        <div className="overflow-hidden rounded-[5px] border bg-card">{applyBar}</div>
      )}

      {/* Run header: Dennis's meta block, run status and run parameters. */}
      <div className="overflow-hidden rounded-[5px] border bg-card shadow-sm">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] border-b">
          <Meta label="Analyst">
            {isCompleted ? (
              <span className="text-sm font-medium">{analystName || '-'}</span>
            ) : (
              <Select
                value={worksheet.assigned_analyst ? String(worksheet.assigned_analyst) : undefined}
                onValueChange={v => onUpdate({ assigned_analyst: Number(v) })}
              >
                <SelectTrigger
                  aria-label="Analyst"
                  className="h-6 w-full border-0 bg-transparent p-0 text-sm font-medium shadow-none focus:ring-0"
                >
                  <SelectValue placeholder="Assign analyst…" />
                </SelectTrigger>
                <SelectContent>
                  {users.map(u => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {displayName(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Meta>
          <Meta label="Date made">
            <span className={MONO}>
              {shortLabDate(calendar ? labDate(worksheet.created_at, calendar) : null)}
            </span>
          </Meta>
          <Meta label="Curve">
            <ConfigField
              key={`curve-${worksheet.id}-${cfg.curve}`}
              value={cfg.curve}
              placeholder="P/A"
              options={['P/A', 'Quantitative']}
              disabled={isCompleted}
              onCommit={v => setConfig({ curve: v })}
            />
          </Meta>
          <Meta label="Plate type">
            <ConfigField
              key={`plate-${worksheet.id}-${cfg.plateType}`}
              value={cfg.plateType}
              placeholder="8-Well Strip"
              options={['8-Well Strip', '96-Well Plate']}
              disabled={isCompleted}
              onCommit={v => setConfig({ plateType: v })}
            />
          </Meta>
          <Meta label="QuantStudio" title="Recorded on every row by the Ran tick">
            <span className="truncate text-sm font-medium">
              {doc.meta.instrument || <span className="text-muted-foreground">not stamped yet</span>}
            </span>
          </Meta>
          <Meta label="Samples">
            <span className={MONO}>{doc.summary.samples}</span>
          </Meta>
          <Meta label="Plates">
            <span className={MONO}>{L.plateCount}</span>
          </Meta>
          <Meta label="Earliest due" title="The earliest SLA due date on this run">
            <span
              className={`${MONO} ${doc.summary.overdue ? 'font-bold text-[#c00000]' : doc.summary.today ? 'font-bold text-[#bf6a00]' : ''}`}
            >
              {shortLabDate(doc.summary.earliestDue)}
            </span>
          </Meta>
          <Meta label="Priority" title="Marked priority, overdue, or due today">
            <span className={`text-sm ${doc.summary.flagged ? 'font-bold text-[#c00000]' : ''}`}>
              {doc.summary.prioText}
            </span>
          </Meta>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-muted/60 px-3.5 py-2.5">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            Run status
          </span>
          <RunTick
            label="Plate made"
            count={`${doc.status.made}/${total}`}
            checked={allMade}
            disabled={isCompleted || total === 0}
            onChange={on => onTickAll({ made: on })}
          />
          <RunTick
            label="Ran on QuantStudio"
            count={`${doc.status.ran}/${total}`}
            checked={allRan}
            disabled={isCompleted || total === 0}
            onChange={on => onTickAll({ ran: on })}
          />
          <span className="flex-1" />
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            Run parameters
          </span>
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title="Applied to assay and IPC mix components only, matching the workbook. Master mix is not scaled: the well counts already carry a +4 / +2 buffer."
          >
            Overage
            <input
              key={`overage-${worksheet.id}-${cfg.overage}`}
              type="number"
              min={1}
              max={3}
              step={0.1}
              defaultValue={cfg.overage}
              disabled={isCompleted}
              aria-label="Overage factor"
              className="h-6 w-14 rounded-[3px] border bg-card px-1 text-right font-mono text-[12.5px] text-foreground"
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              onBlur={e => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v > 0 && v !== cfg.overage) setConfig({ overage: v })
                else e.target.value = String(cfg.overage)
              }}
            />
            ×
          </label>
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title="Lay the plate out by order number. Untick to place samples exactly as listed on the worksheet. Locked wells never move either way."
          >
            <Checkbox
              checked={cfg.sortByOrder}
              disabled={isCompleted}
              onCheckedChange={v => setConfig({ sortByOrder: v === true })}
            />
            Order wells by order #
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(340px,460px)_minmax(0,1fr)]">
        <PcrSampleList
          doc={doc}
          items={pcrItems}
          calendar={calendar}
          slaByKey={slaByKey}
          slaLoading={slaLoading}
          slaError={slaError}
          isCompleted={isCompleted}
          otherWorksheets={otherWorksheets}
          onRemove={onRemove}
          onReassign={onReassign}
        />
        <div className="min-w-0 space-y-4">
          {L.plates.map(pl => (
            <div key={pl.plate} className="space-y-3">
              <PcrPlateMap
                plate={pl}
                plateCount={L.plateCount}
                outlineGroups={cfg.sortByOrder}
                frozenCount={L.frozenCount}
                isCompleted={isCompleted}
                onUnfreeze={onUnfreeze}
              />
              <section>
                <h3 className="pb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                  Calculations{L.plateCount > 1 ? `: plate ${pl.plate}` : ''}
                </h3>
                <PcrCalculations wells={pl.n} overage={cfg.overage} />
              </section>
            </div>
          ))}
        </div>
      </div>

      <section>
        <h3 className="pb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
          Notes
        </h3>
        {isCompleted ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{userNotes || '-'}</p>
        ) : (
          <Textarea
            key={worksheet.id}
            className="min-h-[60px] resize-none bg-card text-sm"
            placeholder="Deviations, lot numbers, observations…"
            defaultValue={userNotes}
            onBlur={e => {
              if (e.target.value !== userNotes) onUpdate({ notes: e.target.value })
            }}
          />
        )}
      </section>
    </div>
  )
}

function Meta({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-r px-3.5 py-2.5 last:border-r-0" title={title}>
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

/** A free-text run setting with suggestions; Enter or leaving the field saves. */
function ConfigField({
  value,
  placeholder,
  options,
  disabled,
  onCommit,
}: {
  value: string
  placeholder: string
  options: string[]
  disabled: boolean
  onCommit: (v: string) => void
}) {
  const listId = `pcr-opts-${placeholder.replace(/\W+/g, '-')}`
  if (disabled) return <span className="text-sm font-medium">{value || '-'}</span>
  return (
    <>
      <input
        type="text"
        list={listId}
        defaultValue={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className={FIELD}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        onBlur={e => {
          const v = e.target.value.trim()
          if (v !== value) onCommit(v)
        }}
      />
      <datalist id={listId}>
        {options.map(o => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  )
}

/** A run-level tick: sets (or clears) Made / Ran on every row at once. */
function RunTick({
  label,
  count,
  checked,
  disabled,
  onChange,
}: {
  label: string
  count: string
  checked: boolean
  disabled: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={v => onChange(v === true)}
      />
      {label}
      <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
    </label>
  )
}

export default PcrWorksheetView
```

- [ ] **Step 5: Wire the drawer**

In `WorksheetDrawer.tsx`:

- import `{ PcrWorksheetView } from './PcrWorksheetView'`; pull `freezeWellsMutation, unfreezeWellsMutation` from `useWorksheetDrawer()`.
- Replace the `isEndo` block with

```tsx
  // Worksheets 2.0: an all-endo or all-PCR worksheet gets its bench view,
  // which needs the room of a page; every other worksheet keeps the 1100px drawer.
  const kind = activeWorksheet ? worksheetKind(activeWorksheet.items) : null
  const isEndo = kind === 'endo'
  const isPcr = kind === 'pcr'
  const isBench = isEndo || isPcr
```

- `handleUpdateWorksheet`'s `data` parameter type gains `bench_config?: Record<string, unknown>`.
- The `SheetContent` width uses `isBench` instead of `isEndo`.
- After the endo block, add the PCR block:

```tsx
          {/* PCR worksheet: Dennis's plate builder + the PCR run log (Worksheets 2.0) */}
          {!isLoading && !isError && activeWorksheet && isPcr && (
            <div className="flex flex-1 min-h-0 overflow-hidden bg-muted/30">
              <BenchRunLog
                kind="pcr"
                label="Rapid sterility PCR"
                tickLabels={['Plate made', 'Ran']}
                activeId={activeWorksheet.id}
                users={users}
                onSelect={id => {
                  setAnalystFilter('all')
                  setActiveId(id)
                }}
              />
              <PcrWorksheetView
                key={activeWorksheet.id}
                worksheet={activeWorksheet}
                users={users}
                userNotes={userNotes}
                isCompleted={!!isCompleted}
                otherWorksheets={openWorksheets.filter(ws => ws.id !== activeWorksheet.id)}
                applyBar={
                  !isCompleted && (
                    <WorksheetApplyBar
                      key={activeWorksheet.id}
                      activeMethods={activeMethods}
                      instruments={instruments}
                      isPending={applyMethodInstrumentMutation.isPending}
                      onApply={handleApplyToAll}
                    />
                  )
                }
                completeAction={completeAction}
                onAddSamples={() => setAddSamplesOpen(true)}
                onUpdate={handleUpdateWorksheet}
                onRemove={itemId => removeMutation.mutate({ worksheetId: activeWorksheet.id, itemId })}
                onReassign={(itemId, targetId) =>
                  reassignMutation.mutate({ worksheetId: activeWorksheet.id, itemId, targetWorksheetId: targetId })
                }
                onTickAll={data => bulkTicksMutation.mutate({ worksheetId: activeWorksheet.id, data })}
                onFreeze={wells => freezeWellsMutation.mutateAsync({ worksheetId: activeWorksheet.id, wells })}
                onUnfreeze={() => unfreezeWellsMutation.mutate(activeWorksheet.id)}
              />
              <AddSamplesModal
                open={addSamplesOpen}
                onOpenChange={setAddSamplesOpen}
                worksheetId={activeWorksheet.id}
                existingItems={activeWorksheet.items}
                onAdd={data => addItemMutation.mutate({ worksheetId: activeWorksheet.id, data })}
              />
            </div>
          )}
```

- The generic block's condition becomes `activeWorksheet && !isBench`.

- [ ] **Step 6: Typecheck, lint, run the drawer tests, commit**

Run: `npm run typecheck && npx eslint src/components/hplc && npx vitest run src/components/hplc src/lib`
Expected: clean; no new failures against the baseline (4 vitest files fail on master too).

```bash
git commit -m "feat(pcr): plate builder view in the worksheet flyout" -- src/components/hplc/EndoWorksheetTable.tsx src/components/hplc/PcrSampleList.tsx src/components/hplc/PcrWorksheetActions.tsx src/components/hplc/PcrWorksheetView.tsx src/components/hplc/WorksheetDrawer.tsx
```

---

### Task 9: Gates, changelog, pull request, stack UAT

**Files:**
- Modify: `CHANGELOG.md` (under `## Unreleased`)

- [ ] **Step 1: Frontend gates as failure-set diffs against master**

Run, in this worktree and in a master checkout (`/c/tmp/Accu-Mk1-master-baseline`, `git pull --ff-only` first):

```bash
npm run typecheck
npx eslint . --max-warnings 0 2>&1 | grep -E "^\S.*\.(ts|tsx)$" | sort > /tmp/eslint-<tree>.txt
npx prettier --check src/lib/pcr-plate.ts src/lib/pcr-worksheet.ts src/lib/pcr-bench-sheet.ts src/lib/__tests__/pcr-*.ts src/components/hplc/Pcr*.tsx src/components/hplc/BenchRunLog.tsx
npm run ast:lint
npx vitest run 2>&1 | grep -E "FAIL|Test Files|Tests " > /tmp/vitest-<tree>.txt
```

Expected: typecheck clean; the eslint failure set equals master's; prettier clean on the new files (never `prettier --write` api.ts or WorksheetDrawer.tsx, both are unclean on master); ast:lint clean; the vitest failing-file set equals master's (the 5 s `FlagsFlyout` timeout is baseline).

- [ ] **Step 2: Backend gate**

Run: `cd backend && python -m pytest tests/test_worksheet_pcr_wells.py tests/test_worksheet_endo_prep.py tests/test_worksheets_list_sync.py tests/test_worksheet_item_by_id.py tests/test_worksheet_analyst_stamp.py -q`
Expected: all pass. (The full suite runs in the stack container before deploy, one tree at a time, as for 1.25.0.)

- [ ] **Step 3: Changelog** (under `## Unreleased`)

```markdown
### Worksheets 2.0: rapid sterility PCR plate builder
- **A PCR worksheet is a run.** Open any worksheet whose samples are all PCR vials (native `pcr` or legacy `ster`, the same test) and the flyout shows Dennis's plate builder: the run header, the samples panel beside a 96-well plate map (16S in columns 1 to 6, its 18S mirror in 7 to 12, one boxed block per order, the NPC after the last sample), the reagent calculations for every plate, and the PCR run log rail. One worksheet spans every order on the plate.
- **Wells lock when the plate leaves for the bench.** Print or the QuantStudio export pins every sample to its well; a locked well never moves. Samples added later take the wells after the last locked one and the NPC stays last. A locked well is never re-issued, even after its sample is removed. "Unlock wells" releases them on purpose (audited).
- **Exports and print:** the QuantStudio 6/7 Flex sample file (one per plate), the plate map CSV, the well list CSV, Preview and Print (one landscape page per plate, run strip on every page, notes on the last). Print is recorded as the run's start on the bench, as on the endo sheet.
- **Run status and parameters:** Plate made / Ran on QuantStudio tick every row at once (Ran records the QuantStudio on each row); overage, curve, plate type and the order-sort switch are saved on the worksheet.
- Legacy `ster` vials now classify as PCR work everywhere (bench kind, run log).
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/pcr-worksheet
gh pr create --title "Worksheets 2.0: PCR plate builder (Dennis's qpcr-plate-builder port)" --body-file docs/superpowers/specs/2026-09-22-pcr-worksheet-design.md
```

- [ ] **Step 5: Stack UAT**

On the devbox (`forrestparker@100.73.137.3`), in the `endows` stack's worktree:

```bash
cd ~/worktrees/Accu-Mk1-endows && git fetch origin && git checkout -B pcrws/feat-pcr-worksheet origin/feat/pcr-worksheet && docker restart accumark-endows-accu-mk1-backend
```

Then, with a minted token (see the endo memory for the recipe): confirm the boot ALTERs landed (`\d worksheet_items` shows `plate_no`, `well_pos`; `\d worksheets` shows `bench_config`), create or find an open worksheet holding two or more `pcr` / `ster` vials, open `#hplc-analysis/worksheet-detail?id=<id>` and click through: plate map renders with the NPC last; Print locks the wells (the badge shows `n wells locked`); Add samples after that puts the new vial after the last locked well; Unlock wells releases them; the QuantStudio file downloads one file per plate; Plate made / Ran tick every row and Ran stamps the instrument when the catalog resolves one.

Report the results to the Handler; deploy is a separate step through the `accumark-deploy` skill.
