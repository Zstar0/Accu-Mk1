# Customer Detail Tabs + Customer Orders Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the customer detail page as a tabbed view with a fully-functional "Customer Orders" tab (with search by Order #, Sample ID, or Analyte) and a placeholder "Dashboard" tab.

**Architecture:** Extend the existing IS `GET /explorer/orders` endpoint with three optional query params (`search_field`, `search_value`, `sort`); add two GIN indexes on `order_submissions` JSONB columns. On the frontend, wrap `CustomerDetailView` in shadcn `Tabs`, add new Zustand state for tab + search, and extend `OrderRow` with optional `defaultExpanded` + `highlightSampleId` props for search-result rendering.

**Tech Stack:** Integration Service (Python 3.11 + FastAPI + SQLAlchemy 2.x + asyncpg + Alembic + pytest), Accu-Mk1 frontend (React 19 + TypeScript + Vite + Zustand v5 + TanStack Query + shadcn/ui v4 + Tailwind v4), Playwright for E2E. Source spec: `docs/superpowers/specs/2026-05-18-customer-detail-tabs-design.md`.

---

## File Structure

### Integration Service (sibling repo: `../integration-service/`)

| File | Status | Responsibility |
|------|--------|----------------|
| `migrations/versions/r6l7m8n9o0p1_add_search_jsonb_indexes.py` | Create | Alembic migration: 2 GIN indexes on `order_submissions.sample_results` and `order_submissions.payload->'line_items'`. CONCURRENTLY. |
| `tests/integration/test_migration_search_jsonb_indexes.py` | Create | Asserts both indexes exist post-upgrade; downgrade removes them. |
| `app/api/desktop.py` | Modify (lines 389-455) | Add `search_field`, `search_value`, `sort` query params; route the three field types to parameterized SQL with `bindparam`. |
| `tests/integration/test_explorer_orders_search.py` | Create | Coverage: 3 search fields × happy path + empty + injection-attempts + 3 sort options + interplay with `customer_id` filter. |

### Accu-Mk1 frontend (this repo)

| File | Status | Responsibility |
|------|--------|----------------|
| `src/store/ui-store.ts` | Modify | Add `customerDetailTab`, `customerOrderSearch` state + `setCustomerDetailTab`, `setCustomerOrderSearch` actions. Extend `navigateToCustomers` to reset both. |
| `src/store/ui-store.test.ts` | Modify | New describe block for customer-detail-tab + customer-order-search actions. |
| `src/lib/api.ts` | Modify (line 1298) | Extend `getExplorerOrdersByCustomer` signature with optional `search` and `sort` params. |
| `src/components/explorer/OrderRow.tsx` | Modify (lines 19-36) | Add optional `defaultExpanded` + `highlightSampleId` props. |
| `src/test/order-row.test.tsx` | Modify | New tests for `defaultExpanded` and `highlightSampleId` behaviors. |
| `src/components/CustomerStatusPage.tsx` | Modify (CustomerDetailView body, ~line 506-852) | Wrap body in `<Tabs>` with `CustomerOrdersTab` + `CustomerDashboardPlaceholder` as new private functions. |
| `src/test/customer-status-page.test.tsx` | Modify | New describe block for tabs + search UI. |
| `e2e/customers.spec.ts` | Modify | Extend with tab switching + search-by-each-field + auto-expand assertions. |

---

## Pre-flight

Before Task 1, verify:

- [ ] Working directory: `Accu-Mk1` repo, branch `feat/customer-status` (or a new branch off it, e.g., `feat/customer-tabs`).
- [ ] Integration Service repo is at `../integration-service/` (sibling of Accu-Mk1).
- [ ] `npm install` ran in Accu-Mk1 if dependencies changed.
- [ ] IS dependencies installed (`pip install -e ".[dev]"` in integration-service).
- [ ] IS Postgres reachable: `docker ps | grep accumark_postgres` returns a running container.

---

## Task 1: IS Alembic migration — 2 GIN indexes on order_submissions

**Files:**
- Create: `../integration-service/migrations/versions/r6l7m8n9o0p1_add_search_jsonb_indexes.py`
- Create: `../integration-service/tests/integration/test_migration_search_jsonb_indexes.py`

- [ ] **Step 1: Write the migration test (RED)**

Create `../integration-service/tests/integration/test_migration_search_jsonb_indexes.py`:

```python
"""Integration test for migration r6l7m8n9o0p1_add_search_jsonb_indexes.

Verifies both GIN indexes exist after upgrade, are removed by downgrade,
and that re-upgrade is idempotent.
"""
import pytest
from sqlalchemy import text

from app.db.base import async_engine


pytestmark = pytest.mark.asyncio


INDEX_NAMES = [
    "idx_order_submissions_sample_results_gin",
    "idx_order_submissions_line_items_gin",
]


async def _index_exists(conn, name: str) -> bool:
    result = await conn.execute(
        text(
            "SELECT 1 FROM pg_indexes "
            "WHERE schemaname = 'public' AND indexname = :name"
        ),
        {"name": name},
    )
    return result.scalar() is not None


@pytest.mark.alembic
async def test_both_indexes_exist_after_upgrade():
    """After migration runs, both GIN indexes are present."""
    async with async_engine.connect() as conn:
        for name in INDEX_NAMES:
            assert await _index_exists(conn, name), f"index {name} missing"


@pytest.mark.alembic
async def test_indexes_use_jsonb_path_ops_opclass():
    """Indexes use jsonb_path_ops operator class (smaller index, path-only queries)."""
    async with async_engine.connect() as conn:
        for name in INDEX_NAMES:
            result = await conn.execute(
                text(
                    "SELECT indexdef FROM pg_indexes "
                    "WHERE indexname = :name"
                ),
                {"name": name},
            )
            indexdef = result.scalar()
            assert indexdef is not None
            assert "jsonb_path_ops" in indexdef, (
                f"{name} should use jsonb_path_ops; got: {indexdef}"
            )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../integration-service && pytest tests/integration/test_migration_search_jsonb_indexes.py -v`

Expected: FAIL — `index idx_order_submissions_sample_results_gin missing` (migration not yet authored).

- [ ] **Step 3: Write the migration**

Create `../integration-service/migrations/versions/r6l7m8n9o0p1_add_search_jsonb_indexes.py`:

```python
"""Add GIN indexes for customer-orders search

Revision ID: r6l7m8n9o0p1
Revises: q5l6m7n8o9p0
Create Date: 2026-05-18

Adds two GIN indexes on order_submissions JSONB columns to support
the customer-orders search feature (sample_id and analyte search).

Both indexes use jsonb_path_ops operator class — smaller than the default
jsonb_ops, sufficient for containment + jsonpath queries which is all we
issue.

Indexes created CONCURRENTLY for online deployment safety. CONCURRENTLY
cannot run inside a transaction, so this migration uses op.execute with
an explicit COMMIT in autocommit mode.
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "r6l7m8n9o0p1"
down_revision = "q5l6m7n8o9p0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # CONCURRENTLY requires autocommit; disable the alembic-managed transaction.
    connection = op.get_bind()
    connection.execute("COMMIT")
    op.execute(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS "
        "idx_order_submissions_sample_results_gin "
        "ON order_submissions USING GIN (sample_results jsonb_path_ops)"
    )
    op.execute(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS "
        "idx_order_submissions_line_items_gin "
        "ON order_submissions USING GIN ((payload -> 'line_items') jsonb_path_ops)"
    )


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute("COMMIT")
    op.execute("DROP INDEX CONCURRENTLY IF EXISTS idx_order_submissions_sample_results_gin")
    op.execute("DROP INDEX CONCURRENTLY IF EXISTS idx_order_submissions_line_items_gin")
```

**Note on CONCURRENTLY in Alembic:** because Alembic wraps migrations in a transaction by default and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, we issue an explicit `COMMIT` first. If the existing IS migrations use `alembic.context.is_offline_mode()` or a `with_transaction = False` config, follow that pattern instead — check the latest migration `q5l6m7n8o9p0_add_order_customer_link.py` for the project's convention. If the project uses transactional migrations for everything, you may need to drop `CONCURRENTLY` and accept a brief table-level lock on this small table.

- [ ] **Step 4: Apply migration**

Run: `cd ../integration-service && alembic upgrade head`

