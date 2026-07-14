"""Schema + model coverage for lims_sample_remarks (read-flip spec §6).

House pattern: live dev DB, TEST-prefixed rows, FK-safe cleanup.
"""
import pytest
from sqlalchemy import select, text

from database import SessionLocal
from models import LimsSample, LimsSampleRemark


TEST_SAMPLE_ID = "TEST-RMK-SCHEMA-P1"


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        # FK-safe cleanup: remarks ride the CASCADE on lims_samples
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

    db.add(LimsSampleRemark(lims_sample_pk=parent.id,
                            content="<p>test remark</p>",
                            author_label="test.user"))
    db.commit()

    got = db.execute(select(LimsSampleRemark).where(
        LimsSampleRemark.lims_sample_pk == parent.id)).scalar_one()
    assert got.content == "<p>test remark</p>"
    assert got.author_user_id is None
    assert got.author_label == "test.user"
    assert got.created_at is not None

    # CASCADE: deleting the sample removes the remark
    remark_id = got.id
    db.delete(parent)
    db.commit()
    assert db.execute(select(LimsSampleRemark).where(
        LimsSampleRemark.id == remark_id)).scalar_one_or_none() is None


def test_dedup_index_blocks_exact_duplicate(db):
    """The backfill's idempotency key: (lims_sample_pk, created_at,
    md5(content)) unique. Same triple → second INSERT must not create a row
    (ON CONFLICT DO NOTHING path used by the backfill)."""
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    params = {"pk": parent.id, "content": "<p>dup</p>",
              "created": "2026-01-02T03:04:05"}
    ins = text(
        "INSERT INTO lims_sample_remarks "
        "  (lims_sample_pk, content, author_label, created_at) "
        "VALUES (:pk, :content, 'seed', :created) "
        "ON CONFLICT DO NOTHING"
    )
    db.execute(ins, params)
    db.execute(ins, params)
    db.commit()

    n = db.execute(text(
        "SELECT COUNT(*) FROM lims_sample_remarks WHERE lims_sample_pk=:pk"
    ), {"pk": parent.id}).scalar()
    assert n == 1
