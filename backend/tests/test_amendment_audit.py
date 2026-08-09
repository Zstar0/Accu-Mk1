"""Amendment audit (spec 2026-08-07): before/after capture on
lims_analysis_transitions.details, plus the activity-log blend.

Fixtures follow tests/test_parent_placeholders.py: self-contained in-memory
SQLite; models import registers everything on Base.metadata before
create_all().
"""
from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401 — registers models on Base.metadata
from database import Base
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
    User,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


def test_details_column_round_trips_a_dict(db):
    """The column exists in the SQLite fixture engine (JSON variant) and
    stores/returns a nested dict unchanged."""
    parent = LimsSample(sample_id="AA-P1", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    svc = AnalysisService(title="T", keyword="KW", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="KW", title="T",
    )
    db.add(row)
    db.commit()

    payload = {"changed": {"result_value": {"before": None, "after": "1.0"}}}
    db.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state=None, to_state="unassigned",
        transition_kind="auto", details=payload,
    ))
    db.commit()

    stored = db.execute(select(LimsAnalysisTransition)).scalars().one()
    assert stored.details == payload


def test_details_is_nullable(db):
    """Grandfathered rows carry NULL — the model must not default it."""
    parent = LimsSample(sample_id="AA-P2", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    svc = AnalysisService(title="T2", keyword="KW2", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="KW2", title="T2",
    )
    db.add(row)
    db.commit()
    db.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state=None, to_state="unassigned",
        transition_kind="auto",
    ))
    db.commit()
    assert db.execute(select(LimsAnalysisTransition)).scalars().one().details is None


from lims_analyses.service import apply_transition


@pytest.fixture
def vial_row(db):
    """A vial-tier analysis in 'unassigned', ready for bench transitions."""
    parent = LimsSample(sample_id="AA-P3", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    vial = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="u1",
        sample_id="AA-P3-S01", vial_sequence=1,
    )
    db.add(vial)
    db.commit()
    svc = AnalysisService(title="Sterility USP<71>", keyword="STERILITY_USP71", origin="mk1")
    db.add(svc)
    db.commit()
    row = LimsAnalysis(
        lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
        keyword="STERILITY_USP71", title="Sterility USP<71>",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _transitions_for(db, analysis_id):
    return db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == analysis_id)
        .order_by(LimsAnalysisTransition.id)
    ).scalars().all()