Expected output: `Running upgrade q5l6m7n8o9p0 -> r6l7m8n9o0p1, Add GIN indexes for customer-orders search`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ../integration-service && pytest tests/integration/test_migration_search_jsonb_indexes.py -v`

Expected: 2 passed.

- [ ] **Step 6: Verify downgrade works**

Run:
```bash
cd ../integration-service
alembic downgrade -1
psql -h localhost -U postgres -d accumark_integration -c "\d order_submissions" | grep -E "idx_order_submissions_(sample_results|line_items)_gin"
alembic upgrade head
```

Expected: After `downgrade -1`, the grep returns nothing (indexes gone). After `upgrade head`, indexes return.

- [ ] **Step 7: Commit**

```bash
cd ../integration-service
git add migrations/versions/r6l7m8n9o0p1_add_search_jsonb_indexes.py tests/integration/test_migration_search_jsonb_indexes.py
git commit -m "feat(search): add GIN indexes on order_submissions JSONB for customer-orders search

Adds two GIN indexes with jsonb_path_ops opclass:
- idx_order_submissions_sample_results_gin (per-position senaite_id lookups)
- idx_order_submissions_line_items_gin (analyte/product-name lookups)

CONCURRENTLY-created. Supports Task 2 endpoint extension.
Migration test verifies both exist post-upgrade and use jsonb_path_ops."
```

---

## Task 2: IS endpoint extension — search_field, search_value, sort on /explorer/orders

**Files:**
- Modify: `../integration-service/app/api/desktop.py:389-455` (the `get_desktop_orders` function)
- Create: `../integration-service/tests/integration/test_explorer_orders_search.py`

- [ ] **Step 1: Write the failing test (RED)**

Create `../integration-service/tests/integration/test_explorer_orders_search.py`:

```python
"""Integration tests for GET /explorer/orders search_field / search_value / sort params.

These extend the existing /explorer/orders endpoint (Phase 28 LINK-07) with
three search fields and three sort options. Tests fixture data into a clean
test DB, then exercises each field + each sort + injection attempts.
"""
import pytest
from httpx import AsyncClient


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def customer_with_orders(test_db):
    """Seed: 1 customer, 3 orders. Order shapes designed to exercise all 3 search fields.

    Order #1: order_number=ORD-3001, samples [P-0001 BPC-157, P-0002 GHRP-6]
    Order #2: order_number=ORD-3002, samples [P-0003 NAD+]
    Order #3: order_number=ORD-3003, samples [P-0004 BPC-157] — analyte collision with #1
    """
    from app.models.persistence import WCCustomer, OrderSubmissionRecord

    customer = WCCustomer(id=555, email="test@example.com", display_name="Test")
    test_db.add(customer)
    await test_db.flush()

    orders = [
        OrderSubmissionRecord(
            order_id="3001",
            order_number="ORD-3001",
            payload={"line_items": [{"name": "BPC-157 5mg"}, {"name": "GHRP-6 5mg"}]},
            sample_results={"1": {"senaite_id": "P-0001", "status": "created"},
                            "2": {"senaite_id": "P-0002", "status": "created"}},
            customer_id=555,
            status="accepted",
        ),
        OrderSubmissionRecord(
            order_id="3002",
            order_number="ORD-3002",
            payload={"line_items": [{"name": "NAD+ 100mg"}]},
            sample_results={"1": {"senaite_id": "P-0003", "status": "created"}},
            customer_id=555,
            status="accepted",
        ),
        OrderSubmissionRecord(
            order_id="3003",
            order_number="ORD-3003",
            payload={"line_items": [{"name": "BPC-157 10mg"}]},
            sample_results={"1": {"senaite_id": "P-0004", "status": "created"}},
            customer_id=555,
            status="accepted",
        ),
    ]
    for o in orders:
        test_db.add(o)
    await test_db.commit()
    return {"customer_id": 555, "order_ids": ["3001", "3002", "3003"]}


# ---------- Happy path: each search_field ----------

async def test_search_by_order_number_substring(client: AsyncClient, customer_with_orders):
    """search_field=order_number does ILIKE substring match on order_number column."""
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "order_number", "search_value": "3002"},
    )
    assert r.status_code == 200
    orders = r.json()
    assert len(orders) == 1
    assert orders[0]["order_number"] == "ORD-3002"


async def test_search_by_sample_id_exact_match(client: AsyncClient, customer_with_orders):
    """search_field=sample_id matches the order containing that senaite_id exactly."""
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "sample_id", "search_value": "P-0001"},
    )
    assert r.status_code == 200
    orders = r.json()
    assert len(orders) == 1
    assert orders[0]["order_number"] == "ORD-3001"


async def test_search_by_sample_id_partial_returns_nothing(client: AsyncClient, customer_with_orders):
    """Sample-ID search is exact-match — partial 'P-000' returns no results."""
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "sample_id", "search_value": "P-000"},
    )
    assert r.status_code == 200
    assert r.json() == []


async def test_search_by_analyte_returns_all_matching_orders(client: AsyncClient, customer_with_orders):
    """search_field=analyte does case-insensitive regex substring against line_items[*].name."""
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "analyte", "search_value": "BPC-157"},
    )
    assert r.status_code == 200
    orders = r.json()
    assert len(orders) == 2
    nums = {o["order_number"] for o in orders}
    assert nums == {"ORD-3001", "ORD-3003"}


async def test_search_by_analyte_case_insensitive(client: AsyncClient, customer_with_orders):
    """Analyte search ignores case."""
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "analyte", "search_value": "bpc-157"},
    )
    assert r.status_code == 200
    assert len(r.json()) == 2


# ---------- Sort options ----------

async def test_sort_open_first_default(client: AsyncClient, customer_with_orders, test_db):
    """sort=open_first (default) places orders with completed_at NULL first."""
    # Complete order #1 to differentiate
    from sqlalchemy import update
    from app.models.persistence import OrderSubmissionRecord
    from datetime import datetime, timezone
    await test_db.execute(
        update(OrderSubmissionRecord)
        .where(OrderSubmissionRecord.order_number == "ORD-3001")
        .values(completed_at=datetime.now(timezone.utc))
    )
    await test_db.commit()

    r = await client.get("/explorer/orders", params={"customer_id": 555})
    assert r.status_code == 200
    orders = r.json()
    # ORD-3002 and ORD-3003 are open → they come first; ORD-3001 is completed
    assert orders[-1]["order_number"] == "ORD-3001"


async def test_sort_date_desc(client: AsyncClient, customer_with_orders):
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "sort": "date_desc"},
    )
    assert r.status_code == 200
    orders = r.json()
    created_at = [o["created_at"] for o in orders]
    assert created_at == sorted(created_at, reverse=True)


async def test_sort_date_asc(client: AsyncClient, customer_with_orders):
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "sort": "date_asc"},
    )
    assert r.status_code == 200
    orders = r.json()
    created_at = [o["created_at"] for o in orders]
    assert created_at == sorted(created_at)


async def test_sort_invalid_value_returns_422(client: AsyncClient, customer_with_orders):
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "sort": "bogus"},
    )
    assert r.status_code == 422


# ---------- Bind-param injection attempts ----------

@pytest.mark.parametrize("malicious", [
    "'; DROP TABLE order_submissions; --",
    "P-0001' OR '1'='1",
    "1) ?(@.senaite_id == \"P-0001\")) || true || (",
    "%' --",
])
async def test_search_value_injection_safe(client: AsyncClient, customer_with_orders, malicious):
    """Injection attempts return safe results (empty or no match), never error stacks."""
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "sample_id", "search_value": malicious},
    )
    assert r.status_code == 200, f"got {r.status_code}: {r.text}"
    # Empty result is expected — none of these are real sample IDs
    assert r.json() == []


# ---------- Combination with existing customer_id filter ----------

async def test_search_respects_customer_id_filter(client: AsyncClient, customer_with_orders, test_db):
    """Search within customer_id=X does NOT return orders from customer Y."""
    from app.models.persistence import WCCustomer, OrderSubmissionRecord
    # Add a second customer with a sample whose ID collides... wait, sample IDs unique
    # Instead: add another customer with an order that has the same analyte
    other = WCCustomer(id=666, email="other@example.com", display_name="Other")
    test_db.add(other)
    test_db.add(OrderSubmissionRecord(
        order_id="4000",
        order_number="ORD-4000",
        payload={"line_items": [{"name": "BPC-157 50mg"}]},
        sample_results={"1": {"senaite_id": "P-9999", "status": "created"}},
        customer_id=666,
        status="accepted",
    ))
    await test_db.commit()

    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "analyte", "search_value": "BPC-157"},
    )
    assert r.status_code == 200
    orders = r.json()
    nums = {o["order_number"] for o in orders}
    assert nums == {"ORD-3001", "ORD-3003"}, "must not include ORD-4000 from customer 666"


# ---------- Missing/empty search_value ----------

async def test_search_field_without_value_returns_400(client: AsyncClient, customer_with_orders):
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "sample_id"},
    )
    assert r.status_code == 400
    assert "search_value" in r.json()["detail"].lower()


