# Phase 5: SENAITE Sample Lookup - Research

**Researched:** 2026-02-20
**Domain:** SENAITE REST API integration, FastAPI httpx client, React tab UI, fuzzy matching
**Confidence:** HIGH (all findings from direct codebase inspection)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Search Trigger & Flow**
- Search field + "Look up" button — deliberate trigger, not as-you-type
- On success: display a read-only summary card (matching how step 1 already behaves after session creation)
- Target conc/vol fields appear below/after the summary card — tech still enters these manually
- Backend hits SENAITE REST API directly via httpx (`http://senaite:8080/senaite/@@API/senaite/v1/AnalysisRequest?id={id}&complete=yes`)
- Auth via HTTP Basic (SENAITE_USER / SENAITE_PASSWORD env vars)

**Manual Entry Fallback**
- Always visible — toggle between "SENAITE Lookup" and "Manual Entry" tabs/buttons in step 1
- Tech can choose manual from the start without attempting a search
- If tech switches to manual after a successful lookup: clear everything, start fresh (no pre-fill from lookup data)

**Error & Unavailability States**
- Differentiate errors with distinct messages:
  - Sample not found (SENAITE returned 0 results): "Sample [ID] not found in SENAITE"
  - SENAITE unreachable / timeout / 5xx: "SENAITE is currently unavailable — use manual entry"
- No background connectivity check on wizard load — errors appear only when "Look up" is clicked

**Blend Samples (Multi-Analyte)**
- SENAITE samples can have up to 4 analytes (Analyte1Peptide through Analyte4Peptide)
- Pull all non-null analyte fields and display all analyte names in the summary card
- For each analyte: attempt fuzzy match to local peptides table
- Physical prep process (stock prep, dilution) is unchanged — still one vial
- Step 4 (peak area / HPLC results) stays single-peak for now

**Field Mapping**
- Sample ID: `id` field (e.g., `P-0112`) — used as-is for `sample_id_label` in the session
- Declared weight: `DeclaredTotalQuantity` — decimal string (e.g., `"123.00"`), convert to float
  - If null/empty: leave declared_weight_mg blank for tech to fill in manually
- Peptide name(s): `Analyte1Peptide` through `Analyte4Peptide`, each formatted as `"BPC-157 - Identity (HPLC)"`
  - Strip trailing ` - Identity (HPLC)` and similar ` - [method]` suffixes
  - Attempt case-insensitive fuzzy match against local `peptides.name` column
  - If matched: auto-select the local peptide (populates `peptide_id` in session creation)
  - If no match: display the raw SENAITE name as informational text, tech selects from local dropdown
- `Analyte1DeclaredQuantity` is always null — do NOT use this field

**SENAITE Configuration**
- `SENAITE_URL` env var — base URL (default: `http://senaite:8080`)
- `SENAITE_USER` / `SENAITE_PASSWORD` env vars — Basic auth credentials
- If `SENAITE_URL` not set: Lookup tab is hidden or disabled; step 1 shows manual form directly

### Claude's Discretion
- Exact fuzzy matching algorithm (e.g., startswith, contains, or Levenshtein distance)
- Styling/layout of the two-tab / toggle UI in step 1
- Loading spinner behavior during SENAITE fetch
- How blend analytes are displayed in the summary card (list vs. inline)
- SENAITE timeout value

### Deferred Ideas (OUT OF SCOPE)
- Multi-peak results handling for blend samples (Step 4 HPLC results with one peak area per analyte)
- Real-time SENAITE status indicator on wizard load
</user_constraints>

---

## Summary

This phase extends `Step1SampleInfo.tsx` with a SENAITE lookup flow. The backend gains a new `/wizard/senaite/lookup` endpoint that calls the SENAITE REST API via httpx (already installed). The frontend gains a two-tab UI using the existing shadcn Tabs component — one tab for SENAITE lookup, one for manual entry. Session creation is unchanged: the lookup pre-fills the form fields, and the tech then creates the session as normal.

