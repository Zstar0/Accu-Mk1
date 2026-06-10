# Phase 2: Scale Bridge Service - Research

**Researched:** 2026-02-19
**Domain:** MT-SICS TCP protocol, Python asyncio TCP client, FastAPI lifespan singleton, graceful degradation
**Confidence:** HIGH for protocol wire format and Python asyncio patterns (verified against official InstrumentKit source and Python docs); MEDIUM for Mettler Toledo XSR-specific TCP port (found port 8001 in web sources but not confirmed against XSR physical hardware documentation)

---

## Summary

Phase 2 adds a singleton `ScaleBridge` class that connects to the Mettler Toledo XSR105DU balance over TCP using the MT-SICS protocol. The service is registered on `app.state` during FastAPI lifespan startup, exposed via a `GET /scale/status` endpoint, and degrades gracefully to "disabled" mode when `SCALE_HOST` is not configured.

The MT-SICS protocol is straightforward: send `SI\r\n` over a raw TCP socket, parse the response line (format: `SI S <weight> <unit>\r\n` for stable or `SI D <weight> <unit>\r\n` for dynamic). No third-party libraries are needed — Python's stdlib `asyncio.open_connection()` handles the TCP client. No new pip packages are required.

The existing codebase already has all patterns needed: the `@asynccontextmanager lifespan` is in `main.py`, the module-level global singleton pattern (used for `file_watcher`) shows the alternative, and the `DEFAULT_SETTINGS` dict plus `seed_default_settings()` shows how to add new settings with defaults.

**Primary recommendation:** Create `backend/scale_bridge.py` as an asyncio-based singleton class, register it on `app.state.scale_bridge` in the lifespan (or as a module-level global matching the `file_watcher` pattern), seed `scale_host` and `scale_port` into DEFAULT_SETTINGS, and add two endpoints: `GET /scale/status` and a `POST /scale/reconnect`.

---

## User Constraints (from STATE.md decisions)

### Locked Decisions
- ScaleBridge as singleton on `app.state` (not per-request connection)
- SSE via `StreamingResponse` (existing codebase pattern — 4 endpoints already using it)
- SCALE_HOST env var controls scale mode; absent = manual-entry mode (no crash)
- Phase 2 is hardware-dependent: confirm Ethernet module, IP, and TCP port on physical balance before coding

### Claude's Discretion
- No CONTEXT.md exists for this phase — implementation details below are research-driven recommendations, not user-locked decisions

### Deferred Ideas (OUT OF SCOPE for Phase 2)
- SSE weight streaming to frontend (Phase 3)
- Stability detection logic (Phase 3 — "5 consecutive readings within 0.5 mg")
- Wizard UI (Phase 4)
- SENAITE lookup (Phase 5)

---

## Standard Stack

No new pip packages required. All capabilities come from Python stdlib and already-installed FastAPI.

### Core (already installed / stdlib)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `asyncio` (stdlib) | Python 3.11+ | TCP client, background reconnect task | Native async I/O; no third-party needed |
| `asyncio.open_connection` | Python 3.11+ | Opens TCP reader/writer pair | Official streams API — simpler than Protocol/Transport |
| `os.environ` (stdlib) | Python 3.11+ | Read SCALE_HOST / SCALE_PORT | Established env-var pattern |
| `fastapi` | 0.115.0 | lifespan, app.state, GET endpoint | Already installed |
| `starlette.responses.StreamingResponse` | via fastapi | Phase 3 SSE (not Phase 2) | Already used in 4 endpoints |

### No New Packages Needed
```bash
# Nothing to install — stdlib asyncio handles all TCP client needs
```

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `asyncio.open_connection` | `mettler_toledo_device` PyPI package | Package adds serial/USB complexity; TCP is simpler to do directly |
| Manual reconnect loop | `backoff` library | No new dependencies needed; simple exponential backoff is straightforward to write |
| `app.state.scale_bridge` | Module-level global (like `file_watcher`) | `app.state` is the locked decision per STATE.md; module-level global is the codebase's current pattern for singletons |

---

## Architecture Patterns

### Recommended File Changes
```
backend/
├── main.py          # MODIFY: lifespan (add scale_bridge init), DEFAULT_SETTINGS, new endpoints
├── scale_bridge.py  # NEW FILE: ScaleBridge class
└── (no models.py changes — scale state is in-memory only)
```

