"""Vendor via the IS creation signal: written on create, kept on vendor-less replay,
never touched by _populate_basic_info (reconcile/backfill safety)."""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models import Base, LimsSample
from sub_samples.service import upsert_sample_from_signal, _populate_basic_info


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


META = {"ClientOrderNumber": "6642", "review_state": "sample_due"}


def test_signal_create_writes_vendor():
    db = _session()
    row = upsert_sample_from_signal(db, "P-9100", None, {**META, "VendorName": "Acme Peptide Co"})
    assert row.vendor_name == "Acme Peptide Co"


def test_vendorless_replay_keeps_prior_vendor():
    db = _session()
    upsert_sample_from_signal(db, "P-9101", None, {**META, "VendorName": "Acme Peptide Co"})
    row = upsert_sample_from_signal(db, "P-9101", None, dict(META))  # replay, no vendor
    assert row.vendor_name == "Acme Peptide Co"


def test_replay_with_vendor_updates_it():
    db = _session()
    upsert_sample_from_signal(db, "P-9102", None, {**META, "VendorName": "Old Vendor"})
    row = upsert_sample_from_signal(db, "P-9102", None, {**META, "VendorName": "New Vendor"})
    assert row.vendor_name == "New Vendor"


def test_populate_basic_info_never_writes_logistics():
    db = _session()
    row = LimsSample(sample_id="P-9103", vendor_name="Keep Me",
                     shipping_carrier="UPS", tracking_number="1Z1", tracking_url="https://x/1Z1")
    db.add(row)
    db.flush()
    _populate_basic_info(row, {"VendorName": "EVIL OVERWRITE", "review_state": "sample_received"})
    assert row.vendor_name == "Keep Me"
    assert row.shipping_carrier == "UPS"
    assert row.tracking_number == "1Z1"
    assert row.tracking_url == "https://x/1Z1"
