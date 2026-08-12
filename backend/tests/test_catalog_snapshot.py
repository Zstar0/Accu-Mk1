"""S4 snapshot rider (task 5): registration stamps a frozen catalog_snapshot.

`test_catalog_demand.py`'s `db_session` idiom covers the pure
`compute_catalog_snapshot` unit tests (self-contained in-memory SQLite via
conftest). The registration-bg-task tests build their OWN engine + session
instead, because `_native_placeholders_at_registration_bg` opens its own
session via `from database import SessionLocal` — asserting the stamp landed
requires monkeypatching `database.SessionLocal` to a sessionmaker bound to
the SAME engine the fixtures seeded, not the shared conftest session (whose
data the bg task's own session would never see). `sqlite:///:memory:`
defaults to a single-connection-per-thread pool, so a fresh `Session()` off
that sessionmaker sees data committed by an earlier one in the same test.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401 — registers AnalysisProfile/AnalysisService before create_all()
from database import Base
from models import AnalysisProfile, AnalysisService, LimsSample, profile_ride_hosts

from catalog.snapshot import compute_catalog_snapshot


# ── compute_catalog_snapshot: pure unit tests (conftest db_session) ────────


def _mk_service(db, *, keyword, title, origin="mk1"):
    svc = AnalysisService(title=title, keyword=keyword, origin=origin)
    db.add(svc)
    db.commit()
    db.refresh(svc)
    return svc


def _mk_profile(db, *, key, name="X", vials=1, role="hm", members=(), dim="role"):
    prof = AnalysisProfile(
        key=key, name=name, is_addon=True,
        vials_required=vials, fulfillment_role=role, fulfillment_dim=dim,
    )
    for svc in members:
        prof.analysis_services.append(svc)
    db.add(prof)
    db.commit()
    db.refresh(prof)
    return prof


def test_freezes_service_ids_and_vials_required(db_session):
    svc1 = _mk_service(db_session, keyword="HM-PB", title="Lead")
    svc2 = _mk_service(db_session, keyword="HM-AS", title="Arsenic")
    prof = _mk_profile(db_session, key="heavy_metals", name="Heavy Metals",
                        vials=2, role="hm", members=[svc1, svc2])

    snap = compute_catalog_snapshot(db_session, {"heavy_metals": True}, None)

    assert "resolved_at" in snap and isinstance(snap["resolved_at"], str)
    assert snap["profiles"] == [{
        "key": "heavy_metals",
        "profile_id": prof.id,
        "fulfillment_role": "hm",
        "role_sort_order": None,  # no VialRole row seeded for 'hm' in this test
        "vials_required": 2,
        "service_ids": [svc1.id, svc2.id],
        "ride_host_roles": [],
    }]


def test_excludes_unordered_and_unknown_keys(db_session):
    svc = _mk_service(db_session, keyword="HM-PB", title="Lead")
    _mk_profile(db_session, key="heavy_metals", members=[svc])

    snap = compute_catalog_snapshot(
        db_session, {"heavy_metals": False, "mystery_key": True}, None,
    )
    assert snap["profiles"] == []


def test_service_ids_are_member_sort_order_not_insertion_order(db_session):
    """analysis_services' relationship is order_by=sort_order (spec 1) — the
    snapshot must preserve that, not whatever order .append() happened in."""
    from models import analysis_profile_members

    svc_a = _mk_service(db_session, keyword="HM-AS", title="Arsenic")
    svc_b = _mk_service(db_session, keyword="HM-PB", title="Lead")
    prof = _mk_profile(db_session, key="heavy_metals", members=[svc_a, svc_b])
    # Force sort_order the reverse of append/insertion order.
    db_session.execute(
        analysis_profile_members.update()
        .where(analysis_profile_members.c.analysis_service_id == svc_a.id)
        .values(sort_order=2)
    )
    db_session.execute(
        analysis_profile_members.update()
        .where(analysis_profile_members.c.analysis_service_id == svc_b.id)
        .values(sort_order=1)
    )
    db_session.commit()
    db_session.expire(prof)

    snap = compute_catalog_snapshot(db_session, {"heavy_metals": True}, None)
    assert snap["profiles"][0]["service_ids"] == [svc_b.id, svc_a.id]


def test_ride_host_roles_tiebreak_matches_live_path(db_session):
    """catalog_demand.py:82 sorts ride rows by (priority, host_role_code,
    profile_id) so two rows sharing a priority don't depend on DB read
    order. Insert 'ster' before 'endo' at the SAME priority — the frozen
    list must still come out alphabetically ('endo' then 'ster'), matching
    what the live resolver would produce."""
    svc = _mk_service(db_session, keyword="STER-ADDON", title="Sterility Addon")
    prof = _mk_profile(db_session, key="ster_addon", vials=1, role="ster_addon",
                        members=[svc])
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=prof.id, host_role_code="ster", priority=1,
    ))
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=prof.id, host_role_code="endo", priority=1,
    ))
    db_session.commit()

    snap = compute_catalog_snapshot(db_session, {"ster_addon": True}, None)
    assert snap["profiles"][0]["ride_host_roles"] == ["endo", "ster"]


def test_anchor_and_rider_are_distinguished_in_the_snapshot(db_session):
    """A real anchor (role 'ster' with live demand) plus a rider whose
    declared host list targets that role: the rider must land in the
    snapshot via RIDER inclusion (resolve_catalog_fulfillment's
    rider_profile_ids, not host_profile_ids — its own role 'ster_rider'
    carries no demand of its own), the anchor/rider distinction must survive
    as ride_host_roles empty vs non-empty, and fulfillment_role stays each
    profile's OWN declared role — never the host the rider actually rode."""
    from models import VialRole

    db_session.add(VialRole(code="ster", label="Sterility", sort_order=3))
    db_session.commit()

    anchor_svc = _mk_service(db_session, keyword="STER-PCR", title="Sterility PCR")
    anchor = _mk_profile(db_session, key="sterility_pcr", vials=2, role="ster",
                          members=[anchor_svc])

    rider_svc = _mk_service(db_session, keyword="STER-ADDON", title="Sterility Addon")
    rider = _mk_profile(db_session, key="ster_addon", vials=0, role="ster_rider",
                         members=[rider_svc])
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider.id, host_role_code="ster", priority=1,
    ))
    db_session.commit()

    snap = compute_catalog_snapshot(
        db_session, {"sterility_pcr": True, "ster_addon": True}, None,
    )
    by_key = {p["key"]: p for p in snap["profiles"]}
    assert set(by_key) == {"sterility_pcr", "ster_addon"}

    assert by_key["sterility_pcr"]["ride_host_roles"] == []
    assert by_key["sterility_pcr"]["fulfillment_role"] == "ster"
    assert by_key["sterility_pcr"]["role_sort_order"] == 3

    assert by_key["ster_addon"]["ride_host_roles"] == ["ster"]
    # Own declared role, NOT the host ('ster') it actually rode.
    assert by_key["ster_addon"]["fulfillment_role"] == "ster_rider"
    # No VialRole row for 'ster_rider' — frozen as None, not a KeyError/0.
    assert by_key["ster_addon"]["role_sort_order"] is None


