"""
Patch a published analysis result via Zope External Method.

SENAITE locks published/verified analyses — the only way to edit the result
is a Zope External Method running as system user to bypass permissions.

This script:
  1. Verifies the analysis exists and shows current value (via API, best-effort)
  2. Writes the External Method extension file into the SENAITE container
  3. Registers the External Method in Zope via API
  4. Executes it (patches the result in ZODB)
  5. Cleans up the External Method and extension file
  6. Verifies the new value via API

Usage:
  python scripts/patch_result_p0386.py                    # dry-run prod
  python scripts/patch_result_p0386.py --execute           # patch prod
  python scripts/patch_result_p0386.py --local             # dry-run local
  python scripts/patch_result_p0386.py --local --execute   # patch local
"""

import argparse
import subprocess
import sys
import requests
from requests.auth import HTTPBasicAuth

# ── ENVIRONMENTS ────────────────────────────────────────────────────
ENVS = {
    "prod": {
        "api_base":     "https://senaite.valenceanalytical.com/@@API/senaite/v1",
        "site_base":    "https://senaite.valenceanalytical.com/senaite",
        "username":     "admin",
        "password":     "MGrHgmqR3hD2EHWEnPpw",
        "sample_id":    "P-0386",
        "sample_path":  "clients/client-24/P-0386",
        "analysis_kw":  "PEPT-Total",
        "old_value":    "59.31",
        "new_value":    "55.98",
        "docker_cmd":   ["ssh", "root@165.227.241.81", "docker exec -i senaite"],
        "docker_exec":  ["ssh", "root@165.227.241.81", "docker exec senaite"],
    },
    "local": {
        "api_base":     "http://localhost:8080/senaite/@@API/senaite/v1",
        "site_base":    "http://localhost:8080/senaite",
        "username":     "admin",
        "password":     "MGrHgmqR3hD2EHWEnPpw",
        "sample_id":    "P-0119",
        "sample_path":  "clients/client-8/P-0119",
        "analysis_kw":  "PEPT-Total",
        "old_value":    "59.31",
        "new_value":    "55.98",
        "docker_cmd":   ["docker", "exec", "-i", "senaite"],
        "docker_exec":  ["docker", "exec", "senaite"],
    },
}

EXT_MODULE = "patch_result"
EXT_ID     = "patch_result_ext"
EXT_DIR    = "/home/senaite/senaitelims/parts/instance/Extensions"
# ────────────────────────────────────────────────────────────────────

# Populated in main()
CFG = {}
AUTH = None


def green(s):  return f"\033[92m{s}\033[0m"
def red(s):    return f"\033[91m{s}\033[0m"
def yellow(s): return f"\033[93m{s}\033[0m"
def bold(s):   return f"\033[1m{s}\033[0m"


