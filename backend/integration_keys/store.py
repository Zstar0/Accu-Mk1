"""Encrypted storage, the key resolver and the audit for integration keys (spec 3.2, 3.3)."""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from database import SessionLocal
from integration_keys.registry import PROVIDERS
from models import IntegrationKey, IntegrationKeyEvent, User

logger = logging.getLogger(__name__)
CACHE_TTL = 60.0
_session_factory = SessionLocal
_clock = time.monotonic
_lock = threading.Lock()
_cache: dict[str, tuple[float, str | None, bool]] = {}  # name -> (at, decrypted stored value, undecryptable)
_warned: set[str] = set()


class KeysNotConfigured(Exception):
    """INTEGRATION_KEYS_SECRET is missing or not a valid Fernet key."""


def _fernet() -> Fernet | None:
    raw = (os.environ.get("INTEGRATION_KEYS_SECRET") or "").strip()
    if not raw:
        return None
    try:
        return Fernet(raw.encode())
    except (ValueError, TypeError):
        logger.warning("integration_keys.bad_secret")
        return None


def configured() -> bool:
    return _fernet() is not None


def _env(name: str) -> str | None:
    return (os.environ.get(name) or "").strip() or None


def _decrypt(token: str | None) -> tuple[str | None, bool]:
    """(value, undecryptable). No token is (None, False)."""
    if not token:
        return None, False
    f = _fernet()
    if f is None:
        return None, True
    try:
        return f.decrypt(token.encode()).decode(), False
    except InvalidToken:
        return None, True


def _stored(name: str) -> tuple[str | None, bool]:
    if not configured():  # feature off: env only, never touch the DB
        return None, False
    with _lock:
        hit = _cache.get(name)
        if hit and _clock() - hit[0] < CACHE_TTL:
            return hit[1], hit[2]
    try:
        with _session_factory() as db:
            row = db.get(IntegrationKey, name)
            token = row.ciphertext if row else None
    except SQLAlchemyError:
        logger.warning("integration_keys.db_unavailable name=%s", name)
        return None, False  # not cached: the stored key wins again once the DB is back
    value, bad = _decrypt(token)
    if bad and name not in _warned:
        _warned.add(name)
        logger.warning("integration_keys.undecryptable name=%s", name)
    with _lock:
        _cache[name] = (_clock(), value, bad)
    return value, bad


def get(name: str) -> str | None:
    """The key in effect: saved in Settings, else the server env, else None."""
    value, _ = _stored(name)
    return value or _env(name)


def drop_cache() -> None:
    with _lock:
        _cache.clear()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def event(db: Session, name: str, action: str, user_id: int, outcome: str) -> None:
    db.add(IntegrationKeyEvent(at=_now(), name=name, action=action, user_id=user_id, outcome=outcome))


def save(db: Session, name: str, value: str, user_id: int) -> None:
    f = _fernet()
    if f is None:
        raise KeysNotConfigured()
    row = db.get(IntegrationKey, name) or IntegrationKey(name=name)
    row.ciphertext = f.encrypt(value.encode()).decode()
    row.last4, row.updated_by, row.updated_at = value[-4:], user_id, _now()
    db.add(row)
    event(db, name, "set", user_id, "ok")
    db.commit()
    drop_cache()


def clear(db: Session, name: str, user_id: int) -> None:
    row = db.get(IntegrationKey, name)
    if row is not None:
        db.delete(row)
    event(db, name, "cleared", user_id, "ok")
    db.commit()
    drop_cache()


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    dt = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)  # SQLite returns naive datetimes
    return dt.isoformat().replace("+00:00", "Z")


def status(db: Session, name: str) -> dict[str, Any]:
    row = db.get(IntegrationKey, name)
    _, bad = _decrypt(row.ciphertext if row else None)
    out: dict[str, Any] = {"name": name, "label": PROVIDERS[name].label, "source": "none", "last4": None,
                           "updated_by_name": None, "updated_at": None, "undecryptable": bad}
    if row is not None and not bad:
        user = db.get(User, row.updated_by)
        who = " ".join(x for x in (getattr(user, "first_name", None), getattr(user, "last_name", None)) if x)
        out.update(source="settings", last4=row.last4, updated_by_name=who or getattr(user, "email", None),
                   updated_at=_iso(row.updated_at))
    elif env := _env(name):
        out.update(source="env", last4=env[-4:])
    return out
