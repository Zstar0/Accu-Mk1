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


# ─── Wave B: profile + SLA routes (incl. side-door mints) ───────────────────
# Reuses route_client (StaticPool SQLite, MagicMock(id=7) actor) from Wave A above.

from models import AnalysisProfile, VialRole, SlaTier


def test_create_profile_writes_create_log_row(route_client):
    resp = route_client.post("/analysis-profiles", json={
        "key": "wb_profile_1", "name": "WB Profile 1", "is_addon": True,
    })
    assert resp.status_code == 201, resp.text
    profile_id = resp.json()["id"]

    db = route_client._test_session
    rows = db.query(CatalogChangeLog).filter_by(entity_type="profile", entity_pk=profile_id).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "create"
    assert row.user_id == 7
    assert row.details["changed"]["key"] == {"before": None, "after": "wb_profile_1"}
    assert row.details["changed"]["name"] == {"before": None, "after": "WB Profile 1"}


def test_create_profile_with_role_mint_writes_two_rows(route_client):
    """POST with an unknown fulfillment_role mints a vial_role — that's a
    second, separate catalog_change_log row (entity_type='vial_role')
    alongside the profile's own create row."""
    resp = route_client.post("/analysis-profiles", json={
        "key": "wb_mint_profile", "name": "WB Mint Profile", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "wbmint",
    })
    assert resp.status_code == 201, resp.text
    profile_id = resp.json()["id"]

    db = route_client._test_session
    profile_rows = db.query(CatalogChangeLog).filter_by(
        entity_type="profile", entity_pk=profile_id
    ).all()
    assert len(profile_rows) == 1
    assert profile_rows[0].action == "create"

    role = db.query(VialRole).filter_by(code="wbmint").one()
    role_rows = db.query(CatalogChangeLog).filter_by(
        entity_type="vial_role", entity_pk=role.id
    ).all()
    assert len(role_rows) == 1
    assert role_rows[0].action == "create"
    assert role_rows[0].details["changed"]["code"] == {"before": None, "after": "wbmint"}
    assert role_rows[0].user_id == 7


def test_patch_profile_changed_field_writes_update_log_row(route_client):
    db = route_client._test_session
    p = AnalysisProfile(key="wb_patch_1", name="WB Patch 1", is_addon=True)
    db.add(p)
    db.commit()

    resp = route_client.patch(f"/analysis-profiles/{p.id}", json={"name": "WB Patch 1 Renamed"})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="profile", entity_pk=p.id).all()
    assert len(rows) == 1
    assert rows[0].action == "update"
    assert rows[0].details == {
        "changed": {"name": {"before": "WB Patch 1", "after": "WB Patch 1 Renamed"}}
    }
    assert rows[0].user_id == 7


def test_patch_profile_resubmit_identical_writes_no_row(route_client):
    db = route_client._test_session
    p = AnalysisProfile(key="wb_patch_noop", name="WB Patch Noop", is_addon=True, vials_required=1)
    db.add(p)
    db.commit()

    resp = route_client.patch(f"/analysis-profiles/{p.id}", json={
        "name": "WB Patch Noop", "vials_required": 1,
    })
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="profile", entity_pk=p.id).all()
    assert rows == []


def test_patch_profile_with_role_mint_writes_two_rows(route_client):
    """PATCH's mint block uses effective_name (fields['name'] if present else
    p.name) — distinct code path from POST's data.name, worth its own test."""
    db = route_client._test_session
    p = AnalysisProfile(key="wb_patch_mint", name="WB Patch Mint", is_addon=True)
    db.add(p)
    db.commit()
    profile_id = p.id

    resp = route_client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "wbpmint", "fulfillment_dim": "role",
    })
    assert resp.status_code == 200, resp.text

    profile_rows = db.query(CatalogChangeLog).filter_by(
        entity_type="profile", entity_pk=profile_id
    ).all()
    assert len(profile_rows) == 1
    assert profile_rows[0].action == "update"

    role = db.query(VialRole).filter_by(code="wbpmint").one()
    role_rows = db.query(CatalogChangeLog).filter_by(
        entity_type="vial_role", entity_pk=role.id
    ).all()
    assert len(role_rows) == 1
    assert role_rows[0].action == "create"
    assert role_rows[0].details["changed"]["label"] == {"before": None, "after": "WB Patch Mint"}


