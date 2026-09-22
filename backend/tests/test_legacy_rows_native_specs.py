"""Native HPLC rows on the page-1 wire carry `specification` + `conforms`,
resolved and judged by the same analysis_service_specs machinery every other
native service uses (coa/spec_rules + native_sections._spec_wire_dict).
Real catalog + real seeded specs; only row selection is stubbed."""
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import coa.legacy_rows as lr
from coa.hplc_shim import SlotWire
from coa.legacy_rows import OPTIONAL_FIELDS, build_legacy_rows
from coa.native_sections import NativeSectionsError
from database import Base
from models import AnalysisServiceSpec, Peptide
from tests.hplc_native_family import native_catalog


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _row(svc, *, uid, result, slot=1, peptide_id=None, origin="mk1", keyword=None):
    return SimpleNamespace(
        uid=uid, keyword=keyword or svc.keyword, title="x", result=result,
        unit=svc.unit, review_state="verified", captured=None,
        service_origin=origin, peptide_id=peptide_id, slot=slot,
        analysis_service_id=svc.id,
    )


def _parent(sample_id="P-5001", matrix="Peptide"):
    # No pk on purpose: native_hplc_service_archetypes returns None for it,
    # which admits the rows unchanged (the documented "can't tell" case).
    return SimpleNamespace(sample_id=sample_id, external_lims_system="mk1",
                           sample_type_title=matrix)


def _peptide(db, name, abbr):
    p = Peptide(name=name, abbreviation=abbr, active=True)
    db.add(p)
    db.flush()
    return p


def _stub(monkeypatch, rows, wires):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: rows)
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: wires)


def test_optional_fields_pinned():
    assert OPTIONAL_FIELDS == ("specification", "conforms")


def test_seeded_specs_ride_every_native_row(db, monkeypatch):
    svcs = native_catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _stub(monkeypatch, [
        _row(svcs["HPLC-IDENTITY"], uid="mk1:1", result="Conforms", peptide_id=pep.id),
        _row(svcs["HPLC-PURITY"], uid="mk1:2", result="98.5", peptide_id=pep.id),
        _row(svcs["HPLC-QUANTITY"], uid="mk1:3", result="4.9", peptide_id=pep.id),
    ], [SlotWire(1, "BPC-157", pep.id, None)])

    ident, pur, qty = build_legacy_rows(db, _parent())

    assert (ident["specification"]["rule_kind"], ident["specification"]["equals"],
            ident["conforms"]) == ("equals", "Conforms", True)
    assert (pur["specification"]["rule_kind"], pur["specification"]["min"],
            pur["specification"]["max"], pur["conforms"]) == ("range", 98.0, None, True)
    assert (qty["specification"]["rule_kind"], qty["conforms"]) == ("informational", None)


def test_blend_resolves_the_peptide_tier_per_slot(db, monkeypatch):
    svcs = native_catalog(db)
    a, b = _peptide(db, "BPC-157", "BPC157"), _peptide(db, "TB-500", "TB500")
    pur = svcs["HPLC-PURITY"]
    db.add(AnalysisServiceSpec(analysis_service_id=pur.id, peptide_id=a.id,
                               rule_kind="range", min_value=Decimal("95"), unit="%"))
    db.flush()
    _stub(monkeypatch, [
        _row(pur, uid="mk1:1", result="96", slot=1, peptide_id=a.id),
        _row(pur, uid="mk1:2", result="96", slot=2, peptide_id=b.id),
    ], [SlotWire(1, "BPC-157", a.id, None), SlotWire(2, "TB-500", b.id, None)])

    one, two = build_legacy_rows(db, _parent("PB-1001", "Peptide Blend"))

    # Same 96%: passes slot 1's own 95 limit, fails slot 2's default 98.
    assert (one["Keyword"], one["specification"]["min"], one["conforms"]) == (
        "ANALYTE-1-PUR", 95.0, True)
    assert (two["Keyword"], two["specification"]["min"], two["conforms"]) == (
        "ANALYTE-2-PUR", 98.0, False)


def test_pending_row_ships_its_spec_without_a_verdict(db, monkeypatch):
    svcs = native_catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _stub(monkeypatch, [_row(svcs["HPLC-PURITY"], uid="mk1:2", result=None, peptide_id=pep.id)],
          [SlotWire(1, "BPC-157", pep.id, None)])

    (pur,) = build_legacy_rows(db, _parent())

    assert pur["specification"]["min"] == 98.0 and pur["conforms"] is None


def test_no_active_spec_ships_no_fields(db, monkeypatch):
    svcs = native_catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    pur = svcs["HPLC-PURITY"]
    for s in db.query(AnalysisServiceSpec).filter_by(analysis_service_id=pur.id):
        s.active = False
    db.flush()
    _stub(monkeypatch, [_row(pur, uid="mk1:2", result="99", peptide_id=pep.id)],
          [SlotWire(1, "BPC-157", pep.id, None)])

    (row,) = build_legacy_rows(db, _parent())

    assert not set(OPTIONAL_FIELDS) & set(row)


def test_senaite_origin_rows_never_carry_the_fields(db, monkeypatch):
    svcs = native_catalog(db)
    _stub(monkeypatch, [_row(svcs["HPLC-PURITY"], uid="abc", result="99", slot=None,
                             origin="senaite", keyword="HPLC-PUR")], [])

    (row,) = build_legacy_rows(db, SimpleNamespace(sample_id="P-0161",
                                                   sample_type_title="Peptide"))

    assert not set(OPTIONAL_FIELDS) & set(row)


def test_unjudgeable_result_aborts_instead_of_guessing(db, monkeypatch):
    svcs = native_catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _stub(monkeypatch, [_row(svcs["HPLC-PURITY"], uid="mk1:2", result="ND", peptide_id=pep.id)],
          [SlotWire(1, "BPC-157", pep.id, None)])

    with pytest.raises(NativeSectionsError, match="not numeric"):
        build_legacy_rows(db, _parent())
