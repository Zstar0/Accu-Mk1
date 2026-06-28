# Order-sourced Products + assignment safety-net + activity legibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sample-page PRODUCTS section reflect what the customer *ordered* (SENAITE-independent), flag any purchased addon with no vial assigned to run it, and surface family vial-assignment history in the parent activity flyout.

**Architecture:** Live-read the order's purchased services from Integration Service (IS) at render time; a single backend product **registry** maps service keys → display chips + vial-fulfillment so new products are a one-line add. The purchased-vs-assigned alert is computed in the frontend from the registry-enriched products × the vials already on the page. The activity endpoint gains a family fan-out + a bucket-aware label.

**Tech Stack:** FastAPI + SQLAlchemy (Python, backend), React 19 + TanStack Query + Vitest/RTL + Tailwind (frontend, **npm only**), FastAPI/Pydantic (integration-service).

## Global Constraints

- **Additive only** — extend existing systems; do not re-architect. A failing existing test defaults to "stale test", not "code is wrong".
- **Data source: live-read-from-IS only.** No SENAITE fallback for this section. No Mk1 persistence/backfill this round.
- **Registry is the single edit point.** Adding a product = one `ProductDef`. No per-product branches in chip rendering or alert logic.
- **Fail open on display.** An unregistered purchased key still renders a chip (derived label); it gets no alert.
- **Variance "purchased"** is determined via `normalize_variance_entitlement` (≥2-pairs floor, lab-override merged) — never a raw non-empty check.
- **Fulfillment roles** parity-check against the seeder's `ROLE_TO_WP_KEYS` (`backend/lims_analyses/seeder.py:65-70`).
- **Use `fetch_sample_services`** (full dict) — never `_fetch_wp_services_for_parent` (drops `package`).
- **FE: npm only** (never pnpm). Zustand selector syntax; no manual memoization (React Compiler).
- **No unsolicited commits** (Accu-Mk1 AGENTS.md #9) — commit steps below run on the operator's go-ahead. Run `gitnexus_impact` on touched symbols before editing and `gitnexus_detect_changes()` before each commit.
- Spec: `docs/superpowers/specs/2026-06-27-ordered-products-source-design.md`.

---

## File map

**integration-service**
- Modify: `app/api/desktop.py:225-229` (`SampleServicesResponse` + `+package`), `app/api/desktop.py:876` (populate `package`).
- Test: `tests/unit/test_desktop_sample_services.py` (create).

**Accu-Mk1 backend**
- Create: `backend/sub_samples/product_registry.py` (registry + `build_ordered_products`).
- Modify: `backend/sub_samples/schemas.py` (`OrderedProduct`, `OrderedProductsResponse`), `backend/sub_samples/routes.py` (new GET endpoint).
- Modify: `backend/main.py:1013-1150` (activity family fan-out + `role_assigned` label).
- Test: `backend/tests/test_product_registry.py`, `backend/tests/test_ordered_products_endpoint.py`, `backend/tests/test_activity_family_fanout.py` (create).

**Accu-Mk1 frontend**
- Modify: `src/lib/api.ts` (`getOrderedProducts` + types).
- Create: `src/components/senaite/OrderedProducts.tsx` (card: chips + alert + states).
- Modify: `src/components/senaite/SampleDetails.tsx:3958-3970` (swap in `<OrderedProducts>`), `src/components/senaite/SampleActivityLog.tsx` (vial id + variance-out color).
- Test: `src/test/ordered-products.test.tsx` (create).

---

## Task 1: IS — return `package` from sample-services

**Files:**
- Modify: `integration-service/app/api/desktop.py:225-229`, `:876`
- Test: `integration-service/tests/unit/test_desktop_sample_services.py`

**Interfaces:**
- Produces: `SampleServicesResponse.package: str | None` (e.g. `"core"`, `"accushield"`, or `None`).

- [ ] **Step 1: Write the failing test**

```python
# integration-service/tests/unit/test_desktop_sample_services.py
from app.api.desktop import SampleServicesResponse


def test_sample_services_response_carries_package():
    r = SampleServicesResponse(
        services={"hplcpurity_identity": True},
        analytical_test="Single Peptide",
        wp_order_number="WP-4242",
        package="core",
    )
    assert r.package == "core"


def test_sample_services_response_package_optional():
    r = SampleServicesResponse(services={}, wp_order_number="WP-1")
    assert r.package is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd integration-service && pytest tests/unit/test_desktop_sample_services.py -v`
Expected: FAIL — `TypeError`/`ValidationError` (unexpected keyword `package`).

- [ ] **Step 3: Add the field**

In `app/api/desktop.py`, class `SampleServicesResponse` (line ~225):

```python
class SampleServicesResponse(BaseModel):
    """Per-sample services dict and order context."""
    services: dict
    analytical_test: str | None = None
    wp_order_number: str
    package: str | None = None
```

- [ ] **Step 4: Populate it in the handler**

In `get_sample_services`, the success return (line ~876):

```python
            return SampleServicesResponse(
                services=sample_payload.get("services") or {},
                analytical_test=sample_payload.get("analytical_test"),
                wp_order_number=rec.order_number,
                package=sample_payload.get("package"),
            )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd integration-service && pytest tests/unit/test_desktop_sample_services.py -v`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add integration-service/app/api/desktop.py integration-service/tests/unit/test_desktop_sample_services.py
git commit -m "feat(is): return package on /orders/sample-services"
```

---

## Task 2: Mk1 — product registry + `build_ordered_products`

**Files:**
- Create: `backend/sub_samples/product_registry.py`
- Test: `backend/tests/test_product_registry.py`

**Interfaces:**
- Produces:
  - `ProductDef(key, label, is_addon, fulfillment_role, fulfillment_dim)` (frozen dataclass).
  - `PRODUCT_REGISTRY: dict[str, ProductDef]` (service-key products) and the package products.
  - `build_ordered_products(services: dict, package: str | None) -> list[dict]` where each dict is `{key, label, is_addon, fulfillment_role, fulfillment_dim}`.
- Consumes: `sub_samples.service.normalize_variance_entitlement` (imported lazily to avoid a cycle); `lims_analyses.seeder.ROLE_TO_WP_KEYS` (parity test only).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_product_registry.py
from sub_samples.product_registry import build_ordered_products, PRODUCT_REGISTRY, ProductDef
from lims_analyses.seeder import ROLE_TO_WP_KEYS


def labels(products):
    return [p["label"] for p in products]


def test_core_package_maps_and_suppresses_redundant_hplc():
    out = build_ordered_products({"hplcpurity_identity": True}, "core")
    assert labels(out) == ["Core HPLC"]  # no separate "HPLC" chip when packaged


def test_accushield_plus_addons_order_and_flags():
    out = build_ordered_products(
        {"hplcpurity_identity": True, "endotoxin": True, "sterility_pcr": True}, "accushield"
    )
    assert labels(out) == ["AccuShield", "Endotoxin", "Sterility"]
    addon = {p["key"]: p for p in out}
    assert addon["endotoxin"]["is_addon"] and addon["endotoxin"]["fulfillment_role"] == "endo"
    assert addon["sterility_pcr"]["fulfillment_role"] == "ster"
    assert addon["sterility_pcr"]["fulfillment_dim"] == "role"


def test_standalone_hplc_without_package_shows_hplc_chip():
    out = build_ordered_products({"hplcpurity_identity": True}, None)
    assert labels(out) == ["HPLC"]


def test_variance_uses_normalized_entitlement():
    # raw map present but below the >=2 floor -> NOT purchased
    out = build_ordered_products({"variance": {"hplcpurity_identity": 1}}, "core")
    assert "Variance HPLC" not in labels(out)
    # >=2 -> purchased, single chip, kind-dimension fulfillment
    out2 = build_ordered_products({"variance": {"hplcpurity_identity": 2}}, "core")
    v = [p for p in out2 if p["key"] == "variance"][0]
    assert v["label"] == "Variance HPLC" and v["is_addon"]
    assert v["fulfillment_dim"] == "kind" and v["fulfillment_role"] == "variance"


def test_bac_water_panel_is_base():
    out = build_ordered_products({"bac_water_panel": True}, None)
    v = [p for p in out if p["key"] == "bac_water_panel"][0]
    assert v["label"] == "Bac Water" and v["is_addon"] is False


def test_unknown_key_fails_open(caplog):
    out = build_ordered_products({"glycan_mapping": True}, None)
    v = [p for p in out if p["key"] == "glycan_mapping"][0]
    assert v["label"] == "Glycan Mapping"  # derived Title-Case
    assert v["fulfillment_role"] is None    # no alert for unknown
    assert "unregistered_product_key" in caplog.text


def test_extensibility_one_entry_adds_chip_and_fulfillment(monkeypatch):
    """Executable proof of D0: a single ProductDef gives a new product a chip
    and an alert with no other change. TEST-ONLY fixture — not the live registry."""
    monkeypatch.setitem(
        PRODUCT_REGISTRY, "sterility_usp71",
        ProductDef("sterility_usp71", "Sterility (USP<71>)", True, "ster", "role"),
    )
    out = build_ordered_products({"sterility_usp71": True}, "core")
    v = [p for p in out if p["key"] == "sterility_usp71"][0]
    assert v["label"] == "Sterility (USP<71>)" and v["is_addon"] and v["fulfillment_role"] == "ster"


def test_addon_fulfillment_roles_match_seeder():
    """Parity: registry role-dimension addons agree with the seeder's authoritative map."""
    service_to_role = {svc: role for role, keys in ROLE_TO_WP_KEYS.items() for svc in keys}
    for key, pdef in PRODUCT_REGISTRY.items():
        if pdef.is_addon and pdef.fulfillment_dim == "role":
            assert pdef.fulfillment_role == service_to_role.get(key), key
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/test_product_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'sub_samples.product_registry'`.

- [ ] **Step 3: Implement the registry**

```python
# backend/sub_samples/product_registry.py
"""Single source mapping a WP order's purchased services to display products +
their vial-fulfillment, for the sample-page PRODUCTS section.

Adding a product = add one ProductDef (see 2026-06-27 ordered-products spec, D0).
Fail-open: unknown purchased keys still render (no alert)."""
from __future__ import annotations

import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProductDef:
    key: str
    label: str
    is_addon: bool
    fulfillment_role: str | None   # vial value that fulfills it; None = base/always-run
    fulfillment_dim: str           # "role" (assignment_role) or "kind" (assignment_kind)


# Package tier — `package` is not part of the `services` dict, so it is keyed separately.
_PACKAGE_PRODUCTS: dict[str, ProductDef] = {
    "core": ProductDef("core", "Core HPLC", False, None, "role"),
    "accushield": ProductDef("accushield", "AccuShield", False, None, "role"),
}

# Service-key products. Addon fulfillment_role mirrors seeder.ROLE_TO_WP_KEYS.
PRODUCT_REGISTRY: dict[str, ProductDef] = {
    "hplcpurity_identity": ProductDef("hplcpurity_identity", "HPLC", False, None, "role"),
    "bac_water_panel": ProductDef("bac_water_panel", "Bac Water", False, None, "role"),
    "endotoxin": ProductDef("endotoxin", "Endotoxin", True, "endo", "role"),
    "sterility_pcr": ProductDef("sterility_pcr", "Sterility", True, "ster", "role"),
    "variance": ProductDef("variance", "Variance HPLC", True, "variance", "kind"),
}


def _as_dict(p: ProductDef) -> dict:
    return {
        "key": p.key, "label": p.label, "is_addon": p.is_addon,
        "fulfillment_role": p.fulfillment_role, "fulfillment_dim": p.fulfillment_dim,
    }


def _derive_label(key: str) -> str:
    return key.replace("_", " ").title()


def build_ordered_products(services: dict, package: str | None) -> list[dict]:
    # Lazy import: service.py imports nothing from here, but keep the edge one-way.
    from sub_samples.service import normalize_variance_entitlement

    services = services or {}
    out: list[dict] = []
    seen: set[str] = set()

    # 1) Base package chip first.
    if package:
        pdef = _PACKAGE_PRODUCTS.get(package)
        if pdef is None:
            log.warning("unregistered_product_key key=%s kind=package", package)
            pdef = ProductDef(package, _derive_label(package), False, None, "role")
        out.append(_as_dict(pdef))
        seen.add(pdef.key)

    has_package = bool(package)

    # 2) Service-key products.
    for key, val in services.items():
        if key == "variance":
            if normalize_variance_entitlement(services):  # >=2 floor; override already merged upstream
                out.append(_as_dict(PRODUCT_REGISTRY["variance"]))
                seen.add("variance")
            continue
        if not val:
            continue
        if key == "hplcpurity_identity" and has_package:
            continue  # implied by the package — avoid a redundant chip
        pdef = PRODUCT_REGISTRY.get(key)
        if pdef is None:
            log.warning("unregistered_product_key key=%s", key)
            pdef = ProductDef(key, _derive_label(key), True, None, "role")
        if pdef.key not in seen:
            out.append(_as_dict(pdef))
            seen.add(pdef.key)

    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/test_product_registry.py -v`
Expected: PASS (all 8).

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/product_registry.py backend/tests/test_product_registry.py
git commit -m "feat(mk1): product registry + build_ordered_products"
```

---

## Task 3: Mk1 — schemas + `/ordered-products` endpoint

**Files:**
- Modify: `backend/sub_samples/schemas.py` (append schemas)
- Modify: `backend/sub_samples/routes.py` (new route; import `build_ordered_products`)
- Test: `backend/tests/test_ordered_products_endpoint.py`

**Interfaces:**
- Consumes: `build_ordered_products` (Task 2); `service.fetch_sample_services` (`service.py:728`, returns full dict or `None` on 404, raises on network/non-2xx).
- Produces: `GET /api/sub-samples/{sample_id}/ordered-products` → `OrderedProductsResponse { sample_id, wp_order_number, products: OrderedProduct[] }`. `404` when no order links the sample; `502` (detail dict) when IS is unreachable.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_ordered_products_endpoint.py
import requests
from fastapi.testclient import TestClient
from main import app
from auth import get_current_user
from sub_samples import routes as ss_routes

client = TestClient(app)
app.dependency_overrides[get_current_user] = lambda: type("U", (), {"id": 1, "email": "t@t"})()


def test_ordered_products_ok(monkeypatch):
    monkeypatch.setattr(ss_routes.service, "fetch_sample_services",
                        lambda sid: {"services": {"endotoxin": True}, "package": "core",
                                     "wp_order_number": "WP-4242"})
    r = client.get("/api/sub-samples/P-0982/ordered-products")
    assert r.status_code == 200
    body = r.json()
    assert body["wp_order_number"] == "WP-4242"
    assert [p["label"] for p in body["products"]] == ["Core HPLC", "Endotoxin"]


def test_ordered_products_no_order_is_404(monkeypatch):
    monkeypatch.setattr(ss_routes.service, "fetch_sample_services", lambda sid: None)
    r = client.get("/api/sub-samples/P-9999/ordered-products")
    assert r.status_code == 404


def test_ordered_products_is_unreachable_is_502(monkeypatch):
    def boom(sid):
        raise requests.ConnectionError("connection refused")
    monkeypatch.setattr(ss_routes.service, "fetch_sample_services", boom)
    r = client.get("/api/sub-samples/P-0982/ordered-products")
    assert r.status_code == 502
    assert r.json()["detail"]["sample_id"] == "P-0982"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/test_ordered_products_endpoint.py -v`
Expected: FAIL — 404 from the router (route not defined) on the OK case.

- [ ] **Step 3: Add the schemas**

Append to `backend/sub_samples/schemas.py`:

```python
class OrderedProduct(BaseModel):
    key: str
    label: str
    is_addon: bool
    fulfillment_role: str | None = None
    fulfillment_dim: str = "role"


class OrderedProductsResponse(BaseModel):
    sample_id: str
    wp_order_number: str | None = None
    products: list[OrderedProduct]
```

- [ ] **Step 4: Add the endpoint**

In `backend/sub_samples/routes.py` — extend the schema import group (line ~26-37) with `OrderedProduct, OrderedProductsResponse`, add `from sub_samples.product_registry import build_ordered_products`, and add the route (place near the variance-entitlement route, ~line 715):

```python
@router.get("/{sample_id}/ordered-products", response_model=OrderedProductsResponse)
def get_ordered_products(sample_id: str, _user=Depends(get_current_user)):
    """Customer-ordered products for the sample-page PRODUCTS section.
    Source: IS order data (no SENAITE). 404 = no linked order; 502 = IS unreachable."""
    try:
        raw = service.fetch_sample_services(sample_id)
    except (requests.RequestException, RuntimeError) as e:
        raise HTTPException(
            status_code=502,
            detail={"message": "integration service unreachable",
                    "sample_id": sample_id, "upstream_error": str(e)},
        )
    if raw is None:
        raise HTTPException(status_code=404, detail=f"no order linked to {sample_id}")
    products = build_ordered_products(raw.get("services") or {}, raw.get("package"))
    return OrderedProductsResponse(
        sample_id=sample_id,
        wp_order_number=raw.get("wp_order_number"),
        products=products,
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && pytest tests/test_ordered_products_endpoint.py -v`
Expected: PASS (all 3).

- [ ] **Step 6: Commit**

```bash
git add backend/sub_samples/schemas.py backend/sub_samples/routes.py backend/tests/test_ordered_products_endpoint.py
git commit -m "feat(mk1): GET /api/sub-samples/{id}/ordered-products"
```

---

## Task 4: Mk1 FE — api client + types

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces:
  - `interface OrderedProduct { key: string; label: string; is_addon: boolean; fulfillment_role: string | null; fulfillment_dim: 'role' | 'kind' }`
  - `interface OrderedProductsResponse { sample_id: string; wp_order_number: string | null; products: OrderedProduct[] }`
  - `class OrderedProductsError extends Error { status: number; detail: unknown }`
  - `getOrderedProducts(sampleId: string): Promise<OrderedProductsResponse>` — throws `OrderedProductsError` (carries status + parsed detail) on non-OK so the UI can show/copy it; the component treats `status === 404` as the quiet empty state.

- [ ] **Step 1: Write the failing test**

```tsx
// src/test/ordered-products.test.tsx  (api section)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getOrderedProducts, OrderedProductsError } from '@/lib/api'

describe('getOrderedProducts', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns products on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ sample_id: 'P-1', wp_order_number: 'WP-1', products: [] }),
    }))
    const res = await getOrderedProducts('P-1')
    expect(res.wp_order_number).toBe('WP-1')
  })

  it('throws OrderedProductsError carrying status + detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 502,
      json: async () => ({ detail: { message: 'IS down' } }),
    }))
    await expect(getOrderedProducts('P-1')).rejects.toMatchObject({
      name: 'OrderedProductsError', status: 502,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/test/ordered-products.test.tsx`
Expected: FAIL — `getOrderedProducts` / `OrderedProductsError` not exported.

- [ ] **Step 3: Implement the client**

Append to `src/lib/api.ts` (near the other sub-sample helpers, ~line 5089):

```typescript
export interface OrderedProduct {
  key: string
  label: string
  is_addon: boolean
  fulfillment_role: string | null
  fulfillment_dim: 'role' | 'kind'
}

export interface OrderedProductsResponse {
  sample_id: string
  wp_order_number: string | null
  products: OrderedProduct[]
}

export class OrderedProductsError extends Error {
  status: number
  detail: unknown
  constructor(status: number, detail: unknown) {
    super(`ordered-products failed: ${status}`)
    this.name = 'OrderedProductsError'
    this.status = status
    this.detail = detail
  }
}

export async function getOrderedProducts(sampleId: string): Promise<OrderedProductsResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/ordered-products`,
    { headers: getBearerHeaders() },
  )
  if (!response.ok) {
    let detail: unknown = null
    try { detail = (await response.json()).detail ?? null } catch { /* no body */ }
    throw new OrderedProductsError(response.status, detail)
  }
  return response.json()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/test/ordered-products.test.tsx`
Expected: PASS (api section).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/test/ordered-products.test.tsx
git commit -m "feat(mk1-fe): getOrderedProducts api client"
```

