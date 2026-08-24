"""Role-flip cleanup sheds the OLD role's unassigned rows, keyed on the
catalog role's department_id (spec 4, Task 7: was a hardcoded role->Department
NAME map; now VialRole.department_id, read once via role_registry and passed
in by the caller)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _mk_role(db, code, department_id):
    from models import VialRole
    db.add(VialRole(code=code, label=code, department_id=department_id,
                    boxable=True, variance_eligible=True, sort_order=0,
                    frozen=True, is_system=True))


def test_flipping_ster_to_hplc_drops_only_unresulted_micro_rows(db_session):
    from catalog.roles import role_registry
    from models import (AnalysisService, Department, LimsAnalysis,
                        LimsSample, LimsSubSample)
    from sub_samples.service import _drop_stale_role_rows

    analytical = Department(name="Analytical")
    micro = Department(name="Microbiology")
    db_session.add_all([analytical, micro])
    db_session.commit()
    _mk_role(db_session, "hplc", analytical.id)
    _mk_role(db_session, "ster", micro.id)
    db_session.commit()

    ster_svc = AnalysisService(title="Sterility PCR", keyword="STER-PCR",
                               department_id=micro.id)
    endo_svc = AnalysisService(title="Endotoxin", keyword="ENDO-LAL",
                               department_id=micro.id)
    db_session.add_all([ster_svc, endo_svc])
    db_session.commit()

    parent = LimsSample(sample_id="P-0001")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0001-S01", parent_sample_pk=parent.id,
                        external_lims_uid="uid-0001-s01", vial_sequence=1)
    db_session.add(sub)
    db_session.commit()

    bare = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=ster_svc.id,
                        keyword="STER-PCR", title="Sterility PCR",
                        review_state="unassigned")
    resulted = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=endo_svc.id,
                            keyword="ENDO-LAL", title="Endotoxin",
                            review_state="unassigned", result_value="0.1")
    db_session.add_all([bare, resulted])
    db_session.commit()

    registry = role_registry(db_session)
    dropped = _drop_stale_role_rows(db_session, sub=sub, old_role="ster", new_role="hplc",
                                     registry=registry)

    assert dropped == 1
    remaining = {r.keyword for r in db_session.query(LimsAnalysis).all()}
    assert remaining == {"ENDO-LAL"}   # a row carrying a result is NEVER touched


def test_ster_to_endo_drops_nothing_same_department(db_session):
    from catalog.roles import role_registry
    from models import Department, LimsSample, LimsSubSample
    from sub_samples.service import _drop_stale_role_rows
    analytical = Department(name="Analytical")
    micro = Department(name="Microbiology")
    db_session.add_all([analytical, micro])
    db_session.commit()
    _mk_role(db_session, "ster", micro.id)
    _mk_role(db_session, "endo", micro.id)
    db_session.commit()
    parent = LimsSample(sample_id="P-0002")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0002-S01", parent_sample_pk=parent.id,
                        external_lims_uid="uid-0002-s01", vial_sequence=1)
    db_session.add(sub)
    db_session.commit()

    registry = role_registry(db_session)
    assert _drop_stale_role_rows(db_session, sub=sub, old_role="ster", new_role="endo",
                                  registry=registry) == 0


# ── Cleanup re-key (2026-08-24): custody edges, not departments, are the
# authoritative "this work left the vial" signal. The department diff stays
# for the legacy no-edge world; custody LOSS clears within-department flips
# and custody POSSESSION protects across-department flips. Together they make
# Department a pure org label (the heavy-metals-under-Analytical end-state).


def _mk_profile(db, key, svcs):
    from models import AnalysisProfile, analysis_profile_members
    p = AnalysisProfile(key=key, name=key, is_addon=True, vials_required=1,
                        fulfillment_role=key, fulfillment_dim="role", active=True)
    db.add(p)
    db.flush()
    for i, svc in enumerate(svcs):
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=p.id, analysis_service_id=svc.id, sort_order=i))
    db.flush()
    return p


def _mk_edge(db, sub, profile, relation="host", superseded=False):
    from datetime import datetime
    from models import VialProfileAssignment
    e = VialProfileAssignment(
        lims_sub_sample_pk=sub.id, analysis_profile_id=profile.id,
        relation=relation,
        superseded_at=datetime.utcnow() if superseded else None)
    db.add(e)
    db.flush()
    return e


def test_custody_loss_clears_within_one_department(db_session):
    """The hm-under-Analytical case: hm and hplc share a department, so the
    department diff is empty on an hm->hplc flip — custody loss must clear
    the lost profile's pristine rows instead. Worked rows are never touched."""
    from models import (AnalysisService, Department, LimsAnalysis,
                       LimsSample, LimsSubSample)
    from sub_samples.service import _drop_stale_custody_rows

    analytical = Department(name="Analytical")
    db_session.add(analytical)
    db_session.commit()
    hm_svc = AnalysisService(title="HM Lead", keyword="HM-PB", origin="mk1",
                             department_id=analytical.id)
    db_session.add(hm_svc)
    db_session.flush()
    hm_prof = _mk_profile(db_session, "zz_hm", [hm_svc])

    parent = LimsSample(sample_id="P-0100")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0100-S01", parent_sample_pk=parent.id,
                        external_lims_uid="uid-0100-s01", vial_sequence=1)
    db_session.add(sub)
    db_session.commit()

    pristine = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=hm_svc.id,
                            keyword="HM-PB", title="HM Lead",
                            review_state="unassigned")
    worked = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=hm_svc.id,
                          keyword="HM-PB", title="HM Lead",
                          review_state="unassigned", result_value="0.01")
    db_session.add_all([pristine, worked])
    # the hm host edge was superseded by the flip (write_custody_edges did
    # this in the real transaction); no current edge names the profile
    _mk_edge(db_session, sub, hm_prof, superseded=True)
    db_session.commit()

    dropped = _drop_stale_custody_rows(db_session, sub=sub,
                                       prev_pids={hm_prof.id})

    assert dropped == 1
    remaining = db_session.query(LimsAnalysis).all()
    assert len(remaining) == 1 and remaining[0].result_value == "0.01"


