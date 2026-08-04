"""GET /api/lims-analyses/parent/{sample_id}/native-analyses (Task 5b).

Read-only "Accu-Mk1 Analyses" card source: the parent Analyses table stays
SENAITE-sourced by design (SampleDetails.tsx:4058-4062); this endpoint is
the separate reader for origin='mk1' parent-tier rows so native results
(e.g. Heavy Metals) show up somewhere on the parent page.

Fixture idiom copied from test_coa_sections_endpoint.py's `client`/`db_session`
(StaticPool in-memory SQLite + get_db override). Unlike that endpoint this one
sits behind the normal user auth dependency (auth.get_current_user), not an
S2S service token — the override is scoped to this file's `client` fixture
(save/restore) rather than a module-level app.dependency_overrides write, so
it can't leak into later-sorted test modules in a full-suite run.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import auth
from main import app
from database import get_db, Base


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


def _mk_service(db, *, keyword, origin="mk1", unit="ppm"):
    from models import AnalysisService
    svc = AnalysisService(title=keyword.title(), keyword=keyword, origin=origin, unit=unit)
    db.add(svc)
    db.flush()
    return svc


def test_404_unknown_sample(client):
    r = client.get("/api/lims-analyses/parent/NOPE/native-analyses")
    assert r.status_code == 404


def test_returns_current_native_row_excludes_shadow_and_superseded(client, db_session):
    """Seeds (a) a native service parent row [current], (b) a SENAITE-origin
    shadow parent row, (c) a superseded native row (retest_of_id set): the
    endpoint returns exactly the one current native row."""
    from models import LimsAnalysis, LimsSample

    parent = LimsSample(sample_id="P-9001")
    db_session.add(parent)
    db_session.flush()

    native_svc = _mk_service(db_session, keyword="HM-PB", origin="mk1")
    senaite_svc = _mk_service(db_session, keyword="STER-PCR", origin="senaite")

    # (a) current native row — must come back.
    current = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=native_svc.id,
        keyword=native_svc.keyword, title=native_svc.title,
        result_value="0.12", result_unit="ppm", review_state="verified",
    )
    db_session.add(current)

    # (b) SENAITE-origin dual-write shadow row — must NOT come back, even
    # though it structurally matches every other filter (parent-tier,
    # retest_of_id NULL). provenance='shadow' is the direct exclusion.
    shadow = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=senaite_svc.id,
        keyword=senaite_svc.keyword, title=senaite_svc.title,
        result_value="Detected", result_unit=None, review_state="senaite_mirror",
        provenance="shadow",
    )
    db_session.add(shadow)
    db_session.flush()

    # (c) superseded native row (retest_of_id set) for a second native
    # service — must NOT come back. Real parent-tier supersession (see
    # promote_to_parent's retest-supersession branch) retracts the OLD row's
    # review_state and inserts an UNRELATED new row — nothing in production
    # ever sets retest_of_id on a parent-tier row. A row that itself carries
    # retest_of_id is the defensive case the WHERE clause pins (mirrors
    # _eligible_parent_row / test_native_sections.py's stale_row), so this is
    # a single isolated row, not an old+new pair — the target row's FK need
    # not resolve to a real id (SQLite does not enforce it here, same as
    # test_native_sections.py's older_row).
    other_svc = _mk_service(db_session, keyword="HM-AS", origin="mk1")
    superseded = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=other_svc.id,
        keyword=other_svc.keyword, title=other_svc.title,
        result_value="0.99", result_unit="ppm", review_state="verified",
        retest_of_id=999999,
    )
    db_session.add(superseded)
    db_session.commit()

    r = client.get(f"/api/lims-analyses/parent/{parent.sample_id}/native-analyses")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [row["keyword"] for row in body] == ["HM-PB"]
    assert body[0]["result_value"] == "0.12"
    assert body[0]["result_unit"] == "ppm"
    assert body[0]["review_state"] == "verified"
    assert body[0]["title"] == native_svc.title


def test_empty_for_parent_with_no_native_rows(client, db_session):
    from models import LimsSample
    parent = LimsSample(sample_id="P-9002")
    db_session.add(parent)
    db_session.commit()
    r = client.get(f"/api/lims-analyses/parent/{parent.sample_id}/native-analyses")
    assert r.status_code == 200
    assert r.json() == []


def test_sub_sample_rows_are_excluded(client, db_session):
    """A native row on a SUB-sample (lims_sub_sample_pk set) must not leak
    into the parent-tier card even though it shares the parent's service."""
    from models import LimsAnalysis, LimsSample, LimsSubSample

    parent = LimsSample(sample_id="P-9003")
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(
        sample_id="P-9003-S01", external_lims_uid="uid-9003-s01",
        parent_sample_pk=parent.id, vial_sequence=1,
    )
    db_session.add(sub)
    db_session.flush()

    svc = _mk_service(db_session, keyword="HM-PB", origin="mk1")
    db_session.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title,
        result_value="0.12", result_unit="ppm", review_state="verified",
    ))
    db_session.commit()

    r = client.get(f"/api/lims-analyses/parent/{parent.sample_id}/native-analyses")
    assert r.status_code == 200
    assert r.json() == []


# ─── Task 2: ?as=senaite_shape projection ────────────────────────────────────


