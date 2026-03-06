"""
Reset verified analyses on P-0227 by deleting them and re-adding the services.

Senaite locks verified analyses — the only reliable way out is ZMI manage_delObjects,
then re-adding the same analysis services so they start fresh (unassigned/assigned state).

After running with --execute, enter correct results in the Senaite UI, then submit + verify.

Usage:
  python scripts/reset_analyses_p0227.py              # dry-run
  python scripts/reset_analyses_p0227.py --execute    # delete + re-add
"""

import argparse
import sys
import requests
from requests.auth import HTTPBasicAuth

PROD = {
    "api_base": "https://senaite.valenceanalytical.com/@@API/senaite/v1",
    "site_base": "https://senaite.valenceanalytical.com",
    "username": "admin",
    "password": "MGrHgmqR3hD2EHWEnPpw",
    "sample_id": "P-0227",
    "sample_path": "clients/client-14/P-0227",
    "client_url": "https://senaite.valenceanalytical.com/clients/client-14/P-0227",
}

AUTH = HTTPBasicAuth(PROD["username"], PROD["password"])


def green(s):  return f"\033[92m{s}\033[0m"
def red(s):    return f"\033[91m{s}\033[0m"
def yellow(s): return f"\033[93m{s}\033[0m"
def bold(s):   return f"\033[1m{s}\033[0m"


def api_get(path, params=None):
    url = f"{PROD['api_base']}/{path}" if not path.startswith("http") else path
    r = requests.get(url, auth=AUTH, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def api_post(path, payload):
    url = f"{PROD['api_base']}/{path}" if not path.startswith("http") else path
    r = requests.post(url, auth=AUTH, json=payload, timeout=30)
    if not r.ok:
        print(red(f"  API error {r.status_code}: {r.text[:300]}"))
    r.raise_for_status()
    return r.json()


def step1_get_sample_and_analyses():
    print(bold(f"\n[Step 1] Fetching {PROD['sample_id']} and analyses..."))

    ar_data = api_get("AnalysisRequest", {"id": PROD["sample_id"], "complete": "yes"})
    items = ar_data.get("items", [])
    if not items:
        print(red(f"  Sample {PROD['sample_id']} not found!"))
        sys.exit(1)
    ar = items[0]
    print(f"  AR UID:   {ar['uid']}")
    print(f"  AR state: {ar.get('review_state')}")
    print(f"  AR path:  {ar.get('path')}")

    a_data = api_get("Analysis", {
        "getRequestID": PROD["sample_id"],
        "complete": "yes",
        "limit": 100,
    })
    analyses = a_data.get("items", [])
    print(f"\n  Found {len(analyses)} analyses:")
    for a in analyses:
        title = a.get("title", "?")
        state = a.get("review_state", "?")
        result = a.get("Result", "")
        obj_id = a.get("id", "?")
        path = a.get("path", "?")
        print(f"    [{obj_id}] {title} | state={state} | result={result}")
        print(f"      path: {path}")

    return ar, analyses


def step2_lookup_services(analyses):
    print(bold("\n[Step 2] Looking up AnalysisService UIDs..."))
    services = []
    for a in analyses:
        keyword = a.get("Keyword") or a.get("getKeyword") or a.get("id")
        title = a.get("title", "?")
        svc_data = api_get("AnalysisService", {
            "getKeyword": keyword,
            "complete": "yes",
            "limit": 5,
        })
        svc_items = svc_data.get("items", [])
        if not svc_items:
            print(yellow(f"  WARNING: service '{keyword}' not found — skipping"))
            continue
        svc = svc_items[0]
        print(f"  {title} [{keyword}] -> service uid={svc['uid']}")
        services.append({"uid": svc["uid"], "keyword": keyword, "title": title})
    return services


def step3_delete_analyses(analyses):
    print(bold("\n[Step 3] Deleting verified analyses via ZMI manage_delObjects..."))
    # Group by parent path
    parent_path = PROD["sample_path"]
    # ZMI URL: site_base / parent_path / manage_delObjects
    zmi_parent = f"{PROD['site_base']}/{parent_path}"
    delete_url = f"{zmi_parent}/manage_delObjects"

    for a in analyses:
        obj_id = a.get("id")
        title = a.get("title", obj_id)
        print(f"  Deleting: {obj_id} ({title})")
        r = requests.post(delete_url, auth=AUTH, data={"ids:list": obj_id},
                          timeout=30, allow_redirects=True)
        print(f"    ZMI response: {r.status_code}")
        if not r.ok:
            print(red(f"    FAILED: {r.text[:200]}"))

    # Verify deletion
    check = api_get("Analysis", {
        "getRequestID": PROD["sample_id"],
        "complete": "yes",
        "limit": 100,
    })
    remaining = check.get("items", [])
    if not remaining:
        print(green("  All analyses deleted."))
    else:
        print(yellow(f"  {len(remaining)} analyses still remain:"))
        for a in remaining:
            print(f"    [{a.get('id')}] state={a.get('review_state')}")
    return remaining


def step4_readd_services(ar, services):
    print(bold("\n[Step 4] Re-adding analysis services to sample..."))
    ar_uid = ar["uid"]
    uid_objects = [{"uid": s["uid"]} for s in services]
    print(f"  Adding {len(uid_objects)} services to AR {ar_uid}...")
    result = api_post(f"update/{ar_uid}", {"Analyses": uid_objects})
    items = result.get("items", [])
    if items:
        print(green(f"  Done. AR state: {items[0].get('review_state', '?')}"))
    else:
        print(yellow("  No items in response."))


def step5_verify():
    print(bold(f"\n[Step 5] Final state of analyses on {PROD['sample_id']}:"))
    data = api_get("Analysis", {
        "getRequestID": PROD["sample_id"],
        "complete": "yes",
        "limit": 100,
    })
    for a in data.get("items", []):
        title = a.get("title", "?")
        state = a.get("review_state", "?")
        result = a.get("Result", "")
        retested = a.get("retested", False)
        print(f"  [{a.get('id')}] {title} | state={state} | result={result} | retested={retested}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()

    mode = "EXECUTE" if args.execute else "DRY RUN"
    print(bold("=" * 60))
    print(bold(f"  Reset analyses on {PROD['sample_id']} — {mode}"))
    print(bold("=" * 60))

    ar, analyses = step1_get_sample_and_analyses()

    verified = [a for a in analyses if a.get("review_state") == "verified" and not a.get("retested")]
    if not verified:
        print(yellow("\nNo verified (non-retested) analyses found. Nothing to do."))
        sys.exit(0)

    services = step2_lookup_services(verified)

    if not args.execute:
        print(bold("\n" + "=" * 60))
        print(yellow("  DRY RUN — no changes made."))
        print(f"  Will delete {len(verified)} analyses and re-add {len(services)} services.")
        print("  To execute: python scripts/reset_analyses_p0227.py --execute")
        print(bold("=" * 60))
        return

    print(bold("\n>>> EXECUTING <<<"))

    remaining = step3_delete_analyses(verified)
    if remaining:
        print(yellow("  Some analyses weren't deleted — re-add may fail or duplicate."))

    step4_readd_services(ar, services)
    step5_verify()

    print(bold("\n" + "=" * 60))
    print(green("  Done. Open Senaite and enter the correct results for P-0227."))
    print(f"  {PROD['client_url']}")
    print(bold("=" * 60))


if __name__ == "__main__":
    main()
