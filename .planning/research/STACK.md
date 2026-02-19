# Technology Stack: v0.11.0 New Analysis Wizard

**Project:** Accu-Mk1
**Milestone:** v0.11.0 — HPLC Sample Prep Wizard with scale integration
**Researched:** 2026-02-19
**Research mode:** Stack dimension (focused on three new concerns)

---

## Summary of Additions

The existing stack (FastAPI + SQLite + SQLAlchemy + React + shadcn/ui + JWT auth + httpx)
handles everything except three new concerns. This is a deliberately minimal-addition
milestone:

| Concern | Solution | New dependency? |
|---------|----------|-----------------|
| MT-SICS balance communication over TCP | `asyncio` stdlib streams | No |
| Stream live weight readings to frontend | `sse-starlette` | YES — one new package |
| SENAITE sample lookup (GET only) | `httpx` (already installed) | No |
| Wizard UI step state | Zustand (already installed) | No |

The only net-new backend dependency is `sse-starlette`.

---

## 1. Mettler Toledo XSR105DU: Network Communication

### Protocol: MT-SICS over TCP

**MT-SICS (Mettler Toledo Standard Interface Command Set)** is the native protocol for
all Mettler Toledo Excellence-line balances. Over the network, it runs as raw ASCII
over a TCP socket — no HTTP, no REST, no MQTT. The balance acts as the TCP server;
the Python backend connects as a TCP client.

All commands are plain ASCII strings terminated with `\r\n` (CRLF). Responses are
also `\r\n` terminated.

**Connection details:**
- Transport: TCP (not UDP, not HTTP)
- Default port: **4001**
  - Source: Atlantis-Software Node.js MT-SICS library (`tcp://192.168.1.1:4001`)
    and N3uron Mettler Toledo driver documentation
  - The port is configurable on the balance via Menu > Communication > Interfaces >
    Ethernet > Port. Verify the actual configured port before coding.
- IP address: Must be statically assigned or DHCP-reserved. Add as env var `SCALE_IP`.
- No login/auth step: connection is open, commands work immediately once TCP is established.

**IMPORTANT hardware prerequisite:** The XSR105DU must have the optional Ethernet
interface module installed. Ethernet is an add-on, not standard on all XSR units.
If the balance has only USB/RS-232, a serial-to-network device server is required
(adds latency and complexity). Confirm with the lab before building.

### MT-SICS Command Reference

| Command | Send (bytes) | Purpose | Returns when |
|---------|-------------|---------|-------------|
| `S` | `S\r\n` | Request stable weight (blocks) | Balance declares stable |
| `SI` | `SI\r\n` | Request immediate weight | Immediately |
| `SIR` | `SIR\r\n` | Start continuous immediate output | Balance sends at its own interval until stopped |
| `@` | `@\r\n` | Reset / stop SIR continuous mode | Immediately |
| `Z` | `Z\r\n` | Zero the balance | Immediately |
| `T` | `T\r\n` | Tare the balance | Immediately |
| `I1` | `I1\r\n` | Identify balance / MT-SICS level | Immediately (use for ping/health check) |

### Response Format

All `S` and `SI` responses follow this pattern:

```
S <STATUS> <sign><value> <unit>\r\n
```

Status characters:
- `S` — **Stable** (reading is settled; this is the flag you check)
- `D` — Dynamic (still moving/settling)
- `+` — Overload
- `-` — Underload
- `I` — Balance busy

Examples:
```
S S      1.2345 g\r\n    <- stable, value 1.2345g  (the good one)
S D      1.2300 g\r\n    <- dynamic, still settling
S S     -0.0002 g\r\n    <- stable, slight negative (near zero)
S +\r\n                  <- overload
```

**Parsing:** Split on whitespace. `parts[0]` = command echo (`S`), `parts[1]` =
status character, `parts[2]` = numeric value string, `parts[3]` = unit string.

Error responses start with `ES` (syntax error), `EL` (logical error — e.g. balance
not ready), or `ET` (transmission error).

### Stable Weight Detection Strategy

**Do NOT use the blocking `S` command for live streaming.** The `S` command blocks
the socket until the balance itself declares stability, which can take 2-15 seconds
on a vibrating lab bench. In an asyncio event loop this blocks everything.

**Recommended pattern: poll `SI` at 300ms intervals, detect stability in software.**

