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
    hits = seams.resolve_entity_search(db, "document", "sop")
    assert [h["entity_id"] for h in hits] == ["SOP-0001"], "two revisions, one hit"
    assert seams.resolve_entity_search(db, "document", "waste")[0]["entity_id"] == "SOP-0001"


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
                               entity_type="document", entity_id=doc.code)
    assert [f.id for f in still] == [flag.id]


def test_an_unknown_document_code_is_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError, match="not found"):
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
    rows = service.list_flags(db, user_id=USER.id, tab="all_open", entity_type="document")
    assert [(f.entity_type, f.entity_id) for f in rows] == [("document", "SOP-0001")]
    assert len(service.list_flags(db, user_id=USER.id, tab="all_open")) == 2

