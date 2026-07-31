"""Custody edges — vial_profile_assignments (spec 4, Task 5): the ISO 17025
backbone, the persisted record of which profile's work is on which vial.

Fixture idiom: `client`/`db_session` pair copied from test_ride_lists.py
(StaticPool in-memory SQLite + get_db/get_current_user overrides). TEST-ONLY
profile keys (`zz_*`) throughout, except test_legacy_hplc_vial_gets_host_edge
which deliberately reads the real seeded legacy catalog (via
catalog.profile_seed.seed_profiles_from_registry) READ-ONLY — never
mutated/deleted — because that's the point of the test.

set_assignment_role's `role` argument is gated by the pre-existing, static
`_VALID_ROLES = {"hplc", "endo", "ster", "xtra", "hm"}` in sub_samples/service.py
— NOT catalog-driven (the /vial-roles CRUD from Task 2 can mint role codes
this gate doesn't know about; see task-5-report.md Concerns). So the
catalog-flavored tests below use the real role code "hm" (a genuine
catalog-only bucket — no legacy ROLE_TO_WP_KEYS/senaite mirror path) with
TEST-ONLY profile *keys* pointed at it via fulfillment_role, rather than a
wholly invented role code, which set_assignment_role would reject outright.

Every test that reaches the seeding hook stubs
`lims_analyses.seeder.seed_analyses_for_vial` (no-op, spy, or raiser as
needed) — the seeder's own correctness is Task 6/existing-suite territory,
and for legacy roles it can reach out to SENAITE, which these tests must
never do.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import AnalysisProfile, LimsSample, LimsSubSample, VialRole, profile_ride_hosts
from sub_samples.custody import current_custody
import sub_samples.service as svc


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user


@pytest.fixture(autouse=True)
def _stub_seeder(monkeypatch):
    """No test in this file is about lims_analyses seeding — it's about
    custody edges. Default every test to a no-op seeder (mirrors production
    shape: returns a list) so a role assignment never makes a real SENAITE
    call. Individual tests override this via their own monkeypatch call
    (spy / raiser) when they need different behavior."""
    monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial", lambda *a, **k: [])


def _mk(db, key, role, vials=1, rides=None):
    """Mint a test-only AnalysisProfile with fulfillment_role `role`
    (creating a VialRole catalog row for it if one doesn't already exist —
    sort_order allocated max+1) and, if `rides` is given, a
    profile_ride_hosts row per host code in list order. Copied from
    test_ride_lists.py's helper of the same name/shape."""
    existing_role = db.query(VialRole).filter_by(code=role).one_or_none()
    if existing_role is None:
        max_sort = db.query(func.coalesce(func.max(VialRole.sort_order), 0)).scalar() or 0
        db.add(VialRole(
            code=role, label=role, department_id=None,
            boxable=False, variance_eligible=False,
            sort_order=max_sort + 1, frozen=False, is_system=False,
        ))
        db.flush()
    p = AnalysisProfile(
        key=key, name=key, is_addon=True, vials_required=vials,
        fulfillment_role=role, fulfillment_dim="role", active=True,
    )
    db.add(p)
    db.flush()
    if rides:
        for i, host in enumerate(rides):
            db.execute(profile_ride_hosts.insert().values(
                analysis_profile_id=p.id, host_role_code=host, priority=i))
    db.commit()
    return p


def _vial(db, order_key, seq=1):
    """Throwaway parent + one sub-sample vial, committed."""
    parent = LimsSample(sample_id=order_key, external_lims_uid=f"{order_key}-uid")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        sample_id=f"{order_key}-S{seq:02d}",
        vial_sequence=seq,
        parent_sample_pk=parent.id,
        external_lims_uid=f"{order_key}-S{seq:02d}-uid",
    )
    db.add(sub)
    db.commit()
    return parent, sub


# ─── write_custody_edges via set_assignment_role ───────────────────────────

def test_role_assign_writes_host_and_rider_edges(db_session):
    """A real role assign writes one host edge (the anchor) and one rider
    edge (a profile riding that anchor's role), both current
    (superseded_at NULL), attributed to the assigning user."""
    anchor = _mk(db_session, "zz_ct_anchor", "hm", vials=1)
    rider = _mk(db_session, "zz_ct_rider", "zzridehost", vials=0, rides=["hm"])
    _parent, sub = _vial(db_session, "ZZCT-0001")

    result = svc.set_assignment_role(
        db_session, sub.sample_id, "hm",
        wp_services={"zz_ct_anchor": True, "zz_ct_rider": True},
        user_id=7,
    )
    assert result["assignment_role"] == "hm"

    current = current_custody(db_session, sub.id)
    assert len(current) == 2
    by_relation = {row.relation: row for row in current}
    assert set(by_relation) == {"host", "rider"}
    assert by_relation["host"].analysis_profile_id == anchor.id
    assert by_relation["rider"].analysis_profile_id == rider.id
    for row in current:
        assert row.superseded_at is None
        assert row.assigned_by_id == 7
        assert row.assigned_at is not None


