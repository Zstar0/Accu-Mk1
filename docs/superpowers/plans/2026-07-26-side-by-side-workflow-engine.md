# Side-by-Side Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mk1 executes sample-tier workflow transitions in parallel with SENAITE — its own `native_status`, driven by its own catalog + requirements at Mk1-originated trigger sites — so a divergence report can prove Mk1 could run the lab alone.

**Architecture:** One new nullable column (`lims_samples.native_status`, materialized convenience) + one new table (`lims_workflow_shadow_evaluations`, the authoritative trajectory). A pure DB-local engine (`workflow/engine.py`) looks up catalog edges by verb from `native_status`, evaluates requirements, and advances or refuses — recording every attempt. Touchpoints piggyback the existing mk1 hook chokepoint and the native analysis-transition routes, all fail-open behind an env gate. SENAITE behavior is byte-identical; no existing reader changes.

**Tech Stack:** FastAPI + SQLAlchemy (backend), pytest against the live subvial Postgres via `SessionLocal` (house test convention), React/TS (one debug-panel block).

**Spec:** `docs/superpowers/specs/2026-07-26-side-by-side-workflow-engine-design.md` (Handler-approved 2026-07-26).

## Global Constraints

- **Additive only.** No existing column, CHECK, or reader changes. NEVER modify a CHECK constraint (last-boot-wins hazard — database.py's own comments). New vocabularies are enforced in code, not CHECKs.
- **`lims_sample_transitions` is untouched** — no new `source` value, no writes from this slice.
- **Fail-open everywhere:** an engine/recorder exception must never fail receive, publish, or an analysis transition. Wrap every touchpoint call.
- **No SENAITE or IS calls in the engine.** Publish success is attested by the touchpoint argument.
- **Env gate:** `MK1_WORKFLOW_SHADOW_ENABLED` — enabled unless explicitly `"0"`/`"false"`/`"no"` (kill switch semantics; Handler decision: ON in prod).
- **NULL `native_status` = not seeded → engine skips silently.** Never treat NULL as a state.
- **Run ALL pytest via the main checkout's venv** (worktrees have no venv): `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`. Run from `C:/tmp/Accu-Mk1-sidebyside/backend`.
- Frontend is **npm only**. If `node_modules` is missing in the worktree, `npm install` first.
- Tests create their own `TEST-`prefixed fixtures and clean them up (house convention, see `backend/tests/test_lims_analyses_service.py`). Never depend on catalog seed rows existing — create private TEST states/edges.
- Baseline failures: the backend suite has ~64 pre-existing failures. The gate is the **failure-name-set diff vs master in the same venv**, not zero failures.

## File Structure

| File | Role |
|---|---|
| `backend/models.py` | +`native_status` on `LimsSample`; +`LimsWorkflowShadowEvaluation`; +`auto_fire` on `LimsWorkflowTransition` |
| `backend/database.py` | idempotent DDL: column, table, indexes, `auto_fire`, 2 guarded catalog-data UPDATEs |
| `backend/workflow/engine.py` | NEW — requirement evaluators, `execute_verb`, `evaluate_cascades`, shadow recorder, `run_cascades_bg` |
| `backend/workflow/catalog.py` | extend `REQUIREMENT_KINDS` + no-value handling |
| `backend/workflow/routes.py` | +`GET /api/workflow/shadow/summary` |
| `backend/main.py` | touchpoint in `_record_sample_transition_bg` (~14143); `_build_shadow_block` beside `_build_sample_transitions` (~17881) |
| `backend/lims_analyses/routes.py` | cascade `BackgroundTasks` on `transition` (~213) and `promote` (~274) |
| `backend/scripts/seed_native_status.py` | NEW — seed/heal/reset script |
| `backend/tests/test_workflow_engine.py` | NEW — evaluators + engine + recorder |
| `backend/tests/test_workflow_shadow_touchpoints.py` | NEW — chokepoint + cascade hooks + seed script |
| `backend/tests/test_workflow_shadow_summary.py` | NEW — summary endpoint + inspect block |
| `src/lib/api.ts` | debug-payload type extension |
| `src/components/senaite/SampleRegistryDebug.tsx` | side-by-side block |

---

### Task 1: Schema — column, shadow table, auto_fire, catalog data

**Files:**
- Modify: `backend/models.py` (LimsSample ~line 795 area; LimsWorkflowTransition ~1539; new class after `LimsWorkflowSyncState` ~1583)
- Modify: `backend/database.py` (append to the idempotent-statements list; the `lims_sample_transitions` block is ~1216 — add a new block after it)
- Test: `backend/tests/test_workflow_engine.py` (created here, grows in Tasks 2–3)

**Interfaces:**
- Produces: `LimsSample.native_status: Optional[str]`; `LimsWorkflowTransition.auto_fire: bool`; model `LimsWorkflowShadowEvaluation` with fields `id, lims_sample_pk, evaluated_at, trigger, verb, from_status, to_status, outcome, requirements_met, outcomes, actor_user_id`. Every later task consumes these names verbatim.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_workflow_engine.py
"""Side-by-side engine tests (2026-07-26 spec). House conventions:
live subvial DB via SessionLocal, TEST-prefixed fixtures, self-cleanup."""
from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import (LimsSample, LimsWorkflowShadowEvaluation,
                    LimsWorkflowState, LimsWorkflowTransition)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def test_sample(db):
    """A TEST lims_samples row with native_status set; removed after."""
    row = LimsSample(sample_id="TEST-SBS-0001", status="sample_received",
                     native_status="test_sbs_received")
    db.add(row)
    db.flush()
    yield row
    db.execute(delete(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == row.id))
    db.execute(delete(LimsSample).where(LimsSample.id == row.id))
    db.commit()


def test_shadow_evaluation_roundtrip(db, test_sample):
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=test_sample.id, trigger="seed", verb=None,
        from_status=None, to_status="test_sbs_received",
        outcome="seeded", requirements_met=None, outcomes=[],
    ))
    db.flush()
    got = db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == test_sample.id
    )).scalars().one()
    assert got.outcome == "seeded"
    assert got.outcomes == []
    assert got.evaluated_at is not None
    db.rollback()


def test_auto_fire_defaults_false(db):
    # Any existing transition row must expose auto_fire (bool, default False
    # on newly created rows).
    t = LimsWorkflowTransition.__table__.c
    assert "auto_fire" in t
```

- [ ] **Step 2: Run to verify failure**

Run (from `C:/tmp/Accu-Mk1-sidebyside/backend`):
`<main-venv-python> -m pytest tests/test_workflow_engine.py -q -p no:warnings --tb=short`
Expected: FAIL — `ImportError: cannot import name 'LimsWorkflowShadowEvaluation'`.

- [ ] **Step 3: Add the models**

In `backend/models.py`, inside `class LimsSample` next to the registry block (after `native_id`, ~line 804):

```python
    # Side-by-side engine (2026-07-26 spec §3.1): Mk1's OWN sample-tier
    # workflow position, advanced only by workflow/engine.py and the seed
    # script. NULL = not seeded (engine skips). NO existing reader consults
    # this — `status` remains the SENAITE mirror that every page renders.
    # Authority note: lims_workflow_shadow_evaluations is the authoritative
    # history; this column is its O(1) materialization.
    native_status: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
```

Inside `class LimsWorkflowTransition` (after `sort_order`, ~1542):

```python
    # Side-by-side engine: edges the cascade evaluator may fire WITHOUT an
    # explicit verb call (SENAITE-style auto-transitions, e.g. all-submitted
    # → to_be_verified). Catalog data, not engine hardcode (spec §4).
    auto_fire: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
