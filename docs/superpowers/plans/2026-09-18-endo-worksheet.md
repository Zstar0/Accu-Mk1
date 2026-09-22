# Endotoxin Worksheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn any Mk1 worksheet holding endotoxin vials into Dennis's endotoxin bench log: prep overrides on the item, computed prep figures and due dates in the drawer, a printable 10-per-page bench sheet, and a backfill of the September runs from his data file.

**Architecture:** Three nullable override columns on `worksheet_items` plus four parent facts on the worksheet API; every derived figure is computed once in `src/lib/endo-prep.ts` (a port of `calc.js`) and rendered by an endo prep line in the drawer, a standalone bench-sheet HTML document printed through an isolated iframe, and a CSV. Attribution rides the existing `worksheet_analyst.stamp_for_item` path, which the backfill script also uses.

**Tech Stack:** FastAPI + SQLAlchemy (boot ALTER migrations in `database.py`), React 19 + TanStack Query + vitest, Python `pytest` with in-memory SQLite.

**Spec:** `docs/superpowers/specs/2026-09-18-endo-worksheet-design.md`

## Global Constraints

- Additive only: no existing column, key, route or behaviour changes. New GET keys ride handlers with no `response_model`.
- Formulas byte-for-byte as in the spec §3; the `calc.js` vectors are the tests.
- Frontend package manager is npm only. Worksheet drawer code uses plain English strings (no i18n), match it.
- Commit with explicit pathspecs (`git commit -- <paths>`) because the worktree stash and index are shared.
- Backend tests: `backend/.venv` python from the workspace checkout; never run the full backend suite concurrently with another session.
- No deploy, no prod write. The backfill runs only as a dry-run tonight.

---

### Task 1: Prep override columns + PATCH

**Files:**
- Modify: `backend/models.py` (class `WorksheetItem`, after `prep_status`)
- Modify: `backend/database.py` (ALTER list, after the `prep_status` ALTER at ~line 288)
- Modify: `backend/main.py` (`WorksheetItemUpdate` + `update_worksheet_item`, ~line 23199)
- Test: `backend/tests/test_worksheet_endo_prep.py`

**Interfaces:**
- Produces: `WorksheetItem.prep_weight_mg | prep_volume_ml | prep_dilution_factor: Optional[float]`; PATCH body keys of the same names (explicit null clears).

- [ ] **Step 1: Write the failing test**

```python
"""Endotoxin bench prep on worksheet items (spec 2026-09-18-endo-worksheet-design).

In-memory SQLite + dependency overrides, no live stack.
"""
import json
from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import Department, LimsSample, LimsSubSample, Worksheet, WorksheetItem


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
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


def _seed(db, *, vial=True):
    micro = Department(name="Microbiology")
    db.add(micro)
    db.flush()
    parent = LimsSample(
        sample_id="P-2995", external_lims_uid="SEN-P-2995",
        declared_total_quantity="10.00", sample_type_title="Peptide",
        client_order_number="WP-7536", analytes=json.dumps(["MOTS-c"]),
        date_received=datetime(2026, 9, 17, 16, 30),
    )
    db.add(parent)
    db.flush()
    sub = None
    if vial:
        sub = LimsSubSample(
            sample_id="P-2995-S02", parent_sample_pk=parent.id, vial_sequence=2,
            external_lims_uid="mk1://endo-1", assignment_role="endo85",
        )
        db.add(sub)
        db.flush()
    ws = Worksheet(title="Endo 09/17/2026", status="open")
    db.add(ws)
    db.flush()
    item = WorksheetItem(
        worksheet_id=ws.id,
        sample_uid=sub.external_lims_uid if sub else parent.external_lims_uid,
        sample_id=sub.sample_id if sub else parent.sample_id,
        department_id=micro.id,
    )
    db.add(item)
    db.commit()
    return ws, item


def test_patch_sets_and_clears_prep_overrides(client, db):
    ws, item = _seed(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}",
                     json={"prep_weight_mg": 30, "prep_volume_ml": 2, "prep_dilution_factor": 40})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert (item.prep_weight_mg, item.prep_volume_ml, item.prep_dilution_factor) == (30, 2, 40)

    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_volume_ml": None})
    assert r.status_code == 200
    db.refresh(item)
    assert item.prep_volume_ml is None
    assert item.prep_weight_mg == 30  # omitted field untouched


def test_patch_rejects_non_positive_override(client, db):
    ws, item = _seed(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_weight_mg": 0})
    assert r.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ../../..../Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_worksheet_endo_prep.py -q -p no:cacheprovider`
