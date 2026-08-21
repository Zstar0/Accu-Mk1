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
    """demand is order-independent (MAX over anchors). host_profile_ids and
    rider_profile_ids are both deterministically ordered by (role
    sort_order, profile key) — NOT by the `services` dict's iteration
    order — so when more than one anchor shares a role (e.g.
    hplcpurity_identity and bac_water_panel both anchor 'hplc'), the same
    services set always produces the same host_profile_ids order regardless
    of caller dict order. Still not a declared "priority" among anchors —
    it's a stable tie-break, not a ranking — but it is reproducible."""
    demand: int = 0
    host_profile_ids: list = field(default_factory=list)
    rider_profile_ids: list = field(default_factory=list)


def resolve_catalog_fulfillment(db, services: dict, snapshot: Optional[dict] = None) -> dict:
    """Anchors mint MAX-per-role demand; riders attach to the first ordered
    host on their priority list, else self-mint their own role
    (Handler-locked 2026-07-31). Deterministic: both anchors and riders
    iterate by (role sort_order, profile key) — never by dict/query
    iteration order.

    snapshot (S4 rider, task 6, fix round 1 — per-profile hybrid merge): when
    given a frozen catalog_snapshot dict (backend/catalog/snapshot.py's
    shape — LimsSample.catalog_snapshot), `services` is partitioned by
    profile key into snapshot-covered and uncovered. Covered keys resolve
    from the frozen snapshot ONLY (_resolve_from_snapshot, zero live
    catalog queries) — a live catalog edit to one of those profiles can
    never retroactively change an already-registered sample's fulfillment.
    Uncovered keys (a post-order add-on, purchased after the snapshot was
    frozen — logged catalog_snapshot.fallback_live per key) run through the
    SAME live walk as the NULL-snapshot path below (_resolve_live), merged
    INTO the snapshot-seeded result rather than a separate one: per role,
    demand is max(frozen, live), profile-id lists are appended (never
    overwritten), and a live-resolved rider's host-attachment check
    (`result.get(h) and result[h].demand > 0`) sees the ALREADY-MERGED
    result — so a post-order rider can attach to a snapshot-frozen host
    that already carries real demand, exactly as if both had resolved
    together live. NULL (the default) skips the snapshot machinery
    entirely and returns _resolve_live's fresh result, unchanged from
    before this task.
    """
    if snapshot is None:
        return _resolve_live(db, services)

    result = _resolve_from_snapshot(snapshot)

    snapshot_keys = {p["key"] for p in (snapshot.get("profiles") or [])}
    uncovered = {}
    for key, val in (services or {}).items():
        if key in _QUIET_KEYS or not val or key in snapshot_keys:
            continue
        uncovered[key] = val
        log.warning(
            "catalog_snapshot.fallback_live reason=profile_not_in_snapshot key=%s",
            key,
        )
    if uncovered:
        _resolve_live(db, uncovered, result=result)
    return result


