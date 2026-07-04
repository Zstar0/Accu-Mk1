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
