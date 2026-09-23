"""Native-born parents in /worksheets/inbox (P-5014, 2026-09-23).

A native-born parent has no SENAITE uid. The registry candidate builder used
to emit uid='' for it and the route's step 4c looked parents up by uid only,
so the family anchor was never found and the parent's native vials (which DO
carry mk1:// uids) never reached the inbox: every native sample the lab
received was missing from every lane. The identity of a uid-less parent is
its sample_id, the convention registry_list.py already uses.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main as main_module
from auth import get_current_user
from database import Base, get_db
from main import app
from models import (AnalysisService, Department, LimsAnalysis, LimsSample,
                    LimsSubSample, VialRole)
from sub_samples.registry_inbox import inbox_candidates_from_registry


def _native_family(db, sample_id="P-5014"):
    """Container parent born in Mk1 (no SENAITE uid) with the three ordered
    placeholders at parent tier and one native vial per role, each carrying
    its unassigned analysis. Mirrors the P-5014 shape on prod."""
    db.add_all([Department(id=101, name="Analytical", color="blue"),
                Department(id=102, name="Microbiology", color="green")])
    db.flush()
    db.add_all([
        VialRole(code="hplc", label="HPLC", department_id=101, sort_order=0),
        VialRole(code="endo85", label="Endotoxin", department_id=102, sort_order=12),
        VialRole(code="pcr", label="PCR", department_id=102, sort_order=13),
    ])
    svcs = {}
    for kw, title, dept in (("HPLC-PURITY", "HPLC Purity", 101),
                            ("ENDOTOXIN-USP85LAL", "Endotoxin USP85 LAL", 102),
                            ("STERILITY-PCR", "Rapid Sterility Screening (PCR)", 102)):
        s = AnalysisService(title=title, keyword=kw, department_id=dept)
        db.add(s); db.flush(); svcs[kw] = s
    parent = LimsSample(sample_id=sample_id, external_lims_uid=None,
                        external_lims_system="mk1", status="sample_received",
                        sample_type="x", container_mode=True)
    db.add(parent); db.flush()
    for kw, s in svcs.items():
        db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=s.id,
                            keyword=kw, title=s.title, review_state="unassigned",
                            provenance="ordered"))
    subs = []
    for seq, role, kw in ((1, "hplc", "HPLC-PURITY"),
                          (2, "endo85", "ENDOTOXIN-USP85LAL"),
                          (3, "pcr", "STERILITY-PCR")):
        sub = LimsSubSample(parent_sample_pk=parent.id,
                            external_lims_uid=f"mk1://{sample_id}-{seq:03d}",
                            sample_id=f"{sample_id}-S{seq:02d}", vial_sequence=seq,
                            assignment_role=role, assignment_kind="core")
        db.add(sub); db.flush()
        db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svcs[kw].id,
                            keyword=kw, title=svcs[kw].title, review_state="unassigned"))
        subs.append(sub)
    db.commit()
    return parent, subs


def test_builder_identity_for_uid_less_parent_is_its_sample_id(db_session):
    db_session.add(LimsSample(sample_id="P-5014", external_lims_uid=None,
                              external_lims_system="mk1", status="sample_received",
                              sample_type="x"))
    db_session.flush()
    items, _ = inbox_candidates_from_registry(db_session)
    assert [i["uid"] for i in items if i["id"] == "P-5014"] == ["P-5014"]


def test_builder_keeps_senaite_uid_when_present(db_session):
    db_session.add(LimsSample(sample_id="P-3097", external_lims_uid="abc123",
                              status="sample_received", sample_type="x"))
    db_session.flush()
    items, _ = inbox_candidates_from_registry(db_session)
    assert [i["uid"] for i in items if i["id"] == "P-3097"] == ["abc123"]


@pytest.fixture
def route_db():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def client(route_db, monkeypatch):
    def _override_db():
        yield route_db

    def _no_integration_db():
        raise RuntimeError("integration DB unavailable in unit tests")

    import integration_db
    # Step 1b of the route filters candidates to orders known to the
    # Integration Service DB and degrades gracefully when it is unreachable.
    # A developer box with a reachable IS DB would otherwise filter the
    # fixture sample out and make this test depend on live data.
    monkeypatch.setattr(integration_db, "get_integration_db", _no_integration_db)
    monkeypatch.setattr(main_module, "SENAITE_URL", "")
    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)


def _inbox(client, **params):
    resp = client.get("/worksheets/inbox",
                      params={"source": "mk1", "hide_test_orders": "false", **params})
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def test_route_emits_every_native_vial_of_a_uid_less_parent(route_db, client):
    _native_family(route_db)
    items = _inbox(client)
    by_id = {i["sample_id"]: i for i in items}
    assert {"P-5014-S01", "P-5014-S02", "P-5014-S03"} <= set(by_id)
    assert "P-5014" not in by_id                      # container parent stays suppressed
    for sid, role in (("P-5014-S01", "hplc"), ("P-5014-S02", "endo85"), ("P-5014-S03", "pcr")):
        row = by_id[sid]
        assert row["is_parent"] is False
        assert row["parent_sample_id"] == "P-5014"
        assert row["assignment_role"] == role
        assert row["uid"].startswith("mk1://")
        assert row["analyses"], sid


def test_route_lane_filter_still_scopes_native_vials(route_db, client):
    _native_family(route_db)
    hplc = {i["sample_id"] for i in _inbox(client, role="hplc")}
    micro = {i["sample_id"] for i in _inbox(client, role="microbiology")}
    assert hplc == {"P-5014-S01"}
    assert micro == {"P-5014-S02", "P-5014-S03"}
