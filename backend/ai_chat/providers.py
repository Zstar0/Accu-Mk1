"""ai_chat.providers: /admin/acp-providers, the admin side of ACP providers (spec 11, Settings > ACP Providers).

Admin only, every route. The private key is Fernet-encrypted at rest and appears in no response, log or exception:
`ProviderOut` has no field that could carry it. Field values go through `transport`'s validators, in a helper rather
than as pydantic validators, so a 422 names the column and never echoes the input.

PUT is a partial update: the body's fields go onto the row's current values and the merged result is checked as a
whole. No DB connection is held across an await on an agent: each route commits first, then closes sessions or runs
the test, then reads the row again.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from ai_chat import context, sessions, transport
from ai_chat.models import AcpProvider, AiChat, _utcnow
from auth import require_admin
from database import get_db
from integration_keys import store

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/acp-providers", tags=["ai-chat-admin"])
TEST_TIMEOUT_S = 90  # below nginx's 120 s; a module attribute so tests can shorten it
_STDERR_LINE_MAX = 500
_ROLES = frozenset({"admin", "standard"})  # `agent` is never accepted
# Same as the model's column defaults; kept here because a new row is validated before it exists.
_DEFAULTS = {"enabled": False, "ssh_port": 22, "allowed_roles": ["admin"], "inject_mk1_tools": False,
             "max_sessions": 4, "idle_minutes": 15, "permission_timeout_s": 240, "agent_approval_timeout_s": 300}
_REQUIRED = ("slug", "display_name", "ssh_host", "ssh_user", "host_key", "launcher_path", "authorized_from",
             "session_cwd")
# Changing any of these makes the last test prove nothing about the new settings (`session_cwd`: the test ran
# session/new with the old one).
_RETEST = ("host_key", "ssh_host", "ssh_port", "ssh_user", "session_cwd", "allowed_roles")
_STEPS = ("connect", "initialize", "new_session", "tools")


class ProviderIn(BaseModel):
    """Create and update body. Unknown keys are ignored, so nothing here can set a key, a test result or a user id."""

    model_config = ConfigDict(strict=True)
    slug: str | None = None  # POST only; ignored on PUT
    display_name: str | None = None
    enabled: bool | None = None
    ssh_host: str | None = None
    ssh_port: int | None = None
    ssh_user: str | None = None
    host_key: str | None = None
    launcher_path: str | None = None
    authorized_from: str | None = None
    session_cwd: str | None = None
    allowed_roles: list[str] | None = None
    inject_mk1_tools: bool | None = None
    max_sessions: int | None = None
    idle_minutes: int | None = None
    permission_timeout_s: int | None = None
    agent_approval_timeout_s: int | None = None


class ProviderOut(BaseModel):
    id: int
    slug: str
    display_name: str
    enabled: bool
    ssh_host: str
    ssh_port: int
    ssh_user: str
    host_key: str | None
    host_key_fingerprint: str | None
    public_key: str | None
    key_created_at: str | None
    authorized_keys_line: str | None
    launcher_path: str
    authorized_from: str
    session_cwd: str
    allowed_roles: list[str]
    inject_mk1_tools: bool
    max_sessions: int
    idle_minutes: int
    permission_timeout_s: int
    agent_approval_timeout_s: int
    last_test_at: str | None
    last_test_ok: bool | None
    last_test_error: str | None
    last_agent_info: dict[str, Any] | None
    last_capabilities: dict[str, Any] | None
    live_sessions: int
    updated_at: str


class ProviderList(BaseModel):
    configured: bool
    providers: list[ProviderOut]


class TestResult(BaseModel):
    ok: bool
    error: str | None = None
    stderr_tail: list[str] | None = None  # only when ok is false
    # connect covers the ssh handshake and `initialize` together (`LiveSession.start` is one step), so initialize is
    # always null; a step that was not reached is null too.
    timings_ms: dict[str, int | None]
    agent_info: dict[str, Any] | None = None
    capabilities: dict[str, Any] | None = None
    tools: list[str]


def _fail(status: int, code: str, field: str | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **({"field": field} if field else {})})


def _need_keys() -> None:
    if not store.configured():
        raise _fail(503, "keys_not_configured")


def _load(db: Session, provider_id: int) -> AcpProvider:
    row = db.get(AcpProvider, provider_id)
    if row is None:
        raise _fail(404, "provider_not_found")
    return row


# ---- validation ---------------------------------------------------------------------------------

def _int_in(lo: int, hi: int):
    def check(n: object) -> int:
        if type(n) is not int or not lo <= n <= hi:  # `type`, not isinstance: True is not a count
            raise ValueError
        return n
    return check


def _display_name(s: object) -> str:
    s = s.strip() if isinstance(s, str) else ""
    if not 1 <= len(s) <= 100 or not s.isprintable():
        raise ValueError
    return s


def _roles(roles: object) -> list[str]:
    if not isinstance(roles, list) or not roles or not set(roles) <= _ROLES:
        raise ValueError
    return sorted(set(roles))  # always a new list: the JSON column is never mutated in place


def _no_mk1_tools(flag: object) -> bool:
    if flag:
        raise _fail(422, "not_supported")  # Phase 2
    return False


_CHECKS = {
    "slug": transport.validate_slug,
    "display_name": _display_name,
    "ssh_host": transport.validate_host,
    "ssh_port": transport.validate_port,
    "ssh_user": transport.validate_user,
    "host_key": transport.validate_host_key,
    "launcher_path": lambda s: transport.validate_path(s, "launcher_path"),
    "authorized_from": transport.validate_from_ip,
    "session_cwd": lambda s: transport.validate_path(s, "session_cwd"),  # absolute POSIX, as the regex requires
    "allowed_roles": _roles,
    "inject_mk1_tools": _no_mk1_tools,
    "max_sessions": _int_in(1, 16),
    "idle_minutes": _int_in(1, 240),
    "permission_timeout_s": _int_in(1, 3600),
    "agent_approval_timeout_s": _int_in(1, 3600),
}
_EDITABLE = tuple(f for f in ProviderIn.model_fields if f != "slug")


def _clean(body: ProviderIn, ignore: tuple[str, ...] = ()) -> dict[str, Any]:
    """The fields the body sets, checked, except `ignore`d ones (not even looked at). null counts as absent, so
    nothing can be cleared through here."""
    out: dict[str, Any] = {}
    for field, value in body.model_dump(exclude_unset=True, exclude=set(ignore)).items():
        if value is None:
            continue
        check = _CHECKS.get(field)
        try:
            out[field] = check(value) if check else value
        except ValueError:
            raise _fail(422, "invalid_input", field) from None
    return out


def _check_merged(values: dict[str, Any], has_key: bool, tested: bool | None) -> None:
    """Timeout order, then the enabling rules: an enabled provider has a key and a host key, and with `standard`
    among its roles a test that passed the tool check."""
    if values["permission_timeout_s"] >= values["agent_approval_timeout_s"]:
        raise _fail(422, "invalid_input", "permission_timeout_s")
    standard = "standard" in values["allowed_roles"]
    if values["enabled"] and not (has_key and values["host_key"] and (not standard or tested is True)):
        raise _fail(409, "not_ready")


# ---- output -------------------------------------------------------------------------------------

def _out(row: AcpProvider) -> ProviderOut:
    columns = AcpProvider.__table__.columns
    data: dict[str, Any] = {name: getattr(row, name) for name in ProviderOut.model_fields if name in columns}
    for name in ("key_created_at", "last_test_at", "updated_at"):
        data[name] = store._iso(getattr(row, name))
    data["allowed_roles"] = list(row.allowed_roles or [])
    data["host_key_fingerprint"] = data["authorized_keys_line"] = None
    # A stored value that no longer validates (a hand edit) must not hide the row from the admin who fixes it.
    with contextlib.suppress(ValueError):
        if row.host_key:
            data["host_key_fingerprint"] = transport.fingerprint(row.host_key)
    with contextlib.suppress(ValueError):
        if row.public_key and row.launcher_path and row.authorized_from:
            data["authorized_keys_line"] = transport.authorized_keys_line(
                row.public_key, row.slug, row.launcher_path, row.authorized_from)
    data["live_sessions"] = sessions.MANAGER.live_count(row.id)
    return ProviderOut(**data)


async def _saved(db: Session, row: AcpProvider) -> ProviderOut:
    """Commit, close the provider's live sessions (they restore on the next prompt), read the row back."""
    provider_id = row.id
    try:
        db.commit()  # first, so a session respawning during the close sees the new row, and no connection stays held
    except SQLAlchemyError as exc:
        # Its text holds the statement's parameters: for a key, the ciphertext. uvicorn would log it, so neither it
        # nor its cause leaves this function.
        db.rollback()
        logger.warning("ai_chat.provider_save_failed provider=%s error=%s", provider_id, type(exc).__name__)
        raise HTTPException(status_code=500) from None
    await sessions.MANAGER.close_provider(provider_id)
    return _out(_load(db, provider_id))


