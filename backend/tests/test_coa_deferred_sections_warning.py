"""Partial-COA fix (2026-08-29, P-2432): the operator-facing warning that
surfaces a deferred native section (build_native_sections' fully-pending
profile deferral — see test_native_sections.py) through the generate and
regen-primary endpoints.

Covers:
  - coa.wire_document.deferred_sections_warning: the extracted helper, unit
    tested directly (per the task's fallback: endpoint-level coverage is
    ALSO included below, but the helper is pinned on its own too).
  - generate_sample_coa: a successful generation whose wire document carried
    deferred_sections surfaces the warning; one with no deferrals leaves it
    unset.
  - regen_primary_coa: same surfacing, merged onto whatever
    publish_sample_coa's own response returns (publish_sample_coa is stubbed
    out here — it has its own SENAITE/Integration-Service network calls that
    are orthogonal to this fix; test_native_sections.py's deferral tests
    already cover build_native_sections itself, and
    test_generate_coa_existence_gate.py / test_regular_coa_child.py pin the
    same in-process call + httpx-monkeypatch idiom used below).

Endpoint tests rely on coa_generation_source(db) defaulting to "senaite"
(coa/source_setting.py: no Settings row -> "senaite") and SENAITE_URL
defaulting unset, which together skip the resolver pre-flight and the
legacy_rows/sample_meta assembly entirely — build_native_sections itself
(the part this fix touches) is NOT gated by that toggle and runs regardless.
"""
from types import SimpleNamespace

import pytest

from coa.wire_document import deferred_sections_warning
from tests.test_native_sections import _mk_native_profile, _mk_parent_with_rows

import main


# ── deferred_sections_warning: the extracted helper ─────────────────────────

def test_helper_none_doc_returns_none():
    assert deferred_sections_warning(None) is None


def test_helper_empty_doc_returns_none():
    assert deferred_sections_warning({}) is None


def test_helper_doc_without_deferrals_key_returns_none():
    doc = {"sample_id": "P-1", "ordered_profiles": ["heavy_metals"], "sections": []}
    assert deferred_sections_warning(doc) is None


def test_helper_doc_with_empty_deferred_list_returns_none():
    """Defensive: build_native_sections never emits an empty list (it omits
    the key instead), but the helper must not misbehave if one ever
    reaches it some other way."""
    doc = {"deferred_sections": []}
    assert deferred_sections_warning(doc) is None


def test_helper_single_deferral_message():
    doc = {"deferred_sections": ["sterility_usp71"]}
    msg = deferred_sections_warning(doc)
    assert msg == (
        "Pending section(s) omitted: sterility_usp71 — "
        "regenerate the COA when results land."
    )


def test_helper_multiple_deferrals_join_with_comma():
    doc = {"deferred_sections": ["sterility_usp71", "endotoxin"]}
    msg = deferred_sections_warning(doc)
    assert "sterility_usp71, endotoxin" in msg


# ── generate_sample_coa: endpoint-level surfacing ────────────────────────────

class _FakeResponse:
    def __init__(self, json_data):
        self._json_data = json_data

    def raise_for_status(self):
        return None

    def json(self):
        return self._json_data


class _FakeClient:
    """Faithful to test_regular_coa_child.py's _FakeClient idiom: one COABuilder
    /process response, reused for every POST the code under test makes."""

    def __init__(self, json_data):
        self._json_data = json_data
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return _FakeResponse(self._json_data)


def _seed_deferred_and_complete_profiles(db_session, monkeypatch, *, sample_id):
    """heavy_metals (complete, one verified result) + sterility_usp71 (armed,
    zero results — the P-2432 shape) ordered on the same sample."""
    _hm_prof, hm_svcs = _mk_native_profile(
        db_session, key="heavy_metals", services=[("HM-PB", "mk1")], sort=10,
    )
    _ster_prof, _ster_svcs = _mk_native_profile(
        db_session, key="sterility_usp71", services=[("STERILITY_USP71", "mk1")],
        sort=20,
    )
    parent = _mk_parent_with_rows(db_session, hm_svcs)
    parent.sample_id = sample_id
    db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sid: {
            "services": {"heavy_metals": True, "sterility_usp71": True},
            "package": None,
        },
    )
    return parent


def _patch_generate_prereqs(monkeypatch, json_data):
    monkeypatch.setattr(main, "COA_BUILDER_URL", "http://coabuilder.test")
    monkeypatch.setattr(main, "SENAITE_URL", None)
    client = _FakeClient(json_data)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: client)
    return client


