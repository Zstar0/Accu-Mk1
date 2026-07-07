"""Pure registry-vs-SENAITE comparison for the admin debug panel
(2026-07-07-sample-registry-debug-panel-design.md).

Authoritative by reuse: the "what SENAITE says" side is computed by running
the real _populate_basic_info onto a throwaway LimsSample and reading its
attributes, so the diff can never drift from the population mapping. No I/O,
no session — pure."""
import json
from datetime import datetime
from typing import Any
from models import LimsSample
from sub_samples.service import _populate_basic_info

# The SENAITE-sourced basic-info fields to compare. Excludes local bookkeeping
# (last_synced_at) and the always-"senaite" discriminator (external_lims_system),
# neither of which is a SENAITE value to agree/drift on.
_COMPARED_FIELDS = (
    "external_lims_uid", "client_id", "client_uid", "contact_uid", "sample_type",
    "client_sample_id", "peptide_name", "date_received", "date_sampled", "status",
    "client_title", "contact_title", "contact_email", "sample_type_title",
    "date_created", "verification_code", "client_order_number", "analytes",
    "declared_total_quantity", "client_lot", "client_reference",
    "company_logo_url", "coa_meta",
)
# Fields stored as JSON strings — compare parsed structures so key/quote
# formatting never reads as drift.
_JSON_FIELDS = frozenset({"analytes", "coa_meta"})


def _norm(field: str, value: Any) -> Any:
    if value is None:
        return None
    if field in _JSON_FIELDS:
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value
    return value


def _display(value: Any) -> Any:
    """JSON-safe scalar for the wire (datetimes → iso)."""
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _classify(stored: Any, want: Any) -> str:
    if stored is None and want is None:
        return "agree"
    if stored is None:
        return "registry_null"
    if want is None:
        return "senaite_null"
    return "agree" if stored == want else "drift"


def diff_registry_vs_senaite(row: LimsSample, meta: dict) -> dict:
    derived = LimsSample()
    _populate_basic_info(derived, meta)  # reuse the exact mapping

    fields = []
    summary = {"agree": 0, "drift": 0, "registry_null": 0, "senaite_null": 0}
    for f in _COMPARED_FIELDS:
        stored = getattr(row, f)
        want = getattr(derived, f)
        status = _classify(_norm(f, stored), _norm(f, want))
        summary[status] += 1
        fields.append({
            "field": f,
            "registry": _display(stored),
            "senaite": _display(want),
            "status": status,
        })
    return {"fields": fields, "summary": summary}
