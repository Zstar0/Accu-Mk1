# Order Entity + Order Flags (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Accu-Mk1 a durable `lims_orders` entity (with billing/shipping addresses), stamp WC line-item ids onto `lims_samples`, and make orders + samples flaggable from the Receive page.

**Architecture:** WP adds `line_item_ids`/`address_2`/`shipping` to the order payload; the IS pushes an idempotent order upsert to a new Mk1 S2S endpoint right after order processing (plus a re-runnable backfill over all historical `order_submissions`); Mk1 stores orders in `lims_orders`, registers `order` in the flags seam, and the Receive page gains flag buttons and a ship-from line.

**Tech Stack:** FastAPI + SQLAlchemy + raw-DDL migrations (Mk1), FastAPI + asyncpg-backed SQLAlchemy (IS), WordPress/WooCommerce PHP 8 (wpstar), React + TanStack Query + vitest (Mk1 FE).

**Spec:** `docs/superpowers/specs/2026-08-28-order-entity-design.md` — read it first; it fixes the semantics (samples ARE the items; no logistics fields here; join by order_number, no FK).

## Global Constraints

- **Branch from Accu-Mk1 master only AFTER PR #150 (logistics-capture) merges.** Task code assumes `require_internal_service_token` and the logistics `lims_samples` columns exist. If `git log origin/master --oneline | head -20` shows no logistics merge, STOP and ask.
- Never add tracking/vendor fields to `lims_orders` or touch logistics columns — logistics-capture owns them per its approved spec.
- Order flag entity id = `order_number` string (e.g. `WP-6344`), never the integer id.
- Mk1 tests: `cd backend && python -m pytest tests/<file> -q`. Frontend: `npx vitest run <file>`, `npx tsc --noEmit`. IS tests: `cd integration-service && python -m pytest tests/<file> -q`. wpstar suite: `docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && php8.1 vendor/bin/phpunit -c phpunit.xml.dist'` (runs against the DevKinsta checkout — sync changed theme files there first; `--filter <TestClass>` for a single class).
- Deploy order: **Mk1 → IS → wpstar**, then run the IS backfill once. Version bumps: Mk1 `package.json` + `src-tauri/tauri.conf.json` (minor bump) in Task 6; wpstar `style.css` + `CHANGELOG.md` (minor bump) in Task 10.
- Commit per task from the repo root; prefix `feat(order-entity):`; end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Mk1 — `lims_orders` table + `LimsOrder` model

