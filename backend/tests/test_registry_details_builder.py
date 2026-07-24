"""Native details builder + DB-typed attachment download route
(read-flip Layer 4 / Task 2).

Builder tests use the in-memory `db_session` fixture (tests/conftest.py) --
self-contained, no live-DB seeding. Download-route tests use a StaticPool
sqlite TestClient (the test_native_remarks_read.py client idiom) plus a
tmp_path-backed FilesystemPhotoStorage (the test_sub_sample_attachments.py
storage idiom).

The IS DB is faked by patching integration_db.fetch_verification_codes_for_
samples (the test_registry_list.py idiom) -- module-level autouse default
returns {} so no builder test ever opens a real psycopg2 connection;
COA-specific tests re-patch inside their body.
"""
from __future__ import annotations

import json
from datetime import datetime
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base, get_db
from auth import get_current_user
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsParentAttachment,
    LimsSample,
    LimsSampleRemark,
)
from sub_samples.photo_storage import (
    FilesystemPhotoStorage,
    get_storage,
    set_storage_for_tests,
)

SID = "TEST-L4B-P1"


@pytest.fixture(autouse=True)
def _no_real_is_db():
    """Default every test to 'IS DB reachable, no codes found' so no test
    ever opens a real psycopg2 connection. COA tests re-patch inside."""
    with patch("integration_db.fetch_verification_codes_for_samples",
               return_value={}):
        yield


def _seed_full_sample(db, sample_id=SID, **overrides):
    kw = dict(
        sample_id=sample_id,
        external_lims_uid="UID-L4B-1",
        status="sample_received",
        client_title="RegistryCo",
        contact_title="Reg Contact",
        sample_type_title="Peptide",
        date_received=datetime(2026, 1, 1, 12, 0, 0),
        date_sampled=datetime(2026, 1, 2, 12, 0, 0),
        client_order_number="WP-3300",
        client_sample_id="CS-1",
        client_lot="LOT-9",
        declared_total_quantity="10",
        analytes=json.dumps([
            {"name": "BPC-157", "declared_quantity": "5"},
            {"name": "TB-500", "declared_quantity": None},
        ]),
        verification_code="OLD1-OLD1",
        coa_meta=json.dumps({
            "CoaAddress": "1 Lab Way",
            "CoaCompanyName": "Accumark",
            "CoaEmail": "lab@accumark.test",
            "CoaWebsite": "https://accumark.test",
        }),
        company_logo_url="https://accumark.test/logo.png",
    )
    kw.update(overrides)
    row = LimsSample(**kw)
    db.add(row)
    db.flush()
    return row


def _seed_analysis(db, parent, keyword="ANALYTE-1-PUR", title="Analyte 1 (Purity)",
                   review_state="verified", **kw):
    svc = AnalysisService(keyword=keyword, title=title)
    db.add(svc)
    db.flush()
    a = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=keyword,
        title=title,
        review_state=review_state,
        provenance="canonical",
        retested=False,
        **kw,
    )
    db.add(a)
    db.flush()
    return a


def _seed_attachment(db, parent, *, storage="s3", storage_key="k/x.png",
                     senaite_attachment_uid=None, filename="v-1.png",
                     content_type="image/png", attachment_type="Sample Image",
                     kind="vial_image"):
    att = LimsParentAttachment(
        lims_sample_pk=parent.id,
        kind=kind,
        filename=filename,
        content_type=content_type,
        storage=storage,
        storage_key=storage_key,
        senaite_attachment_uid=senaite_attachment_uid,
        attachment_type=attachment_type,
    )
    db.add(att)
    db.flush()
    return att


# ═══════════════════════════════════════════════════════════════════════════
# 1. Zero-SENAITE enforcement (spec §9 invariant 2) — FIRST, the binding one.
# ═══════════════════════════════════════════════════════════════════════════


