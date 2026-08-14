"""Boot-time demand-catalog integrity validation (S9). Each check covers a
silent-zero path the retired legacy-wins override used to mask."""
import logging

from models import AnalysisProfile, VialRole, Department
from catalog.demand_verify import verify_demand_catalog


def _mk_profile(db, key, *, vials=1, role="endo", dim="role", active=True):
    p = AnalysisProfile(
        key=key, name=f"T {key}", is_addon=True, vials_required=vials,
        fulfillment_dim=dim, fulfillment_role=role, active=active,
    )
    db.add(p)
    db.flush()
    return p


def _mk_role(db, code, *, dept=True):
    d = None
    if dept:
        d = Department(name=f"Dept {code}")
        db.add(d)
        db.flush()
    r = VialRole(code=code, label=code.upper(), department_id=(d.id if d else None))
    db.add(r)
    db.flush()
    return r


def _seed_legacy_ok(db):
    _mk_role(db, "hplc"); _mk_role(db, "endo"); _mk_role(db, "ster")
    _mk_profile(db, "hplcpurity_identity", role="hplc")
    _mk_profile(db, "bac_water_panel", role="hplc")
    _mk_profile(db, "endotoxin", role="endo")
    _mk_profile(db, "sterility_pcr", role="ster")


def test_empty_catalog_is_not_a_violation(db_session, caplog):
    with caplog.at_level(logging.ERROR):
        assert verify_demand_catalog(db_session) == []
    assert not caplog.records


def test_healthy_catalog_is_clean(db_session):
    _seed_legacy_ok(db_session)
    assert verify_demand_catalog(db_session) == []


def test_missing_legacy_key_flagged(db_session, caplog):
    _seed_legacy_ok(db_session)
    db_session.query(AnalysisProfile).filter_by(key="endotoxin").delete()
    with caplog.at_level(logging.ERROR):
        violations = verify_demand_catalog(db_session)
    assert any("endotoxin" in v for v in violations)
    assert any("demand_catalog_integrity" in r.message for r in caplog.records)


def test_inactive_legacy_key_flagged(db_session):
    _seed_legacy_ok(db_session)
    row = db_session.query(AnalysisProfile).filter_by(key="sterility_pcr").one()
    row.active = False
    db_session.flush()
    assert any("sterility_pcr" in v for v in verify_demand_catalog(db_session))


def test_role_less_active_profile_flagged(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", role=None)
    assert any("heavy_metals" in v for v in verify_demand_catalog(db_session))


def test_zero_vials_role_profile_flagged(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", vials=0, role="hm")
    _mk_role(db_session, "hm")
    assert any("heavy_metals" in v for v in verify_demand_catalog(db_session))


def test_unfillable_role_flagged(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", role="hm")  # no vial_roles row for hm
    assert any("hm" in v for v in verify_demand_catalog(db_session))


def test_null_department_role_flagged(db_session):
    _seed_legacy_ok(db_session)
    _mk_role(db_session, "hm", dept=False)
    _mk_profile(db_session, "heavy_metals", role="hm")
    assert any("hm" in v for v in verify_demand_catalog(db_session))


def test_inactive_profiles_are_ignored(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "retired_thing", role=None, active=False)
    assert verify_demand_catalog(db_session) == []


def test_xtra_role_exempt_from_unfillable_checks(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "misc_addon", role="xtra")
    assert verify_demand_catalog(db_session) == []