def api_get(path, params=None):
    url = f"{CFG['api_base']}/{path}" if not path.startswith("http") else path
    r = requests.get(url, auth=AUTH, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def step1_verify_current_state():
    """Fetch the analysis and confirm current value (best-effort)."""
    sample_id = CFG["sample_id"]
    analysis_kw = CFG["analysis_kw"]
    new_value = CFG["new_value"]
    old_value = CFG["old_value"]

    print(bold(f"\n[Step 1] Verifying current state of {sample_id}..."))

    try:
        data = api_get("Analysis", {
            "getRequestID": sample_id,
            "complete": "yes",
            "limit": 100,
        })
    except Exception as e:
        print(yellow(f"  API query failed: {e}"))
        print(yellow("  Continuing — External Method uses ZODB directly."))
        return None

    analyses = data.get("items", [])
    if not analyses:
        print(yellow(f"  No analyses found via API for {sample_id}"))
        print(yellow("  This may be a catalog issue. External Method uses ZODB directly."))
        return None

    target = None
    print(f"\n  Found {len(analyses)} analyses:")
    for a in analyses:
        title = a.get("title", "?")
        state = a.get("review_state", "?")
        result = a.get("Result", "")
        kw = a.get("Keyword") or a.get("getKeyword") or a.get("id")
        marker = ""
        if kw == analysis_kw and not a.get("retested"):
            target = a
            marker = f"  <-- TARGET (will change {result} -> {new_value})"
        print(f"    {title} | kw={kw} | result={result} | state={state}{marker}")

    if not target:
        print(yellow(f"\n  Analysis '{analysis_kw}' not found via API — may still exist in ZODB."))
        return None

    current = target.get("Result", "")
    if current != old_value:
        print(yellow(f"\n  WARNING: Expected current value '{old_value}' but found '{current}'"))
        resp = input("  Continue anyway? [y/N]: ").strip().lower()
        if resp != "y":
            print("  Aborted.")
            sys.exit(0)

    return target


def step2_write_extension():
    """Write the External Method extension file into the SENAITE container."""
    print(bold("\n[Step 2] Writing extension file to container..."))

    sample_path = CFG["sample_path"]
    analysis_kw = CFG["analysis_kw"]
    new_value = CFG["new_value"]

    ext_code = f'''def patch_result(self):
    import traceback
    from AccessControl.SecurityManagement import newSecurityManager, getSecurityManager, setSecurityManager
    from AccessControl.SpecialUsers import system as system_user

    old_manager = getSecurityManager()
    try:
        from bika.lims import api as bapi

        portal = self.getSite() if hasattr(self, "getSite") else self.getPhysicalRoot()["senaite"]
        newSecurityManager(None, system_user)

        sample_path = "{sample_path}"
        analysis_keyword = "{analysis_kw}"
        new_result = "{new_value}"

        ar = portal.unrestrictedTraverse(sample_path)
        # Use objectValues instead of getAnalyses — catalog may be stale
        for obj in ar.objectValues():
            if obj.portal_type != "Analysis":
                continue
            if obj.getKeyword() == analysis_keyword:
                old_result = obj.getResult()
                obj.setResult(new_result)
                obj.reindexObject()
                import transaction
                transaction.commit()
                return "OK - %s result changed from %s to %s" % (obj.getId(), old_result, new_result)

        return "ERROR: analysis %s not found on %s" % (analysis_keyword, sample_path)
    except Exception as e:
        return "ERROR: " + str(e) + "\\n" + traceback.format_exc()
    finally:
        setSecurityManager(old_manager)
'''

    # Write file into container via stdin
    write_cmd = CFG["docker_cmd"] + [
        f"bash -c 'mkdir -p {EXT_DIR} && cat > {EXT_DIR}/{EXT_MODULE}.py'"
    ]
    # For local docker, the command is split differently
    if CFG["docker_cmd"][0] == "docker":
        write_cmd = CFG["docker_cmd"] + [
            "bash", "-c", f"mkdir -p {EXT_DIR} && cat > {EXT_DIR}/{EXT_MODULE}.py"
        ]

    proc = subprocess.run(
        write_cmd,
        input=ext_code.encode(),
        capture_output=True, timeout=30
    )
    if proc.returncode != 0:
        print(red(f"  Failed: {proc.stderr.decode()[:300]}"))
        sys.exit(1)

    # Verify file exists
    verify_cmd = CFG["docker_exec"] + ["ls", "-la", f"{EXT_DIR}/{EXT_MODULE}.py"]
    proc2 = subprocess.run(verify_cmd, capture_output=True, timeout=15)
    if proc2.returncode == 0:
        print(green(f"  Extension file written: {EXT_DIR}/{EXT_MODULE}.py"))
    else:
        print(red(f"  File verification failed: {proc2.stderr.decode()[:200]}"))
        sys.exit(1)


def step3_register_external_method():
    """Register the External Method in Zope via API."""
    print(bold("\n[Step 3] Registering External Method in Zope..."))

    r = requests.post(
        f"{CFG['site_base']}/manage_addProduct/ExternalMethod/manage_addExternalMethod",
        auth=AUTH,
        data={
            "id": EXT_ID,
            "title": "Patch Analysis Result",
            "module": EXT_MODULE,
            "function": EXT_MODULE,
            "submit": "Add",
        },
        timeout=15, allow_redirects=False
    )
    if r.status_code in (200, 302):
        print(green(f"  Registered: {EXT_ID} (status {r.status_code})"))
    else:
        print(red(f"  Failed to register: {r.status_code} — {r.text[:200]}"))
        sys.exit(1)


def step4_execute():
    """Execute the External Method."""
    print(bold("\n[Step 4] Executing External Method..."))

    r = requests.get(
        f"{CFG['site_base']}/{EXT_ID}",
        auth=AUTH,
        headers={"Accept": "text/plain"},
        timeout=60
    )
    output = r.text.strip()
    # Strip HTML wrapper if present
    if "<html" in output.lower():
        import re
        match = re.search(r"OK[^<]*", output)
        if match:
            output = match.group(0)
        else:
            match = re.search(r"ERROR[^<]*", output)
            if match:
                output = match.group(0)

    print(f"  Response: {output}")
    if "OK" in output:
        print(green("  Patch applied successfully."))
        return True
    else:
        print(red("  Patch may have failed — check response above."))
        return False


def step5_cleanup():
    """Remove External Method from Zope and extension file from disk."""
    print(bold("\n[Step 5] Cleaning up..."))

    # Remove from Zope
    r = requests.post(
        f"{CFG['site_base']}/manage_delObjects",
        auth=AUTH,
        data={"ids:list": EXT_ID},
        timeout=15
    )
    print(f"  Zope cleanup: {r.status_code}")

    # Remove extension file
    rm_cmd = CFG["docker_exec"] + ["rm", "-f", f"{EXT_DIR}/{EXT_MODULE}.py"]
    proc = subprocess.run(rm_cmd, capture_output=True, timeout=15)
    if proc.returncode == 0:
        print(green("  Extension file removed."))
    else:
        print(yellow(f"  Could not remove file: {proc.stderr.decode()[:200]}"))


def step6_verify():
    """Verify the result was updated via API (best-effort)."""
    sample_id = CFG["sample_id"]
    analysis_kw = CFG["analysis_kw"]
    new_value = CFG["new_value"]

    print(bold(f"\n[Step 6] Verifying new state of {sample_id}..."))

    try:
        data = api_get("Analysis", {
            "getRequestID": sample_id,
            "complete": "yes",
            "limit": 100,
        })
    except Exception as e:
        print(yellow(f"  API verification failed: {e}"))
        print(yellow(f"  Check manually: {CFG['site_base'].replace('/senaite','')}/senaite/{CFG['sample_path']}"))
        return

    analyses = data.get("items", [])
    if not analyses:
        print(yellow("  No analyses returned by API. Check the sample in the UI."))
        print(f"  URL: {CFG['site_base'].replace('/senaite','')}/senaite/{CFG['sample_path']}")
        return

    for a in analyses:
        title = a.get("title", "?")
        state = a.get("review_state", "?")
        result = a.get("Result", "")
        kw = a.get("Keyword") or a.get("getKeyword") or a.get("id")
        marker = ""
        if kw == analysis_kw and not a.get("retested"):
            if result == new_value:
                marker = green("  ✓ UPDATED")
            else:
                marker = red(f"  ✗ EXPECTED {new_value}")
        print(f"    {title} | result={result} | state={state}{marker}")


def main():
    global CFG, AUTH

    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--execute", action="store_true",
                        help="Actually patch the result (default is dry-run)")
    parser.add_argument("--local", action="store_true",
                        help="Use local SENAITE (localhost:8080) instead of production")
    args = parser.parse_args()

    CFG = ENVS["local"] if args.local else ENVS["prod"]
    AUTH = HTTPBasicAuth(CFG["username"], CFG["password"])

    env_label = "LOCAL" if args.local else "PRODUCTION"
    mode = "EXECUTE" if args.execute else "DRY RUN"
    sample_id = CFG["sample_id"]
    analysis_kw = CFG["analysis_kw"]
    old_value = CFG["old_value"]
    new_value = CFG["new_value"]

    print(bold("=" * 64))
    print(bold(f"  [{env_label}] Patch {analysis_kw} on {sample_id}"))
    print(bold(f"  Value: {old_value} -> {new_value}"))
    print(bold(f"  Mode: {mode}"))
    print(bold("=" * 64))

    # Step 1 always runs (read-only, best-effort)
    target = step1_verify_current_state()

    if not args.execute:
        print(bold("\n" + "=" * 64))
        print(yellow("  DRY RUN — no changes made."))
        flag = " --local" if args.local else ""
        print(f"  To patch: python {sys.argv[0]}{flag} --execute")
        print(bold("=" * 64))
        return

    print(bold(f"\n>>> PATCHING {analysis_kw}: {old_value} -> {new_value} <<<"))

    step2_write_extension()
    step3_register_external_method()
    success = step4_execute()
    step5_cleanup()

    if success:
        step6_verify()

    url = f"{CFG['site_base'].replace('/senaite','')}/senaite/{CFG['sample_path']}"
    print(bold("\n" + "=" * 64))
    if success:
        print(green(f"  Done. {analysis_kw} on {sample_id} patched to {new_value}."))
        print(f"  Verify in UI: {url}")
    else:
        print(red("  Patch may have failed. Check output above and verify manually."))
        print(f"  URL: {url}")
    print(bold("=" * 64))


if __name__ == "__main__":
    main()