def _resolve_live(db, services: dict, result: Optional[dict] = None) -> dict:
    """The live anchor/rider walk: queries AnalysisProfile/VialRole/
    profile_ride_hosts fresh and resolves `services` against them.

    `result` is the dict to build INTO — defaults to a fresh legacy-bucket
    floor (the NULL-snapshot / no-merge case), or the snapshot-seeded dict
    from resolve_catalog_fulfillment's merge branch (fix round 1) so this
    same code, unmodified, both merges (`rf.demand = max(rf.demand, ...)`
    against whatever the snapshot already put there, `rf.host_profile_ids.
    append(...)` onto the snapshot's own list) and lets the rider
    self-mint-vs-attach check below see snapshot-derived demand that's
    already sitting in `result` before this function ever ran."""
    from models import AnalysisProfile, VialRole, profile_ride_hosts

    if result is None:
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
    # Sort key is (priority, host_role_code, profile id) — priority is the
    # real ordering, host_role_code + id are tiebreakers so two hand-written
    # rows sharing a priority don't depend on DB read order (spec 4 fix round).
    for pid, host, prio in sorted(ride_rows, key=lambda r: (r[2], r[1], r[0])):
        ride_map.setdefault(pid, []).append(host)

    anchors = [p for p in ordered if not ride_map.get(p.id)]
    riders = [p for p in ordered if ride_map.get(p.id)]

    # Deterministic order for BOTH loops — never `services` dict/query
    # iteration order. Computed once, up front, so the anchors loop below
    # can use it too: when two anchors share a role (a real production
    # pair — e.g. two profiles both anchoring 'hplc'), host_profile_ids'
    # append order would otherwise follow caller dict order. `demand` was
    # always safe (`max` is order-independent); this makes the ID lists
    # provably deterministic too, matching the riders sort already below.
    sort_of = {r.code: r.sort_order for r in db.query(VialRole).all()}
    anchors.sort(key=lambda p: (sort_of.get(p.fulfillment_role, 999), p.key))

    for p in anchors:
        rf = result.setdefault(p.fulfillment_role, RoleFulfillment())
        rf.demand = max(rf.demand, p.vials_required)
        rf.host_profile_ids.append(p.id)

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


def _resolve_from_snapshot(snapshot: dict) -> dict:
    """Snapshot-sourced mirror of resolve_catalog_fulfillment's live
    anchor/rider walk above — same algorithm, sourced from the frozen
    per-profile fields in `snapshot["profiles"]` instead of live
    AnalysisProfile/VialRole/profile_ride_hosts queries. See
    catalog/snapshot.py's docstring for the snapshot's shape and per-field
    freezing rationale.

    The in-demand gate is already applied: every entry in
    snapshot["profiles"] passed resolve_catalog_fulfillment's live gate
    (known key, fulfillment_dim == 'role', landed in host/rider_profile_ids)
    at registration time (catalog.snapshot.compute_catalog_snapshot calls
    this same function), so no re-filtering happens here.

    role_sort_order is VialRole.sort_order (NOT NULL in the schema) frozen
    at resolution time, or None when no VialRole row existed for that
    profile's fulfillment_role — the exact same signal the live path's
    `sort_of.get(role, 999)` dict-miss default encodes — so None -> 999
    below reproduces it precisely ("null sorts last").
    """
    result = {b: RoleFulfillment() for b in _LEGACY_BUCKETS}
    profiles = snapshot.get("profiles") or []

    anchors = [p for p in profiles if not p.get("ride_host_roles")]
    riders = [p for p in profiles if p.get("ride_host_roles")]

    def _sort_key(p: dict) -> tuple:
        sort_order = p.get("role_sort_order")
        return (sort_order if sort_order is not None else 999, p["key"])

    anchors.sort(key=_sort_key)
    for p in anchors:
        rf = result.setdefault(p["fulfillment_role"], RoleFulfillment())
        rf.demand = max(rf.demand, p["vials_required"])
        rf.host_profile_ids.append(p["profile_id"])

    riders.sort(key=_sort_key)
    for p in riders:
        host = next(
            (h for h in p["ride_host_roles"] if result.get(h) and result[h].demand > 0),
            None,
        )
        if host is not None:
            result[host].rider_profile_ids.append(p["profile_id"])
        else:
            rf = result.setdefault(p["fulfillment_role"], RoleFulfillment())
            rf.demand = max(rf.demand, p["vials_required"] or 1)  # standalone rider mints its own vial
            rf.host_profile_ids.append(p["profile_id"])
    return result


def derive_base_demand_catalog(db, services: dict, snapshot: Optional[dict] = None) -> dict:
    """Thin wrapper preserving the pre-spec-4 external shape (role -> int)
    for derive_base_demand's shadow-compare caller (sub_samples/service.py).
    `snapshot` (task 6) threads straight through to resolve_catalog_fulfillment."""
    return {
        role: rf.demand
        for role, rf in resolve_catalog_fulfillment(db, services, snapshot=snapshot).items()
    }
