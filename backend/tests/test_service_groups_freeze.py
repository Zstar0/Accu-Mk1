"""Service-group admin freeze (S2 Task 3): departments own routing now.

Group ROWS must survive — worksheet history, sla_priority_tiers (CASCADE!),
and the S7 slice depend on them — so admin mutation is frozen rather than the
table being dropped:
- POST /service-groups -> 410 (creation is dead; departments own routing)
- PUT .../{id} with a name change -> 400 (FE keyword maps + the COA gate key
  on the name); non-name fields (color, sla_tier_id, ...) stay editable
- DELETE .../{id} -> 409 while referenced by a worksheet item, an SLA
  priority tier, or a member row; 200 once unreferenced

PUT .../{id}/members is deliberately untouched by this freeze (see task
brief) and has no coverage here.

Fixture mirrors test_analysis_service_routes.py's route_client idiom: an
isolated in-memory sqlite session shared between the TestClient and the
test body via dependency_overrides, so these tests don't touch live PG.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import (
    ServiceGroup,
    Worksheet,
    WorksheetItem,
    SlaTier,
    SlaPriorityTier,
    service_group_members,
    AnalysisService,
)


@pytest.fixture
def db():
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
def client(db):
    def _override_get_db():
        yield db

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user


def _mk_group(db, name):
    g = ServiceGroup(name=name)
    db.add(g)
    db.commit()
    db.refresh(g)
    return g


def _mk_worksheet_item(db, service_group_id):
    ws = Worksheet(title="Freeze Test Worksheet")
    db.add(ws)
    db.commit()
    item = WorksheetItem(
        worksheet_id=ws.id,
        sample_uid="uid-freeze-1",
        sample_id="P-FREEZE-1",
        service_group_id=service_group_id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _mk_sla_tier(db, service_group_id):
    tier = SlaTier(name="Freeze Tier", target_minutes=1440)
    db.add(tier)
    db.commit()
    row = SlaPriorityTier(
        priority="expedited", sla_tier_id=tier.id, service_group_id=service_group_id
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _add_member(db, service_group_id):
    svc = AnalysisService(title="Freeze Member Service")
    db.add(svc)
    db.commit()
    db.execute(
        service_group_members.insert().values(
            service_group_id=service_group_id, analysis_service_id=svc.id
        )
    )
    db.commit()


def test_create_service_group_is_gone(client):
    r = client.post("/service-groups", json={"name": "NewGroup"})
    assert r.status_code == 410
    assert "legacy" in r.json()["detail"].lower()


def test_rename_service_group_blocked(client, db):
    g = _mk_group(db, "FreezeRename")          # helper: insert a bare ServiceGroup row
    r = client.put(f"/service-groups/{g.id}", json={"name": "Renamed"})
    assert r.status_code == 400
    # non-name edits still pass (display metadata stays editable)
    r2 = client.put(f"/service-groups/{g.id}", json={"color": "purple"})
    assert r2.status_code == 200


def test_delete_blocked_while_worksheet_item_references(client, db):
    g = _mk_group(db, "FreezeDelItem")
    _mk_worksheet_item(db, service_group_id=g.id)   # helper: Worksheet + WorksheetItem
    r = client.delete(f"/service-groups/{g.id}")
    assert r.status_code == 409


def test_delete_blocked_while_sla_tier_references(client, db):
    g = _mk_group(db, "FreezeDelSla")
    _mk_sla_tier(db, service_group_id=g.id)         # helper: SlaPriorityTier row
    r = client.delete(f"/service-groups/{g.id}")
    assert r.status_code == 409


def test_delete_blocked_while_member_references(client, db):
    g = _mk_group(db, "FreezeDelMember")
    _add_member(db, g.id)                            # helper: service_group_members row
    r = client.delete(f"/service-groups/{g.id}")
    assert r.status_code == 409


def test_delete_succeeds_when_unreferenced(client, db):
    g = _mk_group(db, "FreezeDelFree")
    r = client.delete(f"/service-groups/{g.id}")
    assert r.status_code == 200
