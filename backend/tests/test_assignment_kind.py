"""assignment_kind column: stored, serialized, defaults NULL. Live DB; ZZTEST fixtures."""
from datetime import datetime
import pytest
from sqlalchemy import text
from database import SessionLocal
from models import LimsSample, LimsSubSample
from sub_samples import service as sub_service
from sub_samples.service import VarianceLockedError


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback(); s.close()


@pytest.fixture()
def fixture(db):
    parent = LimsSample(sample_id="ZZTEST-AK", peptide_name="ZZ", status="received", assignment_role="hplc")
    db.add(parent); db.flush()
    db.add(LimsSubSample(sample_id="ZZTEST-AK-S01", parent_sample_pk=parent.id, vial_sequence=1,
                         received_at=datetime.utcnow(), assignment_role="hplc",
                         external_lims_uid="zz-ak-s01", assignment_kind="variance"))
    db.commit()
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AK%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AK%'"))
    db.commit()


def test_assignment_kind_round_trips(db, fixture):
    sub = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S01'")).scalar_one()
    assert sub == "variance"


def test_assignment_kind_serializes_through_api_path(db, fixture):
    """_serialize is the real API constructor (routes.py builds every
    SubSampleResponse manually) — raw SQL tests alone would miss an
    omitted field because of the schema's None default."""
    from sub_samples.routes import _serialize
    sub = db.query(LimsSubSample).filter(LimsSubSample.sample_id == "ZZTEST-AK-S01").one()
    assert _serialize(sub).assignment_kind == "variance"


def test_assignment_kind_defaults_null(db, fixture):
    db.execute(text("INSERT INTO lims_sub_samples (sample_id, parent_sample_pk, vial_sequence, received_at, external_lims_uid) "
                    "SELECT 'ZZTEST-AK-S02', id, 2, now(), 'zz-ak-s02' FROM lims_samples WHERE sample_id='ZZTEST-AK'"))
    db.commit()
    k = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S02'")).scalar_one()
    assert k is None


def test_set_assignment_role_sets_kind(db, fixture):
    sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "hplc", kind="core")
    k = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S01'")).scalar_one()
    assert k == "core"


def test_set_assignment_rejects_bad_kind(db, fixture):
    with pytest.raises(ValueError):
        sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "hplc", kind="bogus")


def test_reassignment_blocked_when_variance_locked(db, fixture):
    db.execute(text("UPDATE lims_samples SET variance_locked_at = now() WHERE sample_id='ZZTEST-AK'"))
    db.commit()
    with pytest.raises(VarianceLockedError):
        sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "endo", kind="core")
    # Guard fires BEFORE any mutation — role must be untouched.
    db.rollback()
    r = db.execute(text("SELECT assignment_role FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S01'")).scalar_one()
    assert r == "hplc"


def test_xtra_coerces_kind_to_null(db, fixture):
    # Fixture vial starts at kind='variance'; flipping to xtra must NULL it.
    sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "xtra")
    k = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S01'")).scalar_one()
    assert k is None


# ─── Task 4: auto_assign fills core to base demand, then variance bucket ─────
# Spec 2026-06-10-variance-bucket-assignment-design.md §2: variance is a
# SEPARATE bucket (target = purchased count), not max() demand inflation.

def _vial(sample_id, role=None, kind=None, is_parent=False, seq=0):
    return {"sample_id": sample_id, "is_parent": is_parent, "vial_sequence": seq,
            "assignment_role": role, "assignment_kind": kind}


def test_auto_assign_fills_core_then_variance():
    # 1 base HPLC + variance target 2 => first vial core, surplus variance.
    vials = [
        _vial("P-S01", seq=1),
        _vial("P-S02", seq=2),
    ]
    out = sub_service.auto_assign(vials, demand={"hplc": 1, "endo": 0, "ster": 0},
                                  variance={"hplc": 2, "endo": 0, "ster": 0})
    kinds = {v["sample_id"]: (v["assignment_role"], v["assignment_kind"]) for v in out}
    assert kinds["P-S01"] == ("hplc", "core")
    assert kinds["P-S02"] == ("hplc", "variance")


