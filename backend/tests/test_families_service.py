"""Unit tests for the family-state derivation rule ladder.

Pure-Python tests of the rule ladder — no DB, no SENAITE.
"""

from __future__ import annotations

from families.schemas import AnalyteBreakdown
from families.service import _derive_state, _is_hplc


def _ab(keyword, parent_state=None, vial_states=None):
    return AnalyteBreakdown(
        keyword=keyword,
        is_hplc=_is_hplc(keyword),
        parent_state=parent_state,
        vial_states=vial_states or [],
    )


def test_empty_analytes_returns_pending():
    assert _derive_state({}) == "pending"


def test_pending_when_any_vial_unassigned():
    analytes = {"IDENTITY_HPLC": _ab("IDENTITY_HPLC", vial_states=["unassigned"])}
    assert _derive_state(analytes) == "pending"


def test_pending_when_any_vial_assigned():
    analytes = {"IDENTITY_HPLC": _ab("IDENTITY_HPLC", vial_states=["assigned"])}
    assert _derive_state(analytes) == "pending"


def test_to_be_verified_when_vial_submitted_no_parent():
    analytes = {"IDENTITY_HPLC": _ab("IDENTITY_HPLC", vial_states=["to_be_verified"])}
    assert _derive_state(analytes) == "to_be_verified"


def test_waiting_for_addon_when_hplc_done_endo_unsettled_no_vials():
    """Rule 3 fires only when no analyte is still in active vial work
    (rules 1 + 2 would shadow it). Practical case: HPLC promoted, endo
    addon is ordered but no vials yet (parent_state=None, vial_states=[])."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="verified"),
        "ENDO-LAL":       _ab("ENDO-LAL"),  # no parent, no vials
    }
    assert _derive_state(analytes) == "waiting_for_addon_results"


def test_pending_wins_over_waiting_when_endo_unassigned():
    """Even with HPLC verified, an unassigned endo vial triggers rule 1 first."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="verified"),
        "ENDO-LAL":       _ab("ENDO-LAL", vial_states=["unassigned"]),
    }
    assert _derive_state(analytes) == "pending"


def test_verified_when_all_analytes_have_parent_verified():
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="verified"),
        "ENDO-LAL":       _ab("ENDO-LAL", parent_state="verified"),
    }
    assert _derive_state(analytes) == "verified"


def test_published_when_all_analytes_published():
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="published"),
        "ENDO-LAL":       _ab("ENDO-LAL", parent_state="published"),
    }
    assert _derive_state(analytes) == "published"


def test_verified_not_published_when_some_still_verified():
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="published"),
        "ENDO-LAL":       _ab("ENDO-LAL", parent_state="verified"),
    }
    assert _derive_state(analytes) == "verified"


def test_waiting_for_addon_requires_at_least_one_hplc():
    """Addons-only with all verified → verified, not waiting_for_addon."""
    analytes = {
        "ENDO-LAL": _ab("ENDO-LAL", parent_state="verified"),
    }
    assert _derive_state(analytes) == "verified"


def test_to_be_verified_wins_over_waiting_when_both_pending():
    """Rule 2 wins over rule 3 when even HPLC still has submitted vials."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", vial_states=["to_be_verified"]),
        "ENDO-LAL":       _ab("ENDO-LAL", vial_states=["to_be_verified"]),
    }
    assert _derive_state(analytes) == "to_be_verified"


def test_pending_fallback_when_unsettled_with_no_vial_activity():
    """Unsettled analyte (parent_state not in verified/published) + no vial
    activity → fallback to pending."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="unassigned"),
    }
    assert _derive_state(analytes) == "pending"
