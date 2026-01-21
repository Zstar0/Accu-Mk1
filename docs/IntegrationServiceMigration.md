# Accu-Mk1 Desktop → Integration Service Migration Guide

This guide provides specifications for porting the "Order Explorer" API from the Accu-Mk1 local backend to the Integration Service. The goal is for the desktop app to call the Integration Service (with JWT auth) instead of requiring a local Python backend.

---

## Overview

The Accu-Mk1 desktop app has an "Order Explorer" feature for debugging WooCommerce orders and COA ingestions. Currently it runs a local FastAPI backend that connects to the Integration Service PostgreSQL database.

**Target Architecture:**

- Integration Service exposes Order Explorer endpoints (protected by JWT)
- Desktop app authenticates with JWT and calls remote API
- No local backend needed on desktop

---

## API Endpoints to Implement

### 1. `GET /v1/desktop/status`

Check database connection status.

**Response Schema:**

```python
class ExplorerConnectionStatus(BaseModel):
    connected: bool
    environment: Optional[str] = None       # "local" or "production" - may not be needed
    database: Optional[str] = None
    host: Optional[str] = None
    wordpress_host: Optional[str] = None    # e.g., "https://accumarklabs.kinsta.cloud"
    error: Optional[str] = None
```

**Response Example:**

```json
{
  "connected": true,
  "environment": "production",
  "database": "accumark_integration",
  "host": "localhost",
  "wordpress_host": "https://accumarklabs.kinsta.cloud"
}
```

---

### 2. `GET /v1/desktop/orders`

Fetch orders from `order_submissions` table.

**Query Parameters:**
| Param | Type | Default | Description |
|---------|--------|---------|------------------------------------------|
| search | string | null | Filter by order_id or order_number (ILIKE) |
| limit | int | 50 | Max records to return |
| offset | int | 0 | Pagination offset |

**Response Schema:**

```python
class ExplorerOrderResponse(BaseModel):
    id: str                                  # UUID as string
    order_id: str                            # WordPress order ID (e.g., "2867")
    order_number: str                        # Often same as order_id
    status: str                              # pending, processing, completed, failed, etc.
    samples_expected: int
    samples_delivered: int
    error_message: Optional[str] = None
    payload: Optional[dict] = None           # Original WooCommerce order payload
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
```

**SQL Query:**

```sql
SELECT
    id,
    order_id,
    order_number,
    status,
    samples_expected,
    samples_delivered,
    error_message,
    payload,
    created_at,
    updated_at,
    completed_at
FROM order_submissions
WHERE order_id ILIKE %s OR order_number ILIKE %s  -- if search provided
ORDER BY created_at DESC
LIMIT %s OFFSET %s
```

---

### 3. `GET /v1/desktop/orders/{order_id}/ingestions`

Fetch all ingestions linked to an order.

**Path Parameters:**
| Param | Type | Description |
|----------|--------|--------------------------------|
| order_id | string | WordPress order ID (e.g., "2867") |

**Response Schema:**

```python
class ExplorerIngestionResponse(BaseModel):
    id: str                                  # UUID as string
    sample_id: str                           # SENAITE sample ID
    coa_version: int
    order_ref: Optional[str] = None
    status: str                              # pending, uploaded, notified, failed, etc.
    s3_key: Optional[str] = None
    verification_code: Optional[str] = None  # e.g., "A1B2-C3D4"
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    processing_time_ms: Optional[int] = None
```

**SQL Query:**

```sql
-- First: Find the order_submission UUID
SELECT id FROM order_submissions WHERE order_id = %s

-- Then: Fetch ingestions
SELECT
    i.id,
    i.sample_id,
    i.coa_version,
    i.order_ref,
    i.status,
    i.s3_key,
    i.verification_code,
    i.error_message,
    i.created_at,
    i.updated_at,
    i.completed_at,
    i.processing_time_ms
FROM ingestions i
WHERE i.order_submission_id = %s  -- The UUID from first query
ORDER BY i.created_at DESC
```

---

## API Key Authentication

All `/v1/desktop/*` endpoints should require API key authentication.

### Configuration (.env)

Store allowed API keys as a comma-separated list in the environment:

```bash
# .env
DESKTOP_API_KEYS=ak_prod_key_001,ak_prod_key_002
```

### Middleware Implementation

```python
import os
from fastapi import Header, HTTPException

# Load allowed keys from environment (comma-separated)
ALLOWED_API_KEYS = set(
    key.strip()
    for key in os.environ.get("DESKTOP_API_KEYS", "").split(",")
    if key.strip()
)

async def verify_desktop_api_key(x_api_key: str = Header(..., alias="X-API-Key")):
    """Validate API key from X-API-Key header."""
    if not x_api_key:
        raise HTTPException(401, "API key required")

    if x_api_key not in ALLOWED_API_KEYS:
        raise HTTPException(401, "Invalid API key")

    return x_api_key
```

### Apply to Routes

```python
from fastapi import Depends

@app.get("/v1/desktop/status", dependencies=[Depends(verify_desktop_api_key)])
async def get_desktop_status():
    ...

@app.get("/v1/desktop/orders", dependencies=[Depends(verify_desktop_api_key)])
async def get_desktop_orders(...):
    ...
```

### Desktop App Usage

The desktop app sends API key via `X-API-Key` header:

```typescript
const response = await fetch(`${API_URL}/v1/desktop/orders`, {
  headers: { 'X-API-Key': apiKey },
})
```

---

## CORS Configuration

Add Tauri desktop origins to allowed CORS origins:

```python
allow_origins=[
    # Existing WordPress origins...
    "https://tauri.localhost",    # Tauri v2 production
    "http://tauri.localhost",
    "tauri://localhost",          # Tauri v1
    "http://localhost:1420",      # Tauri dev server
    "http://127.0.0.1:1420",
]
```

---

## TypeScript Interface Reference

The desktop frontend expects these interfaces (from `src/lib/api.ts`):

```typescript
export interface ExplorerOrder {
  id: string
  order_id: string
  order_number: string
  status: string
  samples_expected: number
  samples_delivered: number
  error_message: string | null
  payload: Record<string, unknown> | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface ExplorerIngestion {
  id: string
  sample_id: string
  coa_version: number
  order_ref: string | null
  status: string
  s3_key: string | null
  verification_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  processing_time_ms: number | null
}

export interface ExplorerConnectionStatus {
  connected: boolean
  environment?: string
  database?: string
  host?: string
  wordpress_host?: string
  error?: string
}
```

---

## Notes

1. **Environment switching**: The current local backend has "local" and "production" environment switching. For the Integration Service, this is not needed since it always connects to its own database.

2. **WordPress Host**: The `wordpress_host` field is used to construct verification URLs (e.g., `https://accumarklabs.kinsta.cloud/verify?code=XXXX`). The Integration Service should return its configured WordPress host.

3. **UUID Serialization**: The `id` field is a PostgreSQL UUID. Convert to string for JSON responses.

4. **Payload field**: The `payload` column is JSONB containing the original WooCommerce order data. Return as-is.

---

## Testing

After implementing, verify with:

1. `GET /v1/desktop/status` returns `{"connected": true, ...}`
2. `GET /v1/desktop/orders?limit=5` returns recent orders
3. `GET /v1/desktop/orders/{order_id}/ingestions` returns ingestions for known order
4. Verify 401 returned without valid JWT
5. Verify CORS headers allow Tauri origins
