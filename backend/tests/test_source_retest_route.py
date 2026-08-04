"""HTTP tests for POST /api/lims-analyses/{analysis_id}/source-retest.

Task 5: the vial-side (up-cascade) mirror of Task 3's parent-tier
POST /api/lims-analyses/parent/{sample_id}/retest. Where that route retests
EVERY promoted source under a named parent+keyword, this route retests ONE
named source row directly, then walks up to its promotion parent and
un-promotes it (retract + clear result) if the parent is still
verified/parent_to_verify. A published parent is a citable COA source and is
left untouched.

Fixture idiom: copied from test_parent_retest_route.py (TestClient +
StaticPool in-memory SQLite via get_db/auth dependency overrides, plus the
promoted-parent seeding helpers built on create_analysis + apply_transition +
promote_to_parent).
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


# ─── Seeding helpers (mirrors test_parent_retest_route.py's idiom) ───────────


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


def _seed_parent_and_subs(db, *, sample_id, n_subs=1):
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


def _promote_single_source(db, *, parent, keyword, vial, result="98.55"):
    parent_row, _ = promote_to_parent(
        db,
        keyword=keyword,
        result_value=result,
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": vial.id, "contribution_kind": "chosen"}],
        user_id=None,
        reason=None,
        commit=True,
    )
    return parent_row


# ─── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def client_with_promoted_source_verified_parent(client, db_session):
    """One mk1-origin, vial-hosted, promoted source; parent walked to
    'verified'. Returns (client, source_id, sample_id, keyword)."""
    parent, subs = _seed_parent_and_subs(db_session, sample_id="S-RETEST-001")
    keyword = "HM-AS"
    svc = _mk_service(db_session, keyword=keyword, origin="mk1")
    vial = _make_vial_tbv(db_session, subs[0], svc, result="1.20")

    parent_row = _promote_single_source(
        db_session, parent=parent, keyword=keyword, vial=vial, result="1.20",
    )
    apply_transition(db_session, analysis_id=parent_row.id, kind="verify")

    return client, vial.id, parent.sample_id, keyword


@pytest.fixture
def client_with_promoted_source_awaiting_parent(client, db_session):
    """Same shape, but the parent is LEFT in 'parent_to_verify' (no verify
    sign-off yet)."""
    parent, subs = _seed_parent_and_subs(db_session, sample_id="S-RETEST-002")
    keyword = "HM-AS"
    svc = _mk_service(db_session, keyword=keyword, origin="mk1")
    vial = _make_vial_tbv(db_session, subs[0], svc, result="1.20")

    parent_row = _promote_single_source(
        db_session, parent=parent, keyword=keyword, vial=vial, result="1.20",
    )
    assert parent_row.review_state == "parent_to_verify"

    return client, vial.id, parent.sample_id, keyword


@pytest.fixture
def client_with_promoted_source_published_parent(client, db_session):
    """Same shape, but the parent is walked all the way to 'published'."""
    parent, subs = _seed_parent_and_subs(db_session, sample_id="S-RETEST-003")
    keyword = "HM-AS"
    svc = _mk_service(db_session, keyword=keyword, origin="mk1")
    vial = _make_vial_tbv(db_session, subs[0], svc, result="1.20")

    parent_row = _promote_single_source(
        db_session, parent=parent, keyword=keyword, vial=vial, result="1.20",
    )
    apply_transition(db_session, analysis_id=parent_row.id, kind="verify")
    apply_transition(db_session, analysis_id=parent_row.id, kind="publish")

    return client, vial.id, parent.sample_id, keyword


@pytest.fixture
def client_with_promoted_senaite_origin_source(client, db_session):
    """A SENAITE-origin (not mk1) vial-hosted, promoted source under a
    verified parent — retest must dead-end with 400 before touching
    anything."""
    parent, subs = _seed_parent_and_subs(db_session, sample_id="S-RETEST-004")
    keyword = "PURITY-HPLC"
    svc = _mk_service(db_session, keyword=keyword, origin="senaite")
    vial = _make_vial_tbv(db_session, subs[0], svc, result="97.00")

    parent_row = _promote_single_source(
        db_session, parent=parent, keyword=keyword, vial=vial, result="97.00",
    )
    apply_transition(db_session, analysis_id=parent_row.id, kind="verify")

    return client, vial.id


@pytest.fixture
def client_with_unpromoted_mk1_source(client, db_session):
    """An mk1-origin, vial-hosted row that has NOT been promoted (still
    to_be_verified) — not retest-eligible via this route."""
    parent, subs = _seed_parent_and_subs(db_session, sample_id="S-RETEST-005")
    keyword = "HM-AS"
    svc = _mk_service(db_session, keyword=keyword, origin="mk1")
    vial = _make_vial_tbv(db_session, subs[0], svc, result="1.20")

    return client, vial.id


@pytest.fixture
def client_with_mixed_origin_vial_rows(client, db_session):
    """A single vial hosting one mk1-origin and one senaite-origin analysis
    (both freshly created, no state walk needed — service_origin doesn't
    depend on review_state). Also seeds one mk1-origin native parent-tier row
    for the parent-side senaite-shape read.

    Returns (client, sub_pk, sample_id).
    """
    parent, subs = _seed_parent_and_subs(db_session, sample_id="S-RETEST-006")
    mk1_svc = _mk_service(db_session, keyword="HM-AS", origin="mk1")
    senaite_svc = _mk_service(db_session, keyword="PURITY-HPLC", origin="senaite")

    create_analysis(
        db_session,
        host_kind="sub_sample",
        host_pk=subs[0].id,
        analysis_service_id=mk1_svc.id,
        keyword=mk1_svc.keyword,
        title="TEST: mk1 row",
    )
    create_analysis(
        db_session,
        host_kind="sub_sample",
        host_pk=subs[0].id,
        analysis_service_id=senaite_svc.id,
        keyword=senaite_svc.keyword,
        title="TEST: senaite row",
    )
    create_analysis(
        db_session,
        host_kind="sample",
        host_pk=parent.id,
        analysis_service_id=mk1_svc.id,
        keyword=mk1_svc.keyword,
        title="TEST: mk1 parent-tier row",
    )

    return client, subs[0].id, parent.sample_id


# ─── Tests ──────────────────────────────────────────────────────────────────


def test_source_retest_unverifies_verified_parent(
    client_with_promoted_source_verified_parent, db_session,
):
    client, source_id, sample_id, keyword = client_with_promoted_source_verified_parent
    r = client.post(f"/api/lims-analyses/{source_id}/source-retest", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parent_unverified"] is True
    assert body["parent_review_state"] == "retracted"
    assert isinstance(body["new_row_id"], int)

    from models import LimsAnalysis, LimsSample, LimsSubSampleEvent

    db_session.expire_all()
    src = db_session.get(LimsAnalysis, source_id)
    assert src.retested is True

    new_row = db_session.get(LimsAnalysis, body["new_row_id"])
    assert new_row is not None
    assert new_row.retest_of_id == source_id

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

    # Task 7: promoted_source_retested — hosted on the VIAL, un-promote
    # happened so the event rides that same commit.
    event = db_session.execute(
        select(LimsSubSampleEvent).where(
            LimsSubSampleEvent.event == "promoted_source_retested",
            LimsSubSampleEvent.sub_sample_pk == src.lims_sub_sample_pk,
        )
    ).scalars().first()
    assert event is not None
    assert event.lims_sample_pk is None
    assert event.details == {
        "keyword": keyword,
        "new_row_id": body["new_row_id"],
        "parent_state_before": "verified",
        "parent_unverified": True,
        "service_origin": "mk1",
    }


def test_source_retest_unverifies_awaiting_parent(
    client_with_promoted_source_awaiting_parent, db_session,
):
    client, source_id, sample_id, keyword = client_with_promoted_source_awaiting_parent
    r = client.post(f"/api/lims-analyses/{source_id}/source-retest", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parent_unverified"] is True
    assert body["parent_review_state"] == "retracted"

    from models import LimsAnalysis, LimsSample

    db_session.expire_all()
    src = db_session.get(LimsAnalysis, source_id)
    assert src.retested is True

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


def test_source_retest_published_parent_untouched(
    client_with_promoted_source_published_parent, db_session,
):
    client, source_id, sample_id, keyword = client_with_promoted_source_published_parent
    r = client.post(f"/api/lims-analyses/{source_id}/source-retest", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parent_unverified"] is False
    assert body["parent_review_state"] == "published"

    from models import LimsAnalysis, LimsSample, LimsSubSampleEvent

    # The source itself still retests — only the un-promote step is gated on
    # parent state.
    db_session.expire_all()
    src = db_session.get(LimsAnalysis, source_id)
    assert src.retested is True

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
    assert parent_row.review_state == "published"
    assert parent_row.result_value == "1.20"

    # Task 7: event still fires even though there was no un-promote — it
    # gets its own commit rather than riding one.
    event = db_session.execute(
        select(LimsSubSampleEvent).where(
            LimsSubSampleEvent.event == "promoted_source_retested",
            LimsSubSampleEvent.sub_sample_pk == src.lims_sub_sample_pk,
        )
    ).scalars().first()
    assert event is not None
    assert event.details == {
        "keyword": keyword,
        "new_row_id": body["new_row_id"],
        "parent_state_before": "published",
        "parent_unverified": False,
        "service_origin": "mk1",
    }


def test_source_retest_senaite_origin_400(
    client_with_promoted_senaite_origin_source, db_session,
):
    client, source_id = client_with_promoted_senaite_origin_source
    r = client.post(f"/api/lims-analyses/{source_id}/source-retest", json={})
    assert r.status_code == 400
    assert "SENAITE-origin rows retest from the parent AR" in r.json()["detail"]

    from models import LimsAnalysis

    db_session.expire_all()
    src = db_session.get(LimsAnalysis, source_id)
    assert src.retested is False
    assert src.review_state == "promoted"


def test_source_retest_not_promoted_409(client_with_unpromoted_mk1_source, db_session):
    client, source_id = client_with_unpromoted_mk1_source
    r = client.post(f"/api/lims-analyses/{source_id}/source-retest", json={})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "invalid_transition"

    from models import LimsAnalysis

    db_session.expire_all()
    src = db_session.get(LimsAnalysis, source_id)
    assert src.retested is False
    assert src.review_state == "to_be_verified"


def test_source_retest_double_call_is_rejected_not_duplicated(
    client_with_promoted_source_verified_parent, db_session,
):
    """Idempotency: apply_transition's retest branch never flips
    review_state away from 'promoted', so a second identical POST (e.g. a
    double-click or a retried request) would otherwise still clear the
    vial-hosted+promoted guard and mint a SECOND orphan retest row — one
    the partial unique index (retest_of_id IS NULL only) can't catch. The
    first call must succeed; the second must 409 without creating anything
    new."""
    client, source_id, _sample_id, _keyword = client_with_promoted_source_verified_parent

    r1 = client.post(f"/api/lims-analyses/{source_id}/source-retest", json={})
    assert r1.status_code == 200, r1.text

    r2 = client.post(f"/api/lims-analyses/{source_id}/source-retest", json={})
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "invalid_transition"

    from models import LimsAnalysis, LimsAnalysisTransition

    db_session.expire_all()
    retest_rows = db_session.execute(
        select(LimsAnalysis).where(LimsAnalysis.retest_of_id == source_id)
    ).scalars().all()
    assert len(retest_rows) == 1

    retest_transitions = db_session.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == source_id,
            LimsAnalysisTransition.transition_kind == "retest",
        )
    ).scalars().all()
    assert len(retest_transitions) == 1


def test_source_retest_unknown_id_404(client):
    """A missing route would also 404 — assert on the service's message so
    this discriminates the route existing-but-rejecting from the route
    simply not being registered (test_parent_retest_route.py:394 idiom)."""
    r = client.post("/api/lims-analyses/999999/source-retest", json={})
    assert r.status_code == 404
    assert "not found" in r.json()["detail"]


def test_source_retest_parent_hosted_promoted_row_409(client, db_session):
    """The 'vial-hosted' half of the compound guard: a parent-hosted row
    (lims_sample_pk set, lims_sub_sample_pk NULL — 'the parent acting as a
    vial' promotion source, see state_machine.tier_of) in review_state=
    'promoted' must still 409, not be silently accepted. Built by setting
    review_state directly rather than through promote_to_parent, which
    would collide on the parent-tier partial unique index for a same-
    keyword parent row."""
    parent, _subs = _seed_parent_and_subs(db_session, sample_id="S-RETEST-007", n_subs=0)
    svc = _mk_service(db_session, keyword="HM-AS", origin="mk1")
    row = create_analysis(
        db_session,
        host_kind="sample",
        host_pk=parent.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title="TEST: parent-acting-as-vial row",
    )
    row.review_state = "promoted"
    db_session.commit()

    r = client.post(f"/api/lims-analyses/{row.id}/source-retest", json={})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "invalid_transition"

    from models import LimsAnalysis

    db_session.expire_all()
    src = db_session.get(LimsAnalysis, row.id)
    assert src.retested is False
    assert src.review_state == "promoted"


def test_source_retest_custom_reason_plumbs_to_source_transition(
    client_with_promoted_source_verified_parent, db_session,
):
    """The reason kwarg reaches the SOURCE row's retest audit transition —
    same plumbing test as test_parent_retest_route.py's down-cascade
    counterpart."""
    client, source_id, _sample_id, _keyword = client_with_promoted_source_verified_parent
    r = client.post(
        f"/api/lims-analyses/{source_id}/source-retest",
        json={"reason": "HTTP-TEST: operator note"},
    )
    assert r.status_code == 200, r.text

    from models import LimsAnalysisTransition

    db_session.expire_all()
    retest_transitions = db_session.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == source_id,
            LimsAnalysisTransition.transition_kind == "retest",
        )
    ).scalars().all()
    assert len(retest_transitions) == 1
    assert "HTTP-TEST: operator note" in (retest_transitions[0].reason or "")


def test_source_retest_default_reason_and_unpromote_audit_reason(
    client_with_promoted_source_verified_parent, db_session,
):
    """Brief-specified default strings land verbatim: the source retest
    audit's reason, and the parent's un-promote transition reason."""
    client, source_id, sample_id, keyword = client_with_promoted_source_verified_parent
    r = client.post(f"/api/lims-analyses/{source_id}/source-retest", json={})
    assert r.status_code == 200, r.text

    from models import LimsAnalysis, LimsAnalysisTransition, LimsSample

    db_session.expire_all()
    retest_transition = db_session.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == source_id,
            LimsAnalysisTransition.transition_kind == "retest",
        )
    ).scalars().first()
    assert "retested from vial (source retest)" in (retest_transition.reason or "")

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
    unpromote_transition = db_session.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == parent_row.id,
            LimsAnalysisTransition.to_state == "retracted",
        )
    ).scalars().first()
    assert unpromote_transition is not None
    assert unpromote_transition.reason == "un-promoted: source retested from vial"


# ─── Task 7: parent_analysis_verified event (both service_origin values) ────
#
# These fixtures already walk their parent-tier row through apply_transition
# (kind='verify') as part of seeding — apply_transition is the actual verify
# act (it writes the event) regardless of whether it's invoked directly, as
# here, or via the HTTP generic transitions endpoint (test_lims_analyses_
# routes.py::test_parent_verify_via_generic_endpoint covers that HTTP path,
# but the live catalog it runs against carries no mk1-origin service, so
# BOTH origin values are pinned here instead against fixtures with a known,
# fixed service).


def test_verify_writes_parent_analysis_verified_event_mk1(
    client_with_promoted_source_verified_parent, db_session,
):
    _client, _source_id, sample_id, keyword = client_with_promoted_source_verified_parent

    from models import LimsAnalysis, LimsSample, LimsSubSampleEvent

    parent = db_session.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one()
    parent_row = db_session.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.keyword == keyword,
        )
    ).scalars().first()
    assert parent_row is not None
    assert parent_row.review_state == "verified"

    event = db_session.execute(
        select(LimsSubSampleEvent).where(
            LimsSubSampleEvent.event == "parent_analysis_verified",
            LimsSubSampleEvent.lims_sample_pk == parent.id,
        )
    ).scalars().first()
    assert event is not None
    assert event.sub_sample_pk is None
    assert event.details == {
        "keyword": keyword,
        "analysis_id": parent_row.id,
        "service_origin": "mk1",
    }


def test_verify_writes_parent_analysis_verified_event_senaite_origin(
    client_with_promoted_senaite_origin_source, db_session,
):
    _client, _source_id = client_with_promoted_senaite_origin_source

    from models import LimsAnalysis, LimsSample, LimsSubSampleEvent

    parent = db_session.execute(
        select(LimsSample).where(LimsSample.sample_id == "S-RETEST-004")
    ).scalar_one()
    parent_row = db_session.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
        )
    ).scalars().first()
    assert parent_row is not None
    assert parent_row.review_state == "verified"

    event = db_session.execute(
        select(LimsSubSampleEvent).where(
            LimsSubSampleEvent.event == "parent_analysis_verified",
            LimsSubSampleEvent.lims_sample_pk == parent.id,
        )
    ).scalars().first()
    assert event is not None
    assert event.details == {
        "keyword": "PURITY-HPLC",
        "analysis_id": parent_row.id,
        "service_origin": "senaite",
    }


def test_senaite_shape_rows_carry_service_origin(client_with_mixed_origin_vial_rows):
    client, sub_pk, sample_id = client_with_mixed_origin_vial_rows

    # Vial-tier read: both mk1 and senaite origin values present.
    r = client.get(
        "/api/lims-analyses",
        params={"host_kind": "sub_sample", "host_pk": sub_pk, "as": "senaite_shape"},
    )
    assert r.status_code == 200, r.text
    vial_rows = r.json()
    origins_by_keyword = {row["keyword"]: row["service_origin"] for row in vial_rows}
    assert origins_by_keyword["HM-AS"] == "mk1"
    assert origins_by_keyword["PURITY-HPLC"] == "senaite"

    # Parent-tier native read: mk1-origin row carries the field too.
    r = client.get(
        f"/api/lims-analyses/parent/{sample_id}/native-analyses",
        params={"as": "senaite_shape"},
    )
    assert r.status_code == 200, r.text
    parent_rows = r.json()
    assert len(parent_rows) >= 1
    for row in parent_rows:
        assert row["service_origin"] == "mk1"