# ── registration bg task: stamps once, frozen values survive a live edit ───


@pytest.fixture
def bg_env(monkeypatch):
    """Own engine (not conftest's db_session) so the bg task's own
    `SessionLocal()` — monkeypatched to a sessionmaker bound to THIS engine —
    reads and writes the same data this fixture seeds."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr("database.SessionLocal", Session)

    seed_db = Session()
    svc = _mk_service(seed_db, keyword="HM-PB", title="Lead")
    prof = _mk_profile(seed_db, key="heavy_metals", vials=2, role="hm",
                        members=[svc])
    parent = LimsSample(sample_id="TEST-SNAPSHOT-PARENT", sample_type="x",
                         status="received")
    seed_db.add(parent)
    seed_db.commit()
    seed_db.refresh(prof)
    prof_id = prof.id
    svc_id = svc.id
    seed_db.close()

    monkeypatch.setattr(
        "sub_samples.service.fetch_sample_services",
        lambda _sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    return Session, prof_id, svc_id


def test_registration_bg_task_stamps_catalog_snapshot(bg_env):
    import main

    Session, prof_id, svc_id = bg_env
    main._native_placeholders_at_registration_bg("TEST-SNAPSHOT-PARENT")

    check_db = Session()
    parent = check_db.query(LimsSample).filter_by(
        sample_id="TEST-SNAPSHOT-PARENT").one()
    assert parent.catalog_snapshot is not None
    assert parent.catalog_snapshot["profiles"] == [{
        "key": "heavy_metals",
        "profile_id": prof_id,
        "fulfillment_role": "hm",
        "role_sort_order": None,  # no VialRole row seeded for 'hm' in bg_env
        "vials_required": 2,
        "service_ids": [svc_id],
        "ride_host_roles": [],
    }]
    check_db.close()


def test_replayed_signal_does_not_restamp_even_after_a_live_catalog_edit(bg_env):
    """The once-only guard AND the freezing property in one test: stamp,
    then edit the LIVE profile's vials_required, then replay the SAME
    registration signal. If the guard were missing, the replay would
    overwrite the snapshot with the edited (5) value; if freezing were
    broken, computing the snapshot at all would read the edited value.
    Either bug makes this assertion fail on 5 instead of 2."""
    import main

    Session, prof_id, svc_id = bg_env
    main._native_placeholders_at_registration_bg("TEST-SNAPSHOT-PARENT")

    edit_db = Session()
    row = edit_db.query(AnalysisProfile).filter_by(key="heavy_metals").one()
    row.vials_required = 5
    edit_db.commit()
    edit_db.close()

    main._native_placeholders_at_registration_bg("TEST-SNAPSHOT-PARENT")  # replay

    check_db = Session()
    parent = check_db.query(LimsSample).filter_by(
        sample_id="TEST-SNAPSHOT-PARENT").one()
    assert parent.catalog_snapshot["profiles"][0]["vials_required"] == 2
    check_db.close()


def test_role_sort_order_is_frozen_across_a_live_vial_role_edit(bg_env):
    """role_sort_order must survive a live VialRole.sort_order edit the same
    way vials_required does above — Task 6's rebuild reads the FROZEN value,
    never the live vial_roles table."""
    import main
    from models import VialRole

    Session, prof_id, svc_id = bg_env
    seed_db = Session()
    seed_db.add(VialRole(code="hm", label="Heavy Metals", sort_order=4))
    seed_db.commit()
    seed_db.close()

    main._native_placeholders_at_registration_bg("TEST-SNAPSHOT-PARENT")

    check_db = Session()
    parent = check_db.query(LimsSample).filter_by(
        sample_id="TEST-SNAPSHOT-PARENT").one()
    assert parent.catalog_snapshot["profiles"][0]["role_sort_order"] == 4
    check_db.close()

    edit_db = Session()
    role = edit_db.query(VialRole).filter_by(code="hm").one()
    role.sort_order = 99
    edit_db.commit()
    edit_db.close()

    main._native_placeholders_at_registration_bg("TEST-SNAPSHOT-PARENT")  # replay

    check_db2 = Session()
    parent2 = check_db2.query(LimsSample).filter_by(
        sample_id="TEST-SNAPSHOT-PARENT").one()
    assert parent2.catalog_snapshot["profiles"][0]["role_sort_order"] == 4
    check_db2.close()


def test_snapshot_stamp_failure_does_not_roll_back_placeholder_seeding(bg_env, monkeypatch, caplog):
    """A compute_catalog_snapshot failure must not undo the placeholder seed
    that already succeeded in the SAME transaction — that seed is the
    load-bearing bench-visibility guarantee `_native_placeholders_at_
    registration_bg` exists for. catalog_snapshot stays NULL so the
    once-only guard retries the stamp on the next signal/replay."""
    import main
    from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
    from models import LimsAnalysis

    Session, prof_id, svc_id = bg_env
    monkeypatch.setattr(
        "catalog.snapshot.compute_catalog_snapshot",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    with caplog.at_level("WARNING"):
        main._native_placeholders_at_registration_bg("TEST-SNAPSHOT-PARENT")  # must not raise

    assert any("catalog_snapshot.stamp_failed" in r.message for r in caplog.records)

    check_db = Session()
    parent = check_db.query(LimsSample).filter_by(
        sample_id="TEST-SNAPSHOT-PARENT").one()
    assert parent.catalog_snapshot is None
    rows = check_db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance=PROVENANCE_ORDERED).all()
    assert len(rows) == 1  # heavy_metals placeholder still seeded despite the snapshot failure
    check_db.close()


def test_registration_hook_still_never_raises_when_is_unreachable(monkeypatch):
    """Non-regression on the existing hardening contract (task 3): a
    fetch_sample_services failure must leave the sample row untouched, snapshot
    included — this task must not weaken that guarantee."""
    import main
    from sqlalchemy import create_engine as _ce
    from sqlalchemy.orm import sessionmaker as _sm

    engine = _ce("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = _sm(bind=engine)
    monkeypatch.setattr("database.SessionLocal", Session)
    seed_db = Session()
    parent = LimsSample(sample_id="TEST-SNAPSHOT-IS-DOWN", sample_type="x",
                         status="received")
    seed_db.add(parent)
    seed_db.commit()
    seed_db.close()

    def boom(_sample_id):
        raise RuntimeError("IS down")
    monkeypatch.setattr("sub_samples.service.fetch_sample_services", boom)

    main._native_placeholders_at_registration_bg("TEST-SNAPSHOT-IS-DOWN")  # must not raise

    check_db = Session()
    got = check_db.query(LimsSample).filter_by(
        sample_id="TEST-SNAPSHOT-IS-DOWN").one()
    assert got.catalog_snapshot is None
    check_db.close()


# ── Task 6: check-in seeds from the snapshot ────────────────────────────────
#
# resolve_catalog_fulfillment(db, services, snapshot=None) and the seeder's
# _members_from_edges gain a snapshot-sourced path. Tests below prove: (a)
# demand honors the frozen vials_required after a live profile edit, (b)
# seeding honors the frozen service_ids after a live membership edit, (c) a
# NULL snapshot leaves the whole check-in chain byte-identical to today, (d)
# rider attachment uses the FROZEN role_sort_order (not a live re-read) for
# its sort, (e) with no catalog edit at all the snapshot-sourced rebuild is
# structurally identical to the live walk it mirrors, (f)/(g) the seeder's
# own fallback-to-live paths (an edge naming a profile not in the snapshot,
# a snapshot service id that no longer resolves) each log their own
# catalog_snapshot.* line, and — fix round 1, per-profile hybrid merge,
# ruled — a services key with no matching snapshot profile (a post-order
# add-on) merges REAL live demand + custody-visible fulfillment into the
# frozen result rather than only logging a divergence, including a
# live-merged rider attaching to a snapshot-frozen host; two more minors
# close out the round: frozen member ORDER survives a live re-order on the
# seeding path, and snapshot vs NULL seeding is identical when the catalog
# is unedited between the two.


def _mk_edge(db, sub, prof, relation):
    from models import VialProfileAssignment
    e = VialProfileAssignment(
        lims_sub_sample_pk=sub.id, analysis_profile_id=prof.id, relation=relation,
    )
    db.add(e)
    db.flush()
    return e


def _mk_parent_and_vial(db, *, sample_id, role, snapshot=None):
    from models import LimsSample, LimsSubSample
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"{sample_id}-uid",
                        catalog_snapshot=snapshot)
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        sample_id=f"{sample_id}-S01", vial_sequence=1, parent_sample_pk=parent.id,
        external_lims_uid=f"{sample_id}-S01-uid", assignment_role=role,
    )
    db.add(sub)
    db.flush()
    return parent, sub


def test_resolve_catalog_fulfillment_snapshot_honors_frozen_vials_required(db_session):
    """(a) demand resolution returns the SNAPSHOT's vials_required even
    after the live profile's vials_required is edited."""
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    svc = _mk_service(db_session, keyword="HM-PB", title="Lead")
    prof = _mk_profile(db_session, key="heavy_metals", vials=2, role="hm", members=[svc])
    snap = compute_catalog_snapshot(db_session, {"heavy_metals": True}, None)

    prof.vials_required = 9  # live edit AFTER the snapshot was taken
    db_session.commit()

    live = resolve_catalog_fulfillment(db_session, {"heavy_metals": True})
    assert live["hm"].demand == 9  # live path reads the edit

    frozen = resolve_catalog_fulfillment(
        db_session, {"heavy_metals": True}, snapshot=snap)
    assert frozen["hm"].demand == 2  # frozen at snapshot time
    assert frozen["hm"].host_profile_ids == [prof.id]


