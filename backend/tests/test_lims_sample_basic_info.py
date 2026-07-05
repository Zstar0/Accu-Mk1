"""Unit tests for the canonical basic-info registry
(2026-07-02-lims-sample-canonical-basic-info-design.md)."""
import pytest
from datetime import datetime, timedelta
from unittest.mock import patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsSample, LimsSubSample
from sub_samples import service
from sub_samples.service import (
    _parse_senaite_date,
    ensure_sample_row,
    list_sub_samples,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def _full_meta(**overrides):
    """A fetch_parent_metadata payload carrying the FULL basic-info set,
    shaped like the raw complete=true item (dates as ISO strings with
    offset, reference fields as dicts)."""
    meta = {
        "uid": "PARENT_UID",
        "ClientUID": "C_UID",
        "ClientID": "client-8",
        "ContactUID": "CT_UID",
        "SampleType": {"uid": "ST_UID", "url": "http://senaite/st"},
        "ClientSampleID": "CS-001",
        "Analyte1Peptide": {"uid": "PEP_UID", "title": "BPC-157"},
        "DateReceived": "2026-05-01T10:23:00+00:00",
        "DateSampled": "2026-04-30T08:00:00+02:00",
        "review_state": "received",
    }
    meta.update(overrides)
    return meta


# --- _parse_senaite_date -----------------------------------------------------

def test_parse_date_offset_string_to_naive_utc():
    assert _parse_senaite_date("2026-05-01T10:23:00+00:00") == datetime(2026, 5, 1, 10, 23, 0)


def test_parse_date_nonzero_offset_normalized_to_utc():
    # +02:00 → UTC is two hours earlier
    assert _parse_senaite_date("2026-04-30T08:00:00+02:00") == datetime(2026, 4, 30, 6, 0, 0)


def test_parse_date_trailing_z():
    assert _parse_senaite_date("2026-05-01T10:23:00Z") == datetime(2026, 5, 1, 10, 23, 0)


def test_parse_date_naive_string_kept_naive():
    assert _parse_senaite_date("2026-05-01T10:23:00") == datetime(2026, 5, 1, 10, 23, 0)


def test_parse_date_none_empty_garbage():
    assert _parse_senaite_date(None) is None
    assert _parse_senaite_date("") is None
    assert _parse_senaite_date("not-a-date") is None
    assert _parse_senaite_date({"uid": "X"}) is None  # non-string never raises


# --- _populate_basic_info + create path -------------------------------------

def test_populate_basic_info_writes_full_field_set(db):
    row = LimsSample(sample_id="P-0134")
    service._populate_basic_info(row, _full_meta())
    assert row.external_lims_uid == "PARENT_UID"
    assert row.external_lims_system == "senaite"
    assert row.client_id == "client-8"
    assert row.client_uid == "C_UID"
    assert row.contact_uid == "CT_UID"
    assert row.sample_type == "ST_UID"            # uid-extracted from dict
    assert row.client_sample_id == "CS-001"
    assert row.peptide_name == "BPC-157"          # label-extracted from dict
    assert row.date_received == datetime(2026, 5, 1, 10, 23, 0)
    assert row.date_sampled == datetime(2026, 4, 30, 6, 0, 0)  # +02:00 → UTC
    assert row.status == "received"
    assert row.last_synced_at is not None


def test_populate_basic_info_never_touches_non_basic_fields(db):
    row = LimsSample(sample_id="P-0134", container_mode=True,
                     assignment_role="ster", in_variance_set=False,
                     customer_remarks="keep me", is_retest=True)
    service._populate_basic_info(row, _full_meta())
    assert row.container_mode is True
    assert row.assignment_role == "ster"
    assert row.in_variance_set is False
    assert row.customer_remarks == "keep me"
    assert row.is_retest is True


def test_ensure_sample_row_now_sets_dates_on_create(db):
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta()):
        row = ensure_sample_row(db, "P-0134")
    assert row.date_received == datetime(2026, 5, 1, 10, 23, 0)
    assert row.date_sampled == datetime(2026, 4, 30, 6, 0, 0)
    assert row.client_sample_id == "CS-001"


def test_create_gate_container_mode_still_state_gated(db):
    # received at first touch → legacy (parent-is-vial-1), NOT container
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta(review_state="received")):
        received = ensure_sample_row(db, "P-0200")
    assert received.container_mode is False
    # pre-received at first touch → container family
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta(uid="U2", review_state="sample_due")):
        due = ensure_sample_row(db, "P-0201")
    assert due.container_mode is True


# --- full-field refresh ------------------------------------------------------

def test_refresh_writes_full_set_not_subset(db):
    """Rev-1 gap: refresh only wrote 5 fields, letting client_sample_id,
    peptide_name, client_id and the dates go stale forever."""
    db.add(LimsSample(sample_id="P-0134", external_lims_uid="OLD_UID",
                      client_sample_id="STALE-CSID", peptide_name="Old Peptide",
                      client_id="old-client"))
    db.commit()
    parent = db.query(LimsSample).filter_by(sample_id="P-0134").one()
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta()):
        service._refresh_parent_from_senaite(db, parent)
    assert parent.external_lims_uid == "PARENT_UID"
    assert parent.client_sample_id == "CS-001"      # the real drift source
    assert parent.peptide_name == "BPC-157"
    assert parent.client_id == "client-8"
    assert parent.date_received == datetime(2026, 5, 1, 10, 23, 0)
    assert parent.status == "received"


# --- reconcile piggyback -----------------------------------------------------


def _stale_parent(db, **kw):
    row = LimsSample(sample_id="P-0134", external_lims_uid="PARENT_UID",
                     client_sample_id="STALE-CSID",
                     last_synced_at=datetime.utcnow() - timedelta(minutes=10),
                     **kw)
    db.add(row)
    db.commit()
    return row


def test_stale_list_view_refreshes_basic_info(db):
    _stale_parent(db)
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta()) as fpm, \
         patch("sub_samples.service.senaite.fetch_secondaries", return_value=[]):
        parent, _subs = list_sub_samples(db, "P-0134")
    fpm.assert_called_once()
    assert parent.client_sample_id == "CS-001"
    assert parent.date_received == datetime(2026, 5, 1, 10, 23, 0)


def test_fresh_parent_skips_refresh(db):
    row = LimsSample(sample_id="P-0134", external_lims_uid="PARENT_UID",
                     last_synced_at=datetime.utcnow())
    db.add(row)
    db.commit()
    with patch("sub_samples.service.senaite.fetch_parent_metadata") as fpm:
        list_sub_samples(db, "P-0134")
    fpm.assert_not_called()


def test_refresh_failure_does_not_break_list(db):
    _stale_parent(db)
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               side_effect=RuntimeError("senaite down")), \
         patch("sub_samples.service.senaite.fetch_secondaries", return_value=[]):
        parent, subs = list_sub_samples(db, "P-0134")   # must not raise
    assert parent.client_sample_id == "STALE-CSID"      # stale but served


def test_native_family_still_gets_basic_info_refresh(db, monkeypatch):
    """Model-D guard skips the SUB-SAMPLE pull, not the parent refresh —
    a native family's parent AR still lives in SENAITE."""
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    _stale_parent(db)
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta()) as fpm, \
         patch("sub_samples.service.senaite.fetch_secondaries") as fsec:
        parent, _subs = list_sub_samples(db, "P-0134")
    fpm.assert_called_once()          # basic info refreshed
    fsec.assert_not_called()          # Model-D: sub-sample pull skipped
    assert parent.client_sample_id == "CS-001"