def test_senaite_shape_returns_full_table_fields(client, db_session):
    """?as=senaite_shape projects rows through the shared serializer."""
    from models import LimsAnalysis, LimsSample

    parent = LimsSample(sample_id="P-9101")
    db_session.add(parent)
    db_session.flush()

    svc = _mk_service(db_session, keyword="HM-CD", origin="mk1")
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title,
        result_value="0.05", result_unit="ppm", review_state="verified",
    ))
    db_session.commit()

    r = client.get(f"/api/lims-analyses/parent/{parent.sample_id}/native-analyses?as=senaite_shape")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert rows
    row = rows[0]
    for field in (
        "uid", "keyword", "title", "result", "result_options", "unit",
        "method", "method_uid", "instrument", "instrument_uid", "analyst",
        "review_state", "captured", "retested", "promoted_to_parent_id",
    ):
        assert field in row, f"missing {field}"
    assert row["uid"].startswith("mk1:")


def test_senaite_shape_includes_lineage_current_last(client, db_session):
    """A retracted old root and the active root for the same keyword are BOTH
    returned, active last (groupAnalysesByTitle takes the last row as current)."""
    from models import LimsAnalysis, LimsSample

    KW = "HM-CR"
    parent = LimsSample(sample_id="P-9102")
    db_session.add(parent)
    db_session.flush()

    svc = _mk_service(db_session, keyword=KW, origin="mk1")

    # Old root, retracted (lower id — inserted first).
    old_root = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title,
        result_value="0.20", result_unit="ppm", review_state="retracted",
    )
    db_session.add(old_root)
    db_session.flush()

    # New active root, verified (higher id — inserted second).
    new_root = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title,
        result_value="0.18", result_unit="ppm", review_state="verified",
    )
    db_session.add(new_root)
    db_session.commit()

    r = client.get(f"/api/lims-analyses/parent/{parent.sample_id}/native-analyses?as=senaite_shape")
    assert r.status_code == 200, r.text
    resp = r.json()
    rows = [row for row in resp if row["keyword"] == KW]
    assert [row["review_state"] for row in rows] == ["retracted", "verified"]


def test_senaite_shape_excludes_shadow_and_senaite_origin_and_subsample_rows(client, db_session):
    """Shadow provenance, senaite-origin services, and vial-hosted rows never appear."""
    from models import LimsAnalysis, LimsSample, LimsSubSample

    SHADOW_KW = "HM-HG"
    SENAITE_ORIGIN_KW = "STER-PCR"
    VIAL_HOSTED_KW = "HM-AS"
    CURRENT_KW = "HM-PB"

    parent = LimsSample(sample_id="P-9103")
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(
        sample_id="P-9103-S01", external_lims_uid="uid-9103-s01",
        parent_sample_pk=parent.id, vial_sequence=1,
    )
    db_session.add(sub)
    db_session.flush()

    shadow_svc = _mk_service(db_session, keyword=SHADOW_KW, origin="mk1")
    senaite_svc = _mk_service(db_session, keyword=SENAITE_ORIGIN_KW, origin="senaite")
    vial_svc = _mk_service(db_session, keyword=VIAL_HOSTED_KW, origin="mk1")
    current_svc = _mk_service(db_session, keyword=CURRENT_KW, origin="mk1")

    # Shadow provenance parent-hosted row — must NOT come back.
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=shadow_svc.id,
        keyword=shadow_svc.keyword, title=shadow_svc.title,
        result_value="Detected", result_unit=None, review_state="senaite_mirror",
        provenance="shadow",
    ))

    # SENAITE-origin service, canonical parent-hosted row — must NOT come
    # back (origin != 'mk1').
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=senaite_svc.id,
        keyword=senaite_svc.keyword, title=senaite_svc.title,
        result_value="Negative", result_unit=None, review_state="verified",
    ))

    # Vial-hosted (sub-sample) row with an mk1-origin service — must NOT
    # come back (this endpoint is parent-tier only).
    db_session.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=vial_svc.id,
        keyword=vial_svc.keyword, title=vial_svc.title,
        result_value="0.30", result_unit="ppm", review_state="verified",
    ))

    # Current native parent row — the positive control, must come back.
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=current_svc.id,
        keyword=current_svc.keyword, title=current_svc.title,
        result_value="0.12", result_unit="ppm", review_state="verified",
    ))
    db_session.commit()

    r = client.get(f"/api/lims-analyses/parent/{parent.sample_id}/native-analyses?as=senaite_shape")
    assert r.status_code == 200, r.text
    resp = r.json()
    keywords = {row["keyword"] for row in resp}
    assert SHADOW_KW not in keywords
    assert SENAITE_ORIGIN_KW not in keywords
    assert VIAL_HOSTED_KW not in keywords
    assert CURRENT_KW in keywords


def test_default_shape_unchanged(client, db_session):
    """Back-compat pin: without ?as= the response is still the 6-field rows."""
    from models import LimsAnalysis, LimsSample

    parent = LimsSample(sample_id="P-9104")
    db_session.add(parent)
    db_session.flush()

    svc = _mk_service(db_session, keyword="HM-PB", origin="mk1")
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title,
        result_value="0.12", result_unit="ppm", review_state="verified",
    ))
    db_session.commit()

    r = client.get(f"/api/lims-analyses/parent/{parent.sample_id}/native-analyses")
    assert r.status_code == 200, r.text
    assert set(r.json()[0].keys()) == {
        "keyword", "title", "result_value", "result_unit", "review_state", "updated_at",
    }


def test_senaite_shape_unknown_sample_404(client):
    r = client.get("/api/lims-analyses/parent/NOPE-404/native-analyses?as=senaite_shape")
    assert r.status_code == 404
