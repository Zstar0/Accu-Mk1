"""vial_roles catalog table: seed + registry (spec 4 Task 1)."""
import logging

from catalog.vial_roles_seed import seed_vial_roles
from catalog.roles import role_registry, real_bucket_codes, suggest_role_code
from models import VialRole


def test_seed_creates_five_legacy_roles_with_parity_flags(db_session):
    seed_vial_roles(db_session)
    reg = role_registry(db_session)
    assert set(reg) >= {"hplc", "endo", "ster", "xtra", "hm"}
    # parity with live code, NOT the spec parenthetical (deviation 3)
    assert reg["hplc"].boxable and reg["endo"].boxable and reg["ster"].boxable and reg["xtra"].boxable
    # deviation 4 CLOSED 2026-08-24: Handler ruled hm boxable with the
    # analytical-vials feature — both HM vials must route to the HM box.
    assert reg["hm"].boxable
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


def test_seed_without_departments_leaves_null_and_logs_error(db_session, caplog):
    # No backfill_departments call: every non-xtra legacy role's department
    # name fails to resolve (fix round, spec 4 self-heal).
    with caplog.at_level(logging.ERROR, logger="accumark.catalog"):
        seed_vial_roles(db_session)
    reg = role_registry(db_session)
    for code in ("hplc", "endo", "ster", "hm"):
        assert reg[code].department_id is None
    assert reg["xtra"].department_id is None  # by design, not an error case
    errors = [r for r in caplog.records if r.message.startswith("vial_roles_seed_department_unresolved")]
    logged_codes = {r.getMessage().split("code=")[1].split(" ")[0] for r in errors}
    assert logged_codes == {"hplc", "endo", "ster", "hm"}


def test_backfill_then_reseed_heals_null_department_rows(db_session, caplog):
    # First boot: departments don't exist yet, so the legacy rows seed with
    # department_id NULL (same as the test above).
    with caplog.at_level(logging.ERROR, logger="accumark.catalog"):
        seed_vial_roles(db_session)
    reg = role_registry(db_session)
    assert reg["hplc"].department_id is None

    # Second boot: departments now exist. Re-running seed_vial_roles must
    # heal the existing rows in place (NULL -> resolved id), not just skip
    # them because the code already exists.
    from catalog.departments import backfill_departments
    backfill_departments(db_session)
    caplog.clear()
    with caplog.at_level(logging.ERROR, logger="accumark.catalog"):
        seed_vial_roles(db_session)
    reg = role_registry(db_session)
    assert reg["hplc"].department.name == "Analytical"
    assert reg["endo"].department.name == "Microbiology"
    assert reg["ster"].department.name == "Microbiology"
    assert reg["hm"].department.name == "Heavy Metals"
    # healed cleanly -> no more unresolved-department errors this run
    errors = [r for r in caplog.records if r.message.startswith("vial_roles_seed_department_unresolved")]
    assert errors == []
    # still exactly one row per code — healing updates in place, never duplicates
    assert db_session.query(VialRole).filter_by(code="hplc").count() == 1


def test_heal_never_clobbers_an_admin_set_department(db_session):
    from catalog.departments import backfill_departments
    backfill_departments(db_session)
    seed_vial_roles(db_session)
    reg = role_registry(db_session)
    other_dept_id = reg["ster"].department_id  # a real, different department
    reg["hm"].department_id = other_dept_id
    db_session.commit()
    seed_vial_roles(db_session)  # re-run: hm already has a resolvable dept_id
    reg = role_registry(db_session)
    assert reg["hm"].department_id == other_dept_id  # untouched, not reset to Heavy Metals


def test_suggest_role_code_sanitizes_truncates_uniquifies():
    assert suggest_role_code("heavy_metals", set()) == "heavy_me"
    assert suggest_role_code("heavy_metals", {"heavy_me"}) == "heavy_m2"
    assert suggest_role_code("PCR-Panel 2!", set()) == "pcr_pane"
    assert suggest_role_code("x", set()) == "x"


def test_vial_role_display_faces_nullable(db_session):
    role = VialRole(code="zztest", label="ZZ Test")
    db_session.add(role)
    db_session.commit()
    assert role.color is None and role.short_label is None and role.badge_glyph is None


def test_seed_stamps_legacy_display_faces(db_session):
    seed_vial_roles(db_session)
    reg = role_registry(db_session)
    assert (reg["hplc"].color, reg["hplc"].short_label, reg["hplc"].badge_glyph) == ("green", "HPLC", "H")
    assert (reg["endo"].color, reg["endo"].short_label, reg["endo"].badge_glyph) == ("orange", "ENDO", "E")
    assert (reg["ster"].color, reg["ster"].short_label, reg["ster"].badge_glyph) == ("purple", "PCR", "P")
    assert (reg["hm"].color, reg["hm"].short_label, reg["hm"].badge_glyph) == ("slate", "HM", "M")
    assert (reg["xtra"].color, reg["xtra"].short_label, reg["xtra"].badge_glyph) == ("sky", "XTRA", "X")


def test_seed_never_clobbers_admin_color(db_session):
    seed_vial_roles(db_session)
    ster = db_session.query(VialRole).filter_by(code="ster").one()
    ster.color = "rose"
    db_session.commit()
    db_session.expire_all()  # force the post-reseed query to hit the DB, not the identity map
    seed_vial_roles(db_session)
    assert db_session.query(VialRole).filter_by(code="ster").one().color == "rose"


def test_seed_color_is_sentinel_for_whole_display_face_triple(db_session):
    # Setting color alone marks the triple as admin-owned: short_label and
    # badge_glyph stop healing too, even though they're still NULL. This is
    # deliberate (see the seed's inline comment) — lock it down so a future
    # edit to per-field guards is a conscious decision, not a silent drift.
    seed_vial_roles(db_session)
    ster = db_session.query(VialRole).filter_by(code="ster").one()
    ster.color = "rose"
    ster.short_label = None
    ster.badge_glyph = None
    db_session.commit()
    db_session.expire_all()
    seed_vial_roles(db_session)
    healed_ster = db_session.query(VialRole).filter_by(code="ster").one()
    assert healed_ster.color == "rose"
    assert healed_ster.short_label is None
    assert healed_ster.badge_glyph is None


def test_seed_never_clobbers_short_label_when_color_is_null(db_session):
    # Fix round regression: an admin choosing Auto (color=NULL) but setting
    # short_label/badge_glyph explicitly must survive a re-seed untouched.
    # The old `if row.color is None` guard fired on exactly this state and
    # re-stamped short_label/badge_glyph back to the legacy values — the
    # triple-NULL guard (color AND short_label AND badge_glyph all NULL)
    # only heals a row nobody has touched at all.
    seed_vial_roles(db_session)
    endo = db_session.query(VialRole).filter_by(code="endo").one()
    endo.color = None
    endo.short_label = "MYLABEL"
    endo.badge_glyph = "Z"
    db_session.commit()
    db_session.expire_all()
    seed_vial_roles(db_session)
    healed_endo = db_session.query(VialRole).filter_by(code="endo").one()
    assert healed_endo.color is None
    assert healed_endo.short_label == "MYLABEL"
    assert healed_endo.badge_glyph == "Z"
