"""Schema + model coverage for lims_parent_attachments (read-flip spec §7).

House pattern: live dev DB, TEST-prefixed rows, FK-safe cleanup.
"""
import pytest
from sqlalchemy import select, text

from database import SessionLocal
from models import LimsSample, LimsParentAttachment


TEST_SAMPLE_ID = "TEST-PATT-SCHEMA-P1"


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        # FK-safe cleanup: attachments ride the CASCADE on lims_samples
        row = s.execute(select(LimsSample).where(
            LimsSample.sample_id == TEST_SAMPLE_ID)).scalar_one_or_none()
        if row is not None:
            s.delete(row)
            s.commit()
        s.close()


def test_model_round_trip_and_cascade(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    db.add(LimsParentAttachment(lims_sample_pk=parent.id, kind="vial_image",
                                filename="v-1.png", storage="s3",
                                storage_key="k/x.png", render_in_report=True,
                                attachment_type="Sample Image"))
    db.commit()

    got = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalar_one()
    assert got.kind == "vial_image"
    assert got.filename == "v-1.png"
    assert got.content_type is None
    assert got.storage == "s3"
    assert got.storage_key == "k/x.png"
    assert got.senaite_attachment_uid is None
    assert got.render_in_report is True
    assert got.attachment_type == "Sample Image"
    assert got.created_by_user_id is None
    assert got.created_at is not None

    # CASCADE: deleting the sample removes the attachment
    attachment_id = got.id
    db.delete(parent)
    db.commit()
    assert db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.id == attachment_id)).scalar_one_or_none() is None


def test_kind_check_accepts_chromatogram(db):
    """final review (2026-07-14): 'chromatogram' was widened onto the kind
    CHECK via a named DROP/re-ADD migration pair (the dev DB predates this
    kind — the original CREATE TABLE only had 4 values; database.py's
    migration list now appends `DROP CONSTRAINT IF EXISTS
    lims_parent_attachments_kind_check` + a 5-value re-ADD). This is the
    discriminating assertion that the swap actually took effect against a
    live Postgres constraint name: if the migration's guessed name doesn't
    match Postgres's real auto-generated inline-CHECK name, DROP ... IF
    EXISTS silently no-ops, the ADD creates a second (redundant, still
    4-value-blocking) constraint, and this insert fails against the OLD
    list forever — exactly the silent-capture-death class the last-boot-wins
    lesson warns about. Requires `init_db()` to have run against this DB
    first (task contract)."""
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    db.add(LimsParentAttachment(lims_sample_pk=parent.id, kind="chromatogram",
                                filename="chrom.csv", storage="senaite",
                                render_in_report=False,
                                attachment_type="HPLC Graph"))
    db.commit()

    got = db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == parent.id)).scalar_one()
    assert got.kind == "chromatogram"
    assert got.attachment_type == "HPLC Graph"


def test_kind_and_storage_checks_reject_unknown(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    bad_kind = text(
        "INSERT INTO lims_parent_attachments "
        "  (lims_sample_pk, kind, filename, storage) "
        "VALUES (:pk, 'bogus', 'f.png', 's3')"
    )
    with pytest.raises(Exception):
        db.execute(bad_kind, {"pk": parent.id})
        db.commit()
    db.rollback()

    bad_storage = text(
        "INSERT INTO lims_parent_attachments "
        "  (lims_sample_pk, kind, filename, storage) "
        "VALUES (:pk, 'manual', 'f.png', 'zodb')"
    )
    with pytest.raises(Exception):
        db.execute(bad_storage, {"pk": parent.id})
        db.commit()
    db.rollback()

    n = db.execute(text(
        "SELECT COUNT(*) FROM lims_parent_attachments WHERE lims_sample_pk=:pk"
    ), {"pk": parent.id}).scalar()
    assert n == 0


def test_uid_partial_unique(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    dup_uid = text(
        "INSERT INTO lims_parent_attachments "
        "  (lims_sample_pk, kind, filename, storage, senaite_attachment_uid) "
        "VALUES (:pk, 'manual', :fn, 'senaite', 'TEST-UID-1') "
        "ON CONFLICT DO NOTHING"
    )
    db.execute(dup_uid, {"pk": parent.id, "fn": "a.png"})
    db.execute(dup_uid, {"pk": parent.id, "fn": "b.png"})
    db.commit()

    n_uid = db.execute(text(
        "SELECT COUNT(*) FROM lims_parent_attachments "
        "WHERE senaite_attachment_uid = 'TEST-UID-1'"
    )).scalar()
    assert n_uid == 1

    null_uid = text(
        "INSERT INTO lims_parent_attachments "
        "  (lims_sample_pk, kind, filename, storage) "
        "VALUES (:pk, 'manual', :fn, 'senaite')"
    )
    db.execute(null_uid, {"pk": parent.id, "fn": "c.png"})
    db.execute(null_uid, {"pk": parent.id, "fn": "d.png"})
    db.commit()

    n_null = db.execute(text(
        "SELECT COUNT(*) FROM lims_parent_attachments "
        "WHERE lims_sample_pk=:pk AND senaite_attachment_uid IS NULL"
    ), {"pk": parent.id}).scalar()
    assert n_null == 2
