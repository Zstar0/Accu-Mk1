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
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_watch_row_roundtrips(db):
    from flags.models import FlagEntityWatch
    w = FlagEntityWatch(entity_type="sample", entity_id="PB-1",
                        condition={"field": "state", "equals": "received"},
                        action={"kind": "comment", "flag_id": 1, "body": "hi"},
                        created_by=42, status="armed")
    db.add(w); db.commit(); db.refresh(w)
    assert w.id and w.status == "armed" and w.fired_at is None
    assert w.condition["equals"] == "received"
