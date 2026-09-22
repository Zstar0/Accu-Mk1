"""Task 3 (HPLC native slice 6, M8): native_auto_checkin — retest auto
check-in copying the original's receive photo + remark onto the new row.

Sqlite in-memory (StaticPool) harness; `_receive_native_phase` is patched
with a recording fake here (it is heavily entangled with the engine/SLA/
photo-storage stack) — one real end-to-end pass through the actual phase is
covered separately in tests/test_receive_native_first.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from models import LimsParentAttachment, LimsSample, LimsSampleRemark, LimsSubSampleEvent
from sub_samples.native_checkin import native_auto_checkin
from sub_samples.photo_storage import PhotoNotFoundError


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestSessionLocal = sessionmaker(bind=engine)
    with patch("database.SessionLocal", TestSessionLocal):
        s = TestSessionLocal()
        yield s
        s.close()


def _mk_sample(db, *, sample_id, system="mk1", status="sample_due",
               retest_of=None, date_received=None):
    row = LimsSample(sample_id=sample_id, external_lims_system=system,
                     sample_type="x", status=status,
                     retest_of_sample_id=retest_of, date_received=date_received)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


class _FakeStorage:
    def __init__(self, *, photo: bytes | None = b"jpg-bytes", raise_not_found=False):
        self.photo = photo
        self.raise_not_found = raise_not_found
        self.fetched_keys: list[str] = []

    def fetch_photo(self, key: str) -> bytes:
        self.fetched_keys.append(key)
        if self.raise_not_found:
            raise PhotoNotFoundError(f"missing {key}")
        return self.photo

    def save_photo(self, sample_id, photo_bytes, filename):  # pragma: no cover
        return f"{sample_id}/x.png"


def _patch_storage(fake):
    return patch("sub_samples.native_checkin.get_storage", return_value=fake)


def test_happy_path_copies_image_and_remark(db):
    received_at = datetime(2026, 9, 1, 12, 0, 0)
    original = _mk_sample(db, sample_id="P-ORIG", status="sample_received",
                          date_received=received_at)
    db.add(LimsParentAttachment(
        lims_sample_pk=original.id, kind="receive_image", filename="a.png",
        storage="s3", storage_key="P-ORIG/abc.png",
    ))
    db.add(LimsSampleRemark(
        lims_sample_pk=original.id, content="looked fine on arrival",
        author_user_id=7, created_at=received_at + timedelta(seconds=2),
    ))
    db.commit()
    new_row = _mk_sample(db, sample_id="P-NEW", retest_of="P-ORIG")

    fake = _FakeStorage()
    with _patch_storage(fake), \
         patch("main._receive_native_phase") as phase:
        phase.return_value = {"ok": True, "already": False, "status": "sample_received",
                              "steps": ["image_captured_native", "remarks_added", "received_native"]}
        result = native_auto_checkin("P-NEW")

    assert fake.fetched_keys == ["P-ORIG/abc.png"]
    phase.assert_called_once_with(
        sample_id="P-NEW", image_bytes=b"jpg-bytes",
        remarks="looked fine on arrival", user_id=None,
    )
    assert result == {
        "ok": True, "copied_image": True, "copied_remark": True,
        "steps": ["image_captured_native", "remarks_added", "received_native"],
    }
    event = db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == new_row.id)).scalar_one()
    assert event.event == "native_auto_checkin"
    assert event.details == {
        "original": "P-ORIG", "copied_image": True, "copied_remark": True,
        "steps": ["image_captured_native", "remarks_added", "received_native"],
        "ok": True,
    }


def test_flush_pending_relays_called_after_successful_phase(db):
    _mk_sample(db, sample_id="P-ORIG6", status="sample_received",
              date_received=datetime(2026, 9, 1))
    _mk_sample(db, sample_id="P-NEW6", retest_of="P-ORIG6")

    with _patch_storage(_FakeStorage(photo=None)), \
         patch("main._receive_native_phase") as phase, \
         patch("sub_samples.native_checkin.flush_pending_relays") as flush:
        phase.return_value = {"ok": True, "steps": []}
        native_auto_checkin("P-NEW6")

    flush.assert_called_once_with()


def test_flush_pending_relays_not_called_when_phase_skipped(db):
    with patch("sub_samples.native_checkin.flush_pending_relays") as flush:
        result = native_auto_checkin("P-MISSING6")

    assert result == {"ok": False, "skipped": "new_row_missing"}
    flush.assert_not_called()


def test_remark_falls_back_to_newest_authored_when_none_in_window(db):
    received_at = datetime(2026, 9, 1, 12, 0, 0)
    original = _mk_sample(db, sample_id="P-ORIG2", status="sample_received",
                          date_received=received_at)
    db.add(LimsSampleRemark(
        lims_sample_pk=original.id, content="old note", author_user_id=1,
        created_at=received_at - timedelta(days=1),
    ))
    db.add(LimsSampleRemark(
        lims_sample_pk=original.id, content="newest note", author_user_id=2,
        created_at=received_at - timedelta(hours=1),
    ))
    db.add(LimsSampleRemark(  # unauthored, must never be picked
        lims_sample_pk=original.id, content="system note", author_user_id=None,
        created_at=received_at,
    ))
    db.commit()
    _mk_sample(db, sample_id="P-NEW2", retest_of="P-ORIG2")

    with _patch_storage(_FakeStorage(photo=None)), \
         patch("main._receive_native_phase") as phase:
        phase.return_value = {"ok": True, "steps": []}
        native_auto_checkin("P-NEW2")

    phase.assert_called_once_with(
        sample_id="P-NEW2", image_bytes=None, remarks="newest note", user_id=None,
    )


def test_photo_not_found_proceeds_without_image(db):
    original = _mk_sample(db, sample_id="P-ORIG3", status="sample_received",
                          date_received=datetime(2026, 9, 1))
    db.add(LimsParentAttachment(
        lims_sample_pk=original.id, kind="receive_image", filename="a.png",
        storage="s3", storage_key="P-ORIG3/missing.png",
    ))
    db.commit()
    _mk_sample(db, sample_id="P-NEW3", retest_of="P-ORIG3")

    with _patch_storage(_FakeStorage(raise_not_found=True)), \
         patch("main._receive_native_phase") as phase:
        phase.return_value = {"ok": True, "steps": ["received_native"]}
        result = native_auto_checkin("P-NEW3")

    phase.assert_called_once_with(
        sample_id="P-NEW3", image_bytes=None, remarks=None, user_id=None,
    )
    assert result["copied_image"] is False


@pytest.mark.parametrize("build,expected_skip", [
    (lambda db: None, "new_row_missing"),
    (lambda db: _mk_sample(db, sample_id="P-A", retest_of=None), "no_retest_of_sample_id"),
    (lambda db: _mk_sample(db, sample_id="P-B", retest_of="P-GHOST"), "original_missing"),
])
def test_skip_reasons_before_original_lookup(db, build, expected_skip):
    row = build(db)
    sample_id = row.sample_id if row is not None else "P-MISSING"
    result = native_auto_checkin(sample_id)
    assert result == {"ok": False, "skipped": expected_skip}


def test_skip_when_new_row_already_past_pre_received(db):
    _mk_sample(db, sample_id="P-ORIG4", status="sample_received",
              date_received=datetime(2026, 9, 1))
    _mk_sample(db, sample_id="P-NEW4", status="sample_received",
              retest_of="P-ORIG4")
    result = native_auto_checkin("P-NEW4")
    assert result == {"ok": False, "skipped": "new_row_already_received"}


def test_skip_when_original_not_native_born(db):
    _mk_sample(db, sample_id="P-ORIG5", system="senaite", status="sample_received",
              date_received=datetime(2026, 9, 1))
    _mk_sample(db, sample_id="P-NEW5", retest_of="P-ORIG5")
    result = native_auto_checkin("P-NEW5")
    assert result == {"ok": False, "skipped": "original_not_native_born"}


def test_skip_when_original_not_received(db):
    _mk_sample(db, sample_id="P-ORIG6", status="sample_due", date_received=None)
    _mk_sample(db, sample_id="P-NEW6", retest_of="P-ORIG6")
    result = native_auto_checkin("P-NEW6")
    assert result == {"ok": False, "skipped": "original_not_received"}


def test_never_raises_on_unexpected_error(db):
    _mk_sample(db, sample_id="P-ORIG7", status="sample_received",
              date_received=datetime(2026, 9, 1))
    _mk_sample(db, sample_id="P-NEW7", retest_of="P-ORIG7")
    with patch("main._receive_native_phase", side_effect=RuntimeError("boom")):
        result = native_auto_checkin("P-NEW7")
    assert result["ok"] is False
    assert "error" in result["skipped"]
