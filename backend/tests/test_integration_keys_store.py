"""integration_keys.store: Fernet at rest, resolver order, cache, fallbacks, status (spec 3.2, 3.3)."""
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from integration_keys import store
from models import IntegrationKey, IntegrationKeyEvent, User

SECRET = Fernet.generate_key().decode()


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr(store, "_session_factory", Session)
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", SECRET)
    monkeypatch.delenv("CLOSE_API_KEY", raising=False)
    store.drop_cache()
    s = Session()
    s.add(User(id=7, email="forrest@x.example", hashed_password="x", role="admin", first_name="Forrest"))
    s.commit()
    yield s
    s.close()
    store.drop_cache()


def test_save_encrypts_and_get_returns_the_value(db):
    store.save(db, "CLOSE_API_KEY", "api_live_secret_a3f9", 7)
    row = db.get(IntegrationKey, "CLOSE_API_KEY")
    assert row.ciphertext != "api_live_secret_a3f9" and "secret" not in row.ciphertext
    assert row.last4 == "a3f9" and row.updated_by == 7
    assert store.get("CLOSE_API_KEY") == "api_live_secret_a3f9"
    assert [(e.action, e.outcome) for e in db.query(IntegrationKeyEvent)] == [("set", "ok")]


def test_resolver_order_settings_then_env_then_none(db, monkeypatch):
    assert store.get("CLOSE_API_KEY") is None
    monkeypatch.setenv("CLOSE_API_KEY", " env_key ")
    store.drop_cache()
    assert store.get("CLOSE_API_KEY") == "env_key"
    store.save(db, "CLOSE_API_KEY", "stored_key", 7)
    assert store.get("CLOSE_API_KEY") == "stored_key"
    store.clear(db, "CLOSE_API_KEY", 7)
    assert store.get("CLOSE_API_KEY") == "env_key"


def test_cache_holds_for_ttl_but_writes_drop_it(db, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(store, "_clock", lambda: now[0])
    store.save(db, "CLOSE_API_KEY", "first", 7)
    assert store.get("CLOSE_API_KEY") == "first"
    db.get(IntegrationKey, "CLOSE_API_KEY").ciphertext = Fernet(SECRET.encode()).encrypt(b"sneaky").decode()
    db.commit()
    assert store.get("CLOSE_API_KEY") == "first"  # cached
    now[0] += 61
    assert store.get("CLOSE_API_KEY") == "sneaky"
    store.save(db, "CLOSE_API_KEY", "second", 7)
    assert store.get("CLOSE_API_KEY") == "second"


def test_undecryptable_row_falls_back_to_env_and_reports_it(db, monkeypatch):
    store.save(db, "CLOSE_API_KEY", "stored_key", 7)
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())
    monkeypatch.setenv("CLOSE_API_KEY", "env_key")
    store.drop_cache()
    assert store.get("CLOSE_API_KEY") == "env_key"
    s = store.status(db, "CLOSE_API_KEY")
    assert s["undecryptable"] is True and s["source"] == "env" and s["last4"] == "_key"


def test_db_error_falls_back_to_env_and_is_not_cached(db, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(store, "_clock", lambda: now[0])
    store.save(db, "CLOSE_API_KEY", "stored_key", 7)
    monkeypatch.setenv("CLOSE_API_KEY", "env_key")
    store.drop_cache()
    good = store._session_factory

    def broken():
        raise OperationalError("select", {}, Exception("down"))

    monkeypatch.setattr(store, "_session_factory", broken)
    assert store.get("CLOSE_API_KEY") == "env_key"
    monkeypatch.setattr(store, "_session_factory", good)
    now[0] += store.FAILURE_BACKOFF + 1  # retried once the short backoff passes
    assert store.get("CLOSE_API_KEY") == "stored_key"


def test_no_secret_never_opens_a_session(db, monkeypatch):
    monkeypatch.delenv("INTEGRATION_KEYS_SECRET")
    monkeypatch.setenv("CLOSE_API_KEY", "env_key")
    store.drop_cache()

    def forbidden():
        raise AssertionError("opened a DB session without INTEGRATION_KEYS_SECRET")

    monkeypatch.setattr(store, "_session_factory", forbidden)
    assert store.configured() is False and store.get("CLOSE_API_KEY") == "env_key"


def test_malformed_secret_counts_as_not_configured(db, monkeypatch):
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", "not-a-fernet-key")
    store.drop_cache()
    assert store.configured() is False
    with pytest.raises(store.KeysNotConfigured):
        store.save(db, "CLOSE_API_KEY", "x", 7)


def test_status_for_settings_env_and_none(db, monkeypatch):
    assert store.status(db, "CLOSE_API_KEY") == {
        "name": "CLOSE_API_KEY", "label": "Close CRM", "source": "none", "last4": None,
        "updated_by_name": None, "updated_at": None, "undecryptable": False}
    monkeypatch.setenv("CLOSE_API_KEY", "env_wxyz")
    store.drop_cache()
    assert store.status(db, "CLOSE_API_KEY")["source"] == "env"
    assert store.status(db, "CLOSE_API_KEY")["last4"] == "wxyz"
    store.save(db, "CLOSE_API_KEY", "stored_a3f9", 7)
    s = store.status(db, "CLOSE_API_KEY")
    assert (s["source"], s["last4"], s["updated_by_name"]) == ("settings", "a3f9", "Forrest")
    assert s["updated_at"]


def test_a_lookup_in_flight_never_blocks_other_callers(db, monkeypatch):
    import threading
    store.save(db, "CLOSE_API_KEY", "stored_key", 7)
    monkeypatch.setenv("CLOSE_API_KEY", "env_key")
    store.drop_cache()
    entered, release = threading.Event(), threading.Event()
    good = store._session_factory

    def slow():
        entered.set()
        release.wait(5)
        return good()

    monkeypatch.setattr(store, "_session_factory", slow)
    t = threading.Thread(target=store.get, args=("CLOSE_API_KEY",))
    t.start()
    assert entered.wait(5)
    assert store.get("CLOSE_API_KEY") == "env_key"  # does not wait behind the slow lookup
    release.set()
    t.join(5)
    assert store.get("CLOSE_API_KEY") == "stored_key"


def test_a_failed_lookup_is_not_retried_for_a_few_seconds(db, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(store, "_clock", lambda: now[0])
    monkeypatch.setenv("CLOSE_API_KEY", "env_key")
    store.save(db, "CLOSE_API_KEY", "stored_key", 7)
    good, calls = store._session_factory, []

    def broken():
        calls.append(1)
        raise OperationalError("select", {}, Exception("down"))

    monkeypatch.setattr(store, "_session_factory", broken)
    assert store.get("CLOSE_API_KEY") == "env_key" and store.get("CLOSE_API_KEY") == "env_key"
    assert len(calls) == 1
    monkeypatch.setattr(store, "_session_factory", good)
    now[0] += store.FAILURE_BACKOFF + 1
    assert store.get("CLOSE_API_KEY") == "stored_key"
