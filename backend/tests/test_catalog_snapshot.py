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
