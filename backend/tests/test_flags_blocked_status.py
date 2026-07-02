"""The `blocked` status is an active/open state in the lifecycle + counts."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401  (register FlagType on Base)
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"V{e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    try:
        yield s
    finally:
        s.close()


def _user(id=1, role="standard"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def test_blocked_in_catalog():
    from flags import catalog
    assert "blocked" in catalog.STATUSES
    assert catalog.OPEN_STATES == ("open", "in_progress", "blocked")


def test_can_transition_to_blocked_and_counts_as_open(db):
    from flags import service
    f = service.create_flag(db, user=_user(7), entity_type="sub_sample",
                            entity_id="1", type="blocker", title="t")
    service.change_status(db, user=_user(7), flag_id=f.id, to_status="in_progress")
    f2 = service.change_status(db, user=_user(7), flag_id=f.id, to_status="blocked")
    assert f2.status == "blocked"
    # Counted as open in the all_open tab + the summary.
    open_ids = [x.id for x in service.list_flags(db, user_id=7, tab="all_open")]
    assert f.id in open_ids
    summ = service.summary(db, user_id=7)
    assert summ["by_type"].get("blocker") == 1


def test_blocked_can_reopen_to_open_or_in_progress(db):
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="sub_sample",
                            entity_id="1", type="blocker", title="t")
    service.change_status(db, user=_user(1), flag_id=f.id, to_status="blocked")
    assert service.change_status(db, user=_user(1), flag_id=f.id, to_status="open").status == "open"
    service.change_status(db, user=_user(1), flag_id=f.id, to_status="blocked")
    assert service.change_status(db, user=_user(1), flag_id=f.id, to_status="in_progress").status == "in_progress"


def test_blocked_does_not_stamp_resolved_at(db):
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="sub_sample",
                            entity_id="1", type="blocker", title="t")
    blocked = service.change_status(db, user=_user(1), flag_id=f.id, to_status="blocked")
    assert blocked.resolved_at is None and blocked.resolved_by is None
