"""Mirror seeding against the live catalog; SENAITE keyword read is monkeypatched.

The monkeypatch target is "sub_samples.senaite.fetch_parent_analysis_keywords"
— mirror_parent_hplc_analyses references it via the module (late import) so the
patched attribute is the one called.

Filter contract: the mirror is EXCLUDE-Microbiology, not include-Analytics.
The per-analyte services (ANALYTE-N-PUR / ANALYTE-N-QTY) are intentionally
UNGROUPED in the catalog, so they must still be mirrored. The assertions below
require those per-analyte rows to land and require the Microbiology-group
keywords (ENDO-LAL/STER-PCR/PCR-BACTERIA/PCR-FUNGI) to be dropped. PCR-* are
grouped into Microbiology by a database._run_migrations() statement.

Isolation: these tests need the LIVE Postgres session (for the real catalog —
analysis_services + service_group_members), but they MUST NOT touch any real
vial. Each test creates a throwaway parent + vial (flush only) and seeds with
commit=False, so the `db` fixture's teardown rollback discards the throwaway
rows and every seeded analysis. No live vial is read, mutated, or committed.
"""
import pytest
from sqlalchemy import select

from lims_analyses.seeder import seed_analyses_for_vial
from models import LimsAnalysis, LimsSample, LimsSubSample
from database import SessionLocal


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _throwaway_vial(db):
    """Create a parent + vial that exist only inside this session (flush, no
    commit). The fixture rollback discards them — nothing persists to the live
    DB. Uses a ZZTEST sample_id so any accidental leak is trivially greppable."""
    parent = LimsSample(sample_id="ZZTEST-MIRROR", external_lims_uid="zz-uid-mirror")
    db.add(parent)
    db.flush()
    v = LimsSubSample(
        sample_id="ZZTEST-MIRROR-S01",
        vial_sequence=0,
        parent_sample_pk=parent.id,
        external_lims_uid="zz-vuid-mirror",
    )
    db.add(v)
    db.flush()
    return v


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


def test_mirror_seeds_analyte_rows_and_excludes_micro(db, monkeypatch):
    # Parent (per SENAITE, e.g. blend PB-0076) carries per-analyte purity/qty
    # rows, blend purity, identities, peptide total, plus Micro rows. The mirror
    # must land every HPLC keyword that exists in the catalog and drop only the
    # Microbiology-group keywords (ENDO-LAL/STER-PCR/PCR-BACTERIA/PCR-FUNGI).
    vial = _throwaway_vial(db)
    parent_keywords = [
        "ANALYTE-1-PUR", "ANALYTE-1-QTY", "BLEND-PUR",
        "ID_GHKCU", "HPLC-ID", "PEPT-Total",
        *_MICRO_EXCLUDED,                 # Micro — must be excluded
    ]
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: parent_keywords,
    )

    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True},
        parent_sample_id="X", commit=False,
    )

    # The insert path actually ran for the load-bearing per-analyte rows.
    inserted_kws = {r.keyword for r in inserted}
    assert _EXPECTED_ON_VIAL <= inserted_kws
    for mk in _MICRO_EXCLUDED:
        assert mk not in inserted_kws

    # The flushed-but-uncommitted rows are visible within this same session.
    on_vial = set(db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == vial.id)
    ).scalars().all())
    assert _EXPECTED_ON_VIAL <= on_vial
    assert {"ANALYTE-1-PUR", "ID_GHKCU"} <= on_vial
    for mk in _MICRO_EXCLUDED:
        assert mk not in on_vial


def test_mirror_is_idempotent(db, monkeypatch):
    vial = _throwaway_vial(db)
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["BLEND-PUR", "HPLC-ID"],
    )
    first = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True},
        parent_sample_id="P", commit=False,
    )
    # Second call's existing-keyword query sees the first call's flushed rows
    # (autoflush), so it's a no-op — without ever committing.
    second = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True},
        parent_sample_id="P", commit=False,
    )
    assert len(first) >= 1 and second == []


def test_mirror_propagates_senaite_failure(db, monkeypatch):
    vial = _throwaway_vial(db)

    def _boom(pid):
        raise RuntimeError("SENAITE down")

    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords", _boom)
    with pytest.raises(RuntimeError):
        seed_analyses_for_vial(
            db, sub_sample=vial, role="hplc",
            wp_services={"hplcpurity_identity": True},
            parent_sample_id="P", commit=False,
        )


def test_hplc_without_parent_sample_id_raises(db):
    # Programming-error guard: HPLC mirroring needs a parent id.
    vial = _throwaway_vial(db)
    with pytest.raises(ValueError):
        seed_analyses_for_vial(
            db, sub_sample=vial, role="hplc",
            wp_services={"hplcpurity_identity": True},
            commit=False,
        )
