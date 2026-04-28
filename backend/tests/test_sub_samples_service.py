import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timedelta
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
# Note: use new ORM names from Task 3
from models import LimsSample, LimsSubSample
from sub_samples.service import ensure_sample_row, create_sub_sample, list_sub_samples
from sub_samples.senaite import SecondaryCreateResult, SecondaryFalloutError


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def _meta(uid="PARENT_UID", contact="CT_UID"):
    return {
        "uid": uid, "ClientUID": "C_UID", "ClientID": "client-8",
        "ContactUID": contact, "SampleType": "ST_UID",
        "Title": "P-0134", "review_state": "sample_registered",
    }


def _create_result(uid="UID1", sid="P-0134-S01"):
    return SecondaryCreateResult(uid=uid, sample_id=sid, path=f"/senaite/clients/client-8/{sid}")


def test_ensure_sample_row_creates_when_missing(db):
    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=_meta()):
        row = ensure_sample_row(db, "P-0134")
    assert row.sample_id == "P-0134"
    assert row.external_lims_uid == "PARENT_UID"
    assert row.contact_uid == "CT_UID"


def test_ensure_sample_row_returns_existing(db):
    db.add(LimsSample(sample_id="P-0134", external_lims_uid="PARENT_UID"))
    db.commit()
    with patch("sub_samples.service.senaite.fetch_parent_metadata") as m:
        row = ensure_sample_row(db, "P-0134")
    assert row.sample_id == "P-0134"
    m.assert_not_called()


def test_create_sub_sample_assigns_sequential_vial_numbers(db):
    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=_meta()), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", return_value=_create_result("UID1", "P-0134-S01")), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None), \
         patch("sub_samples.service.senaite.update_secondary_fields", return_value=None):
        ss1 = create_sub_sample(db, parent_sample_id="P-0134",
                                photo_bytes=b"abc", photo_filename="vial.jpg",
                                remarks=None, user_id=1)
    assert ss1.vial_sequence == 1

    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=_meta()), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", return_value=_create_result("UID2", "P-0134-S02")), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None), \
         patch("sub_samples.service.senaite.update_secondary_fields", return_value=None):
        ss2 = create_sub_sample(db, parent_sample_id="P-0134",
                                photo_bytes=b"def", photo_filename="vial.jpg",
                                remarks=None, user_id=1)
    assert ss2.vial_sequence == 2


def test_create_sub_sample_refuses_when_parent_has_no_contact(db):
    """Defense-in-depth #1: secondaries must inherit a Contact, otherwise update_remarks 400s later."""
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_meta(contact=None)):
        with pytest.raises(RuntimeError, match=r"contact"):
            create_sub_sample(db, parent_sample_id="P-0134",
                              photo_bytes=b"abc", photo_filename="vial.jpg",
                              remarks=None, user_id=1)
    assert db.query(LimsSubSample).count() == 0


def test_create_sub_sample_refreshes_stale_uid_then_retries(db):
    """Defense-in-depth #2: if the cached parent UID is stale, refetch and retry."""
    db.add(LimsSample(sample_id="P-0134", external_lims_uid="STALE_UID",
                      client_uid="C_UID", contact_uid="CT_UID", sample_type="ST_UID"))
    db.commit()
    fresh_meta = _meta(uid="FRESH_UID", contact="CT_UID")
    with patch("sub_samples.service.senaite.uid_exists", return_value=False) as ue, \
         patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=fresh_meta) as fpm, \
         patch("sub_samples.service.senaite.create_secondary",
               return_value=_create_result("UID1", "P-0134-S01")) as cs, \
         patch("sub_samples.service.senaite.upload_photo", return_value=None):
        sub = create_sub_sample(db, parent_sample_id="P-0134",
                                photo_bytes=b"abc", photo_filename="vial.jpg",
                                remarks=None, user_id=1)
    assert sub.vial_sequence == 1
    # fetch_parent_metadata is called twice now: once by _refresh_parent_from_senaite
    # (stale-cache recovery) and once by create_sub_sample's new field-inheritance
    # step. Both must hit the mock.
    assert fpm.call_count == 2
    cs.assert_called_once()
    # Verify the create call used the FRESH UID, not the stale one
    assert cs.call_args.kwargs["parent_uid"] == "FRESH_UID"


def test_create_sub_sample_propagates_fallthrough_with_orphan_info(db):
    """Defense-in-depth #3: surface orphan loudly."""
    fallout = SecondaryFalloutError("test fallout", orphan_uid="ORPHAN_UID", orphan_sample_id="P-0136")
    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=_meta()), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", side_effect=fallout):
        with pytest.raises(SecondaryFalloutError) as exc_info:
            create_sub_sample(db, parent_sample_id="P-0134",
                              photo_bytes=b"abc", photo_filename="vial.jpg",
                              remarks=None, user_id=1)
    assert exc_info.value.orphan_uid == "ORPHAN_UID"
    assert db.query(LimsSubSample).count() == 0


def test_create_sub_sample_compensates_on_photo_upload_failure(db):
    """If photo upload fails after create succeeded, delete the secondary so we don't leave a vial without a photo."""
    cr = _create_result("UID1", "P-0134-S01")
    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=_meta()), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", return_value=cr), \
         patch("sub_samples.service.senaite.upload_photo", side_effect=RuntimeError("upload boom")), \
         patch("sub_samples.service.senaite.update_secondary_fields", return_value=None), \
         patch("sub_samples.service.senaite.delete_secondary") as ds:
        with pytest.raises(RuntimeError):
            create_sub_sample(db, parent_sample_id="P-0134",
                              photo_bytes=b"abc", photo_filename="vial.jpg",
                              remarks=None, user_id=1)
    ds.assert_called_once_with("UID1")
    assert db.query(LimsSubSample).count() == 0


