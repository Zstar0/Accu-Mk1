# Analysis Amendment Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture before/after values for every tracked-field change on `lims_analyses` rows into the append-only `lims_analysis_transitions` audit log, and surface entries/amendments in the sample-details Activity flyout (ISO 17025 §7.5.2).

**Architecture:** One nullable JSONB `details` column on `lims_analysis_transitions` with shape `{"changed": {field: {before, after}}}`, populated by a snapshot/diff helper at all ten transition-write sites in `lims_analyses/service.py`. A new service function feeds the federated activity endpoint two curated event types (`result_entered`, `analysis_amended`); the flyout renders them via its existing style map. Logic never reads `details` — zero behavior change to state machine, readers, or COA.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 mapped_column (Postgres JSONB / SQLite JSON variant), pytest (in-memory SQLite fixtures), React + vitest for the flyout.

**Spec:** `docs/superpowers/specs/2026-08-07-analysis-amendment-audit-design.md` (committed alongside this plan's checkout; read it first).

## Global Constraints

- **Base commit:** branch from `01e01c1` (tip of `feat/native-parent-placeholders`) — this slice edits the same `lims_analyses/service.py`. All line numbers below are against that commit.
- **Worktree (execution time, via superpowers:using-git-worktrees):**
  `cd C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1 && git worktree add C:\tmp\Accu-Mk1-amendment-audit -b feat/analysis-amendment-audit 01e01c1` (worktrees share the object store; the sha resolves from the main checkout).
- **Additive only.** No existing column, index, state, or reader changes. A failing pre-existing test defaults to "stale test" — investigate, never "fix" production behavior without sign-off.
- **Backend test baseline is a failure SET, never a count:** 64 failed / 2222 passed / 40 skipped at the base commit. Judge by diffing sorted FAILED ids, base vs tip (Task 7). Known noise: `test_clickup_task_retry.py` is flaky; `test_registry_inbox.py::test_route_mk1_source_works_without_senaite` is pre-existing red.
- **Python:** `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest`, run from the worktree's `backend/`.
- **Frontend is npm only** (never pnpm). First FE task run needs `npm install` in the worktree.
- **Exempt from capture (Handler ruling 2026-08-07, do NOT touch):** `lims_analyses/parent_mirror.py`, `workflow/observer.py`, the SENAITE result proxy in `main.py` (~`:15030`). These write SENAITE-mirror (`provenance='shadow'`) values whose history lives in SENAITE until the phase-out.
- **`details` values must be JSON-serializable** — the tracked field set contains only str/int/bool/None by construction; never add a datetime to it.
- **Commit per task in the worktree. NEVER push** (standing rule; Handler pushes).

## File Structure

| File | Responsibility in this slice |
|---|---|
| `backend/models.py` | `LimsAnalysisTransition.details` column + shape-contract docstring |
| `backend/database.py` | fresh-install DDL column + idempotent `ALTER TABLE` migration |
| `backend/lims_analyses/service.py` | `TRACKED_FIELDS`, `_snapshot`, `_deltas`; `details=` at all 10 write sites; new `list_analysis_change_events_for_parent` |
| `backend/lims_analyses/schemas.py` | `TransitionInfo.details` passthrough |
| `backend/main.py` | one new source block in `get_sample_activity` |
| `backend/tests/test_amendment_audit.py` | all new backend tests (one file) |
| `src/components/senaite/SampleActivityLog.tsx` | 2 bucket-map + 2 icon-map entries |
| `src/test/sample-activity-log.test.tsx` | FE render cases for the 2 new events |

---

### Task 1: `details` column — model, fresh DDL, migration

**Files:**
- Modify: `backend/models.py:1737-1772` (class `LimsAnalysisTransition`)
- Modify: `backend/database.py` — fresh-install `CREATE TABLE lims_analysis_transitions` block (near the `transition_kind` CHECK at `:632`) AND the `_run_migrations()` statement list (follow the pattern of commit `a5cb06f`, which added `uq_lims_analyses_parent_service_ordered` there)
- Test: `backend/tests/test_amendment_audit.py` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `LimsAnalysisTransition.details: Optional[dict]` — every later task depends on this column existing in both engines.

- [ ] **Step 1: Write the failing test**

```python
"""Amendment audit (spec 2026-08-07): before/after capture on
lims_analysis_transitions.details, plus the activity-log blend.

Fixtures follow tests/test_parent_placeholders.py: self-contained in-memory
SQLite; models import registers everything on Base.metadata before
create_all().
"""
from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401 — registers models on Base.metadata
from database import Base
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
    User,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


def test_details_column_round_trips_a_dict(db):
    """The column exists in the SQLite fixture engine (JSON variant) and
    stores/returns a nested dict unchanged."""
    parent = LimsSample(sample_id="AA-P1", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    svc = AnalysisService(title="T", keyword="KW", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="KW", title="T",
    )
    db.add(row)
    db.commit()

    payload = {"changed": {"result_value": {"before": None, "after": "1.0"}}}
    db.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state=None, to_state="unassigned",
        transition_kind="auto", details=payload,
    ))
    db.commit()

    stored = db.execute(select(LimsAnalysisTransition)).scalars().one()
    assert stored.details == payload


def test_details_is_nullable(db):
    """Grandfathered rows carry NULL — the model must not default it."""
    parent = LimsSample(sample_id="AA-P2", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    svc = AnalysisService(title="T2", keyword="KW2", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="KW2", title="T2",
    )
    db.add(row)
    db.commit()
    db.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state=None, to_state="unassigned",
        transition_kind="auto",
    ))
    db.commit()
    assert db.execute(select(LimsAnalysisTransition)).scalars().one().details is None
```

- [ ] **Step 2: Run to verify both fail**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v` (from `backend/`)
Expected: FAIL — `TypeError: 'details' is an invalid keyword argument for LimsAnalysisTransition`

- [ ] **Step 3: Add the model column**

In `models.py`, class `LimsAnalysisTransition`, after the `occurred_at` column (`:1760-1762`), add:

```python
    # Amendment audit (spec 2026-08-07): before/after values for tracked
    # fields changed by the mutation that wrote this row. Shape contract:
    #   {"changed": {"<field>": {"before": <raw>, "after": <raw>}}}
    # `changed` holds ONLY fields whose value differs; a pure state move
    # writes {"changed": {}}. NULL means "row predates capture" — never
    # write NULL from new code. review_state is NOT in `changed` (it lives
    # in the typed from_state/to_state columns). Enforced by tests, not
    # CHECKs (last-boot-wins class).
    details: Mapped[Optional[dict]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )
```

(`JSONB`/`JSON` are already imported in models.py — `LimsSubSampleEvent.details` at `:1927` uses the identical idiom.)

- [ ] **Step 4: Add fresh-DDL + migration in database.py**

In the fresh-install `CREATE TABLE lims_analysis_transitions` DDL block (the one carrying the `transition_kind` CHECK at `:632`), add a `details JSONB` column line. Then append to `_run_migrations()`'s statement list (same list commit `a5cb06f` extended):

```python
        # Amendment audit (spec 2026-08-07): before/after capture. Nullable,
        # no default, no backfill — NULL = pre-slice row, by contract.
        "ALTER TABLE lims_analysis_transitions ADD COLUMN IF NOT EXISTS details JSONB",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v`
Expected: 2 PASS

- [ ] **Step 6: Sanity-check neighbors and commit**

Run: `.venv python -m pytest tests/test_parent_placeholders.py -q`
Expected: 16 passed.

```bash
git add backend/models.py backend/database.py backend/tests/test_amendment_audit.py
git commit -m "feat(audit): details JSONB column on lims_analysis_transitions"
```

---

### Task 2: snapshot/diff helper + capture at the `apply_transition` choke point

**Files:**
- Modify: `backend/lims_analyses/service.py` — module level (near the top, after imports) + `apply_transition` (`:241-434`; transition writes at `:317`, `:329`, `:424`)
- Test: `backend/tests/test_amendment_audit.py`

**Interfaces:**
- Consumes: `LimsAnalysisTransition.details` (Task 1).
- Produces: `TRACKED_FIELDS: tuple[str, ...]`, `_snapshot(row) -> dict`, `_deltas(before: dict, row) -> dict` — Tasks 3 and 5 call these exact names. `_deltas` ALWAYS returns `{"changed": {...}}` (possibly empty), never None.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_amendment_audit.py`:

```python
from lims_analyses.service import apply_transition


@pytest.fixture
def vial_row(db):
    """A vial-tier analysis in 'unassigned', ready for bench transitions."""
    parent = LimsSample(sample_id="AA-P3", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    vial = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="u1",
        sample_id="AA-P3-S01", vial_sequence=1,
    )
    db.add(vial)
    db.commit()
    svc = AnalysisService(title="Sterility USP<71>", keyword="STERILITY_USP71", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
        keyword="STERILITY_USP71", title="Sterility USP<71>",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _transitions_for(db, analysis_id):
    return db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == analysis_id)
        .order_by(LimsAnalysisTransition.id)
    ).scalars().all()


def test_submit_captures_first_entry(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["result_value"] == {"before": None, "after": "0.92"}


def test_self_edge_correction_captures_before_and_after(db, vial_row):
    """THE §7.5.2 test: in-place correction keeps the prior value."""
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.95", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.from_state == "to_be_verified" and t.to_state == "to_be_verified"
    assert t.details["changed"]["result_value"] == {"before": "0.92", "after": "0.95"}


def test_pure_state_move_writes_empty_changed_not_null(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="assign", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details == {"changed": {}}


def test_reset_captures_cleared_fields(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="assign", user_id=1)
    vial_row.result_value = "draft"   # draft value, as the bench UI writes it
    vial_row.method_id = None
    db.commit()
    apply_transition(db, analysis_id=vial_row.id, kind="reset", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["result_value"] == {"before": "draft", "after": None}


def test_retest_flags_old_row_and_seeds_new(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    new_row = apply_transition(db, analysis_id=vial_row.id, kind="retest", user_id=1)
    old_last = _transitions_for(db, vial_row.id)[-1]
    assert old_last.details["changed"]["retested"] == {"before": False, "after": True}
    new_first = _transitions_for(db, new_row.id)[0]
    assert new_first.details == {"changed": {}}
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v -k "submit or self_edge or pure_state or reset or retest_flags"`
Expected: FAIL — `t.details` is None (no capture yet).

- [ ] **Step 3: Implement helper + choke-point capture**

In `lims_analyses/service.py`, module level (near the other module constants):

```python
# ─── Amendment audit (spec 2026-08-07) ───────────────────────────────────────
# Fields whose changes are captured as before/after into
# lims_analysis_transitions.details. Values must stay JSON-serializable
# (str/int/bool/None) — never add a datetime here; per-state timestamps are
# derivable from the transition rows themselves.
TRACKED_FIELDS = (
    "result_value", "result_unit", "method_id", "instrument_id",
    "reportable", "reportable_reason", "analyst_user_id", "retested",
)


def _snapshot(row) -> dict:
    return {f: getattr(row, f) for f in TRACKED_FIELDS}


def _deltas(before: dict, row) -> dict:
    """{"changed": {field: {before, after}}} for tracked fields that differ.
    Always returns the envelope (possibly empty changed) — NULL details is
    reserved for rows that predate capture."""
    after = _snapshot(row)
    return {"changed": {
        f: {"before": before[f], "after": after[f]}
        for f in TRACKED_FIELDS if before[f] != after[f]
    }}
```

In `apply_transition`:
1. Immediately after `from_state = row.review_state` (`:260`), add `before = _snapshot(row)`.
2. Retest branch — new-row audit (`:317`): add `details={"changed": {}},` to the constructor. Old-row audit (`:329`): add `details=_deltas(before, row),` (captures the `retested` flip; place the construction AFTER `row.retested = True` at `:327`, which is already the order).
3. Main-path audit (`:424`): add `details=_deltas(before, row),` to the constructor (it already sits after every branch mutation).

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v`
Expected: all PASS (7 so far).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/service.py backend/tests/test_amendment_audit.py
git commit -m "feat(audit): capture before/after deltas at the apply_transition choke point"
```

---

### Task 3: remaining write sites + the grep guard

**Files:**
- Modify: `backend/lims_analyses/service.py` — `create_analysis` (`:222`), `set_reportable` (`:528`), `set_method_instrument` (`:566`), `promote_to_parent` supersession (`:824`), parent insert (`:879`), source→promoted loop (`:912`), un-promote in `cascade_parent_retest_to_sources` (`:1492`) and in the vial source-retest path (`:1760`)
- Test: `backend/tests/test_amendment_audit.py`

**Interfaces:**
- Consumes: `_snapshot`/`_deltas`/`TRACKED_FIELDS` (Task 2 — exact names).
- Produces: every `LimsAnalysisTransition(` construction in `service.py` passes `details=`. Task 5's emission rule (`changed` non-empty) relies on promote/supersession rows carrying `{"changed": {}}`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_amendment_audit.py`:

```python
import re
from pathlib import Path

from lims_analyses.service import (
    promote_to_parent,
    set_method_instrument,
    set_reportable,
)


def test_set_method_instrument_captures_old_and_new(db, vial_row):
    set_method_instrument(db, analysis_id=vial_row.id, method_id=3,
                          instrument_id=None, user_id=1)
    set_method_instrument(db, analysis_id=vial_row.id, method_id=5,
                          instrument_id=None, user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["method_id"] == {"before": 3, "after": 5}


def test_set_reportable_captures_flag_and_reason(db, vial_row):
    set_reportable(db, analysis_id=vial_row.id, reportable=False,
                   reason="client withdrew", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["reportable"] == {"before": True, "after": False}
    assert t.details["changed"]["reportable_reason"]["after"] == "client withdrew"


def test_promote_rows_carry_empty_changed(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="Not Detected", user_id=1)
    parent_row, _ = promote_to_parent(
        db, keyword="STERILITY_USP71", result_value="Not Detected",
        result_unit=None, method_id=None, instrument_id=None,
        sources=[{"analysis_id": vial_row.id, "contribution_kind": "chosen"}],
        user_id=1,
    )
    # source row's to->promoted transition: state-only
    src_last = _transitions_for(db, vial_row.id)[-1]
    assert src_last.to_state == "promoted" and src_last.details == {"changed": {}}
    # new parent row's initial transition: state-only
    parent_first = _transitions_for(db, parent_row.id)[0]
    assert parent_first.details == {"changed": {}}


def test_unpromote_captures_cleared_parent_value(db, vial_row):
    from lims_analyses.service import vial_source_retest
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="Not Detected", user_id=1)
    parent_row, _ = promote_to_parent(
        db, keyword="STERILITY_USP71", result_value="Not Detected",
        result_unit="Pos/Neg", method_id=None, instrument_id=None,
        sources=[{"analysis_id": vial_row.id, "contribution_kind": "chosen"}],
        user_id=1,
    )
    vial_source_retest(db, analysis_id=vial_row.id, user_id=1)
    t = _transitions_for(db, parent_row.id)[-1]
    assert t.to_state == "retracted"
    assert t.details["changed"]["result_value"] == {"before": "Not Detected", "after": None}
    assert t.details["changed"]["result_unit"] == {"before": "Pos/Neg", "after": None}


def test_grep_guard_every_construction_passes_details():
    """No future write site may regress to value-blind. Forward-scan every
    LimsAnalysisTransition( construction in service.py and require a details=
    kwarg inside its balanced parens."""
    src = Path(__file__).resolve().parents[1].joinpath(
        "lims_analyses", "service.py").read_text(encoding="utf-8")
    sites = [m.start() for m in re.finditer(r"LimsAnalysisTransition\(", src)]
    assert sites, "expected construction sites in service.py"
    for pos in sites:
        depth, i = 0, src.index("(", pos)
        start = i
        while True:
            if src[i] == "(":
                depth += 1
            elif src[i] == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        assert "details=" in src[start:i], (
            f"LimsAnalysisTransition at offset {pos} lacks details= — "
            "amendment audit regression"
        )
```

NOTE for the implementer: `vial_source_retest` is the vial-tier source-retest entry point around `:1700-1780` — verify the exact public function name at the un-promote site at `:1760` before writing the test import, and use that name. If the sterility flow requires extra setup the test fails loudly — extend the fixture, do not weaken the assertion.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v -k "method_instrument or reportable_captures or promote_rows or unpromote or grep_guard"`
Expected: grep guard FAILS listing the un-instrumented sites; capture tests FAIL on `details` None.

- [ ] **Step 3: Instrument the seven remaining sites**

Idiom at each: `before = _snapshot(<row>)` immediately before the first mutation of that row, `details=_deltas(before, <row>)` in the constructor. Literal `details={"changed": {}}` where the row was just created (no before exists):

| Site | details |
|---|---|
| `create_analysis` `:222` | `details={"changed": {}}` (fresh row) |
| `set_reportable` `:528` | snapshot before the flag/reason writes at `:524-525` |
| `set_method_instrument` `:566` | snapshot before the id writes at `:562-563` |
| supersession `:824` | snapshot `old_parent` before `review_state`/`updated_at` writes (yields `{}` today — future-proof) |
| parent insert `:879` | `details={"changed": {}}` (fresh row) |
| source→promoted loop `:912` | snapshot `src` per-iteration before `src.review_state = "promoted"` |
| un-promote `:1492` | snapshot `parent_analysis` before the state/value clears |
| un-promote `:1760` | snapshot `parent` before the state/value clears |

- [ ] **Step 4: Run the whole file**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v`
Expected: all PASS, including the grep guard.

- [ ] **Step 5: Neighbor sweep + commit**

Run: `.venv python -m pytest tests/test_parent_placeholders.py tests/test_registry_inbox.py -q`
Expected: placeholders 16 passed; registry inbox = 3 passed + the known pre-existing failure, nothing new.

```bash
git add backend/lims_analyses/service.py backend/tests/test_amendment_audit.py
git commit -m "feat(audit): before/after capture at all remaining transition write sites + grep guard"
```

---

### Task 4: read surface — `TransitionInfo.details`

**Files:**
- Modify: `backend/lims_analyses/schemas.py:138-148` (class `TransitionInfo`)
- Test: `backend/tests/test_amendment_audit.py`

**Interfaces:**
- Consumes: Task 1's column.
- Produces: `TransitionInfo.details: Optional[dict] = None` — serialized on `GET /api/lims-analyses/{id}` via `AnalysisWithTransitions` (`schemas.py:179`).

- [ ] **Step 1: Write the failing test**

```python
def test_transition_info_serializes_details_and_tolerates_null(db, vial_row):
    from lims_analyses.schemas import TransitionInfo
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="1", user_id=1)
    captured = _transitions_for(db, vial_row.id)[-1]
    info = TransitionInfo.model_validate(captured)
    assert info.details["changed"]["result_value"]["after"] == "1"

    # grandfathered NULL row
    db.add(LimsAnalysisTransition(
        analysis_id=vial_row.id, from_state=None, to_state="unassigned",
        transition_kind="auto",
    ))
    db.commit()
    legacy = _transitions_for(db, vial_row.id)[-1]
    assert TransitionInfo.model_validate(legacy).details is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv python -m pytest tests/test_amendment_audit.py::test_transition_info_serializes_details_and_tolerates_null -v`
Expected: FAIL — `TransitionInfo` has no field `details` (ValidationError or AttributeError on access).

- [ ] **Step 3: Add the field**

In `schemas.py` class `TransitionInfo` (`:138`), after `occurred_at`:

```python
    # Amendment audit: {"changed": {field: {before, after}}}; None on rows
    # that predate capture.
    details: Optional[dict] = None
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/schemas.py backend/tests/test_amendment_audit.py
git commit -m "feat(audit): expose transition details on the GET-by-id audit chain"
```

---

### Task 5: activity-log source — `list_analysis_change_events_for_parent`

**Files:**
- Modify: `backend/lims_analyses/service.py` — new function directly after `list_variance_verifications_for_parent` (which ends ~`:1360`)
- Modify: `backend/main.py` — one block in `get_sample_activity`, immediately after the variance-verifications block (~`:1060`)
- Test: `backend/tests/test_amendment_audit.py`

**Interfaces:**
- Consumes: `details` column (Task 1), populated write sites (Tasks 2-3).
- Produces: `list_analysis_change_events_for_parent(db, parent_sample_id: str) -> list[dict]`, each dict `{timestamp, event, label, details, source}` matching the activity endpoint's event shape exactly (see `main.py:923-931` for the shape convention). Task 6's FE renders events `result_entered` and `analysis_amended`.

- [ ] **Step 1: Write the failing tests**

```python
def test_activity_events_entry_then_amendment(db, vial_row):
    from lims_analyses.service import list_analysis_change_events_for_parent
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.95", user_id=1)
    events = list_analysis_change_events_for_parent(db, "AA-P3")
    assert [e["event"] for e in events] == ["result_entered", "analysis_amended"]
    entered, amended = events
    assert "Sterility USP<71>" in entered["label"]
    assert "AA-P3-S01" in entered["label"]          # vial context
    assert "0.92 → 0.95" in amended["label"]        # before → after inline
    assert amended["details"]["changed"]["result_value"]["before"] == "0.92"
    assert amended["source"] == "lims_analysis_transitions"


def test_activity_skips_state_only_and_null_details(db, vial_row):
    from lims_analyses.service import list_analysis_change_events_for_parent
    apply_transition(db, analysis_id=vial_row.id, kind="assign", user_id=1)  # {"changed": {}}
    db.add(LimsAnalysisTransition(                                            # grandfathered NULL
        analysis_id=vial_row.id, from_state=None, to_state="unassigned",
        transition_kind="auto",
    ))
    db.commit()
    assert list_analysis_change_events_for_parent(db, "AA-P3") == []


def test_activity_non_result_change_is_amended(db, vial_row):
    from lims_analyses.service import list_analysis_change_events_for_parent
    set_method_instrument(db, analysis_id=vial_row.id, method_id=3,
                          instrument_id=None, user_id=1)
    events = list_analysis_change_events_for_parent(db, "AA-P3")
    assert len(events) == 1 and events[0]["event"] == "analysis_amended"
    assert "method_id" in events[0]["label"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v -k activity`
Expected: FAIL — ImportError (`list_analysis_change_events_for_parent` not defined).

- [ ] **Step 3: Implement the service function**

Directly after `list_variance_verifications_for_parent` in `service.py`:

```python
def list_analysis_change_events_for_parent(
    db: Session,
    parent_sample_id: str,
) -> list[dict]:
    """Amendment-audit events for the federated sample activity log
    (spec 2026-08-07 §2.6).

    Emits ONLY transitions whose details["changed"] is non-empty — the
    change history. State-only rows ({"changed": {}}) are skipped (promote /
    verify / variance already have richer dedicated events in the timeline);
    NULL-details rows predate capture and have nothing to render.

    Two event types:
      result_entered   — result_value went None -> value and nothing outside
                         {result_value, result_unit} changed
      analysis_amended — every other non-empty change (corrections,
                         method/instrument, reportable, un-promote clears)
    """
    from models import LimsAnalysisTransition, LimsSample, LimsSubSample, User

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return []

    vials = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
    ).scalars().all()
    vial_by_id = {v.id: v for v in vials}

    host_filter = LimsAnalysis.lims_sample_pk == parent.id
    if vial_by_id:
        host_filter = host_filter | LimsAnalysis.lims_sub_sample_pk.in_(
            list(vial_by_id.keys())
        )

    rows = db.execute(
        select(LimsAnalysisTransition, LimsAnalysis)
        .join(LimsAnalysis, LimsAnalysisTransition.analysis_id == LimsAnalysis.id)
        .where(host_filter, LimsAnalysisTransition.details.isnot(None))
        .order_by(LimsAnalysisTransition.occurred_at)
    ).all()

    events: list[dict] = []
    for t, a in rows:
        changed = (t.details or {}).get("changed") or {}
        if not changed:
            continue  # state-only move — dedicated events cover these

        by_email = None
        if t.user_id:
            u = db.get(User, t.user_id)
            by_email = u.email if u else None

        vial = vial_by_id.get(a.lims_sub_sample_pk)
        where = f" ({vial.sample_id})" if vial else ""

        rv = changed.get("result_value")
        only_result = set(changed) <= {"result_value", "result_unit"}
        if rv and rv["before"] is None and rv["after"] is not None and only_result:
            event = "result_entered"
            label = f"Result entered — {a.title}: {rv['after']}{where}"
        else:
            event = "analysis_amended"
            frags = ", ".join(
                f"{f} {c['before']} → {c['after']}" if f != "result_value"
                else f"{c['before']} → {c['after']}"
                for f, c in changed.items()
            )
            verb = "Result corrected" if rv else "Analysis amended"
            label = f"{verb} — {a.title}: {frags}{where}"

        events.append({
            "timestamp": t.occurred_at.isoformat() if t.occurred_at else None,
            "event": event,
            "label": label,
            "details": {"changed": changed, "by": by_email,
                        "vial": vial.sample_id if vial else None,
                        "analysis_id": a.id, "keyword": a.keyword},
            "source": "lims_analysis_transitions",
        })
    return events
```

- [ ] **Step 4: Wire into the activity endpoint**

In `main.py` `get_sample_activity`, immediately after the variance-verifications block (after the `events.append` closing at ~`:1060`):

```python
    # --- Mk1 DB: amendment audit (result entries + corrections) ---
    from lims_analyses.service import list_analysis_change_events_for_parent
    events.extend(list_analysis_change_events_for_parent(db, sample_id))
```

- [ ] **Step 5: Run tests**

Run: `.venv python -m pytest tests/test_amendment_audit.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/lims_analyses/service.py backend/main.py backend/tests/test_amendment_audit.py
git commit -m "feat(audit): blend result entries and amendments into the sample activity log"
```

---

### Task 6: flyout rendering — style map + FE test

**Files:**
- Modify: `src/components/senaite/SampleActivityLog.tsx` — bucket map (`:40-68`) and icon map (`:83+`)
- Test: `src/test/sample-activity-log.test.tsx`

**Interfaces:**
- Consumes: events `result_entered` / `analysis_amended` from Task 5 (generic `{timestamp, event, label, details, source}` shape — the component already renders unknown events with a default style; this task only makes the two types visually distinct).

- [ ] **Step 1: `npm install` if this worktree hasn't run FE tooling yet** (npm ONLY — never pnpm)

- [ ] **Step 2: Write the failing test**

Open `src/test/sample-activity-log.test.tsx`, copy its existing render-one-event test idiom exactly (mock `getSampleActivity`, render, assert label text), and add two cases:

```tsx
it('renders a result_entered event with its label', async () => {
  // mock getSampleActivity to resolve one event:
  // { timestamp: '2026-08-08T12:00:00', event: 'result_entered',
  //   label: 'Result entered — Sterility USP<71>: Not Detected (P-0145-S02)',
  //   details: {}, source: 'lims_analysis_transitions' }
  // assert the label renders
})

it('renders an analysis_amended event with warn styling', async () => {
  // same idiom, event: 'analysis_amended',
  // label: 'Result corrected — Sterility USP<71>: 0.92 → 0.95 (P-0145-S02)'
  // assert the label renders AND the row carries the warn bucket class/attr
  // (assert however the existing tests assert bucket styling — follow the
  // file's own precedent; if no styling assertion precedent exists, assert
  // the label only and note it in the task report)
})
```

Fill in the real mock/render calls from the file's existing tests — the two blocks above name the required assertions, the surrounding idiom comes from the file itself.

- [ ] **Step 3: Run to verify behavior**

Run: `npm run test -- sample-activity-log` (from the worktree root)
Expected: label assertions may already PASS (generic renderer); the warn-bucket assertion FAILS (unknown event falls to default styling).

- [ ] **Step 4: Add the style-map entries**

In `SampleActivityLog.tsx` bucket switch (`:40-68`):

```tsx
    case 'result_entered':    return 'info'
    case 'analysis_amended':  return 'warn'
```

In the icon switch (`:83+`), matching the file's unicode-escape convention:

```tsx
    case 'result_entered':    return '\u25a0' // ■
    case 'analysis_amended':  return '\u270e' // ✎
```

- [ ] **Step 5: Run FE tests + the repo gate**

Run: `npm run test -- sample-activity-log` → PASS.
Run: `npm run check:all` → judge against the repo's current baseline (pre-existing failures are not yours; new failures are).

- [ ] **Step 6: Commit**

```bash
git add src/components/senaite/SampleActivityLog.tsx src/test/sample-activity-log.test.tsx
git commit -m "feat(audit): render amendment events in the sample activity flyout"
```

---

### Task 7: full-gate — failure-SET diff vs the 64 baseline

**Files:** none (verification only)

- [ ] **Step 1: Capture the baseline set at the base commit**

```bash
cd C:/tmp/Accu-Mk1-amendment-audit
git checkout 01e01c1   # detached, worktree-local, safe
cd backend
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep "^FAILED" | sort > /c/tmp/aa-base-failures.txt
```

- [ ] **Step 2: Capture the set at the branch tip**

```bash
cd C:/tmp/Accu-Mk1-amendment-audit
git checkout feat/analysis-amendment-audit
cd backend
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep "^FAILED" | sort > /c/tmp/aa-tip-failures.txt
```

- [ ] **Step 3: Diff the sorted sets**

```bash
diff /c/tmp/aa-base-failures.txt /c/tmp/aa-tip-failures.txt
```

Expected: empty, modulo the known flaky `test_clickup_task_retry.py` entries. ANY other new FAILED id = stop and report; do not adjust tests to pass.

- [ ] **Step 4: Record the result**

Append the diff outcome (or "byte-identical") to the task report / ledger. No commit (nothing changed).

---

## Self-Review (performed at authoring)

- **Spec coverage:** §2.1 column+contract → Task 1; §2.2 helper → Task 2; §2.3 ten sites + grep guard → Tasks 2-3; §2.4 migration → Task 1; §2.5 read surface → Task 4; §2.6 activity blend (emission rule, two events, labels, FE map) → Tasks 5-6; §5 tests 1-9 → distributed (1-2→T2, 3→T3, 4→T3, 5→T2, 6→T4, 7→T3, 8→T3, 9→T5); §3 non-goals: no task touches immutability/tombstones/backfill/mirror files. Gap check: none.
- **Type consistency:** `_snapshot(row) -> dict`, `_deltas(before, row) -> {"changed": {...}}`, `list_analysis_change_events_for_parent(db, str) -> list[dict]` used identically in Tasks 2/3/5. `details: Optional[dict]` in model (T1) and schema (T4).
- **Known soft spots, stated rather than hidden:** the vial-tier source-retest function name at `:1760` is to be verified in-repo before Task 3's test import (instruction embedded in the task); Task 6's warn-styling assertion depends on the FE test file's existing precedent (fallback documented in the task).
