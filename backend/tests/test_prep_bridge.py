"""Unit tests for the vial-prep result bridge."""
from sqlalchemy import select

from models import HPLCAnalysis, LimsAnalysis, LimsSubSample, Peptide
from lims_analyses.service import create_analysis
from lims_analyses.prep_bridge import bridge_prep_result_to_vial


def _peptide(db, name="BPC-157", abbr="BPC-157"):
    p = Peptide(name=name, abbreviation=abbr)
    db.add(p)
    db.flush()
    return p


def _vial(db):
    # parent_sample_pk + external_lims_uid are NOT NULL on LimsSubSample; SQLite
    # doesn't enforce the parent FK, so any int is fine for this unit test.
    v = LimsSubSample(
        parent_sample_pk=1,
        external_lims_uid="UID-P-0142-S01",
        sample_id="P-0142-S01",
        vial_sequence=0,
    )
    db.add(v)
    db.flush()
    return v


def _hplc(db, pep, *, purity=None, conforms=None, qty=None, instrument_id=None):
    a = HPLCAnalysis(
        sample_id_label="P-0142-S01",
        peptide_id=pep.id,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        purity_percent=purity, identity_conforms=conforms, quantity_mg=qty,
        instrument_id=instrument_id,
    )
    db.add(a)
    db.flush()
    return a


def test_bridges_purity_and_identity_and_submits(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    idr = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=30, keyword="ID_BPC157", title="BPC-157 - Identity (HPLC)")
    a = _hplc(db, pep, purity=98.5, conforms=True)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert set(ids) == {pur.id, idr.id}
    db.refresh(pur); db.refresh(idr)
    assert pur.review_state == "to_be_verified" and pur.result_value == "98.5"
    assert idr.review_state == "to_be_verified" and idr.result_value == "BPC-157"


def test_skips_mismatched_identity_analyte(db_session):
    db = db_session
    pep = _peptide(db, name="BPC-157", abbr="BPC-157")
    vial = _vial(db)
    other = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                            analysis_service_id=33, keyword="ID_PT141", title="PT-141 - Identity (HPLC)")
    a = _hplc(db, pep, conforms=True)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert ids == []
    db.refresh(other)
    assert other.review_state == "unassigned"


def test_idempotent_second_run_is_noop(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                    analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    a = _hplc(db, pep, purity=99.0)

    first = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    second = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert len(first) == 1 and second == []


def test_no_matching_rows_returns_empty(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                    analysis_service_id=77, keyword="ENDO-LAL", title="Endotoxin")
    a = _hplc(db, pep, purity=99.0)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert ids == []


def test_skips_ambiguous_same_category(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                    analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                    analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    a = _hplc(db, pep, purity=98.5)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert ids == []  # two same-category rows -> ambiguous -> skipped


def test_real_seeder_shape_specific_id_wins_generic_left_unassigned(db_session):
    # Real vial shape: seeder puts HPLC-ID + ID_<PEPTIDE> on every HPLC vial.
    # The specific ID_BPC157 row must win; the generic HPLC-ID row stays unassigned.
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    gen_id = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                             analysis_service_id=29, keyword="HPLC-ID", title="Identity (HPLC)")
    spec_id = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                              analysis_service_id=30, keyword="ID_BPC157", title="BPC-157 - Identity (HPLC)")
    a = _hplc(db, pep, purity=98.5, conforms=True)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert set(ids) == {pur.id, spec_id.id}
    db.refresh(pur); db.refresh(gen_id); db.refresh(spec_id)
    assert pur.review_state == "to_be_verified" and pur.result_value == "98.5"
    assert spec_id.review_state == "to_be_verified" and spec_id.result_value == "BPC-157"
    # The generic HPLC-ID row must be LEFT UNASSIGNED (not double-written).
    assert gen_id.review_state == "unassigned" and gen_id.result_value is None


def test_generic_identity_used_when_no_specific_row(db_session):
    # Vial with only the generic HPLC-ID (no ID_*) -> identity goes to HPLC-ID.
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    gen_id = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                             analysis_service_id=29, keyword="HPLC-ID", title="Identity (HPLC)")
    a = _hplc(db, pep, purity=99.0, conforms=True)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert set(ids) == {pur.id, gen_id.id}
    db.refresh(gen_id)
    assert gen_id.review_state == "to_be_verified" and gen_id.result_value == "BPC-157"


def test_non_conforming_identity(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    idr = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=30, keyword="ID_BPC157", title="BPC-157 - Identity (HPLC)")
    a = _hplc(db, pep, conforms=False)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert ids == [idr.id]
    db.refresh(idr)
    assert idr.review_state == "to_be_verified" and idr.result_value == "Non-conforming"


def test_quantity_is_written(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    qty = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=40, keyword="QTY_BPC157", title="BPC-157 - Quantity (HPLC)")
    a = _hplc(db, pep, qty=12.34)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert ids == [qty.id]
    db.refresh(qty)
    assert qty.review_state == "to_be_verified" and qty.result_value == "12.34"
