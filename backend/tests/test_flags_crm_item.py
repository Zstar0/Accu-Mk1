"""crm_item flags: ids, raise checks, snapshot labels, deep link (spec 3.1, 3.2)."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

USER = SimpleNamespace(id=7, role="standard", email="cs@x.t")
EID = "wc:1551|email|acti_8f2abc"
ITEM = {"id": "acti_8f2abc", "type": "email", "title": "Re: COA timing", "lead_name": "Kyle Robertson",
        "at": "2026-10-01T10:00:00Z"}


@pytest.fixture
def db(monkeypatch):
    from database import Base
    import models  # noqa: F401
    import documents.models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from crm_close import service
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    monkeypatch.setattr(service, "activity_detail",
                        lambda key, aid, kind: ITEM if (key, aid, kind) == ("wc:1551", "acti_8f2abc", "email") else None)
    seams.register_mk1_entities()
    yield s
    s.close()


def test_parse():
    from crm_close import flag_entity as fe
    assert fe.parse(EID) == ("wc:1551", "email", "acti_8f2abc")
    assert fe.parse("email:kyle@x.example|call|acti_1") == ("email:kyle@x.example", "call", "acti_1")  # guest key
    for bad in ("wc:1551|email", "wc:1551|fax|acti_1", "wc:1551|email|", "x|email|acti_1", "",
                "wc:1551|email|../leads"):
        assert fe.parse(bad) is None, bad


def test_raise_snapshots_and_labels(db):
    from flags import seams, service
    service.create_flag(db, user=USER, entity_type="crm_item", entity_id=EID, type="question", title="x")
    assert seams.get_entity_spec("crm_item").label(db, EID) == "Email · Re: COA timing · Kyle Robertson"
    assert seams.resolve_context(db, "crm_item", EID)["deep_link"] == {"kind": "customer_item", "id": "crm:" + EID}


def test_malformed_ids_are_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    for bad in ("wc:1551|email", "wc:1551|fax|acti_1"):
        with pytest.raises(BadRequestError, match="malformed"):
            service.create_flag(db, user=USER, entity_type="crm_item", entity_id=bad, type="question", title="x")


def test_foreign_item_is_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError, match="not one of"):
        service.create_flag(db, user=USER, entity_type="crm_item", entity_id="wc:2|email|acti_8f2abc",
                            type="question", title="x")
