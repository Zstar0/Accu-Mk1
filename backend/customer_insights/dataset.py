# backend/customer_insights/dataset.py
"""In-memory Customer Insights dataset assembled from raw rows (pure; no I/O)."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Iterable

from customer_insights.rules import customer_key, is_paid

_CENT = Decimal("0.01")

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
    rep: str | None = None  # SalesKing assigned agent (wc_customers.meta_data), display name


@dataclass(frozen=True)
class Line:
    product: str
    qty: int
    total: Decimal  # post-coupon line total (WC line_items[].total)
    subtotal: Decimal | None = None  # pre-coupon list total; None on rows mirrored before IS 1.0.35


@dataclass(frozen=True)
class CouponLine:
    code: str
    discount: Decimal
    terms: str | None  # configured value, e.g. "15%" or "$50.00"


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
    lines: tuple[Line, ...] = ()
    coupon_lines: tuple[CouponLine, ...] = ()


@dataclass(frozen=True)
class Coa:
    order_number: str
    sample_id: str
    product: str
    passed: bool
    published_at: datetime


@dataclass(frozen=True)
class SlaRec:
    """One sample's SLA facts (from sla_perf.sample_records), business hours throughout."""
    order_number: str
    state: str  # delivered | open | cancelled
    bh: float  # received -> first primary COA (or now, while open)
    target: float
    late: bool
    family_bh: dict[str, float]  # received -> each test family's last verification
    family_target: dict[str, float]
    recv_day: date | None = None  # lab day received (window filter)


@dataclass(frozen=True)
class Dataset:
    customers: dict[str, Customer]
    orders: tuple[Order, ...]
    coas: tuple[Coa, ...]
    late_orders: frozenset[str] | None
    delivered_orders: frozenset[str] | None
    synced_at: datetime | None
    # Orders some submission (paid or free) retests; free retests never reach `orders`.
    retested_order_ids: frozenset[int] = frozenset()
    # Paid $0 orders (a coupon covered everything). Kept out of revenue and repeat metrics;
    # pricing and coupon use read them so a free test still counts as a coupon use at $0.
    free_orders: tuple[Order, ...] = ()
    sla: tuple[SlaRec, ...] = ()


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


# Categories whose line names carry per-order suffixes ("Additional COA - Order #8134 / ...").
_CATEGORY_PRODUCT = {"additional_coa": "Additional COAs", "variance": "Variance", "retest": "Vial re-test"}


def _product_labels(order_rows: list[tuple]) -> dict[int, str]:
    """product_id -> its most common line name (WC renames products; old lines keep old names)."""
    names: dict[int, Counter] = defaultdict(Counter)
    for row in order_rows:
        for i in row[9] or []:
            if i.get("product_id"):
                names[int(i["product_id"])][i.get("name") or ""] += 1
    return {pid: c.most_common(1)[0][0] for pid, c in names.items()}


def _lines(items: list[dict], labels: dict[int, str]) -> tuple[Line, ...]:
    out = []
    for i in items or []:
        cat = i.get("category") or "testing"
        if cat == "fee":  # prepaid draw-downs and card fees are not a product price
            continue
        pid = int(i.get("product_id") or 0)
        product = _CATEGORY_PRODUCT.get(cat) or labels.get(pid) or i.get("name") or "Other"
        sub = i.get("subtotal")
        out.append(Line(product, int(i.get("qty") or 0), Decimal(str(i.get("total") or 0)).quantize(_CENT),
                        Decimal(str(sub)).quantize(_CENT) if sub not in (None, "") else None))
    return tuple(out)


def current_agent(history: Any, today: str) -> str | None:
    """accumark-commissions resolve(): latest {agent_id, from} with from <= today; 0 = none."""
    if isinstance(history, str):
        try:
            history = json.loads(history)
        except ValueError:
            return None
    agent = 0
    for e in sorted((e for e in history or [] if isinstance(e, dict)), key=lambda e: str(e.get("from"))):
        if str(e.get("from")) <= today and str(e.get("agent_id", "")).isdigit():
            agent = int(e["agent_id"])
    return str(agent) if agent else None


def _terms(c: dict) -> str | None:
    amount = c.get("amount")
    if amount in (None, ""):
        return None
    if c.get("type") == "percent":
        return f"{Decimal(str(amount)).normalize():f}%"
    return f"${Decimal(str(amount)):.2f}"


