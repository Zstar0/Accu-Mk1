"""build_variance_replicates: per-vial replicate records for the COA series.
Variance vials only (assignment_kind='variance'), vial_sequence order, each
record carrying its own PURITY/QUANTITY/IDENTITY (whatever it measured).
Parent NOT included (COABuilder prepends its own figure)."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from coa.variance_series import build_variance_replicates
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    Peptide,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _svc(db, keyword, peptide_id=None):
    svc = AnalysisService(title=keyword, keyword=keyword, peptide_id=peptide_id)
    db.add(svc)
    db.flush()
    return svc


def _row(db, sub, svc, value, state="variance_verified"):
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.keyword, result_value=value,
        result_unit="mg" if svc.keyword.startswith("QTY") else None,
        review_state=state, reportable=True,
    ))
    db.flush()


@pytest.fixture
def world(db):
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    pur = _svc(db, "PUR_BPC157", pep.id)
    qty = _svc(db, "QTY_BPC157", pep.id)
    idsvc = _svc(db, "ID_BPC157", pep.id)
    parent = LimsSample(sample_id="P-0500", external_lims_uid="uid-p0500", container_mode=True)
    db.add(parent)
    db.flush()
    # vial 1 = core (excluded); vials 2,3 = variance
    subs = {}
    for seq, kind in ((1, "core"), (2, "variance"), (3, "variance")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://v{seq}",
            sample_id=f"P-0500-S{seq:02d}", vial_sequence=seq,
            assignment_role="hplc", assignment_kind=kind,
        )
        db.add(sub); db.flush()
        subs[seq] = sub
    # vial 2: full set; vial 3: purity + identity only (no quantity)
    _row(db, subs[2], pur, "99.1"); _row(db, subs[2], qty, "10.1"); _row(db, subs[2], idsvc, "BPC-157")
    _row(db, subs[3], pur, "97.21"); _row(db, subs[3], idsvc, "Out of Spec")
    # core vial (seq1) has a result row — now included as Vial 1 in the series
    _row(db, subs[1], pur, "50.0")
    db.commit()
    return parent


def test_variance_vials_only_in_sequence_order(world, db):
    out = build_variance_replicates(db, world)
    recs = out["BPC-157"]
    assert [r["vial_sequence"] for r in recs] == [1, 2, 3]  # core vial 1 now included (has a result row)


def test_per_vial_records_carry_their_analytes(world, db):
    recs = build_variance_replicates(db, world)["BPC-157"]
    # recs[0] is core vial seq1; recs[1] and recs[2] are the variance vials
    v2, v3 = recs[1], recs[2]
    assert v2["PURITY"] == "99.1%" and v2["QUANTITY"] == "10.1 mg" and v2["IDENTITY"] == "BPC-157"
    assert v3["PURITY"] == "97.21%" and v3["IDENTITY"] == "Out of Spec"
    assert "QUANTITY" not in v3  # vial 3 had no quantity row


def test_deselected_vial_excluded(db):
    """A variance vial with in_variance_set=False (unchecked in the overlay)
    must NOT contribute a record — the COA series must match the overlay's
    selected set. Regression: builder filtered only on assignment_kind, so a
    deselected vial still reached the COA."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep); db.flush()
    pur = _svc(db, "PUR_BPC157", pep.id)
    parent = LimsSample(sample_id="P-0700", external_lims_uid="uid-p0700", container_mode=True)
    db.add(parent); db.flush()
    included = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://in",
        sample_id="P-0700-S01", vial_sequence=1,
        assignment_role="hplc", assignment_kind="variance", in_variance_set=True,
    )
    excluded = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://out",
        sample_id="P-0700-S02", vial_sequence=2,
        assignment_role="hplc", assignment_kind="variance", in_variance_set=False,
    )
    db.add_all([included, excluded]); db.flush()
    _row(db, included, pur, "99.1")
    _row(db, excluded, pur, "12.3")  # must NOT appear
    db.commit()

    recs = build_variance_replicates(db, parent)["BPC-157"]
    assert [r["vial_sequence"] for r in recs] == [1]
    assert recs[0]["PURITY"] == "99.1%"


def test_empty_when_no_variance_vials(db):
    parent = LimsSample(sample_id="P-0600", external_lims_uid="uid-p0600")
    db.add(parent); db.commit()
    assert build_variance_replicates(db, parent) == {}


