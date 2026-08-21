"""Analysis Profile membership routes: PUT sets sort_order, GET reads it back
in that order. Route-level coverage against a live DB — the ORM-level tests
in test_analysis_profiles.py exercise the relationship's order_by against
sqlite; this exercises the GET route's own .order_by() against the real
migrated schema, over HTTP. Self-restoring.

Also covers the PUT route's own two behaviors that have no ORM-level
equivalent: filtering bogus analysis_service_ids (rather than 500ing or
dangling a row) and reporting the actual persisted count, and pinning the
sort_order=i WRITE itself (as opposed to the two read-side order_by tests
above, which only prove sort_order is read correctly once it exists).

Run in container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_analysis_profiles.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _auth_override():
    # Scoped per-test (set before, popped after) rather than a bare
    # module-level assignment: app.dependency_overrides is a dict on the
    # shared `app` singleton, mutated by dozens of test files across this
    # suite (several via fixture-scoped pop() in their own teardown, e.g.
    # test_registry_inbox.py). A module-level override here is silently
    # wiped by another file's teardown depending on collection/execution
    # order — confirmed empirically: this file passed standalone but hit
    # 401s inside the full `pytest tests/` run until switched to this
    # try/finally-equivalent per-test pattern (mirrors the codebase's own
    # resilient convention, e.g. test_registry_inbox.py's inline
    # set-before / pop-in-finally).
    app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
    try:
        yield
    finally:
        app.dependency_overrides.pop(auth.get_current_user, None)


@pytest.fixture
def two_services():
    """Created through the live POST /analysis-services route (Task 5) rather
    than raw SQL, so this stays a pure route-level test and doesn't need to
    know which columns the ORM defaults vs. the DB defaults."""
    a = client.post("/analysis-services", json={
        "title": "Route Test Svc A", "keyword": "RTA-ROUTE-TEST",
    }).json()["id"]
    b = client.post("/analysis-services", json={
        "title": "Route Test Svc B", "keyword": "RTB-ROUTE-TEST",
    }).json()["id"]
    yield a, b
    client.delete(f"/analysis-services/{a}")
    client.delete(f"/analysis-services/{b}")


@pytest.fixture(autouse=True)
def cleanup_profiles():
    with engine.connect() as c:
        before = {r[0] for r in c.execute(text("SELECT id FROM analysis_profiles")).fetchall()}
    yield
    with engine.begin() as c:
        after = {r[0] for r in c.execute(text("SELECT id FROM analysis_profiles")).fetchall()}
        new = list(after - before)
        if new:
            c.execute(text("DELETE FROM analysis_profiles WHERE id = ANY(:i)"), {"i": new})


def test_get_members_returns_put_order(two_services):
    """PUT [B, A] then GET must return [B, A]."""
    svc_a, svc_b = two_services
    create = client.post("/analysis-profiles", json={
        "key": "route_order_test", "name": "Route Order Test", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]

    put_resp = client.put(
        f"/analysis-profiles/{profile_id}/members",
        json={"analysis_service_ids": [svc_b, svc_a]},
    )
    assert put_resp.status_code == 200, put_resp.text
    assert put_resp.json() == {"count": 2}

    get_resp = client.get(f"/analysis-profiles/{profile_id}/members")
    assert get_resp.status_code == 200, get_resp.text
    assert get_resp.json() == [svc_b, svc_a]


def test_get_members_orders_by_sort_order_not_insertion(two_services):
    """PUT always inserts in list order, so PUT alone can't tell 'reads by
    sort_order' apart from 'reads by insertion order' — they're always the
    same via that route. Insert directly with insertion order and sort_order
    deliberately disagreeing, so only a genuine ORDER BY sort_order passes."""
    svc_a, svc_b = two_services
    create = client.post("/analysis-profiles", json={
        "key": "route_order_test_2", "name": "Route Order Test 2", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]

    with engine.begin() as c:
        # svc_a inserted first (lower physical/insertion order) but given the
        # HIGHER sort_order; svc_b inserted second but given the LOWER one.
        c.execute(text(
            "INSERT INTO analysis_profile_members "
            "(analysis_profile_id, analysis_service_id, sort_order) "
            "VALUES (:pid, :sid, 1)"
        ), {"pid": profile_id, "sid": svc_a})
        c.execute(text(
            "INSERT INTO analysis_profile_members "
            "(analysis_profile_id, analysis_service_id, sort_order) "
            "VALUES (:pid, :sid, 0)"
        ), {"pid": profile_id, "sid": svc_b})

    get_resp = client.get(f"/analysis-profiles/{profile_id}/members")
    assert get_resp.status_code == 200, get_resp.text
    assert get_resp.json() == [svc_b, svc_a]


def test_put_members_filters_bogus_ids_and_reports_actual_count(two_services):
    """A bogus analysis_service_id must be filtered out — not dangle a row
    and not 500 — and the returned count must reflect what was actually
    persisted (2), not what was requested (3). Mirrors
    set_service_group_members's select-then-assign filtering."""
    svc_a, svc_b = two_services
    create = client.post("/analysis-profiles", json={
        "key": "route_filter_test", "name": "Route Filter Test", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]

    bogus_id = 999999999
    put_resp = client.put(
        f"/analysis-profiles/{profile_id}/members",
        json={"analysis_service_ids": [svc_a, bogus_id, svc_b]},
    )
    assert put_resp.status_code == 200, put_resp.text
    assert put_resp.json() == {"count": 2}

    get_resp = client.get(f"/analysis-profiles/{profile_id}/members")
    assert get_resp.status_code == 200, get_resp.text
    assert get_resp.json() == [svc_a, svc_b]
    assert bogus_id not in get_resp.json()


def test_put_members_writes_sort_order_from_list_position(two_services):
    """Pins the WRITE side (main.py's `for i, svc_id in enumerate(...)`
    loop), independently of both read paths tested above. Reads the junction
    table directly via raw SQL — not through GET and not through the ORM
    relationship — so a mutation that ties every sort_order to a constant
    (breaking only the write) fails this test even though it wouldn't
    affect either order_by-based read test, which never exercise PUT with
    genuinely distinguishable input."""
    svc_a, svc_b = two_services
    create = client.post("/analysis-profiles", json={
        "key": "route_sort_write_test", "name": "Route Sort Write Test",
        "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]

    put_resp = client.put(
        f"/analysis-profiles/{profile_id}/members",
        json={"analysis_service_ids": [svc_b, svc_a]},
    )
    assert put_resp.status_code == 200, put_resp.text

    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT analysis_service_id, sort_order FROM analysis_profile_members "
            "WHERE analysis_profile_id = :pid"
        ), {"pid": profile_id}).fetchall()
    stored = {r[0]: r[1] for r in rows}
    assert stored == {svc_b: 0, svc_a: 1}


def test_get_members_404_for_unknown_profile():
    resp = client.get("/analysis-profiles/999999999/members")
    assert resp.status_code == 404


def test_post_rejects_bad_fulfillment_dim():
    resp = client.post("/analysis-profiles", json={
        "key": "bad_dim_test", "name": "Bad Dim Test", "is_addon": True,
        "fulfillment_dim": "banana",
    })
    assert resp.status_code == 400
    assert "fulfillment_dim" in resp.json()["detail"]


def test_post_rejects_bad_fulfillment_role():
    resp = client.post("/analysis-profiles", json={
        "key": "bad_role_test", "name": "Bad Role Test", "is_addon": True,
        "fulfillment_role": "ALLCAPS-TOO-LONG", "fulfillment_dim": "role",
    })
    assert resp.status_code == 400
    assert "fulfillment_role" in resp.json()["detail"]


def test_post_accepts_valid_role_and_dim():
    resp = client.post("/analysis-profiles", json={
        "key": "good_role_test", "name": "Good Role Test", "is_addon": True,
        "fulfillment_role": "hm", "fulfillment_dim": "role",
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["fulfillment_role"] == "hm"


def test_patch_rejects_bad_fulfillment_dim():
    create = client.post("/analysis-profiles", json={
        "key": "patch_dim_test", "name": "Patch Dim Test", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={"fulfillment_dim": "banana"})
    assert resp.status_code == 400
    assert "fulfillment_dim" in resp.json()["detail"]


def test_patch_rejects_bad_fulfillment_role():
    create = client.post("/analysis-profiles", json={
        "key": "patch_role_test", "name": "Patch Role Test", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "ALLCAPS-TOO-LONG", "fulfillment_dim": "role",
    })
    assert resp.status_code == 400
    assert "fulfillment_role" in resp.json()["detail"]


def test_patch_accepts_valid_role():
    create = client.post("/analysis-profiles", json={
        "key": "patch_role_ok_test", "name": "Patch Role Ok Test", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "hm", "fulfillment_dim": "role",
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["fulfillment_role"] == "hm"


def test_patch_role_only_validates_against_existing_dim_when_omitted():
    """A PATCH that sets only fulfillment_role (omitting fulfillment_dim) must
    still validate against the profile's EXISTING dim (default 'role' here),
    not skip validation because fulfillment_dim wasn't in this payload."""
    create = client.post("/analysis-profiles", json={
        "key": "patch_effective_dim_test", "name": "Patch Effective Dim Test",
        "is_addon": True,
    })
    assert create.status_code == 201, create.text
    assert create.json()["fulfillment_dim"] == "role"  # confirm default
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "ALLCAPS",
    })
    assert resp.status_code == 400
    assert "fulfillment_role" in resp.json()["detail"]


def test_post_accepts_legacy_role_for_new_key():
    """S9 Task 2: superseded by test_new_profile_may_anchor_legacy_role_post_flip
    below. Finding 2's original rule (a NEW profile could not claim a legacy
    fulfillment_role) retired with Task 1's flip — the catalog now prevails
    on divergence, so the zero-clamp this 400 protected no longer happens."""
    resp = client.post("/analysis-profiles", json={
        "key": "new_role_reservation_test", "name": "New Role Reservation Test",
        "is_addon": True, "fulfillment_role": "hplc", "fulfillment_dim": "role",
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["fulfillment_role"] == "hplc"


def test_post_rejects_xtra_role():
    resp = client.post("/analysis-profiles", json={
        "key": "xtra_role_test", "name": "Xtra Role Test", "is_addon": True,
        "fulfillment_role": "xtra", "fulfillment_dim": "role",
    })
    assert resp.status_code == 400
    assert "reserved unassigned bucket" in resp.json()["detail"]


def test_post_accepts_non_legacy_role_for_new_key():
    """Sanity companion to the accept tests above (S9 Task 2 retired their
    old 400s): a catalog-only role (not one of hplc/endo/ster/xtra) on a
    new key is, and always was, unaffected by the legacy-role guard."""
    resp = client.post("/analysis-profiles", json={
        "key": "catalog_only_role_test", "name": "Catalog Only Role Test",
        "is_addon": True, "fulfillment_role": "hm", "fulfillment_dim": "role",
    })
    assert resp.status_code == 201, resp.text


def test_patch_accepts_legacy_role_for_new_key():
    """S9 Task 2: PATCH counterpart to test_post_accepts_legacy_role_for_new_key
    — the same 400 retired on the PATCH edge with Task 1's flip."""
    create = client.post("/analysis-profiles", json={
        "key": "patch_role_reservation_test", "name": "Patch Role Reservation Test",
        "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "endo", "fulfillment_dim": "role",
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["fulfillment_role"] == "endo"


def test_patch_rejects_xtra_role_even_on_legacy_key():
    """S9 Task 2: the legacy-role reservation guard retired, but 'xtra'
    remains reserved for every profile — including the five real legacy-key
    ones. Uses the real 'endotoxin' seed row rather than a fixture profile
    so a genuine legacy-key profile is the one hitting the xtra guard."""
    from database import SessionLocal
    from models import AnalysisProfile
    db = SessionLocal()
    try:
        endotoxin = db.query(AnalysisProfile).filter_by(key="endotoxin").one()
        profile_id, original_role = endotoxin.id, endotoxin.fulfillment_role
    finally:
        db.close()
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={"fulfillment_role": "xtra"})
    assert resp.status_code == 400
    assert "reserved unassigned bucket" in resp.json()["detail"]
    db2 = SessionLocal()
    try:
        after = db2.query(AnalysisProfile).filter_by(key="endotoxin").one()
        assert after.fulfillment_role == original_role  # rejected PATCH must not mutate
    finally:
        db2.close()


def test_patch_accepts_legacy_key_keeping_its_own_role():
    """A legacy-key profile keeping (or re-setting) its own legacy role was
    always legal and stays legal post-S9 — this pins that the retirement of
    the new-key guard didn't regress the existing-key path."""
    from database import SessionLocal
    from models import AnalysisProfile
    db = SessionLocal()
    try:
        endotoxin = db.query(AnalysisProfile).filter_by(key="endotoxin").one()
        profile_id = endotoxin.id
    finally:
        db.close()
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={
        "fulfillment_role": "endo", "fulfillment_dim": "role",
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["fulfillment_role"] == "endo"


def test_new_profile_may_anchor_legacy_role_post_flip():
    """S9 Task 2: with the catalog authoritative (Task 1 retired the
    legacy-wins clamp), a NEW profile may legitimately anchor a legacy
    bucket — the pre-S9 400 protected a zero-clamp that no longer exists.
    'xtra' stays reserved regardless (never a real fulfillment target)."""
    resp = client.post("/analysis-profiles", json={
        "key": "test_new_hplc_family", "name": "Test New HPLC Family",
        "is_addon": True, "fulfillment_role": "hplc", "fulfillment_dim": "role",
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["fulfillment_role"] == "hplc"

    resp2 = client.post("/analysis-profiles", json={
        "key": "test_xtra_grab", "name": "Test Xtra Grab", "is_addon": True,
        "fulfillment_role": "xtra", "fulfillment_dim": "role",
    })
    assert resp2.status_code == 400, "xtra reservation must survive S9"


def test_patch_explicit_null_fulfillment_dim_rejected_not_500():
    """fulfillment_dim is NOT NULL on the model/response (unlike coa_archetype,
    which is legitimately nullable). An explicit JSON null is indistinguishable
    from a bad string at the DB layer — both must 400, never reach setattr +
    commit and trip the NOT NULL constraint as an unhandled 500."""
    create = client.post("/analysis-profiles", json={
        "key": "patch_null_dim_test", "name": "Patch Null Dim Test", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={"fulfillment_dim": None})
    assert resp.status_code == 400, resp.text
    assert "fulfillment_dim" in resp.json()["detail"]


# ── Task 11: profile-level SLA tier ─────────────────────────────────────────

def _default_tier_id():
    """Mirrors test_api_service_group_sla_tier.py's helper — reads the
    seeded catch-all tier rather than minting a throwaway one per test."""
    with engine.connect() as c:
        return c.execute(text("SELECT id FROM sla_tiers WHERE is_default")).scalar()


def test_post_with_sla_tier_id_echoes_it():
    tid = _default_tier_id()
    resp = client.post("/analysis-profiles", json={
        "key": "sla_tier_post_test", "name": "SLA Tier Post Test", "is_addon": True,
        "sla_tier_id": tid,
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["sla_tier_id"] == tid


def test_post_rejects_unknown_sla_tier_id():
    resp = client.post("/analysis-profiles", json={
        "key": "sla_tier_post_bad_test", "name": "SLA Tier Post Bad Test",
        "is_addon": True, "sla_tier_id": 999999999,
    })
    assert resp.status_code == 400, resp.text
    assert "SLA tier" in resp.json()["detail"]


def test_patch_sets_sla_tier_id():
    tid = _default_tier_id()
    create = client.post("/analysis-profiles", json={
        "key": "sla_tier_patch_test", "name": "SLA Tier Patch Test", "is_addon": True,
    })
    assert create.status_code == 201, create.text
    assert create.json()["sla_tier_id"] is None
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={"sla_tier_id": tid})
    assert resp.status_code == 200, resp.text
    assert resp.json()["sla_tier_id"] == tid


def test_patch_null_sla_tier_id_clears_it():
    tid = _default_tier_id()
    create = client.post("/analysis-profiles", json={
        "key": "sla_tier_patch_clear_test", "name": "SLA Tier Patch Clear Test",
        "is_addon": True, "sla_tier_id": tid,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={"sla_tier_id": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["sla_tier_id"] is None


def test_patch_rejects_unknown_sla_tier_id():
    create = client.post("/analysis-profiles", json={
        "key": "sla_tier_patch_bad_test", "name": "SLA Tier Patch Bad Test",
        "is_addon": True,
    })
    assert create.status_code == 201, create.text
    profile_id = create.json()["id"]
    resp = client.patch(f"/analysis-profiles/{profile_id}", json={"sla_tier_id": 999999999})
    assert resp.status_code == 400, resp.text
    assert "SLA tier" in resp.json()["detail"]


def test_member_service_ids_present_and_correct(two_services):
    """member_service_ids (Task 11) must mirror member_ids exactly — same
    analysis_services relationship, added under the name the FE SLA resolver
    contract expects (buildServiceToProfileTierMap)."""
    svc_a, svc_b = two_services
    create = client.post("/analysis-profiles", json={
        "key": "member_service_ids_test", "name": "Member Service Ids Test",
        "is_addon": True,
    })
    assert create.status_code == 201, create.text
    assert create.json()["member_service_ids"] == []
    profile_id = create.json()["id"]

    put_resp = client.put(
        f"/analysis-profiles/{profile_id}/members",
        json={"analysis_service_ids": [svc_b, svc_a]},
    )
    assert put_resp.status_code == 200, put_resp.text

    list_resp = client.get("/analysis-profiles")
    assert list_resp.status_code == 200, list_resp.text
    row = next(r for r in list_resp.json() if r["id"] == profile_id)
    assert row["member_service_ids"] == [svc_b, svc_a]
    assert row["member_service_ids"] == row["member_ids"]
