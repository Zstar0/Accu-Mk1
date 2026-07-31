"""Ride lists (spec 4, Task 4): a rider profile attaches its result to an
already-minted host vial instead of claiming its own, falling back to a
standalone self-mint (of its OWN role, never the host's) when no host on its
priority list is live.

Binding constraint under test throughout: ride-list demand must NEVER change
a legacy bucket count. Riders attaching to legacy hosts (hplc/endo/ster)
contribute ZERO to that bucket; self-mint only ever lands on the rider's own
catalog-only role.

Fixture idiom: TEST-ONLY keys/roles only (`t_*` profile keys, short `t*`-
prefixed role codes) — never the real seeded rows (hplc/endo/ster/xtra/hm or
real profile keys). `client`/`db_session` fixture pair copied from
test_api_vial_roles.py (StaticPool in-memory SQLite + get_db/get_current_user
overrides).
"""
from __future__ import annotations

import itertools

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import AnalysisProfile, VialRole, profile_ride_hosts


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


def _mk(db, key, role, vials=1, rides=None):
    """Test helper: create + commit an AnalysisProfile with fulfillment_role
    `role` (minting a VialRole catalog row for it if one doesn't already
    exist — sort_order is allocated max+1, so mint CALL ORDER controls
    rider-resolution tie-breaking across tests) and, when `rides` is given, a
    profile_ride_hosts row per host code in list order (position = priority).
    """
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


# ─── resolve_catalog_fulfillment: anchors + riders ─────────────────────────

def test_standalone_rider_self_mints_own_role(db_session):
    """fent alone (rides [thplc], thplc NOT ordered) -> demand {tfent: 1}.
    vials_required=0 means "rides when possible" — even a standalone rider
    with vials_required=0 still mints exactly 1 vial, never 0."""
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    fent = _mk(db_session, "t_fent", "tfent", vials=0, rides=["thplc"])

    result = resolve_catalog_fulfillment(db_session, {"t_fent": True})

    assert result["tfent"].demand == 1
    assert result["tfent"].host_profile_ids == [fent.id]
    assert result["tfent"].rider_profile_ids == []
    assert "thplc" not in result  # host never ordered, never fabricated
    assert result["hplc"].demand == 0
    assert result["endo"].demand == 0
    assert result["ster"].demand == 0


def test_rider_attaches_to_ordered_host(db_session):
    """fent + thplc-family ordered -> demand {thplc: 1};
    fulfillment[thplc].rider_profile_ids == [fent.id]."""
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    host = _mk(db_session, "t_hplc_fam", "thplc", vials=1)
    fent = _mk(db_session, "t_fent", "tfent", vials=1, rides=["thplc"])

    result = resolve_catalog_fulfillment(
        db_session, {"t_hplc_fam": True, "t_fent": True})

    assert result["thplc"].demand == 1
    assert result["thplc"].host_profile_ids == [host.id]
    assert result["thplc"].rider_profile_ids == [fent.id]
    assert "tfent" not in result  # rider attached, never self-minted


def test_rider_chain_attaches_to_earlier_self_mint(db_session):
    """vacuum rides [thplc, tfent]; thplc absent, fent ordered standalone
    (self-minted tfent) -> vacuum attaches to tfent; ONE tfent vial hosting
    vacuum (vacuum contributes zero extra demand)."""
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    # fent's role (tfent) minted FIRST so its sort_order sorts before
    # vacuum's (tvac) — riders resolve in (role sort_order, profile key)
    # order, so fent's self-mint must land in `result` before vacuum's turn.
    fent = _mk(db_session, "t_fent", "tfent", vials=1, rides=["thplc"])
    vacuum = _mk(db_session, "t_vacuum", "tvac", vials=1, rides=["thplc", "tfent"])

    # Named precondition, not just a comment: this test only proves what it
    # claims to if tfent's sort_order really did land before tvac's — mint
    # CALL ORDER is what guarantees that (see _mk's docstring). If a future
    # edit reorders the two _mk calls above, fail HERE with a clear cause
    # instead of failing below on an opaque rider_profile_ids mismatch.
    tfent_sort = db_session.query(VialRole).filter_by(code="tfent").one().sort_order
    tvac_sort = db_session.query(VialRole).filter_by(code="tvac").one().sort_order
    assert tfent_sort < tvac_sort

    result = resolve_catalog_fulfillment(
        db_session, {"t_fent": True, "t_vacuum": True})

    assert result["tfent"].demand == 1  # ONE vial, not two
    assert result["tfent"].host_profile_ids == [fent.id]
    assert result["tfent"].rider_profile_ids == [vacuum.id]
    assert "tvac" not in result  # vacuum never self-minted its own role
    assert "thplc" not in result