### Pattern 1: ScaleBridge Class (asyncio-based)

**What:** A class that holds one long-lived TCP connection to the balance, with a background reconnect task.
**When to use:** All scale communication goes through one singleton instance.

```python
# Source: asyncio streams pattern (docs.python.org/3/library/asyncio-stream.html) + codebase patterns
import asyncio
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

SCALE_PORT_DEFAULT = 8001  # MT-SICS TCP port for Excellence/XSR series


class ScaleBridge:
    """
    Singleton TCP client for Mettler Toledo MT-SICS protocol.
    Connection is established at startup if SCALE_HOST is set.
    Reconnects automatically on connection loss.
    """

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._connected = False
        self._reconnect_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> bool:
        """Attempt a single connection. Returns True on success."""
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=5.0,
            )
            self._connected = True
            logger.info(f"ScaleBridge connected to {self.host}:{self.port}")
            return True
        except (ConnectionRefusedError, TimeoutError, OSError) as e:
            self._connected = False
            logger.warning(f"ScaleBridge connection failed: {e}")
            return False

    async def disconnect(self):
        """Close connection cleanly."""
        self._connected = False
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
        self._reader = None
        self._writer = None

    async def start(self):
        """Start connection and background reconnect loop."""
        await self.connect()
        self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def stop(self):
        """Shutdown: cancel reconnect task and close connection."""
        if self._reconnect_task:
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass
        await self.disconnect()

    async def _reconnect_loop(self):
        """Background task: reconnect with exponential backoff when disconnected."""
        delay = 2.0
        max_delay = 60.0
        while True:
            await asyncio.sleep(delay)
            if not self._connected:
                success = await self.connect()
                if success:
                    delay = 2.0  # reset on success
                else:
                    delay = min(delay * 2, max_delay)

    async def read_weight(self) -> dict:
        """
        Send SI command and parse response.
        Returns: {"stable": bool, "value": float, "unit": str, "raw": str}
        Raises: ConnectionError if not connected
        """
        if not self._connected:
            raise ConnectionError("Scale not connected")

        async with self._lock:
            try:
                self._writer.write(b"SI\r\n")
                await self._writer.drain()
                line = await asyncio.wait_for(
                    self._reader.readline(),
                    timeout=3.0,
                )
                return _parse_sics_response(line.decode("ascii").strip())
            except (ConnectionResetError, asyncio.IncompleteReadError, OSError) as e:
                self._connected = False
                logger.warning(f"ScaleBridge read error: {e}")
                raise ConnectionError(f"Scale connection lost: {e}") from e
```

### Pattern 2: MT-SICS Response Parsing

**What:** Parse the ASCII response line from the balance into structured data.
**Source:** InstrumentKit mt_sics source (instrumentkit.readthedocs.io, HIGH confidence) + MT-SICS reference manual format description (MEDIUM confidence — not directly read from PDF but consistent across multiple sources).

**MT-SICS SI Response Format:**
```
SI <status> <weight_value> <unit>\r\n
```

Fields:
- `SI` — echo of command sent (response identifier)
- `<status>` — single character: `S` (stable), `D` (dynamic/unstable)
- `<weight_value>` — right-aligned number, 10 chars including decimal and sign, e.g. `   8505.75`
- `<unit>` — weight unit as configured on balance, e.g. `g` or `mg`

Error responses:
- `SI I` — balance in underrange (weight below zero)
- `SI +` — balance in overrange (overload)
- `SI -` — negative value (not used on standard SI)
- `ES` — syntax error in command
- `ET` — transmission error
- `EL` — logical error
- `SI L` — balance in underload range
- `SI E` — weight not determinable (dynamic, range exceeded)

