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
from sub_samples import service


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


def test_create_sub_sample_compensates_on_photo_storage_failure(db):
    """Phase 2.5: if Mk1 photo storage fails after the SENAITE secondary was
    created, delete the secondary so we don't leave a vial without a photo."""
    cr = _create_result("UID1", "P-0134-S01")
    failing_storage = MagicMock()
    failing_storage.save_photo.side_effect = RuntimeError("disk full")
    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=_meta()), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", return_value=cr), \
         patch("sub_samples.photo_storage.get_storage", return_value=failing_storage), \
         patch("sub_samples.service.senaite.update_secondary_fields", return_value=None), \
         patch("sub_samples.service.senaite.delete_secondary") as ds:
        with pytest.raises(RuntimeError):
            create_sub_sample(db, parent_sample_id="P-0134",
                              photo_bytes=b"abc", photo_filename="vial.jpg",
                              remarks=None, user_id=1)
    ds.assert_called_once_with("UID1")
    assert db.query(LimsSubSample).count() == 0


def test_create_sub_sample_persists_mk1_uri_to_photo_external_uid(db):
    """Phase 2.5: photo_external_uid carries mk1://{key} (not the legacy
    SENAITE secondary-AR path) so the photo-fetch route can dispatch to
    Mk1 storage."""
    cr = _create_result("UID1", "P-0134-S01")
    fake_storage = MagicMock()
    fake_storage.save_photo.return_value = "P-0134-S01/deadbeef.png"
    with patch("sub_samples.service.senaite.fetch_parent_metadata", return_value=_meta()), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary", return_value=cr), \
         patch("sub_samples.photo_storage.get_storage", return_value=fake_storage), \
         patch("sub_samples.service.senaite.update_secondary_fields", return_value=None):
        sub = create_sub_sample(db, parent_sample_id="P-0134",
                                photo_bytes=b"\x89PNG", photo_filename="vial.png",
                                remarks=None, user_id=1)
    fake_storage.save_photo.assert_called_once_with(
        "P-0134-S01", b"\x89PNG", "vial.png",
    )
    assert sub.photo_external_uid == "mk1://P-0134-S01/deadbeef.png"


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


def _ok_response(json_body):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = json_body
    resp.raise_for_status = MagicMock()
    return resp


def _err_response(status_code):
    resp = MagicMock()
    resp.status_code = status_code
    resp.raise_for_status.side_effect = Exception(f"HTTP {status_code}")
    return resp


def test_fetch_sample_services_returns_dict(monkeypatch):
    monkeypatch.setenv("INTEGRATION_SERVICE_URL", "http://is.test")
    monkeypatch.setenv("ACCU_MK1_API_KEY", "test-key")
    monkeypatch.delenv("INTEGRATION_SERVICE_API_KEY", raising=False)
    body = {
        "services": {"endotoxin": True, "sterility_pcr": True, "bac_water_panel": True, "hplcpurity_identity": False, "samplevariance": False, "residualsolvents": False},
        "analytical_test": "Bacteriostatic Water",
        "wp_order_number": "3229",
    }
    with patch("sub_samples.service.requests.get", return_value=_ok_response(body)) as gp:
        result = service.fetch_sample_services("BW-0006")
    assert result["services"]["endotoxin"] is True
    assert result["wp_order_number"] == "3229"
    gp.assert_called_once()
    call_args = gp.call_args
    assert "BW-0006" in str(call_args)
    assert call_args.kwargs["headers"]["X-API-Key"] == "test-key"


def test_fetch_sample_services_returns_none_on_404(monkeypatch):
    monkeypatch.setenv("INTEGRATION_SERVICE_URL", "http://is.test")
    monkeypatch.setenv("ACCU_MK1_API_KEY", "test-key")
    monkeypatch.delenv("INTEGRATION_SERVICE_API_KEY", raising=False)
    resp = MagicMock()
    resp.status_code = 404
    with patch("sub_samples.service.requests.get", return_value=resp):
        result = service.fetch_sample_services("P-NOSUCH")
    assert result is None


def test_derive_demand_peptide_only():
    services = {"hplcpurity_identity": True, "endotoxin": False, "sterility_pcr": False, "bac_water_panel": False, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 1, "endo": 0, "ster": 0}


