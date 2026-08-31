"""Logistics columns (Slice A 2026-08-27): vendor at creation, shipping via s2s update."""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models import Base, LimsSample


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_lims_samples_has_logistics_columns():
    db = _session()
    row = LimsSample(
        sample_id="P-9001",
        vendor_name="Acme Peptide Co",
        shipping_carrier="UPS",
        tracking_number="1Z999AA10123456784",
        tracking_url="https://www.ups.com/track?tracknum=1Z999AA10123456784",
    )
    db.add(row)
    db.commit()
    got = db.query(LimsSample).filter_by(sample_id="P-9001").one()
    assert got.vendor_name == "Acme Peptide Co"
    assert got.shipping_carrier == "UPS"
    assert got.tracking_number == "1Z999AA10123456784"
    assert got.tracking_url.endswith("1Z999AA10123456784")


def test_logistics_columns_default_null():
    db = _session()
    db.add(LimsSample(sample_id="P-9002"))
    db.commit()
    got = db.query(LimsSample).filter_by(sample_id="P-9002").one()
    assert got.vendor_name is None
    assert got.shipping_carrier is None
    assert got.tracking_number is None
    assert got.tracking_url is None
