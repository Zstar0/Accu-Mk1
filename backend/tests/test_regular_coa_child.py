"""Plan 2 B1/B2: Mk1 emits the Regular parent-services COA child for variance samples.

Tests the _maybe_emit_regular_coa_child helper directly — the variance detection
(build_variance_replicates) is patched per-branch and the COABuilder httpx call is
faked, so we assert the regular-child /process body without seeding a full sample.
"""
from types import SimpleNamespace

import pytest

import main


class _FakeClient:
    def __init__(self, captured):
        self._captured = captured

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        self._captured["url"] = url
        self._captured["body"] = json
        return SimpleNamespace(raise_for_status=lambda: None)


def _patch_coabuilder(monkeypatch, captured):
    monkeypatch.setattr(main, "COA_BUILDER_URL", "http://coabuilder.test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: _FakeClient(captured))


@pytest.mark.asyncio
async def test_emit_regular_child_for_variance_posts_plain_body(db_session, monkeypatch):
    monkeypatch.setattr(
        "coa.variance_series.build_variance_replicates",
        lambda db, parent: {"PEP": [{"vial_sequence": 2}]},  # variance sample
    )
    captured = {}
    _patch_coabuilder(monkeypatch, captured)
    parent = SimpleNamespace(customer_remarks_include=False, customer_remarks=None)

    await main._maybe_emit_regular_coa_child(db_session, "P-X", parent, {"generation_id": "GEN-1"})

    assert captured["url"].endswith("/process/P-X")
    assert captured["body"]["is_regular_coa"] is True
    assert captured["body"]["parent_generation_id"] == "GEN-1"
    # the regular COA carries NO variance treatment
    assert "variance_replicates" not in captured["body"]
    assert "variance_analytes" not in captured["body"]
    assert "vial_figures" not in captured["body"]


@pytest.mark.asyncio
async def test_no_regular_child_for_non_variance(db_session, monkeypatch):
    monkeypatch.setattr(
        "coa.variance_series.build_variance_replicates",
        lambda db, parent: {},  # non-variance: primary already IS the regular COA
    )
    captured = {}
    _patch_coabuilder(monkeypatch, captured)
    parent = SimpleNamespace(customer_remarks_include=False, customer_remarks=None)

    await main._maybe_emit_regular_coa_child(db_session, "P-X", parent, {"generation_id": "GEN-1"})

    assert captured == {}  # no COABuilder call


@pytest.mark.asyncio
async def test_no_regular_child_when_primary_has_no_generation_id(db_session, monkeypatch):
    monkeypatch.setattr(
        "coa.variance_series.build_variance_replicates",
        lambda db, parent: {"PEP": [{"vial_sequence": 2}]},
    )
    captured = {}
    _patch_coabuilder(monkeypatch, captured)
    parent = SimpleNamespace(customer_remarks_include=False, customer_remarks=None)

    # primary_data missing generation_id -> cannot parent the child -> no call
    await main._maybe_emit_regular_coa_child(db_session, "P-X", parent, {})

    assert captured == {}
