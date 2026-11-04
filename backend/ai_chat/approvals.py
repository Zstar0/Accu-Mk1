"""Tool approvals for ACP chats: the option mapping and the registry of pending requests (spec 8).

The agent offers its own permission options; the user only ever sees Allow once and Deny. `pick_options`
finds the two option ids that mean that, and `to_response` turns the user's decision back into the ACP reply.
Anything the agent offered beyond those two (allow_always, reject_always) is never selected on the user's
behalf.

The registry is bound to a running turn: an entry lives only while the turn's `request_permission` call is
awaiting its future, and the turn owner calls `expire` or `cancel_chat` when it stops waiting. Everything
here runs on the event loop thread (futures are not thread-safe) and nothing is persisted or logged;
`detail` can hold tool arguments, so it is kept out of the dataclass repr.
"""
from __future__ import annotations

import asyncio
import secrets
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

from acp.schema import AllowedOutcome, DeniedOutcome, PermissionOption, RequestPermissionResponse

_TOMBSTONES = 1024  # decided ids remembered, so a double click gets 409 rather than 404


def pick_options(options: Sequence[PermissionOption]) -> tuple[str | None, str | None]:
    """(first `allow_once` option id, first `reject_once` option id); every other kind is ignored."""
    allow = reject = None
    for o in options:
        if o.kind == "allow_once" and allow is None:
            allow = o.option_id
        elif o.kind == "reject_once" and reject is None:
            reject = o.option_id
    return allow, reject


def to_response(decision: str, allow_id: str | None, reject_id: str | None) -> RequestPermissionResponse:
    """`allow`/`deny` select the matching option when the agent offered one; anything else cancels."""
    chosen = allow_id if decision == "allow" else reject_id if decision == "deny" else None
    outcome = (DeniedOutcome(outcome="cancelled") if chosen is None
               else AllowedOutcome(outcome="selected", option_id=chosen))
    return RequestPermissionResponse(outcome=outcome)


class ApprovalNotFound(Exception):
    """Unknown, expired, cancelled, or another user's permission id."""


class ApprovalConflict(Exception):
    """A user already decided this permission."""


class AllowNotOffered(Exception):
    """`allow` on a card whose agent offered no allow_once option."""


@dataclass
class PendingApproval:
    permission_id: str
    chat_id: int
    user_id: int
    turn_id: str
    source: str
    title: str
    detail: str = field(repr=False)
    can_allow: bool
    row_seq: int | None
    future: asyncio.Future[str]  # resolves to allow, deny, expired or cancelled


def _resolve(p: PendingApproval, outcome: str) -> None:
    if not p.future.done():  # the waiter may have timed out and cancelled it already
        p.future.set_result(outcome)


class ApprovalRegistry:
    def __init__(self) -> None:
        self._pending: dict[str, PendingApproval] = {}
        self._decided: OrderedDict[str, int] = OrderedDict()  # permission id -> deciding user, oldest first

    def register(self, chat_id: int, user_id: int, turn_id: str, source: str, title: str, detail: str,
                 can_allow: bool) -> PendingApproval:
        """Must run inside the event loop: the future belongs to it."""
        p = PendingApproval(secrets.token_urlsafe(12), chat_id, user_id, turn_id, source, title, detail,
                            can_allow, None, asyncio.get_running_loop().create_future())
        self._pending[p.permission_id] = p
        return p

    def decide(self, permission_id: str, user_id: int, decision: Literal["allow", "deny"],
               chat_id: int | None = None) -> PendingApproval:
        """With `chat_id`, only a permission of that chat can be decided: one pending in another of the user's chats
        is not found through this one's URL."""
        p = self._pending.get(permission_id)
        if p is None:
            # A tombstone is only visible to the user who made the decision.
            if self._decided.get(permission_id) == user_id:
                raise ApprovalConflict(permission_id)
            raise ApprovalNotFound(permission_id)
        if p.user_id != user_id or (chat_id is not None and p.chat_id != chat_id):
            raise ApprovalNotFound(permission_id)  # untouched: the owner can still decide, in the right chat
        if decision == "allow" and not p.can_allow:
            raise AllowNotOffered(permission_id)  # stays pending: Deny is still available
        del self._pending[permission_id]
        self._decided[permission_id] = user_id
        if len(self._decided) > _TOMBSTONES:
            self._decided.popitem(last=False)
        _resolve(p, decision)
        return p

    def expire(self, permission_id: str) -> PendingApproval | None:
        p = self._pending.pop(permission_id, None)
        if p is not None:
            _resolve(p, "expired")
        return p

    def cancel_chat(self, chat_id: int) -> list[PendingApproval]:
        """Turn end, stop or disconnect: resolve every pending approval of the chat as `cancelled`."""
        gone = self.pending_for_chat(chat_id)
        for p in gone:
            del self._pending[p.permission_id]
            _resolve(p, "cancelled")
        return gone

    def pending_for_chat(self, chat_id: int) -> list[PendingApproval]:
        return [p for p in self._pending.values() if p.chat_id == chat_id]


# ponytail: single uvicorn worker; sticky routing or a broker if workers > 1
APPROVALS = ApprovalRegistry()
