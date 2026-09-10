"""DB-facing priority helpers: cached priority map, batched effective loader,
and (Task 4) assign(). Spec §4/§5."""
from __future__ import annotations

import time
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import CustomerPriority, LimsOrder, LimsSample, LimsSubSample, Priority
from priority.resolver import Effective, PriorityInfo, resolve

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
        for o in db.execute(select(LimsOrder).where(LimsOrder.order_number.in_(order_nos))).scalars():
            orders[o.order_number] = o

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
    by_vial = {pk: chain(samples.get(v.parent_sample_pk), v) for pk, v in subs.items()}
    return by_sample, by_vial
