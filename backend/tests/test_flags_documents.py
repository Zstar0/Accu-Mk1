"""`document` as a flag entity type (2026-09-18).

A thread anchors on the document CODE, not a revision row, so it survives the
revision that answers it. These guard the Mk1 closures in
`seams.register_mk1_entities` plus the two opt-in core hooks they use
(`must_exist`, `snapshot`).
"""
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
USER = SimpleNamespace(id=7, role="standard", email="u@x.t")


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import documents.models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from documents import service as docs, storage
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    docs.seed_categories(s)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    try:
        yield s
    finally:
        s.close()


def _sop(db, html=HTML, **kw):
    from documents import service as docs
    cat = docs.resolve_category(db, category="SOP")
    doc, _ = docs.create_document(db, title=kw.pop("title", "Waste Disposal"), html=html,
                                  category=cat, **kw)
    return doc


def test_document_is_a_registered_entity_type():
    from flags import seams
    seams.register_mk1_entities()
    assert seams.is_registered("document")
    assert seams.get_entity_spec("document").must_exist is True


def test_context_follows_the_latest_revision_of_the_code(db):
    from flags import seams
    r1 = _sop(db, activate=False)
    ctx = seams.resolve_context(db, "document", r1.code)
    assert ctx["label"] == "SOP-0001 · Waste Disposal"
    assert ctx["deep_link"] == {"kind": "document", "id": str(r1.id)}
    r2 = _sop(db, html=HTML + "<!--2-->", code=r1.code, title="Waste Disposal v2", activate=False)
    assert seams.resolve_context(db, "document", "sop-0001") is None, "codes match exactly"
    ctx = seams.resolve_context(db, "document", "SOP-0001")
    assert ctx["label"] == "SOP-0001 · Waste Disposal v2"
    assert ctx["deep_link"]["id"] == str(r2.id)
    assert seams.resolve_context(db, "document", "SOP-9999") is None


def test_state_is_the_latest_revisions_status_so_documents_are_watchable(db):
    from flags import seams
    doc = _sop(db, activate=False)
    assert seams.resolve_state(db, "document", doc.code) == "draft"
    _sop(db, html=HTML + "<!--2-->", code=doc.code)
    assert seams.resolve_state(db, "document", doc.code) == "active"


def test_search_matches_code_prefix_and_title_once_per_code(db):
    from flags import seams
    doc = _sop(db, activate=False)
    _sop(db, html=HTML + "<!--2-->", code=doc.code, activate=False)
    hits = seams.resolve_entity_search(db, "document", "sop", user=USER)
    assert [h["entity_id"] for h in hits] == ["SOP-0001"], "two revisions, one hit"
    assert seams.resolve_entity_search(db, "document", "waste", user=USER)[0]["entity_id"] == "SOP-0001"


def test_a_thread_records_the_revision_it_was_raised_on(db):
    from flags import service
    from flags.models import FlagEvent
    doc = _sop(db, activate=False)
    flag = service.create_flag(db, user=USER, entity_type="document", entity_id=doc.code,
                               type="doc_review", title="Section 3 contradicts the spill SOP",
                               first_comment="See 3.2")
    db.commit()
    raised = db.query(FlagEvent).filter_by(flag_id=flag.id, event_type="raised").one()
    assert raised.details["entity_snapshot"] == {"revision": 1, "status": "draft"}
    assert flag.entity_id == "SOP-0001"
    # the thread survives the revision that answers it
    _sop(db, html=HTML + "<!--2-->", code=doc.code)
    still = service.list_flags(db, user_id=USER.id, tab="all_open",
                               entity_type="document", entity_id=doc.code, user=USER)
    assert [f.id for f in still] == [flag.id]


def test_an_unknown_document_code_is_refused(db):
    from flags import service
    from flags.errors import PermissionDeniedError
    # can_raise fails closed on an unknown code (existence is never confirmed)
    with pytest.raises(PermissionDeniedError):
        service.create_flag(db, user=USER, entity_type="document", entity_id="SOP-9999",
                            type="question", title="x")


def test_existence_check_is_opt_in_so_legacy_types_are_unchanged(db):
    """Samples the registry cannot resolve (legacy / SENAITE-only ids) are still flaggable."""
    from flags import service
    flag = service.create_flag(db, user=USER, entity_type="sample", entity_id="P-NOT-IN-MK1",
                               type="question", title="x")
    assert flag.id is not None


def test_doc_review_is_document_only_but_general_types_work_on_documents(db):
    from flags import service, types_service
    from flags.errors import BadRequestError
    doc = _sop(db, activate=False)
    assert types_service.get_type_by_slug(db, "doc_review").entity_types == ["document"]
    with pytest.raises(BadRequestError, match="not allowed"):
        service.create_flag(db, user=USER, entity_type="sample", entity_id="P-1",
                            type="doc_review", title="x")
    assert service.create_flag(db, user=USER, entity_type="document", entity_id=doc.code,
                               type="question", title="x").id


