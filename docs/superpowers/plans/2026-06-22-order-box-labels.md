# Order Box Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Print Order #" button to the Receive Wizard's Print Labels tab that prints one box label per department (HPLC/ENDO/PCR) showing the order's expected per-department vial count + order date.

**Architecture:** New Mk1 backend endpoint aggregates per-department vial demand for a whole order by reading the integration DB's `order_submissions` row and running each sample through the existing `derive_base_demand`. The Print Labels tab gets a second print button + a separate box-label render with print isolation. All in Accu-Mk1 — no integration-service change.

**Tech Stack:** FastAPI/SQLAlchemy + raw psycopg2 (`get_integration_db`) backend; React/TS frontend; pytest (in-container); HTML/CSS `window.print()` to the CAB Mach 4S (2"×¼" media).

Spec: `docs/superpowers/specs/2026-06-22-order-box-labels-design.md`.

## Global Constraints

- **Count = expected VIALS per department, summed across the whole order, from what was ORDERED.** `derive_base_demand` returns `{hplc:0/1, endo:0/1, ster:0/2}` per sample (Sterility = 2 vials/sample). Sum across the order's samples.
- **No QR** on the box label (deferred). Departments with count 0 emit **no** label.
- **Label media:** 2"×¼" = 50.8mm × 6.35mm (same `@page` as the vial label).
- **Release:** Mk1 backend+frontend → version bump **1.0.2 → 1.0.3** (`package.json` + `src-tauri/tauri.conf.json` + `CHANGELOG.md`); deploy both together; health check confirms 1.0.3. Not frontend-only.
- **Additive only.** Tests run in-container: `docker exec accu-mk1-backend python -m pytest …`. Commit each task atomically with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Branch `subsample-features` (the deployed line). Department display names: HPLC→"HPLC", endo→"ENDO", ster→"PCR" (mirror `ROLE_SHORT` in LabelTemplate.tsx).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/main.py` | new `GET /orders/{order_number}/box-label-summary` endpoint | Modify (add route + response model) |
| `backend/tests/test_order_box_label_summary.py` | endpoint unit tests (stubbed DB + services) | Create |
| `src/lib/api.ts` | `getOrderBoxLabelSummary()` wrapper + response type | Modify |
| `src/components/intake/ReceiveWizard/OrderLabelTemplate.tsx` | box-label markup | Create |
| `src/components/intake/ReceiveWizard/PrintStep.tsx` | "Print Order #" button + fetch + print-mode isolation | Modify |
| `src/components/intake/ReceiveWizard/PrintStep.css` | `.order-label` styles (screen + print) | Modify |
| `package.json`, `src-tauri/tauri.conf.json`, `CHANGELOG.md` | version 1.0.3 | Modify |

---

## Task 1: Backend — order box-label summary endpoint

**Files:**
- Modify: `backend/main.py` (add route near the other order/sample routes; reuse `get_integration_db`, `RealDictCursor`, and `from sub_samples.service import derive_base_demand, fetch_sample_services`)
- Create: `backend/tests/test_order_box_label_summary.py`

**Interfaces:**
- Produces: `GET /orders/{order_number}/box-label-summary` → JSON
  `{ "order_number": str, "order_date": str|null, "counts": { "hplc": int, "endo": int, "ster": int } }`.
- Consumes (existing): `get_integration_db()` (psycopg2 context manager, see the inbox usage ~`main.py:14447`), `sub_samples.service.derive_base_demand(services: dict) -> {"hplc","endo","ster"}`, `sub_samples.service.fetch_sample_services(sample_id: str) -> dict|None`.

- [ ] **Step 1: Confirm the order_submissions lookup + columns**

Before writing code, run this against the integration DB to confirm how to find a row by WP order number and which column holds the date/sample list:
```bash
docker exec -i accu-mk1-backend python - <<'PY'
from integration_db import get_integration_db
from psycopg2.extras import RealDictCursor
with get_integration_db() as conn:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='order_submissions' ORDER BY ordinal_position")
        print([r['column_name'] for r in cur.fetchall()])
        cur.execute("SELECT order_id, created_at, sample_results, payload FROM order_submissions WHERE sample_results IS NOT NULL LIMIT 1")
        row = cur.fetchone()
        print("order_id sample:", row and row['order_id'])
        print("sample_results keys:", row and list((row['sample_results'] or {}).keys())[:3])
        print("payload order-number-ish keys:", row and [k for k in (row['payload'] or {}) if 'order' in k.lower() or 'number' in k.lower()])
