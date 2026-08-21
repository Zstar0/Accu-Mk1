"""Profile auto-mint + role validation + member-department backfill (spec 4,
Task 3): POST/PATCH /analysis-profiles mint a vial_roles row for an unknown
fulfillment_role code, and PUT .../members backfills a NULL department onto
the profile's role once its member set agrees on exactly one department.

The spec-3 guard chain (dim check, role regex, xtra 400) runs FIRST and is
untouched by this task — mint logic sits strictly after it, so a request
that would 400 on those guards never reaches mint. S9 Task 2 retired the
legacy-role-for-a-new-key 400 (a NEW profile may now be assigned hplc/endo/
ster) — mint's own reach is unaffected by that retirement: hplc/endo/ster
are always-seeded system rows in the real app (seed_vial_roles runs every
boot), so mint's own "code not in registry" gate never opens for them
regardless of the route guard. This file's isolated in-memory DB does NOT
auto-seed like the real boot sequence does, so the tests that need to prove
that reach call seed_vial_roles explicitly first (mirroring the same idiom
in test_ride_lists.py / test_hm_role_sites.py / test_catalog_seeding.py /
test_custody_edges.py).

Fixture idiom copied from test_api_vial_roles.py's `client`/`db_session`
(StaticPool in-memory SQLite + get_db/get_current_user dependency overrides)
— isolates each test's rows and lets `db_session` read back rows the POST
schema doesn't expose directly.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import VialRole


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


def test_post_with_unknown_role_mints_vial_role(client, db_session):
    dep = client.post("/departments", json={"name": "Mint Dept"}).json()
    r = client.post("/analysis-profiles", json={
        "key": "zz_test_family", "name": "ZZ Test", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "zz_test",
        "role_department_id": dep["id"], "vials_required": 1})
    assert r.status_code == 201, r.text
    role = db_session.query(VialRole).filter_by(code="zz_test").one()
    assert role.label == "ZZ Test" and role.department_id == dep["id"]
    assert role.boxable is False and role.variance_eligible is False and role.frozen is False


def test_post_with_existing_role_reuses_it(client, db_session):
    # create role via /vial-roles first; profile POST with that code mints nothing (count==1)
    dep = client.post("/departments", json={"name": "Existing Dept"}).json()
    existing_role = client.post("/vial-roles", json={
        "code": "exrole", "label": "Pre-Existing Role", "department_id": dep["id"],
    }).json()
    r = client.post("/analysis-profiles", json={
        "key": "zz_reuse_test", "name": "ZZ Reuse", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "exrole",
        "vials_required": 1})
    assert r.status_code == 201, r.text
    count = db_session.query(VialRole).filter_by(code="exrole").count()
    assert count == 1
    role = db_session.query(VialRole).filter_by(code="exrole").one()
    assert role.id == existing_role["id"]
    # untouched — mint never fires for a code already in the registry, so the
    # label stays whatever /vial-roles set, not the profile's name.
    assert role.label == "Pre-Existing Role"


def test_post_accepts_legacy_role_for_new_key_mint_reuses_seeded_row(client, db_session):
    """S9 Task 2: the legacy-role-for-a-new-key 400 retired (superseded name
    for the old test_mint_never_bypasses_spec3_guards — that guard is gone).
    Mint's own reach is unchanged: seeds first to mirror the real app's boot
    sequence (this file's isolated DB doesn't auto-seed), so 'hplc' already
    exists as a frozen system row when the POST reaches the mint block — mint
    must reuse it, not mint a second, non-system 'hplc' row."""
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(db_session)
    seeded = db_session.query(VialRole).filter_by(code="hplc").one()

    r = client.post("/analysis-profiles", json={"key": "zz_new", "name": "x", "is_addon": True,
                                                "fulfillment_dim": "role", "fulfillment_role": "hplc"})
    assert r.status_code == 201, r.text

    assert db_session.query(VialRole).filter_by(code="hplc").count() == 1
    reused = db_session.query(VialRole).filter_by(code="hplc").one()
    assert reused.id == seeded.id  # reused the seeded system row, not a mint duplicate
    assert reused.frozen is True and reused.is_system is True  # untouched by mint


def test_mint_never_bypasses_xtra_guard(client, db_session):
    # companion to the legacy-role case above: 'xtra' still 400s and mints nothing
    r = client.post("/analysis-profiles", json={
        "key": "zz_xtra_test", "name": "ZZ Xtra", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "xtra",
    })
    assert r.status_code == 400
    assert db_session.query(VialRole).filter_by(code="xtra").count() == 0


def test_members_put_backfills_null_department_once(client, db_session):
    # profile minted with NULL dept; PUT members whose services share one department
    # → role.department_id set; a second PUT with mixed departments does NOT clobber it
    dep_a = client.post("/departments", json={"name": "Backfill Dept A"}).json()
    dep_b = client.post("/departments", json={"name": "Backfill Dept B"}).json()
    svc_a = client.post("/analysis-services", json={
        "title": "Backfill Svc A", "keyword": "BF-SVC-A", "department_id": dep_a["id"],
    }).json()
    svc_a2 = client.post("/analysis-services", json={
        "title": "Backfill Svc A2", "keyword": "BF-SVC-A2", "department_id": dep_a["id"],
    }).json()

    profile = client.post("/analysis-profiles", json={
        "key": "zz_backfill", "name": "ZZ Backfill", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "zzbfrl",
        "vials_required": 1})
    assert profile.status_code == 201, profile.text
    profile_id = profile.json()["id"]

    role = db_session.query(VialRole).filter_by(code="zzbfrl").one()
    assert role.department_id is None

    put1 = client.put(f"/analysis-profiles/{profile_id}/members", json={
        "analysis_service_ids": [svc_a["id"], svc_a2["id"]],
    })
    assert put1.status_code == 200, put1.text
    db_session.refresh(role)
    assert role.department_id == dep_a["id"]

    svc_b = client.post("/analysis-services", json={
        "title": "Backfill Svc B", "keyword": "BF-SVC-B", "department_id": dep_b["id"],
    }).json()
    put2 = client.put(f"/analysis-profiles/{profile_id}/members", json={
        "analysis_service_ids": [svc_a["id"], svc_b["id"]],
    })
    assert put2.status_code == 200, put2.text
    db_session.refresh(role)
    assert role.department_id == dep_a["id"]  # not clobbered by the second, mixed PUT


def test_members_put_leaves_department_null_when_mixed(client, db_session):
    dep_a = client.post("/departments", json={"name": "Mixed Dept A"}).json()
    dep_b = client.post("/departments", json={"name": "Mixed Dept B"}).json()
    svc_a = client.post("/analysis-services", json={
        "title": "Mixed Svc A", "keyword": "MX-SVC-A", "department_id": dep_a["id"],
    }).json()
    svc_b = client.post("/analysis-services", json={
        "title": "Mixed Svc B", "keyword": "MX-SVC-B", "department_id": dep_b["id"],
    }).json()

    profile = client.post("/analysis-profiles", json={
        "key": "zz_mixed", "name": "ZZ Mixed", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "zzmxrl",
        "vials_required": 1})
    assert profile.status_code == 201, profile.text
    profile_id = profile.json()["id"]
    role = db_session.query(VialRole).filter_by(code="zzmxrl").one()
    assert role.department_id is None

    put_resp = client.put(f"/analysis-profiles/{profile_id}/members", json={
        "analysis_service_ids": [svc_a["id"], svc_b["id"]],
    })
    assert put_resp.status_code == 200, put_resp.text
    db_session.refresh(role)
    assert role.department_id is None


def test_members_put_never_clobbers_a_role_with_department_already_set(client, db_session):
    # is_system exclusion + set-department exclusion, exercised via a role
    # that already has a department BEFORE the first members PUT (e.g. an
    # admin set it by hand via /vial-roles) — must survive untouched.
    dep_a = client.post("/departments", json={"name": "Preset Dept A"}).json()
    dep_b = client.post("/departments", json={"name": "Preset Dept B"}).json()
    preset_role = client.post("/vial-roles", json={
        "code": "preset", "label": "Preset Role", "department_id": dep_a["id"],
    }).json()
    svc_b = client.post("/analysis-services", json={
        "title": "Preset Svc B", "keyword": "PS-SVC-B", "department_id": dep_b["id"],
    }).json()

    profile = client.post("/analysis-profiles", json={
        "key": "zz_preset", "name": "ZZ Preset", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "preset",
        "vials_required": 1})
    assert profile.status_code == 201, profile.text
    profile_id = profile.json()["id"]

    put_resp = client.put(f"/analysis-profiles/{profile_id}/members", json={
        "analysis_service_ids": [svc_b["id"]],
    })
    assert put_resp.status_code == 200, put_resp.text
    role = db_session.query(VialRole).filter_by(code="preset").one()
    assert role.department_id == dep_a["id"]  # untouched, never clobbered


def test_patch_role_change_to_unknown_mints_vial_role(client, db_session):
    # PATCH mint mirrors POST: a role change to an unknown code mints, using
    # effective_* semantics (same as the existing PATCH guards).
    create = client.post("/analysis-profiles", json={
        "key": "zz_patch_mint", "name": "ZZ Patch Mint", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]
    dep = client.post("/departments", json={"name": "Patch Mint Dept"}).json()

    resp = client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "zzptch", "fulfillment_dim": "role",
        "role_department_id": dep["id"],
    })
    assert resp.status_code == 200, resp.text
    role = db_session.query(VialRole).filter_by(code="zzptch").one()
    assert role.label == "ZZ Patch Mint" and role.department_id == dep["id"]
    assert role.boxable is False and role.frozen is False


def test_patch_role_change_to_known_role_does_not_mint(client, db_session):
    dep = client.post("/departments", json={"name": "Patch Known Dept"}).json()
    client.post("/vial-roles", json={
        "code": "known", "label": "Known Role", "department_id": dep["id"],
    })
    create = client.post("/analysis-profiles", json={
        "key": "zz_patch_known", "name": "ZZ Patch Known", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]

    resp = client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "known", "fulfillment_dim": "role",
    })
    assert resp.status_code == 200, resp.text
    assert db_session.query(VialRole).filter_by(code="known").count() == 1


def test_patch_accepts_legacy_role_for_new_key_mint_reuses_seeded_row(client, db_session):
    """S9 Task 2 PATCH counterpart to
    test_post_accepts_legacy_role_for_new_key_mint_reuses_seeded_row — same
    retirement, same reused-not-duplicated mint-reach invariant."""
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(db_session)
    seeded = db_session.query(VialRole).filter_by(code="ster").one()

    create = client.post("/analysis-profiles", json={
        "key": "zz_patch_guard", "name": "ZZ Patch Guard", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]

    resp = client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "ster", "fulfillment_dim": "role",
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["fulfillment_role"] == "ster"  # 200 alone doesn't prove the write landed

    assert db_session.query(VialRole).filter_by(code="ster").count() == 1
    reused = db_session.query(VialRole).filter_by(code="ster").one()
    assert reused.id == seeded.id  # reused the seeded system row, not a mint duplicate
    assert reused.frozen is True and reused.is_system is True  # untouched by mint


def test_post_role_boxable_true_mints_boxable_role(client, db_session):
    # role_boxable is auto-mint-only (like role_department_id): it configures
    # the newly-minted vial_roles row from the profile form, so a 1:1 family
    # is fully set up in one call instead of a second trip to /vial-roles.
    dep = client.post("/departments", json={"name": "Boxable Dept"}).json()
    r = client.post("/analysis-profiles", json={
        "key": "zz_boxable_family", "name": "ZZ Boxable", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "zzbox",
        "role_department_id": dep["id"], "role_boxable": True,
        "vials_required": 1})
    assert r.status_code == 201, r.text
    role = db_session.query(VialRole).filter_by(code="zzbox").one()
    assert role.boxable is True
    # still not a persisted profile column — it must never reach AnalysisProfile
    assert "role_boxable" not in r.json()


def test_role_boxable_does_not_mutate_an_existing_role(client, db_session):
    # Mint-only, matching role_department_id: a profile pointing at a role that
    # already exists must not silently re-configure that shared role, which
    # other profiles may also ride.
    dep = client.post("/departments", json={"name": "Shared Box Dept"}).json()
    client.post("/vial-roles", json={
        "code": "shbox", "label": "Shared Role", "department_id": dep["id"],
        "boxable": False,
    })
    r = client.post("/analysis-profiles", json={
        "key": "zz_shared_box", "name": "ZZ Shared", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "shbox",
        "role_boxable": True, "vials_required": 1})
    assert r.status_code == 201, r.text
    role = db_session.query(VialRole).filter_by(code="shbox").one()
    assert role.boxable is False
