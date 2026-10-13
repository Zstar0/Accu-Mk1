"""Endo slice 3, Task 2: the sample page's promote body as one shared function.

lims_analyses.promote_flow.run_promote is what POST /api/lims-analyses/promote
now calls, and what the worksheet endpoint (Task 5) calls row by row. Pinned
here: the result limits it copies, the audit reason it appends, the refusals it
raises (with the route's exact status and body), the rollback that keeps a
second parent row from ever landing (Review Focus 2), and how the side-by-side
cascade runs with and without a request.

In-memory SQLite with StaticPool (shared by the test and the TestClient
thread), same idiom as test_promote_writeback_route.route_client.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from lims_analyses.promote_flow import PromoteError, run_promote
from lims_analyses.schemas import PromoteRequest
from main import app
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample, LimsSubSample

# The live parent identity index (database.py, the M1-widened form). It lives
# only in the boot migrations, so create_all never builds it; created here so a
# second parent row collides exactly as it does in Postgres.
PARENT_IDX = """
CREATE UNIQUE INDEX uq_lims_analyses_parent_service_id_root
    ON lims_analyses (lims_sample_pk, analysis_service_id, COALESCE(slot, 0))
    WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
      AND review_state NOT IN ('retracted', 'rejected')
      AND provenance = 'canonical'
"""
PARENT_EXISTS = (
    "A parent-tier row already exists for this parent + keyword. Retract the "
    "existing parent row first, then re-promote."
)
USER = SimpleNamespace(id=7, email="qa@accumark.test")
WS_REASON = "promoted from worksheet WS-24 row P-7101-S01"


@pytest.fixture
def world():
    """A native endotoxin service; one parent with two vials, each holding a
    to_be_verified endotoxin result of 25."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text(PARENT_IDX))
    db = sessionmaker(bind=engine)()
    svc = AnalysisService(title="Endotoxin USP85 LAL", keyword="ENDOTOXIN-USP85LAL",
                          origin="mk1", unit="EU/mL")
    parent = LimsSample(sample_id="P-7101", external_lims_uid="uid-P-7101")
    db.add_all([svc, parent])
    db.flush()
    rows = []
    for n in (1, 2):
        vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"uid-P-7101-S0{n}",
                             sample_id=f"P-7101-S0{n}", vial_sequence=n)
        db.add(vial)
        db.flush()
        row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                           keyword=svc.keyword, title=svc.title,
                           result_value="25", review_state="to_be_verified")
        db.add(row)
        db.flush()
        rows.append(row)
    db.commit()
    yield SimpleNamespace(db=db, parent=parent, rows=rows)
    db.close()


@pytest.fixture(autouse=True)
def cascade_calls(monkeypatch):
    """Record the side-by-side cascade instead of running it: the real
    run_cascades_bg opens its own session on the host Postgres."""
    calls = []
    monkeypatch.setenv("MK1_WORKFLOW_SHADOW_ENABLED", "1")
    monkeypatch.setattr("workflow.engine.run_cascades_bg",
                        lambda parent_pk, user_id: calls.append((parent_pk, user_id)))
    return calls


@pytest.fixture
def client(world):
    def _db():
        yield world.db

    prev = {dep: app.dependency_overrides.get(dep) for dep in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: USER
    yield TestClient(app)
    for dep, value in prev.items():
        if value is None:
            app.dependency_overrides.pop(dep, None)
        else:
            app.dependency_overrides[dep] = value


def _req(row_id: int, **kw) -> PromoteRequest:
    return PromoteRequest(keyword="ENDOTOXIN-USP85LAL", result_value="25",
                          sources=[{"analysis_id": row_id, "contribution_kind": "chosen"}], **kw)


def _body(row_id: int) -> dict:
    return {"keyword": "ENDOTOXIN-USP85LAL", "result_value": "25",
            "sources": [{"analysis_id": row_id, "contribution_kind": "chosen"}]}


def _limits(obj) -> tuple:
    return (obj.loq, obj.lod, obj.lod_unit)


def _reasons(db, analysis_id: int) -> list:
    return list(db.execute(
        select(LimsAnalysisTransition.reason)
        .where(LimsAnalysisTransition.analysis_id == analysis_id)
        .order_by(LimsAnalysisTransition.id)
    ).scalars().all())


def _parent_rows(world) -> list:
    return world.db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == world.parent.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
    )).scalars().all()


# ── result limits on the new parent row ────────────────────────────────────


def test_request_limits_land_on_the_parent_row(world):
    resp = run_promote(world.db, USER, _req(world.rows[0].id, loq=25.0, lod=0.05, lod_unit="EU/mL"))

    assert resp.parent.review_state == "parent_to_verify"
    assert _limits(resp.parent) == (25.0, 0.05, "EU/mL")
    assert _limits(world.db.get(LimsAnalysis, resp.parent.id)) == (25.0, 0.05, "EU/mL")