def test_priority_order_respected(db_session):
    """rider rides [a, b], both ordered -> attaches to a (first hit)."""
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    host_a = _mk(db_session, "t_host_a", "ta1", vials=1)
    _mk(db_session, "t_host_b", "tb1", vials=1)
    rider = _mk(db_session, "t_rider", "trid", vials=1, rides=["ta1", "tb1"])

    result = resolve_catalog_fulfillment(
        db_session, {"t_host_a": True, "t_host_b": True, "t_rider": True})

    assert result["ta1"].rider_profile_ids == [rider.id]
    assert result["ta1"].host_profile_ids == [host_a.id]
    assert result["tb1"].rider_profile_ids == []
    assert "trid" not in result


def test_rider_resolution_is_permutation_invariant(db_session):
    """Same service set in every dict insertion order -> identical
    fulfillment map, INCLUDING host_profile_ids order. Property test over
    itertools.permutations of 5 keys — two of which (t_pi_host1,
    t_pi_host1b) are anchors sharing the same TEST-ONLY role (tp1), the
    real-production shape (two profiles both anchoring 'hplc') that the
    anchors loop must sort deterministically (by (role sort_order, profile
    key), same as riders) rather than following `services` dict iteration
    order — the fix for a controller-ruled review finding on this exact
    fixture gap (a one-anchor-per-role fixture would pass without ever
    exercising the order-sensitive path)."""
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    _mk(db_session, "t_pi_host1", "tp1", vials=1)
    _mk(db_session, "t_pi_host1b", "tp1", vials=1)
    _mk(db_session, "t_pi_host2", "tp2", vials=1)
    _mk(db_session, "t_pi_rider1", "tpr1", vials=1, rides=["tp1"])
    _mk(db_session, "t_pi_rider2", "tpr2", vials=1, rides=["tp2"])

    keys = ["t_pi_host1", "t_pi_host1b", "t_pi_host2", "t_pi_rider1", "t_pi_rider2"]
    baseline = None
    for perm in itertools.permutations(keys):
        services = {k: True for k in perm}
        result = resolve_catalog_fulfillment(db_session, services)
        snapshot = {
            role: (rf.demand, rf.host_profile_ids, rf.rider_profile_ids)
            for role, rf in result.items()
        }
        if baseline is None:
            baseline = snapshot
        else:
            assert snapshot == baseline, perm

    # Sanity: the shared-role anchors both actually landed under tp1 — not a
    # vacuously-true assertion because tp1 only ever had one host. snapshot
    # values are (demand, host_profile_ids, rider_profile_ids) tuples.
    assert len(baseline["tp1"][1]) == 2


