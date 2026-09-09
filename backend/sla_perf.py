"""SLA performance engine (pure, DB-free) behind ``GET /reports/sla-performance``.

Sibling of :mod:`throughput`: that one counts the work arriving, this one measures
how long it takes to come back out and whether it met target. Takes already-fetched
rows as plain dataclasses and returns finished aggregates, so the browser never sees
the ~3k samples or the tens of thousands of analysis rows behind them.

Nothing here re-derives SLA arithmetic. Business minutes and tier precedence come
from :mod:`sla_engine` — the same functions the SLA column and the notification jobs
call — so the report and the app cannot disagree. Test-family classification comes
from :mod:`throughput` for the same reason: one copy of the sterility keyword set.

Definitions:

* **clock start** — ``lims_samples.date_received`` (naive UTC).
* **clock stop** — the sample's first *primary* COA publication (Integration
  Service ``coa_generations`` with no parent). Re-issues are included and the
  earliest wins, because a later re-issue does not undo first delivery. An
  unpublished sample's clock runs to now.
* **target** — resolved per sample through ``sla_engine.resolve_sla_tier``: a
  tier on any service group the sample touches, else the default tier. Every
  tier in production is 1440 minutes today, but the resolution is real so the
  report follows the day a group is given its own target.
* **late** — strictly ``elapsed > target``; sitting exactly on the limit is not
  a breach (``sla_engine.sla_status_dict``).
* **gating family** — for a sample carrying two or more families, the one whose
  last analysis was verified latest. That family held the COA, whatever the
  others did. ``verified_at`` exists on canonical rows from June 2026, so this
  cut starts there.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import median
from typing import Iterable, Optional, Sequence

from sla_engine import BusinessSchedule, compute_business_minutes, resolve_sla_tier
from throughput import (
    DEPARTMENT_OF_FAMILY,
    DEPARTMENTS,
    FAMILIES,
    FAMILY_NAMES,
    SERIES_START,
    classify_keyword,
    lab_day,
)

# Mirrors throughput: January 2026 is a migration artifact (every sample shares one
# receipt timestamp), so nothing before February is scored.
NOTES = {
    "jan_excluded": True,
    "verified_from": "2026-06",
    "sla_feature_from": "2026-06",
}

# Families that can gate a COA. "other" is excluded on purpose: it is a per-keyword
# bucket (moisture, fentanyl) rather than a department, so crediting it with holding
# a sample would read as a department that does not exist.
GATING_FAMILIES = FAMILIES

CANCELLED_STATUSES = frozenset({"cancelled", "invalid"})

# Business hours remaining before target, worst bucket first.
RISK_BUCKETS = (
    ("Already past target", None, 0.0),
    ("Under 4 hours left", 0.0, 4.0),
    ("4 to 8 hours left", 4.0, 8.0),
    ("8 or more hours left", 8.0, None),
)

CURVE_STEP = 4        # business-hour width of a delivery-curve bin
CURVE_MAX = 80        # everything slower lands in the final bin
RECENT_DAYS = 90      # "how we run today" curve
KPI_DAYS = 30
MIN_LATE_FOR_TREND = 5  # a month needs this many late samples to carry a claim

MONTHS_SHORT = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


@dataclass(frozen=True)
class SampleIn:
    pk: int
    sample_id: str
    date_received: datetime
    status: Optional[str]
    client: Optional[str]
    order: Optional[str] = None


@dataclass(frozen=True)
class AnalysisIn:
    sample_pk: int
    keyword: str
    category: Optional[str] = None
    verified_at: Optional[datetime] = None
    service_id: Optional[int] = None


@dataclass(frozen=True)
class CoaIn:
    sample_id: str
    published_at: datetime
    is_primary: bool


@dataclass(frozen=True)
class TierIn:
    id: int
    name: str
    target_minutes: int
    is_default: bool


@dataclass(frozen=True)
class GroupIn:
    id: int
    name: str
    sla_tier_id: Optional[int]
    service_ids: frozenset[int]


def month_label(ym: str) -> str:
    """``"2026-07"`` -> ``"Jul 2026"``."""
    return "%s %s" % (MONTHS_SHORT[int(ym[5:7]) - 1], ym[:4])


def gating_family(verified_by_family: dict) -> Optional[str]:
    """The family verified last, or None when fewer than two families are timed.

    A single-family sample has nothing to attribute: whatever it carried was both
    the first and the last thing done, so counting it would credit the busiest
    family rather than the one that actually held anything up.
    """
    timed = {f: v for f, v in verified_by_family.items() if v is not None}
    if len(timed) < 2:
        return None
    return max(timed, key=lambda f: timed[f])


def _pct(part: int, whole: int) -> float:
    return round(part / whole * 100, 1) if whole else 0.0


def _quantile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((len(ordered) - 1) * q)))
    return round(ordered[idx], 1)


def _stats(rows: Sequence[dict]) -> dict:
    """On-time summary for a set of delivered samples."""
    if not rows:
        return {"n": 0, "ontime": 0, "late": 0, "rate": 0.0,
                "med": 0.0, "p75": 0.0, "p90": 0.0, "max": 0.0}
    elapsed = [r["bh"] for r in rows]
    late = sum(1 for r in rows if r["late"])
    return {
        "n": len(rows),
        "ontime": len(rows) - late,
        "late": late,
        "rate": _pct(len(rows) - late, len(rows)),
        "med": round(median(elapsed), 1),
        "p75": _quantile(elapsed, 0.75),
        "p90": _quantile(elapsed, 0.90),
        "max": round(max(elapsed), 1),
    }


def build_sla_performance(
    *,
    samples: Iterable[SampleIn],
    analyses: Iterable[AnalysisIn],
    coas: Iterable[CoaIn],
    tiers: Iterable[TierIn],
    groups: Iterable[GroupIn],
    schedule: BusinessSchedule,
    holidays: frozenset,
    now: datetime,
    excluded_sample_ids: frozenset = frozenset(),
    client: Optional[str] = None,
    order: Optional[str] = None,
    departments: Sequence[str] = (),
    families: Sequence[str] = (),
) -> dict:
    """Build the whole SLA performance report from already-fetched rows."""
    department_keys = tuple(k for k, _ in DEPARTMENTS)
    for d in departments:
        if d not in department_keys:
            raise ValueError("unknown department: %s" % d)
    for f in families:
        if f not in FAMILY_NAMES:
            raise ValueError("unknown family: %s" % f)

    tz = schedule.timezone

    def bh(start: datetime, end: datetime) -> float:
        return compute_business_minutes(start, end, schedule, holidays.__contains__) / 60.0

    # ── tiers ───────────────────────────────────────────────────────────────
    tier_by_id = {t.id: t for t in tiers}
    default_tier = next((t for t in tier_by_id.values() if t.is_default), None)
    tier_of_service: dict[int, TierIn] = {}
    for g in groups:
        tier = tier_by_id.get(g.sla_tier_id) if g.sla_tier_id else None
        if tier is None:
            continue
        for sid in g.service_ids:
            tier_of_service[sid] = tier

    # ── per-sample analysis facts ───────────────────────────────────────────
    # De-duplicate on (sample, keyword) across shadow + canonical provenance,
    # keeping the latest verified_at: only canonical rows carry one.
    verified_by_keyword: dict[int, dict[str, Optional[datetime]]] = defaultdict(dict)
    families_of: dict[int, set] = defaultdict(set)
    services_of: dict[int, set] = defaultdict(set)
    for a in analyses:
        fam = classify_keyword(a.keyword, a.category)
        families_of[a.sample_pk].add(fam)
        if a.service_id is not None:
            services_of[a.sample_pk].add(a.service_id)
        seen = verified_by_keyword[a.sample_pk].get(a.keyword)
        if a.verified_at is not None and (seen is None or a.verified_at > seen):
            verified_by_keyword[a.sample_pk][a.keyword] = a.verified_at
        elif a.keyword not in verified_by_keyword[a.sample_pk]:
            verified_by_keyword[a.sample_pk][a.keyword] = a.verified_at
    # Roll the de-duplicated keywords up to one verified timestamp per family.
    verified_by_family: dict[int, dict[str, Optional[datetime]]] = defaultdict(dict)
    for pk, by_kw in verified_by_keyword.items():
        for kw, v in by_kw.items():
            if v is None:
                continue
            fam = _family_of_keyword(kw, analyses, pk)
            prev = verified_by_family[pk].get(fam)
            if prev is None or v > prev:
                verified_by_family[pk][fam] = v

    # ── first primary publication ───────────────────────────────────────────
    first_primary: dict[str, datetime] = {}
    for c in coas:
        if not c.is_primary or c.published_at is None:
            continue
        seen = first_primary.get(c.sample_id)
        if seen is None or c.published_at < seen:
            first_primary[c.sample_id] = c.published_at

    # ── per-sample record ───────────────────────────────────────────────────
    today = lab_day(now, tz) or now.date()
    records = []
    for s in samples:
        if s.sample_id in excluded_sample_ids:
            continue
        received = s.date_received
        if received is None:
            continue
        recv_day = lab_day(received, tz)
        if recv_day is None or recv_day < SERIES_START:
            continue
        sample_families = families_of.get(s.pk, set())
        tier = resolve_sla_tier(
            {},
            _group_tier_for(services_of.get(s.pk, set()), tier_of_service),
            None,
            default_tier,
        )
        target_bh = (tier.target_minutes if tier else 1440) / 60.0
        published = first_primary.get(s.sample_id)
        cancelled = (s.status or "") in CANCELLED_STATUSES
        if published is not None:
            elapsed = bh(received, _naive(published))
            state = "delivered"
        elif cancelled:
            elapsed = 0.0
            state = "cancelled"
        else:
            elapsed = bh(received, now)
            state = "open"
        fam_verified = verified_by_family.get(s.pk, {})
        last_verified = max(fam_verified.values()) if fam_verified else None
        records.append({
            "pk": s.pk,
            "sid": s.sample_id,
            "client": s.client,
            "order": s.order or "",
            "status": s.status or "",
            "received": received,
            "recv_month": recv_day.strftime("%Y-%m"),
            "published": _naive(published) if published is not None else None,
            "pub_day": lab_day(published, tz) if published is not None else None,
            "pub_month": (lab_day(published, tz) or today).strftime("%Y-%m")
            if published is not None else None,
            "state": state,
            "bh": round(elapsed, 2),
            "target": target_bh,
            "tier": tier.name if tier else "—",
            "late": elapsed > target_bh,
            "families": sample_families,
            "verified": fam_verified,
            "last_verified": last_verified,
        })

    facets = _facets(records)

    # ── scoping ─────────────────────────────────────────────────────────────
    wanted_client = (client or "").strip().lower()
    wanted_order = (order or "").strip().lower()
    dept_set = set(departments)
    fam_set = set(families)
    scoped = []
    for r in records:
        if wanted_client and (r["client"] or "").strip().lower() != wanted_client:
            continue
        if wanted_order and wanted_order not in r["order"].lower():
            continue
        if dept_set and not {DEPARTMENT_OF_FAMILY.get(f) for f in r["families"]} & dept_set:
            continue
        if fam_set and not r["families"] & fam_set:
            continue
        scoped.append(r)

    delivered = [r for r in scoped if r["state"] == "delivered"]
    open_rows = [r for r in scoped if r["state"] == "open"]

    return {
        "start": SERIES_START.isoformat(),
        "today": today.isoformat(),
        "tz": tz,
        "target_bh": (default_tier.target_minutes if default_tier else 1440) / 60.0,
        "targets": _targets(scoped),
        "totals": {
            "samples": len(scoped),
            "delivered": len(delivered),
            "open": len(open_rows),
            "cancelled": sum(1 for r in scoped if r["state"] == "cancelled"),
        },
        "overall": _stats(delivered),
        "kpi": _kpi(delivered, today),
        "months": _cohorts(scoped),
        "curve": _curve(delivered, today),
        "stages": _stages(delivered, bh),
        "gating": _gating(delivered, bh),
        "at_risk": _at_risk(open_rows),
        "filters": {
            "client": client or None,
            "order": order or None,
            "departments": list(departments),
            "families": list(families),
        },
        "facets": facets,
        "notes": dict(NOTES),
    }


# ── helpers ─────────────────────────────────────────────────────────────────
def _naive(dt: datetime) -> datetime:
    """Drop tzinfo. Integration Service timestamps arrive tz-aware; Mk1's are naive
    UTC by codebase convention, and the two are compared against each other."""
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


def _family_of_keyword(keyword: str, analyses: Iterable[AnalysisIn], pk: int) -> str:
    """Classify a keyword using the category recorded on that sample's row."""
    for a in analyses:
        if a.sample_pk == pk and a.keyword == keyword:
            return classify_keyword(keyword, a.category)
    return classify_keyword(keyword, None)


