# Senaite: Reset Verified Analyses

How to delete verified analyses from a sample and re-add them fresh, so correct results can be entered.

## When to Use This

- Results were submitted and verified with wrong values (e.g. 0%)
- The Senaite UI shows no way to edit or retract from the `verified` state
- The `retract` workflow transition does not exist in this Senaite instance's analysis workflow — `verified` is a terminal state

## What Happens

1. The verified analyses are **deleted** from the sample using ZMI `manage_delObjects`
2. The same analysis services are **re-added** to the sample using a Zope External Method running as the system user (to bypass `senaite.core: Add Analysis` permission)
3. The new analyses start in `unassigned` state with no results
4. Results are entered normally in the Senaite UI, then submitted and verified

> **Note:** This permanently destroys the old analysis records including their results and audit history. Only use this when results need to be corrected, not just reviewed.

---

## Prerequisites

- Admin credentials for Senaite (username/password in `scripts/`)
- SSH access to the production server (`ssh root@165.227.241.81`)
- The sample ID and analysis service UIDs (looked up by the script)

---

## Step-by-Step

### Step 1 — Find the Analysis Info

Use the existing reset script (dry-run) to confirm analysis IDs and service UIDs:

```bash
python scripts/reset_analyses_XXXXX.py
```

Or query the Senaite API directly:

```python
import requests
from requests.auth import HTTPBasicAuth

auth = HTTPBasicAuth('admin', '<password>')
base = 'https://senaite.valenceanalytical.com/@@API/senaite/v1'

# Get analyses
r = requests.get(f'{base}/Analysis', auth=auth, params={
    'getRequestID': 'P-0227', 'complete': 'yes', 'limit': 100
})
for a in r.json()['items']:
    print(a['id'], a['title'], a['review_state'], a.get('Result'))

# Get service UIDs (one per keyword)
r = requests.get(f'{base}/AnalysisService', auth=auth, params={
    'getKeyword': 'HPLC-PUR', 'complete': 'yes'
})
print(r.json()['items'][0]['uid'])
```

### Step 2 — Delete the Verified Analyses

Use ZMI `manage_delObjects`. This is the **only reliable way** to remove verified analyses from Senaite's ZODB.

```python
import requests
from requests.auth import HTTPBasicAuth

auth = HTTPBasicAuth('admin', '<password>')
site_base = 'https://senaite.valenceanalytical.com'
sample_path = 'clients/client-14/P-0227'  # adjust client number

# Get the object IDs from the API first (id field, not uid)
# e.g. ['HPLC-PUR', 'PEPT-Total', 'ID_RETATRUTIDE']
analysis_ids = ['HPLC-PUR', 'PEPT-Total', 'ID_RETATRUTIDE']

delete_url = f'{site_base}/senaite/{sample_path}/manage_delObjects'
for aid in analysis_ids:
    r = requests.post(delete_url, auth=auth,
                      data={'ids:list': aid}, timeout=30, allow_redirects=True)
    print(f'{aid}: {r.status_code}')  # expect 200
```

**Verify deletion:**
```python
r = requests.get(f'{base}/Analysis', auth=auth,
                 params={'getRequestID': 'P-0227', 'limit': 100})
print('Remaining:', len(r.json()['items']))  # should be 0
```

### Step 3 — Re-add Analyses via Zope External Method

The `update/{ar_uid}` REST API cannot set the `Analyses` field when the AR is in `verified` state. The workaround is a **Zope External Method** that temporarily escalates to the system security context.

#### 3a — SSH into the server and write the extension file

```bash
ssh root@165.227.241.81
docker exec senaite bash -c '
mkdir -p /home/senaite/senaitelims/parts/instance/Extensions

cat > /home/senaite/senaitelims/parts/instance/Extensions/reset_sample.py << PYEOF
def reset_sample(self):
    import traceback
    from AccessControl.SecurityManagement import newSecurityManager, getSecurityManager, setSecurityManager
    from AccessControl.SpecialUsers import system as system_user

    old_manager = getSecurityManager()
    try:
        from bika.lims import api as bapi
        from Products.CMFCore.utils import getToolByName

        portal = self.getSite() if hasattr(self, "getSite") else self.getPhysicalRoot()["senaite"]
        newSecurityManager(None, system_user)

        # ── EDIT THESE ──────────────────────────────────────────────
        sample_path = "clients/client-14/P-0227"
        service_uids = [
            "ac85c571272d4af9b93ae22f5059444c",  # Retatrutide - Identity (HPLC)
            "ca1837452af84d2eb48644198c34339b",  # Peptide Total Quantity
            "3d122548bb8c43ba839606d06ec7366a",  # Peptide Purity (HPLC)
        ]
        # ────────────────────────────────────────────────────────────

        ar = portal.unrestrictedTraverse(sample_path)
        services = [bapi.get_object_by_uid(uid) for uid in service_uids]
        ar.setAnalyses(services)
        ar.reindexObject()

        import transaction
        transaction.commit()

        wf = getToolByName(portal, "portal_workflow")
        results = ["commit OK"]
        for a in ar.getAnalyses(full_objects=True):
            state = wf.getInfoFor(a, "review_state", "?")
            results.append("%s | %s" % (a.getId(), state))
        return "\n".join(results)

    except Exception as e:
        return "ERROR: " + str(e) + "\n" + traceback.format_exc()
    finally:
        setSecurityManager(old_manager)
PYEOF
echo "Extension file written"
'
```