Expected: FAIL (prep_weight_mg unknown column / attribute).

- [ ] **Step 3: Model + migration + PATCH**

`models.py`, inside `WorksheetItem` after `prep_status`:

```python
    # Endotoxin bench prep (2026-09-18, ported from Dennis's endotoxin-log).
    # All three are analyst OVERRIDES; NULL means "use the computed value":
    #   prep_weight_mg        weight actually prepped, when it differs from the
    #                         parent's declared quantity
    #   prep_volume_ml        reconstitution volume, when it differs from
    #                         MIN(10, 1 + FLOOR(mg / 50))
    #   prep_dilution_factor  bacteriostatic-water dilution, when not 20x
    # Derived figures (vial conc, sample uL, LAL uL, due date) are never stored;
    # src/lib/endo-prep.ts computes them from these plus the parent's declared weight.
    prep_weight_mg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    prep_volume_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    prep_dilution_factor: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
```

`database.py`, after the `prep_status` ALTER:

```python
        # Endotoxin bench prep overrides (2026-09-18, spec endo-worksheet-design)
        "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_weight_mg FLOAT",
        "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_volume_ml FLOAT",
        "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_dilution_factor FLOAT",
```

`main.py`:

```python
class WorksheetItemUpdate(BaseModel):
    instrument_uid: Optional[str] = None
    instrument_id: Optional[int] = None
    prep_status: Optional[str] = None
    # Endotoxin bench prep overrides: explicit null clears, omitted = no-op
    prep_weight_mg: Optional[float] = None
    prep_volume_ml: Optional[float] = None
    prep_dilution_factor: Optional[float] = None
```

and in `update_worksheet_item`, before `db.commit()`:

```python
    for field in ("prep_weight_mg", "prep_volume_ml", "prep_dilution_factor"):
        if field in data.model_fields_set:
            value = getattr(data, field)
            if value is not None and value <= 0:
                raise HTTPException(400, f"{field} must be greater than zero")
            setattr(item, field, value)
```

- [ ] **Step 4: Run test to verify it passes** (same command). Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/models.py backend/database.py backend/main.py backend/tests/test_worksheet_endo_prep.py
git commit -m "feat(worksheets): endotoxin prep overrides on worksheet items" -- backend/models.py backend/database.py backend/main.py backend/tests/test_worksheet_endo_prep.py
```

---

### Task 2: Parent facts on the worksheet item dict

**Files:**
- Modify: `backend/main.py` (`_serialize_worksheets`, the `sub_rows` select and the item dict)
- Test: `backend/tests/test_worksheet_endo_prep.py` (add two tests)

**Interfaces:**
- Produces item keys `prep_weight_mg`, `prep_volume_ml`, `prep_dilution_factor`, `declared_weight_mg: float|None`, `sample_type: str|None`, `client_order_number: str|None`, `sample_identity: str|None`.

- [ ] **Step 1: Write the failing tests**

```python
def test_get_worksheet_carries_parent_facts_for_vial_item(client, db):
    ws, item = _seed(db)
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_volume_ml": 2})
    body = client.get(f"/worksheets/{ws.id}").json()
    it = body["items"][0]
    assert it["declared_weight_mg"] == 10.0
    assert it["sample_type"] == "Peptide"
    assert it["client_order_number"] == "WP-7536"
    assert it["sample_identity"] == "MOTS-c"
    assert it["prep_volume_ml"] == 2 and it["prep_weight_mg"] is None


def test_get_worksheet_resolves_parent_sample_item(client, db):
    ws, item = _seed(db, vial=False)  # legacy "<order> E" worksheets hold P-XXXX ids
    it = client.get(f"/worksheets/{ws.id}").json()["items"][0]
    assert it["declared_weight_mg"] == 10.0
    assert it["sample_identity"] == "MOTS-c"
