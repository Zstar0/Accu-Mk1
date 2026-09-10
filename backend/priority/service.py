"""DB-facing priority helpers: cached priority map, batched effective loader,
and (Task 4) assign(). Spec §4/§5."""
from __future__ import annotations

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
    by_vial = {pk: chain(samples.get(subs[pk].parent_sample_pk) if pk in subs else None, subs.get(pk))
               for pk in sub_pks}
    return by_sample, by_vial


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
        order = db.execute(select(LimsOrder).where(LimsOrder.order_number == entity_id)).scalar_one_or_none()
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
