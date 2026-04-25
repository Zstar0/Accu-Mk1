"""Test-only path shim.

backend/main.py uses bare imports (`from database import ...`, `from auth import ...`)
because it's executed with uvicorn's CWD set to backend/. When pytest runs from the
repo root, `backend/` is not on sys.path, so `from backend.main import app` fails
when main.py tries to `from database import get_db`.

Prepending the absolute path to `backend/` to sys.path resolves the bare imports
without touching main.py's existing import style. Scoped to tests; does not
affect production execution.
"""
import os
import sys

_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)
