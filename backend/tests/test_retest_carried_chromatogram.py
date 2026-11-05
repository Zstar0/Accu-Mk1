"""A retest that carries HPLC files the source vial's chromatogram on itself at
mint (PB-1179, 2026-11-04). It has no HPLC vial, prep or trace of its own and the
COA gate reads only its own attachments. The pick is the one the original's own
COA makes, read-only on the original. Never "the original's newest file": PB-1141's
only CSV came from its variance vial S04 while the carried results came from S01."""
from sqlalchemy import select

import pytest

from coa.sample_meta import select_chromatogram_row
from hplc_csv import build_chromatogram_csv
from lims_analyses import retest_carry
from lims_analyses.retest_carry import apply_retest_spec, carried_hplc_source_vials
from models import (
    AnalysisProfile,
    AnalysisService,
    HPLCAnalysis,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsParentAttachment,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
    Peptide,
    VialRole,
)
from sub_samples.photo_storage import get_storage, set_storage_for_tests

HPLC_KEY = "hplc-purity-identity"
HM_KEY = "heavy_metals"
ENDO_KEY = "endotoxin-usp85-lal"
BW_KEY = "bac_water_panel"
TRACE = {"times": [0.0, 0.1], "signals": [1.0, 2.5]}


class _FakeStorage:
    def __init__(self, *, save_error=None):
        self.saved = []
        self.photos = {}
        self.save_error = save_error

    def save_photo(self, sample_id, photo_bytes, filename):
        if self.save_error:
            raise self.save_error
        self.saved.append((sample_id, photo_bytes, filename))
        return f"fake/{sample_id}/{filename}"

    def fetch_photo(self, key):
        return self.photos[key]


@pytest.fixture
def storage():
    prev = get_storage()
    fake = _FakeStorage()
    set_storage_for_tests(fake)
    yield fake
    set_storage_for_tests(prev)


@pytest.fixture
def cat(db_session):
    db = db_session
    hplc = AnalysisProfile(key=HPLC_KEY, name="HPLC", is_addon=False, vials_required=1,
                           fulfillment_role="hplc", fulfillment_dim="role", active=True)
    hm = AnalysisProfile(key=HM_KEY, name="Heavy Metals", is_addon=True, vials_required=1,
                         fulfillment_role="hm", fulfillment_dim="role", active=True)
    endo = AnalysisProfile(key=ENDO_KEY, name="Endotoxin", is_addon=True, vials_required=1,
                           fulfillment_role="endo85", fulfillment_dim="role", active=True)
    bw = AnalysisProfile(key=BW_KEY, name="Bac Water", is_addon=False, vials_required=1,
                         fulfillment_role="hplc", fulfillment_dim="role", active=True)
    pur = AnalysisService(title="Purity", keyword="HPLC-PURITY", origin="mk1")
    qty = AnalysisService(title="Quantity", keyword="HPLC-QUANTITY", origin="mk1")
    arsenic = AnalysisService(title="Arsenic", keyword="ARSENIC-PPM", origin="mk1")
    lal = AnalysisService(title="Endotoxin", keyword="ENDOTOXIN-USP85LAL", origin="mk1")
    benzyl = AnalysisService(title="Benzyl Alcohol", keyword="BENZYL", origin="mk1")
    db.add_all([hplc, hm, endo, bw, pur, qty, arsenic, lal, benzyl,
                VialRole(code="hplc", label="HPLC", sort_order=0),
                VialRole(code="hm", label="Heavy Metals", sort_order=1),
                VialRole(code="endo85", label="Endotoxin", sort_order=2)])
    db.flush()
    hplc.analysis_services.extend([pur, qty])
    hm.analysis_services.append(arsenic)
    endo.analysis_services.append(lal)
    bw.analysis_services.append(benzyl)
    db.flush()
    return {"pur": pur, "qty": qty, "arsenic": arsenic, "benzyl": benzyl,
            "hplc": hplc, "hm": hm, "endo": endo, "bw": bw}


def _original(db, cat, *, profiles=("hplc", "hm", "endo")):
    row = LimsSample(sample_id="PB-1141", external_lims_system="mk1", status="verified",
                     catalog_snapshot={"profiles": [
                         {"key": cat[p].key, "profile_id": cat[p].id} for p in profiles]})
    db.add(row)
    db.flush()
    return row


def _vial(db, parent, seq, *, role="hplc", kind="core"):
    row = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", parent_sample_pk=parent.id,
                        vial_sequence=seq, external_lims_uid=f"uid-{parent.sample_id}-{seq}",
                        assignment_role=role, assignment_kind=kind)
    db.add(row)
    db.flush()
    return row


