# backend/tests/test_sub_samples_provenance.py
"""Phase 5d: update/delete/reconcile branch on per-ROW provenance, not the
flag. A native vial (mk1://) skips SENAITE; a legacy vial (SENAITE UID)
still calls it. BOTH regimes tested per function — that's the whole point
of the provenance split.
"""
from __future__ import annotations

import datetime
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select

from models import LimsSample, LimsSubSample
from sub_samples import service


@pytest.fixture
def parent(db_session):
    p = LimsSample(
        sample_id="PROV-0001", external_lims_uid="parent-uid",
        last_synced_at=datetime.datetime.utcnow(),
    )
    db_session.add(p)
    db_session.commit()
    return p


def _add_sub(db_session, parent, *, sample_id, uid, seq):
    s = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid=uid,
        sample_id=sample_id, vial_sequence=seq,
        photo_external_uid=f"mk1://{sample_id}/photo.jpg",
        received_at=datetime.datetime.utcnow(),
    )
    db_session.add(s)
    db_session.commit()
    return s


# ── update ────────────────────────────────────────────────────────

def test_update_native_skips_senaite_remarks(db_session, parent, monkeypatch):
    s = _add_sub(db_session, parent, sample_id="PROV-0001-S01", uid="mk1://nativeuid", seq=1)
    remarks_call = MagicMock()
    monkeypatch.setattr("sub_samples.senaite.update_remarks", remarks_call)

    service.update_sub_sample(db_session, "PROV-0001-S01", None, None, "updated remarks")

    remarks_call.assert_not_called()
    db_session.refresh(s)
    assert s.remarks == "updated remarks"


def test_update_legacy_calls_senaite_remarks(db_session, parent, monkeypatch):
    s = _add_sub(db_session, parent, sample_id="PROV-0001-S02", uid="senaite-uid-2", seq=2)
    remarks_call = MagicMock()
    monkeypatch.setattr("sub_samples.senaite.update_remarks", remarks_call)

    service.update_sub_sample(db_session, "PROV-0001-S02", None, None, "legacy remarks")

    remarks_call.assert_called_once_with("senaite-uid-2", "legacy remarks")
    db_session.refresh(s)
    assert s.remarks == "legacy remarks"


# ── delete ────────────────────────────────────────────────────────

def test_delete_native_skips_senaite(db_session, parent, monkeypatch):
    _add_sub(db_session, parent, sample_id="PROV-0001-S03", uid="mk1://nativeuid3", seq=3)
    delete_call = MagicMock()
    monkeypatch.setattr("sub_samples.senaite.delete_secondary", delete_call)

    service.delete_sub_sample(db_session, "PROV-0001-S03")

    delete_call.assert_not_called()
    gone = db_session.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == "PROV-0001-S03")
    ).scalar_one_or_none()
    assert gone is None


def test_delete_legacy_calls_senaite(db_session, parent, monkeypatch):
    _add_sub(db_session, parent, sample_id="PROV-0001-S04", uid="senaite-uid-4", seq=4)
    delete_call = MagicMock()
    monkeypatch.setattr("sub_samples.senaite.delete_secondary", delete_call)

    service.delete_sub_sample(db_session, "PROV-0001-S04")

    delete_call.assert_called_once_with("senaite-uid-4")
