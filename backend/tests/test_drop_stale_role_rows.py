"""Role-flip cleanup sheds the OLD role's unassigned rows, keyed on Department."""
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


def test_flipping_ster_to_hplc_drops_only_unresulted_micro_rows(db_session):
    from models import (AnalysisService, Department, LimsAnalysis,
                        LimsSample, LimsSubSample)
    from sub_samples.service import _drop_stale_role_rows

    analytical = Department(name="Analytical")
    micro = Department(name="Microbiology")
    db_session.add_all([analytical, micro])
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

    dropped = _drop_stale_role_rows(db_session, sub=sub, old_role="ster", new_role="hplc")

    assert dropped == 1
    remaining = {r.keyword for r in db_session.query(LimsAnalysis).all()}
    assert remaining == {"ENDO-LAL"}   # a row carrying a result is NEVER touched


def test_ster_to_endo_drops_nothing_same_department(db_session):
    from models import Department, LimsSample, LimsSubSample
    from sub_samples.service import _drop_stale_role_rows
    db_session.add_all([Department(name="Analytical"), Department(name="Microbiology")])
    db_session.commit()
    parent = LimsSample(sample_id="P-0002")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0002-S01", parent_sample_pk=parent.id,
                        external_lims_uid="uid-0002-s01", vial_sequence=1)
    db_session.add(sub)
    db_session.commit()

    assert _drop_stale_role_rows(db_session, sub=sub, old_role="ster", new_role="endo") == 0