```python
# Source: based on InstrumentKit mt_sics (verified) + MT-SICS spec format
def _parse_sics_response(line: str) -> dict:
    """
    Parse MT-SICS response line into structured dict.

    Valid stable:   "SI S      8505.75 g"
    Valid dynamic:  "SI D      8505.75 g"
    Error:          "SI I" (underrange) | "SI +" (overload)
    Syntax error:   "ES" | "ET" | "EL"

    Returns: {"stable": bool, "value": float, "unit": str, "raw": str}
    Raises: ValueError on parse error or balance error
    """
    parts = line.split()
    # parts[0] = "SI"
    # parts[1] = status: "S", "D", "I", "+", "-", "E", "L"
    # parts[2] = weight value (float string)
    # parts[3] = unit ("g", "mg", etc.)

    if not parts:
        raise ValueError(f"Empty MT-SICS response")

    # Transmission/syntax errors
    if parts[0] in ("ES", "ET", "EL"):
        raise ValueError(f"MT-SICS error: {parts[0]}")

    if len(parts) < 2:
        raise ValueError(f"MT-SICS malformed response: {line!r}")

    status = parts[1]

    if status in ("I", "+", "-", "E", "L"):
        raise ValueError(f"MT-SICS balance error status: {status!r} in {line!r}")

    if len(parts) < 4:
        raise ValueError(f"MT-SICS incomplete response: {line!r}")

    stable = status == "S"
    value = float(parts[2])
    unit = parts[3]

    return {"stable": stable, "value": value, "unit": unit, "raw": line}
```

### Pattern 3: FastAPI Lifespan — Attach Singleton to app.state

**What:** The existing `lifespan` in `main.py` uses `@asynccontextmanager`. Extend it to conditionally start ScaleBridge.
**Source:** FastAPI official docs (fastapi.tiangolo.com/advanced/events/, HIGH confidence) + existing `main.py` lifespan pattern

**Current lifespan (to be extended):**
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    from database import SessionLocal
    db = SessionLocal()
    try:
        seed_default_settings(db)
        seed_admin_user(db)
    finally:
        db.close()
    yield
    # Nothing after yield currently
```

**Extended lifespan (Phase 2 pattern):**
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- existing startup ---
    init_db()
    from database import SessionLocal
    db = SessionLocal()
    try:
        seed_default_settings(db)
        seed_admin_user(db)
    finally:
        db.close()

    # --- scale bridge startup (conditional) ---
    scale_host = os.environ.get("SCALE_HOST")
    scale_port = int(os.environ.get("SCALE_PORT", str(SCALE_PORT_DEFAULT)))

    if scale_host:
        app.state.scale_bridge = ScaleBridge(host=scale_host, port=scale_port)
        await app.state.scale_bridge.start()
        logger.info(f"ScaleBridge started: {scale_host}:{scale_port}")
    else:
        app.state.scale_bridge = None
        logger.info("SCALE_HOST not set — scale bridge disabled (manual-entry mode)")

    yield  # App serves requests

    # --- scale bridge shutdown ---
    if app.state.scale_bridge is not None:
        await app.state.scale_bridge.stop()
        logger.info("ScaleBridge stopped")
```

**Accessing scale_bridge in endpoints:**
```python
from fastapi import Request

@app.get("/scale/status")
async def get_scale_status(request: Request, _current_user=Depends(get_current_user)):
    bridge = request.app.state.scale_bridge
    if bridge is None:
        return {"status": "disabled", "host": None, "port": None}
    return {
        "status": "connected" if bridge.connected else "disconnected",
        "host": bridge.host,
        "port": bridge.port,
    }
```

### Pattern 4: Seeding Settings for SCALE_HOST / SCALE_PORT

**What:** Follow the existing `DEFAULT_SETTINGS` + `seed_default_settings()` pattern.
**Source:** `backend/main.py` lines 251-269 (HIGH confidence — read directly from codebase)

```python
# In DEFAULT_SETTINGS dict (extend existing):
DEFAULT_SETTINGS = {
    "report_directory": "",
    "column_mappings": '...',
    "compound_ranges": '{}',
    "calibration_slope": "1.0",
    "calibration_intercept": "0.0",
    # ADD:
    "scale_host": "",     # Empty = scale disabled; set to IP address to enable
    "scale_port": "8001", # Default MT-SICS TCP port for Excellence/XSR
}
```

Note: The env vars (`SCALE_HOST`, `SCALE_PORT`) take precedence at runtime for the actual bridge. The settings entries allow in-app configuration UI (SCALE-05 requirement). The settings are informational references — the actual bridge is initialized from env vars in lifespan.

### Pattern 5: Standalone Test Script

**What:** A `test_scale.py` script that connects and reads without FastAPI — required by success criterion 1.
**Source:** Python asyncio pattern (docs.python.org, HIGH confidence)