def test_submit_captures_first_entry(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["result_value"] == {"before": None, "after": "0.92"}


def test_self_edge_correction_captures_before_and_after(db, vial_row):
    """THE §7.5.2 test: in-place correction keeps the prior value."""
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.95", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.from_state == "to_be_verified" and t.to_state == "to_be_verified"
    assert t.details["changed"]["result_value"] == {"before": "0.92", "after": "0.95"}


def test_pure_state_move_writes_empty_changed_not_null(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="assign", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details == {"changed": {}}


def test_reset_captures_cleared_fields(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="assign", user_id=1)
    vial_row.result_value = "draft"   # draft value, as the bench UI writes it
    vial_row.method_id = None
    db.commit()
    apply_transition(db, analysis_id=vial_row.id, kind="reset", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["result_value"] == {"before": "draft", "after": None}


def test_retest_flags_old_row_and_seeds_new(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    new_row = apply_transition(db, analysis_id=vial_row.id, kind="retest", user_id=1)
    old_last = _transitions_for(db, vial_row.id)[-1]
    assert old_last.details["changed"]["retested"] == {"before": False, "after": True}
    new_first = _transitions_for(db, new_row.id)[0]
    assert new_first.details == {"changed": {}}


import ast
from pathlib import Path

from lims_analyses.service import (
    promote_to_parent,
    set_method_instrument,
    set_reportable,
)


def test_set_method_instrument_captures_old_and_new(db, vial_row):
    set_method_instrument(db, analysis_id=vial_row.id, method_id=3,
                          instrument_id=None, user_id=1)
    set_method_instrument(db, analysis_id=vial_row.id, method_id=5,
                          instrument_id=None, user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["method_id"] == {"before": 3, "after": 5}


def test_set_reportable_captures_flag_and_reason(db, vial_row):
    set_reportable(db, analysis_id=vial_row.id, reportable=False,
                   reason="client withdrew", user_id=1)
    t = _transitions_for(db, vial_row.id)[-1]
    assert t.details["changed"]["reportable"] == {"before": True, "after": False}
    assert t.details["changed"]["reportable_reason"]["after"] == "client withdrew"


def test_promote_rows_carry_empty_changed(db, vial_row):
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="Not Detected", user_id=1)
    parent_row, _ = promote_to_parent(
        db, keyword="STERILITY_USP71", result_value="Not Detected",
        result_unit=None, method_id=None, instrument_id=None,
        sources=[{"analysis_id": vial_row.id, "contribution_kind": "chosen"}],
        user_id=1,
    )
    # source row's to->promoted transition: state-only
    src_last = _transitions_for(db, vial_row.id)[-1]
    assert src_last.to_state == "promoted" and src_last.details == {"changed": {}}
    # new parent row's initial transition: state-only
    parent_first = _transitions_for(db, parent_row.id)[0]
    assert parent_first.details == {"changed": {}}


def test_unpromote_captures_cleared_parent_value(db, vial_row):
    from lims_analyses.service import vial_source_retest
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="Not Detected", user_id=1)
    parent_row, _ = promote_to_parent(
        db, keyword="STERILITY_USP71", result_value="Not Detected",
        result_unit="Pos/Neg", method_id=None, instrument_id=None,
        sources=[{"analysis_id": vial_row.id, "contribution_kind": "chosen"}],
        user_id=1,
    )
    vial_source_retest(db, analysis_id=vial_row.id, user_id=1)
    t = _transitions_for(db, parent_row.id)[-1]
    assert t.to_state == "retracted"
    assert t.details["changed"]["result_value"] == {"before": "Not Detected", "after": None}
    assert t.details["changed"]["result_unit"] == {"before": "Pos/Neg", "after": None}


def test_grep_guard_every_construction_passes_details():
    """No future write site may regress to value-blind. Parse service.py's
    AST, find every LimsAnalysisTransition(...) call, and require a details=
    keyword on each. AST-based (not a char/paren scan) so it's blind to
    string literals and comments — a reason="...(..." with unbalanced parens
    can't desync it."""
    path = Path(__file__).resolve().parents[1].joinpath(
        "lims_analyses", "service.py")
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    sites = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "LimsAnalysisTransition"
    ]
    # Guards against an import-shape change (e.g. aliasing or calling via a
    # module attribute) silently hiding call sites from this scan.
    assert len(sites) >= 11, (
        f"expected >= 11 LimsAnalysisTransition(...) construction sites in "
        f"service.py, found {len(sites)} — a site may have gone undetected"
    )
    for node in sites:
        has_details = any(kw.arg == "details" for kw in node.keywords)
        assert has_details, (
            f"LimsAnalysisTransition(...) at service.py:{node.lineno} lacks "
            "details= — amendment audit regression"
        )


def test_transition_info_serializes_details_and_tolerates_null(db, vial_row):
    from lims_analyses.schemas import TransitionInfo
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="1", user_id=1)
    captured = _transitions_for(db, vial_row.id)[-1]
    info = TransitionInfo.model_validate(captured)
    assert info.details["changed"]["result_value"]["after"] == "1"

    # grandfathered NULL row
    db.add(LimsAnalysisTransition(
        analysis_id=vial_row.id, from_state=None, to_state="unassigned",
        transition_kind="auto",
    ))
    db.commit()
    legacy = _transitions_for(db, vial_row.id)[-1]
    assert TransitionInfo.model_validate(legacy).details is None


def test_activity_events_entry_then_amendment(db, vial_row):
    from lims_analyses.service import list_analysis_change_events_for_parent
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.92", user_id=1)
    apply_transition(db, analysis_id=vial_row.id, kind="submit",
                     result_value="0.95", user_id=1)
    events = list_analysis_change_events_for_parent(db, "AA-P3")
    assert [e["event"] for e in events] == ["result_entered", "analysis_amended"]
    entered, amended = events
    assert "Sterility USP<71>" in entered["label"]
    assert "AA-P3-S01" in entered["label"]          # vial context
    assert "0.92 → 0.95" in amended["label"]        # before → after inline
    assert amended["details"]["changed"]["result_value"]["before"] == "0.92"
    assert amended["source"] == "lims_analysis_transitions"


def test_activity_skips_state_only_and_null_details(db, vial_row):
    from lims_analyses.service import list_analysis_change_events_for_parent
    apply_transition(db, analysis_id=vial_row.id, kind="assign", user_id=1)  # {"changed": {}}
    db.add(LimsAnalysisTransition(                                            # grandfathered NULL
        analysis_id=vial_row.id, from_state=None, to_state="unassigned",
        transition_kind="auto",
    ))
    db.commit()
    assert list_analysis_change_events_for_parent(db, "AA-P3") == []


def test_activity_non_result_change_is_amended(db, vial_row):
    from lims_analyses.service import list_analysis_change_events_for_parent
    set_method_instrument(db, analysis_id=vial_row.id, method_id=3,
                          instrument_id=None, user_id=1)
    events = list_analysis_change_events_for_parent(db, "AA-P3")
    assert len(events) == 1 and events[0]["event"] == "analysis_amended"
    assert "method_id" in events[0]["label"]
