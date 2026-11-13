"""/api/ui-settings/{key}: per-user page layout settings (spec 2026-10-27 tasks page, section 5).

The user is always the session user; there is no user id in the path.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import UserUiSetting

router = APIRouter(prefix="/api/ui-settings", tags=["ui-settings"])

ALLOWED_KEYS = frozenset({"tasks.page"})
MAX_BYTES = 16384


class UiSettingIn(BaseModel):
    value: dict[str, Any]


class UiSettingOut(BaseModel):
    key: str
    # Free dict on purpose: a typed model would silently drop keys the frontend adds later.
    value: dict[str, Any] | None


def _check_key(key: str) -> None:
    if key not in ALLOWED_KEYS:
        raise HTTPException(status_code=400, detail="unknown settings key")


def _row(db: Session, user_id: int, key: str) -> UserUiSetting | None:
    return db.query(UserUiSetting).filter_by(user_id=user_id, key=key).one_or_none()


@router.get("/{key}", response_model=UiSettingOut)
def get_setting(key: str, db: Session = Depends(get_db), user=Depends(get_current_user)) -> UiSettingOut:
    _check_key(key)
    row = _row(db, user.id, key)
    return UiSettingOut(key=key, value=row.value if row else None)


@router.put("/{key}", response_model=UiSettingOut)
def put_setting(key: str, body: UiSettingIn, db: Session = Depends(get_db),
                user=Depends(get_current_user)) -> UiSettingOut:
    _check_key(key)
    if len(json.dumps(body.value, separators=(",", ":")).encode()) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="settings value too large")
    # ponytail: select-then-write; two concurrent FIRST saves of one key hit the unique
    # constraint and 500 (the page toasts, the next save lands). Use ON CONFLICT if that shows up.
    row = _row(db, user.id, key)
    if row is None:
        row = UserUiSetting(user_id=user.id, key=key)
        db.add(row)
    row.value = body.value
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return UiSettingOut(key=key, value=row.value)
