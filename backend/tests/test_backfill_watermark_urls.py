"""Unit tests for the watermark-URL backfill (COA read-independence spec
§6, Task 6): cohort predicate + dry-run/apply behavior."""
import json
from types import SimpleNamespace
from unittest.mock import patch, MagicMock, call

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsSample
from scripts.backfill_watermark_urls import (
    _needs_watermark_backfill, load_candidates, backfill, WATERMARK_KEY,
)


# --- _needs_watermark_backfill (pure predicate, fakes only) ------------------

def test_needs_backfill_when_coa_meta_none():
    assert _needs_watermark_backfill(SimpleNamespace(coa_meta=None)) is True


def test_needs_backfill_when_key_absent():
    row = SimpleNamespace(coa_meta=json.dumps({"CoaCompanyName": "Acme"}))
    assert _needs_watermark_backfill(row) is True


def test_needs_backfill_when_key_present_but_falsy():
    row = SimpleNamespace(coa_meta=json.dumps({WATERMARK_KEY: None}))
    assert _needs_watermark_backfill(row) is True
    row2 = SimpleNamespace(coa_meta=json.dumps({WATERMARK_KEY: ""}))
    assert _needs_watermark_backfill(row2) is True


def test_no_backfill_needed_when_key_present_and_truthy():
    row = SimpleNamespace(coa_meta=json.dumps({WATERMARK_KEY: "https://x/wm.png"}))
    assert _needs_watermark_backfill(row) is False


def test_needs_backfill_on_malformed_json():
    row = SimpleNamespace(coa_meta="not json")
    assert _needs_watermark_backfill(row) is True


def test_needs_backfill_on_non_dict_json():
    row = SimpleNamespace(coa_meta=json.dumps([1, 2, 3]))
    assert _needs_watermark_backfill(row) is True


# --- load_candidates / backfill (in-memory sqlite db_factory) ----------------

@pytest.fixture
def db_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _add(db, sample_id, *, uid="U1", coa_meta=None):
    row = LimsSample(sample_id=sample_id, external_lims_uid=uid, coa_meta=coa_meta)
    db.add(row)
    db.flush()
    return row


def test_load_candidates_excludes_rows_without_uid(db_factory):
    db = db_factory()
    _add(db, "P-0001", uid=None)
    _add(db, "P-0002", uid="U2")
    db.commit(); db.close()
    out = load_candidates(db_factory)
    assert [sid for _, sid in out] == ["P-0002"]


def test_load_candidates_excludes_rows_already_populated(db_factory):
    db = db_factory()
    _add(db, "P-0001", coa_meta=json.dumps({WATERMARK_KEY: "https://x/wm.png"}))
    _add(db, "P-0002", coa_meta=json.dumps({"CoaCompanyName": "Acme"}))
    db.commit(); db.close()
    out = load_candidates(db_factory)
    assert [sid for _, sid in out] == ["P-0002"]


def test_backfill_dry_run_writes_nothing(db_factory):
    db = db_factory()
    row = _add(db, "P-0001")
    db.commit(); pk = row.id; db.close()

    with patch("scripts.backfill_watermark_urls.senaite") as sen, \
         patch("scripts.backfill_watermark_urls.time.sleep"):
        sen.fetch_parent_metadata.return_value = {WATERMARK_KEY: "https://x/wm.png"}
        stats = backfill(db_factory, sleep_s=0, apply=False, limit=None)

    assert stats == {"candidates": 1, "updated": 1, "empty_from_senaite": 0, "errors": 0}
    db = db_factory()
    fresh = db.get(LimsSample, pk)
    assert fresh.coa_meta is None   # dry-run: nothing written
    db.close()


def test_backfill_apply_merges_into_existing_coa_meta(db_factory):
    db = db_factory()
    row = _add(db, "P-0001", coa_meta=json.dumps({"CoaCompanyName": "Acme"}))
    db.commit(); pk = row.id; db.close()

    with patch("scripts.backfill_watermark_urls.senaite") as sen, \
         patch("scripts.backfill_watermark_urls.time.sleep"):
        sen.fetch_parent_metadata.return_value = {WATERMARK_KEY: "https://x/wm.png"}
        stats = backfill(db_factory, sleep_s=0, apply=True, limit=None)

    assert stats == {"candidates": 1, "updated": 1, "empty_from_senaite": 0, "errors": 0}
    db = db_factory()
    fresh = db.get(LimsSample, pk)
    meta = json.loads(fresh.coa_meta)
    assert meta["CoaCompanyName"] == "Acme"          # existing keys preserved
    assert meta[WATERMARK_KEY] == "https://x/wm.png"
    db.close()


def test_backfill_apply_seeds_full_coa_meta_shape_when_null(db_factory):
    """A legacy row with coa_meta NULL gets the full _COA_META_FIELDS shape
    seeded (matching _populate_basic_info's convention), not just the one key."""
    db = db_factory()
    row = _add(db, "P-0001", coa_meta=None)
    db.commit(); pk = row.id; db.close()

    with patch("scripts.backfill_watermark_urls.senaite") as sen, \
         patch("scripts.backfill_watermark_urls.time.sleep"):
        sen.fetch_parent_metadata.return_value = {WATERMARK_KEY: "https://x/wm.png"}
        backfill(db_factory, sleep_s=0, apply=True, limit=None)

    db = db_factory()
    meta = json.loads(db.get(LimsSample, pk).coa_meta)
    assert meta[WATERMARK_KEY] == "https://x/wm.png"
    assert "CoaCompanyName" in meta and meta["CoaCompanyName"] is None
    db.close()