def test_seeder_honors_frozen_service_ids_after_live_membership_edit(db_session):
    """(b) seeding a catalog-role vial seeds the SNAPSHOT's service_ids even
    after live profile membership changes."""
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import analysis_profile_members

    svc_a = _mk_service(db_session, keyword="HM-PB", title="Lead")
    svc_b = _mk_service(db_session, keyword="HM-AS", title="Arsenic")
    prof = _mk_profile(db_session, key="heavy_metals", vials=1, role="hm",
                       members=[svc_a, svc_b])
    snap = compute_catalog_snapshot(db_session, {"heavy_metals": True}, None)

    parent, sub = _mk_parent_and_vial(db_session, sample_id="ZZT6", role="hm", snapshot=snap)
    _mk_edge(db_session, sub, prof, "host")
    db_session.commit()

    # Live membership edit AFTER the snapshot: a THIRD member joins the profile.
    svc_c = _mk_service(db_session, keyword="HM-CD", title="Cadmium")
    db_session.execute(analysis_profile_members.insert().values(
        analysis_profile_id=prof.id, analysis_service_id=svc_c.id, sort_order=2))
    db_session.commit()
    db_session.expire(prof)

    created = seed_analyses_for_vial(
        db_session, sub_sample=sub, role="hm",
        wp_services={"heavy_metals": True}, commit=True)
    assert sorted(r.keyword for r in created) == ["HM-AS", "HM-PB"]  # NOT HM-CD


