"""Plan 1C Task 3: the Sterility tenant is additive — existing intake is
byte-identical, and the new tenant routes by Department.

Live Postgres for the routing checks (catalog seeded at boot, incl. Task 2's
tenant). Rollback teardown; ZZTEST throwaway vial.

NOTE: LimsSubSample.external_lims_uid is NOT NULL — the brief omitted it.
Corrected per the _throwaway_vial pattern in test_seeder_mirror.py:45-52.
"""
import pytest
from sqlalchemy import select

from database import SessionLocal
from models import AnalysisService, Department, LimsSample, LimsSubSample
from catalog.departments import department_id_by_name
from sub_samples.service import derive_base_demand
from lims_analyses.seeder import select_services_for_role, _micro_group_keywords


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


# ── Demand parity: sterility_pcr order still provisions 2 vials ────────────────
def test_demand_sterility_pcr_still_two_vials():
    assert derive_base_demand({"sterility_pcr": True})["ster"] == 2
    assert derive_base_demand({"sterility_pcr": False})["ster"] == 0


# ── Seeding parity: a `ster` vial still resolves to STER-PCR (legacy path) ─────
def test_seeding_ster_role_still_selects_ster_pcr(db):
    services = select_services_for_role(db, "ster")
    assert {s.keyword for s in services} == {"STER-PCR"}


# ── New tenant is micro-classified (the landmine positive assertion) ──────────
def test_native_usp71_is_micro_classified(db):
    micro_kw = _micro_group_keywords(db)
    assert "STER-USP71" in micro_kw
    assert {"PCR-FUNGI", "PCR-BACTERIA", "STER-PCR", "ENDO-LAL"} <= micro_kw


# ── New micro services never leak onto an HPLC vial (Department exclusion) ─────
def test_new_micro_services_excluded_from_hplc_mirror(db, monkeypatch):
    from lims_analyses.seeder import seed_analyses_for_vial
    # external_lims_uid is NOT NULL on LimsSubSample — add per test_seeder_mirror.py pattern
    parent = LimsSample(sample_id="ZZTEST-PARITY", external_lims_uid="zz-uid-parity")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(
        sample_id="ZZTEST-PARITY-S01",
        vial_sequence=0,
        parent_sample_pk=parent.id,
        external_lims_uid="zz-vuid-parity",
    )
    db.add(vial)
    db.flush()
    # Force the parent's analyte set to include the new sterility keywords.
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["HPLC-ID", "STER-USP71", "PCR-FUNGI", "PCR-BACTERIA"],
    )
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False,
    )
    seeded = {r.keyword for r in inserted}
    assert seeded.isdisjoint({"STER-USP71", "PCR-FUNGI", "PCR-BACTERIA"})


# ── New micro groups land in the micro inbox lane (Department-keyed) ──────────
def test_new_sterility_groups_in_micro_inbox_lane(db):
    from main import _inbox_allowed_group_ids
    from models import ServiceGroup
    allowed = _inbox_allowed_group_ids(db, "microbiology")
    for name in ("Sterility PCR", "Sterility USP<71>"):
        gid = db.execute(select(ServiceGroup.id).where(ServiceGroup.name == name)).scalar_one()
        assert gid in allowed, f"{name} not in the micro lane"
