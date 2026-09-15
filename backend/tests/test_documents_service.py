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


# --- documents -------------------------------------------------------------------

HTML = "<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>"


def _art(db):
    from documents import service
    return service.resolve_category(db, category="ART")


def test_create_mints_code_and_activates_by_default(db):
    from datetime import date
    from documents import service, storage
    doc, created = service.create_document(db, title=" Audit ", html=HTML, category=_art(db),
                                           author="Claude Code", source_session="sess-1")
    assert created is True
    assert (doc.code, doc.revision, doc.status, doc.title) == ("ART-0001", 1, "active", "Audit")
    assert doc.effective_date == date.today()
    assert doc.activated_at is not None and doc.supersedes_id is None
    assert doc.size_bytes == len(HTML.encode()) and len(doc.content_sha256) == 64
    assert storage.get_storage().fetch(doc.storage_key) == HTML.encode()
    assert service.read_content(doc) == HTML.encode()


def test_create_draft_when_activate_false(db):
    from documents import service
    doc, _ = service.create_document(db, title="d", html=HTML, category=_art(db), activate=False)
    assert doc.status == "draft" and doc.effective_date is None and doc.activated_at is None


def test_create_with_supplied_code_checks_prefix(db):
    from documents import service
    from documents.errors import BadRequestError
    doc, _ = service.create_document(db, title="s", html=HTML, category=_art(db), code="art-0100")
    assert doc.code == "ART-0100"
    with pytest.raises(BadRequestError):
        service.create_document(db, title="s", html=HTML, category=_art(db), code="SOP-0001")
    with pytest.raises(BadRequestError):
        service.create_document(db, title="s", html=HTML, category=_art(db), code="bad code")


@pytest.mark.parametrize("html", ["", "   ", "not html", "{}", "x" * 10])
def test_create_rejects_non_html(db, html):
    from documents import service
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_document(db, title="s", html=html, category=_art(db))


def test_create_rejects_oversize(db):
    from documents import service
    from documents.errors import BadRequestError
    big = "<html>" + ("x" * (service.MAX_BYTES + 1)) + "</html>"
    with pytest.raises(BadRequestError):
        service.create_document(db, title="s", html=big, category=_art(db))


def test_create_requires_title_and_category(db):
    from documents import service
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_document(db, title="  ", html=HTML, category=_art(db))
    with pytest.raises(BadRequestError):
        service.create_document(db, title="t", html=HTML, category=None)


def test_repush_same_code_new_bytes_is_next_revision_and_retires_previous(db):
    from documents import service
    r1, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    r2, created = service.create_document(db, title="v2", html=HTML.replace("hi", "hello"),
                                          category=None, code=r1.code)
    assert created is True
    assert (r2.code, r2.revision, r2.status, r2.supersedes_id) == (r1.code, 2, "active", r1.id)
    assert r2.category_id == r1.category_id  # inherited when category is None
    db.refresh(r1)
    assert r1.status == "retired" and r1.retired_at is not None
    assert service.revision_count(db, r1.code) == 2
    assert [d.revision for d in service.get_revisions(db, r1.code)] == [1, 2]


def test_repush_identical_bytes_is_a_metadata_patch_not_a_revision(db):
    from documents import service
    r1, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    same, created = service.create_document(db, title="renamed", html=HTML, category=None,
                                            code=r1.code, description="desc")
    assert created is False and same.id == r1.id and same.revision == 1
    assert (same.title, same.description) == ("renamed", "desc")
    assert service.revision_count(db, r1.code) == 1


def test_activate_and_retire_lockstep(db):
    from documents import service
    from documents.errors import ConflictError
    r1, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    r2, _ = service.create_document(db, title="v2", html=HTML + "<!--2-->", category=None,
                                    code=r1.code, activate=False)
    assert r2.status == "draft"
    db.refresh(r1)
    assert r1.status == "active"  # a draft revision does not disturb the active one
    with pytest.raises(ConflictError):
        service.activate_document(db, r1.id)  # active -> activate: not a draft
    r2 = service.activate_document(db, r2.id)
    db.refresh(r1)
    assert (r1.status, r2.status) == ("retired", "active")
    with pytest.raises(ConflictError):
        service.retire_document(db, r1.id)  # already retired
    r2 = service.retire_document(db, r2.id)
    assert r2.status == "retired" and r2.retired_at is not None


