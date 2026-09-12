import json, pytest
from types import SimpleNamespace
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from coa.hplc_shim import (SlotWire, UnresolvedNativeSlotError, slot_wires, is_native_hplc_row,
                           wire_keyword, wire_title)
from coa.native_sections import NativeSectionsError
from lims_analyses.hplc_native import (KW_IDENTITY, KW_PURITY, KW_QUANTITY, KW_BLEND_PURITY, KW_BLEND_TOTAL,
                                       identity_title, purity_title, quantity_title)
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:"); Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try: yield s
    finally: s.close()


@pytest.mark.parametrize("kw,slot,n,expected", [
    (KW_IDENTITY, 1, 1, "ANALYTE-1-ID"),
    (KW_IDENTITY, 2, 3, "ANALYTE-2-ID"),
    (KW_PURITY, 1, 1, "HPLC-PUR"),
    (KW_PURITY, 1, 2, "ANALYTE-1-PUR"),
    (KW_QUANTITY, 1, 1, "PEPT-Total"),
    (KW_QUANTITY, 3, 3, "ANALYTE-3-QTY"),
    (KW_BLEND_PURITY, None, 2, "BLEND-PUR"),
    (KW_BLEND_TOTAL, None, 2, "PEPT-Total"),
])
def test_wire_keyword_table(kw, slot, n, expected):
    assert wire_keyword(kw, slot, n) == expected


def test_wire_keyword_rejects_non_native():
    with pytest.raises(ValueError):
        wire_keyword("HPLC-PUR", 1, 1)


def test_is_native_hplc_row_predicate():
    assert is_native_hplc_row(SimpleNamespace(keyword=KW_PURITY, service_origin="mk1"))
    assert is_native_hplc_row(SimpleNamespace(keyword="hplc-identity", service_origin="mk1"))
    assert not is_native_hplc_row(SimpleNamespace(keyword="STERILITY-USP71", service_origin="mk1"))
    assert not is_native_hplc_row(SimpleNamespace(keyword="HPLC-PUR", service_origin="senaite"))
    assert not is_native_hplc_row(SimpleNamespace(keyword=KW_PURITY, service_origin="senaite"))


def test_slot_wires_from_native_family(db):
    parent, services, peps, _ = native_family(db, sample_id="PB-1501",
                                              slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    wires = slot_wires(db, parent)
    assert [(w.slot, w.display_name, w.peptide_id, w.reason) for w in wires] == [
        (1, "BPC-157", peps[1].id, None), (2, "TB-500", peps[2].id, None)]
    assert wires[0].identity_title == identity_title("BPC-157")


def test_slot_wires_empty_for_senaite_born(db):
    from models import LimsSample
    p = LimsSample(sample_id="P-0001", external_lims_uid="uid-1", external_lims_system="senaite",
                   sample_type_title="Peptide", analytes=json.dumps([{"name": "BPC-157 - Identity (HPLC)"}]))
    db.add(p); db.flush()
    assert slot_wires(db, p) == []


def test_wire_title_per_category():
    w = SlotWire(slot=1, display_name="BPC-157", peptide_id=5, reason=None)
    assert wire_title(KW_IDENTITY, "ignored", w) == identity_title("BPC-157")
    assert wire_title(KW_PURITY, "ignored", w) == purity_title("BPC-157")
    assert wire_title(KW_QUANTITY, "ignored", w) == quantity_title("BPC-157")
    assert wire_title(KW_BLEND_PURITY, "HPLC Blend Purity (mass-weighted)", None) == "HPLC Blend Purity (mass-weighted)"


def test_unresolved_error_is_a_native_sections_error():
    e = UnresolvedNativeSlotError(sample_id="P-5001", slot=2, raw_name="Mystery")
    assert isinstance(e, NativeSectionsError)
    assert "P-5001" in e.detail and "slot 2" in e.detail and "Mystery" in e.detail
