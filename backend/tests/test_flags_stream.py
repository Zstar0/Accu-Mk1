import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import flags.models  # noqa: F401
    from flags import seams
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    s._engine_for_test = engine  # keep a handle for fresh sessions
    try:
        yield s
    finally:
        s.close()


def test_emit_happens_after_commit_and_is_enriched(db):
    """The sink must only see an event once the flag row is committed (visible
    in a fresh session), and the event must carry event_id + a flag summary."""
    from flags import seams, service
    from flags.models import FlagFlag
    from sqlalchemy.orm import sessionmaker

    Session = sessionmaker(bind=db._engine_for_test)
    seen = []

    class AssertCommittedSink:
        def emit(self, event):
            # a brand-new session must already see the flag → proves post-commit
            fresh = Session()
            try:
                assert fresh.get(FlagFlag, event["flag_id"]) is not None, "emitted before commit!"
            finally:
                fresh.close()
            seen.append(event)

    seams.set_event_sink(AssertCommittedSink())
    user = SimpleNamespace(id=42, role="standard", email="t@x.t")
    flag = service.create_flag(db, user=user, entity_type="sub_sample", entity_id="123",
                               type="blocker", title="Crashed out", first_comment="cloudy")

    assert seen, "no events emitted"
    raised = next(e for e in seen if e["event_type"] == "raised")
    assert raised["event_id"] is not None and isinstance(raised["event_id"], int)
    assert raised["flag"]["title"] == "Crashed out"
    assert raised["flag"]["status"] == "open"
    assert raised["flag"]["entity_type"] == "sub_sample"