def test_rides_never_change_legacy_buckets(db_session, caplog):
    """Legacy keys + a test rider riding the legacy `hplc` host: demand
    ['hplc'/'endo'/'ster'] stays byte-identical to derive_base_demand
    (services, db=None) (the pure-legacy reference), and the shadow-compare
    wrapper (derive_base_demand(services, db=db_session)) logs NO
    demand_divergence — proving a rider attaching to a legacy bucket
    contributes zero to that bucket's count."""
    from sub_samples.catalog_demand import resolve_catalog_fulfillment
    from sub_samples.service import derive_base_demand
    from catalog.profile_seed import seed_profiles_from_registry

    seed_profiles_from_registry(db_session)
    rider = _mk(db_session, "t_rides_legacy", "tridel", vials=1, rides=["hplc"])

    services = {
        "hplcpurity_identity": True,
        "endotoxin": True,
        "sterility_pcr": True,
        "t_rides_legacy": True,
    }

    legacy_ref = derive_base_demand(services)  # db=None -> pure legacy
    fulfillment = resolve_catalog_fulfillment(db_session, services)
    for bucket in ("hplc", "endo", "ster"):
        assert fulfillment[bucket].demand == legacy_ref[bucket], bucket
    assert rider.id in fulfillment["hplc"].rider_profile_ids
    assert "tridel" not in fulfillment  # rider attached, never self-minted

    with caplog.at_level("ERROR"):
        shadow = derive_base_demand(services, db=db_session)
    assert shadow["hplc"] == legacy_ref["hplc"]
    assert shadow["endo"] == legacy_ref["endo"]
    assert shadow["ster"] == legacy_ref["ster"]
    assert not any("demand_divergence" in r.message for r in caplog.records)


# ─── PUT /analysis-profiles/{id}/ride-hosts guards ─────────────────────────

def test_put_ride_hosts_rejects_endo_ster_xtra_self(client, db_session):
    """endo -> 400, ster -> 400, xtra -> 400, own role -> 400, unknown code
    -> 400. A valid save (a legit catalog-only host) still 200s after all
    the rejections, proving the guards don't wedge the endpoint."""
    from catalog.vial_roles_seed import seed_vial_roles

    seed_vial_roles(db_session)
    db_session.commit()
    other_host = _mk(db_session, "t_put_host", "tputho", vials=1)
    prof = _mk(db_session, "t_put_reject", "tputrj", vials=1)

    for code in ("endo", "ster", "xtra"):
        r = client.put(f"/analysis-profiles/{prof.id}/ride-hosts",
                        json={"host_role_codes": [code]})
        assert r.status_code == 400, code

    own_role = client.put(f"/analysis-profiles/{prof.id}/ride-hosts",
                           json={"host_role_codes": ["tputrj"]})
    assert own_role.status_code == 400

    unknown = client.put(f"/analysis-profiles/{prof.id}/ride-hosts",
                          json={"host_role_codes": ["zzzzzzzz"]})
    assert unknown.status_code == 400

    ok = client.put(f"/analysis-profiles/{prof.id}/ride-hosts",
                     json={"host_role_codes": ["tputho"]})
    assert ok.status_code == 200
    assert client.get(f"/analysis-profiles/{prof.id}/ride-hosts").json() == ["tputho"]
    assert other_host.id  # host profile untouched, sanity


def test_put_ride_hosts_rejects_legacy_role_owner(client, db_session):
    """A profile that itself anchors a legacy bucket (fulfillment_role in
    hplc/endo/ster) may never carry a ride list — resolve_catalog_
    fulfillment treats "has a ride row" as "is a rider," so giving e.g.
    endotoxin (role 'endo') a ride list would silently zero the endo bucket
    the moment its host is also ordered. Beyond the brief's enumerated 400
    list; added per the binding constraint that ride lists must never move
    a legacy bucket count (advisor-flagged gap, fixed pre-commit)."""
    from catalog.profile_seed import seed_profiles_from_registry
    from catalog.vial_roles_seed import seed_vial_roles

    seed_vial_roles(db_session)
    seed_profiles_from_registry(db_session)
    db_session.commit()
    endotoxin = db_session.query(AnalysisProfile).filter_by(key="endotoxin").one()

    r = client.put(f"/analysis-profiles/{endotoxin.id}/ride-hosts",
                    json={"host_role_codes": ["hplc"]})
    assert r.status_code == 400
    assert "endo" in r.json()["detail"]

    # No row leaked in despite the 400.
    assert client.get(f"/analysis-profiles/{endotoxin.id}/ride-hosts").json() == []


