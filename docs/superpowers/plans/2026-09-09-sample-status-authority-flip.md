# Sample-Status Authority Flip + Native Cancel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Accu-Mk1's workflow catalog + native engine the writer of a sample's status (behind a settings switch), tee every transition to SENAITE with read-back and scheduled retry, surface stranded samples as flags instead of sweeping them, and add a native "cancel sample" verb usable from any state.

**Architecture:** The engine (`workflow/engine.py::execute_verb`) already advances `lims_samples.native_status` from catalog edges; in `mk1` authority mode it additionally writes `lims_samples.status` (the column every reader uses) and the three SENAITE-sourced writers stop touching that column. A new `workflow/senaite_tee.py` performs AR-level transitions on SENAITE, proves them by read-back, and queues refusals in a new `lims_senaite_tee_retries` table drained by a scheduler job. A new `workflow/stranded.py` job raises/resolves one `workflow_stranded` flag per stranded sample. Cancel is catalog data (seeded edges from every state) plus an analysis-tier `cancel` verb, a `POST /api/samples/{id}/cancel` route and a confirm dialog.

**Tech Stack:** FastAPI + SQLAlchemy 2 (sync `def` routes), pytest with the in-memory `db_session` / `route_client` fixtures, the in-process `flags.scheduler.Scheduler`, React 19 + TypeScript + TanStack Query + zustand + vitest (npm only).

**Spec:** `docs/superpowers/specs/2026-09-09-sample-status-authority-flip-design.md` — the plan argues from it; read both.

## Global Constraints

- Additive only: no existing column, table or route is removed or renamed; every new DB object is `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` in `backend/database.py`'s migration list (the project's hand-rolled, idempotent, last-boot-wins pattern).
- Authority switch default: absent or malformed `registry_read_source.sample_status` → `"senaite"` (today's behavior, byte-identical).
- Vocabularies live in code, not DB CHECKs, except the two existing CHECK constraints this plan extends (`lims_analysis_transitions.transition_kind`, `lims_analyses.review_state`) which are re-issued as DROP + ADD pairs with the full list.
- The engine's status write accepts only slugs present in the live catalog (`entity_scope='sample'`, `is_active`).
- No scheduled converge. Nothing in this plan advances a sample's status on a timer.
- Cancel: allowed from every catalog state except `cancelled`; requires a reason (≥ 3 chars) and `confirm=true`; lab-only (no IS / WooCommerce call); no un-cancel; published COAs are never withdrawn.
- Retry backoff: attempts 1..8 wait 5, 15, 45, 180, 720, 720, 720, 720 minutes; after the 8th failed attempt the row is `gave_up`.
- Test gating: backend full suite runs SOLO (never two concurrent runs — the shared dev DB deadlocks) and is judged by failure-set diff against pristine `origin/master`; frontend via `npm run check:all` per-file deltas. Never run repo-wide `prettier --write`.
- Commit after every task; PR from branch `feat/sample-status-authority-flip` off `origin/master`.
- Backend tests run from `C:\Projects\accumk1-vial-status-wt\backend` with `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider <files>`; frontend tests from the repo root with `npx vitest run <file>`.

---

## File Structure

**Backend — new files**
- `backend/workflow/authority.py` — `sample_status_authority(db) -> "senaite"|"mk1"`; the single reader of the switch.
- `backend/workflow/senaite_tee.py` — AR-level SENAITE transition + read-back, the retry queue helpers, the retry job.
- `backend/workflow/stranded.py` — stranded-sample detector job (flags).
- `backend/workflow/cancel_routes.py` — `POST /api/samples/{sample_id}/cancel`.
- `backend/tests/test_workflow_authority.py`, `test_workflow_status_write.py`, `test_workflow_writers_gated.py`, `test_workflow_cascade_refusals.py`, `test_senaite_tee.py`, `test_senaite_tee_retry_job.py`, `test_workflow_stranded.py`, `test_cancel_state_machine.py`, `test_cancel_pending_rows.py`, `test_cancel_seeds.py`, `test_cancel_route.py`.

**Backend — modified files**
- `backend/workflow/catalog.py` — `sample_state_slugs(db)` (live vocabulary, 60 s cache).
- `backend/workflow/sample_log.py` — `heal_sample_status(..., source=)` gate.
- `backend/workflow/is_event_stream.py` — `_heal_status` gate.
- `backend/workflow/engine.py` — status write in `execute_verb`; refusal recording in `evaluate_cascades`; tee hook in `run_cascades_bg`.
- `backend/workflow/seeds.py` — cancel edges + partial-publish edges.
- `backend/workflow/routes.py` — `senaite_lagging` count in the shadow summary.
- `backend/sub_samples/service.py` — `_refresh_parent_from_senaite` status gate.
- `backend/lims_analyses/state_machine.py`, `schemas.py` — `cancel` verb.
- `backend/lims_analyses/service.py` — `cancel_pending_rows(...)`.
- `backend/models.py` — `LimsSenaiteTeeRetry`.
- `backend/database.py` — migrations (table, indexes, CHECK re-issues, flag type seed).
- `backend/flags/types_service.py` — `workflow_stranded` builtin type.
- `backend/main.py` — router include, two scheduler jobs, publish-route synchrony + retry enqueue.

**Frontend**
- `src/lib/read-source.ts` — `SAMPLE_STATUS_KEY`, `parseSampleStatusAuthority`.
- `src/components/preferences/panes/DataSourcePane.tsx` — "Sample status authority" section.
- `src/lib/workflow-states-store.ts` (new) — zustand store of catalog states + `WorkflowStatesLoader`.
- `src/components/senaite/senaite-utils.tsx`, `src/components/explorer/helpers.tsx` — label from the store, fallback to the maps.
- `src/App.tsx` — mount `WorkflowStatesLoader`.
- `src/lib/api.ts` — `cancelSample`.
- `src/components/senaite/CancelSampleDialog.tsx` (new), `SampleDetails.tsx` — header action.
- `src/test/cancel-sample-dialog.test.tsx`, `src/test/workflow-states-store.test.tsx`, `src/components/preferences/panes/__tests__/DataSourcePane.test.tsx`.

---

### Task 1: Authority switch reader

**Files:**
- Create: `backend/workflow/authority.py`
- Test: `backend/tests/test_workflow_authority.py`

**Interfaces:**
- Produces: `sample_status_authority(db: Session) -> str` returning `"senaite"` or `"mk1"`; constant `SAMPLE_STATUS_KEY = "sample_status"`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_workflow_authority.py
"""registry_read_source.sample_status decides who writes lims_samples.status.
Absent / malformed / unknown value -> 'senaite' (today's behavior)."""
import json

from models import Settings


def _set(db, value):
    row = Settings(key="registry_read_source", value=value)
    db.add(row)
    db.flush()


def test_absent_row_is_senaite(db_session):
    from workflow.authority import sample_status_authority
    assert sample_status_authority(db_session) == "senaite"


def test_key_mk1_is_mk1(db_session):
    from workflow.authority import sample_status_authority
    _set(db_session, json.dumps({"sample_details": "mk1", "sample_status": "mk1"}))
    assert sample_status_authority(db_session) == "mk1"


def test_missing_key_or_bad_value_is_senaite(db_session):
    from workflow.authority import sample_status_authority
    _set(db_session, json.dumps({"sample_details": "mk1", "sample_status": "bogus"}))
    assert sample_status_authority(db_session) == "senaite"


def test_malformed_json_is_senaite(db_session):
    from workflow.authority import sample_status_authority
    _set(db_session, "{not json")
    assert sample_status_authority(db_session) == "senaite"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_authority.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'workflow.authority'`

- [ ] **Step 3: Implement**

```python
# backend/workflow/authority.py
"""Who writes lims_samples.status — the sample-tier authority switch.

`registry_read_source` is the Settings row the Data Source pane owns (a JSON
object keyed by surface). This module reads ONE key, `sample_status`:
  "senaite" (default) -> SENAITE-sourced mirrors write the column (today)
  "mk1"               -> the native engine writes it; mirrors stop
Fail-safe: absence, malformed JSON or an unknown value all mean "senaite".
Spec: docs/superpowers/specs/2026-09-09-sample-status-authority-flip-design.md §3.1
"""
import json

from sqlalchemy import select
from sqlalchemy.orm import Session

SAMPLE_STATUS_KEY = "sample_status"
READ_SOURCE_SETTING_KEY = "registry_read_source"
_VALID = ("senaite", "mk1")


def sample_status_authority(db: Session) -> str:
    from models import Settings
    row = db.execute(
        select(Settings).where(Settings.key == READ_SOURCE_SETTING_KEY)
    ).scalar_one_or_none()
    if row is None or not row.value:
        return "senaite"
    try:
        parsed = json.loads(row.value)
    except (ValueError, TypeError):
        return "senaite"
    val = parsed.get(SAMPLE_STATUS_KEY) if isinstance(parsed, dict) else None
    return val if val in _VALID else "senaite"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_authority.py`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add backend/workflow/authority.py backend/tests/test_workflow_authority.py
git commit -m "feat(workflow): sample_status authority switch reader (default senaite)"
```

---

### Task 2: Live catalog vocabulary for the status writers

**Files:**
- Modify: `backend/workflow/catalog.py` (append)
- Modify: `backend/workflow/sample_log.py:38-61` (`SAMPLE_REVIEW_STATE_WHITELIST`, `heal_sample_status`)
- Test: `backend/tests/test_workflow_authority.py` (append)

**Interfaces:**
- Produces: `workflow.catalog.sample_state_slugs(db) -> frozenset[str]` (live, cached 60 s), `workflow.catalog.clear_sample_state_cache()`; `heal_sample_status(db, sample_id, to_status, *, source: str = "senaite") -> bool`.
- Consumes: Task 1 `sample_status_authority`.

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_workflow_authority.py
from models import LimsSample, LimsWorkflowState


def test_sample_state_slugs_reads_live_catalog(db_session):
    from workflow.catalog import sample_state_slugs, clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    slugs = sample_state_slugs(db_session)
    assert {"sample_received", "to_be_verified", "verified", "published", "cancelled"} <= slugs
    # a state added at runtime (the Settings -> Workflow pane) is honoured
    db_session.add(LimsWorkflowState(entity_scope="sample", slug="on_hold", label="On hold",
                                     category="active", sort_order=55, is_builtin=False,
                                     is_active=True))
    db_session.flush()
    clear_sample_state_cache()
    assert "on_hold" in sample_state_slugs(db_session)


def test_heal_accepts_runtime_state_in_senaite_mode(db_session):
    from workflow.catalog import clear_sample_state_cache
    from workflow.sample_log import heal_sample_status
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    db_session.add(LimsWorkflowState(entity_scope="sample", slug="on_hold", label="On hold",
                                     category="active", sort_order=55, is_builtin=False,
                                     is_active=True))
    db_session.add(LimsSample(sample_id="P-AUTH-1", status="sample_received"))
    db_session.flush()
    clear_sample_state_cache()
    assert heal_sample_status(db_session, "P-AUTH-1", "on_hold") is True
    assert heal_sample_status(db_session, "P-AUTH-1", "analyzing") is False  # IS vocab, never


def test_heal_in_mk1_mode_only_from_native_sources(db_session):
    from workflow.catalog import clear_sample_state_cache
    from workflow.sample_log import heal_sample_status
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    _set(db_session, json.dumps({"sample_status": "mk1"}))
    row = LimsSample(sample_id="P-AUTH-2", status="sample_received")
    db_session.add(row)
    db_session.flush()
    assert heal_sample_status(db_session, "P-AUTH-2", "verified") is False          # senaite default
    assert row.status == "sample_received"
    assert heal_sample_status(db_session, "P-AUTH-2", "verified", source="mk1") is True
    assert row.status == "verified"
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_authority.py`
Expected: 3 new FAIL — `ImportError: cannot import name 'sample_state_slugs'`

- [ ] **Step 3: Implement the catalog helper**

Append to `backend/workflow/catalog.py`:

```python
import time as _time

_SAMPLE_STATE_CACHE: dict = {"at": 0.0, "slugs": None}
_SAMPLE_STATE_TTL_S = 60.0


def clear_sample_state_cache() -> None:
    _SAMPLE_STATE_CACHE["at"] = 0.0
    _SAMPLE_STATE_CACHE["slugs"] = None


def sample_state_slugs(db: Session) -> frozenset:
    """Live sample-tier vocabulary: every ACTIVE `entity_scope='sample'` state
    in the catalog (the Settings -> Workflow pane is its editor). Cached 60 s
    per process. Falls back to the seed constant if the query fails (boot
    before seed) so the status writers never lose their guard."""
    now = _time.monotonic()
    if (_SAMPLE_STATE_CACHE["slugs"] is not None
            and now - _SAMPLE_STATE_CACHE["at"] < _SAMPLE_STATE_TTL_S):
        return _SAMPLE_STATE_CACHE["slugs"]
    try:
        rows = db.execute(
            select(LimsWorkflowState.slug).where(
                LimsWorkflowState.entity_scope == "sample",
                LimsWorkflowState.is_active.is_(True),
            )
        ).scalars().all()
        slugs = frozenset(rows)
    except Exception:
        from workflow.seeds import SEED_STATES
        slugs = frozenset(slug for (scope, slug, *_r) in SEED_STATES if scope == "sample")
    _SAMPLE_STATE_CACHE["at"] = now
    _SAMPLE_STATE_CACHE["slugs"] = slugs
    return slugs
```

- [ ] **Step 4: Gate `heal_sample_status`**

In `backend/workflow/sample_log.py` replace the function body:

```python
NATIVE_STATUS_SOURCES = frozenset({"mk1", "reconcile_native"})
# SENAITE-only legacy values the mirror must still accept in senaite mode.
_LEGACY_MIRROR_EXTRA = frozenset({"rejected", "stored"})


def heal_sample_status(db: Session, sample_id: str, to_status: str, *,
                       source: str = "senaite") -> bool:
    """Guarded write of lims_samples.status. Returns True iff the column was
    changed. Guards:
      - vocabulary: the LIVE catalog's active sample states (+ the two
        SENAITE-only legacy values) — a state added in the pane is honoured;
        IS order-progress vocab never is (RC3);
      - authority: in mk1 mode only native sources ('mk1',
        'reconcile_native') may write; SENAITE-sourced heals are no-ops;
      - existence + idempotence as before.
    Flush-only, never commits."""
    from workflow.authority import sample_status_authority
    from workflow.catalog import sample_state_slugs
    if to_status not in (sample_state_slugs(db) | _LEGACY_MIRROR_EXTRA):
        return False
    if sample_status_authority(db) == "mk1" and source not in NATIVE_STATUS_SOURCES:
        return False
    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if row is None or row.status == to_status:
        return False
    row.status = to_status
    db.flush()
    return True
```

Keep `SAMPLE_REVIEW_STATE_WHITELIST` defined (other modules import it); add a comment above it: `# Fallback vocabulary only — heal_sample_status reads the live catalog (Task 2).`

- [ ] **Step 5: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_authority.py tests/test_registry_signal.py tests/test_workflow_engine.py`
Expected: all pass (the two existing suites exercise `heal_sample_status` through the default `source="senaite"`).

- [ ] **Step 6: Commit**

```bash
git add backend/workflow/catalog.py backend/workflow/sample_log.py backend/tests/test_workflow_authority.py
git commit -m "feat(workflow): live catalog vocabulary + authority gate on heal_sample_status"
```

---

### Task 3: Engine writes the badge column in mk1 mode

**Files:**
- Modify: `backend/workflow/engine.py:215-248` (`execute_verb`)
- Test: `backend/tests/test_workflow_status_write.py`

**Interfaces:**
- Consumes: Task 1 `sample_status_authority`, Task 2 `sample_state_slugs`, existing `record_sample_transition`.
- Produces: in mk1 mode every `advanced` outcome also sets `sample.status = to_slug` and inserts a `lims_sample_transitions` row with `source='mk1'`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_workflow_status_write.py
"""mk1 authority: execute_verb writes lims_samples.status + a source='mk1'
ledger row. senaite authority: status untouched (today)."""
import json

from sqlalchemy import select

from models import LimsSample, LimsSampleTransition, Settings


def _seeded(db, authority):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    db.add(Settings(key="registry_read_source",
                    value=json.dumps({"sample_status": authority})))
    row = LimsSample(sample_id="P-SW-1", status="sample_due", native_status="sample_due")
    db.add(row)
    db.flush()
    return row


def test_mk1_mode_writes_status_and_ledger(db_session):
    from workflow.engine import execute_verb
    row = _seeded(db_session, "mk1")
    ev = execute_verb(db_session, row, "receive", trigger="receive", actor_user_id=7)
    assert ev.outcome == "advanced"
    assert row.native_status == "sample_received"
    assert row.status == "sample_received"
    t = db_session.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id)).scalars().all()
    assert [(x.source, x.verb, x.from_status, x.to_status, x.actor_user_id) for x in t] == [
        ("mk1", "receive", "sample_due", "sample_received", 7)]


def test_senaite_mode_leaves_status_alone(db_session):
    from workflow.engine import execute_verb
    row = _seeded(db_session, "senaite")
    ev = execute_verb(db_session, row, "receive", trigger="receive")
    assert ev.outcome == "advanced"
    assert row.native_status == "sample_received"
    assert row.status == "sample_due"
    assert db_session.execute(select(LimsSampleTransition)).scalars().all() == []


def test_refusal_never_writes_status(db_session):
    from workflow.engine import execute_verb
    row = _seeded(db_session, "mk1")
    ev = execute_verb(db_session, row, "publish", trigger="publish")   # no edge from sample_due
    assert ev.outcome == "no_edge"
    assert row.status == "sample_due"
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_status_write.py`
Expected: `test_mk1_mode_writes_status_and_ledger` FAILS on `row.status == "sample_received"`; the other two pass (they pin today's behavior).

- [ ] **Step 3: Implement**

In `backend/workflow/engine.py::execute_verb`, replace the two lines

```python
    frm = sample.native_status
    sample.native_status = to_slug
    db.flush()
```

with

```python
    frm = sample.native_status
    sample.native_status = to_slug
    _write_status_if_authoritative(db, sample, to_slug, verb=verb,
                                   actor_user_id=actor_user_id)
    db.flush()
```

and add above `execute_verb`:

```python
def _write_status_if_authoritative(db: Session, sample: LimsSample, to_slug: str, *,
                                   verb: str, actor_user_id: Optional[int]) -> bool:
    """mk1 authority (spec §4.1): the engine is the writer of
    lims_samples.status. Only catalog slugs are ever written; a foreign slug
    logs and leaves the column alone. Ledger row source='mk1' (never
    deduped). senaite authority: no-op."""
    from workflow.authority import sample_status_authority
    from workflow.catalog import sample_state_slugs
    from workflow.sample_log import record_sample_transition
    if sample_status_authority(db) != "mk1":
        return False
    if to_slug not in sample_state_slugs(db):
        log.warning("workflow.status_write_refused sample=%s slug=%r not in catalog",
                    sample.sample_id, to_slug)
        return False
    prev = sample.status
    sample.status = to_slug
    record_sample_transition(db, sample_id=sample.sample_id, to_status=to_slug,
                             source="mk1", verb=verb, from_status=prev,
                             actor_user_id=actor_user_id)
    return True
```

- [ ] **Step 4: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_status_write.py tests/test_workflow_engine.py`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/workflow/engine.py backend/tests/test_workflow_status_write.py
git commit -m "feat(workflow): engine writes lims_samples.status under mk1 authority"
```

---

### Task 4: Gate the SENAITE-sourced status writers

**Files:**
- Modify: `backend/sub_samples/service.py:121` (`row.status = meta.get("review_state")` inside `_refresh_parent_from_senaite`)
- Modify: `backend/workflow/is_event_stream.py:84-121` (`_heal_status`)
- Modify: `backend/main.py` receive touchpoint — the line `heal_sample_status(db, row.sample_id, "sample_received")` (around 16260)
- Test: `backend/tests/test_workflow_writers_gated.py`

**Interfaces:**
- Consumes: Task 1, Task 2.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_workflow_writers_gated.py
"""In mk1 authority the SENAITE-sourced writers stop touching
lims_samples.status; every other field still mirrors."""
import json
from datetime import datetime, timezone
from unittest.mock import patch

from models import LimsSample, Settings


def _mode(db, authority):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    db.add(Settings(key="registry_read_source",
                    value=json.dumps({"sample_status": authority})))
    db.flush()


META = {"review_state": "verified", "ClientSampleID": "X-1", "Analyte1Peptide": "BPC-157",
        "getClientTitle": "Acme", "DateReceived": "2026-09-01T00:00:00+00:00"}


def test_refresh_mirrors_fields_but_not_status_in_mk1(db_session):
    from sub_samples.service import _refresh_parent_from_senaite
    _mode(db_session, "mk1")
    row = LimsSample(sample_id="P-GATE-1", status="sample_received",
                     external_lims_uid="U-GATE-1")
    db_session.add(row)
    db_session.flush()
    with patch("sub_samples.senaite.fetch_parent_metadata", return_value=dict(META, uid="U-GATE-1")):
        _refresh_parent_from_senaite(db_session, row)
    assert row.client_sample_id == "X-1"
    assert row.status == "sample_received"


def test_refresh_still_mirrors_status_in_senaite_mode(db_session):
    from sub_samples.service import _refresh_parent_from_senaite
    _mode(db_session, "senaite")
    row = LimsSample(sample_id="P-GATE-2", status="sample_received",
                     external_lims_uid="U-GATE-2")
    db_session.add(row)
    db_session.flush()
    with patch("sub_samples.senaite.fetch_parent_metadata", return_value=dict(META, uid="U-GATE-2")):
        _refresh_parent_from_senaite(db_session, row)
    assert row.status == "verified"


def test_is_event_heal_skipped_in_mk1(db_session):
    from workflow.is_event_stream import _heal_status
    _mode(db_session, "mk1")
    row = LimsSample(sample_id="P-GATE-3", status="sample_received")
    db_session.add(row)
    db_session.flush()
    stats = {"healed": 0, "errors": 0}
    _heal_status(db_session, row.id, "verified", datetime.now(timezone.utc), stats)
    assert row.status == "sample_received"
    assert stats["healed"] == 0
    assert stats.get("skipped_authority") == 1
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_writers_gated.py`
Expected: tests 1 and 3 FAIL (status becomes `verified`); test 2 passes.

- [ ] **Step 3: Gate `_refresh_parent_from_senaite`**

In `backend/sub_samples/service.py` replace

```python
    row.status = meta.get("review_state")
```

with

```python
    # Authority flip (spec §4.2): under mk1 authority the engine owns this
    # column; SENAITE's review_state is still LOGGED by the transition hooks
    # but never written here.
    from workflow.authority import sample_status_authority
    if sample_status_authority(db) != "mk1":
        row.status = meta.get("review_state")
```

- [ ] **Step 4: Gate `_heal_status`**

In `backend/workflow/is_event_stream.py::_heal_status`, insert as the first statement inside the `try:` block (before `if new_status not in SAMPLE_REVIEW_STATE_WHITELIST:`):

```python
        from workflow.authority import sample_status_authority
        if sample_status_authority(db) == "mk1":
            stats["skipped_authority"] = stats.get("skipped_authority", 0) + 1
            return
```

- [ ] **Step 5: Receive touchpoint is a native source**

In `backend/main.py`, change the receive-page call

```python
            heal_sample_status(db, row.sample_id, "sample_received")
```

to

```python
            heal_sample_status(db, row.sample_id, "sample_received", source="mk1")
```

(There is exactly one such call; confirm with `grep -n 'heal_sample_status(db, row.sample_id, "sample_received")' backend/main.py`.)

- [ ] **Step 6: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_writers_gated.py tests/test_registry_signal.py tests/test_workflow_authority.py tests/test_receive*.py`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add backend/sub_samples/service.py backend/workflow/is_event_stream.py backend/main.py backend/tests/test_workflow_writers_gated.py
git commit -m "feat(workflow): SENAITE-sourced status writers gated under mk1 authority"
```

---

### Task 5: Record the refusal that stops a cascade

**Files:**
- Modify: `backend/workflow/engine.py:249-286` (`evaluate_cascades`)
- Test: `backend/tests/test_workflow_cascade_refusals.py`

**Interfaces:**
- Produces: when a cascade run has ≥1 auto-fire candidate and none fires, exactly one `LimsWorkflowShadowEvaluation` with `outcome='requirements_unmet'`, `verb=<first candidate's verb>`, `outcomes=<its requirement outcomes>`; existing `_record` dedup applies.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_workflow_cascade_refusals.py
"""A stopped cascade records WHY (spec §6.1); nothing-to-fire records nothing."""
from sqlalchemy import select

from models import LimsSample, LimsWorkflowShadowEvaluation


def _seeded(db):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)


def _evals(db, row):
    return db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == row.id
    ).order_by(LimsWorkflowShadowEvaluation.id)).scalars().all()


