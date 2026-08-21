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
