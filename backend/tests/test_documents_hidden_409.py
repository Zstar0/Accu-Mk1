"""The structured duplicate 409 (`existing`) never reveals a document the writer cannot see.

Real FastAPI document routes, in-memory SQLite and storage. A restricted space
'leadership' holds a document; agent 'bot' may write General only, agent 'lead' may
write leadership. `lead` is the positive control: it proves the field is present when
the row is visible, so its absence elsewhere is meaningful.
"""
import os
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
from test_documents_routes import HTML, _publish, _restricted_world, client  # noqa: F401

BOT, LEAD = "b" * 40, "l" * 40
ENV = {"MK1_DOCUMENT_AGENT_TOKENS": f"bot:{BOT}:general, lead:{LEAD}:leadership"}


def _world(client):
    sp, secret = _restricted_world(client)  # published as admin into 'leadership'
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)  # real writer auth from here
    return sp, secret


def _leaks(r, secret) -> bool:
    return "existing" in r.text or secret["code"] in r.text or secret["title"] in r.text


def _counts(db):
    from sqlalchemy import func, select
    from documents.models import Document, DocumentSpaceGrant
    from groups.models import UserGroupMember
    return tuple(db.execute(select(func.count()).select_from(t)).scalar_one()
                 for t in (Document, DocumentSpaceGrant, UserGroupMember))


def test_restricted_agent_identical_bytes_never_names_the_hidden_document(client):
    sp, secret = _world(client)
    with patch.dict(os.environ, ENV):
        before = _counts(client.db)
        h = {"X-Service-Token": BOT}
        # Same bytes into the agent's own space: dedupe is space-scoped, so this is a new
        # General document, not a 409 confirming the hidden one exists.
        r = _publish(client, headers=h, title="Plan copy", activate=False)
        assert r.status_code == 201, r.text
        assert r.json()["space_slug"] == "general" and r.json()["code"] != secret["code"]
        assert not _leaks(r, secret)
        # Same bytes aimed at the hidden space: refused naming only the slug.
        r = _publish(client, headers=h, title="Plan copy", space="leadership", activate=False)
        assert r.status_code == 400
        assert r.json() == {"detail": "space 'leadership' is not allowed for this agent"}
        # Same bytes against the hidden code (the identical-bytes metadata-patch branch):
        # 404 identical to a missing code, and the hidden title is not touched.
        r = _publish(client, headers=h, title="renamed", code=secret["code"])
        assert r.status_code == 404 and r.json() == {"detail": f"document {secret['code']!r} not found"}
        after = _counts(client.db)
        assert after == (before[0] + 1, before[1], before[2])  # one General row; no grant/membership change
    from documents.models import Document
    client.db.expire_all()
    assert client.db.get(Document, secret["id"]).title == secret["title"]


def test_visible_writer_gets_existing_and_still_cannot_read_via_the_jwt_routes(client):
    sp, secret = _world(client)
    with patch.dict(os.environ, ENV):
        before = _counts(client.db)
        r = _publish(client, headers={"X-Service-Token": LEAD}, title="Q4 plan", space="leadership")
        assert r.status_code == 409
        assert r.json()["existing"]["id"] == secret["id"]  # positive control
        assert r.json()["existing"]["space_slug"] == "leadership"
        assert _counts(client.db) == before
        # The 409 is not a read grant: agent tokens stay out of the JWT-only read routes.
        from main import app
        from auth import get_current_user
        app.dependency_overrides.pop(get_current_user, None)
        for path in (f"/api/documents/{secret['id']}", f"/api/documents/{secret['id']}/content"):
            for tok in (LEAD, BOT):
                assert client.get(path, headers={"X-Service-Token": tok}).status_code == 401


def test_outsider_reader_cannot_write_or_read_the_hidden_document(client):
    sp, secret = _world(client)
    with patch.dict(os.environ, ENV):
        # Fixture user 42 is a standard login outside 'leadership'.
        assert client.get(f"/api/documents/{secret['id']}").status_code == 404
        r = _publish(client, title="Q4 plan", space="leadership")  # no admin bearer
        assert r.status_code == 401 and not _leaks(r, secret)


def test_route_gate_omits_existing_if_dedupe_ever_returns_a_hidden_row(client):
    """Second layer. Dedupe is already scoped to the target space, so a restricted writer
    cannot reach a hidden duplicate through the service; this forces one to prove the
    route itself still answers with the plain 409 and no fields."""
    sp, secret = _world(client)
    from documents import routes, service
    from documents.errors import DuplicateContentError
    hidden = service.get_document(client.db, secret["id"])

    def dup(*a, **kw):
        raise DuplicateContentError("this content is already published", hidden)

    with patch.dict(os.environ, ENV), patch.object(routes.service, "create_document", dup):
        r = _publish(client, headers={"X-Service-Token": BOT}, title="x")
        assert r.status_code == 409
        assert r.json() == {"detail": "this content is already published"}
        from main import app
        from documents.routes import require_document_writer
        # The human branch (_reader_for -> the login): forced with a writer identity that
        # cannot view the space. Real admins see every space, so this is gate-only.
        app.dependency_overrides[require_document_writer] = lambda: SimpleNamespace(
            id=42, role="standard", email="t@x.t", is_active=True)
        r = _publish(client, title="x")
        assert r.status_code == 409 and "existing" not in r.json()
