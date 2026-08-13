"""GET /worksheets must be a SYNC endpoint (threadpool), never `async def`.

Regression guard for the 2026-07-07 event-loop-blocking finding: the handler
body is ~2.5s of pure synchronous DB work with zero awaits, and the sample
details page fires it twice per load. As `async def` it ran ON uvicorn's
single event loop and froze every other request behind it — a 32ms flag GET
measured 5.3s while two /worksheets calls were in flight (prod probe). The
browser's HTTP/1.1 6-connection cap masked this until HTTP/2 was enabled at
the edge. As plain `def`, FastAPI runs it in the threadpool and concurrent
requests are unaffected.

Pure unit tests: in-memory SQLite + dependency overrides, no live stack.
"""
import asyncio
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main
from main import app
from auth import get_current_user
from database import Base, get_db
from models import Worksheet


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_list_worksheets_is_not_a_coroutine_function():
    """The load-bearing assertion: `async def` here freezes the event loop
    for the handler's full multi-second runtime. Keep it `def` unless the
    body becomes genuinely async end-to-end."""
    assert not asyncio.iscoroutinefunction(main.list_worksheets)


def test_list_worksheets_still_serves(client, db):
    """Sync conversion smoke: route resolves deps, excludes staging, filters."""
    db.add(Worksheet(title="WS Open", status="open"))
    db.add(Worksheet(title="WS Staging", status="staging"))
    db.add(Worksheet(title="WS Done", status="completed"))
    db.commit()

    r = client.get("/worksheets")
    assert r.status_code == 200
    titles = {ws["title"] for ws in r.json()}
    assert titles == {"WS Open", "WS Done"}  # staging excluded

    r = client.get("/worksheets?status=open")
    assert r.status_code == 200
    assert [ws["title"] for ws in r.json()] == ["WS Open"]


# ── department_name fallback for group-less items (fix round, spec-3 Task 3,
# Finding 3) ──────────────────────────────────────────────────────────────
#
# A worksheet item's department_name previously derived ONLY from its
# service_group_id -> ServiceGroup.department_id. Catalog-only roles like hm
# carry no service_group at all (Task 2's seeder assigns hm's AnalysisService
# rows a department_id directly, never a group membership), so every hm item
# serialized with department_name=None — leaving the FE hm badge
# (itemBench/itemRoleBadges, wired correctly on the frontend) structurally
# unreachable. The fix resolves department_name via the item's own cached
# analyses_json keyword -> AnalysisService.department_id -> Department.name
# whenever the group-based lookup yields None; grouped items must be
# byte-identical to before.

def test_worksheet_item_department_name_falls_back_to_service_department(client, db):
    """Group-less service (e.g. hm): department_name resolves via the item's
    own AnalysisService.department_id, not the (absent) service_group_id."""
    import json
    from models import Department, AnalysisService, WorksheetItem

    hm_dept = Department(name="Heavy Metals")
    db.add(hm_dept); db.flush()
    db.add(AnalysisService(title="Lead (Pb)", keyword="HM-PB", department_id=hm_dept.id))
    db.commit()

    ws = Worksheet(title="WS HM", status="open")
    db.add(ws); db.flush()
    db.add(WorksheetItem(
        worksheet_id=ws.id,
        sample_uid="ZZ-HM-01",
        sample_id="ZZ-HM-01",
        service_group_id=None,
        analyses_json=json.dumps([
            {"title": "Lead (Pb)", "keyword": "HM-PB", "peptide_name": None, "method": None},
        ]),
    ))
    db.commit()

    r = client.get("/worksheets")
    assert r.status_code == 200
    ws_out = next(w for w in r.json() if w["title"] == "WS HM")
    assert ws_out["items"][0]["department_name"] == "Heavy Metals"


def test_worksheet_item_department_name_grouped_service_unchanged(client, db):
    """Grouped services resolve via service_group_id -> Department exactly as
    before the group-less fallback was added — must not regress."""
    from models import Department, ServiceGroup, WorksheetItem

    analytical = Department(name="Analytical")
    db.add(analytical); db.flush()
    grp = ServiceGroup(name="Analytics", department_id=analytical.id)
    db.add(grp); db.flush()

    ws = Worksheet(title="WS Grouped", status="open")
    db.add(ws); db.flush()
    db.add(WorksheetItem(
        worksheet_id=ws.id,
        sample_uid="ZZ-GRP-01",
        sample_id="ZZ-GRP-01",
        service_group_id=grp.id,
    ))
    db.commit()

    r = client.get("/worksheets")
    assert r.status_code == 200
    ws_out = next(w for w in r.json() if w["title"] == "WS Grouped")
    assert ws_out["items"][0]["department_name"] == "Analytical"