PY
```
Record the column that matches a WP order number ("WP-3910" → likely `order_id` or `payload->>'order_number'`/`payload->>'number'`) and the date column (`created_at`). Use those concrete names in Steps 3-4.

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_order_box_label_summary.py`. Stub the integration-DB read and `fetch_sample_services` so the test is hermetic (mirrors the monkeypatch style in `tests/test_sub_samples_service.py`):

```python
from fastapi.testclient import TestClient
from unittest.mock import patch
import main
from main import app

client = TestClient(app)

def _fake_order_row():
    # sample_results: dict keyed by sample number -> {senaite_id: ...}
    return {
        "order_number": "WP-3910",
        "created_at": __import__("datetime").datetime(2026, 6, 15, 12, 0, 0),
        "sample_results": {
            "1": {"senaite_id": "P-0858"},
            "2": {"senaite_id": "P-0859"},
        },
    }

# Per-sample services -> derive_base_demand gives hplc1/endo1/ster2.
_SERVICES = {
    "P-0858": {"hplcpurity_identity": True, "endotoxin": True, "sterility_pcr": True},
    "P-0859": {"hplcpurity_identity": True},
}

def test_box_label_summary_sums_vials_per_department():
    with patch.object(main, "_fetch_order_submission_row", return_value=_fake_order_row()), \
         patch("sub_samples.service.fetch_sample_services", side_effect=lambda sid: _SERVICES.get(sid)):
        r = client.get("/orders/WP-3910/box-label-summary")
    assert r.status_code == 200
    body = r.json()
    assert body["order_number"] == "WP-3910"
    assert body["order_date"] == "2026-06-15"
    # P-0858: hplc1+endo1+ster2 ; P-0859: hplc1  => hplc2, endo1, ster2
    assert body["counts"] == {"hplc": 2, "endo": 1, "ster": 2}

def test_box_label_summary_404_when_order_missing():
    with patch.object(main, "_fetch_order_submission_row", return_value=None):
        r = client.get("/orders/WP-0000/box-label-summary")
    assert r.status_code == 404

def test_box_label_summary_skips_unmapped_sample_services():
    with patch.object(main, "_fetch_order_submission_row", return_value=_fake_order_row()), \
         patch("sub_samples.service.fetch_sample_services", side_effect=lambda sid: _SERVICES.get(sid) if sid == "P-0858" else None):
        r = client.get("/orders/WP-3910/box-label-summary")
    assert r.json()["counts"] == {"hplc": 1, "endo": 1, "ster": 2}  # P-0859 skipped
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `docker exec accu-mk1-backend python -m pytest tests/test_order_box_label_summary.py -v`
Expected: FAIL — route 404/not defined, and `_fetch_order_submission_row` doesn't exist yet.

- [ ] **Step 4: Implement the endpoint**

In `backend/main.py`, add a helper + route. Use the concrete column names confirmed in Step 1 (shown here with `order_id` match + `created_at`; adjust if Step 1 differs). Place near the other `/orders` or explorer routes.

```python
from sub_samples.service import derive_base_demand, fetch_sample_services

class BoxLabelSummary(BaseModel):
    order_number: str
    order_date: Optional[str] = None
    counts: dict  # {"hplc": int, "endo": int, "ster": int}

