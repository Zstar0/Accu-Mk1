import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

_PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
_NOT_IMAGE = b"%PDF-1.4 not an image"


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.set_attachment_storage_for_tests(seams.InMemoryAttachmentStorage())
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    types_service.seed_builtins(shared)

    def _db():
        yield shared
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    shared.close()


def _new_flag(client):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                        "type": "blocker", "title": "t"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_upload_sniffs_image_and_serves_bytes(client):
    fid = _new_flag(client)
    up = client.post(f"/api/flags/{fid}/attachments",
                     files={"file": ("shot.png", _PNG, "image/png")})
    assert up.status_code == 201, up.text
    body = up.json()
    assert body["content_type"] == "image/png" and body["comment_id"] is None
    got = client.get(f"/api/flags/attachments/{body['id']}")
    assert got.status_code == 200 and got.content == _PNG
    assert got.headers["content-type"].startswith("image/png")


def test_upload_rejects_non_image_by_magic_bytes(client):
    fid = _new_flag(client)
    # content-type header LIES ("image/png") — magic-byte sniff must reject.
    up = client.post(f"/api/flags/{fid}/attachments",
                     files={"file": ("x.png", _NOT_IMAGE, "image/png")})
    assert up.status_code == 400, up.text


def test_upload_emits_attachment_added_event(client):
    from flags import seams
    fid = _new_flag(client)
    client.post(f"/api/flags/{fid}/attachments",
                files={"file": ("s.png", _PNG, "image/png")})
    assert any(e["event_type"] == "attachment_added" for e in seams.EVENT_SINK.events)


def test_serve_missing_attachment_404s(client):
    assert client.get("/api/flags/attachments/99999").status_code == 404