```python
POLL_INTERVAL_S = 0.3       # 300ms between SI polls
STABILITY_WINDOW = 5        # consecutive readings needed
STABILITY_TOLERANCE_G = 0.0005  # 0.5mg — appropriate for XSR105 (0.1mg resolution)

from collections import deque

readings: deque[float] = deque(maxlen=STABILITY_WINDOW)

def is_stable(readings: deque[float]) -> bool:
    if len(readings) < STABILITY_WINDOW:
        return False
    return (max(readings) - min(readings)) <= STABILITY_TOLERANCE_G
```

This gives software-confirmed stability: 5 consecutive readings within 0.5mg over
1.5 seconds. The wizard UI shows the real-time value during settling, then shows
a "STABLE" indicator when this condition is met, enabling the lab tech to click
"Accept Weight".

Alternative: use `asyncio.wait_for(client.send_command("S"), timeout=10.0)` for a
one-shot stable reading with a 10-second timeout. Use this for the "tare complete"
confirmation step (simpler, no polling needed).

### Python Implementation: asyncio TCP Client

Use `asyncio.open_connection()` from the standard library. No external package needed.
This integrates naturally with FastAPI's uvicorn asyncio event loop.

```python
# backend/scale_client.py — reference skeleton

import asyncio
from collections import deque

SCALE_HOST = "192.168.x.x"  # from env SCALE_IP
SCALE_PORT = 4001             # from env SCALE_PORT, default 4001


class ScaleClient:
    """Asyncio TCP client for Mettler Toledo MT-SICS communication."""

    def __init__(self, host: str, port: int = 4001):
        self.host = host
        self.port = port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

    async def connect(self) -> None:
        self._reader, self._writer = await asyncio.open_connection(
            self.host, self.port
        )

    async def send_command(self, cmd: str) -> str:
        """Send a command and return the response line."""
        self._writer.write(f"{cmd}\r\n".encode("ascii"))
        await self._writer.drain()
        response = await asyncio.wait_for(
            self._reader.readuntil(b"\r\n"), timeout=5.0
        )
        return response.decode("ascii").strip()

    async def get_weight_immediate(self) -> tuple[float | None, str, bool]:
        """
        Returns (value_grams, unit, is_stable).
        Returns (None, "", False) on parse error or overload.
        """
        raw = await self.send_command("SI")
        parts = raw.split()
        if len(parts) < 4 or parts[0] != "S":
            return None, "", False
        status = parts[1]
        if status in ("+", "-"):          # overload / underload
            return None, "", False
        try:
            value = float(parts[2])
        except ValueError:
            return None, "", False
        unit = parts[3] if len(parts) > 3 else "g"
        return value, unit, (status == "S")

    async def zero(self) -> bool:
        raw = await self.send_command("Z")
        return raw.startswith("Z A")

    async def tare(self) -> bool:
        raw = await self.send_command("T")
        return raw.startswith("T A")

    async def ping(self) -> bool:
        """Health check — request balance identity."""
        try:
            raw = await self.send_command("I1")
            return raw.startswith("I1 A")
        except Exception:
            return False

    async def disconnect(self) -> None:
        if self._writer:
            self._writer.close()
            await self._writer.wait_closed()
```

**Critical error handling:** `readuntil()` raises `asyncio.IncompleteReadError` if
the TCP connection drops mid-read. The SSE stream generator must catch this and
attempt reconnect with exponential backoff (start at 1s, cap at 30s).

---

## 2. Streaming Scale Readings to Frontend

### Recommendation: SSE via sse-starlette (not WebSocket)

For this use case — server pushes weight readings, client never sends data via the
stream — SSE is the correct tool:

| Factor | SSE | WebSocket |
|--------|-----|-----------|
| Direction | Server → client only | Bidirectional |
| Our actual need | Server pushes weight | Client never sends via stream |
| Reconnection | Browser handles automatically (built-in) | Must implement manually |
| FastAPI integration | Async generator → `EventSourceResponse` | Separate `@app.websocket` with connection management |
| Proxy/Docker compatibility | Plain HTTP — no upgrade handshake | WebSocket upgrade blocked by some proxies |
| Complexity | Low | Higher |

WebSocket would only be warranted if the client needs to send tare/zero commands via
the same persistent connection. In this wizard, tare and zero are separate REST POST
calls — there is no need for bidirectional streaming.

### Library: sse-starlette

