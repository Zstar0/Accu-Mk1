"""Unit tests for the basic-info backfill: enumeration, upsert, safety rails
(2026-07-02-lims-sample-canonical-basic-info-design.md)."""
import json
import pytest
from datetime import datetime
from unittest.mock import patch, MagicMock, call
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsSample
from sub_samples import senaite


@pytest.fixture
def db_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _page(ids):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"items": [{"id": i, "uid": f"UID-{i}"} for i in ids]}
    return resp


# --- iter_all_sample_ids -----------------------------------------------------

def test_enumeration_pages_until_empty():
    pages = [_page(["P-0001", "P-0002"]), _page(["P-0003"]), _page([])]
    with patch("sub_samples.senaite._get", side_effect=pages) as g:
        out = list(senaite.iter_all_sample_ids(batch_size=2))
    assert out == [("P-0001", 0), ("P-0002", 0), ("P-0003", 2)]
    assert g.call_count == 3


def test_enumeration_resumes_from_start_cursor():
    pages = [_page(["P-0101"]), _page([])]
    with patch("sub_samples.senaite._get", side_effect=pages) as g:
        out = list(senaite.iter_all_sample_ids(batch_size=50, start=100))
    assert out == [("P-0101", 100)]
    first_params = g.call_args_list[0].kwargs.get("params") or g.call_args_list[0].args[1]
    assert first_params["b_start"] == 100


def test_enumeration_raises_on_http_error():
    resp = MagicMock()
    resp.status_code = 500
    resp.text = "boom"
    with patch("sub_samples.senaite._get", return_value=resp):
        with pytest.raises(RuntimeError, match="enumerate"):
            list(senaite.iter_all_sample_ids())


# --- backfill core -----------------------------------------------------------
from scripts.backfill_lims_sample_basic_info import backfill


def _full_meta(sid="P-0001", state="received"):
    return {
        "uid": f"UID-{sid}", "ClientUID": "C_UID", "ClientID": "client-8",
        "ContactUID": "CT_UID", "SampleType": "ST_UID",
        "ClientSampleID": f"CS-{sid}", "Analyte1Peptide": "BPC-157",
        "DateReceived": "2026-05-01T10:23:00+00:00",
        "DateSampled": "2026-04-30T08:00:00+00:00",
        "review_state": state,
    }


def _run(db_factory, ids, metas=None, tmp_path=None, **kw):
    """Drive backfill() with mocked enumeration + per-sample fetch."""
    metas = metas or {i: _full_meta(i) for i, _ in ids}
    ckpt = str((tmp_path / "ckpt.json")) if tmp_path else "/tmp/test-ckpt.json"
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep") as slp:
        sen.iter_all_sample_ids.return_value = iter(ids)
        sen.fetch_parent_metadata.side_effect = (
            lambda sid: metas[sid] if not isinstance(metas.get(sid), Exception)
            else (_ for _ in ()).throw(metas[sid])
        )
        kwargs = dict(sleep_s=0.5, batch_size=50, checkpoint_path=ckpt,
                      dry_run=False, limit=None)
        kwargs.update(kw)
        stats = backfill(db_factory, **kwargs)
    return stats, sen, slp


def test_backfill_creates_missing_and_updates_existing(db_factory, tmp_path):
    db = db_factory()
    db.add(LimsSample(sample_id="P-0002", external_lims_uid="OLD",
                      client_sample_id="STALE"))
    db.commit(); db.close()

    stats, sen, _ = _run(db_factory, [("P-0001", 0), ("P-0002", 0)], tmp_path=tmp_path)
    assert stats["created"] == 1 and stats["updated"] == 1 and stats["errors"] == 0

    db = db_factory()
    created = db.query(LimsSample).filter_by(sample_id="P-0001").one()
    assert created.date_received == datetime(2026, 5, 1, 10, 23, 0)
    updated = db.query(LimsSample).filter_by(sample_id="P-0002").one()
    assert updated.client_sample_id == "CS-P-0002"     # refreshed, not stale
    db.close()


def test_backfill_skips_secondary_ars(db_factory, tmp_path):
    stats, sen, _ = _run(db_factory,
                         [("P-0001", 0), ("P-0001-S01", 0), ("P-0001-S02-R01", 0)],
                         metas={"P-0001": _full_meta("P-0001")}, tmp_path=tmp_path)
    assert stats["skipped_secondary"] == 2
    # fetch never even attempted for secondaries
    sen.fetch_parent_metadata.assert_called_once_with("P-0001")
    db = db_factory()
    assert db.query(LimsSample).count() == 1
    db.close()