def test_unmet_auto_fire_edge_records_one_refusal(db_session):
    from workflow.engine import evaluate_cascades
    _seeded(db_session)
    # sample_received -> to_be_verified is auto_fire with an all_analyses_in_state
    # requirement; a sample with NO analyses cannot meet it.
    row = LimsSample(sample_id="P-CR-1", status="sample_received", native_status="sample_received")
    db_session.add(row)
    db_session.flush()
    fired = evaluate_cascades(db_session, row, trigger="test")
    assert fired == []
    evs = _evals(db_session, row)
    assert len(evs) == 1
    assert evs[0].outcome == "requirements_unmet" and evs[0].verb == "submit"
    assert evs[0].from_status == "sample_received" and evs[0].to_status == "sample_received"
    assert evs[0].outcomes  # the requirement outcomes travel with the row
    # identical second run dedups (existing _record rule)
    evaluate_cascades(db_session, row, trigger="test")
    assert len(_evals(db_session, row)) == 1


def test_nothing_to_fire_records_nothing(db_session):
    from workflow.engine import evaluate_cascades
    _seeded(db_session)
    row = LimsSample(sample_id="P-CR-2", status="published", native_status="published")
    db_session.add(row)
    db_session.flush()
    assert evaluate_cascades(db_session, row, trigger="test") == []
    assert _evals(db_session, row) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_cascade_refusals.py`
Expected: first test FAILS (`len(evs) == 0`); second passes.

- [ ] **Step 3: Implement**

In `evaluate_cascades`, replace the inner loop body

```python
        advanced = None
        for edge in candidates:
            met, _outc = evaluate_requirements(
                db, sample, edge.requirements or [],
                actor_user_id=actor_user_id)
            if met:
                advanced = execute_verb(
                    db, sample, edge.verb, trigger=trigger,
                    actor_user_id=actor_user_id)
                break
        if advanced is None or advanced.outcome != "advanced":
            break
        fired.append(advanced)
```

with

```python
        advanced = None
        first_refusal = None   # (verb, outcomes) of the first unmet candidate
        for edge in candidates:
            met, outc = evaluate_requirements(
                db, sample, edge.requirements or [],
                actor_user_id=actor_user_id)
            if met:
                advanced = execute_verb(
                    db, sample, edge.verb, trigger=trigger,
                    actor_user_id=actor_user_id)
                break
            if first_refusal is None:
                first_refusal = (edge.verb, outc)
        if advanced is None or advanced.outcome != "advanced":
            # Spec §6.1: record WHY the cascade stopped (once per run; the
            # _record delta-dedup keeps repeats from spamming the trajectory).
            # No candidates at all = nothing to fire = record nothing.
            if advanced is None and first_refusal is not None:
                _record(db, sample, trigger=trigger, verb=first_refusal[0],
                        from_status=sample.native_status,
                        to_status=sample.native_status,
                        outcome="requirements_unmet", requirements_met=False,
                        outcomes=first_refusal[1], actor_user_id=actor_user_id)
            break
        fired.append(advanced)
```

Update the docstring sentence "refusals are NOT recorded here" to: "the refusal that STOPS the run is recorded once (spec §6.1); probes that had nothing to fire record nothing."

- [ ] **Step 4: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_cascade_refusals.py tests/test_workflow_engine.py tests/test_workflow_status_write.py`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/workflow/engine.py backend/tests/test_workflow_cascade_refusals.py
git commit -m "feat(workflow): record the refusal that stops a cascade"
```

---

### Task 6: Retry-queue table + model

**Files:**
- Modify: `backend/models.py` (append after `LimsWorkflowShadowEvaluation`)
- Modify: `backend/database.py` migration list — append after the `ix_shadow_evals_nonadvanced` index entry
- Test: `backend/tests/test_senaite_tee.py` (first test)

**Interfaces:**
- Produces: model `LimsSenaiteTeeRetry` (`__tablename__="lims_senaite_tee_retries"`) with columns `id, lims_sample_pk, verb, expected_state, attempts, next_attempt_at, last_error, status, created_at, updated_at`; status vocabulary `TEE_STATUSES = ("pending", "done", "gave_up", "senaite_only")`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_senaite_tee.py
"""SENAITE tee: AR-level transition + read-back; refusals become retry rows."""
from datetime import datetime, timezone

from sqlalchemy import select

from models import LimsSample


def test_retry_row_roundtrip(db_session):
    from models import LimsSenaiteTeeRetry
    row = LimsSample(sample_id="P-TEE-0", status="verified", external_lims_uid="U-TEE-0")
    db_session.add(row)
    db_session.flush()
    r = LimsSenaiteTeeRetry(lims_sample_pk=row.id, verb="publish", expected_state="published",
                            next_attempt_at=datetime.now(timezone.utc))
    db_session.add(r)
    db_session.flush()
    got = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (got.status, got.attempts, got.verb) == ("pending", 0, "publish")
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_senaite_tee.py`
Expected: FAIL — `ImportError: cannot import name 'LimsSenaiteTeeRetry'`

- [ ] **Step 3: Add the model**

Append to `backend/models.py` (after the `LimsWorkflowShadowEvaluation` class):

```python
TEE_STATUSES = ("pending", "done", "gave_up", "senaite_only")


class LimsSenaiteTeeRetry(Base):
    """One queued SENAITE transition that failed its read-back (spec §3.2).
    Vocabulary in code (TEE_STATUSES), not a CHECK. Drained by
    workflow.senaite_tee.run_retries on the flags scheduler."""
    __tablename__ = "lims_senaite_tee_retries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    lims_sample_pk: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_samples.id", ondelete="CASCADE"), nullable=False, index=True)
    verb: Mapped[str] = mapped_column(Text, nullable=False)
    expected_state: Mapped[str] = mapped_column(Text, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                                                 onupdate=lambda: datetime.now(timezone.utc))
```

(`datetime`, `timezone`, `Integer`, `Text`, `DateTime`, `ForeignKey`, `Optional` are already imported at the top of `models.py`; verify with `grep -n "^from datetime import\|^from typing import" backend/models.py`.)

- [ ] **Step 4: Add the migration**

In `backend/database.py`, directly after the entry

```python
        "CREATE INDEX IF NOT EXISTS ix_shadow_evals_nonadvanced "
        "ON lims_workflow_shadow_evaluations (outcome) WHERE outcome != 'advanced'",
```

append:

```python
        # ── Sample-status authority flip (2026-09-09 spec §3.2) — additive.
        """
        CREATE TABLE IF NOT EXISTS lims_senaite_tee_retries (
            id               SERIAL PRIMARY KEY,
            lims_sample_pk   INTEGER NOT NULL REFERENCES lims_samples(id) ON DELETE CASCADE,
            verb             TEXT NOT NULL,
            expected_state   TEXT NOT NULL,
            attempts         INTEGER NOT NULL DEFAULT 0,
            next_attempt_at  TIMESTAMPTZ NOT NULL,
            last_error       TEXT,
            status           TEXT NOT NULL DEFAULT 'pending',
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_senaite_tee_retries_due "
        "ON lims_senaite_tee_retries (next_attempt_at) WHERE status = 'pending'",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_senaite_tee_retries_pending "
        "ON lims_senaite_tee_retries (lims_sample_pk, verb) WHERE status = 'pending'",
```

- [ ] **Step 5: Run the test**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_senaite_tee.py`
Expected: 1 passed

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_senaite_tee.py
git commit -m "feat(workflow): lims_senaite_tee_retries table + model"
```

---

### Task 7: SENAITE tee — transition, read-back, enqueue

**Files:**
- Create: `backend/workflow/senaite_tee.py`
- Test: `backend/tests/test_senaite_tee.py` (append)

**Interfaces:**
- Produces:
  - `EXPECTED_AR_STATES = {"receive": "sample_received", "verify": "verified", "publish": "published", "cancel": "cancelled"}`
  - `SENAITE_CANCELLABLE_STATES = frozenset({"sample_registered", "sample_due", "sample_received", "to_be_verified", "waiting_for_addon_results", "ready_for_initial_review"})`
  - `tee_now(db, sample, verb, *, now=None) -> str` → one of `"done" | "pending" | "senaite_only" | "skipped"`; performs the transition and read-back; on mismatch/error enqueues (or marks senaite_only for cancel after verification). Flush-only.
  - `enqueue_retry(db, sample, verb, *, error, now=None) -> LimsSenaiteTeeRetry` (idempotent while a pending row exists).
  - `read_back_state(sample) -> str` (SENAITE AR `review_state` via `fetch_parent_metadata`).
  - Injection points for tests: module-level `_transition = senaite_writeback._update`-based helper and `_read_back` are looked up at call time so `patch("workflow.senaite_tee._ar_transition")` / `patch("workflow.senaite_tee.read_back_state")` work.

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_senaite_tee.py
from unittest.mock import patch


def _sample(db, sid="P-TEE-1", status="verified", uid="U-TEE-1"):
    row = LimsSample(sample_id=sid, status=status, external_lims_uid=uid)
    db.add(row)
    db.flush()
    return row


def test_tee_done_when_read_back_matches(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session)
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="published"):
        assert tee.tee_now(db_session, row, "publish") == "done"
    tr.assert_called_once_with("U-TEE-1", "publish")
    assert db_session.execute(select(LimsSenaiteTeeRetry)).scalars().all() == []