@pytest.fixture
def prod_world(db):
    """Production single-peptide shape: generic purity/quantity services that
    carry NO peptide_id (HPLC-PUR, PEPT-Total) and a peptide-specific identity
    service (ID_BPC157). The vial's peptide is known only via its identity row;
    purity/quantity must still attach to that peptide."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    pur = _svc(db, "HPLC-PUR")                 # generic, peptide_id=None
    qty = _svc(db, "PEPT-Total")               # generic, peptide_id=None
    idsvc = _svc(db, "ID_BPC157", pep.id)      # peptide-specific
    parent = LimsSample(sample_id="P-0700", external_lims_uid="uid-p0700", container_mode=True)
    db.add(parent)
    db.flush()
    subs = {}
    for seq, kind in ((1, "core"), (2, "variance"), (3, "variance")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://w{seq}",
            sample_id=f"P-0700-S{seq:02d}", vial_sequence=seq,
            assignment_role="hplc", assignment_kind=kind,
        )
        db.add(sub); db.flush()
        subs[seq] = sub
    _row(db, subs[2], pur, "93.1"); _row(db, subs[2], qty, "15"); _row(db, subs[2], idsvc, "BPC-157")
    _row(db, subs[3], pur, "99.98"); _row(db, subs[3], qty, "15"); _row(db, subs[3], idsvc, "BPC-157")
    db.commit()
    return parent


def test_generic_services_attach_purity_quantity_to_vial_peptide(prod_world, db):
    recs = build_variance_replicates(db, prod_world)["BPC-157"]
    assert [r["vial_sequence"] for r in recs] == [2, 3]
    v2, v3 = recs[0], recs[1]
    assert v2["PURITY"] == "93.1%" and v2["IDENTITY"] == "BPC-157"
    assert v2.get("QUANTITY", "").startswith("15")
    assert v3["PURITY"] == "99.98%"
    assert v3.get("QUANTITY", "").startswith("15")


def test_retested_vial_uses_current_result_not_superseded_original(db):
    """Regression (P-0149 S03): a variance vial whose identity was retested must
    report the CURRENT (retested=False) value, not the superseded original.
    `retest_of_id IS NULL` grabs the stale original (which becomes retested=True
    once a retest exists); `retested IS False` is the correct current-row idiom
    for vial-tier rows."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    idsvc = _svc(db, "ID_BPC157", pep.id)
    parent = LimsSample(sample_id="P-0149", external_lims_uid="uid-p0149", container_mode=True)
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://s3",
        sample_id="P-0149-S03", vial_sequence=3,
        assignment_role="hplc", assignment_kind="variance",
    )
    db.add(sub)
    db.flush()
    # Superseded original identity: matched BPC-157, now retested away.
    orig = LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=idsvc.id,
        keyword="ID_BPC157", title="ID_BPC157", result_value="BPC-157",
        review_state="variance_verified", reportable=True, retested=True,
    )
    db.add(orig)
    db.flush()
    # Current retest: does not conform.
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=idsvc.id,
        keyword="ID_BPC157", title="ID_BPC157", result_value="Does_Not_Conform",
        review_state="variance_verified", reportable=True, retested=False,
        retest_of_id=orig.id,
    ))
    db.commit()
    recs = build_variance_replicates(db, parent)["BPC-157"]
    assert len(recs) == 1
    assert recs[0]["IDENTITY"] == "Does_Not_Conform"


def test_core_vial_included_with_promoted_state(db):
    """New contract: a variance sample's CORE vial (promoted state) is included
    as a row, alongside the variance vials, in vial_sequence order."""
    pep = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True)
    db.add(pep); db.flush()
    pur = _svc(db, "HPLC-PUR"); idsvc = _svc(db, "ID_GHKCU", pep.id)
    parent = LimsSample(sample_id="P-1094", external_lims_uid="uid-p1094", container_mode=False)
    db.add(parent); db.flush()
    # P-1094 inverted: S01 = variance (seq1), S02 = core/promoted (seq2)
    s1 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://a",
                       sample_id="P-1094-S01", vial_sequence=1,
                       assignment_role="hplc", assignment_kind="variance")
    s2 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://b",
                       sample_id="P-1094-S02", vial_sequence=2,
                       assignment_role="hplc", assignment_kind="core")
    db.add_all([s1, s2]); db.flush()
    _row(db, s1, pur, "99.73", state="variance_verified"); _row(db, s1, idsvc, "GHK-Cu", state="variance_verified")
    _row(db, s2, pur, "99.965", state="promoted");          _row(db, s2, idsvc, "GHK-Cu", state="promoted")
    db.commit()
    recs = build_variance_replicates(db, parent)["GHK-Cu"]
    assert [r["vial_sequence"] for r in recs] == [1, 2]      # core (seq2) now included
    assert recs[0]["PURITY"] == "99.73%" and recs[1]["PURITY"] == "99.965%"


