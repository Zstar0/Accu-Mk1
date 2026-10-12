"""Detail routes admit flag participants read-only (spec 3.3); lists and writes keep their gates."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db

TH = "th_01KNK2DP78S9Z8P62PZV6M7F8M"
DETAIL = {"thread": {"id": TH, "ref": "T-1540", "title": "Contact form", "status": "open", "priority": "normal",
                     "labels": [], "assignee": None, "created_at": None, "updated_at": None, "preview": "",
                     "waiting_since": None, "plain_url": "https://p/x"},
          "entries": [], "fetched_at": "2026-10-12T00:00:00Z", "stale": False}
ITEM = {"id": "acti_1", "type": "email", "at": None, "direction": "inbound", "who": "Kyle", "title": "Re: COA",
        "preview": "", "lead_id": "lead_1", "lead_name": "Kyle", "automated": False, "support_thread_url": None}


@pytest.fixture
def api(monkeypatch):
    import main
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from crm_close import service as crm
    from flags.models import FlagFlag
    from support_plain import seat, service as support
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    s.add(FlagFlag(entity_type="support_ticket", entity_id=f"wc:1|{TH}", kind="issue", type="question",
                   status="resolved", title="t", created_by=1, assignee_id=50))
    s.add(FlagFlag(entity_type="crm_item", entity_id="wc:1|email|acti_1", kind="issue", type="question",
                   status="open", title="t", created_by=1, assignee_id=50))
    s.commit()

    def _db():
        d = Session()
        try:
            yield d
        finally:
            d.close()

    monkeypatch.setattr(support, "thread_detail", lambda key, th, **kw: DETAIL if (key, th) == ("wc:1", TH) else None)
    monkeypatch.setattr(crm, "activity_detail", lambda key, aid, kind: ITEM if (key, aid) == ("wc:1", "acti_1") else None)
    monkeypatch.setattr(seat, "resolve", lambda email: None)  # nobody has a Plain seat in these tests
    main.app.dependency_overrides[get_db] = _db
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def _as(uid, role="standard"):
    import main
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=uid, role=role, email=f"u{uid}@x")


def test_assignee_without_seat_reads_the_ticket_and_sees_why(api):
    _as(50)
    r = api.get(f"/support/customers/wc:1/threads/{TH}")
    assert r.status_code == 200 and r.json()["via_flag"] == 1


def test_non_participant_without_seat_is_refused(api):
    _as(51)
    r = api.get(f"/support/customers/wc:1/threads/{TH}")
    assert r.status_code == 403 and "T-1540" not in r.text


def test_flag_access_still_scopes_to_the_customer(api):
    _as(50)
    assert api.get(f"/support/customers/wc:2/threads/{TH}").status_code in (403, 404)


def test_flag_access_does_not_open_the_list_or_writes(api):
    _as(50)
    assert api.get("/support/customers/wc:1").status_code == 403
    assert api.post(f"/support/customers/wc:1/threads/{TH}/note", json={"markdown": "x"}).status_code == 403


def test_admin_reads_without_via_flag(api):
    _as(1, role="admin")
    assert api.get(f"/support/customers/wc:1/threads/{TH}").json()["via_flag"] is None


def test_crm_participant_reads_one_item_only(api):
    _as(50)
    r = api.get("/crm/customers/wc:1/activities/acti_1?type=email")
    assert r.status_code == 200 and r.json()["via_flag"] == 2
    assert api.get("/crm/customers/wc:1").status_code == 403
    _as(51)
    assert api.get("/crm/customers/wc:1/activities/acti_1?type=email").status_code == 403
