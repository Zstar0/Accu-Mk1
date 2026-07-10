import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams
    seams._REGISTRY.clear()
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_sample_is_watchable_others_are_not(db):
    from flags import seams
    assert seams.has_state_seam("sample") is True
    assert seams.has_state_seam("sub_sample") is False
    assert seams.has_state_seam("worksheet") is False
    assert seams.has_state_seam("nope") is False


def test_resolve_state_reads_sample_status(db):
    from flags import seams
    from models import LimsSample
    db.add(LimsSample(sample_id="PB-0102", status="received")); db.commit()
    assert seams.resolve_state(db, "sample", "PB-0102") == "received"
    # unresolvable (missing row) → None, NOT an exception
    assert seams.resolve_state(db, "sample", "GHOST-9") is None
    # no seam → None (and has_state_seam already said False)
    assert seams.resolve_state(db, "sub_sample", "1") is None
