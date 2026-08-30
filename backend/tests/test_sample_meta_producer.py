"""sample_meta producer (read-independence spec §2): envelope scalars in
AR-key spellings + attachment descriptors with explicit roles. Fail-closed:
empty matrix aborts; missing MK1_PUBLIC_BASE_URL aborts; no eligible native
sample image aborts (Ruling R-13); senaite-storage rows are invisible."""
import json
import os
import pytest
from unittest.mock import patch

from database import SessionLocal
from models import LimsSample, LimsParentAttachment
from coa.native_sections import NativeSectionsError
from coa.sample_meta import build_sample_meta, SAMPLE_META_SCALARS, ATTACHMENT_ROLES
from sub_samples.service import _COA_META_FIELDS


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
        analytes=json.dumps([
            {"name": "BPC-157", "declared_quantity": "10.0"},
            {"name": "GHK-Cu", "declared_quantity": None},
        ]),
        # Real prod shape (final review C1): sub_samples/service.py's
        # _merge_coa_meta always writes EVERY _COA_META_FIELDS key, holding
        # None for anything the SENAITE payload didn't supply -- not an
        # absent key. Only CoaCompanyName was actually populated here,
        # mirroring the proven prod row (3 of 4 Coa* fields None).
        coa_meta=json.dumps({
            **{k: None for k in _COA_META_FIELDS},
            "CoaCompanyName": "Acme",
        }),
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
    # C1: the other three Coa* fields are stored None (real prod shape, not
    # an absent key) and must still render as "" on the wire, never null.
    assert meta["CoaEmail"] == ""
    assert meta["CoaWebsite"] == ""
    assert meta["CoaAddress"] == ""
    for k in SAMPLE_META_SCALARS:
        assert k in meta
    assert meta["ChromatographBackgroundUrl"] is None  # no watermark configured


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


def test_senaite_storage_chromatogram_invisible_no_abort(db, parent):
    """storage='senaite' rows are invisible (spec §2). Chromatogram absence
    stays non-fatal (C3/Ruling R-13) -- the sample image is still present,
    so this must NOT abort; the descriptor is simply absent."""
    row, img, csv = parent
    csv.storage = "senaite"
    db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    roles = {a["role"] for a in meta["attachments"]}
    assert "chromatogram_csv" not in roles
    assert "sample_image" in roles


def test_senaite_storage_image_invisible_aborts(db, parent):
    """A storage='senaite' sample-image row is treated as missing (spec
    §2) -- with no eligible s3 image row, C3/Ruling R-13 aborts exactly as
    if there were no row at all."""
    row, img, csv = parent
    img.storage = "senaite"
    db.flush()
    with patch.dict(os.environ, ENV), \
         pytest.raises(NativeSectionsError, match="no native sample image"):
        build_sample_meta(db, row)


def test_missing_sample_image_aborts(db, parent):
    """C3 / Ruling R-13: no eligible sample-image attachment row at all
    fail-closed aborts, naming the sample."""
    row, img, csv = parent
    db.delete(img)
    db.flush()
    with patch.dict(os.environ, ENV), \
         pytest.raises(NativeSectionsError, match="TEST-SM-01.*no native sample image"):
        build_sample_meta(db, row)


def test_missing_chromatogram_does_not_abort(db, parent):
    """C3 / Ruling R-13: chromatogram absence is non-fatal at the producer
    (micro-only samples legitimately lack one) -- the descriptor is simply
    absent from the attachments list, generation is not aborted."""
    row, img, csv = parent
    db.delete(csv)
    db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    roles = {a["role"] for a in meta["attachments"]}
    assert roles == {"sample_image"}


def test_all_null_coa_fields_render_empty_strings_not_none(db, parent):
    """C1 (final review): every Coa* scalar must serialize as "" on the
    wire when the stored coa_meta holds None for it -- never JSON null,
    which coab's non-nullable-scalar validator 422s on."""
    row, *_ = parent
    row.coa_meta = json.dumps({k: None for k in _COA_META_FIELDS})
    db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    assert meta["CoaCompanyName"] == ""
    assert meta["CoaEmail"] == ""
    assert meta["CoaWebsite"] == ""
    assert meta["CoaAddress"] == ""


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


# ── Review 2026-08-29, finding 2: the reportable-sidecar seam ────────────────
# analysis_reportable is keyed by SENAITE analysis UID; every mk1-mode
# candidate carries uid="mk1:{id}", so the sidecar lookup in
# coa/source_resolver._apply_reportable can never hit. A de-selection the lab
# made ("not fit to report") would therefore be silently ignored and the
# excluded result could ride onto a certificate. Until the flag has a native
# home, mk1 mode must refuse to certify such a sample rather than quietly
# disagree with the lab.


def test_deselected_sidecar_row_aborts_generation(db, parent):
    from models import AnalysisReportable
    row, _img, _csv = parent
    db.add(AnalysisReportable(
        sample_id=row.sample_id, analysis_uid="senaite-uid-1",
        reportable=False, reason="TEST: not fit to report"))
    db.flush()
    with patch.dict(os.environ, ENV):
        with pytest.raises(NativeSectionsError) as exc:
            build_sample_meta(db, row)
    detail = str(exc.value)
    assert "reportable" in detail.lower()
    assert "senaite-uid-1" in detail


def test_reportable_true_sidecar_row_does_not_abort(db, parent):
    """Only a de-selection is unhonourable — a reportable=True row states the
    default, so ignoring it changes nothing and must not block a certificate."""
    from models import AnalysisReportable
    row, _img, _csv = parent
    db.add(AnalysisReportable(
        sample_id=row.sample_id, analysis_uid="senaite-uid-2",
        reportable=True, reason="TEST: re-selected"))
    db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    assert meta["SampleID"] == row.sample_id


def test_other_samples_deselections_do_not_abort(db, parent):
    """The guard is sample-scoped — another sample's flag is irrelevant."""
    from models import AnalysisReportable
    row, _img, _csv = parent
    db.add(AnalysisReportable(
        sample_id="SOME-OTHER-SAMPLE", analysis_uid="senaite-uid-3",
        reportable=False, reason="TEST: unrelated"))
    db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    assert meta["SampleID"] == row.sample_id
