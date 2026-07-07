"""Slice-1 registry tests: schema, signal upsert, S2S endpoint, dual-write
(2026-07-06-registry-dual-write-program-design.md)."""
import json
import os
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


from sub_samples.service import upsert_sample_from_signal


def _signal_meta(**over):
    m = {
        "uid": "AR_UID_1",
        "ClientID": "client-8",
        "getClientTitle": "forrest@valenceanalytical.com",
        "ContactFullName": "Forrest P",
        "ContactEmail": "fp@example.com",
        "ClientUID": "C_UID",
        "ContactUID": "CT_UID",
        "SampleType": "ST_UID",
        "getSampleTypeTitle": "Peptide",
        "ClientSampleID": "CS-1",
        "ClientOrderNumber": "WP-3031",
        "Analyte1Peptide": "BPC-157",
        "Analyte1DeclaredQuantity": "10.00",
        "DeclaredTotalQuantity": "10.00",
        "created": "2026-07-06T01:00:00+00:00",
        "DateSampled": "2026-07-05T00:00:00+00:00",
    }
    m.update(over)
    return m


def test_signal_creates_row_and_mints_native_id(db):
    row = upsert_sample_from_signal(db, sample_id="P-2001",
                                    senaite_uid="AR_UID_1", meta=_signal_meta())
    assert row.sample_id == "P-2001"
    assert row.external_lims_uid == "AR_UID_1"
    assert row.native_id == "aP-0001"
    assert row.client_order_number == "WP-3031"
    # signal fires at order time -> pre-received -> container family,
    # matching the wizard's first-touch gate
    assert row.status == "sample_due"
    assert row.container_mode is True


def test_signal_is_idempotent_and_never_reminets(db):
    r1 = upsert_sample_from_signal(db, "P-2001", "AR_UID_1", _signal_meta())
    r2 = upsert_sample_from_signal(db, "P-2001", "AR_UID_1",
                                   _signal_meta(ClientSampleID="CS-9"))
    assert r2.id == r1.id
    assert r2.native_id == "aP-0001"          # minted once
    assert r2.client_sample_id == "CS-9"      # fields refreshed


def test_signal_does_not_clobber_existing_status(db):
    """A lazily-created row already tracks live state — the (stale-at-send)
    signal must not regress it."""
    db.add(LimsSample(sample_id="P-2002", status="sample_received"))
    db.commit()
    row = upsert_sample_from_signal(db, "P-2002", "AR_UID_2", _signal_meta(uid="AR_UID_2"))
    assert row.status == "sample_received"


def test_signal_senaite_free_form(db):
    row = upsert_sample_from_signal(db, sample_id=None, senaite_uid=None,
                                    meta=_signal_meta(uid=None))
    assert row.native_id == "aP-0001"
    assert row.sample_id == "aP-0001"          # native id IS the id (1F on-ramp)
    assert row.external_lims_uid is None
    assert row.external_lims_system == "mk1"


def test_senaite_free_retry_with_echoed_id_stays_native(db):
    first = upsert_sample_from_signal(db, sample_id=None, senaite_uid=None,
                                      meta=_signal_meta(uid=None))
    retry = upsert_sample_from_signal(db, sample_id=first.sample_id,
                                      senaite_uid=None, meta=_signal_meta(uid=None))
    assert retry.id == first.id
    assert retry.native_id == first.native_id          # never re-minted
    assert retry.external_lims_system == "mk1"          # identity preserved
    assert retry.external_lims_uid is None


def test_native_row_later_attached_to_senaite_keeps_uid(db):
    """If a signal DOES carry a senaite uid for a previously-native row,
    the attach wins (forward path for a line coming back onto SENAITE)."""
    first = upsert_sample_from_signal(db, sample_id=None, senaite_uid=None,
                                      meta=_signal_meta(uid=None))
    attached = upsert_sample_from_signal(db, sample_id=first.sample_id,
                                         senaite_uid="LATE_UID",
                                         meta=_signal_meta(uid="LATE_UID"))
    assert attached.external_lims_uid == "LATE_UID"
    assert attached.external_lims_system == "senaite"


