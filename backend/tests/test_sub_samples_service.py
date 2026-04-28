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
         patch("main._do_senaite_parent_receive"):
        ss1 = create_sub_sample(db, parent_sample_id="P-0134",
                                photo_bytes=b"abc", photo_filename="vial.jpg",
                                remarks=None, user_id=1)
    assert ss1.vial_sequence == 1

    with patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", return_value=_create_result("UID2", "P-0134-S02")), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None):
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
         patch("sub_samples.service.senaite.upload_photo", return_value=None), \
         patch("main._do_senaite_parent_receive"):
        sub = create_sub_sample(db, parent_sample_id="P-0134",
                                photo_bytes=b"abc", photo_filename="vial.jpg",
                                remarks=None, user_id=1)
    assert sub.vial_sequence == 1
    fpm.assert_called_once()
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
         patch("sub_samples.service.senaite.delete_secondary") as ds:
        with pytest.raises(RuntimeError):
            create_sub_sample(db, parent_sample_id="P-0134",
                              photo_bytes=b"abc", photo_filename="vial.jpg",
                              remarks=None, user_id=1)
    ds.assert_called_once_with("UID1")
    assert db.query(LimsSubSample).count() == 0


def test_first_vial_transitions_parent_when_pre_received(db):
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_meta()), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary",
               return_value=_create_result("UID1", "P-0134-S01")), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None), \
         patch("main._do_senaite_parent_receive") as transition:
        create_sub_sample(db, "P-0134", b"abc", "vial.jpg", None, 1)
    transition.assert_called_once()


def test_subsequent_vial_does_not_re_transition_parent(db):
    parent = LimsSample(sample_id="P-0134", external_lims_uid="PARENT_UID",
                        client_uid="C_UID", contact_uid="CT_UID",
                        sample_type="ST_UID", status="sample_received")
    db.add(parent); db.flush()
    db.add(LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="UID1",
                         sample_id="P-0134-S01", vial_sequence=1))
    db.commit()
    with patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary",
               return_value=_create_result("UID2", "P-0134-S02")), \
         patch("sub_samples.service.senaite.upload_photo", return_value=None), \
         patch("main._do_senaite_parent_receive") as transition:
        create_sub_sample(db, "P-0134", b"def", "vial.jpg", None, 1)
    transition.assert_not_called()
