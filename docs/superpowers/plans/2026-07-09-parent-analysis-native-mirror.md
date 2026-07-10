# Parent Analysis Native Shadow-Mirror — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dual-write parent-sample analysis line items (result, workflow state, method/instrument) into native `lims_analyses` shadow rows at the Mk1 save sites, fail-closed so they cannot reach a certificate until a later, separately-gated read-flip.

**Architecture:** Every Mk1 endpoint that writes a parent analysis to SENAITE (A1 result, A2/A3 transition, A4 method/instrument) tees a best-effort mirror into a native `lims_analyses` shadow row after the SENAITE write succeeds. Shadow rows carry `provenance='shadow'` + sentinel `review_state='senaite_mirror'` (a valid DB state absent from every live reader's `IN(...)` allow-list), with the true SENAITE state in `mirror_review_state`. SENAITE stays system-of-record; no live reader consumes shadow rows this slice. The mirror keys off `getRequestID` + `Keyword` already present in the SENAITE response (no FE change, no extra round-trip) and runs off the event loop via `run_in_threadpool` with a fresh `SessionLocal` (never holds the request DB across the httpx call).

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (`Mapped`/`mapped_column`), Postgres in prod (SQLite in tests), hand-rolled idempotent migrations in `backend/database.py`, pytest.

## Global Constraints

- **Additive only.** SENAITE stays system-of-record; reads do NOT change behavior this slice. (`feedback_additive_only`)
- **Fail-closed.** Shadow rows use sentinel `review_state='senaite_mirror'` (added to the CHECK, ABSENT from `_LIVE_RESULT_STATES`, `_SERIES_STATES`, `_VIAL_COA_STATES`) AND `provenance='shadow'`. Invariant: `provenance='shadow'` ⟺ `review_state='senaite_mirror'`.
- **Mirror is best-effort.** Every hook: SENAITE write + `raise_for_status()` first, THEN mirror wrapped in `try/except` that `rollback()`s (nested-guarded) and `logger.warning("registry.analysis_mirror_failed …")` — **never re-raise**; a mirror failure must never fail the user's edit.
- **Async safety.** Mirror DB work runs via `await run_in_threadpool(...)` with a fresh `SessionLocal()` — never call sync DB code directly in an `async def` handler, never hold the request DB session across the httpx call. (`architecture_mk1_async_def_loop_blocking`, pool-exhaustion outage 2026-07-09)
- **Table naming:** LIMS tables use the `lims_` prefix. (`feedback_lims_table_naming`)
- **Baseline gate:** backend has known baseline failures; gate on the failure-SET diff, not zero failures. (`architecture_mk1_test_baseline_failures`)
- **No-op contract:** the mirror helper returns `False` (silent no-op) when no registry parent row exists — matches `apply_senaite_fields_to_row`.

---

### Task 1: Schema — provenance, mirror_review_state, sentinel state, provenance-aware index

**Files:**
- Modify: `backend/models.py:1219-1290` (LimsAnalysis)
- Modify: `backend/database.py:508-516` (CREATE block), `:640-641` (parent unique index), `:751` (review_state CHECK), plus the `MIGRATIONS` list
- Test: `backend/tests/test_parent_mirror_schema.py`

**Interfaces:**
- Produces: `LimsAnalysis.provenance` (str, default `'canonical'`), `LimsAnalysis.mirror_review_state` (Optional[str]); the review_state value `'senaite_mirror'`; a provenance-aware `uq_lims_analyses_parent_service_root`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_parent_mirror_schema.py
from sqlalchemy import text
from models import LimsAnalysis

def test_shadow_and_canonical_coexist_for_same_parent_service(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service  # LimsSample, AnalysisService
    canonical = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title,
        review_state="verified", provenance="canonical",
    )
    shadow = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title,
        review_state="senaite_mirror", provenance="shadow",
        mirror_review_state="to_be_verified",
    )
    db.add_all([canonical, shadow])
    db.commit()  # must NOT raise: index excludes provenance='shadow'
    rows = db.query(LimsAnalysis).filter(LimsAnalysis.lims_sample_pk == parent.id).all()
    assert {r.provenance for r in rows} == {"canonical", "shadow"}

