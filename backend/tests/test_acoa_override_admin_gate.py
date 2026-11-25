"""PATCH /explorer/additional-coas/{id}: lot_override / sample_image_url are
admin-only (exception to the COA display policy); branding stays open."""
import asyncio

import pytest
from fastapi import HTTPException

import main

_sent = {}


class _Client:
    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def patch(self, url, json, headers):
        _sent["json"] = json

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return {"success": True}

        return R()


def _call(body, role):
    user = type("U", (), {"role": role})()
    return asyncio.run(main.update_additional_coa_config(
        "cfg", main.AdditionalCOAUpdateRequest(**body), user))


@pytest.mark.parametrize("field", ["lot_override", "sample_image_url"])
def test_non_admin_cannot_touch_override(field):
    for value in ("X", None):  # setting and clearing are both gated
        with pytest.raises(HTTPException) as e:
            _call({field: value}, "standard")
        assert e.value.status_code == 403


def test_admin_override_and_non_admin_branding_reach_is(monkeypatch):
    monkeypatch.setattr(main.httpx, "AsyncClient", _Client)
    _call({"lot_override": "NEW-LOT"}, "admin")
    assert _sent["json"] == {"lot_override": "NEW-LOT"}
    _call({"company_name": "Brand"}, "standard")
    assert _sent["json"] == {"company_name": "Brand"}
