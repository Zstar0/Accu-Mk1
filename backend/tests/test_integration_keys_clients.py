"""The three integration clients use a key saved in Settings on the next call, without a restart."""
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from crm_close import client as close_client
from customer_review import llm
from database import Base
from integration_keys import store
from support_plain import client as plain_client


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr(store, "_session_factory", Session)
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())
    store.drop_cache()
    s = Session()
    yield s
    s.close()
    store.drop_cache()


@pytest.mark.parametrize("module,name,shared_key", [
    (close_client, "CLOSE_API_KEY", lambda k: k),
    (plain_client, "PLAIN_API_KEY", lambda k: k),
    (llm, "ANTHROPIC_API_KEY", lambda k: (k, "")),
])
def test_saved_key_wins_over_env_on_the_next_call(db, monkeypatch, module, name, shared_key):
    monkeypatch.setenv(name, "env_key")
    monkeypatch.delenv("ANTHROPIC_WORKSPACE_ID", raising=False)
    module._shared.clear()
    first = module.get_client()
    assert shared_key("env_key") in module._shared
    store.save(db, name, "saved_key", 1)
    second = module.get_client()
    assert second is not first and shared_key("saved_key") in module._shared
