"""Unit tests for the canonical basic-info registry
(2026-07-02-lims-sample-canonical-basic-info-design.md)."""
import pytest
from datetime import datetime
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
