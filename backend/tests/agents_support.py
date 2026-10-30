"""Shared fixture for agent tests: the real app and real auth on in-memory SQLite. Nothing
overrides get_current_user, so every request authenticates the way production does."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style></head>"
        "<body><p>hi</p></body></html>")


@pytest.fixture
def app_client():
    from fastapi.testclient import TestClient
    from main import app
    from database import Base, get_db
    import models  # noqa: F401
    import flags.models  # noqa: F401
    import documents.models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import agents.models  # noqa: F401
    from documents import service, storage

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    service.seed_categories(db)
    service.seed_spaces(db)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())

    def _db():
        yield db

    saved = dict(app.dependency_overrides)
    app.dependency_overrides.clear()
    app.dependency_overrides[get_db] = _db
    yield TestClient(app), db
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)
    db.close()


def make_admin(db, email="admin@x.t"):
    import models
    from auth import create_access_token, get_password_hash
    u = models.User(email=email, hashed_password=get_password_hash("pw-12345678"), role="admin",
                    is_active=True, first_name="Ada", last_name="Admin")
    db.add(u)
    db.commit()
    return u, {"Authorization": f"Bearer {create_access_token({'sub': str(u.id)})}"}


def make_agent(db, username="pia", lab_tools=False, coa_publishing=False):
    from agents import service
    user, key = service.create_agent(db, username=username, display_name=username.title(),
                                     lab_tools=lab_tools, coa_publishing=coa_publishing,
                                     created_by_user_id=None)
    return user, {"Authorization": f"Bearer {key}"}


def restricted_space(db, slug="leadership"):
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup
    g = UserGroup(slug=f"{slug}-group", name=f"{slug} group")
    sp = DocumentSpace(slug=slug, name=slug.title(), visibility="restricted")
    db.add_all([g, sp])
    db.flush()
    db.add(DocumentSpaceGrant(space_id=sp.id, group_id=g.id))
    db.commit()
    return sp, g
