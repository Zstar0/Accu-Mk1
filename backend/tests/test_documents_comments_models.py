"""document_comments / document_comment_attachments shape (spec 2026-10-03 §4)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    service.seed_categories(s)
    doc, _ = service.create_document(
        s, title="A", html="<html><head><style>/* accumark-docs v1 */</style></head><body>x</body></html>",
        category=service.resolve_category(s, category="ART"), author="F")
    s.doc = doc
    yield s
    s.close()


def _comment(db, **over):
    from documents.models import DocumentComment
    row = DocumentComment(code=db.doc.code, document_id=db.doc.id, kind="comment",
                          body="hi", author_user_id=1)
    for k, v in over.items():
        setattr(row, k, v)
    db.add(row)
    db.commit()
    return row


def test_minimal_comment_persists_with_defaults(db):
    row = _comment(db)
    assert (row.status, row.kind, row.parent_id, row.anchor, row.label) == ("open", "comment", None, None, None)
    assert row.created_at and row.updated_at and row.edited_at is None


def test_anchor_round_trips_as_json(db):
    anchor = {"originalText": "x", "htmlAnchor": {"selector": "p", "tagName": "p"}}
    row = _comment(db, anchor=anchor)
    db.expire_all()
    from documents.models import DocumentComment
    assert db.get(DocumentComment, row.id).anchor == anchor


def test_document_level_anchor_is_sql_null(db):
    from sqlalchemy import select
    from documents.models import DocumentComment
    doc_level = _comment(db, anchor=None)
    anchored = _comment(db, anchor={"originalText": "x"})
    ids = [r.id for r in db.execute(
        select(DocumentComment).where(DocumentComment.anchor.is_(None))).scalars().all()]
    assert doc_level.id in ids
    assert anchored.id not in ids


@pytest.mark.parametrize("over", [
    {"author_user_id": 1, "author_agent": "jarvis"},            # two authors
    {"author_user_id": None, "author_agent": None},             # no author
    {"kind": "suggestion", "suggested_text": None},             # suggestion needs text
    {"kind": "comment", "suggested_text": "x"},                 # comment may not carry text
    {"status": "closed"},                                       # bad status
    {"kind": "redline"},                                        # bad kind
])
def test_check_constraints_reject(db, over):
    with pytest.raises(IntegrityError):
        _comment(db, **over)
    db.rollback()


def test_attachment_row_persists_unlinked(db):
    from documents.models import DocumentCommentAttachment
    att = DocumentCommentAttachment(code=db.doc.code, comment_id=None, uploaded_by_user_id=1,
                                    filename="a.png", content_type="image/png", size_bytes=3,
                                    storage_key="documents/ART-0001/x.png")
    db.add(att)
    db.commit()
    assert att.id and att.comment_id is None


def test_forbidden_error_exists():
    from documents.errors import ForbiddenError
    assert issubclass(ForbiddenError, Exception)


def test_comment_number_is_nullable(db):
    from documents.models import DocumentComment
    c = DocumentComment(code=db.doc.code, document_id=db.doc.id, number=None, body="r",
                        author_agent="jarvis")
    db.add(c)
    db.commit()
    assert c.id and c.number is None


def test_comment_counter_persists(db):
    from documents.models import DocumentCommentCounter
    db.add(DocumentCommentCounter(code="ART-0001", next_number=3))
    db.commit()
    assert db.get(DocumentCommentCounter, "ART-0001").next_number == 3