def test_tee_enqueues_on_silent_refusal(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-2", uid="U-TEE-2")
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        assert tee.tee_now(db_session, row, "publish") == "pending"
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (q.verb, q.expected_state, q.status, q.attempts) == ("publish", "published", "pending", 1)
    assert "to_be_verified" in (q.last_error or "")
    # a second refusal does not mint a second pending row
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        tee.tee_now(db_session, row, "publish")
    assert len(db_session.execute(select(LimsSenaiteTeeRetry)).scalars().all()) == 1


def test_tee_enqueues_on_transport_error(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-3", uid="U-TEE-3")
    with patch("workflow.senaite_tee._ar_transition", side_effect=RuntimeError("boom")):
        assert tee.tee_now(db_session, row, "verify") == "pending"
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert q.verb == "verify" and "boom" in q.last_error


def test_cancel_after_verification_is_senaite_only(db_session):
    from workflow import senaite_tee as tee
    from models import LimsSenaiteTeeRetry
    row = _sample(db_session, sid="P-TEE-4", uid="U-TEE-4")
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="published"):
        assert tee.tee_now(db_session, row, "cancel") == "senaite_only"
    tr.assert_not_called()
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert q.status == "senaite_only" and q.verb == "cancel"


def test_no_uid_is_skipped(db_session):
    from workflow import senaite_tee as tee
    row = _sample(db_session, sid="P-TEE-5", uid=None)
    assert tee.tee_now(db_session, row, "verify") == "skipped"
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_senaite_tee.py`
Expected: 5 new FAIL — `ImportError: cannot import name 'senaite_tee'`

- [ ] **Step 3: Implement**

```python
# backend/workflow/senaite_tee.py
"""SENAITE tee with read-back and retry (spec §5).

Every native sample transition SENAITE can represent is teed here, then
PROVEN by re-reading the AR — SENAITE returns HTTP 200 for transitions it
silently refuses, and its JSON `transitions` list is empty even when a
transition is allowed, so neither is evidence. On mismatch or transport
error the transition becomes ONE pending `lims_senaite_tee_retries` row
(unique per sample+verb while pending) drained by `run_retries` (Task 8).
The user's request never waits on, or fails over, the tee.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import LimsSample, LimsSenaiteTeeRetry

log = logging.getLogger(__name__)

EXPECTED_AR_STATES = {
    "receive": "sample_received",
    "verify": "verified",
    "publish": "published",
    "cancel": "cancelled",
}
# SENAITE forbids `cancel` once verified/published; a cancel teed from there
# is a documented SENAITE-only divergence, not a retry.
SENAITE_CANCELLABLE_STATES = frozenset({
    "sample_registered", "sample_due", "sample_received", "to_be_verified",
    "waiting_for_addon_results", "ready_for_initial_review",
})
BACKOFF_MINUTES = (5, 15, 45, 180, 720, 720, 720, 720)
MAX_ATTEMPTS = len(BACKOFF_MINUTES)


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def _ar_transition(uid: str, verb: str) -> None:
    """POST update/{uid} {"transition": verb}. Patched in tests."""
    from lims_analyses.senaite_writeback import _update
    _update(uid, {"transition": verb})


def read_back_state(sample: LimsSample) -> str:
    """The AR's live review_state (the only proof). Patched in tests."""
    from sub_samples.senaite import fetch_parent_metadata
    meta = fetch_parent_metadata(sample.sample_id)
    return str(meta.get("review_state") or "")


def _pending_row(db: Session, sample: LimsSample, verb: str) -> Optional[LimsSenaiteTeeRetry]:
    return db.execute(
        select(LimsSenaiteTeeRetry).where(
            LimsSenaiteTeeRetry.lims_sample_pk == sample.id,
            LimsSenaiteTeeRetry.verb == verb,
            LimsSenaiteTeeRetry.status == "pending",
        )
    ).scalars().first()


def enqueue_retry(db: Session, sample: LimsSample, verb: str, *, error: str,
                  now: Optional[datetime] = None) -> LimsSenaiteTeeRetry:
    """One pending row per (sample, verb); a repeat refusal bumps attempts
    and reschedules per BACKOFF_MINUTES. Flush-only."""
    t = _now(now)
    row = _pending_row(db, sample, verb)
    if row is None:
        row = LimsSenaiteTeeRetry(lims_sample_pk=sample.id, verb=verb,
                                  expected_state=EXPECTED_AR_STATES[verb],
                                  attempts=0, next_attempt_at=t)
        db.add(row)
    row.attempts += 1
    row.last_error = (error or "")[:1000]
    if row.attempts >= MAX_ATTEMPTS:
        row.status = "gave_up"
    else:
        row.next_attempt_at = t + timedelta(minutes=BACKOFF_MINUTES[row.attempts - 1])
    db.flush()
    return row


def _mark_senaite_only(db: Session, sample: LimsSample, verb: str, *, note: str,
                       now: Optional[datetime] = None) -> LimsSenaiteTeeRetry:
    row = _pending_row(db, sample, verb) or LimsSenaiteTeeRetry(
        lims_sample_pk=sample.id, verb=verb, expected_state=EXPECTED_AR_STATES[verb],
        attempts=0, next_attempt_at=_now(now))
    row.status = "senaite_only"
    row.last_error = note[:1000]
    db.add(row)
    db.flush()
    return row


def tee_now(db: Session, sample: LimsSample, verb: str, *,
            now: Optional[datetime] = None) -> str:
    """Tee `verb` to SENAITE and prove it. Returns 'done' | 'pending' |
    'senaite_only' | 'skipped'. Never raises."""
    if verb not in EXPECTED_AR_STATES:
        return "skipped"
    uid = (sample.external_lims_uid or "").strip()
    if not uid:
        return "skipped"
    expected = EXPECTED_AR_STATES[verb]
    try:
        if verb == "cancel":
            current = read_back_state(sample)
            if current == "cancelled":
                return "done"
            if current not in SENAITE_CANCELLABLE_STATES:
                _mark_senaite_only(db, sample, verb, now=now,
                                   note=f"SENAITE forbids cancel from {current!r}")
                return "senaite_only"
        _ar_transition(uid, verb)
        actual = read_back_state(sample)
    except Exception as e:  # transport, auth, parse — all retryable
        enqueue_retry(db, sample, verb, error=f"{type(e).__name__}: {e}", now=now)
        return "pending"
    if actual == expected:
        row = _pending_row(db, sample, verb)
        if row is not None:
            row.status = "done"
            db.flush()
        return "done"
    enqueue_retry(db, sample, verb, now=now,
                  error=f"read-back {actual!r} != expected {expected!r}")
    return "pending"
```

- [ ] **Step 4: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_senaite_tee.py`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add backend/workflow/senaite_tee.py backend/tests/test_senaite_tee.py
git commit -m "feat(workflow): SENAITE tee with read-back and retry enqueue"
```

**Execution rulings (2026-09-09, task review fix round 1 — the shipped module differs from Step 3 in these ways):** one row per (sample, verb) regardless of status — `_row_for()` (latest row, any status) replaces `_pending_row()`; `enqueue_retry` revives a `done`/`gave_up`/`senaite_only` row (status → pending, attempts reset, then the normal bump) instead of minting a second; `_mark_senaite_only` reuses the row; a shared `_resolve_done()` marks an existing row `done` from both the cancel already-cancelled fast path and the matched read-back path; `tee_now` wraps its whole body in a never-raise guard that logs and returns a fifth value `"error"` (no rollback of the caller's session); `enqueue_retry` logs `senaite_tee.enqueued` on create/revive. Also fixed in the same commit: Task 6's `database.py` partial-unique-index literal carried its comma inside the quotes (Python concatenated it with the next `UPDATE` migration into invalid SQL).

---

### Task 8: Retry job + scheduler registration + summary count

**Files:**
- Modify: `backend/workflow/senaite_tee.py` (append `run_retries`)
- Modify: `backend/main.py` lifespan — after the `flag_watch_poller` registration, before `_flag_scheduler.start()`
- Modify: `backend/workflow/routes.py` shadow summary — add `senaite_lagging`
- Test: `backend/tests/test_senaite_tee_retry_job.py`

**Interfaces:**
- Produces: `run_retries(db, *, now=None, batch=50) -> dict` with keys `retried, done, gave_up, superseded, errors`; the verify-then-publish rule; the superseded rule (`sample.status` no longer the verb's target → `done`).
- Summary: `GET /api/workflow/shadow/summary` JSON gains `"senaite_lagging": <count of gave_up rows>`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_senaite_tee_retry_job.py
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, call

from sqlalchemy import select

from models import LimsSample, LimsSenaiteTeeRetry

T0 = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _queued(db, sid, verb, status="verified", attempts=1, due=T0):
    row = LimsSample(sample_id=sid, status=status, external_lims_uid=f"U-{sid}")
    db.add(row)
    db.flush()
    q = LimsSenaiteTeeRetry(lims_sample_pk=row.id, verb=verb,
                            expected_state={"verify": "verified", "publish": "published", "cancel": "cancelled"}[verb],
                            attempts=attempts, next_attempt_at=due, status="pending")
    db.add(q)
    db.flush()
    return row, q


def test_due_row_retried_and_done(db_session):
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-1", "verify")
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", return_value="verified"):
        stats = run_retries(db_session, now=T0 + timedelta(minutes=1))
    assert stats["done"] == 1 and q.status == "done"
    tr.assert_called_once_with("U-P-RJ-1", "verify")


def test_not_due_row_untouched(db_session):
    from workflow.senaite_tee import run_retries
    _, q = _queued(db_session, "P-RJ-2", "verify", due=T0 + timedelta(hours=1))
    with patch("workflow.senaite_tee._ar_transition") as tr:
        stats = run_retries(db_session, now=T0)
    tr.assert_not_called()
    assert stats["retried"] == 0 and q.status == "pending"


def test_publish_refused_because_unverified_issues_verify_first(db_session):
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-3", "publish", status="published")
    # SENAITE: to_be_verified -> (verify) -> verified -> (publish) -> published
    states = iter(["to_be_verified", "verified", "published"])
    with patch("workflow.senaite_tee._ar_transition") as tr, \
         patch("workflow.senaite_tee.read_back_state", side_effect=lambda s: next(states)):
        stats = run_retries(db_session, now=T0)
    assert tr.call_args_list == [call("U-P-RJ-3", "verify"), call("U-P-RJ-3", "publish")]
    assert stats["done"] == 1 and q.status == "done"


def test_backoff_and_give_up(db_session):
    from workflow.senaite_tee import run_retries, BACKOFF_MINUTES
    row, q = _queued(db_session, "P-RJ-4", "verify", attempts=1)
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"):
        run_retries(db_session, now=T0)
    assert q.status == "pending" and q.attempts == 2
    assert q.next_attempt_at == T0 + timedelta(minutes=BACKOFF_MINUTES[1])
    q.attempts = 7
    q.next_attempt_at = T0
    db_session.flush()
    with patch("workflow.senaite_tee._ar_transition"), \
         patch("workflow.senaite_tee.read_back_state", return_value="sample_received"):
        stats = run_retries(db_session, now=T0)
    assert q.status == "gave_up" and stats["gave_up"] == 1


def test_superseded_by_later_native_state(db_session):
    from workflow.senaite_tee import run_retries
    row, q = _queued(db_session, "P-RJ-5", "verify", status="cancelled")   # native moved on
    with patch("workflow.senaite_tee._ar_transition") as tr:
        stats = run_retries(db_session, now=T0)
    tr.assert_not_called()
    assert q.status == "done" and stats["superseded"] == 1
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_senaite_tee_retry_job.py`
Expected: 5 FAIL — `ImportError: cannot import name 'run_retries'`

- [ ] **Step 3: Implement `run_retries`**

Append to `backend/workflow/senaite_tee.py`:

```python
def _attempt(db: Session, sample: LimsSample, row: LimsSenaiteTeeRetry, *,
             now: Optional[datetime]) -> str:
    """One retry attempt for a pending row. Returns the row's new status."""
    uid = (sample.external_lims_uid or "").strip()
    expected = row.expected_state
    try:
        if row.verb == "publish":
            # PB-0462 rule: SENAITE refuses publish while the AR is unverified
            # (its own auto-verify miscounts once an analysis was rejected).
            current = read_back_state(sample)
            if current == "to_be_verified":
                _ar_transition(uid, "verify")
                current = read_back_state(sample)
                if current != "verified":
                    enqueue_retry(db, sample, row.verb, now=now,
                                  error=f"verify-before-publish read-back {current!r}")
                    return row.status
        _ar_transition(uid, row.verb)
        actual = read_back_state(sample)
    except Exception as e:
        enqueue_retry(db, sample, row.verb, error=f"{type(e).__name__}: {e}", now=now)
        return row.status
    if actual == expected:
        row.status = "done"
        db.flush()
        return "done"
    enqueue_retry(db, sample, row.verb, now=now,
                  error=f"read-back {actual!r} != expected {expected!r}")
    return row.status


def run_retries(db: Session, *, now: Optional[datetime] = None, batch: int = 50) -> dict:
    """Scheduler job body (registered as `senaite_tee_retry`, every 5 min):
    drain due pending rows. Never raises past a single row; caller commits."""
    t = _now(now)
    stats = {"retried": 0, "done": 0, "gave_up": 0, "superseded": 0, "errors": 0}
    due = db.execute(
        select(LimsSenaiteTeeRetry).where(
            LimsSenaiteTeeRetry.status == "pending",
            LimsSenaiteTeeRetry.next_attempt_at <= t,
        ).order_by(LimsSenaiteTeeRetry.next_attempt_at).limit(batch)
    ).scalars().all()
    for row in due:
        try:
            sample = db.get(LimsSample, row.lims_sample_pk)
            if sample is None:
                row.status = "done"
                stats["superseded"] += 1
                continue
            # A later native state wins: never push SENAITE somewhere Mk1 has left.
            if sample.status != row.expected_state:
                row.status = "done"
                row.last_error = f"superseded: native status is {sample.status!r}"
                stats["superseded"] += 1
                continue
            stats["retried"] += 1
            new_status = _attempt(db, sample, row, now=now)
            if new_status == "done":
                stats["done"] += 1
            elif new_status == "gave_up":
                stats["gave_up"] += 1
        except Exception:
            log.exception("senaite_tee.retry_failed row=%s", row.id)
            stats["errors"] += 1
        db.flush()
    log.info("senaite_tee.run_retries %s", stats)
    return stats


def gave_up_count(db: Session) -> int:
    from sqlalchemy import func
    return int(db.execute(
        select(func.count()).select_from(LimsSenaiteTeeRetry).where(
            LimsSenaiteTeeRetry.status == "gave_up")
    ).scalar() or 0)
```

- [ ] **Step 4: Register the job**

In `backend/main.py`, immediately before `    _flag_scheduler.start()` (after the `flag_watch_poller` registration), add:

```python
    # Sample-status authority flip (2026-09-09 spec §5): drain SENAITE tee
    # refusals. Runs in BOTH authority modes — the silent-200 class is
    # SENAITE's defect regardless of who owns the badge.
    from workflow import senaite_tee as _senaite_tee

    def _tee_retry_job(now):
        db = _SessionLocal()
        try:
            _senaite_tee.run_retries(db, now=now)
            db.commit()
        finally:
            db.close()
    _flag_scheduler.register("senaite_tee_retry", interval=_timedelta(minutes=5),
                             fn=_tee_retry_job)
```

- [ ] **Step 5: Summary count**

In `backend/workflow/routes.py::shadow_summary` (the handler for `GET /shadow/summary`), where the response dict is assembled with the `buckets` (search for `"buckets": buckets`), add the key `"senaite_lagging": senaite_tee.gave_up_count(db)` to that dict and `from workflow import senaite_tee` at the top of the function. Add to `backend/tests/test_senaite_tee_retry_job.py`:

```python
def test_summary_reports_gave_up_count(db_session):
    from workflow.senaite_tee import gave_up_count
    _, q = _queued(db_session, "P-RJ-6", "verify")
    q.status = "gave_up"
    db_session.flush()
    assert gave_up_count(db_session) == 1
```

- [ ] **Step 6: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_senaite_tee_retry_job.py tests/test_senaite_tee.py tests/test_workflow_shadow_summary*.py`
Expected: all pass (`test_workflow_shadow_summary*` may not exist; if `ls tests/test_workflow_shadow_summary*.py` is empty, run the routes suite `tests/test_workflow_routes*.py` instead).

- [ ] **Step 7: Commit**

```bash
git add backend/workflow/senaite_tee.py backend/main.py backend/workflow/routes.py backend/tests/test_senaite_tee_retry_job.py
git commit -m "feat(workflow): senaite_tee_retry scheduler job + senaite_lagging summary count"
```

**Execution rulings (2026-09-09, task review fix round 1 — the shipped `run_retries` differs from Step 3 in these ways):** each row is processed inside `with db.begin_nested():` (SAVEPOINT) so a failing row rolls back only itself and the session stays usable for the rest of the batch (on Postgres a failed statement otherwise poisons the transaction); the "later native state wins" check compares the verb's target against `sample.native_status` when set (falling back to `status`) — under senaite authority `status` is SENAITE's lagging mirror, so the Step 3 comparison would have marked every refused transition superseded on its first pass. The third test was strengthened to an IntegrityError raised inside the flush (a bare Python exception never touches the session and cannot discriminate the fix).

---

### Task 9: Wire the tee at the touchpoints

**Files:**
- Modify: `backend/workflow/engine.py:329-360` (`run_cascades_bg`) and `drive_sample_touchpoint`
- Modify: `backend/main.py` publish route (`publish_sample_coa`, ~12463-12720)
- Test: `backend/tests/test_senaite_tee.py` (append), `backend/tests/test_publish_route_authority.py`

**Interfaces:**
- Produces: `engine.tee_advances(db, sample, fired: list[LimsWorkflowShadowEvaluation]) -> None` — for each fired advance whose `to_status` has an entry in `EXPECTED_AR_STATES` values (`verified`, `published`, `cancelled`), call `senaite_tee.tee_now(db, sample, verb)` where verb is the advance's verb. Called from `run_cascades_bg` after `evaluate_cascades`.
- Publish route: in mk1 mode the native publish touchpoint runs synchronously (before the SENAITE tee) and a refused SENAITE publish enqueues a retry.

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_senaite_tee.py
def test_tee_advances_only_for_senaite_representable_states(db_session):
    from workflow import engine
    from models import LimsWorkflowShadowEvaluation
    row = _sample(db_session, sid="P-TEE-6", uid="U-TEE-6", status="verified")
    fired = [
        LimsWorkflowShadowEvaluation(lims_sample_pk=row.id, trigger="t", verb="submit",
                                     from_status="sample_received", to_status="to_be_verified",
                                     outcome="advanced", requirements_met=True, outcomes=[]),
        LimsWorkflowShadowEvaluation(lims_sample_pk=row.id, trigger="t", verb="verify",
                                     from_status="to_be_verified", to_status="verified",
                                     outcome="advanced", requirements_met=True, outcomes=[]),
    ]
    with patch("workflow.senaite_tee.tee_now") as tn:
        engine.tee_advances(db_session, row, fired)
    tn.assert_called_once_with(db_session, row, "verify")
```

```python
# backend/tests/test_publish_route_authority.py
"""Publish route under mk1 authority: native publish verb runs BEFORE the
SENAITE tee, and a refused SENAITE publish becomes a retry row."""
import json
from unittest.mock import patch

from sqlalchemy import select

from models import LimsSample, LimsSenaiteTeeRetry, Settings


def test_refused_senaite_publish_enqueues_retry(db_session):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    db_session.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": "mk1"})))
    row = LimsSample(sample_id="P-PUB-1", status="verified", native_status="verified",
                     external_lims_uid="U-PUB-1")
    db_session.add(row)
    db_session.flush()
    from workflow.senaite_tee import enqueue_retry
    from main import _after_publish_native   # the helper Task 9 extracts
    with patch("workflow.senaite_tee.read_back_state", return_value="to_be_verified"):
        _after_publish_native(db_session, sample_id="P-PUB-1", pre_publish_status="verified",
                              actor_user_id=1, senaite_actual_state="to_be_verified")
    assert row.status == "published"
    q = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert q.verb == "publish" and q.status == "pending"
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_senaite_tee.py tests/test_publish_route_authority.py`
Expected: FAIL — `AttributeError: module 'workflow.engine' has no attribute 'tee_advances'` / `ImportError: cannot import name '_after_publish_native'`

- [ ] **Step 3: Engine hook**

Append to `backend/workflow/engine.py`:

```python
_TEE_TO_STATES = frozenset({"verified", "published", "cancelled"})


def tee_advances(db: Session, sample: LimsSample, fired: list) -> None:
    """Spec §5: tee each native advance SENAITE can represent (verify /
    publish / cancel), prove it by read-back, queue refusals. Never raises."""
    from workflow import senaite_tee
    for ev in fired:
        if ev.to_status in _TEE_TO_STATES and ev.verb in senaite_tee.EXPECTED_AR_STATES:
            try:
                senaite_tee.tee_now(db, sample, ev.verb)
            except Exception:
                log.exception("senaite tee failed (never-raise) sample=%s verb=%s",
                              sample.sample_id, ev.verb)
```

In `run_cascades_bg`, replace the two lines inside `if sample is not None:`

```python
            evaluate_cascades(db, sample, trigger="analysis_cascade",
                              actor_user_id=actor_user_id)
            db.commit()
```

with

```python
            fired = evaluate_cascades(db, sample, trigger="analysis_cascade",
                                      actor_user_id=actor_user_id)
            db.commit()
            # Spec §5: prove each SENAITE-representable advance; refusals queue.
            tee_advances(db, sample, fired)
            db.commit()
```

(The existing try/except never-raise shell stays around it.)

- [ ] **Step 4: Publish route synchrony + retry enqueue**

In `backend/main.py`, add a module-level helper next to `_record_sample_transition_bg`:

```python
def _after_publish_native(db, *, sample_id: str, pre_publish_status, actor_user_id,
                          senaite_actual_state: str) -> None:
    """Sample-status authority flip (spec §4.4 / §5): the native publish verb is
    the user's direct intent, so it runs synchronously (ledger + engine), and a
    SENAITE publish that did not read back as 'published' becomes a retry row.
    Flush + commit here; never raises (publish already succeeded on IS)."""
    try:
        from workflow.engine import drive_sample_touchpoint
        from workflow.sample_log import record_sample_transition
        from workflow import senaite_tee
        record_sample_transition(db, sample_id=sample_id, verb="publish",
                                 to_status="published", from_status=pre_publish_status,
                                 source="mk1", actor_user_id=actor_user_id)
        # The publish touchpoint is the attester the engine's `coa_published`
        # requirement kind needs (engine._eval_one reads `attested`); without
        # it the verified -> published edge is requirements_unmet.
        drive_sample_touchpoint(db, sample_id, "publish", from_status=pre_publish_status,
                                actor_user_id=actor_user_id,
                                attested={"coa_published": True})
        if senaite_actual_state != "published":
            row = db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)
                             ).scalar_one_or_none()
            if row is not None:
                senaite_tee.enqueue_retry(
                    db, row, "publish",
                    error=f"publish route read-back {senaite_actual_state!r}")
        db.commit()
    except Exception:
        logger.exception("after-publish native step failed (never-raise) %s", sample_id)
        db.rollback()
```

Then in `publish_sample_coa`, replace the block

```python
                if actual_state == "published":
                    from fastapi.concurrency import run_in_threadpool
                    await run_in_threadpool(
                        _mark_shadows_published_bg, sample_id=sample_id
                    )
                    # Task 3: native sample-transition log (own session,
                    # never-fail — see _record_sample_transition_bg).
                    await run_in_threadpool(
                        _record_sample_transition_bg,
                        sample_id=sample_id, verb="publish", to_status="published",
                        from_status=_pre_publish_status,
                        source="mk1",
                        actor_user_id=getattr(current_user, "id", None),
                    )
```

with

```python
                if actual_state == "published":
                    from fastapi.concurrency import run_in_threadpool
                    await run_in_threadpool(
                        _mark_shadows_published_bg, sample_id=sample_id
                    )
                # Authority flip: native publish runs regardless of what
                # SENAITE accepted; a refusal is queued for retry (spec §5).
                from fastapi.concurrency import run_in_threadpool as _rit
                await _rit(
                    _after_publish_native, db,
                    sample_id=sample_id, pre_publish_status=_pre_publish_status,
                    actor_user_id=getattr(current_user, "id", None),
                    senaite_actual_state=actual_state,
                )
```

Note: `_after_publish_native` replaces the old `_record_sample_transition_bg(..., verb="publish")` call on this path only; the helper stays for its other callers. The route's request `db` is used deliberately (the helper commits it; the response is built after).

Also (Task 4 review ruling): in `_record_sample_transition_bg` (main.py, the helper whose body calls `record_sample_transition(db, **kwargs)` and then `heal_sample_status(db, kwargs["sample_id"], kwargs["to_status"])`), thread the caller's source through to the heal so a native caller is honoured under mk1 authority:

```python
        wrote_status = heal_sample_status(
            db, kwargs["sample_id"], kwargs["to_status"],
            source=kwargs.get("source", "senaite"),
        )
```

(keep the surrounding variable names exactly as they are in the file; only the `source=` kwarg is added).

- [ ] **Step 5: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_senaite_tee.py tests/test_publish_route_authority.py tests/test_workflow_engine.py tests/test_coa_*.py`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add backend/workflow/engine.py backend/main.py backend/tests/test_senaite_tee.py backend/tests/test_publish_route_authority.py
git commit -m "feat(workflow): tee native advances to SENAITE; publish route runs native verb synchronously + queues refusals"
```

---

### Task 10: Stranded-sample detector (flags)

**Files:**
- Create: `backend/workflow/stranded.py`
- Modify: `backend/flags/types_service.py` `_BUILTINS` (append) and `backend/database.py` (flag type seed SQL, after the `identity_collision` seed)
- Modify: `backend/main.py` lifespan (register `workflow_stranded_check`)
- Test: `backend/tests/test_workflow_stranded.py`

**Interfaces:**
- Produces: `find_stranded(db, *, since_days=90) -> list[Stranded]` where `Stranded = dataclass(sample: LimsSample, condition: str, diagnosis: str)`; conditions `lines_verified_status_behind`, `published_in_ledger_not_status`, `native_mirror_disagree` (mk1 mode only), `senaite_tee_gave_up`; `run_check(db, *, now=None) -> dict` with keys `flagged, resolved, skipped_no_actor, errors`; flag type slug `workflow_stranded`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_workflow_stranded.py
"""Detection, not sweeping (spec §6.2): one flag per stranded sample with
the diagnosis; resolves itself when the condition clears; writes nothing else."""
import json
from datetime import datetime, timezone

from sqlalchemy import select

from flags.models import FlagEntityLink, FlagFlag
from models import (AnalysisService, LimsAnalysis, LimsSample, LimsSampleTransition,
                    LimsSenaiteTeeRetry, Settings, User)

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _base(db, authority="senaite"):
    from flags.types_service import seed_builtins
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    seed_builtins(db)
    db.add(User(email="admin@x.t", hashed_password="x", role="admin"))
    db.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": authority})))
    db.flush()


def _parent_with_verified_line(db, sid, status):
    p = LimsSample(sample_id=sid, status=status, native_status=status,
                   date_received=datetime(2026, 9, 1, tzinfo=timezone.utc))
    db.add(p)
    db.flush()
    svc = AnalysisService(keyword=f"K-{sid}", title="t")
    db.add(svc)
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=p.id, lims_sub_sample_pk=None, analysis_service_id=svc.id,
                        keyword=svc.keyword, title="t", review_state="verified",
                        provenance="canonical", retested=False))
    db.flush()
    return p


def _flags(db):
    return db.execute(select(FlagFlag).where(FlagFlag.type == "workflow_stranded")).scalars().all()


def test_lines_verified_but_status_behind_raises_one_flag(db_session):
    from workflow.stranded import find_stranded, run_check
    _base(db_session)
    p = _parent_with_verified_line(db_session, "P-ST-1", "sample_received")
    found = find_stranded(db_session)
    assert [(s.sample.sample_id, s.condition) for s in found] == [("P-ST-1", "lines_verified_status_behind")]
    stats = run_check(db_session, now=NOW)
    assert stats["flagged"] == 1
    flags = _flags(db_session)
    assert len(flags) == 1 and flags[0].status == "open"
    link = db_session.execute(select(FlagEntityLink).where(FlagEntityLink.flag_id == flags[0].id)).scalar_one()
    assert (link.entity_type, link.entity_id) == ("sample", "P-ST-1")
    # second run: no duplicate
    run_check(db_session, now=NOW)
    assert len(_flags(db_session)) == 1
    # status never touched
    assert p.status == "sample_received"


