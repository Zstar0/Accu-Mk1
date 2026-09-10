"""Boot seed for the native HPLC family (spec 2026-09-10, M2): five
origin=mk1 services, ONE profile `hplc-purity-identity` with the five as
ordered members, and the parity spec rows. Idempotent; admin edits survive.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import Base


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


KEYWORDS = ("HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY",
            "HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL")


def test_seed_creates_five_mk1_services_in_analytical(db_session):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisService, Department
    db_session.add(Department(name="Analytical"))
    db_session.commit()
    report = seed_hplc_native_catalog(db_session)
    assert report["services"] == 5
    rows = {s.keyword: s for s in db_session.query(AnalysisService).all()}
    assert set(rows) == set(KEYWORDS)
    dept = db_session.query(Department).filter_by(name="Analytical").one()
    for kw in KEYWORDS:
        assert rows[kw].origin == "mk1"
        assert rows[kw].department_id == dept.id
    assert (rows["HPLC-PURITY"].unit, rows["HPLC-PURITY"].result_type,
            rows["HPLC-PURITY"].variance_capable) == ("%", "numeric", True)
    assert (rows["HPLC-QUANTITY"].unit, rows["HPLC-QUANTITY"].variance_capable) == ("mg", True)
    assert (rows["HPLC-IDENTITY"].unit, rows["HPLC-IDENTITY"].result_type,
            rows["HPLC-IDENTITY"].variance_capable) == (None, "string", False)


def test_seed_creates_profile_with_ordered_members(db_session):
    """Finding 2 (final review): seeded INACTIVE — activating it is an
    explicit flip-runbook step, not something the boot seed decides."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog, HPLC_NATIVE_PROFILE_KEY
    from models import AnalysisProfile
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    assert (prof.is_addon, prof.vials_required, prof.fulfillment_role,
            prof.fulfillment_dim, prof.coa_archetype, prof.active) == (
        False, 1, "hplc", "role", None, False)
    assert [s.keyword for s in prof.analysis_services] == list(KEYWORDS)


def test_seed_is_idempotent_and_keeps_admin_edits(db_session):
    """Finding 2: the seed mints the profile INACTIVE; an admin flipping
    active=True (the flip-runbook step) must survive a re-seed exactly like
    any other admin edit — the seed never resurrects/reverts it."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisProfile, AnalysisService
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key="hplc-purity-identity").one()
    assert prof.active is False   # seeded inactive
    prof.vials_required = 2          # admin edit
    prof.active = True               # admin flip-runbook step
    svc = db_session.query(AnalysisService).filter_by(keyword="HPLC-PURITY").one()
    svc.title = "Purity (edited)"    # admin edit
    db_session.commit()
    report = seed_hplc_native_catalog(db_session)
    assert report == {"services": 0, "profile": 0, "members": 0, "specs": 0}
    assert db_session.query(AnalysisService).count() == 5
    assert prof.vials_required == 2 and svc.title == "Purity (edited)"
    assert prof.active is True


def test_seed_skips_when_department_missing(db_session, caplog):
    """No Analytical department (fresh dev DB before backfill): services still
    seed with department_id NULL and a WARNING — backfill_departments runs
    BEFORE this seeder in database.init_db, so it can't have tagged rows
    that didn't exist yet; its HPLC-% LIKE rescue only catches them on the
    NEXT boot."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisService
    with caplog.at_level("WARNING"):
        seed_hplc_native_catalog(db_session)
    assert db_session.query(AnalysisService).count() == 5
    assert any("hplc_native_seed.no_analytical_department" in r.message for r in caplog.records)


def test_keywords_pass_native_keyword_rules(db_session):
    from main import validate_new_keyword
    for kw in KEYWORDS:
        validate_new_keyword(db_session, kw)   # must not raise on an empty catalog


def test_profile_key_not_in_product_registry():
    """Never add hplc-purity-identity to PRODUCT_REGISTRY — the legacy
    profile seed and test_profile_parity pin that set."""
    from sub_samples.product_registry import PRODUCT_REGISTRY
    assert "hplc-purity-identity" not in PRODUCT_REGISTRY