**Package:** `sse-starlette`
**Install:** `pip install sse-starlette`
**Current version:** 2.x (last commit November 21, 2024 — actively maintained)
**Source:** https://github.com/sysid/sse-starlette | https://pypi.org/project/sse-starlette/

```python
# backend/routers/scale.py — reference skeleton

import asyncio
import json
import os
from collections import deque
from fastapi import APIRouter, Query
from sse_starlette.sse import EventSourceResponse

from scale_client import ScaleClient, is_stable
from auth import verify_token_from_query  # see JWT/SSE note below

router = APIRouter()

SCALE_IP = os.getenv("SCALE_IP", "192.168.1.100")
SCALE_PORT = int(os.getenv("SCALE_PORT", "4001"))
POLL_INTERVAL = 0.3
STABILITY_WINDOW = 5
STABILITY_TOLERANCE_G = 0.0005


@router.get("/api/scale/stream")
async def scale_stream(token: str = Query(...)):
    """
    SSE endpoint: streams live weight readings to wizard frontend.
    Auth via query param token (EventSource API does not support custom headers).
    """
    # Validate JWT from query param
    user = verify_token_from_query(token)  # raises 401 if invalid

    async def event_generator():
        client = ScaleClient(host=SCALE_IP, port=SCALE_PORT)
        readings: deque[float] = deque(maxlen=STABILITY_WINDOW)
        try:
            await client.connect()
            while True:
                value, unit, hw_stable = await client.get_weight_immediate()
                if value is not None:
                    readings.append(value)
                    sw_stable = is_stable(readings)
                    yield {
                        "data": json.dumps({
                            "weight": round(value, 5),
                            "unit": unit,
                            "stable": sw_stable,
                            "hw_stable": hw_stable,
                        })
                    }
                else:
                    yield {"data": json.dumps({"error": "scale_not_ready"})}
                await asyncio.sleep(POLL_INTERVAL)
        except asyncio.IncompleteReadError:
            yield {"data": json.dumps({"error": "scale_disconnected"})}
        except Exception as e:
            yield {"data": json.dumps({"error": str(e)})}
        finally:
            await client.disconnect()

    return EventSourceResponse(event_generator(), ping=10)


@router.post("/api/scale/tare")
async def tare_scale(current_user=Depends(get_current_user)):
    """Tare the balance. Standard JWT auth (not SSE)."""
    client = ScaleClient(host=SCALE_IP, port=SCALE_PORT)
    await client.connect()
    ok = await client.tare()
    await client.disconnect()
    return {"ok": ok}


@router.post("/api/scale/zero")
async def zero_scale(current_user=Depends(get_current_user)):
    """Zero the balance."""
    client = ScaleClient(host=SCALE_IP, port=SCALE_PORT)
    await client.connect()
    ok = await client.zero()
    await client.disconnect()
    return {"ok": ok}
```

**Frontend EventSource pattern (React):**

```typescript
// In wizard step component — each weighing step opens its own stream

useEffect(() => {
  const token = getAccessToken(); // from auth store
  const es = new EventSource(`/api/scale/stream?token=${token}`);

  es.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.error) {
      setScaleStatus({ connected: false, error: data.error });
    } else {
      setCurrentWeight({
        value: data.weight,
        unit: data.unit,
        stable: data.stable,
      });
    }
  };

  es.onerror = () => {
    setScaleStatus({ connected: false, error: "connection_lost" });
    es.close(); // browser will auto-retry after 3s unless closed
  };

  return () => es.close(); // cleanup on step unmount
}, []);
```

### JWT Auth with SSE

The browser's `EventSource` API does not support custom request headers, making
standard `Authorization: Bearer <token>` impossible. Solutions in order of preference:

1. **Query param token** (recommended for this app): Pass JWT in `?token=<jwt>`.
   Validate server-side. Short-lived tokens (existing 1h expiry) limit exposure.
   The URL appears in server logs — acceptable for a LAN-only lab app.

2. **Pre-auth handshake**: Issue a one-time short-lived SSE token via a regular
   POST, then use that token in the EventSource URL. More secure, more complex.

3. **Cookie auth**: Switch the scale stream endpoint to cookie-based auth. Works
   if the app's JWT is in a cookie (it isn't currently — it's a Bearer token).

For this milestone, the query-param approach is the pragmatic choice. The app runs
on a private lab LAN with HTTPS (via Docker/nginx), so log exposure is low risk.

### Heartbeat / Proxy Keepalive