def test_backfill_fetches_once_per_sample(db_factory, tmp_path):
    _, sen, _ = _run(db_factory, [("P-0001", 0)], tmp_path=tmp_path)
    assert sen.fetch_parent_metadata.call_count == 1


def test_backfill_one_error_does_not_abort(db_factory, tmp_path):
    metas = {"P-0001": RuntimeError("senaite hiccup"), "P-0002": _full_meta("P-0002")}
    stats, _, _ = _run(db_factory, [("P-0001", 0), ("P-0002", 0)],
                       metas=metas, tmp_path=tmp_path)
    assert stats["errors"] == 1 and stats["created"] == 1


def test_backfill_throttles_between_samples(db_factory, tmp_path):
    _, _, slp = _run(db_factory, [("P-0001", 0), ("P-0002", 0)], tmp_path=tmp_path)
    assert slp.call_count >= 2 and slp.call_args == call(0.5)


def test_backfill_dry_run_writes_nothing(db_factory, tmp_path):
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep"):
        sen.iter_all_sample_ids.return_value = iter([("P-0001", 0)])
        sen.fetch_parent_metadata.return_value = _full_meta("P-0001")
        stats = backfill(db_factory, sleep_s=0, batch_size=50,
                         checkpoint_path=str(tmp_path / "c.json"),
                         dry_run=True, limit=None)
    db = db_factory()
    assert db.query(LimsSample).count() == 0
    assert stats["seen"] == 1
    db.close()


def test_backfill_respects_limit(db_factory, tmp_path):
    stats, _, _ = _run(db_factory,
                       [("P-0001", 0), ("P-0002", 0), ("P-0003", 0)],
                       tmp_path=tmp_path, limit=2)
    assert stats["seen"] == 2


def test_backfill_container_mode_gate_applies(db_factory, tmp_path):
    metas = {"P-0001": _full_meta("P-0001", state="received"),
             "P-0002": _full_meta("P-0002", state="sample_due")}
    _run(db_factory, [("P-0001", 0), ("P-0002", 0)], metas=metas, tmp_path=tmp_path)
    db = db_factory()
    assert db.query(LimsSample).filter_by(sample_id="P-0001").one().container_mode is False
    assert db.query(LimsSample).filter_by(sample_id="P-0002").one().container_mode is True
    db.close()


def test_dry_run_leaves_no_checkpoint(db_factory, tmp_path):
    ckpt = tmp_path / "c.json"
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep"):
        sen.iter_all_sample_ids.return_value = iter([("P-0001", 0)])
        sen.fetch_parent_metadata.return_value = _full_meta("P-0001")
        backfill(db_factory, sleep_s=0, batch_size=50,
                 checkpoint_path=str(ckpt), dry_run=True, limit=None)
    assert not ckpt.exists()


# --- checkpoint + CLI --------------------------------------------------------
from scripts.backfill_lims_sample_basic_info import (
    load_checkpoint, save_checkpoint, main,
)


def test_checkpoint_round_trip(tmp_path):
    p = str(tmp_path / "ckpt.json")
    assert load_checkpoint(p) == 0                    # missing file → fresh
    save_checkpoint(p, 150, "P-0150")
    assert load_checkpoint(p) == 150
    (tmp_path / "ckpt.json").write_text("garbage")
    assert load_checkpoint(p) == 0                    # corrupt file → fresh


def test_backfill_resumes_from_checkpoint(db_factory, tmp_path):
    ckpt = str(tmp_path / "ckpt.json")
    save_checkpoint(ckpt, 100, "P-0100")
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep"):
        sen.iter_all_sample_ids.return_value = iter([])
        backfill(db_factory, sleep_s=0, batch_size=50,
                 checkpoint_path=ckpt, dry_run=False, limit=None)
    sen.iter_all_sample_ids.assert_called_once_with(batch_size=50, start=100)


def test_main_prints_stats_json(db_factory, tmp_path, capsys):
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep"), \
         patch("scripts.backfill_lims_sample_basic_info.SessionLocal", db_factory):
        sen.iter_all_sample_ids.return_value = iter([("P-0001", 0)])
        sen.fetch_parent_metadata.return_value = _full_meta("P-0001")
        rc = main(["--checkpoint", str(tmp_path / "c.json"), "--sleep", "0"])
    assert rc == 0
    stats = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert stats["created"] == 1