def test_change_log_rows_written(db_session):
    """entity_type literals mirror main.py's live routes (POST
    /analysis-services and POST /analysis-profiles use "service" / "profile",
    not "analysis_service" / "analysis_profile" — confirmed by grepping
    log_create( call sites in main.py, ~3668 and ~18972). Also covers the
    profile_members audit row written by log_members (PUT
    /analysis-profiles/{id}/members ~19191 uses entity_type="profile_members",
    field="member_ids")."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog, HPLC_NATIVE_PROFILE_KEY
    from models import AnalysisProfile, AnalysisService, CatalogChangeLog
    report = seed_hplc_native_catalog(db_session)
    rows = db_session.query(CatalogChangeLog).all()
    actions = [(r.entity_type, r.action) for r in rows]
    assert actions.count(("service", "create")) == 5
    assert actions.count(("profile", "create")) == 1

    member_rows = [r for r in rows if r.entity_type == "profile_members"]
    assert len(member_rows) == 1
    member_row = member_rows[0]
    assert member_row.action == "update"

    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    assert member_row.entity_pk == prof.id

    expected_service_ids = [
        db_session.query(AnalysisService).filter_by(keyword=kw).one().id
        for kw in KEYWORDS
    ]
    changed = member_row.details["changed"]["member_ids"]
    assert changed["before"] == []
    assert changed["after"] == expected_service_ids

    # A second run must not write any additional change-log rows of any kind.
    before_count = db_session.query(CatalogChangeLog).count()
    report2 = seed_hplc_native_catalog(db_session)
    assert report2 == {"services": 0, "profile": 0, "members": 0, "specs": 0}
    assert db_session.query(CatalogChangeLog).count() == before_count


def test_spec_audit_rows_written(db_session):
    """Finding 2: record_spec_change writes one AuditLog row per seeded spec
    (operation="analysis_service_spec_changed"), before=None for creation.
    Mirrors test_service_spec_seed.py::test_seed_writes_audit_rows."""
    from catalog.hplc_native_seed import HPLC_NATIVE_SPECS, seed_hplc_native_catalog
    from models import AnalysisService, AnalysisServiceSpec, AuditLog
    seed_hplc_native_catalog(db_session)
    logs = (db_session.query(AuditLog)
            .filter(AuditLog.operation == "analysis_service_spec_changed")
            .all())
    assert len(logs) == 5

    expected_spec_ids = set()
    for keyword in HPLC_NATIVE_SPECS:
        svc = db_session.query(AnalysisService).filter_by(keyword=keyword).one()
        spec = (db_session.query(AnalysisServiceSpec)
                .filter(AnalysisServiceSpec.analysis_service_id == svc.id,
                        AnalysisServiceSpec.matrix.is_(None),
                        AnalysisServiceSpec.peptide_id.is_(None))
                .one())
        expected_spec_ids.add(spec.id)

    logged_ids = {int(entry.entity_id) for entry in logs}
    assert logged_ids == expected_spec_ids
    for entry in logs:
        assert entry.entity_type == "analysis_service_spec"
        assert entry.details["before"] is None
        assert entry.details["actor_user_id"] is None


def test_init_db_calls_hplc_native_seed_between_vial_roles_and_specs(monkeypatch):
    """Order pin: vial_roles -> hplc_native -> service_specs. Uses the same
    trick as test_workflow_engine: run the REAL init_db with every seeder
    stubbed to record its name."""
    import database
    calls = []

    def _rec(name):
        def _f(*a, **k):
            calls.append(name)
        return _f

    class _FakeSession:
        """No-op stand-in for a real SQLAlchemy Session/context manager, so
        `with SessionLocal() as _db:` in init_db never opens a connection --
        every seeder it wraps is stubbed below and never touches `_db`."""
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def commit(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(database, "_run_migrations", _rec("migrations"))
    monkeypatch.setattr(database.Base.metadata, "create_all", _rec("create_all"))
    monkeypatch.setattr(database, "_seed_federal_holidays_window", _rec("holidays"))
    # init_db also opens a fresh SessionLocal() around every seeder call; stub
    # it too so no stubbed seeder (or the try/except plumbing around it) ever
    # touches a real database connection.
    monkeypatch.setattr(database, "SessionLocal", lambda: _FakeSession())

    import catalog.per_substance_reconciler as psr
    import workflow.seeds as wfs
    import catalog.departments as dep
    import catalog.profile_seed as ps
    import catalog.vial_roles_seed as vr
    import catalog.hplc_native_seed as hn
    import catalog.service_spec_seed as ss
    import catalog.demand_verify as dv

    monkeypatch.setattr(psr, "reconcile_per_substance_services", _rec("reconcile_per_substance"))
    monkeypatch.setattr(wfs, "seed_workflow_catalog", _rec("workflow_catalog"))
    monkeypatch.setattr(dep, "backfill_departments", _rec("backfill_departments"))
    monkeypatch.setattr(ps, "seed_profiles_from_registry", _rec("profiles_from_registry"))
    monkeypatch.setattr(vr, "seed_vial_roles", _rec("vial_roles"))
    monkeypatch.setattr(hn, "seed_hplc_native_catalog", _rec("hplc_native"))
    monkeypatch.setattr(ss, "seed_service_specs", _rec("service_specs"))
    monkeypatch.setattr(dv, "verify_demand_catalog", _rec("demand_verify"))

    database.init_db()

    assert calls.index("vial_roles") < calls.index("hplc_native") < calls.index("service_specs")


def test_seeded_services_match_admin_create_contract(db_session):
    """The admin POST /analysis-services validator must accept every seeded
    keyword AFTER the seed too (exclude_id) -- proves an operator can edit
    them without tripping the collision rule."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from main import validate_new_keyword
    from models import AnalysisService
    seed_hplc_native_catalog(db_session)
    for svc in db_session.query(AnalysisService).all():
        validate_new_keyword(db_session, svc.keyword, exclude_id=svc.id)


