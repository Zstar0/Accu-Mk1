"""Mk1 customer key -> customer emails (IS DB) -> Close leads."""
from __future__ import annotations

from typing import Any, Callable

from integration_db import get_integration_db

_ACCOUNT_EMAIL_SQL = "SELECT email FROM wc_customers WHERE id = %s AND deleted_at IS NULL"
_BILLING_EMAILS_SQL = ("SELECT DISTINCT billing_email FROM wc_orders "
                       "WHERE customer_id = %s AND billing_email IS NOT NULL")


def _clean(values) -> list[str]:
    out: list[str] = []
    for v in values:
        e = (v or "").strip().lower()
        if e and e not in out:
            out.append(e)
    return out


def customer_emails(customer_key: str, conn_factory: Callable = get_integration_db) -> list[str] | None:
    if customer_key.startswith("email:"):
        return _clean([customer_key[6:]])
    if not customer_key.startswith("wc:") or not customer_key[3:].isdigit():
        return None
    cid = int(customer_key[3:])
    with conn_factory() as conn, conn.cursor() as cur:
        cur.execute(_ACCOUNT_EMAIL_SQL, (cid,))
        account = cur.fetchall()
        cur.execute(_BILLING_EMAILS_SQL, (cid,))
        billing = cur.fetchall()
    if not account and not billing:
        return None
    return _clean([r[0] for r in account] + [r[0] for r in billing])


_LEAD_FIELDS = "id,display_name,status_label,html_url,contacts,opportunities"


def find_leads(emails: list[str], client) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for e in emails:
        page = client.get("lead/", {"query": f'email_address:"{e}"', "_fields": _LEAD_FIELDS})
        for lead in page.get("data") or []:
            seen.setdefault(lead["id"], lead)
    return list(seen.values())


def shape_lead(raw: dict[str, Any]) -> dict[str, Any]:
    opps = sorted(raw.get("opportunities") or [], key=lambda o: o.get("date_updated") or "", reverse=True)
    return {
        "id": raw["id"],
        "name": raw.get("display_name") or raw["id"],
        "status": raw.get("status_label"),
        # Close leads have no built-in owner: the rep on the most recently updated opportunity.
        "owner": opps[0].get("user_name") if opps else None,
        "url": raw.get("html_url") or f"https://app.close.com/lead/{raw['id']}/",
        "contacts": [{"name": c.get("name") or "",
                      "emails": [x.get("email") for x in c.get("emails") or [] if x.get("email")],
                      "phones": [x.get("phone") for x in c.get("phones") or [] if x.get("phone")]}
                     for c in raw.get("contacts") or []],
        "opportunities": [{"status": o.get("status_label"),
                           "value": round((o.get("value") or 0) / 100, 2),
                           "value_period": o.get("value_period"), "confidence": o.get("confidence"),
                           "expected_date": o.get("expected_date")} for o in opps],
    }
