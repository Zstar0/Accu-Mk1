"""An agent user on the documents routes (spec 2026-10-12 section 3.5): reads and writes only in
spaces it can see, never an admin's powers, attributed to itself."""
from tests.agents_support import HTML, app_client, make_admin, make_agent, restricted_space  # noqa: F401

DENIED = {"detail": "agent keys cannot use this endpoint"}


def _post(c, headers, **body):
    payload = {"title": "Note", "html": HTML, "category": "ART", "activate": False}
    payload.update(body)
    return c.post("/api/documents", json=payload, headers=headers)


def test_agent_creates_in_general_and_is_the_attributed_creator(app_client):
    c, db = app_client
    agent, h = make_agent(db, "pia")
    r = _post(c, h, author="Forrest Parker")
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["co_author"] == "pia" and doc["created_by_user_id"] == agent.id
    assert doc["provenance"]["creator"] == {"kind": "agent", "id": "pia", "label": "pia", "verified": True}
    assert doc["provenance"]["requested_by"]["verified"] is False


def test_spaces_follow_group_membership(app_client):
    from groups.models import UserGroupMember
    c, db = app_client
    agent, h = make_agent(db)
    sp, g = restricted_space(db)
    r = _post(c, h, space="leadership", html=HTML + "<!--1-->")
    assert r.status_code == 400 and "not allowed for this agent" in r.text
    db.add(UserGroupMember(group_id=g.id, user_id=agent.id))
    db.commit()
    assert _post(c, h, space="leadership", html=HTML + "<!--2-->").status_code == 201
    slugs = {s["slug"] for s in c.get("/api/document-spaces", headers=h).json()}
    assert slugs == {"general", "leadership"}


def test_hidden_documents_are_404_to_read_and_to_revise(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    restricted_space(db)
    secret = _post(c, admin, space="leadership").json()
    _, h = make_agent(db)
    assert c.get(f"/api/documents/{secret['id']}", headers=h).status_code == 404
    assert _post(c, h, code=secret["code"], html=HTML + "<!--r2-->").status_code == 404
    assert all(i["code"] != secret["code"] for i in c.get("/api/documents", headers=h).json()["items"])


def test_hidden_documents_are_404_to_patch_retire_and_comment(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    restricted_space(db)
    secret = _post(c, admin, space="leadership").json()
    _, h = make_agent(db)
    assert c.patch(f"/api/documents/{secret['id']}", json={"title": "x"}, headers=h).status_code == 404
    assert c.post(f"/api/documents/{secret['id']}/retire", headers=h).status_code == 404
    assert c.post(f"/api/documents/{secret['id']}/comments", json={"body": "hi"},
                  headers=h).status_code == 404


def test_admin_powers_are_refused(app_client):
    c, db = app_client
    _, admin = make_admin(db)
    sp, _ = restricted_space(db)
    draft = _post(c, admin).json()
    _, h = make_agent(db)
    checks = [
        c.delete(f"/api/documents/{draft['id']}?code={draft['code']}&revision=1", headers=h),
        c.post("/api/document-categories", json={"name": "X", "code_prefix": "XX"}, headers=h),
        c.post("/api/document-spaces", json={"slug": "x", "name": "X"}, headers=h),
        c.get(f"/api/document-spaces/{sp.id}/grants", headers=h),
        c.put(f"/api/documents/{draft['id']}/content", json={"html": HTML + "<!--x-->"}, headers=h),
    ]
    for r in checks:
        assert (r.status_code, r.json()) == (403, DENIED), r.request.url
    move = c.patch(f"/api/documents/{draft['id']}", json={"space_id": sp.id}, headers=h)
    assert move.status_code == 403  # existing "only an admin login can move" check


def test_agent_comments_are_authored_by_the_agent(app_client):
    c, db = app_client
    _, h = make_agent(db)
    doc = _post(c, h).json()
    r = c.post(f"/api/documents/{doc['id']}/comments", json={"body": "looks right"}, headers=h)
    assert r.status_code == 201, r.text
    assert r.json()["author_agent"] == "pia" and r.json()["author_user_id"] is None


def test_an_agent_edits_only_its_own_comments(app_client):
    c, db = app_client
    _, a = make_agent(db, "pia")
    _, b = make_agent(db, "bob")
    doc = _post(c, a).json()
    cid = c.post(f"/api/documents/{doc['id']}/comments", json={"body": "mine"}, headers=a).json()["id"]
    assert c.patch(f"/api/documents/comments/{cid}", json={"body": "hijack"}, headers=b).status_code == 403
    r = c.patch(f"/api/documents/comments/{cid}", json={"body": "edited"}, headers=a)
    assert r.status_code == 200 and r.json()["body"] == "edited"