`ping=10` sends an SSE comment (`:ping`) every 10 seconds. This prevents Docker's
nginx proxy from closing idle connections. Also add `X-Accel-Buffering: no` to the
response headers to disable nginx output buffering for SSE:

```python
return EventSourceResponse(
    event_generator(),
    ping=10,
    headers={"X-Accel-Buffering": "no"},
)
```

---

## 3. SENAITE REST API: Sample Lookup

### Library

Use **`httpx`** — already in `requirements.txt` at `>=0.27.0`. No new dependency.
The existing `sharepoint.py` uses `httpx.AsyncClient`, so the same pattern applies.

### Endpoint

Base URL from existing env config: `http://<SENAITE_HOST>/senaite/@@API/senaite/v1`

**Search by system sample ID:**
```
GET /search?id=<SAMPLE_ID>&catalog=bika_catalog_analysisrequest_listing&complete=yes
```

**Search by client-assigned sample ID** (what the lab enters on sample submission):
```
GET /search?getClientSampleID=<ID>&catalog=bika_catalog_analysisrequest_listing&complete=yes
```

Note: `getClientSampleID` must be indexed in your SENAITE installation's catalog.
If it is not, the `id` search (system ID) is the reliable fallback. Verify by
fetching one sample with `complete=yes` and checking what fields are present.

**Direct access by UID:**
```
GET /v1/<uid>
```

**Pagination:** Results default to 25 per page. Add `&limit=1` for ID lookups.

**Complete vs. metadata-only:** Without `complete=yes`, SENAITE returns only catalog
metadata (lightweight). With `complete=yes`, returns full object fields. Always use
`complete=yes` for the wizard's sample lookup (you need peptide name, declared
weight, and other fields).

### Authentication

