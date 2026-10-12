"""Agents never appear or act as people (spec 2026-10-12 section 3.6)."""
from tests.agents_support import app_client, make_admin, make_agent  # noqa: F401


def test_login_refuses_agents(app_client):
    from auth import get_password_hash
    c, db = app_client
    agent, _ = make_agent(db)
    agent.hashed_password = get_password_hash("anything")  # only the role guard can refuse now
    db.commit()
    r = c.post("/auth/login", json={"email": "pia@agent.invalid", "password": "anything"})
    assert (r.status_code, r.json()["detail"]) == (401, "Invalid credentials")


def test_people_lists_exclude_agents(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    make_agent(db)
    assert all(u["role"] != "agent" for u in c.get("/auth/users", headers=admin).json())
    assert all(not u["email"].endswith("@agent.invalid")
               for u in c.get("/worksheets/users", headers=admin).json())


def test_user_admin_cannot_touch_agents(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    agent, _ = make_agent(db)
    r = c.put(f"/auth/users/{agent.id}", json={"role": "admin"}, headers=admin)
    assert r.status_code == 400
    assert c.post(f"/auth/users/{agent.id}/reset-password", headers=admin).status_code == 400
    db.refresh(agent)
    assert agent.role == "agent"


def test_agent_names_are_not_scrubbed_from_ai_reviews(app_client):
    from customer_review.names import staff_names
    _, db = app_client
    make_admin(db)
    make_agent(db, "devon")
    names = staff_names(db, None)
    assert "Ada" in names and "Devon" not in names
