"""Catalog: departments table + extended group/service columns. Self-restoring."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401  (register all models on Base)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_department_persists_with_defaults(db_session):
    from models import Department
    d = Department(name="Microbiology")
    db_session.add(d)
    db_session.commit()
    db_session.refresh(d)
    assert d.id is not None
    assert d.name == "Microbiology"
    assert d.sort_order == 0
    assert d.color == "blue"
    assert d.is_system is False
