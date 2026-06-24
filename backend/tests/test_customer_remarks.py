"""Customer remarks: parent-level customer-facing text delivered with the COA.
set_customer_remarks persists + audit-logs; ParentSampleSummary carries it."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from models import AuditLog, LimsSample
from sub_samples import senaite
from sub_samples.service import set_customer_remarks


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
def parent(db):
    p = LimsSample(sample_id="P-0700", external_lims_uid="uid-p0700")
    db.add(p)
    db.commit()
    return p


def test_set_and_update(db, parent):
    out = set_customer_remarks(db, "P-0700", "Sample shows minor degradation.", user_id=None)
    assert out["customer_remarks"] == "Sample shows minor degradation."
    db.refresh(parent)
    assert parent.customer_remarks == "Sample shows minor degradation."
    set_customer_remarks(db, "P-0700", "Updated text.", user_id=None)
    db.refresh(parent)
    assert parent.customer_remarks == "Updated text."


def test_clear_with_empty_string(db, parent):
    set_customer_remarks(db, "P-0700", "something", user_id=None)
    set_customer_remarks(db, "P-0700", "", user_id=None)
    db.refresh(parent)
    assert parent.customer_remarks == ""


def test_missing_row_is_lazily_created(db, monkeypatch):
    """Pre-1.0 parents have no lims_samples row. The first save must upsert the
    row from SENAITE metadata (ensure_sample_row) instead of 404ing — regression
    guard for prod P-0931 (2026-06-22)."""
    fake_meta = {"uid": "uid-p0931", "review_state": "published", "ClientID": "VALENCE"}
    monkeypatch.setattr(senaite, "fetch_parent_metadata", lambda sid: fake_meta)

    out = set_customer_remarks(db, "P-0931", "Non-conforming: RT delta > 0.2min.", user_id=None)

    assert out["customer_remarks"] == "Non-conforming: RT delta > 0.2min."
    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == "P-0931")
    ).scalar_one_or_none()
    assert row is not None
    assert row.customer_remarks == "Non-conforming: RT delta > 0.2min."
    # Published parent first-touch -> legacy mode, NOT container.
    assert row.container_mode is False


def test_missing_row_and_senaite_unreachable_raises_runtime_error(db, monkeypatch):
    """When the row is missing AND SENAITE can't be reached (or has no such AR),
    surface RuntimeError so the route maps it to 502 — not a misleading 404 or a
    silent 500."""
    def boom(sid):
        raise RuntimeError(f"SENAITE has no AR with id={sid}")
    monkeypatch.setattr(senaite, "fetch_parent_metadata", boom)

    with pytest.raises(RuntimeError):
        set_customer_remarks(db, "P-9999", "text", user_id=None)


def test_audit_log_written_without_full_text(db, parent):
    set_customer_remarks(db, "P-0700", "Confidential paragraph.", user_id=None)
    row = db.execute(
        select(AuditLog).where(
            AuditLog.operation == "customer_remarks_updated",
            AuditLog.entity_id == "P-0700",
        )
    ).scalars().first()
    assert row is not None
    # Audit details carry lengths, not the text itself
    assert "Confidential" not in str(row.details)
    assert row.details.get("new_length") == len("Confidential paragraph.")


def test_include_defaults_true(db, parent):
    set_customer_remarks(db, "P-0700", "Visible to customer.", user_id=None)
    db.refresh(parent)
    assert parent.customer_remarks_include is True


def test_include_false_persists(db, parent):
    out = set_customer_remarks(db, "P-0700", "Internal only.", include=False, user_id=None)
    assert out["customer_remarks_include"] is False
    db.refresh(parent)
    assert parent.customer_remarks_include is False


def test_include_flag_in_audit_details(db, parent):
    set_customer_remarks(db, "P-0700", "text", include=False, user_id=None)
    row = db.execute(
        select(AuditLog).where(
            AuditLog.operation == "customer_remarks_updated",
            AuditLog.entity_id == "P-0700",
        )
    ).scalars().first()
    assert row.details.get("include") is False