The key insight is that the lookup is a **pre-fill mechanism**, not a new session creation path. The lookup result populates `peptideId`, `sampleIdLabel`, and `declaredWeightMg` local state in the component; the existing `createWizardSession` call is unchanged. This minimises scope and risk.

The current wizard session model supports only a single `peptide_id`. For blend samples with multiple analytes, the phase resolves to: auto-select the first matched analyte, display all raw analyte names in the summary card, and let the tech confirm or override the peptide dropdown selection. Multi-peptide session support is deferred.

**Primary recommendation:** Keep session creation unchanged. Lookup is UI-only pre-fill. New backend endpoint `/wizard/senaite/lookup?id={id}` returns a normalised response consumed by the frontend.

---

## Standard Stack

### Already Installed / Available

| Component | Version / Location | Purpose | Status |
|-----------|-------------------|---------|--------|
| `httpx` | `>=0.27.0` in `requirements.txt` | Async HTTP client for SENAITE calls | Already installed |
| shadcn `Tabs` | `src/components/ui/tabs.tsx` | Two-tab toggle UI | Already present |
| `Loader2` from lucide-react | Used in Step1SampleInfo.tsx | Loading spinner | Already imported |
| `Alert / AlertDescription` | Used in Step1SampleInfo.tsx | Error display | Already imported |

### No New Dependencies Required

httpx is already installed (`requirements.txt` line 12: `httpx>=0.27.0`) and actively used for the Integration Service proxy pattern. No new Python packages needed.

No new frontend packages needed. Tabs, Button, Input, Label, Alert, Loader2 are all already in use in Step1SampleInfo.tsx and adjacent files.

---

## Architecture Patterns

### Existing httpx Pattern (Integration Service Proxy)

The codebase already uses httpx for outbound HTTP calls. The established pattern from `main.py` lines 3981–3993:

```python
# Source: backend/main.py lines 3981-3993
import httpx

INTEGRATION_SERVICE_URL = os.environ.get("INTEGRATION_SERVICE_URL", "http://host.docker.internal:8000")

async def _proxy_explorer_get(path: str) -> list[dict]:
    """Proxy a GET request to the Integration Service explorer API."""
    url = f"{INTEGRATION_SERVICE_URL}/explorer{path}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers={"X-API-Key": INTEGRATION_SERVICE_API_KEY})
        resp.raise_for_status()
        return resp.json()
```

Error handling pattern (lines 4001-4004):
```python
except httpx.HTTPStatusError as e:
    raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
except Exception as e:
    raise HTTPException(status_code=503, detail=f"Integration Service unavailable: {e}")
```

### Existing Env Var Pattern (SCALE_HOST)

The SCALE_HOST pattern is the correct precedent for SENAITE_URL. From `main.py` lines 292-300:

```python
# Source: backend/main.py lines 292-300
scale_host = os.environ.get("SCALE_HOST")
scale_port = int(os.environ.get("SCALE_PORT", str(SCALE_PORT_DEFAULT)))
if scale_host:
    app.state.scale_bridge = ScaleBridge(host=scale_host, port=scale_port)
    ...
    _logger.info(f"ScaleBridge started: {scale_host}:{scale_port}")
else:
    app.state.scale_bridge = None
    _logger.info("SCALE_HOST not set — scale bridge disabled (manual-entry mode)")
```

For SENAITE, the pattern translates to module-level constants (no `app.state` needed since SENAITE is stateless per-request):

```python
# New pattern for SENAITE
SENAITE_URL = os.environ.get("SENAITE_URL")   # None if not set
SENAITE_USER = os.environ.get("SENAITE_USER", "")
SENAITE_PASSWORD = os.environ.get("SENAITE_PASSWORD", "")
```

The frontend needs to know if SENAITE is configured to decide whether to show the Lookup tab. Use a `/wizard/senaite/config` or `/wizard/senaite/lookup` 503 response. Simpler: expose a `GET /wizard/senaite/status` endpoint that returns `{"enabled": bool}`, called once on wizard load.

