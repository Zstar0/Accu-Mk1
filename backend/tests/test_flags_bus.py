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


def _run(coro):
    return asyncio.run(coro)


def test_audience_none_reaches_everyone():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        subs = [bus.subscribe(1, group_ids=frozenset(), is_admin=False),
                bus.subscribe(2, group_ids=frozenset({5}), is_admin=False),
                bus.subscribe(3, is_admin=True), bus.subscribe(None, system=True)]
        bus.publish({"event_type": "raised", "flag_id": 1, "audience": None})
        for s in subs:
            assert (await asyncio.wait_for(s.get(), timeout=1.0))["flag_id"] == 1
            s.close()
    _run(scenario())


def test_audience_groups_reach_members_admins_and_system_only():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        outsider = bus.subscribe(1, group_ids=frozenset({9}))
        member = bus.subscribe(2, group_ids=frozenset({5, 9}))
        admin = bus.subscribe(3, is_admin=True)
        system = bus.subscribe(None, system=True)
        bus.publish({"event_type": "raised", "flag_id": 7, "audience": {"groups": [5]}})
        for s in (member, admin, system):
            assert (await asyncio.wait_for(s.get(), timeout=1.0))["flag_id"] == 7
        with pytest_raises_timeout():
            await asyncio.wait_for(outsider.get(), timeout=0.2)
        for s in (outsider, member, admin, system):
            s.close()
    _run(scenario())


def test_orphan_audience_is_admin_and_system_only():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        member = bus.subscribe(2, group_ids=frozenset({5}))
        admin = bus.subscribe(3, is_admin=True)
        bus.publish({"event_type": "commented", "flag_id": 8, "audience": {"groups": []}})
        assert (await asyncio.wait_for(admin.get(), timeout=1.0))["flag_id"] == 8
        with pytest_raises_timeout():
            await asyncio.wait_for(member.get(), timeout=0.2)
        member.close(); admin.close()
    _run(scenario())


def test_new_subscription_after_revocation_gets_nothing():
    """Review Focus 2: a subscription opened after the user left the group carries no
    group ids, so it receives nothing for that board; an older connection persists until
    reconnect (documented)."""
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        before = bus.subscribe(2, group_ids=frozenset({5}))
        after = bus.subscribe(2, group_ids=frozenset())
        bus.publish({"event_type": "raised", "flag_id": 9, "audience": {"groups": [5]}})
        assert (await asyncio.wait_for(before.get(), timeout=1.0))["flag_id"] == 9
        with pytest_raises_timeout():
            await asyncio.wait_for(after.get(), timeout=0.2)
        before.close(); after.close()
    _run(scenario())


def test_malformed_audience_fails_closed_and_does_not_break_fanout():
    """Task 8 item 4: a non-int-able group id in `audience` must not drop the
    whole fan-out. Admin/system still get it (they short-circuit before the
    parse), everyone else is denied, and a later well-formed event is unaffected."""
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        member = bus.subscribe(2, group_ids=frozenset({5}))
        admin = bus.subscribe(3, is_admin=True)
        system = bus.subscribe(None, system=True)
        bus.publish({"event_type": "raised", "flag_id": 11,
                    "audience": {"groups": ["not-a-number"]}})
        for s in (admin, system):
            assert (await asyncio.wait_for(s.get(), timeout=1.0))["flag_id"] == 11
        with pytest_raises_timeout():
            await asyncio.wait_for(member.get(), timeout=0.2)
        bus.publish({"event_type": "raised", "flag_id": 12, "audience": {"groups": [5]}})
        for s in (member, admin, system):
            assert (await asyncio.wait_for(s.get(), timeout=1.0))["flag_id"] == 12
        member.close(); admin.close(); system.close()
    _run(scenario())


def test_legacy_subscribe_signature_still_works():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=7)
        bus.publish({"event_type": "raised", "flag_id": 1})  # no audience key at all
        assert (await asyncio.wait_for(sub.get(), timeout=1.0))["flag_id"] == 1
        sub.close()
    _run(scenario())