def test_null_snapshot_end_to_end_check_in_seeding_unchanged(db_session):
    """(c) NULL snapshot -> identical to today: the full production wiring
    (set_assignment_role -> write_custody_edges -> seed_analyses_for_vial)
    on a parent whose catalog_snapshot is NULL behaves exactly as it did
    before this task — live resolution end to end."""
    import sub_samples.service as svc_mod
    from catalog.vial_roles_seed import seed_vial_roles
    from models import LimsAnalysis
    from sub_samples.custody import current_custody

    seed_vial_roles(db_session)
    svc1 = _mk_service(db_session, keyword="HM-PB", title="Lead")
    svc2 = _mk_service(db_session, keyword="HM-AS", title="Arsenic")
    prof = _mk_profile(db_session, key="heavy_metals", vials=1, role="hm",
                       members=[svc1, svc2])

    parent, sub = _mk_parent_and_vial(db_session, sample_id="ZZT6NULL", role=None, snapshot=None)
    assert parent.catalog_snapshot is None

    result = svc_mod.set_assignment_role(
        db_session, sub.sample_id, "hm",
        wp_services={"heavy_metals": True}, user_id=1,
    )
    assert result["assignment_role"] == "hm"

    current = current_custody(db_session, sub.id)
    assert len(current) == 1
    assert current[0].analysis_profile_id == prof.id

    rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert sorted(r.keyword for r in rows) == ["HM-AS", "HM-PB"]