def test_delete_profile_writes_delete_log_row(route_client):
    db = route_client._test_session
    p = AnalysisProfile(key="wb_delete_1", name="WB Delete 1", is_addon=True)
    db.add(p)
    db.commit()
    profile_id = p.id

    resp = route_client.delete(f"/analysis-profiles/{profile_id}")
    assert resp.status_code == 204, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="profile", entity_pk=profile_id).all()
    assert len(rows) == 1
    assert rows[0].action == "delete"
    assert rows[0].details["changed"]["key"] == {"before": "wb_delete_1", "after": None}
    assert rows[0].user_id == 7


def test_members_put_identical_set_writes_no_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="WB Member Svc", keyword="WB-MEMBER-SVC", origin="mk1")
    p = AnalysisProfile(key="wb_members_noop", name="WB Members Noop", is_addon=True)
    db.add_all([svc, p])
    db.commit()

    route_client.put(f"/analysis-profiles/{p.id}/members",
                      json={"analysis_service_ids": [svc.id]})
    resp = route_client.put(f"/analysis-profiles/{p.id}/members",
                             json={"analysis_service_ids": [svc.id]})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(
        entity_type="profile_members", entity_pk=p.id
    ).all()
    assert len(rows) == 1  # only the first PUT ([] -> [svc.id]) is a real change


def test_members_put_reorder_writes_row(route_client):
    db = route_client._test_session
    svc_a = AnalysisService(title="WB Reorder A", keyword="WB-REORDER-A", origin="mk1")
    svc_b = AnalysisService(title="WB Reorder B", keyword="WB-REORDER-B", origin="mk1")
    p = AnalysisProfile(key="wb_members_reorder", name="WB Members Reorder", is_addon=True)
    db.add_all([svc_a, svc_b, p])
    db.commit()

    route_client.put(f"/analysis-profiles/{p.id}/members",
                      json={"analysis_service_ids": [svc_a.id, svc_b.id]})
    resp = route_client.put(f"/analysis-profiles/{p.id}/members",
                             json={"analysis_service_ids": [svc_b.id, svc_a.id]})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(
        entity_type="profile_members", entity_pk=p.id
    ).order_by(CatalogChangeLog.id).all()
    assert len(rows) == 2  # initial set + the reorder
    reorder_row = rows[-1]
    assert reorder_row.details == {"changed": {"member_ids": {
        "before": [svc_a.id, svc_b.id], "after": [svc_b.id, svc_a.id],
    }}}


def test_members_put_department_backfill_writes_vial_role_update_row(route_client):
    db = route_client._test_session
    dept_resp = route_client.post("/departments", json={"name": "WB Backfill Dept"})
    dept_id = dept_resp.json()["id"]
    svc = AnalysisService(title="WB Backfill Svc", keyword="WB-BACKFILL-SVC",
                           origin="mk1", department_id=dept_id)
    db.add(svc)
    db.commit()

    profile_resp = route_client.post("/analysis-profiles", json={
        "key": "wb_backfill_profile", "name": "WB Backfill Profile", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "wbbfrl", "vials_required": 1,
    })
    assert profile_resp.status_code == 201, profile_resp.text
    profile_id = profile_resp.json()["id"]
    role = db.query(VialRole).filter_by(code="wbbfrl").one()
    assert role.department_id is None

    resp = route_client.put(f"/analysis-profiles/{profile_id}/members",
                             json={"analysis_service_ids": [svc.id]})
    assert resp.status_code == 200, resp.text

    db.refresh(role)
    assert role.department_id == dept_id

    rows = db.query(CatalogChangeLog).filter_by(
        entity_type="vial_role", entity_pk=role.id
    ).order_by(CatalogChangeLog.id).all()
    assert len(rows) == 2  # 1: mint (create), 2: backfill (update)
    backfill_row = rows[-1]
    assert backfill_row.action == "update"
    assert backfill_row.details == {
        "changed": {"department_id": {"before": None, "after": dept_id}}
    }
    assert backfill_row.user_id == 7


