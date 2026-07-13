"""Capture-token business logic: mint/resolve/revoke + session photo count.

Raw tokens are 256-bit urlsafe strings that exist only in the QR URL; the DB
stores their SHA-256. Scope (sample list + display context) freezes at mint.
"""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from models import LimsCaptureToken, LimsPackagingPhoto

CAPTURE_TOKEN_TTL_HOURS = 2
MAX_PHOTOS_PER_TOKEN = 50
MAX_SAMPLES_PER_TOKEN = 50


class UnknownTokenError(Exception):
    pass


class GoneTokenError(Exception):
    """Expired or revoked — the token existed but is no longer usable."""


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def mint_capture_token(
    db: Session, samples: list[dict], order_label: Optional[str], user_id: int,
) -> tuple[LimsCaptureToken, str]:
    raw = secrets.token_urlsafe(32)
    tok = LimsCaptureToken(
        token_hash=_hash(raw),
        order_label=order_label,
        context_json=json.dumps(samples),
        created_by_user_id=user_id,
        expires_at=datetime.utcnow() + timedelta(hours=CAPTURE_TOKEN_TTL_HOURS),
    )
    db.add(tok)
    db.commit()
    db.refresh(tok)
    return tok, raw


def resolve_capture_token(db: Session, raw: str) -> LimsCaptureToken:
    tok = db.execute(
        select(LimsCaptureToken).where(LimsCaptureToken.token_hash == _hash(raw))
    ).scalar_one_or_none()
    if tok is None:
        raise UnknownTokenError("unknown capture token")
    if tok.revoked_at is not None or tok.expires_at <= datetime.utcnow():
        raise GoneTokenError("capture token expired or revoked")
    return tok


def revoke_capture_token(db: Session, token_id: int) -> bool:
    tok = db.get(LimsCaptureToken, token_id)
    if tok is None:
        return False
    if tok.revoked_at is None:
        tok.revoked_at = datetime.utcnow()
        db.commit()
    return True


def token_photo_count(db: Session, token: LimsCaptureToken) -> int:
    rows = db.execute(
        select(func.count(LimsPackagingPhoto.id))
        .where(LimsPackagingPhoto.capture_token_id == token.id)
    ).scalar_one()
    samples = json.loads(token.context_json)
    return rows // max(1, len(samples))
