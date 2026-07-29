"""origin + local_overrides: sync can never touch Mk1-owned data."""
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


def test_origin_defaults_to_senaite(db_session):
    from models import AnalysisService
    s = AnalysisService(title="Purity X", keyword="PUR_X")
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    assert s.origin == "senaite"
    assert s.local_overrides is None


def test_mk1_origin_row_is_invisible_to_orphan_adoption(db_session):
    """The adoption branch matches on keyword alone. A native row must never be
    a candidate, or SENAITE would silently take ownership of it."""
    from main import _find_adoptable_orphan
    from models import AnalysisService
    native = AnalysisService(title="Lead (Pb)", keyword="HM-PB", origin="mk1")
    db_session.add(native)
    db_session.commit()

    assert _find_adoptable_orphan(db_session, keyword="HM-PB",
                                  current_ids={"AS-999"}) is None


def test_senaite_orphan_is_still_adoptable(db_session):
    from main import _find_adoptable_orphan
    from models import AnalysisService
    orphan = AnalysisService(title="Purity X", keyword="PUR_X",
                             origin="senaite", senaite_id="AS-001")
    db_session.add(orphan)
    db_session.commit()

    found = _find_adoptable_orphan(db_session, keyword="PUR_X",
                                   current_ids={"AS-002"})
    assert found is not None and found.id == orphan.id


def test_sync_skips_fields_named_in_local_overrides(db_session):
    from main import _apply_sync_fields
    from models import AnalysisService
    svc = AnalysisService(title="Old Title", keyword="PUR_X", unit="mg",
                          origin="senaite", local_overrides=["unit"])
    db_session.add(svc)
    db_session.commit()

    _apply_sync_fields(svc, {"title": "New Title", "unit": "ug"})

    assert svc.title == "New Title"   # not overridden -> sync wins
    assert svc.unit == "mg"           # overridden -> Mk1 wins


def test_sync_never_touches_an_mk1_row(db_session):
    from main import _apply_sync_fields
    from models import AnalysisService
    svc = AnalysisService(title="Lead (Pb)", keyword="HM-PB", origin="mk1")
    db_session.add(svc)
    db_session.commit()

    _apply_sync_fields(svc, {"title": "Clobbered"})

    assert svc.title == "Lead (Pb)"
