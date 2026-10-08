"""Customer emails (from crm_close.match.customer_emails) -> Plain customers."""
from __future__ import annotations

from typing import Any

from crm_close.match import _EMAIL
from support_plain import queries


def find_customers(emails: list[str], client) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for e in emails:
        if not _EMAIL.match(e):
            continue
        found = client.query(queries.CUSTOMER_BY_EMAIL, {"email": e}).get("customerByEmail")
        if found and found.get("id"):
            seen.setdefault(found["id"], found)
    return list(seen.values())
