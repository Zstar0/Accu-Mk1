"""Resolving an agent key (spec 2026-10-12 sections 3.3, 3.4). Every failure to authenticate is
the same 401; an authenticated agent off its allow-list, or with no matched route, is 403."""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta

from fastapi import HTTPException, status

from agents import access, keys

logger = logging.getLogger(__name__)
DENIED = "agent keys cannot use this endpoint"
_TOUCH_EVERY = timedelta(minutes=5)
_NO_HASH = "0" * 64  # compared when the name is unknown, so both paths do the same work


def _invalid() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid agent key",
                         headers={"WWW-Authenticate": "Bearer"})


def resolve(db, token: str):
    """(user, credential) for a valid key of an ACTIVE agent; 401 otherwise."""
    from models import User
    from agents.models import AgentCredential
    parsed = keys.parse(token)
    if parsed is None:
        raise _invalid()
    username, secret = parsed
    user = (db.query(User)
            .filter(User.email == keys.email_for(username), User.role == "agent").first())
    cred = db.get(AgentCredential, user.id) if user is not None else None
    match = secrets.compare_digest(keys.hash_secret(secret), cred.key_hash if cred else _NO_HASH)
    if not (match and cred is not None and user.is_active):
        logger.warning("agents.auth_failed username=%s", username[:40])
        raise _invalid()
    now = datetime.utcnow()
    if cred.last_used_at is None or now - cred.last_used_at > _TOUCH_EVERY:
        cred.last_used_at = now
        db.commit()
    return user, cred


def agent_for_route(db, token: str, request):
    """The agent's user row, only on a route its scopes allow. No request or no matched route
    (a direct call outside FastAPI dependency injection) is refused: fail closed."""
    user, cred = resolve(db, token)
    route = request.scope.get("route") if request is not None else None
    template = getattr(route, "path", None)
    if template is None or not access.allowed(access.scopes_for(cred), request.method, template):
        raise HTTPException(status.HTTP_403_FORBIDDEN, DENIED)
    return user
