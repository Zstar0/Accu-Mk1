"""Boot-time demand-catalog integrity validation (S9). Each check covers a
silent-zero path the retired legacy-wins override used to mask."""
import logging

from models import AnalysisProfile
from catalog.demand_verify import verify_demand_catalog
from tests._demand_catalog_helpers import _mk_profile, _mk_role, _seed_legacy_ok


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


def test_legacy_key_wrong_fulfillment_dim_flagged(db_session):
    """resolve_catalog_fulfillment requires fulfillment_dim == "role"
    (sub_samples/catalog_demand.py:68) — a legacy key stuck on the old
    'kind' dim passes every other check while contributing ZERO vials."""
    _seed_legacy_ok(db_session)
    row = db_session.query(AnalysisProfile).filter_by(key="endotoxin").one()
    row.fulfillment_dim = "kind"
    db_session.flush()
    violations = verify_demand_catalog(db_session)
    assert any("endotoxin" in v and "fulfillment_dim" in v for v in violations)


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


def test_inactive_roleless_profile_flagged(db_session):
    """The resolver still fulfills inactive profiles for paid orders ('still
    fulfilling: paid order') — a role-less inactive profile is exactly as
    silent-zero as an active one, so check 2 now covers it too."""
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "retired_thing", role=None, active=False)
    violations = verify_demand_catalog(db_session)
    assert any("retired_thing" in v and "inactive" in v for v in violations)


def test_inactive_properly_configured_profile_not_flagged(db_session):
    """An inactive profile that DOES carry a role/vials is still exempt from
    checks 3-4 (unfillable role / null department stay active-only) — only
    the role-less condition follows an inactive profile."""
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "retired_thing", active=False)
    assert verify_demand_catalog(db_session) == []


def test_xtra_role_exempt_from_unfillable_checks(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "misc_addon", role="xtra")
    assert verify_demand_catalog(db_session) == []
