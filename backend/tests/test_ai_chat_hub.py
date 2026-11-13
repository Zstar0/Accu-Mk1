"""ai_chat.hub: per-user event buffer with replay and resync, live fan-out and the SSE frame (spec 8)."""
import json
import time

import anyio
import pytest

from ai_chat import hub
from ai_chat.hub import EventHub, format_frame

pytestmark = pytest.mark.anyio

BASE = 5_000_000


def pub(h: EventHub, user_id: int = 1, type: str = "message_chunk", **fields) -> dict:
    fields.setdefault("text", "x")
    return h.publish(user_id, type, 7, "t1", **fields)


def seqs(events: list[dict]) -> list[int]:
    return [e["seq"] for e in events]


def backlog(h: EventHub, user_id: int, last: str | None) -> list[dict]:
    sub = h.subscribe(user_id, last)
    sub.close()
    return sub.backlog


# ---- publish ---------------------------------------------------------------------------------

async def test_publish_builds_the_wire_dict():
    h = EventHub(boot_base=BASE)
    ev = h.publish(1, "tool_call", 7, "t1", id="c1", title="Run", kind="execute", status="pending")
    assert ev == {"seq": BASE, "type": "tool_call", "chat_id": 7, "turn_id": "t1",
                  "id": "c1", "title": "Run", "kind": "execute", "status": "pending"}


async def test_seq_is_one_counter_per_user_starting_at_boot_base():
    h = EventHub(boot_base=BASE)
    assert [pub(h, 1)["seq"], pub(h, 1)["seq"]] == [BASE, BASE + 1]
    assert pub(h, 2)["seq"] == BASE  # another user starts at the same base


async def test_default_boot_base_is_epoch_seconds_in_millionths():
    lo = int(time.time()) * 1_000_000
    seq = pub(EventHub())["seq"]
    assert lo <= seq <= (int(time.time()) + 1) * 1_000_000


async def test_the_module_singleton_is_an_event_hub():
    assert isinstance(hub.HUB, EventHub)


async def test_publish_without_subscribers_still_buffers():
    h = EventHub(boot_base=BASE)
    first = pub(h, 9)
    pub(h, 9)
    assert seqs(backlog(h, 9, str(first["seq"]))) == [BASE + 1]


# ---- replay ----------------------------------------------------------------------------------

async def test_replay_after_last_event_id():
    h = EventHub(boot_base=BASE)
    evs = [pub(h) for _ in range(5)]
    sub = h.subscribe(1, str(evs[1]["seq"]))
    assert seqs(sub.backlog) == [evs[2]["seq"], evs[3]["seq"], evs[4]["seq"]]
    sub.close()


async def test_no_header_means_no_backlog():
    h = EventHub(boot_base=BASE)
    pub(h)
    sub = h.subscribe(1, None)
    assert sub.backlog == []
    sub.close()


async def test_caught_up_client_gets_an_empty_backlog():
    h = EventHub(boot_base=BASE)
    last = [pub(h) for _ in range(3)][-1]
    sub = h.subscribe(1, str(last["seq"]))
    assert sub.backlog == []
    sub.close()


async def test_evicted_id_gets_resync():
    h = EventHub(buffer_size=3, boot_base=BASE)
    evs = [pub(h) for _ in range(5)]  # buffer now holds seqs 2, 3, 4 (offsets from BASE)
    sub = h.subscribe(1, str(evs[0]["seq"]))
    assert sub.backlog == [{"seq": evs[4]["seq"], "type": "resync", "chat_id": None, "turn_id": None}]
    sub.close()


async def test_the_id_just_before_the_oldest_retained_event_still_replays():
    h = EventHub(buffer_size=3, boot_base=BASE)
    evs = [pub(h) for _ in range(5)]
    sub = h.subscribe(1, str(evs[1]["seq"]))  # oldest - 1: nothing was lost in between
    assert seqs(sub.backlog) == seqs(evs[2:])
    sub.close()


async def test_an_id_from_the_future_gets_resync():
    h = EventHub(boot_base=BASE)
    ev = pub(h)
    sub = h.subscribe(1, str(ev["seq"] + 1))
    assert [e["type"] for e in sub.backlog] == ["resync"]
    assert sub.backlog[0]["seq"] == ev["seq"]
    sub.close()


async def test_restart_forces_resync():
    hub1 = EventHub(boot_base=BASE)
    last = pub(hub1)
    hub2 = EventHub(boot_base=BASE + 1_000_000)
    pub(hub2)
    sub = hub2.subscribe(1, str(last["seq"]))
    assert [e["type"] for e in sub.backlog] == ["resync"]
    sub.close()


async def test_stale_id_for_a_user_with_no_events_gets_resync_at_boot_base_minus_one():
    h = EventHub(boot_base=BASE)
    sub = h.subscribe(1, str(BASE - 1_000_000))
    assert sub.backlog == [{"seq": BASE - 1, "type": "resync", "chat_id": None, "turn_id": None}]
    assert backlog(h, 1, str(BASE - 1)) == []  # the resync id itself is a valid cursor
    sub.close()


@pytest.mark.parametrize("header", ["abc", "", " ", "1.5", "0x10", "12abc"])
async def test_non_integer_header_gets_resync(header):
    h = EventHub(boot_base=BASE)
    ev = pub(h)
    sub = h.subscribe(1, header)
    assert sub.backlog == [{"seq": ev["seq"], "type": "resync", "chat_id": None, "turn_id": None}]
    sub.close()