def test_non_variance_sample_sends_nothing(db):
    """A sample with only CORE vials (no variance) must still return {} — the
    variance path must never fire for non-variance certs."""
    pep = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True)
    db.add(pep); db.flush()
    pur = _svc(db, "HPLC-PUR")
    parent = LimsSample(sample_id="P-2000", external_lims_uid="uid-p2000", container_mode=True)
    db.add(parent); db.flush()
    s1 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://c",
                       sample_id="P-2000-S01", vial_sequence=1,
                       assignment_role="hplc", assignment_kind="core")
    db.add(s1); db.flush()
    _row(db, s1, pur, "99.0", state="promoted")
    db.commit()
    assert build_variance_replicates(db, parent) == {}


def test_vial_quantity_single_peptide_renders_mg_not_concentration(prod_world, db):
    """Single-peptide variance sample: its only parent quantity row is PEPT-Total
    (mg/mL, the blend concentration). The per-vial series reports per-analyte
    measured MASS, so the quantity column renders 'mg' — matching the COA's own
    total-quantity figure — not the mg/mL concentration."""
    qty = db.execute(
        select(AnalysisService).where(AnalysisService.keyword == "PEPT-Total")
    ).scalar_one()
    db.add(LimsAnalysis(
        lims_sample_pk=prod_world.id, analysis_service_id=qty.id,
        keyword="PEPT-Total", title="PEPT-Total", result_value="12",
        result_unit="mg/mL", review_state="verified", reportable=True,
    ))
    db.commit()
    recs = build_variance_replicates(db, prod_world)["BPC-157"]
    assert recs[0]["QUANTITY"] == "15 mg"


# ─── _parent_quantity_unit: reject non-unit strings, prefer per-analyte mass ─────
# Regression: QTY_BPC157/PUR_BPC157 were mis-seeded with unit='text'. That string
# rode onto the parent quantity row at promote time and, because the old selector
# returned the FIRST quantity row's unit from an unordered query, leaked onto the
# variance COA quantity column as e.g. "10.387 text" (both analytes — the unit is
# sample-wide). The selector must reject non-unit strings and deterministically
# prefer the per-analyte quantity unit (mg, the measured mass the per-vial series
# reports) over the PEPT-Total blend concentration (mg/mL). PEPT-Total is only a
# fallback for single-peptide samples that carry no per-analyte quantity row.


def test_parent_quantity_unit_rejects_text_unit(db):
    from coa.variance_series import _parent_quantity_unit
    parent = LimsSample(sample_id="P-0801", external_lims_uid="uid-p0801", container_mode=True)
    db.add(parent); db.flush()
    qsvc = _svc(db, "ANALYTE-2-QTY")
    db.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=qsvc.id,
        keyword="ANALYTE-2-QTY", title="ANALYTE-2-QTY", result_value="10.387",
        result_unit="text", review_state="verified", reportable=True,
    ))
    db.commit()
    # 'text' is not a real unit — it must never become the series unit (callers
    # default to 'mg' when this returns None).
    assert _parent_quantity_unit(db, parent) is None


def test_parent_quantity_unit_prefers_analyte_mass_over_pept_total(db):
    from coa.variance_series import _parent_quantity_unit
    parent = LimsSample(sample_id="P-0802", external_lims_uid="uid-p0802", container_mode=True)
    db.add(parent); db.flush()
    ptot = _svc(db, "PEPT-Total")
    aqty = _svc(db, "ANALYTE-1-QTY")
    # PEPT-Total inserted FIRST so it can't win merely by row order: the per-vial
    # series reports per-analyte mass (mg), not the blend concentration (mg/mL).
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=ptot.id,
                        keyword="PEPT-Total", title="PEPT-Total", result_value="20.0",
                        result_unit="mg/mL", review_state="verified", reportable=True))
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=aqty.id,
                        keyword="ANALYTE-1-QTY", title="ANALYTE-1-QTY", result_value="9.6",
                        result_unit="mg", review_state="verified", reportable=True))
    db.commit()
    assert _parent_quantity_unit(db, parent) == "mg"


