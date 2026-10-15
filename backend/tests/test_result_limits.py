"""Endo slice 3, Task 1: per-result LOQ / LOD on lims_analyses.

The three columns travel with the value (retest carry) and are cleared with it
(reset, both un-promote paths); a new retest row starts without them; the
amendment audit records them as JSON-safe values; every analysis payload,
including the registry re-type the mk1 sample page reads, declares them.

Spec: docs/superpowers/specs/2026-10-12-endo-slice3-promote-loq-design.md
sections 4 and 7; plan Review Focus 4. In-memory SQLite (`db_session`,
tests/conftest.py).
"""
from __future__ import annotations

import json

from sqlalchemy import inspect, select

from lims_analyses.service import (
    apply_transition,
    cascade_parent_retest_to_sources,
    list_analysis_change_events_for_parent,
    promote_to_parent,
    vial_source_retest,
)
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)

LIMITS = {"loq": 25.0, "lod": 0.05, "lod_unit": "EU/mL"}
CLEARED = {"loq": None, "lod": None, "lod_unit": None}


def _limits(obj) -> dict:
    return {"loq": obj.loq, "lod": obj.lod, "lod_unit": obj.lod_unit}


def _set_limits(row) -> None:
    row.loq, row.lod, row.lod_unit = LIMITS["loq"], LIMITS["lod"], LIMITS["lod_unit"]


def _endo_world(db):
    """A native endotoxin service, a parent with one vial, one unassigned vial row."""
    svc = AnalysisService(title="Endotoxin USP85 LAL", keyword="ENDOTOXIN-USP85LAL",
                          origin="mk1", unit="EU/mL")
    parent = LimsSample(sample_id="P-7001", external_lims_uid="uid-P-7001")
    db.add_all([svc, parent])
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="uid-P-7001-S01",
                         sample_id="P-7001-S01", vial_sequence=1)
    db.add(vial)
    db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                       keyword=svc.keyword, title=svc.title)
    db.add(row)
    db.commit()
    return svc, parent, row


def _promoted_parent_with_limits(db):
    """The vial result submitted and promoted; the parent row then carries the
    limits (Task 2 copies them at promote; set directly so this task stands alone)."""
    svc, parent, row = _endo_world(db)
    apply_transition(db, analysis_id=row.id, kind="submit", result_value="25")
    parent_row, _ = promote_to_parent(
        db, keyword=svc.keyword, result_value="25", result_unit="EU/vial",
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}],
    )
    _set_limits(parent_row)
    db.commit()
    return svc, parent, row, parent_row


def _last_changed(db, analysis_id) -> dict:
    db.expire_all()   # read the stored details back, not the in-memory dict
    t = db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == analysis_id)
        .order_by(LimsAnalysisTransition.id.desc()).limit(1)
    ).scalar_one()
    return t.details["changed"]


def test_columns_exist_and_start_empty(db_session):
    cols = {c["name"] for c in inspect(db_session.get_bind()).get_columns("lims_analyses")}
    assert {"loq", "lod", "lod_unit"} <= cols
    _svc, _parent, row = _endo_world(db_session)
    assert _limits(row) == CLEARED


def test_boot_migrations_add_the_columns_above_the_pinned_last_statement():
    from tests.test_hplc_native_schema import _captured
    stmts = _captured()
    for sql in ("ALTER TABLE lims_analyses ADD COLUMN IF NOT EXISTS loq DOUBLE PRECISION",
                "ALTER TABLE lims_analyses ADD COLUMN IF NOT EXISTS lod DOUBLE PRECISION",
                "ALTER TABLE lims_analyses ADD COLUMN IF NOT EXISTS lod_unit TEXT"):
        assert sql in stmts, sql
    assert stmts[-1] == "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS retest_of_sample_id TEXT"


def test_reset_clears_the_limits_and_the_audit_records_them_as_json(db_session):
    _svc, _parent, row = _endo_world(db_session)
    apply_transition(db_session, analysis_id=row.id, kind="assign")
    row.result_value = "25"            # a draft, as the bench writes it
    _set_limits(row)
    db_session.commit()

    apply_transition(db_session, analysis_id=row.id, kind="reset")

    changed = _last_changed(db_session, row.id)
    assert _limits(db_session.get(LimsAnalysis, row.id)) == CLEARED
    assert changed["loq"] == {"before": 25.0, "after": None}
    assert changed["lod"] == {"before": 0.05, "after": None}
    assert changed["lod_unit"] == {"before": "EU/mL", "after": None}
    assert isinstance(changed["loq"]["before"], float)
    assert isinstance(changed["lod"]["before"], float)
    json.dumps(changed)                # the audit column must stay JSON-serializable


def test_reset_that_preserves_the_draft_keeps_the_limits(db_session):
    """A worksheet releasing its claim (preserve_draft) never owned the draft."""
    _svc, _parent, row = _endo_world(db_session)
    apply_transition(db_session, analysis_id=row.id, kind="assign")
    row.result_value = "25"
    _set_limits(row)
    db_session.commit()

    apply_transition(db_session, analysis_id=row.id, kind="reset", preserve_draft=True)

    db_session.refresh(row)
    assert row.result_value == "25" and _limits(row) == LIMITS


