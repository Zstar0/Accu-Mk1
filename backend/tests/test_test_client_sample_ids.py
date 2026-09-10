"""``_test_client_sample_ids`` / TEST_CLIENT_TITLES: internal samples registered
straight into the LIMS carry no WordPress order and no billing e-mail, so the
reports' hide-test-orders switch recognises them by ``client_title``."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import main as main_module
from database import Base
from models import LimsSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _sample(db, sid, client):
    db.add(LimsSample(sample_id=sid, client_title=client, status="verified"))
    db.flush()


def test_valence_internal_2_is_a_test_client():
    assert "valence internal 2" in main_module.TEST_CLIENT_TITLES


def test_matches_client_title_case_insensitively(db):
    _sample(db, "P-0677", "Valence Internal 2")
    _sample(db, "P-0678", "VALENCE INTERNAL 2")
    _sample(db, "P-0700", "Acme Peptides")
    _sample(db, "P-0701", None)
    assert main_module._test_client_sample_ids(db) == {"P-0677", "P-0678"}


def test_test_order_ids_union_client_leg(monkeypatch, db):
    """The order-e-mail leg stays as is; the client leg is unioned in and a
    failing integration DB cannot drop it."""
    _sample(db, "P-0677", "Valence Internal 2")
    monkeypatch.setattr(main_module, "SessionLocal", lambda: db, raising=False)

    class _Boom:
        def __enter__(self):
            raise RuntimeError("integration db down")

        def __exit__(self, *a):
            return False

    import database
    monkeypatch.setattr(database, "SessionLocal", lambda: _NoClose(db))
    monkeypatch.setattr(main_module, "get_integration_db", lambda: _Boom())
    assert main_module._test_order_senaite_ids() == {"P-0677"}


class _NoClose:
    """Context-manager wrapper so ``with SessionLocal() as db`` doesn't close
    the test's session."""

    def __init__(self, s):
        self._s = s

    def __enter__(self):
        return self._s

    def __exit__(self, *a):
        return False
