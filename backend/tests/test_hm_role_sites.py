"""Site checklist for the hm role landing (spec-3 Task 3).

hm is the first catalog-only fulfillment role (profile heavy_metals,
fulfillment_role='hm', fulfillment_dim='role'). These tests pin the sites
that let an hm vial be assigned, seeded, laned, and variance-excluded:
_VALID_ROLES/_BUCKET_PRIORITY/_REAL_BUCKETS, the "Heavy Metals" Department
(backfill_departments), the inbox lane maps (ROLE_TO_DEPARTMENT_NAME /
ROLE_TO_VIAL_ROLES), role-flip cleanup keying (_ROLE_DEPARTMENT_NAMES), and
the live variance-exclusion recompute in set_assignment_role.
"""


def _mk_parent_and_vial(db, *, role):
    """Throwaway parent + vial (flush only), same shape as
    test_catalog_seeding.py's helper of the same name / test_seeder_mirror.py's
    _throwaway_vial."""
    from models import LimsSample, LimsSubSample
    parent = LimsSample(sample_id="ZZTEST-HMSITES", external_lims_uid="zz-uid-hmsites")
    db.add(parent); db.flush()
    v = LimsSubSample(
        sample_id="ZZTEST-HMSITES-S01",
        vial_sequence=0,
        parent_sample_pk=parent.id,
        external_lims_uid="zz-vuid-hmsites",
        assignment_role=role,
    )
    db.add(v); db.flush()
    return v


def test_hm_is_a_valid_role():
    from sub_samples.service import _VALID_ROLES, _BUCKET_PRIORITY, _REAL_BUCKETS
    assert "hm" in _VALID_ROLES and "hm" in _REAL_BUCKETS and "hm" in _BUCKET_PRIORITY


def test_hm_department_exists_after_backfill(db_session):
    from catalog.departments import backfill_departments, HEAVY_METALS_DEPARTMENT
    from models import Department
    backfill_departments(db_session); db_session.commit()
    assert db_session.query(Department).filter_by(name=HEAVY_METALS_DEPARTMENT).one()


def test_hm_maps_to_exactly_one_inbox_lane():
    from main import ROLE_TO_DEPARTMENT_NAME, ROLE_TO_VIAL_ROLES
    lanes = [k for k, roles in ROLE_TO_VIAL_ROLES.items() if "hm" in roles]
    assert lanes == ["hm"]
    assert ROLE_TO_DEPARTMENT_NAME["hm"] == "Heavy Metals"


def test_role_flip_cleanup_keys_hm_on_its_own_department():
    from sub_samples.service import _ROLE_DEPARTMENT_NAMES
    assert _ROLE_DEPARTMENT_NAMES["hm"] == {"Heavy Metals"}
    # the ambiguity this department exists to prevent:
    assert "Heavy Metals" not in _ROLE_DEPARTMENT_NAMES["hplc"]


def test_hm_vial_is_variance_excluded(db_session):
    """Site 7 — the physical-outcome site. An hm vial must never be
    variance-eligible. Exercise the real recompute path, not the backfill.

    wp_services={} is passed explicitly (rather than left to default None)
    so the role-flip seeding hook inside set_assignment_role skips its WP/IS
    fetch entirely — no catalog profile is set up here, and no live HTTP call
    should happen in a unit test (see test_seeder_mirror.py:88 for the
    monkeypatch alternative when a call genuinely needs to be stubbed)."""
    sub = _mk_parent_and_vial(db_session, role="hm")
    from sub_samples.service import set_assignment_role
    set_assignment_role(db_session, sub.sample_id, "hm", wp_services={})
    db_session.refresh(sub)
    assert sub.in_variance_set is False
