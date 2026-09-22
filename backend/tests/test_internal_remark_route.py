"""POST /api/sub-samples/parent/{sample_id}/remarks: the sample_id-keyed
internal-remark write. The older write path is keyed by SENAITE uid, which a
native-born sample does not have, so its remarks form was hidden."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from main import app
from models import LimsSample
from sub_samples.registry_details import native_sample_remarks


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    app.dependency_overrides[get_db] = lambda: s
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=None)
    try:
        yield s
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        s.close()


def test_native_born_sample_takes_a_remark_and_reads_it_back(db):
    db.add(LimsSample(sample_id="P-5007", external_lims_uid=None))
    db.commit()

    resp = TestClient(app).post(
        "/api/sub-samples/parent/p-5007/remarks",
        json={"content": "  vial arrived cracked  "},
    )

    assert resp.status_code == 201
    assert resp.json() == {"sample_id": "P-5007"}
    remarks = native_sample_remarks(db, "P-5007")
    assert [r.content for r in remarks] == ["vial arrived cracked"]


def test_blank_remark_is_rejected_and_unknown_sample_404s(db):
    db.add(LimsSample(sample_id="P-5007", external_lims_uid=None))
    db.commit()
    client = TestClient(app)

    blank = client.post(
        "/api/sub-samples/parent/P-5007/remarks", json={"content": "   "})
    missing = client.post(
        "/api/sub-samples/parent/P-9999/remarks", json={"content": "x"})

    assert blank.status_code == 422
    assert missing.status_code == 404
    assert native_sample_remarks(db, "P-5007") == []
