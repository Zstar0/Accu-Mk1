"""
Test script: Can we add/remove analyses from a sample via the Senaite API?

Target: P-0086 (sample_received state, local dev)
Current analyses (unassigned): HPLC-PUR, PEPT-Total, ID_AOD9604

Tests:
  1. List available AnalysisService objects (to populate a picker UI)
  2. Add a new analysis service to the sample via REST API
  3. Remove an analysis from the sample via REST API (and ZMI fallback)

Usage:
  python scripts/test_analysis_management.py
"""

import json
import sys
import requests
from requests.auth import HTTPBasicAuth

# ── Config ───────────────────────────────────────────────────────
BASE_URL = "http://localhost:8080/senaite/@@API/senaite/v1"
SITE_URL = "http://localhost:8080/senaite"
AUTH = HTTPBasicAuth("admin", "MGrHgmqR3hD2EHWEnPpw")

SAMPLE_ID = "P-0086"
SAMPLE_UID = "785b7e9a86bd441cbc59918dc62d16e5"
SAMPLE_PATH = "clients/client-8/P-0086"

# ── Helpers ──────────────────────────────────────────────────────

def api_get(endpoint, params=None):
    r = requests.get(f"{BASE_URL}/{endpoint}", auth=AUTH, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()

def api_post(endpoint, data=None, json_data=None):
    r = requests.post(f"{BASE_URL}/{endpoint}", auth=AUTH, data=data, json=json_data, timeout=30)
    return r

def get_analyses(sample_id):
    """Get current analyses for a sample."""
    data = api_get("search", {
        "portal_type": "Analysis",
        "getRequestID": sample_id,
        "complete": "true",
        "limit": 50,
    })
    return data.get("items", [])

def get_unassigned_analyses(sample_id):
    """Get only unassigned/registered analyses (skip retracted)."""
    all_analyses = get_analyses(sample_id)
    return [a for a in all_analyses if a.get("review_state") not in ("retracted", "cancelled")]

def print_analyses(analyses, label=""):
    if label:
        print(f"\n{'='*60}")
        print(f"  {label}")
        print(f"{'='*60}")
    for a in analyses:
        state = a.get("review_state", "?")
        kw = a.get("Keyword", "?")
        title = a.get("title", "?")
        uid = a.get("uid", "?")
        print(f"    {kw:25s} | {title:40s} | {state:15s} | {uid[:12]}...")


# ══════════════════════════════════════════════════════════════════
# TEST 1: List available AnalysisService objects
# ══════════════════════════════════════════════════════════════════
def test_list_services():
    print("\n" + "="*60)
    print("  TEST 1: List available AnalysisService objects")
    print("="*60)

    data = api_get("AnalysisService", {
        "complete": "true",
        "limit": 100,
        "is_active": "true",
    })

    services = data.get("items", [])
    print(f"\n  Found {len(services)} active analysis services:\n")

    for s in services:
        kw = s.get("Keyword", "?")
        title = s.get("title", "?")
        uid = s.get("uid", "?")
        cat = s.get("getCategoryTitle", "") or ""
        print(f"    {kw:25s} | {title:45s} | cat={cat:20s} | uid={uid[:12]}...")

    return services


# ══════════════════════════════════════════════════════════════════
# TEST 2: Add a new analysis service to the sample
# ══════════════════════════════════════════════════════════════════
def test_add_analysis(services):
    print("\n" + "="*60)
    print("  TEST 2: Add analysis to sample via REST API update")
    print("="*60)

    # Pick a service NOT already on the sample - look for something like Appearance
    # First get current analyses to know what's already there
    current = get_unassigned_analyses(SAMPLE_ID)
    current_keywords = {a.get("Keyword") for a in current}
    print(f"\n  Current active keywords on {SAMPLE_ID}: {current_keywords}")

    # Find a service not already present
    new_service = None
    for s in services:
        kw = s.get("Keyword", "")
        if kw and kw not in current_keywords and "retracted" not in kw.lower():
            new_service = s
            break

    if not new_service:
        print("  [SKIP] All services already on sample, nothing to add")
        return None

    new_uid = new_service["uid"]
    new_kw = new_service["Keyword"]
    new_title = new_service["title"]
    print(f"  Will add: {new_kw} ({new_title}) uid={new_uid[:12]}...")

    # Strategy: Update the sample's Analyses field with existing + new service UIDs
    # Need to get current service UIDs (not analysis UIDs - the parent service UIDs)
    # Each analysis has a getServiceUID or we look it up from the service catalog

    # Get UIDs of services already attached (from unassigned analyses)
    existing_service_uids = set()
    for a in current:
        # The analysis object should have a reference to its service
        svc_uid = a.get("getServiceUID") or a.get("ServiceUID") or ""
        if svc_uid:
            existing_service_uids.add(svc_uid)

    if not existing_service_uids:
        # Fallback: look up service UIDs by keyword
        print("  [INFO] No ServiceUID in analysis data, looking up by keyword...")
        for a in current:
            kw = a.get("Keyword", "")
            if kw:
                svc_data = api_get("AnalysisService", {"getKeyword": kw, "complete": "true", "limit": 1})
                items = svc_data.get("items", [])
                if items:
                    existing_service_uids.add(items[0]["uid"])

    print(f"  Existing service UIDs: {existing_service_uids}")

    all_service_uids = list(existing_service_uids) + [new_uid]
    analyses_payload = [{"uid": uid} for uid in all_service_uids]

    print(f"\n  Sending POST /update/{SAMPLE_UID} with Analyses field ({len(analyses_payload)} services)...")
    r = api_post(f"update/{SAMPLE_UID}", json_data={"Analyses": analyses_payload})
    print(f"  Response: {r.status_code}")
    try:
        resp = r.json()
        print(f"  Body: {json.dumps(resp, indent=2)[:500]}")
    except Exception:
        print(f"  Body: {r.text[:500]}")

    # Verify
    print(f"\n  Verifying...")
    after = get_unassigned_analyses(SAMPLE_ID)
    after_keywords = {a.get("Keyword") for a in after}
    print(f"  Keywords after: {after_keywords}")

    if new_kw in after_keywords:
        print(f"  [PASS] Successfully added {new_kw} via REST API!")
        # Find the new analysis UID for removal test
        for a in after:
            if a.get("Keyword") == new_kw and a.get("review_state") not in ("retracted",):
                return a
        return None
    else:
        print(f"  [FAIL] {new_kw} not found after update")

        # Try alternate approach: POST to create endpoint
        print(f"\n  Trying alternate: POST /AnalysisRequest/create with just the new service...")
        # This probably won't work for existing samples, but let's confirm
        return None


# ══════════════════════════════════════════════════════════════════
# TEST 3: Remove an analysis from the sample
# ══════════════════════════════════════════════════════════════════
def test_remove_analysis(analysis_to_remove):
    print("\n" + "="*60)
    print("  TEST 3: Remove analysis from sample")
    print("="*60)

    if not analysis_to_remove:
        print("  [SKIP] No analysis to remove (test 2 may have failed)")
        # Use an existing one for testing - pick the last unassigned
        current = get_unassigned_analyses(SAMPLE_ID)
        if not current:
            print("  [SKIP] No analyses available to test removal")
            return
        # We'll describe what we'd do but not actually remove a real analysis
        print(f"\n  Would remove: {current[-1].get('Keyword')} but skipping to preserve sample")
        analysis_to_remove = current[-1]
        DRY_RUN = True
    else:
        DRY_RUN = False

    analysis_id = analysis_to_remove.get("id", "")  # e.g. "ID_AOD9604" or "HPLC-PUR-1"
    analysis_kw = analysis_to_remove.get("Keyword", "")
    analysis_uid = analysis_to_remove.get("uid", "")
    analysis_state = analysis_to_remove.get("review_state", "")

    print(f"\n  Target: {analysis_kw} (id={analysis_id}, state={analysis_state}, uid={analysis_uid[:12]}...)")

    # ── Approach A: REST API delete ──
    print(f"\n  --- Approach A: REST API DELETE /delete/{analysis_uid} ---")
    if DRY_RUN:
        print("  [DRY-RUN] Skipping actual delete")
    else:
        r = requests.delete(f"{BASE_URL}/delete/{analysis_uid}", auth=AUTH, timeout=30)
        print(f"  Response: {r.status_code}")
        try:
            resp = r.json()
            print(f"  Body: {json.dumps(resp, indent=2)[:500]}")
        except Exception:
            print(f"  Body: {r.text[:300]}")

        # Check if it worked
        after = get_unassigned_analyses(SAMPLE_ID)
        after_kws = {a.get("Keyword") for a in after}
        if analysis_kw not in after_kws:
            print(f"  [PASS] REST API DELETE removed {analysis_kw}!")
            return

        print(f"  [INFO] REST API delete didn't remove it, trying ZMI...")

    # ── Approach B: ZMI manage_delObjects ──
    print(f"\n  --- Approach B: ZMI manage_delObjects ---")
    zmi_url = f"{SITE_URL}/{SAMPLE_PATH}/manage_delObjects"
    print(f"  URL: {zmi_url}")
    print(f"  Deleting object id: {analysis_id}")

    if DRY_RUN:
        print("  [DRY-RUN] Skipping actual delete")
    else:
        r = requests.post(zmi_url, auth=AUTH, data={"ids:list": analysis_id}, timeout=30, allow_redirects=True)
        print(f"  Response: {r.status_code}")

        # Verify
        after = get_unassigned_analyses(SAMPLE_ID)
        after_kws = {a.get("Keyword") for a in after}
        if analysis_kw not in after_kws:
            print(f"  [PASS] ZMI manage_delObjects removed {analysis_kw}!")
        else:
            print(f"  [FAIL] {analysis_kw} still present after ZMI delete")
            print(f"  Remaining: {after_kws}")

    # ── Approach C: Update Analyses field without the removed service ──
    print(f"\n  --- Approach C (info): Update Analyses field minus the service ---")
    print("  This approach sets the Analyses list to all services EXCEPT the one to remove.")
    print("  Similar to how setAnalyses() works server-side.")
    print("  Would use: POST /update/{sample_uid} with Analyses=[remaining service UIDs]")


# ══════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print(f"Testing analysis management on {SAMPLE_ID}")
    print(f"Senaite: {SITE_URL}")

    # Show current state
    current = get_unassigned_analyses(SAMPLE_ID)
    print_analyses(current, f"Current active analyses on {SAMPLE_ID}")

    # Test 1: List services
    services = test_list_services()

    # Test 2: Add analysis
    added_analysis = test_add_analysis(services)

    # Test 3: Remove analysis (the one we just added, or dry-run)
    test_remove_analysis(added_analysis)

    # Final state
    final = get_unassigned_analyses(SAMPLE_ID)
    print_analyses(final, f"Final active analyses on {SAMPLE_ID}")

    print("\n" + "="*60)
    print("  DONE")
    print("="*60)
