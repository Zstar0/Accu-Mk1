"""sample_meta producer (read-independence spec §2): envelope scalars in
AR-key spellings + attachment descriptors with explicit roles. Fail-closed:
empty matrix aborts; missing MK1_PUBLIC_BASE_URL aborts; senaite-storage
rows are invisible."""
import json
import os
import pytest
from unittest.mock import patch

from database import SessionLocal
from models import LimsSample, LimsParentAttachment
from coa.native_sections import NativeSectionsError
from coa.sample_meta import build_sample_meta, SAMPLE_META_SCALARS, ATTACHMENT_ROLES


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def parent(db):
    row = LimsSample(
        sample_id="TEST-SM-01", status="verified",
        sample_type_title="Peptide Blend", client_sample_id="CS-1",
        declared_total_quantity="20.0", client_lot="LOT-9",
        analytes=json.dumps({"1": {"label": "BPC-157"}, "2": {"label": "GHK-Cu"}}),
        coa_meta=json.dumps({"CoaCompanyName": "Acme", "CoaEmail": "a@b.c",
                             "CoaWebsite": "acme.io", "CoaAddress": "1 Way"}),
        company_logo_url="/wp-content/logo.png",
    )
    db.add(row); db.flush()
    img = LimsParentAttachment(
        lims_sample_pk=row.id, kind="receive_image", filename="img.png",
        content_type="image/png", storage="s3", storage_key="k1",
        render_in_report=True, attachment_type="Sample Image",
        created_by_user_id=None)
    csv = LimsParentAttachment(
        lims_sample_pk=row.id, kind="chromatogram", filename="chrom.csv",
        content_type="text/csv", storage="s3", storage_key="k2",
        render_in_report=False, attachment_type="HPLC Graph",
        created_by_user_id=None)
    db.add_all([img, csv]); db.flush()
    yield row, img, csv


ENV = {"MK1_PUBLIC_BASE_URL": "https://mk1.test"}


def test_scalars_use_ar_key_spellings(db, parent):
    row, img, csv = parent
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    assert meta["source"] == "mk1"
    assert meta["SampleID"] == "TEST-SM-01"
    assert meta["SampleTypeTitle"] == "Peptide Blend"
    assert meta["ClientSampleID"] == "CS-1"
    assert meta["DeclaredTotalQuantity"] == "20.0"
    assert meta["ClientLot"] == "LOT-9"
    assert meta["BatchID"] == "LOT-9"          # peptide-engine alias
    assert meta["Analyte1Peptide"] == "BPC-157"
    assert meta["Analyte2Peptide"] == "GHK-Cu"
    assert "Analyte3Peptide" not in meta        # absent slots omitted
    assert meta["CoaCompanyName"] == "Acme"
    for k in SAMPLE_META_SCALARS:
        assert k in meta or k in ("ChromatographBackgroundUrl",)  # nullable


def test_attachment_descriptors_roles_and_urls(db, parent):
    row, img, csv = parent
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    by_role = {a["role"]: a for a in meta["attachments"]}
    assert set(by_role) == {"sample_image", "chromatogram_csv"}
    assert set(by_role) <= ATTACHMENT_ROLES
    a = by_role["sample_image"]
    assert a["attachment_id"] == img.id
    assert a["content_type"] == "image/png"
    assert a["url"] == f"https://mk1.test/s2s/samples/TEST-SM-01/attachments/{img.id}"
    assert by_role["chromatogram_csv"]["attachment_id"] == csv.id


def test_newest_eligible_row_wins(db, parent):
    row, img, csv = parent
    newer = LimsParentAttachment(
        lims_sample_pk=row.id, kind="receive_image", filename="img2.png",
        content_type="image/png", storage="s3", storage_key="k3",
        render_in_report=True, attachment_type="Sample Image",
        created_by_user_id=None)
    db.add(newer); db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    by_role = {a["role"]: a for a in meta["attachments"]}
    assert by_role["sample_image"]["attachment_id"] == newer.id


def test_senaite_storage_rows_invisible(db, parent):
    row, img, csv = parent
    img.storage = "senaite"
    db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    roles = {a["role"] for a in meta["attachments"]}
    assert "sample_image" not in roles


def test_empty_matrix_aborts(db, parent):
    row, *_ = parent
    row.sample_type_title = ""
    db.flush()
    with patch.dict(os.environ, ENV), pytest.raises(NativeSectionsError):
        build_sample_meta(db, row)


def test_missing_base_url_aborts(db, parent):
    row, *_ = parent
    with patch.dict(os.environ, {"MK1_PUBLIC_BASE_URL": ""}), \
         pytest.raises(NativeSectionsError):
        build_sample_meta(db, row)
