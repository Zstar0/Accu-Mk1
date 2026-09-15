"""Documents library — tables, constraints, blob storage (spec §3, §4)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker


def _engine():
    from database import Base
    import models  # noqa: F401  (users table: documents.created_by_user_id FK)
    import documents.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return engine


def test_tables_created():
    names = set(inspect(_engine()).get_table_names())
    assert {"document_categories", "documents", "document_code_counters"} <= names


def _row(cat_id, rev, status):
    from documents.models import Document
    return Document(code="ART-0001", revision=rev, title="t", category_id=cat_id,
                    status=status, storage_key=f"ART-0001/r{rev}.html",
                    size_bytes=1, content_sha256="0" * 64)


def test_code_revision_unique():
    from sqlalchemy.exc import IntegrityError
    from documents.models import DocumentCategory
    s = sessionmaker(bind=_engine())()
    cat = DocumentCategory(name="Artifact", code_prefix="ART")
    s.add(cat)
    s.flush()
    s.add(_row(cat.id, 1, "draft"))
    s.commit()
    s.add(_row(cat.id, 1, "draft"))
    with pytest.raises(IntegrityError):
        s.commit()


def test_one_active_revision_per_code():
    from sqlalchemy.exc import IntegrityError
    from documents.models import DocumentCategory
    s = sessionmaker(bind=_engine())()
    cat = DocumentCategory(name="Artifact", code_prefix="ART")
    s.add(cat)
    s.flush()
    s.add(_row(cat.id, 1, "active"))
    s.commit()
    s.add(_row(cat.id, 2, "active"))
    with pytest.raises(IntegrityError):
        s.commit()
    s.rollback()
    # Two retired revisions of one code are fine — the index is partial.
    s.add(_row(cat.id, 2, "retired"))
    s.add(_row(cat.id, 3, "retired"))
    s.commit()


def test_storage_roundtrips(tmp_path):
    from documents.storage import (DocumentNotFound, FilesystemDocumentStorage,
                                   InMemoryDocumentStorage)
    for st in (InMemoryDocumentStorage(), FilesystemDocumentStorage(root=str(tmp_path))):
        key = st.save("ART-0001", 1, b"<html>x</html>")
        assert key == "ART-0001/r1.html"
        assert st.fetch(key) == b"<html>x</html>"
        with pytest.raises(DocumentNotFound):
            st.fetch("ART-0001/r9.html")


def test_filesystem_refuses_traversal(tmp_path):
    from documents.storage import DocumentStorageError, FilesystemDocumentStorage
    st = FilesystemDocumentStorage(root=str(tmp_path))
    with pytest.raises(DocumentStorageError):
        st.fetch("../etc/passwd")
    with pytest.raises(DocumentStorageError):
        st.save("ART-0001", 1, b"")


def test_s3_storage_wraps_failures(monkeypatch, tmp_path):
    # Point the photo-storage default at tmp_path in case this test is the first
    # to import the module (it builds a Filesystem default at import time).
    monkeypatch.setenv("MK1_PHOTO_STORAGE_DIR", str(tmp_path))
    import sub_samples.photo_storage as ps
    from documents.storage import (DocumentNotFound, DocumentStorageError,
                                   S3DocumentStorage)

    class _StubS3:
        def __init__(self, prefix=None, **kw):
            pass

        def fetch_photo(self, key):
            if key == "missing":
                raise ps.PhotoNotFoundError(key)
            raise RuntimeError("boom")

        def save_photo(self, sample_id, data, filename):
            raise RuntimeError("boom")

    monkeypatch.setattr(ps, "S3PhotoStorage", _StubS3)
    st = S3DocumentStorage()
    with pytest.raises(DocumentNotFound):
        st.fetch("missing")
    with pytest.raises(DocumentStorageError):
        st.fetch("x")
    with pytest.raises(DocumentStorageError):
        st.save("ART-0001", 1, b"<x>")


def test_filesystem_fetch_rejects_directory_key(tmp_path):
    from documents.storage import DocumentStorageError, FilesystemDocumentStorage
    st = FilesystemDocumentStorage(root=str(tmp_path))
    st.save("ART-0001", 1, b"<x>")
    with pytest.raises(DocumentStorageError):
        st.fetch("ART-0001")
    assert st.fetch("ART-0001/r1.html") == b"<x>"


def test_status_check_constraint():
    from sqlalchemy.exc import IntegrityError
    from documents.models import DocumentCategory
    s = sessionmaker(bind=_engine())()
    cat = DocumentCategory(name="Artifact", code_prefix="ART")
    s.add(cat)
    s.flush()
    s.add(_row(cat.id, 1, "published"))
    with pytest.raises(IntegrityError):
        s.commit()
