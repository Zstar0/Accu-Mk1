"""The sample list's Assigned column must not print a role no vial carries.

A container-mode parent is a report depository, never a physical vial, and
nothing ever sets its ``assignment_role``: it keeps the column default
``hplc``. For an a la carte order (no HPLC vial) the list showed "HPLC" on a
parent whose only vial is an endotoxin vial. ``aggregate_by_parent`` now
returns ``assigned_roles``: the stored parent role as before, except for a
container parent whose vials carry roles and none of them is the stored one,
where it is the vials' own roles.

Service test against the LIVE accumark_mk1 DB: ZZTEST-AGGR fixtures with
explicit teardown (same idiom as test_variance_aggregate.py).
"""
from datetime import datetime

import pytest
from sqlalchemy import text

from database import SessionLocal
from models import LimsSample, LimsSubSample
from sub_samples import service as sub_service


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _make_parent(db, sample_id, *, container, vial_roles, parent_role="hplc"):
    parent = LimsSample(
        sample_id=sample_id, peptide_name="ZZ AggR", status="received",
        assignment_role=parent_role, container_mode=container,
    )
    db.add(parent)
    db.flush()
    for i, role in enumerate(vial_roles, start=1):
        db.add(LimsSubSample(
            sample_id=f"{sample_id}-S{i:02d}", parent_sample_pk=parent.id,
            vial_sequence=i, received_at=datetime.utcnow(), assignment_role=role,
            external_lims_uid=f"zz-uid-aggr-{sample_id}-s{i:02d}",
        ))
    db.commit()


@pytest.fixture()
def aggr_fixture(db):
    # A la carte shapes: a container parent with the default role and no HPLC vial.
    _make_parent(db, "ZZTEST-AGGR-ENDO", container=True, vial_roles=["endo85"])
    _make_parent(db, "ZZTEST-AGGR-TWO", container=True, vial_roles=["endo85", "fentanyl"])
    _make_parent(db, "ZZTEST-AGGR-DUP", container=True, vial_roles=["endo85", "endo85"])
    # Shapes that must read exactly as before.
    _make_parent(db, "ZZTEST-AGGR-HPLC", container=True, vial_roles=["hplc", "endo"])
    _make_parent(db, "ZZTEST-AGGR-LEGACY", container=False, vial_roles=["endo"])
    _make_parent(db, "ZZTEST-AGGR-NOROLE", container=True, vial_roles=[None])
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AGGR%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AGGR%'"))
    db.commit()


def _agg(db, *ids):
    return sub_service.aggregate_by_parent(db, list(ids))


def test_container_parent_with_no_vial_of_its_stored_role_shows_the_vial_role(db, aggr_fixture):
    out = _agg(db, "ZZTEST-AGGR-ENDO")["ZZTEST-AGGR-ENDO"]
    assert out["assigned_roles"] == ["endo85"]
    # The stored value is reported unchanged: only the display list differs.
    assert out["parent_role"] == "hplc"
    assert out["vial_count"] == 1


def test_container_parent_lists_each_distinct_vial_role_in_vial_order(db, aggr_fixture):
    out = _agg(db, "ZZTEST-AGGR-TWO", "ZZTEST-AGGR-DUP")
    assert out["ZZTEST-AGGR-TWO"]["assigned_roles"] == ["endo85", "fentanyl"]
    assert out["ZZTEST-AGGR-DUP"]["assigned_roles"] == ["endo85"]


def test_parent_whose_stored_role_is_carried_by_a_vial_reads_as_before(db, aggr_fixture):
    out = _agg(db, "ZZTEST-AGGR-HPLC")["ZZTEST-AGGR-HPLC"]
    assert out["assigned_roles"] == ["hplc"]
    assert out["parent_role"] == "hplc"


def test_legacy_parent_that_is_itself_a_vial_keeps_its_own_role(db, aggr_fixture):
    # Not container mode: the parent IS vial 1, so its stored role is real even
    # though no sub-sample carries it.
    out = _agg(db, "ZZTEST-AGGR-LEGACY")["ZZTEST-AGGR-LEGACY"]
    assert out["assigned_roles"] == ["hplc"]


def test_container_parent_whose_vials_have_no_role_yet_reads_as_before(db, aggr_fixture):
    out = _agg(db, "ZZTEST-AGGR-NOROLE")["ZZTEST-AGGR-NOROLE"]
    assert out["assigned_roles"] == ["hplc"]


def test_sub_sample_lookup_lists_its_own_role(db, aggr_fixture):
    out = _agg(db, "ZZTEST-AGGR-TWO-S02", "ZZTEST-AGGR-NOROLE-S01")
    assert out["ZZTEST-AGGR-TWO-S02"]["assigned_roles"] == ["fentanyl"]
    assert out["ZZTEST-AGGR-TWO-S02"]["parent_role"] == "fentanyl"
    assert out["ZZTEST-AGGR-NOROLE-S01"]["assigned_roles"] == ["unassigned"]


def test_route_response_carries_assigned_roles():
    # FastAPI response_model drops undeclared keys silently: the schema must
    # declare the field or the list page never receives it.
    from sub_samples.schemas import ParentAggregate

    assert "assigned_roles" in ParentAggregate.model_fields
    agg = ParentAggregate(vial_count=1, parent_role="hplc", assigned_roles=["endo85"])
    assert agg.model_dump()["assigned_roles"] == ["endo85"]


def test_zztest_cleaned(db):
    n = db.execute(text(
        "SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AGGR%'"
    )).scalar_one()
    assert n == 0