def _verified(db, parent, vial, svc, value="99.6"):
    """A verified parent row promoted from `vial`: what a carry copies."""
    src = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id, keyword=svc.keyword,
                       title=svc.title, review_state="promoted", result_value=value)
    row = LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword=svc.keyword,
                       title=svc.title, provenance="canonical", review_state="verified",
                       result_value=value)
    db.add_all([src, row])
    db.flush()
    db.add(LimsAnalysisPromotion(parent_analysis_id=row.id, source_analysis_id=src.id,
                                 contribution_kind="chosen"))
    db.flush()


def _trace(db, label, chrom=None):
    pep = db.execute(select(Peptide).where(Peptide.abbreviation == "PEP")).scalar_one_or_none()
    if pep is None:
        pep = Peptide(name="pep", abbreviation="PEP")
        db.add(pep)
        db.flush()
    row = HPLCAnalysis(sample_id_label=label, peptide_id=pep.id, stock_vial_empty=1.0,
                       stock_vial_with_diluent=2.0, dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
                       dil_vial_with_diluent_and_sample=3.0, chromatogram_data=chrom or TRACE)
    db.add(row)
    db.flush()
    return row


def _file(db, parent, vial=None, name=None, key="k"):
    row = LimsParentAttachment(
        lims_sample_pk=parent.id, kind="chromatogram",
        source_sub_sample_pk=vial.id if vial else None,
        filename=name or f"chromatogram_{(vial or parent).sample_id}.csv",
        content_type="text/csv", storage="s3", storage_key=key,
        render_in_report=False, attachment_type="HPLC Graph")
    db.add(row)
    db.flush()
    return row


def _mint(db, *, carry=(HPLC_KEY,), retest=None):
    retest = retest or LimsSample(sample_id="PB-1179", external_lims_system="mk1", status="sample_due")
    db.add(retest)
    db.flush()
    out = apply_retest_spec(
        db, parent=retest, source="test", package=None,
        services={ENDO_KEY: True},
        raw_spec={"retest_of_sample_id": "PB-1141", "retest": [ENDO_KEY], "carry": list(carry),
                  "add": {"profiles": [], "variance_points": 0, "additional_vials": 0},
                  "auto_checkin": False, "fee": "free", "reason": "wrong cartridge",
                  "requested_by_user_id": 5, "requested_at": "2026-11-04T20:51:00Z"})
    db.commit()
    return retest, out


def _atts(db, sample):
    return db.execute(select(LimsParentAttachment).where(
        LimsParentAttachment.lims_sample_pk == sample.id).order_by(LimsParentAttachment.id)).scalars().all()


def _events(db, sample, name):
    return db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == sample.id, LimsSubSampleEvent.event == name)).scalars().all()


def _warnings(db, sample):
    """Chromatogram warnings only: a carry of part of the snapshot also warns profiles_dropped."""
    return [e for e in _events(db, sample, "retest_spec_warning")
            if e.details["reason"] == "chromatogram_not_carried"]