def test_zero_senaite_http_builder_returns_complete_result(db_session):
    """SENAITE surfaces patched to raise on ANY use: httpx.AsyncClient (the
    async lookup client) and sub_samples.senaite._get (the sync requests
    wrapper). The builder must still return a complete result for a fully
    seeded sample — proving zero SENAITE HTTP end-to-end."""
    from sub_samples.registry_details import build_native_details

    parent = _seed_full_sample(db_session)
    db_session.add(LimsSampleRemark(lims_sample_pk=parent.id,
                                    content="<p>native remark</p>",
                                    author_label="native.author"))
    analysis = _seed_analysis(db_session, parent, result_value="98.5")
    s3_att = _seed_attachment(db_session, parent)
    db_session.flush()

    with patch("httpx.AsyncClient",
               side_effect=AssertionError("SENAITE HTTP attempted")), \
         patch("sub_samples.senaite._get",
               side_effect=AssertionError("SENAITE HTTP attempted")), \
         patch("integration_db.fetch_verification_codes_for_samples",
               return_value={SID: "NEWC-ODE1"}):
        res = build_native_details(db_session, SID)

    assert res.read_source == "mk1"
    assert res.registry_missing is False
    assert res.sample_id == SID
    assert res.sample_uid == "UID-L4B-1"
    assert res.client == "RegistryCo"
    assert res.contact == "Reg Contact"
    assert res.sample_type == "Peptide"
    assert res.date_received == "2026-01-01T12:00:00"
    assert res.date_sampled == "2026-01-02T12:00:00"
    assert res.client_order_number == "WP-3300"
    assert res.client_sample_id == "CS-1"
    assert res.client_lot == "LOT-9"
    assert res.declared_weight_mg == 10.0
    assert res.review_state == "sample_received"
    assert [a.raw_name for a in res.analytes] == ["BPC-157", "TB-500"]
    assert [a.uid for a in res.analyses] == [f"mk1:{analysis.id}"]
    assert [r.content for r in res.remarks] == ["<p>native remark</p>"]
    assert [a.uid for a in res.attachments] == [f"mk1att:{s3_att.id}"]
    assert res.coa.verification_code == "NEWC-ODE1"
    assert res.published_coa is None
    assert res.cached_at is not None


# ═══════════════════════════════════════════════════════════════════════════
# 2. Analytes adapter (registry JSON → typed SenaiteAnalyte)
# ═══════════════════════════════════════════════════════════════════════════


def test_analytes_adapter_well_formed():
    from sub_samples.registry_details import analytes_from_registry_json

    out = analytes_from_registry_json(json.dumps([
        {"name": "BPC-157", "declared_quantity": "5"},
        {"name": "TB-500", "declared_quantity": None},
    ]))
    assert len(out) == 2
    assert out[0].raw_name == "BPC-157"
    assert out[0].slot_number == 1
    assert out[0].declared_quantity == 5.0
    assert out[0].matched_peptide_id is None
    assert out[0].matched_peptide_name is None
    assert out[1].raw_name == "TB-500"
    assert out[1].slot_number == 2
    assert out[1].declared_quantity is None


def test_analytes_adapter_empty_and_malformed_to_empty_list():
    from sub_samples.registry_details import analytes_from_registry_json

    assert analytes_from_registry_json(None) == []
    assert analytes_from_registry_json("") == []
    assert analytes_from_registry_json("{not json") == []
    assert analytes_from_registry_json('{"a": 1}') == []  # non-list


def test_analytes_adapter_skips_bad_entries_preserves_positions():
    """slot_number is the 1-based position in the STORED list (the original
    SENAITE slot index isn't persisted); a bad entry is skipped but still
    consumes its position so surviving entries keep their slots."""
    from sub_samples.registry_details import analytes_from_registry_json

    out = analytes_from_registry_json(json.dumps([
        {"junk": 1},                                   # no name → skipped
        {"name": "X", "declared_quantity": "abc"},     # unparseable qty → None
        "not-a-dict",                                  # skipped
        {"name": "Y", "declared_quantity": 7},         # numeric qty ok
    ]))
    assert [(a.raw_name, a.slot_number, a.declared_quantity) for a in out] == [
        ("X", 2, None),
        ("Y", 4, 7.0),
    ]


# ═══════════════════════════════════════════════════════════════════════════
# 3. Attachments mapping (uid fallback + download_url routing per storage)
# ═══════════════════════════════════════════════════════════════════════════


