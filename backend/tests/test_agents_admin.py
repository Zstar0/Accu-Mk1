"""Settings > Agents API (spec 2026-10-12 section 4)."""
import os
from unittest.mock import patch

from tests.agents_support import app_client, make_admin, make_agent  # noqa: F401


def _create(c, admin, **over):
    body = {"username": "pia", "display_name": "Pia"}
    body.update(over)
    return c.post("/admin/agents", json=body, headers=admin)


def test_create_returns_the_key_once_and_it_works_at_once(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    r = _create(c, admin)
    assert r.status_code == 201, r.text
    key = r.json()["key"]
    assert key.startswith("mk1a.pia.") and r.json()["agent"]["key_hint"] == key.split(".")[2][:6]
    listed = c.get("/admin/agents", headers=admin).json()
    assert [a["username"] for a in listed] == ["pia"] and key not in str(listed)
    assert c.get("/api/documents", headers={"Authorization": f"Bearer {key}"}).status_code == 200


def test_rotate_kills_the_old_key_immediately(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    created = _create(c, admin).json()
    rotated = c.post(f"/admin/agents/{created['agent']['id']}/rotate-key", headers=admin).json()
    old, new = created["key"], rotated["key"]
    assert c.get("/api/documents", headers={"Authorization": f"Bearer {old}"}).status_code == 401
    assert c.get("/api/documents", headers={"Authorization": f"Bearer {new}"}).status_code == 200
    assert rotated["agent"]["rotated_at"] is not None


def test_rotate_logs_the_acting_admin_and_never_the_key(app_client, caplog):
    import logging
    c, db = app_client
    admin_user, admin = make_admin(db)
    created = _create(c, admin).json()
    caplog.set_level(logging.INFO, logger="agents.service")
    key = c.post(f"/admin/agents/{created['agent']['id']}/rotate-key", headers=admin).json()["key"]
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("agents.key_rotated")]
    assert len(lines) == 1, caplog.text
    assert lines[0].endswith(f"by={admin_user.id}"), lines[0]
    assert key not in caplog.text and "mk1a." not in caplog.text


def test_deactivate_is_immediate(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    created = _create(c, admin).json()
    c.patch(f"/admin/agents/{created['agent']['id']}", json={"is_active": False}, headers=admin)
    assert c.get("/api/documents", headers={"Authorization": f"Bearer {created['key']}"}).status_code == 401


def test_username_is_normalised_and_unique_case_insensitively(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    assert _create(c, admin, username="  Pia ").json()["agent"]["username"] == "pia"
    r = _create(c, admin, username="PIA")
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "name_taken")
    r = _create(c, admin, username="pia!")
    assert (r.status_code, r.json()["detail"]["code"]) == (400, "invalid_username")


def test_env_token_names_are_reserved(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "jarvis:" + "j" * 40}):
        r = _create(c, admin, username="jarvis")
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "name_taken")


def test_coa_needs_lab(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    r = _create(c, admin, coa_publishing=True)
    assert (r.status_code, r.json()["detail"]["code"]) == (400, "coa_needs_lab")


def test_lab_off_clears_coa(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    a = _create(c, admin, lab_tools=True, coa_publishing=True).json()["agent"]
    out = c.patch(f"/admin/agents/{a['id']}", json={"lab_tools": False}, headers=admin).json()
    assert (out["lab_tools"], out["coa_publishing"]) == (False, False)


def test_patch_cannot_rename(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    a = _create(c, admin).json()["agent"]
    r = c.patch(f"/admin/agents/{a['id']}", json={"username": "other"}, headers=admin)
    assert r.status_code == 422


def test_groups_are_set_on_the_agent(app_client):
    from groups.models import UserGroup
    c, db = app_client
    _, admin = make_admin(db)
    g1, g2 = UserGroup(slug="a", name="A"), UserGroup(slug="b", name="B", is_active=False)
    db.add_all([g1, g2])
    db.commit()
    a = _create(c, admin).json()["agent"]
    out = c.put(f"/admin/agents/{a['id']}/groups", json={"group_ids": [g1.id]}, headers=admin).json()
    assert out["group_ids"] == [g1.id]
    r = c.put(f"/admin/agents/{a['id']}/groups", json={"group_ids": [g2.id]}, headers=admin)
    assert (r.status_code, r.json()["detail"]["code"]) == (400, "unknown_group")


def test_a_deactivated_group_does_not_stick_the_save(app_client):
    """I-3: only ADDED groups must be active; a kept membership in a since-deactivated group
    must not make every later save a 400."""
    from groups.models import UserGroup
    c, db = app_client
    _, admin = make_admin(db)
    g1, g_new = UserGroup(slug="a", name="A"), UserGroup(slug="z", name="Z", is_active=False)
    db.add_all([g1, g_new])
    db.commit()
    a = _create(c, admin).json()["agent"]
    url = f"/admin/agents/{a['id']}/groups"
    assert c.put(url, json={"group_ids": [g1.id]}, headers=admin).status_code == 200
    g1.is_active = False
    db.commit()
    r = c.put(url, json={"group_ids": [g1.id]}, headers=admin)
    assert (r.status_code, r.json()["group_ids"]) == (200, [g1.id]), r.text
    r = c.put(url, json={"group_ids": [g1.id, g_new.id]}, headers=admin)
    assert (r.status_code, r.json()["detail"]["code"]) == (400, "unknown_group")


def test_a_human_id_is_not_an_agent(app_client):
    """The admin API must never edit, re-key or re-group a human account."""
    c, db = app_client
    human, admin = make_admin(db)
    for r in (c.patch(f"/admin/agents/{human.id}", json={"is_active": False}, headers=admin),
              c.post(f"/admin/agents/{human.id}/rotate-key", headers=admin),
              c.put(f"/admin/agents/{human.id}/groups", json={"group_ids": []}, headers=admin)):
        assert (r.status_code, r.json()["detail"]) == (404, {"code": "unknown_agent"})
    db.refresh(human)
    assert human.is_active


def test_only_admin_logins_manage_agents(app_client):
    import models
    from auth import create_access_token, get_password_hash
    c, db = app_client
    std = models.User(email="s@x.t", hashed_password=get_password_hash("pw-12345678"), role="standard")
    db.add(std)
    db.commit()
    assert c.get("/admin/agents", headers={"Authorization":
                 f"Bearer {create_access_token({'sub': str(std.id)})}"}).status_code == 403
    _, agent = make_agent(db, "devon")
    assert c.get("/admin/agents", headers=agent).status_code == 403