def test_default_provenance_is_canonical(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    row = LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                       keyword=svc.keyword, title=svc.title, review_state="verified")
    db.add(row); db.commit()
    assert row.provenance == "canonical"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_parent_mirror_schema.py -v`
Expected: FAIL — `provenance`/`mirror_review_state` attributes don't exist.

- [ ] **Step 3: Add the model columns**

In `backend/models.py`, inside `class LimsAnalysis` (after `reportable_reason`, ~line 1280):

```python
    # SENAITE phase-out (parent analysis mirror): provenance discriminates a
    # promoted/native 'canonical' row from a SENAITE 'shadow' mirror row.
    provenance: Mapped[str] = mapped_column(
        Text, nullable=False, default="canonical", server_default="canonical",
        index=True,
    )
    # For shadow rows only: the true SENAITE review_state (the row's own
    # review_state is the sentinel 'senaite_mirror'). NULL on canonical rows.
    mirror_review_state: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
```

- [ ] **Step 4: Add the DDL + migration**

In `backend/database.py`:

1. CREATE block (~line 514, inside the `lims_analyses` CREATE TABLE): add columns
```sql
            provenance            TEXT NOT NULL DEFAULT 'canonical',
            mirror_review_state   TEXT,
```
2. review_state CHECK (~line 751): append `'senaite_mirror'` to the existing `IN (...)` value list.
3. Parent unique index (~line 640): add `AND provenance = 'canonical'` to the `WHERE` predicate so shadow rows never occupy the canonical slot.
4. Append idempotent migrations to the `MIGRATIONS` list (house pattern — `create_all` won't alter existing tables):
```python
    "ALTER TABLE lims_analyses ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'canonical'",
    "ALTER TABLE lims_analyses ADD COLUMN IF NOT EXISTS mirror_review_state TEXT",
    # Rebuild the review_state CHECK to include the sentinel, and the parent
    # unique index to be provenance-aware. (Follow the existing drop/recreate
    # idiom already used in this file for the review_state CHECK evolution.)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest backend/tests/test_parent_mirror_schema.py -v`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_parent_mirror_schema.py
git commit -m "feat(phaseout): lims_analyses provenance + sentinel shadow state + provenance-aware index"
```

---

### Task 2: Mirror helper — target resolution + create path

**Files:**
- Create: `backend/lims_analyses/parent_mirror.py`
- Test: `backend/tests/test_parent_mirror_helper.py`

**Interfaces:**
- Consumes: `LimsAnalysis` (Task 1), `LimsSample`, `AnalysisService`, `LimsAnalysisTransition`.
- Produces:
  - `resolve_shadow_target(db, *, sample_id: str, keyword: str) -> tuple[LimsSample, AnalysisService] | None`
  - `mirror_parent_analysis(db, *, sample_id: str, keyword: str, mirror_review_state: str | None = None, result_value: str | None = None, result_unit: str | None = None, method_id: int | None = None, instrument_id: int | None = None, is_retest: bool = False) -> bool`
  - Constant `SHADOW_STATE = "senaite_mirror"`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_parent_mirror_helper.py
from lims_analyses.parent_mirror import mirror_parent_analysis, SHADOW_STATE
from models import LimsAnalysis, LimsAnalysisTransition

def test_no_op_when_parent_not_in_registry(db):
    assert mirror_parent_analysis(db, sample_id="P-9999", keyword="ANALYTE-1-ID",
                                  mirror_review_state="to_be_verified", result_value="OK") is False

def test_creates_shadow_row_with_sentinel_state(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service  # svc.keyword == "ANALYTE-1-ID"
    ok = mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                                mirror_review_state="to_be_verified", result_value="99.2%")
    assert ok is True
    row = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").one()
    assert row.review_state == SHADOW_STATE
    assert row.mirror_review_state == "to_be_verified"
    assert row.result_value == "99.2%"
    assert row.analysis_service_id == svc.id
    tr = db.query(LimsAnalysisTransition).filter_by(analysis_id=row.id).all()
    assert len(tr) == 1  # audit row for the mirrored create
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_parent_mirror_helper.py -v`
Expected: FAIL — module `lims_analyses.parent_mirror` does not exist.

- [ ] **Step 3: Write the helper (create path only)**