```

After `class LimsWorkflowSyncState` (~1583):

```python
class LimsWorkflowShadowEvaluation(Base):
    """Side-by-side engine trajectory (2026-07-26 spec §3.2): every engine
    attempt — advance, refusal, or seed — one row. Authoritative history for
    lims_samples.native_status (the column is the materialization; written in
    the same transaction). outcome/trigger vocabularies are enforced in code,
    NOT CHECKs (last-boot-wins class):
      outcome: 'advanced' | 'requirements_unmet' | 'no_edge' | 'seeded'
      trigger: 'receive' | 'publish' | 'analysis_cascade' | 'seed'
    """
    __tablename__ = "lims_workflow_shadow_evaluations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    lims_sample_pk: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_samples.id", ondelete="CASCADE"), nullable=False)
    evaluated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False)
    trigger: Mapped[str] = mapped_column(Text, nullable=False)
    verb: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    from_status: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    to_status: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    outcome: Mapped[str] = mapped_column(Text, nullable=False)
    requirements_met: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    outcomes: Mapped[list] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=False, default=list)
    actor_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True)
```

(`BigInteger` is already imported in models.py; verify — if not, add it to the existing sqlalchemy import line.)

- [ ] **Step 4: Add the idempotent DDL**

In `backend/database.py`, append a new block to the statements list, AFTER the `lims_sample_transitions` block (~1298), following the exact house string-list style:

```python
        # ── Side-by-side workflow engine (2026-07-26 spec) — ALL additive.
        # Vocabularies live in code, not CHECKs (last-boot-wins class).
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS native_status VARCHAR(50)",
        "ALTER TABLE lims_workflow_transitions ADD COLUMN IF NOT EXISTS "
        "auto_fire BOOLEAN NOT NULL DEFAULT FALSE",
        """
        CREATE TABLE IF NOT EXISTS lims_workflow_shadow_evaluations (
            id                BIGSERIAL PRIMARY KEY,
            lims_sample_pk    INTEGER NOT NULL REFERENCES lims_samples(id) ON DELETE CASCADE,
            evaluated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
            trigger           TEXT NOT NULL,
            verb              TEXT,
            from_status       TEXT,
            to_status         TEXT,
            outcome           TEXT NOT NULL,
            requirements_met  BOOLEAN,
            outcomes          JSONB NOT NULL DEFAULT '[]'::jsonb,
            actor_user_id     INTEGER REFERENCES users(id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_shadow_evals_sample "
        "ON lims_workflow_shadow_evaluations (lims_sample_pk, evaluated_at)",
        "CREATE INDEX IF NOT EXISTS ix_shadow_evals_nonadvanced "
        "ON lims_workflow_shadow_evaluations (outcome) WHERE outcome != 'advanced'",
        # Catalog data (spec §8 decision 3): cascade-eligible builtin edges +
        # the publish edge's attested requirement. Guarded → idempotent.
        "UPDATE lims_workflow_transitions SET auto_fire = TRUE "
        "WHERE entity_scope = 'sample' AND verb IN ('submit','verify') "
        "AND is_builtin AND NOT auto_fire",
        "UPDATE lims_workflow_transitions SET requirements = requirements || "
        "'[{\"kind\":\"coa_published\",\"value\":null,"
        "\"note\":\"attested by the publish touchpoint\"}]'::jsonb "
        "WHERE entity_scope = 'sample' AND verb = 'publish' AND is_builtin "
        "AND requirements::text NOT LIKE '%coa_published%'",
```

- [ ] **Step 5: Run the tests**

`<main-venv-python> -m pytest tests/test_workflow_engine.py -q -p no:warnings --tb=short`
Expected: 2 passed. (The dev DB gets the DDL on next backend boot; for the test DB, `create_all`/existing boot has run — if `test_shadow_evaluation_roundtrip` fails with UndefinedTable, restart the local backend once or run the DDL block manually, then re-run.)

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_workflow_engine.py
git commit -m "feat(sbs): native_status column, shadow-evaluations table, auto_fire catalog flag"
```

---

### Task 2: Requirement evaluation

**Files:**
- Create: `backend/workflow/engine.py` (evaluators half)
- Modify: `backend/workflow/catalog.py:10-16` (`REQUIREMENT_KINDS`, no-value kinds)
- Test: `backend/tests/test_workflow_engine.py` (extend)

**Interfaces:**
- Consumes: catalog requirement entry shape `{"kind": str, "value": str|None, "note": str|None}` (the LIVE registry shape — NOT the 07-13 draft's `{kind, args}`; seeds already use it).
- Produces: `evaluate_requirements(db, sample, entries, *, actor_user_id=None, attested=None) -> tuple[bool, list[dict]]` — `(gate_met, outcomes)`; each outcome `{"kind","value","met","gates","detail"}`. `distinct_actor` is evaluated but `gates=False` (dormant). Also `shadow_enabled() -> bool`.

**Kind semantics (v1 — the as-built vocabulary):**

| kind | gates | semantics |
|---|---|---|
| `all_analyses_in_state` | yes | every LIVE parent-tier line's state ∈ comma-list `value`. Live lines = canonical rows (`provenance='canonical'`, `lims_sub_sample_pk IS NULL`, `retested == False`, `review_state ∉ {'retracted','rejected','cancelled'}`) using `review_state`, plus shadow rows (`provenance='shadow'`) using `mirror_review_state` (same exclusions on `mirror_review_state`), **canonical wins per keyword** (read-flip collapse rule). **Empty set ⇒ met=False** (`detail="no live parent analyses"` — fail-closed; an all-quantifier must not fire vacuously at receive time). |
| `field_present` | yes | `getattr(sample, value, None)` is neither None nor `""` |
| `coa_published` | yes | `bool((attested or {}).get("coa_published"))` — attested by the publish touchpoint, never queried |
| `distinct_actor` | **no** | met iff `actor_user_id` differs from the newest `lims_sample_transitions` row for this sample with `verb == value`; unknown/absent actor ⇒ met=False, `detail="actor unknown"`. Recorded, never gates (dormant until enforcement). |
| `role_at_least`, `manual`, anything else | yes | met=False, `detail="not evaluable in shadow v1"` / `"unknown kind"` — fail-closed, visible |

- [ ] **Step 1: Extend the catalog registry**

In `backend/workflow/catalog.py` replace lines 10–11 and the needs-value check:

```python
REQUIREMENT_KINDS = frozenset({"all_analyses_in_state", "field_present",
                               "role_at_least", "manual",
                               "coa_published", "distinct_actor"})
# Kinds whose entries carry no value (attested / self-contained).
NO_VALUE_KINDS = frozenset({"manual", "coa_published"})
```

and in `validate_requirements` change the needs-value condition to:

```python
        if e["kind"] not in NO_VALUE_KINDS and not e.get("value"):
```

- [ ] **Step 2: Write failing tests**

Append to `backend/tests/test_workflow_engine.py`:

```python
from models import AnalysisService, LimsAnalysis


@pytest.fixture
def any_service(db):
    svc = db.execute(select(AnalysisService).where(
        AnalysisService.keyword.isnot(None))).scalars().first()
    if svc is None:
        pytest.skip("no seeded analysis_services")
    return svc


def _add_parent_line(db, sample, svc, state, provenance="canonical",
                     mirror_state=None, keyword=None):
    row = LimsAnalysis(
        lims_sample_pk=sample.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword=keyword or svc.keyword,
        title="TEST: sbs line", provenance=provenance,
        review_state=state if provenance == "canonical" else "senaite_mirror",
        mirror_review_state=mirror_state,
    )
    db.add(row)
    db.flush()
    return row


@pytest.fixture
def sbs_cleanup(db, test_sample):
    yield
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == test_sample.id))
    db.commit()


def test_all_analyses_in_state_empty_set_is_unmet(db, test_sample, sbs_cleanup):
    from workflow.engine import evaluate_requirements
    met, outcomes = evaluate_requirements(
        db, test_sample,
        [{"kind": "all_analyses_in_state", "value": "verified", "note": None}])
    assert met is False
    assert outcomes[0]["detail"] == "no live parent analyses"


def test_all_analyses_in_state_comma_list_and_canonical_wins(
        db, test_sample, any_service, sbs_cleanup):
    from workflow.engine import evaluate_requirements
    # canonical verified + shadow (same keyword) published → canonical wins;
    # second keyword only-shadow to_be_verified.
    _add_parent_line(db, test_sample, any_service, "verified")
    _add_parent_line(db, test_sample, any_service, None, provenance="shadow",
                     mirror_state="published")
    _add_parent_line(db, test_sample, any_service, None, provenance="shadow",
                     mirror_state="to_be_verified", keyword="TEST-KW2")
    met, _ = evaluate_requirements(
        db, test_sample,
        [{"kind": "all_analyses_in_state",
          "value": "verified,to_be_verified", "note": None}])
    assert met is True
    met2, _ = evaluate_requirements(
        db, test_sample,
        [{"kind": "all_analyses_in_state", "value": "verified", "note": None}])
    assert met2 is False   # TEST-KW2 is to_be_verified


def test_coa_published_attested_and_unknown_kind_fail_closed(db, test_sample):
    from workflow.engine import evaluate_requirements
    met, _ = evaluate_requirements(
        db, test_sample, [{"kind": "coa_published", "value": None, "note": None}],
        attested={"coa_published": True})
    assert met is True
    met2, out2 = evaluate_requirements(
        db, test_sample, [{"kind": "coa_published", "value": None, "note": None}])
    assert met2 is False
    met3, out3 = evaluate_requirements(
        db, test_sample, [{"kind": "bogus_kind", "value": "x", "note": None}])
    assert met3 is False and out3[0]["detail"] == "unknown kind"


def test_distinct_actor_evaluated_but_never_gates(db, test_sample):
    from workflow.engine import evaluate_requirements
    met, outcomes = evaluate_requirements(
        db, test_sample,
        [{"kind": "distinct_actor", "value": "submit", "note": None}],
        actor_user_id=None)
    assert met is True                      # non-gating: gate ignores it
    assert outcomes[0]["met"] is False      # ...but the outcome is recorded
    assert outcomes[0]["gates"] is False
```

- [ ] **Step 3: Run to verify failure**

`<main-venv-python> -m pytest tests/test_workflow_engine.py -q -p no:warnings -k "all_analyses or coa_published or distinct_actor" --tb=short`
Expected: FAIL — `ModuleNotFoundError: No module named 'workflow.engine'`.

- [ ] **Step 4: Implement `workflow/engine.py` (evaluators half)**

```python
"""Side-by-side workflow engine (2026-07-26 spec).

