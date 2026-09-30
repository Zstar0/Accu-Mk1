from main import retest_activity_label


def test_retest_created():
    d = {"original": "P-2799", "fee": "paid", "auto_checkin": True, "reason": "purity re-run",
         "retest": ["hplcpurity_identity"], "carry": ["heavy_metals", "endotoxin-usp85-lal"],
         "add": ["rapid-sterility-pcr"], "variance_points": 0, "additional_vials": 0}
    assert retest_activity_label("retest_created", d) == (
        "Created as retest of P-2799 (paid, auto check-in): purity re-run. "
        "Retesting hplcpurity_identity; carrying heavy_metals, endotoxin-usp85-lal; "
        "adding rapid-sterility-pcr")


def test_retest_created_free_due_no_add():
    d = {"original": "P-2799", "fee": "free", "auto_checkin": False, "reason": "r",
         "retest": ["heavy_metals"], "carry": [], "add": [], "variance_points": 0}
    assert retest_activity_label("retest_created", d) == (
        "Created as retest of P-2799 (free, due at lab): r. Retesting heavy_metals")


def test_analysis_carried():
    d = {"keyword": "ARSENIC-PPM", "title": "Arsenic", "result_value": "9.077", "result_unit": "ug/g",
         "source_sample_id": "P-2799", "source_vial_id": "P-2799-S02",
         "verified_at": "2026-09-14T23:23:40", "analyst_user_id": 5}
    assert retest_activity_label("analysis_carried", d) == (
        "Arsenic 9.077 ug/g carried from P-2799-S02, verified 2026-09-14")


def test_analysis_carried_without_vial_or_date():
    d = {"keyword": "ENDO", "title": "Endotoxin", "result_value": "2.5", "result_unit": None,
         "source_sample_id": "P-2700", "source_vial_id": None, "verified_at": None}
    assert retest_activity_label("analysis_carried", d) == "Endotoxin 2.5 carried from P-2700"


def test_retested_as_and_warning():
    assert retest_activity_label("retested_as", {"sample_id": "P-3017", "retest": ["hplcpurity_identity"],
                                                 "carry": ["heavy_metals"], "add": []}) == \
        "Retested as P-3017 (hplcpurity_identity); carried: heavy_metals"
    assert retest_activity_label("retest_spec_warning", {"reason": "profiles_missing_on_original",
                                                         "missing": ["rapid-sterility-pcr"]}) == \
        "Retest spec warning: profiles_missing_on_original (rapid-sterility-pcr)"
    assert retest_activity_label("retest_spec_warning", {"reason": "invalid_spec", "message": "bad fee"}) == \
        "Retest spec warning: invalid_spec (bad fee)"
    assert retest_activity_label("coa_published", {}) is None
