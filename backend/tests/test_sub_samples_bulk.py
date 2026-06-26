# backend/tests/test_sub_samples_bulk.py
"""Bulk sub-sample creation: create N identical vials (same photo) in one call.

`service.create_sub_samples_bulk` loops the tested single-create path; each vial
gets its own vial_sequence + a distinct storage key; partial failure is tolerated
(vials created before an error are kept, the error is returned alongside). Auto-
assignment is NOT run here — the caller refreshes the vial-plan afterward.
"""
from __future__ import annotations

import datetime
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select

from models import LimsSample, LimsSubSample
from sub_samples import service

_PNG = b"\x89PNG\r\n\x1a\n"


@pytest.fixture
def parent(db_session):
    p = LimsSample(
        sample_id="BLK-0001",
        external_lims_uid="parentuid-BLK-0001",
        client_uid="client-uid-1",
        contact_uid="contact-uid-1",
        sample_type="sampletype-uid-1",
        last_synced_at=datetime.datetime.utcnow(),
    )
    db_session.add(p)
    db_session.commit()
    return p


@pytest.fixture
def _unique_photo(monkeypatch):
    """Photo storage stub returning a DISTINCT key per call (like real uuid4)."""
    counter = {"n": 0}

    def _save(sample_id, photo_bytes, filename):
        counter["n"] += 1
        return f"{sample_id}/photo{counter['n']}.jpg"

    fake = MagicMock()
    fake.save_photo.side_effect = _save
    monkeypatch.setattr("sub_samples.photo_storage.get_storage", lambda: fake)
    return fake


@pytest.fixture(autouse=True)
def _native_on(monkeypatch):
    """Force the native (no-SENAITE) create path for all bulk tests."""
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    monkeypatch.setattr("sub_samples.senaite.create_secondary", MagicMock())
    monkeypatch.setattr("sub_samples.senaite.update_remarks", MagicMock())
    monkeypatch.setattr(service, "_fetch_wp_services_for_parent", lambda *_a, **_k: {})


def test_bulk_creates_n_vials_with_sequential_sequence(db_session, parent, _unique_photo):
    created, err = service.create_sub_samples_bulk(
        db_session, parent_sample_id="BLK-0001", photo_bytes=_PNG,
        photo_filename="vial.jpg", remarks="dup vials", user_id=1, count=5,
    )
    assert err is None
    assert len(created) == 5
    assert [s.vial_sequence for s in created] == [1, 2, 3, 4, 5]
    assert [s.sample_id for s in created] == [f"BLK-0001-S0{i}" for i in range(1, 6)]
    assert _unique_photo.save_photo.call_count == 5
    # same photo bytes reused for every vial — args are (sample_id, photo_bytes, filename)
    for call in _unique_photo.save_photo.call_args_list:
        assert call.args[1] == _PNG
    assert all(s.remarks == "dup vials" for s in created)


def test_bulk_same_photo_distinct_storage_keys(db_session, parent, _unique_photo):
    created, err = service.create_sub_samples_bulk(
        db_session, parent_sample_id="BLK-0001", photo_bytes=_PNG,
        photo_filename="vial.jpg", remarks=None, user_id=1, count=3,
    )
    assert err is None
    keys = [s.photo_external_uid for s in created]
    assert len(set(keys)) == 3  # each vial has its own storage key


def test_bulk_partial_failure_keeps_created_and_returns_error(db_session, parent, monkeypatch):
    counter = {"n": 0}

    def _save(sample_id, photo_bytes, filename):
        counter["n"] += 1
        if counter["n"] == 3:
            raise RuntimeError("disk full")
        return f"{sample_id}/photo{counter['n']}.jpg"

    fake = MagicMock()
    fake.save_photo.side_effect = _save
    monkeypatch.setattr("sub_samples.photo_storage.get_storage", lambda: fake)

    created, err = service.create_sub_samples_bulk(
        db_session, parent_sample_id="BLK-0001", photo_bytes=_PNG,
        photo_filename="vial.jpg", remarks=None, user_id=1, count=5,
    )
    assert len(created) == 2
    assert isinstance(err, RuntimeError)
    rows = db_session.execute(
        select(LimsSubSample).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    assert [r.vial_sequence for r in rows] == [1, 2]


def test_bulk_continues_existing_vial_sequence(db_session, parent, _unique_photo):
    service.create_sub_samples_bulk(
        db_session, parent_sample_id="BLK-0001", photo_bytes=_PNG,
        photo_filename="vial.jpg", remarks=None, user_id=1, count=2,
    )
    created, err = service.create_sub_samples_bulk(
        db_session, parent_sample_id="BLK-0001", photo_bytes=_PNG,
        photo_filename="vial.jpg", remarks=None, user_id=1, count=3,
    )
    assert err is None
    assert [s.vial_sequence for s in created] == [3, 4, 5]


def test_bulk_count_one_creates_single(db_session, parent, _unique_photo):
    created, err = service.create_sub_samples_bulk(
        db_session, parent_sample_id="BLK-0001", photo_bytes=_PNG,
        photo_filename="vial.jpg", remarks=None, user_id=1, count=1,
    )
    assert err is None
    assert len(created) == 1
    assert created[0].vial_sequence == 1


def test_bulk_request_schema_rejects_out_of_bounds():
    from pydantic import ValidationError
    from sub_samples.schemas import CreateBulkSubSamplesRequest

    CreateBulkSubSamplesRequest(parent_sample_id="P-1", photo_base64="x", count=1)
    CreateBulkSubSamplesRequest(parent_sample_id="P-1", photo_base64="x", count=50)
    for bad in (0, -1, 51, 1000):
        with pytest.raises(ValidationError):
            CreateBulkSubSamplesRequest(parent_sample_id="P-1", photo_base64="x", count=bad)