```

- [ ] **Step 2: Run to verify they fail** (KeyError on `declared_weight_mg`).

- [ ] **Step 3: Implement**

Module-level helper in `main.py` (near `_serialize_worksheets`):

```python
def _worksheet_item_parent_facts(parent: "Optional[LimsSample]") -> dict:
    """Parent-sample facts the endotoxin bench needs on a worksheet item
    (spec 2026-09-18-endo-worksheet-design §4). None-safe: every key is
    present even when the item has no resolvable parent."""
    if parent is None:
        return {"declared_weight_mg": None, "sample_type": None,
                "client_order_number": None, "sample_identity": None}
    declared = None
    if parent.declared_total_quantity not in (None, ""):
        try:
            declared = float(parent.declared_total_quantity)
        except (TypeError, ValueError):
            declared = None
    identity = None
    if parent.analytes:
        try:
            slots = json.loads(parent.analytes)
        except (TypeError, ValueError):
            slots = None
        if isinstance(slots, list):
            names = []
            for s in slots:
                name = s.get("name") or s.get("title") if isinstance(s, dict) else s
                if name:
                    names.append(str(name))
            identity = ", ".join(names) or None
    return {
        "declared_weight_mg": declared,
        "sample_type": parent.sample_type_title or parent.sample_type,
        "client_order_number": parent.client_order_number,
        "sample_identity": identity or parent.peptide_name,
    }
```

In `_serialize_worksheets`: add `LimsSubSample.parent_sample_pk` to the `sub_rows` select and `sub_parent_pk_map = {r.sample_id: r.parent_sample_pk for r in sub_rows}`; then after the box-label block:

```python
    # Endotoxin bench prep (2026-09-18): resolve each item's parent sample so the
    # declared weight, matrix, order and identity ride on the item. Vial items
    # go through the vial's parent; parent-sample items (legacy "<order> E"
    # worksheets hold P-XXXX ids) match by their own sample id. ONE query.
    parent_pks = {pk for pk in sub_parent_pk_map.values() if pk}
    parent_by_pk: dict[int, LimsSample] = {}
    parent_by_sample_id: dict[str, LimsSample] = {}
    if parent_pks or item_sample_ids:
        parent_rows = db.execute(
            select(LimsSample).where(or_(
                LimsSample.id.in_(parent_pks or [0]),
                LimsSample.sample_id.in_(item_sample_ids or ["-"]),
            ))
        ).scalars().all()
        parent_by_pk = {p.id: p for p in parent_rows}
        parent_by_sample_id = {p.sample_id: p for p in parent_rows}

    def _parent_for(sample_id: str):
        pk = sub_parent_pk_map.get(sample_id)
        return parent_by_pk.get(pk) if pk else parent_by_sample_id.get(sample_id)
```

and in the item dict after `"prep_status"`:

```python
                    "prep_weight_mg": it.prep_weight_mg,
                    "prep_volume_ml": it.prep_volume_ml,
                    "prep_dilution_factor": it.prep_dilution_factor,
                    **_worksheet_item_parent_facts(_parent_for(it.sample_id)),