def test_the_sources_limits_are_copied_when_the_request_sends_none(world):
    """A vial filled with its LOQ keeps it when promoted from the sample page."""
    src = world.rows[0]
    src.loq, src.lod, src.lod_unit = 25.0, 0.05, "EU/mL"
    world.db.commit()

    resp = run_promote(world.db, USER, _req(src.id))

    assert _limits(resp.parent) == (25.0, 0.05, "EU/mL")


def test_request_limits_win_whole_and_are_never_mixed_with_the_sources(world):
    src = world.rows[0]
    src.loq, src.lod, src.lod_unit = 25.0, 0.05, "EU/mL"
    world.db.commit()

    resp = run_promote(world.db, USER, _req(src.id, loq=50.0))

    assert _limits(resp.parent) == (50.0, None, None)


# ── audit reason ────────────────────────────────────────────────────────────


def test_audit_reason_is_appended_to_the_promote_transitions(world):
    src = world.rows[0]

    resp = run_promote(world.db, USER, _req(src.id), audit_reason=WS_REASON)

    pid = resp.parent.id
    assert _reasons(world.db, pid) == [f"promoted from sources [{src.id}]; {WS_REASON}"]
    assert _reasons(world.db, src.id) == [f"promoted to parent #{pid} (kind=chosen); {WS_REASON}"]


def test_without_an_audit_reason_the_reasons_are_unchanged(world):
    src = world.rows[0]

    resp = run_promote(world.db, USER, _req(src.id))

    pid = resp.parent.id
    assert _reasons(world.db, pid) == [f"promoted from sources [{src.id}]"]
    assert _reasons(world.db, src.id) == [f"promoted to parent #{pid} (kind=chosen)"]


# ── refusals (Review Focus 2) ───────────────────────────────────────────────


def test_a_second_parent_row_is_a_409_refusal_and_the_session_is_rolled_back(world):
    first, second = world.rows
    run_promote(world.db, USER, _req(first.id))
    second_id = second.id

    with pytest.raises(PromoteError) as caught:
        run_promote(world.db, USER, _req(second_id))

    e = caught.value
    assert (e.code, e.status, e.detail) == ("parent_row_already_exists", 409, PARENT_EXISTS)
    assert e.body == {"code": "parent_row_already_exists", "message": PARENT_EXISTS}
    # Rolled back: the session still works, exactly one parent row, the second
    # source untouched.
    assert len(_parent_rows(world)) == 1
    assert world.db.get(LimsAnalysis, second_id).review_state == "to_be_verified"


def test_a_missing_source_and_a_wrong_state_source_are_refusals(world):
    with pytest.raises(PromoteError) as missing:
        run_promote(world.db, USER, _req(999_999))
    assert (missing.value.code, missing.value.status, missing.value.body) == (
        "source_not_found", 404, "source analysis not found")

    src = world.rows[0]
    src.review_state = "unassigned"
    world.db.commit()
    with pytest.raises(PromoteError) as wrong:
        run_promote(world.db, USER, _req(src.id))
    assert (wrong.value.code, wrong.value.status) == ("bad_request", 400)
    assert wrong.value.body == (
        f"source {src.id} is in 'unassigned'; only 'to_be_verified' rows can be promoted")


def test_the_route_answers_the_same_bodies_as_before(world, client):
    first, second = world.rows
    assert client.post("/api/lims-analyses/promote", json=_body(first.id)).status_code == 201

    dup = client.post("/api/lims-analyses/promote", json=_body(second.id))
    assert dup.status_code == 409
    assert dup.json() == {"detail": {"code": "parent_row_already_exists", "message": PARENT_EXISTS}}

    missing = client.post("/api/lims-analyses/promote", json=_body(999_999))
    assert missing.status_code == 404
    assert missing.json() == {"detail": "source analysis not found"}


# ── the side-by-side cascade ────────────────────────────────────────────────


def test_without_background_tasks_the_cascade_runs_inline(world, cascade_calls):
    run_promote(world.db, USER, _req(world.rows[0].id))

    assert cascade_calls == [(world.parent.id, USER.id)]


def test_with_background_tasks_the_cascade_is_scheduled_not_run(world, cascade_calls):
    import workflow.engine as engine
    tasks = BackgroundTasks()

    run_promote(world.db, USER, _req(world.rows[0].id), background_tasks=tasks)

    assert cascade_calls == []
    [task] = tasks.tasks
    assert task.func is engine.run_cascades_bg
    assert task.args == (world.parent.id, USER.id)


def test_the_cascade_kill_switch_is_honoured(world, cascade_calls, monkeypatch):
    monkeypatch.setenv("MK1_WORKFLOW_SHADOW_ENABLED", "0")

    run_promote(world.db, USER, _req(world.rows[0].id))

    assert cascade_calls == []
