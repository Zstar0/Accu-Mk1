"""/admin/integrations: set, test, clear third-party API keys (spec section 4). Admin only; values never returned."""
from __future__ import annotations

from typing import Literal, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_admin
from database import get_db
from integration_keys import registry, store

router = APIRouter(prefix="/admin/integrations", tags=["integration-keys"])
_transport: httpx.BaseTransport | None = None  # tests inject a MockTransport
MAX_LEN = 512


class KeyStatus(BaseModel):
    name: str
    label: str
    source: Literal["settings", "env", "none"]
    last4: Optional[str] = None
    updated_by_name: Optional[str] = None
    updated_at: Optional[str] = None
    undecryptable: bool = False


class KeyList(BaseModel):
    configured: bool
    keys: list[KeyStatus]


class SaveBody(BaseModel):
    value: str  # no pydantic constraint: its 422 echoes the input, and this field is a secret


class TestResult(BaseModel):
    ok: bool
    outcome: Literal["ok", "rejected", "unavailable", "not_set"]


def _known(name: str) -> None:
    if name not in registry.PROVIDERS:
        raise HTTPException(status_code=404, detail={"code": "unknown_key"})


@router.get("", response_model=KeyList)
def list_keys(db: Session = Depends(get_db), _u=Depends(require_admin)):
    return {"configured": store.configured(), "keys": [store.status(db, n) for n in registry.PROVIDERS]}


@router.put("/{name}", response_model=KeyStatus)
def save_key(name: str, body: SaveBody, db: Session = Depends(get_db), user=Depends(require_admin)):
    _known(name)
    if not store.configured():
        raise HTTPException(status_code=503, detail={"code": "keys_not_configured"})
    value = body.value.strip()
    # Printable ASCII only: httpx cannot send anything else in a header, and stray whitespace is a paste error.
    if not value or len(value) > MAX_LEN or not all(33 <= ord(ch) <= 126 for ch in value):
        raise HTTPException(status_code=422, detail={"code": "invalid_input"})
    outcome = registry.run_test(name, value, _transport)
    if outcome != "ok":
        store.event(db, name, "set", user.id, outcome)
        db.commit()
        if outcome == "rejected":
            raise HTTPException(status_code=422, detail={"code": "key_rejected"})
        raise HTTPException(status_code=502, detail={"code": "provider_unavailable"})
    try:
        store.save(db, name, value, user.id)
    except store.KeysNotConfigured:
        raise HTTPException(status_code=503, detail={"code": "keys_not_configured"})
    return store.status(db, name)


@router.post("/{name}/test", response_model=TestResult)
def test_key(name: str, db: Session = Depends(get_db), user=Depends(require_admin)):
    _known(name)
    key = store.get(name)
    if not key:
        return {"ok": False, "outcome": "not_set"}
    outcome = registry.run_test(name, key, _transport)
    store.event(db, name, "tested", user.id, outcome)
    db.commit()
    return {"ok": outcome == "ok", "outcome": outcome}


@router.delete("/{name}", response_model=KeyStatus)
def clear_key(name: str, db: Session = Depends(get_db), user=Depends(require_admin)):
    _known(name)
    store.clear(db, name, user.id)
    return store.status(db, name)