async def test_resync_is_never_buffered():
    h = EventHub(boot_base=BASE)
    ev = pub(h)
    resync = backlog(h, 1, "abc")[0]
    assert resync["seq"] == ev["seq"]
    nxt = pub(h)
    assert nxt["seq"] == ev["seq"] + 1  # no seq was spent on the resync
    assert seqs(backlog(h, 1, str(ev["seq"]))) == [nxt["seq"]]  # and it is not in the buffer


async def test_resync_is_not_put_on_the_queue():
    h = EventHub(boot_base=BASE)
    sub = h.subscribe(1, "abc")
    assert sub.queue.empty()
    sub.close()


# ---- live delivery ---------------------------------------------------------------------------

async def test_live_delivery():
    h = EventHub(boot_base=BASE)
    sub = h.subscribe(1, None)
    ev = pub(h)
    with anyio.fail_after(2):
        assert await sub.get() is ev
    sub.close()


async def test_get_waits_for_the_next_event():
    h = EventHub(boot_base=BASE)
    sub = h.subscribe(1, None)
    got: list[dict] = []

    async def reader():
        got.append(await sub.get())

    async with anyio.create_task_group() as tg:
        tg.start_soon(reader)
        await anyio.sleep(0.01)
        assert got == []
        ev = pub(h)
    assert got == [ev]
    sub.close()


async def test_every_subscriber_of_a_user_gets_the_event():
    h = EventHub(boot_base=BASE)
    a, b = h.subscribe(1, None), h.subscribe(1, None)
    ev = pub(h)
    with anyio.fail_after(2):
        assert (await a.get(), await b.get()) == (ev, ev)
    a.close()
    b.close()


async def test_users_are_isolated():
    h = EventHub(boot_base=BASE)
    one, two = h.subscribe(1, None), h.subscribe(2, None)
    ev1 = pub(h, 1)
    ev2 = pub(h, 2)
    with anyio.fail_after(2):
        assert await one.get() is ev1
        assert await two.get() is ev2
    assert one.queue.empty() and two.queue.empty()
    # Replay is per user too: user 2 asking for a cursor in user 1's stream sees only its own events.
    assert seqs(backlog(h, 2, str(BASE - 1))) == [ev2["seq"]]
    one.close()
    two.close()


async def test_backlog_and_queue_cover_each_event_exactly_once():
    h = EventHub(boot_base=BASE)
    first = pub(h)
    second = pub(h)
    sub = h.subscribe(1, str(first["seq"]))  # backlog and registration happen in this one sync call
    third = pub(h)                           # published right after, before the stream loop runs
    with anyio.fail_after(2):
        live = await sub.get()
    assert seqs(sub.backlog) + [live["seq"]] == [second["seq"], third["seq"]]
    assert sub.queue.empty()
    sub.close()


async def test_slow_consumer_drops_the_oldest_and_keeps_the_newest():
    h = EventHub(boot_base=BASE)
    sub = h.subscribe(1, None)
    for _ in range(1001):
        pub(h)
    assert sub.queue.qsize() == 1000
    with anyio.fail_after(2):
        assert (await sub.get())["seq"] == BASE + 1  # BASE was dropped
    last = None
    while not sub.queue.empty():
        last = sub.queue.get_nowait()
    assert last["seq"] == BASE + 1000
    sub.close()


# ---- close -----------------------------------------------------------------------------------

async def test_close_stops_delivery_and_is_idempotent():
    h = EventHub(boot_base=BASE)
    sub = h.subscribe(1, None)
    other = h.subscribe(1, None)
    sub.close()
    sub.close()
    ev = pub(h)
    assert sub.queue.empty()
    with anyio.fail_after(2):
        assert await other.get() is ev  # the other subscriber is unaffected
    other.close()


async def test_closing_the_last_subscriber_leaves_the_buffer_intact():
    h = EventHub(boot_base=BASE)
    first = pub(h)
    h.subscribe(1, None).close()
    pub(h)
    assert seqs(backlog(h, 1, str(first["seq"]))) == [BASE + 1]


# ---- frame -----------------------------------------------------------------------------------

def test_frame_format():
    ev = {"seq": 7, "type": "message_chunk", "chat_id": 3, "turn_id": "abc", "text": "hi"}
    assert format_frame(ev) == (
        'id: 7\nevent: message_chunk\n'
        'data: {"seq":7,"type":"message_chunk","chat_id":3,"turn_id":"abc","text":"hi"}\n\n'
    )


def test_frame_with_newlines_in_text_stays_one_data_line():
    ev = {"seq": 8, "type": "message_chunk", "chat_id": 3, "turn_id": "abc", "text": "a\nb\r\nc d"}
    frame = format_frame(ev)
    assert frame.count("\n") == 4  # id, event, data, blank line: the text newlines are escaped
    data_lines = [ln for ln in frame.split("\n") if ln.startswith("data:")]
    assert len(data_lines) == 1
    assert json.loads(data_lines[0][len("data: "):]) == ev


def test_frame_for_a_resync_event():
    ev = {"seq": 41, "type": "resync", "chat_id": None, "turn_id": None}
    assert format_frame(ev) == (
        'id: 41\nevent: resync\ndata: {"seq":41,"type":"resync","chat_id":null,"turn_id":null}\n\n'
    )
