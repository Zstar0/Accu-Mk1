"""Mk1 -> IS proxy routes for COA generation state: preview, revoke, forward.

Thin proxies onto the Integration Service explorer routes. The tests pin: the
exact IS path and body each one sends, that revoked_by is composed on the
server from the session (never taken from the browser), that an IS HTTP error
keeps its status (a 409 there is a 409 here), that an unreachable IS is a 503,
and the role gates: revoke and its preview are admin only, the forward switch
stays at Publish's gate.

Direct-call tests drive the coroutines; the last group goes through the mounted
app so the URLs and the gates are real.
"""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from auth import get_current_user


class _FakeClient:
    def __init__(self, captured, *, status=200, body=None, error=None, error_text="is says no"):
        self._captured = captured
        self._status = status
        self._body = body or {}
        self._error = error
        self._error_text = error_text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def _send(self, method, url, json=None, headers=None):
        self._captured.update({"method": method, "url": url, "body": json, "headers": headers or {}})
        if self._error:
            raise self._error
        status, body = self._status, self._body

        def raise_for_status():
            if status >= 400:
                raise httpx.HTTPStatusError(
                    "err", request=httpx.Request(method, url), response=httpx.Response(status, text=self._error_text)
                )

        return SimpleNamespace(status_code=status, raise_for_status=raise_for_status, json=lambda: body)

    async def get(self, url, headers=None):
        return await self._send("GET", url, headers=headers)

    async def post(self, url, json=None, headers=None):
        return await self._send("POST", url, json=json, headers=headers)

    async def patch(self, url, json=None, headers=None):
        return await self._send("PATCH", url, json=json, headers=headers)


def _patch_is(monkeypatch, captured, **client_kwargs):
    monkeypatch.setattr(main, "INTEGRATION_SERVICE_URL", "http://is.test")
    monkeypatch.setattr(main, "INTEGRATION_SERVICE_API_KEY", "k-test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: _FakeClient(captured, **client_kwargs))


GEN = "11111111-1111-4111-8111-111111111111"
ADMIN = SimpleNamespace(id=1, role="admin", first_name="Ada", last_name="Lovelace", email="ada@lab.test")
PREVIEW = {
    "target": {"generation_id": GEN, "verification_code": "PRIM-0002", "status": "published", "kind": "primary", "brand": None},
    "others": [
        {"generation_id": "22222222-2222-4222-8222-222222222222", "verification_code": "ACOA-0002", "status": "published", "kind": "additional", "brand": "Acme"},
    ],
}
REVOKED = {
    "revoked": [
        {"generation_id": GEN, "verification_code": "PRIM-0002", "status": "revoked", "kind": "primary", "brand": None,
         "revoked_at": "2026-09-23T15:04:05+00:00", "revocation_reason": "Lot recalled"},
    ],
    "skipped": [],
    "wp_notified": True,
    "wp_error": None,
}


# --- direct calls ------------------------------------------------------------

def test_revoke_posts_reason_codes_and_a_server_composed_revoked_by(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)

    out = asyncio.run(
        main.revoke_coa_generation(GEN, main.RevokeCOARequest(reason="Lot recalled", include_codes=["ACOA-0002"]), admin=ADMIN)
    )

    assert captured["method"] == "POST"
    assert captured["url"] == f"http://is.test/explorer/coa-generations/{GEN}/revoke"
    assert captured["body"] == {
        "reason": "Lot recalled",
        "include_codes": ["ACOA-0002"],
        "notify_customer": True,
        "revoked_by": "Ada Lovelace <ada@lab.test>",
    }
    assert captured["headers"]["X-API-Key"] == "k-test"
    assert out["revoked"][0]["status"] == "revoked" and out["wp_notified"] is True


def test_notify_customer_false_passes_through_to_the_is(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)
    asyncio.run(
        main.revoke_coa_generation(GEN, main.RevokeCOARequest(reason="Internal test", notify_customer=False), admin=ADMIN)
    )
    assert captured["body"]["notify_customer"] is False


def test_revoked_by_falls_back_to_the_email_when_no_name_is_set(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)
    nameless = SimpleNamespace(id=2, role="admin", first_name=None, last_name=None, email="ops@lab.test")
    asyncio.run(main.revoke_coa_generation(GEN, main.RevokeCOARequest(reason="r"), admin=nameless))
    assert captured["body"]["revoked_by"] == "ops@lab.test <ops@lab.test>"


def test_preview_proxies_a_get(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=PREVIEW)
    out = asyncio.run(main.revoke_coa_preview(GEN, _admin=ADMIN))
    assert captured["method"] == "GET"
    assert captured["url"] == f"http://is.test/explorer/coa-generations/{GEN}/revoke-preview"
    assert out["others"][0]["verification_code"] == "ACOA-0002"


def test_forward_patches_flag_to_is(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body={"generation_id": GEN, "verification_code": "OLD-0001", "status": "superseded",
                                            "forward_enabled": True, "revoked_at": None, "revocation_reason": None})
    out = asyncio.run(main.set_coa_forward_enabled(GEN, main.ForwardEnabledRequest(forward_enabled=True), _current_user=None))
    assert captured["method"] == "PATCH"
    assert captured["url"] == f"http://is.test/explorer/coa-generations/{GEN}/forward"
    assert captured["body"] == {"forward_enabled": True}
    assert out["forward_enabled"] is True


def test_is_http_error_keeps_its_status(monkeypatch):
    _patch_is(monkeypatch, {}, status=409)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.revoke_coa_generation(GEN, main.RevokeCOARequest(reason="x"), admin=ADMIN))
    assert exc.value.status_code == 409
    assert "is says no" in str(exc.value.detail)


