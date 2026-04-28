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