Pure and DB-local: reads lims_samples / lims_analyses / lims_sample_transitions
and the workflow catalog. NO SENAITE reads, NO IS calls — publish success is
attested by the touchpoint. Flush-only helpers; touchpoint wrappers own their
sessions and commits. Never imported by any read path.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (LimsAnalysis, LimsSample, LimsSampleTransition,
                    LimsWorkflowShadowEvaluation, LimsWorkflowState,
                    LimsWorkflowTransition)

log = logging.getLogger(__name__)

_EXCLUDED_LINE_STATES = frozenset({"retracted", "rejected", "cancelled"})
CASCADE_CAP = 10


def shadow_enabled() -> bool:
    """Kill-switch semantics (spec §8): enabled unless explicitly off."""
    return os.environ.get("MK1_WORKFLOW_SHADOW_ENABLED", "1").strip().lower() \
        not in ("0", "false", "no")


def _live_parent_line_states(db: Session, sample: LimsSample) -> dict[str, str]:
    """{keyword: effective_state} for the sample's LIVE parent-tier lines.
    Canonical rows win per keyword over shadow mirrors (read-flip collapse
    rule); shadow rows contribute mirror_review_state. Exception states and
    retest-superseded canonical rows are excluded."""
    rows = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == sample.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
    )).scalars().all()
    out: dict[str, str] = {}
    shadow: dict[str, str] = {}
    for r in rows:
        if r.provenance == "canonical":
            if r.retested or r.review_state in _EXCLUDED_LINE_STATES:
                continue
            out[r.keyword] = r.review_state
        elif r.provenance == "shadow":
            st = r.mirror_review_state
            if not st or st in _EXCLUDED_LINE_STATES:
                continue
            shadow[r.keyword] = st
    for kw, st in shadow.items():
        out.setdefault(kw, st)
    return out


def _eval_one(db: Session, sample: LimsSample, entry: dict, *,
              actor_user_id: Optional[int],
              attested: Optional[dict]) -> dict:
    kind = entry.get("kind")
    value = entry.get("value")
    met, gates, detail = False, True, None

    if kind == "all_analyses_in_state":
        allowed = {v.strip() for v in (value or "").split(",") if v.strip()}
        states = _live_parent_line_states(db, sample)
        if not states:
            detail = "no live parent analyses"          # empty ∀ = fail-closed
        else:
            off = {kw: st for kw, st in states.items() if st not in allowed}
            met = not off
            if off:
                detail = f"outside {sorted(allowed)}: {off}"
    elif kind == "field_present":
        met = getattr(sample, value or "", None) not in (None, "")
    elif kind == "coa_published":
        met = bool((attested or {}).get("coa_published"))
        detail = None if met else "publish not attested"
    elif kind == "distinct_actor":
        gates = False                                    # dormant (spec §8.2)
        if actor_user_id is None:
            detail = "actor unknown"
        else:
            last = db.execute(
                select(LimsSampleTransition.actor_user_id).where(
                    LimsSampleTransition.lims_sample_pk == sample.id,
                    LimsSampleTransition.verb == value,
                ).order_by(LimsSampleTransition.occurred_at.desc(),
                           LimsSampleTransition.id.desc()).limit(1)
            ).scalar_one_or_none()
            met = last is not None and last != actor_user_id
    elif kind in ("role_at_least", "manual"):
        detail = "not evaluable in shadow v1"
    else:
        detail = "unknown kind"

    return {"kind": kind, "value": value, "met": met, "gates": gates,
            "detail": detail}


def evaluate_requirements(db: Session, sample: LimsSample, entries: list,
                          *, actor_user_id: Optional[int] = None,
                          attested: Optional[dict] = None,
                          ) -> tuple[bool, list[dict]]:
    """(gate_met, outcomes). gate_met = ALL gating outcomes met (non-gating
    kinds — distinct_actor — are recorded but ignored by the gate)."""
    outcomes = [_eval_one(db, sample, e, actor_user_id=actor_user_id,
                          attested=attested)
                for e in (entries or [])]
    gate_met = all(o["met"] for o in outcomes if o["gates"])
    return gate_met, outcomes
```

- [ ] **Step 5: Run tests**

Same command as Step 3. Expected: 4 passed. Then the full file:
`<main-venv-python> -m pytest tests/test_workflow_engine.py -q -p no:warnings --tb=short` — all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/workflow/engine.py backend/workflow/catalog.py backend/tests/test_workflow_engine.py
git commit -m "feat(sbs): requirement evaluators (as-built catalog vocabulary, fail-closed)"
```

---

### Task 3: execute_verb, cascades, recorder

**Files:**
- Modify: `backend/workflow/engine.py` (append)
- Test: `backend/tests/test_workflow_engine.py` (extend)