def test_create_sub_sample_inherits_custom_fields_from_parent(db):
    """Bug fix: ClientOrderNumber, Analyte*Peptide, Coa*, Profiles, etc. must
    copy from parent → secondary after create. SENAITE only natively inherits
    Client/Contact/SampleType/DateSampled."""
    fake_meta = {
        # Identity (used by ensure_sample_row + the new inheritance step)
        "uid": "PARENT_UID",
        "ClientUID": "C_UID",
        "ClientID": "client-8",
        "ContactUID": "CT_UID",
        "SampleType": "ST_UID",
        "Title": "P-0134",
        "review_state": "sample_received",
        # Inheritable Accumark-custom fields
        "ClientOrderNumber": "WP-3511",
        "ClientSampleID": "Semaglutide",
        "ClientLot": "LOT-001",
        "DeclaredTotalQuantity": "100.00",
        # Reference field — comes back as a dict from /complete=true
        "Analyte1Peptide": {"uid": "PEPTIDE_UID", "url": "/foo"},
        "Analyte2Peptide": "BPC-157 - Identity (HPLC)",  # plain string also OK
        # List of references
        "Profiles": [
            {"uid": "PROF_UID_1", "url": "/p1"},
            {"uid": "PROF_UID_2"},
        ],
        # COA fields
        "CoaCompanyName": "Jade Nexus",
        "CoaEmail": "lab@jade.example",
        "CoaWebsite": "https://jade.example",
        "CoaAddress": "123 Lab St",
        "CompanyLogoUrl": "/wp-content/uploads/logo.png",
        "ChromatographBackgroundUrl": "/wp-content/uploads/bg.png",
        "VerificationCode": "ABCD-1234",
        # Empty/blank values that should be skipped by extract_inheritable_fields
        "Analyte3Peptide": "",
        "Analyte4Peptide": None,
    }
    cr = _create_result("UID1", "P-0134-S01")
    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=fake_meta), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", return_value=cr), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None), \
         patch("sub_samples.service.senaite.update_secondary_fields") as upd:
        create_sub_sample(
            db, parent_sample_id="P-0134",
            photo_bytes=b"abc", photo_filename="vial.jpg",
            remarks=None, user_id=1,
        )
    upd.assert_called_once()
    # Signature: update_secondary_fields(secondary_uid, fields)
    args, kwargs = upd.call_args
    assert args[0] == "UID1"
    passed = args[1] if len(args) > 1 else kwargs.get("fields")
    # Scalar copies
    assert passed["ClientOrderNumber"] == "WP-3511"
    assert passed["ClientSampleID"] == "Semaglutide"
    assert passed["ClientLot"] == "LOT-001"
    assert passed["DeclaredTotalQuantity"] == "100.00"
    # Reference dict reduced to UID
    assert passed["Analyte1Peptide"] == "PEPTIDE_UID"
    assert passed["Analyte2Peptide"] == "BPC-157 - Identity (HPLC)"
    # List of dicts reduced to list of UIDs
    assert passed["Profiles"] == ["PROF_UID_1", "PROF_UID_2"]
    # COA block
    assert passed["CoaCompanyName"] == "Jade Nexus"
    assert passed["CoaEmail"] == "lab@jade.example"
    assert passed["CoaWebsite"] == "https://jade.example"
    assert passed["CoaAddress"] == "123 Lab St"
    assert passed["CompanyLogoUrl"] == "/wp-content/uploads/logo.png"
    assert passed["ChromatographBackgroundUrl"] == "/wp-content/uploads/bg.png"
    assert passed["VerificationCode"] == "ABCD-1234"
    # Empty / None values must NOT be copied
    assert "Analyte3Peptide" not in passed
    assert "Analyte4Peptide" not in passed


def test_create_sub_sample_field_inheritance_failure_does_not_abort(db):
    """Field inheritance is best-effort: if /update fails, vial is still
    created and no exception bubbles up to the caller."""
    cr = _create_result("UID1", "P-0134-S01")
    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=_meta()), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", return_value=cr), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None), \
         patch("sub_samples.service.senaite.update_secondary_fields",
               side_effect=RuntimeError("update boom")):
        sub = create_sub_sample(
            db, parent_sample_id="P-0134",
            photo_bytes=b"abc", photo_filename="vial.jpg",
            remarks=None, user_id=1,
        )
    assert sub.vial_sequence == 1
    assert db.query(LimsSubSample).count() == 1


def test_extract_inheritable_fields_handles_reference_shapes():
    """Unit test for the extraction helper — covers the dict/list/scalar
    shapes SENAITE returns from complete=true."""
    from sub_samples.senaite import extract_inheritable_fields

    out = extract_inheritable_fields({
        "ClientOrderNumber": "WP-1",
        "ClientSampleID": "",       # skipped
        "ClientLot": None,          # skipped
        "Analyte1Peptide": {"uid": "U1"},
        "Analyte2Peptide": {"uid": ""},  # skipped (empty uid)
        "Profiles": [{"uid": "P1"}, {"uid": "P2"}, {}, "P3"],
        "VerificationCode": "ABCD-1234",
        "NotInWhitelist": "ignored",  # not copied
    })
    assert out == {
        "ClientOrderNumber": "WP-1",
        "Analyte1Peptide": "U1",
        "Profiles": ["P1", "P2", "P3"],
        "VerificationCode": "ABCD-1234",
    }


