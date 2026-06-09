"""Mirror seeding against the live catalog; SENAITE keyword read is monkeypatched.
Skips if no sub-sample is seeded (mirrors test_lims_analyses_seeder.py).

The monkeypatch target is "sub_samples.senaite.fetch_parent_analysis_keywords"
— mirror_parent_hplc_analyses references it via the module (late import) so the
patched attribute is the one called.

Filter contract: the mirror is EXCLUDE-Microbiology, not include-Analytics.
The per-analyte services (ANALYTE-N-PUR / ANALYTE-N-QTY) are intentionally
UNGROUPED in the catalog, so they must still be mirrored. The assertions below
require those per-analyte rows to land and require the Microbiology-group
keywords (ENDO-LAL/STER-PCR/PCR-BACTERIA/PCR-FUNGI) to be dropped. PCR-* are
grouped into Microbiology by a database._run_migrations() statement.

These tests mutate the live fixture vial, so each delete+reseed is committed to
net to no change (a flush-only reseed would be undone by the fixture rollback,
permanently stripping the rows the committed delete removed).
"""
import pytest
from sqlalchemy import delete, select

from lims_analyses.seeder import seed_analyses_for_vial
from models import LimsAnalysis, LimsAnalysisTransition, LimsSubSample
from database import SessionLocal


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def sub_sample(db):
    sub = db.execute(select(LimsSubSample).limit(1)).scalar_one_or_none()
    if sub is None:
        pytest.skip("no lims_sub_samples row available")
    return sub


# Keywords the corrected mirror MUST land. ANALYTE-N-* are the load-bearing
# rows: they exist in the live catalog (e.g. ANALYTE-1-PUR=id 85) but are
# intentionally UNGROUPED — an include-Analytics filter would drop them.
_EXPECTED_ON_VIAL = {
    "ANALYTE-1-PUR", "ANALYTE-1-QTY", "BLEND-PUR",
    "ID_GHKCU", "HPLC-ID", "PEPT-Total",
}
# Microbiology-group keywords the mirror MUST drop. PCR-BACTERIA/PCR-FUNGI are
# grouped into Microbiology by a database._run_migrations() statement; before
# that grouping they were ungrouped and exclude-Micro would wrongly mirror them.
_MICRO_EXCLUDED = ("ENDO-LAL", "STER-PCR", "PCR-BACTERIA", "PCR-FUNGI")


def test_mirror_seeds_analyte_rows_and_excludes_micro(db, sub_sample, monkeypatch):
    # Parent (per SENAITE, e.g. blend PB-0076) carries per-analyte purity/qty
    # rows, blend purity, identities, peptide total, plus Micro rows. The mirror
    # must land every HPLC keyword that exists in the catalog and drop only the
    # Microbiology-group keywords (ENDO-LAL/STER-PCR/PCR-BACTERIA/PCR-FUNGI).
    parent_keywords = [
        "ANALYTE-1-PUR", "ANALYTE-1-QTY", "BLEND-PUR",
        "ID_GHKCU", "HPLC-ID", "PEPT-Total",
        *_MICRO_EXCLUDED,                 # Micro — must be excluded
    ]
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: parent_keywords,
    )
    # Exercise the insert path even if a prior run already seeded these: scoped
    # hard-delete of the expected keywords (+ audit transitions) on this vial.
    doomed = db.execute(
        select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id,
            LimsAnalysis.keyword.in_(_EXPECTED_ON_VIAL),
        )
    ).scalars().all()
    if doomed:
        db.execute(delete(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id.in_(doomed)))
        db.execute(delete(LimsAnalysis).where(LimsAnalysis.id.in_(doomed)))
        db.commit()

    inserted = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"hplcpurity_identity": True},
        parent_sample_id="PARENT-X",
    )
    # create_analysis only flushes within this session; commit so the delete +
    # reseed nets to NO net change to the live fixture vial (rather than the
    # fixture rollback stripping the rows the delete already committed).
    db.commit()

    # The insert path actually ran for the load-bearing per-analyte rows.
    inserted_kws = {r.keyword for r in inserted}
    assert _EXPECTED_ON_VIAL <= inserted_kws
    for mk in _MICRO_EXCLUDED:
        assert mk not in inserted_kws

    # And the rows are on the vial; Micro never lands (full-set check so prior
    # seeds can't mask a Micro leak).
    on_vial = set(db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id)
    ).scalars().all())
    assert _EXPECTED_ON_VIAL <= on_vial
    assert {"ANALYTE-1-PUR", "ID_GHKCU"} <= on_vial
    for mk in _MICRO_EXCLUDED:
        assert mk not in on_vial


def test_mirror_is_idempotent(db, sub_sample, monkeypatch):
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["BLEND-PUR", "HPLC-ID"],
    )
    # Ensure `first` seeds at least one row even if the vial already carries
    # these from a prior run: hard-delete those two keyword rows (+ their audit
    # transitions) scoped to this vial before seeding.
    doomed = db.execute(
        select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id,
            LimsAnalysis.keyword.in_(["BLEND-PUR", "HPLC-ID"]),
        )
    ).scalars().all()
    if doomed:
        db.execute(delete(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id.in_(doomed)))
        db.execute(delete(LimsAnalysis).where(LimsAnalysis.id.in_(doomed)))
        db.commit()

    first = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="P",
    )
    db.commit()  # persist the reseed so the committed delete above nets to no-op
    second = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="P",
    )
    db.commit()
    assert len(first) >= 1 and len(second) == 0


def test_mirror_propagates_senaite_failure(db, sub_sample, monkeypatch):
    def _boom(pid):
        raise RuntimeError("SENAITE down")
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords", _boom)
    with pytest.raises(RuntimeError):
        seed_analyses_for_vial(
            db, sub_sample=sub_sample, role="hplc",
            wp_services={"hplcpurity_identity": True}, parent_sample_id="P",
        )


def test_hplc_without_parent_sample_id_raises(db, sub_sample):
    # Programming-error guard: HPLC mirroring needs a parent id.
    with pytest.raises(ValueError):
        seed_analyses_for_vial(
            db, sub_sample=sub_sample, role="hplc",
            wp_services={"hplcpurity_identity": True},
        )