**Interfaces:**
- Consumes: Task 2's `evaluate_requirements`, `shadow_enabled`; Task 1's models.
- Produces (later tasks call these exact signatures):
  - `execute_verb(db, sample, verb, *, trigger, actor_user_id=None, attested=None) -> Optional[LimsWorkflowShadowEvaluation]` — flush-only; advances `sample.native_status` on success; returns the recorded row (None when sample unseeded / dedup-skipped).
  - `evaluate_cascades(db, sample, *, trigger, actor_user_id=None) -> list[LimsWorkflowShadowEvaluation]` — fires `auto_fire` edges repeatedly (cap 10).
  - `run_cascades_bg(sample_pk: int, actor_user_id: Optional[int]) -> None` — own-session, never-raise wrapper (used by Task 5's BackgroundTasks).

- [ ] **Step 1: Write failing tests** (append; private TEST catalog so seeds are never a dependency)

```python
@pytest.fixture
def sbs_catalog(db):
    """Private TEST slice of the sample-scope catalog:
    test_sbs_received --submit(auto)--> test_sbs_tbv --verify(auto, needs
    all verified)--> test_sbs_verified --publish(explicit, needs attested
    coa_published)--> test_sbs_published."""
    states = {}
    for slug in ("test_sbs_received", "test_sbs_tbv",
                 "test_sbs_verified", "test_sbs_published"):
        s = LimsWorkflowState(entity_scope="sample", slug=slug,
                              label=f"TEST {slug}", category="active",
                              sort_order=9000, is_builtin=False)
        db.add(s)
        db.flush()
        states[slug] = s
    def edge(f, t, verb, reqs, auto):
        e = LimsWorkflowTransition(
            entity_scope="sample", from_state_id=states[f].id,
            to_state_id=states[t].id, verb=verb, requirements=reqs,
            auto_fire=auto, is_builtin=False, sort_order=9000)
        db.add(e)
        db.flush()
        return e
    edge("test_sbs_received", "test_sbs_tbv", "test_submit",
         [{"kind": "all_analyses_in_state",
           "value": "to_be_verified,verified", "note": None}], True)
    edge("test_sbs_tbv", "test_sbs_verified", "test_verify",
         [{"kind": "all_analyses_in_state", "value": "verified",
           "note": None}], True)
    edge("test_sbs_verified", "test_sbs_published", "test_publish",
         [{"kind": "coa_published", "value": None, "note": None}], False)
    yield states
    db.execute(delete(LimsWorkflowTransition).where(
        LimsWorkflowTransition.verb.in_(
            ["test_submit", "test_verify", "test_publish"])))
    db.execute(delete(LimsWorkflowState).where(
        LimsWorkflowState.slug.like("test_sbs_%")))
    db.commit()


def test_execute_verb_advances_and_records(db, test_sample, any_service,
                                           sbs_catalog, sbs_cleanup):
    from workflow.engine import execute_verb
    _add_parent_line(db, test_sample, any_service, "verified")
    test_sample.native_status = "test_sbs_verified"
    row = execute_verb(db, test_sample, "test_publish", trigger="publish",
                       attested={"coa_published": True})
    assert row.outcome == "advanced"
    assert test_sample.native_status == "test_sbs_published"
    assert row.from_status == "test_sbs_verified"
    db.rollback()


def test_execute_verb_refuses_and_dedups(db, test_sample, any_service,
                                         sbs_catalog, sbs_cleanup):
    from workflow.engine import execute_verb
    test_sample.native_status = "test_sbs_verified"
    r1 = execute_verb(db, test_sample, "test_publish", trigger="publish")
    assert r1.outcome == "requirements_unmet"
    assert test_sample.native_status == "test_sbs_verified"   # unchanged
    r2 = execute_verb(db, test_sample, "test_publish", trigger="publish")
    assert r2 is None                                          # delta-dedup
    r3 = execute_verb(db, test_sample, "bogus_verb", trigger="publish")
    assert r3.outcome == "no_edge"
    db.rollback()


def test_execute_verb_skips_unseeded(db, sbs_catalog):
    from workflow.engine import execute_verb
    s = LimsSample(sample_id="TEST-SBS-NULL", status="sample_received",
                   native_status=None)
    db.add(s)
    db.flush()
    assert execute_verb(db, s, "test_publish", trigger="publish") is None
    db.rollback()


def test_cascades_chain_and_terminate(db, test_sample, any_service,
                                      sbs_catalog, sbs_cleanup):
    from workflow.engine import evaluate_cascades
    _add_parent_line(db, test_sample, any_service, "verified")
    test_sample.native_status = "test_sbs_received"
    rows = evaluate_cascades(db, test_sample, trigger="analysis_cascade")
    # submit fires (verified ∈ list), then verify fires (all verified);
    # publish is NOT auto_fire so the chain stops at verified.
    assert [r.outcome for r in rows] == ["advanced", "advanced"]
    assert test_sample.native_status == "test_sbs_verified"
    db.rollback()
```

- [ ] **Step 2: Run to verify failure** — same pytest file, `-k "execute_verb or cascades"`. Expected: FAIL (`ImportError: cannot import name 'execute_verb'`).

- [ ] **Step 3: Implement** (append to `workflow/engine.py`)

```python
def _outcomes_hash(outcomes: list[dict]) -> str:
    return hashlib.md5(json.dumps(outcomes, sort_keys=True,
                                  default=str).encode()).hexdigest()


def _record(db: Session, sample: LimsSample, *, trigger: str,
            verb: Optional[str], from_status: Optional[str],
            to_status: Optional[str], outcome: str,
            requirements_met: Optional[bool], outcomes: list,
            actor_user_id: Optional[int],
            ) -> Optional[LimsWorkflowShadowEvaluation]:
    """Insert one trajectory row (flush-only). Delta-dedup applies to
    REFUSALS only (spec §3.2): identical latest (verb, from_status, outcome,
    outcomes-hash) → skip. Advances and seeds always insert."""
    if outcome in ("requirements_unmet", "no_edge"):
        latest = db.execute(
            select(LimsWorkflowShadowEvaluation).where(
                LimsWorkflowShadowEvaluation.lims_sample_pk == sample.id,
            ).order_by(LimsWorkflowShadowEvaluation.evaluated_at.desc(),
                       LimsWorkflowShadowEvaluation.id.desc()).limit(1)
        ).scalars().first()
        if (latest is not None and latest.verb == verb
                and latest.from_status == from_status
                and latest.outcome == outcome
                and _outcomes_hash(latest.outcomes or []) == _outcomes_hash(outcomes)):
            return None
    row = LimsWorkflowShadowEvaluation(
        lims_sample_pk=sample.id, trigger=trigger, verb=verb,
        from_status=from_status, to_status=to_status, outcome=outcome,
        requirements_met=requirements_met, outcomes=outcomes,
        actor_user_id=actor_user_id)
    db.add(row)
    db.flush()
    return row


def _find_edge(db: Session, from_slug: str, verb: str,
               ) -> Optional[tuple[LimsWorkflowTransition, str]]:
    """(edge, to_slug) for the active sample-scope edge `verb` out of
    `from_slug`, or None. Two aliased joins — native_status stores SLUGS,
    the catalog stores state ids."""
    from sqlalchemy.orm import aliased
    FromS, ToS = aliased(LimsWorkflowState), aliased(LimsWorkflowState)
    row = db.execute(
        select(LimsWorkflowTransition, ToS.slug)
        .join(FromS, LimsWorkflowTransition.from_state_id == FromS.id)
        .join(ToS, LimsWorkflowTransition.to_state_id == ToS.id)
        .where(LimsWorkflowTransition.entity_scope == "sample",
               LimsWorkflowTransition.is_active,
               LimsWorkflowTransition.verb == verb,
               FromS.slug == from_slug)
        .order_by(LimsWorkflowTransition.sort_order, LimsWorkflowTransition.id)
        .limit(1)
    ).first()
    return (row[0], row[1]) if row else None


def execute_verb(db: Session, sample: LimsSample, verb: str, *, trigger: str,
                 actor_user_id: Optional[int] = None,
                 attested: Optional[dict] = None,
                 ) -> Optional[LimsWorkflowShadowEvaluation]:
    """One native transition attempt. Flush-only; caller commits.
    NULL native_status → None (unseeded; spec §3.1)."""
    if sample.native_status is None:
        return None
    found = _find_edge(db, sample.native_status, verb)
    if found is None:
        return _record(db, sample, trigger=trigger, verb=verb,
                       from_status=sample.native_status,
                       to_status=sample.native_status, outcome="no_edge",
                       requirements_met=None, outcomes=[],
                       actor_user_id=actor_user_id)
    edge, to_slug = found
    met, outcomes = evaluate_requirements(
        db, sample, edge.requirements or [],
        actor_user_id=actor_user_id, attested=attested)
    if not met:
        return _record(db, sample, trigger=trigger, verb=verb,
                       from_status=sample.native_status,
                       to_status=sample.native_status,
                       outcome="requirements_unmet", requirements_met=False,
                       outcomes=outcomes, actor_user_id=actor_user_id)
    frm = sample.native_status
    sample.native_status = to_slug
    db.flush()
    return _record(db, sample, trigger=trigger, verb=verb, from_status=frm,
                   to_status=to_slug, outcome="advanced",
                   requirements_met=True, outcomes=outcomes,
                   actor_user_id=actor_user_id)


def evaluate_cascades(db: Session, sample: LimsSample, *, trigger: str,
                      actor_user_id: Optional[int] = None,
                      ) -> list[LimsWorkflowShadowEvaluation]:
    """Fire auto_fire edges out of native_status until none applies
    (cap CASCADE_CAP). Only edges whose requirements are ALL met fire —
    refusals are NOT recorded here (cascade probing is speculative; recording
    every probe would spam the trajectory). Flush-only."""
    if sample.native_status is None:
        return []
    from sqlalchemy.orm import aliased
    fired: list[LimsWorkflowShadowEvaluation] = []
    for _ in range(CASCADE_CAP):
        FromS = aliased(LimsWorkflowState)
        candidates = db.execute(
            select(LimsWorkflowTransition)
            .join(FromS, LimsWorkflowTransition.from_state_id == FromS.id)
            .where(LimsWorkflowTransition.entity_scope == "sample",
                   LimsWorkflowTransition.is_active,
                   LimsWorkflowTransition.auto_fire,
                   FromS.slug == sample.native_status)
            .order_by(LimsWorkflowTransition.sort_order,
                      LimsWorkflowTransition.id)
        ).scalars().all()
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
    return fired


def run_cascades_bg(sample_pk: int, actor_user_id: Optional[int]) -> None:
    """Own-session, never-raise cascade run — the Task 5 BackgroundTasks
    target. Same hardening pattern as main._record_sample_transition_bg."""
    if not shadow_enabled():
        return
    db = None
    try:
        from database import SessionLocal
        db = SessionLocal()
        sample = db.get(LimsSample, sample_pk)
        if sample is not None:
            evaluate_cascades(db, sample, trigger="analysis_cascade",
                              actor_user_id=actor_user_id)
            db.commit()
    except Exception:
        log.exception("sbs.run_cascades_bg failed (never-raise)")
        if db is not None:
            db.rollback()
    finally:
        if db is not None:
            db.close()
```

- [ ] **Step 4: Run tests** — whole file. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/workflow/engine.py backend/tests/test_workflow_engine.py
git commit -m "feat(sbs): execute_verb + auto_fire cascades + trajectory recorder"
```

---

### Task 4: Touchpoint — receive/publish chokepoint

**Files:**
- Modify: `backend/main.py:14143` region — inside `_record_sample_transition_bg`, after the `wrote_received` block, before the commit
- Test: `backend/tests/test_workflow_shadow_touchpoints.py` (create)

**Interfaces:**
- Consumes: `execute_verb`, `evaluate_cascades`, `shadow_enabled` (Task 3 signatures); the bg hook's existing `kwargs` (`sample_id`, `verb`, `to_status`, `actor_user_id`, `source`).
- Produces: receive/publish verbs drive the native trajectory in prod. No signature changes anywhere — both existing call sites (`main.py:10396` publish, `main.py:13813` receive) are untouched.

Why here: this bg function is the SINGLE chokepoint both hooks already call, on its own short-lived session, already never-raise — the engine call inherits all of that for free.

- [ ] **Step 1: Write failing test**

```python
# backend/tests/test_workflow_shadow_touchpoints.py
"""Touchpoint wiring tests: the mk1-hook chokepoint and the analysis-route
cascades drive the engine, env-gated, never breaking the host path."""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import (LimsSample, LimsSampleTransition,
                    LimsWorkflowShadowEvaluation, LimsWorkflowState,
                    LimsWorkflowTransition)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def receive_catalog(db):
    """TEST states + a plain receive-verb edge (no requirements)."""
    a = LimsWorkflowState(entity_scope="sample", slug="test_tp_due",
                          label="TEST due", category="active",
                          sort_order=9100, is_builtin=False)
    b = LimsWorkflowState(entity_scope="sample", slug="test_tp_received",
                          label="TEST received", category="active",
                          sort_order=9101, is_builtin=False)
    db.add_all([a, b]); db.flush()
    e = LimsWorkflowTransition(entity_scope="sample", from_state_id=a.id,
                               to_state_id=b.id, verb="receive",
                               requirements=[], auto_fire=False,
                               is_builtin=False, sort_order=9100)
    db.add(e); db.flush(); db.commit()
    yield
    db.execute(delete(LimsWorkflowTransition).where(
        LimsWorkflowTransition.id == e.id))
    db.execute(delete(LimsWorkflowState).where(
        LimsWorkflowState.id.in_([a.id, b.id])))
    db.commit()


@pytest.fixture
def tp_sample(db):
    row = LimsSample(sample_id="TEST-TP-0001", status="sample_due",
                     native_status="test_tp_due")
    db.add(row); db.flush(); db.commit()
    yield row
    db.execute(delete(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == row.id))
    db.execute(delete(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id))
    db.execute(delete(LimsSample).where(LimsSample.id == row.id))
    db.commit()


def _run_hook(sample_id):
    from main import _record_sample_transition_bg
    _record_sample_transition_bg(
        sample_id=sample_id, verb="receive", to_status="sample_received",
        from_status="sample_due", source="mk1", actor_user_id=None)


def test_receive_hook_advances_native(db, receive_catalog, tp_sample):
    _run_hook(tp_sample.sample_id)
    db.expire_all()
    fresh = db.get(LimsSample, tp_sample.id)
    assert fresh.native_status == "test_tp_received"
    evals = db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == tp_sample.id
    )).scalars().all()
    assert any(e.outcome == "advanced" and e.trigger == "receive"
               for e in evals)