def _fetch_order_submission_row(order_number: str) -> Optional[dict]:
    """The order_submissions row for a WP order number, or None.
    Returns keys: order_number, created_at (datetime|None), sample_results (dict)."""
    from integration_db import get_integration_db
    from psycopg2.extras import RealDictCursor
    norm = order_number.strip()
    with get_integration_db() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Match on the column confirmed in Step 1. Try the WP number as-is
            # and without the "WP-" prefix.
            cur.execute(
                """
                SELECT order_id, created_at, sample_results
                  FROM order_submissions
                 WHERE order_id::text = %s OR order_id::text = %s
                 ORDER BY created_at DESC
                 LIMIT 1
                """,
                (norm, norm.replace("WP-", "")),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return {
                "order_number": norm,
                "created_at": row.get("created_at"),
                "sample_results": row.get("sample_results") or {},
            }

@app.get("/orders/{order_number}/box-label-summary", response_model=BoxLabelSummary)
def get_order_box_label_summary(order_number: str, current_user=Depends(get_current_user)):
    row = _fetch_order_submission_row(order_number)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Order {order_number} not found")
    counts = {"hplc": 0, "endo": 0, "ster": 0}
    for entry in (row["sample_results"] or {}).values():
        sid = entry.get("senaite_id") if isinstance(entry, dict) else None
        if not sid:
            continue
        try:
            services = fetch_sample_services(sid)
        except Exception:
            services = None
        if not services:
            continue
        d = derive_base_demand(services)
        counts["hplc"] += d["hplc"]
        counts["endo"] += d["endo"]
        counts["ster"] += d["ster"]
    created = row.get("created_at")
    order_date = created.date().isoformat() if created else None
    return BoxLabelSummary(order_number=row["order_number"], order_date=order_date, counts=counts)
```

> If Step 1 showed the order number lives in `payload->>'order_number'` (not `order_id`), change the `WHERE` clause accordingly and add `payload` to the SELECT. Keep `_fetch_order_submission_row` as the single seam the tests patch.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `docker exec accu-mk1-backend python -m pytest tests/test_order_box_label_summary.py -v`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_order_box_label_summary.py
git commit -m "feat(orders): box-label summary endpoint (per-department vial counts)

GET /orders/{order_number}/box-label-summary sums each sample's
derive_base_demand across the order's order_submissions row -> expected vials per
department (hplc/endo/ster) + order date. Powers the Print Order # box labels.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Frontend — Print Order # button + box labels

**Files:**
- Modify: `src/lib/api.ts` (add wrapper + type)
- Create: `src/components/intake/ReceiveWizard/OrderLabelTemplate.tsx`
- Modify: `src/components/intake/ReceiveWizard/PrintStep.tsx`
- Modify: `src/components/intake/ReceiveWizard/PrintStep.css`

**Interfaces:**
- Consumes: `GET /orders/{order_number}/box-label-summary` (Task 1).
- Produces: `getOrderBoxLabelSummary(orderNumber: string): Promise<OrderBoxLabelSummary>` where `OrderBoxLabelSummary = { order_number: string; order_date: string | null; counts: { hplc: number; endo: number; ster: number } }`.

- [ ] **Step 1: Add the API wrapper**

In `src/lib/api.ts`, mirror an existing GET wrapper (e.g. `getVialPlan`). Add:
```typescript
export interface OrderBoxLabelSummary {
  order_number: string
  order_date: string | null
  counts: { hplc: number; endo: number; ster: number }
}

export async function getOrderBoxLabelSummary(
  orderNumber: string,
): Promise<OrderBoxLabelSummary> {
  const res = await authedFetch(
    `${API_BASE_URL()}/orders/${encodeURIComponent(orderNumber)}/box-label-summary`,
  )
  if (!res.ok) throw new Error(`box-label-summary failed: ${res.status}`)
  return res.json()
}
```
> Use whatever auth-fetch helper the neighboring wrappers use (match `getVialPlan`'s exact pattern — `authedFetch`/`apiFetch`/headers).

- [ ] **Step 2: Create the box-label component**

Create `src/components/intake/ReceiveWizard/OrderLabelTemplate.tsx`:
```tsx
const DEPT_LABEL: Record<'hplc' | 'endo' | 'ster', string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'PCR',
}

interface Props {
  orderNumber: string
  department: 'hplc' | 'endo' | 'ster'
  vialCount: number
  orderDate: string | null
}

