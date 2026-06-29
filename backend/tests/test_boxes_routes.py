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
    fake = MagicMock(id=3, order_key="WP-20066", box_number=2, role="hplc", printed_at=None)
    with patch("boxes.routes.service.next_box", return_value=fake), \
         patch("boxes.routes.service.box_label_code", return_value="WP-20066-2"), \
         patch("boxes.routes.service.vial_count", return_value=0):
        resp = client.post("/api/boxes", json={"order_key": "WP-20066", "role": "hplc"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["label_code"] == "WP-20066-2"
    assert body["box_number"] == 2


def test_assign_role_mismatch_is_400():
    with patch("boxes.routes.service.assign_vials", side_effect=ValueError("role mismatch")):
        resp = client.post("/api/boxes/3/assign", json={"sub_sample_ids": ["P-0600-S01"]})
    assert resp.status_code == 400
