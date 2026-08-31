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


# ─── Manual chromatogram uploads (BW-0106, 2026-08-31) ──────────────────────
# A CSV attached from the sample page lands kind='manual' with SENAITE's
# 'HPLC Graph' type — the gate must accept it (symmetric with the image
# arm's attachment_type alternative). A non-CSV typed 'HPLC Graph' (e.g. a
# chromatogram screenshot) must NOT: the coab wire role is chromatogram_csv
# and the renderer parses CSV.

def test_manual_csv_typed_hplc_graph_counts_as_chromatogram(db):
    row = _sample(db,
        chrom={"kind": "manual", "at": "HPLC Graph", "ct": "text/csv"})
    assert _parent_attachment_kinds_native(db, row.id) == {"chromatogram"}


def test_manual_senaite_ct_variant_counts(db):
    row = _sample(db,
        chrom={"kind": "manual", "at": "HPLC Graph",
               "ct": "text/comma-separated-values"})
    assert _parent_attachment_kinds_native(db, row.id) == {"chromatogram"}


def test_image_typed_hplc_graph_is_not_a_chromatogram(db):
    row = _sample(db,
        chrom={"kind": "manual", "at": "HPLC Graph", "ct": "image/jpeg"})
    assert _parent_attachment_kinds_native(db, row.id) == set()
