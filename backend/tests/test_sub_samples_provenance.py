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


# ── reconcile ─────────────────────────────────────────────────────

def test_reconcile_skipped_for_family_with_native_vial(db_session, parent, monkeypatch):
    """A family with at least one native vial must NOT pull from SENAITE —
    Mk1 is canonical. This is the BW-0013 500 guard."""
    _add_sub(db_session, parent, sample_id="PROV-0001-S01", uid="mk1://nativeuid", seq=1)
    # Make the cache look stale so list_sub_samples would normally reconcile.
    parent.last_synced_at = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
    db_session.commit()

    fetch = MagicMock()
    monkeypatch.setattr("sub_samples.senaite.fetch_secondaries", fetch)

    _parent, subs = service.list_sub_samples(db_session, "PROV-0001")

    fetch.assert_not_called()
    assert len(subs) == 1


def test_reconcile_runs_for_legacy_only_family(db_session, parent, monkeypatch):
    """A family with only legacy vials still reconciles from SENAITE (back-
    compat — nothing changes for pre-cutover families)."""
    _add_sub(db_session, parent, sample_id="PROV-0001-S01", uid="senaite-uid-1", seq=1)
    parent.last_synced_at = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
    db_session.commit()

    # SENAITE reports the one we already have — no new insert, no error.
    fetch = MagicMock(return_value=[{"uid": "senaite-uid-1", "id": "PROV-0001-S01"}])
    monkeypatch.setattr("sub_samples.senaite.fetch_secondaries", fetch)

    _parent, subs = service.list_sub_samples(db_session, "PROV-0001")

    fetch.assert_called_once()
    assert len(subs) == 1


def test_reconcile_skipped_for_empty_family_when_flag_on(db_session, parent, monkeypatch):
    """A family with zero subs and the native flag ON should not reconcile —
    new vials will be native, so SENAITE has nothing authoritative to add."""
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    parent.last_synced_at = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
    db_session.commit()

    fetch = MagicMock(return_value=[])
    monkeypatch.setattr("sub_samples.senaite.fetch_secondaries", fetch)

    service.list_sub_samples(db_session, "PROV-0001")

    fetch.assert_not_called()


def test_reconcile_runs_for_empty_family_when_flag_off(db_session, parent, monkeypatch):
    """Empty family + flag OFF (legacy opt-in) must STILL reconcile from SENAITE —
    the guard must not over-reach and skip back-compat reconciliation. As of
    1.0.2 native is the default, so the OFF case must be set explicitly."""
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "0")
    parent.last_synced_at = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
    db_session.commit()

    fetch = MagicMock(return_value=[])
    monkeypatch.setattr("sub_samples.senaite.fetch_secondaries", fetch)

    service.list_sub_samples(db_session, "PROV-0001")

    fetch.assert_called_once()
