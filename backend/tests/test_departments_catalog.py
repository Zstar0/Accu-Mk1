"""Catalog: departments table + department_id columns + idempotent backfill."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401  (register all models on Base)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_department_persists_with_defaults(db_session):
    from models import Department
    d = Department(name="Microbiology")
    db_session.add(d)
    db_session.commit()
    db_session.refresh(d)
    assert d.id is not None
    assert d.sort_order == 0
    assert d.color == "blue"
    assert d.is_system is False


def test_group_and_service_have_department_id(db_session):
    from models import Department, ServiceGroup, AnalysisService
    dept = Department(name="Analytical")
    db_session.add(dept)
    db_session.commit()
    g = ServiceGroup(name="Analytics", department_id=dept.id)
    s = AnalysisService(title="Purity X", keyword="PUR_X", department_id=dept.id)
    db_session.add_all([g, s])
    db_session.commit()
    assert g.department_id == dept.id
    assert s.department_id == dept.id


def _seed_groups_and_services(db_session):
    from models import ServiceGroup, AnalysisService, service_group_members
    analytics = ServiceGroup(name="Analytics")
    micro = ServiceGroup(name="Microbiology")
    db_session.add_all([analytics, micro])
    db_session.commit()
    pur = AnalysisService(title="Purity X", keyword="PUR_X")
    ster = AnalysisService(title="Sterility PCR", keyword="STER-PCR")
    analyte = AnalysisService(title="Analyte 1 Purity", keyword="ANALYTE-1-PUR")
    db_session.add_all([pur, ster, analyte])
    db_session.commit()
    for gid, sid in ((analytics.id, pur.id), (micro.id, ster.id)):
        db_session.execute(service_group_members.insert().values(
            service_group_id=gid, analysis_service_id=sid))
    db_session.commit()
    return analytics, micro, pur, ster, analyte


def test_backfill_seeds_departments_and_assigns_from_live_groups(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    analytics, micro, pur, ster, analyte = _seed_groups_and_services(db_session)

    backfill_departments(db_session)

    names = {d.name for d in db_session.query(Department).all()}
    # spec-3 Task 3: Heavy Metals joins as the first catalog-only department.
    assert names == {"Analytical", "Microbiology", "Heavy Metals"}
    analytical_id = db_session.query(Department).filter_by(name="Analytical").one().id
    micro_id = db_session.query(Department).filter_by(name="Microbiology").one().id

    db_session.refresh(analytics); db_session.refresh(micro)
    db_session.refresh(pur); db_session.refresh(ster); db_session.refresh(analyte)
    assert analytics.department_id == analytical_id
    assert micro.department_id == micro_id
    assert pur.department_id == analytical_id
    assert ster.department_id == micro_id
    # Ungrouped ANALYTE-* services are tagged Analytical, or the fail-closed
    # HPLC allow-list in Task 2 would drop the very rows the mirror exists for.
    assert analyte.department_id == analytical_id


def test_backfill_is_idempotent(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    backfill_departments(db_session)
    # spec-3 Task 3: Heavy Metals joins as the first catalog-only department.
    assert db_session.query(Department).count() == 3


def test_backfill_never_clobbers_a_manual_reassignment(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    analytics, _micro, _pur, _ster, _a = _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    micro_id = db_session.query(Department).filter_by(name="Microbiology").one().id

    analytics.department_id = micro_id      # admin moves it by hand
    db_session.commit()
    backfill_departments(db_session)        # a restart must not undo that
    db_session.refresh(analytics)
    assert analytics.department_id == micro_id


def test_backfill_marks_only_the_three_canonical_departments_is_system(db_session):
    """The worksheet-inbox legacy lane keys (catalog.roles._LEGACY_LANE_KEYS)
    are pinned to Analytical/Microbiology/Heavy Metals BY NAME — a rename
    would silently break a stored FE pref / bookmarked ?role=. backfill
    marks exactly these three is_system=True (departments PATCH refuses a
    name change on an is_system row) and never touches any other
    department (fix round, spec 4 Task 7)."""
    from catalog.departments import backfill_departments
    from models import Department
    extra = Department(name="QC Retain")
    db_session.add(extra)
    db_session.commit()

    backfill_departments(db_session)

    system_names = {d.name for d in db_session.query(Department).filter_by(is_system=True).all()}
    assert system_names == {"Analytical", "Microbiology", "Heavy Metals"}
    db_session.refresh(extra)
    assert extra.is_system is False


def test_department_id_by_name(db_session):
    from catalog.departments import backfill_departments, department_id_by_name
    _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    assert department_id_by_name(db_session, "Analytical") is not None
    assert department_id_by_name(db_session, "Nope") is None


# ── production-shaped group naming + ungrouped rescue (Task 2 fix round) ────
#
# Production's real service_groups table has no "Analytics" row — its
# analytical bench group is named "Core HPLC" — and its HPLC analyte services
# (ID_*, HPLC-PUR, PEPT-Total, per-substance PUR_<X>/QTY_<X>) carry NO group
# membership at all. Before this fix, backfill_departments left every one of
# those services with a NULL department_id, and the fail-closed HPLC
# allow-list (lims_analyses/seeder.py) then silently mirrored ZERO analyses
# onto every HPLC vial — without the mirror's missing-department guard ever
# firing, because the Analytical department row itself still existed.


def test_backfill_recognizes_core_hplc_as_the_production_group_name(db_session):
    """Production's analytical bench group is named "Core HPLC", not
    "Analytics". The group-name map must recognize it — dropping this mapping
    is exactly what would silently empty every HPLC vial."""
    from catalog.departments import backfill_departments
    from models import AnalysisService, Department, ServiceGroup, service_group_members

    core_hplc = ServiceGroup(name="Core HPLC")
    db_session.add(core_hplc)
    db_session.commit()
    id_svc = AnalysisService(title="GHK-Cu - Identity (HPLC)", keyword="ID_GHKCU")
    db_session.add(id_svc)
    db_session.commit()
    db_session.execute(service_group_members.insert().values(
        service_group_id=core_hplc.id, analysis_service_id=id_svc.id))
    db_session.commit()

    backfill_departments(db_session)

    analytical_id = db_session.query(Department).filter_by(name="Analytical").one().id
    db_session.refresh(core_hplc)
    db_session.refresh(id_svc)
    assert core_hplc.department_id == analytical_id
    assert id_svc.department_id == analytical_id   # inherited from the group


def test_ungrouped_rescue_covers_all_enumerated_analytical_families(db_session):
    """Every ungrouped analytical keyword family production actually carries
    — confirmed against production data during the Task 2 fix round — is
    rescued into Analytical, not just ANALYTE-N-*."""
    from catalog.departments import backfill_departments
    from models import AnalysisService, Department

    keywords = [
        "ANALYTE-1-PUR", "ID_GHKCU", "HPLC-PUR", "HPLC-ID",
        "PEPT-Total", "PUR_GHKCU", "QTY_GHKCU", "BLEND-PUR",
    ]
    db_session.add_all([AnalysisService(title=kw, keyword=kw) for kw in keywords])
    db_session.commit()

    backfill_departments(db_session)

    analytical_id = db_session.query(Department).filter_by(name="Analytical").one().id
    tagged = {
        kw for (kw, dep) in db_session.query(
            AnalysisService.keyword, AnalysisService.department_id
        ).all()
        if dep == analytical_id
    }
    assert tagged == set(keywords)


def test_ungrouped_rescue_patterns_are_escaped_not_wildcards(db_session):
    """The rescue LIKE patterns contain literal underscores (PUR_, QTY_,
    ID_), which is the SQL LIKE single-char wildcard unless escaped. A decoy
    keyword that would match an UNESCAPED "PUR_%" (any single char standing
    in for "_") must NOT be rescued — only a literal-underscore match may
    land in Analytical."""
    from catalog.departments import backfill_departments
    from models import AnalysisService, Department

    real = AnalysisService(title="GHK-Cu - Purity", keyword="PUR_GHKCU")
    decoy = AnalysisService(title="Purge Foo", keyword="PURGE-FOO")
    db_session.add_all([real, decoy])
    db_session.commit()

    backfill_departments(db_session)

    analytical_id = db_session.query(Department).filter_by(name="Analytical").one().id
    db_session.refresh(real)
    db_session.refresh(decoy)
    assert real.department_id == analytical_id
    assert decoy.department_id is None   # NOT rescued: no literal-underscore match


def test_backfill_logs_error_when_analytical_department_ends_up_empty(db_session, caplog):
    """Residual-gap regression coverage: a service that matches NEITHER a
    known group name NOR any enumerated rescue pattern (a genuinely novel
    future misconfiguration, e.g. yet another unmapped production group name)
    leaves the Analytical department row existing but carrying zero tagged
    services. That state is silent everywhere except here — the mirror's
    missing-department guard never fires because the row exists — so this
    diagnostic is the only loud signal. Must fire at ERROR, not WARNING (the
    existing null_department check is a different, less severe condition)."""
    import logging
    from catalog.departments import backfill_departments
    from models import AnalysisService, Department

    db_session.add(AnalysisService(title="Mystery Service", keyword="MYSTERY-SVC"))
    db_session.commit()

    caplog.set_level(logging.ERROR)
    backfill_departments(db_session)

    assert any(
        "catalog.backfill.analytical_department_empty" in r.message
        for r in caplog.records
    )
    analytical_id = db_session.query(Department).filter_by(name="Analytical").one().id
    assert db_session.query(AnalysisService).filter_by(
        department_id=analytical_id
    ).count() == 0


def test_backfill_does_not_log_error_on_a_genuinely_empty_catalog(db_session, caplog):
    """A fresh install with no analysis_services rows at all (before the first
    SENAITE catalog sync) is not a misconfiguration and must not trip the
    empty-Analytical-department diagnostic."""
    import logging
    from catalog.departments import backfill_departments

    caplog.set_level(logging.ERROR)
    backfill_departments(db_session)

    assert not any(
        "catalog.backfill.analytical_department_empty" in r.message
        for r in caplog.records
    )