def test_repush_rejects_category_with_other_prefix(db):
    """The revision path must agree with the new-code path: a cross-prefix category
    is refused BEFORE the blob write, so neither a revision nor an orphan blob."""
    from documents import service, storage
    from documents.errors import BadRequestError
    doc, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    sop = service.resolve_category(db, category="SOP")
    blobs = len(storage.get_storage().blobs)
    with pytest.raises(BadRequestError):
        service.create_document(db, title="v2", html=HTML + "<!--2-->", code=doc.code,
                                category=sop)
    assert service.revision_count(db, doc.code) == 1
    assert len(storage.get_storage().blobs) == blobs


def test_patch_metadata_only(db):
    from datetime import date
    from documents import service
    from documents.errors import BadRequestError, NotFoundError
    art = _art(db)
    doc, _ = service.create_document(db, title="v1", html=HTML, category=art)
    doc = service.patch_document(db, doc.id, title="new", description=None,
                                 category_id=art.id, effective_date=date(2026, 1, 2))
    assert (doc.title, doc.description, doc.category_id, doc.effective_date) == \
        ("new", None, art.id, date(2026, 1, 2))
    assert doc.revision == 1
    with pytest.raises(BadRequestError):
        service.patch_document(db, doc.id, title="   ")
    with pytest.raises(BadRequestError):
        service.patch_document(db, doc.id, status="retired")
    with pytest.raises(NotFoundError):
        service.patch_document(db, doc.id, category_id=9999)
    with pytest.raises(NotFoundError):
        service.patch_document(db, 9999, title="x")


def test_patch_rejects_category_with_other_prefix(db):
    """A code is minted from its category's prefix; PATCH must not move ART-0001
    under SOP and orphan the code from the category it claims to live in."""
    from documents import service
    from documents.errors import BadRequestError
    art = _art(db)
    sop = service.resolve_category(db, category="SOP")
    doc, _ = service.create_document(db, title="v1", html=HTML, category=art)
    with pytest.raises(BadRequestError):
        service.patch_document(db, doc.id, category_id=sop.id)
    db.refresh(doc)
    assert doc.category_id == art.id
    same = service.patch_document(db, doc.id, category_id=art.id)  # same prefix: allowed
    assert same.category_id == art.id


def test_delete_category_refused_when_referenced(db):
    from documents import service
    from documents.errors import ConflictError
    cat = service.create_category(db, name="Temp", code_prefix="TMP")
    service.create_document(db, title="t", html=HTML, category=cat)
    with pytest.raises(ConflictError):
        service.delete_category(db, cat.id)


def test_list_latest_revision_per_code_with_filters(db):
    from documents import service
    art, sop = _art(db), service.resolve_category(db, category="SOP")
    a, _ = service.create_document(db, title="Alpha audit", html=HTML, category=art,
                                   description="first")
    service.create_document(db, title="Alpha audit v2", html=HTML + "<!--2-->", category=None,
                            code=a.code, activate=False)  # a: r1 active, r2 draft
    b, _ = service.create_document(db, title="Bravo SOP", html=HTML, category=sop, activate=False)
    c, _ = service.create_document(db, title="Charlie", html=HTML, category=art)
    service.retire_document(db, c.id)

    rows, total = service.list_documents(db)
    assert total == 2
    assert [(d.code, d.revision, n) for d, n in rows] == [(b.code, 1, 1), (a.code, 2, 2)] or \
           [(d.code, d.revision, n) for d, n in rows] == [(a.code, 2, 2), (b.code, 1, 1)]

    # Filter-first: the latest revision AMONG rows matching the status filter, not
    # "latest overall, then filter" (which hid a entirely behind its draft r2).
    rows, total = service.list_documents(db, statuses=("active",))
    assert total == 1
    assert [(d.code, d.revision, n) for d, n in rows] == [(a.code, 1, 2)]  # count unfiltered

    rows, total = service.list_documents(db, statuses=("retired",))
    assert total == 1 and rows[0][0].code == c.code

    rows, total = service.list_documents(db, category_id=sop.id)
    assert total == 1 and rows[0][0].code == b.code

    rows, total = service.list_documents(db, q="bravo")
    assert total == 1 and rows[0][0].code == b.code
    rows, total = service.list_documents(db, q=a.code.lower())
    assert total == 1 and rows[0][0].code == a.code

    rows, total = service.list_documents(db, sort="title", statuses=STATUSES_ALL)
    assert [d.title for d, _ in rows] == ["Alpha audit v2", "Bravo SOP", "Charlie"]

    rows, total = service.list_documents(db, statuses=STATUSES_ALL, page=2, page_size=2)
    assert total == 3 and len(rows) == 1


