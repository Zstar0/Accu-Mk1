"""M7 COA shim: mk1-mode source resolver keys native HPLC rows per slot.

_resolve_mk1_parent_tier is consulted on the real generate path in mk1 mode
(main.py:13238, coa_generation_source(db) == "mk1") and its decisions gate
generation via has_blocking_unresolved/summarize_unresolved — so a native
blend's two verified HPLC-PURITY rows must not collapse onto one decision
keyed by the bare (slot-generic) stored keyword.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.hplc_native import KW_IDENTITY, KW_PURITY, KW_QUANTITY
from lims_analyses.service import apply_transition, promote_to_parent
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _submit_verify_promote(db, row, value, unit="%"):
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value, user_id=1, commit=False)
    parent, _ = promote_to_parent(
        db, keyword=row.keyword, result_value=value, result_unit=unit,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}],
        user_id=1, commit=False,
    )
    apply_transition(db, analysis_id=parent.id, kind="verify", user_id=1, commit=False)
    db.refresh(parent)
    return parent


def _rows_by_kw(rows, kw):
    return sorted((r for r in rows if r.keyword == kw), key=lambda r: r.slot or 0)


def test_blend_purity_rows_key_by_slot(db):
    from coa.source_resolver import _resolve_mk1_parent_tier

    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-9101", slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")]
    )
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _rows_by_kw(rows, KW_PURITY)
    _submit_verify_promote(db, pur1, "98.1")
    _submit_verify_promote(db, pur2, "96.2")
    db.commit()

    decisions = _resolve_mk1_parent_tier(db, parent)

    assert "ANALYTE-1-PUR" in decisions
    assert "ANALYTE-2-PUR" in decisions
    assert "HPLC-PURITY" not in decisions
    assert decisions["ANALYTE-1-PUR"].chosen.value == "98.1"
    assert decisions["ANALYTE-2-PUR"].chosen.value == "96.2"
    assert decisions["ANALYTE-1-PUR"].analyte_keyword == "ANALYTE-1-PUR"


def test_single_peptide_native_parent_wire_keywords(db):
    from coa.source_resolver import _resolve_mk1_parent_tier

    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-9102", slots=[("BPC-157", "BPC157")]
    )
    rows = next(iter(vial_rows.values()))
    (pur,) = _rows_by_kw(rows, KW_PURITY)
    (qty,) = _rows_by_kw(rows, KW_QUANTITY)
    (ident,) = _rows_by_kw(rows, KW_IDENTITY)
    _submit_verify_promote(db, pur, "99.0")
    _submit_verify_promote(db, qty, "5.1", unit="mg")
    _submit_verify_promote(db, ident, "Pass", unit=None)
    db.commit()

    decisions = _resolve_mk1_parent_tier(db, parent)

    assert set(decisions) == {"HPLC-PUR", "PEPT-Total", "ANALYTE-1-ID"}


def test_pin_row_identity_matches_native_wire_keyword(db):
    from coa.source_resolver import _pin_row_identity_matches
    from models import LimsAnalysis

    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-9103", slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")]
    )
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _rows_by_kw(rows, KW_PURITY)
    p1 = _submit_verify_promote(db, pur1, "98.1")
    p2 = _submit_verify_promote(db, pur2, "96.2")
    db.commit()
    db.refresh(p1)
    db.refresh(p2)

    assert _pin_row_identity_matches(db, p2, "ANALYTE-2-PUR") is True
    assert _pin_row_identity_matches(db, p1, "ANALYTE-2-PUR") is False
    # Leg 1 (exact stored keyword) is untouched.
    assert _pin_row_identity_matches(db, p1, KW_PURITY) is True


def _run(coro):
    # asyncio.run (not get_event_loop().run_until_complete) — matches
    # tests/test_shadow_reader.py's rationale: order-independent even if
    # pytest-asyncio tests elsewhere in the session already consumed the
    # default event loop.
    import asyncio
    return asyncio.run(coro)


def test_resolve_sources_blend_no_phantom_bare_keyword(db):
    """Fix round 1 (Critical): end-to-end through resolve_sources with the
    real ShadowAnalysesReader. Before the shadow_reader filter, the reader
    surfaced both native purity rows under the bare 'HPLC-PURITY' keyword
    (in addition to mk1_decisions' ANALYTE-{n}-PUR keys), producing a
    phantom needs_decision block on every native blend COA."""
    from coa.block_summary import has_blocking_unresolved
    from coa.shadow_reader import ShadowAnalysesReader
    from coa.source_resolver import resolve_sources

    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-9201", slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")]
    )
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _rows_by_kw(rows, KW_PURITY)
    _submit_verify_promote(db, pur1, "98.1")
    _submit_verify_promote(db, pur2, "96.2")
    db.commit()

    result = _run(resolve_sources(parent.sample_id, db, ShadowAnalysesReader(db)))
    keys = {d.analyte_keyword for d in result.decisions}

    assert "ANALYTE-1-PUR" in keys and "ANALYTE-2-PUR" in keys
    assert "HPLC-PURITY" not in keys
    assert has_blocking_unresolved(result, micro_keywords=set()) is False


def test_resolve_sources_single_peptide_no_duplicate(db):
    from coa.shadow_reader import ShadowAnalysesReader
    from coa.source_resolver import resolve_sources

    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-9202", slots=[("BPC-157", "BPC157")]
    )
    rows = next(iter(vial_rows.values()))
    (pur,) = _rows_by_kw(rows, KW_PURITY)
    (qty,) = _rows_by_kw(rows, KW_QUANTITY)
    (ident,) = _rows_by_kw(rows, KW_IDENTITY)
    _submit_verify_promote(db, pur, "99.0")
    _submit_verify_promote(db, qty, "5.1", unit="mg")
    _submit_verify_promote(db, ident, "Pass", unit=None)
    db.commit()

    result = _run(resolve_sources(parent.sample_id, db, ShadowAnalysesReader(db)))
    keys = [d.analyte_keyword for d in result.decisions]

    assert set(keys) == {"HPLC-PUR", "PEPT-Total", "ANALYTE-1-ID"}
    assert len(keys) == len(set(keys))  # no spurious duplicate entries
    assert "HPLC-PURITY" not in keys


def test_resolve_sources_senaite_born_parent_unaffected(db):
    """SENAITE-origin parent-tier row (not native HPLC): the shadow_reader
    filter must be a no-op — decisions stay keyed by the bare stored
    keyword, identical to pre-M7 behavior."""
    from models import AnalysisService, LimsSample, LimsAnalysis
    from coa.shadow_reader import ShadowAnalysesReader
    from coa.source_resolver import resolve_sources

    svc = AnalysisService(title="Endotoxin (LAL)", keyword="ENDO-LAL", origin="senaite")
    db.add(svc); db.flush()
    parent = LimsSample(sample_id="BW-9203", external_lims_system="senaite",
                        external_lims_uid="uid-BW-9203", sample_type_title="Bacteriostatic Water")
    db.add(parent); db.flush()
    row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword="ENDO-LAL",
        title="Endotoxin (LAL)", result_value="0.05", result_unit="EU/mL",
        review_state="verified", reportable=True, provenance="canonical",
    )
    db.add(row); db.flush(); db.commit()

    result = _run(resolve_sources(parent.sample_id, db, ShadowAnalysesReader(db)))

    assert len(result.decisions) == 1
    d = result.decisions[0]
    assert d.analyte_keyword == "ENDO-LAL"
    assert d.chosen.value == "0.05"
    assert d.blocked is None


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-q"]))
