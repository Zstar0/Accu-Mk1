"""support_ticket flags: ids, raise checks, snapshot labels, deep link (spec 3.1, 3.2)."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

USER = SimpleNamespace(id=7, role="standard", email="cs@x.t")
EID = "wc:1572|th_01KNK2DP78S9Z8P62PZV6M7F8M"
DETAIL = {"thread": {"id": "th_01KNK2DP78S9Z8P62PZV6M7F8M", "ref": "T-1540", "title": "Contact form",
                     "customer": {"name": "Lilia Billones"}}, "entries": []}


@pytest.fixture
def db(monkeypatch):
    from database import Base
    import models  # noqa: F401
    import documents.models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    from support_plain import service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    monkeypatch.setattr(service, "thread_detail",
                        lambda key, th, **kw: DETAIL if (key, th) == ("wc:1572", DETAIL["thread"]["id"]) else None)
    monkeypatch.setattr(service, "customer_support",
                        lambda key, **kw: {"threads": [DETAIL["thread"]]} if key == "wc:1572" else None)
    seams.register_mk1_entities()
    yield s
    s.close()


def test_parse():
    from support_plain import flag_entity as fe
    assert fe.parse(EID) == ("wc:1572", "th_01KNK2DP78S9Z8P62PZV6M7F8M")
    assert fe.parse("email:kyle@x.example|th_01A") == ("email:kyle@x.example", "th_01A")  # guest key
    for bad in ("wc:1572", "wc:1572|abc", "x:1|th_01", "wc:1572|th_01|extra", "", "wc:|th_01"):
        assert fe.parse(bad) is None, bad


def test_raise_snapshots_and_labels(db):
    from flags import seams, service
    flag = service.create_flag(db, user=USER, entity_type="support_ticket", entity_id=EID,
                               type="question", title="Need lab help")
    assert flag.entity_id == EID
    assert seams.get_entity_spec("support_ticket").label(db, EID) == "T-1540 · Contact form · Lilia Billones"
    ctx = seams.resolve_context(db, "support_ticket", EID)
    assert ctx["deep_link"] == {"kind": "customer_item", "id": "support:" + EID}


def test_malformed_ids_are_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    for bad in ("wc:1572", "wc:1572|abc", "nope"):
        with pytest.raises(BadRequestError):
            service.create_flag(db, user=USER, entity_type="support_ticket", entity_id=bad,
                                type="question", title="x")


def test_foreign_ticket_is_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=USER, entity_type="support_ticket",
                            entity_id="wc:999|th_01KNK2DP78S9Z8P62PZV6M7F8M", type="question", title="x")


def test_snapshot_failure_still_raises_with_fallback_label(db, monkeypatch):
    from flags import seams, service
    from support_plain import service as support
    from support_plain.client import SupportUnavailable

    def down(key, th, **kw):
        raise SupportUnavailable("http_503")  # the snapshot's timeline fetch fails; the cached listing still answers

    monkeypatch.setattr(support, "thread_detail", down)
    service.create_flag(db, user=USER, entity_type="support_ticket", entity_id=EID, type="question", title="x")
    assert seams.get_entity_spec("support_ticket").label(db, EID) == "Support ticket"


def test_plain_down_on_raise_is_a_503_and_no_flag(db, monkeypatch):
    from fastapi import HTTPException
    from flags import service
    from flags.models import FlagFlag
    from support_plain import service as support
    from support_plain.client import SupportUnavailable

    def down(key, **kw):
        raise SupportUnavailable("http_503")

    monkeypatch.setattr(support, "customer_support", down)
    with pytest.raises(HTTPException) as e:
        service.create_flag(db, user=USER, entity_type="support_ticket", entity_id=EID, type="question", title="x")
    assert e.value.status_code == 503
    assert db.query(FlagFlag).count() == 0


def test_ownership_check_uses_the_listing_not_the_timeline(db, monkeypatch):
    from flags import service
    from support_plain import service as support
    seen = []
    monkeypatch.setattr(support, "customer_support",
                        lambda key, **kw: seen.append(kw) or {"threads": [DETAIL["thread"]]})
    service.create_flag(db, user=USER, entity_type="support_ticket", entity_id=EID, type="question", title="x")
    assert seen and seen[0]["refresh"] is False
