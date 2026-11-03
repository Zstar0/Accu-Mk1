"""ai_chat.approvals: ACP option mapping and the turn-bound registry of pending approvals (spec 7)."""
import pytest
from acp.schema import PermissionOption

from ai_chat.approvals import (
    AllowNotOffered,
    ApprovalConflict,
    ApprovalNotFound,
    ApprovalRegistry,
    pick_options,
    to_response,
)

pytestmark = pytest.mark.anyio


def opt(option_id: str, kind: str) -> PermissionOption:
    return PermissionOption(option_id=option_id, name=option_id, kind=kind)


def make(reg: ApprovalRegistry, *, chat_id: int = 1, user_id: int = 1, can_allow: bool = True, detail: str = "d"):
    return reg.register(chat_id, user_id, "turn", "agent", "Run a tool", detail, can_allow)


# ---- option mapping (pure) -------------------------------------------------------------------

def test_pick_options_ignores_other_kinds():
    opts = [opt("a1", "allow_always"), opt("o1", "allow_once"), opt("r1", "reject_once"), opt("x", "reject_always")]
    assert pick_options(opts) == ("o1", "r1")


def test_pick_options_takes_first_of_each_kind():
    opts = [opt("o1", "allow_once"), opt("o2", "allow_once"), opt("r1", "reject_once"), opt("r2", "reject_once")]
    assert pick_options(opts) == ("o1", "r1")


@pytest.mark.parametrize("opts, expected", [
    ([], (None, None)),
    ([opt("a1", "allow_always"), opt("x", "reject_always")], (None, None)),
    ([opt("o1", "allow_once")], ("o1", None)),
    ([opt("r1", "reject_once")], (None, "r1")),
])
def test_pick_options_missing_kinds_are_none(opts, expected):
    assert pick_options(opts) == expected


def test_allow_selects_the_allow_option():
    out = to_response("allow", "o1", "r1").outcome
    assert (out.outcome, out.option_id) == ("selected", "o1")


def test_deny_selects_the_reject_option():
    out = to_response("deny", "o1", "r1").outcome
    assert (out.outcome, out.option_id) == ("selected", "r1")


def test_deny_without_reject_once_is_cancelled():
    assert to_response("deny", "o1", None).outcome.outcome == "cancelled"


def test_allow_without_allow_once_is_cancelled():
    assert to_response("allow", None, "r1").outcome.outcome == "cancelled"


@pytest.mark.parametrize("decision", ["cancelled", "expired", "", "ALLOW"])
def test_anything_else_is_cancelled(decision):
    assert to_response(decision, "o1", "r1").outcome.outcome == "cancelled"


# ---- registry --------------------------------------------------------------------------------

async def test_decide_resolves_future_and_removes():
    reg = ApprovalRegistry()
    p = make(reg)
    assert reg.pending_for_chat(1) == [p]
    assert reg.decide(p.permission_id, 1, "allow") is p
    assert p.future.result() == "allow"
    assert reg.pending_for_chat(1) == []


async def test_deny_resolves_future_with_deny():
    reg = ApprovalRegistry()
    p = make(reg)
    reg.decide(p.permission_id, 1, "deny")
    assert p.future.result() == "deny"


async def test_second_decision_conflicts():
    reg = ApprovalRegistry()
    p = make(reg)
    reg.decide(p.permission_id, 1, "deny")
    with pytest.raises(ApprovalConflict):
        reg.decide(p.permission_id, 1, "allow")
    assert p.future.result() == "deny"  # the first decision stands


async def test_unknown_id_is_not_found():
    with pytest.raises(ApprovalNotFound):
        ApprovalRegistry().decide("nope", 1, "allow")


async def test_other_user_gets_not_found():
    reg = ApprovalRegistry()
    p = make(reg, user_id=1)
    with pytest.raises(ApprovalNotFound):
        reg.decide(p.permission_id, 2, "allow")
    # Not resolved, not removed: the owner can still decide.
    assert not p.future.done()
    assert reg.pending_for_chat(1) == [p]
    reg.decide(p.permission_id, 1, "allow")
    assert p.future.result() == "allow"


async def test_other_user_gets_not_found_after_decision_too():
    reg = ApprovalRegistry()
    p = make(reg, user_id=1)
    reg.decide(p.permission_id, 1, "allow")
    with pytest.raises(ApprovalNotFound):  # a tombstone is no oracle for another user's ids
        reg.decide(p.permission_id, 2, "allow")


async def test_cancelled_then_decide_is_not_found():
    reg = ApprovalRegistry()
    p = make(reg)
    assert reg.cancel_chat(1) == [p]
    assert p.future.result() == "cancelled"
    with pytest.raises(ApprovalNotFound):  # not Conflict: no user ever decided it
        reg.decide(p.permission_id, 1, "allow")


async def test_expired_then_decide_is_not_found():
    reg = ApprovalRegistry()
    p = make(reg)
    assert reg.expire(p.permission_id) is p
    assert p.future.result() == "expired"
    assert reg.pending_for_chat(1) == []
    with pytest.raises(ApprovalNotFound):
        reg.decide(p.permission_id, 1, "deny")


async def test_expire_unknown_is_none():
    assert ApprovalRegistry().expire("nope") is None


async def test_allow_not_offered_keeps_pending():
    reg = ApprovalRegistry()
    p = make(reg, can_allow=False)
    with pytest.raises(AllowNotOffered):
        reg.decide(p.permission_id, 1, "allow")
    assert not p.future.done()
    assert reg.pending_for_chat(1) == [p]
    reg.decide(p.permission_id, 1, "deny")  # deny is always offered
    assert p.future.result() == "deny"


async def test_decide_after_waiter_cancelled_the_future_does_not_raise():
    reg = ApprovalRegistry()
    p = make(reg)
    p.future.cancel()  # a Task 7 waiter that timed out
    assert reg.decide(p.permission_id, 1, "allow") is p
    assert p.future.cancelled()
    assert reg.pending_for_chat(1) == []


async def test_cancel_chat_is_scoped_to_the_chat_and_ordered():
    reg = ApprovalRegistry()
    a, b, other = make(reg, chat_id=1), make(reg, chat_id=1), make(reg, chat_id=2)
    assert reg.cancel_chat(1) == [a, b]
    assert [p.future.result() for p in (a, b)] == ["cancelled", "cancelled"]
    assert not other.future.done()
    assert reg.pending_for_chat(2) == [other]
    assert reg.cancel_chat(1) == []


async def test_pending_for_chat_is_in_registration_order():
    reg = ApprovalRegistry()
    first, other, second = make(reg, chat_id=1), make(reg, chat_id=2), make(reg, chat_id=1)
    assert reg.pending_for_chat(1) == [first, second]
    assert reg.pending_for_chat(2) == [other]


async def test_tombstones_are_bounded_to_the_last_1024_decisions():
    reg = ApprovalRegistry()
    ids = []
    for _ in range(1025):
        p = make(reg)
        reg.decide(p.permission_id, 1, "allow")
        ids.append(p.permission_id)
    with pytest.raises(ApprovalNotFound):  # evicted: the first decision is forgotten
        reg.decide(ids[0], 1, "allow")
    for kept in (ids[1], ids[-1]):
        with pytest.raises(ApprovalConflict):
            reg.decide(kept, 1, "allow")


async def test_ids_are_distinct_and_repr_hides_detail():
    reg = ApprovalRegistry()
    a, b = make(reg, detail="rm -rf /secret-arg"), make(reg)
    assert a.permission_id != b.permission_id
    assert "secret-arg" not in repr(a)  # detail can hold tool arguments, so a stray %r must not print it
