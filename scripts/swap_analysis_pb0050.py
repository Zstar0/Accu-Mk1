"""
Swap analysis service on a Senaite sample.

Replaces: TB-500 - Identity (HPLC)  [ID_TB500]
With:     TB500 (17-23 Fragment) - Identity (HPLC)  [ID_TB500-17-23]

Strategy:
  1. Add the new analysis service to the sample (if not already present)
  2. Copy result from old analysis to new, submit + verify
  3. Remove the old analysis (try multiple approaches)

Usage:
  python scripts/swap_analysis_pb0050.py                        # dry-run local dev
  python scripts/swap_analysis_pb0050.py --execute              # execute on local dev
  python scripts/swap_analysis_pb0050.py --prod                 # dry-run production
  python scripts/swap_analysis_pb0050.py --prod --execute       # execute on production
"""

import argparse
import sys
import requests
from requests.auth import HTTPBasicAuth

# ── Environment configs ───────────────────────────────────────────
ENVS = {
    "local": {
        "base_url": "http://localhost:8080/senaite/@@API/senaite/v1",
        "username": "admin",
        "password": "MGrHgmqR3hD2EHWEnPpw",
        "sample_id": "PB-0061",
        "web_url": "http://localhost:8080/senaite/clients/client-8",
    },
    "prod": {
        "base_url": "https://senaite.valenceanalytical.com/@@API/senaite/v1",
        "username": "admin",
        "password": "MGrHgmqR3hD2EHWEnPpw",
        "sample_id": "PB-0050",
        "web_url": "https://senaite.valenceanalytical.com/clients/client-15",
    },
}

OLD_KEYWORD = "ID_TB500"
NEW_KEYWORD = "ID_TB500-17-23"

# Resolved at runtime
BASE_URL = ""
AUTH = None
SAMPLE_ID = ""
WEB_URL = ""

# ── Helpers ────────────────────────────────────────────────────────

def api_get(path, params=None):
    url = f"{BASE_URL}/{path}" if not path.startswith("http") else path
    r = requests.get(url, auth=AUTH, params=params, timeout=30)
    r.raise_for_status()
    return r.json()

def api_post(path, payload):
    url = f"{BASE_URL}/{path}" if not path.startswith("http") else path
    r = requests.post(url, auth=AUTH, json=payload, timeout=30)
    if not r.ok:
        print(red(f"  API error {r.status_code}: {r.text[:500]}"))
    r.raise_for_status()
    return r.json()

def api_post_safe(path, payload):
    """POST that returns result dict even on error (no raise)."""
    url = f"{BASE_URL}/{path}" if not path.startswith("http") else path
    r = requests.post(url, auth=AUTH, json=payload, timeout=30)
    if not r.ok:
        print(red(f"  API error {r.status_code}: {r.text[:500]}"))
        return {"_error": True, "status": r.status_code}
    return r.json()


def green(s):  return f"\033[92m{s}\033[0m"
def red(s):    return f"\033[91m{s}\033[0m"
def yellow(s): return f"\033[93m{s}\033[0m"
def bold(s):   return f"\033[1m{s}\033[0m"

# ── Step 1: Query sample ─────────────────────────────────────────

def step1_query_sample():
    print(bold(f"\n[Step 1] Querying sample {SAMPLE_ID}..."))
    data = api_get("AnalysisRequest", {"id": SAMPLE_ID, "complete": "yes"})
    items = data.get("items", [])
    if not items:
        print(red(f"  Sample {SAMPLE_ID} not found!"))
        sys.exit(1)

    sample = items[0]
    print(f"  Sample UID:   {sample['uid']}")
    print(f"  Review state: {sample.get('review_state', '?')}")

    print("  Fetching analyses...")
    analysis_data = api_get("Analysis", {
        "getRequestID": SAMPLE_ID,
        "complete": "yes",
        "limit": 100
    })
    analyses = analysis_data.get("items", [])
    print(f"  Found {len(analyses)} analyses:")

    old_analysis = None
    new_analysis = None

    for a in analyses:
        keyword = a.get("Keyword", a.get("getKeyword", "?"))
        title = a.get("title", a.get("Title", "?"))
        state = a.get("review_state", "?")
        result = a.get("Result", "")
        retested = a.get("retested", False)

        marker = ""
        if keyword == OLD_KEYWORD and state == "verified" and not retested:
            old_analysis = a
            marker = "  <-- OLD (to remove)"
        elif keyword == NEW_KEYWORD and state == "verified":
            new_analysis = a
            marker = "  <-- NEW (already present)"
        elif keyword == NEW_KEYWORD:
            marker = "  <-- NEW (not yet verified)"

        retested_str = " [RETESTED]" if retested else ""
        print(f"    - {keyword}: {title} | state={state} | result={result}{retested_str}{marker}")

    return sample, old_analysis, new_analysis, analyses

# ── Step 2: Look up new service ──────────────────────────────────