def test_ride_hosts_put_writes_row_then_noop_writes_none(route_client):
    db = route_client._test_session
    p = AnalysisProfile(key="wb_ride_profile", name="WB Ride Profile", is_addon=True,
                         fulfillment_dim="role", fulfillment_role="hm")
    rider_role = VialRole(code="wbrider", label="WB Rider", boxable=False,
                           variance_eligible=False, sort_order=1, frozen=False, is_system=False)
    db.add_all([p, rider_role])
    db.commit()

    resp = route_client.put(f"/analysis-profiles/{p.id}/ride-hosts",
                             json={"host_role_codes": ["wbrider"]})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="ride_hosts", entity_pk=p.id).all()
    assert len(rows) == 1
    assert rows[0].action == "update"
    assert rows[0].details == {
        "changed": {"host_role_codes": {"before": [], "after": ["wbrider"]}}
    }

    resp2 = route_client.put(f"/analysis-profiles/{p.id}/ride-hosts",
                              json={"host_role_codes": ["wbrider"]})
    assert resp2.status_code == 200, resp2.text
    rows2 = db.query(CatalogChangeLog).filter_by(entity_type="ride_hosts", entity_pk=p.id).all()
    assert len(rows2) == 1  # identical resubmit writes no new row


def test_create_sla_tier_writes_create_log_row(route_client):
    resp = route_client.post("/sla-tiers", json={
        "name": "WB Tier 1", "target_minutes": 1440,
    })
    assert resp.status_code == 201, resp.text
    tier_id = resp.json()["id"]

    db = route_client._test_session
    rows = db.query(CatalogChangeLog).filter_by(entity_type="sla_tier", entity_pk=tier_id).all()
    assert len(rows) == 1
    assert rows[0].action == "create"
    assert rows[0].details["changed"]["name"] == {"before": None, "after": "WB Tier 1"}
    assert rows[0].user_id == 7


def test_update_sla_tier_writes_update_log_row(route_client):
    db = route_client._test_session
    tier = SlaTier(name="WB Tier 2", target_minutes=2880, is_default=False)
    db.add(tier)
    db.commit()

    resp = route_client.put(f"/sla-tiers/{tier.id}", json={"target_minutes": 4320})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="sla_tier", entity_pk=tier.id).all()
    assert len(rows) == 1
    assert rows[0].action == "update"
    assert rows[0].details == {"changed": {"target_minutes": {"before": 2880, "after": 4320}}}


def test_delete_sla_tier_writes_delete_log_row(route_client):
    db = route_client._test_session
    tier = SlaTier(name="WB Tier 3", target_minutes=1000, is_default=False)
    db.add(tier)
    db.commit()
    tier_id = tier.id

    resp = route_client.delete(f"/sla-tiers/{tier_id}")
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="sla_tier", entity_pk=tier_id).all()
    assert len(rows) == 1
    assert rows[0].action == "delete"
    assert rows[0].details["changed"]["name"] == {"before": "WB Tier 3", "after": None}


def test_sla_priority_tier_upsert_create_then_update_actions(route_client):
    db = route_client._test_session
    tier_a = SlaTier(name="WB Prio Tier A", target_minutes=1000, is_default=False)
    tier_b = SlaTier(name="WB Prio Tier B", target_minutes=2000, is_default=False)
    db.add_all([tier_a, tier_b])
    db.commit()

    first = route_client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tier_a.id})
    assert first.status_code == 200, first.text
    row_id = first.json()["id"]

    rows = db.query(CatalogChangeLog).filter_by(
        entity_type="sla_priority_tier", entity_pk=row_id
    ).all()
    assert len(rows) == 1
    assert rows[0].action == "create"
    assert rows[0].details["changed"]["sla_tier_id"] == {"before": None, "after": tier_a.id}

    second = route_client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tier_b.id})
    assert second.status_code == 200, second.text

    rows2 = db.query(CatalogChangeLog).filter_by(
        entity_type="sla_priority_tier", entity_pk=row_id
    ).order_by(CatalogChangeLog.id).all()
    assert len(rows2) == 2
    assert rows2[-1].action == "update"
    assert rows2[-1].details == {
        "changed": {"sla_tier_id": {"before": tier_a.id, "after": tier_b.id}}
    }