def _coupon_lines(raw: list[dict] | None, codes: list[str] | None, discount: Decimal) -> tuple[CouponLine, ...]:
    raw = [c for c in raw or [] if c.get("code")]
    if raw:
        # The order's discount_total is the truth; coupon lines only give each code's share.
        # (WC can keep a coupon line whose discount was never applied, e.g. after an admin edit.)
        shares = [Decimal(str(c.get("discount") or 0)) for c in raw]
        total = sum(shares, Decimal(0))
        return tuple(CouponLine(c["code"].lower(), (discount * sh / total).quantize(_CENT) if total else Decimal("0.00"),
                                _terms(c)) for c, sh in zip(raw, shares))
    # Rows synced before IS stored coupon_lines: a lone code owns the whole discount.
    if codes and len(codes) == 1:
        return (CouponLine(codes[0].lower(), discount, None),)
    return ()


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
    order_rows = list(order_rows)
    labels = _product_labels(order_rows)
    customers: dict[str, Customer] = {}
    rep_ids: dict[str, str] = {}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")  # ponytail: UTC date, WP uses site-local
    for cid, email, first, last, company, rep_id, history in customer_rows:
        key = f"wc:{int(cid)}"
        customers[key] = Customer(key, _name(first, last, email or key), email, company or None, int(cid))
        agent = current_agent(history, today) or (str(rep_id) if rep_id and str(rep_id).isdigit() else None)
        if agent:
            rep_ids[key] = agent
    for key, rep_id in rep_ids.items():
        agent = customers.get(f"wc:{rep_id}")
        customers[key] = replace(customers[key], rep=agent.name if agent else f"Agent #{rep_id}")

    orders: list[Order] = []
    free_orders: list[Order] = []
    for (oid, number, cid, email, status, total, discount, refund, coupons, items, paid, cl) in order_rows:
        net = (total or Decimal(0)) - (refund or Decimal(0))
        key = customer_key(cid, email)
        if key is None or not is_paid(status, paid):
            continue
        free = net <= 0 and not (total or 0) and not (refund or 0) and bool(coupons)
        if net <= 0 and not free:  # fully refunded
            continue
        sub = subs.get(int(oid))
        samples = list((sub[1] if sub else None) or [])
        # A retest resends the original samples (no NEW sample), so it is paid but not testing.
        is_testing = bool(sub) and bool(samples) and not bool(sub[4]) and not bool(sub[2])
        tests = tuple(t for s in samples for t in _sample_tests(s)) if is_testing else ()
        if key not in customers:
            billing = (sub[5] if sub else None) or {}
            customers[key] = Customer(
                key, _name(billing.get("first_name"), billing.get("last_name"), (email or "").lower()),
                (email or "").lower() or None, billing.get("company_name") or billing.get("company") or None,
                int(cid) if cid else None,
            )
        (free_orders if free else orders).append(Order(
            order_id=int(oid), order_number=norm_order_number(number), customer_key=key, paid_at=paid,
            net=net.quantize(Decimal("0.01")), discount=(discount or Decimal(0)).quantize(Decimal("0.01")),
            coupons=tuple(c.lower() for c in coupons or []),
            categories=tuple(sorted({(i or {}).get("category", "testing") for i in items or []})),
            is_testing=is_testing, samples=len(samples) if is_testing else 0, tests=tests,
            is_retest=bool(sub[2]) if sub else False, retest_of_order_id=int(sub[3]) if sub and sub[3] else None,
            lines=_lines(items, labels),
            coupon_lines=_coupon_lines(cl, coupons, (discount or Decimal(0)).quantize(_CENT)),
        ))
    orders.sort(key=lambda o: o.paid_at)

    coas = tuple(Coa(norm_order_number(n), str(s), p or "", (st or "").upper() == "PASSED", at)
                 for n, s, p, st, at in coa_rows if n and norm_order_number(n))

    late = delivered = None
    sla: tuple[SlaRec, ...] = ()
    if sla_records is not None:
        recs = [(norm_order_number(r["order"]), r) for r in sla_records
                if r.get("order") and r.get("state") == "delivered"]
        delivered = frozenset(n for n, _ in recs if n)
        late = frozenset(n for n, r in recs if n and r.get("late"))
        sla = tuple(
            SlaRec(norm_order_number(r["order"]), r.get("state") or "", float(r.get("bh") or 0),
                   float(r.get("target") or 0), bool(r.get("late")), dict(r.get("family_bh") or {}),
                   dict(r.get("family_target") or {}), r.get("recv_day"))
            for r in sla_records if r.get("order") and r.get("state") in ("delivered", "open")
        )
    retested = frozenset(int(r[3]) for r in subs.values() if r[2] and r[3])
    return Dataset(customers, tuple(orders), coas, late, delivered, synced_at, retested,
                   tuple(sorted(free_orders, key=lambda o: o.paid_at)), sla)
