"""Mk1-native Analysis Service CRUD + keyword rules."""
import pytest
from fastapi import HTTPException
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


@pytest.mark.parametrize("kw", ["HM-PB", "KF", "MOISTURE_1"])
def test_valid_keywords_accepted(db_session, kw):
    from main import validate_new_keyword
    validate_new_keyword(db_session, kw)   # must not raise


@pytest.mark.parametrize("kw", ["", "hm-pb", "1HM", "HM PB", "HM.PB"])
def test_invalid_keyword_shapes_rejected(db_session, kw):
    from main import validate_new_keyword
    with pytest.raises(HTTPException) as e:
        validate_new_keyword(db_session, kw)
    assert e.value.status_code == 400


def test_duplicate_mk1_keyword_rejected(db_session):
    from main import validate_new_keyword
    from models import AnalysisService
    db_session.add(AnalysisService(title="Lead", keyword="HM-PB", origin="mk1"))
    db_session.commit()
    with pytest.raises(HTTPException) as e:
        validate_new_keyword(db_session, "HM-PB")
    assert e.value.status_code == 400


def test_collision_with_a_senaite_keyword_rejected(db_session):
    """Cross-origin collision. If a native service could claim ENDO-LAL,
    COABuilder would receive it from the SENAITE add-on block AND from a native
    section, and print it twice."""
    from main import validate_new_keyword
    from models import AnalysisService
    db_session.add(AnalysisService(title="Endotoxin", keyword="ENDO-LAL",
                                   origin="senaite", active=False))
    db_session.commit()
    with pytest.raises(HTTPException) as e:
        validate_new_keyword(db_session, "ENDO-LAL")
    assert e.value.status_code == 400


def test_keyword_is_immutable_once_referenced(db_session):
    from main import assert_keyword_editable
    from models import AnalysisService, LimsAnalysis, LimsSample
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    parent = LimsSample(sample_id="P-0001")
    db_session.add_all([svc, parent])
    db_session.commit()
    db_session.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                                keyword="HM-PB", title="Lead",
                                review_state="unassigned"))
    db_session.commit()

    with pytest.raises(HTTPException) as e:
        assert_keyword_editable(db_session, svc)
    assert e.value.status_code == 409


def test_unreferenced_keyword_is_editable(db_session):
    from main import assert_keyword_editable
    from models import AnalysisService
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    db_session.add(svc)
    db_session.commit()
    assert_keyword_editable(db_session, svc)   # must not raise
