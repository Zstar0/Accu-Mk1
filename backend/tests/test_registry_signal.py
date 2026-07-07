"""Slice-1 registry tests: schema, signal upsert, S2S endpoint, dual-write
(2026-07-06-registry-dual-write-program-design.md)."""
import json
import pytest
from datetime import datetime
from unittest.mock import patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsSample, LimsNativeIdSequence


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def test_new_columns_and_sequence_table_exist(db):
    row = LimsSample(
        sample_id="P-0134",
        client_title="forrest@valenceanalytical.com",
        contact_title="Forrest P",
        contact_email="f@example.com",
        sample_type_title="Peptide",
        date_created=datetime(2026, 2, 2, 3, 59, 29),
        verification_code="AB12-CD34",
        client_order_number="WP-3031",
        analytes=json.dumps([{"name": "BPC-157", "declared_quantity": "10.00"}]),
        declared_total_quantity="123.00",
        client_lot="123",
        client_reference="ref-1",
        company_logo_url="/wp-content/uploads/logo.jpg",
        coa_meta=json.dumps({"CoaCompanyName": "Ftest"}),
        native_id="aP-0001",
    )
    db.add(row)
    db.add(LimsNativeIdSequence(prefix="aP", next_value=2))
    db.commit()
    got = db.query(LimsSample).filter_by(sample_id="P-0134").one()
    assert got.native_id == "aP-0001"
    assert json.loads(got.analytes)[0]["declared_quantity"] == "10.00"
    assert db.query(LimsNativeIdSequence).get("aP").next_value == 2
