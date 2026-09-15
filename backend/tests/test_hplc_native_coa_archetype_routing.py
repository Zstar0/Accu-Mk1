"""Slice 8 Task 2: native HPLC rows route by the owning profile's COA
archetype — legacy_hplc rides page 1 via coa/hplc_shim.py,
limit_table builds a native_sections page-2 section, NULL reports nowhere.

Two layers:
  * Unit-level (SimpleNamespace rows + a monkeypatched resolver) for
    coa/legacy_rows.py's admission gate — same style as
    tests/test_legacy_rows_contract.py, so these never touch the network/DB
    the resolver would otherwise hit and stay independent of that file
    (which this task does not own/edit).
  * Real-DB (tests.hplc_native_family.native_family) for
    coa/native_sections.py's page-2 routing, where real catalog specs
    (seeded by catalog/hplc_native_seed.py) matter.

Spec: docs/superpowers/plans/2026-09-15-hplc-native-slice8-legacy-
archetype-identity-select.md, Task 2.
"""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import coa.legacy_rows as lr
from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE, SlotWire
from coa.legacy_rows import build_legacy_rows
from coa.native_sections import NativeSectionsError, build_native_sections
from database import Base

# ─────────────────────── legacy_rows gate (unit, no DB) ────────────────────


def _shaped(**over):
    base = dict(
        uid="mk1:1", keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)",
        result="Conforms", unit=None, review_state="published",
        captured="2026-09-15T00:00:00+00:00", service_origin="mk1",
        peptide_id=101, slot=1, analysis_service_id=901,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _senaite_row(**over):
    base = dict(
        uid="mk1:9", keyword="ENDO-LAL", title="Endotoxin", result="0.1",
        unit="EU/mL", review_state="published",
        captured="2026-09-15T00:00:00+00:00", service_origin="senaite",
        peptide_id=None, slot=None, analysis_service_id=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


_PARENT = SimpleNamespace(sample_id="P-8001", external_lims_system="mk1")


def _wires(*names):
    return [SlotWire(i, n, 100 + i, None) for i, n in enumerate(names, start=1)]


def test_legacy_hplc_archetype_admits_trio_rows(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped()])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {901: LEGACY_HPLC_ARCHETYPE})
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["ANALYTE-1-ID"]


def test_limit_table_archetype_excludes_trio_rows(monkeypatch):
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {901: "limit_table"})
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped(), _senaite_row()])
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["ENDO-LAL"]


def test_null_archetype_excludes_trio_rows(monkeypatch):
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {901: None})
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped(), _senaite_row()])
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["ENDO-LAL"]


def test_unresolvable_lookup_admits_unchanged(monkeypatch):
    """native_hplc_service_archetypes returning None ("can't tell") must not
    change today's behaviour — this is the fallback that keeps
    test_legacy_rows_contract.py's real-resolver tests (db=None, no catalog
    wired) passing unchanged after this slice."""
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped()])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    monkeypatch.setattr(lr, "native_hplc_service_archetypes", lambda db, parent: None)
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["ANALYTE-1-ID"]


def test_blend_limit_table_excludes_both_slots_without_false_abort(monkeypatch):
    """Regression: computing slot_wires() unconditionally (2 registry slots)
    while both slots' rows are excluded by the archetype gate used to raise
    a bogus 'registry slot has no analysis rows' abort. A limit_table blend
    must just drop the native rows, not explode."""
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157", "TB-500"))
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {901: "limit_table", 902: "limit_table"})
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-IDENTITY", slot=1, analysis_service_id=901),
        _shaped(uid="mk1:2", keyword="HPLC-IDENTITY", slot=2, analysis_service_id=902),
        _senaite_row(),
    ])
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["ENDO-LAL"]


def test_senaite_born_never_calls_resolver(monkeypatch):
    """No native row on the sample at all -> the resolver never runs (perf
    guard; also proves a pure-SENAITE parent stays byte-identical)."""
    def _boom(db, parent):
        raise AssertionError("resolver must not run when no native row is present")
    monkeypatch.setattr(lr, "native_hplc_service_archetypes", _boom)
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_senaite_row()])
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["ENDO-LAL"]


# ──────────────── native_sections page-2 routing (real DB/catalog) ─────────


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _profile(db):
    from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY
    from models import AnalysisProfile
    return db.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()


def _order_lookup(monkeypatch):
    from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {HPLC_NATIVE_PROFILE_KEY: True}, "package": None},
    )


def _promote(db, row, value, unit):
    from lims_analyses.service import apply_transition, promote_to_parent
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value, user_id=1, commit=False)
    parent_row, _ = promote_to_parent(
        db, keyword=row.keyword, result_value=value, result_unit=unit,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}],
        user_id=1, commit=False)
    apply_transition(db, analysis_id=parent_row.id, kind="verify", user_id=1, commit=False)
    return parent_row


def _row(rows, keyword, slot):
    return next(r for r in rows if r.keyword == keyword and r.slot == slot)


def test_legacy_hplc_profile_excluded_from_native_sections(db, monkeypatch):
    """(a) legacy_hplc — seed default (T1) — is treated like NULL by
    native_sections: no page-2 section, not listed in ordered_profiles."""
    from lims_analyses.hplc_native import KW_IDENTITY
    from tests.hplc_native_family import native_family
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-8101", slots=[("BPC-157", "BPC157")])
    assert _profile(db).coa_archetype == LEGACY_HPLC_ARCHETYPE  # T1's seed default
    _order_lookup(monkeypatch)
    doc = build_native_sections(db, parent)
    assert doc["sections"] == []
    assert doc["ordered_profiles"] == []