def test_pb1141_shape_files_the_source_vials_trace_and_not_the_variance_csv(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s01, s04 = _vial(db, original, 1), _vial(db, original, 4, kind="variance")
    _verified(db, original, s01, cat["pur"])
    variance_csv = _file(db, original, s04)      # the original's only, and newest, file
    _trace(db, s01.sample_id, {"times": [0.0], "signals": [9.0]})
    newest = _trace(db, s01.sample_id)
    _trace(db, s04.sample_id, {"times": [0.0], "signals": [7.0]})

    retest, out = _mint(db)

    assert out["applied"] is True and out["carried"] == 1
    [row] = _atts(db, retest)
    assert (row.kind, row.attachment_type, row.content_type, row.storage) == (
        "chromatogram", "HPLC Graph", "text/csv", "s3")
    assert row.filename == "chromatogram_PB-1141-S01.csv"
    assert row.render_in_report is False and row.source_sub_sample_pk is None
    assert storage.saved == [("PB-1179", build_chromatogram_csv(newest), row.filename)]
    # The original is read, never written.
    assert [a.id for a in _atts(db, original)] == [variance_csv.id]
    # The COA picks it, and the stamp the row can't hold lives on the event.
    assert select_chromatogram_row(db, retest).id == row.id
    [event] = _events(db, retest, "chromatogram_carried")
    assert event.details["source_vial"] == "PB-1141-S01"
    assert event.details["hplc_analysis_id"] == newest.id
    assert event.details["attachment_id"] == row.id
    assert _warnings(db, retest) == []


def test_row_stamped_with_the_source_vial_is_copied_byte_for_byte(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    stamped = _file(db, original, s01, name="chromatogram_PB-1141-S01.csv", key="orig-key")
    storage.photos["orig-key"] = b"0.0,1.0\n"
    _trace(db, s01.sample_id)                    # the stamped row wins, as on the original's COA

    retest, _ = _mint(db)

    [row] = _atts(db, retest)
    assert storage.saved == [("PB-1179", b"0.0,1.0\n", "chromatogram_PB-1141-S01.csv")]
    assert row.filename == "chromatogram_PB-1141-S01.csv"
    [event] = _events(db, retest, "chromatogram_carried")
    assert event.details["attachment_id"] == row.id
    assert event.details["source_attachment_id"] == stamped.id


def test_non_variance_source_uses_the_csv_uploaded_on_the_sample_page(db_session, cat, storage):
    """Handler ruling 2026-10-23: one HPLC vial, so a sample-level file can only be that vial's."""
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    _file(db, original, name="PB-1141-S01_Inj_1.dx_DAD1A.CSV", key="upload-key")
    storage.photos["upload-key"] = b"0.0,2.0\n"

    retest, _ = _mint(db)

    [row] = _atts(db, retest)
    assert row.filename == "PB-1141-S01_Inj_1.dx_DAD1A.CSV"
    assert storage.saved == [("PB-1179", b"0.0,2.0\n", row.filename)]


def test_variance_source_with_no_own_media_files_nothing_and_warns(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s01, s04 = _vial(db, original, 1), _vial(db, original, 4, kind="variance")
    _verified(db, original, s01, cat["pur"])
    _file(db, original, s04)                     # a sibling's
    _file(db, original)                          # could be any vial's

    retest, out = _mint(db)

    assert out["applied"] is True
    assert _atts(db, retest) == [] and storage.saved == []
    [warning] = _warnings(db, retest)
    assert "PB-1141-S01" in warning.details["message"]
    retest_carry._carry_chromatogram(db, retest=retest, user_id=None)   # a later carry says it once
    assert len(_warnings(db, retest)) == 1


def test_results_from_two_vials_file_nothing_and_warn(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s01, s02 = _vial(db, original, 1), _vial(db, original, 2)
    _verified(db, original, s01, cat["pur"])
    _verified(db, original, s02, cat["qty"], value="10.5")
    _trace(db, s01.sample_id)
    _trace(db, s02.sample_id)

    retest, _ = _mint(db)

    assert _atts(db, retest) == [] and storage.saved == []
    [warning] = _warnings(db, retest)
    assert "PB-1141-S01" in warning.details["message"] and "PB-1141-S02" in warning.details["message"]
    assert [v.sample_id for v in carried_hplc_source_vials(db, retest)] == ["PB-1141-S01", "PB-1141-S02"]


def test_storage_failure_warns_and_never_costs_the_mint(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    _trace(db, s01.sample_id)
    storage.save_error = RuntimeError("s3 down, bucket secret-name")

    retest, out = _mint(db)

    assert out["applied"] is True and out["carried"] == 1
    assert retest.is_retest is True and _atts(db, retest) == []
    [warning] = _warnings(db, retest)
    assert "secret-name" not in warning.details["message"]


def test_a_failed_copy_is_retried_on_the_next_push(db_session, cat, storage):
    """A re-push carries no new rows, so only the earlier warning says the copy is owed."""
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    _trace(db, s01.sample_id)
    storage.save_error = RuntimeError("s3 down")
    retest, _ = _mint(db)
    assert _atts(db, retest) == []

    storage.save_error = None
    _, out = _mint(db, retest=retest)

    assert out["carried"] == 0
    [row] = _atts(db, retest)
    assert row.filename == "chromatogram_PB-1141-S01.csv"
    assert len(_events(db, retest, "chromatogram_carried")) == 1
    _mint(db, retest=retest)
    assert len(_atts(db, retest)) == 1 and len(storage.saved) == 1


def test_a_re_push_does_not_heal_a_retest_minted_before_the_copy(db_session, cat, storage, monkeypatch):
    """PB-1178 and P-5502 never warned: healing them waits on the Handler, not on an order re-push."""
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    _trace(db, s01.sample_id)
    with monkeypatch.context() as m:
        m.setattr(retest_carry, "_carry_chromatogram", lambda db, **kw: None)
        retest, _ = _mint(db)

    _mint(db, retest=retest)

    assert _atts(db, retest) == [] and storage.saved == []


def test_a_bac_water_carry_files_the_chromatogram_too(db_session, cat, storage):
    """bac_water_panel anchors the hplc vial role (seeder ROLE_TO_WP_KEYS), and its COA gate wants a trace."""
    db = db_session
    original = _original(db, cat, profiles=("bw", "endo"))
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["benzyl"], value="0.9")
    _trace(db, s01.sample_id)

    retest, out = _mint(db, carry=(BW_KEY,))

    assert out["carried"] == 1
    [row] = _atts(db, retest)
    assert row.filename == "chromatogram_PB-1141-S01.csv"
    assert [v.sample_id for v in carried_hplc_source_vials(db, retest)] == ["PB-1141-S01"]


def test_a_carry_without_hplc_files_nothing(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s02 = _vial(db, original, 2, role="hm")
    _verified(db, original, s02, cat["arsenic"], value="9.0")

    retest, out = _mint(db, carry=(HM_KEY,))

    assert out["carried"] == 1
    assert _atts(db, retest) == [] and storage.saved == []
    assert _warnings(db, retest) == []
    assert carried_hplc_source_vials(db, retest) == []


def test_a_carried_rider_on_the_hplc_vial_is_not_carried_hplc(db_session, cat, storage):
    """Riders share the host vial (fentanyl on hplc), and this retest re-runs HPLC."""
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["arsenic"], value="9.0")
    _trace(db, s01.sample_id)

    retest, out = _mint(db, carry=(HM_KEY,))

    assert out["carried"] == 1
    assert _atts(db, retest) == [] and storage.saved == []
    assert _warnings(db, retest) == []
    assert carried_hplc_source_vials(db, retest) == []


def test_carried_hplc_with_no_vial_behind_it_warns(db_session, cat, storage):
    """A parent row with no promotion link is its own source: the gate must not block unexplained."""
    db = db_session
    original = _original(db, cat)
    db.add(LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=cat["pur"].id, keyword="HPLC-PURITY",
                        title="Purity", provenance="canonical", review_state="verified", result_value="99.6"))
    db.flush()

    retest, out = _mint(db)

    assert out["carried"] == 1 and _atts(db, retest) == []
    [warning] = _warnings(db, retest)
    assert "PB-1141" in warning.details["message"] and "PB-1179" in warning.details["message"]


def test_a_failure_after_the_row_is_added_leaves_no_row(db_session, cat, storage, monkeypatch):
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    _trace(db, s01.sample_id)
    real_event = retest_carry._event

    def event(db, sample, name, details, user_id=None):
        if name == "chromatogram_carried":
            raise RuntimeError("after the flush")
        real_event(db, sample, name, details, user_id)

    monkeypatch.setattr(retest_carry, "_event", event)

    retest, out = _mint(db)

    assert out["applied"] is True and out["carried"] == 1
    assert _atts(db, retest) == []
    assert len(_warnings(db, retest)) == 1


def test_a_chromatogram_already_on_the_retest_is_left_alone(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    _trace(db, s01.sample_id)
    retest = LimsSample(sample_id="PB-1179", external_lims_system="mk1", status="sample_due")
    db.add(retest)
    db.flush()
    mine = _file(db, retest, name="by-hand.csv")

    _mint(db, retest=retest)

    assert [a.id for a in _atts(db, retest)] == [mine.id] and storage.saved == []


def test_a_re_push_files_nothing_more(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    _trace(db, s01.sample_id)

    retest, _ = _mint(db)
    _mint(db, retest=retest)

    assert len(_atts(db, retest)) == 1 and len(storage.saved) == 1
    assert len(_events(db, retest, "chromatogram_carried")) == 1


def test_a_retracted_carried_row_no_longer_counts_as_carried(db_session, cat, storage):
    db = db_session
    original = _original(db, cat)
    s01 = _vial(db, original, 1)
    _verified(db, original, s01, cat["pur"])
    _trace(db, s01.sample_id)
    retest, _ = _mint(db)
    assert [v.sample_id for v in carried_hplc_source_vials(db, retest)] == ["PB-1141-S01"]

    for row in db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == retest.id,
                                                     LimsAnalysis.keyword == "HPLC-PURITY")).scalars():
        row.review_state = "retracted"
    db.flush()

    assert carried_hplc_source_vials(db, retest) == []
