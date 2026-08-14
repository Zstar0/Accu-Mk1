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


def test_to_be_verified_when_parent_awaiting_verification_post_promote():
    """Post-promote: the source vial has moved to 'promoted' (no longer
    'to_be_verified') and the parent row sits in 'parent_to_verify' awaiting
    sign-off. This must NOT regress the family state backward to 'pending'
    (Rule 2's has-to_be_verified-work predicate must also recognize
    parent_state == 'parent_to_verify', mirroring the read-flip collapse in
    workflow/engine.py's _live_parent_line_states)."""
    analytes = {
        "HM-PB": _ab("HM-PB", parent_state="parent_to_verify", vial_states=["promoted"]),
    }
    assert _derive_state(analytes) == "to_be_verified"


def test_to_be_verified_parent_awaiting_wins_over_verified_addon():
    """Mixed family: HPLC promoted+awaiting sign-off (parent_to_verify),
    addon already verified. Rule 2 (awaiting HPLC) must win over Rule 3
    (waiting_for_addon) — the family isn't done just because the addon is."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="parent_to_verify", vial_states=["promoted"]),
        "ENDO-LAL":       _ab("ENDO-LAL", parent_state="verified"),
    }
    assert _derive_state(analytes) == "to_be_verified"


def test_catalog_family_keyword_classifies_as_addon(db_session):
    """S9/D19: a keyword belonging to a NON-Analytical catalog service must
    classify as addon even though it matches no legacy prefix. Pre-S9 this
    misclassified as HPLC and suppressed waiting_for_addon_results."""
    from models import AnalysisService, Department

    hm_dept = Department(name="Heavy Metals TEST")
    db_session.add(hm_dept)
    db_session.flush()
    db_session.add(AnalysisService(
        title="Heavy Metals Panel", keyword="HM-ICPMS", origin="mk1",
        department_id=hm_dept.id,
    ))
    db_session.flush()

    from families.service import _build_hplc_classifier
    is_hplc = _build_hplc_classifier(db_session)
    assert is_hplc("HM-ICPMS") is False          # catalog wins
    assert is_hplc("ENDO-LAL") is False           # prefix fallback intact
    assert is_hplc("IDENTITY_BPC157") is True     # non-catalog keyword falls back to prefix rule


def test_gather_analytes_threads_catalog_classifier_into_waiting_for_addon(db_session):
    """D19 regression pin: _gather_analytes must actually USE the threaded
    classifier, not just accept one as an unused parameter. HM-ICPMS is a
    catalog addon (Heavy Metals dept) with no legacy-prefix match — if the
    classifier isn't threaded through from derive_family_state's call site,
    it silently falls back to _is_hplc's prefix rule, HM-ICPMS reads as HPLC,
    hplc_settled goes False, and Rule 3 never fires. That's the exact pre-S9
    symptom this task fixes (a pending catalog addon suppresses
    waiting_for_addon_results and the family shows 'pending' instead)."""
    from families.service import _build_hplc_classifier, _derive_state, _gather_analytes
    from models import AnalysisService, Department, LimsAnalysis, LimsSample

    hm_dept = Department(name="Heavy Metals TEST2")
    db_session.add(hm_dept)
    db_session.flush()
    hplc_svc = AnalysisService(title="ID_BPC157 Identity", keyword="ID_BPC157")
    hm_svc = AnalysisService(
        title="Heavy Metals Panel 2", keyword="HM-ICPMS", origin="mk1",
        department_id=hm_dept.id,
    )
    db_session.add_all([hplc_svc, hm_svc])
    db_session.flush()

    parent = LimsSample(sample_id="TEST-D19-PARENT", sample_type="x", status="received")
    db_session.add(parent)
    db_session.flush()
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=hplc_svc.id,
        keyword="ID_BPC157", title="ID_BPC157", review_state="verified",
    ))
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=hm_svc.id,
        keyword="HM-ICPMS", title="Heavy Metals Panel 2", review_state="unassigned",
    ))
    db_session.flush()

    is_hplc = _build_hplc_classifier(db_session)
    breakdown = _gather_analytes(db_session, parent, [], is_hplc)
    # HPLC side settled + addon side pending -> Rule 3. If HM-ICPMS were
    # misread as HPLC (classifier not threaded), hplc_settled goes False
    # and this regresses to "pending" instead.
    assert _derive_state(breakdown) == "waiting_for_addon_results"
