"""HTTP tests for POST /api/lims-analyses/parent/{sample_id}/retest.

This is the dedicated native-origination route for a parent-tier retest: the
generic POST /api/lims-analyses/{id}/transitions tier-blocks 'retest' at
TIER_PARENT by design (pinned in test_lims_analyses_routes.py), so this route
is the only HTTP caller of cascade_parent_retest_to_sources
(lims_analyses/service.py ~1276) via the new parent_retest service function.

Fixture idiom: TestClient + StaticPool in-memory SQLite (get_db/auth
dependency overrides) copied from test_native_parent_analyses_endpoint.py:56,
combined with the promoted-parent seeding helpers from
test_parent_retest_cascade.py (create_analysis + apply_transition ->
to_be_verified, then promote_to_parent) so the fixtures exercise the same
promote/cascade machinery those cascade unit tests already cover.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import auth
from main import app
from database import get_db, Base
from lims_analyses.service import apply_transition, create_analysis, promote_to_parent


class _FakeUser:
    id = None
    email = "test@accumark.test"


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(auth.get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(auth.get_current_user, None)
    else:
        app.dependency_overrides[auth.get_current_user] = prev_user


@pytest.fixture
def plain_client(client):
    """Plain client with no seeded sample — used for the unknown-sample 404."""
    return client


# ─── Seeding helpers (mirrors test_parent_retest_cascade.py's idiom) ─────────


def _mk_service(db, *, keyword, origin="mk1", unit="ppm"):
    from models import AnalysisService
    svc = AnalysisService(title=keyword.title(), keyword=keyword, origin=origin, unit=unit)
    db.add(svc)
    db.flush()
    return svc


def _make_vial_tbv(db, sub, svc, result="98.55"):
    """Create a vial-tier analysis and walk it to to_be_verified."""
    row = create_analysis(
        db,
        host_kind="sub_sample",
        host_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title="TEST: " + (svc.title or svc.keyword),
        result_value=None,
    )
    apply_transition(db, analysis_id=row.id, kind="assign")
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=result)
    db.refresh(row)
    assert row.review_state == "to_be_verified"
    return row


def _seed_parent_and_subs(db, *, sample_id, n_subs=2):
    from models import LimsSample, LimsSubSample

    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"uid-{sample_id}")
    db.add(parent)
    db.flush()
    subs = []
    for i in range(n_subs):
        sub = LimsSubSample(
            parent_sample_pk=parent.id,
            external_lims_uid=f"uid-{sample_id}-S{i + 1:02d}",
            sample_id=f"{sample_id}-S{i + 1:02d}",
            vial_sequence=i + 1,
        )
        db.add(sub)
        db.flush()
        subs.append(sub)
    db.commit()
    return parent, subs


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def client_with_promoted_parent(client, db_session):
    """Verified parent + 2 promoted (aggregated_in) vial sources.

    Returns (client, sample_id, keyword, source_ids).
    """
    parent, subs = _seed_parent_and_subs(db_session, sample_id="P-RETEST-001")
    keyword = "PURITY-HPLC"
    svc = _mk_service(db_session, keyword=keyword)

    vial1 = _make_vial_tbv(db_session, subs[0], svc, result="97.00")
    vial2 = _make_vial_tbv(db_session, subs[1], svc, result="98.00")

    parent_row, _ = promote_to_parent(
        db_session,
        keyword=keyword,
        result_value="97.50",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[
            {"analysis_id": vial1.id, "contribution_kind": "aggregated_in"},
            {"analysis_id": vial2.id, "contribution_kind": "aggregated_in"},
        ],
        user_id=None,
        reason=None,
        commit=True,
    )
    # Task 3: promote mints 'parent_to_verify', not 'verified' — this fixture's
    # name/contract promises a VERIFIED parent, so the verify sign-off is part
    # of the seed, not the behavior under test.
    apply_transition(db_session, analysis_id=parent_row.id, kind="verify")

    return client, parent.sample_id, keyword, [vial1.id, vial2.id]


@pytest.fixture
def client_with_promoted_parent_published(client, db_session):
    """Same shape as client_with_promoted_parent, but the active parent row
    is walked to 'published' before the route is called.

    Returns (client, sample_id, keyword, source_ids).
    """
    parent, subs = _seed_parent_and_subs(db_session, sample_id="P-RETEST-002")
    keyword = "PURITY-HPLC"
    svc = _mk_service(db_session, keyword=keyword)

    vial1 = _make_vial_tbv(db_session, subs[0], svc, result="97.00")
    vial2 = _make_vial_tbv(db_session, subs[1], svc, result="98.00")

    parent_row, _ = promote_to_parent(
        db_session,
        keyword=keyword,
        result_value="97.50",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[
            {"analysis_id": vial1.id, "contribution_kind": "aggregated_in"},
            {"analysis_id": vial2.id, "contribution_kind": "aggregated_in"},
        ],
        user_id=None,
        reason=None,
        commit=True,
    )
    # Task 3: promote mints 'parent_to_verify' — verify before publish (publish
    # is legal only from 'verified').
    apply_transition(db_session, analysis_id=parent_row.id, kind="verify")
    apply_transition(db_session, analysis_id=parent_row.id, kind="publish")

    return client, parent.sample_id, keyword, [vial1.id, vial2.id]


@pytest.fixture
def client_with_already_retested_source(client, db_session):
    """Single promoted source, retested BEFORE the route is called — the
    cascade must find nothing eligible.

    Returns (client, sample_id, keyword).
    """
    parent, subs = _seed_parent_and_subs(db_session, sample_id="P-RETEST-003", n_subs=1)
    keyword = "PURITY-HPLC"
    svc = _mk_service(db_session, keyword=keyword)

    vial = _make_vial_tbv(db_session, subs[0], svc, result="98.55")

    parent_row, _ = promote_to_parent(
        db_session,
        keyword=keyword,
        result_value="98.55",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": vial.id, "contribution_kind": "chosen"}],
        user_id=None,
        reason=None,
        commit=True,
    )
    # Task 3: promote mints 'parent_to_verify' — verify so the parent lands in
    # 'verified', matching this fixture's "parent STAYS verified" contract.
    apply_transition(db_session, analysis_id=parent_row.id, kind="verify")

    # Retest the source BEFORE calling the route — it's no longer eligible.
    apply_transition(db_session, analysis_id=vial.id, kind="retest")

    return client, parent.sample_id, keyword


# ─── Tests ───────────────────────────────────────────────────────────────────


def test_parent_retest_happy_path(client_with_promoted_parent, db_session):
    """Verified parent + 2 promoted sources: both sources get retest rows,
    parent is un-promoted (retracted, result cleared)."""
    client, sample_id, keyword, source_ids = client_with_promoted_parent
    r = client.post(
        f"/api/lims-analyses/parent/{sample_id}/retest",
        json={"keyword": keyword},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["new_row_ids"]) == 2
    assert body["parent_review_state"] == "retracted"

    from models import LimsAnalysis, LimsSample

    # Sources flagged retested.
    db_session.expire_all()
    for sid in source_ids:
        src = db_session.get(LimsAnalysis, sid)
        assert src.retested is True

    # New rows linked via retest_of_id back to their originals.
    new_of_ids = {
        db_session.get(LimsAnalysis, nid).retest_of_id for nid in body["new_row_ids"]
    }
    assert new_of_ids == set(source_ids)

    # Parent row retracted with result_value cleared.
    parent = db_session.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one()
    parent_row = db_session.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.keyword == keyword,
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalars().first()
    assert parent_row is not None
    assert parent_row.review_state == "retracted"
    assert parent_row.result_value is None


def test_parent_retest_not_verified_409(client_with_promoted_parent_published, db_session):
    """Published (or any non-verified) active parent row → 409, nothing retested."""
    client, sample_id, keyword, source_ids = client_with_promoted_parent_published
    r = client.post(
        f"/api/lims-analyses/parent/{sample_id}/retest", json={"keyword": keyword}
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "invalid_transition"

    from models import LimsAnalysis

    db_session.expire_all()
    for sid in source_ids:
        src = db_session.get(LimsAnalysis, sid)
        assert src.retested is False


def test_parent_retest_no_eligible_sources_returns_empty(client_with_already_retested_source):
    """Sources already retested → 200, new_row_ids [], parent STAYS verified
    (the cascade only un-promotes when it actually created retest rows)."""
    client, sample_id, keyword = client_with_already_retested_source
    r = client.post(
        f"/api/lims-analyses/parent/{sample_id}/retest", json={"keyword": keyword}
    )
    assert r.status_code == 200, r.text
    assert r.json()["new_row_ids"] == []
    assert r.json()["parent_review_state"] == "verified"


def test_parent_retest_unknown_sample_404(plain_client):
    """A missing route would also 404 with {"detail": "Not Found"} — assert
    on the service's NotFoundError message so this discriminates the route
    existing-but-rejecting from the route simply not being registered."""
    r = plain_client.post(
        "/api/lims-analyses/parent/NOPE-404/retest", json={"keyword": "HM-ICPMS"}
    )
    assert r.status_code == 404
    assert "not known to Mk1" in r.json()["detail"]


def test_parent_retest_unknown_keyword_404(client_with_promoted_parent):
    """Same discriminating-message rationale as the unknown-sample 404 above."""
    client, sample_id, _, _ = client_with_promoted_parent
    r = client.post(
        f"/api/lims-analyses/parent/{sample_id}/retest", json={"keyword": "NOPE"}
    )
    assert r.status_code == 404
    assert "no active native parent row" in r.json()["detail"]


def test_parent_retest_custom_reason_plumbs_to_source_transitions(
    client_with_promoted_parent, db_session,
):
    """The new source_reason kwarg (service.py cascade_parent_retest_to_sources)
    exists so the route's caller-supplied reason reaches the SOURCE vials'
    retest audit rows — assert the plumbing, not just that the default is
    preserved (the untouched cascade suite already covers the default)."""
    client, sample_id, keyword, source_ids = client_with_promoted_parent
    r = client.post(
        f"/api/lims-analyses/parent/{sample_id}/retest",
        json={"keyword": keyword, "reason": "HTTP-TEST: operator note"},
    )
    assert r.status_code == 200, r.text

    from models import LimsAnalysisTransition

    db_session.expire_all()
    retest_transitions = db_session.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id.in_(source_ids),
            LimsAnalysisTransition.transition_kind == "retest",
        )
    ).scalars().all()
    assert len(retest_transitions) == len(source_ids)
    for t in retest_transitions:
        assert "HTTP-TEST: operator note" in (t.reason or "")
