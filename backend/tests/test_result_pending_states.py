"""What `assigned` means to the rest of the backend (2026-09-08).

Once worksheet-add applies the `assign` transition, `assigned` rows exist in
prod for the first time. Two distinct contracts, pinned here on an `assigned`
row so neither drifts:

* RESULT PRODUCTION -- the HPLC prep bridge (result auto-fill, blend
  aggregates, method/instrument stamping) must treat `assigned` exactly like
  `unassigned`: it is the legal predecessor of `submit`, and a vial on a
  worksheet is precisely the vial results are being processed for.
* PRISTINE / CLEANUP -- a worksheet claim IS activity. Manage Analyses removal
  classifies an `assigned` row as worked (soft-reject, never hard-delete),
  `delete_pristine_analysis` refuses it, and custody / role-change cleanup
  never drops it. These match the pre-existing tests
  (test_native_manage_analyses::test_delete_with_non_unassigned_state_raises,
  test_parent_remove_cascade::test_cascade_skips_rows_with_activity).
"""
from datetime import datetime

import pytest

from lims_analyses import manage_native as mn
from lims_analyses.service import (
    BadRequestError,
    _analysis_removal_tier,
    apply_transition,
    delete_pristine_analysis,
)
from lims_analyses.state_machine import RESULT_PENDING_STATES
from models import (
    AnalysisProfile,
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    VialProfileAssignment,
    VialRole,
)


def test_result_pending_states_is_the_submit_predecessor_pair():
    assert RESULT_PENDING_STATES == frozenset({"unassigned", "assigned"})


def _parent(db, sid="RP-PARENT"):
    p = LimsSample(sample_id=sid, external_lims_uid=f"mk1://{sid}", sample_type="x",
                   status="received")
    db.add(p)
    db.flush()
    return p


def _vial(db, parent, *, sid, seq, role):
    v = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"mk1://{sid}",
                      sample_id=sid, vial_sequence=seq, assignment_role=role)
    db.add(v)
    db.flush()
    return v


def _svc(db, *, keyword, title, department=None):
    s = AnalysisService(title=title, keyword=keyword, origin="mk1")
    if department is not None:
        s.department_id = department.id
    db.add(s)
    db.flush()
    return s


def _profile(db, *, key, name, members, role):
    p = AnalysisProfile(key=key, name=name, is_addon=True, coa_archetype="limit_table",
                        fulfillment_role=role, fulfillment_dim="role", vials_required=1,
                        active=True)
    for m in members:
        p.analysis_services.append(m)
    db.add(p)
    db.flush()
    return p


def _assigned_row(db, vial, svc):
    a = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                     keyword=svc.keyword, title=svc.title, review_state="unassigned")
    db.add(a)
    db.flush()
    apply_transition(db, analysis_id=a.id, kind="assign", user_id=1)
    assert a.review_state == "assigned" and a.result_value is None
    return a


# -- result production: assigned == unassigned -------------------------------

def test_stamp_prep_assignment_reaches_assigned_rows(db_session):
    from lims_analyses.prep_bridge import stamp_prep_assignment
    db = db_session
    v = _vial(db, _parent(db), sid="P-0142-S01", seq=1, role="hplc")
    pur = _svc(db, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    row = _assigned_row(db, v, pur)

    changed = stamp_prep_assignment(db, lims_sub_sample_pk=v.id, instrument_id=None,
                                    method_id=42, user_id=1)

    assert changed == [row.id]
    db.refresh(row)
    assert row.method_id == 42 and row.review_state == "assigned"


# -- pristine / cleanup: a claim is activity ---------------------------------

def test_removal_tier_treats_assigned_row_as_worked(db_session):
    db = db_session
    v = _vial(db, _parent(db), sid="RP-PARENT-S01", seq=1, role="kf")
    kf = _svc(db, keyword="MOISTURE-KF", title="Residual Moisture")
    row = _assigned_row(db, v, kf)

    assert _analysis_removal_tier(db, row) == "worked_unverified"


def test_classify_vial_rows_buckets_assigned_row_as_worked(db_session):
    db = db_session
    parent = _parent(db)
    v = _vial(db, parent, sid="RP-PARENT-S01", seq=1, role="kf")
    kf = _svc(db, keyword="MOISTURE-KF", title="Residual Moisture")
    _profile(db, key="moisture", name="Residual Moisture", members=[kf], role="kf")
    row = _assigned_row(db, v, kf)

    out = mn._classify_vial_rows(db, parent, kf.id)

    assert [e["analysis_id"] for e in out["worked_unverified"]] == [row.id]
    assert out["pristine"] == [] and out["blocked"] == []


def test_delete_pristine_analysis_refuses_assigned_row(db_session):
    db = db_session
    v = _vial(db, _parent(db), sid="RP-PARENT-S01", seq=1, role="kf")
    kf = _svc(db, keyword="MOISTURE-KF", title="Residual Moisture")
    row = _assigned_row(db, v, kf)

    with pytest.raises(BadRequestError):
        delete_pristine_analysis(db, sub_sample_pk=v.id, keyword="MOISTURE-KF", user_id=1)
    assert db.get(LimsAnalysis, row.id) is not None


def test_custody_cleanup_keeps_assigned_row(db_session):
    from sub_samples.service import _drop_stale_custody_rows
    db = db_session
    parent = _parent(db)
    v = _vial(db, parent, sid="RP-PARENT-S01", seq=1, role="kf")
    kf = _svc(db, keyword="MOISTURE-KF", title="Residual Moisture")
    prof = _profile(db, key="moisture", name="Residual Moisture", members=[kf], role="kf")
    row = _assigned_row(db, v, kf)
    db.add(VialProfileAssignment(lims_sub_sample_pk=v.id, analysis_profile_id=prof.id,
                                 relation="host", superseded_at=datetime.utcnow()))
    db.flush()

    n = _drop_stale_custody_rows(db, sub=v, prev_pids={prof.id})

    assert n == 0
    assert db.get(LimsAnalysis, row.id) is not None


def test_role_change_cleanup_keeps_assigned_row(db_session):
    from catalog.roles import role_registry
    from sub_samples.service import _drop_stale_role_rows
    db = db_session
    analytical = Department(name="Analytical")
    micro = Department(name="Microbiology")
    db.add_all([analytical, micro])
    db.flush()
    db.add_all([
        VialRole(code="hplc", label="HPLC", department_id=analytical.id),
        VialRole(code="ster", label="Sterility", department_id=micro.id),
    ])
    db.flush()
    v = _vial(db, _parent(db), sid="RP-PARENT-S01", seq=1, role="hplc")
    ster = _svc(db, keyword="STER-PCR", title="Sterility PCR", department=micro)
    row = _assigned_row(db, v, ster)

    n = _drop_stale_role_rows(db, sub=v, old_role="ster", new_role="hplc",
                              registry=role_registry(db))

    assert n == 0
    assert db.get(LimsAnalysis, row.id) is not None