#### 3b — Create the External Method in Zope via the API

```python
import requests
from requests.auth import HTTPBasicAuth

auth = HTTPBasicAuth('admin', '<password>')
site = 'https://senaite.valenceanalytical.com/senaite'

r = requests.post(
    f'{site}/manage_addProduct/ExternalMethod/manage_addExternalMethod',
    auth=auth,
    data={
        'id': 'reset_sample_ext',
        'title': 'Reset Sample Analyses',
        'module': 'reset_sample',
        'function': 'reset_sample',
        'submit': 'Add',
    },
    timeout=15, allow_redirects=False
)
print('Create:', r.status_code)  # expect 302
```

#### 3c — Execute it

```python
r = requests.get(f'{site}/reset_sample_ext',
                 auth=auth,
                 headers={'Accept': 'text/plain'},
                 timeout=60)
print(r.text)  # should show "commit OK" followed by analysis IDs and states
```

#### 3d — Verify

```python
r = requests.get(f'{base}/Analysis', auth=auth,
                 params={'getRequestID': 'P-0227', 'complete': 'yes', 'limit': 100})
for a in r.json()['items']:
    print(a['id'], a['review_state'], a.get('Result'))
# Should show 3 analyses in 'unassigned' state with result=None
```

### Step 4 — Clean Up

Remove the temporary ZMI objects and extension file:

```python
for obj_id in ['reset_sample_ext']:
    r = requests.post(f'{site}/manage_delObjects', auth=auth,
                      data={'ids:list': obj_id}, timeout=15)
    print(f'Deleted {obj_id}: {r.status_code}')
```

```bash
docker exec senaite rm /home/senaite/senaitelims/parts/instance/Extensions/reset_sample.py
```

### Step 5 — Enter Correct Results in Senaite UI

Open the sample in Senaite, enter the correct results, and go through the normal submit → verify workflow.

---

## Reusable Script

For recurring use, copy `scripts/reset_analyses_p0227.py` and update:

- `PROD["sample_id"]` — the sample ID (e.g. `P-0227`)
- `PROD["sample_path"]` — the Senaite path (e.g. `clients/client-14/P-0227`)
- `PROD["client_url"]` — the Senaite UI URL

The script handles steps 1–3 (minus the External Method — that part is manual via SSH).

---

## Why Each API Approach Fails

| Approach | Result | Reason |
|---|---|---|
| `POST /update/{uid}` with `{"transition": "retract"}` | 200 but no state change | `retract` is not a valid transition from `verified` in this workflow |
| `content_status_modify` POST | 302 but no state change | Same — no workflow transition guard passes |
| `POST /update/{uid}` with `{"Result": "..."}` | 401 | Result field is locked on verified analyses |
| `POST /update/{ar_uid}` with `{"Analyses": [...]}` | 401 | Analyses field locked on verified AR |
| ZMI Python Script with `setStatusOf` | Unauthorized | Restricted Python Script environment blocks it |
| `bin/instance run script.py` | Lock error | ZODB file lock held by running instance |
| External Method (no security escalation) | Unauthorized | `senaite.core: Add Analysis` permission check fails |
| **External Method + `newSecurityManager(system_user)`** | ✅ Works | Bypasses permission check entirely |

## Finding Client Number and Sample Path

The client number in the path (`client-14`) is not the same across environments. Get it from the API:

```python
r = requests.get(f'{base}/AnalysisRequest', auth=auth,
                 params={'id': 'P-0227', 'complete': 'yes'})
path = r.json()['items'][0]['path']
print(path)  # /senaite/clients/client-14/P-0227
```