```python
# backend/lims_analyses/parent_mirror.py
"""Parent analysis SENAITE→Mk1 shadow mirror (SENAITE phase-out slice).

Best-effort dual-write: mirror parent-AR analysis line items into native
lims_analyses SHADOW rows. Shadow rows carry provenance='shadow' + sentinel
review_state=SHADOW_STATE so no live COA/variance/family reader picks them up
(fail-closed). SENAITE stays system-of-record; nothing reads shadows this slice.
"""
from __future__ import annotations
from datetime import datetime
from typing import Optional, Tuple
from sqlalchemy import select
from sqlalchemy.orm import Session
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

SHADOW_STATE = "senaite_mirror"


def resolve_shadow_target(db: Session, *, sample_id: str, keyword: str
                          ) -> Optional[Tuple[LimsSample, AnalysisService]]:
    """Resolve (parent LimsSample, AnalysisService) from a SENAITE getRequestID
    + Keyword. Returns None when the parent isn't in the registry yet, or the
    service keyword is unknown — the documented no-op contract."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return None
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword == keyword)
    ).scalar_one_or_none()
    if svc is None:
        return None
    return parent, svc


def _existing_shadow(db: Session, parent_id: int, service_id: int) -> Optional[LimsAnalysis]:
    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_id,
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.provenance == "shadow",
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.retested.is_(False),
        )
    ).scalar_one_or_none()


def mirror_parent_analysis(db: Session, *, sample_id: str, keyword: str,
                           mirror_review_state: Optional[str] = None,
                           result_value: Optional[str] = None,
                           result_unit: Optional[str] = None,
                           method_id: Optional[int] = None,
                           instrument_id: Optional[int] = None,
                           is_retest: bool = False) -> bool:
    """Upsert a parent shadow row. Returns False (no-op) if the parent isn't
    registered. Caller commits. Best-effort — callers wrap in try/except."""
    target = resolve_shadow_target(db, sample_id=sample_id, keyword=keyword)
    if target is None:
        return False
    parent, svc = target

    row = _existing_shadow(db, parent.id, svc.id)
    if row is None:
        row = LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            review_state=SHADOW_STATE, provenance="shadow",
        )
        db.add(row)
        db.flush()
        db.add(LimsAnalysisTransition(
            analysis_id=row.id, from_state=None, to_state=SHADOW_STATE,
            transition_kind="auto", reason="shadow mirror: initial insert",
        ))

    if mirror_review_state is not None:
        row.mirror_review_state = mirror_review_state
    if result_value is not None:
        row.result_value = result_value
    if result_unit is not None:
        row.result_unit = result_unit
    if method_id is not None:
        row.method_id = method_id
    if instrument_id is not None:
        row.instrument_id = instrument_id
    row.updated_at = datetime.utcnow()
    db.flush()
    return True
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_parent_mirror_helper.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/parent_mirror.py backend/tests/test_parent_mirror_helper.py
git commit -m "feat(phaseout): parent analysis shadow-mirror helper (resolve + create)"
```

---

### Task 3: Mirror helper — update + retest paths

**Files:**
- Modify: `backend/lims_analyses/parent_mirror.py`
- Test: `backend/tests/test_parent_mirror_helper.py` (extend)

**Interfaces:**
- Produces: `mirror_parent_analysis(..., is_retest=True)` creates a NEW shadow row (`retest_of_id` → prior shadow) and marks the old `retested=True`, matching native retest semantics (`lims_analyses/service.py:267`).

- [ ] **Step 1: Write the failing tests**