# ---- routes -------------------------------------------------------------------------------------

@router.get("", response_model=ProviderList)
async def list_providers(db: Session = Depends(get_db), _u=Depends(require_admin)):
    rows = db.scalars(select(AcpProvider).order_by(AcpProvider.id)).all()
    return ProviderList(configured=store.configured(), providers=[_out(r) for r in rows])


@router.post("", response_model=ProviderOut, status_code=201)
async def create_provider(body: ProviderIn, db: Session = Depends(get_db), user=Depends(require_admin)):
    _need_keys()
    patch = _clean(body)
    for field in _REQUIRED:
        if field not in patch:
            raise _fail(422, "invalid_input", field)
    values = {**_DEFAULTS, **patch}
    values["allowed_roles"] = list(values["allowed_roles"])  # a list of its own, never the shared default
    _check_merged(values, has_key=False, tested=None)  # a new provider has no key: `enabled: true` is not_ready
    row = AcpProvider(**values, created_by_user_id=user.id, updated_by_user_id=user.id)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:  # the unique slug
        db.rollback()
        raise _fail(422, "invalid_input", "slug") from None
    return _out(row)


@router.put("/{provider_id}", response_model=ProviderOut)
async def update_provider(provider_id: int, body: ProviderIn, db: Session = Depends(get_db),
                          user=Depends(require_admin)):
    _need_keys()
    row = _load(db, provider_id)
    patch = _clean(body, ignore=("slug",))  # immutable, and ignored whatever it holds
    current = {f: getattr(row, f) for f in _EDITABLE}
    current["allowed_roles"] = sorted(set(row.allowed_roles or []))
    values = {**current, **patch}
    tested = None if any(values[f] != current[f] for f in _RETEST) else row.last_test_ok
    _check_merged(values, row.private_key_ciphertext is not None, tested)
    for field, value in patch.items():
        setattr(row, field, value)
    row.last_test_ok, row.updated_by_user_id = tested, user.id
    return await _saved(db, row)


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(provider_id: int, db: Session = Depends(get_db), _u=Depends(require_admin)):
    row = _load(db, provider_id)
    if db.scalar(select(AiChat.id).where(AiChat.provider_id == provider_id).limit(1)) is not None:
        raise _fail(409, "provider_in_use")  # archived chats count: they keep the approval record
    slug = row.slug
    db.delete(row)
    try:
        db.commit()
    except IntegrityError:  # a chat was created after the check above: the foreign key refuses
        db.rollback()
        raise _fail(409, "provider_in_use") from None
    await sessions.MANAGER.close_provider(provider_id)
    transport.KEYFILES.drop(slug)  # after the close: the plaintext key does not outlive the provider
    return Response(status_code=204)