def test_flag_resolves_when_condition_clears(db_session):
    from workflow.stranded import run_check
    _base(db_session)
    p = _parent_with_verified_line(db_session, "P-ST-2", "sample_received")
    run_check(db_session, now=NOW)
    p.status = "verified"
    db_session.flush()
    stats = run_check(db_session, now=NOW)
    assert stats["resolved"] == 1
    assert _flags(db_session)[0].status == "resolved"


def test_published_in_ledger_but_not_status(db_session):
    from workflow.stranded import find_stranded
    _base(db_session)
    p = LimsSample(sample_id="P-ST-3", status="verified", native_status="verified",
                   date_received=datetime(2026, 9, 1, tzinfo=timezone.utc))
    db_session.add(p)
    db_session.flush()
    db_session.add(LimsSampleTransition(lims_sample_pk=p.id, verb="publish", from_status="verified",
                                        to_status="published", source="mk1", occurred_at=NOW))
    db_session.flush()
    assert [s.condition for s in find_stranded(db_session)] == ["published_in_ledger_not_status"]


def test_native_mirror_disagree_only_in_mk1_mode(db_session):
    from workflow.stranded import find_stranded
    _base(db_session, authority="mk1")
    db_session.add(LimsSample(sample_id="P-ST-4", status="sample_received", native_status="verified",
                              date_received=datetime(2026, 9, 1, tzinfo=timezone.utc)))
    db_session.flush()
    assert [s.condition for s in find_stranded(db_session)] == ["native_mirror_disagree"]


def test_gave_up_tee_is_stranded(db_session):
    from workflow.stranded import find_stranded
    _base(db_session)
    p = LimsSample(sample_id="P-ST-5", status="published", native_status="published",
                   date_received=datetime(2026, 9, 1, tzinfo=timezone.utc))
    db_session.add(p)
    db_session.flush()
    db_session.add(LimsSenaiteTeeRetry(lims_sample_pk=p.id, verb="publish", expected_state="published",
                                       attempts=8, next_attempt_at=NOW, status="gave_up"))
    db_session.flush()
    assert [s.condition for s in find_stranded(db_session)] == ["senaite_tee_gave_up"]


def test_no_admin_user_skips_flagging(db_session):
    from workflow.stranded import run_check
    from flags.types_service import seed_builtins
    from workflow.seeds import seed_workflow_catalog
    seed_workflow_catalog(db_session)
    seed_builtins(db_session)
    _parent_with_verified_line(db_session, "P-ST-6", "sample_received")
    stats = run_check(db_session, now=NOW)
    assert stats["skipped_no_actor"] == 1 and _flags(db_session) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_stranded.py`
Expected: 6 FAIL — `ModuleNotFoundError: No module named 'workflow.stranded'`

- [ ] **Step 3: Seed the flag type**

In `backend/flags/types_service.py::_BUILTINS` append:

```python
    # Sample-status authority flip (2026-09-09 spec §6.2): stranded samples.
    ("workflow_stranded", "Workflow Stranded", "#f59e0b", "issue", False, 8),
```

In `backend/database.py`, directly after the `identity_collision` seed statement (the SQL string ending `WHERE NOT EXISTS (SELECT 1 FROM flag_types WHERE slug='identity_collision')`), add the same shape for the new type:

```python
        """
        INSERT INTO flag_types (slug, label, color, kind, is_blocking, is_active, sort_order, entity_types, is_builtin)
        SELECT 'workflow_stranded', 'Workflow Stranded', '#f59e0b', 'issue', FALSE, TRUE, 8, '[]'::jsonb, TRUE
        WHERE NOT EXISTS (SELECT 1 FROM flag_types WHERE slug='workflow_stranded')
        """,