def test_null_archetype_excluded_from_native_sections(db, monkeypatch):
    """(c) NULL — explicit admin state, same treatment as legacy_hplc."""
    from tests.hplc_native_family import native_family
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-8102", slots=[("BPC-157", "BPC157")])
    prof = _profile(db)
    prof.coa_archetype = None
    db.flush()
    _order_lookup(monkeypatch)
    doc = build_native_sections(db, parent)
    assert doc["sections"] == []
    assert doc["ordered_profiles"] == []


def test_limit_table_profile_builds_page2_section(db, monkeypatch):
    """(b) limit_table — the generic native_sections builder renders the
    profile's five members (native_sections has no slot concept — one row
    per member SERVICE, so a blend just picks the most-recently-promoted
    slot's row; page 2 was never designed to print per-slot rows, a known
    ceiling of the archetype flip, not a bug this task fixes) as an
    ordinary page-2 section: identity rides the PCR-precedent
    `equals "Conforms"` string rule, purity a `range` floor, quantity/
    blend-total `informational`."""
    from lims_analyses.hplc_native import (
        KW_BLEND_PURITY, KW_BLEND_TOTAL, KW_IDENTITY, KW_PURITY, KW_QUANTITY,
    )
    from tests.hplc_native_family import native_family
    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-8103", slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    prof = _profile(db)
    prof.coa_archetype = "limit_table"
    db.flush()
    rows = next(iter(vial_rows.values()))
    _promote(db, _row(rows, KW_IDENTITY, 1), "Conforms", None)
    _promote(db, _row(rows, KW_IDENTITY, 2), "Conforms", None)  # last -> wins (highest id)
    _promote(db, _row(rows, KW_PURITY, 1), "97", "%")
    _promote(db, _row(rows, KW_PURITY, 2), "99", "%")  # last -> wins
    _promote(db, _row(rows, KW_QUANTITY, 1), "4", "mg")
    _promote(db, _row(rows, KW_QUANTITY, 2), "1", "mg")  # last -> wins
    _promote(db, _row(rows, KW_BLEND_PURITY, None), "99", "%")
    _promote(db, _row(rows, KW_BLEND_TOTAL, None), "5", "mg")

    _order_lookup(monkeypatch)
    doc = build_native_sections(db, parent)

    from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY
    assert doc["ordered_profiles"] == [HPLC_NATIVE_PROFILE_KEY]
    assert len(doc["sections"]) == 1
    section = doc["sections"][0]
    assert section["archetype"] == "limit_table"
    by_kw = {r["keyword"]: r for r in section["rows"]}
    assert by_kw["HPLC-IDENTITY"]["specification"]["rule_kind"] == "equals"
    assert by_kw["HPLC-IDENTITY"]["conforms"] is True
    assert by_kw["HPLC-PURITY"]["specification"]["rule_kind"] == "range"
    assert by_kw["HPLC-PURITY"]["result"] == "99"
    assert by_kw["HPLC-PURITY"]["conforms"] is True
    assert by_kw["HPLC-QUANTITY"]["specification"]["rule_kind"] == "informational"
    assert by_kw["HPLC-QUANTITY"]["conforms"] is None

    # And the trio must NOT also ride page 1 for this sample.
    monkeypatch.setattr(
        "sub_samples.service.fetch_sample_services",
        lambda sample_id: {"services": {HPLC_NATIVE_PROFILE_KEY: True}, "package": None},
    )
    with pytest.raises(NativeSectionsError):
        # Pure-native fixture has no SENAITE-family row once the trio is
        # excluded from page 1 — the documented "fails loudly" ceiling
        # (plan: NULL/limit_table removes it from page 1; COABuilder's own
        # empty-results validation is what would ultimately abort a mixed
        # real sample; here it's legacy_rows' own zero-row guard).
        build_legacy_rows(db, parent)


def test_identity_does_not_conform_on_limit_table_section(db, monkeypatch):
    """Same equals-rule code path as PCR's `equals "Not Detected"` — a
    failing identity value verdicts False, not an abort."""
    from lims_analyses.hplc_native import (
        KW_BLEND_PURITY, KW_BLEND_TOTAL, KW_IDENTITY, KW_PURITY, KW_QUANTITY,
    )
    from tests.hplc_native_family import native_family
    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-8104", slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    prof = _profile(db)
    prof.coa_archetype = "limit_table"
    db.flush()
    rows = next(iter(vial_rows.values()))
    _promote(db, _row(rows, KW_IDENTITY, 1), "Conforms", None)
    _promote(db, _row(rows, KW_IDENTITY, 2), "Does Not Conform", None)  # last -> wins
    _promote(db, _row(rows, KW_PURITY, 1), "99", "%")
    _promote(db, _row(rows, KW_PURITY, 2), "99", "%")
    _promote(db, _row(rows, KW_QUANTITY, 1), "5", "mg")
    _promote(db, _row(rows, KW_QUANTITY, 2), "5", "mg")
    _promote(db, _row(rows, KW_BLEND_PURITY, None), "99", "%")
    _promote(db, _row(rows, KW_BLEND_TOTAL, None), "5", "mg")

    _order_lookup(monkeypatch)
    doc = build_native_sections(db, parent)
    by_kw = {r["keyword"]: r for r in doc["sections"][0]["rows"]}
    assert by_kw["HPLC-IDENTITY"]["conforms"] is False
