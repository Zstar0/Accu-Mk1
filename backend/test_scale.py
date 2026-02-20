#!/usr/bin/env python3
"""
Standalone test script for Mettler Toledo MT-SICS TCP connection.
Tests direct balance communication without FastAPI.

Usage:
    python test_scale.py                         # Uses defaults: 192.168.3.113:8001
    python test_scale.py 192.168.3.113          # Custom host, default port
    python test_scale.py 192.168.3.113 8001     # Custom host and port
"""
import asyncio
import sys

from scale_bridge import ScaleBridge


async def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "192.168.3.113"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8001

    print(f"Connecting to {host}:{port}...")
    bridge = ScaleBridge(host=host, port=port)

    ok = await bridge.connect()
    if not ok:
        print(f"FAILED: Could not connect to {host}:{port}")
        print("Check that:")
        print("  1. The balance is powered on")
        print("  2. The Ethernet module is installed and configured")
        print("  3. The IP address and port are correct")
        sys.exit(1)

    print("Connected. Sending SI command...")
    try:
        result = await bridge.read_weight()
        stability = "STABLE" if result["stable"] else "DYNAMIC"
        print(f"Stability: {stability}")
        print(f"Weight:    {result['value']} {result['unit']}")
        print(f"Raw:       {result['raw']!r}")
    except Exception as e:
        print(f"ERROR reading weight: {e}")
        sys.exit(1)
    finally:
        await bridge.disconnect()

    print("\nScale communication test PASSED")


if __name__ == "__main__":
    asyncio.run(main())