```

(Copy the column list from the `identity_collision` statement verbatim if it differs from the above — the two statements must be shape-identical.)

- [ ] **Step 4: Implement the detector**

```python
# backend/workflow/stranded.py
"""Stranded-sample detector (spec §6.2). Read-only over samples; its only
writes are flags. Never advances a status — a stranded sample is a bug to
find and fix at the root (Handler ruling 2026-09-09)."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from flags import catalog as flag_catalog
from flags import service as flag_service
from flags.models import FlagEntityLink, FlagFlag
from models import (LimsSample, LimsSampleTransition, LimsSenaiteTeeRetry,
                    LimsWorkflowShadowEvaluation, User)
from workflow.authority import sample_status_authority
from workflow.engine import _live_parent_line_states

log = logging.getLogger(__name__)

FLAG_TYPE = "workflow_stranded"
_BEHIND_VERIFIED = frozenset({"sample_registered", "sample_due", "sample_received",
                              "ready_for_initial_review", "waiting_for_addon_results",
                              "to_be_verified"})


@dataclass
class Stranded:
    sample: LimsSample
    condition: str
    diagnosis: str


def _recent_samples(db: Session, since_days: int) -> list[LimsSample]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
    return db.execute(
        select(LimsSample).where(LimsSample.date_received >= cutoff)
    ).scalars().all()


def _diagnosis(db: Session, sample: LimsSample, condition: str) -> str:
    last_eval = db.execute(
        select(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == sample.id,
            LimsWorkflowShadowEvaluation.outcome != "advanced",
        ).order_by(LimsWorkflowShadowEvaluation.id.desc()).limit(1)
    ).scalars().first()
    log_rows = db.execute(
        select(LimsSampleTransition).where(
            LimsSampleTransition.lims_sample_pk == sample.id
        ).order_by(LimsSampleTransition.occurred_at.desc()).limit(3)
    ).scalars().all()
    lines = [f"Condition: {condition}",
             f"status={sample.status!r} native_status={sample.native_status!r}"]
    if last_eval is not None:
        lines.append(f"Last cascade refusal: verb={last_eval.verb} outcome={last_eval.outcome} "
                     f"outcomes={last_eval.outcomes}")
    for r in log_rows:
        lines.append(f"log: {r.occurred_at:%Y-%m-%d %H:%M} {r.source} {r.verb} "
                     f"{r.from_status}->{r.to_status}")
    return "\n".join(lines)


def find_stranded(db: Session, *, since_days: int = 90) -> list[Stranded]:
    mk1 = sample_status_authority(db) == "mk1"
    gave_up_pks = set(db.execute(
        select(LimsSenaiteTeeRetry.lims_sample_pk).where(LimsSenaiteTeeRetry.status == "gave_up")
    ).scalars().all())
    published_pks = set(db.execute(
        select(LimsSampleTransition.lims_sample_pk).where(
            LimsSampleTransition.verb == "publish", LimsSampleTransition.source == "mk1")
    ).scalars().all())
    out: list[Stranded] = []
    for s in _recent_samples(db, since_days):
        condition: Optional[str] = None
        if s.status in _BEHIND_VERIFIED:
            states = _live_parent_line_states(db, s)
            if states and all(v == "verified" for v in states.values()):
                condition = "lines_verified_status_behind"
        if condition is None and s.id in published_pks and s.status != "published":
            condition = "published_in_ledger_not_status"
        if condition is None and mk1 and s.native_status and s.native_status != s.status:
            condition = "native_mirror_disagree"
        if condition is None and s.id in gave_up_pks:
            condition = "senaite_tee_gave_up"
        if condition is not None:
            out.append(Stranded(sample=s, condition=condition,
                                diagnosis=_diagnosis(db, s, condition)))
    return out


def _actor(db: Session):
    admin = db.execute(
        select(User).where(User.role == "admin").order_by(User.id).limit(1)
    ).scalars().first()
    return None if admin is None else SimpleNamespace(id=admin.id, role="admin")


def _open_flag_for(db: Session, sample_id: str) -> Optional[FlagFlag]:
    return db.execute(
        select(FlagFlag).join(FlagEntityLink, FlagEntityLink.flag_id == FlagFlag.id).where(
            FlagFlag.type == FLAG_TYPE,
            FlagFlag.status.in_(flag_catalog.OPEN_STATES),
            FlagEntityLink.entity_type == "sample",
            FlagEntityLink.entity_id == sample_id,
        ).order_by(FlagFlag.id.desc()).limit(1)
    ).scalars().first()


def run_check(db: Session, *, now: Optional[datetime] = None, since_days: int = 90) -> dict:
    """Scheduler job body (`workflow_stranded_check`, every 15 min)."""
    stats = {"flagged": 0, "resolved": 0, "skipped_no_actor": 0, "errors": 0}
    actor = _actor(db)
    stranded = find_stranded(db, since_days=since_days)
    stranded_ids = {s.sample.sample_id for s in stranded}
    if actor is None:
        stats["skipped_no_actor"] = len(stranded)
        return stats
    for s in stranded:
        try:
            if _open_flag_for(db, s.sample.sample_id) is not None:
                continue
            flag_service.create_flag(
                db, user=actor, entity_type="sample", entity_id=s.sample.sample_id,
                type=FLAG_TYPE,
                title=f"{s.sample.sample_id} stranded: {s.condition.replace('_', ' ')}",
                first_comment=s.diagnosis)
            stats["flagged"] += 1
        except Exception:
            log.exception("stranded.flag_failed sample=%s", s.sample.sample_id)
            stats["errors"] += 1
    # resolve flags whose sample is no longer stranded
    open_flags = db.execute(
        select(FlagFlag, FlagEntityLink.entity_id)
        .join(FlagEntityLink, FlagEntityLink.flag_id == FlagFlag.id)
        .where(FlagFlag.type == FLAG_TYPE, FlagFlag.status.in_(flag_catalog.OPEN_STATES),
               FlagEntityLink.entity_type == "sample")
    ).all()
    for flag, sample_id in open_flags:
        if sample_id in stranded_ids:
            continue
        try:
            flag_service.add_comment(db, user=actor, flag_id=flag.id,
                                     body="Condition cleared — resolved by the stranded-sample check.")
            flag_service.change_status(db, user=actor, flag_id=flag.id, to_status="resolved")
            stats["resolved"] += 1
        except Exception:
            log.exception("stranded.resolve_failed flag=%s", flag.id)
            stats["errors"] += 1
    log.info("workflow.stranded_check %s", stats)
    return stats
```

`create_flag`, `add_comment` and `change_status` each commit internally via `_commit_and_emit` (so the job's own `db.commit()` in Task 10 step 5 is a harmless no-op after them). The `sample` entity seam is registered at `flags.seams` import time (module-level `register(...)` calls; `flags.service` imports `seams`, and `stranded.py` imports `flags.service`, so the registry is populated before `run_check` runs — the existing flags tests rely on the same import-time registration with `entity_type="sub_sample"`). `entity_id` is the sample id string, as `main.py`'s own `create_flag(... entity_type="sample", entity_id=...)` calls pass it.

- [ ] **Step 5: Register the job**

In `backend/main.py`, right after the `senaite_tee_retry` registration from Task 8:

```python
    from workflow import stranded as _stranded

    def _stranded_job(now):
        db = _SessionLocal()
        try:
            _stranded.run_check(db, now=now)
            db.commit()
        finally:
            db.close()
    _flag_scheduler.register("workflow_stranded_check", interval=_timedelta(minutes=15),
                             fn=_stranded_job)
```

- [ ] **Step 6: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_workflow_stranded.py tests/test_flags_*.py`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add backend/workflow/stranded.py backend/flags/types_service.py backend/database.py backend/main.py backend/tests/test_workflow_stranded.py
git commit -m "feat(workflow): stranded-sample detector raises/resolves workflow_stranded flags"
```

---

### Task 11: Analysis-tier `cancel` verb

**Files:**
- Modify: `backend/lims_analyses/state_machine.py` (`STATES`, `TRANSITION_KINDS`, `_ALLOWED`, `_TIER_ALLOWED_KINDS`)
- Modify: `backend/lims_analyses/schemas.py:58-61` (`TransitionKind` Literal)
- Modify: `backend/database.py` (two CHECK re-issues)
- Test: `backend/tests/test_cancel_state_machine.py`

**Interfaces:**
- Produces: `next_state(from, "cancel", tier)` → `"cancelled"` from `unassigned | assigned | to_be_verified | parent_to_verify`; `"cancelled"` in `STATES`; `apply_transition(db, analysis_id=…, kind="cancel", reason=…, user_id=…, commit=False)` works on both tiers.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_cancel_state_machine.py
import pytest

from lims_analyses.state_machine import (InvalidTransitionError, STATES, TIER_PARENT,
                                         TIER_VIAL, TRANSITION_KINDS, next_state, tier_allows)


@pytest.mark.parametrize("frm", ["unassigned", "assigned", "to_be_verified"])
def test_vial_pending_rows_cancel(frm):
    assert next_state(frm, "cancel", TIER_VIAL) == "cancelled"


def test_parent_to_verify_cancels():
    assert next_state("parent_to_verify", "cancel", TIER_PARENT) == "cancelled"


@pytest.mark.parametrize("frm", ["verified", "promoted", "variance_verified", "published"])
def test_finished_rows_never_cancel(frm):
    with pytest.raises(InvalidTransitionError):
        next_state(frm, "cancel", None)


def test_vocabulary():
    assert "cancel" in TRANSITION_KINDS and "cancelled" in STATES
    assert tier_allows(TIER_VIAL, "cancel") and tier_allows(TIER_PARENT, "cancel")


def test_apply_transition_cancel_audits(db_session):
    from lims_analyses.service import apply_transition
    from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample, LimsSubSample
    from sqlalchemy import select
    p = LimsSample(sample_id="P-CSM-1", status="sample_received")
    db_session.add(p)
    db_session.flush()
    v = LimsSubSample(sample_id="P-CSM-1-S01", parent_sample_pk=p.id, vial_sequence=1,
                      external_lims_uid="mk1://vial/csm-1")   # NOT NULL + unique
    db_session.add(v)
    svc = AnalysisService(keyword="K-CSM", title="t")
    db_session.add(svc)
    db_session.flush()
    a = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=svc.id, keyword="K-CSM",
                     title="t", review_state="assigned", provenance="canonical", retested=False)
    db_session.add(a)
    db_session.flush()
    apply_transition(db_session, analysis_id=a.id, kind="cancel", reason="customer request",
                     user_id=None, commit=False)
    assert a.review_state == "cancelled"
    t = db_session.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == a.id)).scalar_one()
    assert (t.transition_kind, t.to_state, t.reason) == ("cancel", "cancelled", "customer request")
```

(If `LimsSubSample` requires more NOT NULL columns in this fixture, copy the constructor used by `tests/test_clear_analyte.py`'s vial helper.)

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_cancel_state_machine.py`
Expected: FAIL — `UnknownKindError`/`InvalidTransitionError` for cancel; vocabulary assertion fails.

- [ ] **Step 3: Implement the state machine**

In `backend/lims_analyses/state_machine.py`:
- add `"cancelled"` to the `STATES` frozenset (line 74 block);
- add `"cancel"` to `TRANSITION_KINDS`;
- add to `_ALLOWED`:

```python
    # Native cancel (2026-09-09 spec §3.4): pending work dies with the sample;
    # verified / promoted / variance-verified / published rows are history.
    ("unassigned",       "cancel"): "cancelled",
    ("assigned",         "cancel"): "cancelled",
    ("to_be_verified",   "cancel"): "cancelled",
    ("parent_to_verify", "cancel"): "cancelled",
```

- add `"cancel"` to both frozensets in `_TIER_ALLOWED_KINDS`.

In `backend/lims_analyses/schemas.py` add `"cancel"` to the `TransitionKind` Literal.

In `backend/database.py`, directly after the existing `lims_analysis_transitions_transition_kind_check` DROP+ADD pair (lines ~801-806), append a new pair with `'cancel'` added:

```python
        "ALTER TABLE lims_analysis_transitions DROP CONSTRAINT IF EXISTS lims_analysis_transitions_transition_kind_check",
        """
        ALTER TABLE lims_analysis_transitions ADD CONSTRAINT lims_analysis_transitions_transition_kind_check
            CHECK (transition_kind IN
                ('assign','submit','verify','retract','reject',
                 'retest','publish','reset','auto','variance_verify','observed','cancel'))
        """,
```

and after the existing `lims_analyses_review_state_check` DROP+ADD pair (lines ~740-750), a new pair whose list is the existing list plus `'cancelled'` (copy the existing list verbatim and append `, 'cancelled'`). Both new pairs sit AFTER the old ones so last-boot-wins yields the extended lists.

- [ ] **Step 4: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_cancel_state_machine.py tests/test_state_machine*.py tests/test_lims_analyses*.py`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/state_machine.py backend/lims_analyses/schemas.py backend/database.py backend/tests/test_cancel_state_machine.py
git commit -m "feat(lims-analyses): analysis-tier cancel verb (pending rows -> cancelled)"
```

---

### Task 12: Cancel cascade service

**Files:**
- Modify: `backend/lims_analyses/service.py` (append)
- Test: `backend/tests/test_cancel_pending_rows.py`

**Interfaces:**
- Produces: `cancel_pending_rows(db, *, parent_sample_pk: int, user_id: Optional[int], reason: str) -> dict` returning `{"cancelled_rows": [ids], "released_worksheets": [worksheet ids], "kept_rows": [ids]}`; `preview_cancel(db, *, parent_sample_pk) -> dict` with the same keys computed without writing.
- Consumes: Task 11 `apply_transition(kind="cancel")`, existing `worksheet_analyst.clear_for_item(..., reset_state=False)`, `WorksheetItem`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_cancel_pending_rows.py
from sqlalchemy import select

from models import (AnalysisService, LimsAnalysis, LimsSample, LimsSubSample, Worksheet,
                    WorksheetItem)


def _fixture(db):
    p = LimsSample(sample_id="P-CPR-1", status="sample_received", native_status="sample_received")
    db.add(p)
    db.flush()
    v = LimsSubSample(sample_id="P-CPR-1-S01", parent_sample_pk=p.id, vial_sequence=1,
                      external_lims_uid="mk1://vial/1")
    db.add(v)
    svc = AnalysisService(keyword="K-CPR", title="t")
    db.add(svc)
    db.flush()
    rows = {}
    for name, state, host in (("pending_vial", "assigned", "vial"),
                              ("done_vial", "promoted", "vial"),
                              ("pending_parent", "parent_to_verify", "parent"),
                              ("done_parent", "verified", "parent")):
        a = LimsAnalysis(analysis_service_id=svc.id, keyword="K-CPR", title="t", review_state=state,
                         provenance="canonical", retested=False,
                         lims_sub_sample_pk=v.id if host == "vial" else None,
                         lims_sample_pk=None if host == "vial" else p.id)
        db.add(a)
        db.flush()
        rows[name] = a
    ws = Worksheet(title="WS-CPR", status="open")
    db.add(ws)
    db.flush()
    item = WorksheetItem(worksheet_id=ws.id, sample_uid="mk1://vial/1", sample_id="P-CPR-1-S01")
    db.add(item)
    db.flush()
    return p, v, rows, ws, item


def test_preview_counts_without_writing(db_session):
    from lims_analyses.service import preview_cancel
    p, v, rows, ws, item = _fixture(db_session)
    pv = preview_cancel(db_session, parent_sample_pk=p.id)
    assert sorted(pv["cancelled_rows"]) == sorted([rows["pending_vial"].id, rows["pending_parent"].id])
    assert pv["released_worksheets"] == [ws.id]
    assert rows["pending_vial"].review_state == "assigned"


def test_cancel_pending_rows_cancels_releases_and_keeps_history(db_session):
    from lims_analyses.service import cancel_pending_rows
    p, v, rows, ws, item = _fixture(db_session)
    out = cancel_pending_rows(db_session, parent_sample_pk=p.id, user_id=None, reason="customer")
    assert sorted(out["cancelled_rows"]) == sorted([rows["pending_vial"].id, rows["pending_parent"].id])
    assert rows["pending_vial"].review_state == "cancelled"
    assert rows["pending_parent"].review_state == "cancelled"
    assert rows["done_vial"].review_state == "promoted"
    assert rows["done_parent"].review_state == "verified"
    assert out["released_worksheets"] == [ws.id]
    assert db_session.execute(select(WorksheetItem).where(WorksheetItem.id == item.id)).scalar_one_or_none() is None
```

(If `Worksheet` needs other NOT NULL columns, copy the constructor from `tests/test_worksheet_assign_transition.py`.)

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_cancel_pending_rows.py`
Expected: FAIL — `ImportError: cannot import name 'preview_cancel'`

- [ ] **Step 3: Implement**

Append to `backend/lims_analyses/service.py`:

```python
CANCEL_PENDING_STATES = frozenset({"unassigned", "assigned", "to_be_verified", "parent_to_verify"})


def _cancel_targets(db: Session, *, parent_sample_pk: int):
    """Live canonical/ordered rows on the parent and its vials that are still
    pending — the rows a customer cancellation kills. Finished rows are
    history and stay (spec §3.4)."""
    from models import LimsSubSample
    from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
    vial_pks = [v.id for v in db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent_sample_pk)
    ).scalars()]
    rows = db.execute(
        select(LimsAnalysis).where(
            or_(LimsAnalysis.lims_sample_pk == parent_sample_pk,
                LimsAnalysis.lims_sub_sample_pk.in_(vial_pks or [-1])),
            LimsAnalysis.provenance.in_(("canonical", PROVENANCE_ORDERED)),
            LimsAnalysis.retested.is_(False),
            LimsAnalysis.review_state.in_(CANCEL_PENDING_STATES),
        ).order_by(LimsAnalysis.id)
    ).scalars().all()
    uids = [v.external_lims_uid for v in db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent_sample_pk)
    ).scalars() if v.external_lims_uid]
    items = db.execute(
        select(WorksheetItem).where(WorksheetItem.sample_uid.in_(uids or ["-"]))
    ).scalars().all() if uids else []
    return rows, items


def preview_cancel(db: Session, *, parent_sample_pk: int) -> Dict:
    rows, items = _cancel_targets(db, parent_sample_pk=parent_sample_pk)
    return {"cancelled_rows": [r.id for r in rows],
            "released_worksheets": sorted({i.worksheet_id for i in items}),
            "kept_rows": []}


def cancel_pending_rows(db: Session, *, parent_sample_pk: int, user_id: Optional[int],
                        reason: str) -> Dict:
    """Spec §8.3: cancel every pending row (audited per row), then release the
    vials from their worksheets WITHOUT a reset transition (the rows are dead).
    Flush-only; the route commits."""
    from lims_analyses.worksheet_analyst import clear_for_item
    rows, items = _cancel_targets(db, parent_sample_pk=parent_sample_pk)
    cancelled = []
    for r in rows:
        apply_transition(db, analysis_id=r.id, kind="cancel", reason=reason,
                         user_id=user_id, commit=False)
        cancelled.append(r.id)
    released = []
    for item in items:
        clear_for_item(db, sample_uid=item.sample_uid, service_group_id=item.service_group_id,
                       acting_user_id=user_id, worksheet_id=item.worksheet_id,
                       department_id=item.department_id, reset_state=False)
        released.append(item.worksheet_id)
        db.delete(item)
    db.flush()
    return {"cancelled_rows": cancelled, "released_worksheets": sorted(set(released)),
            "kept_rows": []}
```

Ensure `WorksheetItem` and `or_` are imported at the top of `lims_analyses/service.py` (`from models import WorksheetItem`; `from sqlalchemy import or_` — both may already be present; check with grep).

- [ ] **Step 4: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_cancel_pending_rows.py tests/test_worksheet_assign_transition.py tests/test_clear_analyte.py`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/service.py backend/tests/test_cancel_pending_rows.py
git commit -m "feat(lims-analyses): cancel_pending_rows cascade + worksheet release"
```

---

### Task 13: Catalog seeds — cancel from every state, partial-publish pathway

**Files:**
- Modify: `backend/workflow/seeds.py` (`SEED_TRANSITIONS`)
- Test: `backend/tests/test_cancel_seeds.py`

**Interfaces:**
- Produces: seeded `cancel` transitions into `cancelled` from every sample state except `cancelled`; a partial-publish edge `sample_received → waiting_for_addon_results` keyed by verb **`publish`** (`auto_fire=False`, requirement `{"kind": "coa_published", "value": None, "note": "attested by the publish touchpoint"}` — the engine's `coa_published` kind is satisfied only by the publish touchpoint's `attested={"coa_published": True}`, so the edge must carry the verb that touchpoint executes; the spec's working name `partial_publish` is therefore realised as the `publish` verb from `sample_received`) and `submit` (`waiting_for_addon_results → to_be_verified`, auto_fire, same requirement entry as the seeded `sample_received → to_be_verified` submit edge).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_cancel_seeds.py
from sqlalchemy import select

from models import LimsWorkflowState, LimsWorkflowTransition


def _edges(db, verb):
    S = LimsWorkflowState
    rows = db.execute(
        select(LimsWorkflowTransition).where(LimsWorkflowTransition.entity_scope == "sample",
                                             LimsWorkflowTransition.verb == verb)
    ).scalars().all()
    by_id = {s.id: s.slug for s in db.execute(select(S).where(S.entity_scope == "sample")).scalars()}
    return {(by_id[t.from_state_id], by_id[t.to_state_id]): t for t in rows}


def test_cancel_edges_from_every_state(db_session):
    from workflow.seeds import SEED_STATES, seed_workflow_catalog
    seed_workflow_catalog(db_session)
    edges = _edges(db_session, "cancel")
    expected = {slug for (scope, slug, *_r) in SEED_STATES if scope == "sample"} - {"cancelled"}
    assert {frm for (frm, to) in edges} == expected
    assert all(to == "cancelled" and not t.auto_fire and t.requirements == [] for (frm, to), t in edges.items())


def test_partial_publish_pathway(db_session):
    from workflow.seeds import seed_workflow_catalog
    seed_workflow_catalog(db_session)
    pub = _edges(db_session, "publish")
    assert ("sample_received", "waiting_for_addon_results") in pub
    t = pub[("sample_received", "waiting_for_addon_results")]
    assert not t.auto_fire
    assert t.requirements == [{"kind": "coa_published", "value": None,
                               "note": "attested by the publish touchpoint"}]
    # the two pre-existing publish edges are untouched
    assert ("verified", "published") in pub and ("waiting_for_addon_results", "published") in pub
    sub = _edges(db_session, "submit")
    assert ("waiting_for_addon_results", "to_be_verified") in sub
    assert sub[("waiting_for_addon_results", "to_be_verified")].requirements == \
        sub[("sample_received", "to_be_verified")].requirements


def test_seed_is_idempotent(db_session):
    from workflow.seeds import seed_workflow_catalog
    seed_workflow_catalog(db_session)
    n1 = len(_edges(db_session, "cancel"))
    seed_workflow_catalog(db_session)
    assert len(_edges(db_session, "cancel")) == n1
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_cancel_seeds.py`
Expected: first two FAIL (only two cancel edges exist; no partial_publish edge)

- [ ] **Step 3: Implement**

In `backend/workflow/seeds.py::SEED_TRANSITIONS`, replace the two existing cancel tuples with a generated block. Immediately after the list literal closes, append:

```python
# Native cancel (2026-09-09 spec §3.3): a customer can cancel at ANY point, so
# every sample state except `cancelled` gets an edge. Data, not code — the
# Settings -> Workflow pane owns these afterwards (seed is insert-if-missing).
_CANCEL_FROM = [slug for (scope, slug, *_r) in SEED_STATES if scope == "sample" and slug != "cancelled"]
SEED_TRANSITIONS += [
    ("sample", frm, "cancelled", "cancel", False, [],
     "Customer-requested cancellation; allowed at any point.")
    for frm in _CANCEL_FROM
    if frm not in ("sample_due", "sample_received")   # the two original edges stay as written
]
# Partial-publish pathway (spec §3.3): a primary COA published while add-on
# lines are still pending. Keyed by the `publish` verb because the engine's
# `coa_published` requirement is satisfied ONLY by the publish touchpoint's
# attestation (engine._eval_one: `met = bool((attested or {}).get("coa_published"))`)
# and _find_edge looks up (from_state, verb) — so the touchpoint's own verb
# must be the edge's verb. Not auto_fire (cascades never attest).
_SUBMIT_REQS = next(reqs for (scope, f, t, verb, _af, reqs, _d) in SEED_TRANSITIONS
                    if scope == "sample" and f == "sample_received" and verb == "submit")
_COA_PUBLISHED_REQ = [{"kind": "coa_published", "value": None,
                       "note": "attested by the publish touchpoint"}]
SEED_TRANSITIONS += [
    ("sample", "sample_received", "waiting_for_addon_results", "publish", False,
     _COA_PUBLISHED_REQ, "Primary COA out while add-on lines are still pending (partial publish)."),
    ("sample", "waiting_for_addon_results", "to_be_verified", "submit", True, _SUBMIT_REQS,
     "Add-on results submitted; back onto the verify path."),
]
```

`_find_edge` selects by `(from_state, verb)`; there is no pre-existing `publish` edge out of `sample_received`, so this adds a pathway without shadowing one (the `verified → published` and `waiting_for_addon_results → published` publish edges are untouched — pinned by the test).

- [ ] **Step 4: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_cancel_seeds.py tests/test_workflow_engine.py tests/test_workflow_cascade_refusals.py`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/workflow/seeds.py backend/tests/test_cancel_seeds.py
git commit -m "feat(workflow): seed cancel edges from every state + partial-publish pathway"
```

---

### Task 14: Cancel route

**Files:**
- Create: `backend/workflow/cancel_routes.py`
- Modify: `backend/main.py` — `app.include_router(cancel_router)` after `app.include_router(workflow_router)` (line ~536), with `from workflow.cancel_routes import router as cancel_router` beside the other router imports
- Test: `backend/tests/test_cancel_route.py`

**Interfaces:**
- Produces: `POST /api/samples/{sample_id}/cancel` body `{reason: str, confirm: bool=false, dry_run: bool=false}` → 200 `{status, from_status, cancelled_rows, released_worksheets, published_coa_still_live, dry_run}`; 404 unknown sample; 409 already cancelled / no edge; 412 `{detail: <preview>}` when `confirm` is false and not dry-run; 412 with engine outcomes when requirements unmet.
- Consumes: Task 3 `execute_verb`, engine `arm_native_status`, Task 12 `preview_cancel` / `cancel_pending_rows`, Task 7 `tee_now`, `LimsSubSampleEvent`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_cancel_route.py
import json
from unittest.mock import patch

from sqlalchemy import select

from models import LimsSample, LimsSubSampleEvent, Settings


def _prep(db, authority="mk1", status="sample_received", code=None):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    db.add(Settings(key="registry_read_source", value=json.dumps({"sample_status": authority})))
    row = LimsSample(sample_id="P-CX-1", status=status, native_status=status,
                     external_lims_uid="U-CX-1", verification_code=code)
    db.add(row)
    db.commit()
    return row


def test_dry_run_previews_without_writing(route_client):
    db = route_client._test_session
    row = _prep(db, status="published", code="ABCD-EFGH")
    r = route_client.post("/api/samples/P-CX-1/cancel", json={"reason": "customer asked", "dry_run": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True and body["published_coa_still_live"] is True
    assert body["from_status"] == "published"
    db.expire_all()
    assert row.status == "published"


def test_requires_confirm(route_client):
    db = route_client._test_session
    _prep(db)
    r = route_client.post("/api/samples/P-CX-1/cancel", json={"reason": "customer asked"})
    assert r.status_code == 412
    assert "cancelled_rows" in r.json()["detail"]


def test_cancel_writes_status_event_and_tees(route_client):
    db = route_client._test_session
    row = _prep(db)
    with patch("workflow.senaite_tee.tee_now", return_value="done") as tn:
        r = route_client.post("/api/samples/P-CX-1/cancel",
                              json={"reason": "customer asked", "confirm": True})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"
    db.expire_all()
    assert row.status == "cancelled" and row.native_status == "cancelled"
    ev = db.execute(select(LimsSubSampleEvent).where(LimsSubSampleEvent.lims_sample_pk == row.id)).scalar_one()
    assert ev.event == "sample_cancelled" and ev.details["reason"] == "customer asked"
    assert tn.call_count == 1


def test_already_cancelled_is_409(route_client):
    db = route_client._test_session
    _prep(db, status="cancelled")
    r = route_client.post("/api/samples/P-CX-1/cancel", json={"reason": "again", "confirm": True})
    assert r.status_code == 409


def test_short_reason_is_422(route_client):
    db = route_client._test_session
    _prep(db)
    r = route_client.post("/api/samples/P-CX-1/cancel", json={"reason": "no", "confirm": True})
    assert r.status_code == 422


def test_senaite_mode_moves_native_only(route_client):
    db = route_client._test_session
    row = _prep(db, authority="senaite")
    with patch("workflow.senaite_tee.tee_now", return_value="done"):
        r = route_client.post("/api/samples/P-CX-1/cancel",
                              json={"reason": "customer asked", "confirm": True})
    assert r.status_code == 200
    db.expire_all()
    assert row.native_status == "cancelled" and row.status == "sample_received"
```

Use the `route_client` fixture from `tests/test_analysis_service_routes.py` (copy its definition into this file's top if it is not in `conftest.py`; it is a local fixture today).

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_cancel_route.py`
Expected: FAIL — 404 (route not registered)

- [ ] **Step 3: Implement the route**

```python
# backend/workflow/cancel_routes.py
"""POST /api/samples/{sample_id}/cancel — native cancel (spec §8).

