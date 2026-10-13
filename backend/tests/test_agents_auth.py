"""Agent key authentication (spec 2026-10-12 sections 3.3, 3.4)."""
import os
import sys
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from tests.agents_support import app_client  # noqa: E402,F401


def _agent(db, username="pia", lab=False, coa=False, active=True):
    """Row-level helper so this task does not depend on the admin service (Task 4)."""
    import models
    from agents import keys
    from agents.models import AgentCredential
    from auth import get_password_hash
    secret = keys.new_secret()
    u = models.User(email=keys.email_for(username), hashed_password=get_password_hash(keys.new_secret()),
                    role="agent", is_active=active, first_name=username.title())
    db.add(u)
    db.flush()
    db.add(AgentCredential(user_id=u.id, key_hash=keys.hash_secret(secret), key_hint=keys.hint(secret),
                           lab_tools=lab, coa_publishing=coa))
    db.commit()
    return u, keys.wire_key(username, secret)


def _h(key):
    return {"Authorization": f"Bearer {key}"}


def test_documents_route_accepts_the_agent(app_client):
    c, db = app_client
    _, key = _agent(db)
    assert c.get("/api/documents", headers=_h(key)).status_code == 200


def test_unlisted_route_is_403_with_the_exact_text(app_client):
    c, db = app_client
    _, key = _agent(db)
    for path in ("/admin/agents", "/auth/me", "/worksheets/users"):
        r = c.get(path, headers=_h(key))
        assert (r.status_code, r.json()) == (403, {"detail": "agent keys cannot use this endpoint"}), path


def test_lab_reads_are_open_and_the_switch_gates_flag_writes(app_client):
    denied = {"detail": "agent keys cannot use this endpoint"}
    c, db = app_client
    _, plain = _agent(db)
    assert c.get("/api/flags/types", headers=_h(plain)).status_code == 200  # reads: every agent
    r = c.post("/api/flags", headers=_h(plain), json={})
    assert (r.status_code, r.json()) == (403, denied)
    _, lab = _agent(db, "lab-agent", lab=True)
    assert c.post("/api/flags", headers=_h(lab), json={}).json() != denied  # past auth (body may 422)
    r = c.post("/wizard/senaite/samples/P-1/publish-coa", headers=_h(lab), json={})
    assert (r.status_code, r.json()) == (403, denied)


def test_coa_route_passes_auth_only_with_lab_and_coa(app_client):
    """Checked at the dependency, so no COA handler (network) runs in the test."""
    from fastapi import HTTPException
    from agents.auth import agent_for_route
    _, db = app_client
    route = SimpleNamespace(path="/wizard/senaite/samples/{sample_id}/publish-coa")
    req = SimpleNamespace(method="POST", scope={"route": route})
    _, lab_only = _agent(db, "lab-only", lab=True)
    with pytest.raises(HTTPException) as e:
        agent_for_route(db, lab_only, req)
    assert e.value.status_code == 403
    user, both = _agent(db, "coa-agent", lab=True, coa=True)
    assert agent_for_route(db, both, req).id == user.id


def test_every_auth_failure_is_the_same_401(app_client):
    from agents import keys
    c, db = app_client
    _, key = _agent(db)
    _, off = _agent(db, "dormant", active=False)
    wrong = key.rsplit(".", 1)[0] + "." + keys.new_secret()
    unknown = keys.wire_key("nobody", keys.new_secret())
    bodies = set()
    for bad in (wrong, unknown, off, "mk1a.pia.short"):
        r = c.get("/api/documents", headers=_h(bad))
        assert r.status_code == 401, bad[:12]
        bodies.add(r.text)
    assert bodies == {'{"detail":"invalid agent key"}'}


def test_direct_call_without_a_route_fails_closed(app_client):
    from fastapi import HTTPException
    from auth import get_current_user
    _, db = app_client
    _, key = _agent(db)
    with pytest.raises(HTTPException) as e:
        get_current_user(token=key, db=db)
    assert e.value.status_code == 403


def test_a_jwt_for_an_agent_row_is_refused(app_client):
    from auth import create_access_token
    c, db = app_client
    user, _ = _agent(db)
    r = c.get("/auth/me", headers=_h(create_access_token({"sub": str(user.id)})))
    assert r.status_code == 401


def test_last_used_is_written_at_most_every_five_minutes(app_client):
    from agents.models import AgentCredential
    c, db = app_client
    user, key = _agent(db)
    c.get("/api/documents", headers=_h(key))
    first = db.get(AgentCredential, user.id).last_used_at
    assert first is not None
    c.get("/api/documents", headers=_h(key))
    db.expire_all()
    assert db.get(AgentCredential, user.id).last_used_at == first
    cred = db.get(AgentCredential, user.id)
    cred.last_used_at = datetime.utcnow() - timedelta(minutes=6)
    db.commit()
    c.get("/api/documents", headers=_h(key))
    db.expire_all()
    assert db.get(AgentCredential, user.id).last_used_at > first


def test_whitespace_around_the_key_is_tolerated(app_client):
    c, db = app_client
    _, key = _agent(db)
    assert c.get("/api/documents", headers={"Authorization": f"Bearer  {key}  "}).status_code == 200