def test_delete_sla_priority_tier_writes_delete_log_row(route_client):
    db = route_client._test_session
    tier = SlaTier(name="WB Prio Tier C", target_minutes=1500, is_default=False)
    db.add(tier)
    db.commit()

    put_resp = route_client.put("/sla-priority-tiers/high", json={"sla_tier_id": tier.id})
    assert put_resp.status_code == 200, put_resp.text
    row_id = put_resp.json()["id"]

    del_resp = route_client.delete("/sla-priority-tiers/high")
    assert del_resp.status_code == 200, del_resp.text

    rows = db.query(CatalogChangeLog).filter_by(
        entity_type="sla_priority_tier", entity_pk=row_id
    ).order_by(CatalogChangeLog.id).all()
    assert len(rows) == 2
    assert rows[-1].action == "delete"
    assert rows[-1].details["changed"]["sla_tier_id"] == {"before": tier.id, "after": None}


# ─── Wave C: vial-roles / departments / service-groups / bench-stations ─────
# Reuses route_client (StaticPool SQLite, MagicMock(id=7) actor) from Wave A above.

from models import ServiceGroup, Department, BenchStation


def test_create_department_writes_create_log_row(route_client):
    resp = route_client.post("/departments", json={"name": "WC Dept 1"})
    assert resp.status_code == 201, resp.text
    dept_id = resp.json()["id"]

    db = route_client._test_session
    rows = db.query(CatalogChangeLog).filter_by(entity_type="department", entity_pk=dept_id).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "create"
    assert row.user_id == 7
    assert row.details["changed"]["name"] == {"before": None, "after": "WC Dept 1"}


def test_patch_department_changed_field_writes_update_log_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC Dept 2", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()

    resp = route_client.patch(f"/departments/{dept.id}", json={"color": "red"})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="department", entity_pk=dept.id).all()
    assert len(rows) == 1
    assert rows[0].action == "update"
    assert rows[0].details == {"changed": {"color": {"before": "blue", "after": "red"}}}
    assert rows[0].user_id == 7


def test_patch_department_resubmit_identical_writes_no_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC Dept 3", sort_order=1, color="green", is_system=False)
    db.add(dept)
    db.commit()

    resp = route_client.patch(f"/departments/{dept.id}", json={"sort_order": 1, "color": "green"})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="department", entity_pk=dept.id).all()
    assert rows == []


def test_delete_department_writes_delete_log_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC Dept 4", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()
    dept_id = dept.id

    resp = route_client.delete(f"/departments/{dept_id}")
    assert resp.status_code == 204, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="department", entity_pk=dept_id).all()
    assert len(rows) == 1
    assert rows[0].action == "delete"
    assert rows[0].details["changed"]["name"] == {"before": "WC Dept 4", "after": None}
    assert rows[0].user_id == 7


def test_create_vial_role_writes_create_log_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC VR Dept", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()

    resp = route_client.post("/vial-roles", json={
        "code": "wc1", "label": "WC Role 1", "department_id": dept.id,
    })
    assert resp.status_code == 201, resp.text
    role_id = resp.json()["id"]

    rows = db.query(CatalogChangeLog).filter_by(entity_type="vial_role", entity_pk=role_id).all()
    assert len(rows) == 1
    assert rows[0].action == "create"
    assert rows[0].user_id == 7
    assert rows[0].details["changed"]["code"] == {"before": None, "after": "wc1"}