```python
#!/usr/bin/env python3
"""
Standalone test script for MT-SICS TCP connection.
Usage: python test_scale.py 192.168.1.100 8001
"""
import asyncio
import sys
from scale_bridge import ScaleBridge, _parse_sics_response


async def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.100"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8001

    print(f"Connecting to {host}:{port}...")
    bridge = ScaleBridge(host=host, port=port)

    ok = await bridge.connect()
    if not ok:
        print("FAILED: Could not connect")
        return

    print("Connected. Sending SI command...")
    try:
        result = await bridge.read_weight()
        print(f"Weight: {result['value']} {result['unit']} | Stable: {result['stable']}")
        print(f"Raw response: {result['raw']!r}")
    except Exception as e:
        print(f"ERROR: {e}")
    finally:
        await bridge.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
```

### Anti-Patterns to Avoid

- **Per-request connection:** Opening a new TCP socket per HTTP request will cause the balance to queue or reject connections. The singleton pattern is the locked decision.
- **Threading + asyncio mix:** `file_watcher.py` uses `threading.Lock` because it's a synchronous watchdog-based watcher. `ScaleBridge` is fully async — use `asyncio.Lock` not `threading.Lock`.
- **Blocking socket calls in async context:** Never use `socket.recv()` or `socket.connect()` directly in an async function — use `asyncio.open_connection()`.
- **Crashing if SCALE_HOST not set:** The lifespan must set `app.state.scale_bridge = None` when env var is absent. Endpoints must check for `None` before using the bridge.
- **Not draining the writer:** Always `await writer.drain()` after `writer.write(data)` to flush the TCP send buffer.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TCP socket management | Custom socket wrapper | `asyncio.open_connection()` | stdlib, handles buffering, readline, drain |
| MT-SICS response parsing | Full parser with state machine | 4-line `split()` parser | Protocol is trivially line-oriented ASCII |
| Reconnect with jitter | Custom backoff algorithm | Simple `delay * 2` capped at 60s | overkill for a local LAN device |
| Balance driver | `mettler_toledo_device` PyPI package | Raw asyncio TCP | Package is serial-centric; TCP is 20 lines of code |
| Connection pooling | Thread-safe pool | Single persistent connection + `asyncio.Lock` | Balance only supports one client at a time anyway |

**Key insight:** MT-SICS is intentionally simple. The entire TCP client including reconnect logic is about 80 lines of Python. Avoid adding dependencies for this.

---

## Common Pitfalls

### Pitfall 1: Balance Only Accepts One TCP Connection at a Time

**What goes wrong:** Second connection attempt while one is active causes the first to drop silently, or the second fails.
**Why it happens:** Most Mettler Toledo Ethernet interfaces expose a single TCP server socket with a 1-client limit.
**How to avoid:** Always maintain exactly one connection (the singleton). Never open a second connection in the test script while the app is running.
**Warning signs:** Intermittent disconnects that correlate with multiple clients connecting.

### Pitfall 2: asyncio.Lock Required for Concurrent Reads

**What goes wrong:** Two concurrent `read_weight()` calls on the same `(reader, writer)` pair interleave sends and reads. Response to command 1 gets consumed by command 2's readline.
**Why it happens:** TCP streams are not request/response locked by default. Concurrent calls race on the shared stream.
**How to avoid:** `asyncio.Lock` around `write + drain + readline` in `read_weight()`. One pending request at a time.
**Warning signs:** `ValueError` from `_parse_sics_response` about unexpected response format (response of command N consumed by command N+1).

### Pitfall 3: Reconnect Task Runs Forever After App Shutdown

**What goes wrong:** `asyncio.create_task(_reconnect_loop())` is still running when lifespan's `yield` returns. Uvicorn exits with a "task was destroyed but pending" warning or hangs.
**Why it happens:** Background task not cancelled before shutdown.
**How to avoid:** In the `stop()` method, `task.cancel()` + `await task` with `CancelledError` catch. The lifespan's post-yield code calls `bridge.stop()`.
**Warning signs:** Uvicorn logs "Task was destroyed but it is pending" on shutdown.

### Pitfall 4: readline() Blocks if Balance Sends No CRLF

