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


def test_stream_generator_frames_event():
    """Direct-generator unit test (the plan's documented fallback for the SSE
    endpoint, since TestClient.stream + cross-thread publish hangs under the sync
    test transport). Drive the endpoint's inner async generator on the loop,
    publish an event through the bus, and assert the first non-heartbeat frame is
    correctly framed (id: / event: / data: <json>)."""
    import asyncio, json
    from types import SimpleNamespace
    import main  # noqa: F401  (ensure app + routes import cleanly)
    from flags.routes import stream
    from flags import bus

    async def scenario():
        bus.BUS.set_loop(asyncio.get_running_loop())

        class FakeRequest:
            async def is_disconnected(self):
                return False

        user = SimpleNamespace(id=42, role="standard", email="t@x.t")
        resp = await stream(FakeRequest(), user=user)
        assert resp.media_type == "text/event-stream"
        assert resp.headers["cache-control"] == "no-cache"
        agen = resp.body_iterator
        try:
            first = await agen.__anext__()
            assert first == ": connected\n\n"
            # subscription is registered (stream() ran); publish reaches it on-loop
            bus.BUS.publish({"event_type": "raised", "flag_id": 1, "event_id": 7,
                             "flag": {"id": 1, "title": "Crashed out"}})
            frame = await asyncio.wait_for(agen.__anext__(), timeout=2.0)
            assert frame.startswith("id: 7\n")
            assert "event: raised\n" in frame
            data_line = next(l for l in frame.split("\n") if l.startswith("data: "))
            payload = json.loads(data_line[len("data: "):])
            assert payload["flag_id"] == 1
            assert payload["flag"]["title"] == "Crashed out"
        finally:
            await agen.aclose()

    asyncio.run(scenario())
