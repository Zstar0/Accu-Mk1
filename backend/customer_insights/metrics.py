# backend/customer_insights/metrics.py
"""Pure Customer Insights builders. Everything takes (Dataset, as-of bounds, tz)."""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from customer_insights import rules
from customer_insights.dataset import Dataset, Order

ZERO = Decimal("0.00")
ADDON_TESTS = ("Endotoxin", "Sterility", "Heavy metals", "Variance")


def money(d: Decimal) -> str:
    return str(Decimal(d).quantize(Decimal("0.01")))


def scope(ds: Dataset, *, exclude_launch: bool) -> Dataset:
    def drop(key: str) -> bool:
        c = ds.customers.get(key)
        return rules.is_excluded(key, exclude_launch=exclude_launch, email=c.email if c else None)

    keep = [o for o in ds.orders if not drop(o.customer_key)]
    free = tuple(o for o in ds.free_orders if not drop(o.customer_key))
    keys = {o.customer_key for o in keep}
    return replace(ds, orders=tuple(keep), free_orders=free,
                   customers={k: c for k, c in ds.customers.items() if k in keys})


def _upto(ds: Dataset, end: datetime) -> list[Order]:
    return [o for o in ds.orders if o.paid_at <= end]


def testing_dates(ds: Dataset, end: datetime | None = None) -> dict[str, list[datetime]]:
    out: dict[str, list[datetime]] = defaultdict(list)
    for o in ds.orders:
        if o.is_testing and (end is None or o.paid_at <= end):
            out[o.customer_key].append(o.paid_at)
    return out


def _repeat_stats(ds: Dataset, end: datetime) -> tuple[float | None, float | None]:
    dates = testing_dates(ds, end)
    mature = [d for d in dates.values() if (end - d[0]).days >= rules.MATURITY_DAYS]
    rate = round(sum(len(d) >= 2 for d in mature) / len(mature), 4) if mature else None
    seconds = [(d[1] - d[0]).total_seconds() / 86400 for d in dates.values() if len(d) >= 2]
    return rate, (round(statistics.median(seconds), 1) if seconds else None)


def _window(ds: Dataset, start: datetime | None, end: datetime, *, free: bool = False) -> list[Order]:
    src = ds.orders + ds.free_orders if free else ds.orders
    return [o for o in src if (start is None or o.paid_at >= start) and o.paid_at <= end]


def _kpis(ds: Dataset, start: datetime | None, end: datetime) -> dict[str, Any]:
    win = _window(ds, start, end)
    revenue = sum((o.net for o in win), ZERO)
    rate, median2 = _repeat_stats(ds, end)
    return {"active": len({o.customer_key for o in win}), "revenue": revenue, "orders": len(win),
            "aov": revenue / len(win) if win else ZERO, "repeat": rate, "median2": median2}