def test_derive_demand_bw_only():
    services = {"hplcpurity_identity": False, "endotoxin": False, "sterility_pcr": False, "bac_water_panel": True, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 1, "endo": 0, "ster": 0}


def test_derive_demand_endo_only():
    services = {"hplcpurity_identity": False, "endotoxin": True, "sterility_pcr": False, "bac_water_panel": False, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 0, "endo": 1, "ster": 0}


def test_derive_demand_ster_is_2_vials():
    services = {"hplcpurity_identity": False, "endotoxin": False, "sterility_pcr": True, "bac_water_panel": False, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 0, "endo": 0, "ster": 2}


def test_derive_demand_full_bw_all_addons():
    services = {"hplcpurity_identity": False, "endotoxin": True, "sterility_pcr": True, "bac_water_panel": True, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 1, "endo": 1, "ster": 2}


def test_derive_demand_handles_missing_keys():
    """Missing keys (older orders, partial WP responses) treat as False."""
    assert service.derive_demand({}) == {"hplc": 0, "endo": 0, "ster": 0}


def test_derive_demand_hplc_or_bw_panel():
    """HPLC bucket is satisfied by either flag; demand stays at 1 (not 2)."""
    services = {"hplcpurity_identity": True, "bac_water_panel": True, "endotoxin": False, "sterility_pcr": False, "samplevariance": False, "residualsolvents": False}
    assert service.derive_demand(services) == {"hplc": 1, "endo": 0, "ster": 0}


def _vial(sample_id, vial_seq, role=None, is_parent=False):
    return {
        "sample_id": sample_id,
        "vial_sequence": vial_seq,
        "is_parent": is_parent,
        "assignment_role": role,
    }


def test_auto_assign_full_bw_with_all_addons():
    """Parent → HPLC (already pinned), 3 sub-samples → ENDO, STER, STER."""
    demand = {"hplc": 1, "endo": 1, "ster": 2}
    vials = [
        _vial("BW-0006", 0, role="hplc", is_parent=True),
        _vial("BW-0006-S01", 1, role=None),
        _vial("BW-0006-S02", 2, role=None),
        _vial("BW-0006-S03", 3, role=None),
    ]
    result = service.auto_assign(vials, demand)
    assert [v["assignment_role"] for v in result] == ["hplc", "endo", "ster", "ster"]


def test_auto_assign_skips_existing_overrides():
    """A vial with an explicit role keeps it; demand is decremented if it
    matches a real bucket."""
    demand = {"hplc": 1, "endo": 1, "ster": 2}
    vials = [
        _vial("BW-0006", 0, role="hplc", is_parent=True),
        _vial("BW-0006-S01", 1, role="ster"),  # tech pre-assigned this to STER
        _vial("BW-0006-S02", 2, role=None),
        _vial("BW-0006-S03", 3, role=None),
    ]
    result = service.auto_assign(vials, demand)
    # S01 stays STER (user override), S02 fills remaining STER slot, S03 fills ENDO
    assert [v["assignment_role"] for v in result] == ["hplc", "ster", "ster", "endo"]


def test_auto_assign_surplus_vials_go_to_xtra():
    """Demand met → remaining vials land in xtra."""
    demand = {"hplc": 1, "endo": 0, "ster": 0}
    vials = [
        _vial("P-0139", 0, role="hplc", is_parent=True),
        _vial("P-0139-S01", 1, role=None),
        _vial("P-0139-S02", 2, role=None),
    ]
    result = service.auto_assign(vials, demand)
    assert [v["assignment_role"] for v in result] == ["hplc", "xtra", "xtra"]


def test_auto_assign_short_demand_leaves_unfilled():
    """If demand exceeds vials, the unfilled slots just... don't get a vial.
    auto_assign doesn't conjure phantom vials. (UI shows amber warning.)"""
    demand = {"hplc": 1, "endo": 1, "ster": 2}
    vials = [
        _vial("BW-0006", 0, role="hplc", is_parent=True),
        _vial("BW-0006-S01", 1, role=None),
    ]
    result = service.auto_assign(vials, demand)
    # Only 2 vials, but demand was 4. S01 → ENDO (priority order). HPLC met by parent.
    assert [v["assignment_role"] for v in result] == ["hplc", "endo"]


