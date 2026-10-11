"""The Plain seat is the permission (spec 3.1): a Mk1 user may act when their login email is an active Plain user."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException

from auth import get_current_user
from support_plain import queries, rules, service
from support_plain.client import SupportNotConfigured, SupportUnavailable

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Seat:
    plain_user_id: str
    full_name: str
    public_name: str
    email: str


@dataclass(frozen=True)
class SeatUser:
    user: Any
    seat: Seat


def resolve(email: object) -> Seat | None:
    if not isinstance(email, str) or not email.strip():
        return None
    e = email.strip().lower()

    def load() -> Seat | None:
        try:
            u = service._client_factory().query(queries.USER_BY_EMAIL, {"email": e})["userByEmail"]
            if not u or u.get("isDeleted"):
                return None
            return Seat(u["id"], u["fullName"], u.get("publicName") or u["fullName"], u["email"])
        except (KeyError, TypeError) as err:
            raise SupportUnavailable("bad_shape") from err

    found, _ = service.CACHE.get_or_load(f"seat:{e}", rules.SEAT_TTL, load)
    return found


def require_seat(user=Depends(get_current_user)) -> SeatUser:
    try:
        found = resolve(getattr(user, "email", None))
    except SupportNotConfigured:
        raise HTTPException(status_code=503, detail={"code": "support_not_configured"})
    except SupportUnavailable:  # fail closed
        raise HTTPException(status_code=502, detail={"code": "support_unavailable"})
    if found is None:
        raise HTTPException(status_code=403, detail={"code": "no_plain_seat"})
    return SeatUser(user, found)


def require_support_reader(user=Depends(get_current_user)):
    if user.role == "admin":
        return user
    try:
        found = resolve(getattr(user, "email", None))
    except (SupportNotConfigured, SupportUnavailable):
        found = None
    if found is None:
        raise HTTPException(status_code=403, detail="Admin access or a Plain seat required")
    return user
