# backend/tests/test_sub_samples_cutover.py
"""Phase 5d: create_sub_sample flag-branch tests.

Flag ON  → Mk1-native vial, ZERO senaite.create_secondary calls, sample_id
           and external_lims_uid generated locally (mk1://).
Flag OFF → legacy path, senaite.create_secondary called exactly as before.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from sqlalchemy import select

from models import LimsSample, LimsSubSample
from sub_samples import service
from sub_samples.senaite import SecondaryCreateResult


_PNG = b"\x89PNG\r\n\x1a\n"


@pytest.fixture
def parent(db_session):
    p = LimsSample(
        sample_id="CUT-0001",
        external_lims_uid="parentuid-CUT-0001",
        client_uid="client-uid-1",
        contact_uid="contact-uid-1",
        sample_type="sampletype-uid-1",
        last_synced_at=__import__("datetime").datetime.utcnow(),
    )
    db_session.add(p)
    db_session.commit()
    return p


@pytest.fixture
def _stub_photo(monkeypatch):
    """Stub Mk1 photo storage so no disk write happens."""
    fake_storage = MagicMock()
    fake_storage.save_photo.return_value = "CUT-0001-S01/photo.jpg"
    monkeypatch.setattr(
        "sub_samples.photo_storage.get_storage", lambda: fake_storage
    )
    return fake_storage


@pytest.fixture
def _stub_wp_services(monkeypatch):
    """No role at create time → seeding is a no-op; stub the IS fetch anyway."""
    monkeypatch.setattr(service, "_fetch_wp_services_for_parent", lambda *_a, **_k: {})


def test_native_create_skips_senaite(db_session, parent, _stub_photo, _stub_wp_services, monkeypatch):
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")

    senaite_create = MagicMock()
    monkeypatch.setattr("sub_samples.senaite.create_secondary", senaite_create)
    monkeypatch.setattr("sub_samples.senaite.update_remarks", MagicMock())
    monkeypatch.setattr("sub_samples.senaite.update_secondary_fields", MagicMock())

    sub = service.create_sub_sample(
        db_session,
        parent_sample_id="CUT-0001",
        photo_bytes=_PNG,
        photo_filename="vial.jpg",
        remarks="native test",
        user_id=1,
    )

    senaite_create.assert_not_called()
    assert sub.sample_id == "CUT-0001-S01"
    assert sub.external_lims_uid.startswith("mk1://")
    assert sub.remarks == "native test"
    assert sub.photo_external_uid.startswith("mk1://")
    assert sub.vial_sequence == 1


def test_native_create_photo_failure_inserts_no_row(
    db_session, parent, _stub_wp_services, monkeypatch
):
    """Native path raises on photo-save failure BEFORE inserting the row —
    no SENAITE orphan exists, and no partial DB row is left behind."""
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    fake_storage = MagicMock()
    fake_storage.save_photo.side_effect = IOError("disk full")
    monkeypatch.setattr("sub_samples.photo_storage.get_storage", lambda: fake_storage)
    monkeypatch.setattr("sub_samples.senaite.create_secondary", MagicMock())

    with pytest.raises(IOError):
        service.create_sub_sample(
            db_session, parent_sample_id="CUT-0001", photo_bytes=_PNG,
            photo_filename="v.jpg", remarks=None, user_id=1,
        )

    leftover = db_session.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
    ).scalars().all()
    assert leftover == []


def test_native_create_second_vial_increments_sequence(
    db_session, parent, _stub_photo, _stub_wp_services, monkeypatch
):
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    monkeypatch.setattr("sub_samples.senaite.create_secondary", MagicMock())
    monkeypatch.setattr("sub_samples.senaite.update_remarks", MagicMock())

    s1 = service.create_sub_sample(
        db_session, parent_sample_id="CUT-0001", photo_bytes=_PNG,
        photo_filename="v.jpg", remarks=None, user_id=1,
    )
    s2 = service.create_sub_sample(
        db_session, parent_sample_id="CUT-0001", photo_bytes=_PNG,
        photo_filename="v.jpg", remarks=None, user_id=1,
    )
    assert s1.sample_id == "CUT-0001-S01"
    assert s2.sample_id == "CUT-0001-S02"
    assert s1.external_lims_uid != s2.external_lims_uid


def test_native_create_after_legacy_subs_continues_sequence(
    db_session, parent, _stub_photo, _stub_wp_services, monkeypatch
):
    """A dual-written family already has SENAITE subs S01-S02. The first
    native vial must be S03 (no collision)."""
    import datetime
    for seq in (1, 2):
        db_session.add(LimsSubSample(
            parent_sample_pk=parent.id,
            external_lims_uid=f"senaite-uid-{seq}",  # legacy
            sample_id=f"CUT-0001-S0{seq}",
            vial_sequence=seq,
            received_at=datetime.datetime.utcnow(),
        ))
    db_session.commit()

    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    monkeypatch.setattr("sub_samples.senaite.create_secondary", MagicMock())
    monkeypatch.setattr("sub_samples.senaite.update_remarks", MagicMock())

    s3 = service.create_sub_sample(
        db_session, parent_sample_id="CUT-0001", photo_bytes=_PNG,
        photo_filename="v.jpg", remarks=None, user_id=1,
    )
    assert s3.sample_id == "CUT-0001-S03"
    assert s3.external_lims_uid.startswith("mk1://")


# ── 1.0.2: in_variance_set default + assignment coupling ─────────────────────


def _make_native(db_session, monkeypatch, n):
    """Create n native vials under CUT-0001; return them in sequence order."""
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    monkeypatch.setattr("sub_samples.senaite.create_secondary", MagicMock())
    monkeypatch.setattr("sub_samples.senaite.update_remarks", MagicMock())
    out = []
    for _ in range(n):
        out.append(service.create_sub_sample(
            db_session, parent_sample_id="CUT-0001", photo_bytes=_PNG,
            photo_filename="v.jpg", remarks=None, user_id=1,
        ))
    return out


def test_first_vial_defaults_in_variance_set(
    db_session, parent, _stub_photo, _stub_wp_services, monkeypatch
):
    """The first vial (baseline) defaults into the variance set; others don't."""
    s1, s2 = _make_native(db_session, monkeypatch, 2)
    assert s1.vial_sequence == 1 and s1.in_variance_set is True
    assert s2.vial_sequence == 2 and s2.in_variance_set is False