def test_rider_attachment_from_snapshot_uses_frozen_role_sort_order(db_session):
    """(d) rider attachment uses the frozen role_sort_order for the rider
    sort — a live VialRole.sort_order edit AFTER the snapshot must not
    change the ORDER riders landed in the host's rider_profile_ids list.
    Also covers 'null sorts last': a third rider whose own role never got a
    VialRole row (role_sort_order frozen None) sorts after both others."""
    from models import VialRole
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    db_session.add_all([
        VialRole(code="ster", label="Sterility", sort_order=5),
        VialRole(code="rider_a_role", label="A", sort_order=1),
        VialRole(code="rider_b_role", label="B", sort_order=2),
    ])
    db_session.commit()

    host_svc = _mk_service(db_session, keyword="STER-PCR", title="Sterility PCR")
    host = _mk_profile(db_session, key="ster_host", vials=2, role="ster", members=[host_svc])

    svc_a = _mk_service(db_session, keyword="RIDE-A", title="Ride A")
    rider_a = _mk_profile(db_session, key="rider_a", vials=0, role="rider_a_role",
                          members=[svc_a])
    svc_b = _mk_service(db_session, keyword="RIDE-B", title="Ride B")
    rider_b = _mk_profile(db_session, key="rider_b", vials=0, role="rider_b_role",
                          members=[svc_b])
    svc_c = _mk_service(db_session, keyword="RIDE-C", title="Ride C")
    rider_c = _mk_profile(db_session, key="rider_c", vials=0, role="rider_c_role",  # no VialRole row
                          members=[svc_c])

    from models import profile_ride_hosts
    for rider in (rider_a, rider_b, rider_c):
        db_session.execute(profile_ride_hosts.insert().values(
            analysis_profile_id=rider.id, host_role_code="ster", priority=1))
    db_session.commit()

    services = {"ster_host": True, "rider_a": True, "rider_b": True, "rider_c": True}
    snap = compute_catalog_snapshot(db_session, services, None)

    # Live catalog edit AFTER the snapshot: flip the priority order.
    db_session.query(VialRole).filter_by(code="rider_a_role").one().sort_order = 99
    db_session.query(VialRole).filter_by(code="rider_b_role").one().sort_order = 1
    db_session.commit()

    live_now = resolve_catalog_fulfillment(db_session, services)
    assert live_now["ster"].rider_profile_ids == [rider_b.id, rider_a.id, rider_c.id]

    frozen = resolve_catalog_fulfillment(db_session, services, snapshot=snap)
    assert frozen["ster"].rider_profile_ids == [rider_a.id, rider_b.id, rider_c.id]