def test_a_new_retest_row_starts_without_limits(db_session):
    _svc, _parent, row = _endo_world(db_session)
    apply_transition(db_session, analysis_id=row.id, kind="submit", result_value="25")
    _set_limits(row)
    db_session.commit()

    new_row = apply_transition(db_session, analysis_id=row.id, kind="retest")

    assert _limits(new_row) == CLEARED
    db_session.refresh(row)
    assert _limits(row) == LIMITS      # the retested row keeps its history


def test_source_retest_unpromote_clears_the_parent_limits(db_session):
    """Review Focus 4: the sample page's vial-side retest un-promotes the parent;
    its LOQ / LOD go with the value, so a regenerated COA cannot print a stale
    "< LOQ"."""
    _svc, _parent, row, parent_row = _promoted_parent_with_limits(db_session)

    vial_source_retest(db_session, analysis_id=row.id, user_id=None)

    changed = _last_changed(db_session, parent_row.id)
    parent_row = db_session.get(LimsAnalysis, parent_row.id)
    assert parent_row.review_state == "retracted" and parent_row.result_value is None
    assert _limits(parent_row) == CLEARED
    assert changed["loq"] == {"before": 25.0, "after": None}
    assert changed["lod_unit"] == {"before": "EU/mL", "after": None}


def test_parent_retest_cascade_unpromote_clears_the_parent_limits(db_session):
    """Review Focus 4, the other un-promote path (parent retest cascade)."""
    svc, parent, _row, parent_row = _promoted_parent_with_limits(db_session)

    new_ids = cascade_parent_retest_to_sources(
        db_session, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
    )

    assert len(new_ids) == 1
    changed = _last_changed(db_session, parent_row.id)
    parent_row = db_session.get(LimsAnalysis, parent_row.id)
    assert parent_row.review_state == "retracted"
    assert _limits(parent_row) == CLEARED
    assert changed["lod"] == {"before": 0.05, "after": None}


def test_result_entered_grouping_counts_the_limits_as_part_of_the_result(db_session):
    """A first entry that sets value, unit, LOQ and LOD together is one
    "result entered" event, not an amendment."""
    _svc, _parent, row = _endo_world(db_session)
    db_session.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state="unassigned", to_state="to_be_verified",
        transition_kind="submit",
        details={"changed": {
            "result_value": {"before": None, "after": "25"},
            "result_unit": {"before": None, "after": "EU/vial"},
            "loq": {"before": None, "after": 25.0},
            "lod": {"before": None, "after": 0.05},
            "lod_unit": {"before": None, "after": "EU/mL"},
        }},
    ))
    db_session.commit()

    [event] = list_analysis_change_events_for_parent(db_session, "P-7001")

    assert event["event"] == "result_entered"


def test_retest_carry_copies_the_limits(db_session):
    from lims_analyses.retest_carry import carry_results
    from tests.test_retest_carry import _carried_rows, _world
    original, retest, parents, _vial = _world(db_session)
    _set_limits(parents["ARSENIC-PPM"])
    db_session.commit()

    carry_results(db_session, original=original, retest=retest,
                  profile_keys=["heavy_metals"], user_id=None)
    db_session.commit()

    by_kw = {r.keyword: r for r in _carried_rows(db_session, retest)}
    assert _limits(by_kw["ARSENIC-PPM"]) == LIMITS
    assert _limits(by_kw["LEAD-PPM"]) == CLEARED


def test_every_analysis_payload_declares_the_limits():
    from lims_analyses.schemas import (
        AnalysisResponse,
        NativeParentAnalysisRow,
        SenaiteShapeAnalysisResponse,
    )
    from sub_samples.lookup_models import SenaiteAnalysis
    for model in (AnalysisResponse, NativeParentAnalysisRow,
                  SenaiteShapeAnalysisResponse, SenaiteAnalysis):
        for field in ("loq", "lod", "lod_unit"):
            assert field in model.model_fields, (model.__name__, field)
            assert model.model_fields[field].default is None, (model.__name__, field)


def test_the_limits_reach_every_read_surface(db_session):
    """Off the real serializers: the vial table, the parent row, the native card
    and the registry re-type the mk1 sample page reads (it drops undeclared keys)."""
    from lims_analyses.schemas import AnalysisResponse
    from lims_analyses.service import list_analyses_in_senaite_shape, list_native_parent_analyses
    from sub_samples.registry_details import _analyses_block
    _svc, parent, row, parent_row = _promoted_parent_with_limits(db_session)
    _set_limits(row)
    db_session.commit()

    [vial_shape] = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=row.lims_sub_sample_pk)
    [card] = list_native_parent_analyses(db_session, parent.sample_id)
    [registry_line] = _analyses_block(db_session, parent.sample_id)

    assert _limits(AnalysisResponse.model_validate(parent_row)) == LIMITS
    assert _limits(vial_shape) == LIMITS
    assert _limits(card) == LIMITS
    assert _limits(registry_line) == LIMITS
