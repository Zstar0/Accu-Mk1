"""Partial-COA deferral is SILENT to operators (Handler ruling 2026-08-30,
reversing the 08-29 warning): a fully-pending native section is simply left
off the certificate, and the generate/regen responses carry NO message about
it — the COA presents the generated sections as if that's all that's on it.
The `deferred_sections` wire key itself is untouched (COA Builder needs it to
exempt the missing section from its completeness rule), and the backend log
line remains for forensics.

Covers:
  - generate_sample_coa: a successful generation whose wire document carried
    deferred_sections leaves `warning` unset — same as a no-deferral run.
  - regen_primary_coa: same silence, and publish_sample_coa's OWN warning
    (e.g. the SENAITE pre-publish-state notice) still passes through
    untouched (publish_sample_coa is stubbed out here — it has its own
    SENAITE/Integration-Service network calls that are orthogonal;
    test_native_sections.py's deferral tests cover build_native_sections
    itself, and test_generate_coa_existence_gate.py /
    test_regular_coa_child.py pin the same in-process call +
    httpx-monkeypatch idiom used below).

Endpoint tests rely on coa_generation_source(db) defaulting to "senaite"
(coa/source_setting.py: no Settings row -> "senaite") and SENAITE_URL
defaulting unset, which together skip the resolver pre-flight and the
legacy_rows/sample_meta assembly entirely — build_native_sections itself
is NOT gated by that toggle and runs regardless.
"""
from types import SimpleNamespace

import pytest

from tests.test_native_sections import _mk_native_profile, _mk_parent_with_rows

import main


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
async def test_generate_sample_coa_silent_on_deferred_sections(
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
    assert result.warning is None


@pytest.mark.asyncio
async def test_generate_sample_coa_no_warning_when_nothing_deferred(
    db_session, monkeypatch,
):
    """Control: the common no-deferral path is equally silent."""
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


@pytest.mark.asyncio
async def test_regen_primary_coa_silent_on_deferred_sections(
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
    assert result.warning is None


@pytest.mark.asyncio
async def test_regen_primary_coa_preserves_publish_warning_verbatim(
    db_session, monkeypatch,
):
    """publish_sample_coa can carry its own warning (e.g. the SENAITE
    pre-publish-state notice) — it must pass through untouched, with no
    deferral text appended."""
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

    assert result.warning == (
        "Warning: Sample should not typically be published from state X."
    )
