"""Characterisation tests: a real COA wire document for a native-born single
peptide and a native-born blend, fed to the VENDORED COABuilder conformance
engine (backend/conformance_vendored/conformance.py, MIRROR-ONLY -- never
edited here). Proves the shim vocabulary (coa/hplc_shim.py) actually reaches
the engine's page-1 verdicts, not just that legacy_rows/sample_meta produce
*some* dict.

Entry point: conformance_vendored.ConformanceEngine().process(senaite_json)
(see backend/scripts/regen_conformance_goldens.py) -- NOT `.evaluate()`.
Input shape: sample_meta dict + `_Analyses_Detailed` = legacy_rows["rows"]
(see backend/tests/test_conformance_coabuilder_parity.py /
tests/fixtures/conformance/senaite_dump_PB-0010.json).

Spec: docs/superpowers/sdd/2026-09-12-hplc-native-slice5-coa-shim/, Task 6.
"""
import json
import os
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from coa.hplc_shim import UnresolvedNativeSlotError
from coa.wire_document import build_coa_wire_document
from conformance_vendored import ConformanceEngine
from lims_analyses.hplc_native import KW_IDENTITY, KW_PURITY, KW_QUANTITY
from lims_analyses.service import apply_transition, promote_to_parent
from tests.hplc_native_family import native_family

ENV = {"MK1_PUBLIC_BASE_URL": "https://mk1.test"}


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _add_sample_image(db, parent):
    from models import LimsParentAttachment
    img = LimsParentAttachment(
        lims_sample_pk=parent.id, kind="receive_image", filename="img.png",
        content_type="image/png", storage="s3", storage_key="k1",
        render_in_report=True, attachment_type="Sample Image",
        created_by_user_id=None)
    db.add(img); db.flush()
    return img


def _row(rows, keyword, slot):
    return next(r for r in rows if r.keyword == keyword and r.slot == slot)


def _promote(db, row, value, unit):
    """submit -> promote_to_parent -> verify, mirroring
    test_hplc_native_promote_slots.py's flow to a VERIFIED parent-tier row."""
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value, user_id=1, commit=False)
    parent_row, _ = promote_to_parent(
        db, keyword=row.keyword, result_value=value, result_unit=unit,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}],
        user_id=1, commit=False)
    apply_transition(db, analysis_id=parent_row.id, kind="verify", user_id=1, commit=False)
    return parent_row


def _patch_wire_document(monkeypatch):
    monkeypatch.setattr("coa.wire_document.coa_generation_source", lambda db: "mk1")
    monkeypatch.setattr(
        "coa.wire_document.build_native_sections",
        lambda db, parent: {"sample_id": parent.sample_id, "ordered_profiles": [], "sections": []},
    )


def _engine_input(doc):
    meta = dict(doc["sample_meta"])
    meta["_Analyses_Detailed"] = doc["legacy_rows"]["rows"]
    return meta


