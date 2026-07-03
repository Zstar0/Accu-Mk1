"""One SSL context shared by every ad-hoc httpx client (memory-leak fix).

httpx eagerly builds a fresh ssl.SSLContext — a full CA-bundle parse, ~340 kB
of allocations — for every Client()/AsyncClient() constructed without an
explicit verify= or transport=, even when the target URL is plain http. The
backend constructs clients per request (SENAITE proxying, SharePoint), so each
such call ratcheted RSS by ~340 kB that the allocator never returned to the OS
(~2 GB/hour under an active lab session — the 2026-07-02 prod memory alert;
A/B-measured 343.7 → 3.9 kB/call with the shared context).

An SSLContext is read-only after construction and safe to share across
clients, threads, and asyncio tasks for outbound connections.
"""
import ssl

HTTPX_SSL_CONTEXT = ssl.create_default_context()