def step2_lookup_new_service():
    print(bold("\n[Step 2] Looking up new analysis service..."))
    data = api_get("AnalysisService", {
        "getKeyword": NEW_KEYWORD,
        "complete": "yes",
        "limit": 10
    })
    items = data.get("items", [])
    if not items:
        print(f"  Trying broader search...")
        data = api_get("AnalysisService", {"complete": "yes", "limit": 100})
        items = [i for i in data.get("items", [])
                 if "TB500" in (i.get("title", "") + i.get("Keyword", "")).upper()
                 or "TB-500" in (i.get("title", "") + i.get("Keyword", "")).upper()]
        for svc in items:
            print(f"    - {svc.get('Keyword', '?')}: {svc.get('title', '?')} | UID: {svc.get('uid', '?')}")

    if not items:
        print(red(f"  Service '{NEW_KEYWORD}' not found!"))
        sys.exit(1)

    service = next((i for i in items if i.get("Keyword") == NEW_KEYWORD), items[0])
    print(green(f"  Found: {service.get('title')} [{service.get('Keyword')}]"))
    print(f"  UID: {service.get('uid')}")
    return service

# ── Step 3: Ensure new analysis exists on sample ─────────────────

def step3_ensure_new_analysis(sample, new_service, analyses, existing_new):
    if existing_new:
        print(bold("\n[Step 3] New analysis already on sample — skipping add."))
        return existing_new

    print(bold("\n[Step 3] Adding new analysis to sample..."))
    sample_uid = sample["uid"]
    new_service_uid = new_service["uid"]

    # Collect existing AnalysisService UIDs
    existing_service_uids = set()
    for a in analyses:
        svc = a.get("AnalysisService", "")
        if isinstance(svc, dict):
            svc_uid = svc.get("uid", "")
        elif isinstance(svc, str) and len(svc) == 32:
            svc_uid = svc
        else:
            svc_uid = ""
        if svc_uid:
            existing_service_uids.add(svc_uid)

    all_uids = list(existing_service_uids) + [new_service_uid]
    uid_objects = [{"uid": uid} for uid in all_uids]

    result = api_post_safe(f"update/{sample_uid}", {"Analyses": uid_objects})
    if result.get("_error"):
        print(red("  Failed to add analysis!"))
        return None

    print(green("  Analysis added."))

    # Fetch the new analysis
    check = api_get("Analysis", {
        "getRequestID": SAMPLE_ID,
        "getKeyword": NEW_KEYWORD,
        "complete": "yes",
        "limit": 5
    })
    new_items = check.get("items", [])
    return new_items[0] if new_items else None

# ── Step 4: Copy result + submit + verify new analysis ───────────

def step4_populate_and_verify(old_analysis, new_analysis):
    print(bold("\n[Step 4] Populating and verifying new analysis..."))

    new_uid = new_analysis["uid"]
    new_state = new_analysis.get("review_state", "?")
    print(f"  New analysis UID:   {new_uid}")
    print(f"  New analysis state: {new_state}")

    if new_state == "verified":
        print(green("  Already verified — nothing to do."))
        return True

    # Copy result
    old_result = old_analysis.get("Result", "")
    if old_result:
        update = {"Result": old_result}
        method = old_analysis.get("Method", "")
        if isinstance(method, dict) and method.get("uid"):
            update["Method"] = method["uid"]
        instrument = old_analysis.get("Instrument", "")
        if isinstance(instrument, dict) and instrument.get("uid"):
            update["Instrument"] = instrument["uid"]

        print(f"  Copying result: {old_result}")
        api_post(f"update/{new_uid}", update)

    # Submit
    if new_state in ("unassigned", "assigned"):
        print("  Submitting...")
        r = api_post_safe(f"update/{new_uid}", {"transition": "submit"})
        if not r.get("_error"):
            new_state = r.get("items", [{}])[0].get("review_state", "?")
            print(f"  State: {new_state}")

    # Verify
    if new_state == "to_be_verified":
        print("  Verifying...")
        r = api_post_safe(f"update/{new_uid}", {"transition": "verify"})
        if not r.get("_error"):
            new_state = r.get("items", [{}])[0].get("review_state", "?")
            print(f"  State: {new_state}")

    if new_state == "verified":
        print(green("  New analysis verified!"))
        return True
    else:
        print(yellow(f"  State is '{new_state}' — may need manual verify."))
        return False

# ── Step 5: Remove old analysis ──────────────────────────────────

