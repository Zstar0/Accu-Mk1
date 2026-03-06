"""
Retract all verified analyses on P-0227 in Senaite.

Retracting moves analyses from 'verified' back to 'assigned' state,
making them editable again. Senaite marks the old analysis as retested=True
and creates a fresh copy for new results.

Usage:
  python scripts/retract_analyses_p0227.py              # dry-run production
  python scripts/retract_analyses_p0227.py --execute    # execute on production
"""

import argparse
import sys
import requests
from requests.auth import HTTPBasicAuth

PROD = {
    "base_url": "https://senaite.valenceanalytical.com/@@API/senaite/v1",
    "username": "admin",
    "password": "MGrHgmqR3hD2EHWEnPpw",
    "sample_id": "P-0227",
}

BASE_URL = PROD["base_url"]
AUTH = HTTPBasicAuth(PROD["username"], PROD["password"])
SAMPLE_ID = PROD["sample_id"]


def green(s):  return f"\033[92m{s}\033[0m"
def red(s):    return f"\033[91m{s}\033[0m"
def yellow(s): return f"\033[93m{s}\033[0m"
def bold(s):   return f"\033[1m{s}\033[0m"


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
    return r


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="Actually retract (default is dry-run)")
    args = parser.parse_args()

    mode = "EXECUTE" if args.execute else "DRY RUN"
    print(bold("=" * 60))
    print(bold(f"  Retract verified analyses on {SAMPLE_ID} — {mode}"))
    print(bold("=" * 60))

    # Fetch analyses
    print(f"\nFetching analyses for {SAMPLE_ID}...")
    data = api_get("Analysis", {
        "getRequestID": SAMPLE_ID,
        "complete": "yes",
        "limit": 100,
    })
    analyses = data.get("items", [])
    if not analyses:
        print(red(f"No analyses found for {SAMPLE_ID}"))
        sys.exit(1)

    print(f"\nFound {len(analyses)} analyses:")
    verified = []
    for a in analyses:
        title = a.get("title", a.get("Title", "?"))
        state = a.get("review_state", "?")
        result = a.get("Result", "")
        retested = a.get("retested", False)
        retested_str = " [RETESTED]" if retested else ""
        marker = ""
        if state == "verified" and not retested:
            verified.append(a)
            marker = "  <-- will retract"
        print(f"  - {title} | state={state} | result={result}{retested_str}{marker}")

    if not verified:
        print(yellow("\nNo verified (non-retested) analyses to retract."))
        sys.exit(0)

    print(f"\n{len(verified)} analyses to retract.")

    if not args.execute:
        print(bold("\n" + "=" * 60))
        print(yellow("  DRY RUN — no changes made."))
        print("  To retract: python scripts/retract_analyses_p0227.py --execute")
        print(bold("=" * 60))
        return

    print(bold("\n>>> RETRACTING <<<"))
    for a in verified:
        uid = a["uid"]
        title = a.get("title", a.get("Title", uid))
        print(f"\n  Retracting: {title} (uid={uid})")
        r = api_post(f"update/{uid}", {"transition": "retract"})
        if r.ok:
            items = r.json().get("items", [])
            new_state = items[0].get("review_state", "?") if items else "?"
            print(green(f"    OK — new state: {new_state}"))
        else:
            print(red(f"    FAILED — {r.status_code}: {r.text[:200]}"))

    # Final check
    print(bold(f"\nFinal state of analyses on {SAMPLE_ID}:"))
    data = api_get("Analysis", {"getRequestID": SAMPLE_ID, "complete": "yes", "limit": 100})
    for a in data.get("items", []):
        title = a.get("title", a.get("Title", "?"))
        state = a.get("review_state", "?")
        result = a.get("Result", "")
        retested = a.get("retested", False)
        retested_str = " [RETESTED]" if retested else ""
        print(f"  - {title} | state={state} | result={result}{retested_str}")

    print(bold("\n" + "=" * 60))
    print(green("  Done. Check Senaite to confirm and re-enter results."))
    print(f"  https://senaite.valenceanalytical.com/clients/client-15/{SAMPLE_ID}")
    print(bold("=" * 60))


if __name__ == "__main__":
    main()
