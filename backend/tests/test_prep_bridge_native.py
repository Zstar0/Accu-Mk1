"""Prep bridge on NATIVE-BORN vials (spec 2026-09-10 M5).

Native vials carry the generic trio per slot with LimsAnalysis.peptide_id +
slot stamped by the native seeder; routing is by peptide_id, never by keyword
prefix. Fixtures mirror tests/test_prep_bridge.py (in-memory SQLite via the
conftest db_session) plus the native catalog from test_hplc_native_seeder.py.
"""
from typing import Optional

from models import AnalysisService, Department, HPLCAnalysis, LimsSample, LimsSubSample, Peptide
from lims_analyses.service import create_analysis
from lims_analyses.hplc_native import (
    KW_IDENTITY, KW_PURITY, KW_QUANTITY, KW_BLEND_PURITY, KW_BLEND_TOTAL,
    identity_title, purity_title, quantity_title,
)
from lims_analyses.prep_bridge import (
    _category, bridge_prep_result_to_vial, bridge_blend_aggregates, stamp_prep_assignment,
    rebridge_prep,
)


def _catalog(db) -> dict[str, AnalysisService]:
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES
    dept = Department(name="Analytical")
    db.add(dept)
    db.flush()
    out = {}
    for kw, title, unit, rtype, vc in HPLC_NATIVE_SERVICES:
        svc = AnalysisService(title=title, keyword=kw, unit=unit, result_type=rtype,
                              origin="mk1", variance_capable=vc, department_id=dept.id)
        db.add(svc)
        db.flush()
        out[kw] = svc
    return out


def _peptide(db, name, abbr):
    p = Peptide(name=name, abbreviation=abbr, active=True)
    db.add(p)
    db.flush()
    return p


def _native_vial(db, sample_id="P-5001", sample_type="Peptide"):
    # Deviation from the brief's sketch: LimsSubSample.external_lims_uid is
    # NOT NULL on the real schema (db_session uses the real models, unlike
    # test_hplc_native_seeder.py's from-scratch in-memory engine) so the vial
    # needs a synthetic uid, mirroring test_hplc_native_seeder.py's `_vial`.
    parent = LimsSample(sample_id=sample_id, external_lims_system="mk1",
                        external_lims_uid=None, sample_type_title=sample_type, analytes="[]")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"zz-{sample_id}-1",
                         sample_id=f"{sample_id}-S01", vial_sequence=1)
    db.add(vial)
    db.flush()
    return parent, vial


def _trio(db, vial, services, *, slot: int, peptide: Optional[Peptide], name: str):
    """Seed one slot's identity/purity/quantity rows the way seed_native_hplc_rows does."""
    pid = peptide.id if peptide else None
    idr = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=services[KW_IDENTITY].id, keyword=KW_IDENTITY,
                          title=identity_title(name) if peptide else name, peptide_id=pid, slot=slot,
                          reportable_reason=None if peptide else f"analyte_unresolved: {name}")
    pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=services[KW_PURITY].id, keyword=KW_PURITY,
                          title=purity_title(name), peptide_id=pid, slot=slot)
    qty = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=services[KW_QUANTITY].id, keyword=KW_QUANTITY,
                          title=quantity_title(name), peptide_id=pid, slot=slot)
    return idr, pur, qty


def _aggregates(db, vial, services):
    bp = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                         analysis_service_id=services[KW_BLEND_PURITY].id, keyword=KW_BLEND_PURITY,
                         title=services[KW_BLEND_PURITY].title)
    bt = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                         analysis_service_id=services[KW_BLEND_TOTAL].id, keyword=KW_BLEND_TOTAL,
                         title=services[KW_BLEND_TOTAL].title)
    return bp, bt


def _hplc(db, pep, *, purity=None, conforms=None, qty=None, instrument_id=None,
          processed_by=None):
    """Copied verbatim from tests/test_prep_bridge.py::_hplc (deviation: the
    brief's sketch omitted the NOT NULL stock/dilution columns HPLCAnalysis
    actually requires)."""
    a = HPLCAnalysis(
        sample_id_label="P-5001-S01",
        peptide_id=pep.id,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        purity_percent=purity, identity_conforms=conforms, quantity_mg=qty,
        instrument_id=instrument_id, processed_by_user_id=processed_by,
    )
    db.add(a)
    db.flush()
    return a


def test_category_learns_the_native_trio():
    assert _category(KW_PURITY) == "purity"
    assert _category(KW_QUANTITY) == "quantity"
    assert _category(KW_IDENTITY) == "identity"
    assert _category(KW_BLEND_PURITY) is None
    assert _category(KW_BLEND_TOTAL) is None
    # legacy arms unchanged
    assert _category("HPLC-PUR") == "purity" and _category("ID_BPC157") == "identity"
    assert _category("PEPT-TOTAL") is None


