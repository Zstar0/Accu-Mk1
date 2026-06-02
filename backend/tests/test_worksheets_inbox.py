"""Integration tests for the /worksheets/inbox endpoint after the vial-flat redesign.

Hits the live subvial stack DB + SENAITE via FastAPI TestClient. Marked
`integration` so the default pytest run skips them — opt in with `-m integration`.

Verifies:
  * role validation (400 on invalid value, 200 on omitted)
  * role=hplc filters to assignment_role='hplc'
  * role=microbiology filters to assignment_role in {ster, endo}
  * show_xtra gating
  * Sub-samples surface in the inbox via the linked-orders extension
  * Each item carries the new vial-shape fields (is_parent, parent_sample_id,
    vial_sequence, vial_total, assignment_role, flat analyses[])
"""
import pytest
from fastapi.testclient import TestClient

from main import app, ROLE_TO_VIAL_ROLES, VALID_INBOX_ROLES, ROLE_TO_GROUP_NAMES
from database import SessionLocal
from models import LimsSample, LimsSubSample


pytestmark = pytest.mark.integration


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth_headers(client):
    resp = client.post(
        "/auth/login",
        json={"email": "forrest@valenceanalytical.com", "password": "test123"},
    )
    resp.raise_for_status()
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# ── Pure constants sanity ────────────────────────────────────────────────────

def test_microbiology_role_collapses_ster_and_endo():
    """Spec Q1: one Microbiology filter, ster + endo collapsed."""
    assert ROLE_TO_VIAL_ROLES["microbiology"] == {"ster", "endo"}


def test_hplc_role_is_singleton():
    assert ROLE_TO_VIAL_ROLES["hplc"] == {"hplc"}


def test_valid_inbox_roles_exactly_hplc_and_micro():
    assert VALID_INBOX_ROLES == {"hplc", "microbiology"}


def test_role_to_group_names_present():
    assert "Analytics" in ROLE_TO_GROUP_NAMES["hplc"]
    assert "Microbiology" in ROLE_TO_GROUP_NAMES["microbiology"]


# ── Route validation ─────────────────────────────────────────────────────────

def test_invalid_role_returns_400(client, auth_headers):
    resp = client.get("/worksheets/inbox", params={"role": "bogus"}, headers=auth_headers)
    assert resp.status_code == 400
    assert "Invalid role" in resp.json()["detail"]