def test_flag_off_is_a_noop(db, receive_catalog, tp_sample):
    with patch.dict(os.environ, {"MK1_WORKFLOW_SHADOW_ENABLED": "0"}):
        _run_hook(tp_sample.sample_id)
    db.expire_all()
    assert db.get(LimsSample, tp_sample.id).native_status == "test_tp_due"


def test_engine_failure_never_breaks_the_hook(db, receive_catalog, tp_sample):
    with patch("workflow.engine.execute_verb",
               side_effect=RuntimeError("boom")):
        _run_hook(tp_sample.sample_id)   # must not raise
    db.expire_all()
    # host effects still landed: the log row + status heal
    assert db.get(LimsSample, tp_sample.id).status == "sample_received"
```

- [ ] **Step 2: Run to verify failure** — `-k "receive_hook or flag_off or never_breaks"`. Expected: `test_receive_hook_advances_native` FAILS (native_status unchanged); the other two may pass vacuously — confirm the first fails for the right reason.

- [ ] **Step 3: Implement the hook**

In `_record_sample_transition_bg` (main.py, after the `wrote_received` block, still inside the outer `try`, before its commit):

```python
        # Side-by-side engine touchpoint (2026-07-26 spec §5): the SAME verb
        # this hook just logged drives Mk1's own trajectory. Separately
        # guarded — an engine error must not cost us the log write above.
        try:
            from workflow.engine import (evaluate_cascades, execute_verb,
                                         shadow_enabled)
            if shadow_enabled():
                _s = db.execute(select(LimsSample).where(
                    LimsSample.sample_id == kwargs["sample_id"]
                )).scalar_one_or_none()
                _verb = kwargs.get("verb")
                if _s is not None and _verb in ("receive", "publish"):
                    execute_verb(
                        db, _s, _verb, trigger=_verb,
                        actor_user_id=kwargs.get("actor_user_id"),
                        attested={"coa_published": True}
                        if _verb == "publish" else None,
                    )
                    evaluate_cascades(db, _s, trigger=_verb,
                                      actor_user_id=kwargs.get("actor_user_id"))
        except Exception:
            logger.exception("sbs touchpoint failed (never-raise)")
