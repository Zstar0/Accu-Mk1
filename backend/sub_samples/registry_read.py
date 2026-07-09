"""Map a lims_samples registry row into the SenaiteLookupResult field shape,
for the sample-details read-source toggle. Only fields the registry actually
supplies are emitted (a null column is omitted, so the overlay layer keeps the
SENAITE value + tags the field 'senaite')."""
import json
from typing import Any
from models import LimsSample

# Every SenaiteLookupResult field this mapper can populate. The overlay's
# field_sources map is built over exactly this set. review_state is
# deliberately ABSENT: workflow state is SENAITE-owned (it mutates after
# order time), and the details endpoint has the live value in hand — the
# registry's cached status may lag and must never shadow it.
OVERLAY_FIELDS: tuple[str, ...] = (
    "client", "contact", "sample_type",
    "date_received", "date_sampled", "client_order_number",
    "client_sample_id", "client_lot",
    "declared_weight_mg", "analytes",
)


def registry_row_to_display(row: LimsSample) -> dict[str, Any]:
    out: dict[str, Any] = {}

    def put(key: str, value: Any) -> None:
        if value is not None and value != "":
            out[key] = value

    put("client", row.client_title)
    put("contact", row.contact_title)
    put("sample_type", row.sample_type_title)
    put("client_order_number", row.client_order_number)
    put("client_sample_id", row.client_sample_id)
    put("client_lot", row.client_lot)
    if row.date_received is not None:
        out["date_received"] = row.date_received.isoformat()
    if row.date_sampled is not None:
        out["date_sampled"] = row.date_sampled.isoformat()

    if row.declared_total_quantity not in (None, ""):
        try:
            out["declared_weight_mg"] = float(row.declared_total_quantity)
        except (ValueError, TypeError):
            pass

    if row.analytes:
        try:
            parsed = json.loads(row.analytes)
            if isinstance(parsed, list):
                out["analytes"] = parsed
        except (ValueError, TypeError):
            pass

    return out