def test_auto_assign_surplus_beyond_variance_goes_to_xtra():
    # core 1 + variance 1 => third vial overflows to xtra with NULL kind.
    vials = [_vial(f"P-S0{i}", seq=i) for i in (1, 2, 3)]
    out = sub_service.auto_assign(vials, demand={"hplc": 1, "endo": 0, "ster": 0},
                                  variance={"hplc": 1, "endo": 0, "ster": 0})
    got = [(v["assignment_role"], v["assignment_kind"]) for v in out]
    assert got == [("hplc", "core"), ("hplc", "variance"), ("xtra", None)]


def test_auto_assign_existing_variance_vial_decrements_variance_bucket():
    # A tech-pinned variance vial consumes a variance slot, not a core slot.
    vials = [
        _vial("P-S01", role="hplc", kind="variance", seq=1),
        _vial("P-S02", seq=2),
        _vial("P-S03", seq=3),
    ]
    out = sub_service.auto_assign(vials, demand={"hplc": 1, "endo": 0, "ster": 0},
                                  variance={"hplc": 1, "endo": 0, "ster": 0})
    got = [(v["assignment_role"], v["assignment_kind"]) for v in out]
    assert got == [("hplc", "variance"), ("hplc", "core"), ("xtra", None)]


def test_auto_assign_parent_counts_against_core():
    # Parent (kind-less, role pinned hplc) consumes the core hplc slot —
    # legacy behavior preserved.
    vials = [
        _vial("P-0001", role="hplc", is_parent=True, seq=0),
        _vial("P-0001-S01", seq=1),
    ]
    out = sub_service.auto_assign(vials, demand={"hplc": 1, "endo": 0, "ster": 0},
                                  variance={"hplc": 2, "endo": 0, "ster": 0})
    assert (out[1]["assignment_role"], out[1]["assignment_kind"]) == ("hplc", "variance")


def test_auto_assign_no_variance_arg_backwards_compatible():
    # Old call shape still works: variance defaults to zeros, fills are core.
    vials = [_vial("P-S01", seq=1), _vial("P-S02", seq=2)]
    out = sub_service.auto_assign(vials, demand={"hplc": 1, "endo": 1, "ster": 0})
    got = [(v["assignment_role"], v["assignment_kind"]) for v in out]
    assert got == [("hplc", "core"), ("endo", "core")]


def test_auto_assign_no_variance_fill_for_unordered_service():
    # A (contract-invalid) variance key on a service with zero core demand
    # must not fill variance vials — you can't buy variance for a service
    # that wasn't ordered. Surplus goes to xtra.
    vials = [_vial("P-S01", seq=1), _vial("P-S02", seq=2)]
    out = sub_service.auto_assign(vials, demand={"hplc": 0, "endo": 1, "ster": 0},
                                  variance={"hplc": 2, "endo": 0, "ster": 0})
    got = [(v["assignment_role"], v["assignment_kind"]) for v in out]
    assert got == [("endo", "core"), ("xtra", None)]


# ─── Task 4: compute_vial_plan respects variance lock (no auto-assign) ───────

@pytest.fixture()
def locked_fixture(db):
    parent = LimsSample(sample_id="ZZTEST-AKLOCK", peptide_name="ZZ", status="received",
                        assignment_role="hplc", variance_locked_at=datetime.utcnow())
    db.add(parent); db.flush()
    db.add(LimsSubSample(sample_id="ZZTEST-AKLOCK-S01", parent_sample_pk=parent.id,
                         vial_sequence=1, received_at=datetime.utcnow(),
                         external_lims_uid="zz-aklock-s01"))  # role NULL on purpose
    db.commit()
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AKLOCK%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AKLOCK%'"))
    db.commit()


