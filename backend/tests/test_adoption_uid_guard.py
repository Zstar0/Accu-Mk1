import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models import Base, LimsSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def test_quarantine_columns_default_clean(db):
    db.add(LimsSample(sample_id="ZZQ-1"))
    db.commit()
    row = db.query(LimsSample).filter_by(sample_id="ZZQ-1").one()
    assert row.quarantined is False
    assert row.quarantine_reason is None


def test_identity_collision_flag_type_seeded(db):
    from flags import types_service
    types_service.seed_builtins(db)
    assert types_service.kind_for_type(db, "identity_collision") == "issue"