def test_s2s_endpoint_rejects_missing_token():
    """No X-Service-Token -> rejected (S2S endpoint, never anonymous).

    require_internal_service_token (auth.py) 500s -- rather than 401ing --
    when ACCUMK1_INTERNAL_SERVICE_TOKEN isn't configured in the environment.
    This test container doesn't set it (the same gap independently fails
    test_variance_payload_endpoint.py's sibling test here), so patch it in
    for the duration of this call: that exercises the real
    missing-token/invalid-token branch instead of the misconfiguration
    branch, which is what actually proves the endpoint rejects an
    unauthenticated caller."""
    from fastapi.testclient import TestClient
    from main import app
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-secret"}):
        client = TestClient(app)
        resp = client.post("/s2s/lims-samples",
                           json={"sample_id": "P-1", "meta": {}})
    assert resp.status_code in (401, 403)


from sub_samples.service import apply_senaite_fields_to_row


def _seeded(db, **kw):
    row = LimsSample(sample_id="P-3001", external_lims_uid="U-3001", **kw)
    db.add(row)
    db.commit()
    return row


def test_field_mirror_maps_scalar_fields(db):
    _seeded(db)
    ok = apply_senaite_fields_to_row(db, "U-3001", {
        "ClientSampleID": "NEW-CS",
        "ClientLot": "LOT-9",
        "DeclaredTotalQuantity": "55.5",
        "CoaCompanyName": "NewCo",
        "VerificationCode": "ZZ99-YY88",
        "ClientOrderNumber": "WP-4000",
        "ClientReference": "r2",
        "CompanyLogoUrl": "/logo2.jpg",
    })
    assert ok is True
    row = db.query(LimsSample).filter_by(sample_id="P-3001").one()
    assert row.client_sample_id == "NEW-CS"
    assert row.client_lot == "LOT-9"
    assert row.declared_total_quantity == "55.5"
    assert json.loads(row.coa_meta)["CoaCompanyName"] == "NewCo"
    assert row.verification_code == "ZZ99-YY88"
    assert row.client_order_number == "WP-4000"
    assert row.client_reference == "r2"
    assert row.company_logo_url == "/logo2.jpg"


def test_field_mirror_merges_analyte_slot_edit(db):
    _seeded(db, analytes=json.dumps([
        {"name": "BPC-157", "declared_quantity": "10.00"},
        {"name": "GHK-Cu", "declared_quantity": "5.00"},
    ]), peptide_name="BPC-157")
    apply_senaite_fields_to_row(db, "U-3001", {"Analyte1Peptide": "TB-500"})
    row = db.query(LimsSample).filter_by(sample_id="P-3001").one()
    slots = json.loads(row.analytes)
    assert slots[0] == {"name": "TB-500", "declared_quantity": "10.00"}
    assert slots[1]["name"] == "GHK-Cu"        # untouched
    assert row.peptide_name == "TB-500"        # slot-1 back-compat follows


def test_field_mirror_coa_merge_preserves_other_keys(db):
    _seeded(db, coa_meta=json.dumps({"CoaAddress": "addr", "CoaCompanyName": "Old",
                                     "CoaEmail": None, "CoaWebsite": None}))
    apply_senaite_fields_to_row(db, "U-3001", {"CoaEmail": "c@x.com"})
    row = db.query(LimsSample).filter_by(sample_id="P-3001").one()
    meta = json.loads(row.coa_meta)
    assert meta["CoaEmail"] == "c@x.com" and meta["CoaAddress"] == "addr"


def test_field_mirror_noop_when_row_missing(db):
    assert apply_senaite_fields_to_row(db, "UNKNOWN-UID", {"ClientLot": "x"}) is False


def test_field_mirror_ignores_unmapped_fields(db):
    _seeded(db)
    ok = apply_senaite_fields_to_row(db, "U-3001", {"Remarks": "internal note"})
    assert ok is True   # row found; nothing mapped; no error