def test_role_flip_supersedes_and_reinserts(db_session):
    """tanchor -> xtra: old edges superseded, xtra writes nothing new.
    xtra -> tanchor: fresh rows inserted; the superseded generation is
    untouched (its id and superseded_at stamp are exactly what they were
    right after the first flip) — three generations queryable: original
    (now superseded), the empty xtra gap, and the fresh reinsertion."""
    _mk(db_session, "zz_flip_anchor", "hm", vials=1)
    _parent, sub = _vial(db_session, "ZZFLIP-0001")

    svc.set_assignment_role(
        db_session, sub.sample_id, "hm",
        wp_services={"zz_flip_anchor": True}, user_id=1,
    )
    gen1 = current_custody(db_session, sub.id)
    assert len(gen1) == 1
    gen1_id = gen1[0].id

    # flip to xtra: gen1 superseded, nothing new written
    svc.set_assignment_role(db_session, sub.sample_id, "xtra", user_id=1)
    assert current_custody(db_session, sub.id) == []
    all_after_xtra = db_session.query(type(gen1[0])).filter_by(
        lims_sub_sample_pk=sub.id
    ).all()
    assert len(all_after_xtra) == 1
    superseded_row = all_after_xtra[0]
    assert superseded_row.id == gen1_id
    assert superseded_row.superseded_at is not None
    stamp_after_xtra = superseded_row.superseded_at

    # flip back to hm: fresh row inserted; history row untouched
    svc.set_assignment_role(
        db_session, sub.sample_id, "hm",
        wp_services={"zz_flip_anchor": True}, user_id=2,
    )
    all_rows = db_session.query(type(gen1[0])).filter_by(
        lims_sub_sample_pk=sub.id
    ).order_by(type(gen1[0]).id).all()
    assert len(all_rows) == 2  # original (superseded) + fresh (current)
    old, new = all_rows
    assert old.id == gen1_id
    assert old.superseded_at == stamp_after_xtra  # stamped once, never rewritten
    assert new.id != gen1_id  # reinsert, not an un-supersede of the old row
    assert new.superseded_at is None
    assert new.assigned_by_id == 2

    current = current_custody(db_session, sub.id)
    assert len(current) == 1
    assert current[0].id == new.id


def test_edges_commit_atomically_with_role(db_session, monkeypatch):
    """A seeding failure rolls back the WHOLE transaction — including the
    custody edges written earlier in that same transaction. Proves the
    write_custody_edges + db.flush() insertion joins the caller's
    transaction rather than committing independently."""
    _mk(db_session, "zz_atomic_anchor", "hm", vials=1)
    _parent, sub = _vial(db_session, "ZZATOMIC-0001")

    def _boom(*a, **k):
        raise RuntimeError("seed boom")

    monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial", _boom)

    with pytest.raises(RuntimeError):
        svc.set_assignment_role(
            db_session, sub.sample_id, "hm",
            wp_services={"zz_atomic_anchor": True}, user_id=3,
        )
    db_session.rollback()

    assert current_custody(db_session, sub.id) == []
    fresh = db_session.get(LimsSubSample, sub.id)
    assert fresh.assignment_role is None  # role flip rolled back too


def test_no_services_skips_edges_with_warning(db_session, caplog, monkeypatch):
    """wp_services unavailable (the PATCH route's default, resolved to
    None/empty by IS): no edges are written or superseded, a
    'custody_edge_skipped' warning is logged, and the role write itself
    still succeeds."""
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent", lambda pid: None)
    _parent, sub = _vial(db_session, "ZZNOSVC-0001")

    with caplog.at_level("WARNING"):
        result = svc.set_assignment_role(
            db_session, sub.sample_id, "hm", wp_services=None, user_id=1,
        )

    assert result["assignment_role"] == "hm"
    fresh = db_session.get(LimsSubSample, sub.id)
    assert fresh.assignment_role == "hm"
    assert current_custody(db_session, sub.id) == []
    assert any("custody_edge_skipped" in r.message for r in caplog.records)


