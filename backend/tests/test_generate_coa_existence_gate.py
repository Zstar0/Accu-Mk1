"""COA read-independence Task 10: generate_sample_coa's existence check.

mk1 mode's existence authority for a parent sample is lims_samples — an
unknown sample_id must abort with Mk1-named wording, never SENAITE, before
the COABuilder POST fires, and before the (fail-closed) resolver/attachment
pre-flight gates get a chance to mask the real problem behind a misleading
"missing attachments" 422. senaite mode is untouched by this task (no new
gate added on that branch).
"""
from types import SimpleNamespace

import pytest

import main


@pytest.mark.asyncio
async def test_mk1_mode_unknown_sample_aborts_with_accumk1_wording(
    db_session, monkeypatch,
):
    """No LimsSample row for this sample_id + mk1 mode -> abort naming
    Accu-Mk1, never SENAITE, and never reach the COABuilder POST.

    Deliberately does NOT patch the resolver pre-flight or the attachment
    gate: the existence check must fire before either runs, so this test
    only goes green if the gate is placed early enough to actually be
    reachable in production for a genuinely unknown sample_id."""
    sample_id = "P-UNKNOWN-9999"

    monkeypatch.setattr(main, "COA_BUILDER_URL", "http://coabuilder.test")
    monkeypatch.setattr(
        "coa.source_setting.coa_generation_source", lambda db: "mk1")

    # The COABuilder POST must never fire — fail loudly if it does.
    def _boom_post(*a, **kw):
        raise AssertionError("COABuilder POST must not fire for an unknown sample")
    monkeypatch.setattr(main.httpx, "AsyncClient", _boom_post)

    result = await main.generate_sample_coa(
        sample_id=sample_id, db=db_session,
        current_user=SimpleNamespace(id=1),
    )

    assert result.success is False
    assert "Accu-Mk1" in result.message
    assert "SENAITE" not in result.message
    # Not the attachments-gate's wording — proves the existence check ran
    # ahead of that gate, not that the gate itself happened to fail closed.
    assert "missing required attachments" not in result.message
