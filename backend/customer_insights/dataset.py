# backend/customer_insights/dataset.py
"""In-memory Customer Insights dataset assembled from raw rows (pure; no I/O)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Iterable

from customer_insights.rules import customer_key, is_paid

_LABELS = (
    ("hplc", "HPLC"), ("endotoxin", "Endotoxin"), ("steril", "Sterility"),
    ("solvent", "Residual solvents"), ("variance", "Variance"), ("bacwater", "Bac water panel"),
    ("heavy", "Heavy metals"),
)


@dataclass(frozen=True)
class Customer:
    key: str
    name: str
    email: str | None
    company: str | None
    wc_id: int | None


@dataclass(frozen=True)
class Order:
    order_id: int
    order_number: str
    customer_key: str
    paid_at: datetime
    net: Decimal
    discount: Decimal
    coupons: tuple[str, ...]
    categories: tuple[str, ...]
    is_testing: bool
    samples: int
    tests: tuple[str, ...]
    is_retest: bool
    retest_of_order_id: int | None


@dataclass(frozen=True)
class Coa:
    order_number: str
    sample_id: str
    product: str
    passed: bool
    published_at: datetime


@dataclass(frozen=True)
class Dataset:
    customers: dict[str, Customer]
    orders: tuple[Order, ...]
    coas: tuple[Coa, ...]
    late_orders: frozenset[str] | None
    delivered_orders: frozenset[str] | None
    synced_at: datetime | None


def service_label(service_key: str) -> str | None:
    k = (service_key or "").lower().replace("_", "").replace("-", "")
    return next((label for needle, label in _LABELS if needle in k), None)


def _sample_tests(sample: dict[str, Any]) -> list[str]:
    out: set[str] = set()
    for key, val in (sample.get("services") or {}).items():
        if isinstance(val, dict):
            val = any(val.values())
        if val and (label := service_label(key)):
            out.add(label)
    if sample.get("variance") or sample.get("variance_value"):
        out.add("Variance")
    return sorted(out)


def norm_order_number(v: Any) -> str:
    """One join form for order numbers: SLA records say "WP-8642", wc_orders/IS say "8642"."""
    s = str(v).strip()
    for prefix in ("wp-", "#"):
        if s.lower().startswith(prefix):
            s = s[len(prefix):]
    return s.strip()


def _name(first: str | None, last: str | None, fallback: str) -> str:
    return " ".join(p for p in (first, last) if p) or fallback


def build_dataset(
    *,
    order_rows: Iterable[tuple],
    submission_rows: Iterable[tuple],
    customer_rows: Iterable[tuple],
    coa_rows: Iterable[tuple],
    sla_records: Iterable[dict] | None,
    synced_at: datetime | None,
) -> Dataset:
    subs = {int(r[0]): r for r in submission_rows}
    customers: dict[str, Customer] = {}
    for cid, email, first, last, company in customer_rows:
        key = f"wc:{int(cid)}"
        customers[key] = Customer(key, _name(first, last, email or key), email, company or None, int(cid))

    orders: list[Order] = []
    for (oid, number, cid, email, status, total, discount, refund, coupons, items, paid) in order_rows:
        net = (total or Decimal(0)) - (refund or Decimal(0))
        key = customer_key(cid, email)
        if key is None or not is_paid(status, paid) or net <= 0:
            continue
        sub = subs.get(int(oid))
        samples = list((sub[1] if sub else None) or [])
        is_testing = bool(sub) and bool(samples) and not bool(sub[4])
        tests = tuple(t for s in samples for t in _sample_tests(s)) if is_testing else ()
        if key not in customers:
            billing = (sub[5] if sub else None) or {}
            customers[key] = Customer(
                key, _name(billing.get("first_name"), billing.get("last_name"), (email or "").lower()),
                (email or "").lower() or None, billing.get("company_name") or billing.get("company") or None,
                int(cid) if cid else None,
            )
        orders.append(Order(
            order_id=int(oid), order_number=norm_order_number(number), customer_key=key, paid_at=paid,
            net=net.quantize(Decimal("0.01")), discount=(discount or Decimal(0)).quantize(Decimal("0.01")),
            coupons=tuple(c.lower() for c in coupons or []),
            categories=tuple(sorted({(i or {}).get("category", "testing") for i in items or []})),
            is_testing=is_testing, samples=len(samples) if is_testing else 0, tests=tests,
            is_retest=bool(sub[2]) if sub else False, retest_of_order_id=int(sub[3]) if sub and sub[3] else None,
        ))
    orders.sort(key=lambda o: o.paid_at)

    coas = tuple(Coa(norm_order_number(n), str(s), p or "", (st or "").upper() == "PASSED", at)
                 for n, s, p, st, at in coa_rows if n and norm_order_number(n))

    late = delivered = None
    if sla_records is not None:
        recs = [(norm_order_number(r["order"]), r) for r in sla_records
                if r.get("order") and r.get("state") == "delivered"]
        delivered = frozenset(n for n, _ in recs if n)
        late = frozenset(n for n, r in recs if n and r.get("late"))
    return Dataset(customers, tuple(orders), coas, late, delivered, synced_at)
