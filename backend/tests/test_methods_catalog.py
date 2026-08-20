"""Slice 1 foundation: generic method columns + method_services + local instruments.
Harness: in-memory SQLite, same idiom as tests/test_manage_native_routes.py."""
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401
from database import Base
from models import AnalysisService, HplcMethod, Instrument, method_services


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _svc(db, kw):
    s = AnalysisService(title=kw.title(), keyword=kw, origin="mk1", active=True,
                        variance_capable=False)
    db.add(s)
    db.flush()
    return s


def test_method_generic_columns_and_service_links(db_session):
    m = HplcMethod(name="Elemental Impurities by ICP-MS", code="AM-ELEM-001",
                   technique="ICP-MS", reference="USP <232>/<233>",
                   procedure_summary="Microwave digestion; ICP-MS quant.",
                   origin="mk1", active=True)
    db_session.add(m)
    lead = _svc(db_session, "LEAD-PPM")
    db_session.flush()
    db_session.execute(method_services.insert().values(
        method_id=m.id, analysis_service_id=lead.id, is_default=True))
    db_session.commit()

    row = db_session.execute(select(HplcMethod).where(HplcMethod.code == "AM-ELEM-001")).scalar_one()
    assert row.technique == "ICP-MS"
    assert row.origin == "mk1"
    assert row.supersedes_id is None
    link = db_session.execute(select(method_services)).one()
    assert link.is_default is True


def test_instrument_department_and_origin_columns(db_session):
    i = Instrument(name="Agilent 7900 ICP-MS", instrument_type="ICP-MS",
                   department_id=None, origin="mk1", active=True)
    db_session.add(i)
    db_session.commit()
    got = db_session.execute(select(Instrument)).scalar_one()
    assert got.origin == "mk1"
    assert got.senaite_id is None and got.senaite_uid is None
