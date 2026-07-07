from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user


@pytest.fixture(autouse=True)
def override_auth():
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield
    app.dependency_overrides.pop(get_current_user, None)


client = TestClient(app)


def test_create_box_returns_label_code():
    fake = MagicMock(id=3, order_key="WP-20066", box_number=2, role="hplc", printed_at=None,
                     created_at=None, stored_at=None)
    with patch("boxes.routes.service.next_box", return_value=fake), \
         patch("boxes.routes.service.box_label_code", return_value="BOX-20066-2"), \
         patch("boxes.routes.service.vial_count", return_value=0):
        resp = client.post("/api/boxes", json={"order_key": "WP-20066", "role": "hplc"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["label_code"] == "BOX-20066-2"
    assert body["box_number"] == 2


def test_assign_role_mismatch_is_400():
    with patch("boxes.routes.service.assign_vials", side_effect=ValueError("role mismatch")):
        resp = client.post("/api/boxes/3/assign", json={"sub_sample_ids": ["P-0600-S01"]})
    assert resp.status_code == 400


def test_unassign_returns_count():
    with patch("boxes.routes.service.unassign_vials", return_value=2) as m:
        resp = client.post("/api/boxes/unassign", json={"sub_sample_ids": ["P-0600-S01", "P-0600-S02"]})
    assert resp.status_code == 200
    assert resp.json() == {"unassigned": 2}
    m.assert_called_once()


def test_unassign_already_unassigned_is_noop_success():
    with patch("boxes.routes.service.unassign_vials", return_value=0):
        resp = client.post("/api/boxes/unassign", json={"sub_sample_ids": ["P-0600-S01"]})
    assert resp.status_code == 200
    assert resp.json() == {"unassigned": 0}


def test_delete_empty_box_returns_204():
    with patch("boxes.routes.service.delete_box", return_value=None):
        resp = client.delete("/api/boxes/3")
    assert resp.status_code == 204
    assert resp.content == b""


def test_delete_box_with_vials_returns_204():
    # Deleting a box with vials is now allowed (service returns them to Unboxed),
    # so the route responds 204 — there is no 409 rejection path anymore.
    with patch("boxes.routes.service.delete_box", return_value=None):
        resp = client.delete("/api/boxes/3")
    assert resp.status_code == 204


def test_delete_missing_box_404():
    with patch("boxes.routes.service.delete_box", side_effect=LookupError("box 99 not found")):
        resp = client.delete("/api/boxes/99")
    assert resp.status_code == 404


def test_list_active_boxes_returns_200():
    with patch("boxes.routes.service.list_active", return_value=[]):
        resp = client.get("/api/boxes/active")
    assert resp.status_code == 200
    assert resp.json() == []


def test_active_boxes_include_vials():
    fake = MagicMock(id=13, order_key="WP-3267", box_number=1, role="hplc",
                     printed_at=None, created_at=None, stored_at=None)
    vials = [{"sample_id": "P-0141-S01", "parent_sample_id": "P-0141",
              "assignment_role": "hplc", "vial_sequence": 1}]
    with patch("boxes.routes.service.list_active", return_value=[fake]), \
         patch("boxes.routes.service.vials_for_boxes", return_value={13: vials}), \
         patch("boxes.routes.service.box_label_code", return_value="BOX-3267-1"), \
         patch("boxes.routes.service.vial_count", return_value=1):
        resp = client.get("/api/boxes/active")
    assert resp.status_code == 200
    assert resp.json()[0]["vials"][0]["sample_id"] == "P-0141-S01"


def test_close_box_returns_stored_box():
    fake = MagicMock(id=13, order_key="WP-3267", box_number=1, role="hplc",
                     printed_at=None, created_at=None, stored_at="2026-07-01T13:00:00")
    with patch("boxes.routes.service.close_box", return_value=fake) as m, \
         patch("boxes.routes.service.box_label_code", return_value="BOX-3267-1"), \
         patch("boxes.routes.service.vial_count", return_value=0):
        resp = client.post("/api/boxes/13/close")
    assert resp.status_code == 200
    assert resp.json()["stored_at"] is not None
    m.assert_called_once()
    assert m.call_args.args[1] == 13 or m.call_args.kwargs.get("box_id") == 13


def test_close_missing_box_returns_404():
    with patch("boxes.routes.service.close_box", side_effect=LookupError("box 99 not found")):
        resp = client.post("/api/boxes/99/close")
    assert resp.status_code == 404
