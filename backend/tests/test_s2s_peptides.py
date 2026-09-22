"""GET /s2s/peptides — Mk1 peptide list for the Integration Service (spec
2026-09-10 M3 / IS-6): replaces the SENAITE-sourced WordPress dropdown."""
import os
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401
from models import Base, Peptide


@pytest.fixture
def db():
    # StaticPool + check_same_thread=False: TestClient (used by the S2S
    # endpoint tests below) runs requests off a threadpool, and a plain
    # sqlite:///:memory: engine 500s there ("created in thread X, used in Y").
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


@pytest.fixture(autouse=True)
def _cleanup_s2s_get_db_override():
    """_client() below overrides app.dependency_overrides[get_db] with this
    module's short-lived sqlite session; pop it after every test so a later
    test file's plain TestClient(app) doesn't inherit a closed session."""
    yield
    from database import get_db
    from main import app
    app.dependency_overrides.pop(get_db, None)


def _client(db):
    """TestClient wired to the sqlite `db` fixture session via the SAME
    get_db dependency object the S2S route uses, with the internal service
    token set. Mirrors tests/test_registry_signal.py's override idiom."""
    from database import get_db
    from main import app

    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    return TestClient(app)


def test_s2s_peptides_requires_token(db, monkeypatch):
    monkeypatch.setenv("ACCUMK1_INTERNAL_SERVICE_TOKEN", "tok")
    client = _client(db)
    assert client.get("/s2s/peptides").status_code in (401, 403)


def test_s2s_peptides_ships_every_peptide_with_ids_and_aliases(db, monkeypatch):
    monkeypatch.setenv("ACCUMK1_INTERNAL_SERVICE_TOKEN", "tok")
    client = _client(db)
    db.add(Peptide(name="BPC-157", abbreviation="BPC157", active=True, hplc_aliases=["BPC"]))
    db.add(Peptide(name="Old Thing", abbreviation="OLD", active=False))
    db.add(Peptide(name="GLOW", abbreviation="GLOW", is_blend=True))
    db.commit()
    r = client.get("/s2s/peptides", headers={"X-Service-Token": "tok"})
    assert r.status_code == 200
    body = r.json()
    rows = {p["name"]: p for p in body["peptides"]}
    assert set(rows) == {"BPC-157", "Old Thing", "GLOW"}
    assert rows["BPC-157"]["hplc_aliases"] == ["BPC"] and rows["BPC-157"]["active"] is True
    assert rows["Old Thing"]["active"] is False
    assert rows["GLOW"]["is_blend"] is True
    assert set(rows["BPC-157"]) == {"id", "name", "abbreviation", "is_blend", "active",
                                    "analyte_class", "display_aliases", "hplc_aliases"}
    assert "generated_at" in body
