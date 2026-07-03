"""Every ad-hoc httpx client must reuse the shared SSL context.

httpx eagerly builds a fresh ssl.SSLContext — a full CA-bundle parse, ~340 kB
of allocations — for every Client()/AsyncClient() constructed without an
explicit verify= or transport=, even when the target URL is plain http. The
backend constructs clients per request (SENAITE proxying, SharePoint), so each
such call ratcheted RSS by ~340 kB that the allocator never returned to the OS
(~2 GB/hour under an active lab session — the 2026-07-02 prod memory alert).

This test walks the backend source and fails on any httpx client construction
that doesn't pass verify= (the shared context) or its own transport=, so the
leak class can't silently come back with new code.
"""
import ast
import pathlib

BACKEND = pathlib.Path(__file__).resolve().parents[1]


def _iter_backend_sources():
    for path in BACKEND.rglob("*.py"):
        rel = path.relative_to(BACKEND)
        if rel.parts[0] in ("tests", "__pycache__"):
            continue
        yield path


def _httpx_client_calls(tree):
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in ("Client", "AsyncClient")
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "httpx"
        ):
            yield node


def test_all_httpx_clients_share_ssl_context():
    offenders = []
    for path in _iter_backend_sources():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for call in _httpx_client_calls(tree):
            kwargs = {kw.arg for kw in call.keywords}
            if not kwargs & {"verify", "transport"}:
                offenders.append(f"{path.relative_to(BACKEND)}:{call.lineno}")
    assert not offenders, (
        "httpx client(s) built without verify=HTTPX_SSL_CONTEXT (or a shared "
        "transport) — each such construction loads a fresh CA bundle and leaks "
        f"~340 kB RSS per call:\n  " + "\n  ".join(offenders)
    )


def test_files_using_shared_context_import_it():
    """A file that references HTTPX_SSL_CONTEXT must actually import it —
    guards against the call-site patch landing without its import (runtime
    NameError the kwarg scan above cannot see)."""
    offenders = []
    for path in _iter_backend_sources():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        uses = any(
            isinstance(n, ast.Name) and n.id == "HTTPX_SSL_CONTEXT"
            and isinstance(n.ctx, ast.Load)
            for n in ast.walk(tree)
        )
        if not uses:
            continue
        imports = any(
            isinstance(n, ast.ImportFrom) and n.module == "httpx_shared"
            and any(a.name == "HTTPX_SSL_CONTEXT" for a in n.names)
            for n in ast.walk(tree)
        )
        if not imports:
            offenders.append(str(path.relative_to(BACKEND)))
    assert not offenders, (
        "HTTPX_SSL_CONTEXT used without `from httpx_shared import "
        "HTTPX_SSL_CONTEXT` (runtime NameError):\n  " + "\n  ".join(offenders)
    )
