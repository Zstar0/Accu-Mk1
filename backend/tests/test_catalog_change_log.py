from decimal import Decimal
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import VialRole, CatalogChangeLog
from catalog.change_log import apply_and_log, log_create, log_delete, log_members, _json_safe


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def _make_role(db, **overrides):
    defaults = dict(
        code="tst", label="Old", boxable=False, variance_eligible=False,
        sort_order=5, frozen=False, is_system=False,
    )
    defaults.update(overrides)
    row = VialRole(**defaults)
    db.add(row)
    db.flush()
    return row


def test_apply_and_log_writes_one_row_for_changed_field(db):
    row = _make_role(db)

    changed = apply_and_log(
        db, row, {"label": "New", "boxable": False},
        entity_type="vial_role", entity_pk=row.id, user_id=7,
    )
    db.flush()

    assert changed == {"label": {"before": "Old", "after": "New"}}
    rows = db.query(CatalogChangeLog).all()
    assert len(rows) == 1
    log_row = rows[0]
    assert log_row.details == {"changed": {"label": {"before": "Old", "after": "New"}}}
    assert log_row.action == "update"
    assert log_row.entity_type == "vial_role"
    assert log_row.entity_pk == row.id
    assert log_row.user_id == 7


def test_apply_and_log_no_row_when_nothing_changes(db):
    row = _make_role(db)

    changed = apply_and_log(
        db, row, {"label": "Old", "boxable": False},
        entity_type="vial_role", entity_pk=row.id, user_id=7,
    )
    db.flush()

    assert changed == {}
    assert db.query(CatalogChangeLog).count() == 0


def test_log_create_snapshots_before_none_per_field(db):
    row = _make_role(db, code="new1", label="Fresh")

    log_create(db, row, ["code", "label"], entity_type="vial_role", entity_pk=row.id, user_id=None)
    db.flush()

    log_row = db.query(CatalogChangeLog).one()
    assert log_row.action == "create"
    assert log_row.entity_type == "vial_role"
    assert log_row.entity_pk == row.id
    assert log_row.user_id is None
    assert log_row.details == {
        "changed": {
            "code": {"before": None, "after": "new1"},
            "label": {"before": None, "after": "Fresh"},
        }
    }


def test_log_delete_snapshots_after_none_per_field(db):
    row = _make_role(db, code="gone", label="Bye")

    log_delete(db, row, ["code", "label"], entity_type="vial_role", entity_pk=row.id, user_id=3)
    db.flush()

    log_row = db.query(CatalogChangeLog).one()
    assert log_row.action == "delete"
    assert log_row.details == {
        "changed": {
            "code": {"before": "gone", "after": None},
            "label": {"before": "Bye", "after": None},
        }
    }


def test_log_members_same_list_writes_no_row(db):
    log_members(
        db, entity_type="department", entity_pk=1, user_id=1,
        field="role_ids", before_ids=[1, 2, 3], after_ids=[1, 2, 3],
    )
    db.flush()

    assert db.query(CatalogChangeLog).count() == 0


def test_log_members_reordered_list_writes_row(db):
    log_members(
        db, entity_type="department", entity_pk=1, user_id=1,
        field="role_ids", before_ids=[1, 2, 3], after_ids=[2, 1, 3],
    )
    db.flush()

    log_row = db.query(CatalogChangeLog).one()
    assert log_row.action == "update"
    assert log_row.entity_type == "department"
    assert log_row.entity_pk == 1
    assert log_row.details == {"changed": {"role_ids": {"before": [1, 2, 3], "after": [2, 1, 3]}}}


def test_json_safe_decimal_becomes_str():
    assert _json_safe(Decimal("1.50")) == "1.50"


def test_json_safe_datetime_becomes_isoformat():
    dt = datetime(2026, 8, 11, 12, 0, 0)
    assert _json_safe(dt) == dt.isoformat()


def test_json_safe_passthrough_for_other_types():
    assert _json_safe("plain") == "plain"
    assert _json_safe(None) is None
    assert _json_safe(42) == 42


# ─── Wave A: analysis-services routes ────────────────────────────────────────
# Fixture mirrors test_analysis_service_routes.py.

from unittest.mock import MagicMock
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db
from models import AnalysisService, Peptide


@pytest.fixture
def route_client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared_session = Session()

    def _override_get_db():
        yield shared_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=7)
    tc = TestClient(app)
    tc._test_session = shared_session
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user
    shared_session.close()


