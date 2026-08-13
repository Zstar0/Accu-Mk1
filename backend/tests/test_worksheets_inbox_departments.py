"""S2 Task 7: /worksheets/inbox reads DEPARTMENT identity, not service groups.

Hermetic twins of the endpoint cases in tests/test_worksheets_inbox.py. That
sibling file talks to the live subvial stack and logs in with hardcoded
credentials; in this environment that login 401s, so every one of its
client-based cases ERRORs at the fixture — and its module-level `integration`
mark keeps them out of the default suite anyway. The department contract is
load-bearing enough to run on every bare `pytest`, so these cases use the
in-memory-SQLite + dependency-override idiom of tests/test_worksheet_item_scope.py
and drive the endpoint with read-source 'mk1' (no SENAITE round-trip).

Department ids and ServiceGroup ids are seeded from deliberately DISJOINT
ranges (1xx vs 2xx). On the live dev stack they happen to coincide (Analytics
group 1 -> Analytical department 1, Microbiology group 2 -> department 2), which
would let a group-keyed lookup pass a department-keyed assertion by accident.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    ServiceGroup,
    VialRole,
    Worksheet,
    WorksheetItem,
    service_group_members,
)

# Disjoint id ranges — see module docstring.
DEPT_ANALYTICAL = 101
DEPT_MICRO = 102
DEPT_HM = 103
GROUP_ANALYTICS = 201
GROUP_MICRO = 202
GROUP_ENDO = 203

PARENT_UID = "uid-s2-9001"
PARENT_SID = "P-9001"


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    _seed_catalog(session)
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db, monkeypatch):
    """Endpoint with the local session bound and both external DBs forced to
    fail. The inbox wraps the integration-DB lookup (order linkage) and the
    mk1-DB prep lookup in bare `except Exception: pass` — making them raise is
    how a hermetic run gets the documented graceful-degradation path instead of
    whatever the developer's real integration DB happens to hold."""
    import integration_db

    def _boom(*_a, **_kw):
        raise RuntimeError("no external DB in hermetic inbox tests")

    monkeypatch.setattr(integration_db, "get_integration_db", _boom)

    def _override_get_db():
        yield db

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
    try:
        yield TestClient(app)
    finally:
        if prev_db is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = prev_db
        if prev_user is None:
            app.dependency_overrides.pop(get_current_user, None)
        else:
            app.dependency_overrides[get_current_user] = prev_user


def _seed_catalog(db):
    """Three departments with their vial roles (so inbox_lanes yields the three
    legacy lane keys) plus the legacy service groups that bridge to them."""
    db.add_all([
        Department(id=DEPT_ANALYTICAL, name="Analytical", color="blue", sort_order=1),
        Department(id=DEPT_MICRO, name="Microbiology", color="violet", sort_order=2),
        Department(id=DEPT_HM, name="Heavy Metals", color="emerald", sort_order=3),
    ])
    db.add_all([
        VialRole(code="hplc", label="HPLC", department_id=DEPT_ANALYTICAL, sort_order=1),
        VialRole(code="ster", label="Sterility", department_id=DEPT_MICRO, sort_order=2),
        VialRole(code="endo", label="Endotoxin", department_id=DEPT_MICRO, sort_order=3),
        VialRole(code="hm", label="Heavy Metals", department_id=DEPT_HM, sort_order=4),
        VialRole(code="xtra", label="Extra", department_id=None, sort_order=9),
    ])
    db.add_all([
        # is_default=True is the fallback the port retires — seeded so its
        # retirement is actually observable.
        ServiceGroup(id=GROUP_ANALYTICS, name="Analytics", color="sky",
                     department_id=DEPT_ANALYTICAL, is_default=True),
        ServiceGroup(id=GROUP_MICRO, name="Microbiology", color="violet",
                     department_id=DEPT_MICRO, is_default=False),
        # Second group bridging to the SAME department — the many-to-one
        # collapse the claim check has to survive.
        ServiceGroup(id=GROUP_ENDO, name="Endotoxin", color="fuchsia",
                     department_id=DEPT_MICRO, is_default=False),
    ])
    db.commit()