---

## Task 5: Mk1 FE — `OrderedProducts` card (chips + states)

**Files:**
- Create: `src/components/senaite/OrderedProducts.tsx`
- Test: `src/test/ordered-products.test.tsx` (component section)

**Interfaces:**
- Consumes: `getOrderedProducts`, `OrderedProduct`, `OrderedProductsError` (Task 4); `SubSampleListResponse` (the `subData` already loaded by `SampleDetails`, passed as a prop).
- Produces: `export function OrderedProducts({ sampleId, subData }: { sampleId: string; subData: SubSampleListResponse | undefined })`. Renders: loading spinner; **404 → quiet empty** ("no linked order"); **other error → error chip with hover/click to view+copy + Retry**; success → product chips. (Alert added in Task 6.)

- [ ] **Step 1: Write the failing tests**

```tsx
// src/test/ordered-products.test.tsx  (component section)
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OrderedProducts } from '@/components/senaite/OrderedProducts'
import * as api from '@/lib/api'

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}
const noVials = { parent: null, sub_samples: [] } as unknown as api.SubSampleListResponse

it('renders product chips', async () => {
  vi.spyOn(api, 'getOrderedProducts').mockResolvedValue({
    sample_id: 'P-1', wp_order_number: 'WP-1',
    products: [{ key: 'core', label: 'Core HPLC', is_addon: false, fulfillment_role: null, fulfillment_dim: 'role' }],
  })
  wrap(<OrderedProducts sampleId="P-1" subData={noVials} />)
  expect(await screen.findByText('Core HPLC')).toBeInTheDocument()
})

it('404 shows quiet empty, not an error', async () => {
  vi.spyOn(api, 'getOrderedProducts').mockRejectedValue(new api.OrderedProductsError(404, null))
  wrap(<OrderedProducts sampleId="P-1" subData={noVials} />)
  expect(await screen.findByText(/no linked order/i)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
})

it('non-404 error shows copy + retry', async () => {
  vi.spyOn(api, 'getOrderedProducts').mockRejectedValue(
    new api.OrderedProductsError(502, { message: 'IS down' }))
  wrap(<OrderedProducts sampleId="P-1" subData={noVials} />)
  expect(await screen.findByText(/couldn't load ordered products/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/test/ordered-products.test.tsx`