def test_parent_quantity_unit_uses_valid_analyte_unit_when_no_pept_total(db):
    from coa.variance_series import _parent_quantity_unit
    parent = LimsSample(sample_id="P-0803", external_lims_uid="uid-p0803", container_mode=True)
    db.add(parent); db.flush()
    aqty = _svc(db, "ANALYTE-1-QTY")
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=aqty.id,
                        keyword="ANALYTE-1-QTY", title="ANALYTE-1-QTY", result_value="9.6",
                        result_unit="mg", review_state="verified", reportable=True))
    db.commit()
    assert _parent_quantity_unit(db, parent) == "mg"


def test_parent_quantity_unit_rejects_pept_total_concentration(db):
    """A single-peptide sample carries only a PEPT-Total (mg/mL) quantity row. The
    per-vial series reports per-analyte mass, so mg/mL is NOT accepted — this
    returns None and the caller defaults to 'mg' (not the blend concentration)."""
    from coa.variance_series import _parent_quantity_unit
    parent = LimsSample(sample_id="P-0804", external_lims_uid="uid-p0804", container_mode=True)
    db.add(parent); db.flush()
    ptot = _svc(db, "PEPT-Total")
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=ptot.id,
                        keyword="PEPT-Total", title="PEPT-Total", result_value="20.0",
                        result_unit="mg/mL", review_state="verified", reportable=True))
    db.commit()
    assert _parent_quantity_unit(db, parent) is None


# ---------------------------------------------------------------------------
# Series key must be the name COABuilder derives from the identity SERVICE
# TITLE (`Analyte{i}Peptide`.split(" - Identity")[0]), not `peptides.name`.
# PB-0354 (2026-08-18): peptide 63 is named 'TB500 (Thymosin Beta 4)' but the
# sample was provisioned with ID_THYMOSINBETA4 whose title is
# 'Thymosin Beta-4 - Identity (HPLC)'. COABuilder looked up
# reps.get('Thymosin Beta-4'), missed, and silently rendered the TB4 slot as a
# non-variance analyte (no mean/SD/n, no 'Conforms 2/2').
# ---------------------------------------------------------------------------

def _titled_svc(db, keyword, title, peptide_id=None):
    svc = AnalysisService(title=title, keyword=keyword, peptide_id=peptide_id)
    db.add(svc)
    db.flush()
    return svc


@pytest.fixture
def pb0354_world(db):
    """Blend BPC-157 + TB4, one core vial (promoted) + one variance vial, where
    the TB4 peptide's catalog name diverges from its identity service title."""
    bpc = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    tb4 = Peptide(name="TB500 (Thymosin Beta 4)", abbreviation="TB500", active=True)
    db.add_all([bpc, tb4]); db.flush()
    svcs = {
        "ID_BPC157": _titled_svc(db, "ID_BPC157", "BPC-157 - Identity (HPLC)", bpc.id),
        "PUR_BPC157": _titled_svc(db, "PUR_BPC157", "BPC-157 - Purity", bpc.id),
        "QTY_BPC157": _titled_svc(db, "QTY_BPC157", "BPC-157 - Quantity", bpc.id),
        # Identity title prefix ('Thymosin Beta-4') != peptide.name
        "ID_THYMOSINBETA4": _titled_svc(db, "ID_THYMOSINBETA4", "Thymosin Beta-4 - Identity (HPLC)", tb4.id),
        "PUR_TB500BETA4": _titled_svc(db, "PUR_TB500BETA4", "TB500 (Thymosin Beta 4) - Purity", tb4.id),
        "QTY_TB500BETA4": _titled_svc(db, "QTY_TB500BETA4", "TB500 (Thymosin Beta 4) - Quantity", tb4.id),
    }
    parent = LimsSample(sample_id="PB-0354", external_lims_uid="uid-pb0354", container_mode=True)
    db.add(parent); db.flush()
    subs = {}
    for seq, kind in ((1, "core"), (5, "variance")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://pb0354-v{seq}",
            sample_id=f"PB-0354-S{seq:02d}", vial_sequence=seq,
            assignment_role="hplc", assignment_kind=kind, in_variance_set=True,
        )
        db.add(sub); db.flush()
        subs[seq] = sub
    core, var = subs[1], subs[5]
    _row(db, core, svcs["ID_BPC157"], "BPC-157", state="promoted")
    _row(db, core, svcs["PUR_BPC157"], "99.611", state="promoted")
    _row(db, core, svcs["QTY_BPC157"], "12.213", state="promoted")
    _row(db, core, svcs["ID_THYMOSINBETA4"], "Thymosin Beta-4", state="promoted")
    _row(db, core, svcs["PUR_TB500BETA4"], "99.754", state="promoted")
    _row(db, core, svcs["QTY_TB500BETA4"], "10.689", state="promoted")
    _row(db, var, svcs["ID_BPC157"], "BPC-157")
    _row(db, var, svcs["PUR_BPC157"], "99.626")
    _row(db, var, svcs["QTY_BPC157"], "11.948")
    _row(db, var, svcs["ID_THYMOSINBETA4"], "Thymosin Beta-4")
    _row(db, var, svcs["PUR_TB500BETA4"], "99.662")
    _row(db, var, svcs["QTY_TB500BETA4"], "10.683")
    db.commit()
    return parent, subs


