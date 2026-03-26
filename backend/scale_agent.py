#!/usr/bin/env python3
"""
Local Scale Agent — lightweight HTTP service for bridging a Mettler Toledo
balance to the AccuMk1 web app running on DigitalOcean.

Runs on the lab machine alongside the browser. The web frontend discovers it
at http://localhost:8765 and streams live weight readings via SSE.

Usage:
    python scale_agent.py                          # defaults: 192.168.3.113:8001
    python scale_agent.py --scale-host 10.0.0.5    # custom scale IP
    python scale_agent.py --port 9000              # custom agent port

Requires: fastapi, uvicorn (already in requirements.txt)
"""

import argparse
import asyncio
import logging
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager

from scale_bridge import ScaleBridge

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scale_agent")

# --- Globals set by CLI args before app starts ---
_bridge: ScaleBridge | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bridge
    if _bridge is not None:
        await _bridge.start()
        if _bridge.connected:
            logger.info(f"Scale connected: {_bridge.host}:{_bridge.port}")
        else:
            logger.warning(
                f"Scale not reachable at {_bridge.host}:{_bridge.port} "
                "— will keep retrying in background"
            )
    yield
    if _bridge is not None:
        await _bridge.stop()


app = FastAPI(title="AccuMk1 Local Scale Agent", lifespan=lifespan)

# Allow the DO-hosted frontend to call us on localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://accumk1.valencenanalytical.com",
        "http://localhost:5173",   # local Vite dev
        "http://localhost:1420",   # Tauri dev
    ],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/scale/status")
async def scale_status():
    """Return current connection status — no auth required."""
    if _bridge is None:
        return {"status": "disabled"}
    return {
        "status": "connected" if _bridge.connected else "disconnected",
        "host": _bridge.host,
        "port": _bridge.port,
    }


@app.get("/scale/weight")
async def scale_weight():
    """Single weight reading — handy for quick tests."""
    if _bridge is None or not _bridge.connected:
        return {"error": "Scale not connected"}
    try:
        reading = await _bridge.read_weight()
        return reading
    except Exception as exc:
        return {"error": str(exc)}


@app.get("/scale/weight/stream")
async def scale_weight_stream():
    """SSE endpoint streaming weight at ~4 Hz. Same event format as the DO backend."""

    async def event_generator():
        while True:
            if _bridge is None or not _bridge.connected:
                yield 'event: error\ndata: {"message": "Scale not connected"}\n\n'
                await asyncio.sleep(2.0)
                continue

            try:
                reading = await _bridge.read_weight()
                import json
                payload = json.dumps({
                    "value": reading["value"],
                    "unit": reading["unit"],
                    "stable": reading["stable"],
                })
                yield f"event: weight\ndata: {payload}\n\n"
            except ConnectionError:
                yield 'event: error\ndata: {"message": "Scale connection lost"}\n\n'
                await asyncio.sleep(1.0)
                continue
            except Exception as exc:
                yield f'event: error\ndata: {{"message": "{exc}"}}\n\n'
                await asyncio.sleep(1.0)
                continue

            await asyncio.sleep(0.25)  # ~4 Hz

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def main():
    parser = argparse.ArgumentParser(description="AccuMk1 Local Scale Agent")
    parser.add_argument(
        "--scale-host",
        default="192.168.3.113",
        help="Mettler Toledo balance IP (default: 192.168.3.113)",
    )
    parser.add_argument(
        "--scale-port",
        type=int,
        default=8001,
        help="MT-SICS TCP port (default: 8001)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="HTTP port for this agent (default: 8765)",
    )
    args = parser.parse_args()

    global _bridge
    _bridge = ScaleBridge(host=args.scale_host, port=args.scale_port)

    logger.info(f"Starting scale agent on http://localhost:{args.port}")
    logger.info(f"Scale target: {args.scale_host}:{args.scale_port}")

    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
