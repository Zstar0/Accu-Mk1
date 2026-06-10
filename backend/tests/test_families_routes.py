"""HTTP-level + integration tests for the family-state route."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import auth
from database import SessionLocal
from main import app
from lims_analyses.service import (
    apply_transition, create_analysis, promote_to_parent,
)
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)


class _FakeUser:
    id = None


app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()

from families.routes import _get_senaite_reader_dep


class _EmptyReader:
    async def list_for_sample(self, sample_id):
        return []


app.dependency_overrides[_get_senaite_reader_dep] = lambda: _EmptyReader()

client = TestClient(app)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def clean_sub(db, analysis_service):
    stmt = (
        select(LimsSubSample)
        .where(~select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id,
            LimsAnalysis.keyword == analysis_service.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        ).exists())
    )
    sub = db.execute(stmt).scalars().first()
    if sub is None:
        pytest.skip("no sub-sample free of keyword")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.execute(delete(LimsAnalysisPromotion).where(
        LimsAnalysisPromotion.parent_analysis_id.in_(
            select(LimsAnalysis.id).where(LimsAnalysis.title.like("TEST:%"))
        )
    ))
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.reason.like("TEST:%")
    ))
    db.execute(delete(LimsAnalysis).where(LimsAnalysis.title.like("TEST:%")))
    db.commit()


def test_get_family_state_404_for_unknown_parent():
    r = client.get("/api/families/THIS-DOES-NOT-EXIST-XYZ/state")
    assert r.status_code == 404


def test_get_family_state_pending_when_only_vial_assigned(db, clean_sub, analysis_service):
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=clean_sub.id,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title=f"TEST: family-state pending {analysis_service.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: family-state pending")
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)

    r = client.get(f"/api/families/{parent.sample_id}/state")
    assert r.status_code == 200
    body = r.json()
    assert body["parent_sample_id"] == parent.sample_id
    assert body["state"] == "pending"


def test_get_family_state_to_be_verified_when_vial_submitted(db, clean_sub, analysis_service):
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=clean_sub.id,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title=f"TEST: family-state tbv {analysis_service.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: family-state tbv")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value="42.0", reason="TEST: family-state tbv")
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)

    r = client.get(f"/api/families/{parent.sample_id}/state")
    assert r.status_code == 200
    assert r.json()["state"] == "to_be_verified"


def test_get_family_state_verified_when_only_analyte_promoted(db, clean_sub, analysis_service):
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=clean_sub.id,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title=f"TEST: family-state verified {analysis_service.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: family-state verified")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value="42.0", reason="TEST: family-state verified")
    parent_row, _ = promote_to_parent(
        db, keyword=analysis_service.keyword, result_value="42.0", result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}],
        reason="TEST: family-state verified",
    )
    parent_row.title = "TEST: parent " + parent_row.title
    db.commit()
    parent = db.get(LimsSample, parent_row.lims_sample_pk)

    r = client.get(f"/api/families/{parent.sample_id}/state")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "verified"
    keywords = {a["keyword"] for a in body["analytes"]}
    assert analysis_service.keyword in keywords
    matching = next(a for a in body["analytes"] if a["keyword"] == analysis_service.keyword)
    assert matching["parent_state"] == "verified"


def test_get_family_state_breakdown_includes_per_analyte_facts(db, clean_sub, analysis_service):
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=clean_sub.id,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title=f"TEST: family-state breakdown {analysis_service.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: family-state breakdown")
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)

    r = client.get(f"/api/families/{parent.sample_id}/state")
    assert r.status_code == 200
    body = r.json()
    matching = next((a for a in body["analytes"] if a["keyword"] == analysis_service.keyword), None)
    assert matching is not None
    assert matching["parent_state"] is None
    assert "assigned" in matching["vial_states"]
    assert isinstance(matching["is_hplc"], bool)