def test_snapshot_resolution_mirrors_live_resolution_with_no_edit(db_session):
    """(e) equivalence proof: with NO catalog edit between
    compute_catalog_snapshot and the snapshot-sourced resolve, the
    snapshot-sourced result is structurally identical (RoleFulfillment is a
    plain dataclass, so == covers demand + both id lists in order) to the
    live result — two anchors sharing a role (MAX-not-SUM), a rider that
    attaches, and a rider whose only declared host is dead (self-mint)."""
    from models import VialRole, profile_ride_hosts
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    db_session.add_all([
        VialRole(code="ster", label="Sterility", sort_order=1),
        VialRole(code="dead_role", label="Dead", sort_order=2),
    ])
    db_session.commit()

    svc1 = _mk_service(db_session, keyword="ST-1", title="S1")
    _mk_profile(db_session, key="ster_a", vials=2, role="ster", members=[svc1])
    svc2 = _mk_service(db_session, keyword="ST-2", title="S2")
    _mk_profile(db_session, key="ster_b", vials=3, role="ster", members=[svc2])

    svc3 = _mk_service(db_session, keyword="RIDE-1", title="R1")
    rider_attach = _mk_profile(db_session, key="rider_attach", vials=0,
                               role="rider_attach_role", members=[svc3])
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider_attach.id, host_role_code="dead_role", priority=1))
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider_attach.id, host_role_code="ster", priority=2))

    svc4 = _mk_service(db_session, keyword="RIDE-2", title="R2")
    rider_selfmint = _mk_profile(db_session, key="rider_selfmint", vials=0,
                                 role="rider_selfmint_role", members=[svc4])
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider_selfmint.id, host_role_code="dead_role", priority=1))
    db_session.commit()

    services = {"ster_a": True, "ster_b": True, "rider_attach": True, "rider_selfmint": True}
    snap = compute_catalog_snapshot(db_session, services, None)

    live = resolve_catalog_fulfillment(db_session, services)
    frozen = resolve_catalog_fulfillment(db_session, services, snapshot=snap)

    assert frozen == live
    # Sanity: the scenario actually exercises what it claims.
    assert live["ster"].demand == 3  # MAX(2, 3), not SUM
    assert rider_attach.id in live["ster"].rider_profile_ids
    assert rider_selfmint.id in live["rider_selfmint_role"].host_profile_ids  # self-minted


def test_seeder_falls_back_to_live_members_for_profile_not_in_snapshot(db_session, caplog):
    """(f) a custody edge names a profile that ISN'T part of the parent's
    frozen snapshot (e.g. a post-order add-on) -> that profile's members
    come from LIVE prof.analysis_services, logged via
    catalog_snapshot.fallback_live, while a sibling profile that IS in the
    snapshot still seeds from its frozen service_ids."""
    import logging
    from lims_analyses.seeder import seed_analyses_for_vial

    snapped_svc = _mk_service(db_session, keyword="ZZ6-SNAPPED", title="Snapped")
    snapped_prof = _mk_profile(db_session, key="zz6_snapped", vials=1, role="zz6",
                               members=[snapped_svc])
    snap = compute_catalog_snapshot(db_session, {"zz6_snapped": True}, None)

    # A second profile, purchased post-order, never part of the snapshot.
    addon_svc = _mk_service(db_session, keyword="ZZ6-ADDON", title="Addon")
    addon_prof = _mk_profile(db_session, key="zz6_addon", vials=1, role="zz6_addon_role",
                             members=[addon_svc])

    parent, sub = _mk_parent_and_vial(db_session, sample_id="ZZ6", role="zz6", snapshot=snap)
    _mk_edge(db_session, sub, snapped_prof, "host")
    _mk_edge(db_session, sub, addon_prof, "rider")
    db_session.commit()

    with caplog.at_level(logging.WARNING):
        created = seed_analyses_for_vial(
            db_session, sub_sample=sub, role="zz6",
            wp_services={"zz6_snapped": True, "zz6_addon": True}, commit=True)

    kws = {r.keyword for r in created}
    assert kws == {"ZZ6-SNAPPED", "ZZ6-ADDON"}
    assert (f"catalog_snapshot.fallback_live reason=profile_not_in_snapshot "
            f"profile_id={addon_prof.id}") in caplog.text