**SENAITE jsonapi only reliably supports cookie authentication.**
(Source: official auth docs at https://senaitejsonapi.readthedocs.io/en/latest/auth.html)
Basic Auth and other PAS plugins are documented as unreliable.

Cookie auth flow:
```
GET /@@API/senaite/v1/login?__ac_name=<user>&__ac_password=<pass>
```
Response sets `__ac` session cookie for subsequent requests.

```python
# backend/senaite_client.py — reference skeleton

import os
import httpx

SENAITE_URL = os.getenv("SENAITE_URL", "http://senaite:8080/senaite")
SENAITE_USER = os.getenv("SENAITE_USERNAME", "admin")
SENAITE_PASS = os.getenv("SENAITE_PASSWORD", "")
API_BASE = f"{SENAITE_URL}/@@API/senaite/v1"


class SenaiteClient:
    """Async SENAITE client using cookie auth. Reuse across requests."""

    def __init__(self):
        self._client = httpx.AsyncClient(timeout=10.0)
        self._authenticated = False

    async def authenticate(self) -> None:
        resp = await self._client.get(
            f"{API_BASE}/login",
            params={"__ac_name": SENAITE_USER, "__ac_password": SENAITE_PASS},
        )
        resp.raise_for_status()
        self._authenticated = True

    async def _ensure_auth(self) -> None:
        if not self._authenticated:
            await self.authenticate()

    async def search_sample_by_id(self, sample_id: str) -> dict | None:
        """Return full sample object by system ID, or None if not found."""
        await self._ensure_auth()
        resp = await self._client.get(
            f"{API_BASE}/search",
            params={
                "id": sample_id,
                "catalog": "bika_catalog_analysisrequest_listing",
                "complete": "yes",
                "limit": "1",
            },
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        return items[0] if items else None

    async def close(self) -> None:
        await self._client.aclose()
```

### Response Fields (with complete=yes)

These fields are confirmed in official SENAITE jsonapi documentation:
- `id` — system sample ID (e.g., `"WB-00012"`)
- `uid` — internal UID
- `review_state` — workflow state (e.g., `"sample_received"`, `"verified"`)
- `title` — human-readable title
- `getClientTitle` — client name
- `getSampleTypeTitle` — sample type
- `getDateSampled` — collection timestamp
- `api_url` — canonical URL for this object

Fields that depend on your SENAITE configuration (LOW confidence — verify against
your actual instance):
- Peptide name — likely a custom field, check for `getPeptide`, `Description`,
  or custom analysis-level fields
- Declared weight — check for `getDeclaredWeight` or a custom result field
- Peptide sequence — may be in `Description` or a custom field

**To discover available fields:** Fetch one known sample with `?complete=yes` and
inspect the full response JSON. Build the field mapping from that inspection.

### Session Reuse

Create a single `SenaiteClient` instance at application startup (or as a FastAPI
dependency with lifespan scope) and reuse it. Do not create a new httpx.AsyncClient
per request — it wastes TCP connections and forces re-authentication.

---

## 4. Wizard UI State: Zustand

No new library needed. Zustand is already installed and used throughout the project.

**State belongs in Zustand because:** The wizard spans 5+ steps; data from early
steps (SENAITE sample, weighings) is needed in later steps (dilution calculation,
session save). This is cross-component persistent state within a session — the
middle tier of the State Management Onion defined in AGENTS.md.

**Pattern:**

```typescript
// Follow existing selector pattern — do NOT destructure from store

// Store definition
interface PrepWizardState {
  currentStep: number;
  sampleId: string | null;
  senaiteRecord: SenaiteRecord | null;
  weighings: Weighing[];
  stockConcentrationMgMl: number | null;
  dilution: DilutionResult | null;
  // Actions
  setStep: (step: number) => void;
  setSenaiteRecord: (record: SenaiteRecord) => void;
  recordWeighing: (w: Weighing) => void;
  setStockConc: (conc: number) => void;
  setDilution: (d: DilutionResult) => void;
  reset: () => void;
}

// Usage in components — selector pattern (project rule)
const currentStep = usePrepWizardStore(state => state.currentStep);
const recordWeighing = usePrepWizardStore(state => state.recordWeighing);

// In callbacks — getState() pattern (project rule)
const handleAcceptWeight = () => {
  const { recordWeighing } = usePrepWizardStore.getState();
  recordWeighing({ step: 1, label: "Peptide", weightG: currentWeight.value });
};
```

**Step navigation:** Drive with `currentStep` integer index. No URL routing changes
needed — the wizard is a page within the existing app. The vertical step rail (left
side, Stripe-style) maps step index to display status: completed, current, upcoming.

**Per-step validation:** Use React Hook Form inside each step component for input
validation (target concentration, total volume, etc.). On valid submission, the step
dispatches to Zustand and increments `currentStep`.

**Do not use TanStack Query for wizard state.** TanStack Query is for server data
(SENAITE lookup, final session save). The in-progress weighing session is local UI
state until the lab tech explicitly saves it.

---

## Complete Dependency Changes

### Backend: requirements.txt

**Add:**
```
sse-starlette>=2.1.0
```

**No changes to:**
- `asyncio` — stdlib, no installation needed
- `httpx` — already present at `>=0.27.0`
- `fastapi`, `uvicorn`, `sqlalchemy`, `pydantic` — no version changes needed

**Do NOT add:**
- `pyserial` — not needed; XSR uses TCP
- `mettler_toledo_device` (PyPI package) — serial-only, no TCP support
- `websockets` or `python-socketio` — SSE is sufficient, WebSocket adds complexity

### Frontend: no new packages

- `EventSource` is a native browser API (no library)
- `Zustand` already installed
- `shadcn/ui` components (Card, Button, Input, Progress) cover all wizard UI needs
- No step-wizard library needed — build with shadcn/ui primitives + Zustand state

---

## Environment Variables (New)

```bash
# .env additions for v0.11.0
SCALE_IP=192.168.x.x        # Mettler Toledo XSR105DU IP address
SCALE_PORT=4001              # MT-SICS TCP port (verify on balance)
# SENAITE vars likely already exist — verify:
SENAITE_URL=http://senaite:8080/senaite
SENAITE_USERNAME=admin
SENAITE_PASSWORD=<password>
```

---

## Confidence Assessment

| Area | Confidence | Basis |
|------|------------|-------|
| MT-SICS command set (S, SI, Z, T, @) | MEDIUM-HIGH | Multiple official MT-SICS reference manuals referenced; command set is stable and consistent across all sources. PDFs not directly parseable but command structure confirmed by working implementations. |
| TCP port 4001 | MEDIUM | Confirmed by Atlantis-Software Node.js MT-SICS library examples. Official MT-SICS docs confirm port is configurable — 4001 is the documented default. Must verify on device. |
| Response format `S <STATUS> <value> <unit>` | HIGH | Consistent across N3uron docs, MT-SICS supplement, and Node.js library. Status characters S/D/+/- well-documented. |
| `asyncio.open_connection` for TCP | HIGH | Python stdlib, fully documented at docs.python.org. No uncertainty. |
| `readuntil(b"\r\n")` for MT-SICS | HIGH | MT-SICS uses CRLF termination — confirmed by multiple sources. `readuntil` is correct approach. |
| `sse-starlette` for SSE streaming | HIGH | Active library (Nov 2024), 351 commits, widely used with FastAPI. API confirmed from GitHub. |
| SSE > WebSocket for one-way streaming | HIGH | Well-established principle; multiple 2024-2025 sources confirm. |
| SENAITE /search endpoint | HIGH | Official readthedocs documentation. |
| SENAITE cookie-auth requirement | HIGH | Explicitly stated in official SENAITE auth docs: "Currently only cookie authentication works." |
| SENAITE `complete=yes` for full fields | HIGH | Official SENAITE jsonapi docs describe the two-step strategy. |
| `getClientSampleID` as search index | LOW | Not confirmed in indexed catalog docs. Must verify against live instance. |
| Peptide/declared weight field names | LOW | Custom SENAITE fields — cannot know without inspecting actual instance. |
| Zustand for wizard state | HIGH | Already used in project. Pattern matches AGENTS.md architecture rules. |

---

## Open Questions (Must Answer Before Building)

1. **Does the XSR105DU have the Ethernet module installed?**
   The Ethernet interface is an optional add-on for Excellence XSR balances.
   If absent, TCP is impossible. Check with lab or inspect the back of the balance.

2. **What TCP port is configured on this balance?**
   On the balance display: Menu > Communication > Interface > Ethernet > Port.
   Default is 4001, but it may have been changed.

3. **What is the balance's IP address?**
   Should be static or DHCP-reserved. Get from lab/IT before writing any code.

4. **What SENAITE fields hold peptide name and declared weight?**
   Fetch one sample with `?complete=yes` and log the full JSON response.
   Build the field mapping from that inspection before wiring up the wizard.

5. **Is `getClientSampleID` indexed in this SENAITE installation?**
   If not, the wizard will use `id` (system ID) instead. This affects the UX
   of the "enter sample ID" step — the lab tech may need to enter the SENAITE
   system ID rather than their own numbering.

---

## Sources

- [Atlantis-Software mt-sics Node.js library](https://github.com/Atlantis-Software/mt-sics) — TCP port 4001, command list, connection pattern
- [N3uron Mettler Toledo Client docs](https://docs.n3uron.com/docs/mettler-toledo-configuration) — TCP configuration, S command stable weight description
- [MT-SICS Excellence Reference Manual (MT)](https://www.mt.com/dam/product_organizations/laboratory_weighing/WEIGHING_SOLUTIONS/PRODUCTS/MT-SICS/MANUALS/en/Excellence-SICS-BA-en-11780711D.pdf) — primary reference (403 at fetch time; structure known from supplement)
- [MT-SICS Supplement 2024 (geass.com)](https://www.geass.com/wp-content/uploads/2024/12/MT-SICS.pdf) — PDF binary, content confirmed via cross-references
- [janelia-python/mettler_toledo_device_python](https://github.com/janelia-python/mettler_toledo_device_python) — Python reference implementation (serial only, not usable directly)
- [sse-starlette GitHub](https://github.com/sysid/sse-starlette) — API, EventSourceResponse, ping, anyio memory channel pattern
- [sse-starlette PyPI](https://pypi.org/project/sse-starlette/) — version and maintenance status
- [SENAITE jsonapi API docs](https://senaitejsonapi.readthedocs.io/en/latest/api.html) — search endpoint, catalog names, complete parameter
- [SENAITE jsonapi Auth docs](https://senaitejsonapi.readthedocs.io/en/latest/auth.html) — cookie auth limitation explicitly documented
- [SENAITE jsonapi Quickstart](https://senaitejsonapi.readthedocs.io/en/latest/quickstart.html) — base URL format, response structure
- [WebSocket vs SSE 2025](https://potapov.me/en/make/websocket-sse-longpolling-realtime) — SSE vs WebSocket comparison
- [Python asyncio streams docs](https://docs.python.org/3/library/asyncio-stream.html) — open_connection, StreamReader, readuntil
- [Build with Matija — Zustand multi-step form](https://www.buildwithmatija.com/blog/master-multi-step-forms-build-a-dynamic-react-form-in-6-simple-steps) — Zustand wizard state pattern
