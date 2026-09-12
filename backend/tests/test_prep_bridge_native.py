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
