"""mk1-mode attachments gate reads lims_parent_attachments, never SENAITE
(spec §5). Fail-closed: no native rows → kinds empty → existing blocker."""
import pytest

from database import SessionLocal
from models import LimsSample, LimsParentAttachment
from main import _parent_attachment_kinds_native


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback(); s.close()


def _sample(db, **atts):
    row = LimsSample(sample_id="TEST-GATE-01", status="verified")
    db.add(row); db.flush()
    for kind, extra in atts.items():
        db.add(LimsParentAttachment(
            lims_sample_pk=row.id, kind=extra.get("kind", kind),
            filename="f", content_type=extra.get("ct", "image/png"),
            storage=extra.get("storage", "s3"), storage_key="k",
            render_in_report=extra.get("rir", True),
            attachment_type=extra.get("at", "Sample Image"),
            created_by_user_id=None))
    db.flush()
    return row


def test_both_kinds_detected(db):
    row = _sample(db,
        img={"kind": "receive_image", "at": "Sample Image"},
        chrom={"kind": "chromatogram", "at": "HPLC Graph", "ct": "text/csv", "rir": False})
    assert _parent_attachment_kinds_native(db, row.id) == {"image", "chromatogram"}


def test_empty_without_rows(db):
    row = _sample(db)
    assert _parent_attachment_kinds_native(db, row.id) == set()


def test_senaite_storage_invisible(db):
    row = _sample(db, img={"kind": "receive_image", "storage": "senaite"})
    assert _parent_attachment_kinds_native(db, row.id) == set()
