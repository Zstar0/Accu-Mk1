"""DB-facing priority helpers: cached priority map, batched effective loader,
and (Task 4) assign(). Spec §4/§5."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    PRIORITY_LEVELS, PRIORITY_SOURCES, CustomerPriority, LimsOrder, LimsSample,
    LimsSubSample, Priority, PriorityAudit,
)
from priority.resolver import Effective, PriorityInfo, resolve

logger = logging.getLogger(__name__)

_CACHE_TTL_S = 60.0
_cache: dict = {"at": 0.0, "map": None}


def invalidate_priority_cache() -> None:
    _cache["at"] = 0.0
    _cache["map"] = None


def priority_map(db: Session) -> dict[str, PriorityInfo]:
    """All priorities (active and inactive) keyed by key; 60 s per-process cache
    like the throughput row cache. Inactive rows are kept so the resolver can
    treat them as inherit instead of unknown."""
    now = time.monotonic()
    if _cache["map"] is not None and now - _cache["at"] < _CACHE_TTL_S:
        return _cache["map"]
    rows = db.execute(select(Priority)).scalars().all()
    m = {r.key: PriorityInfo(r.key, r.rank, r.is_active, r.is_default) for r in rows}
    _cache["map"], _cache["at"] = m, now
    return m


def load_effective(
    db: Session,
    sample_pks: Iterable[int] = (),
    sub_sample_pks: Iterable[int] = (),
) -> tuple[dict[int, Effective], dict[int, Effective]]:
    """Batched: one query per level. Sub-samples resolve through their parent
    sample's chain. Unknown pks resolve to the default so callers never KeyError."""
    prios = priority_map(db)
    sample_pks = list(dict.fromkeys(sample_pks))
    sub_pks = list(dict.fromkeys(sub_sample_pks))

    subs: dict[int, LimsSubSample] = {}
    if sub_pks:
        for v in db.execute(select(LimsSubSample).where(LimsSubSample.id.in_(sub_pks))).scalars():
            subs[v.id] = v
        sample_pks = list(dict.fromkeys(sample_pks + [v.parent_sample_pk for v in subs.values()]))

    samples: dict[int, LimsSample] = {}
    if sample_pks:
        for s in db.execute(select(LimsSample).where(LimsSample.id.in_(sample_pks))).scalars():
            samples[s.id] = s

    order_nos = {s.client_order_number for s in samples.values() if s.client_order_number}
    orders: dict[str, LimsOrder] = {}
    if order_nos:
        # order_number is NOT unique: assign() picks the LOWEST id on duplicates,
        # so the resolver must agree — order by id and keep the first seen.
        for o in db.execute(
            select(LimsOrder).where(LimsOrder.order_number.in_(order_nos)).order_by(LimsOrder.id)
        ).scalars():
            orders.setdefault(o.order_number, o)

    cust_ids = {o.customer_user_id for o in orders.values() if o.customer_user_id is not None}
    customers: dict[int, CustomerPriority] = {}
    if cust_ids:
        for c in db.execute(
            select(CustomerPriority).where(CustomerPriority.wp_customer_user_id.in_(cust_ids))
        ).scalars():
            customers[c.wp_customer_user_id] = c

    def chain(sample: Optional[LimsSample], vial: Optional[LimsSubSample]) -> Effective:
        order = orders.get(sample.client_order_number) if sample and sample.client_order_number else None
        cust = customers.get(order.customer_user_id) if order and order.customer_user_id is not None else None
        explicit = {
            "vial": vial.priority_key if vial else None,
            "sample": sample.priority_key if sample else None,
            "order": order.priority_key if order else None,
            "customer": cust.priority_key if cust else None,
        }
        ids = {
            "vial": str(vial.id) if vial else None,
            "sample": str(sample.id) if sample else None,
            "order": order.order_number if order else None,
            "customer": str(cust.wp_customer_user_id) if cust else None,
        }
        return resolve(explicit, prios, explicit_ids={k: v for k, v in ids.items() if v})

    by_sample = {pk: chain(samples.get(pk), None) for pk in sample_pks}
    by_vial = {pk: chain(samples.get(subs[pk].parent_sample_pk) if pk in subs else None, subs.get(pk))
               for pk in sub_pks}
    return by_sample, by_vial


def load_effective_safe(
    db: Session,
    sample_pks: Iterable[int] = (),
    sub_sample_pks: Iterable[int] = (),
) -> tuple[dict[int, Effective], dict[int, Effective]]:
    """READ-path wrapper around load_effective.

    resolve() raises when the priorities table has no default row — correct for
    a write (assign must refuse to guess), wrong for a list endpoint: a
    half-migrated database would 500 the samples list, the inbox and the vial
    board instead of merely omitting a chip. Degrades to "no priority known".
    """
    try:
        return load_effective(db, sample_pks=sample_pks, sub_sample_pks=sub_sample_pks)
    except ValueError:
        logger.warning("priority embed skipped: no default priority configured")
        return {}, {}