def test_put_ride_hosts_rejects_duplicate_codes(client, db_session):
    """Two identical codes in one payload would 500 on the junction's
    UNIQUE(analysis_profile_id, host_role_code) constraint — refused with a
    400 before any write instead (same class of guard as the legacy-role
    check above)."""
    from catalog.vial_roles_seed import seed_vial_roles

    seed_vial_roles(db_session)
    db_session.commit()
    other_host = _mk(db_session, "t_dup_host", "tduph", vials=1)
    prof = _mk(db_session, "t_dup_reject", "tdupr", vials=1)

    r = client.put(f"/analysis-profiles/{prof.id}/ride-hosts",
                    json={"host_role_codes": ["tduph", "tduph"]})
    assert r.status_code == 400
    assert client.get(f"/analysis-profiles/{prof.id}/ride-hosts").json() == []
    assert other_host.id  # sanity: host profile untouched


def test_patch_rejects_re_entering_legacy_role_with_a_live_ride_list(client, db_session):
    """Closure gap (advisor-caught, second pass): the PUT guard
    (test_put_ride_hosts_rejects_legacy_role_owner) only blocks attaching a
    ride list WHILE a profile's role is already legacy. It does not stop
    the reverse door: a legacy-key profile (endotoxin) can legally move its
    role AWAY from 'endo' (PATCH — 'zzhold' isn't reserved), pick up a ride
    list once its role isn't legacy anymore (PUT ride-hosts — also legal),
    then PATCH back to 'endo' — landing in the exact state the PUT guard
    exists to prevent, without ever touching the PUT guard on the way in.
    PATCH must refuse to re-enter a legacy role while a ride list still
    exists; clearing the ride list first unblocks it."""
    from catalog.profile_seed import seed_profiles_from_registry
    from catalog.vial_roles_seed import seed_vial_roles

    seed_vial_roles(db_session)
    seed_profiles_from_registry(db_session)
    db_session.commit()
    endotoxin = db_session.query(AnalysisProfile).filter_by(key="endotoxin").one()

    away = client.patch(f"/analysis-profiles/{endotoxin.id}",
                         json={"fulfillment_role": "zzhold"})
    assert away.status_code == 200

    rides = client.put(f"/analysis-profiles/{endotoxin.id}/ride-hosts",
                        json={"host_role_codes": ["hplc"]})
    assert rides.status_code == 200

    back = client.patch(f"/analysis-profiles/{endotoxin.id}",
                         json={"fulfillment_role": "endo"})
    assert back.status_code == 400
    assert "ride list" in back.json()["detail"].lower()

    cleared = client.put(f"/analysis-profiles/{endotoxin.id}/ride-hosts",
                          json={"host_role_codes": []})
    assert cleared.status_code == 200

    back2 = client.patch(f"/analysis-profiles/{endotoxin.id}",
                          json={"fulfillment_role": "endo"})
    assert back2.status_code == 200


def test_put_ride_hosts_rejects_kind_dim_profile(client, db_session):
    """A kind-dim profile (fulfillment_dim='kind', e.g. variance-shaped) has
    no single role to ride against — ride-hosts refuses it outright, even
    for an otherwise-legal host code."""
    from catalog.vial_roles_seed import seed_vial_roles

    seed_vial_roles(db_session)
    kind_profile = AnalysisProfile(
        key="t_kind_dim", name="Kind Dim Profile", is_addon=True,
        vials_required=0, fulfillment_dim="kind", fulfillment_role=None,
    )
    db_session.add(kind_profile)
    db_session.commit()

    r = client.put(f"/analysis-profiles/{kind_profile.id}/ride-hosts",
                    json={"host_role_codes": ["hplc"]})
    assert r.status_code == 400
