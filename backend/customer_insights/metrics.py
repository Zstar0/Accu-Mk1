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
    keep = [o for o in ds.orders if not rules.is_excluded(o.customer_key, exclude_launch=exclude_launch)]
    keys = {o.customer_key for o in keep}
    return replace(ds, orders=tuple(keep), customers={k: c for k, c in ds.customers.items() if k in keys})


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


def _window(ds: Dataset, start: datetime | None, end: datetime) -> list[Order]:
    return [o for o in ds.orders if (start is None or o.paid_at >= start) and o.paid_at <= end]


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

    paid_keys = {x.customer_key for x in _upto(ds, end)}  # customers WITH orders (not every wc_customers row)
    ltv = sorted((sum((x.net for x in _upto(ds, end) if x.customer_key == k), ZERO) for k in paid_keys), reverse=True)
    total = sum(ltv, ZERO)
    dates = testing_dates(ds, end)
    repeaters = {k for k, d in dates.items() if len(d) >= 2}
    repeat_rev = sum((x.net for x in _upto(ds, end) if x.customer_key in repeaters), ZERO)
    decile = max(1, len(ltv) // 10) if ltv else 0

    def share(part: Decimal) -> float:
        return round(float(part / total), 4) if total else 0.0

    testing = [x for x in _upto(ds, end) if x.is_testing]
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
