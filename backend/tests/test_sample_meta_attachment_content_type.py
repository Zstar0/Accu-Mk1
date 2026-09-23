"""Attachment role selection must respect content type (P-1777, 2026-09-22).

Legacy samples mirrored from SENAITE can carry their chromatogram CSV typed
'Sample Image' (the May-2026 attach flow). The photo selector took the NEWEST
'Sample Image' row with no content-type guard, so the CSV won the photo slot
and no chromatogram row was found: 26 additional COAs shipped with a blank
photo and an empty chromatogram section. Both twins (coa.sample_meta._newest
and main._parent_attachment_kinds_native) are pinned here with the P-1777
row shape: jpeg first, CSV newer, both typed 'Sample Image'.
"""
from coa.sample_meta import _newest, select_chromatogram_row
from main import _parent_attachment_kinds_native
from models import LimsParentAttachment, LimsSample


def _parent(db, sample_id="P-1777"):
    row = LimsSample(sample_id=sample_id, external_lims_uid=f"uid-{sample_id}",
                     sample_type="x", status="published")
    db.add(row); db.flush()
    return row


def _att(db, parent, *, filename, content_type, attachment_type="Sample Image",
         kind="manual", render_in_report=True):
    row = LimsParentAttachment(
        lims_sample_pk=parent.id, kind=kind, filename=filename,
        content_type=content_type, storage="s3", storage_key="k",
        render_in_report=render_in_report, attachment_type=attachment_type,
        created_by_user_id=None)
    db.add(row); db.flush()
    return row


def _p1777(db):
    p = _parent(db)
    jpeg = _att(db, p, filename="P-1777-signal.jpeg", content_type="image/jpeg")
    csv = _att(db, p, filename="P-1777-chromatogram_P-0636.csv",
               content_type="text/comma-separated-values")
    return p, jpeg, csv


def test_photo_arm_skips_newer_csv_typed_sample_image(db_session):
    p, jpeg, csv = _p1777(db_session)
    assert _newest(db_session, p.id, chromatogram=False).id == jpeg.id


def test_photo_arm_returns_none_when_only_a_csv_is_typed_sample_image(db_session):
    p = _parent(db_session)
    _att(db_session, p, filename="only.csv", content_type="text/csv")
    assert _newest(db_session, p.id, chromatogram=False) is None


def test_chromatogram_arm_accepts_csv_typed_sample_image(db_session):
    p, jpeg, csv = _p1777(db_session)
    assert select_chromatogram_row(db_session, p).id == csv.id


def test_chromatogram_arm_still_rejects_images_typed_hplc_graph(db_session):
    p = _parent(db_session)
    _att(db_session, p, filename="screenshot.png", content_type="image/png",
         attachment_type="HPLC Graph", render_in_report=False)
    assert select_chromatogram_row(db_session, p) is None


def test_gate_twin_classifies_p1777_rows_as_image_and_chromatogram(db_session):
    p, jpeg, csv = _p1777(db_session)
    assert _parent_attachment_kinds_native(db_session, p.id) == {"image", "chromatogram"}


def test_gate_twin_lone_csv_typed_sample_image_is_not_an_image(db_session):
    p = _parent(db_session)
    _att(db_session, p, filename="only.csv", content_type="text/csv")
    assert _parent_attachment_kinds_native(db_session, p.id) == {"chromatogram"}