def _group_tier_for(service_ids: set, tier_of_service: dict) -> Optional[TierIn]:
    """The tier of any service group the sample touches.

    Production has exactly one tiered group, so "any" is unambiguous today. If a
    second tiered group ever appears the longest target wins, which is the only
    reading that cannot mark work late for a test it was never waiting on.
    """
    hits = [tier_of_service[sid] for sid in service_ids if sid in tier_of_service]
    if not hits:
        return None
    return max(hits, key=lambda t: t.target_minutes)


def _targets(records: Sequence[dict]) -> list:
    counts = Counter((r["tier"], r["target"]) for r in records)
    return [{"name": name, "bh": target, "samples": n}
            for (name, target), n in sorted(counts.items(), key=lambda kv: kv[0][1])]


def _kpi(delivered: Sequence[dict], today: date) -> dict:
    def window(lo: date, hi: date) -> dict:
        return _stats([r for r in delivered
                       if r["pub_day"] is not None and lo <= r["pub_day"] < hi])

    return {
        "last30": window(today - timedelta(days=KPI_DAYS), today + timedelta(days=1)),
        "prev30": window(today - timedelta(days=2 * KPI_DAYS), today - timedelta(days=KPI_DAYS)),
    }


def _cohorts(records: Sequence[dict]) -> list:
    by_month: dict[str, list] = defaultdict(list)
    for r in records:
        if r["state"] == "cancelled":
            continue
        by_month[r["recv_month"]].append(r)
    out = []
    for m in sorted(by_month):
        rows = by_month[m]
        delivered = [r for r in rows if r["state"] == "delivered"]
        open_rows = [r for r in rows if r["state"] == "open"]
        ontime = sum(1 for r in delivered if not r["late"])
        elapsed = [r["bh"] for r in delivered]
        out.append({
            "m": m,
            "label": month_label(m),
            "received": len(rows),
            "delivered": len(delivered),
            "open": len(open_rows),
            "ontime": ontime,
            "late": len(delivered) - ontime,
            "open_late": sum(1 for r in open_rows if r["late"]),
            "rate_delivered": _pct(ontime, len(delivered)),
            "rate_received": _pct(ontime, len(rows)),
            "med": round(median(elapsed), 1) if elapsed else 0.0,
            "p90": _quantile(elapsed, 0.90),
        })
    return out