def test_seeded_inactive_profile_hidden_from_manage_analyses_picker(db_session):
    """Finding 2: native_profiles_for_parent (the Manage Analyses picker
    payload) filters on AnalysisProfile.active.is_(True). The seed mints
    hplc-purity-identity INACTIVE specifically so it does not appear as
    addable on every existing sample on deploy day -- assert that directly
    against the real picker function, not just the raw `active` column."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from lims_analyses.manage_native import native_profiles_for_parent
    from models import LimsSample

    seed_hplc_native_catalog(db_session)
    parent = LimsSample(sample_id="TEST-PICKER-1", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()

    profiles = native_profiles_for_parent(db_session, parent=parent)
    assert "hplc-purity-identity" not in {p["key"] for p in profiles}


def test_verify_demand_catalog_logs_no_violation_for_inactive_seeded_profile(db_session, caplog):
    """Finding 2: hplc-purity-identity is not one of the four
    LEGACY_DEMAND_KEYS, and it IS role-dim with a fulfillment_role -- the
    only demand_verify checks that would fire on an inactive role-dim
    profile are scoped to `role_dim` (active-only) by controller ruling, so
    seeding it inactive must not trip verify_demand_catalog at all."""
    from catalog.demand_verify import verify_demand_catalog
    from catalog.hplc_native_seed import seed_hplc_native_catalog

    seed_hplc_native_catalog(db_session)
    with caplog.at_level("ERROR"):
        violations = verify_demand_catalog(db_session)
    assert not any("hplc-purity-identity" in v for v in violations)
    assert not any("hplc-purity-identity" in r.message for r in caplog.records)


def test_keyword_collision_skips_service_and_aborts_profile(db_session, caplog):
    """Finding 3: a pre-existing senaite-origin HPLC-PURITY row must block
    the mk1 seed from minting a cross-origin duplicate under the same
    keyword. No mk1 duplicate, an ERROR logged, and (per the controller
    ruling) no profile created at all -- five members or none."""
    from catalog.hplc_native_seed import (HPLC_NATIVE_PROFILE_KEY,
                                          seed_hplc_native_catalog)
    from models import AnalysisProfile, AnalysisService

    senaite_row = AnalysisService(title="HPLC Purity (SENAITE)", keyword="HPLC-PURITY",
                                  origin="senaite")
    db_session.add(senaite_row)
    db_session.commit()

    with caplog.at_level("ERROR"):
        report = seed_hplc_native_catalog(db_session)

    mk1_dupes = (db_session.query(AnalysisService)
                 .filter_by(keyword="HPLC-PURITY", origin="mk1").all())
    assert mk1_dupes == []
    assert report["profile"] == 0
    assert db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one_or_none() is None
    assert any("hplc_native_seed.keyword_collision" in r.message
               and "HPLC-PURITY" in r.message for r in caplog.records)
    assert any("hplc_native_seed.profile_creation_aborted" in r.message
               for r in caplog.records)

    # The other four (non-colliding) services still seed normally.
    other_kws = {kw for kw in KEYWORDS if kw != "HPLC-PURITY"}
    seeded = {s.keyword for s in db_session.query(AnalysisService)
              .filter(AnalysisService.origin == "mk1").all()}
    assert seeded == other_kws
    assert report["services"] == 4

    # Re-running after the collision is resolved (senaite row renamed away)
    # lets the seed complete on the next boot.
    senaite_row.keyword = "HPLC-PURITY-LEGACY"
    db_session.commit()
    report2 = seed_hplc_native_catalog(db_session)
    assert report2["services"] == 1 and report2["profile"] == 1 and report2["members"] == 5
    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    assert [s.keyword for s in prof.analysis_services] == list(KEYWORDS)