def test_backfill_counts_empty_senaite_response(db_factory):
    db = db_factory()
    _add(db, "P-0001")
    db.commit(); db.close()

    with patch("scripts.backfill_watermark_urls.senaite") as sen, \
         patch("scripts.backfill_watermark_urls.time.sleep"):
        sen.fetch_parent_metadata.return_value = {}   # no watermark key at all
        stats = backfill(db_factory, sleep_s=0, apply=True, limit=None)

    assert stats == {"candidates": 1, "updated": 0, "empty_from_senaite": 1, "errors": 0}
    db = db_factory()
    row = db.query(LimsSample).filter_by(sample_id="P-0001").one()
    assert row.coa_meta is None   # never touched — nothing to merge
    db.close()


def test_backfill_one_error_does_not_abort(db_factory):
    db = db_factory()
    _add(db, "P-0001")
    _add(db, "P-0002", uid="U2")
    db.commit(); db.close()

    with patch("scripts.backfill_watermark_urls.senaite") as sen, \
         patch("scripts.backfill_watermark_urls.time.sleep"):
        sen.fetch_parent_metadata.side_effect = [
            RuntimeError("senaite hiccup"),
            {WATERMARK_KEY: "https://x/wm.png"},
        ]
        stats = backfill(db_factory, sleep_s=0, apply=True, limit=None)

    assert stats["errors"] == 1 and stats["updated"] == 1


def test_backfill_throttles_between_candidates(db_factory):
    db = db_factory()
    _add(db, "P-0001")
    _add(db, "P-0002", uid="U2")
    db.commit(); db.close()

    with patch("scripts.backfill_watermark_urls.senaite") as sen, \
         patch("scripts.backfill_watermark_urls.time.sleep") as slp:
        sen.fetch_parent_metadata.return_value = {}
        backfill(db_factory, sleep_s=0.25, apply=False, limit=None)

    assert slp.call_count == 2 and slp.call_args == call(0.25)


def test_backfill_respects_limit(db_factory):
    db = db_factory()
    _add(db, "P-0001")
    _add(db, "P-0002", uid="U2")
    _add(db, "P-0003", uid="U3")
    db.commit(); db.close()

    with patch("scripts.backfill_watermark_urls.senaite") as sen, \
         patch("scripts.backfill_watermark_urls.time.sleep"):
        sen.fetch_parent_metadata.return_value = {}
        stats = backfill(db_factory, sleep_s=0, apply=False, limit=2)

    assert stats["candidates"] == 2


# --- main() / APPLY env gate --------------------------------------------------
from scripts.backfill_watermark_urls import main


def test_main_defaults_to_dry_run(db_factory, monkeypatch, capsys):
    monkeypatch.delenv("APPLY", raising=False)
    with patch("scripts.backfill_watermark_urls.SessionLocal", db_factory), \
         patch("scripts.backfill_watermark_urls.load_candidates", return_value=[]):
        rc = main([])
    assert rc == 0
    stats = json.loads(capsys.readouterr().out.strip())
    assert stats["mode"] == "DRY-RUN"


def test_main_apply_requires_env_flag(db_factory, monkeypatch, capsys):
    monkeypatch.setenv("APPLY", "1")
    with patch("scripts.backfill_watermark_urls.SessionLocal", db_factory), \
         patch("scripts.backfill_watermark_urls.load_candidates", return_value=[]):
        rc = main([])
    assert rc == 0
    stats = json.loads(capsys.readouterr().out.strip())
    assert stats["mode"] == "APPLY"


def test_main_apply_value_other_than_1_stays_dry_run(db_factory, monkeypatch, capsys):
    monkeypatch.setenv("APPLY", "true")   # only the literal "1" flips it
    with patch("scripts.backfill_watermark_urls.SessionLocal", db_factory), \
         patch("scripts.backfill_watermark_urls.load_candidates", return_value=[]):
        rc = main([])
    stats = json.loads(capsys.readouterr().out.strip())
    assert stats["mode"] == "DRY-RUN"


def test_main_exit_code_reflects_errors(db_factory, monkeypatch, capsys):
    monkeypatch.delenv("APPLY", raising=False)
    with patch("scripts.backfill_watermark_urls.SessionLocal", db_factory), \
         patch("scripts.backfill_watermark_urls.load_candidates",
               return_value=[(1, "P-0001")]), \
         patch("scripts.backfill_watermark_urls.senaite") as sen, \
         patch("scripts.backfill_watermark_urls.time.sleep"):
        sen.fetch_parent_metadata.side_effect = RuntimeError("boom")
        rc = main([])
    assert rc == 1
    stats = json.loads(capsys.readouterr().out.strip())
    assert stats["errors"] == 1
