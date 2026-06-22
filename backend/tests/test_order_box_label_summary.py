import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch
import auth
import main
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _auth_override():
    """Make these tests hermetic: the endpoint depends on get_current_user, so a
    standalone run 401s without an override. Some sibling test modules install
    this override at import time and never tear it down; capture and restore the
    prior value (rather than clearing) so we don't strip their leaked override
    in a full-suite run."""
    key = auth.get_current_user
    prev = app.dependency_overrides.get(key)
    app.dependency_overrides[key] = lambda: {"id": 0, "username": "test"}
    yield
    if prev is None:
        app.dependency_overrides.pop(key, None)
    else:
        app.dependency_overrides[key] = prev

def _fake_order_row():
    return {
        "order_number": "WP-3263",
        "created_at": __import__("datetime").datetime(2026, 6, 15, 12, 0, 0),
        "sample_results": {
            "1": {"senaite_id": "P-0858"},
            "2": {"senaite_id": "P-0859"},
        },
    }

_SERVICES = {
    "P-0858": {"hplcpurity_identity": True, "endotoxin": True, "sterility_pcr": True},
    "P-0859": {"hplcpurity_identity": True},
}

def test_box_label_summary_sums_vials_per_department():
    with patch.object(main, "_fetch_order_submission_row", return_value=_fake_order_row()), \
         patch("sub_samples.service.fetch_sample_services", side_effect=lambda sid: _SERVICES.get(sid)):
        r = client.get("/orders/WP-3263/box-label-summary")
    assert r.status_code == 200
    body = r.json()
    assert body["order_number"] == "WP-3263"
    assert body["order_date"] == "2026-06-15"
    # P-0858: hplc1+endo1+ster2 ; P-0859: hplc1  => hplc2, endo1, ster2
    assert body["counts"] == {"hplc": 2, "endo": 1, "ster": 2}

def test_box_label_summary_404_when_order_missing():
    with patch.object(main, "_fetch_order_submission_row", return_value=None):
        r = client.get("/orders/WP-0000/box-label-summary")
    assert r.status_code == 404

def test_box_label_summary_skips_unmapped_sample_services():
    with patch.object(main, "_fetch_order_submission_row", return_value=_fake_order_row()), \
         patch("sub_samples.service.fetch_sample_services", side_effect=lambda sid: _SERVICES.get(sid) if sid == "P-0858" else None):
        r = client.get("/orders/WP-3263/box-label-summary")
    assert r.json()["counts"] == {"hplc": 1, "endo": 1, "ster": 2}  # P-0859 skipped
