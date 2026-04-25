from fastapi.testclient import TestClient
from unittest.mock import patch
import os
import uuid

from main import app

client = TestClient(app)


def _comment_text(call_args):
    """Return the comment body from a patched post_task_comment call.

    Patching the unbound method on the class binds `self` as args[0],
    so the comment text lands at args[-1]. Works for either positional
    or kwarg invocation.
    """
    args, kwargs = call_args
    if "comment_text" in kwargs:
        return kwargs["comment_text"]
    # Last positional is always comment_text (handler calls it positionally)
    return args[-1]


def _headers():
    return {
        "X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
        "Idempotency-Key": str(uuid.uuid4()),
    }


def _auth_headers():
    return {"X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"]}


def _make_request(status_override: str | None = None) -> str:
    """Create a peptide_request row and optionally force its status.

    Patches ClickUpClient.create_task_for_request so the new row always
    has a predictable clickup_task_id (the retract route's ClickUp-
    comment branch only fires when clickup_task_id is truthy, and
    most of these tests need to observe that call).

    Returns the id (str). If status_override is given and differs from
    "new", the row's status is updated directly via the repo.
    """
    body = {
        "compound_kind": "peptide",
        "compound_name": "Retractatide",
        "vendor_producer": "V",
        "submitted_by_wp_user_id": 7,
        "submitted_by_email": "a@b.c",
        "submitted_by_name": "N",
    }
    with patch(
        "main.ClickUpClient.create_task_for_request",
        return_value="stub-task-id",
    ):
        resp = client.post("/peptide-requests", headers=_headers(), json=body)
    assert resp.status_code == 201, resp.text
    rid = resp.json()["id"]
    if status_override is not None and status_override != "new":
        from peptide_request_repo import PeptideRequestRepository
        from uuid import UUID
        repo = PeptideRequestRepository()
        # update_status uses keyword-only args; see peptide_request_repo.py.
        repo.update_status(UUID(rid), new_status=status_override)
    return rid


def test_retract_rejects_missing_token():
    resp = client.post(
        "/peptide-requests/00000000-0000-0000-0000-000000000000/retract",
        json={},
    )
    assert resp.status_code == 401


def test_retract_happy_path_new_status():
    rid = _make_request()
    with patch("main.ClickUpClient.post_task_comment") as comment_mock, \
         patch("main.ClickUpClient.set_task_status") as status_mock:
        resp = client.post(
            f"/peptide-requests/{rid}/retract",
            headers=_headers(),
            json={"reason": "wrong compound"},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    comment_mock.assert_called_once()
    comment_text = _comment_text(comment_mock.call_args)
    assert "wrong compound" in comment_text
    status_mock.assert_called_once()
    args, kwargs = status_mock.call_args
    # `self` is args[0] when patching an unbound method; status is the
    # second positional arg (or a `status` kwarg).
    assert (kwargs.get("status") or args[-1]) == "retracted"
    follow = client.get(f"/peptide-requests/{rid}", headers=_auth_headers())
    assert follow.status_code == 404


def test_retract_omits_reason_line_when_empty():
    rid = _make_request()
    with patch("main.ClickUpClient.post_task_comment") as comment_mock, \
         patch("main.ClickUpClient.set_task_status"):
        resp = client.post(
            f"/peptide-requests/{rid}/retract",
            headers=_headers(),
            json={},
        )
    assert resp.status_code == 200
    comment_text = _comment_text(comment_mock.call_args)
    assert "Reason:" not in comment_text
    assert "retracted" in comment_text.lower()


def test_retract_rejected_status_is_retractable():
    rid = _make_request(status_override="rejected")
    with patch("main.ClickUpClient.post_task_comment"), \
         patch("main.ClickUpClient.set_task_status"):
        resp = client.post(
            f"/peptide-requests/{rid}/retract",
            headers=_headers(),
            json={},
        )
    assert resp.status_code == 200


def test_retract_blocks_on_approved_status():
    rid = _make_request(status_override="approved")
    with patch("main.ClickUpClient.post_task_comment") as comment_mock, \
         patch("main.ClickUpClient.set_task_status") as status_mock:
        resp = client.post(
            f"/peptide-requests/{rid}/retract",
            headers=_headers(),
            json={},
        )
    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"]["code"] == "request_not_retractable"
    assert body["detail"]["current_status"] == "approved"
    comment_mock.assert_not_called()
    status_mock.assert_not_called()
    follow = client.get(f"/peptide-requests/{rid}", headers=_auth_headers())
    assert follow.status_code == 200


def test_retract_still_succeeds_when_clickup_fails():
    rid = _make_request()
    with patch(
        "main.ClickUpClient.post_task_comment",
        side_effect=RuntimeError("clickup down"),
    ), patch(
        "main.ClickUpClient.set_task_status",
        side_effect=RuntimeError("clickup down"),
    ):
        resp = client.post(
            f"/peptide-requests/{rid}/retract",
            headers=_headers(),
            json={},
        )
    assert resp.status_code == 200
    follow = client.get(f"/peptide-requests/{rid}", headers=_auth_headers())
    assert follow.status_code == 404


def test_retract_returns_404_when_missing():
    resp = client.post(
        "/peptide-requests/00000000-0000-0000-0000-000000000000/retract",
        headers=_headers(),
        json={},
    )
    assert resp.status_code == 404