def test_no_services_leaves_existing_edges_untouched(db_session, monkeypatch):
    """The binding decision, proven directly: a real-role reassignment with
    no resolvable wp_services must NOT supersede whatever custody already
    existed — losing custody on a transient IS outage would be worse than a
    stale-but-correct record."""
    _mk(db_session, "zz_keep_anchor", "hm", vials=1)
    _parent, sub = _vial(db_session, "ZZKEEP-0001")

    svc.set_assignment_role(
        db_session, sub.sample_id, "hm",
        wp_services={"zz_keep_anchor": True}, user_id=1,
    )
    before = current_custody(db_session, sub.id)
    assert len(before) == 1
    before_id = before[0].id

    # Re-assign the SAME role, but this time services are unresolvable.
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent", lambda pid: None)
    svc.set_assignment_role(db_session, sub.sample_id, "hm", wp_services=None, user_id=2)

    after = current_custody(db_session, sub.id)
    assert len(after) == 1
    assert after[0].id == before_id  # untouched — not superseded, not replaced


def test_legacy_hplc_vial_gets_host_edge(db_session):
    """Legacy keys exist as profiles too (catalog.profile_seed): an hplc
    assign with hplcpurity_identity ordered gets a host edge to that real
    profile row. Reads the seeded legacy catalog; never mutates it."""
    from catalog.profile_seed import seed_profiles_from_registry

    seed_profiles_from_registry(db_session)
    hplc_profile = db_session.query(AnalysisProfile).filter_by(
        key="hplcpurity_identity"
    ).one()
    _parent, sub = _vial(db_session, "ZZLEGACY-0001")

    svc.set_assignment_role(
        db_session, sub.sample_id, "hplc",
        wp_services={"hplcpurity_identity": True}, user_id=9,
    )

    current = current_custody(db_session, sub.id)
    assert len(current) == 1
    assert current[0].relation == "host"
    assert current[0].analysis_profile_id == hplc_profile.id


def test_flush_makes_edges_visible_under_autoflush_false(monkeypatch):
    """Production SessionLocal is autoflush=False (see
    catalog/profile_seed.py's own docstring). The db.flush() call after
    write_custody_edges in set_assignment_role must make the fresh custody
    rows visible to an in-transaction query under THAT setting — the
    shared db_session fixture defaults to autoflush=True, which would make
    this assertion pass whether or not the flush exists, so this test
    builds its own autoflush=False session and spies on the seeding hook to
    prove the rows are queryable from inside the same transaction, before
    commit."""
    from models import VialProfileAssignment

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False)
    db = Session()
    try:
        _mk(db, "zz_flush_anchor", "hm", vials=1)
        _parent, sub = _vial(db, "ZZFLUSH-0001")

        seen = {}

        def _spy(db_, sub_sample, role, wp_services, parent_sample_id, created_by_user_id, commit):
            rows = db_.query(VialProfileAssignment).filter_by(
                lims_sub_sample_pk=sub_sample.id, superseded_at=None
            ).all()
            seen["count"] = len(rows)
            return []

        monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial", _spy)

        svc.set_assignment_role(
            db, sub.sample_id, "hm",
            wp_services={"zz_flush_anchor": True}, user_id=1,
        )
        assert seen["count"] == 1
    finally:
        db.close()


# ─── GET /sub-samples/{sample_id}/custody ──────────────────────────────────

def test_custody_endpoint_returns_history_current_first(client, db_session):
    _mk(db_session, "zz_ep_anchor", "hm", vials=1)
    _mk(db_session, "zz_ep_rider", "zzephost", vials=0, rides=["hm"])
    _parent, sub = _vial(db_session, "ZZEP-0001")

    services = {"zz_ep_anchor": True, "zz_ep_rider": True}
    svc.set_assignment_role(db_session, sub.sample_id, "hm", wp_services=services, user_id=1)
    svc.set_assignment_role(db_session, sub.sample_id, "xtra", user_id=1)
    svc.set_assignment_role(db_session, sub.sample_id, "hm", wp_services=services, user_id=2)

    resp = client.get(f"/sub-samples/{sub.sample_id}/custody")
    assert resp.status_code == 200
    body = resp.json()

    assert len(body) == 4  # 2 superseded (gen 1) + 2 current (gen 2)
    current_rows, superseded_rows = body[:2], body[2:]
    assert all(row["superseded_at"] is None for row in current_rows)
    assert all(row["superseded_at"] is not None for row in superseded_rows)

    keys = {row["profile_key"] for row in body}
    assert {"zz_ep_anchor", "zz_ep_rider"} <= keys
    names = {row["profile_name"] for row in body}
    assert {"zz_ep_anchor", "zz_ep_rider"} <= names

    current_relations = {row["relation"] for row in current_rows}
    assert current_relations == {"host", "rider"}
    assert all(row["assigned_by"] == 2 for row in current_rows)
    assert all(row["assigned_by"] == 1 for row in superseded_rows)


def test_custody_endpoint_404_for_unknown_sample_id(client):
    resp = client.get("/sub-samples/ZZ-DOES-NOT-EXIST-S01/custody")
    assert resp.status_code == 404