def test_flags_can_be_listed_by_entity_type_alone(db):
    """The library counts open threads per code with ONE request."""
    from flags import service
    doc = _sop(db, activate=False)
    service.create_flag(db, user=USER, entity_type="document", entity_id=doc.code,
                        type="doc_review", title="a")
    service.create_flag(db, user=USER, entity_type="sample", entity_id="P-1",
                        type="question", title="b")
    rows = service.list_flags(db, user_id=USER.id, tab="all_open", entity_type="document", user=USER)
    assert [(f.entity_type, f.entity_id) for f in rows] == [("document", "SOP-0001")]
    assert len(service.list_flags(db, user_id=USER.id, tab="all_open", user=USER)) == 2


# --- spaces (spec 2026-10-06 section 6) --------------------------------------------------

ADMIN_U = SimpleNamespace(id=1, role="admin", email="a@x.t", is_active=True)
MEMBER_U = SimpleNamespace(id=10, role="standard", email="m@x.t", is_active=True)
OUTSIDER_U = SimpleNamespace(id=11, role="standard", email="o@x.t", is_active=True)


def _restricted(db):
    from documents import service as docs
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup, UserGroupMember
    import groups.models  # noqa: F401
    docs.seed_spaces(db)
    g = UserGroup(slug="leaders", name="L")
    sp = DocumentSpace(slug="leadership", name="L", visibility="restricted")
    db.add_all([g, sp])
    db.flush()
    db.add_all([UserGroupMember(group_id=g.id, user_id=MEMBER_U.id),
                DocumentSpaceGrant(space_id=sp.id, group_id=g.id)])
    db.commit()
    cat = docs.resolve_category(db, category="ART")
    secret, _ = docs.create_document(db, title="Q4 plan", html=HTML, category=cat, space=sp)
    public, _ = docs.create_document(db, title="Public", html=HTML + "<!--p-->", category=cat)
    return g, sp, secret, public


def test_document_seams_follow_the_space(db):
    from flags import seams
    seams.register_mk1_entities()
    spec = seams.get_entity_spec("document")
    g, sp, secret, public = _restricted(db)
    assert spec.can_view(db, OUTSIDER_U, secret.code) is False
    assert spec.can_view(db, MEMBER_U, secret.code) is True
    assert spec.can_view(db, OUTSIDER_U, public.code) is True
    assert spec.can_view(db, OUTSIDER_U, "ART-9999") is False  # unknown anchor: fail closed
    assert spec.can_view(db, ADMIN_U, "ART-9999") is True
    assert spec.can_raise(db, OUTSIDER_U, secret.code) is False
    assert spec.can_raise(db, MEMBER_U, secret.code) is True
    assert spec.visible_entity_ids(db, ADMIN_U) is None
    visible = set(db.execute(spec.visible_entity_ids(db, OUTSIDER_U)).scalars().all())
    assert visible == {public.code}
    labels = [r["entity_id"] for r in spec.search_scoped(db, OUTSIDER_U, "Q4")]
    assert labels == []
    assert [r["entity_id"] for r in spec.search_scoped(db, MEMBER_U, "Q4")] == [secret.code]
    assert spec.audience(db, public.code) is None
    assert spec.audience(db, secret.code) == {"groups": [g.id]}
    assert spec.audience(db, "ART-9999") == {"groups": []}


def test_a_document_thread_follows_the_space_end_to_end(db):
    """Important 3: the real flag service, not the closures. A thread on a restricted
    document lists for a member only, and an outsider cannot be assigned to it."""
    from flags import service
    from flags.errors import BadRequestError
    from models import User
    for u in (ADMIN_U, MEMBER_U, OUTSIDER_U):
        db.add(User(id=u.id, email=u.email, hashed_password="x", role=u.role, is_active=True))
    db.commit()
    g, sp, secret, public = _restricted(db)
    flag = service.create_flag(db, user=MEMBER_U, entity_type="document", entity_id=secret.code,
                               type="doc_review", title="Q4 numbers do not add up")
    db.commit()

    def ids(who):
        return [f.id for f in service.list_flags(db, user_id=who.id, tab="all_open", user=who)]
    assert flag.id in ids(MEMBER_U)
    assert flag.id in ids(ADMIN_U)
    assert flag.id not in ids(OUTSIDER_U)
    with pytest.raises(BadRequestError, match="cannot see this flag"):
        service.assign(db, user=MEMBER_U, flag_id=flag.id, assignee_id=OUTSIDER_U.id)
    assert service.assign(db, user=MEMBER_U, flag_id=flag.id, assignee_id=MEMBER_U.id).assignee_id == MEMBER_U.id
