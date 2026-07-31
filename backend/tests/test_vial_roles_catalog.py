"""vial_roles catalog table: seed + registry (spec 4 Task 1)."""
from catalog.vial_roles_seed import seed_vial_roles
from catalog.roles import role_registry, real_bucket_codes, suggest_role_code
from models import VialRole


def test_seed_creates_five_legacy_roles_with_parity_flags(db_session):
    seed_vial_roles(db_session)
    reg = role_registry(db_session)
    assert set(reg) >= {"hplc", "endo", "ster", "xtra", "hm"}
    # parity with live code, NOT the spec parenthetical (deviation 3)
    assert reg["hplc"].boxable and reg["endo"].boxable and reg["ster"].boxable and reg["xtra"].boxable
    assert not reg["hm"].boxable  # deviation 4: dark until Handler flips post-rehearsal
    for code in ("hplc", "endo", "ster", "xtra"):
        assert reg[code].variance_eligible
    assert not reg["hm"].variance_eligible
    assert all(reg[c].is_system and reg[c].frozen for c in ("hplc", "endo", "ster", "xtra", "hm"))
    assert reg["xtra"].department_id is None  # deviation 2


def test_seed_departments_match_role_department_names(db_session):
    from catalog.departments import backfill_departments
    backfill_departments(db_session)
    seed_vial_roles(db_session)
    reg = role_registry(db_session)
    assert reg["hplc"].department.name == "Analytical"
    assert reg["endo"].department.name == "Microbiology"
    assert reg["ster"].department.name == "Microbiology"
    assert reg["hm"].department.name == "Heavy Metals"


def test_seed_is_idempotent_and_never_clobbers_admin_edits(db_session):
    from catalog.departments import backfill_departments
    backfill_departments(db_session)
    seed_vial_roles(db_session)
    row = db_session.query(VialRole).filter_by(code="hm").one()
    row.label = "Heavy Metals (edited)"
    db_session.commit()
    seed_vial_roles(db_session)
    assert db_session.query(VialRole).filter_by(code="hm").one().label == "Heavy Metals (edited)"
    assert db_session.query(VialRole).filter_by(code="hplc").count() == 1


def test_seed_on_fresh_db_under_production_autoflush_config(tmp_path):
    # own sessionmaker(autoflush=False) — conftest's autoflush=True masks the bug class
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from models import Base
    eng = create_engine(f"sqlite:///{tmp_path}/fresh.db")
    Base.metadata.create_all(eng)
    S = sessionmaker(bind=eng, autoflush=False)
    with S() as s:
        from catalog.departments import backfill_departments
        backfill_departments(s)
        seed_vial_roles(s)
        assert {r.code for r in s.query(VialRole).all()} == {"hplc", "endo", "ster", "xtra", "hm"}


def test_real_bucket_codes_excludes_xtra_and_orders_by_sort(db_session):
    from catalog.departments import backfill_departments
    backfill_departments(db_session)
    seed_vial_roles(db_session)
    codes = real_bucket_codes(db_session)
    assert codes == ["hplc", "endo", "ster", "hm"]  # legacy _BUCKET_PRIORITY order via sort_order
    assert "xtra" not in codes


def test_suggest_role_code_sanitizes_truncates_uniquifies():
    assert suggest_role_code("heavy_metals", set()) == "heavy_me"
    assert suggest_role_code("heavy_metals", {"heavy_me"}) == "heavy_m2"
    assert suggest_role_code("PCR-Panel 2!", set()) == "pcr_pane"
    assert suggest_role_code("x", set()) == "x"
