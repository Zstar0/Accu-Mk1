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

# fetch_sample_services returns the IS payload with the flags nested under
# "services" (alongside analytical_test, wp_order_number) — not a flat dict.
# The endpoint must unwrap .get("services") before derive_base_demand.
_SERVICES = {
    "P-0858": {"services": {"hplcpurity_identity": True, "endotoxin": True, "sterility_pcr": True}},
    "P-0859": {"services": {"hplcpurity_identity": True}},
}

def test_box_label_summary_sums_vials_per_department():
    with patch.object(main, "_fetch_order_submission_row", return_value=_fake_order_row()), \
         patch("sub_samples.service.fetch_sample_services", side_effect=lambda sid: _SERVICES.get(sid)):
        r = client.get("/orders/WP-3263/box-label-summary")
    assert r.status_code == 200
    body = r.json()
    assert body["order_number"] == "WP-3263"
    assert body["order_date"] == "2026-06-15"
    # P-0858: hplc1+endo1+ster1 ; P-0859: hplc1  => hplc2, endo1, ster1
    assert body["counts"] == {"hplc": 2, "endo": 1, "ster": 1}

def test_box_label_summary_404_when_order_missing():
    with patch.object(main, "_fetch_order_submission_row", return_value=None):
        r = client.get("/orders/WP-0000/box-label-summary")
    assert r.status_code == 404

def test_box_label_summary_503_when_services_fetch_raises():
    # A network/non-2xx error (raise, not a 404 None) must fail loud rather than
    # silently undercount — otherwise the wizard would print a misleading label.
    def _raise(sid):
        raise RuntimeError("IS unreachable")
    with patch.object(main, "_fetch_order_submission_row", return_value=_fake_order_row()), \
         patch("sub_samples.service.fetch_sample_services", side_effect=_raise):
        r = client.get("/orders/WP-3263/box-label-summary")
    assert r.status_code == 503


def test_box_label_summary_skips_unmapped_sample_services():
    with patch.object(main, "_fetch_order_submission_row", return_value=_fake_order_row()), \
         patch("sub_samples.service.fetch_sample_services", side_effect=lambda sid: _SERVICES.get(sid) if sid == "P-0858" else None):
        r = client.get("/orders/WP-3263/box-label-summary")
    assert r.json()["counts"] == {"hplc": 1, "endo": 1, "ster": 1}  # P-0859 skipped


# Deliberately NOT 'heavy_metals' — this fixture inserts through the app's
# real engine/SessionLocal against the live dev DB (this endpoint's get_db()
# is never overridden in this file), so colliding with the real seeded
# catalog key would delete a genuine catalog row on every run once one
# exists. A test-only key can only ever be test debris, never live data, so
# it's the only key safe for this fixture to also clean up if a prior run
# crashed before teardown.
_HM_TEST_KEY = "hm_boxlabel_test_fixture"


@pytest.fixture
def hm_profile():
    """A test-only 'hm' fulfillment_role profile (vials_required=1, dim='role')
    — same demand shape as test_catalog_demand.py's _mk_hm_profile, but keyed
    distinctly from the real 'heavy_metals' catalog key (see _HM_TEST_KEY) and
    inserted through the app's real engine/SessionLocal since this file's
    endpoint runs against the live get_db() session, not the sqlite db_session
    fixture. Self-restoring — touches only its own row, never the real catalog."""
    from database import SessionLocal
    from models import AnalysisProfile
    db = SessionLocal()
    try:
        stale = db.query(AnalysisProfile).filter_by(key=_HM_TEST_KEY).one_or_none()
        if stale:
            db.delete(stale)
            db.commit()
        p = AnalysisProfile(key=_HM_TEST_KEY, name="HM Box Label Test Fixture", is_addon=True,
                             vials_required=1, fulfillment_role="hm",
                             fulfillment_dim="role", active=True)
        db.add(p)
        db.commit()
        db.refresh(p)
        pid = p.id
        yield p
    finally:
        db.query(AnalysisProfile).filter_by(id=pid).delete()
        db.commit()
        db.close()


def test_box_label_summary_counts_hm_bucket(hm_profile):
    """Finding 1: get_order_box_label_summary must not drop the hm bucket —
    an order with the hm-role test profile + hplcpurity_identity demands hplc
    AND hm. The box-label endpoints resolve demand by profile key, so proving
    it via this test-only key (fulfillment_role='hm') exercises the same
    accumulation path a real 'heavy_metals' order would."""
    hm_row = {
        "order_number": "WP-3269",
        "created_at": __import__("datetime").datetime(2026, 7, 30, 12, 0, 0),
        "sample_results": {"1": {"senaite_id": "P-0900"}},
    }
    services = {"P-0900": {"services": {"hplcpurity_identity": True, _HM_TEST_KEY: True}}}
    with patch.object(main, "_fetch_order_submission_row", return_value=hm_row), \
         patch("sub_samples.service.fetch_sample_services", side_effect=lambda sid: services.get(sid)):
        r = client.get("/orders/WP-3269/box-label-summary")
    assert r.status_code == 200, r.text
    counts = r.json()["counts"]
    assert counts["hm"] == 1
    assert counts["hplc"] == 1