@router.post("/{provider_id}/key", response_model=ProviderOut)
async def generate_key(provider_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    """A new Ed25519 key replaces any old one. The private half is stored encrypted and never leaves this function."""
    _need_keys()
    row = _load(db, provider_id)
    pem, row.public_key = transport.generate_keypair()
    row.private_key_ciphertext = transport.encrypt_private(pem)
    row.key_created_at, row.last_test_ok, row.updated_by_user_id = _utcnow(), None, user.id
    if "standard" in (row.allowed_roles or []):
        row.enabled = False  # the old key's test no longer holds: disable, install the new key, test, enable
    out = await _saved(db, row)
    transport.KEYFILES.drop(out.slug)  # after the close: the old plaintext key goes now, the next spawn writes the new
    return out


@router.post("/{provider_id}/test", response_model=TestResult)
async def test_connection(provider_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = _load(db, provider_id)
    snapshot, edited_at = sessions.ProviderSnapshot.from_row(row), row.updated_at
    # `user` is on this same session (get_current_user shares get_db), and the commit expires it: reading `user.id`
    # afterwards would open a transaction that stays open for the whole agent run.
    user_id = user.id
    db.commit()  # ends the read transaction: its connection goes back to the pool, not held across the agent
    out = await _run_test(snapshot, user_id)
    fresh = db.get(AcpProvider, provider_id)
    # A provider edited or deleted meanwhile is not the one that was tested: the result goes back, but is not
    # recorded. `updated_at` catches any admin write (the snapshot has no `enabled`), the snapshot what was tested.
    if fresh is not None and fresh.updated_at == edited_at and sessions.ProviderSnapshot.from_row(fresh) == snapshot:
        db.execute(update(AcpProvider).where(AcpProvider.id == provider_id).values(
            last_test_at=_utcnow(), last_test_ok=out["ok"], last_test_error=out["error"],
            updated_at=AcpProvider.updated_at,  # "last edited by an admin" is not a test
        ).execution_options(synchronize_session=False))
        db.commit()
    return out


# ---- Test connection ----------------------------------------------------------------------------

def _ms(since: float) -> int:
    return round((time.monotonic() - since) * 1000)


async def _probe(session: sessions.LiveSession, out: dict[str, Any]) -> None:
    """The steps, in order, each timed. `out` is filled as it goes, so a timeout keeps what was learned."""
    timings = out["timings_ms"]
    t = time.monotonic()
    await session.start()  # also runs `record_connect`: last_agent_info and last_capabilities are stored here
    timings["connect"] = _ms(t)
    out["agent_info"], out["capabilities"] = sessions._dump(session.agent_info), sessions._dump(session.capabilities)
    t = time.monotonic()
    await session._new_session(recap=False)  # not `attach`: that would probe `/tools` a second time
    timings["new_session"] = _ms(t)
    t = time.monotonic()
    names = await session.list_tools()
    timings["tools"] = _ms(t)
    out["tools"] = names or []
    out["error"] = context.check_tools(names, list(session.provider.allowed_roles))
    out["ok"] = out["error"] is None


async def _run_test(snapshot: sessions.ProviderSnapshot, user_id: int) -> dict[str, Any]:
    """A throwaway session: not in the manager, so it does not count toward `max_sessions`, and with no chat it
    publishes nothing. Works on a disabled provider, which is how a provider becomes ready."""
    out: dict[str, Any] = {"ok": False, "error": None, "stderr_tail": None, "timings_ms": dict.fromkeys(_STEPS),
                           "agent_info": None, "capabilities": None, "tools": []}
    session = sessions.LiveSession(None, user_id, snapshot)
    carried: list[str] = []  # why the agent never started, when no process was there to write stderr
    try:
        await asyncio.wait_for(_probe(session, out), TEST_TIMEOUT_S)
    except TimeoutError:
        out["error"] = "Test connection timed out."
    except sessions.AgentUnreachable as exc:
        out["error"], carried = "Could not connect.", exc.stderr_tail
    except store.KeysNotConfigured:
        raise _fail(503, "keys_not_configured") from None
    except Exception as exc:
        if isinstance(exc, ValueError) and session.proc is None:  # raised by the spawn command, before any process
            out["error"] = "The stored host key is not valid."
        else:
            logger.warning("ai_chat.test_failed provider=%s error=%s", snapshot.id, type(exc).__name__)
            out["error"] = "Test connection failed."
    finally:
        # Outside the timeout, and in a held task: a caller that goes away must not cancel the close, which sends
        # session/cancel before EOF and reaps the process.
        await asyncio.wait({sessions.MANAGER._spawn(session.close())})
    if not out["ok"]:  # read after the close, when the drain has reached EOF. Admins only: it can name hosts and paths.
        out["stderr_tail"] = [line[:_STDERR_LINE_MAX] for line in session.stderr_tail or carried]
    return out