def test_create_analysis_service_writes_create_log_row(route_client):
    resp = route_client.post(
        "/analysis-services", json={"title": "Lead", "keyword": "HM-PB", "unit": "ppm"}
    )
    assert resp.status_code == 201
    svc_id = resp.json()["id"]

    db = route_client._test_session
    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc_id).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "create"
    assert row.user_id == 7
    assert row.details["changed"]["title"] == {"before": None, "after": "Lead"}
    assert row.details["changed"]["keyword"] == {"before": None, "after": "HM-PB"}


def test_patch_changed_field_writes_update_log_row_with_actor(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    db.add(svc)
    db.commit()

    resp = route_client.patch(f"/analysis-services/{svc.id}", json={"title": "Lead 2"})
    assert resp.status_code == 200

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc.id).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "update"
    assert row.user_id == 7
    assert row.details == {"changed": {"title": {"before": "Lead", "after": "Lead 2"}}}


def test_patch_resubmitting_identical_values_writes_no_log_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Lead", keyword="HM-PB", unit="ppm", origin="mk1")
    db.add(svc)
    db.commit()

    resp = route_client.patch(
        f"/analysis-services/{svc.id}",
        json={"title": "Lead", "keyword": "HM-PB", "unit": "ppm"},
    )
    assert resp.status_code == 200

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc.id).all()
    assert rows == []


def test_patch_senaite_origin_override_edit_logs_field_and_local_overrides(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Endo", keyword="ENDO-LAL", origin="senaite", senaite_id="s-1")
    db.add(svc)
    db.commit()

    resp = route_client.patch(
        f"/analysis-services/{svc.id}", json={"title": "Endo (renamed by lab)"}
    )
    assert resp.status_code == 200

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc.id).all()
    assert len(rows) == 1
    changed = rows[0].details["changed"]
    assert changed["title"] == {"before": "Endo", "after": "Endo (renamed by lab)"}
    assert changed["local_overrides"] == {"before": None, "after": ["title"]}


def test_delete_analysis_service_writes_delete_log_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    db.add(svc)
    db.commit()
    svc_id = svc.id

    resp = route_client.delete(f"/analysis-services/{svc_id}")
    assert resp.status_code == 204

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc_id).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "delete"
    assert row.user_id == 7
    assert row.details["changed"]["title"] == {"before": "Lead", "after": None}
    assert row.details["changed"]["keyword"] == {"before": "HM-PB", "after": None}


def test_update_peptide_link_writes_update_log_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="AICAR Purity", keyword="AICAR-PUR", origin="mk1")
    peptide = Peptide(name="AICAR", abbreviation="AICAR")
    db.add_all([svc, peptide])
    db.commit()

    resp = route_client.put(
        f"/analysis-services/{svc.id}/peptide", json={"peptide_id": peptide.id}
    )
    assert resp.status_code == 200

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc.id).all()
    assert len(rows) == 1
    changed = rows[0].details["changed"]
    assert changed["peptide_id"] == {"before": None, "after": peptide.id}
    assert changed["peptide_name"] == {"before": None, "after": "AICAR"}


def test_update_peptide_unlink_same_state_writes_no_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    db.add(svc)
    db.commit()

    resp = route_client.put(f"/analysis-services/{svc.id}/peptide", json={"peptide_id": None})
    assert resp.status_code == 200

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc.id).all()
    assert rows == []


def test_update_result_type_writes_update_log_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Ster", keyword="STER-PCR", origin="mk1")
    db.add(svc)
    db.commit()

    resp = route_client.patch(
        f"/analysis-services/{svc.id}/result-type",
        json={"result_type": "select",
              "result_options": [{"value": "1", "label": "Conforms"}]},
    )
    assert resp.status_code == 200

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc.id).all()
    assert len(rows) == 1
    changed = rows[0].details["changed"]
    assert changed["result_type"] == {"before": None, "after": "select"}
    assert changed["result_options"] == {
        "before": None, "after": [{"value": "1", "label": "Conforms"}],
    }


def test_update_variance_capable_writes_update_log_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PUR", origin="mk1",
                           variance_capable=False)
    db.add(svc)
    db.commit()

    resp = route_client.patch(
        f"/analysis-services/{svc.id}/variance-capable", json={"variance_capable": True}
    )
    assert resp.status_code == 200

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc.id).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.user_id == 7
    assert row.details == {"changed": {"variance_capable": {"before": False, "after": True}}}


def test_update_variance_capable_same_value_writes_no_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PUR", origin="mk1",
                           variance_capable=True)
    db.add(svc)
    db.commit()

    resp = route_client.patch(
        f"/analysis-services/{svc.id}/variance-capable", json={"variance_capable": True}
    )
    assert resp.status_code == 200

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service", entity_pk=svc.id).all()
    assert rows == []