def test_patch_vial_role_changed_field_writes_update_log_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC VR Dept 2", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()
    role = VialRole(code="wc2", label="Old Label", department_id=dept.id, boxable=False,
                     variance_eligible=False, sort_order=0, frozen=False, is_system=False)
    db.add(role)
    db.commit()

    resp = route_client.patch(f"/vial-roles/{role.id}", json={"label": "New Label"})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="vial_role", entity_pk=role.id).all()
    assert len(rows) == 1
    assert rows[0].action == "update"
    assert rows[0].details == {"changed": {"label": {"before": "Old Label", "after": "New Label"}}}


def test_patch_vial_role_resubmit_identical_writes_no_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC VR Dept 3", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()
    role = VialRole(code="wc3", label="Same Label", department_id=dept.id, boxable=False,
                     variance_eligible=False, sort_order=0, frozen=False, is_system=False)
    db.add(role)
    db.commit()

    resp = route_client.patch(f"/vial-roles/{role.id}", json={"label": "Same Label"})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="vial_role", entity_pk=role.id).all()
    assert rows == []


def test_delete_vial_role_writes_delete_log_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC VR Dept 4", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()
    role = VialRole(code="wc4", label="Deletable", department_id=dept.id, boxable=False,
                     variance_eligible=False, sort_order=0, frozen=False, is_system=False)
    db.add(role)
    db.commit()
    role_id = role.id

    resp = route_client.delete(f"/vial-roles/{role_id}")
    assert resp.status_code == 204, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="vial_role", entity_pk=role_id).all()
    assert len(rows) == 1
    assert rows[0].action == "delete"
    assert rows[0].details["changed"]["code"] == {"before": "wc4", "after": None}


def test_create_service_group_writes_create_log_row(route_client):
    """S2×S4 supersession (arc-integration ruling 2026-08-14): S2 retires
    POST /service-groups to HTTP 410 ("service groups are legacy;
    departments own routing now"). A route that no longer creates anything
    has nothing to change-log, so S4's instrumentation claim only holds
    while the route is live. Tolerant on both trees: standalone S4 asserts
    the 201 + log row; with S2 merged it asserts the 410 and that NO
    change-log row was written. NEVER restore the create body to satisfy
    the 201 leg.
    """
    resp = route_client.post("/service-groups", json={"name": "WC Group 1"})
    db = route_client._test_session

    if resp.status_code == 410:
        # S2 merged: the retired route must neither create nor log.
        assert "legacy" in resp.json()["detail"]
        rows = db.query(CatalogChangeLog).filter_by(entity_type="service_group").all()
        assert rows == []
        return

    assert resp.status_code == 201, resp.text
    group_id = resp.json()["id"]

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service_group", entity_pk=group_id).all()
    assert len(rows) == 1
    assert rows[0].action == "create"
    assert rows[0].user_id == 7
    assert rows[0].details["changed"]["name"] == {"before": None, "after": "WC Group 1"}


def test_put_service_group_changed_field_writes_update_log_row(route_client):
    db = route_client._test_session
    group = ServiceGroup(name="WC Group 2", color="blue", sort_order=0, is_default=False)
    db.add(group)
    db.commit()

    resp = route_client.put(f"/service-groups/{group.id}", json={"color": "red"})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service_group", entity_pk=group.id).all()
    assert len(rows) == 1
    assert rows[0].action == "update"
    assert rows[0].details == {"changed": {"color": {"before": "blue", "after": "red"}}}


def test_put_service_group_resubmit_identical_writes_no_row(route_client):
    db = route_client._test_session
    group = ServiceGroup(name="WC Group 3", color="green", sort_order=2, is_default=False)
    db.add(group)
    db.commit()

    resp = route_client.put(f"/service-groups/{group.id}", json={"color": "green", "sort_order": 2})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service_group", entity_pk=group.id).all()
    assert rows == []