def _service(db, *, keyword, department_id, group_id=None):
    svc = AnalysisService(title=keyword.title(), keyword=keyword,
                          department_id=department_id)
    db.add(svc)
    db.flush()
    if group_id is not None:
        db.execute(service_group_members.insert().values(
            service_group_id=group_id, analysis_service_id=svc.id,
        ))
    return svc


def _parent(db, *, uid=PARENT_UID, sid=PARENT_SID, role="hplc", container_mode=False):
    row = LimsSample(sample_id=sid, external_lims_uid=uid, status="sample_received",
                     assignment_role=role, container_mode=container_mode)
    db.add(row)
    db.flush()
    return row


def _analysis(db, *, service, parent_pk=None, sub_pk=None, state="unassigned"):
    row = LimsAnalysis(
        lims_sample_pk=parent_pk, lims_sub_sample_pk=sub_pk,
        analysis_service_id=service.id, keyword=service.keyword,
        title=service.title, review_state=state, provenance="canonical",
    )
    db.add(row)
    db.flush()
    return row


def _claim(db, *, sample_uid, sample_id, department_id, service_group_id):
    """An OPEN worksheet holding one item — the shape assigned_pairs is built from."""
    ws = Worksheet(title="WS-claim", status="open")
    db.add(ws)
    db.flush()
    db.add(WorksheetItem(worksheet_id=ws.id, sample_uid=sample_uid, sample_id=sample_id,
                         department_id=department_id, service_group_id=service_group_id))
    db.commit()


def _get_inbox(client, **params):
    query = {"source": "mk1", "hide_test_orders": "false", "hide_prepped": "false"}
    query.update(params)
    resp = client.get("/worksheets/inbox", params=query)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def _analyses_of(items, sample_id):
    for it in items:
        if it["sample_id"] == sample_id:
            return {a["keyword"]: a for a in it["analyses"]}
    return {}


# ── The four department contracts ────────────────────────────────────────────


def test_inbox_analysis_carries_department_identity(client, db):
    """A keyword whose service has department Analytical serializes with the
    DEPARTMENT's id/name/color in group_id/group_name/group_color (the
    sanctioned wire re-meaning, sub-spec D4). The service is also in the
    'Analytics' group, whose id/name/color all differ — so this fails if the
    group is still the operand."""
    parent = _parent(db)
    svc = _service(db, keyword="PURITY_A", department_id=DEPT_ANALYTICAL,
                   group_id=GROUP_ANALYTICS)
    _analysis(db, service=svc, parent_pk=parent.id)
    db.commit()

    analyses = _analyses_of(_get_inbox(client, role="hplc"), PARENT_SID)
    assert "PURITY_A" in analyses, "seeded Analytical analysis missing from the hplc lane"
    a = analyses["PURITY_A"]
    assert a["group_id"] == DEPT_ANALYTICAL
    assert a["group_name"] == "Analytical"
    assert a["group_color"] == "blue"


def test_inbox_unresolved_keyword_lands_in_other_bucket(client, db):
    """A keyword whose service has no department gets (0, 'Other', 'gray') —
    fail-visible. The seeded is_default ServiceGroup ('Analytics') must NOT
    absorb it: no Department.is_default analogue exists and none is added."""
    parent = _parent(db)
    svc = _service(db, keyword="ORPHAN_X", department_id=None)
    _analysis(db, service=svc, parent_pk=parent.id)
    db.commit()

    # role omitted == no lane filter, so the Other bucket is reachable at all.
    analyses = _analyses_of(_get_inbox(client), PARENT_SID)
    assert "ORPHAN_X" in analyses
    a = analyses["ORPHAN_X"]
    assert (a["group_id"], a["group_name"], a["group_color"]) == (0, "Other", "gray")