def step5_remove_old(old_analysis, sample):
    old_uid = old_analysis["uid"]
    old_id = old_analysis.get("id", old_analysis.get("Keyword", ""))
    old_path = old_analysis.get("path", "")
    print(bold(f"\n[Step 5] Removing old analysis ({old_id}, uid={old_uid})..."))
    print(f"  Path: {old_path}")

    # Use ZMI manage_delObjects — the only reliable way to delete
    # a verified analysis from Senaite's ZODB
    if old_path:
        # Parent path is everything up to the last segment
        parent_path = "/".join(old_path.split("/")[:-1])
        object_id = old_path.split("/")[-1]
    else:
        # Fallback: construct from what we know
        object_id = old_id
        parent_path = f"/senaite{sample.get('path', '')}" if sample.get("path") else ""

    if not parent_path or not object_id:
        print(red("  Cannot determine parent path or object ID!"))
        return "failed"

    # Build the ZMI URL (strip /senaite prefix, use site base URL)
    site_base = BASE_URL.replace("/@@API/senaite/v1", "")
    # parent_path starts with /senaite/..., we need to map to site URL
    if parent_path.startswith("/senaite/"):
        zmi_parent = f"{site_base}/{parent_path[len('/senaite/'):]}"
    elif parent_path.startswith("/senaite"):
        zmi_parent = f"{site_base}/{parent_path[len('/senaite'):]}"
    else:
        zmi_parent = f"{site_base}{parent_path}"

    delete_url = f"{zmi_parent}/manage_delObjects"
    print(f"  ZMI delete URL: {delete_url}")
    print(f"  Object ID: {object_id}")

    try:
        r = requests.post(delete_url, auth=AUTH, data={
            "ids:list": object_id,
        }, timeout=30, allow_redirects=True)
        print(f"  Response: {r.status_code}")
    except Exception as e:
        print(red(f"  ZMI request failed: {e}"))
        return "failed"

    if not r.ok:
        print(red(f"  ZMI returned {r.status_code}"))
        return "failed"

    # Verify deletion
    check = api_get("Analysis", {
        "getRequestID": SAMPLE_ID,
        "getKeyword": OLD_KEYWORD,
        "limit": 5
    })
    remaining = [a for a in check.get("items", [])
                 if a.get("review_state") == "verified" and not a.get("retested")]
    if not remaining:
        print(green("  Old analysis deleted via ZMI!"))
        return "deleted"
    else:
        print(yellow(f"  ZMI returned 200 but {len(remaining)} verified analyses remain."))
        return "failed"

# ── Step 6: Final verification ───────────────────────────────────

def step6_verify():
    print(bold(f"\n[Step 6] Final state of analyses on {SAMPLE_ID}:"))
    data = api_get("Analysis", {
        "getRequestID": SAMPLE_ID,
        "complete": "yes",
        "limit": 100
    })
    for a in data.get("items", []):
        keyword = a.get("Keyword", "?")
        state = a.get("review_state", "?")
        result = a.get("Result", "")
        retested = a.get("retested", False)
        # Only show identity analyses and the old keyword
        if keyword.startswith("ID_") or keyword == OLD_KEYWORD or "REPLACED" in keyword:
            r_str = " [RETESTED]" if retested else ""
            print(f"    - {keyword}: state={state} | result={result}{r_str}")

# ── Main ──────────────────────────────────────────────────────────

def main():
    global BASE_URL, AUTH, SAMPLE_ID, WEB_URL

    parser = argparse.ArgumentParser(description="Swap analysis on a Senaite sample")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--prod", action="store_true")
    args = parser.parse_args()

    env = ENVS["prod"] if args.prod else ENVS["local"]
    BASE_URL = env["base_url"]
    AUTH = HTTPBasicAuth(env["username"], env["password"])
    SAMPLE_ID = env["sample_id"]
    WEB_URL = env["web_url"]
    env_label = "PRODUCTION" if args.prod else "LOCAL DEV"

    print(bold("=" * 60))
    print(bold(f"  Analysis Swap: {SAMPLE_ID} ({env_label})"))
    print(bold(f"  {OLD_KEYWORD} -> {NEW_KEYWORD}"))
    print(bold(f"  Mode: {'EXECUTE' if args.execute else 'DRY RUN'}"))
    print(bold("=" * 60))

    # Step 1
    sample, old_analysis, new_analysis, analyses = step1_query_sample()

    if not old_analysis:
        print(red(f"\n  No verified '{OLD_KEYWORD}' analysis found on {SAMPLE_ID}!"))
        sys.exit(1)

    print(f"\n  Old analysis UID: {old_analysis['uid']} (state={old_analysis.get('review_state')})")

    # Step 2
    new_service = step2_lookup_new_service()

    if not args.execute:
        print(bold("\n" + "=" * 60))
        print(yellow("  DRY RUN complete."))
        flag = " --prod" if args.prod else ""
        print(f"  To execute: python scripts/swap_analysis_pb0050.py{flag} --execute")
        print(bold("=" * 60))
        return

    print(bold("\n>>> EXECUTING <<<"))

    # Step 3: Ensure new analysis exists
    new_a = step3_ensure_new_analysis(sample, new_service, analyses, new_analysis)
    if not new_a:
        print(red("  Could not add new analysis. Aborting."))
        sys.exit(1)

    # Step 4: Populate + verify
    step4_populate_and_verify(old_analysis, new_a)

    # Step 5: Remove old
    removal_result = step5_remove_old(old_analysis, sample)

    # Step 6: Final check
    step6_verify()

    print(bold("\n" + "=" * 60))
    if removal_result != "failed":
        print(green(f"  Swap complete! Old analysis: {removal_result}"))
    else:
        print(yellow("  New analysis is in place, but old could not be removed."))
        print("  You may need to remove it via the Senaite ZMI.")
    print(f"  Check: {WEB_URL}/{SAMPLE_ID}")
    print(bold("=" * 60))


if __name__ == "__main__":
    main()