# ── Task 8: four-state department_name resolution chain ────────────────────
#
# WorksheetItem.department_id (Tasks 1-7) is now the primary signal, but old
# rows and legacy call sites still only carry service_group_id or bare
# analyses_json. The serializer must resolve department_name in strict order:
#   1. item.department_id set -> its Department.name (one batched id->name map)
#   2. NULL dept + live service_group_id -> group's department (bridge, unchanged)
#   3. NULL both, analyses_json first-keyword resolves -> existing fallback
#   4. truly unresolvable -> literal "Legacy" (was None)
# Item dicts also additively gain "department_id".

def test_worksheet_item_department_name_state1_own_department_id_wins(client, db):
    """State 1: item.department_id set resolves via the batched id->name map
    and takes priority even when the item ALSO carries a service_group_id
    pointing at a different department."""
    from models import Department, ServiceGroup, WorksheetItem

    micro = Department(name="Microbiology")
    analytical = Department(name="Analytical")
    db.add_all([micro, analytical]); db.flush()
    grp = ServiceGroup(name="Analytics Group", department_id=analytical.id)
    db.add(grp); db.flush()

    ws = Worksheet(title="WS DeptId", status="open")
    db.add(ws); db.flush()
    db.add(WorksheetItem(
        worksheet_id=ws.id,
        sample_uid="ZZ-DID-01",
        sample_id="ZZ-DID-01",
        service_group_id=grp.id,
        department_id=micro.id,
    ))
    db.commit()

    r = client.get("/worksheets")
    assert r.status_code == 200
    item = next(w for w in r.json() if w["title"] == "WS DeptId")["items"][0]
    assert item["department_id"] == micro.id
    assert item["department_name"] == "Microbiology"
    # legacy group fields stay frozen regardless of department_id precedence
    assert item["group_name"] == "Analytics Group"


def test_worksheet_item_department_name_state2_service_group_bridge(client, db):
    """State 2: NULL department_id, live service_group_id -> resolves via the
    existing group->department bridge, unchanged."""
    from models import Department, ServiceGroup, WorksheetItem

    sterility = Department(name="Sterility")
    db.add(sterility); db.flush()
    grp = ServiceGroup(name="Sterility Testing", department_id=sterility.id)
    db.add(grp); db.flush()

    ws = Worksheet(title="WS GroupBridge", status="open")
    db.add(ws); db.flush()
    db.add(WorksheetItem(
        worksheet_id=ws.id,
        sample_uid="ZZ-GRB-01",
        sample_id="ZZ-GRB-01",
        service_group_id=grp.id,
        department_id=None,
    ))
    db.commit()

    r = client.get("/worksheets")
    assert r.status_code == 200
    item = next(w for w in r.json() if w["title"] == "WS GroupBridge")["items"][0]
    assert item["department_id"] is None
    assert item["department_name"] == "Sterility"


def test_worksheet_item_department_name_state3_analyses_json_fallback(client, db):
    """State 3: NULL department_id AND no departmented group -> resolves via
    the existing analyses_json first-keyword fallback."""
    import json
    from models import Department, AnalysisService, WorksheetItem

    hm_dept = Department(name="Heavy Metals")
    db.add(hm_dept); db.flush()
    db.add(AnalysisService(title="Arsenic (As)", keyword="HM-AS", department_id=hm_dept.id))
    db.commit()

    ws = Worksheet(title="WS AnalysesFallback", status="open")
    db.add(ws); db.flush()
    db.add(WorksheetItem(
        worksheet_id=ws.id,
        sample_uid="ZZ-AJF-01",
        sample_id="ZZ-AJF-01",
        service_group_id=None,
        department_id=None,
        analyses_json=json.dumps([
            {"title": "Arsenic (As)", "keyword": "HM-AS", "peptide_name": None, "method": None},
        ]),
    ))
    db.commit()

    r = client.get("/worksheets")
    assert r.status_code == 200
    item = next(w for w in r.json() if w["title"] == "WS AnalysesFallback")["items"][0]
    assert item["department_id"] is None
    assert item["department_name"] == "Heavy Metals"


def test_worksheet_item_department_name_state4_unresolvable_renders_legacy(client, db):
    """State 4: nothing resolves (no department_id, no group, no usable
    analyses_json) -> the literal string "Legacy", not None."""
    from models import WorksheetItem

    ws = Worksheet(title="WS Unresolvable", status="open")
    db.add(ws); db.flush()
    db.add(WorksheetItem(
        worksheet_id=ws.id,
        sample_uid="ZZ-UNR-01",
        sample_id="ZZ-UNR-01",
        service_group_id=None,
        department_id=None,
        analyses_json=None,
    ))
    db.commit()

    r = client.get("/worksheets")
    assert r.status_code == 200
    item = next(w for w in r.json() if w["title"] == "WS Unresolvable")["items"][0]
    assert item["department_id"] is None
    assert item["department_name"] == "Legacy"
