"""Backend role-site conversions (spec 4, Task 7): every hardcoded role
constant becomes a read of the vial_roles catalog. Fail-closed by
construction — an unknown role raises/400s, never silently drops.

Local `db_session` fixture (plain in-memory SQLite, not the shared
conftest one) so each test controls exactly which vial_roles rows exist —
the conversion's whole point is that behavior now comes from catalog data,
not a hardcoded set.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401  (register all ORM tables before create_all)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


def _mk_role(db, code, *, department_id=None, boxable=False,
            variance_eligible=False, sort_order=50, frozen=False):
    from models import VialRole
    role = VialRole(code=code, label=code, department_id=department_id,
                    boxable=boxable, variance_eligible=variance_eligible,
                    sort_order=sort_order, frozen=frozen, is_system=False)
    db.add(role)
    db.commit()
    return role


def _mk_vial(db, *, sample_id, role=None):
    from models import LimsSample, LimsSubSample
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"{sample_id}-uid")
    db.add(parent)
    db.flush()
    v = LimsSubSample(
        sample_id=f"{sample_id}-S01", vial_sequence=1, parent_sample_pk=parent.id,
        external_lims_uid=f"{sample_id}-S01-uid", assignment_role=role,
    )
    db.add(v)
    db.commit()
    return v


# ─── set_assignment_role: catalog-driven validation (was _VALID_ROLES) ──────

def test_unknown_role_raises_value_error(db_session):
    import sub_samples.service as svc
    v = _mk_vial(db_session, sample_id="ZZTEST-RSC-UNK")
    with pytest.raises(ValueError):
        svc.set_assignment_role(db_session, v.sample_id, "not_a_real_role")


# ─── next_box: catalog-driven boxable (was BOXABLE_ROLES) ──────────────────

def test_next_box_unknown_role_raises_value_error(db_session):
    from boxes import service as box_service
    with pytest.raises(ValueError):
        box_service.next_box(db_session, "WP-ZZUNK", "not_a_real_role", user_id=1)


def test_boxable_flag_flip_changes_next_box_without_code_change(db_session):
    """Rehearsal proof surrogate for the eventual hm boxable=True flip
    (spec-3 Task 3 dark launch): flipping ONE catalog row's `boxable` flag
    changes next_box's behavior with zero code changes on either side."""
    from boxes import service as box_service
    role = _mk_role(db_session, "zztestbx", boxable=False)

    with pytest.raises(ValueError):
        box_service.next_box(db_session, "WP-ZZBOX", "zztestbx", user_id=1)

    role.boxable = True
    db_session.commit()

    box = box_service.next_box(db_session, "WP-ZZBOX", "zztestbx", user_id=1)
    assert box.role == "zztestbx"


# ─── set_assignment_role: catalog-driven variance eligibility ──────────────
# (was _VARIANCE_INELIGIBLE_ROLES / _VARIANCE_INELIGIBLE_REASON)

def test_variance_ineligible_role_gets_new_generic_reason(db_session, monkeypatch):
    monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial", lambda *a, **k: [])
    import sub_samples.service as svc
    _mk_role(db_session, "zzvarin", variance_eligible=False)
    v = _mk_vial(db_session, sample_id="ZZTEST-RSC-VARIN")

    svc.set_assignment_role(db_session, v.sample_id, "zzvarin", wp_services={})
    db_session.refresh(v)
    assert v.in_variance_set is False
    assert v.variance_exclusion_reason == "auto: role zzvarin is not variance-eligible"


# ─── set_assignment_role: frozen maintenance (new site) ────────────────────

def test_frozen_flips_on_first_assignment(db_session, monkeypatch):
    monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial", lambda *a, **k: [])
    import sub_samples.service as svc
    role = _mk_role(db_session, "zzfroz", variance_eligible=True, frozen=False)
    v = _mk_vial(db_session, sample_id="ZZTEST-RSC-FROZ")
    assert role.frozen is False

    svc.set_assignment_role(db_session, v.sample_id, "zzfroz", wp_services={})

    db_session.refresh(role)
    assert role.frozen is True


# ─── inbox_lanes: catalog-driven lanes (was ROLE_TO_DEPARTMENT_NAME /
# VALID_INBOX_ROLES / ROLE_TO_VIAL_ROLES) ────────────────────────────────────

def _seed_legacy(db):
    from catalog.departments import backfill_departments
    from catalog.vial_roles_seed import seed_vial_roles
    backfill_departments(db)
    seed_vial_roles(db)


def test_legacy_lane_keys_unchanged(db_session):
    from catalog.roles import inbox_lanes
    _seed_legacy(db_session)

    lanes = inbox_lanes(db_session)
    assert set(lanes) == {"hplc", "microbiology", "hm"}
    assert lanes["hplc"].role_codes == {"hplc"}
    assert lanes["microbiology"].role_codes == {"ster", "endo"}
    assert lanes["hm"].role_codes == {"hm"}


def test_new_department_role_appears_as_slugified_lane_and_in_union(db_session):
    from catalog.roles import inbox_lanes
    from models import Department
    _seed_legacy(db_session)

    dept = Department(name="QC Retain Samples")
    db_session.add(dept)
    db_session.flush()
    _mk_role(db_session, "zzqcret", department_id=dept.id, sort_order=60)

    lanes = inbox_lanes(db_session)
    assert "qc_retain_samples" in lanes
    assert lanes["qc_retain_samples"].role_codes == {"zzqcret"}
    # legacy keys still exactly what they were before the new lane existed.
    assert {"hplc", "microbiology", "hm"} <= set(lanes)

    # The main.py route's role=None branch computes exactly this union —
    # replicate the formula here to prove it's live off the catalog, not a
    # hand-duplicated literal (which would never contain "zzqcret").
    computed_union = set().union(*(l.role_codes for l in lanes.values()))
    assert "zzqcret" in computed_union
    assert {"hplc", "endo", "ster", "hm"} <= computed_union