def test_delete_service_group_writes_delete_log_row(route_client):
    db = route_client._test_session
    group = ServiceGroup(name="WC Group 4", color="blue", sort_order=0, is_default=False)
    db.add(group)
    db.commit()
    group_id = group.id

    resp = route_client.delete(f"/service-groups/{group_id}")
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="service_group", entity_pk=group_id).all()
    assert len(rows) == 1
    assert rows[0].action == "delete"
    assert rows[0].details["changed"]["name"] == {"before": "WC Group 4", "after": None}


def test_service_group_members_put_before_capture_writes_row(route_client):
    db = route_client._test_session
    svc_a = AnalysisService(title="WC Member A", keyword="WC-MEMBER-A", origin="mk1")
    svc_b = AnalysisService(title="WC Member B", keyword="WC-MEMBER-B", origin="mk1")
    group = ServiceGroup(name="WC Group Members", color="blue", sort_order=0, is_default=False)
    db.add_all([svc_a, svc_b, group])
    db.commit()

    resp1 = route_client.put(f"/service-groups/{group.id}/members",
                              json={"analysis_service_ids": [svc_a.id]})
    assert resp1.status_code == 200, resp1.text
    resp2 = route_client.put(f"/service-groups/{group.id}/members",
                              json={"analysis_service_ids": [svc_a.id, svc_b.id]})
    assert resp2.status_code == 200, resp2.text

    rows = db.query(CatalogChangeLog).filter_by(
        entity_type="service_group_members", entity_pk=group.id
    ).order_by(CatalogChangeLog.id).all()
    assert len(rows) == 2  # empty->[a], [a]->[a,b]
    second = rows[-1]
    assert second.action == "update"
    assert second.details == {"changed": {"member_ids": {
        "before": [svc_a.id], "after": [svc_a.id, svc_b.id],
    }}}


def test_service_group_members_put_identical_set_writes_no_row(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="WC Member C", keyword="WC-MEMBER-C", origin="mk1")
    group = ServiceGroup(name="WC Group Members Noop", color="blue", sort_order=0, is_default=False)
    db.add_all([svc, group])
    db.commit()

    route_client.put(f"/service-groups/{group.id}/members", json={"analysis_service_ids": [svc.id]})
    resp = route_client.put(f"/service-groups/{group.id}/members",
                             json={"analysis_service_ids": [svc.id]})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(
        entity_type="service_group_members", entity_pk=group.id
    ).all()
    assert len(rows) == 1  # only the first PUT is a real change


def test_create_bench_station_writes_create_log_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC Bench Dept", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()

    resp = route_client.post("/bench-stations", json={"name": "WC Bench 1", "department_id": dept.id})
    assert resp.status_code == 201, resp.text
    station_id = resp.json()["id"]

    rows = db.query(CatalogChangeLog).filter_by(entity_type="bench_station", entity_pk=station_id).all()
    assert len(rows) == 1
    assert rows[0].action == "create"
    assert rows[0].user_id == 7
    assert rows[0].details["changed"]["name"] == {"before": None, "after": "WC Bench 1"}


def test_patch_bench_station_changed_field_writes_update_log_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC Bench Dept 2", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()
    station = BenchStation(name="WC Bench 2", department_id=dept.id, active=True, sort_order=0)
    db.add(station)
    db.commit()

    resp = route_client.patch(f"/bench-stations/{station.id}", json={"sort_order": 5})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="bench_station", entity_pk=station.id).all()
    assert len(rows) == 1
    assert rows[0].action == "update"
    assert rows[0].details == {"changed": {"sort_order": {"before": 0, "after": 5}}}


def test_patch_bench_station_resubmit_identical_writes_no_row(route_client):
    db = route_client._test_session
    dept = Department(name="WC Bench Dept 3", sort_order=0, color="blue", is_system=False)
    db.add(dept)
    db.commit()
    station = BenchStation(name="WC Bench 3", department_id=dept.id, active=True, sort_order=3)
    db.add(station)
    db.commit()

    resp = route_client.patch(f"/bench-stations/{station.id}", json={"sort_order": 3})
    assert resp.status_code == 200, resp.text

    rows = db.query(CatalogChangeLog).filter_by(entity_type="bench_station", entity_pk=station.id).all()
    assert rows == []