**Files:**
- Modify: `backend/database.py` (append to the DDL migrations list where the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` strings live)
- Modify: `backend/models.py` (after `LimsSample`)
- Test: `backend/tests/test_lims_orders_model.py` (create)

**Interfaces:**
- Produces: `models.LimsOrder` with columns exactly as below — Tasks 3, 4, 5 import it.

- [ ] **Step 1: Write the failing test**

```python
"""lims_orders: table exists, upsert-friendly uniqueness on wp_order_id."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base
from models import LimsOrder


@pytest.fixture
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def test_lims_order_roundtrip(db_session):
    o = LimsOrder(wp_order_id=6344, order_number="WP-6344", status="order-submitted",
                  customer_user_id=3181, customer_name="Jane Doe",
                  customer_email="j@x.com",
                  billing={"city": "Austin", "state": "TX", "country": "US"},
                  shipping=None)
    db_session.add(o)
    db_session.commit()
    row = db_session.query(LimsOrder).filter_by(wp_order_id=6344).one()
    assert row.order_number == "WP-6344"
    assert row.billing["city"] == "Austin"
    assert row.shipping is None


def test_wp_order_id_unique(db_session):
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-1"))
    db_session.commit()
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-1-dupe"))
    with pytest.raises(Exception):
        db_session.commit()
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && python -m pytest tests/test_lims_orders_model.py -q` → FAIL (`ImportError: cannot import name 'LimsOrder'`).

- [ ] **Step 3: Add the model** to `backend/models.py` after `LimsSample`, matching its style (SQLAlchemy declarative, `JSON` type so SQLite tests work — Postgres stores it as JSONB via the existing `JSON().with_variant` convention if the file uses one; otherwise plain `JSON` matches `LimsSample`'s json columns):

```python
class LimsOrder(Base):
    """WP order registry row — the parent entity for lims_samples
    (join: order_number == lims_samples.client_order_number, no FK by
    design). Upserted by the IS at order acceptance and by the backfill;
    NEVER carries logistics fields (vendor/tracking live per-sample)."""

    __tablename__ = "lims_orders"

    id = Column(Integer, primary_key=True)
    wp_order_id = Column(Integer, nullable=False, unique=True, index=True)
    order_number = Column(String(40), nullable=False, index=True)
    status = Column(String(40), nullable=True)
    customer_user_id = Column(Integer, nullable=True)
    customer_name = Column(String(200), nullable=True)
    customer_email = Column(String(254), nullable=True)
    billing = Column(JSON, nullable=True)
    shipping = Column(JSON, nullable=True)
    wp_created_at = Column(DateTime(timezone=True), nullable=True)
    wp_paid_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now(), nullable=False)
```

(Use the exact `Column`/`Mapped` idiom the surrounding models use — if `LimsSample` uses `Mapped[...]`/`mapped_column`, mirror that instead of classic `Column`; the column names/types above are the contract.)

- [ ] **Step 4: Add the DDL migration** to the migrations list in `backend/database.py` (same list holding the `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...` strings):

```python
        """
        CREATE TABLE IF NOT EXISTS lims_orders (
            id               SERIAL PRIMARY KEY,
            wp_order_id      INTEGER NOT NULL UNIQUE,
            order_number     VARCHAR(40) NOT NULL,
            status           VARCHAR(40),
            customer_user_id INTEGER,
            customer_name    VARCHAR(200),
            customer_email   VARCHAR(254),
            billing          JSONB,
            shipping         JSONB,
            wp_created_at    TIMESTAMPTZ,
            wp_paid_at       TIMESTAMPTZ,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_orders_order_number ON lims_orders (order_number)",
```

- [ ] **Step 5: Run tests** → PASS. Also run `python -m pytest tests/test_registry_list.py -q` (no regressions).
- [ ] **Step 6: Commit** — `git add backend/models.py backend/database.py backend/tests/test_lims_orders_model.py && git commit -m "feat(order-entity): lims_orders table + model"`.

---

### Task 2: Mk1 — `wc_line_item_ids` on `lims_samples` + registry passthrough

**Files:**
- Modify: `backend/database.py` (migrations list), `backend/models.py` (`LimsSample`), `backend/sub_samples/registry_list.py`, `backend/main.py` (`SenaiteSampleItem`)
- Test: `backend/tests/test_registry_list.py` (extend)

**Interfaces:**
- Produces: `LimsSample.wc_line_item_ids` (JSON list of ints, nullable) — Task 3 writes it; registry items carry `wc_line_item_ids: list[int]` — Task 6's TS type mirrors it.

- [ ] **Step 1: Write the failing test** (append to `test_registry_list.py`, reusing its `_row` helper):

```python
def test_wc_line_item_ids_passthrough():
    [out] = registry_rows_to_list([_row(wc_line_item_ids=[13049, 13052])])
    assert out['wc_line_item_ids'] == [13049, 13052]
    assert registry_rows_to_list([_row()])[0]['wc_line_item_ids'] == []
```

- [ ] **Step 2: Run to verify it fails** → FAIL (KeyError or attribute missing).
- [ ] **Step 3: Implement** — models.py `LimsSample`: add `wc_line_item_ids = Column(JSON, nullable=True)` (mirroring the file's column idiom). database.py migrations list: `"ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS wc_line_item_ids JSONB"`. registry_list.py `registry_rows_to_list` row dict: `"wc_line_item_ids": list(r.wc_line_item_ids or []),`. main.py `SenaiteSampleItem`: `wc_line_item_ids: list[int] = []`.
- [ ] **Step 4: Run** `python -m pytest tests/test_registry_list.py -q` → PASS.
- [ ] **Step 5: Commit** — `feat(order-entity): wc_line_item_ids column + registry passthrough`.

---

### Task 3: Mk1 — `POST /s2s/orders/upsert`

**Files:**
- Modify: `backend/main.py` (new models + route, near the `/s2s/lims-samples/shipping` route)
- Test: `backend/tests/test_s2s_orders_upsert.py` (create — copy the fixture idiom from `backend/tests/test_s2s_shipping_update.py`, which authenticates with header `X-Service-Token` and patches the service-token setting the same way)

**Interfaces:**
- Consumes: `models.LimsOrder` (Task 1), `LimsSample.wc_line_item_ids` (Task 2), the existing `require_internal_service_token` dependency (landed with logistics).
- Produces: route contract below — the IS adapter (Task 7) calls it verbatim.

- [ ] **Step 1: Write the failing tests** — cases: (a) insert creates a row; (b) second call with changed fields updates in place (same id, updated values); (c) `samples[]` stamps `wc_line_item_ids` on an existing `lims_samples` row and reports a missing one in `samples_missing`; (d) missing/wrong `X-Service-Token` → 401/403 (mirror the assertion style of `test_s2s_shipping_update.py::test_rejects_without_service_token`).

```python
def test_upsert_insert_then_update(client, db_session):
    body = {"orders": [{
        "wp_order_id": 6344, "order_number": "WP-6344",
        "status": "order-submitted",
        "customer": {"user_id": 3181, "name": "Jane Doe", "email": "j@x.com"},
        "billing": {"city": "Austin", "state": "TX", "country": "US"},
        "shipping": None,
        "wp_created_at": "2026-08-19T23:02:46Z",
        "wp_paid_at": "2026-08-20T00:10:22Z",
        "samples": [],
    }]}
    r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200 and r.json()["upserted"] == 1
    body["orders"][0]["status"] = "sample-received"
    r2 = client.post(URL, json=body, headers=HDR)
    assert r2.status_code == 200
    rows = db_session.query(LimsOrder).filter_by(wp_order_id=6344).all()
    assert len(rows) == 1 and rows[0].status == "sample-received"


def test_upsert_stamps_line_items_and_reports_missing(client, db_session):
    db_session.add(LimsSample(sample_id="P-2289", client_order_number="WP-6344"))
    db_session.commit()
    body = {"orders": [{
        "wp_order_id": 6344, "order_number": "WP-6344", "status": None,
        "customer": None, "billing": None, "shipping": None,
        "wp_created_at": None, "wp_paid_at": None,
        "samples": [
            {"senaite_sample_id": "P-2289", "line_item_ids": [13049, 13052]},
            {"senaite_sample_id": "P-9999", "line_item_ids": [1]},
        ],
    }]}
    r = client.post(URL, json=body, headers=HDR)
    assert r.json() == {"upserted": 1, "samples_stamped": 1, "samples_missing": 1}
    row = db_session.query(LimsSample).filter_by(sample_id="P-2289").one()
    assert row.wc_line_item_ids == [13049, 13052]
```

- [ ] **Step 2: Run to verify failure** → FAIL (404 route missing).
- [ ] **Step 3: Implement** in `backend/main.py`:

```python
class S2SOrderSampleStamp(BaseModel):
    senaite_sample_id: str
    line_item_ids: list[int] = []


class S2SOrderCustomer(BaseModel):
    user_id: Optional[int] = None
    name: Optional[str] = None
    email: Optional[str] = None


class S2SOrderUpsert(BaseModel):
    wp_order_id: int
    order_number: str
    status: Optional[str] = None
    customer: Optional[S2SOrderCustomer] = None
    billing: Optional[dict] = None
    shipping: Optional[dict] = None
    wp_created_at: Optional[datetime] = None
    wp_paid_at: Optional[datetime] = None
    samples: list[S2SOrderSampleStamp] = []


class S2SOrdersUpsertRequest(BaseModel):
    orders: list[S2SOrderUpsert]


class S2SOrdersUpsertResponse(BaseModel):
    upserted: int
    samples_stamped: int
    samples_missing: int


@app.post("/s2s/orders/upsert", response_model=S2SOrdersUpsertResponse)
def s2s_upsert_orders(
    req: S2SOrdersUpsertRequest,
    db: Session = Depends(get_db),
    _: None = Depends(require_internal_service_token),
):
    """Idempotent order upsert from the integration service (acceptance push
    + backfill). Never touches logistics columns; missing registry samples
    are reported, not errors (registry sync may lag the first push)."""
    upserted = stamped = missing = 0
    for o in req.orders:
        row = db.query(LimsOrder).filter_by(wp_order_id=o.wp_order_id).first()
        if row is None:
            row = LimsOrder(wp_order_id=o.wp_order_id, order_number=o.order_number)
            db.add(row)
        row.order_number = o.order_number
        row.status = o.status
        if o.customer is not None:
            row.customer_user_id = o.customer.user_id
            row.customer_name = o.customer.name
            row.customer_email = o.customer.email
        row.billing = o.billing
        row.shipping = o.shipping
        row.wp_created_at = o.wp_created_at
        row.wp_paid_at = o.wp_paid_at
        upserted += 1
        for s in o.samples:
            sample = db.query(LimsSample).filter_by(sample_id=s.senaite_sample_id).first()
            if sample is None:
                missing += 1
                continue
            sample.wc_line_item_ids = list(s.line_item_ids)
            stamped += 1
    db.commit()
    return S2SOrdersUpsertResponse(upserted=upserted, samples_stamped=stamped,
                                   samples_missing=missing)
```

- [ ] **Step 4: Run tests** → PASS (all four cases).
- [ ] **Step 5: Commit** — `feat(order-entity): s2s orders upsert endpoint`.

---

### Task 4: Mk1 — `GET /registry/orders`

**Files:**
- Modify: `backend/main.py` (route next to `GET /registry/samples`)
- Test: `backend/tests/test_registry_orders_read.py` (create — copy the authenticated-client fixture idiom from `backend/tests/test_registry_list.py`, which overrides `get_current_user` and `get_db`)

**Interfaces:**
- Consumes: `LimsOrder` (Task 1), `get_current_user` (existing).
- Produces: `GET /registry/orders?numbers=WP-6344,WP-6350` → `{"orders": [RegistryOrderItem]}` with fields `wp_order_id, order_number, status, customer_name, customer_email, billing, shipping, wp_created_at, wp_paid_at` — Task 6's `getRegistryOrders` consumes it.

- [ ] **Step 1: Write the failing tests** — (a) returns rows for requested numbers, absent for unknown; (b) caps request at 100 numbers (422 beyond); (c) unauthenticated → 401 (drop the auth override for that case, same as the registry-list test does).

```python
def test_returns_requested_orders(client, db_session):
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-1",
                             billing={"city": "Austin", "state": "TX"}))
    db_session.commit()
    r = client.get("/registry/orders", params={"numbers": "WP-1,WP-404"})
    assert r.status_code == 200
    orders = r.json()["orders"]
    assert len(orders) == 1
    assert orders[0]["order_number"] == "WP-1"
    assert orders[0]["billing"]["city"] == "Austin"