Expected: FAIL — cannot find `@/components/senaite/OrderedProducts`.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/senaite/OrderedProducts.tsx
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Copy, FlaskConical } from 'lucide-react'
import {
  getOrderedProducts, OrderedProductsError,
  type OrderedProduct, type SubSampleListResponse,
} from '@/lib/api'

function Chip({ p }: { p: OrderedProduct }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-xs text-violet-300">
      <FlaskConical size={12} /> {p.label}
    </span>
  )
}

export function OrderedProducts({
  sampleId, subData,
}: { sampleId: string; subData: SubSampleListResponse | undefined }) {
  const q = useQuery({
    queryKey: ['ordered-products', sampleId],
    queryFn: () => getOrderedProducts(sampleId),
    retry: (count, err) => !(err instanceof OrderedProductsError && err.status === 404) && count < 2,
  })

  const Header = (
    <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Products</span>
  )

  if (q.isLoading) {
    return <Section header={Header}><span className="text-xs text-muted-foreground">loading…</span></Section>
  }

  if (q.isError) {
    const err = q.error
    if (err instanceof OrderedProductsError && err.status === 404) {
      return <Section header={Header}><span className="text-xs text-muted-foreground">no linked order</span></Section>
    }
    const errorText = formatError(sampleId, err)
    return (
      <Section header={Header}>
        <div className="flex items-center gap-2">
          <span className="text-xs text-red-400" title={errorText}>⚠ Couldn't load ordered products</span>
          <button className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
                  onClick={() => navigator.clipboard?.writeText(errorText)}>
            <Copy size={12} /> Copy
          </button>
          <button className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
                  onClick={() => q.refetch()}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      </Section>
    )
  }

  const products = q.data?.products ?? []
  return (
    <Section header={Header}>
      <div className="flex flex-wrap gap-2">
        {products.map(p => <Chip key={p.key} p={p} />)}
      </div>
      {/* Task 6 inserts the purchased-vs-assigned alert here, using `subData`. */}
    </Section>
  )
}

