"""Lab throughput engine (pure, DB-free) behind ``GET /reports/throughput``.

Takes already-fetched rows as plain dataclasses and returns the per-day series
plus the open-backlog snapshot. Keeping it free of any session/FastAPI import
makes it unit-testable with dicts, exactly like :mod:`sla_engine`.

Definitions (mirroring the offline ``lab-throughput-report`` skill — do not
re-derive):

* **test** — one analysis *family* on a sample: the HPLC panel (identity +
  purity + quantity incl. blend / ``PUR_`` / ``QTY_`` analytes, once per
  sample), ``STER-PCR``, ``ENDO-LAL``, the Bac Water panel (benzyl alcohol +
  pH + fill volume, once per sample). Anything else is "other", per keyword.
  Analyses are de-duplicated on (sample, keyword) across ``shadow`` and
  ``canonical`` provenance so pre-June samples count.
* **day** — ``lims_samples.date_received`` (naive UTC) in the lab timezone.
* **primary COA** — Integration Service ``coa_generations`` row with no
  ``parent_generation_id``; **fp** (samples completed) = a sample's first
  primary publication, clamped to no earlier than its receipt day.
* **backlog** — received, not cancelled, no primary COA yet.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

# January 2026 is a migration artifact (every sample shares one receipt
# timestamp), so the series never starts before February.
SERIES_START = date(2026, 2, 1)

NOTES = {"jan_excluded": True, "vials_from": "2026-06", "bench_from": "2026-03"}

HPLC_CATEGORIES = frozenset({"HPLC", "Peptide Identity", "Peptide Analysis"})
HPLC_KEYWORDS = frozenset({"HPLC-PUR", "PEPT-Total", "HPLC-ID", "BLEND-PUR"})
HPLC_PREFIXES = ("ID_", "ANALYTE-", "PUR_", "QTY_")
BACW_KEYWORDS = frozenset({"Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT"})

AGE_BUCKETS = (("0-2d", 2), ("3-7d", 7), ("8-14d", 14), ("15-30d", 30))
STALE_BUCKET = ">30d"
UNASSIGNED_INSTRUMENT = "unassigned"


@dataclass(frozen=True)
class SampleIn:
    pk: int
    sample_id: str
    date_received: datetime
    status: Optional[str]
    client: Optional[str]
    is_retest: bool = False


@dataclass(frozen=True)
class AnalysisIn:
    sample_pk: int
    keyword: str


@dataclass(frozen=True)
class CoaIn:
    sample_id: str
    published_at: datetime
    is_primary: bool


@dataclass(frozen=True)
class BenchIn:
    label: str
    created_at: datetime
    instrument_id: Optional[int]


@dataclass(frozen=True)
class LabCalendar:
    tz: str
    working_days: frozenset[int]  # Python weekday ints, Mon=0..Sun=6
    holidays: frozenset[date]

    def is_business_day(self, d: date) -> bool:
        return d.weekday() in self.working_days and d not in self.holidays


def classify_keyword(keyword: str, category: Optional[str]) -> str:
    """Map an analysis keyword (+ its service category) to a test family."""
    if keyword == "STER-PCR":
        return "ster"
    if keyword == "ENDO-LAL":
        return "endo"
    if (category or "") in HPLC_CATEGORIES:
        return "hplc"
    if keyword in HPLC_KEYWORDS or keyword.startswith(HPLC_PREFIXES):
        return "hplc"
    if keyword in BACW_KEYWORDS:
        return "bacw"
    return "other"


def lab_day(ts: Optional[datetime], tz: str) -> Optional[date]:
    """Calendar day of ``ts`` in the lab timezone. Naive datetimes are UTC."""
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(ZoneInfo(tz)).date()


def _bench_sample_id(label: str) -> str:
    """``P-0142-2`` (vial label) -> ``P-0142``; plain sample ids pass through."""
    head, sep, tail = label.rpartition("-")
    if sep and tail.isdigit() and head.count("-") >= 1:
        return head
    return label


def build_throughput(
    *,
    samples: list[SampleIn],
    analyses: list[AnalysisIn],
    vial_counts: dict[int, int],
    coas: list[CoaIn],
    bench: list[BenchIn],
    instruments: dict[int, str],
    service_categories: dict[str, Optional[str]],
    calendar: LabCalendar,
    start: date,
    today: date,
    excluded_sample_ids: frozenset[str] = frozenset(),
) -> dict:
    tz = calendar.tz

    # ---- samples in window ----
    by_pk: dict[int, dict] = {}
    for s in samples:
        if s.sample_id in excluded_sample_ids:
            continue
        d = lab_day(s.date_received, tz)
        if d is None or d < start:
            continue
        by_pk[s.pk] = {
            "sid": s.sample_id,
            "d": d,
            "status": s.status or "unknown",
            "client": (s.client or "").strip() or "unknown",
            "retest": bool(s.is_retest),
            "families": set(),
            "other": 0,
            "vials": vial_counts.get(s.pk, 0),
            "pub": None,
        }
    by_sid = {v["sid"]: v for v in by_pk.values()}

    # ---- analyses: distinct (sample, keyword) ----
    seen: set[tuple[int, str]] = set()
    for a in analyses:
        s = by_pk.get(a.sample_pk)
        if s is None or (a.sample_pk, a.keyword) in seen:
            continue
        seen.add((a.sample_pk, a.keyword))
        fam = classify_keyword(a.keyword, service_categories.get(a.keyword))
        if fam == "other":
            s["other"] += 1
        else:
            s["families"].add(fam)

    # ---- COA output ----
    coa_day: Counter = Counter()
    acoa_day: Counter = Counter()
    for c in coas:
        if c.sample_id in excluded_sample_ids:
            continue
        d = lab_day(c.published_at, tz)
        if c.is_primary:
            coa_day[d] += 1
            s = by_sid.get(c.sample_id)
            if s is not None and (s["pub"] is None or d < s["pub"]):
                s["pub"] = d
        else:
            acoa_day[d] += 1

    # ---- HPLC bench ----
    bench_rows: Counter = Counter()
    bench_vials: dict[date, set[str]] = defaultdict(set)
    bench_inst: dict[date, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for b in bench:
        if b.label in excluded_sample_ids or _bench_sample_id(b.label) in excluded_sample_ids:
            continue
        d = lab_day(b.created_at, tz)
        if d is None or d < start:
            continue
        name = instruments.get(b.instrument_id, UNASSIGNED_INSTRUMENT) if b.instrument_id is not None else UNASSIGNED_INSTRUMENT
        bench_rows[d] += 1
        bench_vials[d].add(b.label)
        bench_inst[d][name].add(b.label)
    instrument_names = sorted({n for per_day in bench_inst.values() for n in per_day})

    # ---- per-day accumulation ----
    per_day: dict[date, Counter] = defaultdict(Counter)
    clients_day: dict[date, set[str]] = defaultdict(set)
    received_by_day: Counter = Counter()
    completed_by_day: Counter = Counter()
    for s in by_pk.values():
        c = per_day[s["d"]]
        c["samples"] += 1
        cancelled = s["status"] == "cancelled"
        if cancelled:
            c["cancelled"] += 1
        for fam in s["families"]:
            c[fam] += 1
        c["other"] += s["other"]
        c["vials"] += s["vials"]
        c["retest"] += 1 if s["retest"] else 0
        clients_day[s["d"]].add(s["client"])
        if not cancelled:
            received_by_day[s["d"]] += 1
            if s["pub"] is not None:
                completed_by_day[max(s["pub"], s["d"])] += 1

    days: list[dict] = []
    backlog = 0
    d = start
    while d <= today:
        c = per_day.get(d, Counter())
        backlog += received_by_day.get(d, 0) - completed_by_day.get(d, 0)
        days.append(
            {
                "d": d.isoformat(),
                "dow": d.weekday(),
                "biz": calendar.is_business_day(d),
                "hol": d in calendar.holidays,
                "samples": c["samples"],
                "cancelled": c["cancelled"],
                "hplc": c["hplc"],
                "ster": c["ster"],
                "endo": c["endo"],
                "bacw": c["bacw"],
                "other": c["other"],
                "tests": c["hplc"] + c["ster"] + c["endo"] + c["bacw"] + c["other"],
                "vials": c["vials"],
                "retest": c["retest"],
                "clients": len(clients_day.get(d, ())),
                "coa": coa_day.get(d, 0),
                "acoa": acoa_day.get(d, 0),
                "fp": completed_by_day.get(d, 0),
                "bench_rows": bench_rows.get(d, 0),
                "bench_vials": len(bench_vials.get(d, ())),
                "bench_inst": {n: len(v) for n, v in bench_inst[d].items()} if d in bench_inst else {},
                "backlog": backlog,
            }
        )
        d += timedelta(days=1)

    # ---- open backlog now ----
    open_now = [s for s in by_pk.values() if s["status"] != "cancelled" and s["pub"] is None]
    age: Counter = Counter()
    for s in open_now:
        a = (today - s["d"]).days
        for label, limit in AGE_BUCKETS:
            if a <= limit:
                age[label] += 1
                break
        else:
            age[STALE_BUCKET] += 1
    status_counts = Counter(s["status"] for s in open_now)

    return {
        "start": start.isoformat(),
        "end": today.isoformat(),
        "today": today.isoformat(),
        "tz": tz,
        "instruments": instrument_names,
        "holidays": sorted(h.isoformat() for h in calendar.holidays if start <= h <= today),
        "days": days,
        "backlog_now": {"total": len(open_now), "status": dict(status_counts), "age": dict(age)},
        "notes": dict(NOTES),
    }