```

- [ ] **Step 4: Run** `tests/test_worksheet_endo_prep.py tests/test_worksheets_list_sync.py tests/test_worksheet_item_by_id.py`. Expected: all pass.

- [ ] **Step 5: Commit** `git commit -m "feat(worksheets): parent facts on worksheet items for the endo bench" -- backend/main.py backend/tests/test_worksheet_endo_prep.py`

---

### Task 3: `src/lib/endo-prep.ts` (the calc.js port)

**Files:**
- Create: `src/lib/endo-prep.ts`
- Test: `src/lib/__tests__/endo-prep.test.ts`

**Interfaces (produces):**

```ts
export const CARTRIDGE_UL = 1000, MAX_VOLUME_ML = 10, DEFAULT_DILUTION = 20, ENDO_TURNAROUND_BUSINESS_DAYS = 3
export interface EndoPrepInput { sampleId: string; sampleType?: string|null; declaredWeightMg?: number|null; prepWeightMg?: number|null; prepVolumeMl?: number|null; prepDilutionFactor?: number|null }
export interface EndoPrep { isWater: boolean; dilution: number|null; weightMg: number|null; weightOverridden: boolean; autoVolumeMl: number|null; volumeMl: number|null; volumeOverridden: boolean; vialConc: number|null; sampleUl: number|null; lalUl: number|null; warning: 'over_cartridge'|'no_diluent'|null }
export function autoVolumeMl(weightMg: number|null|undefined): number|null
export function isBacWater(sampleId: string, sampleType?: string|null): boolean
export function calcEndoPrep(input: EndoPrepInput): EndoPrep
export interface LabCalendar { timezone: string; workingDays: number[]; holidays: Map<string,string> }
export function labDate(iso: string|null|undefined, cal: LabCalendar): string|null
export function addBusinessDays(isoDate: string, n: number, cal: LabCalendar): { iso: string; holidaysSkipped: { iso: string; name: string }[] }
export function endoDueDate(dateReceivedIso: string|null|undefined, cal: LabCalendar): { iso: string; holidaysSkipped: {iso:string;name:string}[] } | null
export function priorityRank(priority: string|null|undefined): number   // expedited 0, high 1, else 2
export function orderForBench<T>(items: T[], key: (t: T) => { due: string|null; priority: string|null|undefined }): T[]
export function fmtUl(v: number|null|undefined): string
export function fmt(v: number|null|undefined): string
```

- [ ] **Step 1: Write the failing tests** (the calc.js vectors):

```ts
import { describe, it, expect } from 'vitest'
import {
  autoVolumeMl, calcEndoPrep, isBacWater, addBusinessDays, endoDueDate, labDate,
  orderForBench, fmtUl, fmt, type LabCalendar,
} from '@/lib/endo-prep'

const cal: LabCalendar = {
  timezone: 'America/Los_Angeles',
  workingDays: [0, 1, 2, 3, 4],
  holidays: new Map([['2026-05-25', 'Memorial Day'], ['2026-09-07', 'Labor Day']]),
}

describe('endo-prep: reconstitution volume', () => {
  it('is 1 mL plus 1 per whole 50 mg, capped at 10', () => {
    expect(autoVolumeMl(10)).toBe(1)
    expect(autoVolumeMl(49)).toBe(1)
    expect(autoVolumeMl(50)).toBe(2)
    expect(autoVolumeMl(120)).toBe(3)
    expect(autoVolumeMl(449)).toBe(9)
    expect(autoVolumeMl(450)).toBe(10)
    expect(autoVolumeMl(600)).toBe(10)
    expect(autoVolumeMl(0)).toBeNull()
    expect(autoVolumeMl(null)).toBeNull()
  })
})

describe('endo-prep: peptide prep', () => {
  it('10 mg in 1 mL: 100 uL sample + 900 uL LAL', () => {
    const p = calcEndoPrep({ sampleId: 'P-0101', declaredWeightMg: 10 })
    expect([p.volumeMl, p.vialConc, p.sampleUl, p.lalUl]).toEqual([1, 10, 100, 900])
    expect(p.isWater).toBe(false)
    expect(p.warning).toBeNull()
  })
  it('120 mg in 3 mL: 25 + 975', () => {
    const p = calcEndoPrep({ sampleId: 'P-0102', declaredWeightMg: 120 })
    expect([p.vialConc, p.sampleUl, p.lalUl]).toEqual([40, 25, 975])
  })
  it('600 mg hits the 10 mL cap: 60 mg/mL, 16.7 / 983.3', () => {
    const p = calcEndoPrep({ sampleId: 'P-0104', declaredWeightMg: 600 })
    expect(p.volumeMl).toBe(10)
    expect(p.vialConc).toBe(60)
    expect(fmtUl(p.sampleUl)).toBe('16.7')
    expect(fmtUl(p.lalUl)).toBe('983.3')
  })
  it('an entered volume overrides the rule and is marked', () => {
    const p = calcEndoPrep({ sampleId: 'P-0200', declaredWeightMg: 120, prepVolumeMl: 2 })
    expect(p.volumeMl).toBe(2)
    expect(p.autoVolumeMl).toBe(3)
    expect(p.volumeOverridden).toBe(true)
    expect(p.vialConc).toBe(60)
  })
  it('an entered weight overrides the declared quantity', () => {
    const p = calcEndoPrep({ sampleId: 'P-2458', declaredWeightMg: 30, prepWeightMg: 10 })
    expect(p.weightMg).toBe(10)
    expect(p.weightOverridden).toBe(true)
    expect(p.sampleUl).toBe(100)
  })
  it('a half-filled row yields nulls, never NaN', () => {
    const p = calcEndoPrep({ sampleId: 'P-0300', declaredWeightMg: null })
    expect(p.sampleUl).toBeNull()
    expect(p.lalUl).toBeNull()
    expect(fmtUl(p.sampleUl)).toBe('')
  })
  it('flags 1 mg (no diluent) and 0.5 mg (over the cartridge)', () => {
    expect(calcEndoPrep({ sampleId: 'P-1', declaredWeightMg: 1 }).warning).toBe('no_diluent')
    expect(calcEndoPrep({ sampleId: 'P-1', declaredWeightMg: 0.5 }).warning).toBe('over_cartridge')
  })
})

