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


# ── 2026-08-27 batching fix: GET /worksheets was ~10 queries per worksheet
# plus one method lookup per item (16.9s / 4.2MB on prod with 1,166
# worksheets — worksheet status changes appeared to take a minute in the UI
# because every mutation refetches this endpoint). _serialize_worksheets now
# batches every lookup across ALL worksheets. These tests pin (a) the query
# count is CONSTANT in worksheet count, (b) the by-id route serves the exact
# list shape for the drawer's non-open fallback. ─────────────────────────────

def _fresh_client_with_counter():
    """Own engine + counter (the shared fixtures don't expose the engine)."""
    from sqlalchemy import event

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    counter = {"n": 0}

    @event.listens_for(engine, "before_cursor_execute")
    def _count(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            counter["n"] += 1

    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    return TestClient(app), session, counter


def _seed_rich_worksheet(db, n, analyst_id=None):
    """One worksheet + grouped item + group-less item, distinct per n."""
    import json as _json
    from models import Department, ServiceGroup, AnalysisService, WorksheetItem, service_group_members

    dept = Department(name=f"Dept {n}")
    db.add(dept); db.flush()
    grp = ServiceGroup(name=f"Group {n}", department_id=dept.id)
    db.add(grp); db.flush()
    svc = AnalysisService(title=f"Svc {n}", keyword=f"KW-{n}", department_id=dept.id)
    db.add(svc); db.flush()
    db.execute(service_group_members.insert().values(
        service_group_id=grp.id, analysis_service_id=svc.id))
    ws = Worksheet(title=f"WS {n}", status="open", assigned_analyst_id=analyst_id)
    db.add(ws); db.flush()
    db.add(WorksheetItem(
        worksheet_id=ws.id, sample_uid=f"UID-{n}-A", sample_id=f"P-90{n}0",
        service_group_id=grp.id, assigned_analyst_id=analyst_id,
    ))
    db.add(WorksheetItem(
        worksheet_id=ws.id, sample_uid=f"UID-{n}-B", sample_id=f"P-90{n}1",
        service_group_id=None,
        analyses_json=_json.dumps([{"title": f"Svc {n}", "keyword": f"KW-{n}",
                                    "peptide_name": None, "method": None}]),
    ))
    db.commit()
    return ws


def test_list_worksheets_query_count_constant_in_worksheet_count():
    """The load-bearing anti-N+1 pin: serving 6 worksheets must issue exactly
    as many SELECTs as serving 1. Every lookup is batched across worksheets;
    a reintroduced per-worksheet (or per-item) query fails this immediately."""
    client, db, counter = _fresh_client_with_counter()
    try:
        _seed_rich_worksheet(db, 1)
        counter["n"] = 0
        assert client.get("/worksheets").status_code == 200
        queries_for_one = counter["n"]

        for n in range(2, 7):
            _seed_rich_worksheet(db, n)
        counter["n"] = 0
        r = client.get("/worksheets")
        assert r.status_code == 200
        assert len(r.json()) == 6
        assert counter["n"] == queries_for_one, (
            f"query count grew with worksheet count: {queries_for_one} for 1 "
            f"worksheet vs {counter['n']} for 6 — a per-worksheet/per-item "
            "query crept back into _serialize_worksheets"
        )
    finally:
        db.close()
        app.dependency_overrides.clear()


def test_get_worksheet_by_id_is_not_a_coroutine_function():
    """Same event-loop rule as list_worksheets: pure sync DB body, keep `def`."""
    assert not asyncio.iscoroutinefunction(main.get_worksheet_by_id)


def test_get_worksheet_by_id_matches_list_shape(client, db):
    """The by-id route must serve the EXACT dict the list serves for that
    worksheet — the FE drawer swaps between them interchangeably (open list
    first, by-id fallback for completed/deep-linked worksheets)."""
    from models import User

    user = User(email="tech@accumark.test", hashed_password="x")
    db.add(user); db.flush()
    ws = _seed_rich_worksheet(db, 1, analyst_id=user.id)

    list_entry = next(w for w in client.get("/worksheets").json() if w["id"] == ws.id)
    single = client.get(f"/worksheets/{ws.id}")
    assert single.status_code == 200
    assert single.json() == list_entry
    # spot-check the enrichment actually resolved (not all-None parity)
    assert list_entry["assigned_analyst_email"] == "tech@accumark.test"
    assert list_entry["items"][0]["group_name"] == "Group 1"
    assert list_entry["items"][0]["department_name"] == "Dept 1"


def test_get_worksheet_by_id_404s_on_missing_and_staging(client, db):
    staging = Worksheet(title="WS Staging", status="staging")
    db.add(staging); db.commit()

    assert client.get("/worksheets/999999").status_code == 404
    # staging is invisible in the list; by-id must match that exclusion
    assert client.get(f"/worksheets/{staging.id}").status_code == 404
