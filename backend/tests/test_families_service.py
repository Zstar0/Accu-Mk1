"""Unit tests for the family-state derivation rule ladder.

Pure-Python tests of the rule ladder — no DB, no SENAITE.
"""

from __future__ import annotations

import pytest

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
    hplc_svc = AnalysisService(title="IDENTITY_BPC157 Identity", keyword="IDENTITY_BPC157")
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
        keyword="IDENTITY_BPC157", title="IDENTITY_BPC157", review_state="verified",
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


def test_catalog_classifier_resolves_duplicate_keyword_to_lowest_id(db_session):
    """AnalysisService.keyword carries no unique constraint (senaite-origin
    duplicates are schema-legal today). When the SAME keyword string exists
    under two different departments, the classifier must resolve
    deterministically to the lowest AnalysisService.id — the same
    determinism rule lims_analyses/parent_mirror.py and
    lims_analyses/service.py:88,125 use — not to whatever order the query
    happens to return."""
    from catalog.departments import ANALYTICAL_DEPARTMENT
    from families.service import _build_hplc_classifier
    from models import AnalysisService, Department

    # Name must be the exact ANALYTICAL_DEPARTMENT string for is_hplc to
    # read True on a hit — a "TEST"-suffixed name (as elsewhere in this
    # file) would silently make the assertion below true for the wrong
    # reason (never in the catalog at all) rather than proving the id-order
    # tie-break.
    analytical_dept = Department(name=ANALYTICAL_DEPARTMENT)
    hm_dept = Department(name="Heavy Metals TEST3")
    db_session.add_all([analytical_dept, hm_dept])
    db_session.flush()

    # Lower id first: Analytical. A later, higher-id row clones the SAME
    # keyword under Heavy Metals (the real-world shape: a re-run of the
    # sync cloning a service under a different department).
    lower = AnalysisService(
        title="Dup keyword (Analytical, lower id)", keyword="DUP-KEYWORD",
        department_id=analytical_dept.id,
    )
    db_session.add(lower)
    db_session.flush()
    higher = AnalysisService(
        title="Dup keyword (Heavy Metals, higher id)", keyword="DUP-KEYWORD",
        department_id=hm_dept.id,
    )
    db_session.add(higher)
    db_session.flush()
    assert lower.id < higher.id

    is_hplc = _build_hplc_classifier(db_session)
    assert is_hplc("DUP-KEYWORD") is True  # lowest id (Analytical) wins


def test_derive_family_state_end_to_end_threads_catalog_classifier(db_session):
    """D19 regression pin at the PRODUCTION wiring point. Unlike the two
    tests above (which hand a classifier to _gather_analytes explicitly),
    this calls derive_family_state() itself — the actual public entry point
    that builds and threads the classifier internally. A caller that reverts
    service.py's `_gather_analytes(db, parent, senaite_payload, is_hplc)`
    call back to 3 args (dropping the classifier) would NOT be caught by
    the other two tests, since they never call derive_family_state — only
    this one exercises the real wiring."""
    import asyncio

    from families.service import derive_family_state
    from models import AnalysisService, Department, LimsAnalysis, LimsSample

    class _FakeEmptyReader:
        async def list_for_sample(self, sample_id):
            return []

    hm_dept = Department(name="Heavy Metals TEST4")
    db_session.add(hm_dept)
    db_session.flush()
    hplc_svc = AnalysisService(title="IDENTITY_BPC157 Identity E2E", keyword="IDENTITY_BPC157")
    hm_svc = AnalysisService(
        title="Heavy Metals Panel E2E", keyword="HM-ICPMS", origin="mk1",
        department_id=hm_dept.id,
    )
    db_session.add_all([hplc_svc, hm_svc])
    db_session.flush()

    parent = LimsSample(sample_id="TEST-D19-E2E-PARENT", sample_type="x", status="received")
    db_session.add(parent)
    db_session.flush()
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=hplc_svc.id,
        keyword="IDENTITY_BPC157", title="IDENTITY_BPC157", review_state="verified",
    ))
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=hm_svc.id,
        keyword="HM-ICPMS", title="Heavy Metals Panel E2E", review_state="unassigned",
    ))
    db_session.commit()

    response = asyncio.run(
        derive_family_state(db_session, parent.sample_id, _FakeEmptyReader())
    )
    assert response.state == "waiting_for_addon_results"


# ── Review 2026-08-29, findings 3 + 5: the mk1-mode reader seam ──────────────


def test_gather_analytes_ignores_non_reportable_payload_rows(db_session):
    """Finding 3: in mk1 mode the payload comes from ShadowAnalysesReader,
    which carries an explicit `reportable` flag. The legacy leg read only
    keyword+review_state, so a canonical row the lab DE-SELECTED
    (reportable=False) — correctly dropped by the Mk1 leg's
    `reportable == True` filter — re-entered here and stamped parent_state,
    letting an excluded result drive family state."""
    from families.service import _build_hplc_classifier, _gather_analytes
    from models import LimsSample

    parent = LimsSample(sample_id="TEST-REPORTABLE-1", sample_type="x",
                        status="received")
    db_session.add(parent)
    db_session.flush()

    payload = [
        {"keyword": "IDENTITY_BPC157", "review_state": "verified",
         "reportable": False},
    ]
    is_hplc = _build_hplc_classifier(db_session)
    breakdown = _gather_analytes(db_session, parent, payload, is_hplc)

    assert "IDENTITY_BPC157" not in breakdown, (
        "a de-selected (reportable=False) result must not drive family state"
    )


def test_gather_analytes_keeps_rows_without_a_reportable_key(db_session):
    """The SENAITE HTTP reader never emits `reportable`; absence must keep
    meaning reportable (senaite mode byte-identical)."""
    from families.service import _build_hplc_classifier, _gather_analytes
    from models import LimsSample

    parent = LimsSample(sample_id="TEST-REPORTABLE-2", sample_type="x",
                        status="received")
    db_session.add(parent)
    db_session.flush()

    payload = [{"keyword": "IDENTITY_BPC157", "review_state": "verified"}]
    is_hplc = _build_hplc_classifier(db_session)
    breakdown = _gather_analytes(db_session, parent, payload, is_hplc)

    assert breakdown["IDENTITY_BPC157"].parent_state == "verified"


@pytest.mark.asyncio
async def test_derive_family_state_survives_a_null_review_state_row(db_session):
    """Finding 5: ShadowAnalysesReader raises ValueError on a NULL
    review_state (a shadow row whose mirror_review_state is NULL). The COA
    caller has a fail-open catch; this one did not, so GET
    /api/families/{id}/state 500'd in mk1 mode where senaite mode returned a
    state fine. The family panel must degrade, not die."""
    from families.service import derive_family_state
    from models import LimsSample

    parent = LimsSample(sample_id="TEST-NULLSTATE-1", sample_type="x",
                        status="received")
    db_session.add(parent)
    db_session.flush()

    class _RaisingReader:
        async def list_for_sample(self, sample_id):
            raise ValueError(
                f"analysis 1 on {sample_id} has review_state=None"
            )

    resp = await derive_family_state(db_session, "TEST-NULLSTATE-1",
                                     _RaisingReader())
    assert resp.state == "pending"