### Existing Tabs Pattern (AnalysisHistory.tsx)

The codebase already uses Tabs in `AnalysisHistory.tsx` (lines 106-297):

```tsx
// Source: src/components/hplc/AnalysisHistory.tsx lines 106-110
<Tabs defaultValue="hplc-import">
  <TabsList>
    <TabsTrigger value="hplc-import">HPLC Import</TabsTrigger>
    <TabsTrigger value="wizard-sessions">Sample Prep Wizard</TabsTrigger>
  </TabsList>
  ...
</Tabs>
```

The import is: `import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'`

The tabs component supports `defaultValue` for uncontrolled usage. For this phase, use **controlled** tabs (`value` + `onValueChange`) so the component can react to tab switches (clearing state when switching to Manual Entry).

### Existing Step1 Read-Only Summary Card Pattern

The existing summary card (Step1SampleInfo.tsx lines 76-140) uses this structure:

```tsx
// Source: src/components/hplc/wizard/steps/Step1SampleInfo.tsx lines 76-140
<Card>
  <CardHeader><CardTitle>Sample Information</CardTitle></CardHeader>
  <CardContent className="space-y-4">
    <div className="rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-muted-foreground">Peptide</span>
          <p className="font-medium">{...}</p>
        </div>
        ...
      </div>
    </div>
  </CardContent>
</Card>
```

The SENAITE lookup result card should use the same visual treatment (green border/bg, grid layout, text-sm, muted labels) for consistency.

### New Backend Endpoint Design

```python
# New endpoint: GET /wizard/senaite/lookup?id={sample_id}
# Returns normalised SENAITE data, NOT a wizard session
class SenaiteLookupResult(BaseModel):
    sample_id: str
    declared_weight_mg: Optional[float]
    analytes: list[SenaiteAnalyte]   # 1-4 items

class SenaiteAnalyte(BaseModel):
    raw_name: str                    # Stripped of " - Identity (HPLC)" suffix
    matched_peptide_id: Optional[int]
    matched_peptide_name: Optional[str]

# Also: GET /wizard/senaite/status
class SenaiteStatusResponse(BaseModel):
    enabled: bool
```

### Recommended Project Structure Changes

```
backend/
├── main.py              # Add SENAITE_URL/USER/PASSWORD constants + 2 new endpoints
backend/.env.example     # Add SENAITE_URL, SENAITE_USER, SENAITE_PASSWORD section

src/components/hplc/wizard/steps/
├── Step1SampleInfo.tsx  # Replace with two-tab version (lookup + manual)
src/lib/api.ts           # Add lookupSenaiteSample() and getSenaiteStatus() functions
```

### Anti-Patterns to Avoid

- **Do not** create a new session creation path for SENAITE. The lookup pre-fills local state; `createWizardSession` is called with the same signature.
- **Do not** add SENAITE data to `WizardSession` model. The session only stores `sample_id_label`, `declared_weight_mg`, `peptide_id` — same as manual entry.
- **Do not** call SENAITE from the frontend directly. All outbound calls go through the backend (CORS, credential security, network topology).
- **Do not** use `useEffect` with a dependency on the sample ID input for auto-search. Search is deliberate (button click only).
- **Do not** pre-fill manual form from lookup data when tech switches tabs. Decision: clear everything on tab switch to manual.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Async HTTP to SENAITE | Custom urllib/requests wrapper | `httpx.AsyncClient` | Already installed, async-native, has timeout support |
| Tab UI toggle | Custom button-group with useState | shadcn `Tabs` | Already in codebase, accessible, consistent styling |
| Loading spinner | Custom CSS animation | `Loader2` from lucide-react | Already imported in Step1SampleInfo.tsx |
| HTTP Basic auth | Manual header construction | `httpx.BasicAuth` | Built-in httpx auth parameter |
| Fuzzy string match | Levenshtein library | Simple Python `lower()` + `in` containment | See Fuzzy Matching section below |

