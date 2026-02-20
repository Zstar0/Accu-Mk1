"""
ScaleBridge — asyncio TCP client for Mettler Toledo balances using MT-SICS protocol.

Provides a singleton-style class that connects to an Excellence/XSR series
balance over Ethernet, sends SI (Send Immediately) commands, and parses the
ASCII response into structured weight readings.

Usage (via FastAPI app.state):
    bridge = ScaleBridge(host="192.168.3.113", port=8001)
    await bridge.start()
    ...
    result = await bridge.read_weight()
    # -> {"stable": True, "value": 8505.75, "unit": "g", "raw": "SI S      8505.75 g"}
    await bridge.stop()
"""

import asyncio
import logging
from typing import Optional

# Default TCP port for MT-SICS on Excellence/XSR series Ethernet modules
SCALE_PORT_DEFAULT = 8001

logger = logging.getLogger(__name__)


def _parse_sics_response(line: str) -> dict:
    """
    Parse a single MT-SICS ASCII response line.

    MT-SICS SI response format:
        <command> <status> <value> <unit>
        e.g.  "SI S      8505.75 g"
              "SI D      123.45 mg"

    Args:
        line: Stripped response string from the balance.

    Returns:
        dict with keys:
            stable (bool): True if status is 'S' (stable), False if 'D' (dynamic)
            value  (float): Numeric weight value
            unit   (str):   Unit string, e.g. "g", "mg", "kg"
            raw    (str):   Original unmodified line

    Raises:
        ValueError: For error responses (ES, ET, EL), invalid status flags
                    (I, +, -, E, L), or malformed/incomplete responses.
    """
    raw = line

    # Top-level error codes — balance or communication error
    parts = line.split()
    if len(parts) == 0:
        raise ValueError(f"Empty response from scale")

    # Single-token error responses
    if parts[0] in ("ES", "ET", "EL"):
        raise ValueError(f"MT-SICS error response: {parts[0]!r}")

    # Need at least 4 tokens: command, status, value, unit
    if len(parts) < 4:
        # Check if the second token (status) is itself an error code
        if len(parts) >= 2 and parts[1] in ("I", "+", "-", "E", "L"):
            raise ValueError(f"Balance error status: {parts[1]!r} in response {line!r}")
        raise ValueError(f"Malformed MT-SICS response (expected 4+ parts): {line!r}")

    _command, status_flag, value_str, unit = parts[0], parts[1], parts[2], parts[3]

    # Validate status flag
    if status_flag in ("I", "+", "-", "E", "L"):
        raise ValueError(f"Balance error status: {status_flag!r} in response {line!r}")

    if status_flag not in ("S", "D"):
        raise ValueError(f"Unknown MT-SICS status flag: {status_flag!r} in response {line!r}")

    try:
        value = float(value_str)
    except ValueError:
        raise ValueError(f"Cannot parse weight value {value_str!r} in response {line!r}")

    return {
        "stable": status_flag == "S",
        "value": value,
        "unit": unit,
        "raw": raw,
    }


class ScaleBridge:
    """
    Asyncio TCP client for Mettler Toledo balances (MT-SICS protocol).

    Designed as a singleton stored on FastAPI's app.state.  Maintains a
    persistent connection with automatic exponential-backoff reconnection.

    Example lifecycle (FastAPI lifespan):
        bridge = ScaleBridge(host=scale_host, port=scale_port)
        await bridge.start()          # connect + start reconnect loop
        app.state.scale_bridge = bridge
        yield
        await bridge.stop()           # cancel reconnect loop + disconnect
    """

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._connected: bool = False
        self._reconnect_task: Optional[asyncio.Task] = None
        self._lock: asyncio.Lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        """Return True if the bridge currently has an active connection."""
        return self._connected

    async def connect(self) -> bool:
        """
        Attempt a single TCP connection to the balance.

        Returns True on success, False on any connection error.
        Does NOT start the reconnect loop — call start() for that.
        """
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=5.0,
            )
            self._connected = True
            logger.info(f"ScaleBridge connected to {self.host}:{self.port}")
            return True
        except (ConnectionRefusedError, TimeoutError, OSError) as exc:
            self._connected = False
            logger.warning(f"ScaleBridge failed to connect to {self.host}:{self.port}: {exc}")
            return False

    async def disconnect(self):
        """Close the TCP connection and reset state."""
        self._connected = False
        if self._writer is not None:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception as exc:
                logger.debug(f"ScaleBridge disconnect error (ignored): {exc}")
            finally:
                self._writer = None
                self._reader = None

    async def start(self):
        """
        Connect and start the background reconnect loop.

        Call this during FastAPI lifespan startup.
        """
        await self.connect()
        self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def stop(self):
        """
        Cancel the reconnect loop and close the connection.

        Call this during FastAPI lifespan shutdown.
        """
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass
            self._reconnect_task = None
        await self.disconnect()

    async def _reconnect_loop(self):
        """
        Background task: reconnect with exponential backoff when disconnected.

        Initial delay: 2 s. Doubles on each failure, capped at 60 s.
        Resets to 2 s on successful reconnection.
        """
        delay = 2.0
        while True:
            await asyncio.sleep(delay)
            if not self._connected:
                success = await self.connect()
                if success:
                    delay = 2.0
                else:
                    delay = min(delay * 2, 60.0)

    async def read_weight(self) -> dict:
        """
        Send an SI command to the balance and return the parsed response.

        Returns:
            dict: {"stable": bool, "value": float, "unit": str, "raw": str}

        Raises:
            ConnectionError: If not connected or connection drops during read.
            ValueError: If the balance response is malformed or indicates an error.
        """
        if not self._connected:
            raise ConnectionError("Scale not connected")

        async with self._lock:
            try:
                self._writer.write(b"SI\r\n")
                await self._writer.drain()
                raw_line = await asyncio.wait_for(
                    self._reader.readline(),
                    timeout=3.0,
                )
            except (ConnectionResetError, asyncio.IncompleteReadError, OSError) as exc:
                self._connected = False
                logger.warning(f"ScaleBridge read error (connection lost): {exc}")
                raise ConnectionError(f"Scale connection lost: {exc}") from exc

        line = raw_line.decode("ascii", errors="replace").strip()
        return _parse_sics_response(line)
