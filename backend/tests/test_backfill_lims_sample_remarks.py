"""Unit tests for the one-time SENAITE remarks history backfill
(2026-07-14-parent-ar-read-flip spec §6).

Harness idioms cloned from test_backfill_basic_info.py: a sqlite in-memory
`db_factory`, a patched `sen.fetch_parent_metadata`, a `_run` wrapper, and
tmp-path checkpoints. Two adaptations from that precedent, both load-bearing:

1. This script's registry-cursor design (module docstring) iterates
   `lims_samples` directly rather than SENAITE's own enumeration, so tests
   seed real LimsSample rows instead of mocking `iter_all_sample_ids`.
2. The ON CONFLICT DO NOTHING insert rides the real dedup index
   (`uq_lims_sample_remarks_dedup` on lims_sample_pk, created_at,
   md5(content)) — a raw Postgres migration in database.py, not part of the
   ORM model, so `Base.metadata.create_all` alone wouldn't create it. sqlite
   also has no built-in md5(). `db_factory` registers an md5 UDF and
   recreates the same unique index so the idempotency contract (Test 2) is
   exercised for real, not just assumed.
"""
import hashlib
from datetime import datetime
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsSample, LimsSampleRemark

from scripts.backfill_lims_sample_remarks import backfill


@pytest.fixture
def db_factory():
    engine = create_engine("sqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def _register_md5(dbapi_conn, _record):
        dbapi_conn.create_function(
            "md5", 1,
            lambda s: hashlib.md5(s.encode()).hexdigest() if s is not None else None,
            deterministic=True,
        )

    Base.metadata.create_all(engine)
    with engine.connect() as conn:
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_sample_remarks_dedup "
            "ON lims_sample_remarks (lims_sample_pk, created_at, md5(content))"
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


def _meta_with_remarks(remarks):
    return {"Remarks": remarks}


def _run(db_factory, metas, ckpt_path, **kw):
    """Drive backfill() against real lims_samples rows in db_factory, with
    sen.fetch_parent_metadata mocked per parent sample_id."""
    with patch("scripts.backfill_lims_sample_remarks.sen.fetch_parent_metadata") as fpm, \
         patch("scripts.backfill_lims_sample_remarks.time.sleep"):
        fpm.side_effect = lambda sid: metas[sid]
        kwargs = dict(sleep_s=0, batch_size=50, checkpoint_path=ckpt_path,
                      dry_run=False, limit=None)
        kwargs.update(kw)
        stats = backfill(db_factory, **kwargs)
    return stats


def test_backfill_inserts_rows_with_author_label(db_factory, tmp_path):
    pk = _seed_sample(db_factory, "TEST-RMKBF-P1")
    meta = _meta_with_remarks([
        {"content": "<p>r1</p>", "user_id": "zeus", "created": "2026-01-02T03:04:05"},
        {"content": "<p>r2</p>", "user_id": None, "created": "2026-01-03T00:00:00"},
    ])
    ckpt = str(tmp_path / "ckpt.json")

    stats = _run(db_factory, {"TEST-RMKBF-P1": meta}, ckpt)

    assert stats["fetched"] == 1
    assert stats["inserted"] == 2
    assert stats["dup"] == 0
    assert stats["errors"] == 0

    db = db_factory()
    rows = (db.query(LimsSampleRemark)
            .filter_by(lims_sample_pk=pk)
            .order_by(LimsSampleRemark.created_at)
            .all())
    assert len(rows) == 2
    first = rows[0]
    assert first.author_label == "zeus"
    assert first.author_user_id is None
    assert first.created_at == datetime(2026, 1, 2, 3, 4, 5)
    assert first.content == "<p>r1</p>"
    second = rows[1]
    assert second.author_label is None
    db.close()


def test_backfill_idempotent_rerun_inserts_nothing(db_factory, tmp_path):
    _seed_sample(db_factory, "TEST-RMKBF-P2")
    meta = _meta_with_remarks([
        {"content": "<p>r1</p>", "user_id": "zeus", "created": "2026-01-02T03:04:05"},
        {"content": "<p>r2</p>", "user_id": "hera", "created": "2026-01-03T00:00:00"},
    ])
    metas = {"TEST-RMKBF-P2": meta}
    ckpt_file = tmp_path / "ckpt.json"

    stats1 = _run(db_factory, metas, str(ckpt_file))
    assert stats1["inserted"] == 2
    assert stats1["dup"] == 0

    ckpt_file.unlink()  # re-scan contract: delete checkpoint to re-run
    stats2 = _run(db_factory, metas, str(ckpt_file))
    assert stats2["inserted"] == 0
    assert stats2["dup"] == 2

    db = db_factory()
    assert db.query(LimsSampleRemark).count() == 2
    db.close()


def test_backfill_dry_run_writes_nothing(db_factory, tmp_path):
    _seed_sample(db_factory, "TEST-RMKBF-P3")
    meta = _meta_with_remarks([
        {"content": "<p>r1</p>", "user_id": "zeus", "created": "2026-01-02T03:04:05"},
        {"content": "<p>r2</p>", "user_id": None, "created": "2026-01-03T00:00:00"},
    ])
    ckpt = tmp_path / "ckpt.json"

    stats = _run(db_factory, {"TEST-RMKBF-P3": meta}, str(ckpt), dry_run=True)

    assert stats["inserted"] == 2   # would-insert count, SELECT-side only
    assert stats["dup"] == 0

    db = db_factory()
    assert db.query(LimsSampleRemark).count() == 0
    db.close()
    assert not ckpt.exists()


def test_backfill_skips_malformed_entries(db_factory, tmp_path):
    _seed_sample(db_factory, "TEST-RMKBF-P4")
    meta = _meta_with_remarks([
        {"content": "<p>good</p>", "user_id": "zeus", "created": "2026-01-02T03:04:05"},
        "not-a-dict",
        {"user_id": "hera", "created": "2026-01-03T00:00:00"},  # no content
    ])
    ckpt = str(tmp_path / "ckpt.json")

    stats = _run(db_factory, {"TEST-RMKBF-P4": meta}, ckpt)

    assert stats["inserted"] == 1
    assert stats["skipped_malformed"] == 2
    assert stats["errors"] == 0

    db = db_factory()
    assert db.query(LimsSampleRemark).count() == 1
    db.close()


def test_backfill_unparseable_created_uses_none_guard(db_factory, tmp_path):
    _seed_sample(db_factory, "TEST-RMKBF-P5")
    meta = _meta_with_remarks([
        {"content": "<p>bad-date</p>", "user_id": "zeus", "created": "garbage"},
    ])
    ckpt = str(tmp_path / "ckpt.json")

    stats = _run(db_factory, {"TEST-RMKBF-P5": meta}, ckpt)

    assert stats["inserted"] == 1
    assert stats["unparseable_created"] == 1

    db = db_factory()
    row = db.query(LimsSampleRemark).one()
    assert row.created_at == datetime(1970, 1, 1)
    db.close()