describe('endo-prep: bacteriostatic water', () => {
  it('is a 20x dilution by id or by sample type', () => {
    const byId = calcEndoPrep({ sampleId: 'BW-0105' })
    expect([byId.dilution, byId.sampleUl, byId.lalUl, byId.volumeMl, byId.vialConc]).toEqual([20, 50, 950, null, null])
    expect(isBacWater('P-0999', 'Bacteriostatic Water')).toBe(true)
    expect(isBacWater('P-0999', 'Peptide')).toBe(false)
  })
  it('honours a non-default factor', () => {
    const p = calcEndoPrep({ sampleId: 'BW-0106', prepDilutionFactor: 40 })
    expect([p.dilution, p.sampleUl, p.lalUl]).toEqual([40, 25, 975])
  })
})

describe('endo-prep: due dates', () => {
  it('received date is read in the lab time zone', () => {
    // 2026-09-17 23:30Z is still 09-17 in Los Angeles; 2026-09-18 03:00Z is 09-17 too
    expect(labDate('2026-09-18T03:00:00Z', cal)).toBe('2026-09-17')
    expect(labDate(null, cal)).toBeNull()
  })
  it('is 3 business days out, skipping weekends', () => {
    expect(addBusinessDays('2026-09-11', 3, cal).iso).toBe('2026-09-16') // Fri -> Wed
    expect(addBusinessDays('2026-09-15', 3, cal).iso).toBe('2026-09-18') // Tue -> Fri
  })
  it('steps over lab holidays and reports them', () => {
    const r = addBusinessDays('2026-05-21', 3, cal) // Memorial Day 05-25
    expect(r.iso).toBe('2026-05-27')
    expect(r.holidaysSkipped).toEqual([{ iso: '2026-05-25', name: 'Memorial Day' }])
    expect(addBusinessDays('2026-09-04', 3, cal).iso).toBe('2026-09-10') // Labor Day
  })
  it('respects a custom working-day set', () => {
    const fourDay: LabCalendar = { ...cal, workingDays: [0, 1, 2, 3] } // no Fridays
    expect(addBusinessDays('2026-09-16', 3, fourDay).iso).toBe('2026-09-22')
  })
  it('endoDueDate takes an ISO timestamp and returns the due date', () => {
    expect(endoDueDate('2026-09-15T16:30:00Z', cal)?.iso).toBe('2026-09-18')
    expect(endoDueDate(null, cal)).toBeNull()
  })
})

