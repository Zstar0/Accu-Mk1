"""SENAITE tee: AR-level transition + read-back; refusals become retry rows."""
from datetime import datetime, timezone

from sqlalchemy import select

from models import LimsSample


def test_retry_row_roundtrip(db_session):
    from models import LimsSenaiteTeeRetry
    row = LimsSample(sample_id="P-TEE-0", status="verified", external_lims_uid="U-TEE-0")
    db_session.add(row)
    db_session.flush()
    r = LimsSenaiteTeeRetry(lims_sample_pk=row.id, verb="publish", expected_state="published",
                            next_attempt_at=datetime.now(timezone.utc))
    db_session.add(r)
    db_session.flush()
    got = db_session.execute(select(LimsSenaiteTeeRetry)).scalar_one()
    assert (got.status, got.attempts, got.verb) == ("pending", 0, "publish")
