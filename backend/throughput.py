"""Lab throughput engine (pure, DB-free) behind ``GET /reports/throughput``.

Takes already-fetched rows as plain dataclasses and returns the per-day series
plus the open-backlog snapshot. Keeping it free of any session/FastAPI import
makes it unit-testable with dicts, exactly like :mod:`sla_engine`.

Definitions (mirroring the offline ``lab-throughput-report`` skill — do not
re-derive):

* **test** — one analysis *family* on a sample: the HPLC panel (identity +
  purity + quantity incl. blend / ``PUR_`` / ``QTY_`` analytes, once per
  sample), sterility (legacy ``STER-PCR`` or the catalog-arc ``STERILITY-PCR``
  / ``STERILITY-USP71``), endotoxin (``ENDO-LAL`` / ``ENDOTOXIN-USP85LAL``),
  the Bac Water panel (benzyl alcohol + pH + fill volume, once per sample) and
  the heavy-metals panel (``LEAD-PPM`` … ``ARSENIC-PPM``, once per sample).
  Anything else is "other", per keyword (e.g. ``MOISTURE-KF``, ``FENTANYL``).
  Analyses are de-duplicated on (sample, keyword) across ``shadow`` and
  ``canonical`` provenance so pre-June samples count.
* **day** — ``lims_samples.date_received`` (naive UTC) in the lab timezone.
* **primary COA** — Integration Service ``coa_generations`` row with no
  ``parent_generation_id``; **fp** (samples completed) = a sample's first
  primary publication, clamped to no earlier than its receipt day.
* **backlog** — received, not cancelled, no primary COA yet.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional
from zoneinfo import ZoneInfo

# January 2026 is a migration artifact (every sample shares one receipt
# timestamp), so the series never starts before February.
SERIES_START = date(2026, 2, 1)

NOTES = {"jan_excluded": True, "vials_from": "2026-06", "bench_from": "2026-03"}

HPLC_CATEGORIES = frozenset({"HPLC", "Peptide Identity", "Peptide Analysis"})
HPLC_KEYWORDS = frozenset({"HPLC-PUR", "PEPT-Total", "HPLC-ID", "BLEND-PUR"})
HPLC_PREFIXES = ("ID_", "ANALYTE-", "PUR_", "QTY_")
BACW_KEYWORDS = frozenset({"Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT"})
# Legacy SENAITE keyword + the catalog-arc forms live in prod since 2026-09-01.
STER_KEYWORDS = frozenset({"STER-PCR", "STERILITY-PCR", "STERILITY-USP71"})
STER_CATEGORY = "Sterility"
ENDO_KEYWORDS = frozenset({"ENDO-LAL", "ENDOTOXIN-USP85LAL"})
ENDO_PREFIX = "ENDOTOXIN"
# Heavy-metals panel: classified by keyword suffix on purpose — the category is
# NULL on several prod rows (see the hm-under-Analytical department state).
HM_CATEGORY = "Heavy Metals"
HM_SUFFIX = "-PPM"

FAMILIES = ("hplc", "ster", "endo", "bacw", "hm")  # once-per-sample families; "other" is per keyword
ALL_FAMILIES = FAMILIES + ("other",)
FAMILY_NAMES = {
    "hplc": "HPLC panel",
    "ster": "Sterility",
    "endo": "Endotoxin",
    "bacw": "Bac Water panel",
    "hm": "Heavy metals",
    "other": "Other",
}
# Department chips mirror the Vial Status board (Analytical / Microbiology / Heavy Metals).
# Mapped from the family, not from analysis_services.department_id, because prod still
# files the heavy-metals services under Analytical (see the hm-under-Analytical note).
DEPARTMENTS = (("analytical", "Analytical"), ("microbiology", "Microbiology"), ("heavy_metals", "Heavy Metals"))
DEPARTMENT_KEYS = tuple(k for k, _ in DEPARTMENTS)
DEPARTMENT_OF_FAMILY = {
    "hplc": "analytical",
    "bacw": "analytical",
    "other": "analytical",
    "ster": "microbiology",
    "endo": "microbiology",
    "hm": "heavy_metals",
}

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
    order: Optional[str] = None  # lims_samples.client_order_number (the WP order number)


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
    if keyword in STER_KEYWORDS or category == STER_CATEGORY:
        return "ster"
    if keyword in ENDO_KEYWORDS or keyword.startswith(ENDO_PREFIX):
        return "endo"
    if category == HM_CATEGORY or keyword.endswith(HM_SUFFIX):
        return "hm"
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


_VIAL_TAIL = re.compile(r"[SR]?\d+")


def bench_sample_id(label: str) -> str:
    """Parent sample id for an HPLC bench label.

    Vial-scoped preps label rows with the native vial id (``P-0134-S01``), a
    retest adds another suffix (``P-0134-S01-R01``), and legacy rows may use a
    bare ordinal (``P-0142-2``). Strip every trailing ``-S01`` / ``-R01`` /
    ``-2`` segment; plain sample ids (``P-0142``, ``BW-0076``) pass through.
    """
    while True:
        head, sep, tail = label.rpartition("-")
        if sep and head.count("-") >= 1 and _VIAL_TAIL.fullmatch(tail):
            label = head
        else:
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
    client: Optional[str] = None,
    order: Optional[str] = None,
    departments: Optional[Iterable[str]] = None,
    families: Optional[Iterable[str]] = None,
) -> dict:
    """Build the report.

    ``excluded_sample_ids`` (test orders) is applied first and also shapes the
    facets. ``client`` / ``order`` / ``departments`` / ``families`` then scope
    the counted samples and, when any of them is set, COA output and bench rows
    are restricted to the kept samples too (unscoped, every published COA
    counts, even for samples Mk1 never registered).
    """
    tz = calendar.tz
    dept_filter = list(dict.fromkeys(departments or ()))
    family_filter = list(dict.fromkeys(families or ()))
    client_key = (client or "").strip().casefold() or None
    order_key = (order or "").strip().casefold() or None

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
            "order": (s.order or "").strip().casefold(),
            "retest": bool(s.is_retest),
            "families": set(),
            "other": 0,
            "vials": vial_counts.get(s.pk, 0),
            "pub": None,
        }

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

    # ---- facets: computed BEFORE the scoping filters so the dropdowns stay stable ----
    facets = _facets(by_pk.values())

    # ---- scoping filters ----
    if family_filter:
        in_scope = set(family_filter)
    elif dept_filter:
        in_scope = {f for f, dep in DEPARTMENT_OF_FAMILY.items() if dep in dept_filter}
    else:
        in_scope = None
    scoped = bool(client_key or order_key or in_scope is not None)
    if scoped:
        kept: dict[int, dict] = {}
        for pk, s in by_pk.items():
            if client_key and s["client"].casefold() != client_key:
                continue
            if order_key and s["order"] != order_key:
                continue
            if in_scope is not None:
                s["families"] = {f for f in s["families"] if f in in_scope}
                if "other" not in in_scope:
                    s["other"] = 0
                if not s["families"] and not s["other"]:
                    continue
            kept[pk] = s
        by_pk = kept
    by_sid = {v["sid"]: v for v in by_pk.values()}

    # ---- COA output ----
    coa_day: Counter = Counter()
    acoa_day: Counter = Counter()
    for c in coas:
        if c.sample_id in excluded_sample_ids:
            continue
        if scoped and c.sample_id not in by_sid:
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
        parent = bench_sample_id(b.label)
        if b.label in excluded_sample_ids or parent in excluded_sample_ids:
            continue
        if scoped and b.label not in by_sid and parent not in by_sid:
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
                "hm": c["hm"],
                "other": c["other"],
                "tests": sum(c[f] for f in FAMILIES) + c["other"],
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
        "filters": {"client": client, "order": order, "departments": dept_filter, "families": family_filter},
        "facets": facets,
        "notes": dict(NOTES),
    }


def _facets(samples: Iterable[dict]) -> dict:
    """Dropdown/chip options with counts: customers, departments, families."""
    clients: Counter = Counter()
    fam_tests: Counter = Counter()
    for s in samples:
        clients[s["client"]] += 1
        for f in s["families"]:
            fam_tests[f] += 1
        fam_tests["other"] += s["other"]
    dept_tests: Counter = Counter()
    for f, n in fam_tests.items():
        dept_tests[DEPARTMENT_OF_FAMILY[f]] += n
    return {
        "clients": [
            {"name": name, "samples": n} for name, n in sorted(clients.items(), key=lambda kv: (-kv[1], kv[0].casefold()))
        ],
        "departments": [{"key": k, "name": name, "tests": dept_tests.get(k, 0)} for k, name in DEPARTMENTS],
        "families": [
            {"key": f, "name": FAMILY_NAMES[f], "department": DEPARTMENT_OF_FAMILY[f], "tests": fam_tests.get(f, 0)}
            for f in ALL_FAMILIES
        ],
    }