def test_current_custody_protects_across_department_diff(db_session):
    """A profile HOLDING a current edge is live work: its member services
    survive the department-diff cleanup even when their department is being
    cleared (e.g. an endotoxin rider on a vial whose host flips ster->hplc).
    An unprotected same-department service still drops."""
    from catalog.roles import role_registry
    from models import (AnalysisService, Department, LimsAnalysis,
                       LimsSample, LimsSubSample)
    from sub_samples.service import _drop_stale_role_rows

    analytical = Department(name="Analytical")
    micro = Department(name="Microbiology")
    db_session.add_all([analytical, micro])
    db_session.commit()
    _mk_role(db_session, "hplc", analytical.id)
    _mk_role(db_session, "ster", micro.id)
    db_session.commit()

    endo_svc = AnalysisService(title="Endotoxin", keyword="ENDO-LAL",
                               department_id=micro.id)
    ster_svc = AnalysisService(title="Sterility PCR", keyword="STER-PCR",
                               department_id=micro.id)
    db_session.add_all([endo_svc, ster_svc])
    db_session.flush()
    endo_prof = _mk_profile(db_session, "zz_endo", [endo_svc])

    parent = LimsSample(sample_id="P-0101")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0101-S01", parent_sample_pk=parent.id,
                        external_lims_uid="uid-0101-s01", vial_sequence=1)
    db_session.add(sub)
    db_session.commit()

    protected = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=endo_svc.id,
                             keyword="ENDO-LAL", title="Endotoxin",
                             review_state="unassigned")
    unprotected = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=ster_svc.id,
                               keyword="STER-PCR", title="Sterility PCR",
                               review_state="unassigned")
    db_session.add_all([protected, unprotected])
    _mk_edge(db_session, sub, endo_prof, relation="rider")   # CURRENT edge
    db_session.commit()

    registry = role_registry(db_session)
    dropped = _drop_stale_role_rows(db_session, sub=sub, old_role="ster",
                                    new_role="hplc", registry=registry)

    assert dropped == 1
    remaining = {r.keyword for r in db_session.query(LimsAnalysis).all()}
    assert remaining == {"ENDO-LAL"}


def test_custody_cleanup_noop_when_profile_still_holds_an_edge(db_session):
    """prev - current is empty when the profile kept custody through the
    flip (host re-written, or rider surviving) — nothing clears."""
    from models import (AnalysisService, Department, LimsAnalysis,
                       LimsSample, LimsSubSample)
    from sub_samples.service import _drop_stale_custody_rows

    analytical = Department(name="Analytical")
    db_session.add(analytical)
    db_session.commit()
    svc = AnalysisService(title="HM Lead", keyword="HM-PB", origin="mk1",
                          department_id=analytical.id)
    db_session.add(svc)
    db_session.flush()
    prof = _mk_profile(db_session, "zz_hold", [svc])

    parent = LimsSample(sample_id="P-0102")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0102-S01", parent_sample_pk=parent.id,
                        external_lims_uid="uid-0102-s01", vial_sequence=1)
    db_session.add(sub)
    db_session.commit()
    db_session.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                                keyword="HM-PB", title="HM Lead",
                                review_state="unassigned"))
    _mk_edge(db_session, sub, prof)   # CURRENT edge — custody retained
    db_session.commit()

    assert _drop_stale_custody_rows(db_session, sub=sub,
                                    prev_pids={prof.id}) == 0
    assert db_session.query(LimsAnalysis).count() == 1


def test_unknown_old_role_drops_nothing(db_session):
    """A vial's stored old_role predates a retired catalog code — the
    registry doesn't know it. Resolve to an empty department set: log,
    drop nothing, never raise (this is cleanup, not a validation gate)."""
    from catalog.roles import role_registry
    from models import LimsSample, LimsSubSample
    from sub_samples.service import _drop_stale_role_rows
    parent = LimsSample(sample_id="P-0003")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0003-S01", parent_sample_pk=parent.id,
                        external_lims_uid="uid-0003-s01", vial_sequence=1)
    db_session.add(sub)
    db_session.commit()

    registry = role_registry(db_session)  # empty — no VialRole rows exist
    assert _drop_stale_role_rows(db_session, sub=sub, old_role="retired_code",
                                  new_role="hplc", registry=registry) == 0
