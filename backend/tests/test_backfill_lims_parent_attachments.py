"""Unit tests for the one-time SENAITE AR-attachment history backfill
(2026-07-14-parent-ar-read-flip spec §7, Layer 3 Task 4).

Harness idioms cloned from test_backfill_lims_sample_remarks.py: a sqlite
in-memory `db_factory`, patched `sen` fetches, a `_run` wrapper, and
tmp-path checkpoints. Two adaptations from that precedent, both load-bearing:

1. Two SENAITE calls per attachment instead of one: `sen.fetch_parent_metadata`
   returns the AR detail whose `Attachment` list carries minimal refs (uid
   only, in these tests); each ref needs a SECOND fetch,
   `sen.fetch_attachment_meta(uid)`, to resolve `AttachmentFile`
   (filename/content_type), `RenderInReport`, and `created`. Both are
   patched independently in `_run`.
2. The idempotency key here is `lims_parent_attachments.senaite_attachment_uid`
   under a PARTIAL unique index (`uq_lims_parent_attachments_uid`, `WHERE
   senaite_attachment_uid IS NOT NULL` — capture-time rows are uid-less until
   this sweep adopts them, so the index can't be a plain full-column unique
   constraint). `db_factory` recreates that same partial index — sqlite
   supports `WHERE`-qualified unique indexes natively, so no UDF is needed
   here (unlike the remarks harness's md5 dedup key).
"""
from datetime import datetime
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsParentAttachment, LimsSample

from scripts.backfill_lims_parent_attachments import backfill


@pytest.fixture
def db_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with engine.connect() as conn:
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_parent_attachments_uid "
            "ON lims_parent_attachments (senaite_attachment_uid) "
            "WHERE senaite_attachment_uid IS NOT NULL"
        ))
        conn.commit()
    return sessionmaker(bind=engine)


