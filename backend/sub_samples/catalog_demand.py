"""Catalog-backed base vial demand (spec 3).

Demand for a fulfillment role is MAX(vials_required) over the ordered
profiles that fulfil it — MAX, not SUM, because legacy semantics are
boolean-OR per bucket (hplcpurity_identity OR bac_water_panel -> 1 hplc
vial) and two families sharing a role share the aliquot.
"""
import logging
from typing import Optional

log = logging.getLogger(__name__)

# Legacy bucket floor: always present in the returned dict, zeros included,
# so callers keyed on the historical 3-bucket shape keep working.
_LEGACY_BUCKETS = ("hplc", "endo", "ster")
# Keys that are demand-inert by design; skipping them must not warn.
_QUIET_KEYS = {"samplevariance", "variance"}


def derive_base_demand_catalog(db, services: dict) -> dict:
    from models import AnalysisProfile

    demand = {b: 0 for b in _LEGACY_BUCKETS}
    for key, selected in (services or {}).items():
        if key in _QUIET_KEYS or not selected:
            continue
        prof = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if prof is None:
            # Same class as build_ordered_products' fail-open: an unknown key
            # must never break fulfilment of the rest of the order.
            log.warning("catalog_demand_unknown_key key=%s", key)
            continue
        if not prof.active:
            log.warning("catalog_demand_inactive_profile key=%s", key)
        if prof.fulfillment_dim != "role" or not prof.fulfillment_role:
            continue  # kind-dim (variance) composes elsewhere, never here
        role = prof.fulfillment_role
        demand[role] = max(demand.get(role, 0), prof.vials_required)
    return demand
