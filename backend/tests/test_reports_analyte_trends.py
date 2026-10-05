"""build_coa_records: one product-level record per COA from per-analyte rows."""
from datetime import datetime, timezone

from reports_analyte_trends import addon_verdicts, build_coa_records, parse_mass_mg

AT = datetime(2026, 9, 1, 23, 30, tzinfo=timezone.utc)


def row(code, analyte, *, product=None, is_blend=False, overall_row=False,
        purity=None, purity_ok=None, identity=None, qty=None, unit="mg/mL",
        status="PASSED", declared=None, addons=None, native=None, generic=False,
        spec=None):
    return (code, "P-" + code, AT, product or analyte, is_blend, "Peptide", "LOT1",
            analyte, overall_row, purity, purity_ok, spec, identity,
            qty, unit, status, declared, addons, native, generic)


def test_single_peptide_fails_on_endotoxin_not_purity():
    [rec] = build_coa_records([row(
        "A", "5-Amino-1MQ", purity=99.1, purity_ok=True, identity=True, qty=9.8,
        status="FAILED", declared="10.0 mg",
        addons=[{"test_name": "Endotoxin (LAL)", "status": "DOES NOT CONFORM"}],
    )])
    assert rec["overall"] == "FAILED"
    assert rec["purity_ok"] is True
    assert rec["endo"] is False
    assert rec["sterility"] is None and rec["hm"] is None
    assert rec["qty"] == 9.8 and rec["qty_declared"] == 10.0
    assert rec["published_at"] == AT.isoformat()


def test_blend_uses_rollup_row_and_component_identity():
    # coa_data columns (declared, addons, native) repeat on every row of a COA.
    blend = {"product": "BPC-157, TB-500", "is_blend": True, "declared": "10.0 mg"}
    rows = [
        row("B", "BPC-157", **blend, purity=99, identity=True, qty=5, unit="mg"),
        row("B", "TB-500", **blend, purity=97, identity=False, qty=5, unit="mg"),
        row("B", "Peptide Blend", **blend, overall_row=True, purity=98.2, purity_ok=True, qty=10.4),
    ]
    [rec] = build_coa_records(rows)
    assert rec["purity"] == 98.2
    assert rec["identity_ok"] is False
    assert rec["qty"] == 10.4 and rec["qty_declared"] == 10.0


def test_declared_fallback_to_measured_is_unknown():
    [rec] = build_coa_records([row("C", "BPC-157", qty=10.0, declared="10.00 mg")])
    assert rec["qty_declared"] is None


def test_non_mass_unit_gets_no_quantity():
    [rec] = build_coa_records([row("D", "HGH", qty=30, unit="IU", declared="10 mg")])
    assert rec["qty"] is None and rec["qty_declared"] is None


def test_bac_water_rows_become_tests():
    rows = [
        row("W", "Benzyl Alcohol Assay (HPLC)", product="Bacteriostatic Water", purity=0.91,
            purity_ok=True, unit="v/v", generic=True, spec="0.9% (v/v) ±20%"),
        row("W", "pH Determination", product="Bacteriostatic Water", qty=5.5, purity_ok=True,
            unit="pH", generic=True),
    ]
    [rec] = build_coa_records(rows)
    assert rec["purity"] is None
    assert [(t["name"], t["value"], t["unit"]) for t in rec["tests"]] == [
        ("Benzyl Alcohol Assay (HPLC)", 0.91, "%"), ("pH Determination", 5.5, "pH")]


def test_native_sections_heavy_metals_and_sterility():
    native = [
        {"title": "Heavy Metals", "rows": [{"conforms": True}, {"conforms": False}]},
        {"title": "Sterility (USP <71>)", "rows": [{"conforms": True}]},
        {"title": "Residual Solvents", "rows": [{"conforms": False}]},
    ]
    assert addon_verdicts(None, native) == {"endo": None, "sterility": True, "hm": False}
    assert addon_verdicts([{"test_name": "Endotoxin (LAL)", "status": ""}], "[]")["endo"] is None


def test_parse_mass_mg():
    assert parse_mass_mg("10.0 mg") == 10.0
    assert parse_mass_mg("12") == 12.0
    assert parse_mass_mg("20 mL") is None
    assert parse_mass_mg(None) is None
