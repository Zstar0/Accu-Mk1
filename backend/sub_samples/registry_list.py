"""Map lims_samples rows into the SenaiteSample list shape for GET /registry/samples."""
import json
from typing import Any
from models import LimsSample


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


def registry_rows_to_list(rows: list[LimsSample]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append({
            # uid is required (non-null) on the response model — fall back to
            # sample_id (NOT NULL + unique) for rows never synced to SENAITE,
            # rather than 500ing the whole list on one uid-less row.
            "uid": r.external_lims_uid or r.sample_id,
            "id": r.sample_id,
            "title": r.sample_id,
            "client_id": r.client_id,
            "client_order_number": r.client_order_number,
            "date_created": r.date_created.isoformat() if r.date_created else None,
            "date_received": r.date_received.isoformat() if r.date_received else None,
            "date_sampled": r.date_sampled.isoformat() if r.date_sampled else None,
            "review_state": r.status or "",
            "sample_type": r.sample_type_title,
            "contact": r.contact_title,
            "verification_code": r.verification_code,
            "analytes": _analyte_names(r.analytes),
        })
    return out