def test_stamp_prep_assignment_reaches_native_trio_rows(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    changed = stamp_prep_assignment(db, lims_sub_sample_pk=vial.id, instrument_id=7, method_id=3, user_id=1)
    assert set(changed) == {idr.id, pur.id, qty.id}
    db.refresh(pur)
    assert pur.instrument_id == 7 and pur.method_id == 3


def test_native_single_routes_trio_by_peptide_id(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2, instrument_id=9)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert set(ids) == {idr.id, pur.id, qty.id}
    for r in (idr, pur, qty):
        db.refresh(r)
    assert pur.result_value == "98.5" and pur.review_state == "to_be_verified"
    assert qty.result_value == "4.2"
    assert idr.result_value == "Conforms"          # literal token, NOT the peptide name (ruling 2026-09-10)
    assert pur.instrument_id == 9


def test_native_identity_fail_writes_does_not_conform(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, _, _ = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, conforms=False)
    bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    db.refresh(idr)
    assert idr.result_value == "Does Not Conform"


def test_native_identity_unknown_is_skipped(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, _ = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=97.0, conforms=None)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert ids == [pur.id]
    db.refresh(idr)
    assert idr.review_state == "unassigned" and idr.result_value is None


def test_native_blend_routes_only_the_matching_slot(db_session):
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1001", sample_type="Peptide Blend")
    id1, pur1, qty1 = _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    id2, pur2, qty2 = _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    _aggregates(db, vial, services)
    a = _hplc(db, tb, purity=96.1, conforms=True, qty=2.0)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=tb, user_id=1)
    assert set(ids) == {id2.id, pur2.id, qty2.id}
    db.refresh(pur1); db.refresh(id1)
    assert pur1.review_state == "unassigned" and id1.review_state == "unassigned"


def test_native_unresolved_slot_never_matches(db_session):
    """peptide_id NULL (analyte_unresolved) rows are never a bridge target — even
    when they are the only rows in the category (spec addendum: never guess)."""
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=None, name="Mystery Peptide")
    a = _hplc(db, pep, purity=99.0, conforms=True, qty=1.0)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert ids == []
    db.refresh(pur)
    assert pur.review_state == "unassigned"


def test_native_duplicate_slot_rows_are_ambiguous(db_session):
    """Two pending HPLC-PURITY rows for the same peptide (should be impossible
    under the widened unique index, but sqlite has no index here) → skip, never guess."""
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    _trio(db, vial, services, slot=2, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=99.0, conforms=True, qty=1.0)
    assert bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1) == []


def test_native_vial_never_falls_through_to_legacy_generic(db_session):
    """A stray legacy HPLC-PUR row on a native vial must not be written by a
    peptide whose native row is absent — native vials use the native tier only."""
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    other = _peptide(db, "GHK-Cu", "GHKCU")
    _, vial = _native_vial(db)
    _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    stray = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                            analysis_service_id=999, keyword="HPLC-PUR", title="Purity (HPLC)")
    a = _hplc(db, other, purity=90.0, conforms=True, qty=1.0)
    assert bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=other, user_id=1) == []
    db.refresh(stray)
    assert stray.review_state == "unassigned"


def test_native_rerun_does_not_touch_already_bridged_rows(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2)
    first = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert len(first) == 3
    b = _hplc(db, pep, purity=50.0, conforms=False, qty=9.9)
    assert bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=b, peptide=pep, user_id=1) == []
    db.refresh(pur)
    assert pur.result_value == "98.5"


def _fill(db, row, value):
    row.result_value = value
    row.review_state = "to_be_verified"
    db.flush()


def test_native_blend_aggregates_wait_for_every_slot(db_session):
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1002", sample_type="Peptide Blend")
    _, pur1, qty1 = _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    _, pur2, qty2 = _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    bp, bt = _aggregates(db, vial, services)
    _fill(db, pur1, "98"); _fill(db, qty1, "4")
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []   # slot 2 pending
    _fill(db, pur2, "96"); _fill(db, qty2, "1")
    written = bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1)
    assert set(written) == {bp.id, bt.id}
    db.refresh(bp); db.refresh(bt)
    assert bt.result_value == "5"                       # 4 + 1
    assert bp.result_value == "97.6"                    # (4*98 + 1*96) / 5
    assert bp.review_state == "to_be_verified"


def test_native_blend_aggregates_idempotent(db_session):
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1003", sample_type="Peptide Blend")
    _, pur1, qty1 = _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    _, pur2, qty2 = _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    _aggregates(db, vial, services)
    for r, v in ((pur1, "98"), (qty1, "4"), (pur2, "96"), (qty2, "1")):
        _fill(db, r, v)
    assert len(bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1)) == 2
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []


def test_native_single_vial_has_no_aggregates(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    _, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    _fill(db, pur, "98"); _fill(db, qty, "4")
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []


def test_native_blend_end_to_end_via_process_hplc_order(db_session):
    """Two Process-HPLC runs (one per slot) then aggregates — the main.py
    /hplc/analyze call order: bridge_prep_result_to_vial, then bridge_blend_aggregates."""
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1004", sample_type="Peptide Blend")
    _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    bp, bt = _aggregates(db, vial, services)
    a1 = _hplc(db, bpc, purity=98.0, conforms=True, qty=4.0)
    bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a1, peptide=bpc, user_id=1)
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []
    a2 = _hplc(db, tb, purity=96.0, conforms=True, qty=1.0)
    bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a2, peptide=tb, user_id=1)
    assert set(bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1)) == {bp.id, bt.id}


# ── rebridge_prep (flyout Auto-fill re-run) on a native vial ────────────────


def test_rebridge_prep_on_native_vial(db_session):
    """Flyout Auto-fill: rebridge_prep loads the prep via mk1_db.get_sample_prep
    and the linked HPLCAnalysis (via sample_prep_id, same as the legacy path in
    tests/test_prep_bridge.py::_hplc_for_prep) then derives peptide from
    HPLCAnalysis.peptide_id — no native-specific branch needed."""
    from unittest.mock import patch

    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2)
    a.sample_prep_id = 77
    db.flush()

    with patch("mk1_db.get_sample_prep",
               return_value={"id": 77, "lims_sub_sample_pk": vial.id}):
        ids = rebridge_prep(db, prep_id=77, user_id=1)

    assert set(ids) == {idr.id, pur.id, qty.id}


# ── I-1 (final review 2026-09-12): native detection requires a native-born
# parent, not just a live native keyword on the vial ───────────────────────


def test_stray_native_keyword_on_senaite_vial_still_bridges_legacy(db_session):
    """A SENAITE-born vial (parent.external_lims_system absent/'senaite',
    uid set) carrying legacy PUR_/QTY_/ID_ rows plus ONE stray HPLC-PURITY
    row (peptide_id None -- the shape lims_analyses/service.py::
    add_analysis_to_vial can create today) must still bridge the legacy rows
    exactly like tests/test_prep_bridge.py::test_routes_to_per_substance_by_peptide,
    and the stray row must stay untouched. Before the fix, the live native
    keyword alone flipped `native` True and stopped all legacy bridging."""
    db = db_session
    pep = _peptide(db, "BPC-157", "BPC157")
    parent = LimsSample(sample_id="P-9001", external_lims_uid="UID-P-9001")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="UID-P-9001-S01",
                         sample_id="P-9001-S01", vial_sequence=0)
    db.add(vial)
    db.flush()

    db.add_all([
        AnalysisService(keyword="PUR_BPC157", peptide_id=pep.id, title="BPC-157 - Purity"),
        AnalysisService(keyword="QTY_BPC157", peptide_id=pep.id, title="BPC-157 - Quantity"),
    ])
    db.flush()

    pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=200, keyword="PUR_BPC157", title="BPC-157 - Purity")
    qty = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=201, keyword="QTY_BPC157", title="BPC-157 - Quantity")
    idr = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=30, keyword="ID_BPC157", title="BPC-157 - Identity (HPLC)")
    stray = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                            analysis_service_id=999, keyword=KW_PURITY, title="Purity (HPLC)")

    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert set(ids) == {pur.id, qty.id, idr.id}
    db.refresh(pur); db.refresh(qty); db.refresh(idr); db.refresh(stray)
    assert pur.result_value == "98.5" and pur.review_state == "to_be_verified"
    assert qty.result_value == "4.2"
    assert idr.result_value == "BPC-157"   # legacy identity value, not native's "Conforms"
    assert stray.review_state == "unassigned" and stray.result_value is None


# ── M-5: intra-slot partial-fill (purity done, quantity still pending) ─────


def test_native_blend_aggregates_wait_for_intra_slot_quantity(db_session):
    """Whole-slot incompleteness is covered by
    test_native_blend_aggregates_wait_for_every_slot; this covers the finer
    grain -- slot 1 fully filled (purity AND quantity), slot 2 purity filled
    but its quantity still pending -- aggregates must still withhold."""
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1005", sample_type="Peptide Blend")
    _, pur1, qty1 = _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    _, pur2, qty2 = _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    bp, bt = _aggregates(db, vial, services)
    _fill(db, pur1, "98"); _fill(db, qty1, "4")
    _fill(db, pur2, "96")   # slot 2 purity done, quantity still pending
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []
    _fill(db, qty2, "1")
    written = bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1)
    assert set(written) == {bp.id, bt.id}
    db.refresh(bp); db.refresh(bt)
    assert bt.result_value == "5"
    assert bp.result_value == "97.6"
