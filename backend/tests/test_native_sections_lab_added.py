"""Lab-added native profiles report on the COA (2026-09-01 gate-rule change).

The order stops being the SOLE authority for reportable native profiles:
a profile the lab put on the sample via Manage Analyses (comps, retrofits)
is unioned into the services map and then flows through the identical
machinery — archetype gate, all-mk1 gate, rules 3-5, deferral, sort.
A sample with no lab-added profiles produces a byte-identical document.

Idioms mirror test_native_sections.py: db_session fixture, helper builders,
fetch_sample_services monkeypatched at coa.native_sections.
"""
import pytest

from coa.native_sections import NativeSectionsError, build_native_sections

from tests.test_native_sections import _mk_native_profile, _mk_parent_with_rows


def test_lab_added_profile_renders_without_order_key(db_session, monkeypatch):
    # P-1508 shape: the order carries only other services; the lab added the
    # profile in Manage Analyses and the canonical rows are verified.
    prof, svcs = _mk_native_profile(
        db_session, key="endotoxin-usp85-lal",
        services=[("ENDOTOXIN-USP85LAL", "mk1")], title="Endotoxin USP85 LAL",
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"hplcpurity_identity": True}, "package": "core"},
    )
    doc = build_native_sections(db_session, parent)
    assert "endotoxin-usp85-lal" in doc["ordered_profiles"]
    [section] = doc["sections"]
    assert section["profile_key"] == "endotoxin-usp85-lal"
    assert section["rows"][0]["keyword"] == "ENDOTOXIN-USP85LAL"


def test_lab_added_profile_renders_when_no_order_exists(db_session, monkeypatch):
    # IS 404 (no linked order) used to hard-return an empty document. A comp
    # on an order-less sample must still print.
    prof, svcs = _mk_native_profile(
        db_session, key="endotoxin-usp85-lal",
        services=[("ENDOTOXIN-USP85LAL", "mk1")],
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services", lambda sample_id: None)
    doc = build_native_sections(db_session, parent)
    assert doc["ordered_profiles"] == ["endotoxin-usp85-lal"]
    assert len(doc["sections"]) == 1


def test_no_order_and_no_lab_added_yields_empty_document(db_session, monkeypatch):
    # The pre-change 404 behavior is preserved exactly when nothing was added.
    from models import LimsSample
    parent = LimsSample(sample_id="P-7002")
    db_session.add(parent); db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services", lambda sample_id: None)
    doc = build_native_sections(db_session, parent)
    assert doc == {"sample_id": "P-7002", "ordered_profiles": [], "sections": []}


def test_lab_added_beats_an_ordered_false_key(db_session, monkeypatch):
    # The order explicitly says False, the lab deliberately added it anyway —
    # the lab's addition wins (same authority as the seeding union).
    prof, svcs = _mk_native_profile(
        db_session, key="sterility_pcr", services=[("STER-PCR-M", "mk1")],
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"sterility_pcr": False}, "package": None},
    )
    doc = build_native_sections(db_session, parent)
    assert doc["ordered_profiles"] == ["sterility_pcr"]


def test_lab_added_partial_pending_aborts_like_ordered(db_session, monkeypatch):
    # Symmetric semantics: a half-entered lab-added profile aborts (rule 4),
    # exactly like a paid one — a comp must never print half-filled.
    from models import LimsAnalysis
    prof, svcs = _mk_native_profile(
        db_session, key="bac_water_panel",
        services=[("BW-BENZYL", "mk1"), ("BW-PH", "mk1")],
    )
    parent = _mk_parent_with_rows(db_session, [svcs[0]])          # verified
    db_session.add(LimsAnalysis(                                   # pending
        lims_sample_pk=parent.id, analysis_service_id=svcs[1].id,
        keyword=svcs[1].keyword, title=svcs[1].title,
        result_value=None, review_state="unassigned",
    ))
    db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="bac_water_panel"):
        build_native_sections(db_session, parent)


def test_dead_lab_added_rows_do_not_summon_the_profile(db_session, monkeypatch):
    # Manage Analyses removal rejects/retracts the rows — a withdrawn profile
    # must stop reporting.
    prof, svcs = _mk_native_profile(
        db_session, key="endotoxin-usp85-lal",
        services=[("ENDOTOXIN-USP85LAL", "mk1")],
    )
    parent = _mk_parent_with_rows(db_session, svcs, state="retracted")
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {}, "package": None},
    )
    doc = build_native_sections(db_session, parent)
    assert doc["ordered_profiles"] == [] and doc["sections"] == []


def test_dead_states_stay_in_lockstep_with_manage_native():
    # Drift guard: the union's liveness predicate mirrors manage_native's
    # (import direction forbids sharing the constant — manage_native imports
    # coa.native_sections).
    from coa.native_sections import _DEAD_STATES
    from lims_analyses.manage_native import DEAD_STATES
    assert tuple(_DEAD_STATES) == tuple(DEAD_STATES)