@pytest.mark.asyncio
async def test_generate_sample_coa_surfaces_deferred_sections_warning(
    db_session, monkeypatch,
):
    _seed_deferred_and_complete_profiles(db_session, monkeypatch, sample_id="P-9500")
    _patch_generate_prereqs(
        monkeypatch,
        {"verification_code": "ABCD-1234", "generation_number": 1, "warnings": []},
    )

    result = await main.generate_sample_coa(
        sample_id="P-9500", db=db_session, current_user=SimpleNamespace(id=1),
    )

    assert result.success is True
    assert result.warning is not None
    assert "sterility_usp71" in result.warning
    assert "Pending section(s) omitted" in result.warning


@pytest.mark.asyncio
async def test_generate_sample_coa_no_warning_when_nothing_deferred(
    db_session, monkeypatch,
):
    """Control: an order with every native profile fully resultant leaves
    `warning` unset — this fix must not manufacture noise on the common
    path."""
    _prof, svcs = _mk_native_profile(
        db_session, key="heavy_metals", services=[("HM-PB", "mk1")],
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    parent.sample_id = "P-9501"
    db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sid: {"services": {"heavy_metals": True}, "package": None},
    )
    _patch_generate_prereqs(
        monkeypatch,
        {"verification_code": "EFGH-5678", "generation_number": 1, "warnings": []},
    )

    result = await main.generate_sample_coa(
        sample_id="P-9501", db=db_session, current_user=SimpleNamespace(id=1),
    )

    assert result.success is True
    assert result.warning is None


# ── regen_primary_coa: endpoint-level surfacing, merged onto publish's own response ──

@pytest.mark.asyncio
async def test_regen_primary_coa_surfaces_deferred_sections_warning(
    db_session, monkeypatch,
):
    _seed_deferred_and_complete_profiles(db_session, monkeypatch, sample_id="P-9502")
    _patch_generate_prereqs(
        monkeypatch,
        {"verification_code": "IJKL-9012", "pdf_base64": None},
    )

    async def _fake_publish(sample_id, current_user, db):
        return main.SampleCOAActionResponse(
            success=True, message="COA published", verification_code="IJKL-9012",
        )
    monkeypatch.setattr(main, "publish_sample_coa", _fake_publish)

    result = await main.regen_primary_coa(
        sample_id="P-9502", db=db_session, current_user=SimpleNamespace(id=1),
    )

    assert result.success is True
    assert result.warning is not None
    assert "sterility_usp71" in result.warning


@pytest.mark.asyncio
async def test_regen_primary_coa_preserves_publish_warning_alongside_deferred(
    db_session, monkeypatch,
):
    """publish_sample_coa can carry its own warning (e.g. the SENAITE
    pre-publish-state notice) — the deferred-sections warning must be
    ADDED to it, never overwrite it."""
    _seed_deferred_and_complete_profiles(db_session, monkeypatch, sample_id="P-9503")
    _patch_generate_prereqs(
        monkeypatch,
        {"verification_code": "MNOP-3456", "pdf_base64": None},
    )

    async def _fake_publish(sample_id, current_user, db):
        return main.SampleCOAActionResponse(
            success=True, message="COA published", verification_code="MNOP-3456",
            warning="Warning: Sample should not typically be published from state X.",
        )
    monkeypatch.setattr(main, "publish_sample_coa", _fake_publish)

    result = await main.regen_primary_coa(
        sample_id="P-9503", db=db_session, current_user=SimpleNamespace(id=1),
    )

    assert "should not typically be published" in result.warning
    assert "sterility_usp71" in result.warning


@pytest.mark.asyncio
async def test_regen_primary_coa_no_warning_when_nothing_deferred(
    db_session, monkeypatch,
):
    _prof, svcs = _mk_native_profile(
        db_session, key="heavy_metals", services=[("HM-PB", "mk1")],
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    parent.sample_id = "P-9504"
    db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sid: {"services": {"heavy_metals": True}, "package": None},
    )
    _patch_generate_prereqs(
        monkeypatch,
        {"verification_code": "QRST-7890", "pdf_base64": None},
    )

    async def _fake_publish(sample_id, current_user, db):
        return main.SampleCOAActionResponse(
            success=True, message="COA published", verification_code="QRST-7890",
        )
    monkeypatch.setattr(main, "publish_sample_coa", _fake_publish)

    result = await main.regen_primary_coa(
        sample_id="P-9504", db=db_session, current_user=SimpleNamespace(id=1),
    )

    assert result.success is True
    assert result.warning is None