def test_compute_vial_plan_skips_auto_assign_when_locked(db, locked_fixture, monkeypatch):
    """A locked parent must NOT have vials auto-assigned under it (closes the
    set_assignment_role lock-guard bypass in compute_vial_plan)."""
    monkeypatch.setattr(
        sub_service, "fetch_sample_services",
        lambda sid: {"services": {"hplcpurity_identity": True,
                                  "variance": {"hplcpurity_identity": 2}},
                     "wp_order_number": "WP-9"},
    )
    plan = sub_service.compute_vial_plan(db, "ZZTEST-AKLOCK")
    sub = next(v for v in plan["vials"] if not v["is_parent"])
    assert sub["assignment_role"] is None  # untouched in the response
    r = db.execute(text("SELECT assignment_role FROM lims_sub_samples "
                        "WHERE sample_id='ZZTEST-AKLOCK-S01'")).scalar_one()
    assert r is None  # and not persisted


# ─── Task 4 review: plan-path persistence through set_assignment_role ────────

PLAN_SERVICES = {
    "services": {"hplcpurity_identity": True, "endotoxin": True,
                 "variance": {"endotoxin": 2}},
    "wp_order_number": "WP-10",
}


@pytest.fixture()
def plan_fixture(db, monkeypatch):
    """ZZTEST parent (role hplc) + 2 NULL-role vials. IS/SENAITE-free:
    fetch_sample_services monkeypatched, seeder stubbed to a no-op."""
    monkeypatch.setattr(sub_service, "fetch_sample_services",
                        lambda sid: PLAN_SERVICES)
    monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial",
                        lambda *a, **k: None)
    parent = LimsSample(sample_id="ZZTEST-AKPP", peptide_name="ZZ",
                        status="received", assignment_role="hplc")
    db.add(parent); db.flush()
    for i in (1, 2):
        db.add(LimsSubSample(sample_id=f"ZZTEST-AKPP-S0{i}", parent_sample_pk=parent.id,
                             vial_sequence=i, received_at=datetime.utcnow(),
                             external_lims_uid=f"zz-akpp-s0{i}"))
    db.commit()
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AKPP%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AKPP%'"))
    db.commit()


def _stored_assignment(db, sample_id):
    return db.execute(text(
        "SELECT assignment_role, assignment_kind FROM lims_sub_samples "
        "WHERE sample_id = :sid"), {"sid": sample_id}).one()


def test_compute_vial_plan_persists_roles_and_kinds(db, plan_fixture):
    """Happy path: auto-assign fill order lands in the DB (role AND kind).
    Parent consumes core hplc; S01 → endo core; S02 → endo variance."""
    plan = sub_service.compute_vial_plan(db, "ZZTEST-AKPP")
    assert plan["is_unreachable"] is False
    assert tuple(_stored_assignment(db, "ZZTEST-AKPP-S01")) == ("endo", "core")
    assert tuple(_stored_assignment(db, "ZZTEST-AKPP-S02")) == ("endo", "variance")


def test_compute_vial_plan_persist_failure_is_per_vial(db, plan_fixture, monkeypatch):
    """One vial's set_assignment_role failing must not block the others:
    failed vial stays NULL (retried next GET), the rest persist, response
    stays coherent."""
    orig = sub_service.set_assignment_role

    def flaky(db_, sid, role, kind=None, user_id=None, wp_services=None):
        if sid == "ZZTEST-AKPP-S01":
            raise RuntimeError("boom")
        return orig(db_, sid, role, kind=kind, user_id=user_id,
                    wp_services=wp_services)

    monkeypatch.setattr(sub_service, "set_assignment_role", flaky)
    plan = sub_service.compute_vial_plan(db, "ZZTEST-AKPP")
    # S01 failed → untouched in the DB; S02 persisted normally.
    assert tuple(_stored_assignment(db, "ZZTEST-AKPP-S01")) == (None, None)
    assert tuple(_stored_assignment(db, "ZZTEST-AKPP-S02")) == ("endo", "variance")
    # Response stays coherent: full vial list with the computed plan.
    by_id = {v["sample_id"]: v for v in plan["vials"]}
    assert len(plan["vials"]) == 3
    assert by_id["ZZTEST-AKPP-S01"]["assignment_role"] == "endo"
    assert by_id["ZZTEST-AKPP-S02"]["assignment_kind"] == "variance"