async def test_empty_search_value_returns_all_orders(client: AsyncClient, customer_with_orders):
    """search_value='' is treated as no-search and returns the full unfiltered list."""
    r = await client.get(
        "/explorer/orders",
        params={"customer_id": 555, "search_field": "sample_id", "search_value": ""},
    )
    assert r.status_code == 200
    assert len(r.json()) == 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../integration-service && pytest tests/integration/test_explorer_orders_search.py -v`

Expected: All tests fail (endpoint doesn't yet accept `search_field` or `sort` params, so they're silently ignored, and assertions on filtered results fail).

- [ ] **Step 3: Modify the endpoint**

Open `../integration-service/app/api/desktop.py`. At line 389-455 (the `get_desktop_orders` function), modify per the diff below.

Add imports at the top of the file if not already present:
```python
from sqlalchemy import or_, text, bindparam
from fastapi import HTTPException
```

Replace the function signature and body:

```python
ALLOWED_SEARCH_FIELDS = {"order_number", "sample_id", "analyte"}
ALLOWED_SORTS = {"open_first", "date_desc", "date_asc"}


@router.get(
    "/orders",
    response_model=list[ExplorerOrderResponse],
    summary="Get orders",
    description="Fetch orders from order_submissions table with optional search and pagination.",
)
async def get_desktop_orders(
    api_key: str = Depends(verify_desktop_api_key),
    db: AsyncSession = Depends(get_db),
    search: str | None = Query(None, description="Legacy: filter by order_id or order_number"),
    status_filter: str | None = Query(None, alias="status", description="Filter by status"),
    customer_id: int | None = Query(None, description="Filter to a specific customer (LINK-07)"),
    search_field: str | None = Query(
        None,
        description="Field to search: order_number | sample_id | analyte",
    ),
    search_value: str | None = Query(
        None,
        max_length=256,  # T-30-02 DoS mitigation — bound jsonpath input length
        description="Value to match (semantics differ per search_field)",
    ),
    sort: str = Query(
        "open_first",
        description="Sort order: open_first | date_desc | date_asc",
    ),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> list[ExplorerOrderResponse]:
    """Fetch orders with optional search, status filter, and pagination."""

    logger.info(
        "desktop_orders_request",
        search=search, status=status_filter, customer_id=customer_id,
        search_field=search_field, search_value_len=len(search_value) if search_value else 0,
        sort=sort, limit=limit, offset=offset,
    )

    # Validate enums
    if search_field is not None and search_field not in ALLOWED_SEARCH_FIELDS:
        raise HTTPException(
            status_code=422,
            detail=f"search_field must be one of {sorted(ALLOWED_SEARCH_FIELDS)}",
        )
    if sort not in ALLOWED_SORTS:
        raise HTTPException(
            status_code=422,
            detail=f"sort must be one of {sorted(ALLOWED_SORTS)}",
        )
    if search_field is not None and search_value is None:
        raise HTTPException(
            status_code=400,
            detail="search_value is required when search_field is set",
        )

    # Build base filter conditions (existing behavior preserved)
    conditions = []

    # Legacy `search` param — preserved for back-compat with existing callers.
    if search:
        legacy_term = f"%{search}%"
        conditions.append(
            or_(
                OrderSubmissionRecord.order_id.ilike(legacy_term),
                OrderSubmissionRecord.order_number.ilike(legacy_term),
            )
        )

    if status_filter:
        conditions.append(OrderSubmissionRecord.status == status_filter)

    if customer_id is not None:
        conditions.append(OrderSubmissionRecord.customer_id == customer_id)

    # New search_field/search_value handling. Empty string = no-search (back-compat with
    # frontend that may send '' before debounce/min-char gate kicks in).
    if search_field is not None and search_value:
        if search_field == "order_number":
            pattern = f"%{search_value}%"
            conditions.append(OrderSubmissionRecord.order_number.ilike(pattern))
        elif search_field == "sample_id":
            # T-30-01: bind value via :val. jsonpath uses $val internally.
            conditions.append(
                text(
                    "sample_results @@ "
                    "('$.* ? (@.senaite_id == \"' || :sample_id_val || '\")')::jsonpath"
                ).bindparams(bindparam("sample_id_val", value=search_value, literal_execute=False))
            )
            # NOTE: above uses string concat at SQL level which is acceptable ONLY because
            # asyncpg binds the value as a TEXT literal before concat; however, safer is
            # the jsonpath_query approach below. Use whichever the team's SQL review prefers.
            #
            # Safer alternative (recommended): use jsonb_path_exists with a constant jsonpath
            # and a vars parameter:
            #   conditions.append(text(
            #       "jsonb_path_exists(sample_results, '$.* ? (@.senaite_id == $v)', "
            #       "jsonb_build_object('v', :sample_id_val))"
            #   ).bindparams(bindparam("sample_id_val", value=search_value)))
            # The jsonb_path_exists form fully parameterizes the value without touching the
            # jsonpath string. PREFER THIS in implementation.
        elif search_field == "analyte":
            # T-30-01: same bindparam discipline. Analyte = case-insensitive substring.
            conditions.append(
                text(
                    "jsonb_path_exists(payload->'line_items', "
                    "'$[*].name ? (@ like_regex $v flag \"i\")', "
                    "jsonb_build_object('v', :analyte_val))"
                ).bindparams(bindparam("analyte_val", value=search_value))
            )

    # Build query
    query = select(OrderSubmissionRecord)
    for condition in conditions:
        query = query.where(condition)

    # Sort
    if sort == "open_first":
        query = query.order_by(
            OrderSubmissionRecord.completed_at.is_(None).desc(),
            OrderSubmissionRecord.created_at.desc(),
        )
    elif sort == "date_desc":
        query = query.order_by(OrderSubmissionRecord.created_at.desc())
    elif sort == "date_asc":
        query = query.order_by(OrderSubmissionRecord.created_at.asc())

    query = query.limit(limit).offset(offset)

    result = await db.execute(query)
    orders = result.scalars().all()

    return [
        ExplorerOrderResponse(
            id=str(order.id),
            order_id=order.order_id,
            order_number=order.order_number,
            status=order.status,
            samples_expected=order.samples_expected,
            samples_delivered=order.samples_delivered,
            error_message=order.error_message,
            payload=order.payload,
            sample_results=order.sample_results,
            created_at=order.created_at,
            updated_at=order.updated_at,
            completed_at=order.completed_at,
            wp_order_status=order.wp_order_status,
            customer_id=order.customer_id,
        )
        for order in orders
    ]
```

**Pick the jsonb_path_exists form** for both sample_id and analyte queries (the "safer alternative" path in the sample_id block). The string-concat-at-SQL-level form for sample_id is included only as a reference; implementer must use `jsonb_path_exists` with `jsonb_build_object` for both.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../integration-service && pytest tests/integration/test_explorer_orders_search.py -v`

Expected: All tests pass (15+ tests green).

- [ ] **Step 5: Verify GIN index is used (EXPLAIN check)**

Run:
```bash
docker exec accumark_postgres psql -U postgres -d accumark_integration -c "
EXPLAIN (FORMAT TEXT)
SELECT id FROM order_submissions
WHERE jsonb_path_exists(sample_results, '$.* ? (@.senaite_id == \$v)', jsonb_build_object('v', 'P-0001'));
"
```

Expected output includes: `Bitmap Index Scan on idx_order_submissions_sample_results_gin`. If you see `Seq Scan`, the GIN index isn't being used — verify the migration ran (Task 1) and the table has enough rows for Postgres's planner to prefer the index (run `ANALYZE order_submissions;` if needed).

- [ ] **Step 6: Verify back-compat — existing /explorer/orders calls still work**

Run: `cd ../integration-service && pytest tests/integration/test_explorer_orders.py -v`

Expected: All existing tests still pass (the legacy `search` param keeps its old behavior; `customer_id` filter unchanged).

- [ ] **Step 7: Commit**

```bash
cd ../integration-service
git add app/api/desktop.py tests/integration/test_explorer_orders_search.py
git commit -m "feat(search): add search_field/search_value/sort params to /explorer/orders

Three new optional query params:
- search_field: order_number | sample_id | analyte
- search_value: max 256 chars (T-30-02 DoS mitigation)
- sort: open_first (default) | date_desc | date_asc

Sample-ID search uses jsonb_path_exists with jsonb_build_object to fully
parameterize the search value (T-30-01 SQL injection mitigation). Analyte
uses case-insensitive jsonpath regex against payload->line_items[*].name.

Both jsonb queries use the GIN indexes added in r6l7m8n9o0p1.
Legacy 'search' param preserved for back-compat with existing Mk1 callers."
```

---

## Task 3: Zustand store — customerDetailTab + customerOrderSearch

**Files:**
- Modify: `src/store/ui-store.ts`
- Modify: `src/store/ui-store.test.ts`

- [ ] **Step 1: Write the failing test (RED)**

Open `src/store/ui-store.test.ts`. Add this describe block at the end of the file:

```typescript
describe('UIStore customer detail tabs + order search', () => {
  beforeEach(() => {
    useUIStore.setState(useUIStore.getInitialState())
  })

  it('has correct customer-detail-tab initial state', () => {
    const state = useUIStore.getState()
    expect(state.customerDetailTab).toBe('orders')
    expect(state.customerOrderSearch).toEqual({ field: null, value: '' })
  })

  it('setCustomerDetailTab writes the tab field', () => {
    useUIStore.getState().setCustomerDetailTab('dashboard')
    expect(useUIStore.getState().customerDetailTab).toBe('dashboard')
  })

  it('setCustomerOrderSearch writes both field and value atomically', () => {
    useUIStore.getState().setCustomerOrderSearch({
      field: 'sample_id',
      value: 'P-0001',
    })
    const state = useUIStore.getState()
    expect(state.customerOrderSearch).toEqual({
      field: 'sample_id',
      value: 'P-0001',
    })
  })

  it('navigateToCustomers clears customerDetailTab and customerOrderSearch', () => {
    // Seed both fields with non-default values
    useUIStore.setState({
      customerDetailTab: 'dashboard',
      customerOrderSearch: { field: 'analyte', value: 'BPC-157' },
    })
    useUIStore.getState().navigateToCustomers()
    const state = useUIStore.getState()
    expect(state.customerDetailTab).toBe('orders')
    expect(state.customerOrderSearch).toEqual({ field: null, value: '' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/store/ui-store.test.ts`

Expected: FAIL — `customerDetailTab is undefined`, `setCustomerDetailTab is not a function`, etc.

- [ ] **Step 3: Modify ui-store.ts**

Open `src/store/ui-store.ts`. Locate the `UIState` interface and the `navigateToCustomers` action.

Add to the `UIState` interface:

```typescript
// Customer detail page — Phase 30
customerDetailTab: 'orders' | 'dashboard'
customerOrderSearch: {
  field: 'order_number' | 'sample_id' | 'analyte' | null
  value: string
}
setCustomerDetailTab: (tab: 'orders' | 'dashboard') => void
setCustomerOrderSearch: (next: {
  field: 'order_number' | 'sample_id' | 'analyte' | null
  value: string
}) => void
```

Add to the initial-state object (alongside `customerListPage`, `hideTestAccounts`, etc.):

```typescript
customerDetailTab: 'orders',
customerOrderSearch: { field: null, value: '' },
```

Add new action implementations inside the `create<UIState>` body, near the other `customer*` actions:

```typescript
setCustomerDetailTab: (tab) =>
  set({ customerDetailTab: tab }, false, 'setCustomerDetailTab'),

setCustomerOrderSearch: (next) =>
  set({ customerOrderSearch: next }, false, 'setCustomerOrderSearch'),
```

Locate the existing `navigateToCustomers` action — extend its `set()` payload to also clear the new fields:

```typescript
navigateToCustomers: () =>
  set(
    state => ({
      activeSection: 'accumark-tools',
      activeSubSection: 'customers',
      customerDetailTargetId: null,
      // NEW: reset customer-detail page state when going back to list
      customerDetailTab: 'orders',
      customerOrderSearch: { field: null, value: '' },
      navigationKey: state.navigationKey + 1,
    }),
    false,
    'navigateToCustomers'
  ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/store/ui-store.test.ts`

Expected: All 11+ tests pass (4 new + existing).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/ui-store.ts src/store/ui-store.test.ts
git commit -m "feat(store): add customerDetailTab + customerOrderSearch state

Two new UIState fields with their setters:
- customerDetailTab: 'orders' | 'dashboard' (default 'orders')
- customerOrderSearch: { field, value } (atomic dual-write, mirrors Phase 29
  setSearchAndResetPage pattern)

navigateToCustomers extended to reset both new fields, preventing
search/tab state from leaking across customer drill-throughs (T-30-03)."
```

---

## Task 4: API client — extend getExplorerOrdersByCustomer signature

**Files:**
- Modify: `src/lib/api.ts` (around line 1298)

This task has no dedicated unit test — the function is exercised through the component tests in Tasks 6 and 7. Typecheck is the gate.

- [ ] **Step 1: Read current signature**

Run: `npm exec grep -- -n "export async function getExplorerOrdersByCustomer" src/lib/api.ts`

Read the function at the line returned (~1298-1326). Note the existing signature: `customerId, page, perPage`.

- [ ] **Step 2: Modify the function**

Replace the function with:

```typescript
export async function getExplorerOrdersByCustomer(
  customerId: number,
  search?: {
    field: 'order_number' | 'sample_id' | 'analyte'
    value: string
  },
  sort: 'open_first' | 'date_desc' | 'date_asc' = 'open_first',
  page = 0,
  perPage = 50
): Promise<ExplorerOrder[]> {
  try {
    const params = new URLSearchParams()
    params.set('customer_id', String(customerId))
    params.set('limit', String(perPage))
    params.set('offset', String(page * perPage))
    params.set('sort', sort)
    if (search && search.value.length >= 2) {
      // Spec: 2-char minimum gate prevents "no results" flicker during typing
      params.set('search_field', search.field)
      params.set('search_value', search.value)
    }

    const res = await fetch(
      `${API_BASE_URL()}/explorer/orders?${params.toString()}`,
      { headers: getAuthHeaders() }
    )
    if (res.status === 401) {
      throw new Error('API key required or invalid')
    }
    if (!res.ok) {
      throw new Error(`Get explorer orders by customer failed: ${res.status}`)
    }
    return (await res.json()) as ExplorerOrder[]
  } catch (error) {
    console.error('getExplorerOrdersByCustomer error:', error)
    throw error
  }
}
```

- [ ] **Step 3: Verify back-compat — existing callers still compile**

Run: `npm run typecheck`

Expected: 0 errors. The function's new params are all optional with defaults, so the existing call in `CustomerStatusPage.tsx` (passes only `customerDetailTargetId`) continues to compile.

- [ ] **Step 4: Run all unit tests to confirm no regression**

Run: `npm run test:run`

Expected: All existing tests pass (no behavior change for callers that don't pass new params).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): extend getExplorerOrdersByCustomer with search + sort

Adds optional search ({field, value}) and sort params to the API client.
2-char minimum gate on search.value before search params are sent to
backend — prevents 'no results' flicker during partial typing for the
exact-match sample_id search.

Defaults preserve back-compat: sort='open_first', no search."
```

---

## Task 5: OrderRow — defaultExpanded + highlightSampleId props

**Files:**
- Modify: `src/components/explorer/OrderRow.tsx` (lines 19-36)
- Modify: `src/test/order-row.test.tsx`

- [ ] **Step 1: Write the failing tests (RED)**

Open `src/test/order-row.test.tsx`. Add at the end of the existing describe block:

```typescript
describe('OrderRow — search-result props (Phase 30)', () => {
  it('defaults to collapsed when defaultExpanded is undefined', async () => {
    const order = makeOrderWithSamples([{ senaite_id: 'P-0001', status: 'created' }])
    render(<OrderRow order={order} wordpressHost="https://wp" sampleLookupMap={new Map()} activeAnalysisStates={[]} />)
    // Sample cards are not visible (need to be expanded)
    expect(screen.queryByText('P-0001')).not.toBeInTheDocument()
  })

  it('renders pre-expanded when defaultExpanded=true', async () => {
    const order = makeOrderWithSamples([{ senaite_id: 'P-0001', status: 'created' }])
    render(<OrderRow order={order} wordpressHost="https://wp" sampleLookupMap={new Map()} activeAnalysisStates={[]} defaultExpanded={true} />)
    // Sample cards visible without user click
    expect(await screen.findByText(/P-0001/)).toBeInTheDocument()
  })

  it('applies ring-2 ring-primary class to SampleCard with matching highlightSampleId', async () => {
    const order = makeOrderWithSamples([
      { senaite_id: 'P-0001', status: 'created' },
      { senaite_id: 'P-0002', status: 'created' },
    ])
    render(<OrderRow order={order} wordpressHost="https://wp" sampleLookupMap={new Map()} activeAnalysisStates={[]} defaultExpanded={true} highlightSampleId="P-0001" />)

    const highlighted = await screen.findByTestId('sample-card-P-0001')
    expect(highlighted.className).toMatch(/ring-2/)
    expect(highlighted.className).toMatch(/ring-primary/)

    const notHighlighted = await screen.findByTestId('sample-card-P-0002')
    expect(notHighlighted.className).not.toMatch(/ring-2/)
  })
})

// Helper — adjust to whatever fixture pattern the existing tests use
function makeOrderWithSamples(samples: Array<{ senaite_id: string; status: string }>) {
  const sample_results: Record<string, { senaite_id: string; status: string }> = {}
  samples.forEach((s, i) => { sample_results[String(i + 1)] = s })
  return {
    id: 'test-uuid',
    order_id: '1234',
    order_number: 'ORD-1234',
    status: 'accepted',
    sample_results,
    payload: { billing: { email: 'test@example.com' } },
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    completed_at: null,
  } as ExplorerOrder
}
```

If `SampleCard` doesn't currently render with a `data-testid`, that's part of this task — extend `SampleCard` to set `data-testid={\`sample-card-${sampleId}\`}` on its root element. The test references this testid.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:run -- src/test/order-row.test.tsx`

Expected: 3 new tests fail (props don't exist, no `data-testid`).

- [ ] **Step 3: Modify OrderRow.tsx**

Open `src/components/explorer/OrderRow.tsx`. Change the function signature and body — current expansion uses internal `useState`; we need it to accept a default and propagate the highlight.

Locate the inline type at lines 24-35 (`{ order, wordpressHost, ... }: { order: ExplorerOrder, ... }`). Add two optional props:

```typescript
export function OrderRow({
  order,
  wordpressHost,
  sampleLookupMap,
  activeAnalysisStates,
  defaultExpanded,
  highlightSampleId,
}: {
  order: ExplorerOrder
  wordpressHost: string
  sampleLookupMap: Map<
    string,
    {
      data?: SenaiteLookupResult
      isLoading: boolean
      isError: boolean
    }
  >
  activeAnalysisStates: string[]
  defaultExpanded?: boolean
  highlightSampleId?: string
}) {
```

Find the existing `useState` for expansion (search for `useState` in this file — there should be one for whether the row is expanded). Change it to:

```typescript
const [isExpanded, setIsExpanded] = useState(defaultExpanded ?? false)
```

Find the JSX that renders `<SampleCard>` for each sample. Add the highlight class prop (which SampleCard accepts as a className override or a dedicated prop — see Step 4):

```tsx
<SampleCard
  key={s.senaiteId}
  sampleId={s.senaiteId}
  lookup={lookup?.data}
  isLoading={lookup?.isLoading ?? false}
  isError={lookup?.isError ?? false}
  className={cn(
    /* existing classes if any */,
    highlightSampleId === s.senaiteId && 'ring-2 ring-primary ring-offset-2'
  )}
/>
```

- [ ] **Step 4: Modify SampleCard.tsx to accept className**

Open `src/components/explorer/SampleCard.tsx`. The current signature accepts `sampleId, lookup, isLoading, isError`. Add an optional `className` prop and `data-testid` for the tests:

```typescript
export function SampleCard({
  sampleId,
  lookup,
  isLoading,
  isError,
  className,
}: {
  sampleId: string
  lookup: SenaiteLookupResult | undefined
  isLoading: boolean
  isError: boolean
  className?: string
}) {
  // ... existing logic ...
  return (
    <div
      data-testid={`sample-card-${sampleId}`}
      className={cn(
        /* existing classes */,
        className,  // append at end so caller can override
      )}
    >
      {/* existing JSX */}
    </div>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:run -- src/test/order-row.test.tsx src/test/sample-card.test.tsx`

Expected: All tests pass (3 new + existing 4 each).

- [ ] **Step 6: Typecheck and scoped lint**

Run:
```bash
npm run typecheck
npx eslint src/components/explorer/OrderRow.tsx src/components/explorer/SampleCard.tsx src/test/order-row.test.tsx --max-warnings 0
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/explorer/OrderRow.tsx src/components/explorer/SampleCard.tsx src/test/order-row.test.tsx
git commit -m "feat(explorer): OrderRow + SampleCard support search-result rendering

Two optional new props on OrderRow:
- defaultExpanded?: boolean — initial expansion state (search-result auto-open)
- highlightSampleId?: string — adds ring-2 ring-primary to matching SampleCard

SampleCard gains optional className prop (appended last so caller wins) and a
data-testid={sample-card-<id>} for query targeting.

Existing OrderStatusPage call site unchanged — all new props default to
undefined which preserves current behavior."
```

---

## Task 6: CustomerDetailView — wrap in Tabs with placeholder Dashboard

**Files:**
- Modify: `src/components/CustomerStatusPage.tsx` (CustomerDetailView body, ~lines 506-852)
- Modify: `src/test/customer-status-page.test.tsx`

This task restructures `CustomerDetailView` so its body content lives inside `<TabsContent value="orders">` (existing behavior, no UX change) and adds a placeholder `<TabsContent value="dashboard">`. The persistent header card stays above the Tabs. No search functionality yet — that's Task 7.

- [ ] **Step 1: Write the failing tests (RED)**

Open `src/test/customer-status-page.test.tsx`. Add at the end:

```typescript
describe('CustomerStatusPage — detail view tabs (Phase 30)', () => {
  beforeEach(async () => {
    state.activeSection = 'accumark-tools'
    state.activeSubSection = 'customer-detail'
    state.customerDetailTargetId = 42
    state.customerDetailTab = 'orders'
    state.customerOrderSearch = { field: null, value: '' }
    vi.mocked(getExplorerStatus).mockResolvedValue({ connected: true })
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
  })

  it('renders the persistent header card above the tabs list', async () => {
    const { CustomerStatusPage } = await import('@/components/CustomerStatusPage')
    renderDetailWithCache(makeCustomer({ customer_id: 42, display_name: 'Test' }))

    const header = await screen.findByText('Test')
    const tabsList = await screen.findByRole('tablist')
    // Header appears earlier in DOM order than tab list
    expect(header.compareDocumentPosition(tabsList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders both Customer Orders and Dashboard tabs', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(await screen.findByRole('tab', { name: 'Customer Orders' })).toBeInTheDocument()
    expect(await screen.findByRole('tab', { name: 'Dashboard' })).toBeInTheDocument()
  })

  it('defaults to Customer Orders tab', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    const ordersTab = await screen.findByRole('tab', { name: 'Customer Orders' })
    expect(ordersTab).toHaveAttribute('data-state', 'active')
  })

  it('clicking Dashboard tab dispatches setCustomerDetailTab', async () => {
    const setCustomerDetailTab = vi.fn()
    state.setCustomerDetailTab = setCustomerDetailTab
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    const dashboardTab = await screen.findByRole('tab', { name: 'Dashboard' })
    await userEvent.click(dashboardTab)
    expect(setCustomerDetailTab).toHaveBeenCalledWith('dashboard')
  })

  it('Dashboard tab renders Coming Soon placeholder', async () => {
    state.customerDetailTab = 'dashboard'
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(await screen.findByText(/Coming soon/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:run -- src/test/customer-status-page.test.tsx`

Expected: 5 new tests fail.

- [ ] **Step 3: Modify CustomerStatusPage.tsx — add Tabs structure**

Open `src/components/CustomerStatusPage.tsx`. Add to imports at the top:

```typescript
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
```

Locate `function CustomerDetailView()` (~line 506). The function currently returns the header card + the orders card + the error alert all in one JSX tree. Restructure so the header card stays at the top, and the rest becomes the body of the orders tab.

Below the header card JSX (after the closing `</Card>` for the header), replace whatever follows (the orders card + error alert) with:

```tsx
<Tabs
  value={customerDetailTab}
  onValueChange={(v) =>
    setCustomerDetailTab(v as 'orders' | 'dashboard')
  }
  className="mt-4"
>
  <TabsList>
    <TabsTrigger value="orders">Customer Orders</TabsTrigger>
    <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
  </TabsList>
  <TabsContent value="orders" className="mt-4">
    <CustomerOrdersTab
      orders={sortedOrders}
      ordersLoading={ordersLoading}
      ordersError={ordersError}
      refetchOrders={refetchOrders}
      isConnected={isConnected}
      wordpressHost={wordpressHost}
      sampleLookupMap={sampleLookupMap}
    />
  </TabsContent>
  <TabsContent value="dashboard" className="mt-4">
    <CustomerDashboardPlaceholder />
  </TabsContent>
</Tabs>
```

Add `customerDetailTab` + `setCustomerDetailTab` to the existing `useUIStore` selector calls at the top of `CustomerDetailView`:

```typescript
const customerDetailTab = useUIStore(state => state.customerDetailTab)
const setCustomerDetailTab = useUIStore(state => state.setCustomerDetailTab)
```

Add two new private functions at the same level as `CustomerDetailView` (before the `export function CustomerStatusPage()` router):

```typescript
function CustomerOrdersTab({
  orders,
  ordersLoading,
  ordersError,
  refetchOrders,
  isConnected,
  wordpressHost,
  sampleLookupMap,
}: {
  orders: ExplorerOrder[]
  ordersLoading: boolean
  ordersError: unknown
  refetchOrders: () => void
  isConnected: boolean
  wordpressHost: string
  sampleLookupMap: Map<string, {
    data?: SenaiteLookupResult
    isLoading: boolean
    isError: boolean
  }>
}) {
  const hasError = ordersError !== null && ordersError !== undefined
  const showLoading = isConnected && ordersLoading && !hasError
  const showEmpty = !showLoading && !hasError && orders.length === 0

  return (
    <>
      {/* MOVE — verbatim from CustomerStatusPage.tsx:744-851 (error Alert + orders Card)
          INTO this fragment. The block starts with the {hasError && (...)} Alert and ends
          with the closing </Card> of the orders Card. No JSX changes — the local
          variables (hasError, showLoading, showEmpty, orders, refetchOrders, ordersError,
          wordpressHost, sampleLookupMap) are now this function's props/locals instead
          of CustomerDetailView's. The reference `sortedOrders` in the original code
          becomes `orders` here (the parent passes sortedOrders as the orders prop). */}
    </>
  )
}

// Concrete instruction: open CustomerStatusPage.tsx, select lines 744-851
// (the {hasError && (...)} Alert block through the closing </Card> of the orders
// Card), CUT them, and paste them inside the return fragment above. Rename references
// to `sortedOrders` -> `orders`. Verify the diff by running:
//   git diff src/components/CustomerStatusPage.tsx
// — the CustomerDetailView function should be ~110 lines shorter and the new
// CustomerOrdersTab + CustomerDashboardPlaceholder functions should account for
// that delta plus the placeholder card. Run the test suite (Step 4) to confirm
// the move is behavior-preserving before continuing.

function CustomerDashboardPlaceholder() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Coming soon — customer analytics (revenue, orders/day, average turnaround).
        </p>
      </CardContent>
    </Card>
  )
}
```

The "paste from the existing CustomerDetailView body" instruction means: move the existing JSX (lines ~771 through whatever closes out the orders card and the error alert) into `CustomerOrdersTab`. This is a verbatim move, not a rewrite — the function gains the props it needs and the JSX stays identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:run -- src/test/customer-status-page.test.tsx`

Expected: All tests pass (5 new + 46 existing).

- [ ] **Step 5: Typecheck + scoped lint**

Run:
```bash
npm run typecheck
npx eslint src/components/CustomerStatusPage.tsx --max-warnings 0
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/CustomerStatusPage.tsx src/test/customer-status-page.test.tsx
git commit -m "feat(customer-detail): wrap detail view in Tabs (Orders + Dashboard placeholder)

CustomerDetailView body now uses shadcn Tabs:
- Customer Orders tab (default): existing orders card + error alert, verbatim
  moved into new private CustomerOrdersTab function
- Dashboard tab: placeholder Coming Soon card

Header card stays persistent above the tabs.

No behavior change to orders rendering — this is purely a structural move."
```

---

## Task 7: CustomerOrdersTab — search UI (field selector + debounced input + clear)

**Files:**
- Modify: `src/components/CustomerStatusPage.tsx` (extend `CustomerOrdersTab`)
- Modify: `src/test/customer-status-page.test.tsx`

This is the largest task — it adds the search input, wires it to the orders query, and applies auto-expand + highlight to OrderRow when a search is active.

- [ ] **Step 1: Write the failing tests (RED)**

Open `src/test/customer-status-page.test.tsx`. Add a new describe block:

```typescript
describe('CustomerStatusPage — customer-orders search (Phase 30)', () => {
  beforeEach(async () => {
    state.activeSection = 'accumark-tools'
    state.activeSubSection = 'customer-detail'
    state.customerDetailTargetId = 42
    state.customerDetailTab = 'orders'
    state.customerOrderSearch = { field: null, value: '' }
    vi.mocked(getExplorerStatus).mockResolvedValue({ connected: true })
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
  })

  it('renders search field selector with 3 options', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await userEvent.click(await screen.findByRole('combobox', { name: /search field/i }))
    expect(await screen.findByRole('option', { name: 'Order #' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Sample ID' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Analyte' })).toBeInTheDocument()
  })

  it('typing in search input dispatches setCustomerOrderSearch with debounce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const setCustomerOrderSearch = vi.fn()
    state.setCustomerOrderSearch = setCustomerOrderSearch
    state.customerOrderSearch = { field: 'sample_id', value: '' }

    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    const input = await screen.findByPlaceholderText(/search by/i)
    await userEvent.type(input, 'P-0001')

    // No dispatch yet (debounce pending)
    expect(setCustomerOrderSearch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    await waitFor(() => {
      expect(setCustomerOrderSearch).toHaveBeenCalledWith({
        field: 'sample_id',
        value: 'P-0001',
      })
    })
    vi.useRealTimers()
  })

  it('passes search params to getExplorerOrdersByCustomer when value length >= 2', async () => {
    state.customerOrderSearch = { field: 'sample_id', value: 'P-0001' }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await waitFor(() => {
      expect(getExplorerOrdersByCustomer).toHaveBeenCalledWith(
        42,
        { field: 'sample_id', value: 'P-0001' },
        'open_first',
        0,
        50
      )
    })
  })

  it('does NOT pass search params when value length < 2', async () => {
    state.customerOrderSearch = { field: 'sample_id', value: 'P' }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await waitFor(() => {
      expect(getExplorerOrdersByCustomer).toHaveBeenCalledWith(
        42,
        undefined,
        'open_first',
        0,
        50
      )
    })
  })

  it('renders OrderRow with defaultExpanded=true when search active', async () => {
    state.customerOrderSearch = { field: 'sample_id', value: 'P-0001' }
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([
      makeOrder({ order_id: '1234', sample_results: { '1': { senaite_id: 'P-0001', status: 'created' } } }),
    ])
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(await screen.findByTestId('order-row')).toHaveAttribute('data-expanded', 'true')
  })

  it('passes highlightSampleId to OrderRow when search_field=sample_id', async () => {
    state.customerOrderSearch = { field: 'sample_id', value: 'P-0001' }
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([
      makeOrder({ order_id: '1234', sample_results: { '1': { senaite_id: 'P-0001', status: 'created' } } }),
    ])
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(await screen.findByTestId('order-row')).toHaveAttribute('data-highlight-sample-id', 'P-0001')
  })

  it('shows empty-state with field/value echo when search returns 0 orders', async () => {
    state.customerOrderSearch = { field: 'analyte', value: 'BPC-157' }
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(await screen.findByText(/No orders match Analyte: "BPC-157"/i)).toBeInTheDocument()
  })

  it('clear-search button resets customerOrderSearch', async () => {
    const setCustomerOrderSearch = vi.fn()
    state.setCustomerOrderSearch = setCustomerOrderSearch
    state.customerOrderSearch = { field: 'sample_id', value: 'P-0001' }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await userEvent.click(await screen.findByRole('button', { name: /clear search/i }))
    expect(setCustomerOrderSearch).toHaveBeenCalledWith({ field: null, value: '' })
  })
})
```

The test references `data-expanded` and `data-highlight-sample-id` on the OrderRow. To make these queryable in tests, **either** add these `data-*` attributes to OrderRow's root `<tr>` (cleanest, low cost), **or** use the OrderRow's test mock from existing test infra. Recommended: add the `data-*` attributes in Step 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:run -- src/test/customer-status-page.test.tsx`

Expected: 8 new tests fail.

- [ ] **Step 3: Extend OrderRow to surface test attributes (small follow-up to Task 5)**

In `src/components/explorer/OrderRow.tsx`, add `data-*` attributes to the root `<tr>`:

```tsx
<tr
  data-testid="order-row"
  data-expanded={isExpanded ? 'true' : 'false'}
  data-highlight-sample-id={highlightSampleId ?? ''}
  /* ... existing className, onClick, etc. */
>
  {/* existing tr content */}
</tr>
```

- [ ] **Step 4: Implement CustomerOrdersTab search UI**

Open `src/components/CustomerStatusPage.tsx`. Replace the `CustomerOrdersTab` function body with a version that includes the search header. Also update `CustomerDetailView` to read `customerOrderSearch` and pass it into `getExplorerOrdersByCustomer`.

In `CustomerDetailView`, add to the selector calls at the top:

```typescript
const customerOrderSearch = useUIStore(state => state.customerOrderSearch)
const setCustomerOrderSearch = useUIStore(state => state.setCustomerOrderSearch)
```

Modify the orders `useQuery` to pass search params and include them in the query key:

```typescript
const {
  data: orders,
  isLoading: ordersLoading,
  error: ordersError,
  refetch: refetchOrders,
} = useQuery({
  queryKey: [
    'explorer',
    'orders',
    'by-customer',
    customerDetailTargetId,
    customerOrderSearch.field,
    customerOrderSearch.value,
    'open_first',  // sort — currently fixed; later phases may parameterize
    envName,
  ],
  queryFn: () => {
    if (customerDetailTargetId === null) {
      throw new Error('customerDetailTargetId unexpectedly null')
    }
    const searchForApi =
      customerOrderSearch.field !== null && customerOrderSearch.value.length >= 2
        ? { field: customerOrderSearch.field, value: customerOrderSearch.value }
        : undefined
    return getExplorerOrdersByCustomer(
      customerDetailTargetId,
      searchForApi,
      'open_first',
      0,
      50
    )
  },
  enabled: isConnected && customerDetailTargetId !== null,
  staleTime: 30_000,
})
```

Pass `customerOrderSearch` and `setCustomerOrderSearch` into `CustomerOrdersTab` props (extend its props interface in the function signature).

Now replace `CustomerOrdersTab` with:

```tsx
function CustomerOrdersTab({
  orders,
  ordersLoading,
  ordersError,
  refetchOrders,
  isConnected,
  wordpressHost,
  sampleLookupMap,
  customerOrderSearch,
  setCustomerOrderSearch,
}: {
  /* existing props from Task 6 */
  customerOrderSearch: { field: 'order_number' | 'sample_id' | 'analyte' | null; value: string }
  setCustomerOrderSearch: (next: { field: 'order_number' | 'sample_id' | 'analyte' | null; value: string }) => void
}) {
  // Local input state for debounce (mirrors Phase 29's setLocalInput pattern)
  const [localInput, setLocalInput] = useState(customerOrderSearch.value)

  useEffect(() => {
    const handle = setTimeout(() => {
      if (customerOrderSearch.field === null) return
      if (localInput === customerOrderSearch.value) return
      setCustomerOrderSearch({ field: customerOrderSearch.field, value: localInput })
    }, 300)
    return () => clearTimeout(handle)
  }, [localInput, customerOrderSearch.field, customerOrderSearch.value, setCustomerOrderSearch])

  const fieldLabels: Record<'order_number' | 'sample_id' | 'analyte', string> = {
    order_number: 'Order #',
    sample_id: 'Sample ID',
    analyte: 'Analyte',
  }
  const placeholderByField: Record<'order_number' | 'sample_id' | 'analyte', string> = {
    order_number: 'Search by Order # (e.g., 3001)',
    sample_id: 'Search by Sample ID (e.g., P-0001)',
    analyte: 'Search by Analyte (e.g., BPC-157)',
  }

  const searchActive =
    customerOrderSearch.field !== null && customerOrderSearch.value.length >= 2

  const hasError = ordersError !== null && ordersError !== undefined
  const showLoading = isConnected && ordersLoading && !hasError
  const showEmpty = !showLoading && !hasError && (orders ?? []).length === 0

  return (
    <div className="space-y-4">
      {/* Search header */}
      <div className="flex items-center gap-2">
        <Select
          value={customerOrderSearch.field ?? ''}
          onValueChange={(v) => {
            if (v === '') {
              setCustomerOrderSearch({ field: null, value: '' })
              setLocalInput('')
            } else {
              const field = v as 'order_number' | 'sample_id' | 'analyte'
              setCustomerOrderSearch({ field, value: '' })
              setLocalInput('')
            }
          }}
          aria-label="Search field"
        >
          <SelectTrigger className="w-[180px]" aria-label="Search field">
            <SelectValue placeholder="Search field…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="order_number">Order #</SelectItem>
            <SelectItem value="sample_id">Sample ID</SelectItem>
            <SelectItem value="analyte">Analyte</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={localInput}
          onChange={(e) => setLocalInput(e.target.value)}
          placeholder={
            customerOrderSearch.field
              ? placeholderByField[customerOrderSearch.field]
              : 'Pick a search field first…'
          }
          disabled={customerOrderSearch.field === null}
          className="flex-1"
        />
        {searchActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCustomerOrderSearch({ field: null, value: '' })
              setLocalInput('')
            }}
            aria-label="Clear search"
          >
            Clear search
          </Button>
        )}
      </div>

      {/* Error alert — preserved from Phase 29 */}
      {hasError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not load customer</AlertTitle>
          <AlertDescription>
            {import.meta.env.PROD
              ? 'Check your connection and try again.'
              : String(ordersError instanceof Error ? ordersError.message : ordersError)}
          </AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => refetchOrders()}
            aria-label="Retry loading customer"
          >
            Retry
          </Button>
        </Alert>
      )}

      {/* Orders card body */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Orders</CardTitle>
          <CardDescription className="text-sm text-muted-foreground">
            {searchActive ? 'Search results' : 'Open orders first'}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {showLoading && (
            <div className="divide-y divide-border/50 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={`detail-skel-${i}`} data-testid="detail-order-skeleton" className="py-2">
                  <Skeleton className="h-14 w-full" />
                </div>
              ))}
            </div>
          )}
          {showEmpty && !searchActive && (
            <div className="flex flex-col items-center text-center py-12">
              <PackageX className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm font-medium text-muted-foreground">
                No orders for this customer
              </p>
            </div>
          )}
          {showEmpty && searchActive && customerOrderSearch.field !== null && (
            <div className="flex flex-col items-center text-center py-12">
              <p className="text-sm font-medium text-muted-foreground">
                No orders match {fieldLabels[customerOrderSearch.field]}: &quot;{customerOrderSearch.value}&quot;
              </p>
            </div>
          )}
          {!showLoading && !showEmpty && (orders ?? []).length > 0 && (
            <table className="w-full">
              <thead className="sticky top-0 z-10 bg-card border-b">
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 px-3 font-medium whitespace-nowrap">Order ID</th>
                  <th className="py-2 px-3 font-medium whitespace-nowrap">Email</th>
                  <th className="py-2 px-3 font-medium whitespace-nowrap">Progress</th>
                  <th className="py-2 px-3 font-medium whitespace-nowrap">Created</th>
                  <th className="py-2 px-3 font-medium whitespace-nowrap">Processing Time</th>
                  <th className="py-2 px-3 font-medium whitespace-nowrap">Sample Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {(orders ?? []).map((order) => (
                  <OrderRow
                    key={order.id}
                    order={order}
                    wordpressHost={wordpressHost}
                    sampleLookupMap={sampleLookupMap}
                    activeAnalysisStates={[]}
                    defaultExpanded={searchActive ? true : undefined}
                    highlightSampleId={
                      searchActive && customerOrderSearch.field === 'sample_id'
                        ? customerOrderSearch.value
                        : undefined
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

Add the needed imports (Select, Input, Button) at the top of the file if not already present:

```typescript
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useEffect, useState } from 'react'  // if not already
```

Update the `<TabsContent value="orders">` block in `CustomerDetailView` to pass the new props:

```tsx
<TabsContent value="orders" className="mt-4">
  <CustomerOrdersTab
    orders={sortedOrders}
    ordersLoading={ordersLoading}
    ordersError={ordersError}
    refetchOrders={refetchOrders}
    isConnected={isConnected}
    wordpressHost={wordpressHost}
    sampleLookupMap={sampleLookupMap}
    customerOrderSearch={customerOrderSearch}
    setCustomerOrderSearch={setCustomerOrderSearch}
  />
</TabsContent>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:run -- src/test/customer-status-page.test.tsx`

Expected: All tests pass (8 new + 51 existing).

- [ ] **Step 6: Typecheck + scoped lint + ast-grep**

Run:
```bash
npm run typecheck
npx eslint src/components/CustomerStatusPage.tsx --max-warnings 0
npx ast-grep scan src/components/CustomerStatusPage.tsx
```

Expected: 0 errors. No new Zustand-destructuring violations.

- [ ] **Step 7: Commit**

```bash
git add src/components/CustomerStatusPage.tsx src/components/explorer/OrderRow.tsx src/test/customer-status-page.test.tsx
git commit -m "feat(customer-detail): search UI on Customer Orders tab

CustomerOrdersTab gains:
- Field selector dropdown (Order # / Sample ID / Analyte) — mirrors SENAITE
  samples-page UX from backend/main.py:10840
- Debounced text input (300ms, 2-char minimum gate)
- Clear-search button (visible when search active)
- Empty-state with field/value echo on zero matches
- OrderRow auto-expand + highlight when search is active

TanStack query key extended with (search_field, search_value) so search
results have their own cache namespace, no bleed into the no-search list.

OrderRow gains data-* attributes (data-testid, data-expanded,
data-highlight-sample-id) for test targeting."
```

---

## Task 8: E2E — extend customers.spec.ts with tab/search assertions

**Files:**
- Modify: `e2e/customers.spec.ts`

- [ ] **Step 1: Read existing spec structure**

Open `e2e/customers.spec.ts`. Note the existing helper `openCustomersPage` and the existing test `'clicking a registered customer drills through to detail view'`. New tests reuse the same drill-through pattern.

- [ ] **Step 2: Add new tests at the end of the existing `test.describe` block**

```typescript
test('detail page shows tabs with Customer Orders default and Dashboard placeholder', async ({ authedPage: page }) => {
  await openCustomersPage(page)
  await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })

  // Drill through to a registered customer
  await page.getByPlaceholder('Search by name or email…').fill('a')
  await page.waitForTimeout(500)
  const clickableRow = await findClickableCustomerRow(page)
  test.skip(clickableRow === null, 'No registered customers in dev DB')
  await clickableRow!.click()
  await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

  // Both tabs visible, Customer Orders active by default
  const ordersTab = page.getByRole('tab', { name: 'Customer Orders' })
  const dashboardTab = page.getByRole('tab', { name: 'Dashboard' })
  await expect(ordersTab).toBeVisible()
  await expect(dashboardTab).toBeVisible()
  await expect(ordersTab).toHaveAttribute('data-state', 'active')

  // Click Dashboard, see Coming Soon
  await dashboardTab.click()
  await expect(page.getByText(/Coming soon/i)).toBeVisible({ timeout: 5_000 })

  // Back to orders
  await ordersTab.click()
  await expect(ordersTab).toHaveAttribute('data-state', 'active')
})

test('search by sample ID auto-expands matching order with highlighted sample card', async ({ authedPage: page }) => {
  // This test requires a known-good sample ID in the dev DB. Either:
  //   (a) pull one from the database before the test (requires DB access)
  //   (b) use the seeded e2e-test customer's first order's first sample
  // For v1, pick a sample ID known to exist via psql probe in test setup.

  test.skip(!process.env.E2E_KNOWN_SAMPLE_ID, 'Set E2E_KNOWN_SAMPLE_ID env var to a real P-#### in the dev DB')

  await openCustomersPage(page)
  await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })
  await page.getByPlaceholder('Search by name or email…').fill('a')
  await page.waitForTimeout(500)
  const clickableRow = await findClickableCustomerRow(page)
  test.skip(clickableRow === null)
  await clickableRow!.click()
  await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

  // Select Sample ID field and type
  await page.getByLabel('Search field').click()
  await page.getByRole('option', { name: 'Sample ID' }).click()
  await page.getByPlaceholder(/Search by Sample ID/).fill(process.env.E2E_KNOWN_SAMPLE_ID!)

  // Wait for the request with the search param
  await page.waitForRequest(
    req => req.url().includes('/explorer/orders') && req.url().includes(`search_value=${process.env.E2E_KNOWN_SAMPLE_ID}`),
    { timeout: 5_000 }
  )

  // Verify a row appears, is expanded, and the sample is highlighted
  const orderRow = page.locator('[data-testid="order-row"]').first()
  await expect(orderRow).toBeVisible({ timeout: 10_000 })
  await expect(orderRow).toHaveAttribute('data-expanded', 'true')
  await expect(orderRow).toHaveAttribute('data-highlight-sample-id', process.env.E2E_KNOWN_SAMPLE_ID!)
})

test('search by analyte returns matching orders auto-expanded', async ({ authedPage: page }) => {
  await openCustomersPage(page)
  await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })
  await page.getByPlaceholder('Search by name or email…').fill('a')
  await page.waitForTimeout(500)
  const clickableRow = await findClickableCustomerRow(page)
  test.skip(clickableRow === null)
  await clickableRow!.click()
  await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

  await page.getByLabel('Search field').click()
  await page.getByRole('option', { name: 'Analyte' }).click()
  await page.getByPlaceholder(/Search by Analyte/).fill('BPC')

  // Either real BPC orders exist → rows visible auto-expanded, OR empty state
  await page.waitForRequest(req => req.url().includes('search_field=analyte'), { timeout: 5_000 })

  // Two valid outcomes: at least one expanded order row OR empty-state copy
  const orderRow = page.locator('[data-testid="order-row"]').first()
  const emptyState = page.getByText(/No orders match Analyte: "BPC"/i)
  await expect(orderRow.or(emptyState)).toBeVisible({ timeout: 10_000 })
})

test('clear-search button resets state and shows full order list', async ({ authedPage: page }) => {
  await openCustomersPage(page)
  await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })
  await page.getByPlaceholder('Search by name or email…').fill('a')
  await page.waitForTimeout(500)
  const clickableRow = await findClickableCustomerRow(page)
  test.skip(clickableRow === null)
  await clickableRow!.click()
  await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

  await page.getByLabel('Search field').click()
  await page.getByRole('option', { name: 'Analyte' }).click()
  await page.getByPlaceholder(/Search by Analyte/).fill('xqzqzqxqz')
  await expect(page.getByText(/No orders match/i)).toBeVisible({ timeout: 5_000 })

  await page.getByRole('button', { name: /Clear search/i }).click()
  // Search field selector returns to placeholder state; orders table returns
  await expect(page.getByText('Search field…')).toBeVisible()
})
```

- [ ] **Step 3: Run the E2E suite**

Pre-flight: ensure the dev stack is running (frontend on :3101, backend on :8012, IS on :8000). Migration from Task 1 must have been applied to the IS dev DB.

Optionally set `E2E_KNOWN_SAMPLE_ID` to a real `P-####` from the dev DB:

```bash
docker exec accumark_postgres psql -U postgres -d accumark_integration -c "
SELECT value->>'senaite_id' AS sid
FROM order_submissions, jsonb_each(sample_results)
WHERE customer_id IS NOT NULL
  AND value->>'senaite_id' IS NOT NULL
LIMIT 1
"
```

Use the returned `P-####` value:

```bash
E2E_KNOWN_SAMPLE_ID=P-XXXX npm run test:e2e -- customers.spec.ts
```

Expected: All E2E tests pass (7 existing + 4 new = 11 specs).

- [ ] **Step 4: Commit**

```bash
git add e2e/customers.spec.ts
git commit -m "test(e2e): cover customer-detail tabs + customer-orders search

Four new Playwright specs:
- Tab visibility, default-active orders tab, Dashboard placeholder
- Sample-ID search auto-expands + highlights matching sample
- Analyte search returns matched orders or empty state
- Clear-search button resets state

Sample-ID test requires E2E_KNOWN_SAMPLE_ID env var (a real P-#### from
the dev DB); skipped otherwise."
```

---

## Post-flight

After all 8 tasks complete:

- [ ] **Run the full test suite**

```bash
cd ../integration-service && pytest tests/integration/test_explorer_orders_search.py tests/integration/test_migration_search_jsonb_indexes.py -v
cd ../../Accu-Mk1 && npm run test:run
npm run typecheck
npm run test:e2e -- customers.spec.ts
```

All green expected.

- [ ] **Smoke walkthrough in the running stack**
  - Open http://localhost:3101, log in
  - Click into a customer
  - Confirm tabs present, Customer Orders active
  - Click Dashboard → Coming Soon visible
  - Click Customer Orders, pick Sample ID, type a real `P-####`, see auto-expanded row with ring
  - Pick Analyte, type `BPC`, confirm matched orders or empty state
  - Click Clear search, confirm full list returns
  - Back to Customers, click into a DIFFERENT customer, confirm Search state didn't carry over

- [ ] **Verify GIN indexes are being used** (one-shot check, not part of CI)

```bash
docker exec accumark_postgres psql -U postgres -d accumark_integration -c "
EXPLAIN SELECT id FROM order_submissions
WHERE jsonb_path_exists(payload->'line_items', '\$[*].name ? (@ like_regex \$v flag \"i\")', jsonb_build_object('v', 'BPC-157'));
"
```

Expected: plan shows `Bitmap Index Scan on idx_order_submissions_line_items_gin`.

- [ ] **Update CLAUDE.md / AGENTS.md if any new patterns emerged** (likely not — this work fits Phase 29's established patterns)

- [ ] **Open PR** with title `feat: customer detail tabs + customer orders search` and link the spec doc + this plan doc in the description.

---

*Plan authored 2026-05-18 via Superpowers writing-plans skill. Source spec: `docs/superpowers/specs/2026-05-18-customer-detail-tabs-design.md`.*
