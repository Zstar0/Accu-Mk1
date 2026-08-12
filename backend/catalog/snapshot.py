"""Registration-time frozen catalog resolution (S4 snapshot rider, task 5).

`compute_catalog_snapshot` resolves the LIVE catalog once, against an
order's WP `services` dict, into a snapshot that `LimsSample.catalog_snapshot`
stamps ONCE at registration (backend/main.py's
`_native_placeholders_at_registration_bg`). What the customer bought is what
they get: task 6 makes check-in seed from this frozen snapshot first (NULL
or missing-profile falls back to a live-catalog lookup), so a later catalog
edit (a profile's vials_required changed, its member services re-ordered, a
ride-host priority flipped) can never retroactively change what an
ALREADY-REGISTERED sample provisions. Task 7 adds the only other writer — an
audited, deliberate reprovision action — which must always call this
function fresh against the LIVE catalog, never thread an existing snapshot
into it (that would re-freeze stale data instead of updating it).

Each profile entry freezes the profile's OWN catalog facts — never an
already-resolved/effective per-role value:

  - `fulfillment_role` is the profile's own declared role, not the role its
    result ends up attached to (a rider that successfully rides a host still
    freezes its OWN role here).
  - `role_sort_order` is `fulfillment_role`'s VialRole.sort_order AT
    RESOLUTION TIME (null when the role has no VialRole row). Frozen for the
    same reason as the two fields below: catalog_demand.py's rider sort
    (line ~103) orders both anchors and riders by (live VialRole.sort_order,
    key) BEFORE deciding which host a rider attaches to — that ordering
    decides self-mint-vs-attach, and therefore total demand. Task 6's
    snapshot-sourced rebuild must not read the live VialRole table to get it.
  - `vials_required` is the profile's own catalog value, not the MAX-per-role
    demand (a role can have >1 anchor) and not the rider "or 1" self-mint
    fallback.
  - `ride_host_roles` is the profile's own declared priority-ordered list of
    host role codes, not the one host it happened to attach to this time.

This matters because task 6's snapshot-sourced `resolve_catalog_fulfillment`
re-runs the SAME anchor/rider algorithm over these frozen per-profile
values — storing an already-resolved number here would double-apply it.
"""
from datetime import datetime

from sqlalchemy import select


def compute_catalog_snapshot(db, services: dict, package) -> dict:
    """Resolves `services` into a frozen, order-preserving profile snapshot.

    Reuses `resolve_catalog_fulfillment` (sub_samples/catalog_demand.py) for
    the "is this profile actually in demand" half — unknown-key warnings,
    inactive-profile warnings, the quiet-key skip (samplevariance/variance),
    and the kind-dim skip (fulfillment_dim != 'role') all live there and are
    NOT reimplemented here — then walks `services` a second time, in the
    caller's own key order, so the output list is order-preserving over the
    WP services dict rather than resolve_catalog_fulfillment's role-sorted
    host/rider id lists (whose docstring explicitly says NOT dict order).

    `package` is accepted to match the mandated signature (a base/always-run
    package key, e.g. "core"/"accushield", is not itself a role-dim demand
    source — mirroring `resolve_catalog_fulfillment` and
    `derive_base_demand_catalog`, neither of which takes `package` either)
    but is deliberately NOT folded into role-based demand here: today no
    package key is seeded as an AnalysisProfile row (profile_seed.py seeds
    only PRODUCT_REGISTRY, never _PACKAGE_PRODUCTS), and even if one were,
    resolve_catalog_fulfillment would still never surface it in-demand
    (fulfillment_role is None for a base/always-run package) — base-panel
    seeding is a separate, pre-existing mechanism outside task 6's
    catalog-role-vial scope.
    """
    from models import AnalysisProfile, VialRole, profile_ride_hosts
    from sub_samples.catalog_demand import resolve_catalog_fulfillment

    services = services or {}
    fulfillment = resolve_catalog_fulfillment(db, services)
    in_demand_ids = set()
    for rf in fulfillment.values():
        in_demand_ids.update(rf.host_profile_ids)
        in_demand_ids.update(rf.rider_profile_ids)

    # Same live source resolve_catalog_fulfillment's own `sort_of` uses
    # (catalog_demand.py:95) — read once, frozen per profile below.
    role_sort_of = {r.code: r.sort_order for r in db.query(VialRole).all()}

    profiles_out = []
    for key, val in services.items():
        if not val:
            continue
        prof = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if prof is None or prof.id not in in_demand_ids:
            continue
        # Same (priority, host_role_code) tiebreak as catalog_demand.py:82 —
        # a frozen snapshot must order ride hosts identically to the live
        # path, or task 6's "NULL snapshot -> identical to today" invariant
        # could diverge on two hand-written rows sharing a priority.
        ride_rows = db.execute(
            select(profile_ride_hosts.c.host_role_code)
            .where(profile_ride_hosts.c.analysis_profile_id == prof.id)
            .order_by(profile_ride_hosts.c.priority, profile_ride_hosts.c.host_role_code)
        ).scalars().all()
        profiles_out.append({
            "key": prof.key,
            "profile_id": prof.id,
            "fulfillment_role": prof.fulfillment_role,
            "role_sort_order": (
                role_sort_of.get(prof.fulfillment_role)
                if prof.fulfillment_role else None
            ),
            "vials_required": prof.vials_required,
            "service_ids": [svc.id for svc in prof.analysis_services],
            "ride_host_roles": list(ride_rows),
        })

    return {
        "resolved_at": datetime.utcnow().isoformat(),
        "profiles": profiles_out,
    }