def test_assigning_variance_adds_to_set(
    db_session, parent, _stub_photo, _stub_wp_services, monkeypatch
):
    """A non-first vial assigned a variance kind joins the set."""
    _s1, s2 = _make_native(db_session, monkeypatch, 2)
    assert s2.in_variance_set is False
    service.set_assignment_role(db_session, s2.sample_id, role="hplc",
                               kind="variance", user_id=1)
    db_session.refresh(s2)
    assert s2.in_variance_set is True


def test_assigning_core_nonfirst_drops_from_set(
    db_session, parent, _stub_photo, _stub_wp_services, monkeypatch
):
    """A non-first vial assigned a non-variance kind drops out, even if it was
    in the set (e.g. a stale default)."""
    _s1, s2 = _make_native(db_session, monkeypatch, 2)
    s2.in_variance_set = True
    db_session.commit()
    service.set_assignment_role(db_session, s2.sample_id, role="hplc",
                               kind="core", user_id=1)
    db_session.refresh(s2)
    assert s2.in_variance_set is False


def test_first_vial_stays_in_set_when_assigned_core(
    db_session, parent, _stub_photo, _stub_wp_services, monkeypatch
):
    """The first vial (baseline) stays in the set regardless of its kind."""
    s1, = _make_native(db_session, monkeypatch, 1)
    service.set_assignment_role(db_session, s1.sample_id, role="hplc",
                               kind="core", user_id=1)
    db_session.refresh(s1)
    assert s1.in_variance_set is True


def test_legacy_create_still_calls_senaite(db_session, parent, _stub_photo, _stub_wp_services, monkeypatch):
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "0")

    senaite_create = MagicMock(return_value=SecondaryCreateResult(
        uid="senaite-new-uid", sample_id="CUT-0001-S01",
        path="/senaite/clients/client-8/CUT-0001-S01",
    ))
    monkeypatch.setattr("sub_samples.senaite.create_secondary", senaite_create)
    monkeypatch.setattr("sub_samples.senaite.update_remarks", MagicMock())
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_metadata", MagicMock(return_value={}))
    monkeypatch.setattr("sub_samples.senaite.uid_exists", MagicMock(return_value=True))

    sub = service.create_sub_sample(
        db_session, parent_sample_id="CUT-0001", photo_bytes=_PNG,
        photo_filename="v.jpg", remarks=None, user_id=1,
    )

    senaite_create.assert_called_once()
    assert sub.external_lims_uid == "senaite-new-uid"
    assert not sub.external_lims_uid.startswith("mk1://")
