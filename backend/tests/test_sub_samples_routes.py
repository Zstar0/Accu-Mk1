"""Route-level tests for /api/sub-samples endpoints.

Focus: auth gating, schema validation, error handling, and happy-path responses.
The underlying service logic is covered separately; these tests verify FastAPI
wiring (dependency injection, status codes, JSON envelope).

Auth is mocked via app.dependency_overrides per the project pattern.
"""
from datetime import datetime
from unittest.mock import patch, MagicMock
import pytest
from fastapi.testclient import TestClient
from main import app
from auth import get_current_user
from sub_samples.senaite import SecondaryFalloutError

client = TestClient(app)


@pytest.fixture(autouse=True)
def override_auth():
    """Override auth dependency for all tests. Each test can use the mocked user."""
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield
    app.dependency_overrides.pop(get_current_user, None)


def _mock_sub(sample_id="P-0134-S01", parent_id="P-0134", vial_seq=1, remarks=None):
    """Create a mock LimsSubSample for testing."""
    sub = MagicMock()
    sub.id = 1
    sub.sample_id = sample_id
    sub.vial_sequence = vial_seq
    sub.received_at = datetime.utcnow()
    sub.received_by_user_id = 1
    sub.photo_external_uid = f"/senaite/clients/client-8/{sample_id}"
    sub.remarks = remarks
    sub.assignment_role = None
    sub.parent_sample = MagicMock(sample_id=parent_id)
    return sub


def test_create_sub_sample_201():
    """POST /api/sub-samples returns 201 with SubSampleResponse."""
    sub = _mock_sub()
    with patch("sub_samples.routes.service.create_sub_sample", return_value=sub):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "YWJj", "remarks": None},
        )
    assert resp.status_code == 201
    body = resp.json()
    assert body["sample_id"] == "P-0134-S01"
    assert body["parent_sample_id"] == "P-0134"
    assert body["vial_sequence"] == 1


def test_create_sub_sample_passes_decoded_photo_bytes_to_service():
    """POST decodes base64 photo and passes bytes to service."""
    sub = _mock_sub()
    with patch("sub_samples.routes.service.create_sub_sample", return_value=sub) as svc:
        client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "YWJj", "remarks": "first"},
        )
    kwargs = svc.call_args.kwargs
    assert kwargs["parent_sample_id"] == "P-0134"
    assert kwargs["photo_bytes"] == b"abc"  # base64 "YWJj" → b"abc"
    assert kwargs["remarks"] == "first"
    assert kwargs["user_id"] == 1


def test_create_sub_sample_rejects_invalid_base64():
    """POST with malformed base64 returns 400."""
    with patch("sub_samples.routes.service.create_sub_sample"):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "!!!invalid!!!", "remarks": None},
        )
    assert resp.status_code == 400
    assert "photo_base64" in resp.json()["detail"]


def test_create_sub_sample_502_on_secondary_fallout_with_orphan_info():
    """POST returns 502 with structured fallout error including orphan IDs."""
    fallout = SecondaryFalloutError(
        "test fallout",
        orphan_uid="ORPHAN_UID_ABC",
        orphan_sample_id="P-0136",
    )
    with patch("sub_samples.routes.service.create_sub_sample", side_effect=fallout):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "YWJj", "remarks": None},
        )
    assert resp.status_code == 502
    body = resp.json()
    assert body["detail"]["code"] == "secondary_fallout"
    assert body["detail"]["orphan_uid"] == "ORPHAN_UID_ABC"
    assert body["detail"]["orphan_sample_id"] == "P-0136"
    assert "test fallout" in body["detail"]["message"]


def test_create_sub_sample_502_on_generic_runtime_error():
    """POST with RuntimeError from service returns 502 with message."""
    with patch("sub_samples.routes.service.create_sub_sample",
               side_effect=RuntimeError("parent has no contact_uid")):
        resp = client.post(
            "/api/sub-samples",
            json={"parent_sample_id": "P-0134", "photo_base64": "YWJj", "remarks": None},
        )
    assert resp.status_code == 502
    assert "contact_uid" in resp.json()["detail"]


def test_list_sub_samples_with_children():
    """GET /api/sub-samples returns parent summary + children."""
    parent = MagicMock(
        sample_id="P-0134",
        external_lims_uid="UID",
        peptide_name="BPC-157",
        status="sample_received",
        last_synced_at=datetime.utcnow(),
    )
    s1 = _mock_sub("P-0134-S01", "P-0134", 1)
    s2 = _mock_sub("P-0134-S02", "P-0134", 2)
    with patch("sub_samples.routes.service.list_sub_samples", return_value=(parent, [s1, s2])):
        resp = client.get("/api/sub-samples?parent_sample_id=P-0134")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"]["sample_id"] == "P-0134"
    assert body["parent"]["sub_sample_count"] == 2
    assert len(body["sub_samples"]) == 2
    assert body["sub_samples"][0]["vial_sequence"] == 1
    assert body["sub_samples"][1]["vial_sequence"] == 2