def test_seeder_logs_when_snapshot_service_id_no_longer_resolves(db_session, caplog):
    """(g) a snapshot service_id that no longer resolves to a real
    AnalysisService row (deleted since registration) is skipped, not
    crashed, and logs catalog_snapshot.service_id_missing."""
    import logging
    from lims_analyses.seeder import seed_analyses_for_vial

    svc1 = _mk_service(db_session, keyword="ZZ7-A", title="A")
    svc2 = _mk_service(db_session, keyword="ZZ7-B", title="B")
    prof = _mk_profile(db_session, key="zz7_prof", vials=1, role="zz7",
                       members=[svc1, svc2])
    snap = compute_catalog_snapshot(db_session, {"zz7_prof": True}, None)
    # Simulate a service deleted after registration: a service_id the live
    # catalog no longer has, spliced into the already-frozen snapshot dict.
    snap["profiles"][0]["service_ids"] = snap["profiles"][0]["service_ids"] + [999999]

    parent, sub = _mk_parent_and_vial(db_session, sample_id="ZZ7", role="zz7", snapshot=snap)
    _mk_edge(db_session, sub, prof, "host")
    db_session.commit()

    with caplog.at_level(logging.WARNING):
        created = seed_analyses_for_vial(
            db_session, sub_sample=sub, role="zz7",
            wp_services={"zz7_prof": True}, commit=True)

    assert sorted(r.keyword for r in created) == ["ZZ7-A", "ZZ7-B"]
    assert "catalog_snapshot.service_id_missing" in caplog.text


def test_uncovered_services_key_merges_live_demand_into_frozen_result(db_session, caplog):
    """Fix round 1 (per-profile hybrid merge, ruled): a post-order add-on
    (a services key with no matching profile in the frozen snapshot) gets
    REAL live demand + custody-visible fulfillment merged into the result —
    not just a log line — while every snapshot-covered profile stays
    frozen despite a live edit made after the snapshot. Non-legacy role
    (heavy_metals-style — no legacy-value floor the way hplc/endo/ster
    have, so before this fix a non-legacy add-on would silently under-
    provision instead of self-healing)."""
    import logging
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    svc = _mk_service(db_session, keyword="HM-PB", title="Lead")
    hm_prof = _mk_profile(db_session, key="heavy_metals", vials=1, role="hm", members=[svc])
    snap = compute_catalog_snapshot(db_session, {"heavy_metals": True}, None)

    # Live edit to the SNAPSHOT-COVERED profile after the snapshot — must
    # stay frozen in the merged result.
    hm_prof.vials_required = 9
    db_session.commit()

    # A second profile, purchased post-order — never part of the snapshot.
    svc2 = _mk_service(db_session, keyword="ZZ-ADDON", title="Addon")
    addon_prof = _mk_profile(db_session, key="zz_addon_key", vials=3,
                             role="zz_addon", members=[svc2])

    with caplog.at_level(logging.WARNING):
        merged = resolve_catalog_fulfillment(
            db_session, {"heavy_metals": True, "zz_addon_key": True}, snapshot=snap)

    # Snapshot-covered profile stays frozen despite the live edit.
    assert merged["hm"].demand == 1
    assert merged["hm"].host_profile_ids == [hm_prof.id]
    # Uncovered post-order add-on gets REAL live demand + a real edge-ready id.
    assert merged["zz_addon"].demand == 3
    assert merged["zz_addon"].host_profile_ids == [addon_prof.id]
    assert ("catalog_snapshot.fallback_live reason=profile_not_in_snapshot "
            "key=zz_addon_key") in caplog.text
    assert "key=heavy_metals" not in caplog.text


def test_uncovered_rider_attaches_to_a_snapshot_frozen_host(db_session):
    """A post-order rider (uncovered by the snapshot) whose ride_host_roles
    targets a role that's ALREADY carrying frozen demand from the snapshot
    attaches to that frozen host — the merge's rider walk sees the
    snapshot's demand already sitting in `result` before the live pass
    ever runs its own self-mint-vs-attach check."""
    from models import VialRole, profile_ride_hosts
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    db_session.add(VialRole(code="ster", label="Sterility", sort_order=1))
    db_session.commit()

    host_svc = _mk_service(db_session, keyword="STER-PCR", title="Sterility PCR")
    host = _mk_profile(db_session, key="ster_host", vials=2, role="ster", members=[host_svc])
    snap = compute_catalog_snapshot(db_session, {"ster_host": True}, None)

    # A post-order rider, purchased after registration, rides "ster".
    rider_svc = _mk_service(db_session, keyword="STER-ADDON", title="Sterility Addon")
    rider = _mk_profile(db_session, key="ster_addon", vials=0, role="ster_addon_role",
                        members=[rider_svc])
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider.id, host_role_code="ster", priority=1))
    db_session.commit()

    merged = resolve_catalog_fulfillment(
        db_session, {"ster_host": True, "ster_addon": True}, snapshot=snap)

    assert merged["ster"].demand == 2  # the frozen host's demand, unchanged
    assert merged["ster"].host_profile_ids == [host.id]
    assert merged["ster"].rider_profile_ids == [rider.id]  # attached, not self-minted