```

- [ ] **Step 2: Run to verify failure** → FAIL (404).
- [ ] **Step 3: Implement:**

```python
class RegistryOrderItem(BaseModel):
    wp_order_id: int
    order_number: str
    status: Optional[str] = None
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    billing: Optional[dict] = None
    shipping: Optional[dict] = None
    wp_created_at: Optional[datetime] = None
    wp_paid_at: Optional[datetime] = None


class RegistryOrdersResponse(BaseModel):
    orders: list[RegistryOrderItem]


@app.get("/registry/orders", response_model=RegistryOrdersResponse)
def list_registry_orders(
    numbers: str,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Batched lims_orders read for the Receive page's ship-from line —
    one request for the visible order groups, never per-row."""
    wanted = [n.strip() for n in numbers.split(",") if n.strip()][:100]
    if not wanted:
        return RegistryOrdersResponse(orders=[])
    rows = db.query(LimsOrder).filter(LimsOrder.order_number.in_(wanted)).all()
    return RegistryOrdersResponse(orders=[RegistryOrderItem(
        wp_order_id=r.wp_order_id, order_number=r.order_number, status=r.status,
        customer_name=r.customer_name, customer_email=r.customer_email,
        billing=r.billing, shipping=r.shipping,
        wp_created_at=r.wp_created_at, wp_paid_at=r.wp_paid_at,
    ) for r in rows])
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `feat(order-entity): batched registry orders read`.

---

### Task 5: Mk1 — flags `order` entity registration

**Files:**
- Modify: `backend/flags/seams.py` (the wiring section registering `sample`/`sub_sample`/`worksheet`), `backend/database.py` (seed an `order` row in `flag_item_kinds`, mirroring the existing `general_task` idempotent INSERT)
- Test: `backend/tests/test_flags_order_entity.py` (create)

**Interfaces:**
- Consumes: `LimsOrder`, `LimsSample`, `register_entity` (existing seam).
- Produces: registered entity type `"order"` with entity_id = order_number — Task 6's `RaiseFlagButton entityType="order"` relies on it.

- [ ] **Step 1: Write the failing tests** — resolve label/context/descendants through the seam registry:

```python
"""Flags 'order' entity: label, context, descendants roll-up."""
from flags.seams import resolve_label, resolve_context, resolve_descendants
# (use the seam module's actual resolver entrypoints — grep seams.py for the
# functions the flags service calls; they exist for 'sample' already. If they
# are methods on a registry object, mirror how backend/tests exercise the
# sample entity's label today — test_flags_* files show the idiom.)


def test_order_label_includes_customer(db_session):
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-6344",
                             customer_name="Jane Doe"))
    db_session.commit()
    assert resolve_label(db_session, "order", "WP-6344") == "WP-6344 · Jane Doe"


def test_order_label_without_row_is_number(db_session):
    assert resolve_label(db_session, "order", "WP-404") == "WP-404"


def test_order_descendants_are_its_samples(db_session):
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-6344"))
    db_session.add(LimsSample(sample_id="P-1", client_order_number="WP-6344"))
    db_session.add(LimsSample(sample_id="P-2", client_order_number="WP-6344"))
    db_session.add(LimsSample(sample_id="P-9", client_order_number="WP-9"))
    db_session.commit()
    assert set(resolve_descendants(db_session, "order", "WP-6344")) == {
        ("sample", "P-1"), ("sample", "P-2")}
```

- [ ] **Step 2: Run to verify failure** → FAIL (unknown entity type "order").
- [ ] **Step 3: Implement** in `seams.py` next to the existing registrations:

```python
    def _order_label(db, eid):
        row = (db.query(LimsOrder).filter_by(order_number=eid).first()
               if db is not None else None)
        return f"{eid} · {row.customer_name}" if row and row.customer_name else eid

    def _order_context(db, eid):
        row = db.query(LimsOrder).filter_by(order_number=eid).first()
        sample_ids = [s.sample_id for s in
                      db.query(LimsSample).filter_by(client_order_number=eid)]
        if row is None and not sample_ids:
            return None
        return {"label": _order_label(db, eid),
                "customer_name": row.customer_name if row else None,
                "customer_email": row.customer_email if row else None,
                "sample_ids": sample_ids,
                "deep_link": "/#senaite/receive-sample"}

    def _order_descendants(db, eid):
        return [("sample", s.sample_id) for s in
                db.query(LimsSample).filter_by(client_order_number=eid)]

    register_entity("order",
                    label=_order_label,
                    deep_link=lambda eid: "/#senaite/receive-sample",
                    can_flag=lambda user, eid: True,
                    context=_order_context,
                    descendants=_order_descendants)
```

(Import `LimsOrder` alongside the existing `LimsSample` import in the wiring section. Match the exact kwargs the sample registration uses; omit `contexts`/`state`/`search` — optional.)

- [ ] **Step 4: Seed the kind** in database.py, mirroring the `general_task` insert:

```python
        """
        INSERT INTO flag_item_kinds (slug, label, color, is_active, is_builtin, sort_order)
        SELECT 'order', 'Order', '#f59e0b', TRUE, TRUE, 5
        WHERE NOT EXISTS (SELECT 1 FROM flag_item_kinds WHERE slug='order')
        """,
```

- [ ] **Step 5: Run tests** → PASS; also `python -m pytest tests/ -q -k flag` (no regressions).
- [ ] **Step 6: Commit** — `feat(order-entity): register order flag entity + kind seed`.

---

### Task 6: Mk1 FE — flag buttons + ship-from line on Receive

**Files:**
- Modify: `src/lib/api.ts`, `src/components/intake/ReceiveSample.tsx`, `src/components/intake/OrderListRow.tsx`, `package.json` + `src-tauri/tauri.conf.json` (minor version bump), `CHANGELOG.md`
- Test: `src/components/intake/__tests__/ReceiveSample.test.tsx` (extend)

**Interfaces:**
- Consumes: `GET /registry/orders` (Task 4 shape), existing `RaiseFlagButton` (`src/components/flags/RaiseFlagButton.tsx` — props `entityType`, `entityId`, `candidates`, `trigger`, `targetLabel`).
- Produces: `getRegistryOrders(numbers: string[]): Promise<RegistryOrder[]>` in api.ts.

- [ ] **Step 1: api.ts** — add type + fetcher next to `getRegistrySamples`:

```ts
export interface RegistryOrder {
  wp_order_id: number
  order_number: string
  status: string | null
  customer_name: string | null
  customer_email: string | null
  billing: Record<string, string> | null
  shipping: Record<string, string> | null
  wp_created_at: string | null
  wp_paid_at: string | null
}

export async function getRegistryOrders(
  numbers: string[]
): Promise<RegistryOrder[]> {
  if (numbers.length === 0) return []
  const params = new URLSearchParams({ numbers: numbers.slice(0, 100).join(',') })
  const response = await fetch(`${API_BASE_URL()}/registry/orders?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) return []
  const data = (await response.json()) as { orders: RegistryOrder[] }
  return data.orders
}
```

Also extend `SenaiteSample` with `wc_line_item_ids?: number[]` (registry passthrough from Task 2).

- [ ] **Step 2: Write the failing tests** (extend the existing suite; mock `getRegistryOrders` in the `vi.mock('@/lib/api', ...)` factory returning `[{ order_number: 'WP-2001', billing: { city: 'Austin', state: 'TX', country: 'US' }, ... }]`):

```tsx
it('shows the ship-from line in the expanded order detail', async () => {
  renderRich()
  await screen.findByText('WP-2001')
  fireEvent.click(screen.getByRole('button', { name: 'Expand WP-2001' }))
  expect(
    await screen.findByText(/Ships from: Austin, TX US/)
  ).toBeInTheDocument()
})

it('renders a flag button per order row and per expanded sample', async () => {
  renderRich()
  await screen.findByText('WP-2001')
  expect(
    screen.getAllByRole('button', { name: /Raise flag/i }).length
  ).toBeGreaterThan(0)
})
```

(If `RaiseFlagButton`'s accessible name differs, assert on the name it actually renders — read the component first; do not change the component.)

- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement in ReceiveSample.tsx** — ONE batched query, mirroring the expected-vials batch (never per-row):

```tsx
  const orderNumbers = Array.from(
    new Set(
      enriched.map(g => g.orderKey).filter((k): k is string => k != null)
    )
  ).sort()
  const registryOrdersQ = useQuery({
    queryKey: ['registry-orders', orderNumbers.join(',')],
    queryFn: () => getRegistryOrders(orderNumbers),
    enabled: orderNumbers.length > 0,
    staleTime: 60_000,
  })
  const ordersByNumber = new Map(
    (registryOrdersQ.data ?? []).map(o => [o.order_number, o])
  )
```

Pass `registryOrder={group.orderKey ? ordersByNumber.get(group.orderKey) : undefined}` into `OrderListRow`.

- [ ] **Step 5: Implement in OrderListRow.tsx** — accept `registryOrder?: RegistryOrder`; render in the expanded detail row, above the sub-table:

```tsx
{registryOrder?.billing && (
  <p className="pb-1 text-xs text-muted-foreground">
    Ships from: {[registryOrder.billing.city, registryOrder.billing.state]
      .filter(Boolean).join(', ')} {registryOrder.billing.country ?? ''}
  </p>
)}
```

Add `RaiseFlagButton` (import from `@/components/flags/RaiseFlagButton`) in the actions cell next to Process (`entityType="order"`, `entityId={group.orderKey ?? ''}`, `candidates={group.samples}`, compact `variant` if the component offers one — render only when `group.orderKey != null`), and one per expanded sample sub-row (`entityType="sample"`, `entityId={s.id}`).

- [ ] **Step 6: Run** `npx vitest run src/components/intake/__tests__/` and `npx tsc --noEmit` → PASS.
- [ ] **Step 7: Bump version** (minor) in `package.json` + `src-tauri/tauri.conf.json`, add a CHANGELOG entry (Added: order flags on Receive, ship-from line, lims_orders registry + s2s upsert, wc_line_item_ids).
- [ ] **Step 8: Commit** — `feat(order-entity): receive-page flag buttons + ship-from line`.

---

### Task 7: IS — `AccuMk1Adapter.upsert_orders`

**Files:**
- Modify: `integration-service/app/adapters/accumk1.py`
- Test: `integration-service/tests/test_accumk1_upsert_orders.py` (create — mirror the mock-transport idiom of the adapter's existing tests; find them with `grep -rl accumk1 tests/`)

**Interfaces:**
- Consumes: the adapter's existing `__init__` (base_url + service_token) and `X-Service-Token` header helper.
- Produces: `async def upsert_orders(self, orders: list[dict]) -> dict` → POSTs `{"orders": orders}` to `/s2s/orders/upsert`, returns the parsed response — Tasks 8 and 9 call it.

- [ ] **Step 1: Write the failing test** — asserts the method POSTs to `/s2s/orders/upsert` with the `X-Service-Token` header and the `{"orders": [...]}` body, and returns the JSON body on 200; raises (or returns an error marker matching the adapter's existing convention — read a sibling method) on non-2xx.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, mirroring a sibling method's httpx usage exactly:

```python
    async def upsert_orders(self, orders: list[dict]) -> dict:
        """Bulk order upsert (acceptance push + backfill). Idempotent on the
        Mk1 side; callers treat failures as non-fatal (backfill re-converges)."""
        url = f"{self.base_url}/s2s/orders/upsert"
        async with self._client() as client:
            resp = await client.post(url, json={"orders": orders},
                                     headers=self._headers())
            resp.raise_for_status()
            return resp.json()
```

(Use the file's actual client/header helper names — `_client`/`_headers` above are placeholders for whatever `submit_peptide_request` uses; copy its structure line-for-line.)

- [ ] **Step 4: Run test** → PASS. **Step 5: Commit** — `feat(order-entity): AccuMk1 upsert_orders adapter method`.

---

### Task 8: IS — acceptance push from `order_processor`

**Files:**
- Modify: `integration-service/app/services/order_processor.py` (after `sample_results` is persisted for an accepted order)
- Create: `integration-service/app/services/order_upsert.py` (pure builder, unit-testable)
- Test: `integration-service/tests/test_order_upsert_builder.py` (create)

**Interfaces:**
- Consumes: the order payload dict (WP shape: `order_id`, `order_number` bare number, `customer`, `billing`, `shipping` (may be absent on old payloads), `samples[].{number, line_item_ids}`), `sample_results` dict (`{"1": {"senaite_id": "P-2289", ...}}`), `AccuMk1Adapter.upsert_orders` (Task 7).
- Produces: `build_order_upsert(payload: dict, sample_results: dict | None) -> dict` returning the Task 3 wire shape.

- [ ] **Step 1: Write the failing tests** for the pure builder:

```python
from app.services.order_upsert import build_order_upsert


def test_builds_wire_shape_with_line_item_stamps():
    payload = {
        "order_id": 6344, "order_number": "6344", "status": "order-submitted",
        "customer": {"user_id": 3181, "first_name": "Jane", "last_name": "Doe",
                      "user_email": "j@x.com"},
        "billing": {"city": "Austin", "state": "TX", "country": "US"},
        "created_at": "2026-08-19T23:02:46Z", "paid_at": "2026-08-20T00:10:22Z",
        "samples": [{"number": 1, "line_item_ids": [13049]},
                     {"number": 2, "line_item_ids": [13050, 13052]}],
    }
    results = {"1": {"senaite_id": "P-2289"}, "2": {"senaite_id": "P-2290"}}
    out = build_order_upsert(payload, results)
    assert out["wp_order_id"] == 6344
    assert out["order_number"] == "WP-6344"
    assert out["customer"] == {"user_id": 3181, "name": "Jane Doe", "email": "j@x.com"}
    assert out["samples"] == [
        {"senaite_sample_id": "P-2289", "line_item_ids": [13049]},
        {"senaite_sample_id": "P-2290", "line_item_ids": [13050, 13052]},
    ]


def test_tolerates_old_payloads():
    out = build_order_upsert({"order_id": 1, "order_number": "1",
                              "billing": {"city": "X"}, "samples": [{}]}, None)
    assert out["order_number"] == "WP-1"
    assert out["shipping"] is None
    assert out["samples"] == []   # no senaite mapping -> no stamps
```

(Adjust the payload key names to the REAL keys after reading one stored payload — `order_id`/`created_at`/`paid_at` naming must match what `build_order_payload` in wpstar actually emits and what `order_submissions.payload` holds; verify with a `SELECT payload FROM order_submissions LIMIT 1` equivalent in the IS test fixtures or the wpstar source, and fix the test to the truth before implementing.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the builder** (`app/services/order_upsert.py`):

```python
"""Build the Mk1 /s2s/orders/upsert wire dict from a WP payload +
sample_results. Pure — no IO — so the acceptance hook and the backfill
share one tested code path."""


def _wp_number(payload: dict) -> str:
    n = str(payload.get("order_number") or payload.get("order_id") or "")
    return n if n.upper().startswith("WP-") else f"WP-{n}"


def build_order_upsert(payload: dict, sample_results: dict | None) -> dict:
    cust = payload.get("customer") or {}
    name = " ".join(p for p in (cust.get("first_name"), cust.get("last_name")) if p) or None
    results = sample_results or {}
    stamps = []
    for s in payload.get("samples") or []:
        num = s.get("number")
        senaite = (results.get(str(num)) or {}).get("senaite_id")
        items = s.get("line_item_ids") or []
        if senaite and items:
            stamps.append({"senaite_sample_id": senaite,
                           "line_item_ids": [int(i) for i in items]})
    return {
        "wp_order_id": int(payload.get("order_id") or 0),
        "order_number": _wp_number(payload),
        "status": payload.get("status"),
        "customer": {"user_id": cust.get("user_id"), "name": name,
                      "email": cust.get("user_email")} if cust else None,
        "billing": payload.get("billing"),
        "shipping": payload.get("shipping"),
        "wp_created_at": payload.get("created_at"),
        "wp_paid_at": payload.get("paid_at"),
        "samples": stamps,
    }
```

- [ ] **Step 4: Hook it** in `order_processor.py` immediately after `sample_results` is persisted for an accepted order — non-fatal:

```python
        try:
            upsert = build_order_upsert(payload, sample_results)
            await accumk1.upsert_orders([upsert])
        except Exception:
            logger.exception("order upsert push to Mk1 failed (non-fatal; "
                             "backfill re-converges)", extra={"order": upsert.get("order_number")})
```

(Use the module's existing adapter instance/DI and logger names — read the surrounding code and match it.)

- [ ] **Step 5: Run** the builder tests + the order_processor test module the repo already has → PASS.
- [ ] **Step 6: Commit** — `feat(order-entity): acceptance push of order upserts to Mk1`.

---

### Task 9: IS — backfill script

**Files:**
- Create: `integration-service/scripts/backfill_orders_to_mk1.py`
- Test: `integration-service/tests/test_backfill_orders.py` (create — unit-test the batching/`--dry-run` logic with a stubbed adapter + stubbed row iterator; no live DB)

**Interfaces:**
- Consumes: `order_submissions` rows (`payload`, `sample_results`), `build_order_upsert` (Task 8), `AccuMk1Adapter.upsert_orders` (Task 7).
- Produces: `python -m scripts.backfill_orders_to_mk1 [--dry-run] [--batch 50]` run inside the IS container.

- [ ] **Step 1: Write the failing test** — feeds three fake rows through the batch runner with `batch=2`, asserts two adapter calls (`2 + 1` orders) and that `--dry-run` makes zero calls while still reporting the would-be counts.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — async main that pages `order_submissions` by id, maps rows through `build_order_upsert`, chunks, calls `upsert_orders`, prints totals per chunk plus a final `{orders, samples_stamped, samples_missing}` summary; `--dry-run` prints the first built dict and totals without POSTing. Structure the chunk runner as a pure function `run_backfill(rows_iter, adapter, batch, dry_run) -> dict` so the test drives it directly.
- [ ] **Step 4: Run test** → PASS. **Step 5: Commit** — `feat(order-entity): order backfill script`.

---

### Task 10: wpstar — payload `line_item_ids` + `address_2` + `shipping`

**Files:**
- Modify: `wp-content/themes/wpstar/src/Integration/IntegrationService.php` (`build_order_payload`)
- Test: `wp-content/themes/wpstar/tests/phpunit/Integration/OrderEntityPayloadTest.php` (create — mirror the harness style of the existing Integration payload tests)
- Modify: `wp-content/themes/wpstar/style.css` (minor version bump) + `CHANGELOG.md`

**Interfaces:**
- Produces: payload additions exactly as the spec's wire format — Task 8's builder consumes them.

- [ ] **Step 1: Write the failing test** — create a WC order with two line items carrying `_sample_number` metas 1 and 1 (two items, same sample) and one with 2; set billing address incl. `address_2`; set a shipping address; assert `build_order_payload` emits `samples[0]['line_item_ids']` with both ids, `samples[1]['line_item_ids']` with one, `billing['address_2']`, and the `shipping` block; assert `shipping` is `null` when the order has no shipping address.
- [ ] **Step 2: Sync theme files to the DevKinsta checkout and run** `docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && php8.1 vendor/bin/phpunit -c phpunit.xml.dist --filter OrderEntityPayloadTest'` → FAIL.
- [ ] **Step 3: Implement** in `build_order_payload`, before the samples loop:

```php
        // Map sample number -> WC line-item ids via the _sample_number item
        // meta the wizard stamps on every line item (product + service add-ons
        // share the sample number).
        $line_items_by_sample = [];
        foreach ($order->get_items() as $item_id => $item) {
            $num = $item->get_meta('_sample_number');
            if ($num !== '' && $num !== null) {
                $line_items_by_sample[(int) $num][] = (int) $item_id;
            }
        }
```

Inside the per-sample array: `'line_item_ids' => $line_items_by_sample[(int) $sample['number']] ?? [],` (using the loop's actual sample-number variable). In the `billing` block add `'address_2' => sanitize_text_field($order->get_billing_address_1() ? $order->get_billing_address_2() : $order->get_billing_address_2()),` — plainly: `'address_2' => sanitize_text_field($order->get_billing_address_2()),`. After the billing block:

```php
        $shipping = null;
        if ($order->get_shipping_address_1() || $order->get_shipping_city()) {
            $shipping = [
                'company_name' => sanitize_text_field($order->get_shipping_company()),
                'first_name'   => sanitize_text_field($order->get_shipping_first_name()),
                'last_name'    => sanitize_text_field($order->get_shipping_last_name()),
                'address_1'    => sanitize_text_field($order->get_shipping_address_1()),
                'address_2'    => sanitize_text_field($order->get_shipping_address_2()),
                'city'         => sanitize_text_field($order->get_shipping_city()),
                'state'        => sanitize_text_field($order->get_shipping_state()),
                'postcode'     => sanitize_text_field($order->get_shipping_postcode()),
                'country'      => sanitize_text_field($order->get_shipping_country()),
            ];
        }
```

and `'shipping' => $shipping,` in the returned array next to `'billing'`.

- [ ] **Step 4: Run the filtered suite** → PASS; then the FULL suite (same command without `--filter`) → no regressions.
- [ ] **Step 5: Bump version + CHANGELOG**, commit — `feat(order-entity): payload line_item_ids + address_2 + shipping block`.

---

## Self-review notes

- Spec coverage: lims_orders (T1), wc_line_item_ids (T2), S2S upsert (T3), registry read (T4), flags (T5), Receive UI (T6), adapter (T7), acceptance push (T8), backfill (T9), WP payload (T10). Deploy order + backfill run are operational steps in the Global Constraints, executed at ship time.
- Payload key names in Task 8's tests are flagged for verification against a real stored payload before implementation (the one deliberate look-before-you-code step; everything else is pinned).
- Type consistency: `order_number` is `WP-`-prefixed everywhere in Mk1; the IS builder normalizes bare WP numbers via `_wp_number`; `senaite_sample_id`/`line_item_ids` names match across T3/T7/T8/T9.