def test_series_keyed_by_identity_title_prefix_when_peptide_name_diverges(pb0354_world, db):
    parent, _ = pb0354_world
    out = build_variance_replicates(db, parent)
    # The key COABuilder will look up is the identity-service title prefix.
    assert set(out) == {"BPC-157", "Thymosin Beta-4"}
    tb4 = out["Thymosin Beta-4"]
    assert [r["vial_sequence"] for r in tb4] == [1, 5]
    # PUR_/QTY_ rows for that peptide (whose own titles use the catalog name)
    # attach under the SAME key — one record per vial, not split across two.
    assert tb4[0] == {"vial_sequence": 1, "IDENTITY": "Thymosin Beta-4",
                      "PURITY": "99.754%", "QUANTITY": "10.689 mg"}
    assert tb4[1] == {"vial_sequence": 5, "IDENTITY": "Thymosin Beta-4",
                      "PURITY": "99.662%", "QUANTITY": "10.683 mg"}


def test_series_key_unchanged_when_title_prefix_equals_peptide_name(pb0354_world, db):
    parent, _ = pb0354_world
    bpc = build_variance_replicates(db, parent)["BPC-157"]
    assert [r["vial_sequence"] for r in bpc] == [1, 5]
    assert bpc[1] == {"vial_sequence": 5, "IDENTITY": "BPC-157",
                      "PURITY": "99.626%", "QUANTITY": "11.948 mg"}


def test_vial_figures_use_same_identity_title_key(pb0354_world, db):
    from coa.variance_series import build_vial_figures
    _, subs = pb0354_world
    figs = build_vial_figures(db, subs[5])
    assert set(figs) == {"BPC-157", "Thymosin Beta-4"}
    assert figs["Thymosin Beta-4"] == {"IDENTITY": "Thymosin Beta-4",
                                       "PURITY": "99.662%", "QUANTITY": "10.683 mg"}


def test_series_falls_back_to_peptide_name_without_identity_row(db):
    """No identity row on the vial for that peptide → nothing better than the
    catalog name (COABuilder N/A-gates a vial with no IDENTITY anyway)."""
    tb4 = Peptide(name="TB500 (Thymosin Beta 4)", abbreviation="TB500", active=True)
    db.add(tb4); db.flush()
    pur = _titled_svc(db, "PUR_TB500BETA4", "TB500 (Thymosin Beta 4) - Purity", tb4.id)
    parent = LimsSample(sample_id="P-0900", external_lims_uid="uid-p0900", container_mode=True)
    db.add(parent); db.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://p0900-v2",
        sample_id="P-0900-S02", vial_sequence=2,
        assignment_role="hplc", assignment_kind="variance", in_variance_set=True,
    )
    db.add(sub); db.flush()
    _row(db, sub, pur, "99.0")
    db.commit()
    out = build_variance_replicates(db, parent)
    assert set(out) == {"TB500 (Thymosin Beta 4)"}