def test_list_sub_samples_empty_for_unknown_parent():
    """GET with unknown parent returns 200 with empty list."""
    with patch("sub_samples.routes.service.list_sub_samples", return_value=(None, [])):
        resp = client.get("/api/sub-samples?parent_sample_id=P-9999")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"]["sample_id"] == "P-9999"
    assert body["parent"]["sub_sample_count"] == 0
    assert body["sub_samples"] == []
    assert body["parent"]["external_lims_uid"] is None


def test_list_sub_samples_missing_parent_query_param():
    """GET without parent_sample_id returns 422."""
    resp = client.get("/api/sub-samples")
    assert resp.status_code == 422


def test_update_sub_sample_200():
    """PATCH /api/sub-samples/{sample_id} returns 200 with updated response."""
    sub = _mock_sub(sample_id="P-0134-S01", remarks="updated")
    with patch("sub_samples.routes.service.update_sub_sample", return_value=sub):
        resp = client.patch(
            "/api/sub-samples/P-0134-S01",
            json={"photo_base64": None, "remarks": "updated"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sample_id"] == "P-0134-S01"
    assert body["remarks"] == "updated"


def test_update_sub_sample_with_photo():
    """PATCH with photo_base64 decodes and passes to service."""
    sub = _mock_sub()
    with patch("sub_samples.routes.service.update_sub_sample", return_value=sub) as svc:
        client.patch(
            "/api/sub-samples/P-0134-S01",
            json={"photo_base64": "ZGVm", "remarks": None},
        )
    args = svc.call_args.args
    assert args[1] == "P-0134-S01"  # sample_id
    assert args[2] == b"def"  # photo_bytes (base64 "ZGVm" → b"def")
    assert args[3] == "vial.jpg"  # photo_filename


def test_update_sub_sample_no_changes():
    """PATCH with all None values is valid (no-op)."""
    sub = _mock_sub()
    with patch("sub_samples.routes.service.update_sub_sample", return_value=sub) as svc:
        resp = client.patch(
            "/api/sub-samples/P-0134-S01",
            json={"photo_base64": None, "remarks": None},
        )
    assert resp.status_code == 200
    args = svc.call_args.args
    assert args[1] == "P-0134-S01"  # sample_id
    assert args[2] is None  # photo_bytes
    assert args[3] is None  # photo_filename
    assert args[4] is None  # remarks


def test_update_sub_sample_502_on_runtime_error():
    """PATCH with RuntimeError returns 502."""
    with patch("sub_samples.routes.service.update_sub_sample",
               side_effect=RuntimeError("sample not found")):
        resp = client.patch(
            "/api/sub-samples/P-0134-S01",
            json={"photo_base64": None, "remarks": "new remarks"},
        )
    assert resp.status_code == 502
    assert "sample not found" in resp.json()["detail"]


def test_delete_sub_sample_204():
    """DELETE /api/sub-samples/{sample_id} returns 204 with empty body."""
    with patch("sub_samples.routes.service.delete_sub_sample", return_value=None):
        resp = client.delete("/api/sub-samples/P-0134-S01")
    assert resp.status_code == 204
    assert resp.text == ""


def test_delete_sub_sample_502_on_runtime_error():
    """DELETE with RuntimeError returns 502."""
    with patch("sub_samples.routes.service.delete_sub_sample",
               side_effect=RuntimeError("cannot delete")):
        resp = client.delete("/api/sub-samples/P-0134-S01")
    assert resp.status_code == 502
    assert "cannot delete" in resp.json()["detail"]


def test_vial_plan_returns_full_layout():
    """GET /api/sub-samples/{parent}/vial-plan returns demand + per-vial roles."""
    parent = MagicMock()
    parent.sample_id = "BW-0006"
    parent.assignment_role = "hplc"
    sub1 = _mock_sub("BW-0006-S01", "BW-0006", vial_seq=1)
    sub1.assignment_role = None
    sub2 = _mock_sub("BW-0006-S02", "BW-0006", vial_seq=2)
    sub2.assignment_role = None
    sub3 = _mock_sub("BW-0006-S03", "BW-0006", vial_seq=3)
    sub3.assignment_role = None

    with patch("sub_samples.routes.service.compute_vial_plan", return_value={
        "demand": {"hplc": 1, "endo": 1, "ster": 2},
        "wp_order_number": "3229",
        "vials": [
            {"sample_id": "BW-0006",     "is_parent": True,  "vial_sequence": 0, "assignment_role": "hplc"},
            {"sample_id": "BW-0006-S01", "is_parent": False, "vial_sequence": 1, "assignment_role": "endo"},
            {"sample_id": "BW-0006-S02", "is_parent": False, "vial_sequence": 2, "assignment_role": "ster"},
            {"sample_id": "BW-0006-S03", "is_parent": False, "vial_sequence": 3, "assignment_role": "ster"},
        ],
        "is_unreachable": False,
    }):
        resp = client.get("/api/sub-samples/BW-0006/vial-plan")
    assert resp.status_code == 200
    body = resp.json()
    assert body["demand"] == {"hplc": 1, "endo": 1, "ster": 2}
    assert body["wp_order_number"] == "3229"
    assert len(body["vials"]) == 4
    assert body["vials"][0]["is_parent"] is True
    assert body["vials"][1]["assignment_role"] == "endo"


def test_vial_plan_returns_503_envelope_when_is_unreachable():
    with patch("sub_samples.routes.service.compute_vial_plan", return_value={
        "demand": {"hplc": 0, "endo": 0, "ster": 0},
        "wp_order_number": None,
        "vials": [
            {"sample_id": "BW-0006", "is_parent": True, "vial_sequence": 0, "assignment_role": "hplc"},
        ],
        "is_unreachable": True,
    }):
        resp = client.get("/api/sub-samples/BW-0006/vial-plan")
    assert resp.status_code == 200  # body envelope, not http 503 — wizard banner-renders
    body = resp.json()
    assert body["is_unreachable"] is True
    assert body["demand"] == {"hplc": 0, "endo": 0, "ster": 0}


def test_assignment_patch_subsample_to_endo():
    sub = _mock_sub("BW-0006-S01", "BW-0006", vial_seq=1)
    sub.assignment_role = "ster"
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006-S01", "assignment_role": "endo"}
        resp = client.patch(
            "/api/sub-samples/BW-0006-S01/assignment",
            json={"role": "endo"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"sample_id": "BW-0006-S01", "assignment_role": "endo"}
    fn.assert_called_once()
    args, kwargs = fn.call_args
    assert kwargs.get("sample_id") or args[1] == "BW-0006-S01"
    assert kwargs.get("role") or args[2] == "endo"


def test_assignment_patch_subsample_null_resets():
    """null role on a sub-sample sets assignment_role=NULL (auto-assign on next plan call)."""
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006-S01", "assignment_role": None}
        resp = client.patch(
            "/api/sub-samples/BW-0006-S01/assignment",
            json={"role": None},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["assignment_role"] is None


def test_assignment_patch_parent_null_coerced_to_hplc():
    """null role on the parent AR is coerced to 'hplc' — preserves the
    'primary always HPLC' rule even after Reset-to-auto."""
    with patch("sub_samples.routes.service.set_assignment_role") as fn:
        fn.return_value = {"sample_id": "BW-0006", "assignment_role": "hplc"}
        resp = client.patch(
            "/api/sub-samples/BW-0006/assignment",
            json={"role": None},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["assignment_role"] == "hplc"


def test_aggregates_returns_count_and_breakdown_per_parent():
    """POST /aggregates returns sub_sample_count and role_breakdown keyed by
    parent_sample_id. Sample IDs not present in lims_samples are omitted."""
    with patch("sub_samples.routes.service.aggregate_by_parent") as fn:
        fn.return_value = {
            "BW-0006": {
                "sub_sample_count": 4,
                "role_breakdown": {"hplc": 1, "endo": 1, "ster": 2},
            },
            "P-0115": {
                "sub_sample_count": 0,
                "role_breakdown": {},
            },
            # PB-0099 NOT returned — not in lims_samples
        }
        resp = client.post(
            "/api/sub-samples/aggregates",
            json={"parent_sample_ids": ["BW-0006", "P-0115", "PB-0099"]},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert "aggregates" in body
    aggs = body["aggregates"]
    assert set(aggs.keys()) == {"BW-0006", "P-0115"}
    assert aggs["BW-0006"]["sub_sample_count"] == 4
    assert aggs["BW-0006"]["role_breakdown"] == {"hplc": 1, "endo": 1, "ster": 2}
    assert aggs["P-0115"]["sub_sample_count"] == 0
    assert aggs["P-0115"]["role_breakdown"] == {}
    assert "PB-0099" not in aggs


def test_aggregates_rejects_empty_id_list():
    """min_length=1 on parent_sample_ids — empty list returns 422."""
    resp = client.post(
        "/api/sub-samples/aggregates",
        json={"parent_sample_ids": []},
    )
    assert resp.status_code == 422
