import asyncio
import threading
from flags.bus import FlagEventBus, SSEEventSink


def test_publish_delivers_to_subscriber():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=7)
        bus.publish({"event_type": "raised", "flag_id": 1})
        got = await asyncio.wait_for(sub.get(), timeout=1.0)
        assert got["flag_id"] == 1
        sub.close()
    asyncio.run(scenario())


def test_cross_thread_publish_is_safe():
    """publish() called from a non-loop thread (mimics FastAPI's threadpool)."""
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=7)
        t = threading.Thread(target=lambda: bus.publish({"event_type": "commented", "flag_id": 9}))
        t.start(); t.join()
        got = await asyncio.wait_for(sub.get(), timeout=1.0)
        assert got["flag_id"] == 9
        sub.close()
    asyncio.run(scenario())


def test_unsubscribe_stops_delivery():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=7)
        sub.close()
        bus.publish({"event_type": "raised", "flag_id": 1})
        with pytest_raises_timeout():
            await asyncio.wait_for(sub.get(), timeout=0.2)
    asyncio.run(scenario())


def test_sink_forwards_to_bus():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=1)
        SSEEventSink(bus).emit({"event_type": "assigned", "flag_id": 5})
        got = await asyncio.wait_for(sub.get(), timeout=1.0)
        assert got["event_type"] == "assigned"
        sub.close()
    asyncio.run(scenario())


def test_publish_with_no_loop_is_noop():
    bus = FlagEventBus()  # never set_loop, no subscribers
    bus.publish({"event_type": "raised", "flag_id": 1})  # must not raise


# helper: assert an awaitable times out
import contextlib
@contextlib.contextmanager
def pytest_raises_timeout():
    try:
        yield
        raise AssertionError("expected TimeoutError")
    except asyncio.TimeoutError:
        pass
