"""Read helpers for the vial_roles catalog (spec 4). Fail-closed: callers treat a
registry miss as an error, never a silent drop."""
import re

from models import VialRole

_CODE_RE = re.compile(r"[a-z][a-z0-9_]{0,7}")


def role_registry(db) -> dict:
    """All roles keyed by code. One query; call once per request path."""
    return {r.code: r for r in db.query(VialRole).all()}


def real_bucket_codes(db) -> list[str]:
    """Assignable demand buckets: every role with a department, ordered. xtra (NULL
    department) is the reserved unassigned bucket and is deliberately excluded."""
    rows = (
        db.query(VialRole)
        .filter(VialRole.department_id.isnot(None))
        .order_by(VialRole.sort_order, VialRole.code)
        .all()
    )
    return [r.code for r in rows]


def suggest_role_code(key: str, existing: set) -> str:
    """Derive a role code from a profile key: lowercase, strip invalid chars,
    truncate to 8, uniquify with a numeric suffix."""
    base = re.sub(r"[^a-z0-9_]", "_", key.lower()).strip("_") or "role"
    if not base[0].isalpha():
        base = "r" + base
    code = base[:8]
    n = 2
    while code in existing:
        suffix = str(n)
        code = base[: 8 - len(suffix)] + suffix
        n += 1
    return code