def test_omitted_role_returns_200(client, auth_headers):
    """AddSamplesModal omits role; route must accept and treat as 'all roles'."""
    resp = client.get(
        "/worksheets/inbox",
        params={"hide_test_orders": "false"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["filter_role"] is None


def test_response_shape_has_new_fields(client, auth_headers):
    resp = client.get(
        "/worksheets/inbox",
        params={"role": "hplc", "hide_test_orders": "false"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["filter_role"] == "hplc"
    assert isinstance(data["items"], list)
    if not data["items"]:
        pytest.skip("subvial stack has no HPLC vials in sample_received state")
    item = data["items"][0]
    for k in (
        "uid", "sample_id", "is_parent", "parent_sample_id",
        "assignment_role", "vial_sequence", "vial_total", "analyses",
    ):
        assert k in item, f"missing field: {k}"
    assert isinstance(item["analyses"], list)
    if item["analyses"]:
        analysis = item["analyses"][0]
        for k in ("group_id", "group_name", "group_color"):
            assert k in analysis, f"missing analysis field: {k}"


# ── Role filtering ───────────────────────────────────────────────────────────

def test_hplc_filter_returns_only_hplc_vials(client, auth_headers):
    resp = client.get(
        "/worksheets/inbox",
        params={"role": "hplc", "hide_test_orders": "false"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    for item in resp.json()["items"]:
        assert item["assignment_role"] == "hplc"


def test_microbiology_filter_includes_ster_and_endo(client, auth_headers):
    resp = client.get(
        "/worksheets/inbox",
        params={"role": "microbiology", "hide_test_orders": "false"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    for item in resp.json()["items"]:
        assert item["assignment_role"] in {"ster", "endo"}


def test_microbiology_filter_excludes_hplc_vials(client, auth_headers):
    resp = client.get(
        "/worksheets/inbox",
        params={"role": "microbiology", "hide_test_orders": "false"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    for item in resp.json()["items"]:
        assert item["assignment_role"] != "hplc"


# ── Analysis filtering by service group ──────────────────────────────────────

def test_hplc_vial_analyses_are_analytics_only(client, auth_headers):
    """A vial on the HPLC filter must show only Analytics analyses, even if the
    underlying SENAITE AR carries Micro keywords (the inert duplicates decision)."""
    resp = client.get(
        "/worksheets/inbox",
        params={"role": "hplc", "hide_test_orders": "false"},
        headers=auth_headers,
    )
    for item in resp.json()["items"]:
        for analysis in item["analyses"]:
            assert analysis["group_name"] == "Analytics", (
                f"HPLC vial {item['sample_id']} has non-Analytics analysis: {analysis}"
            )


def test_microbiology_vial_analyses_are_micro_only(client, auth_headers):
    resp = client.get(
        "/worksheets/inbox",
        params={"role": "microbiology", "hide_test_orders": "false"},
        headers=auth_headers,
    )
    for item in resp.json()["items"]:
        for analysis in item["analyses"]:
            assert analysis["group_name"] == "Microbiology", (
                f"Micro vial {item['sample_id']} has non-Micro analysis: {analysis}"
            )


# ── show_xtra toggle ─────────────────────────────────────────────────────────

def test_show_xtra_off_excludes_xtra_vials(client, auth_headers):
    resp = client.get(
        "/worksheets/inbox",
        params={"role": "hplc", "hide_test_orders": "false", "show_xtra": "false"},
        headers=auth_headers,
    )
    for item in resp.json()["items"]:
        assert item["assignment_role"] != "xtra"


def test_show_xtra_on_includes_xtra_vials(client, auth_headers):
    """If the stack has any xtra-role sub-sample, show_xtra=true surfaces it."""
    with SessionLocal() as db:
        xtra_count = len([
            s for s in db.query(LimsSubSample).filter(
                LimsSubSample.assignment_role == "xtra"
            ).all()
        ])
    if xtra_count == 0:
        pytest.skip("no XTRA sub-samples in subvial stack")

    resp = client.get(
        "/worksheets/inbox",
        params={"role": "hplc", "hide_test_orders": "false", "show_xtra": "true"},
        headers=auth_headers,
    )
    items = resp.json()["items"]
    xtra_items = [i for i in items if i["assignment_role"] == "xtra"]
    assert len(xtra_items) > 0, "expected at least one XTRA vial with show_xtra=true"


# ── Sub-sample inclusion via linked-orders extension ─────────────────────────

def test_sub_samples_appear_in_inbox(client, auth_headers):
    """A sub-sample of a linked parent should surface as its own inbox item.

    Picks a parent with at least one sub-sample whose assignment_role matches
    a known filter; verifies the sub appears as a separate inbox card.
    """
    with SessionLocal() as db:
        # Find a sub-sample with a role we can filter on (hplc/ster/endo)
        candidate = db.query(LimsSubSample).filter(
            LimsSubSample.assignment_role.in_(["hplc", "ster", "endo"])
        ).first()
        if candidate is None:
            pytest.skip("no role-assigned sub-samples in subvial stack")
        parent = candidate.parent_sample
        target_role = (
            "hplc" if candidate.assignment_role == "hplc" else "microbiology"
        )
        sub_id = candidate.sample_id
        parent_id = parent.sample_id

    resp = client.get(
        "/worksheets/inbox",
        params={"role": target_role, "hide_test_orders": "false"},
        headers=auth_headers,
    )
    items = resp.json()["items"]
    sub_items = [i for i in items if i["sample_id"] == sub_id]
    assert len(sub_items) == 1, (
        f"sub-sample {sub_id} (role={candidate.assignment_role}) should appear "
        f"on the {target_role} filter; got {len(sub_items)} items"
    )
    sub = sub_items[0]
    assert sub["is_parent"] is False
    assert sub["parent_sample_id"] == parent_id
    assert sub["vial_sequence"] >= 1
    assert sub["vial_total"] >= 2  # parent + at least this sub


# ── Sort order ───────────────────────────────────────────────────────────────

def test_items_sort_by_parent_then_parent_first_then_vial_sequence(client, auth_headers):
    """Within a parent's family, parent comes first then subs in vial_sequence order."""
    resp = client.get(
        "/worksheets/inbox",
        params={
            "role": "hplc", "hide_test_orders": "false", "show_xtra": "true",
        },
        headers=auth_headers,
    )
    items = resp.json()["items"]
    # Walk pairs and check the sort order is non-decreasing on (parent_sample_id, not is_parent, vial_sequence)
    last_key = None
    for it in items:
        key = (it["parent_sample_id"], not it["is_parent"], it["vial_sequence"])
        if last_key is not None:
            assert key >= last_key, (
                f"items out of sort order: {last_key} then {key} ({it['sample_id']})"
            )
        last_key = key