def legacy_priority_string(eff: Effective) -> str:
    """The pre-Task-8 inbox/worksheet vocabulary ("normal" | "high" |
    "expedited") — a RANK-CLAMPED compatibility view, retired by the frontend
    plan once every consumer reads `priority` / `priority_effective` instead.

    The legacy field's contract is that closed three-value vocabulary: the
    frontend types it as 'normal' | 'high' | 'expedited' and the inbox PUTs
    reject anything else with a 400. Priorities are admin-created now, so
    echoing `eff.key` would leak e.g. "rush" into that field. Clamp by rank
    instead: >= the expedited rank reads "expedited", anything above default
    reads "high", default (and any below-default key) reads "normal".

    `priority_effective` / `priority` carry the REAL key — this narrowing is
    confined to the legacy string.
    """
    if eff.source_level == "default":
        # Nothing explicit anywhere in the chain: "no priority" is 'normal' in
        # the legacy vocabulary regardless of how the default row is ranked --
        # an admin who re-ranks 'default' upward must not turn every untouched
        # sample into a High in the legacy field.
        return "normal"
    if eff.rank >= 20:
        return "expedited"
    if eff.rank > 0:
        return "high"
    return "normal"


def priority_target_for_uid(db: Session, uid: str) -> Optional[tuple[str, str]]:
    """(level, entity_id) for a worksheet-inbox row uid, or None when the uid
    has no native row.

    Vial FIRST: native `mk1://…` uids live on lims_sub_samples, and the legacy
    sample_priorities writes these routes replaced were per-VIAL for exactly
    those rows. Falling back to the parent level would silently widen the
    blast radius of a per-vial priority change.
    """
    if not uid:
        return None
    vial_pk = db.execute(
        select(LimsSubSample.id).where(LimsSubSample.external_lims_uid == uid)
    ).scalars().first()
    if vial_pk is not None:
        return ("vial", str(vial_pk))
    sample_pk = db.execute(
        select(LimsSample.id).where(LimsSample.external_lims_uid == uid)
    ).scalars().first()
    if sample_pk is not None:
        return ("sample", str(sample_pk))
    return None


def load_effective_for_uids(db: Session, uids: Iterable[str]) -> dict[str, Effective]:
    """Effective priority keyed by external_lims_uid — the identity the
    worksheets inbox rows carry. Two id queries plus ONE load_effective for the
    whole page (never per row). Uids with no native row are omitted."""
    wanted = [u for u in dict.fromkeys(uids) if u]
    if not wanted:
        return {}
    vial_by_uid = {
        uid: pk for pk, uid in db.execute(
            select(LimsSubSample.id, LimsSubSample.external_lims_uid)
            .where(LimsSubSample.external_lims_uid.in_(wanted))
        ).all()
    }
    remaining = [u for u in wanted if u not in vial_by_uid]
    sample_by_uid = {
        uid: pk for pk, uid in db.execute(
            select(LimsSample.id, LimsSample.external_lims_uid)
            .where(LimsSample.external_lims_uid.in_(remaining))
        ).all()
    } if remaining else {}
    by_sample, by_vial = load_effective_safe(
        db, sample_pks=sample_by_uid.values(), sub_sample_pks=vial_by_uid.values())
    out: dict[str, Effective] = {}
    for uid, pk in vial_by_uid.items():
        if pk in by_vial:
            out[uid] = by_vial[pk]
    for uid, pk in sample_by_uid.items():
        if pk in by_sample:
            out[uid] = by_sample[pk]
    return out


def order_number_variants(n: Optional[str]) -> set[str]:
    """Integration Service payloads carry the bare WooCommerce number ("3008");
    lims_orders stores the WordPress form ("WP-3008"). Every order lookup
    keyed by a caller-supplied number accepts either and matches both
    (2026-09-11: no explorer order ever carried a priority, and assigning one
    from Order Status raised 'order not found', because the stamp looked up
    the bare string)."""
    n = (n or "").strip()
    if not n:
        return set()
    bare = n[3:] if n.upper().startswith("WP-") else n
    return {n, bare, f"WP-{bare}"}


