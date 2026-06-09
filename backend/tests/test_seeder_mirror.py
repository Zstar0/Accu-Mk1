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


# Microbiology-group keywords the mirror MUST drop. PCR-BACTERIA/PCR-FUNGI are
# grouped into Microbiology by a database._run_migrations() statement; before
# that grouping they were ungrouped and exclude-Micro would wrongly mirror them.
_MICRO_EXCLUDED = ("ENDO-LAL", "STER-PCR", "PCR-BACTERIA", "PCR-FUNGI")


def test_mirror_translates_analyte_to_per_substance(db, monkeypatch):
    # Generic ANALYTE-{n}-PUR/QTY are translated to the slot peptide's
    # per-substance PUR_<X>/QTY_<X> via the parent's Analyte{N}Peptide slot map
    # (slot title -> ID_<X> service -> peptide_id -> PUR_<X>/QTY_<X>). Empty
    # slots are skipped; the generic ANALYTE-* services are never seeded.
    vial = _throwaway_vial(db)
    parent_keywords = [
        "ANALYTE-1-PUR", "ANALYTE-1-QTY",          # slot 1 -> GHK-Cu
        "ANALYTE-4-PUR",                            # empty slot -> skipped
        "BLEND-PUR", "ID_GHKCU", "HPLC-ID", "PEPT-Total",
        "ENDO-LAL", "STER-PCR",                     # Micro -> excluded
    ]
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords", lambda pid: parent_keywords)
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: {1: "GHK-Cu - Identity (HPLC)"})   # only slot 1 populated
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    kws = {r.keyword for r in inserted}
    assert {"PUR_GHKCU", "QTY_GHKCU"} <= kws
    assert not any(k.startswith("ANALYTE-") for k in kws)   # generic NOT seeded; slot 4 skipped
    assert "ENDO-LAL" not in kws and "STER-PCR" not in kws
    assert {"ID_GHKCU", "BLEND-PUR", "HPLC-ID", "PEPT-Total"} <= kws

    # Flushed-but-uncommitted rows are queryable within this same session.
    on_vial = set(db.execute(select(LimsAnalysis.keyword).where(
        LimsAnalysis.lims_sub_sample_pk == vial.id)).scalars().all())
    assert {"PUR_GHKCU", "QTY_GHKCU"} <= on_vial


def test_mirror_falls_back_to_generic_when_no_per_substance(db, monkeypatch):
    # Post-migration every ID_<X> has PUR_/QTY_, so force the fallback via a slot
    # title that maps to NO ID_ service: id_svc None -> per None -> generic kept.
    vial = _throwaway_vial(db)
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["ANALYTE-2-PUR"])
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: {2: "No Such Substance - Identity (HPLC)"})
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    kws = {r.keyword for r in inserted}
    assert "ANALYTE-2-PUR" in kws   # generic kept, not silently dropped


def test_mirror_translation_is_idempotent(db, monkeypatch):
    # The translated path must also dedupe on re-run (existing_kw -> no double-seed).
    vial = _throwaway_vial(db)
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["ANALYTE-1-PUR", "ANALYTE-1-QTY"])
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: {1: "GHK-Cu - Identity (HPLC)"})
    first = seed_analyses_for_vial(db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    second = seed_analyses_for_vial(db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    assert {"PUR_GHKCU", "QTY_GHKCU"} <= {r.keyword for r in first}
    assert second == []   # re-translation hits existing_kw -> no double-seed


def test_mirror_skips_unmapped_analyte_slot(db, monkeypatch):
    vial = _throwaway_vial(db)
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["ANALYTE-2-PUR", "ANALYTE-2-QTY"])
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: {})  # no slots
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    assert inserted == []


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
