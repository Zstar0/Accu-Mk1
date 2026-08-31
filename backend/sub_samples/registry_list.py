"""Map lims_samples rows into the SenaiteSample list shape for GET /registry/samples."""
import json
from typing import Any
from sqlalchemy import select
from sqlalchemy.orm import Session
from models import LimsSample, LimsSampleRemark


def _analyte_names(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    names: list[str] = []
    for a in parsed:
        if isinstance(a, dict) and a.get("name"):
            names.append(str(a["name"]))
    return names


def _analyte_details(raw: str | None) -> list[dict[str, Any]]:
    """Name + declared quantity pairs — the receive page's expanded order rows
    show declared qty, which the names-only flattening above drops."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    out: list[dict[str, Any]] = []
    for a in parsed:
        if isinstance(a, dict) and a.get("name"):
            q = a.get("declared_quantity")
            out.append({
                "name": str(a["name"]),
                "declared_quantity": None if q in (None, "") else str(q),
            })
    return out


def fetch_customer_notes(db: Session, rows: list[LimsSample]) -> dict[int, str]:
    """{lims_sample_pk: customer note} for a page of registry rows.

    lims_sample_remarks holds three kinds of row and only ONE is
    customer-origin:
      * customer order note  -- author_user_id NULL *and* author_label NULL
                               (written by upsert_sample_from_signal from the
                               order signal's Remarks)
      * lab remark           -- a real author_user_id (receive / Add Remark)
      * backfilled SENAITE   -- author_label carries the SENAITE login

    The receive page's column is deliberately narrow (Handler ruling
    2026-08-30): a column that mixes a customer's shipping instruction with a
    lab remark a tech added later cannot be trusted at a glance.

    ONE grouped query for the whole page, never per row -- this feeds a list
    endpoint, so an N+1 here would scale with page size.

    Earliest-wins when a sample somehow carries several: at most one is
    expected (the note is written only on registry-row creation), but the read
    must be deterministic rather than order-of-insertion.
    """
    pks = [r.id for r in rows if getattr(r, "id", None) is not None]
    if not pks:
        return {}
    stmt = (
        select(LimsSampleRemark.lims_sample_pk, LimsSampleRemark.content)
        .where(
            LimsSampleRemark.lims_sample_pk.in_(pks),
            LimsSampleRemark.author_user_id.is_(None),
            LimsSampleRemark.author_label.is_(None),
        )
        # Earliest first, then let the first write into the dict win.
        .order_by(LimsSampleRemark.created_at.asc(), LimsSampleRemark.id.asc())
    )
    notes: dict[int, str] = {}
    for pk, content in db.execute(stmt).all():
        notes.setdefault(pk, content)
    return notes


def registry_rows_to_list(
    rows: list[LimsSample],
    customer_notes: dict[int, str] | None = None,
) -> list[dict[str, Any]]:
    """`customer_notes` comes from fetch_customer_notes(); omitted (None) means
    every row reports no note, which keeps callers that do not need the column
    working unchanged."""
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append({
            # uid is required (non-null) on the response model — fall back to
            # sample_id (NOT NULL + unique) for rows never synced to SENAITE,
            # rather than 500ing the whole list on one uid-less row.
            "uid": r.external_lims_uid or r.sample_id,
            "id": r.sample_id,
            "title": r.sample_id,
            # Prefer client_title (SENAITE getClientTitle, e.g. the email) over
            # the client_id slug, matching /senaite/samples' getClientTitle-or-
            # ClientID precedence (main.py _item_to_model) so the Client column
            # and hide-test email filter agree in Accu-Mk1 mode.
            "client_id": r.client_title or r.client_id,
            "client_order_number": r.client_order_number,
            "date_created": r.date_created.isoformat() if r.date_created else None,
            "date_received": r.date_received.isoformat() if r.date_received else None,
            "date_sampled": r.date_sampled.isoformat() if r.date_sampled else None,
            "review_state": r.status or "",
            "sample_type": r.sample_type_title,
            "contact": r.contact_title,
            "verification_code": r.verification_code,
            "client_lot": r.client_lot,
            "shipping_carrier": r.shipping_carrier,
            "tracking_number": r.tracking_number,
            "tracking_url": r.tracking_url,
            "analytes": _analyte_names(r.analytes),
            "analyte_details": _analyte_details(r.analytes),
            # Customer's wizard note ("Notes for Lab"); None when absent.
            "customer_note": (customer_notes or {}).get(getattr(r, "id", None)),
        })
    return out
