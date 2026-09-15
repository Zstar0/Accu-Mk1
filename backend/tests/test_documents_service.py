"""Documents library service rules (spec §3.1, §3.3, §5.2, §5.4)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
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
    session = sessionmaker(bind=engine)()
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    service.seed_categories(session)
    yield session
    session.close()


def _prefixes(db):
    from documents import service
    return [(c.name, c.code_prefix, n) for c, n in service.list_categories(db)]


def test_seed_is_idempotent(db):
    from documents import service
    service.seed_categories(db)
    service.seed_categories(db)
    assert _prefixes(db) == [("Artifact", "ART", 0), ("SOP", "SOP", 0)]
    assert [c.sort_order for c, _ in service.list_categories(db)] == [0, 1]


def test_create_category_normalizes_prefix(db):
    from documents import service
    cat = service.create_category(db, name=" Validation ", code_prefix="val")
    assert (cat.name, cat.code_prefix, cat.active) == ("Validation", "VAL", True)


@pytest.mark.parametrize("prefix", ["", "a", "TOO-LONG-PREFIX", "ab c", "A/B", "ABCDEFGHIJK"])
def test_create_category_rejects_bad_prefix(db, prefix):
    from documents import service
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_category(db, name="X", code_prefix=prefix)


def test_create_category_rejects_duplicates(db):
    from documents import service
    from documents.errors import ConflictError
    with pytest.raises(ConflictError):
        service.create_category(db, name="Artifact", code_prefix="XYZ")
    with pytest.raises(ConflictError):
        service.create_category(db, name="Other", code_prefix="art")


def test_update_category_fields_and_name_conflict(db):
    from documents import service
    from documents.errors import ConflictError
    cat = service.create_category(db, name="Temp", code_prefix="TMP")
    cat = service.update_category(db, cat.id, name="Temp2", description="d",
                                  sort_order=9, active=False)
    assert (cat.name, cat.description, cat.sort_order, cat.active) == ("Temp2", "d", 9, False)
    with pytest.raises(ConflictError):
        service.update_category(db, cat.id, name="SOP")


def test_delete_unused_category(db):
    from documents import service
    from documents.errors import NotFoundError
    cat = service.create_category(db, name="Temp", code_prefix="TMP")
    service.delete_category(db, cat.id)
    with pytest.raises(NotFoundError):
        service.get_category(db, cat.id)


def test_resolve_category_by_prefix_name_or_id(db):
    from documents import service
    from documents.errors import BadRequestError, NotFoundError
    art = service.resolve_category(db, category="art")
    assert art.code_prefix == "ART"
    assert service.resolve_category(db, category="SOP").name == "SOP"
    assert service.resolve_category(db, category_id=art.id).id == art.id
    with pytest.raises(NotFoundError):
        service.resolve_category(db, category="nope")
    with pytest.raises(BadRequestError):
        service.resolve_category(db)
    service.update_category(db, art.id, active=False)
    with pytest.raises(BadRequestError):
        service.resolve_category(db, category="ART")


def test_mint_code_sequences_per_prefix(db):
    from documents import service
    assert service.mint_code(db, "ART") == "ART-0001"
    assert service.mint_code(db, "ART") == "ART-0002"
    assert service.mint_code(db, "SOP") == "SOP-0001"


def test_mint_code_skips_numbers_already_taken(db):
    from documents import service
    from documents.models import Document
    art = service.resolve_category(db, category="ART")
    db.add(Document(code="ART-0001", revision=1, title="supplied", category_id=art.id,
                    status="draft", storage_key="ART-0001/r1.html", size_bytes=1,
                    content_sha256="0" * 64))
    db.commit()
    assert service.mint_code(db, "ART") == "ART-0002"


def test_create_category_conflict_when_name_and_prefix_hit_different_rows(db):
    from documents import service
    from documents.errors import ConflictError
    # name matches "Artifact", prefix matches "SOP" — two distinct rows
    with pytest.raises(ConflictError):
        service.create_category(db, name="artifact", code_prefix="sop")


def test_resolve_category_prefers_exact_prefix_over_name(db):
    from documents import service
    # "ART" is now both the seeded Artifact's prefix and this category's name.
    service.create_category(db, name="ART", code_prefix="XYZ")
    assert service.resolve_category(db, category="ART").code_prefix == "ART"
    assert service.resolve_category(db, category="xyz").name == "ART"
    # Precedence must not ride on insertion order: re-mint Artifact so the
    # name-matching row is now the LOWER id. Lowest-id-wins would answer "XYZ".
    service.delete_category(db, service.resolve_category(db, category="Artifact").id)
    remade = service.create_category(db, name="Artifact", code_prefix="ART")
    assert remade.id > service.resolve_category(db, category="xyz").id
    assert service.resolve_category(db, category="ART").code_prefix == "ART"


def test_delete_category_refused_when_referenced_by_document(db):
    from documents import service
    from documents.errors import ConflictError
    from documents.models import Document
    cat = service.create_category(db, name="Temp", code_prefix="TMP")
    db.add(Document(code="TMP-0001", revision=1, title="held", category_id=cat.id,
                    status="draft", storage_key="TMP-0001/r1.html", size_bytes=1,
                    content_sha256="0" * 64))
    db.commit()
    with pytest.raises(ConflictError):
        service.delete_category(db, cat.id)


def test_update_category_rejects_unknown_field(db):
    from documents import service
    from documents.errors import BadRequestError
    art = service.resolve_category(db, category="ART")
    with pytest.raises(BadRequestError):
        service.update_category(db, art.id, code_prefix="ZZZ")
    with pytest.raises(BadRequestError):
        service.update_category(db, art.id, bogus=1)


def test_list_categories_counts_distinct_codes(db):
    from documents import service
    from documents.models import Document
    art = service.resolve_category(db, category="ART")
    for rev in (1, 2):
        db.add(Document(code="ART-0001", revision=rev, title=f"rev {rev}",
                        category_id=art.id, status="draft",
                        storage_key=f"ART-0001/r{rev}.html", size_bytes=1,
                        content_sha256="0" * 64))
    db.commit()
    counts = {c.name: n for c, n in service.list_categories(db)}
    assert counts["Artifact"] == 1
