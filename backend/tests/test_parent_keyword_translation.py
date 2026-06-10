"""resolve_parent_analyte_target maps a vial per-substance keyword to the parent's
ANALYTE-{slot} keyword. Live catalog (PUR_/QTY_/ID_/ANALYTE services exist);
the SENAITE slot read is monkeypatched."""
from database import SessionLocal
from lims_analyses.service import resolve_parent_analyte_target


def _db():
    return SessionLocal()


def test_per_substance_translates_to_analyte_slot(monkeypatch):
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: {1: "GHK-Cu - Identity (HPLC)",
                     2: "BPC-157 - Identity (HPLC)",
                     3: "TB500 (Thymosin Beta 4) - Identity (HPLC)"},
    )
    db = _db()
    try:
        kw, svc_id, title = resolve_parent_analyte_target(
            db, vial_keyword="PUR_TB500BETA4", parent_sample_id="PB-0076")
        assert kw == "ANALYTE-3-PUR"
        assert title == "Analyte 3 (Purity)"
        assert svc_id is not None
        kw2, _, _ = resolve_parent_analyte_target(
            db, vial_keyword="QTY_GHKCU", parent_sample_id="PB-0076")
        assert kw2 == "ANALYTE-1-QTY"
    finally:
        db.close()


def test_native_keywords_pass_through(monkeypatch):
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: (_ for _ in ()).throw(AssertionError("slot read must not happen")),
    )
    db = _db()
    try:
        for kw in ("ID_BPC157", "BLEND-PUR", "PEPT-Total", "HPLC-ID"):
            out_kw, svc_id, title = resolve_parent_analyte_target(
                db, vial_keyword=kw, parent_sample_id="PB-0076")
            assert out_kw == kw and svc_id is None and title is None
    finally:
        db.close()


def test_unresolvable_slot_falls_through(monkeypatch):
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: {})
    db = _db()
    try:
        kw, svc_id, title = resolve_parent_analyte_target(
            db, vial_keyword="PUR_GHKCU", parent_sample_id="PB-0076")
        assert kw == "PUR_GHKCU" and svc_id is None and title is None
    finally:
        db.close()