```python
def test_second_call_updates_same_shadow_row(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="to_be_verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified")
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").all()
    assert len(rows) == 1
    assert rows[0].mirror_review_state == "verified"
    assert rows[0].result_value == "1"  # unchanged fields preserved

def test_retest_creates_new_row_and_marks_old(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="2", is_retest=True)
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").order_by(LimsAnalysis.id).all()
    assert len(rows) == 2
    assert rows[0].retested is True
    assert rows[1].retest_of_id == rows[0].id and rows[1].retested is False
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest backend/tests/test_parent_mirror_helper.py -k "update_same or retest" -v`
Expected: FAIL — `test_retest_creates_new_row_and_marks_old` (retest branch not implemented; second row collides or isn't created).

- [ ] **Step 3: Implement retest branch**

In `mirror_parent_analysis`, immediately after resolving `target` and before the create/update block, insert:

```python
    if is_retest:
        old = _existing_shadow(db, parent.id, svc.id)
        if old is not None:
            old.retested = True
            db.add(LimsAnalysisTransition(
                analysis_id=old.id, from_state=old.review_state, to_state=old.review_state,
                transition_kind="retest", reason="shadow mirror: superseded by retest",
            ))
        new = LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            review_state=SHADOW_STATE, provenance="shadow",
            mirror_review_state=mirror_review_state,
            result_value=result_value, result_unit=result_unit,
            method_id=method_id, instrument_id=instrument_id,
            retest_of_id=(old.id if old is not None else None),
        )
        db.add(new); db.flush()
        db.add(LimsAnalysisTransition(
            analysis_id=new.id, from_state=None, to_state=SHADOW_STATE,
            transition_kind="auto", reason="shadow mirror: retest insert",
        ))
        return True
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest backend/tests/test_parent_mirror_helper.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/parent_mirror.py backend/tests/test_parent_mirror_helper.py
git commit -m "feat(phaseout): shadow-mirror update + retest paths"
```

---

### Task 4: Threadpool wrapper + hook A1 (set_analysis_result)

**Files:**
- Modify: `backend/main.py:13686-13729` (`set_analysis_result`) + add a module-level helper near it
- Test: `backend/tests/test_parent_mirror_hooks.py`

**Interfaces:**
- Consumes: `mirror_parent_analysis` (Task 2/3), `SessionLocal` (from `database`), `run_in_threadpool` (from `starlette.concurrency` / `fastapi.concurrency`).
- Produces: `_mirror_parent_analysis_bg(*, sample_id, keyword, **fields) -> None` (opens its own session, commits, swallows errors) and its wiring into A1.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_parent_mirror_hooks.py — uses the app's TestClient + a mocked SENAITE
def test_set_result_writes_shadow_row(client, db, seed_parent_and_service, mock_senaite_update):
    parent, svc = seed_parent_and_service
    # SENAITE update returns the analysis item echoing getRequestID + Keyword
    mock_senaite_update(review_state="to_be_verified", keyword=svc.keyword,
                        getRequestID=parent.sample_id)
    r = client.post(f"/wizard/senaite/analyses/UID-123/result", json={"result": "42%"})
    assert r.json()["success"] is True
    row = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").one()
    assert row.result_value == "42%" and row.mirror_review_state == "to_be_verified"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest backend/tests/test_parent_mirror_hooks.py::test_set_result_writes_shadow_row -v`
Expected: FAIL — no shadow row written.

- [ ] **Step 3: Add the background wrapper (module-level, once)**

Near the analysis endpoints in `backend/main.py`:

```python
def _mirror_parent_analysis_bg(**kwargs) -> None:
    """Best-effort parent-analysis shadow mirror on its own short-lived session
    (never holds the request DB across the SENAITE HTTP call). Never raises."""
    from database import SessionLocal
    from lims_analyses.parent_mirror import mirror_parent_analysis
    db = SessionLocal()
    try:
        if mirror_parent_analysis(db, **kwargs):
            db.commit()
    except Exception as mirror_err:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:
            pass
        logger.warning("registry.analysis_mirror_failed kw=%s err=%s",
                       kwargs.get("keyword"), mirror_err)
    finally:
        db.close()
```

- [ ] **Step 4: Wire it into A1**

In `set_analysis_result`, after `resp.raise_for_status()` and building `item` (~line 13723), before `return`:

```python
            from fastapi.concurrency import run_in_threadpool
            _sid = item.get("getRequestID") or item.get("RequestID")
            _kw = item.get("Keyword")
            if _sid and _kw:
                await run_in_threadpool(
                    _mirror_parent_analysis_bg,
                    sample_id=_sid, keyword=_kw,
                    mirror_review_state=item.get("review_state"),
                    result_value=req.result,
                )
```

- [ ] **Step 5: Run to verify pass**

Run: `pytest backend/tests/test_parent_mirror_hooks.py::test_set_result_writes_shadow_row -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_parent_mirror_hooks.py
git commit -m "feat(phaseout): mirror hook on A1 set_analysis_result"
```

---

### Task 5: Hook A2/A3 (transition_analysis — state mirror + retest)

**Files:**
- Modify: `backend/main.py:13836-13970` (`transition_analysis`, after the silent-rejection check)
- Test: `backend/tests/test_parent_mirror_hooks.py` (extend)

**Interfaces:**
- Consumes: `_mirror_parent_analysis_bg` (Task 4), `EXPECTED_POST_STATES` (main.py:13827).

- [ ] **Step 1: Write the failing tests**

```python
def test_transition_verify_mirrors_state(client, db, seed_parent_and_service, mock_senaite_update):
    parent, svc = seed_parent_and_service
    mock_senaite_update(review_state="verified", keyword=svc.keyword, getRequestID=parent.sample_id)
    client.post("/wizard/senaite/analyses/UID-1/transition", json={"transition": "verify"})
    row = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").one()
    assert row.mirror_review_state == "verified"

def test_transition_retest_mirrors_new_row(client, db, seed_parent_and_service, mock_senaite_update):
    parent, svc = seed_parent_and_service
    mock_senaite_update(review_state="verified", keyword=svc.keyword, getRequestID=parent.sample_id)
    client.post("/wizard/senaite/analyses/UID-1/transition", json={"transition": "verify"})
    client.post("/wizard/senaite/analyses/UID-1/transition", json={"transition": "retest"})
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").all()
    assert len(rows) == 2 and any(r.retested for r in rows)
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest backend/tests/test_parent_mirror_hooks.py -k transition -v`
Expected: FAIL.

- [ ] **Step 3: Wire the mirror into A2/A3**

In `transition_analysis`, after the `actual_state == expected_state` validation passes (i.e. the transition was NOT silently rejected), before returning success:

```python
            from fastapi.concurrency import run_in_threadpool
            _sid = item.get("getRequestID") or item.get("RequestID")
            if _sid and keyword:
                await run_in_threadpool(
                    _mirror_parent_analysis_bg,
                    sample_id=_sid, keyword=keyword,
                    mirror_review_state=actual_state,
                    is_retest=(req.transition == "retest"),
                )
```

(`keyword` and `actual_state` are already in scope from the existing handler.)

- [ ] **Step 4: Run to verify pass**

Run: `pytest backend/tests/test_parent_mirror_hooks.py -k transition -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_parent_mirror_hooks.py
git commit -m "feat(phaseout): mirror hook on A2/A3 transition_analysis (state + retest)"
```

---

### Task 6: Hook A4 (set_analysis_method_instrument — with SENAITE-uid resolution)

**Files:**
- Modify: `backend/main.py:13756-13818` (`set_analysis_method_instrument`)
- Modify: `backend/lims_analyses/parent_mirror.py` (add uid→id resolvers)
- Test: `backend/tests/test_parent_mirror_hooks.py` (extend)

**Interfaces:**
- Produces: `resolve_method_id(db, senaite_uid) -> int | None`, `resolve_instrument_id(db, senaite_uid) -> int | None` in `parent_mirror.py`, resolving via `HPLCMethod.senaite_uid` / `Instrument.senaite_uid` (models.py:170 / :132).

- [ ] **Step 1: Write the failing test**

```python
def test_method_instrument_mirrors_resolved_ids(client, db, seed_parent_and_service,
                                                 seed_method_instrument, mock_senaite_update):
    parent, svc = seed_parent_and_service
    method, instrument = seed_method_instrument  # each has .senaite_uid
    mock_senaite_update(review_state="to_be_verified", keyword=svc.keyword, getRequestID=parent.sample_id)
    client.post("/wizard/senaite/analyses/UID-1/method-instrument",
                json={"method_uid": method.senaite_uid, "instrument_uid": instrument.senaite_uid})
    row = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").one()
    assert row.method_id == method.id and row.instrument_id == instrument.id
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest backend/tests/test_parent_mirror_hooks.py -k method_instrument -v`
Expected: FAIL.

- [ ] **Step 3: Add resolvers to parent_mirror.py**

```python
def resolve_method_id(db, senaite_uid):
    if not senaite_uid:
        return None
    from models import HPLCMethod
    m = db.execute(select(HPLCMethod).where(HPLCMethod.senaite_uid == senaite_uid)).scalar_one_or_none()
    return m.id if m else None

def resolve_instrument_id(db, senaite_uid):
    if not senaite_uid:
        return None
    from models import Instrument
    i = db.execute(select(Instrument).where(Instrument.senaite_uid == senaite_uid)).scalar_one_or_none()
    return i.id if i else None
```

- [ ] **Step 4: Wire into A4**

In `set_analysis_method_instrument`, after `resp.raise_for_status()` and building `item`, before return. Resolve the ids inside the bg wrapper to keep DB work off the loop — pass the raw uids through and resolve in `_mirror_parent_analysis_bg` by extending it to accept `method_uid`/`instrument_uid` and call the resolvers before `mirror_parent_analysis`. Minimal wiring in the handler:

```python
            from fastapi.concurrency import run_in_threadpool
            _sid = item.get("getRequestID") or item.get("RequestID")
            _kw = item.get("Keyword")
            if _sid and _kw:
                await run_in_threadpool(
                    _mirror_parent_analysis_bg,
                    sample_id=_sid, keyword=_kw,
                    mirror_review_state=item.get("review_state"),
                    method_uid=req.method_uid, instrument_uid=req.instrument_uid,
                )
```

Extend `_mirror_parent_analysis_bg` to pop `method_uid`/`instrument_uid`, resolve them via the new resolvers on its own session, and pass `method_id`/`instrument_id` into `mirror_parent_analysis`.

- [ ] **Step 5: Run to verify pass**

Run: `pytest backend/tests/test_parent_mirror_hooks.py -k method_instrument -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/lims_analyses/parent_mirror.py backend/tests/test_parent_mirror_hooks.py
git commit -m "feat(phaseout): mirror hook on A4 method/instrument with senaite_uid resolution"
```

---

### Task 7: Read-path provenance filters + fail-closed / COA shadow-diff proof

**Files:**
- Modify: `backend/families/service.py:64-68` (the unfiltered reader — MANDATORY filter)
- Modify (defense-in-depth): `backend/coa/source_resolver.py:267-274`, `backend/coa/variance_series.py:76-84`, `backend/lims_analyses/service.py` parent-line-states query (~1892)
- Test: `backend/tests/test_parent_mirror_fail_closed.py`

**Interfaces:**
- Consumes: shadow rows produced by Tasks 4–6. No new interface; adds `LimsAnalysis.provenance == "canonical"` to each parent-FK read.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_parent_mirror_fail_closed.py
def test_family_breakdown_ignores_shadow_rows(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    # a canonical verified row + a shadow row for a DIFFERENT keyword
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title, review_state="verified",
                        provenance="canonical", reportable=True))
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword="ANALYTE-2-ID", title="x", review_state="senaite_mirror",
                        provenance="shadow", mirror_review_state="to_be_verified", reportable=True))
    db.commit()
    from families.service import _gather_analytes
    out = _gather_analytes(db, parent, senaite_parent_payload=[])
    assert "ANALYTE-2-ID" not in out  # shadow keyword must not appear

def test_coa_source_resolver_excludes_shadow(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title, review_state="senaite_mirror",
                        provenance="shadow", mirror_review_state="verified",
                        result_value="99%", reportable=True))
    db.commit()
    from coa.source_resolver import resolve_from_native_parent  # adjust to real fn name
    decisions = resolve_from_native_parent(db, parent)
    assert decisions == {} or svc.keyword not in decisions
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest backend/tests/test_parent_mirror_fail_closed.py -v`
Expected: `test_family_breakdown_ignores_shadow_rows` FAILS (families/service has no filter); the COA one already passes via the sentinel-state IN-filter — confirming fail-closed, but add the explicit filter anyway.

- [ ] **Step 3: Add the filters**

- `backend/families/service.py:64` — add `LimsAnalysis.provenance == "canonical",` to the `where(...)`.
- `backend/coa/source_resolver.py:267`, `backend/coa/variance_series.py:76`, and the parent-line-states query in `backend/lims_analyses/service.py` — add the same clause (defense-in-depth; already excluded by state).

- [ ] **Step 4: Run to verify pass + run the full COA/variance/family suites**

Run:
```
pytest backend/tests/test_parent_mirror_fail_closed.py -v
pytest backend/tests/ -k "coa or variance or families or source_resolver" -q
```
Expected: fail-closed tests PASS; the COA/variance/family suites show **no new failures vs. baseline** (the shadow-diff proof: shadow rows present must not change these outputs).

- [ ] **Step 5: Commit**

```bash
git add backend/families/service.py backend/coa/source_resolver.py backend/coa/variance_series.py backend/lims_analyses/service.py backend/tests/test_parent_mirror_fail_closed.py
git commit -m "feat(phaseout): fail-closed provenance filters on parent-analysis readers"
```

---

### Task 8: Extend the partial mirrors (A5 replace-analyte, A6 publish, A7 add/remove)

**Files:**
- Modify: `backend/main.py` — `replace_analyte` (~8849), `publish_sample_coa` (~9965), `add_sample_analysis` (~8611) / `remove_sample_analysis` (~8718)
- Test: `backend/tests/test_parent_mirror_hooks.py` (extend)

**Interfaces:**
- Consumes: `_mirror_parent_analysis_bg` / `mirror_parent_analysis`. A7 remove marks the shadow row `review_state`→ (via `mirror_review_state='rejected'`); A6 publish sets `mirror_review_state='published'` on existing shadow rows for the AR; A5 replace re-points the shadow row's service/keyword for the swapped slot.

- [ ] **Step 1: Write failing tests** — one per site asserting the shadow row reflects the composition/publish change (e.g. after publish, the parent's shadow rows carry `mirror_review_state='published'`; after remove, the removed keyword's shadow row is marked rejected; after add, a shadow row exists for the new keyword once a result is entered).

```python
def test_publish_marks_shadow_rows_published(client, db, seed_parent_with_shadow, mock_senaite_publish):
    parent = seed_parent_with_shadow  # has >=1 shadow row in mirror_review_state='verified'
    client.post(f"/wizard/senaite/samples/{parent.sample_id}/publish-coa", json={})
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").all()
    assert rows and all(r.mirror_review_state == "published" for r in rows)
```

- [ ] **Step 2: Run to verify failure.** Run: `pytest backend/tests/test_parent_mirror_hooks.py -k "publish or remove or add or replace" -v` → FAIL.

- [ ] **Step 3: Wire each site** to call `_mirror_parent_analysis_bg` after its existing SENAITE write succeeds, using the site's already-resolved `sample_id`/`keyword`(s). For publish (AR-level), iterate the parent's existing shadow rows and set `mirror_review_state='published'` (add a small helper `mark_parent_shadows_published(db, sample_id)` in `parent_mirror.py`). For A7 add/remove, ride the existing `cascade_parent_add_to_vials` / `cascade_parent_remove_from_vials` call sites (no IS change).

- [ ] **Step 4: Run to verify pass.** Run the `-k "publish or remove or add or replace"` suite → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/lims_analyses/parent_mirror.py backend/tests/test_parent_mirror_hooks.py
git commit -m "feat(phaseout): extend A5/A6/A7 to stamp parent shadow rows"
```

---

## Deferred to later slices (NOT in this plan)

- **State-system slice:** flip provenance semantics so shadow rows become read-authoritative (`review_state` ← `mirror_review_state`), take ownership of the native state machine, re-point the readers off `provenance='canonical'`, retire the sentinel.
- **Read-flip:** point the FE parent-analyses overlay off its keyword-join onto native rows.
- **Reconcile backstop:** a bounded per-parent SENAITE analysis pull to heal SENAITE-UI-origin edits (only needed once reads depend on the shadow).
- **Integration Service:** no change this slice (A7 rides Mk1-side cascades).

## Self-review notes

- **Spec coverage:** schema (Task 1) ✓; write hooks A1/A2/A4 (Tasks 4–6) ✓; helper + retest (Tasks 2–3) ✓; read audit + fail-closed + COA-diff proof (Task 7) ✓; A5–A7 (Task 8) ✓; non-goals fenced ✓.
- **Async safety:** every hook uses `run_in_threadpool` + fresh `SessionLocal` (Global Constraints) — never the request `db` across httpx.
- **Fail-closed:** Task 1 sentinel state + Task 7 filters; Task 7 Step 4 is the shadow-diff proof gate.
- **Fixtures assumed:** `db`, `client`, `seed_parent_and_service` (returns `(LimsSample, AnalysisService)` with `keyword="ANALYTE-1-ID"`), `seed_method_instrument`, `mock_senaite_update`/`mock_senaite_publish` (patch the outbound httpx to echo `getRequestID`/`Keyword`/`review_state`). Confirm/author these in `backend/tests/conftest.py` following existing SENAITE-mock patterns before Task 4.