def summary(ds: Dataset, *, start: datetime | None, end: datetime, tz: str) -> dict[str, Any]:
    cur = _kpis(ds, start, end)
    prior = _kpis(ds, start - (end - start), start) if start else None

    def pair(k: str, fmt=lambda v: v) -> dict[str, Any]:
        return {"value": fmt(cur[k]), "prior": fmt(prior[k]) if prior else None}

    first_paid: dict[str, str] = {}
    for x in ds.orders:
        first_paid.setdefault(x.customer_key, rules.lab_month(x.paid_at, tz))
    by_month: dict[str, dict[str, Decimal]] = defaultdict(lambda: {"new": ZERO, "returning": ZERO})
    for x in _window(ds, start, end):
        m = rules.lab_month(x.paid_at, tz)
        by_month[m]["new" if first_paid[x.customer_key] == m else "returning"] += x.net

    upto = _upto(ds, end)
    net_by_key: dict[str, Decimal] = defaultdict(lambda: ZERO)  # customers WITH orders only
    for x in upto:
        net_by_key[x.customer_key] += x.net
    ltv = sorted(net_by_key.values(), reverse=True)
    total = sum(ltv, ZERO)
    dates = testing_dates(ds, end)
    repeaters = {k for k, d in dates.items() if len(d) >= 2}
    repeat_rev = sum((v for k, v in net_by_key.items() if k in repeaters), ZERO)
    decile = max(1, len(ltv) // 10) if ltv else 0

    def share(part: Decimal) -> float:
        return round(float(part / total), 4) if total else 0.0

    testing = [x for x in upto if x.is_testing]
    first_ids = {d[0] for d in dates.values()}
    attach = []
    for t in ADDON_TESTS + ("Additional COAs",):
        def has(x: Order) -> bool:
            return "additional_coa" in x.categories if t == "Additional COAs" else t in x.tests
        new = [x for x in testing if x.paid_at in first_ids]
        ret = [x for x in testing if x.paid_at not in first_ids]
        attach.append({"test": t,
                       "new": round(sum(map(has, new)) / len(new), 4) if new else 0.0,
                       "returning": round(sum(map(has, ret)) / len(ret), 4) if ret else 0.0})

    kinds: dict[str, list[bool]] = defaultdict(list)
    for k, d in dates.items():
        if (end - d[0]).days < rules.MATURITY_DAYS:
            continue
        first = next(x for x in testing if x.customer_key == k and x.paid_at == d[0])
        if "accutry50" in first.coupons:
            kind = "accutry50"
        elif first.coupons:
            kind = "other_coupon"
        elif any(t in first.tests for t in ADDON_TESTS):
            kind = "with_addon"
        else:
            kind = "full_price"
        kinds[kind].append(len(d) >= 2)

    return {
        "kpis": {
            "active_customers": pair("active"), "revenue": pair("revenue", money),
            "paid_orders": pair("orders"), "aov": pair("aov", money),
            "repeat_rate": pair("repeat"), "median_days_to_second": pair("median2"),
        },
        "revenue_by_month": [{"month": m, "new": money(v["new"]), "returning": money(v["returning"])}
                             for m, v in sorted(by_month.items())],
        "concentration": {
            "top10_share": share(sum(ltv[:10], ZERO)), "top_decile_share": share(sum(ltv[:decile], ZERO)),
            "repeat_share": share(repeat_rev), "customers": len(ltv),
            "median_ltv": money(Decimal(statistics.median(ltv)) if ltv else ZERO),
            "mean_ltv": money(total / len(ltv) if ltv else ZERO),
        },
        "attach": attach,
        "product_prices": product_prices(_window(ds, start, end, free=True)),
        "first_order": [{"kind": kind, "customers": len(kinds.get(kind, [])),
                         "repeat_rate": round(sum(kinds[kind]) / len(kinds[kind]), 4) if kinds.get(kind) else None}
                        for kind in ("accutry50", "other_coupon", "full_price", "with_addon")],
    }


def _month_add(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    m += n
    return f"{y + (m - 1) // 12:04d}-{(m - 1) % 12 + 1:02d}"


def cohorts(ds: Dataset, *, end: datetime, tz: str, max_months: int = 12) -> dict[str, Any]:
    months_by_key: dict[str, set[str]] = defaultdict(set)
    first: dict[str, str] = {}
    for x in ds.orders:
        if x.is_testing and x.paid_at <= end:
            m = rules.lab_month(x.paid_at, tz)
            first.setdefault(x.customer_key, m)
            months_by_key[x.customer_key].add(m)
    now_m = rules.lab_month(end, tz)
    groups: dict[str, list[str]] = defaultdict(list)
    for k, m in first.items():
        groups[m].append(k)
    rows = []
    for cohort in sorted(groups):
        members = groups[cohort]
        cells: list[float | None] = []
        for k in range(1, max_months + 1):
            target = _month_add(cohort, k)
            if target > now_m:
                cells.append(None)
                continue
            cells.append(round(sum(target in months_by_key[c] for c in members) / len(members), 4))
        rows.append({"cohort": cohort, "size": len(members), "cells": cells})
    return {"months": [f"M{k}" for k in range(1, max_months + 1)], "rows": rows}


def _spend(orders: list[Order], start: datetime | None, end: datetime) -> Decimal:
    return sum((o.net for o in orders if (start is None or o.paid_at >= start) and o.paid_at <= end), ZERO)


def _by_customer(ds: Dataset, end: datetime) -> dict[str, list[Order]]:
    out: dict[str, list[Order]] = defaultdict(list)
    for x in ds.orders:
        if x.paid_at <= end:
            out[x.customer_key].append(x)
    return out


def customer_rows(ds: Dataset, *, start: datetime | None, end: datetime, tz: str) -> list[dict[str, Any]]:
    rows = []
    span = (end - start) if start else timedelta(days=90)
    p_start = start or end - span
    for key, orders in _by_customer(ds, end).items():
        c = ds.customers.get(key)
        dates = [x.paid_at for x in orders if x.is_testing]
        period = _spend(orders, p_start, end)
        prior = _spend(orders, p_start - span, p_start)
        risk = rules.is_at_risk(dates, end)
        monthly: dict[str, Decimal] = defaultdict(lambda: ZERO)
        for x in orders:
            monthly[rules.lab_month(x.paid_at, tz)] += x.net
        tests = Counter(t for x in orders for t in x.tests)
        rows.append({
            "key": key, "name": c.name if c else key, "email": c.email if c else None,
            "company": c.company if c else None, "rep": c.rep if c else None,
            "period_spend": money(period), "prior_spend": money(prior),
            "delta_pct": round(float((period - prior) / prior), 4) if prior else None,
            "lifetime": money(_spend(orders, None, end)), "orders": len(orders),
            "samples": sum(x.samples for x in orders),
            "usual_gap_days": round(rules.usual_gap_days(dates), 1) if len(dates) >= 3 else None,
            "last_order_at": max(dates).isoformat() if dates else None,
            "top_tests": [t for t, _ in tests.most_common(3)],
            "status": rules.spend_status(paid_orders=len(orders), at_risk=risk, period=period, prior=prior),
            "monthly": [{"month": m, "spend": money(v)} for m, v in sorted(monthly.items())],
        })
    return rows


def at_risk(ds: Dataset, *, end: datetime, tz: str) -> list[dict[str, Any]]:
    rows = [r for r in customer_rows(ds, start=end - timedelta(days=90), end=end, tz=tz) if r["status"] == "at_risk"]
    by = _by_customer(ds, end)
    for r in rows:
        r["spend_12m"] = money(_spend(by[r["key"]], end - timedelta(days=365), end))
        r["overdue"] = rules.overdue_ratio([x.paid_at for x in by[r["key"]] if x.is_testing], end)
    return sorted(rows, key=lambda r: Decimal(r["spend_12m"]), reverse=True)


def order_rows(ds: Dataset, *, start: datetime | None, end: datetime) -> list[dict[str, Any]]:
    return [{
        "customer_key": x.customer_key, "order_id": x.order_id, "order_number": x.order_number,
        "paid_at": x.paid_at.isoformat(), "net": money(x.net), "discount": money(x.discount),
        "coupons": list(x.coupons), "categories": list(x.categories), "samples": x.samples,
        "tests": sorted(set(x.tests)),
    } for x in _window(ds, start, end)]


def product_prices(orders: list[Order]) -> list[dict[str, Any]]:
    """Avg price actually paid per paid unit (post-coupon line total / qty), by product.

    Free units ($0 lines, e.g. a 100% coupon) are counted in free_units, not averaged.

    ponytail: refunds are order-level only, so a partially refunded order keeps full line prices.
    """
    agg: dict[str, list] = defaultdict(lambda: [0, ZERO, set(), 0])
    for x in orders:
        for ln in x.lines:
            if ln.qty <= 0:
                continue
            a = agg[ln.product]
            a[2].add(x.customer_key)
            if ln.total <= 0:  # free (100% coupon): counted, never averaged in as $0
                a[3] += ln.qty
                continue
            a[0] += ln.qty
            a[1] += ln.total
    rows = [{"product": p, "units": u, "avg_price": money(t / u) if u else None, "revenue": money(t),
             "customers": len(c), "free_units": f}
            for p, (u, t, c, f) in agg.items()]
    return sorted(rows, key=lambda r: -Decimal(r["revenue"]))


def coupon_use(orders: list[Order]) -> list[dict[str, Any]]:
    agg: dict[str, dict[str, Any]] = {}
    for x in sorted(orders, key=lambda x: x.paid_at):
        for c in x.coupon_lines:
            a = agg.setdefault(c.code, {"code": c.code, "orders": 0, "discount": ZERO, "terms": None})
            a["orders"] += 1
            a["discount"] += c.discount
            a["terms"] = c.terms or a["terms"]  # latest configured terms win
            a["last_used"] = x.paid_at.isoformat()
    return sorted(({**a, "discount": money(a["discount"])} for a in agg.values()), key=lambda a: -a["orders"])


def _rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def dossier(ds: Dataset, key: str, *, end: datetime, tz: str) -> dict[str, Any] | None:
    by = _by_customer(ds, end)
    orders = by.get(key)
    if not orders:
        return None
    c = ds.customers.get(key)
    numbers = {x.order_number for x in orders}
    lifetimes = sorted(((k, _spend(v, None, end)) for k, v in by.items()), key=lambda kv: kv[1], reverse=True)
    rank = next(i for i, (k, _) in enumerate(lifetimes, 1) if k == key)
    dates = [x.paid_at for x in orders if x.is_testing]
    gaps = sorted((b - a).total_seconds() / 86400 for a, b in zip(dates, dates[1:]))
    iqr = [round(gaps[len(gaps) // 4], 1), round(gaps[(3 * len(gaps)) // 4], 1)] if len(gaps) >= 2 else None
    mine = [x for x in ds.coas if x.order_number in numbers]
    tests = Counter(t for x in orders for t in x.tests)
    all_tests = Counter(t for x in ds.orders if x.paid_at <= end for t in x.tests)
    samples = sum(x.samples for x in orders)
    all_samples = sum(x.samples for x in ds.orders if x.paid_at <= end)
    products: dict[str, list[bool]] = defaultdict(list)
    for x in mine:
        products[x.product].append(x.passed)

    def on_time(nums: set[str]) -> float | None:
        if ds.delivered_orders is None or ds.late_orders is None:
            return None
        delivered = nums & ds.delivered_orders
        return _rate(len(delivered - ds.late_orders), len(delivered))

    all_numbers = {x.order_number for x in ds.orders if x.paid_at <= end}
    lab_coas = [x for x in ds.coas if x.order_number in all_numbers]  # scope() filters orders, not COAs
    monthly: dict[str, dict[str, Any]] = defaultdict(lambda: {"spend": ZERO, "samples": 0})
    for x in orders:
        m = monthly[rules.lab_month(x.paid_at, tz)]
        m["spend"] += x.net
        m["samples"] += x.samples
    period = _spend(orders, end - timedelta(days=90), end)
    prior = _spend(orders, end - timedelta(days=180), end - timedelta(days=90))
    risk = rules.is_at_risk(dates, end)
    lab_prices = {r["product"]: r["avg_price"] for r in product_prices(_window(ds, None, end, free=True))}
    priced = orders + [x for x in ds.free_orders if x.customer_key == key and x.paid_at <= end]
    test_prices = [{**r, "lab_avg_price": lab_prices.get(r["product"])} for r in product_prices(priced)]

    def recent_row(x: Order) -> dict[str, Any]:
        cs = [y for y in mine if y.order_number == x.order_number]
        sla = None
        if ds.delivered_orders is not None and ds.late_orders is not None and x.order_number in ds.delivered_orders:
            sla = "late" if x.order_number in ds.late_orders else "on_time"
        return {"order_number": x.order_number, "paid_at": x.paid_at.isoformat(), "coas": len(cs),
                "failed": sum(not y.passed for y in cs), "sla": sla}

    return {
        "identity": {"key": key, "name": c.name if c else key, "email": c.email if c else None,
                     "company": c.company if c else None, "wc_id": c.wc_id if c else None,
                     "rep": c.rep if c else None,
                     "since": orders[0].paid_at.isoformat()},
        "kpis": {
            "lifetime": money(_spend(orders, None, end)), "rank": rank, "customers": len(lifetimes),
            "orders": len(orders), "avg_order": money(_spend(orders, None, end) / len(orders)),
            "samples": samples, "samples_per_order": round(samples / len(orders), 1),
            "usual_gap_days": round(rules.usual_gap_days(dates), 1) if len(dates) >= 3 else None,
            "gap_iqr": iqr,
            "nonconforming_rate": _rate(sum(not x.passed for x in mine), len(mine)),
            "lab_nonconforming_rate": _rate(sum(not x.passed for x in lab_coas), len(lab_coas)),
            "on_time_rate": on_time(numbers), "lab_on_time_rate": on_time(all_numbers),
        },
        "status": rules.spend_status(paid_orders=len(orders), at_risk=risk, period=period, prior=prior),
        "days_since_last": round((end - dates[-1]).total_seconds() / 86400, 1) if dates else None,
        "overdue": rules.overdue_ratio(dates, end),
        "spend_delta_pct": round(float((period - prior) / prior), 4) if prior else None,
        "monthly": [{"month": m, "spend": money(v["spend"]), "samples": v["samples"]} for m, v in sorted(monthly.items())],
        "order_dates": [d.isoformat() for d in dates],
        "test_mix": [{"test": t, "share": round(n / samples, 4) if samples else 0.0,
                      "all_share": round(all_tests[t] / all_samples, 4) if all_samples else 0.0}
                     for t, n in sorted(tests.items(), key=lambda kv: -kv[1])],
        "analytes": sorted(({"product": p, "coas": len(v), "pass_rate": round(sum(v) / len(v), 4)}
                            for p, v in products.items()), key=lambda r: -r["coas"])[:8],
        "test_prices": test_prices,
        "free_tests": sum(r["free_units"] for r in test_prices),
        "coupons": coupon_use(priced),
        "recent": [recent_row(x) for x in sorted(orders, key=lambda x: x.paid_at, reverse=True)[:6]],
        "orders": order_rows(replace(ds, orders=tuple(orders)), start=None, end=end),
    }


def churn_signals(ds: Dataset, *, end: datetime) -> dict[str, Any]:
    window = timedelta(days=rules.CHURN_WINDOW_DAYS)
    testing = [x for x in ds.orders if x.is_testing]
    retested = ds.retested_order_ids  # from every submission: free ($0) retests are not in ds.orders
    by_key: dict[str, list[datetime]] = defaultdict(list)
    for x in testing:
        by_key[x.customer_key].append(x.paid_at)
    coa_by_order: dict[str, list[bool]] = defaultdict(list)
    for c in ds.coas:
        coa_by_order[c.order_number].append(c.passed)
    acc: dict[tuple[str, str], list[bool]] = defaultdict(list)
    for x in testing:
        if x.paid_at > end - window:
            continue
        came_back = any(x.paid_at < d <= x.paid_at + window for d in by_key[x.customer_key])
        if ds.delivered_orders is not None and ds.late_orders is not None and x.order_number in ds.delivered_orders:
            acc[("sla", "late" if x.order_number in ds.late_orders else "on_time")].append(came_back)
        if coa_by_order.get(x.order_number):
            acc[("conformance", "all_pass" if all(coa_by_order[x.order_number]) else "any_fail")].append(came_back)
        acc[("retest", "retest" if x.order_id in retested else "no_retest")].append(came_back)
    return {"window_days": rules.CHURN_WINDOW_DAYS,
            "buckets": [{"signal": s, "group": g, "orders": len(v), "returned": _rate(sum(v), len(v))}
                        for (s, g), v in sorted(acc.items())]}


def changes(ds: Dataset, *, since: datetime, end: datetime, tz: str) -> list[dict[str, Any]]:
    """Stateless diff: rule outputs at `since` vs `end`.
    ponytail: recomputes both instants; persist events if bots need an audit trail."""
    before = {r["key"]: r for r in customer_rows(ds, start=since - timedelta(days=90), end=since, tz=tz)}
    after = {r["key"]: r for r in customer_rows(ds, start=end - timedelta(days=90), end=end, tz=tz)}

    def decile(rows: dict[str, dict]) -> set[str]:
        ranked = sorted(rows.values(), key=lambda r: Decimal(r["lifetime"]), reverse=True)
        return {r["key"] for r in ranked[: max(1, len(ranked) // 10)]} if ranked else set()

    top_before, top_after = decile(before), decile(after)
    t_before = testing_dates(ds, since)
    t_after = testing_dates(ds, end)
    events: list[dict[str, Any]] = []

    def ev(kind: str, key: str, **detail: Any) -> None:
        events.append({"type": kind, "customer_key": key, "name": after[key]["name"],
                       "detected_at": end.isoformat(), "detail": detail})

    for key, r in after.items():
        prev = before.get(key)
        prev_status = prev["status"] if prev else None
        if r["status"] == "at_risk" and prev_status != "at_risk":
            ev("became_at_risk", key, usual_gap_days=r["usual_gap_days"], last_order_at=r["last_order_at"])
        if r["status"] == "dropping" and prev_status != "dropping":
            ev("spend_drop", key, period_spend=r["period_spend"], prior_spend=r["prior_spend"], delta_pct=r["delta_pct"])
        if len(t_before.get(key, [])) == 1 and len(t_after.get(key, [])) >= 2:
            ev("first_reorder", key, orders=len(t_after[key]))
        if prev_status == "at_risk" and r["status"] != "at_risk":
            ev("returned", key, last_order_at=r["last_order_at"])
        if key in top_after and key not in top_before:
            ev("entered_top_decile", key, lifetime=r["lifetime"])
    return events
