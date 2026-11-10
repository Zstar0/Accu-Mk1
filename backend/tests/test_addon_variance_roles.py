"""Heavy metals may join a variance set (add-on test Variance, Task 6).

Decision 5 (2026-11-10): a heavy metals replicate is a full digest; hm is
variance-eligible. Boot no longer pulls hm vials out of their set, and a
fresh environment seeds hm eligible. An existing role row keeps whatever
flag the owner set: the seed creates, it never overwrites.
"""
import inspect

import models  # noqa: F401  (register every ORM table before create_all)

from tests.test_hm_role_sites import _mk_parent_and_vial, _seed_catalog


def test_boot_no_longer_excludes_hm():
    import database
    src = inspect.getsource(database)
    assert "hm is single-vial" not in src
    assert "WHERE assignment_role = 'hm'" not in src
    assert "WHERE assignment_role IN ('endo', 'ster', 'xtra')" in src


def test_seed_marks_hm_variance_eligible(db_session):
    _seed_catalog(db_session)
    from catalog.roles import role_registry
    reg = role_registry(db_session)
    assert reg["hm"].variance_eligible is True
    for code in ("hplc", "endo", "ster", "xtra"):
        assert reg[code].variance_eligible is True


def test_hm_variance_vial_joins_the_set(db_session):
    _seed_catalog(db_session)
    sub = _mk_parent_and_vial(db_session, role="hm")
    from sub_samples.service import set_assignment_role
    set_assignment_role(db_session, sub.sample_id, "hm", kind="variance", wp_services={})
    db_session.refresh(sub)
    assert sub.in_variance_set is True
    assert sub.variance_exclusion_reason is None


def test_seed_never_clobbers_an_admin_flag(db_session):
    from catalog.departments import backfill_departments
    from catalog.roles import role_registry
    from catalog.vial_roles_seed import seed_vial_roles
    from models import VialRole
    backfill_departments(db_session)
    db_session.add(VialRole(code="hm", label="Heavy Metals", boxable=True,
                            variance_eligible=False, sort_order=3,
                            frozen=True, is_system=True))
    db_session.commit()
    seed_vial_roles(db_session)
    db_session.expire_all()
    assert role_registry(db_session)["hm"].variance_eligible is False