def order_priority_fields(db: Session, order_numbers: Iterable[str]) -> dict[str, dict]:
    """{order_number: {priority_key, priority_source, effective_priority}} for
    the order-list/detail payloads. Order rows resolve through the order →
    customer half of the chain only (there is no sample in play). Batched:
    one orders query, one customers query, one priority map."""
    wanted = [n for n in dict.fromkeys(order_numbers) if n]
    if not wanted:
        return {}
    prios = priority_map(db)
    lookup: set[str] = set()
    for n in wanted:
        lookup |= order_number_variants(n)
    orders = db.execute(
        # order_number is NOT unique: assign() picks the LOWEST id on duplicates,
        # so this payload must agree — order by id and keep the first seen.
        select(LimsOrder).where(LimsOrder.order_number.in_(sorted(lookup))).order_by(LimsOrder.id)
    ).scalars().all()
    first_by_number: dict[str, LimsOrder] = {}
    for o in orders:
        first_by_number.setdefault(o.order_number, o)
    cust_ids = {o.customer_user_id for o in orders if o.customer_user_id is not None}
    customers: dict[int, CustomerPriority] = {}
    if cust_ids:
        for c in db.execute(
            select(CustomerPriority).where(CustomerPriority.wp_customer_user_id.in_(cust_ids))
        ).scalars():
            customers[c.wp_customer_user_id] = c
    out: dict[str, dict] = {}
    # Keyed by the CALLER'S string (bare or WP-), so the stamp can join back
    # onto the payload it was asked about.
    for requested in wanted:
        o = next((first_by_number[v] for v in (requested, *sorted(order_number_variants(requested)))
                  if v in first_by_number), None)
        if o is None:
            continue
        cust = customers.get(o.customer_user_id) if o.customer_user_id is not None else None
        try:
            eff = resolve(
                {"order": o.priority_key, "customer": cust.priority_key if cust else None},
                prios,
                explicit_ids={
                    k: v for k, v in {
                        "order": o.order_number,
                        "customer": str(cust.wp_customer_user_id) if cust else None,
                    }.items() if v
                },
            )
        except ValueError:
            # No default priority configured — read paths degrade, never 500.
            logger.warning("order priority skipped: no default priority configured")
            return {}
        out.setdefault(requested, {
            "priority_key": o.priority_key,
            "priority_source": o.priority_source,
            "effective_priority": eff.as_dict(),
        })
    return out


@dataclass
class AssignResult:
    level: str
    entity_id: str
    old_key: Optional[str]
    new_key: Optional[str]
    affected_sample_pks: list[int] = field(default_factory=list)


def _samples_for_order_numbers(db: Session, order_numbers: list[str]) -> list[int]:
    if not order_numbers:
        return []
    return list(db.execute(
        select(LimsSample.id).where(LimsSample.client_order_number.in_(order_numbers))
    ).scalars())


def assign(
    db: Session, *, level: str, entity_id: str, priority_key: Optional[str],
    user_id: Optional[int], source: str = "ui", note: Optional[str] = None,
) -> AssignResult:
    """Set (or clear, with None) the explicit priority at one level. One audit
    row; SLA snapshot refreshed for every in-flight sample whose effective
    value could have changed. Spec §5 `PUT /priorities/assign`."""
    from priority import snapshot  # local import: snapshot imports this module

    if level not in PRIORITY_LEVELS:
        raise ValueError(f"unknown level {level!r}")
    if source not in PRIORITY_SOURCES:
        raise ValueError(f"unknown source {source!r}")
    if priority_key is not None and priority_key not in priority_map(db):
        raise ValueError(f"unknown priority {priority_key!r}")

    affected: list[int] = []
    if level == "customer":
        cid = int(entity_id)
        row = db.get(CustomerPriority, cid)
        old = row.priority_key if row else None
        if priority_key is None:
            if row:
                db.delete(row)
        elif row:
            # A note is only written when one is supplied: re-prioritising a
            # customer from the picker (no note) must not erase the stored one.
            row.priority_key, row.updated_by = priority_key, user_id
            if note is not None:
                row.note = note
        else:
            db.add(CustomerPriority(wp_customer_user_id=cid, priority_key=priority_key, note=note, updated_by=user_id))
        order_nos = list(db.execute(
            select(LimsOrder.order_number).where(LimsOrder.customer_user_id == cid)
        ).scalars())
        affected = _samples_for_order_numbers(db, order_nos)
    elif level == "order":
        # order_number is indexed, NOT unique: two rows may share one number.
        # scalar_one_or_none() would raise MultipleResultsFound; take the
        # lowest id deterministically instead.
        order = db.execute(
            select(LimsOrder).where(LimsOrder.order_number.in_(sorted(order_number_variants(entity_id))))
            .order_by(LimsOrder.id).limit(1)
        ).scalars().first()
        if order is None:
            raise ValueError(f"order {entity_id!r} not found")
        old = order.priority_key
        order.priority_key = priority_key
        order.priority_source = None if priority_key is None else source
        affected = _samples_for_order_numbers(db, [order.order_number])
    elif level == "sample":
        sample = db.get(LimsSample, int(entity_id))
        if sample is None:
            raise ValueError(f"sample {entity_id!r} not found")
        old = sample.priority_key
        sample.priority_key = priority_key
        affected = [sample.id]
    else:  # vial
        vial = db.get(LimsSubSample, int(entity_id))
        if vial is None:
            raise ValueError(f"vial {entity_id!r} not found")
        old = vial.priority_key
        vial.priority_key = priority_key
        affected = [vial.parent_sample_pk]

    db.add(PriorityAudit(user_id=user_id, level=level, entity_id=str(entity_id),
                         old_key=old, new_key=priority_key, source=source, note=note))
    db.flush()
    snapshot.refresh(db, affected, only_in_flight=True)
    return AssignResult(level, str(entity_id), old, priority_key, sorted(affected))