---

## Common Pitfalls

### Pitfall 1: TypeScript Narrowing Lost Across Async Closures

**What goes wrong:** `session` from `useWizardStore` loses type narrowing after an `await` in the same handler.
**Why it happens:** Prior art in the project: `const sessionId = session.id` captured before async handlers in existing steps.
**How to avoid:** Capture all needed values from store before the first `await`.
**Warning signs:** TypeScript error "Object is possibly null" after an await.

### Pitfall 2: SENAITE Returns Empty `items` Array (Not 404)

**What goes wrong:** Treating HTTP 200 with `{"count": 0, "items": []}` the same as a network error.
**Why it happens:** SENAITE REST API returns 200 with empty results for unknown IDs — it does not return 404.
**How to avoid:** Check `response_json["count"] == 0` or `len(items) == 0` to trigger "not found" error message.
**Warning signs:** No error shown to tech even though sample doesn't exist.

### Pitfall 3: SENAITE Timeout Blocking the UI

**What goes wrong:** httpx waits indefinitely if SENAITE is reachable but slow, blocking the FastAPI response.
**Why it happens:** Default httpx timeout is 5 seconds but needs to be explicitly set for connect vs. read.
**How to avoid:** Use `httpx.Timeout(connect=5.0, read=10.0)` — connect timeout catches unreachable host fast; read timeout handles slow responses.
**Warning signs:** Tech waits >10 seconds with no feedback.

### Pitfall 4: Analyte Name Suffix Variations

**What goes wrong:** Stripping only `" - Identity (HPLC)"` misses other method suffixes on future samples.
**Why it happens:** SENAITE field format is `"BPC-157 - Identity (HPLC)"` but suffix could vary.
**How to avoid:** Use regex `re.sub(r'\s*-\s*[^-]+\([^)]+\)\s*$', '', name).strip()` to strip any ` - Method (Type)` suffix.
**Warning signs:** Fuzzy match fails on samples with different method suffixes.

### Pitfall 5: Zustand Destructuring Anti-Pattern

**What goes wrong:** `const { session } = useWizardStore()` causes render cascades.
**Why it happens:** Project architecture rule — Zustand destructuring is caught by ast-grep.
**How to avoid:** Always use selector syntax: `const session = useWizardStore(state => state.session)`.
**Warning signs:** ast-grep lint failure in `npm run check:all`.

### Pitfall 6: Multi-Analyte Blend — Which Peptide ID to Pass to createWizardSession

**What goes wrong:** For blend samples (2-4 analytes), the session only accepts one `peptide_id`.
**Why it happens:** WizardSession model has a single `peptide_id` FK (not a list).
**How to avoid:** Auto-select first matched analyte's `peptide_id`. Display all analyte names in the summary card. Tech can override with the dropdown if needed. Document that multi-peptide support is deferred.
**Warning signs:** Attempting to change the session schema to support multiple peptide IDs.

---

## Code Examples

### SENAITE API Call (httpx with Basic Auth)

```python
# Backend: SENAITE lookup implementation
import httpx
import re
from typing import Optional

SENAITE_URL = os.environ.get("SENAITE_URL")
SENAITE_USER = os.environ.get("SENAITE_USER", "")
SENAITE_PASSWORD = os.environ.get("SENAITE_PASSWORD", "")
SENAITE_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0)

async def _fetch_senaite_sample(sample_id: str) -> dict:
    """Fetch raw SENAITE AnalysisRequest data by ID."""
    url = f"{SENAITE_URL}/senaite/@@API/senaite/v1/AnalysisRequest"
    params = {"id": sample_id, "complete": "yes"}
    auth = httpx.BasicAuth(SENAITE_USER, SENAITE_PASSWORD)
    async with httpx.AsyncClient(timeout=SENAITE_TIMEOUT, auth=auth) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()
```

