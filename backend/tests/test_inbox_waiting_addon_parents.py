"""Open native vials on a 'waiting_for_addon_results' parent reach the inbox.

When a sample's primary COA is published while an add-on line is still open,
the parent moves to waiting_for_addon_results. The mk1 inbox used to load only
'sample_received' parents, so the add-on's open vials never reached any lane
(10 ENDOTOXIN-USP85LAL S02 vials, prod 2026-10-15). Rule: such a parent
contributes its open native vials, never its own row; published parents stay
out; the 200-row received query is untouched.

Hermetic: in-memory SQLite, the integration DB forced to fail (graceful
degradation shows every candidate) and the mk1 prep lookup faked, so no test
here touches a host database.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta
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
from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    VialRole,
    Worksheet,
    WorksheetItem,
)
from sub_samples.registry_inbox import inbox_candidates_from_registry

WAITING = "waiting_for_addon_results"


def _catalog(db):
    db.add_all([Department(id=101, name="Analytical", color="blue"),
                Department(id=102, name="Microbiology", color="green")])
    db.flush()
    db.add_all([
        VialRole(code="hplc", label="HPLC", department_id=101, sort_order=0),
        VialRole(code="endo", label="Endotoxin", department_id=102, sort_order=12),
    ])
    svcs = {}
    for kw, title, dept in (("HPLC-PURITY", "HPLC Purity", 101),
                            ("ENDOTOXIN-USP85LAL", "Endotoxin USP85 LAL", 102)):
        s = AnalysisService(title=title, keyword=kw, department_id=dept)
        db.add(s)
        db.flush()
        svcs[kw] = s
    db.commit()
    return svcs


def _family(db, svcs, sample_id, *, status, hplc_state="promoted",
            endo_state="unassigned", container_mode=False, created=None):
    """A parent with an HPLC vial (S01) and an endo vial (S02), each with its
    live analysis. Defaults: the P-5309 shape, HPLC done and endo open."""
    parent = LimsSample(sample_id=sample_id, external_lims_uid=None,
                        external_lims_system="mk1", status=status,
                        sample_type="x", container_mode=container_mode,
                        assignment_role="hplc", client_order_number="WP-7000",
                        date_created=created or datetime(2026, 10, 1, 12))
    db.add(parent)
    db.flush()
    # The parent's own canonical row: a non-container received parent emits
    # its own card from it, so the suppression for waiting parents is real.
    db.add(LimsAnalysis(lims_sample_pk=parent.id,
                        analysis_service_id=svcs["HPLC-PURITY"].id,
                        keyword="HPLC-PURITY", title="HPLC Purity",
                        review_state="unassigned", provenance="canonical"))
    subs = []
    for seq, role, kw, state in ((1, "hplc", "HPLC-PURITY", hplc_state),
                                 (2, "endo", "ENDOTOXIN-USP85LAL", endo_state)):
        sub = LimsSubSample(parent_sample_pk=parent.id,
                            external_lims_uid=f"mk1://{sample_id}-{seq:03d}",
                            sample_id=f"{sample_id}-S{seq:02d}", vial_sequence=seq,
                            assignment_role=role)
        db.add(sub)
        db.flush()
        db.add(LimsAnalysis(lims_sub_sample_pk=sub.id,
                            analysis_service_id=svcs[kw].id, keyword=kw,
                            title=svcs[kw].title, review_state=state))
        subs.append(sub)
    db.commit()
    return parent, subs


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def svcs(db):
    return _catalog(db)


@pytest.fixture
def preps(monkeypatch):
    """Fake sample_preps: tests fill `senaite_ids` / `sub_pks`."""
    import mk1_db

    state = {"senaite_ids": set(), "sub_pks": set()}

    class _Cursor:
        def __init__(self):
            self._out = [[(s,) for s in state["senaite_ids"]],
                         [(p,) for p in state["sub_pks"]]]

        def execute(self, _sql):
            pass

        def fetchall(self):
            return self._out.pop(0)

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    class _Conn:
        def cursor(self):
            return _Cursor()

    @contextmanager
    def _get_mk1_db():
        yield _Conn()

    monkeypatch.setattr(mk1_db, "ensure_sample_preps_table", lambda: None)
    monkeypatch.setattr(mk1_db, "get_mk1_db", _get_mk1_db)
    return state


@pytest.fixture
def client(db, preps, monkeypatch):
    import integration_db

    def _boom(*_a, **_kw):
        raise RuntimeError("no integration DB in hermetic inbox tests")

    monkeypatch.setattr(integration_db, "get_integration_db", _boom)
    monkeypatch.setattr(main_module, "SENAITE_URL", "")

    def _override_db():
        yield db

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
    return {i["sample_id"]: i for i in resp.json()["items"]}


def test_waiting_parent_open_endo_vial_in_microbiology_lane(db, svcs, client):
    _family(db, svcs, "P-5309", status=WAITING)
    micro = _inbox(client, role="microbiology")
    assert set(micro) == {"P-5309-S02"}
    row = micro["P-5309-S02"]
    assert row["is_parent"] is False
    assert row["parent_sample_id"] == "P-5309"
    assert row["uid"] == "mk1://P-5309-002"
    assert row["client_order_number"] == "WP-7000"
    assert [a["keyword"] for a in row["analyses"]] == ["ENDOTOXIN-USP85LAL"]


def test_waiting_parent_own_card_never_emitted(db, svcs, client):
    # Non-container on purpose: a received non-container parent emits its own
    # card (see the received test below), so absence here is the suppression.
    _family(db, svcs, "P-5309", status=WAITING, container_mode=False)
    for lane in (None, "hplc", "microbiology"):
        rows = _inbox(client, **({"role": lane} if lane else {}))
        assert "P-5309" not in rows, lane
    # The promoted HPLC vial stays out too.
    assert "P-5309-S01" not in _inbox(client)


def test_waiting_parent_card_suppressed_even_with_parent_analyses(
        db, svcs, client, monkeypatch):
    """The builder hands waiting parents no parent analyses today, which alone
    would hide the card. The endpoint suppresses it explicitly, so a later
    builder change that loads them cannot bring the card back."""
    import sub_samples.registry_inbox as reg

    real = reg.inbox_candidates_from_registry

    def _with_parent_analyses(session, **kw):
        items, analyses = real(session, **kw)
        for it in items:
            if it["review_state"] == WAITING:
                analyses[it["id"]] = [{"uid": "x", "keyword": "HPLC-PURITY",
                                       "title": "HPLC Purity",
                                       "review_state": "unassigned"}]
        return items, analyses

    monkeypatch.setattr(reg, "inbox_candidates_from_registry", _with_parent_analyses)
    _family(db, svcs, "P-5309", status=WAITING, container_mode=False)
    rows = _inbox(client)
    assert "P-5309" not in rows
    assert "P-5309-S02" in rows


@pytest.mark.parametrize("endo_state", ["assigned", "promoted", "verified"])
def test_waiting_parent_with_no_open_vial_contributes_nothing(
        db, svcs, client, endo_state):
    _parent, (_s01, s02) = _family(db, svcs, "P-5322", status=WAITING,
                                   endo_state=endo_state)
    if endo_state == "assigned":
        # Assigned = on an open worksheet, as worksheet_analyst does it.
        ws = Worksheet(title="WS-1569", status="open")
        db.add(ws)
        db.flush()
        db.add(WorksheetItem(worksheet_id=ws.id, sample_uid=s02.external_lims_uid,
                             sample_id=s02.sample_id, department_id=102))
        db.commit()
    items, _ = inbox_candidates_from_registry(db)
    assert "P-5322" not in [i["id"] for i in items]
    rows = _inbox(client)
    assert not {"P-5322", "P-5322-S01", "P-5322-S02"} & set(rows)


def _sibling(db, svcs, parent, seq, state):
    """One more endo vial (S0<seq>) on `parent`, on no worksheet."""
    sub = LimsSubSample(parent_sample_pk=parent.id,
                        external_lims_uid=f"mk1://{parent.sample_id}-{seq:03d}",
                        sample_id=f"{parent.sample_id}-S{seq:02d}",
                        vial_sequence=seq, assignment_role="endo")
    db.add(sub)
    db.flush()
    svc = svcs["ENDOTOXIN-USP85LAL"]
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title, review_state=state))
    db.commit()


SIBLING_STATES = ["to_be_verified", "assigned", "cancelled", "registered"]


@pytest.mark.parametrize("state", SIBLING_STATES)
def test_waiting_parent_shows_only_unassigned_vials(db, svcs, client, state):
    """Once a waiting parent loads (its S02 is unassigned), a sibling vial in
    any other state stays out, even though the per-vial loop would show it
    for a received parent."""
    parent, _ = _family(db, svcs, "P-5309", status=WAITING)
    _sibling(db, svcs, parent, 3, state)
    rows = _inbox(client)
    assert "P-5309-S02" in rows
    assert "P-5309-S03" not in rows


@pytest.mark.parametrize("state", ["to_be_verified", "cancelled", "registered"])
def test_received_parent_sibling_states_unchanged(db, svcs, client, state):
    """Received parents keep today's per-vial rule: only rejected/retracted
    and done states drop a vial, so these siblings still show."""
    parent, _ = _family(db, svcs, "P-6000", status="sample_received",
                        hplc_state="unassigned")
    _sibling(db, svcs, parent, 3, state)
    assert "P-6000-S03" in _inbox(client)


def test_published_parent_open_vial_stays_out(db, svcs, client):
    _family(db, svcs, "P-4100", status="published")
    items, _ = inbox_candidates_from_registry(db)
    assert "P-4100" not in [i["id"] for i in items]
    assert not {"P-4100", "P-4100-S02"} & set(_inbox(client))


def test_received_parent_behaviour_unchanged(db, svcs, client):
    """A received non-container parent: its own card plus its open native
    vial, exactly as before (the after-the-fact-add case)."""
    _family(db, svcs, "P-6000", status="sample_received", hplc_state="unassigned")
    rows = _inbox(client)
    assert {"P-6000", "P-6000-S01", "P-6000-S02"} <= set(rows)
    assert rows["P-6000"]["is_parent"] is True
    assert rows["P-6000"]["review_state"] == "sample_received"
    micro = _inbox(client, role="microbiology")
    assert set(micro) == {"P-6000-S02"}


def test_received_and_waiting_side_by_side(db, svcs, client):
    _family(db, svcs, "P-6000", status="sample_received", hplc_state="unassigned")
    _family(db, svcs, "P-5309", status=WAITING)
    micro = _inbox(client, role="microbiology")
    assert set(micro) == {"P-6000-S02", "P-5309-S02"}


def test_parent_level_prep_does_not_hide_waiting_parents_vials(
        db, svcs, client, preps):
    """A prep under the waiting parent's own ID is its published HPLC work;
    its open endo vial still shows. A prep on the vial itself still hides it.
    A received parent with a parent-ID prep stays hidden, as before."""
    _, (_s01, s02) = _family(db, svcs, "P-5309", status=WAITING)
    _family(db, svcs, "P-6000", status="sample_received", hplc_state="unassigned")
    preps["senaite_ids"] = {"P-5309", "P-6000"}
    rows = _inbox(client)
    assert "P-5309-S02" in rows
    assert not {"P-6000", "P-6000-S01", "P-6000-S02"} & set(rows)

    preps["sub_pks"] = {s02.id}
    assert "P-5309-S02" not in _inbox(client)


def test_waiting_parents_never_push_received_out_of_the_200(db, svcs):
    base = datetime(2026, 9, 1, 12)
    received = [
        LimsSample(sample_id=f"P-{1000 + n}", external_lims_uid=f"uid-{n}",
                   status="sample_received", sample_type="x",
                   date_created=base + timedelta(minutes=n))
        for n in range(200)
    ]
    db.add_all(received)
    db.commit()
    # Newer than every received parent: one combined newest-first query would
    # have pushed three received parents out.
    for n in range(3):
        _family(db, svcs, f"P-9{n:03d}", status=WAITING,
                created=datetime(2026, 10, 10, 12) + timedelta(minutes=n))
    items, analyses = inbox_candidates_from_registry(db)
    ids = [i["id"] for i in items]
    assert {r.sample_id for r in received} <= set(ids)
    assert {"P-9000", "P-9001", "P-9002"} <= set(ids)
    assert len(ids) == 203
    assert all(i["review_state"] == WAITING for i in items if i["id"].startswith("P-9"))
    # Waiting parents carry no parent analyses (their row is never emitted).
    assert not any(k.startswith("P-9") for k in analyses)
