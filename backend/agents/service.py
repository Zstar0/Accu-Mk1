"""Creating and managing agent users (spec 2026-10-12 sections 3.1, 4). Keys are returned to the
caller exactly once and never stored; callers commit through these functions."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from agents import keys
from agents.models import AgentCredential

logger = logging.getLogger(__name__)


class AgentError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status, self.code = status, code


def _clean_username(raw: str) -> str:
    username = (raw or "").strip().lower()
    if not keys.USERNAME_RE.match(username):
        raise AgentError(400, "invalid_username")
    from documents.routes import _agent_tokens
    if username in _agent_tokens():
        raise AgentError(409, "name_taken")  # one name never means two principals
    return username


def _clean_display(raw: Optional[str]) -> str:
    name = (raw or "").strip()
    if not name or len(name) > 100:
        raise AgentError(400, "invalid_display_name")
    return name


def create_agent(db, *, username: str, display_name: str, lab_tools: bool = False,
                 coa_publishing: bool = False, created_by_user_id: Optional[int] = None):
    from models import User
    from auth import get_password_hash
    username = _clean_username(username)
    display = _clean_display(display_name)
    if coa_publishing and not lab_tools:
        raise AgentError(400, "coa_needs_lab")
    if db.query(User).filter(User.email == keys.email_for(username)).first() is not None:
        raise AgentError(409, "name_taken")
    secret = keys.new_secret()
    user = User(email=keys.email_for(username), role="agent", is_active=True, first_name=display,
                # bcrypt of a discarded secret: verify_password never matches and never errors
                hashed_password=get_password_hash(keys.new_secret()))
    db.add(user)
    db.flush()
    db.add(AgentCredential(user_id=user.id, key_hash=keys.hash_secret(secret), key_hint=keys.hint(secret),
                           lab_tools=lab_tools, coa_publishing=coa_publishing,
                           created_by_user_id=created_by_user_id))
    db.commit()
    db.refresh(user)
    logger.info("agents.created username=%s by=%s lab=%s coa=%s", username, created_by_user_id,
                lab_tools, coa_publishing)
    return user, keys.wire_key(username, secret)


def get_agent(db, agent_id: int):
    from models import User
    user = db.get(User, int(agent_id))
    cred = db.get(AgentCredential, int(agent_id)) if user is not None else None
    if user is None or user.role != "agent" or cred is None:
        raise AgentError(404, "unknown_agent")
    return user, cred


def list_agents(db):
    from models import User
    users = db.execute(select(User).where(User.role == "agent").order_by(User.email)).scalars().all()
    return [(u, db.get(AgentCredential, u.id)) for u in users]


def update_agent(db, agent_id: int, *, display_name=None, is_active=None, lab_tools=None,
                 coa_publishing=None):
    user, cred = get_agent(db, agent_id)
    display = _clean_display(display_name) if display_name is not None else None
    lab = cred.lab_tools if lab_tools is None else bool(lab_tools)
    coa = cred.coa_publishing if coa_publishing is None else bool(coa_publishing)
    if coa_publishing and not lab:
        raise AgentError(400, "coa_needs_lab")
    if not lab:
        coa = False  # Lab tools off takes COA publishing with it
    if display is not None:
        user.first_name = display
    if is_active is not None:
        user.is_active = bool(is_active)
    cred.lab_tools, cred.coa_publishing = lab, coa
    db.commit()
    logger.info("agents.updated username=%s active=%s lab=%s coa=%s", keys.username_of(user),
                user.is_active, lab, coa)
    return user, cred


def rotate_key(db, agent_id: int):
    user, cred = get_agent(db, agent_id)
    secret = keys.new_secret()
    cred.key_hash, cred.key_hint, cred.rotated_at = keys.hash_secret(secret), keys.hint(secret), datetime.utcnow()
    db.commit()
    logger.info("agents.key_rotated username=%s", keys.username_of(user))
    return user, cred, keys.wire_key(keys.username_of(user), secret)


def group_ids(db, user_id: int) -> list[int]:
    from groups.models import UserGroupMember
    return sorted(db.execute(select(UserGroupMember.group_id)
                             .where(UserGroupMember.user_id == user_id)).scalars())


def set_groups(db, agent_id: int, wanted: list[int]) -> list[int]:
    """Replace the agent's group memberships. Every id must be an ACTIVE group."""
    from groups.models import UserGroup, UserGroupMember
    user, _ = get_agent(db, agent_id)
    ids = sorted(set(int(g) for g in wanted))
    if ids:
        ok = set(db.execute(select(UserGroup.id).where(UserGroup.id.in_(ids),
                                                       UserGroup.is_active.is_(True))).scalars())
        if set(ids) - ok:
            raise AgentError(400, "unknown_group")
    db.query(UserGroupMember).filter(UserGroupMember.user_id == user.id).delete()
    db.add_all([UserGroupMember(group_id=g, user_id=user.id) for g in ids])
    db.commit()
    return ids