**What goes wrong:** `await reader.readline()` waits forever if the balance sends a partial line or no response.
**Why it happens:** MT-SICS always uses `\r\n` terminators, but a broken connection or wrong port can return no data.
**How to avoid:** Always wrap `reader.readline()` in `asyncio.wait_for(..., timeout=3.0)`. A 3-second timeout is sufficient for a local LAN balance.
**Warning signs:** Request to `/scale/status` hangs indefinitely.

### Pitfall 5: TCP Port is Unknown Until Physical Balance is Checked

**What goes wrong:** Code ships with `port=8001` hard-coded, but the physical XSR105DU has a different port configured (e.g., 23 if Telnet mode, or a custom port set by the lab).
**Why it happens:** MT-SICS over Ethernet uses port 8001 on Excellence series, but the XSR Ethernet module configuration may differ. This cannot be confirmed without physical hardware access.
**How to avoid:**
1. Make port fully configurable via `SCALE_PORT` env var with default 8001
2. Ensure `test_scale.py` accepts host and port as CLI arguments
3. STATE.md decision: "confirm Ethernet module, IP, and TCP port on physical balance before coding begins"
**Warning signs:** Connection refused on port 8001 — try port 23 (Telnet mode) as fallback.

### Pitfall 6: `app.state` Not Available in Module-Level Code

**What goes wrong:** Accessing `app.state.scale_bridge` at module level (before lifespan runs) raises `AttributeError`.
**Why it happens:** `app.state` attributes are set during lifespan startup, not at import time.
**How to avoid:** Only access `app.state.scale_bridge` inside endpoint functions via `request.app.state` or `app.state` (after the app is running). Never at module level.
**Warning signs:** `AttributeError: 'State' object has no attribute 'scale_bridge'` at import.

### Pitfall 7: Response Encoding

**What goes wrong:** `line.decode("utf-8")` fails on special characters in unit strings.
**Why it happens:** MT-SICS uses ASCII only — not UTF-8. Decoding with UTF-8 is fine for ASCII-only data, but explicitly using `"ascii"` is more correct and avoids edge cases.
**How to avoid:** Use `line.decode("ascii", errors="replace")` to safely handle any unexpected non-ASCII bytes.

---

## Code Examples

### Complete ScaleBridge (Minimal Verified Pattern)

```python
# backend/scale_bridge.py — full implementation sketch
import asyncio
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

SCALE_PORT_DEFAULT = 8001


def _parse_sics_response(line: str) -> dict:
    """
    Parse MT-SICS response line.
    Format: "SI S     8505.75 g"  (stable)
    Format: "SI D     8505.75 g"  (dynamic/unstable)
    Raises: ValueError on error response or parse failure.
    """
    parts = line.split()
    if not parts:
        raise ValueError("Empty MT-SICS response")
    if parts[0] in ("ES", "ET", "EL"):
        raise ValueError(f"MT-SICS protocol error: {parts[0]}")
    if len(parts) < 4:
        raise ValueError(f"MT-SICS incomplete response: {line!r}")
    status = parts[1]
    if status not in ("S", "D"):
        raise ValueError(f"MT-SICS error status: {status!r}")
    return {
        "stable": status == "S",
        "value": float(parts[2]),
        "unit": parts[3],
        "raw": line,
    }


class ScaleBridge:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._connected = False
        self._reconnect_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> bool:
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port), timeout=5.0
            )
            self._connected = True
            logger.info(f"ScaleBridge connected to {self.host}:{self.port}")
            return True
        except Exception as e:
            self._connected = False
            logger.warning(f"ScaleBridge connection failed: {e}")
            return False

    async def disconnect(self):
        self._connected = False
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
        self._reader = None
        self._writer = None

    async def start(self):
        await self.connect()
        self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def stop(self):
        if self._reconnect_task:
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass
        await self.disconnect()

    async def _reconnect_loop(self):
        delay = 2.0
        while True:
            await asyncio.sleep(delay)
            if not self._connected:
                success = await self.connect()
                delay = 2.0 if success else min(delay * 2, 60.0)

    async def read_weight(self) -> dict:
        if not self._connected:
            raise ConnectionError("Scale not connected")
        async with self._lock:
            self._writer.write(b"SI\r\n")
            await self._writer.drain()
            line = await asyncio.wait_for(self._reader.readline(), timeout=3.0)
            if self._writer.is_closing():
                self._connected = False
                raise ConnectionError("Scale connection lost")
        return _parse_sics_response(line.decode("ascii", errors="replace").strip())
```

