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


# ── token claims ──────────────────────────────────────────────────

def test_token_claims_carry_identity(db_session):
    import auth
    from jose import jwt
    u = _user(db_session, "c@test", scope="finance", first_name="Ada", last_name="Lovelace")
    tok = auth.create_access_token(auth.token_claims_for(u))
    c = jwt.decode(tok, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])
    assert c["sub"] == str(u.id)
    assert c["email"] == "c@test" and c["scope"] == "finance" and c["role"] == "standard"
    assert c["first_name"] == "Ada" and c["last_name"] == "Lovelace"
    assert "exp" in c


# ── routes ────────────────────────────────────────────────────
# Real tokens through the real resolvers; only get_db is overridden so the
# handlers see the in-memory session. Mirrors test_user_name_endpoints.py's
# save/restore of dependency_overrides.

from fastapi.testclient import TestClient
from database import get_db
from main import app


@pytest.fixture
def db_session():
    """Module-local override of conftest's db_session: StaticPool +
    check_same_thread=False, because the route tests below share this session
    with TestClient's worker threads (FastAPI resolves sync deps off-thread).
    conftest's plain sqlite:///:memory: engine (SingletonThreadPool,
    check_same_thread=True) raises 'SQLite objects created in a thread can
    only be used in that same thread' the moment a request handler touches it
    from the threadpool. The 8 pre-existing tests in this module call auth.py
    functions directly (single-threaded), so this is behaviorally identical
    for them."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from database import Base
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(db_session):
    def _override_db():
        yield db_session
    prev = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_db
    yield TestClient(app)
    if prev is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev


def _bearer(u):
    return {"Authorization": f"Bearer {_token_for(u)}"}


def test_finance_user_can_read_self_and_directory(client, db_session):
    u = _user(db_session, "fin@test", scope="finance")
    r = client.get("/auth/me", headers=_bearer(u))
    assert r.status_code == 200, r.text
    assert r.json()["scope"] == "finance"
    r = client.get("/auth/directory", headers=_bearer(u))
    assert r.status_code == 200, r.text
    assert any(d["email"] == "fin@test" for d in r.json())


def test_finance_user_refused_by_lab_admin_route(client, db_session):
    u = _user(db_session, "fin@test", scope="finance", role="admin")
    r = client.get("/auth/users", headers=_bearer(u))
    assert r.status_code == 403, r.text


def test_admin_creates_finance_user(client, db_session):
    admin = _user(db_session, "admin@lab.test", role="admin")
    r = client.post("/auth/users", headers=_bearer(admin),
                    json={"email": "new@fin.test", "password": "longenough", "scope": "finance"})
    assert r.status_code == 200, r.text
    assert r.json()["scope"] == "finance"
    r = client.post("/auth/users", headers=_bearer(admin),
                    json={"email": "bad@fin.test", "password": "longenough", "scope": "bogus"})
    assert r.status_code == 400


def test_admin_updates_scope(client, db_session):
    admin = _user(db_session, "admin@lab.test", role="admin")
    target = _user(db_session, "t@test", scope="finance")
    r = client.put(f"/auth/users/{target.id}", headers=_bearer(admin), json={"scope": "both"})
    assert r.status_code == 200, r.text
    assert r.json()["scope"] == "both"
    r = client.put(f"/auth/users/{target.id}", headers=_bearer(admin), json={"scope": "nope"})
    assert r.status_code == 400