```

Attestation note: this bg hook is scheduled at the publish endpoint ONLY after the IS publish succeeded and `actual_state == "published"` (main.py:10388-10402), so `verb == "publish"` here IS the attestation the spec requires.

- [ ] **Step 4: Run tests** — whole new file. Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_workflow_shadow_touchpoints.py
git commit -m "feat(sbs): receive/publish touchpoint via the mk1-hook chokepoint"
```

---

### Task 5: Touchpoint — analysis-change cascades

**Files:**
- Modify: `backend/lims_analyses/routes.py` — `transition` (~213) and `promote` (~274)
- Test: `backend/tests/test_workflow_shadow_touchpoints.py` (extend)

**Interfaces:**
- Consumes: `run_cascades_bg(sample_pk, actor_user_id)` (Task 3).
- Produces: parent-analysis state changes trigger sample-tier cascade evaluation post-response.

- [ ] **Step 1: Write failing test** (append)

```python
def test_transition_route_schedules_cascade():
    """The native analysis transition endpoint registers run_cascades_bg as
    a background task with the resolved PARENT sample pk."""
    import inspect
    from lims_analyses import routes
    src = inspect.getsource(routes.transition)
    assert "run_cascades_bg" in src and "background_tasks" in src
    src2 = inspect.getsource(routes.promote)
    assert "run_cascades_bg" in src2 and "background_tasks" in src2
```

(Source-level assertion is the house-lightest wiring check; behavior of `run_cascades_bg` itself is covered in Task 3. TestClient-driving these routes requires live analyses fixtures whose promote path is already exercised by `test_lims_analyses_routes.py` — currently in the pre-existing-failure set, so a source assertion avoids coupling to that.)

- [ ] **Step 2: Run to verify failure** — FAIL (`run_cascades_bg` not in source).

- [ ] **Step 3: Implement**

In `backend/lims_analyses/routes.py`:

1. Add `BackgroundTasks` to the fastapi import line.
2. Add a module-level resolver + scheduling helper near `_handle_service_error`:

```python
def _schedule_sbs_cascade(background_tasks, db, row, current_user) -> None:
    """Side-by-side engine (2026-07-26 spec §5): after a parent-analysis
    state change, evaluate sample-tier auto_fire edges post-response.
    Never-raise by construction: resolution failures are swallowed and the
    bg target itself is own-session never-raise."""
    try:
        from models import LimsSubSample
        from workflow.engine import run_cascades_bg, shadow_enabled
        if not shadow_enabled():
            return
        if row.lims_sample_pk is not None:
            parent_pk = row.lims_sample_pk
        elif row.lims_sub_sample_pk is not None:
            sub = db.get(LimsSubSample, row.lims_sub_sample_pk)
            parent_pk = sub.parent_sample_pk if sub else None
        else:
            parent_pk = None
        if parent_pk is not None:
            background_tasks.add_task(
                run_cascades_bg, parent_pk,
                getattr(current_user, "id", None))
    except Exception:
        import logging
        logging.getLogger(__name__).exception(
            "sbs cascade scheduling failed (never-raise)")
```

3. In `transition` (~213): add `background_tasks: BackgroundTasks,` to the signature (before `db=Depends(...)`), and after the service call succeeds (`row = service.apply_transition(...)` returns), call `_schedule_sbs_cascade(background_tasks, db, row, current_user)`.
4. In `promote` (~274): same signature addition; after the SENAITE write-back section completes and before the final response is built, call `_schedule_sbs_cascade(background_tasks, db, parent_row, current_user)`.

- [ ] **Step 4: Run tests** — new test passes. Also run the promote-path regression set:
`<main-venv-python> -m pytest tests/test_lims_analyses_service.py tests/test_promote_writeback_route.py tests/test_lims_analyses_routes.py -q -p no:warnings --tb=no`
Expected: failure NAMES identical to the pre-existing baseline (no new names).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/routes.py backend/tests/test_workflow_shadow_touchpoints.py
git commit -m "feat(sbs): analysis-change cascade touchpoint (BackgroundTasks, never-raise)"
```

---

### Task 6: Seed / heal / reset script

**Files:**
- Create: `backend/scripts/seed_native_status.py`
- Test: `backend/tests/test_workflow_shadow_touchpoints.py` (extend)

**Interfaces:**
- Consumes: Task 1 models only (no engine import needed).
- Produces: `seed_native_status(db, *, sample_ids=None, apply=False) -> dict` stats (importable), CLI `python -m scripts.seed_native_status [--samples P-1,P-2 | --all] [--apply]`.

- [ ] **Step 1: Write failing test** (append)

```python
def test_seed_native_status_dry_run_and_apply(db, tp_sample):
    from scripts.seed_native_status import seed_native_status
    db.execute(  # start unseeded
        LimsSample.__table__.update().where(
            LimsSample.id == tp_sample.id).values(native_status=None))
    db.commit()
    stats = seed_native_status(db, sample_ids=[tp_sample.sample_id], apply=False)
    db.expire_all()
    assert stats["would_seed"] == 1
    assert db.get(LimsSample, tp_sample.id).native_status is None
    stats2 = seed_native_status(db, sample_ids=[tp_sample.sample_id], apply=True)
    db.expire_all()
    assert stats2["seeded"] == 1
    fresh = db.get(LimsSample, tp_sample.id)
    assert fresh.native_status == fresh.status
    seeded_rows = db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == tp_sample.id,
        LimsWorkflowShadowEvaluation.outcome == "seeded",
    )).scalars().all()
    assert len(seeded_rows) == 1
    # heal/reset: re-run re-adopts (idempotent when equal — still records)
    stats3 = seed_native_status(db, sample_ids=[tp_sample.sample_id], apply=True)
    assert stats3["seeded"] == 1
