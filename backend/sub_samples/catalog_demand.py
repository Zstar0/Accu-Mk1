"""Catalog-backed base vial demand (spec 3, extended spec 4: ride lists).

Demand for a fulfillment role is MAX(vials_required) over the ordered
profiles that anchor it — MAX, not SUM, because legacy semantics are
boolean-OR per bucket (hplcpurity_identity OR bac_water_panel -> 1 hplc
vial) and two families sharing a role share the aliquot.

Spec 4 adds RIDERS: a profile may declare a priority-ordered list of host
roles (profile_ride_hosts) it would rather attach its result to than mint
its own vial. A rider never inflates the host's demand — it only ever adds
to host_profile_ids/rider_profile_ids bookkeeping — and if no host on its
list is live, it self-mints under its OWN fulfillment_role (never the
host's), same as any other anchor. This keeps the legacy hplc/endo/ster
buckets byte-identical whether or not a rider attaches to them.
"""
import logging
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import select

log = logging.getLogger(__name__)

# Legacy bucket floor: always present in the returned dict, zeros included,
# so callers keyed on the historical 3-bucket shape keep working.
_LEGACY_BUCKETS = ("hplc", "endo", "ster")
# Keys that are demand-inert by design; skipping them must not warn.
_QUIET_KEYS = {"samplevariance", "variance"}


@dataclass
class RoleFulfillment:
    """demand is order-independent (MAX over anchors, computed once via
    resolve_catalog_fulfillment). host_profile_ids/rider_profile_ids are
    NOT guaranteed order-stable across calls when more than one anchor
    shares a role (e.g. hplcpurity_identity and bac_water_panel both anchor
    'hplc') — their relative order in host_profile_ids follows the
    `services` dict's iteration order that call received, not a declared
    priority. Consumers (Tasks 5/6/8) must not treat host_profile_ids[0] as
    "the" anchor; treat the list as a set for anything but demand."""
    demand: int = 0
    host_profile_ids: list = field(default_factory=list)
    rider_profile_ids: list = field(default_factory=list)


def resolve_catalog_fulfillment(db, services: dict) -> dict:
    """Anchors mint MAX-per-role demand; riders attach to the first ordered
    host on their priority list, else self-mint their own role
    (Handler-locked 2026-07-31). Deterministic: riders iterate by (role
    sort_order, profile key) — never by dict/query iteration order.
    """
    from models import AnalysisProfile, VialRole, profile_ride_hosts

    result = {b: RoleFulfillment() for b in _LEGACY_BUCKETS}
    ordered = []
    for key, val in (services or {}).items():
        if key in _QUIET_KEYS or not val:
            continue
        prof = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if prof is None:
            # Same class as build_ordered_products' fail-open: an unknown key
            # must never break fulfilment of the rest of the order.
            log.warning("catalog_demand_unknown_key key=%s", key)
            continue
        if not prof.active:
            log.warning("catalog_demand_inactive_profile key=%s (still fulfilling: paid order)", key)
        if prof.fulfillment_dim != "role" or not prof.fulfillment_role:
            continue  # kind-dim (variance) composes elsewhere, never here
        ordered.append(prof)

    ride_rows = db.execute(
        select(profile_ride_hosts.c.analysis_profile_id,
               profile_ride_hosts.c.host_role_code,
               profile_ride_hosts.c.priority)
        .where(profile_ride_hosts.c.analysis_profile_id.in_([p.id for p in ordered]))
    ).all() if ordered else []
    ride_map = {}
    for pid, host, prio in sorted(ride_rows, key=lambda r: r[2]):
        ride_map.setdefault(pid, []).append(host)

    anchors = [p for p in ordered if not ride_map.get(p.id)]
    riders = [p for p in ordered if ride_map.get(p.id)]

    for p in anchors:
        rf = result.setdefault(p.fulfillment_role, RoleFulfillment())
        rf.demand = max(rf.demand, p.vials_required)
        rf.host_profile_ids.append(p.id)

    sort_of = {r.code: r.sort_order for r in db.query(VialRole).all()}
    riders.sort(key=lambda p: (sort_of.get(p.fulfillment_role, 999), p.key))
    for p in riders:
        host = next((h for h in ride_map[p.id] if result.get(h) and result[h].demand > 0), None)
        if host is not None:
            result[host].rider_profile_ids.append(p.id)
        else:
            rf = result.setdefault(p.fulfillment_role, RoleFulfillment())
            rf.demand = max(rf.demand, p.vials_required or 1)  # standalone rider mints its own vial
            rf.host_profile_ids.append(p.id)
    return result


def derive_base_demand_catalog(db, services: dict) -> dict:
    """Thin wrapper preserving the pre-spec-4 external shape (role -> int)
    for derive_base_demand's shadow-compare caller (sub_samples/service.py) —
    untouched by this task."""
    return {role: rf.demand for role, rf in resolve_catalog_fulfillment(db, services).items()}
