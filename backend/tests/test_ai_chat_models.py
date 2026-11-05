"""AI chat tables (spec 2026-11-02 section 5): created by create_all, with the pinned defaults."""
from datetime import datetime

import pytest
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError

import models  # noqa: F401  (registers users so the FKs resolve on Base)
from ai_chat.models import AcpProvider, AiChat, AiChatMessage


def _user():
    # created_at is set so the User column default (`datetime.utcnow`, deprecated) never fires.
    return models.User(email="a@example.com", hashed_password="x",
                       created_at=datetime(2026, 1, 1))


def _provider(**over):
    fields = dict(slug="jarvis", display_name="Jarvis", ssh_host="100.68.141.122",
                  ssh_user="hermes-tars", launcher_path="/opt/x",
                  authorized_from="100.120.92.93", session_cwd="/tmp")
    fields.update(over)
    return AcpProvider(**fields)


def test_tables_created_by_create_all(db_session):
    names = set(inspect(db_session.bind).get_table_names())
    assert {"acp_providers", "ai_chats", "ai_chat_messages"} <= names


def test_provider_defaults(db_session):
    p = _provider()
    db_session.add(p)
    db_session.commit()
    assert (p.enabled, p.ssh_port, p.allowed_roles, p.max_sessions, p.permission_timeout_s) == (
        False, 22, ["admin"], 4, 240)
    assert (p.inject_mk1_tools, p.idle_minutes, p.agent_approval_timeout_s) == (False, 15, 300)
    for col in ("private_key_ciphertext", "public_key", "host_key", "key_created_at",
                "last_test_at", "last_test_ok", "last_test_error", "last_agent_info",
                "last_capabilities"):
        assert getattr(p, col) is None, col


def test_provider_slug_unique(db_session):
    db_session.add(_provider())
    db_session.commit()
    db_session.add(_provider(display_name="Other"))
    with pytest.raises(IntegrityError):
        db_session.commit()


def test_chat_defaults(db_session):
    user = _user()
    p = _provider()
    db_session.add_all([user, p])
    db_session.commit()
    chat = AiChat(user_id=user.id, provider_id=p.id)
    db_session.add(chat)
    db_session.commit()
    assert (chat.title, chat.acp_session_id, chat.archived) == ("", None, False)
    assert chat.created_at is not None and chat.updated_at is not None
    assert "ix_ai_chats_user_updated" in {
        i["name"] for i in inspect(db_session.bind).get_indexes("ai_chats")}


def test_message_defaults(db_session):
    user = _user()
    p = _provider()
    db_session.add_all([user, p])
    db_session.commit()
    chat = AiChat(user_id=user.id, provider_id=p.id)
    db_session.add(chat)
    db_session.commit()
    m = AiChatMessage(chat_id=chat.id, seq=1, role="user")
    db_session.add(m)
    db_session.commit()
    assert (m.text, m.meta) == ("", None)
    assert m.created_at is not None


def test_message_seq_unique_per_chat(db_session):
    user = _user()
    p = _provider()
    db_session.add_all([user, p])
    db_session.commit()
    c1 = AiChat(user_id=user.id, provider_id=p.id)
    c2 = AiChat(user_id=user.id, provider_id=p.id)
    db_session.add_all([c1, c2])
    db_session.commit()
    db_session.add(AiChatMessage(chat_id=c1.id, seq=1, role="user", text="hi"))
    db_session.add(AiChatMessage(chat_id=c2.id, seq=1, role="user", text="same seq, other chat"))
    db_session.commit()  # the same seq in a different chat is fine
    db_session.add(AiChatMessage(chat_id=c1.id, seq=1, role="assistant", text="dup"))
    with pytest.raises(IntegrityError):
        db_session.commit()
