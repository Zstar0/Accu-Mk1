"""Unit tests for sub_samples.variance.compute_variance_stats.

Pure function — no DB. Vials are dicts with `in_variance_set` flag and
`results` dict keyed by analysis keyword.
"""
import math

import pytest

from sub_samples.variance import compute_variance_stats


def _vial(sample_id, in_set=True, results=None, reason=None):
    return {
        "sample_id": sample_id,
        "in_variance_set": in_set,
        "exclusion_reason": reason,
        "results": results or {},
    }


def test_empty_family_returns_empty_stats():
    assert compute_variance_stats([]) == {}


def test_singleton_selected_returns_mean_no_sd():
    vials = [_vial("P-1", results={"Purity": {"value": 98.5, "kind": "numeric"}})]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["mean"] == 98.5
    assert stats["Purity"]["n"] == 1
    assert stats["Purity"]["sd"] is None
    assert stats["Purity"]["cv_pct"] is None


def test_all_excluded_returns_n_zero():
    vials = [
        _vial("P-1", in_set=False, results={"Purity": {"value": 98.5, "kind": "numeric"}}),
        _vial("P-2", in_set=False, results={"Purity": {"value": 98.6, "kind": "numeric"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["n"] == 0
    assert stats["Purity"]["mean"] is None


def test_two_vials_mean_sd_cv():
    vials = [
        _vial("P-1", results={"Purity": {"value": 98.0, "kind": "numeric"}}),
        _vial("P-2", results={"Purity": {"value": 99.0, "kind": "numeric"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["mean"] == pytest.approx(98.5)
    assert stats["Purity"]["sd"] == pytest.approx(math.sqrt(0.5))
    assert stats["Purity"]["cv_pct"] == pytest.approx((math.sqrt(0.5) / 98.5) * 100)
    assert stats["Purity"]["n"] == 2


def test_excluded_vial_skipped_from_stats():
    vials = [
        _vial("P-1", results={"Purity": {"value": 98.0, "kind": "numeric"}}),
        _vial("P-2", results={"Purity": {"value": 99.0, "kind": "numeric"}}),
        _vial("P-3", in_set=False, results={"Purity": {"value": 50.0, "kind": "numeric"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["n"] == 2
    assert stats["Purity"]["mean"] == pytest.approx(98.5)


def test_identity_categorical_returns_conforms_count():
    vials = [
        _vial("P-1", results={"Identity": {"value": "Conforms", "kind": "categorical"}}),
        _vial("P-2", results={"Identity": {"value": "Conforms", "kind": "categorical"}}),
        _vial("P-3", results={"Identity": {"value": "Does not conform", "kind": "categorical"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Identity"]["kind"] == "categorical"
    assert stats["Identity"]["conforms_count"] == 2
    assert stats["Identity"]["total"] == 3
    assert stats["Identity"]["mean"] is None


def test_missing_result_on_one_vial_reduces_n():
    vials = [
        _vial("P-1", results={"Purity": {"value": 98.0, "kind": "numeric"}}),
        _vial("P-2", results={}),
        _vial("P-3", results={"Purity": {"value": 99.0, "kind": "numeric"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["n"] == 2
    assert stats["Purity"]["mean"] == pytest.approx(98.5)


def test_multiple_keywords_independent_stats():
    vials = [
        _vial("P-1", results={
            "Purity": {"value": 98.0, "kind": "numeric"},
            "Quantity": {"value": 5.0, "kind": "numeric"},
        }),
        _vial("P-2", results={
            "Purity": {"value": 99.0, "kind": "numeric"},
            "Quantity": {"value": 5.2, "kind": "numeric"},
        }),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["mean"] == pytest.approx(98.5)
    assert stats["Quantity"]["mean"] == pytest.approx(5.1)
    assert stats["Purity"]["n"] == 2
    assert stats["Quantity"]["n"] == 2


def test_spec_pass_status_when_provided():
    vials = [
        _vial("P-1", results={"Purity": {"value": 98.5, "kind": "numeric", "spec": {"min": 98.0}}}),
        _vial("P-2", results={"Purity": {"value": 99.0, "kind": "numeric", "spec": {"min": 98.0}}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["spec"] == {"min": 98.0}
    assert stats["Purity"]["pass"] is True


def test_spec_fail_status():
    vials = [
        _vial("P-1", results={"Purity": {"value": 97.0, "kind": "numeric", "spec": {"min": 98.0}}}),
        _vial("P-2", results={"Purity": {"value": 97.5, "kind": "numeric", "spec": {"min": 98.0}}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["pass"] is False


# ── identity conformance (agrees with the COA's name-match rule) ─────────────

from sub_samples.variance import identity_conforms


def test_identity_conforms_name_match():
    # Peptide-specific identity stores the peptide NAME on conformance.
    assert identity_conforms("BPC-157", peptide_name="BPC-157") is True
    assert identity_conforms("TB500 (17-23 Fragment)", peptide_name="TB500 (17-23 Fragment)") is True


def test_identity_nonconform_explicit_token():
    assert identity_conforms("Does_Not_Conform", peptide_name="TB500 (17-23 Fragment)") is False


def test_identity_select_value_via_options():
    # HPLC-ID stores "1"; its label "Conforms" is the signal.
    opts = [{"value": "1", "label": "Conforms"}, {"value": "0", "label": "Does Not Conform"}]
    assert identity_conforms("1", result_options=opts) is True
    assert identity_conforms("0", result_options=opts) is False


def test_identity_blank_is_none():
    assert identity_conforms("", peptide_name="BPC-157") is None
    assert identity_conforms(None) is None


def test_categorical_uses_explicit_conforms_flag():
    # 3 conform, 1 not — mirrors PB-0080 ID_TB500-17-23 (S02 set non-conform).
    vials = [
        _vial("S-1", results={"ID_X": {"value": "X", "kind": "categorical", "conforms": True}}),
        _vial("S-2", results={"ID_X": {"value": "Does_Not_Conform", "kind": "categorical", "conforms": False}}),
        _vial("S-3", results={"ID_X": {"value": "X", "kind": "categorical", "conforms": True}}),
        _vial("S-4", results={"ID_X": {"value": "X", "kind": "categorical", "conforms": True}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["ID_X"]["kind"] == "categorical"
    assert stats["ID_X"]["conforms_count"] == 3
    assert stats["ID_X"]["total"] == 4
    assert stats["ID_X"]["pass"] is False


def test_categorical_all_conform_flag_passes():
    vials = [
        _vial("S-1", results={"ID_X": {"value": "X", "kind": "categorical", "conforms": True}}),
        _vial("S-2", results={"ID_X": {"value": "X", "kind": "categorical", "conforms": True}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["ID_X"]["conforms_count"] == 2
    assert stats["ID_X"]["pass"] is True