Order (one transaction): engine verb (catalog edge; 409 no edge, 412 unmet)
-> analysis-tier cascade + worksheet release -> sample_cancelled event ->
commit -> SENAITE tee in a background task (never blocks the user).
`dry_run` returns the same shape without writing; `confirm=false` on a real
call returns 412 carrying the preview (the dialog's gate).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import LimsSample, LimsSubSampleEvent

router = APIRouter(prefix="/api/samples", tags=["samples"])


class CancelSampleBody(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)
    confirm: bool = False
    dry_run: bool = False


def _preview(db: Session, row: LimsSample) -> dict:
    from lims_analyses.service import preview_cancel
    pv = preview_cancel(db, parent_sample_pk=row.id)
    return {
        "status": row.status, "from_status": row.status,
        "cancelled_rows": pv["cancelled_rows"],
        "released_worksheets": pv["released_worksheets"],
        "published_coa_still_live": bool(row.verification_code),
        "dry_run": True,
    }


def _tee_cancel_bg(sample_pk: int) -> None:
    from database import SessionLocal
    from workflow import senaite_tee
    db = SessionLocal()
    try:
        row = db.get(LimsSample, sample_pk)
        if row is not None:
            senaite_tee.tee_now(db, row, "cancel")
            db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


@router.post("/{sample_id}/cancel")
def cancel_sample(sample_id: str, body: CancelSampleBody, background_tasks: BackgroundTasks,
                  db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    from lims_analyses.service import cancel_pending_rows
    from workflow.engine import arm_native_status, execute_verb
    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id).with_for_update()
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"sample {sample_id} not found")
    if row.status == "cancelled" or row.native_status == "cancelled":
        raise HTTPException(409, f"{sample_id} is already cancelled")
    preview = _preview(db, row)
    if body.dry_run:
        return preview
    if not body.confirm:
        raise HTTPException(412, detail=preview)
    actor_id = getattr(current_user, "id", None)
    if row.native_status is None:
        arm_native_status(db, row, row.status, trigger="cancel", actor_user_id=actor_id)
    from_status = row.native_status
    ev = execute_verb(db, row, "cancel", trigger="cancel", actor_user_id=actor_id)
    if ev is None or ev.outcome == "no_edge":
        db.rollback()
        raise HTTPException(409, f"no cancel edge from {from_status!r} in the workflow catalog")
    if ev.outcome == "requirements_unmet":
        db.rollback()
        raise HTTPException(412, detail={"requirements": ev.outcomes})
    cascade = cancel_pending_rows(db, parent_sample_pk=row.id, user_id=actor_id, reason=body.reason)
    db.add(LimsSubSampleEvent(
        lims_sample_pk=row.id, event="sample_cancelled", user_id=actor_id,
        details={"reason": body.reason, "from_status": from_status,
                 "published_coa": bool(row.verification_code),
                 "cancelled_rows": len(cascade["cancelled_rows"]),
                 "released_worksheets": cascade["released_worksheets"]},
    ))
    db.commit()
    background_tasks.add_task(_tee_cancel_bg, row.id)
    return {
        "status": row.status, "from_status": from_status,
        "cancelled_rows": cascade["cancelled_rows"],
        "released_worksheets": cascade["released_worksheets"],
        "published_coa_still_live": bool(row.verification_code),
        "dry_run": False,
    }
```

Note for the tests: `TestClient` runs background tasks after the response, in-process, so patching `workflow.senaite_tee.tee_now` is observed (`_tee_cancel_bg` resolves it at call time via the module attribute). `execute_verb`'s status write happens only in mk1 mode (Task 3), which is what `test_senaite_mode_moves_native_only` pins.

- [ ] **Step 4: Register the router**

In `backend/main.py`, next to the other router imports add `from workflow.cancel_routes import router as cancel_router`, and after `app.include_router(workflow_router)` add `app.include_router(cancel_router)`.

- [ ] **Step 5: Run the tests**

Run: `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_cancel_route.py tests/test_cancel_pending_rows.py tests/test_workflow_status_write.py`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add backend/workflow/cancel_routes.py backend/main.py backend/tests/test_cancel_route.py
git commit -m "feat(api): POST /api/samples/{id}/cancel — native cancel with dry-run preview and confirm gate"
```

---

### Task 15: Frontend — authority switch in the Data Source pane

**Files:**
- Modify: `src/lib/read-source.ts` (append)
- Modify: `src/components/preferences/panes/DataSourcePane.tsx`
- Test: `src/components/preferences/panes/__tests__/DataSourcePane.test.tsx` (append)

**Interfaces:**
- Produces: `SAMPLE_STATUS_KEY = 'sample_status'`, `parseSampleStatusAuthority(raw) -> ReadSource`; the pane's save writes `{ ...sourceByPage, [COA_SOURCE_KEY]: coaSource, [SAMPLE_STATUS_KEY]: statusAuthority }`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/preferences/panes/__tests__/DataSourcePane.test.tsx` (reuse its existing `renderPane` / mocked `getSettings` + `updateSetting` helpers — read the file's first 35 lines and follow the `saving includes coa_generation in the written map` test verbatim in shape):

```tsx
it('saving includes sample_status in the written map and preserves it when untouched', async () => {
  const put = mockSettings([
    { key: 'registry_read_source', value: JSON.stringify({ sample_details: 'senaite', sample_status: 'mk1' }) } as api.Setting,
  ])
  renderPane()
  await screen.findByText(/Sample status authority/i)
  expect(screen.getByRole('button', { name: /Sample status authority: Accu-Mk1/i })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByRole('button', { name: /Sample details.*SENAITE|SENAITE.*Sample details/i }))
  fireEvent.click(screen.getByRole('button', { name: /^Save/i }))
  await waitFor(() => expect(put).toHaveBeenCalled())
  const written = put.mock.calls[0][1]
  expect(JSON.parse(written as string)).toMatchObject({ sample_status: 'mk1' })
})
```