### Lifespan Extension Pattern

```python
# Extend existing lifespan in main.py
@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- existing code ---
    init_db()
    from database import SessionLocal
    db = SessionLocal()
    try:
        seed_default_settings(db)
        seed_admin_user(db)
    finally:
        db.close()

    # --- scale bridge (Phase 2 addition) ---
    from scale_bridge import ScaleBridge, SCALE_PORT_DEFAULT
    scale_host = os.environ.get("SCALE_HOST")
    scale_port = int(os.environ.get("SCALE_PORT", str(SCALE_PORT_DEFAULT)))
    if scale_host:
        bridge = ScaleBridge(host=scale_host, port=scale_port)
        await bridge.start()
        app.state.scale_bridge = bridge
    else:
        app.state.scale_bridge = None

    yield

    # --- scale bridge shutdown ---
    if app.state.scale_bridge is not None:
        await app.state.scale_bridge.stop()
```

### Status Endpoint Pattern

```python
# Access app.state via Request object
from fastapi import Request

@app.get("/scale/status")
async def get_scale_status(
    request: Request,
    _current_user=Depends(get_current_user),
):
    """Get scale connection status."""
    bridge = request.app.state.scale_bridge
    if bridge is None:
        return {"status": "disabled", "host": None, "port": None}
    return {
        "status": "connected" if bridge.connected else "disconnected",
        "host": bridge.host,
        "port": bridge.port,
    }
```

---

## Endpoint Design

| Method | Path | Purpose | Auth | Phase |
|--------|------|---------|------|-------|
| `GET` | `/scale/status` | Returns connected/disconnected/disabled + host/port | JWT | Phase 2 |
| `POST` | `/scale/reconnect` | Manually trigger reconnect attempt | JWT | Phase 2 (optional) |

`GET /scale/status` response schema:
```json
{
  "status": "connected" | "disconnected" | "disabled",
  "host": "192.168.1.100" | null,
  "port": 8001 | null
}
```

`GET /scale/read` (Phase 3 — SSE streaming, not Phase 2) — deferred.

---

## MT-SICS Wire Format Reference

| Direction | Data | Description |
|-----------|------|-------------|
| Client → Balance | `SI\r\n` | Request immediate weight (regardless of stability) |
| Client → Balance | `S\r\n` | Request stable weight only (blocks until stable) |
| Client → Balance | `Z\r\n` | Zero the balance |
| Client → Balance | `T\r\n` | Tare |
| Client → Balance | `@\r\n` | Reset balance |
| Balance → Client | `SI S      8505.75 g\r\n` | Stable reading: 8505.75 g |
| Balance → Client | `SI D      8505.75 g\r\n` | Dynamic (unstable) reading |
| Balance → Client | `SI I\r\n` | Underrange error |
| Balance → Client | `SI +\r\n` | Overload |
| Balance → Client | `ES\r\n` | Syntax error (bad command) |
| Balance → Client | `ET\r\n` | Transmission error |
| Balance → Client | `EL\r\n` | Logical error |

**Key details:**
- Terminator: always `\r\n` (CRLF, ASCII 13 + 10) — both sent and received
- Encoding: ASCII (7-bit)
- Weight field: right-aligned, 10 chars including decimal and sign
- SI is preferred over S for Phase 2 (Phase 3 adds stability detection in application layer)
- TCP port: 8001 (confirmed for Excellence series; verify against physical XSR hardware)

---

## Settings Integration (SCALE-05)

The settings system in `main.py` uses `DEFAULT_SETTINGS` dict + `seed_default_settings()`. New keys to add:

```python
DEFAULT_SETTINGS = {
    # ... existing keys ...
    "scale_host": "",     # Empty string = scale disabled
    "scale_port": "8001", # Default MT-SICS TCP port
}
```

Settings are stored in the SQLite `settings` table and editable via `PUT /settings/scale_host` and `PUT /settings/scale_port`. The app settings UI (Phase 4) can wire these inputs.