### Analyte Name Stripping

```python
# Strip " - Identity (HPLC)" and similar " - Method (Type)" suffixes
def _strip_method_suffix(name: str) -> str:
    """Strip ' - Method (Type)' suffix from SENAITE analyte names."""
    return re.sub(r'\s*-\s*[^-]+\([^)]+\)\s*$', '', name).strip()

# Examples:
# "BPC-157 - Identity (HPLC)"  ->  "BPC-157"
# "AOD-9604 - Purity (UV)"     ->  "AOD-9604"
```

### Fuzzy Peptide Matching (Recommended: contains, case-insensitive)

```python
# Backend: match stripped analyte name against local peptides
def _fuzzy_match_peptide(
    stripped_name: str,
    peptides: list[Peptide]
) -> Optional[Peptide]:
    """
    Case-insensitive substring match: stripped_name in peptide.name.
    Simple and sufficient for lab context. No Levenshtein needed.
    """
    needle = stripped_name.lower()
    for p in peptides:
        if needle in p.name.lower():
            return p
    return None
```

**Rationale for contains-match:** SENAITE analyte names like `"BPC-157"` will match peptide names like `"BPC-157"` or `"BPC-157 Acetate"`. This is sufficient for the lab's controlled peptide vocabulary. Levenshtein distance adds complexity without meaningful benefit when the vocabulary is small and controlled.

### Frontend: Two-Tab Structure in Step1SampleInfo

```tsx
// Controlled tabs so we can react to tab switches
const [activeTab, setActiveTab] = useState<'lookup' | 'manual'>(
  senaiteEnabled ? 'lookup' : 'manual'
)

function handleTabChange(tab: string) {
  // Clear all pre-filled state when switching to manual
  if (tab === 'manual') {
    setPeptideId(null)
    setSampleIdLabel('')
    setDeclaredWeightMg('')
    setSenaiteResult(null)
    setLookupError(null)
  }
  setActiveTab(tab as 'lookup' | 'manual')
}

return (
  <Card>
    <CardHeader><CardTitle>Sample Information</CardTitle></CardHeader>
    <CardContent>
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          {senaiteEnabled && (
            <TabsTrigger value="lookup">SENAITE Lookup</TabsTrigger>
          )}
          <TabsTrigger value="manual">Manual Entry</TabsTrigger>
        </TabsList>

        <TabsContent value="lookup">
          {/* Search field + Look Up button */}
          {/* On success: read-only summary card */}
          {/* Target conc/vol fields below the card */}
        </TabsContent>

        <TabsContent value="manual">
          {/* Existing form content unchanged */}
        </TabsContent>
      </Tabs>
    </CardContent>
  </Card>
)
```

### Frontend: lookupSenaiteSample in api.ts

```typescript
// src/lib/api.ts additions

export interface SenaiteAnalyte {
  raw_name: string
  matched_peptide_id: number | null
  matched_peptide_name: string | null
}

export interface SenaiteLookupResult {
  sample_id: string
  declared_weight_mg: number | null
  analytes: SenaiteAnalyte[]
}

export interface SenaiteStatusResponse {
  enabled: boolean
}

export async function getSenaiteStatus(): Promise<SenaiteStatusResponse> {
  const response = await fetch(`${API_BASE_URL()}/wizard/senaite/status`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`SENAITE status check failed: ${response.status}`)
  return response.json()
}

export async function lookupSenaiteSample(
  sampleId: string
): Promise<SenaiteLookupResult> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/lookup?id=${encodeURIComponent(sampleId)}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `SENAITE lookup failed: ${response.status}`)
  }
  return response.json()
}
```

### Backend: Error Differentiation

