import hashlib
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import User
from capture_tokens.service import (
    mint_capture_token,
    resolve_capture_token,
    revoke_capture_token,
    UnknownTokenError,
    GoneTokenError,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def user(db):
    u = User(email="capture-tester@example.com", hashed_password="x")
    db.add(u)
    db.flush()
    return u


def test_mint_stores_hash_not_token(db, user):
    tok, raw = mint_capture_token(db, [{"sample_id": "P-1", "lot": "L", "analytes": "A"}], "WP-1", user.id)
    assert raw not in (tok.token_hash or "")
    assert tok.token_hash == hashlib.sha256(raw.encode()).hexdigest()
    assert tok.expires_at > datetime.utcnow()


def test_resolve_happy_and_unknown(db, user):
    tok, raw = mint_capture_token(db, [{"sample_id": "P-1"}], None, user.id)
    assert resolve_capture_token(db, raw).id == tok.id
    with pytest.raises(UnknownTokenError):
        resolve_capture_token(db, "not-a-token")


def test_resolve_expired_and_revoked_are_gone(db, user):
    tok, raw = mint_capture_token(db, [{"sample_id": "P-1"}], None, user.id)
    tok.expires_at = datetime.utcnow() - timedelta(minutes=1)
    db.commit()
    with pytest.raises(GoneTokenError):
        resolve_capture_token(db, raw)
    tok2, raw2 = mint_capture_token(db, [{"sample_id": "P-1"}], None, user.id)
    assert revoke_capture_token(db, tok2.id) is True
    with pytest.raises(GoneTokenError):
        resolve_capture_token(db, raw2)
