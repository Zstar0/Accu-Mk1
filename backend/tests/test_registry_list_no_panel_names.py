"""The sample list must not label a sample "Identity (HPLC)" when no HPLC was ordered.

The registry stores the declared peptide in service-title form
("BPC-157 - Identity (HPLC)"), which is right for identity matching. The
list printed that title for every sample, so an a la carte order (endotoxin
only, no HPLC panel) read as if HPLC identity had been ordered.

registry_rows_to_list now prints the bare peptide name for a native-born,
non-retest sample whose stored order snapshot holds no HPLC or Bacteriostatic
Water primary. Every other row reads exactly as before. Pure mapping tests:
no database.
"""
import json

from models import LimsSample
from sub_samples.registry_list import registry_rows_to_list


def _row(**kw):
    r = LimsSample(sample_id=kw.get("sample_id", "P-1"))
    for k, v in kw.items():
        setattr(r, k, v)
    return r


def _snap(*keys, **extra):
    return {"profiles": [{"key": k, "fulfillment_role": "x"} for k in keys], **extra}


def _analytes(*pairs):
    return json.dumps([{"name": n, "declared_quantity": q} for n, q in pairs])


BPC = ("BPC-157 - Identity (HPLC)", "10")


def test_a_la_carte_row_prints_the_bare_peptide_name():
    row = _row(external_lims_system="mk1",
               catalog_snapshot=_snap("endotoxin-usp85-lal"),
               analytes=_analytes(BPC))
    [out] = registry_rows_to_list([row])
    assert out["analytes"] == ["BPC-157"]
    assert out["analyte_details"] == [{"name": "BPC-157", "declared_quantity": "10"}]


def test_a_la_carte_blend_strips_every_peptide_and_keeps_other_names():
    row = _row(external_lims_system="mk1",
               catalog_snapshot=_snap("fentanyl", "ph-profile"),
               analytes=_analytes(("KPV - Identity (HPLC)", "2"),
                                  ("GHK-Cu - identity (hplc)", None),
                                  ("Already Bare", None)))
    [out] = registry_rows_to_list([row])
    assert out["analytes"] == ["KPV", "GHK-Cu", "Already Bare"]
    assert [d["name"] for d in out["analyte_details"]] == ["KPV", "GHK-Cu", "Already Bare"]
    assert [d["declared_quantity"] for d in out["analyte_details"]] == ["2", None, None]


def test_hplc_order_reads_as_before_native_and_legacy_key():
    for hplc_key in ("hplc-purity-identity", "hplcpurity_identity"):
        row = _row(external_lims_system="mk1",
                   catalog_snapshot=_snap(hplc_key, "fentanyl"),
                   analytes=_analytes(BPC))
        [out] = registry_rows_to_list([row])
        assert out["analytes"] == ["BPC-157 - Identity (HPLC)"], hplc_key
        assert out["analyte_details"][0]["name"] == "BPC-157 - Identity (HPLC)", hplc_key


def test_bacteriostatic_water_order_reads_as_before():
    for bw_key in ("bac_water_panel", "bacteriostatic-water-panel"):
        row = _row(external_lims_system="mk1",
                   catalog_snapshot=_snap(bw_key, "endotoxin-usp85-lal"),
                   analytes=_analytes(("Benzyl Alcohol", "30"), BPC))
        [out] = registry_rows_to_list([row])
        assert out["analytes"] == ["Benzyl Alcohol", "BPC-157 - Identity (HPLC)"], bw_key


def test_senaite_born_row_reads_as_before_even_with_a_no_hplc_snapshot():
    for system in ("senaite", None):
        row = _row(external_lims_system=system,
                   catalog_snapshot=_snap("endotoxin-usp85-lal"),
                   analytes=_analytes(BPC))
        [out] = registry_rows_to_list([row])
        assert out["analytes"] == ["BPC-157 - Identity (HPLC)"], system


def test_row_with_no_usable_order_snapshot_reads_as_before():
    for snap in (None, {}, {"profiles": []}, {"profiles": "bad"}, "not a dict", {"profiles": [None, 7]}):
        row = _row(external_lims_system="mk1", catalog_snapshot=snap, analytes=_analytes(BPC))
        [out] = registry_rows_to_list([row])
        assert out["analytes"] == ["BPC-157 - Identity (HPLC)"], snap


def test_retest_reads_as_before():
    retests = (
        dict(is_retest=True),
        dict(retest_of_sample_id="P-0001"),
        dict(catalog_snapshot=_snap("endotoxin-usp85-lal", retest={"carry": []})),
    )
    for extra in retests:
        kw = dict(external_lims_system="mk1",
                  catalog_snapshot=_snap("endotoxin-usp85-lal"),
                  analytes=_analytes(BPC))
        kw.update(extra)
        [out] = registry_rows_to_list([_row(**kw)])
        assert out["analytes"] == ["BPC-157 - Identity (HPLC)"], extra