def test_native_single_page1_parity(db, monkeypatch):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-2001", slots=[("BPC-157", "BPC157")])
    rows = next(iter(vial_rows.values()))
    _promote(db, _row(rows, KW_IDENTITY, 1), "Conforms", None)
    _promote(db, _row(rows, KW_PURITY, 1), "98.5", "%")
    _promote(db, _row(rows, KW_QUANTITY, 1), "4.9", "mg")

    _patch_wire_document(monkeypatch)
    with patch.dict(os.environ, ENV):
        _add_sample_image(db, parent)
        doc = build_coa_wire_document(db, parent)
        out = ConformanceEngine().process(_engine_input(doc))

    kws = {r["Keyword"] for r in doc["legacy_rows"]["rows"]}
    assert kws == {"ANALYTE-1-ID", "HPLC-PUR", "PEPT-Total"}
    assert doc["sample_meta"]["Analyte1Peptide"] == "BPC-157 - Identity (HPLC)"
    ident_row = next(r for r in doc["legacy_rows"]["rows"] if r["Keyword"] == "ANALYTE-1-ID")
    assert doc["sample_meta"]["Analyte1Peptide"] == ident_row["Title"]

    table = out["results_table"]
    ident = next(r for r in table if r["test_type"] == "IDENTITY")
    assert ident["conforms"] is True
    assert ident["analyte_name"] == "BPC-157"

    pur = next(r for r in table if r["test_type"] == "PURITY")
    assert pur["conforms"] is True
    assert pur["result"] == "98.5%"

    qty = next(r for r in table if r["test_type"] == "QUANTITY")
    assert qty["conforms"] is None
    # Single-peptide quantity has no ANALYTE-1-QTY key (that's the blend
    # vocabulary) -- the engine's single-peptide fallback reads PEPT-Total
    # instead (conformance.py:290-300), so `measured.slots` stays empty and
    # the value only shows up on the results_table row itself.
    assert out["measured"]["slots"][1] == {"value": None, "unit": None}
    assert qty["result"] == "4.9 mg"


def test_native_blend_page1_parity(db, monkeypatch):
    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-2002", slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    _promote(db, _row(rows, KW_IDENTITY, 1), "Conforms", None)
    _promote(db, _row(rows, KW_IDENTITY, 2), "Conforms", None)
    _promote(db, _row(rows, KW_PURITY, 1), "98", "%")
    _promote(db, _row(rows, KW_PURITY, 2), "96", "%")
    _promote(db, _row(rows, KW_QUANTITY, 1), "4", "mg")
    _promote(db, _row(rows, KW_QUANTITY, 2), "1", "mg")
    from lims_analyses.hplc_native import KW_BLEND_PURITY, KW_BLEND_TOTAL
    # Submitted BLEND-PUR (50) is a value the mass-weighted recompute below
    # (97.6) cannot produce — proving the engine ignores the submitted
    # aggregate and recalculates, not merely that its output happens to
    # match a coincidentally-equal submitted value (F5).
    _promote(db, _row(rows, KW_BLEND_PURITY, None), "50", "%")
    _promote(db, _row(rows, KW_BLEND_TOTAL, None), "5", "mg")

    _patch_wire_document(monkeypatch)
    with patch.dict(os.environ, ENV):
        _add_sample_image(db, parent)
        doc = build_coa_wire_document(db, parent)
        out = ConformanceEngine().process(_engine_input(doc))

    kws = {r["Keyword"] for r in doc["legacy_rows"]["rows"]}
    assert kws == {
        "ANALYTE-1-ID", "ANALYTE-2-ID", "ANALYTE-1-PUR", "ANALYTE-2-PUR",
        "ANALYTE-1-QTY", "ANALYTE-2-QTY", "BLEND-PUR", "PEPT-Total",
    }
    assert doc["sample_meta"]["Analyte1Peptide"] == "BPC-157 - Identity (HPLC)"
    assert doc["sample_meta"]["Analyte2Peptide"] == "TB-500 - Identity (HPLC)"

    table = out["results_table"]
    idents = [r for r in table if r["test_type"] == "IDENTITY" and r.get("peptide_name")]
    assert len(idents) == 2
    assert all(r["conforms"] is True for r in idents)

    purities = [r for r in table if r["test_type"] == "PURITY" and r.get("peptide_name")]
    assert len(purities) == 2

    blend_purity = next(r for r in table if r["test_name"] == "Blend Purity")
    # Engine RECALCULATES from measured qty/purity (mass-weighted average),
    # ignoring the submitted BLEND-PUR value: (4*98 + 1*96) / 5 = 97.6.
    assert blend_purity["result"] == "97.60%"
    assert blend_purity["conforms"] is False  # 97.6 < the 98.0% spec floor

    blend_total = next(r for r in table if r["test_name"] == "Blend Total Quantity")
    assert blend_total["result"] == "5.0 mg"
    assert out["measured"]["blend_total"] == {"value": 5.0, "unit": "mg"}