describe('endo-prep: bench order and formatting', () => {
  it('orders by due date, then priority, then insertion', () => {
    const rows = [
      { id: 'A', due: '2026-09-18', priority: 'normal' },
      { id: 'B', due: '2026-09-16', priority: 'default' },
      { id: 'C', due: '2026-09-16', priority: 'expedited' },
      { id: 'D', due: '2026-09-16', priority: 'high' },
      { id: 'E', due: '2026-09-16', priority: null },
      { id: 'F', due: null, priority: 'expedited' },
    ]
    expect(orderForBench(rows, r => r).map(r => r.id)).toEqual(['C', 'D', 'B', 'E', 'A', 'F'])
  })
  it('formats microlitres to 1 decimal and the rest to 3', () => {
    expect(fmtUl(33.333)).toBe('33.3')
    expect(fmtUl(100)).toBe('100')
    expect(fmt(49.888888)).toBe('49.889')
    expect(fmt(null)).toBe('')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/endo-prep.test.ts` → fails (module missing).

- [ ] **Step 3: Implement `src/lib/endo-prep.ts`**: see the file in the repo; it is the plan's content verbatim (constants, `num`, `autoVolumeMl`, `isBacWater`, `calcEndoPrep`, calendar helpers using `Intl.DateTimeFormat(…, {timeZone})` for `labDate` and UTC-noon date stepping for `addBusinessDays`, `priorityRank`, `orderForBench` (stable: `Array.prototype.sort` is stable in modern engines; ties keep input order), `fmtUl`, `fmt`).

- [ ] **Step 4: Run** the test → all pass. **Step 5: Commit** `-- src/lib/endo-prep.ts src/lib/__tests__/endo-prep.test.ts`.

---

### Task 4: Bench sheet HTML builder, CSV, and isolated print

**Files:**
- Create: `src/lib/endo-bench-sheet.ts` (`buildEndoBenchSheetHtml`, `buildEndoCsv`, `escapeHtml`)
- Create: `src/lib/print-document.ts` (`printHtmlDocument(html)`: hidden iframe, `srcdoc`, print on load, remove after `afterprint`/timeout)
- Test: `src/lib/__tests__/endo-bench-sheet.test.ts`

**Interfaces:**

```ts
export interface EndoSheetRow { due: string|null; dueHoliday: boolean; priority: string; order: string; sampleId: string; identity: string; volumeMl: string; dilution: number|null; sampleUl: string; lalUl: string; received: string|null; weightMg: string; vialConc: string }
export interface EndoSheetDoc { title: string; runName: string; analyst: string; dateMade: string; orders: string; printedAt: string; rows: EndoSheetRow[]; holidayNotes: { iso: string; name: string }[] }
export function buildEndoBenchSheetHtml(doc: EndoSheetDoc): string   // complete standalone HTML; 10 rows per <section class="page">; summary page last
export function buildEndoCsv(doc: EndoSheetDoc): string
export function escapeHtml(s: unknown): string
```

- [ ] **Step 1: Failing tests**: 21 rows → exactly 3 `<section class="page">` + 1 `<section class="page summary">`; each table page has ≤ 10 `<tr>` in tbody; `<` in an identity is escaped; CSV has the header line and 22 lines; a bac-water row prints `20×` in the volume cell and a blank vial conc.

- [ ] **Step 3: Implement**: port of `buildPrintDoc` from `tools-dennis/tools/endotoxin-log/endotoxin.html` (styles verbatim minus `fitRowPadding`; 11 columns: `# · Due · Priority · Order # · Sample ID · Sample identity · Volume mL · Sample µL · LAL µL · Made · Ran` with the two tick boxes printed empty for the pen), plus the summary sheet (tiles: samples, sample volume, LAL volume; priority counts; due grouping; the five rules; holiday footnote). `printHtmlDocument` writes the html into an off-screen iframe (`position:fixed;right:0;bottom:0;width:0;height:0;border:0`), waits for `load`, calls `contentWindow.print()`, and removes the iframe on `afterprint` or after 60 s.

- [ ] **Step 4/5:** run tests, commit `-- src/lib/endo-bench-sheet.ts src/lib/print-document.ts src/lib/__tests__/endo-bench-sheet.test.ts`.

---

### Task 5: API types, calendar hook, drawer prep line, print/CSV actions

**Files:**
- Modify: `src/lib/api.ts` (`WorksheetListItem.items[]` + 7 keys; `updateWorksheetItem` data type + 3 keys)
- Modify: `src/hooks/use-worksheet-drawer.ts` (`updateItemMutation` data type)
- Create: `src/hooks/use-lab-calendar.ts` (`useLabCalendar(): { calendar: LabCalendar|null }` from `getBusinessHoursConfig` + `getLabHolidays(y-1..y+1)`, React Query, staleTime 1 h)
- Create: `src/components/hplc/EndoPrepLine.tsx`
- Modify: `src/components/hplc/WorksheetDrawerItems.tsx` (`isEndoItem`, render `EndoPrepLine` under the row, `onUpdateItem` data type)
- Modify: `src/components/hplc/WorksheetDrawer.tsx` (Print bench sheet + Export CSV buttons when the worksheet holds endo items; open and completed)

**Interfaces:**
- `isEndoWorksheetItem(item): boolean` exported from `EndoPrepLine.tsx`: `assignment_role` in `endo|endo85` or any analysis keyword matching `/ENDO/i`.
- `EndoPrepLine` props: `{ item: ItemType; calendar: LabCalendar|null; isCompleted: boolean; onUpdate: (data: { prep_weight_mg?: number|null; prep_volume_ml?: number|null; prep_dilution_factor?: number|null }) => void }`.
- `buildEndoSheetDoc(worksheet, users, calendar, printedAt): EndoSheetDoc` in `EndoPrepLine.tsx` (shared by print and CSV; rows in bench order).

- [ ] Steps: typecheck fails until types land; implement; `npx vitest run src/lib/__tests__/endo-prep.test.ts src/lib/__tests__/endo-bench-sheet.test.ts`, `npm run typecheck`, `npx eslint <files>`, `npx prettier --check <files>`; commit.

---

### Task 6: Backfill script

**Files:**
- Create: `backend/scripts/backfill_endo_worksheets.py`
- Test: `backend/tests/test_backfill_endo_worksheets.py`

**Interfaces:**
- `load_runs(path) -> list[dict]`; `run_backfill(db, runs, *, apply: bool, today: date) -> dict` (report with per-run rows: name, analyst, resolved, unresolved, existing, new, worksheet_status); CLI `python -m scripts.backfill_endo_worksheets <json> [--apply]`.

- [ ] **Step 1: Failing test** (SQLite): seed Microbiology department, user `guian@…` first_name Guian, service `ENDOTOXIN-USP85LAL` dept Microbiology, parent P-2995 (declared "10") with vial P-2995-S02 role endo85 + promoted endo row (analyst None), parent P-2826 (declared "24") with vial P-2826-S02 role endo85 + unassigned endo row, and an unrelated vial already on a worksheet. Store = one run `09112026-3` analyst Guian, rows `P-2995-S02` (f 30, g null), `P-2826` (f 24, g 2), `P-9999` (unknown). Dry-run → report counts, zero worksheets. Apply → one worksheet titled `Endo 09/11/2026 #3`, status open (one row unassigned), 2 items, `prep_weight_mg` 30 on the first (differs from declared 10) and None on the second, `prep_volume_ml` 2 on the second, both endo rows carry Guian, the unassigned row is now `assigned`, unresolved = [`P-9999`]. Second apply → nothing new.

- [ ] **Step 3: Implement** per spec §5 (docstring as in the spec; `resolve_vial`, `analyst_for`, `prep_overrides_for_row`, `run_backfill`, `main`). Title rule: run `label` if set, else `Endo MM/DD/YYYY` with ` #n` for `-n` suffixed run names. `created_at`/`completed_at` = run date at 17:00 UTC (10:00 lab time) so the week histogram lands on the right week.

- [ ] **Step 4/5:** run test; commit `-- backend/scripts/backfill_endo_worksheets.py backend/tests/test_backfill_endo_worksheets.py`.

---

### Task 7: Changelog, gates, PR

- [ ] `CHANGELOG.md` `## Unreleased` → `### Added` entry describing the endo worksheet slice and the backfill script (mention the spec path).
- [ ] Gates: backend `pytest tests/test_worksheet_endo_prep.py tests/test_backfill_endo_worksheets.py tests/test_worksheet_analyst_stamp.py tests/test_worksheets_list_sync.py tests/test_worksheet_item_by_id.py`; frontend `npm run typecheck`, `npx eslint` + `npx prettier --check` on changed files, `npx vitest run src/lib/__tests__/endo-prep.test.ts src/lib/__tests__/endo-bench-sheet.test.ts src/components/hplc`.
- [ ] `gitnexus_detect_changes()` before the final commit; push `feat/endo-worksheet`; open the PR (no merge).
- [ ] Dry-run the backfill against prod read-only (`docker cp` the json, run without `--apply`) and record the report for the Handler.
