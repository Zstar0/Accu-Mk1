"""flags.access: who is 'on a flag' for an item, and labels from the raise-time snapshot (spec 3.2, 3.3)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


EID = "wc:1|th_01ABC"


def _flag(db, **kw):
    from flags.models import FlagFlag
    f = FlagFlag(entity_type=kw.pop("entity_type", "support_ticket"), entity_id=kw.pop("entity_id", EID),
                 kind="issue", type="question", status=kw.pop("status", "open"), title="t",
                 created_by=kw.pop("created_by", 1), assignee_id=kw.pop("assignee_id", None))
    db.add(f)
    db.commit()
    return f


def test_creator_assignee_and_watcher_are_on_the_flag(db):
    from flags import access
    from flags.models import FlagParticipant
    f = _flag(db, created_by=1, assignee_id=2)
    db.add(FlagParticipant(flag_id=f.id, user_id=3, role="watcher"))
    db.commit()
    for uid in (1, 2, 3):
        assert access.on_flag_for(db, uid, "support_ticket", EID), uid
    assert not access.on_flag_for(db, 4, "support_ticket", EID)
    assert not access.on_flag_for(db, None, "support_ticket", EID)


def test_resolved_flags_still_count_and_newest_wins(db):
    from flags import access
    old = _flag(db, created_by=5, status="resolved")
    new = _flag(db, created_by=5, status="closed")
    assert access.flag_for_user(db, 5, "support_ticket", EID) == new.id != old.id


def test_other_items_and_types_do_not_count(db):
    from flags import access
    _flag(db, created_by=1, entity_id="wc:1|th_OTHER")
    _flag(db, created_by=1, entity_type="crm_item", entity_id=EID)
    assert not access.on_flag_for(db, 1, "support_ticket", EID)


def test_snapshot_label_from_the_latest_raised_event(db):
    from flags import access
    from flags.models import FlagEvent
    f = _flag(db)
    db.add(FlagEvent(flag_id=f.id, actor_id=1, event_type="raised",
                     details={"type": "question", "entity_snapshot": {"label": "T-1 · Old title · Kyle"}}))
    g = _flag(db)
    db.add(FlagEvent(flag_id=g.id, actor_id=1, event_type="raised",
                     details={"type": "question", "entity_snapshot": {"label": "T-1 · New title · Kyle"}}))
    db.commit()
    assert access.snapshot_label(db, "support_ticket", EID, "Support ticket") == "T-1 · New title · Kyle"


def test_snapshot_label_falls_back(db):
    from flags import access
    assert access.snapshot_label(db, "support_ticket", EID, "Support ticket") == "Support ticket"
    assert access.snapshot_label(None, "support_ticket", EID, "Support ticket") == "Support ticket"