def test_list_retired_filter_sees_older_retired_revision(db):
    """r1 retired by r2's activation: a retired-only listing surfaces r1, and still
    reports the UNFILTERED revision count for the code."""
    from documents import service
    d, _ = service.create_document(db, title="Delta", html=HTML, category=_art(db))
    service.create_document(db, title="Delta v2", html=HTML + "<!--2-->", category=None,
                            code=d.code)  # activates r2, retires r1
    rows, total = service.list_documents(db, statuses=("retired",))
    assert total == 1
    assert [(x.code, x.revision, x.status, n) for x, n in rows] == [(d.code, 1, "retired", 2)]


STATUSES_ALL = ("draft", "active", "retired")


def test_get_document_not_found(db):
    from documents import service
    from documents.errors import NotFoundError
    with pytest.raises(NotFoundError):
        service.get_document(db, 12345)


def test_create_accepts_exactly_max_bytes(db):
    from documents import service
    html = "<html>" + ("x" * (service.MAX_BYTES - len("<html></html>"))) + "</html>"
    assert len(html.encode()) == service.MAX_BYTES
    doc, _ = service.create_document(db, title="max", html=html, category=_art(db))
    assert doc.size_bytes == service.MAX_BYTES


def test_list_rejects_bad_sort_and_status(db):
    from documents import service
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.list_documents(db, sort="bogus")
    with pytest.raises(BadRequestError):
        service.list_documents(db, statuses=("bogus",))


def test_list_clamps_paging(db):
    from documents import service
    art = _art(db)
    for i in range(3):
        service.create_document(db, title=f"doc {i}", html=HTML + f"<!--{i}-->", category=art)
    rows, total = service.list_documents(db, page=0, page_size=999)
    assert total == 3 and len(rows) == 3  # page clamped to 1, page_size to 200
    rows, total = service.list_documents(db, page=1, page_size=0)
    assert total == 3 and len(rows) == 1  # page_size clamped up to 1


def test_patch_clears_description_and_validates_before_mutating(db):
    from documents import service
    from documents.errors import NotFoundError
    doc, _ = service.create_document(db, title="v1", html=HTML, category=_art(db),
                                     description="d")
    doc = service.patch_document(db, doc.id, description=None)
    assert doc.description is None
    with pytest.raises(NotFoundError):
        service.patch_document(db, doc.id, title="changed", category_id=9999)
    db.refresh(doc)
    assert doc.title == "v1"  # the failed patch left nothing behind to autoflush


def test_latest_for_update_is_a_no_op_on_sqlite(db):
    from documents import service
    doc, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    locked = service._latest(db, doc.code, for_update=True)
    assert locked is not None and locked.id == service._latest(db, doc.code).id


def test_latest_for_update_emits_no_outer_join_on_postgres(db):
    """Regression: Document.category is lazy="joined", so a plain select(Document)
    left-joins document_categories. Postgres then rejects the lock with
    "FOR UPDATE cannot be applied to the nullable side of an outer join" and every
    revision push 500s. SQLite ignores FOR UPDATE entirely, so only compiling what
    _latest actually builds, against the real dialect, catches it."""
    from sqlalchemy.dialects import postgresql

    from documents import service

    seen = []
    real_execute = db.execute
    db.execute = lambda stmt, *a, **kw: (seen.append(stmt), real_execute(stmt, *a, **kw))[1]
    try:
        service._latest(db, "ART-0001", for_update=True)
        locked = str(seen[-1].compile(dialect=postgresql.dialect()))
        service._latest(db, "ART-0001")
        plain = str(seen[-1].compile(dialect=postgresql.dialect()))
    finally:
        db.execute = real_execute

    assert "FOR UPDATE" in locked
    assert "LEFT OUTER JOIN" not in locked, locked
    # the unlocked path keeps its eager join
    assert "LEFT OUTER JOIN" in plain
