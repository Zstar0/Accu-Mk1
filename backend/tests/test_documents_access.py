"""Document space access matrix (spec 2026-10-06 section 5). Hidden = NotFoundError."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style>"
        "</head><body><p>hi</p></body></html>")
ADMIN = SimpleNamespace(id=1, role="admin", is_active=True)
MEMBER = SimpleNamespace(id=10, role="standard", is_active=True)
OUTSIDER = SimpleNamespace(id=11, role="standard", is_active=True)
INACTIVE = SimpleNamespace(id=12, role="standard", is_active=False)
SUSPENDED = SimpleNamespace(id=13, role="standard", is_active=True)  # in a deactivated group


@pytest.fixture
def world():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup, UserGroupMember
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    service.seed_categories(s)
    service.seed_spaces(s)
    leaders = UserGroup(slug="leaders", name="Leaders")
    dormant = UserGroup(slug="dormant", name="Dormant", is_active=False)
    exec_space = DocumentSpace(slug="leadership", name="Leadership", visibility="restricted")
    lab = DocumentSpace(slug="lab", name="Lab", visibility="company")
    s.add_all([leaders, dormant, exec_space, lab])
    s.flush()
    s.add_all([UserGroupMember(group_id=leaders.id, user_id=MEMBER.id),
               UserGroupMember(group_id=leaders.id, user_id=INACTIVE.id),
               UserGroupMember(group_id=dormant.id, user_id=SUSPENDED.id),
               DocumentSpaceGrant(space_id=exec_space.id, group_id=leaders.id),
               DocumentSpaceGrant(space_id=exec_space.id, group_id=dormant.id)])
    s.commit()
    cat = service.resolve_category(s, category="ART")
    secret, _ = service.create_document(s, title="Q4 plan", html=HTML, category=cat, space=exec_space)
    public, _ = service.create_document(s, title="SOP index", html=HTML + "<!--2-->", category=cat, space=lab)
    return SimpleNamespace(s=s, exec_space=exec_space, lab=lab, secret=secret, public=public,
                           general=service.general_space(s))


def test_view_space_matrix(world):
    from documents.access import can_view_space as v
    s = world.s
    users = (ADMIN, MEMBER, OUTSIDER, INACTIVE, SUSPENDED)
    assert [v(s, u, world.lab) for u in users] == [True, True, True, False, True]
    assert [v(s, u, world.exec_space) for u in users] == [True, True, False, False, False]
    assert v(s, None, world.lab) is False


def test_view_document_follows_its_space(world):
    from documents.access import can_view_document as v
    s = world.s
    assert [v(s, u, world.secret) for u in (ADMIN, MEMBER, OUTSIDER)] == [True, True, False]
    assert [v(s, u, world.public) for u in (ADMIN, MEMBER, OUTSIDER)] == [True, True, True]


def test_visible_space_ids(world):
    from documents.access import visible_space_ids
    s = world.s
    ids = lambda u: set(s.execute(visible_space_ids(s, u)).scalars().all())  # noqa: E731
    everything = {world.general.id, world.lab.id, world.exec_space.id}
    assert ids(ADMIN) == everything and ids(MEMBER) == everything
    assert ids(OUTSIDER) == {world.general.id, world.lab.id}
    assert ids(SUSPENDED) == {world.general.id, world.lab.id}
    assert ids(INACTIVE) == set()


def test_require_view_is_404_text_identical_to_missing(world):
    from documents.access import require_view
    from documents.errors import NotFoundError
    with pytest.raises(NotFoundError) as e:
        require_view(world.s, OUTSIDER, world.secret)
    assert str(e.value) == f"document {world.secret.id} not found"


def test_null_space_reads_as_general(world):
    """Review Focus 1: a pre-backfill row is General, visible to everyone active."""
    from documents.access import can_view_document
    from documents.models import Document
    world.secret.space_id = None
    world.s.commit()
    world.s.expire_all()
    row = world.s.get(Document, world.secret.id)
    assert row.space_id is None
    assert can_view_document(world.s, OUTSIDER, row) is True
    assert can_view_document(world.s, INACTIVE, row) is False