@pytest.mark.parametrize(
    "error_body,expected_detail",
    [
        # Has a "message"/"error" key: flattens to that string.
        (
            {"detail": {"error": "Generation is revoked, not published or superseded", "status": "revoked"}},
            "Generation is revoked, not published or superseded",
        ),
        # Dict with none of message/error/detail: last-resort json.dumps.
        ({"detail": {"status": "revoked"}}, json.dumps({"status": "revoked"})),
    ],
)
def test_dict_shaped_is_error_detail_flattens_to_its_message(monkeypatch, error_body, expected_detail):
    _patch_is(monkeypatch, {}, status=409, error_text=json.dumps(error_body))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.revoke_coa_generation(GEN, main.RevokeCOARequest(reason="x"), admin=ADMIN))
    assert exc.value.status_code == 409
    assert exc.value.detail == expected_detail


def test_is_unreachable_is_503(monkeypatch):
    _patch_is(monkeypatch, {}, error=httpx.ConnectError("refused"))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.revoke_coa_preview(GEN, _admin=ADMIN))
    assert exc.value.status_code == 503


# --- mounted app: URLs and role gates ----------------------------------------

def _as(role):
    main.app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=1, role=role, first_name="Ada", last_name="Lovelace", email="ada@lab.test"
    )
    return TestClient(main.app)


def _clear():
    main.app.dependency_overrides.pop(get_current_user, None)


def test_non_admin_cannot_revoke_or_preview(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)
    try:
        r1 = _as("hplc").post(f"/explorer/coa-generations/{GEN}/revoke", json={"reason": "x"})
        r2 = _as("hplc").get(f"/explorer/coa-generations/{GEN}/revoke-preview")
    finally:
        _clear()
    assert r1.status_code == 403 and r2.status_code == 403
    assert "url" not in captured  # IS never called


def test_admin_revoke_and_preview_go_through_the_mounted_routes(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)
    try:
        resp = _as("admin").post(f"/explorer/coa-generations/{GEN}/revoke", json={"reason": "Lot recalled"})
    finally:
        _clear()
    assert resp.status_code == 200
    assert resp.json()["revoked"][0]["verification_code"] == "PRIM-0002"
    assert captured["body"]["revoked_by"] == "Ada Lovelace <ada@lab.test>"
    assert captured["body"]["include_codes"] == []

    captured.clear()
    _patch_is(monkeypatch, captured, body=PREVIEW)
    try:
        resp = _as("admin").get(f"/explorer/coa-generations/{GEN}/revoke-preview")
    finally:
        _clear()
    assert resp.status_code == 200 and resp.json()["target"]["kind"] == "primary"


def test_any_lab_user_can_set_the_forward_switch(monkeypatch):
    """Reversible and per-COA, so it stays at the same gate as Publish."""
    captured = {}
    _patch_is(monkeypatch, captured, body={"generation_id": GEN, "verification_code": "OLD-0001", "status": "superseded",
                                            "forward_enabled": True, "revoked_at": None, "revocation_reason": None})
    try:
        resp = _as("hplc").patch(f"/explorer/coa-generations/{GEN}/forward", json={"forward_enabled": True})
    finally:
        _clear()
    assert resp.status_code == 200 and resp.json()["forward_enabled"] is True


def test_generation_list_model_declares_the_chain_and_author_fields():
    fields = main.ExplorerCOAGenerationResponse.model_fields
    assert {"superseded_by_id", "revoked_by", "forward_enabled", "revoked_at", "revocation_reason"} <= set(fields)
