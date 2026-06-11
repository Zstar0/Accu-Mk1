"""container_mode: stored, set at creation, serialized. Live DB; ZZTEST fixtures."""
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


@pytest.fixture()
def cleanup(db):
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-CM%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-CM%'"))
    db.commit()


def test_container_mode_defaults_false_for_existing_rows(db, cleanup):
    # Raw INSERT bypasses the ORM default — proves the DB-level default that
    # legacy rows rely on.
    db.execute(text(
        "INSERT INTO lims_samples (sample_id, status) VALUES ('ZZTEST-CM-LEGACY', 'received')"))
    db.commit()
    v = db.execute(text(
        "SELECT container_mode FROM lims_samples WHERE sample_id='ZZTEST-CM-LEGACY'")).scalar_one()
    assert v is False


def test_ensure_sample_row_creates_container_parent(db, cleanup, monkeypatch):
    # ensure_sample_row is the single parent-creation path — new parents are containers.
    monkeypatch.setattr(sub_service.senaite, "fetch_parent_metadata", lambda sid: {
        "uid": "zz-cm-uid", "review_state": "received"})
    row = sub_service.ensure_sample_row(db, "ZZTEST-CM-NEW")
    db.commit()
    assert row.container_mode is True


def test_parent_summary_serializes_container_mode(db, cleanup):
    parent = LimsSample(sample_id="ZZTEST-CM-SER", status="received", container_mode=True)
    db.add(parent)
    db.commit()
    from sub_samples.schemas import ParentSampleSummary
    s = ParentSampleSummary(
        sample_id=parent.sample_id, external_lims_uid=None, peptide_name=None,
        status=parent.status, sub_sample_count=0, last_synced_at=datetime.utcnow(),
        container_mode=parent.container_mode,
    )
    assert s.container_mode is True


# --- Task 2: vial plan + variance summary omit the synthetic parent ---

CM_PLAN_SERVICES = {
    "services": {"hplcpurity_identity": True},
    "wp_order_number": "WP-11",
}


@pytest.fixture()
def cm_plan_fixture(db, monkeypatch):
    """ZZTEST container parent + 2 NULL-role vials. IS/SENAITE-free:
    fetch_sample_services monkeypatched, seeder stubbed to a no-op
    (same mechanics as test_assignment_kind.plan_fixture)."""
    monkeypatch.setattr(sub_service, "fetch_sample_services",
                        lambda sid: CM_PLAN_SERVICES)
    monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial",
                        lambda *a, **k: None)
    parent = LimsSample(sample_id="ZZTEST-CM-VP", peptide_name="ZZ",
                        status="received", container_mode=True)
    db.add(parent); db.flush()
    for i in (1, 2):
        db.add(LimsSubSample(sample_id=f"ZZTEST-CM-VP-S0{i}", parent_sample_pk=parent.id,
                             vial_sequence=i, received_at=datetime.utcnow(),
                             external_lims_uid=f"zz-cm-vp-s0{i}"))
    db.commit()
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-CM-VP%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-CM-VP%'"))
    db.commit()


def test_vial_plan_omits_parent_in_container_mode(db, cm_plan_fixture):
    plan = sub_service.compute_vial_plan(db, "ZZTEST-CM-VP")
    ids = [v["sample_id"] for v in plan["vials"]]
    assert "ZZTEST-CM-VP" not in ids  # no synthetic parent entry
    assert ids == ["ZZTEST-CM-VP-S01", "ZZTEST-CM-VP-S02"]
    assert not any(v["is_parent"] for v in plan["vials"])
    assert plan["container_mode"] is True


def test_container_auto_assign_fills_core_with_first_vial(db, cm_plan_fixture):
    """demand hplc=1: in container mode a REAL vial takes the core slot
    (legacy: the parent consumed it)."""
    sub_service.compute_vial_plan(db, "ZZTEST-CM-VP")
    role, kind = db.execute(text(
        "SELECT assignment_role, assignment_kind FROM lims_sub_samples "
        "WHERE sample_id='ZZTEST-CM-VP-S01'")).one()
    assert (role, kind) == ("hplc", "core")
    # the plan must not have touched the parent's stored role
    prole = db.execute(text(
        "SELECT assignment_role FROM lims_samples WHERE sample_id='ZZTEST-CM-VP'")).scalar_one()
    assert prole == "hplc"  # untouched server_default