export function OrderLabelTemplate({ orderNumber, department, vialCount, orderDate }: Props) {
  return (
    <div className="order-label">
      <div className="order-label-id">{orderNumber}</div>
      <div className="order-label-meta">
        <span className="order-label-dept">
          {DEPT_LABEL[department]} · {vialCount} vial{vialCount === 1 ? '' : 's'}
        </span>
        {orderDate && <span className="order-label-date">{orderDate}</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire the button + print isolation into PrintStep**

In `src/components/intake/ReceiveWizard/PrintStep.tsx`:
1. Import `getOrderBoxLabelSummary`, `OrderBoxLabelSummary`, `OrderLabelTemplate`.
2. Add state: `const [orderSummary, setOrderSummary] = useState<OrderBoxLabelSummary | null>(null)` and `const [printMode, setPrintMode] = useState<'vials' | 'order'>('vials')`.
3. Add a handler that fetches + prints only the order labels:
```tsx
const printOrderLabels = async () => {
  if (!orderNumber) return
  const summary = await getOrderBoxLabelSummary(orderNumber)
  setOrderSummary(summary)
  setPrintMode('order')
  // wait a tick so the order-label DOM mounts before printing
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.print()
    setPrintMode('vials')
  }))
}
```
4. Add the button next to the existing Print button (the `ml-auto` div ~`PrintStep.tsx:120`), disabled when `!orderNumber`:
```tsx
<Button type="button" variant="outline" onClick={() => void printOrderLabels()} disabled={!orderNumber} className="gap-2">
  <Printer className="w-4 h-4" aria-hidden="true" />
  Print Order #
</Button>
```
5. Render the order labels in their own container that is the print target only in `'order'` mode. Add **next to** the existing `<div className="print-area">…</div>`:
```tsx
{orderSummary && (
  <div className={printMode === 'order' ? 'print-area order-print-area' : 'order-print-area screen-only'}>
    {(['hplc', 'endo', 'ster'] as const)
      .filter(d => orderSummary.counts[d] > 0)
      .map(d => (
        <div key={d} className="label-row">
          <OrderLabelTemplate
            orderNumber={orderSummary.order_number}
            department={d}
            vialCount={orderSummary.counts[d]}
            orderDate={orderSummary.order_date}
          />
        </div>
      ))}
  </div>
)}
```
6. Make the **vial** `print-area` not print in order mode: change its className to
`className={printMode === 'order' ? 'screen-only' : 'print-area'}`.
This guarantees exactly one `.print-area` at print time, so the `@media print` "hide all but .print-area" rule isolates correctly.

- [ ] **Step 4: Add the box-label CSS**

In `src/components/intake/ReceiveWizard/PrintStep.css`, add `.order-label` rules in BOTH the `@media screen` and `@media print` blocks (mirror `.label` for the 50.8mm × 6.35mm media + the `padding-right: 4mm` right-margin fix). The box label is a 2-row column: a large dominant order number, then dept+count / date.

Screen block:
```css
  .print-area .order-label,
  .order-print-area .order-label {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.3mm;
    width: 50.8mm;
    height: 6.35mm;
    padding: 0.3mm 0.8mm;
    padding-right: 4mm;
    box-sizing: border-box;
    border: 1px dashed #ccc;
    background: var(--background, #fff);
  }
  .order-label-id {
    font-family: ui-monospace, monospace;
    font-weight: 700;
    font-size: 11pt;
    line-height: 1;
    letter-spacing: -0.02em;
    white-space: nowrap;
    color: var(--foreground);
  }
  .order-label-meta {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: baseline;
    gap: 1mm;
    font-family: ui-monospace, monospace;
    font-size: 5.5pt;
    color: var(--muted-foreground);
    line-height: 1;
    white-space: nowrap;
  }
  .order-label-dept { font-weight: 700; }
```

Print block (inside `@media print`):
```css
  .order-print-area .order-label {
    width: 50.8mm;
    height: 6.35mm;
    padding: 0.3mm 0.8mm;
    padding-right: 4mm;
    margin: 0;
    box-sizing: border-box;
    display: flex !important;
    flex-direction: column;
    justify-content: center;
    gap: 0.3mm;
    border: none !important;
    background: #fff !important;
    page-break-inside: avoid;
  }
  .order-print-area .order-label:not(:last-child) { page-break-after: always; }
  .order-print-area .order-label-id { font-family: ui-monospace, monospace; font-weight: 700; font-size: 11pt; line-height: 1; color: #000; white-space: nowrap; }
  .order-print-area .order-label-meta { display: flex !important; flex-direction: row; justify-content: space-between; align-items: baseline; gap: 1mm; font-family: ui-monospace, monospace; font-size: 5.5pt; line-height: 1; color: #000; white-space: nowrap; }
  .order-print-area .order-label-dept { font-weight: 700; }
```
> The existing `@media print` `body *{display:none}` + `body :has(.print-area){display:contents}` rules already isolate whichever container has `.print-area`. Since the order container only carries `.print-area` in order mode (Step 3), no other print rule changes are needed.

- [ ] **Step 5: Typecheck**

Run: `docker exec accu-mk1-frontend npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/components/intake/ReceiveWizard/OrderLabelTemplate.tsx src/components/intake/ReceiveWizard/PrintStep.tsx src/components/intake/ReceiveWizard/PrintStep.css
git commit -m "feat(labels): Print Order # box labels (per-department vial counts)

Adds a Print Order # button to the Print Labels tab that fetches the order's
per-department expected vial counts and prints one box label per non-empty
department (order # large, dept + vial count, order date). Print-mode flag keeps
exactly one .print-area so box labels and vial labels print independently.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Release 1.0.3 + deploy

**Files:** `package.json`, `src-tauri/tauri.conf.json`, `CHANGELOG.md`

- [ ] **Step 1: Bump version** — `package.json` and `src-tauri/tauri.conf.json`: `1.0.2` → `1.0.3`.

- [ ] **Step 2: Prepend CHANGELOG.md**
```markdown
## v1.0.3 — 2026-06-22

### Added
- **Print Order # box labels.** The Print Labels tab can print one box label per
  department (HPLC / ENDO / PCR) for the whole order, showing the order number,
  the department's expected vial count, and the order date — for labeling the
  color-coded department bins. Backed by a new order box-label summary endpoint.
```

- [ ] **Step 3: Baseline-aware full backend suite**

Run: `docker exec accu-mk1-backend python -m pytest tests/ -q`
Expected: the new endpoint tests pass; the failure set still matches the documented baseline (see `architecture_mk1_test_baseline_failures` — normalize with `sed 's/^FAILED //' | sort -u` and `comm` against a pre-work capture; zero net-new).

- [ ] **Step 4: FE typecheck** — `docker exec accu-mk1-frontend npx tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 5: Commit**
```bash
git add package.json src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore(release): Accu-Mk1 1.0.3

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Deploy (backend + frontend) + verify** — invoke the **accumark-deploy** skill (Accu-Mk1 web playbook). Worktree → run from **Git Bash**, `sed -i 's/\r$//' scripts/deploy.sh` first, then `bash scripts/deploy.sh --skip-release` (full web deploy, both images). Verify `curl https://accumk1.valenceanalytical.com/api/health` → `{"status":"ok","version":"1.0.3"}`. Push `subsample-features`; merge to master via PR (keep prod = master in sync per the prior hotfix pattern). Then a physical test print of the box labels.

---

## Self-Review

- **Spec coverage:** endpoint + per-department sum from `derive_base_demand` over `order_submissions` (Task 1) ✓; ordered/expected basis, ster=2, 0-count omission, 404, sample-services-404 skip (Task 1 tests) ✓; Print Order # button + one label per non-zero dept + print isolation + 2"×¼" box-label layout, no QR (Task 2) ✓; order date (Task 1) ✓; 1.0.3 backend+frontend release (Task 3) ✓. Out-of-scope (QR, customer-detail param, received-count) untouched.
- **Placeholders:** none — Step 1 of Task 1 is an explicit discovery step feeding the concrete column names into Steps 3-4 (the one spec-flagged unknown), not a TBD; all code steps show code.
- **Type consistency:** backend returns `{order_number, order_date, counts:{hplc,endo,ster}}`; FE `OrderBoxLabelSummary` mirrors it exactly; `OrderLabelTemplate` props (`orderNumber/department/vialCount/orderDate`) match the PrintStep call site; department keys `hplc|endo|ster` and labels HPLC/ENDO/PCR consistent across endpoint, component, and CSS.