def _seed_sample(db_factory, sample_id: str) -> int:
    db = db_factory()
    row = LimsSample(sample_id=sample_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    pk = row.id
    db.close()
    return pk


def _seed_capture_row(db_factory, pk: int, filename: str, **overrides) -> int:
    """Seed a uid-less capture-time row (Task 2/3's write path) so a sweep
    can adopt it instead of inserting a duplicate."""
    db = db_factory()
    kwargs = dict(
        lims_sample_pk=pk, kind="vial_image", filename=filename,
        content_type="image/png", storage="s3",
        storage_key=f"captures/{filename}", senaite_attachment_uid=None,
        render_in_report=False, created_at=datetime(2026, 1, 1),
    )
    kwargs.update(overrides)
    row = LimsParentAttachment(**kwargs)
    db.add(row)
    db.commit()
    db.refresh(row)
    row_id = row.id
    db.close()
    return row_id


def _meta_with_attachments(refs):
    return {"Attachment": refs}


def _run(db_factory, metas, attachment_metas, ckpt_path, **kw):
    """Drive backfill() against real lims_samples rows in db_factory, with
    sen.fetch_parent_metadata mocked per parent sample_id and
    sen.fetch_attachment_meta mocked per attachment uid. A value in
    `attachment_metas` that IS an Exception instance is raised instead of
    returned — models a per-ref detail-fetch failure.

    `_fetch_attachment` accepts the `api_url` second positional arg
    `_rows_for_sample` now passes (final review, 2026-07-14: prefer the
    ref's self-reported api_url) — unused here since none of these fixtures'
    refs carry one, but the signature must match or the mock's side_effect
    raises a TypeError on every call."""
    def _fetch_attachment(uid, api_url=None):
        val = attachment_metas[uid]
        if isinstance(val, Exception):
            raise val
        return val

    with patch("scripts.backfill_lims_parent_attachments.sen.fetch_parent_metadata") as fpm, \
         patch("scripts.backfill_lims_parent_attachments.sen.fetch_attachment_meta") as fam, \
         patch("scripts.backfill_lims_parent_attachments.time.sleep"):
        fpm.side_effect = lambda sid: metas[sid]
        fam.side_effect = _fetch_attachment
        kwargs = dict(sleep_s=0, batch_size=50, checkpoint_path=ckpt_path,
                      dry_run=False, limit=None)
        kwargs.update(kw)
        stats = backfill(db_factory, **kwargs)
    return stats


def test_backfill_inserts_attachment_rows(db_factory, tmp_path):
    pk = _seed_sample(db_factory, "TEST-ATTBF-P1")
    meta = _meta_with_attachments([{"uid": "A1"}, {"uid": "A2"}])
    attachment_metas = {
        # AttachmentType as a plain string — one shape SENAITE may return it.
        "A1": {"AttachmentFile": {"filename": "img1.png", "content_type": "image/png"},
               "AttachmentType": "HPLC Graph",
               "RenderInReport": True, "created": "2026-01-05T10:00:00"},
        # AttachmentType as a {title: ...} dict — the other shape (matches
        # the display path's extraction in main.py's get_senaite_sample).
        "A2": {"AttachmentFile": {"filename": "data.csv", "content_type": "text/csv"},
               "AttachmentType": {"title": "Sample Image"},
               "RenderInReport": None, "created": "2026-01-06T11:00:00"},
    }
    ckpt = str(tmp_path / "ckpt.json")

    stats = _run(db_factory, {"TEST-ATTBF-P1": meta}, attachment_metas, ckpt)

    assert stats["fetched"] == 1
    assert stats["attachments_seen"] == 2
    assert stats["inserted"] == 2
    assert stats["dup"] == 0
    assert stats["adopted"] == 0
    assert stats["skipped_malformed"] == 0
    assert stats["detail_fetch_errors"] == 0
    assert stats["errors"] == 0

    db = db_factory()
    rows = (db.query(LimsParentAttachment)
            .filter_by(lims_sample_pk=pk)
            .order_by(LimsParentAttachment.senaite_attachment_uid)
            .all())
    assert len(rows) == 2
    a1, a2 = rows
    assert a1.senaite_attachment_uid == "A1"
    assert a1.filename == "img1.png"
    assert a1.content_type == "image/png"
    assert a1.attachment_type == "HPLC Graph"
    assert a1.storage == "senaite"
    assert a1.storage_key is None
    assert a1.kind == "manual"
    assert a1.render_in_report is True
    assert a1.created_at == datetime(2026, 1, 5, 10, 0, 0)
    assert a2.senaite_attachment_uid == "A2"
    assert a2.attachment_type == "Sample Image"  # extracted from dict shape
    assert a2.render_in_report is False  # RenderInReport None -> False
    db.close()


def test_backfill_prefers_ref_api_url_over_constructed(db_factory, tmp_path):
    """final review (2026-07-14): a ref carrying its own `api_url` is passed
    straight through to `fetch_attachment_meta` instead of letting it
    construct one from just the uid — see that function's docstring."""
    _seed_sample(db_factory, "TEST-ATTBF-P7")
    meta = _meta_with_attachments([
        {"uid": "A20", "api_url": "http://senaite.test/self-reported/A20"},
    ])
    ckpt = str(tmp_path / "ckpt.json")

    with patch("scripts.backfill_lims_parent_attachments.sen.fetch_parent_metadata") as fpm, \
         patch("scripts.backfill_lims_parent_attachments.sen.fetch_attachment_meta") as fam, \
         patch("scripts.backfill_lims_parent_attachments.time.sleep"):
        fpm.side_effect = lambda sid: meta
        fam.return_value = {
            "AttachmentFile": {"filename": "x.png", "content_type": "image/png"},
            "created": "2026-01-20T00:00:00",
        }
        backfill(db_factory, sleep_s=0, batch_size=50, checkpoint_path=ckpt,
                 dry_run=False, limit=None)

    fam.assert_called_once_with("A20", "http://senaite.test/self-reported/A20")


def test_backfill_idempotent_rerun_inserts_nothing(db_factory, tmp_path):
    _seed_sample(db_factory, "TEST-ATTBF-P2")
    meta = _meta_with_attachments([{"uid": "B1"}, {"uid": "B2"}])
    attachment_metas = {
        "B1": {"AttachmentFile": {"filename": "a.png", "content_type": "image/png"},
               "created": "2026-01-01T00:00:00"},
        "B2": {"AttachmentFile": {"filename": "b.png", "content_type": "image/png"},
               "created": "2026-01-02T00:00:00"},
    }
    metas = {"TEST-ATTBF-P2": meta}
    ckpt_file = tmp_path / "ckpt.json"

    stats1 = _run(db_factory, metas, attachment_metas, str(ckpt_file))
    assert stats1["inserted"] == 2
    assert stats1["dup"] == 0
    assert stats1["adopted"] == 0

    ckpt_file.unlink()  # re-scan contract: delete checkpoint to re-run
    stats2 = _run(db_factory, metas, attachment_metas, str(ckpt_file))
    assert stats2["inserted"] == 0
    assert stats2["dup"] == 2
    assert stats2["adopted"] == 0

    db = db_factory()
    assert db.query(LimsParentAttachment).count() == 2
    db.close()


def test_backfill_dry_run_writes_nothing(db_factory, tmp_path):
    _seed_sample(db_factory, "TEST-ATTBF-P3")
    meta = _meta_with_attachments([{"uid": "C1"}])
    attachment_metas = {
        "C1": {"AttachmentFile": {"filename": "c.png", "content_type": "image/png"},
               "created": "2026-01-03T00:00:00"},
    }
    ckpt = tmp_path / "ckpt.json"

    stats = _run(db_factory, {"TEST-ATTBF-P3": meta}, attachment_metas,
                 str(ckpt), dry_run=True)

    assert stats["inserted"] == 1   # would-insert count, SELECT-side only
    assert stats["dup"] == 0
    assert stats["adopted"] == 0

    db = db_factory()
    assert db.query(LimsParentAttachment).count() == 0
    db.close()
    assert not ckpt.exists()


def test_backfill_adopts_uidless_capture_row(db_factory, tmp_path):
    pk = _seed_sample(db_factory, "TEST-ATTBF-P4")
    _seed_capture_row(db_factory, pk, "v-1.png")

    meta = _meta_with_attachments([{"uid": "A9"}])
    attachment_metas = {
        "A9": {"AttachmentFile": {"filename": "v-1.png", "content_type": "image/png"},
               "RenderInReport": True, "created": "2026-01-09T00:00:00"},
    }
    ckpt = str(tmp_path / "ckpt.json")

    stats = _run(db_factory, {"TEST-ATTBF-P4": meta}, attachment_metas, ckpt)

    assert stats["adopted"] == 1
    assert stats["inserted"] == 0
    assert stats["dup"] == 0

    db = db_factory()
    rows = db.query(LimsParentAttachment).filter_by(lims_sample_pk=pk).all()
    assert len(rows) == 1  # no new row — the capture-time row was adopted
    row = rows[0]
    assert row.senaite_attachment_uid == "A9"
    # Everything else about the capture-time row is untouched by adoption.
    assert row.storage == "s3"
    assert row.storage_key == "captures/v-1.png"
    assert row.kind == "vial_image"
    assert row.render_in_report is False
    assert row.created_at == datetime(2026, 1, 1)
    db.close()


def test_backfill_dry_run_does_not_adopt(db_factory, tmp_path):
    pk = _seed_sample(db_factory, "TEST-ATTBF-P4B")
    _seed_capture_row(db_factory, pk, "v-2.png")

    meta = _meta_with_attachments([{"uid": "A10"}])
    attachment_metas = {
        "A10": {"AttachmentFile": {"filename": "v-2.png", "content_type": "image/png"},
                "created": "2026-01-10T00:00:00"},
    }
    ckpt = tmp_path / "ckpt.json"

    stats = _run(db_factory, {"TEST-ATTBF-P4B": meta}, attachment_metas,
                 str(ckpt), dry_run=True)

    assert stats["adopted"] == 1   # would-adopt, SELECT-side only
    assert stats["inserted"] == 0
    assert stats["dup"] == 0

    db = db_factory()
    row = db.query(LimsParentAttachment).filter_by(lims_sample_pk=pk).one()
    assert row.senaite_attachment_uid is None  # untouched — dry-run writes nothing
    db.close()


def test_backfill_uid_collision_counts_dup_and_leaves_capture_row(db_factory, tmp_path):
    """Re-scan collision guard: the swept uid ALREADY exists on another row
    for this sample, AND a later uid-less capture row shares the filename
    (retake/re-upload — filename is user-controlled and not unique). The
    sweep must count `dup` and skip entirely — never stamp the existing uid
    onto the uid-less row (partial-unique-index violation that would roll
    back the whole sample and mask itself as a generic `errors` count)."""
    pk = _seed_sample(db_factory, "TEST-ATTBF-P6")
    # Sweep #1 already landed uid A9 for (pk, 'v-1.png') on an earlier row.
    _seed_capture_row(db_factory, pk, "v-1.png",
                      senaite_attachment_uid="A9", kind="manual",
                      storage="senaite", storage_key=None)
    # A later capture-time retake shares the filename, uid-less.
    uidless_id = _seed_capture_row(db_factory, pk, "v-1.png")

    meta = _meta_with_attachments([{"uid": "A9"}, {"uid": "A11"}])
    attachment_metas = {
        "A9": {"AttachmentFile": {"filename": "v-1.png", "content_type": "image/png"},
               "created": "2026-01-09T00:00:00"},
        "A11": {"AttachmentFile": {"filename": "other.png", "content_type": "image/png"},
                "created": "2026-01-11T00:00:00"},
    }
    ckpt = str(tmp_path / "ckpt.json")

    stats = _run(db_factory, {"TEST-ATTBF-P6": meta}, attachment_metas, ckpt)

    assert stats["dup"] == 1        # A9 skipped entirely — uid already present
    assert stats["adopted"] == 0    # never stamped onto the uid-less retake
    assert stats["inserted"] == 1   # A11 in the same sample still lands
    assert stats["errors"] == 0     # no IntegrityError, no masked rollback

    db = db_factory()
    row = db.get(LimsParentAttachment, uidless_id)
    assert row.senaite_attachment_uid is None  # retake row untouched
    assert db.query(LimsParentAttachment).filter_by(
        lims_sample_pk=pk).count() == 3  # 2 seeded + A11
    db.close()


def test_backfill_skips_malformed_attachment_refs(db_factory, tmp_path):
    _seed_sample(db_factory, "TEST-ATTBF-P5")
    meta = _meta_with_attachments([
        {"uid": "D1"},          # good
        "not-a-dict",           # malformed: ref itself isn't a dict
        {"api_url": "no-uid"},  # malformed: ref has no uid
        {"uid": "D2"},          # detail fetch raises → detail_fetch_errors
    ])
    attachment_metas = {
        "D1": {"AttachmentFile": {"filename": "good.png", "content_type": "image/png"},
               "created": "2026-01-10T00:00:00"},
        "D2": RuntimeError("SENAITE fetch_attachment_meta failed (500): boom"),
    }
    ckpt = str(tmp_path / "ckpt.json")

    stats = _run(db_factory, {"TEST-ATTBF-P5": meta}, attachment_metas, ckpt)

    assert stats["attachments_seen"] == 4
    assert stats["inserted"] == 1
    assert stats["skipped_malformed"] == 2       # non-dict + no-uid only
    assert stats["detail_fetch_errors"] == 1     # raised fetch, counted separately
    assert stats["errors"] == 0  # a bad ref/detail-fetch never counts as a sample-level error

    db = db_factory()
    assert db.query(LimsParentAttachment).count() == 1
    db.close()
