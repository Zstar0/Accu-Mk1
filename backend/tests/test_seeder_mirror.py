"""Mirror seeding against the live catalog; SENAITE keyword read is monkeypatched.

The monkeypatch target is "sub_samples.senaite.fetch_parent_analysis_keywords"
— mirror_parent_hplc_analyses references it via the module (late import) so the
patched attribute is the one called.

Filter contract: the mirror is a fail-closed Department allow-list — a keyword
is mirrored only if its service's department_id is the Analytical department
(see catalog.departments / mirror_parent_hplc_analyses), not a Microbiology
deny-list. The per-analyte services (ANALYTE-N-PUR / ANALYTE-N-QTY) are
intentionally UNGROUPED in the catalog but tagged Analytical by the catalog
backfill, so they must still be mirrored. The assertions below require those
per-analyte rows to land and require the Microbiology-department keywords
(ENDO-LAL/STER-PCR/PCR-BACTERIA/PCR-FUNGI) to be dropped. PCR-* are grouped
into Microbiology (and therefore department-tagged Microbiology) by a
database._run_migrations() statement.

test_micro_and_untagged_services_never_reach_an_hplc_vial and
test_mirror_aborts_when_the_analytical_department_is_missing below exercise
the allow-list predicate itself (including the NULL-department fail-closed
case and the missing-department abort) against an isolated in-memory catalog,
rather than the live one.

Isolation: the tests above the allow-list section need the LIVE Postgres
session (for the real catalog — analysis_services + service_group_members),
but they MUST NOT touch any real vial. Each test creates a throwaway parent +
vial (flush only) and seeds with commit=False, so the `db` fixture's teardown
rollback discards the throwaway rows and every seeded analysis. No live vial
is read, mutated, or committed. The allow-list section below uses its own
`db_session` fixture (in-memory sqlite) instead — no live DB involved at all.
"""
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

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


# ── fail-closed Department allow-list ───────────────────────────────────────
#
# The tests below exercise mirror_parent_hplc_analyses directly against an
# isolated in-memory catalog (not the live Postgres one used above) so the
# department wiring — including the NULL-department and missing-department
# cases — is fully under test control. This is the regression coverage for
# incident BW-0015-S01 (an Endotoxin row landed on an HPLC vial because the
# old predicate was a Microbiology deny-list that defaulted to "mirror it").


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _mk_catalog(db):
    """Analytical + Microbiology departments, one service in each, plus one
    service with NO department at all (the mis-tagged case)."""
    from models import AnalysisService, Department
    analytical = Department(name="Analytical")
    micro = Department(name="Microbiology")
    db.add_all([analytical, micro])
    db.commit()
    db.add_all([
        AnalysisService(title="Purity X", keyword="PUR_X", department_id=analytical.id),
        AnalysisService(title="Sterility PCR", keyword="STER-PCR", department_id=micro.id),
        AnalysisService(title="Endotoxin", keyword="ENDO-LAL", department_id=micro.id),
        AnalysisService(title="Orphan", keyword="ORPHAN-1", department_id=None),
    ])
    db.commit()
    return analytical, micro


def _mk_isolated_vial(db):
    """Throwaway parent + vial inside the isolated in-memory session (mirrors
    _throwaway_vial's shape, but against db_session's sqlite catalog)."""
    from models import LimsSample, LimsSubSample
    parent = LimsSample(sample_id="P-0001", external_lims_uid="zz-uid-allowlist")
    db.add(parent)
    db.flush()
    v = LimsSubSample(
        sample_id="P-0001-S01",
        vial_sequence=0,
        parent_sample_pk=parent.id,
        external_lims_uid="zz-vuid-allowlist",
    )
    db.add(v)
    db.flush()
    return v


def test_micro_and_untagged_services_never_reach_an_hplc_vial(db_session, monkeypatch):
    from lims_analyses.seeder import mirror_parent_hplc_analyses
    _mk_catalog(db_session)
    vial = _mk_isolated_vial(db_session)

    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda _sid: ["PUR_X", "STER-PCR", "ENDO-LAL", "ORPHAN-1"],
    )
    created = mirror_parent_hplc_analyses(
        db_session,
        sub_sample=vial,
        parent_sample_id="P-0001",
        existing_kw=set(),
        created_by_user_id=None,
        commit=False,
    )
    kws = {row.keyword for row in created}
    assert "PUR_X" in kws
    assert "STER-PCR" not in kws      # Microbiology department
    assert "ENDO-LAL" not in kws      # Microbiology department
    assert "ORPHAN-1" not in kws      # NULL department -> fail closed


def test_mirror_aborts_when_the_analytical_department_is_missing(db_session, monkeypatch):
    """No Analytical department => seed nothing. Never fall back to open."""
    from lims_analyses.seeder import mirror_parent_hplc_analyses
    from models import AnalysisService
    db_session.add(AnalysisService(title="Purity X", keyword="PUR_X"))
    db_session.commit()
    vial = _mk_isolated_vial(db_session)

    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda _sid: ["PUR_X"],
    )
    created = mirror_parent_hplc_analyses(
        db_session,
        sub_sample=vial,
        parent_sample_id="P-0001",
        existing_kw=set(),
        created_by_user_id=None,
        commit=False,
    )
    assert created == []


def test_mirror_returns_empty_when_analytical_department_has_no_tagged_services(
    db_session, monkeypatch,
):
    """Production-shaped regression (Task 2 fix round): the Analytical
    department ROW can exist — so the missing-department abort guard tested
    above never fires — while carrying ZERO tagged services, if this
    environment's real service-group names or ungrouped keyword families
    aren't recognized by catalog.departments (e.g. before the "Core HPLC" /
    ungrouped-family fix). This is deliberately reached via the real
    backfill_departments(), not hand-crafted department_id values, to prove
    the end-to-end path: a service that matches no known group AND no
    enumerated rescue pattern stays NULL, so the department row is empty and
    the mirror still correctly returns [] rather than raising or leaking.
    (The loud signal for this state is backfill's own log.error — see
    test_backfill_logs_error_when_analytical_department_ends_up_empty in
    test_departments_catalog.py.)"""
    from catalog.departments import backfill_departments
    from lims_analyses.seeder import mirror_parent_hplc_analyses
    from models import AnalysisService

    # Matches no known group name and no _UNGROUPED_ANALYTICAL_LIKE_PATTERNS
    # entry — the residual gap the backfill's diagnostic exists to catch.
    db_session.add(AnalysisService(title="Mystery Service", keyword="MYSTERY-SVC"))
    db_session.commit()
    backfill_departments(db_session)   # Analytical dept row now exists, empty
    vial = _mk_isolated_vial(db_session)

    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda _sid: ["MYSTERY-SVC"],
    )
    created = mirror_parent_hplc_analyses(
        db_session,
        sub_sample=vial,
        parent_sample_id="P-0001",
        existing_kw=set(),
        created_by_user_id=None,
        commit=False,
    )
    assert created == []
