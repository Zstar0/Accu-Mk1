"""Finance scope: the users.scope column, the lab fence at get_current_user,
identity claims in the token, and the routes that carry scope. Pure tests on
the in-memory SQLite fixture — no Postgres, no network."""
import pytest
from fastapi import HTTPException

from models import User


def _user(db, email, scope=None, role="standard", **fields):
    kw = {"email": email, "hashed_password": "x", "role": role, "is_active": True, **fields}
    if scope is not None:
        kw["scope"] = scope
    u = User(**kw)
    db.add(u); db.commit(); db.refresh(u)
    return u


def test_scope_defaults_to_lab(db_session):
    assert _user(db_session, "a@lab.test").scope == "lab"


def test_scope_can_be_finance(db_session):
    assert _user(db_session, "f@fin.test", scope="finance").scope == "finance"
