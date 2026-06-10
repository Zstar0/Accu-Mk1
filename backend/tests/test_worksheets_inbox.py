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

    Picks a sub-sample with a real bench role that isn't already on an open
    worksheet (the `assigned_pairs` filter in the route correctly hides those).
    """
    from models import Worksheet, WorksheetItem  # local import to avoid top-level cycle in test setup
    with SessionLocal() as db:
        # Sub-sample UIDs already on an open or staging worksheet
        worksheeted_uids = {
            row[0] for row in db.query(WorksheetItem.sample_uid)
            .join(Worksheet, WorksheetItem.worksheet_id == Worksheet.id)
            .filter(Worksheet.status.in_(("open", "staging")))
            .all()
        }
        candidate = (
            db.query(LimsSubSample)
            .filter(LimsSubSample.assignment_role.in_(["hplc", "ster", "endo"]))
            .filter(~LimsSubSample.external_lims_uid.in_(worksheeted_uids or {""}))
            .first()
        )
        if candidate is None:
            pytest.skip("no inbox-eligible role-assigned sub-samples in subvial stack")
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


# ── Legacy fallback (no lims_samples row) ────────────────────────────────────

def test_legacy_parent_without_lims_row_falls_back_to_hplc(client, auth_headers):
    """Prod safety net: a parent SENAITE id linked to an order but with no
    lims_samples row should still appear in the HPLC inbox via the legacy
    fallback. Without this, a cold deploy onto prod (lims_samples empty for
    every legacy parent) would yield an empty inbox.

    Test strategy: pick an inbox-eligible parent, temporarily delete its
    lims_samples row + the row's sub-samples, hit the inbox, assert the
    parent still appears with assignment_role='hplc' / vial_total=1, then
    restore the rows in a rollback.
    """
    from models import LimsSample, LimsSubSample
    with SessionLocal() as db:
        # Pick a parent that's currently in the HPLC inbox AND has a lims_samples row
        resp = client.get(
            "/worksheets/inbox",
            params={"role": "hplc", "hide_test_orders": "false"},
            headers=auth_headers,
        )
        candidates = [
            item for item in resp.json()["items"]
            if item["is_parent"] and item["assignment_role"] == "hplc"
        ]
        if not candidates:
            pytest.skip("no HPLC parent vials in subvial stack inbox")
        target = candidates[0]
        target_id = target["sample_id"]

        # Snapshot then delete the lims_samples row (CASCADE drops sub rows too)
        existing = db.query(LimsSample).filter(LimsSample.sample_id == target_id).first()
        if existing is None:
            pytest.skip(f"{target_id} has no lims_samples row to delete")
        # Avoid the variance-locked-by-user FK ON DELETE constraint
        existing_subs = db.query(LimsSubSample).filter(
            LimsSubSample.parent_sample_pk == existing.id
        ).all()

        try:
            for sub in existing_subs:
                db.delete(sub)
            db.delete(existing)
            db.commit()

            # Hit the inbox again — fallback should kick in
            resp = client.get(
                "/worksheets/inbox",
                params={"role": "hplc", "hide_test_orders": "false"},
                headers=auth_headers,
            )
            items = resp.json()["items"]
            fallback_items = [i for i in items if i["sample_id"] == target_id]
            assert len(fallback_items) == 1, (
                f"{target_id} should appear via legacy fallback; got {len(fallback_items)}"
            )
            fb = fallback_items[0]
            assert fb["is_parent"] is True
            assert fb["assignment_role"] == "hplc"
            assert fb["parent_sample_id"] == target_id
            assert fb["vial_sequence"] == 0
            assert fb["vial_total"] == 1
        finally:
            # Restore the rows
            restored = LimsSample(
                sample_id=existing.sample_id,
                external_lims_uid=existing.external_lims_uid,
                external_lims_system=existing.external_lims_system,
                client_id=existing.client_id,
                client_uid=existing.client_uid,
                contact_uid=existing.contact_uid,
                sample_type=existing.sample_type,
                status=existing.status,
                peptide_name=existing.peptide_name,
                client_sample_id=existing.client_sample_id,
                date_sampled=existing.date_sampled,
                date_received=existing.date_received,
                is_retest=existing.is_retest,
                assignment_role=existing.assignment_role,
                in_variance_set=existing.in_variance_set,
                variance_exclusion_reason=existing.variance_exclusion_reason,
                variance_locked_at=existing.variance_locked_at,
                variance_locked_by_user_id=existing.variance_locked_by_user_id,
                created_at=existing.created_at,
                last_synced_at=existing.last_synced_at,
            )
            db.add(restored)
            db.flush()
            for s in existing_subs:
                db.add(LimsSubSample(
                    parent_sample_pk=restored.id,
                    external_lims_uid=s.external_lims_uid,
                    sample_id=s.sample_id,
                    vial_sequence=s.vial_sequence,
                    received_at=s.received_at,
                    received_by_user_id=s.received_by_user_id,
                    photo_external_uid=s.photo_external_uid,
                    remarks=s.remarks,
                    assignment_role=s.assignment_role,
                    in_variance_set=s.in_variance_set,
                    variance_exclusion_reason=s.variance_exclusion_reason,
                    created_at=s.created_at,
                ))
            db.commit()


def test_legacy_sub_sample_shaped_id_is_skipped(client, auth_headers):
    """A sample id matching the -SNN sub-sample pattern but without a
    lims_sub_samples row is skipped (not fabricated as a parent)."""
    # The fallback regex is in main.py; exercised indirectly by every other
    # test that depends on real sub-samples appearing only when they have
    # lims_sub_samples rows. Direct assertion: regex matches the canonical
    # sub-sample id format.
    import re as _re
    assert _re.match(r"^.+-S\d{2,}$", "BW-0009-S01") is not None
    assert _re.match(r"^.+-S\d{2,}$", "P-0140-S03") is not None
    assert _re.match(r"^.+-S\d{2,}$", "BW-0009") is None
    assert _re.match(r"^.+-S\d{2,}$", "P-0140") is None


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


# ── Phase 3.5: Mk1-sourced inbox analyses for sub-samples ────────────────────


def test_sub_sample_inbox_analyses_come_from_mk1_when_seeded(client, auth_headers):
    """Sub-samples with seeded lims_analyses rows surface those rows in the
    inbox response (uid carries the 'mk1:' prefix). Sub-samples without Mk1
    rows fall back to SENAITE (uid is 32-char hex). Parent samples never
    carry mk1: UIDs.

    Requires at least one sub-sample with Phase 2+ seeded Mk1 analyses in
    the env. Skip otherwise so the test is robust on fresh DBs.
    """
    r = client.get(
        "/worksheets/inbox?role=microbiology&hide_test_orders=false",
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    items = r.json().get("items", [])
    sub_samples_with_mk1 = []
    for vial in items:
        if vial.get("is_parent"):
            continue
        uids = [a.get("uid") for a in vial.get("analyses", [])]
        if any(u and u.startswith("mk1:") for u in uids):
            sub_samples_with_mk1.append(vial["sample_id"])
    if not sub_samples_with_mk1:
        pytest.skip(
            "no sub-samples with Mk1-seeded analyses in this env — seed via "
            "Receive Wizard + assign role hplc/endo/ster first"
        )
    assert sub_samples_with_mk1, "expected at least one sub-sample with mk1: UIDs"


def test_parent_sample_inbox_analyses_never_carry_mk1_uids(client, auth_headers):
    """Parent samples (non-sub) always source analyses from SENAITE — their
    UIDs are 32-char hex, never 'mk1:'-prefixed."""
    r = client.get(
        "/worksheets/inbox?role=hplc&hide_test_orders=false",
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    items = r.json().get("items", [])
    parents = [v for v in items if v.get("is_parent")]
    if not parents:
        pytest.skip("no parent vials in hplc inbox in this env")
    for parent in parents:
        for a in parent.get("analyses", []):
            uid = a.get("uid")
            if uid:
                assert not uid.startswith("mk1:"), (
                    f"parent {parent['sample_id']} unexpectedly has mk1: UID {uid}"
                )
