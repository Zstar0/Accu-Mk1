"""Test-only path shim.

backend/main.py uses bare imports (`from database import ...`, `from auth import ...`)
because it's executed with uvicorn's CWD set to backend/. When pytest runs from the
repo root, `backend/` is not on sys.path, so `from backend.main import app` fails
when main.py tries to `from database import get_db`.

Prepending the absolute path to `backend/` to sys.path resolves the bare imports
without touching main.py's existing import style. Scoped to tests; does not
affect production execution.
"""
import dataclasses
import os
import sys

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)


@pytest.fixture
def db_session():
    """In-memory SQLite session for unit tests. Mirrors the local `db` fixtures
    used in test_sub_samples_service.py and test_sub_samples_integration.py."""
    from database import Base
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


FAKE_ACP_AGENT = os.path.join(os.path.dirname(__file__), "fixtures", "fake_acp_agent.py")


@pytest.fixture
def ai_chat_db(tmp_path, monkeypatch):
    """A file SQLite database for the AI chat tests (turn writes run in `to_thread` workers beside route reads).

    Seeds admin user 1, enabled provider 1 ("jarvis": real host key, private key encrypted under a fresh
    INTEGRATION_KEYS_SECRET, roles ["admin"]) and chat 1 of user 1. Yields the sessionmaker.
    """
    from datetime import datetime

    from cryptography.fernet import Fernet

    import models
    from ai_chat import transport
    from ai_chat.models import AcpProvider, AiChat, AiChatMessage
    from database import Base

    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())
    engine = create_engine(f"sqlite:///{tmp_path.as_posix()}/ai_chat.db", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[m.__table__ for m in (models.User, AcpProvider, AiChat, AiChatMessage)])
    Session = sessionmaker(bind=engine)
    pem, public = transport.generate_keypair()
    with Session() as s:
        # created_at is set so the User column default (`datetime.utcnow`, deprecated) never fires.
        s.add(models.User(id=1, email="admin@example.com", hashed_password="x", role="admin",
                          created_at=datetime(2026, 1, 1)))
        s.add(AcpProvider(id=1, slug="jarvis", display_name="Jarvis", enabled=True, ssh_host="192.0.2.10",
                          ssh_user="hermes-tars", host_key=transport.generate_keypair()[1],
                          launcher_path="/opt/mk1-acp/launch", authorized_from="192.0.2.20",
                          session_cwd="/home/hermes-tars", private_key_ciphertext=transport.encrypt_private(pem),
                          public_key=public, allowed_roles=["admin"]))
        s.add(AiChat(id=1, user_id=1, provider_id=1))
        s.commit()
    yield Session
    engine.dispose()


class AiChatEnv:
    """What the ai_chat session tests drive: the fake agent's flags, provider snapshots, published events."""

    def __init__(self, Session, sub):
        self.Session = Session
        self.flags: list[str] = []  # appended to `[sys.executable, FAKE_ACP_AGENT]` at each spawn
        self._sub = sub
        self._seen: list[dict] = []

    def provider(self, **over):
        """Provider 1 as a `ProviderSnapshot`, with `over` replacing fields (e.g. allowed_roles=("standard",))."""
        from ai_chat import sessions
        from ai_chat.models import AcpProvider
        with self.Session() as s:
            snapshot = sessions.ProviderSnapshot.from_row(s.get(AcpProvider, 1))
        return dataclasses.replace(snapshot, **over)

    def session(self, chat_id=1, **over):
        """A `LiveSession` for user 1 (not started)."""
        from ai_chat import sessions
        return sessions.LiveSession(chat_id, 1, self.provider(**over))

    def events(self) -> list[dict]:
        """Every event published to user 1 since the fixture started, oldest first."""
        while not self._sub.queue.empty():
            self._seen.append(self._sub.queue.get_nowait())
        return list(self._seen)


@pytest.fixture
async def ai_chat_env(ai_chat_db, monkeypatch):
    """`ai_chat_db` plus: sessions use it and spawn the fake ACP agent, and fresh hub and approval registries.

    Every `LiveSession` the test creates is tracked and closed at teardown, so each owner task is done and each
    agent process reaped before the event loop closes.
    """
    import anyio

    from ai_chat import approvals, hub, sessions

    monkeypatch.setattr(sessions, "_session_factory", ai_chat_db)
    monkeypatch.setattr(hub, "HUB", hub.EventHub())
    monkeypatch.setattr(approvals, "APPROVALS", approvals.ApprovalRegistry())
    monkeypatch.setattr(sessions, "MANAGER", sessions.SessionManager())
    env = AiChatEnv(ai_chat_db, hub.HUB.subscribe(1, None))
    monkeypatch.setattr(sessions, "spawn_command", lambda provider: [sys.executable, FAKE_ACP_AGENT, *env.flags])
    created = []
    init = sessions.LiveSession.__init__

    def tracked(self, *args, **kwargs):
        init(self, *args, **kwargs)
        created.append(self)

    monkeypatch.setattr(sessions.LiveSession, "__init__", tracked)
    yield env
    timed_out = None
    try:
        with anyio.fail_after(30):
            await sessions.MANAGER.close_all()  # turn tasks, background closes and the reaper
    except TimeoutError as exc:
        timed_out = exc
    for live in created:  # every one of them, so one stuck session cannot strand the rest
        try:
            with anyio.fail_after(15):
                await live.close()
        except TimeoutError as exc:
            timed_out = exc
    if timed_out is not None:
        raise timed_out


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "integration: live-SENAITE integration test. Skipped by default; "
        "run explicitly with `-m integration`.",
    )
    config.addinivalue_line(
        "markers",
        "parity: adapter-vs-coabuilder conformance parity (needs COABUILDER_SRC).",
    )


def pytest_collection_modifyitems(config, items):
    """Skip integration-marked tests unless the user explicitly opted in
    via `-m integration` (or any expression that mentions it, e.g.
    `-m "integration or unit"`). A bare run with no `-m` skips them."""
    markexpr = config.getoption("markexpr") or ""
    if "integration" in markexpr:
        return
    skip_integration = pytest.mark.skip(
        reason="integration test (run with `-m integration` to enable)"
    )
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip_integration)