**Important:** The running `ScaleBridge` instance reads from env vars at startup, not from the settings table. If the user changes `scale_host` in the UI, they need to restart the app for the bridge to reconnect to a new host. This is consistent with how most backend configuration changes work.

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `@app.on_event("startup")` decorator | `@asynccontextmanager lifespan` (FastAPI ≥0.95) | Lifespan already used in this codebase — no migration needed |
| `socket` module directly | `asyncio.open_connection()` | asyncio streams are safer in coroutine context |
| Module-level global (like `file_watcher`) | `app.state.scale_bridge` | Locked decision from STATE.md — but functionally equivalent; both are singletons |

---

## Open Questions

1. **Physical XSR105DU TCP port**
   - What we know: Excellence series uses port 8001. Arduino/lab community references port 8001. Some balances use port 23 (Telnet).
   - What's unclear: The XSR105DU has an Ethernet Interface Kit — what port does it expose by default?
   - Recommendation: Hard-code 8001 as default, make fully configurable via `SCALE_PORT` env var. The `test_scale.py` script should take port as a CLI argument. STATE.md says: confirm port before coding begins.
   - **BLOCKER for execution:** Requires physical hardware access to verify before running `test_scale.py`.

2. **SI vs SIR command**
   - What we know: `SI` sends weight immediately once. `SIR` sends weight continuously until `@` reset.
   - What's unclear: Phase 3 requires live weight streaming — `SIR` continuous mode may be needed then.
   - Recommendation: Phase 2 uses `SI` (poll on demand). Phase 3 research should evaluate `SIR` for SSE streaming.

3. **Balance response when idle vs after S command timeout**
   - What we know: `S` command blocks until stable — balance only responds when weight is stable.
   - What's unclear: Does `S` time out if the balance never stabilizes?
   - Recommendation: Use `SI` (immediate) for Phase 2 status checks. `S` with a long timeout is more relevant for Phase 3 stable-weight detection.

---

## Sources

### Primary (HIGH confidence)
- `backend/main.py` (lines 272-294) — Existing lifespan pattern, app.state, DEFAULT_SETTINGS
- `backend/file_watcher.py` — Module-level singleton pattern currently in use
- `backend/requirements.txt` — Confirms no asyncio-related packages needed
- FastAPI official docs: https://fastapi.tiangolo.com/advanced/events/ — lifespan + app.state pattern
- Python stdlib docs: https://docs.python.org/3/library/asyncio-stream.html — `open_connection`, `StreamReader.readline`, `StreamWriter.write`/`drain`
- InstrumentKit mt_sics source: https://instrumentkit.readthedocs.io/en/latest/_modules/instruments/mettler_toledo/mt_sics.html — Confirmed `SI\r\n` command, `\r\n` terminator, stability flags S/D, error codes ES/ET/EL/I/L/+/-, weight field format

### Secondary (MEDIUM confidence)
- Multiple MT-SICS reference manual PDFs (403 errors on fetch, but consistent format description extracted from WebSearch): response format `SI <status> <weight_value> <unit>\r\n`, 10-char right-aligned weight field
- N3uron docs and web sources: TCP port 8001 for Excellence series Ethernet interface
- `mettler_toledo_device` PyPI page: confirms `get_weight()` returns `[-0.68, 'g', 'S']` — weight, unit, stability flag

### Tertiary (LOW confidence, flag for validation)
- TCP port 8001 for XSR105DU specifically: confirmed for Excellence series but XSR-specific hardware documentation was not directly read. Must verify against physical hardware.
- `SIR` (continuous read) mode: mentioned in web sources but not directly verified from official docs for Phase 3 use.

---

## Metadata

**Confidence breakdown:**
- MT-SICS wire format: HIGH — confirmed from InstrumentKit source code reading the actual Python client
- asyncio TCP patterns: HIGH — Python stdlib official documentation
- FastAPI lifespan + app.state: HIGH — official FastAPI docs + existing codebase pattern
- TCP port (8001): MEDIUM — found in multiple sources for Excellence series, not confirmed for XSR105DU specifically
- Reconnect pattern: HIGH — standard asyncio practice, no exotic behavior
- Graceful degradation: HIGH — straightforward `if scale_host:` guard in lifespan

**Research date:** 2026-02-19
**Valid until:** 2026-05-19 (stable stdlib and FastAPI patterns — 90 days)
**Hardware dependency:** TCP port and IP address must be confirmed against physical XSR105DU before `test_scale.py` can be run. This is a stated blocker in STATE.md.
