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
    from catalog.hplc_native_seed import seed_hplc_native_catalog, HPLC_NATIVE_PROFILE_KEY
    from models import AnalysisProfile
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    assert (prof.is_addon, prof.vials_required, prof.fulfillment_role,
            prof.fulfillment_dim, prof.coa_archetype, prof.active) == (
        False, 1, "hplc", "role", None, True)
    assert [s.keyword for s in prof.analysis_services] == list(KEYWORDS)


def test_seed_is_idempotent_and_keeps_admin_edits(db_session):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisProfile, AnalysisService
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key="hplc-purity-identity").one()
    prof.vials_required = 2          # admin edit
    svc = db_session.query(AnalysisService).filter_by(keyword="HPLC-PURITY").one()
    svc.title = "Purity (edited)"    # admin edit
    db_session.commit()
    report = seed_hplc_native_catalog(db_session)
    assert report == {"services": 0, "profile": 0, "members": 0, "specs": 0}
    assert db_session.query(AnalysisService).count() == 5
    assert prof.vials_required == 2 and svc.title == "Purity (edited)"


def test_seed_skips_when_department_missing(db_session, caplog):
    """No Analytical department (fresh dev DB before backfill): services still
    seed with department_id NULL and a WARNING — backfill_departments'
    HPLC-% LIKE rescue tags them on the same boot."""
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
