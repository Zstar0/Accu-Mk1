"""Publishing a review: company space + CR category, one code per customer, revisions."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from customer_review import document


@pytest.fixture
def db():
    import documents.models  # noqa: F401  register documents tables before create_all
    import models  # noqa: F401
    from database import Base
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


REVIEW = {"headline": "h", "sentiment": {"score": 0, "trend": "steady", "reason": "r", "citations": [], "unsupported": True},
          "open_issues": [], "shortfalls": [], "strengths": [], "next_steps": []}


def pub(db, code=None, headline="h"):
    return document.publish(db, review={**REVIEW, "headline": headline}, customer_key="wc:1", customer_name="Kyle",
                            author="Forrest Parker", run_id=1, model="m", lookups=3, cost_usd=0.1, metric_cards=[],
                            code=code)


def test_first_publish_creates_space_category_and_code(db):
    from documents.models import Document, DocumentSpace

    doc_id, code = pub(db)
    assert code.startswith("CR-")
    sp = db.query(DocumentSpace).filter_by(slug="customer-reviews").one()
    assert sp.visibility == "company"
    d = db.get(Document, doc_id)
    assert d.space_id == sp.id and d.title == "Customer review: Kyle" and d.author == "Forrest Parker"


def test_second_publish_is_a_new_revision_of_the_same_code(db):
    from documents.models import Document

    first_id, code = pub(db)
    second_id, code2 = pub(db, code=code, headline="changed")
    assert code2 == code and second_id != first_id
    assert db.get(Document, second_id).revision == db.get(Document, first_id).revision + 1


def test_ensure_is_idempotent(db):
    a = document.ensure_space_and_category(db)
    b = document.ensure_space_and_category(db)
    assert (a[0].id, a[1].id) == (b[0].id, b[1].id)


def test_moved_document_still_takes_new_revisions(db):
    from documents.models import Document
    from documents.service import create_space

    first_id, code = pub(db)
    other = create_space(db, slug="elsewhere", name="Elsewhere")
    db.query(Document).filter_by(code=code).update({"space_id": other.id})
    db.commit()
    second_id, code2 = pub(db, code=code, headline="after move")
    assert code2 == code and db.get(Document, second_id).space_id == other.id


def test_existing_code_is_found_when_the_run_row_lost_it(db):
    _, code = pub(db)
    assert document.existing_code(db, "wc:1") == code
    assert document.existing_code(db, "wc:2") is None