def test_attachments_mapping_both_storages_and_uid_fallback(db_session):
    from sub_samples.registry_details import build_native_details

    parent = _seed_full_sample(db_session)
    s3_row = _seed_attachment(db_session, parent, storage="s3",
                              storage_key="k/a.png", filename="a.png")
    sen_row = _seed_attachment(db_session, parent, storage="senaite",
                               storage_key=None,
                               senaite_attachment_uid="ABC123",
                               filename="b.png", kind="manual",
                               attachment_type="HPLC Graph",
                               content_type="text/csv")
    sen_no_uid = _seed_attachment(db_session, parent, storage="senaite",
                                  storage_key=None, filename="c.png",
                                  kind="manual")
    db_session.flush()

    res = build_native_details(db_session, SID)
    by_uid = {a.uid: a for a in res.attachments}

    # s3 row: mk1att uid fallback + the new native download route
    a = by_uid[f"mk1att:{s3_row.id}"]
    assert a.download_url == (
        f"/registry/sample/{SID}/attachments/{s3_row.id}/download")
    assert a.filename == "a.png"
    assert a.content_type == "image/png"
    assert a.attachment_type == "Sample Image"

    # senaite row with uid: SENAITE uid + the existing proxy URL
    b = by_uid["ABC123"]
    assert b.download_url == "/wizard/senaite/attachment/ABC123"
    assert b.content_type == "text/csv"
    assert b.attachment_type == "HPLC Graph"

    # senaite row without an adopted uid: mk1att fallback, no reachable URL
    c = by_uid[f"mk1att:{sen_no_uid.id}"]
    assert c.download_url is None


# ═══════════════════════════════════════════════════════════════════════════
# 4. COA blocks (IS-DB overlay / stored fallback / unavailable) +
#    published_coa stays senaite-era
# ═══════════════════════════════════════════════════════════════════════════


def test_coa_block_is_db_code_wins_and_meta_from_registry(db_session):
    from sub_samples.registry_details import build_native_details

    _seed_full_sample(db_session)
    with patch("integration_db.fetch_verification_codes_for_samples",
               return_value={SID: "NEWC-ODE1"}) as m:
        res = build_native_details(db_session, SID)

    m.assert_called_once_with([SID])
    assert res.coa.verification_code == "NEWC-ODE1"
    assert res.coa.company_name == "Accumark"
    assert res.coa.email == "lab@accumark.test"
    assert res.coa.website == "https://accumark.test"
    assert res.coa.address == "1 Lab Way"
    assert res.coa.company_logo_url == "https://accumark.test/logo.png"
    assert res.field_sources["coa"] == "mk1"
    # ARReport artifacts stay SENAITE-era until the COABuilder re-wire
    assert res.published_coa is None
    assert res.field_sources["published_coa"] == "senaite"


def test_coa_block_falls_back_to_stored_code_when_is_has_none(db_session):
    from sub_samples.registry_details import build_native_details

    _seed_full_sample(db_session)  # autouse patch returns {}
    res = build_native_details(db_session, SID)
    assert res.coa.verification_code == "OLD1-OLD1"
    assert res.field_sources["coa"] == "mk1"


def test_coa_block_empty_and_honest_when_is_db_unavailable(db_session):
    from sub_samples.registry_details import build_native_details

    _seed_full_sample(db_session)
    with patch("integration_db.fetch_verification_codes_for_samples",
               side_effect=RuntimeError("IS db down")):
        res = build_native_details(db_session, SID)

    # never raises; empty block + honest tag (task brief binding behavior)
    assert res.coa.model_dump() == {
        "company_logo_url": None, "chromatograph_background_url": None,
        "company_name": None, "email": None, "website": None,
        "address": None, "verification_code": None,
    }
    assert res.field_sources["coa"] == "unavailable"


# ═══════════════════════════════════════════════════════════════════════════
# 5. registry_missing path + field_sources completeness
# ═══════════════════════════════════════════════════════════════════════════


def test_registry_missing_returns_complete_empty_result(db_session):
    from sub_samples.registry_details import build_native_details

    res = build_native_details(db_session, "NO-SUCH-SAMPLE")
    assert res.registry_missing is True
    assert res.read_source == "mk1"
    assert res.sample_id == "NO-SUCH-SAMPLE"
    assert res.analytes == []
    assert res.analyses == []
    assert res.remarks == []
    assert res.attachments == []
    assert res.published_coa is None
    assert res.senaite_url is None
    assert res.cached_at is not None


def test_field_sources_cover_every_lookup_field(db_session):
    """Every SenaiteLookupResult data field is accounted for in
    field_sources, on both the present and the missing path."""
    from sub_samples.lookup_models import SenaiteLookupResult
    from sub_samples.registry_details import build_native_details

    expected = set(SenaiteLookupResult.model_fields.keys())

    missing = build_native_details(db_session, "NO-SUCH-SAMPLE")
    assert set(missing.field_sources.keys()) == expected

    _seed_full_sample(db_session)
    present = build_native_details(db_session, SID)
    assert set(present.field_sources.keys()) == expected
    # spot-check the vocabulary
    assert present.field_sources["client"] == "mk1"
    assert present.field_sources["remarks"] == "mk1"
    assert present.field_sources["analyses"] == "mk1"
    assert present.field_sources["attachments"] == "mk1"
    assert present.field_sources["senaite_url"] == "unavailable"