(If the existing tests name their helpers differently — `mockSettings`, `renderPane` — use the file's actual names; the assertions are what matter.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/preferences/panes/__tests__/DataSourcePane.test.tsx`
Expected: FAIL — "Unable to find an element with the text: /Sample status authority/i"

- [ ] **Step 3: Implement**

Append to `src/lib/read-source.ts`:

```ts
/** Backend-read key: who WRITES lims_samples.status (spec 2026-09-09 §3.1).
 *  Absent/malformed -> 'senaite' (SENAITE mirror), 'mk1' -> native engine. */
export const SAMPLE_STATUS_KEY = 'sample_status'
export function parseSampleStatusAuthority(rawValue: string | undefined | null): ReadSource {
  if (!rawValue) return DEFAULT_READ_SOURCE
  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>
    const v = parsed?.[SAMPLE_STATUS_KEY]
    return v === 'mk1' || v === 'senaite' ? v : DEFAULT_READ_SOURCE
  } catch {
    return DEFAULT_READ_SOURCE
  }
}
```

In `DataSourcePane.tsx`:
1. Import `SAMPLE_STATUS_KEY, parseSampleStatusAuthority` from `@/lib/read-source`.
2. Add state next to `coaSource`: `const [statusAuthority, setStatusAuthority] = useState<ReadSource>('senaite')`.
3. Where the settings query result initialises `coaSource` (search `setCoaSource(parseCoaGenerationSource(`), add `setStatusAuthority(parseSampleStatusAuthority(map.get(READ_SOURCE_SETTING_KEY)))` using the same source string.
4. In the save mutation, change the written object to `JSON.stringify({ ...sourceByPage, [COA_SOURCE_KEY]: coaSource, [SAMPLE_STATUS_KEY]: statusAuthority })`.
5. Below the `<SettingsSection title="COA generation">` block, add a sibling section that mirrors its two-button toggle markup exactly (same classes, same `aria-label` pattern, same `aria-pressed`), with title `Sample status authority`, labels `SENAITE` / `Accu-Mk1`, `aria-label={\`Sample status authority: ${source === 'mk1' ? 'Accu-Mk1' : 'SENAITE'}\`}`, `onClick={() => { setStatusAuthority(source); setIsDirty(true) }}`, and this helper text: "Who writes a sample's status. SENAITE: the badge mirrors SENAITE's review state (today). Accu-Mk1: the workflow engine writes it from the catalog and SENAITE follows. Flip only when the stranded-sample check has been clean for 48 h."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/preferences/panes/__tests__/DataSourcePane.test.tsx && npx tsc --noEmit`
Expected: all pass; typecheck clean

- [ ] **Step 5: Commit**

```bash
git add src/lib/read-source.ts src/components/preferences/panes/DataSourcePane.tsx src/components/preferences/panes/__tests__/DataSourcePane.test.tsx
git commit -m "feat(ui): sample status authority toggle in the Data Source pane"
```

---

### Task 16: Frontend — catalog-driven state labels

**Files:**
- Create: `src/lib/workflow-states-store.ts`
- Modify: `src/components/senaite/senaite-utils.tsx` (`StateBadge`), `src/components/explorer/helpers.tsx` (the state-config function around line 118)
- Modify: `src/App.tsx` (mount `WorkflowStatesLoader`)
- Test: `src/test/workflow-states-store.test.tsx`

**Interfaces:**
- Produces: zustand store `useWorkflowStatesStore` with `{ states: Record<string, { label: string; category: WorkflowCategory; sort_order: number }>, setStates(list: WorkflowState[]) }`; `labelFor(slug: string, fallback: string): string`; component `WorkflowStatesLoader` (renders null; fetches `getWorkflowGraph('sample')` once via TanStack Query and fills the store).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/test/workflow-states-store.test.tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useWorkflowStatesStore, labelFor } from '@/lib/workflow-states-store'
import { StateBadge } from '@/components/senaite/senaite-utils'

beforeEach(() => {
  useWorkflowStatesStore.setState({ states: {} })
})

describe('workflow states store', () => {
  it('falls back to the hardcoded map when the store is empty', () => {
    render(<StateBadge state="to_be_verified" />)
    expect(screen.getByText('To Verify')).toBeInTheDocument()
    expect(labelFor('on_hold', 'on_hold')).toBe('on_hold')
  })

  it('uses the catalog label once loaded, including runtime-added states', () => {
    useWorkflowStatesStore.getState().setStates([
      { id: 1, slug: 'to_be_verified', label: 'Awaiting review', category: 'active', sort_order: 60 } as never,
      { id: 2, slug: 'on_hold', label: 'On hold', category: 'active', sort_order: 55 } as never,
    ])
    render(<><StateBadge state="to_be_verified" /><StateBadge state="on_hold" /></>)
    expect(screen.getByText('Awaiting review')).toBeInTheDocument()
    expect(screen.getByText('On hold')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/test/workflow-states-store.test.tsx`
Expected: FAIL — cannot resolve `@/lib/workflow-states-store`

- [ ] **Step 3: Implement the store + loader**

```ts
// src/lib/workflow-states-store.ts
import { create } from 'zustand'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { getWorkflowGraph, type WorkflowCategory, type WorkflowState } from '@/lib/workflow-api'

/** Catalog is the source of truth for sample status labels (spec 2026-09-09 §7.2).
 *  A plain zustand store so badges work with no provider (tests, storybook);
 *  empty store = hardcoded fallback maps. */
interface StateInfo { label: string; category: WorkflowCategory; sort_order: number }
interface WorkflowStatesStore {
  states: Record<string, StateInfo>
  setStates: (list: WorkflowState[]) => void
}

export const useWorkflowStatesStore = create<WorkflowStatesStore>(set => ({
  states: {},
  setStates: list =>
    set({
      states: Object.fromEntries(
        list.map(s => [s.slug, { label: s.label, category: s.category, sort_order: s.sort_order }])
      ),
    }),
}))

export function labelFor(slug: string, fallback: string): string {
  return useWorkflowStatesStore.getState().states[slug]?.label ?? fallback
}

export function useStateLabel(slug: string, fallback: string): string {
  return useWorkflowStatesStore(s => s.states[slug]?.label ?? fallback)
}

/** Mount once near the app root: fetches the sample-scope graph and fills the store. */
export function WorkflowStatesLoader() {
  const setStates = useWorkflowStatesStore(s => s.setStates)
  const { data } = useQuery({
    queryKey: ['workflow', 'graph', 'sample'],
    queryFn: () => getWorkflowGraph('sample'),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })
  useEffect(() => {
    if (data?.states) setStates(data.states.filter(s => s.is_active))
  }, [data, setStates])
  return null
}
```

(Check `WorkflowState` in `src/lib/workflow-api.ts` has `is_active`; if it does not, drop the filter.)

In `senaite-utils.tsx::StateBadge` replace the label line:

```tsx
export function StateBadge({ state }: { state: string }) {
  const config = STATE_LABELS[state] ?? { label: state, className: 'bg-zinc-700 text-zinc-200' }
  const label = useStateLabel(state, config.label)
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', config.className)}>
      {label}
    </span>
  )
}
```

(Keep the existing JSX around it; only the label source changes. Import `useStateLabel` from `@/lib/workflow-states-store`.)

In `explorer/helpers.tsx`, in the function that returns `{ variant, label }` for a state (the one holding the `sample_received: { variant: 'secondary', label: 'Received' }` map), wrap the returned label: `label: labelFor(s, config[s]?.label ?? state)` using the store's non-hook `labelFor` (this helper is not a component). Import `labelFor`.

In `src/App.tsx`, inside the existing `QueryClientProvider` subtree, render `<WorkflowStatesLoader />` once (any position; it renders null).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/test/workflow-states-store.test.tsx src/test/vial-board*.test.tsx && npx tsc --noEmit && npx eslint src/lib/workflow-states-store.ts src/components/senaite/senaite-utils.tsx src/components/explorer/helpers.tsx`
Expected: tests pass; typecheck clean; eslint reports no NEW errors on the three files versus `origin/master` (compare counts with `git stash`/`git checkout origin/master -- <file>` if unsure).

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow-states-store.ts src/components/senaite/senaite-utils.tsx src/components/explorer/helpers.tsx src/App.tsx src/test/workflow-states-store.test.tsx
git commit -m "feat(ui): sample status labels from the workflow catalog with hardcoded fallback"
```

---

### Task 17: Frontend — Cancel sample dialog + header action

**Files:**
- Modify: `src/lib/api.ts` (append `cancelSample` after `clearAnalyteSlot`)
- Create: `src/components/senaite/CancelSampleDialog.tsx`
- Modify: `src/components/senaite/SampleDetails.tsx` (state + dropdown item + mount, beside the existing `clearSlot` dialog)
- Test: `src/test/cancel-sample-dialog.test.tsx`

**Interfaces:**
- Produces: `cancelSample(sampleId, { reason, confirm?, dryRun? }): Promise<CancelSamplePreview | CancelSampleResult>`; `CancelSampleDialog({ open, sampleId, currentStatus, onClose, onCancelled })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/test/cancel-sample-dialog.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CancelSampleDialog } from '@/components/senaite/CancelSampleDialog'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, cancelSample: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { cancelSample } from '@/lib/api'
import { toast } from 'sonner'
const mockCancel = vi.mocked(cancelSample)

const PREVIEW = {
  status: 'published', from_status: 'published', cancelled_rows: [1, 2],
  released_worksheets: [7], published_coa_still_live: true, dry_run: true as const,
}
const RESULT = { ...PREVIEW, status: 'cancelled', dry_run: false as const }

function renderDialog() {
  const onClose = vi.fn(); const onCancelled = vi.fn()
  render(<CancelSampleDialog open sampleId="PB-0001" currentStatus="published" onClose={onClose} onCancelled={onCancelled} />)
  return { onClose, onCancelled }
}

beforeEach(() => vi.clearAllMocks())

describe('CancelSampleDialog', () => {
  it('previews on open, warns about the live COA, and needs reason + typed id', async () => {
    mockCancel.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce(RESULT)
    const { onCancelled } = renderDialog()
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('PB-0001', expect.objectContaining({ dryRun: true })))
    expect(await screen.findByText(/2 pending results will be cancelled/i)).toBeInTheDocument()
    expect(screen.getByText(/1 worksheet/i)).toBeInTheDocument()
    expect(screen.getByText(/published certificate .* stay live/i)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /^cancel sample$/i })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Customer withdrew the order' } })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/type pb-0001 to confirm/i), { target: { value: 'pb-0001' } })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(mockCancel).toHaveBeenLastCalledWith('PB-0001', expect.objectContaining({ confirm: true, reason: 'Customer withdrew the order' })))
    await waitFor(() => expect(onCancelled).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalled()
  })

  it('surfaces a server error as a toast and keeps the dialog open', async () => {
    mockCancel.mockResolvedValueOnce({ ...PREVIEW, published_coa_still_live: false })
      .mockRejectedValueOnce(Object.assign(new Error('no cancel edge'), { status: 409 }))
    const { onCancelled } = renderDialog()
    await screen.findByText(/2 pending results/i)
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Customer withdrew' } })
    fireEvent.change(screen.getByLabelText(/type pb-0001 to confirm/i), { target: { value: 'PB-0001' } })
    fireEvent.click(screen.getByRole('button', { name: /^cancel sample$/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onCancelled).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/test/cancel-sample-dialog.test.tsx`
Expected: FAIL — cannot resolve `CancelSampleDialog` / `cancelSample` is not exported

- [ ] **Step 3: API client**

Append to `src/lib/api.ts` after `clearAnalyteSlot`:

```ts
export interface CancelSamplePreview {
  status: string
  from_status: string
  cancelled_rows: number[]
  released_worksheets: number[]
  published_coa_still_live: boolean
  dry_run: true
}
export interface CancelSampleResult extends Omit<CancelSamplePreview, 'dry_run'> { dry_run: false }

export async function cancelSample(
  sampleId: string,
  body: { reason: string; confirm?: boolean; dryRun?: boolean },
): Promise<CancelSamplePreview | CancelSampleResult> {
  const response = await fetch(`${API_BASE_URL()}/api/samples/${encodeURIComponent(sampleId)}/cancel`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ reason: body.reason, confirm: body.confirm ?? false, dry_run: body.dryRun ?? false }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const err = new Error(
      typeof payload?.detail === 'string' ? payload.detail : `Cancel failed: ${response.status}`,
    ) as Error & { status?: number; detail?: unknown }
    err.status = response.status
    err.detail = payload?.detail
    throw err
  }
  return response.json()
}
```

- [ ] **Step 4: Dialog**

```tsx
// src/components/senaite/CancelSampleDialog.tsx
import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cancelSample, type CancelSamplePreview } from '@/lib/api'

interface Props {
  open: boolean
  sampleId: string
  currentStatus: string
  onClose: () => void
  onCancelled: () => void
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * Cancel a sample at any point in the process (customer request). Dry-run
 * preview on open; requires a reason and the sample id typed back. When a
 * COA is already published it says so: cancelling never withdraws it.
 */
export function CancelSampleDialog({ open, sampleId, currentStatus, onClose, onCancelled }: Props) {
  const [preview, setPreview] = useState<CancelSamplePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPreview(null); setPreviewError(null); setReason(''); setTyped('')
    cancelSample(sampleId, { reason: 'preview', dryRun: true })
      .then(res => { if (!cancelled && res.dry_run) setPreview(res) })
      .catch((e: Error) => { if (!cancelled) setPreviewError(e.message) })
    return () => { cancelled = true }
  }, [open, sampleId])

  const confirmMatches = typed.trim().toLowerCase() === sampleId.toLowerCase()
  const canSubmit = preview !== null && reason.trim().length >= 3 && confirmMatches && !pending

  async function doCancel() {
    setPending(true)
    try {
      await cancelSample(sampleId, { reason: reason.trim(), confirm: true })
      toast.success(`${sampleId} cancelled`)
      onCancelled()
      onClose()
    } catch (e) {
      toast.error('Cancel failed', { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !pending) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Cancel sample {sampleId}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground -mt-1">
          Current status: {currentStatus}. Cancelling stops all pending work on this sample.
        </p>
        {preview === null && previewError === null && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 size={14} className="animate-spin" /> Checking what this would touch…
          </div>
        )}
        {previewError !== null && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
            <span>Could not preview the change: {previewError}</span>
          </div>
        )}
        {preview !== null && (
          <ul className="space-y-1 text-sm">
            <li>{plural(preview.cancelled_rows.length, 'pending result')} will be cancelled.</li>
            <li>{plural(preview.released_worksheets.length, 'worksheet')} will release this sample.</li>
            {preview.published_coa_still_live && (
              <li className="text-amber-600 dark:text-amber-400">
                The published certificate and its AccuVerify page stay live. Cancelling does not withdraw them.
              </li>
            )}
          </ul>
        )}
        <label className="block text-xs text-muted-foreground mt-2">
          Reason
          <textarea value={reason} onChange={e => setReason(e.target.value)} disabled={preview === null}
            rows={2} className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50" />
        </label>
        <label className="block text-xs text-muted-foreground mt-2">
          Type {sampleId} to confirm
          <input type="text" value={typed} onChange={e => setTyped(e.target.value)} disabled={preview === null}
            autoComplete="off" className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50" />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Keep sample</Button>
          <Button variant="destructive" onClick={doCancel} disabled={!canSubmit}>
            {pending ? 'Cancelling…' : 'Cancel sample'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 5: Header action in SampleDetails**

In `src/components/senaite/SampleDetails.tsx`:
1. `import { CancelSampleDialog } from './CancelSampleDialog'` and `import { Ban } from 'lucide-react'` (add `Ban` to the existing lucide import list).
2. Next to the existing `const [clearSlot, setClearSlot] = useState<...>` add `const [cancelOpen, setCancelOpen] = useState(false)`.
3. In the header `<DropdownMenuContent align="end" className="w-60">` (the one holding `handleGenerateCOA` / `handlePublishCOA`), append as the last item, hidden once cancelled:

```tsx
                        {data.review_state !== 'cancelled' && (
                          <DropdownMenuItem
                            onClick={() => setCancelOpen(true)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Ban className="h-4 w-4 mr-2" />
                            Cancel sample…
                          </DropdownMenuItem>
                        )}
```

4. Next to the `<ClearAnalyteDialog … />` mount add:

```tsx
      <CancelSampleDialog
        open={cancelOpen}
        sampleId={data.sample_id}
        currentStatus={data.review_state ?? ''}
        onClose={() => setCancelOpen(false)}
        onCancelled={() => refreshSample(data.sample_id)}
      />
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/test/cancel-sample-dialog.test.tsx src/test/clear-analyte-dialog.test.tsx && npx tsc --noEmit && npx eslint src/components/senaite/CancelSampleDialog.tsx src/lib/api.ts src/components/senaite/SampleDetails.tsx`
Expected: tests pass; typecheck clean; no new eslint errors on the touched files versus `origin/master` (SampleDetails.tsx carries pre-existing debt — compare counts, do not chase).

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/components/senaite/CancelSampleDialog.tsx src/components/senaite/SampleDetails.tsx src/test/cancel-sample-dialog.test.tsx
git commit -m "feat(ui): Cancel sample action with dry-run preview, reason and typed confirm"
```

---

### Task 18: Gating, changelog, PR

**Files:**
- Modify: `CHANGELOG.md` (new `## v1.16.0 — <date>` section at the top; version bump happens at deploy time, not here)
- No code changes.

- [ ] **Step 1: Backend failure-set diff (SOLO runs)**

```bash
cd backend
.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/ > /c/tmp/fs_branch.log 2>&1
grep "^FAILED" /c/tmp/fs_branch.log | sed 's/ - .*//' | sort > /c/tmp/fs_branch.txt
git worktree add --detach /c/tmp/mk1-base-flip origin/master
cd /c/tmp/mk1-base-flip/backend
/c/Projects/accumk1-vial-status-wt/backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/ > /c/tmp/fs_base.log 2>&1
grep "^FAILED" /c/tmp/fs_base.log | sed 's/ - .*//' | sort > /c/tmp/fs_base.txt
comm -23 /c/tmp/fs_branch.txt /c/tmp/fs_base.txt     # net-new: must be empty or known flake classes
```

Run the two suites one after the other, never concurrently. Known flake classes that pass in isolation: `test_clickup_task_retry.py` (3), `test_httpx_shared_ssl.py` (2, the `.venv` BOM artifact on branch worktrees). Re-run any other net-new test in isolation before calling it a flake; a real failure goes back to its task.

- [ ] **Step 2: Frontend gates**

```bash
npx tsc --noEmit
npx vitest run src/test/cancel-sample-dialog.test.tsx src/test/workflow-states-store.test.tsx src/components/preferences/panes/__tests__/DataSourcePane.test.tsx
npx vitest run     # full; compare failure set to origin/master the same way (flag/* and auth suites flake under CPU contention — isolation rerun decides)
```

- [ ] **Step 3: Changelog**

Prepend to `CHANGELOG.md` under `# Changelog`:

```markdown
## v1.16.0 — 2026-09-XX

### Added
- **Sample-status authority switch** (`Settings → Data Source → Sample status authority`): under `Accu-Mk1` the workflow engine writes the sample's status from the catalog and SENAITE follows; the SENAITE-sourced mirrors stop writing it. Default stays `SENAITE`. Spec `docs/superpowers/specs/2026-09-09-sample-status-authority-flip-design.md`.
- **SENAITE tee with read-back and retry**: verify / publish / cancel are teed to SENAITE, proven by re-reading the AR, and refusals are queued (`lims_senaite_tee_retries`) for the `senaite_tee_retry` job (5 min, backoff, gives up after 8). A refused publish issues `verify` first (the PB-0462 class). Shadow summary reports `senaite_lagging`.
- **Stranded-sample detector** (`workflow_stranded_check`, 15 min, read-only): raises one `Workflow Stranded` flag per sample whose verified lines are ahead of its status, whose publish ledger has no matching status, whose native and mirror disagree (Mk1 authority), or whose SENAITE tee gave up; resolves it when the condition clears. Cascade refusals are now recorded with their unmet requirement.
- **Cancel sample** from any state: `POST /api/samples/{id}/cancel` (dry-run preview, reason, confirm) + the sample page's "Cancel sample…" action with a typed confirm; pending analysis rows are cancelled and released from worksheets, finished rows stay as history, a published COA stays live (the dialog says so). Catalog edges seeded from every state; analysis-tier `cancel` verb.
- Catalog is the source of truth for status vocabulary: the status writers accept any active catalog state; badges take their label from the catalog with the hardcoded map as fallback. Seeded `partial_publish` pathway keeps the add-on-pending badge meaningful.
```

Replace `XX` with the day the PR merges.

- [ ] **Step 4: PR**

```bash
git push -u origin feat/sample-status-authority-flip
gh pr create --repo Zstar0/Accu-Mk1 --base master --head feat/sample-status-authority-flip \
  --title "feat(workflow): sample-status authority flip + SENAITE tee/retry + stranded detector + native cancel" \
  --body-file docs/superpowers/plans/pr-body-authority-flip.md
```

Write `docs/superpowers/plans/pr-body-authority-flip.md` from the changelog section plus: the spec path, the rollout steps from spec §11 (deploy dark → work the flags → flip when clean 48 h), the failure-set diff summary, and the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/superpowers/plans/pr-body-authority-flip.md
git commit -m "docs: changelog + PR body for the sample-status authority flip"
```

---

## Self-review (done while writing; kept for the executor)

- **Spec coverage** — §3.1 Task 1, 15 · §3.2 Task 6 · §3.3 Task 13 · §3.4 Task 11 · §4.1 Task 3 · §4.2 Task 4 · §4.4 Task 9 (publish synchrony; receive already synchronous via Task 4's `source="mk1"`; cancel synchronous in Task 14) · §5 Tasks 7, 8, 9 · §6.1 Task 5 · §6.2 Task 10 · §6.3 no task by design (manual script stays) · §7.1 Task 2 · §7.2 Task 16 · §7.3 Task 13 · §8.1 Task 14 · §8.2 Task 17 · §8.3 Task 12 · §9 residual classes are operational work in rollout step 2 (no code) · §10 fail-safes live inside Tasks 1, 3, 7, 8, 10 · §11 rollout is in the PR body (Task 18) · §12 tests per task.
- **Type consistency** — `sample_status_authority(db)` (Tasks 1, 2, 3, 4, 10); `sample_state_slugs(db)` / `clear_sample_state_cache()` (Tasks 2, 3, tests); `heal_sample_status(..., source=)` (Tasks 2, 4); `tee_now(db, sample, verb)` / `enqueue_retry(db, sample, verb, *, error, now)` / `read_back_state(sample)` / `_ar_transition(uid, verb)` (Tasks 7, 8, 9, 14); `run_retries(db, *, now, batch)` (Task 8); `tee_advances(db, sample, fired)` (Task 9); `find_stranded(db, *, since_days)` / `run_check(db, *, now, since_days)` (Task 10); `preview_cancel(db, *, parent_sample_pk)` / `cancel_pending_rows(db, *, parent_sample_pk, user_id, reason)` (Tasks 12, 14); `cancelSample(sampleId, {reason, confirm, dryRun})` (Task 17); `useWorkflowStatesStore` / `labelFor` / `useStateLabel` (Task 16).
- **Placeholders** — none; the two "verify the exact shape then mirror it" notes (Task 13 `coa_published` entry, Task 15 test helper names) point at concrete files and lines to read, not at work left undefined.