function Section({ header, children }: { header: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-3 pt-3 border-t border-border">
      {header}
      <div className="mt-2">{children}</div>
    </div>
  )
}

function formatError(sampleId: string, err: unknown): string {
  const e = err as OrderedProductsError
  const status = e?.status ?? '?'
  const detail = typeof e?.detail === 'string' ? e.detail : JSON.stringify(e?.detail ?? {})
  return `ordered-products error\nsample_id: ${sampleId}\nstatus: ${status}\ndetail: ${detail}\nat: ${new Date().toISOString()}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/test/ordered-products.test.tsx`
Expected: PASS (component section).

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/OrderedProducts.tsx src/test/ordered-products.test.tsx
git commit -m "feat(mk1-fe): OrderedProducts card (chips + 404/error states)"
```

---

## Task 6: Mk1 FE — purchased-vs-assigned alert

**Files:**
- Modify: `src/components/senaite/OrderedProducts.tsx`
- Test: `src/test/ordered-products.test.tsx` (alert section)

**Interfaces:**
- Consumes: `q.data.products` (each carries `is_addon`, `fulfillment_role`, `fulfillment_dim`) and `subData.sub_samples` (each carries `assignment_role`, `assignment_kind`).
- Produces: a generic, per-addon alert. No new exports.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/test/ordered-products.test.tsx  (alert section)
const vialIn = (k: 'role' | 'kind', v: string) =>
  ({ parent: null, sub_samples: [{ assignment_role: k === 'role' ? v : 'hplc',
       assignment_kind: k === 'kind' ? v : null }] }) as unknown as api.SubSampleListResponse

it('alerts when variance purchased but no variance vial', async () => {
  vi.spyOn(api, 'getOrderedProducts').mockResolvedValue({
    sample_id: 'P-1', wp_order_number: 'WP-1',
    products: [{ key: 'variance', label: 'Variance HPLC', is_addon: true, fulfillment_role: 'variance', fulfillment_dim: 'kind' }],
  })
  wrap(<OrderedProducts sampleId="P-1" subData={{ parent: null, sub_samples: [] } as unknown as api.SubSampleListResponse} />)
  expect(await screen.findByText(/Variance HPLC purchased .* no vial assigned/i)).toBeInTheDocument()
})

it('no alert when a variance vial exists', async () => {
  vi.spyOn(api, 'getOrderedProducts').mockResolvedValue({
    sample_id: 'P-1', wp_order_number: 'WP-1',
    products: [{ key: 'variance', label: 'Variance HPLC', is_addon: true, fulfillment_role: 'variance', fulfillment_dim: 'kind' }],
  })
  wrap(<OrderedProducts sampleId="P-1" subData={vialIn('kind', 'variance')} />)
  await screen.findByText('Variance HPLC')
  expect(screen.queryByText(/no vial assigned/i)).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/test/ordered-products.test.tsx`
Expected: FAIL — alert text not rendered.

- [ ] **Step 3: Implement the alert**

In `OrderedProducts.tsx`, replace the success-branch `return (...)` with one that computes and renders unmet addons:

```tsx
  const products = q.data?.products ?? []
  const vials = subData?.sub_samples ?? []
  const unmet = products.filter(p =>
    p.is_addon && p.fulfillment_role && !vials.some(s =>
      (p.fulfillment_dim === 'kind' ? s.assignment_kind : s.assignment_role) === p.fulfillment_role,
    ),
  )

  return (
    <Section header={Header}>
      <div className="flex flex-wrap gap-2">
        {products.map(p => <Chip key={p.key} p={p} />)}
      </div>
      {unmet.length > 0 && (
        <div className="mt-2 space-y-1">
          {unmet.map(p => (
            <div key={p.key}
                 className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
              ⚠ {p.label} purchased — no vial assigned to run it.
            </div>
          ))}
        </div>
      )}
    </Section>
  )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/test/ordered-products.test.tsx`
Expected: PASS (alert section + all prior).

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/OrderedProducts.tsx src/test/ordered-products.test.tsx
git commit -m "feat(mk1-fe): purchased-vs-assigned alert in OrderedProducts"
```

---

## Task 7: Mk1 FE — wire `OrderedProducts` into the sample page

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (import + replace block at `:3958-3970`; remove now-dead `hasVariance` at `:3406-3411`)

**Interfaces:**
- Consumes: `OrderedProducts` (Task 5/6); the existing `subData` (from `listSubSamples`, `SampleDetails.tsx:2677`) and `sampleId` (`:2577`).

- [ ] **Step 1: Add the import**

Near the other senaite imports (`SampleDetails.tsx:146`):

```tsx
import { OrderedProducts } from '@/components/senaite/OrderedProducts'
```

- [ ] **Step 2: Replace the PRODUCTS block**

Replace `SampleDetails.tsx:3958-3970` (the `{(data.profiles.length > 0 || hasVariance) && (...)}` block) with:

```tsx
                <OrderedProducts sampleId={sampleId ?? ''} subData={subData} />
```

- [ ] **Step 3: Remove the now-dead `hasVariance`**

Delete the `hasVariance` computation at `SampleDetails.tsx:3406-3411` (the chip no longer uses it; the alert lives in `OrderedProducts`). If `hasVariance` is referenced elsewhere, leave it; otherwise remove to satisfy lint.

- [ ] **Step 4: Typecheck + lint + full FE test run**

Run: `npm run check:all`
Expected: PASS (no unused-var/type errors; `ordered-products.test.tsx` green). If `hasVariance` is referenced elsewhere, the typecheck will flag it — re-add or update that reference.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/SampleDetails.tsx
git commit -m "feat(mk1-fe): source PRODUCTS from order data on sample page"
```

---

## Task 8: Mk1 backend — activity family fan-out + bucket-aware label

**Files:**
- Modify: `backend/main.py:1013-1150` (the vial section of `get_sample_activity`)
- Test: `backend/tests/test_activity_family_fanout.py`

**Interfaces:**
- Consumes: `LimsSample` (parent, `.sub_samples` relationship), `LimsSubSample`, `LimsSubSampleEvent`, `LimsAnalysis*` (already imported in the endpoint).
- Produces: `/samples/{parent_id}/activity` now returns each family vial's Section A+B events, each event's `details["vial"]` set to the vial `sample_id`; `role_assigned` label includes the bucket when `kind` changed. Calling with a vial id is unchanged.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_activity_family_fanout.py
# Uses the project's standard DB test fixture (see backend/tests/conftest.py).
from models import LimsSample, LimsSubSample, LimsSubSampleEvent


def _seed_family(db):
    parent = LimsSample(sample_id="P-7000", status="received")
    db.add(parent); db.flush()
    v1 = LimsSubSample(sample_id="P-7000-S01", parent_sample_pk=parent.id, vial_sequence=1,
                       assignment_role="hplc", assignment_kind="variance")
    db.add(v1); db.flush()
    db.add(LimsSubSampleEvent(sub_sample_pk=v1.id, event="role_assigned",
           details={"from": "hplc", "to": "hplc", "kind_from": "variance", "kind_to": None}))
    db.commit()
    return parent


def test_parent_activity_includes_family_vial_events(client, db_session):
    _seed_family(db_session)
    r = client.get("/samples/P-7000/activity")
    assert r.status_code == 200
    role_events = [e for e in r.json()["events"] if e["event"] == "role_assigned"]
    assert role_events, "parent flyout must surface vial assignment events"
    e = role_events[0]
    assert e["details"]["vial"] == "P-7000-S01"
    assert "Variance" in e["label"] and "Extra" in e["label"]  # bucket-aware label
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_activity_family_fanout.py -v`
Expected: FAIL — no `role_assigned` events (parent id doesn't match a `LimsSubSample`).

- [ ] **Step 3: Family fan-out**

In `backend/main.py`, replace the single-sub gate (`:1015-1018`):

```python
    # was:
    # sub_row = db.execute(select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)).scalar_one_or_none()
    # if sub_row is not None:
    family_subs: list = []
    direct_sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if direct_sub is not None:
        family_subs = [direct_sub]            # called with a vial id (unchanged behavior)
    else:
        parent = db.execute(
            select(LimsSample).where(LimsSample.sample_id == sample_id)
        ).scalar_one_or_none()
        if parent is not None:
            family_subs = list(parent.sub_samples)[:64]   # cap defensively
    for sub_row in family_subs:
```

Then **indent the existing Section A1/A2/B body (`:1019-1150`) under this `for` loop** (it already references `sub_row`). No other logic change in that body except Steps 4–5.

- [ ] **Step 4: Tag every appended vial event with its vial id**

Every `events.append({...})` inside the loop (Sections A1, A2, B) gets `"vial": sub_row.sample_id` added to its `details`. For Section B (`:1142-1150`) this is in the shared `event_details` dict:

```python
            event_details = dict(se.details or {})
            event_details["by"] = actor_email
            event_details["vial"] = sub_row.sample_id
```

For the Section A appends, add `"vial": sub_row.sample_id` to each `details`/`details=` dict literal.

- [ ] **Step 5: Bucket-aware `role_assigned` label**

Replace the `role_assigned` label (`:1116-1118`):

```python
            if se.event == "role_assigned":
                d = se.details or {}

                def _bucket(kind, role):
                    if kind == "variance":
                        return "Variance"
                    if role in (None, "xtra") or kind is None:
                        return "Extra" if role in (None, "xtra") else (role or "Extra")
                    return role

                if d.get("kind_from") != d.get("kind_to"):
                    label = f"Bucket: {_bucket(d.get('kind_from'), d.get('from'))} → {_bucket(d.get('kind_to'), d.get('to'))}"
                else:
                    label = f"Role: {d.get('from')} → {d.get('to')}"
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && pytest tests/test_activity_family_fanout.py -v`
Expected: PASS. Also run `pytest tests/test_subsample_activity.py -v` to confirm the vial-id path still passes.

- [ ] **Step 7: Commit**

```bash
git add backend/main.py backend/tests/test_activity_family_fanout.py
git commit -m "feat(mk1): parent activity fan-out + bucket-aware role label"
```

---

## Task 9: Mk1 FE — show vial id + flag variance-out moves in the flyout

**Files:**
- Modify: `src/components/senaite/SampleActivityLog.tsx`
- Test: `src/test/ordered-products.test.tsx` (flyout section) — or co-locate in a new `sample-activity-log.test.tsx`

**Interfaces:**
- Consumes: `event.details.vial` (string) and `event.details.kind_from`/`kind_to` (Task 8).
- Produces: vial badge on vial events; `role_assigned` moves *out of* variance render at `warn` (amber) instead of `accent`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/test/sample-activity-log.test.tsx
import { render, screen } from '@testing-library/react'
import { eventLevelFor } from '@/components/senaite/SampleActivityLog'

it('move out of variance is warn', () => {
  expect(eventLevelFor({ event: 'role_assigned',
    details: { kind_from: 'variance', kind_to: null } } as any)).toBe('warn')
})

it('other role_assigned stays accent', () => {
  expect(eventLevelFor({ event: 'role_assigned',
    details: { kind_from: null, kind_to: 'variance' } } as any)).toBe('accent')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/test/sample-activity-log.test.tsx`
Expected: FAIL — `eventLevelFor` not exported.

- [ ] **Step 3: Add `eventLevelFor` and use it**

In `SampleActivityLog.tsx`, add an exported helper that wraps `eventToLevel` with the variance-out special case, and call it from the render loop instead of `eventToLevel(ev.event)`:

```tsx
export function eventLevelFor(ev: SampleActivityEvent): EventLevel {
  if (ev.event === 'role_assigned' &&
      ev.details?.kind_from === 'variance' && ev.details?.kind_to !== 'variance') {
    return 'warn'
  }
  return eventToLevel(ev.event)
}
```

In the render loop (`:298`), change `const level = eventToLevel(ev.event)` to `const level = eventLevelFor(ev)`.

- [ ] **Step 4: Show the vial id on vial events**

In `DetailLine` (`:140-146`, the default case), prepend the vial when present:

```tsx
    default: {
      if (d.vial) parts.push(<span key="v" className="text-zinc-400">{String(d.vial)}</span>)
      if (d.by) parts.push(<span key="u">by <UserTag email={d.by as string} directory={directory} /></span>)
      if (d.reason) parts.push(`reason=${d.reason}`)
      break
    }
```

- [ ] **Step 5: Run tests + full gate**

Run: `npm run test -- src/test/sample-activity-log.test.tsx` then `npm run check:all`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/senaite/SampleActivityLog.tsx src/test/sample-activity-log.test.tsx
git commit -m "feat(mk1-fe): vial id + variance-out emphasis in activity flyout"
```

---

## Final verification

- [ ] Backend: `cd backend && pytest tests/test_product_registry.py tests/test_ordered_products_endpoint.py tests/test_activity_family_fanout.py -v`
- [ ] IS: `cd integration-service && pytest tests/unit/test_desktop_sample_services.py -v`
- [ ] FE: `npm run check:all`
- [ ] Manual (stack or local): open a sample whose order has a Variance addon; confirm the **Variance HPLC** chip shows regardless of vial assignment; move its variance vial to Extra and confirm the **amber alert** appears and the activity flyout shows `Bucket: Variance → Extra` with the vial id + actor; stop IS and confirm the Products card shows the **error + copy + retry** (no SENAITE fallback).

## Spec coverage (self-review)
- D0 registry / extensibility → Task 2 (+ extensibility proof test). D1 live-IS, no fallback → Tasks 3,5. D2 labels → Task 2. D3/D4 alert → Task 6. D5 404 quiet empty → Tasks 3,5. D6 error UX → Task 5. Component 1 → Tasks 1–5,7. Component 2 → Task 6. Component 3 → Tasks 8,9. Variance-via-helpers (#1) → Task 2. fetch_sample_services not _fetch_wp (#4) → Task 3. ROLE_TO_WP_KEYS parity (#3) → Task 2.