# ═══════════════════════════════════════════════════════════════════════════
# 6. Remarks helper move: main re-export stays wired (L2 call sites)
# ═══════════════════════════════════════════════════════════════════════════


def test_native_remarks_helper_reexported_into_main():
    import main
    from sub_samples import registry_details
    assert main._native_sample_remarks is registry_details.native_sample_remarks


# ═══════════════════════════════════════════════════════════════════════════
# 7. Download route: DB-typed headers (binding constraint 1), storage
#    dispatch, 404 paths
# ═══════════════════════════════════════════════════════════════════════════


@pytest.fixture
def client():
    import main
    engine = create_engine("sqlite://",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[get_current_user] = (
        lambda: {"email": "a@x", "role": "standard"})
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()


@pytest.fixture
def storage(tmp_path):
    prev = get_storage()
    fs = FilesystemPhotoStorage(root=str(tmp_path))
    set_storage_for_tests(fs)
    yield fs
    set_storage_for_tests(prev)


def _seed_route_attachment(client, *, storage_key, content_type, filename,
                           storage="s3", senaite_attachment_uid=None):
    db = client._Session()
    parent = LimsSample(sample_id=SID, external_lims_uid="UID-L4B-1",
                        status="sample_received")
    db.add(parent)
    db.flush()
    att = LimsParentAttachment(
        lims_sample_pk=parent.id, kind="chromatogram",
        filename=filename, content_type=content_type,
        storage=storage, storage_key=storage_key,
        senaite_attachment_uid=senaite_attachment_uid,
        attachment_type="HPLC Graph",
    )
    db.add(att)
    db.commit()
    db.refresh(att)
    att_id = att.id
    db.close()
    return att_id


def test_download_content_type_from_db_never_key_extension(client, storage):
    """THE binding case: a chromatogram snapshot keys as '.bin' (csv is not
    a known image extension in photo_storage) but the row says text/csv —
    the response must carry text/csv + the row's filename, never anything
    derived from the storage key."""
    csv_bytes = b"time,mAU\n0.1,42\n"
    key = storage.save_photo(SID, csv_bytes, "chromatogram.csv")
    assert key.endswith(".bin")  # premise of the trap

    att_id = _seed_route_attachment(
        client, storage_key=key, content_type="text/csv",
        filename="chromatogram_TEST.csv")

    r = client.get(f"/registry/sample/{SID}/attachments/{att_id}/download")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"] == (
        'inline; filename="chromatogram_TEST.csv"')
    assert r.content == csv_bytes


def test_download_null_content_type_falls_back_to_octet_stream(client, storage):
    key = storage.save_photo(SID, b"bytes", "blob.xyz")
    att_id = _seed_route_attachment(
        client, storage_key=key, content_type=None, filename="blob.xyz")

    r = client.get(f"/registry/sample/{SID}/attachments/{att_id}/download")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/octet-stream")


def test_download_senaite_storage_rows_404_with_proxy_hint(client, storage):
    att_id = _seed_route_attachment(
        client, storage_key=None, content_type="image/png",
        filename="old.png", storage="senaite",
        senaite_attachment_uid="ABC123")

    r = client.get(f"/registry/sample/{SID}/attachments/{att_id}/download")
    assert r.status_code == 404
    assert "/wizard/senaite/attachment/" in r.json()["detail"]


def test_download_missing_object_404(client, storage):
    att_id = _seed_route_attachment(
        client, storage_key=f"{SID}/deadbeef.bin", content_type="text/csv",
        filename="gone.csv")

    r = client.get(f"/registry/sample/{SID}/attachments/{att_id}/download")
    assert r.status_code == 404


def test_download_wrong_sample_or_unknown_id_404(client, storage):
    key = storage.save_photo(SID, b"bytes", "a.png")
    att_id = _seed_route_attachment(
        client, storage_key=key, content_type="image/png", filename="a.png")

    r = client.get(f"/registry/sample/OTHER-SAMPLE/attachments/{att_id}/download")
    assert r.status_code == 404
    r = client.get(f"/registry/sample/{SID}/attachments/999999/download")
    assert r.status_code == 404
