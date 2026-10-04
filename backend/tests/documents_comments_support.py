"""Shared fixture for the document-comment test files. Not a test module."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style></head>"
        "<body><h1>Audit</h1><h2>Rulings</h2>"
        "<p>Dedupe on an EXPLICIT code still behaves as before.</p>"
        "<p>Cd &amp; Pb limits use&nbsp;50% of spec.</p>"
        "<script>var x = 'never quoted';</script></body></html>")
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
JPEG = b"\xff\xd8\xff" + b"0" * 32
GIF = b"GIF89a" + b"0" * 32
WEBP = b"RIFF" + b"0000" + b"WEBP" + b"0" * 32
NOT_IMAGE = b"%PDF-1.4 not an image"
AGENT_TOKEN = "j" * 40
OTHER_AGENT_TOKEN = "t" * 40
INTERNAL_TOKEN = "internal-token"

USER = SimpleNamespace(id=42, role="standard", email="t@x.t", first_name="Tess",
                       last_name="Tech", is_active=True)
OTHER = SimpleNamespace(id=43, role="standard", email="o@x.t", first_name="Olu",
                        last_name=None, is_active=True)
ADMIN = SimpleNamespace(id=1, role="admin", email="admin@x.t", first_name=None,
                        last_name=None, is_active=True)


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import documents.models  # noqa: F401
    import flags.models  # noqa: F401
    from documents import service, storage
    from documents.comments import actor_from_user
    from documents.comment_routes import require_comment_actor
    from documents.routes import require_document_writer
    from flags import seams as flag_seams

    monkeypatch.setenv("MK1_DOCUMENT_AGENT_TOKENS",
                       f"jarvis:{AGENT_TOKEN},tars:{OTHER_AGENT_TOKEN}")
    monkeypatch.setenv("ACCUMK1_INTERNAL_SERVICE_TOKEN", INTERNAL_TOKEN)
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    service.seed_categories(shared)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    flag_seams.set_attachment_storage_for_tests(flag_seams.InMemoryAttachmentStorage())

    def _db():
        yield shared

    keys = (get_db, get_current_user, require_document_writer, require_comment_actor)
    saved = {k: app.dependency_overrides.get(k) for k in keys}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: USER
    app.dependency_overrides[require_document_writer] = lambda: ADMIN

    def as_user(u):
        app.dependency_overrides[require_comment_actor] = lambda: actor_from_user(u)

    def real_actor():
        """Drop the override so X-Service-Token / bearer logic really runs."""
        app.dependency_overrides.pop(require_comment_actor, None)

    tc = TestClient(app)
    tc.db = shared
    tc.as_user = as_user
    tc.real_actor = real_actor
    as_user(USER)
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    shared.close()


def publish(client, **over) -> dict:
    """Create ART-0001 (or the next revision when `code` is passed) as ADMIN."""
    body = {"title": "Audit", "html": HTML, "category": "ART", "author": "Forrest Parker"}
    body.update(over)
    r = client.post("/api/documents", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()


def comment(client, doc_id: int, **over) -> dict:
    body = {"kind": "comment", "body": "Which before?",
            "anchor": {"originalText": "still behaves as before"}}
    body.update(over)
    r = client.post(f"/api/documents/{doc_id}/comments", json=body)
    assert r.status_code == 201, r.text
    return r.json()