def _curve(delivered: Sequence[dict], today: date) -> dict:
    bins = list(range(0, CURVE_MAX, CURVE_STEP))

    def series(rows: Sequence[dict]) -> list:
        hist = Counter(min(bins[-1], int(r["bh"] // CURVE_STEP) * CURVE_STEP) for r in rows)
        out, cum = [], 0
        for b in bins:
            cum += hist.get(b, 0)
            out.append({"bh": b + CURVE_STEP, "n": hist.get(b, 0), "cum_pct": _pct(cum, len(rows))})
        return out

    cutoff = today - timedelta(days=RECENT_DAYS)
    recent = [r for r in delivered if r["pub_day"] is not None and r["pub_day"] >= cutoff]
    inside = sum(1 for r in recent if not r["late"])
    return {
        "all": series(delivered),
        "recent": series(recent),
        "recent_n": len(recent),
        "within_target": _pct(inside, len(recent)),
    }


def _stages(delivered: Sequence[dict], bh) -> dict:
    staged = [r for r in delivered if r["last_verified"] is not None]
    rows = []
    for r in staged:
        bench = bh(r["received"], r["last_verified"])
        lag = bh(r["last_verified"], r["published"]) if r["published"] > r["last_verified"] else 0.0
        rows.append({**r, "bench": bench, "lag": lag})
    if not rows:
        return {"n": 0, "coverage": 0.0, "bench_med": 0.0, "bench_p90": 0.0,
                "lag_med": 0.0, "lag_p90": 0.0, "lag_share": 0.0, "lag_over_day": 0,
                "by_month": []}
    total_elapsed = sum(r["bh"] for r in rows)
    by_month: dict[str, list] = defaultdict(list)
    for r in rows:
        if r["pub_month"]:
            by_month[r["pub_month"]].append(r)
    return {
        "n": len(rows),
        "coverage": _pct(len(rows), len(delivered)),
        "bench_med": round(median([r["bench"] for r in rows]), 1),
        "bench_p90": _quantile([r["bench"] for r in rows], 0.90),
        "lag_med": round(median([r["lag"] for r in rows]), 1),
        "lag_p90": _quantile([r["lag"] for r in rows], 0.90),
        "lag_share": _pct(int(round(sum(r["lag"] for r in rows))), int(round(total_elapsed))),
        "lag_over_day": sum(1 for r in rows if r["lag"] > 8),
        "by_month": [{
            "m": m,
            "label": month_label(m),
            "n": len(v),
            "bench": round(median([r["bench"] for r in v]), 1),
            "lag": round(median([r["lag"] for r in v]), 1),
        } for m, v in sorted(by_month.items())],
    }


def _gating(delivered: Sequence[dict], bh) -> dict:
    fam_times: dict[str, list] = defaultdict(list)
    by_month: dict[str, dict] = {}
    mixed = late_mixed = 0
    waits, waits_by_month = [], defaultdict(list)

    for r in delivered:
        verified = {f: v for f, v in r["verified"].items() if f in GATING_FAMILIES}
        month = r["pub_month"]
        for fam, v in verified.items():
            fam_times[fam].append({"bh": bh(r["received"], v), "target": r["target"], "m": month})
        gate = gating_family(verified)
        if gate is None:
            continue
        mixed += 1
        row = by_month.setdefault(month, {"m": month, "label": month_label(month) if month else "",
                                          "late_total": 0, "n": 0})
        row["n"] += 1
        if r["late"]:
            late_mixed += 1
            row["late_total"] += 1
            row[gate + "_gate_late"] = row.get(gate + "_gate_late", 0) + 1
        row[gate + "_gate"] = row.get(gate + "_gate", 0) + 1
        # How long the sample waited on microbiology once the HPLC panel was done.
        micro = [v for f, v in verified.items() if f in ("ster", "endo")]
        if "hplc" in verified and micro:
            micro_done = max(micro)
            if micro_done > verified["hplc"]:
                w = bh(verified["hplc"], micro_done)
                waits.append(w)
                waits_by_month[month].append(w)

    gate_late_total = sum(v.get("late_total", 0) for v in by_month.values())
    families_out = []
    for fam in GATING_FAMILIES:
        entries = fam_times.get(fam, [])
        if not entries:
            continue
        vals = [e["bh"] for e in entries]
        gated_late = sum(v.get(fam + "_gate_late", 0) for v in by_month.values())
        families_out.append({
            "k": fam,
            "name": FAMILY_NAMES[fam],
            "department": DEPARTMENT_OF_FAMILY.get(fam),
            "n": len(vals),
            "med": round(median(vals), 1),
            "p90": _quantile(vals, 0.90),
            "over_target": sum(1 for e in entries if e["bh"] > e["target"]),
            "over_pct": _pct(sum(1 for e in entries if e["bh"] > e["target"]), len(entries)),
            "gated": sum(v.get(fam + "_gate", 0) for v in by_month.values()),
            "gated_late": gated_late,
            "gated_late_pct": _pct(gated_late, gate_late_total),
        })

    trend = []
    for m in sorted(k for k in by_month if k):
        row = dict(by_month[m])
        for fam in GATING_FAMILIES:
            row.setdefault(fam + "_gate", 0)
            row.setdefault(fam + "_gate_late", 0)
            vals = [e["bh"] for e in fam_times.get(fam, []) if e["m"] == m]
            row[fam] = round(median(vals), 1) if vals else None
            row[fam + "_n"] = len(vals)
        row["wait"] = round(median(waits_by_month[m]), 1) if waits_by_month.get(m) else None
        trend.append(row)

    return {
        "mixed": mixed,
        "late_mixed": late_mixed,
        "families": families_out,
        "trend": trend,
        "wait_med": round(median(waits), 1) if waits else 0.0,
        "wait_p90": _quantile(waits, 0.90),
        "wait_n": len(waits),
        "wait_over_day": sum(1 for w in waits if w > 8),
        "min_late_for_trend": MIN_LATE_FOR_TREND,
    }


def _at_risk(open_rows: Sequence[dict]) -> dict:
    buckets = []
    for label, lo, hi in RISK_BUCKETS:
        n = 0
        for r in open_rows:
            left = r["target"] - r["bh"]
            if lo is None and left < hi:
                n += 1
            elif hi is None and lo is not None and left >= lo:
                n += 1
            elif lo is not None and hi is not None and lo <= left < hi:
                n += 1
        buckets.append({"label": label, "n": n})
    ordered = sorted(open_rows, key=lambda r: -r["bh"])
    return {
        "total": len(open_rows),
        "late": sum(1 for r in open_rows if r["late"]),
        "buckets": buckets,
        "status": dict(Counter(r["status"] for r in open_rows)),
        "rows": [{
            "sid": r["sid"],
            "client": r["client"],
            "order": r["order"],
            "status": r["status"],
            "received": r["received"].date().isoformat(),
            "bh": round(r["bh"], 1),
            "over": round(r["bh"] - r["target"], 1),
            "families": sorted(r["families"]),
        } for r in ordered[:30]],
    }


def _facets(records: Sequence[dict]) -> dict:
    """Filter options, computed before scoping so a chip never empties itself."""
    clients: Counter = Counter()
    depts: Counter = Counter()
    fams: Counter = Counter()
    for r in records:
        if r["client"]:
            clients[r["client"]] += 1
        for f in r["families"]:
            fams[f] += 1
            dept = DEPARTMENT_OF_FAMILY.get(f)
            if dept:
                depts[dept] += 1
    return {
        "clients": [{"name": name, "samples": n}
                    for name, n in sorted(clients.items(), key=lambda kv: kv[0].lower())],
        "departments": [{"key": key, "name": name, "samples": depts.get(key, 0)}
                        for key, name in DEPARTMENTS],
        "families": [{"key": f, "name": FAMILY_NAMES[f],
                      "department": DEPARTMENT_OF_FAMILY.get(f), "samples": fams.get(f, 0)}
                     for f in FAMILIES + ("other",) if fams.get(f)],
    }