def test_snapshot_sourced_seeding_preserves_frozen_member_order(db_session):
    """Minor 1 (fix round 1): frozen service_ids order is preserved
    verbatim into insertion order on the snapshot-sourced seeding path —
    mirrors test_catalog_seeding.py's test_hm_vial_seeds_exactly_profile_
    members load-bearing order assertion. A live re-order AFTER the
    snapshot must not change what was already frozen."""
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import analysis_profile_members

    svc_pb = _mk_service(db_session, keyword="HM-PB", title="Lead")
    svc_as = _mk_service(db_session, keyword="HM-AS", title="Arsenic")
    svc_cd = _mk_service(db_session, keyword="HM-CD", title="Cadmium")
    prof = _mk_profile(db_session, key="heavy_metals", vials=1, role="hm",
                       members=[svc_pb, svc_as, svc_cd])
    for svc, order in ((svc_pb, 0), (svc_as, 1), (svc_cd, 2)):
        db_session.execute(
            analysis_profile_members.update()
            .where(analysis_profile_members.c.analysis_service_id == svc.id)
            .values(sort_order=order)
        )
    db_session.commit()
    db_session.expire(prof)

    snap = compute_catalog_snapshot(db_session, {"heavy_metals": True}, None)

    # Live re-order AFTER the snapshot: send HM-PB to the back.
    db_session.execute(
        analysis_profile_members.update()
        .where(analysis_profile_members.c.analysis_service_id == svc_pb.id)
        .values(sort_order=9)
    )
    db_session.commit()
    db_session.expire(prof)

    parent, sub = _mk_parent_and_vial(db_session, sample_id="ZZ8", role="hm", snapshot=snap)
    _mk_edge(db_session, sub, prof, "host")
    db_session.commit()

    created = seed_analyses_for_vial(
        db_session, sub_sample=sub, role="hm",
        wp_services={"heavy_metals": True}, commit=True)
    # FROZEN order (PB, AS, CD) survives — not the live-reordered (AS, CD, PB).
    assert [r.keyword for r in created] == ["HM-PB", "HM-AS", "HM-CD"]


def test_seed_analyses_for_vial_snapshot_vs_null_identical_when_catalog_unedited(db_session):
    """Minor 2 (fix round 1): equivalence at the seeder layer, mirroring
    test_snapshot_resolution_mirrors_live_resolution_with_no_edit's
    demand-layer proof — with the catalog UNEDITED between the snapshot
    and the seed call, seeding through a snapshot-stamped parent produces
    the exact same keyword list as seeding through a NULL-snapshot parent."""
    from lims_analyses.seeder import seed_analyses_for_vial

    svc_a = _mk_service(db_session, keyword="HM-PB", title="Lead")
    svc_b = _mk_service(db_session, keyword="HM-AS", title="Arsenic")
    prof = _mk_profile(db_session, key="heavy_metals", vials=1, role="hm",
                       members=[svc_a, svc_b])
    snap = compute_catalog_snapshot(db_session, {"heavy_metals": True}, None)

    parent_snap, sub_snap = _mk_parent_and_vial(
        db_session, sample_id="ZZ9SNAP", role="hm", snapshot=snap)
    _mk_edge(db_session, sub_snap, prof, "host")
    parent_null, sub_null = _mk_parent_and_vial(
        db_session, sample_id="ZZ9NULL", role="hm", snapshot=None)
    _mk_edge(db_session, sub_null, prof, "host")
    db_session.commit()

    created_snap = seed_analyses_for_vial(
        db_session, sub_sample=sub_snap, role="hm",
        wp_services={"heavy_metals": True}, commit=True)
    created_null = seed_analyses_for_vial(
        db_session, sub_sample=sub_null, role="hm",
        wp_services={"heavy_metals": True}, commit=True)

    snap_kws = [r.keyword for r in created_snap]
    null_kws = [r.keyword for r in created_null]
    assert snap_kws == null_kws
    assert set(snap_kws) == {"HM-PB", "HM-AS"}
