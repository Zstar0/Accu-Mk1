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


# ── the fence ─────────────────────────────────────────────────

def _token_for(u):
    import auth
    return auth.create_access_token({"sub": str(u.id)})


def test_finance_user_refused_by_lab_resolver(db_session):
    import auth
    u = _user(db_session, "fin@test", scope="finance")
    with pytest.raises(HTTPException) as e:
        auth.get_current_user(token=_token_for(u), db=db_session)
    assert e.value.status_code == 403


@pytest.mark.parametrize("scope", ["lab", "both"])
def test_lab_scopes_pass_lab_resolver(db_session, scope):
    import auth
    u = _user(db_session, f"{scope}@test", scope=scope)
    assert auth.get_current_user(token=_token_for(u), db=db_session).id == u.id


def test_any_scope_resolver_accepts_finance(db_session):
    import auth
    u = _user(db_session, "fin2@test", scope="finance")
    assert auth.get_current_user_any_scope(token=_token_for(u), db=db_session).id == u.id


def test_any_scope_resolver_still_refuses_inactive(db_session):
    import auth
    u = _user(db_session, "gone@test", scope="finance")
    u.is_active = False; db_session.commit()
    with pytest.raises(HTTPException) as e:
        auth.get_current_user_any_scope(token=_token_for(u), db=db_session)
    assert e.value.status_code == 401