def test_inbox_lane_filter_is_department_keyed(client, db):
    """role=hplc passes an Analytical-department analysis and drops a
    Microbiology-department one — with NEITHER service carrying a
    service_group_members row, so the lane cannot be consulting the group
    bridge."""
    parent = _parent(db)
    an = _service(db, keyword="HPLC_ONLY", department_id=DEPT_ANALYTICAL)
    mi = _service(db, keyword="MICRO_ONLY", department_id=DEPT_MICRO)
    _analysis(db, service=an, parent_pk=parent.id)
    _analysis(db, service=mi, parent_pk=parent.id)
    db.commit()

    analyses = _analyses_of(_get_inbox(client, role="hplc"), PARENT_SID)
    assert "HPLC_ONLY" in analyses, "group-less Analytical service must still pass its own lane"
    assert "MICRO_ONLY" not in analyses, "Microbiology-department analysis leaked into the hplc lane"


def test_inbox_claimed_pair_is_department_keyed(client, db):
    """An open-worksheet item claiming (vial, Microbiology department) hides
    BOTH a Microbiology-group and an Endotoxin-group analysis of that vial —
    the many-to-one group->department collapse is intentional here."""
    parent = _parent(db)
    keep = _service(db, keyword="PURITY_A", department_id=DEPT_ANALYTICAL,
                    group_id=GROUP_ANALYTICS)
    ster = _service(db, keyword="STER_1", department_id=DEPT_MICRO, group_id=GROUP_MICRO)
    endo = _service(db, keyword="ENDO_1", department_id=DEPT_MICRO, group_id=GROUP_ENDO)
    for svc in (keep, ster, endo):
        _analysis(db, service=svc, parent_pk=parent.id)
    db.commit()
    _claim(db, sample_uid=PARENT_UID, sample_id=PARENT_SID,
           department_id=DEPT_MICRO, service_group_id=GROUP_MICRO)

    analyses = _analyses_of(_get_inbox(client), PARENT_SID)
    assert "PURITY_A" in analyses, "unclaimed Analytical analysis must survive"
    assert "STER_1" not in analyses
    assert "ENDO_1" not in analyses, (
        "sibling group bridging to the SAME claimed department must be hidden too"
    )


# ── Cross-branch consistency: the Mk1-native inbox path ──────────────────────


def test_native_vial_claim_uses_the_same_key_space_as_assigned_pairs(client, db):
    """A native (mk1://) vial claimed by an open worksheet must not appear in
    the inbox.

    CURRENTLY RED — S2 Task 7 open ruling. The brief holds the Mk1-native
    emitter at service-group identity while get_worksheets_inbox re-keys
    assigned_pairs/assignment_map to departments, so a claimed native vial
    comes back. Left as a plain failure on purpose: it is a live regression,
    and an xfail would report the suite green over exactly the behavior under
    escalation. Delete nothing here — port the emitter (see task-7-report.md).

    The native branch (_build_native_vial_inbox_items) does not build
    assigned_pairs — get_worksheets_inbox builds it and passes it down, and the
    native rows are matched against it by the group_id
    _fetch_mk1_inbox_analyses_for_sub_sample emits. So the two must be drawn
    from ONE id space; this test pins that, with the claim's department
    (Analytical=101) and its group (Analytics=201) deliberately different
    numbers.
    """
    parent = _parent(db, uid="uid-s2-9002", sid="P-9002")
    svc = _service(db, keyword="PURITY_A", department_id=DEPT_ANALYTICAL,
                   group_id=GROUP_ANALYTICS)
    _analysis(db, service=svc, parent_pk=parent.id)
    sub = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://s2-native-1",
                        sample_id="P-9002-S01", vial_sequence=1, assignment_role="hplc")
    db.add(sub)
    db.flush()
    _analysis(db, service=svc, sub_pk=sub.id)
    db.commit()
    _claim(db, sample_uid="mk1://s2-native-1", sample_id="P-9002-S01",
           department_id=DEPT_ANALYTICAL, service_group_id=GROUP_ANALYTICS)

    sids = {it["sample_id"] for it in _get_inbox(client, role="hplc")}
    assert "P-9002-S01" not in sids, (
        "native vial claimed by an open worksheet is still in the inbox — the "
        "claim key and the native rows' group_id are no longer the same id space"
    )