def test_native_identity_fail_cascades(db, monkeypatch):
    parent, services, peps, vial_rows = native_family(
        db, sample_id="PB-2003", slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    _promote(db, _row(rows, KW_IDENTITY, 1), "Does Not Conform", None)
    _promote(db, _row(rows, KW_IDENTITY, 2), "Conforms", None)
    _promote(db, _row(rows, KW_PURITY, 1), "99", "%")
    _promote(db, _row(rows, KW_PURITY, 2), "96", "%")
    _promote(db, _row(rows, KW_QUANTITY, 1), "4", "mg")
    _promote(db, _row(rows, KW_QUANTITY, 2), "1", "mg")
    from lims_analyses.hplc_native import KW_BLEND_PURITY, KW_BLEND_TOTAL
    _promote(db, _row(rows, KW_BLEND_PURITY, None), "97.6", "%")
    _promote(db, _row(rows, KW_BLEND_TOTAL, None), "5", "mg")

    _patch_wire_document(monkeypatch)
    with patch.dict(os.environ, ENV):
        _add_sample_image(db, parent)
        doc = build_coa_wire_document(db, parent)
        out = ConformanceEngine().process(_engine_input(doc))

    table = out["results_table"]
    ident1 = next(r for r in table if r["test_type"] == "IDENTITY" and r.get("peptide_name") == "BPC-157")
    assert ident1["conforms"] is False
    assert ident1["status"] == "DOES NOT CONFORM"
    assert ident1["result"] == "Out of Spec"

    # conformance.py:289-364 -- Quantity/Purity are unconditional per slot;
    # a failed identity does NOT suppress or blank out its slot's own rows.
    pur1 = next(r for r in table if r["test_type"] == "PURITY" and r.get("peptide_name") == "BPC-157")
    assert pur1["conforms"] is True
    assert pur1["result"] == "99.0%"
    qty1 = next(r for r in table if r["test_type"] == "QUANTITY" and r.get("peptide_name") == "BPC-157")
    assert qty1["conforms"] is None

    blend_ident = next(r for r in table if r["test_name"] == "Peptide ID (HPLC)")
    assert blend_ident["status"] == "DOES NOT CONFORM"
    assert out["canonical"]["overall_pass"] is False
    assert out["canonical"]["nonconformance_reasons"] == ["Blend Identity Condition not met"]


def test_native_unresolved_slot_blocks_generation(db, monkeypatch):
    from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY
    from lims_analyses.hplc_native import seed_native_hplc_rows
    from lims_analyses.parent_placeholders import seed_parent_placeholders
    from models import LimsSample, LimsSubSample
    from tests.hplc_native_family import native_catalog

    native_catalog(db)
    parent = LimsSample(
        sample_id="PB-2099", external_lims_system="mk1", sample_type_title="Peptide",
        analytes=json.dumps([{"name": "Mystery-Peptide", "declared_quantity": None, "peptide_id": None}]))
    db.add(parent); db.flush()
    seed_parent_placeholders(db, parent=parent, services={HPLC_NATIVE_PROFILE_KEY: True})
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="PB-2099-S01",
                         external_lims_uid="uid-PB-2099-S01", vial_sequence=1)
    db.add(vial); db.flush()
    rows = seed_native_hplc_rows(
        db, sub_sample=vial, parent=parent, existing_keys=set(),
        existing_service_ids=set(), created_by_user_id=None, commit=False)
    ident_row = _row(rows, KW_IDENTITY, 1)
    assert ident_row.peptide_id is None  # unresolved: no catalog peptide matched "Mystery-Peptide"
    _promote(db, ident_row, "Does Not Conform", None)

    _patch_wire_document(monkeypatch)
    with pytest.raises(UnresolvedNativeSlotError):
        build_coa_wire_document(db, parent)