```

- [ ] **Step 2: Run to verify failure** — ModuleNotFoundError.

- [ ] **Step 3: Implement**

```python
# backend/scripts/seed_native_status.py
"""Seed / heal / reset lims_samples.native_status (2026-07-26 spec §7).

    docker exec -w /app -i <backend> python -m scripts.seed_native_status --all --apply
    docker exec -w /app -i <backend> python -m scripts.seed_native_status --samples P-1525 --apply

Dry-run by default. Sets native_status = status and writes one
outcome='seeded' trajectory row per sample (trigger='seed') recording the
adopted state. Serves three roles: initial deploy seed; per-sample heal after
a diagnosed divergence; global burn-in reset after a rule fix. Pure DB — no
SENAITE, no throttle needed. Exit 0 clean; 1 on any per-sample error.
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session


def seed_native_status(db: Session, *, sample_ids=None, apply: bool = False) -> dict:
    from models import LimsSample, LimsWorkflowShadowEvaluation
    q = select(LimsSample).order_by(LimsSample.id)
    if sample_ids:
        q = q.where(LimsSample.sample_id.in_(list(sample_ids)))
    stats = {"scanned": 0, "would_seed": 0, "seeded": 0, "errors": 0}
    for row in db.execute(q).scalars().all():
        stats["scanned"] += 1
        try:
            if not apply:
                stats["would_seed"] += 1
                continue
            prior = row.native_status
            row.native_status = row.status
            db.add(LimsWorkflowShadowEvaluation(
                lims_sample_pk=row.id, trigger="seed", verb=None,
                from_status=prior, to_status=row.status, outcome="seeded",
                requirements_met=None, outcomes=[]))
            db.flush()
            stats["seeded"] += 1
        except Exception:
            stats["errors"] += 1
            db.rollback()
    if apply:
        db.commit()
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--samples", type=str)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    from database import SessionLocal
    db = SessionLocal()
    try:
        ids = [s.strip() for s in args.samples.split(",")] if args.samples else None
        stats = seed_native_status(db, sample_ids=ids, apply=args.apply)
        print(f"seed_native_status stats: {stats} "
              f"(mode={'APPLY' if args.apply else 'DRY-RUN'})")
        return 1 if stats["errors"] else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests** — pass.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/seed_native_status.py backend/tests/test_workflow_shadow_touchpoints.py
git commit -m "feat(sbs): native_status seed/heal/reset script"
```

---

### Task 7: Divergence summary endpoint

**Files:**
- Modify: `backend/workflow/routes.py` (append route)
- Test: `backend/tests/test_workflow_shadow_summary.py` (create)

**Interfaces:**
- Consumes: Task 1 models; router conventions in `workflow/routes.py` (router has `get_current_user` global dep; admin routes add `dependencies=[Depends(require_admin)]` per-route — the module docstring documents this).
- Produces: `GET /api/workflow/shadow/summary?since=<iso>` (admin) →
  `{"total_seeded", "buckets": {"agree": n, "mk1_refused": n, "no_native_pathway": n, "stuck_behind": n}, "divergent": [{"sample_id","status","native_status","bucket","latest_outcome","latest_verb","unmet"} ... capped 200]}`.

**Bucket rules (spec §6.1, keyed to exact outcomes):** over samples with `native_status IS NOT NULL`: equal columns → `agree`. Differing: latest shadow row `outcome='requirements_unmet'` → `mk1_refused`; `outcome='no_edge'` → `stuck_behind`; otherwise (no shadow attempt since divergence — includes only-`seeded`/`advanced` history) → `no_native_pathway`.

- [ ] **Step 1: Write failing test**

```python
# backend/tests/test_workflow_shadow_summary.py
"""Summary buckets + registry-inspect shadow block."""
from __future__ import annotations

import pytest
from sqlalchemy import delete

from database import SessionLocal
from models import LimsSample, LimsWorkflowShadowEvaluation


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def cohort(db):
    rows = []
    def mk(sid, status, native, evals=()):
        r = LimsSample(sample_id=sid, status=status, native_status=native)
        db.add(r); db.flush()
        for outcome, verb in evals:
            db.add(LimsWorkflowShadowEvaluation(
                lims_sample_pk=r.id, trigger="publish", verb=verb,
                from_status=native, to_status=native, outcome=outcome,
                requirements_met=(outcome == "advanced"), outcomes=[]))
        db.flush()
        rows.append(r)
        return r
    mk("TEST-SUM-A", "verified", "verified")                       # agree
    mk("TEST-SUM-B", "published", "verified",
       evals=[("requirements_unmet", "publish")])                  # mk1_refused
    mk("TEST-SUM-C", "published", "verified",
       evals=[("no_edge", "publish")])                             # stuck_behind
    mk("TEST-SUM-D", "cancelled", "sample_received",
       evals=[("seeded", None)])                                   # no_native_pathway
    db.commit()
    yield rows
    for r in rows:
        db.execute(delete(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == r.id))
        db.execute(delete(LimsSample).where(LimsSample.id == r.id))
    db.commit()


def test_summary_buckets(db, cohort):
    from workflow.routes import _shadow_summary_payload
    p = _shadow_summary_payload(db, since=None)
    by_id = {d["sample_id"]: d["bucket"] for d in p["divergent"]}
    assert by_id["TEST-SUM-B"] == "mk1_refused"
    assert by_id["TEST-SUM-C"] == "stuck_behind"
    assert by_id["TEST-SUM-D"] == "no_native_pathway"
    assert "TEST-SUM-A" not in by_id
    assert p["buckets"]["agree"] >= 1
```

- [ ] **Step 2: Run to verify failure** — ImportError on `_shadow_summary_payload`.

- [ ] **Step 3: Implement** (append to `workflow/routes.py`)

```python
def _shadow_summary_payload(db: Session, since) -> dict:
    """Side-by-side divergence report (2026-07-26 spec §6.1). Core is a
    two-column comparison; the latest trajectory row supplies the WHY."""
    from models import LimsSample, LimsWorkflowShadowEvaluation as Ev
    samples = db.execute(
        select(LimsSample).where(LimsSample.native_status.isnot(None))
    ).scalars().all()
    buckets = {"agree": 0, "mk1_refused": 0,
               "no_native_pathway": 0, "stuck_behind": 0}
    divergent = []
    for s in samples:
        if s.native_status == s.status:
            buckets["agree"] += 1
            continue
        q = select(Ev).where(Ev.lims_sample_pk == s.id)
        if since is not None:
            q = q.where(Ev.evaluated_at >= since)
        latest = db.execute(
            q.order_by(Ev.evaluated_at.desc(), Ev.id.desc()).limit(1)
        ).scalars().first()
        outcome = latest.outcome if latest else None
        if outcome == "requirements_unmet":
            bucket = "mk1_refused"
        elif outcome == "no_edge":
            bucket = "stuck_behind"
        else:
            bucket = "no_native_pathway"
        buckets[bucket] += 1
        if len(divergent) < 200:
            divergent.append({
                "sample_id": s.sample_id, "status": s.status,
                "native_status": s.native_status, "bucket": bucket,
                "latest_outcome": outcome,
                "latest_verb": latest.verb if latest else None,
                "unmet": [o for o in (latest.outcomes or [])
                          if not o.get("met")] if latest else [],
            })
    return {"total_seeded": len(samples), "buckets": buckets,
            "divergent": divergent}


@router.get("/shadow/summary", dependencies=[Depends(require_admin)])
def shadow_summary(since: str | None = Query(default=None),
                   db: Session = Depends(get_db)):
    """Flip-readiness report: agree / mk1_refused / no_native_pathway /
    stuck_behind over seeded samples (spec §6.1)."""
    from datetime import datetime as _dt
    parsed = _dt.fromisoformat(since) if since else None
    return _shadow_summary_payload(db, since=parsed)
```

(Match the module's existing imports — `Query`, `get_db`, `require_admin`, `select`, `Session` are already imported there; add any that aren't.)

- [ ] **Step 4: Run tests** — pass.

- [ ] **Step 5: Commit**

```bash
git add backend/workflow/routes.py backend/tests/test_workflow_shadow_summary.py
git commit -m "feat(sbs): admin divergence summary endpoint (flip-readiness report)"
```

---

### Task 8: Registry-inspect block — backend + FE

**Files:**
- Modify: `backend/main.py` — new `_build_shadow_block` next to `_build_sample_transitions` (~17881); wire into `_build_registry_debug_response`
- Modify: `src/lib/api.ts` — extend the registry-debug payload type
- Modify: `src/components/senaite/SampleRegistryDebug.tsx` — render the block
- Test: `backend/tests/test_workflow_shadow_summary.py` (extend); FE: `src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 1 models.
- Produces: debug payload gains `"shadow": {"native_status", "current_status", "in_sync", "latest": {"verb","outcome","evaluated_at","unmet"} | null, "error"}`.

- [ ] **Step 1: Write failing backend test** (append to test_workflow_shadow_summary.py)

```python
def test_build_shadow_block(db, cohort):
    from main import _build_shadow_block
    refused = next(r for r in cohort if r.sample_id == "TEST-SUM-B")
    block = _build_shadow_block(db, refused)
    assert block["native_status"] == "verified"
    assert block["current_status"] == "published"
    assert block["in_sync"] is False
    assert block["latest"]["outcome"] == "requirements_unmet"

    agree = next(r for r in cohort if r.sample_id == "TEST-SUM-A")
    assert _build_shadow_block(db, agree)["in_sync"] is True
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement backend**

Next to `_build_sample_transitions` in main.py, same independent-failure posture:

```python
def _build_shadow_block(db: Session, row: LimsSample) -> dict:
    """Side-by-side engine panel block (2026-07-26 spec §6.2): the native
    trajectory position vs the SENAITE mirror, + the latest engine attempt.
    Own try/except — a failure here must not blank the rest of the payload."""
    from models import LimsWorkflowShadowEvaluation as Ev
    try:
        latest = db.execute(
            select(Ev).where(Ev.lims_sample_pk == row.id)
            .order_by(Ev.evaluated_at.desc(), Ev.id.desc()).limit(1)
        ).scalars().first()
        return {
            "native_status": row.native_status,
            "current_status": row.status,
            "in_sync": (None if row.native_status is None
                        else row.native_status == row.status),
            "latest": None if latest is None else {
                "verb": latest.verb, "outcome": latest.outcome,
                "evaluated_at": latest.evaluated_at.isoformat(),
                "unmet": [o for o in (latest.outcomes or [])
                          if not o.get("met")],
            },
            "error": None,
        }
    except Exception as e:
        return {"native_status": None, "current_status": row.status,
                "in_sync": None, "latest": None, "error": str(e)}
```

In `_build_registry_debug_response`, where the payload dict assembles the `transitions` key, add a sibling: `"shadow": _build_shadow_block(db, row),`.

- [ ] **Step 4: Implement FE**

In `src/lib/api.ts`, find the registry-debug response type (the one carrying `transitions: SampleTransitionsTail | null`, ~5177) and add:

```typescript
  shadow: {
    native_status: string | null
    current_status: string | null
    in_sync: boolean | null
    latest: {
      verb: string | null
      outcome: string
      evaluated_at: string
      unmet: Array<{ kind: string; value: string | null; detail: string | null }>
    } | null
    error: string | null
  } | null
```

In `SampleRegistryDebug.tsx`, after the transitions-tail section, add a "Side-by-side" section following the component's existing section idiom (same wrappers/classNames as the transitions block — copy its structure):

- Row 1: `native_status` vs `current_status` with an in-sync/desync badge (`in_sync === null` → "not seeded" muted text).
- Row 2 (when `latest` non-null): `latest.verb` → `latest.outcome` + `evaluated_at`; when `latest.unmet.length > 0`, list each `kind`: `detail` in `font-mono` small text.
- When `error` non-null: render the error string, same style as `transitions.error`.

- [ ] **Step 5: Extend the FE test** (in `__tests__/SampleRegistryDebug.test.tsx`, follow the file's existing mock-payload pattern — add `shadow` to the mocked payload and assert the section title and the desync badge render):

```typescript
it('renders the side-by-side shadow block', () => {
  // extend the existing mock payload object with:
  // shadow: { native_status: 'verified', current_status: 'published',
  //           in_sync: false,
  //           latest: { verb: 'publish', outcome: 'requirements_unmet',
  //                     evaluated_at: '2026-07-26T00:00:00',
  //                     unmet: [{ kind: 'coa_published', value: null, detail: 'publish not attested' }] },
  //           error: null }
  // then assert:
  // expect(screen.getByText(/side-by-side/i)).toBeInTheDocument()
  // expect(screen.getByText(/requirements_unmet/)).toBeInTheDocument()
})
```

- [ ] **Step 6: Run tests**

Backend: `<main-venv-python> -m pytest tests/test_workflow_shadow_summary.py -q -p no:warnings` — pass.
FE (worktree, npm only; `npm install` first if needed): `npx vitest run src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` — pass. Also `npx tsc --noEmit` clean for the touched files.

- [ ] **Step 7: Commit**

```bash
git add backend/main.py backend/tests/test_workflow_shadow_summary.py src/lib/api.ts src/components/senaite/SampleRegistryDebug.tsx src/components/senaite/__tests__/SampleRegistryDebug.test.tsx
git commit -m "feat(sbs): registry-inspect side-by-side block (backend + FE)"
```

---

### Task 9: Gate, docs, spec as-built note

**Files:**
- Modify: `CHANGELOG.md` (Unreleased section)
- Modify: `docs/superpowers/specs/2026-07-26-side-by-side-workflow-engine-design.md` (as-built amendments)

- [ ] **Step 1: Full-suite failure-set gate**

```bash
cd /c/tmp/Accu-Mk1-sidebyside/backend
<main-venv-python> -m pytest tests/ -q --tb=no -p no:warnings 2>&1 | grep '^FAILED' | sed 's/ - .*//' | sort > /tmp/fail_branch.txt
cd /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend
<main-venv-python> -m pytest tests/ -q --tb=no -p no:warnings 2>&1 | grep '^FAILED' | sed 's/ - .*//' | sort > /tmp/fail_master.txt
comm -23 /tmp/fail_branch.txt /tmp/fail_master.txt   # MUST be empty
```

Expected: empty diff (branch-only failures = none). The known master-side noise (`test_httpx_shared_ssl` pair in the main checkout, flaky `test_clickup_task_retry` pair) appears on the master side only.

- [ ] **Step 2: CHANGELOG**

Add under `## Unreleased`:

```markdown
### Added
- **Side-by-side workflow engine** (2026-07-26 spec): Mk1 executes sample-tier
  transitions in parallel — own `native_status` driven by the workflow catalog
  + requirements at Mk1-originated trigger sites (receive, publish, analysis
  cascades). SENAITE untouched and authoritative; all writes additive; env
  kill switch `MK1_WORKFLOW_SHADOW_ENABLED`. Divergence report
  `GET /api/workflow/shadow/summary` = flip-readiness; registry-inspect gains
  a side-by-side block. Deploy: run
  `python -m scripts.seed_native_status --all --apply` (off-hours), then
  verify the summary shows 100% agree on day zero.
```

- [ ] **Step 3: Spec as-built amendments** (append an "As built" section to the spec):

```markdown
## As built (2026-07-26 implementation)

- Requirements vocabulary v1 is the LIVE catalog registry
  (`workflow/catalog.py REQUIREMENT_KINDS`) — entry shape
  `{kind, value, note}`, extended with `coa_published` (no value) and
  `distinct_actor` (value = than-verb, non-gating). The 07-13 draft's
  `{kind, args}` shape was never seeded and is dropped.
  `all_analyses_in_state` takes a comma-list value; empty live-line set
  evaluates unmet (fail-closed).
- Cascade eligibility = `lims_workflow_transitions.auto_fire` (new additive
  column; seeded TRUE for the builtin sample submit/verify edges via a
  guarded boot UPDATE).
- Trigger sites landed as: the `_record_sample_transition_bg` chokepoint
  (receive + publish, attestation = the hook only fires post-IS-success) and
  `lims_analyses` routes `transition`/`promote` via BackgroundTasks.
- Cascade probing does NOT record refusals (speculative probes would spam
  the trajectory); refusals are recorded only for explicit verbs.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-07-26-side-by-side-workflow-engine-design.md
git commit -m "docs(sbs): changelog + spec as-built amendments"
```

---

## Deploy runbook (post-merge — Handler-gated, NOT part of this plan's execution)

1. Merge PR → deploy image from the main checkout (accumark-deploy skill; MINOR bump — new feature).
2. Confirm env: `MK1_WORKFLOW_SHADOW_ENABLED` unset or `1` (default-on kill-switch semantics).
3. Off-hours: `docker exec -w /app -i accu-mk1-backend python -m scripts.seed_native_status --all --apply` — retain the stats line.
4. `GET /api/workflow/shadow/summary` → expect `buckets.agree == total_seeded` on day zero.
5. Burn-in: re-check the summary daily; end when the report is clean (spec §6.1), not the calendar.

## Self-review notes

- Spec coverage: §3.1→T1, §3.2→T1+T3, §4→T2+T3, §5→T4+T5, §6.1→T7, §6.2→T8, §7→T6, §8→T4 (flag) + T9 (runbook), §10→tests throughout, auto_fire (§4 "catalog data")→T1+T3.
- Deviation from spec, intentional: `trigger` value for receive-site cascades is the verb (`'receive'`/`'publish'`) via `execute_verb`/`evaluate_cascades` trigger passing at the chokepoint — matches spec §3.2 ("cascades inherit the initiating site's value").
- Deviation: cascade probes don't record refusals (spec is silent; recording every probe would violate the delta-dedup intent). Captured in the as-built amendment.
- Type consistency: `execute_verb`/`evaluate_cascades`/`run_cascades_bg`/`evaluate_requirements`/`shadow_enabled` names match across Tasks 2–5; `LimsWorkflowShadowEvaluation` fields match T1 across all consumers; bucket strings match T7↔spec §6.1.