```python
@app.get("/wizard/senaite/lookup")
async def senaite_lookup(
    id: str,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    if not SENAITE_URL:
        raise HTTPException(status_code=503, detail="SENAITE not configured")
    try:
        data = await _fetch_senaite_sample(id)
        if data.get("count", 0) == 0:
            raise HTTPException(
                status_code=404,
                detail=f"Sample {id} not found in SENAITE"
            )
        item = data["items"][0]
        # ... parse and return SenaiteLookupResult
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=503,
            detail="SENAITE is currently unavailable — use manual entry"
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=503,
            detail="SENAITE is currently unavailable — use manual entry"
        )
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail="SENAITE is currently unavailable — use manual entry"
        )
```

**Frontend error mapping:** HTTP 404 from backend → "Sample [ID] not found in SENAITE". HTTP 503 from backend → display the detail string directly (it's already user-readable).

---

## SENAITE API: Confirmed Structure

**Endpoint:** `GET {SENAITE_URL}/senaite/@@API/senaite/v1/AnalysisRequest?id={id}&complete=yes`
**Auth:** HTTP Basic
**Success response structure (confirmed from test samples):**

```json
{
  "count": 1,
  "items": [
    {
      "id": "P-0112",
      "DeclaredTotalQuantity": "123.00",
      "Analyte1Peptide": "BPC-157 - Identity (HPLC)",
      "Analyte2Peptide": null,
      "Analyte3Peptide": null,
      "Analyte4Peptide": null,
      "Analyte1DeclaredQuantity": null
    }
  ]
}
```

**Fields to extract:**

| SENAITE field | Maps to | Notes |
|--------------|---------|-------|
| `id` | `sample_id_label` | Use as-is, e.g. `"P-0112"` |
| `DeclaredTotalQuantity` | `declared_weight_mg` | String → float. Null/empty → leave blank |
| `Analyte1Peptide` | analyte names[0] | Strip ` - Identity (HPLC)` suffix |
| `Analyte2Peptide` | analyte names[1] | Null → skip |
| `Analyte3Peptide` | analyte names[2] | Null → skip |
| `Analyte4Peptide` | analyte names[3] | Null → skip |
| `Analyte1DeclaredQuantity` | (ignored) | Always null per decision |

**Empty result (sample not found):**
```json
{"count": 0, "items": []}
```

---

## Session Creation: What Changes

**The session creation path is unchanged.** The SENAITE lookup pre-fills local form state. Tech still clicks "Create Session" which calls `createWizardSession` with the same signature:

```typescript
// api.ts signature (unchanged)
createWizardSession({
  peptide_id: number,
  sample_id_label?: string,
  declared_weight_mg?: number,
  target_conc_ug_ml?: number,
  target_total_vol_ul?: number,
})
```

**What changes in the UI flow (lookup tab):**

1. Tech types sample ID → clicks "Look Up"
2. Backend returns `SenaiteLookupResult`
3. Frontend sets local state: `peptideId` = first matched peptide ID (or null), `sampleIdLabel` = SENAITE `id`, `declaredWeightMg` = parsed DeclaredTotalQuantity
4. A read-only summary card appears showing all analyte names (informational)
5. If peptide not matched: peptide dropdown remains empty, tech selects manually
6. Target conc/vol fields appear below the summary card (same as manual flow)
7. Tech clicks "Create Session" — same handler, same API call

**For blend samples:** The summary card lists all analyte names. The `peptide_id` passed to session creation is the first matched analyte (or the first SENAITE analyte if none match). This is a UX simplification — multi-peptide session support is deferred.

---

## Env Var Pattern

Follow the SCALE_HOST precedent exactly. Module-level constants at top of the relevant section in `main.py`:

```python
# New section in main.py (near the Integration Service section)
# ── SENAITE Integration ────────────────────────────────────────────
SENAITE_URL = os.environ.get("SENAITE_URL")          # None = disabled
SENAITE_USER = os.environ.get("SENAITE_USER", "")
SENAITE_PASSWORD = os.environ.get("SENAITE_PASSWORD", "")
```

Add to `.env.example`:
```
# ============================================================
# SENAITE LIMS Integration
# ============================================================
# Set SENAITE_URL to enable sample lookup in the wizard.
# Leave commented out to disable the SENAITE Lookup tab entirely.
# Docker network: http://senaite:8080
# SENAITE_URL=http://senaite:8080
# SENAITE_USER=admin
# SENAITE_PASSWORD=your_senaite_password
```

The `/wizard/senaite/status` endpoint reads `SENAITE_URL` at request time (no app.state needed — it's stateless). Frontend calls this once on wizard mount to decide whether to show the Lookup tab.

---

## Frontend Tab Visibility Logic

The `senaiteEnabled` flag drives conditional rendering:

```tsx
// Called once on mount (similar to loadPeptides pattern already in Step1)
const [senaiteEnabled, setSenaiteEnabled] = useState(false)
const [checkingStatus, setCheckingStatus] = useState(true)

useEffect(() => {
  getSenaiteStatus()
    .then(r => setSenaiteEnabled(r.enabled))
    .catch(() => setSenaiteEnabled(false))
    .finally(() => setCheckingStatus(false))
}, [])
```

If `SENAITE_URL` is not set: status returns `{"enabled": false}`, Lookup tab is hidden, component defaults to Manual Entry tab only.

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Manual-only Step 1 | Two-tab Step 1 (SENAITE lookup + manual) | Tech can auto-populate from LIMS |
| Single analyte assumed | Up to 4 analytes displayed | Correct for blend samples |

---

## Open Questions

1. **SENAITE `items[0]` field name for `id`**
   - What we know: Test samples use `id` field (e.g., `P-0112`). The endpoint query param is also `id`.
   - What's unclear: Whether `id` in the response JSON is the sample code or SENAITE's internal UUID.
   - Recommendation: If `id` returns the internal UUID, use `getTextContent` or `getId` field instead. Planner should add a task to verify against actual SENAITE response for P-0112.

2. **SENAITE status endpoint caching**
   - What we know: Status is checked once on wizard mount.
   - What's unclear: Whether the status should be re-checked on each wizard open or cached at app level.
   - Recommendation: Check on each wizard mount (same pattern as peptides load). Simple and avoids stale state.

3. **Peptide dropdown when analyte matches but tech wants to override**
   - What we know: On match, `peptideId` is set to the matched ID and the Select shows that value.
   - What's unclear: Should the dropdown be editable after a successful lookup (to let tech correct a wrong match)?
   - Recommendation: Yes — keep the peptide Select editable in all cases in the lookup tab form section. Only the top summary card is read-only.

---

## Sources

### Primary (HIGH confidence)
- Direct inspection of `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` — full component structure
- Direct inspection of `backend/main.py` — httpx pattern, env var pattern, wizard session endpoints
- Direct inspection of `backend/requirements.txt` — httpx already installed
- Direct inspection of `backend/models.py` — WizardSession and Peptide model columns
- Direct inspection of `src/lib/api.ts` — createWizardSession signature, WizardSessionResponse type
- Direct inspection of `src/store/wizard-store.ts` — store actions and Zustand pattern
- Direct inspection of `src/components/ui/tabs.tsx` — Tabs component API
- Direct inspection of `src/components/hplc/AnalysisHistory.tsx` — live Tabs usage pattern
- Direct inspection of `backend/.env.example` — env var comment style and structure

### Secondary (MEDIUM confidence)
- SENAITE API endpoint structure from phase context `<specifics>` section — confirmed working endpoint, test samples, field names

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries confirmed present in codebase
- Architecture: HIGH — follows established httpx and env var patterns already in main.py
- Pitfalls: HIGH — TypeScript narrowing and Zustand anti-patterns are documented project rules
- SENAITE API structure: MEDIUM — endpoint confirmed working per context, field names from context (not personally verified against live API)
- Fuzzy matching: HIGH — simple contains-match is sufficient and verifiable

**Research date:** 2026-02-20
**Valid until:** 2026-03-20 (stable codebase — no fast-moving dependencies)
