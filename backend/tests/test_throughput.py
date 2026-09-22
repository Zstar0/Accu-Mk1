"""Unit tests for the pure lab-throughput engine (backend/throughput.py).

The engine takes already-fetched rows (plain dataclasses) and returns the
/reports/throughput payload. No DB, no FastAPI — mirrors sla_engine.py.
"""
from __future__ import annotations

from datetime import date, datetime

import pytest

from throughput import (
    AnalysisIn,
    BenchIn,
    CoaIn,
    LabCalendar,
    SampleIn,
    bench_sample_id,
    build_throughput,
    classify_keyword,
    lab_day,
)

LA = "America/Los_Angeles"
WEEKDAYS = frozenset({0, 1, 2, 3, 4})


def cal(holidays=()):
    return LabCalendar(tz=LA, working_days=WEEKDAYS, holidays=frozenset(holidays))


def sample(pk, sid, received, status="sample_received", client="acme", retest=False, order=None):
    return SampleIn(
        pk=pk,
        sample_id=sid,
        date_received=received,
        status=status,
        client=client,
        is_retest=retest,
        order=order,
    )


def build(**kw):
    defaults = dict(
        samples=[],
        analyses=[],
        vial_counts={},
        coas=[],
        bench=[],
        instruments={},
        service_categories={},
        calendar=cal(),
        start=date(2026, 7, 1),
        today=date(2026, 7, 7),
        excluded_sample_ids=frozenset(),
    )
    defaults.update(kw)
    return build_throughput(**defaults)


def day(result, iso):
    return next(d for d in result["days"] if d["d"] == iso)


# ---------------------------------------------------------------- classify


@pytest.mark.parametrize(
    "keyword,category,expected",
    [
        ("STER-PCR", None, "ster"),
        ("ENDO-LAL", None, "endo"),
        ("BPC157-PURITY", "HPLC", "hplc"),
        ("X", "Peptide Identity", "hplc"),
        ("X", "Peptide Analysis", "hplc"),
        ("HPLC-PUR", None, "hplc"),
        ("PEPT-Total", None, "hplc"),
        ("BLEND-PUR", None, "hplc"),
        ("PUR_BPC157", None, "hplc"),
        ("QTY_BPC157", None, "hplc"),
        ("ID_BPC157", None, "hplc"),
        ("ANALYTE-1", None, "hplc"),
        ("Benzyl_Alcohol_Assay", None, "bacw"),
        ("PH-DETERM", None, "bacw"),
        ("FILL-NET-CONTENT", None, "bacw"),
        ("KF", "Chemistry", "other"),
        # catalog-arc keyword forms (live in prod since 2026-09-01)
        ("STERILITY-PCR", "Sterility", "ster"),
        ("STERILITY-USP71", "Sterility", "ster"),
        ("ENDOTOXIN-USP85LAL", "Toxicology", "endo"),
        ("ENDOTOXIN-USP85LAL", None, "endo"),
        ("LEAD-PPM", "Heavy Metals", "hm"),
        ("CADMIUM-PPM", None, "hm"),
        ("MECURY-PPM", None, "hm"),  # prod typo, keyword-classified on purpose
        ("ARSENIC-PPM", None, "hm"),
        ("MOISTURE-KF", "Moisture", "other"),
        ("FENTANYL", None, "other"),
        ("HPLC-IDENTITY", None, "hplc"),
        ("HPLC-PURITY", None, "hplc"),
        ("HPLC-BLEND-TOTAL", None, "hplc"),
    ],
)
def test_classify_keyword(keyword, category, expected):
    assert classify_keyword(keyword, category) == expected


def test_heavy_metals_panel_counts_once_per_sample():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0))],
        analyses=[
            AnalysisIn(1, "LEAD-PPM"),
            AnalysisIn(1, "CADMIUM-PPM"),
            AnalysisIn(1, "MECURY-PPM"),
            AnalysisIn(1, "ARSENIC-PPM"),
            AnalysisIn(1, "HPLC-PUR"),
        ],
    )
    d = day(r, "2026-07-01")
    assert d["hm"] == 1 and d["hplc"] == 1 and d["other"] == 0
    assert d["tests"] == 2


def test_new_sterility_and_endotoxin_keywords_join_their_families():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0))],
        analyses=[
            AnalysisIn(1, "STERILITY-PCR"),
            AnalysisIn(1, "STERILITY-USP71"),  # same family, still one sterility test
            AnalysisIn(1, "ENDOTOXIN-USP85LAL"),
        ],
    )
    d = day(r, "2026-07-01")
    assert (d["ster"], d["endo"], d["other"], d["tests"]) == (1, 1, 0, 2)


# ---------------------------------------------------------------- lab_day


def test_lab_day_converts_naive_utc_to_lab_timezone():
    # 02:30 UTC on 1 Jul is still 30 Jun in Los Angeles (PDT = UTC-7)
    assert lab_day(datetime(2026, 7, 1, 2, 30), LA) == date(2026, 6, 30)


def test_lab_day_none_is_none():
    assert lab_day(None, LA) is None


# ---------------------------------------------------------------- tests per sample


def test_hplc_panel_counts_once_per_sample_regardless_of_analyte_rows():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0))],
        analyses=[
            AnalysisIn(1, "HPLC-PUR"),
            AnalysisIn(1, "PUR_BPC157"),
            AnalysisIn(1, "QTY_BPC157"),
            AnalysisIn(1, "STER-PCR"),
        ],
    )
    d = day(r, "2026-07-01")
    assert (d["hplc"], d["ster"], d["endo"], d["bacw"], d["other"]) == (1, 1, 0, 0, 0)
    assert d["tests"] == 2
    assert d["samples"] == 1


def test_duplicate_sample_keyword_rows_across_provenance_count_once():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0))],
        analyses=[AnalysisIn(1, "STER-PCR"), AnalysisIn(1, "STER-PCR")],  # shadow + canonical
    )
    assert day(r, "2026-07-01")["ster"] == 1


def test_bac_water_panel_counts_once_per_sample():
    r = build(
        samples=[sample(1, "BW-1", datetime(2026, 7, 1, 18, 0))],
        analyses=[
            AnalysisIn(1, "Benzyl_Alcohol_Assay"),
            AnalysisIn(1, "PH-DETERM"),
            AnalysisIn(1, "FILL-NET-CONTENT"),
        ],
    )
    d = day(r, "2026-07-01")
    assert d["bacw"] == 1
    assert d["tests"] == 1


def test_other_family_counts_per_keyword():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0))],
        analyses=[AnalysisIn(1, "KF"), AnalysisIn(1, "MYSTERY")],
    )
    assert day(r, "2026-07-01")["other"] == 2


def test_category_lookup_drives_hplc_classification():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0))],
        analyses=[AnalysisIn(1, "BPC157-PURITY")],
        service_categories={"BPC157-PURITY": "HPLC"},
    )
    assert day(r, "2026-07-01")["hplc"] == 1


# ---------------------------------------------------------------- window & calendar


def test_series_spans_start_to_today_inclusive_with_calendar_flags():
    r = build(start=date(2026, 7, 1), today=date(2026, 7, 7), calendar=cal(holidays=[date(2026, 7, 3)]))
    assert [d["d"] for d in r["days"]] == [f"2026-07-0{i}" for i in range(1, 8)]
    fri_holiday = day(r, "2026-07-03")
    assert fri_holiday["hol"] is True and fri_holiday["biz"] is False
    sat = day(r, "2026-07-04")
    assert sat["dow"] == 5 and sat["biz"] is False and sat["hol"] is False
    mon = day(r, "2026-07-06")
    assert mon["biz"] is True


def test_samples_received_before_start_are_ignored():
    r = build(samples=[sample(1, "P-1", datetime(2026, 6, 30, 18, 0))])
    assert sum(d["samples"] for d in r["days"]) == 0


def test_receipt_day_is_bucketed_in_lab_timezone():
    # 02:00 UTC on 3 Jul == 19:00 PDT on 2 Jul
    r = build(samples=[sample(1, "P-1", datetime(2026, 7, 3, 2, 0))])
    assert day(r, "2026-07-02")["samples"] == 1
    assert day(r, "2026-07-03")["samples"] == 0


def test_excluded_sample_ids_are_dropped_everywhere():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0)), sample(2, "T-1", datetime(2026, 7, 1, 18, 0))],
        analyses=[AnalysisIn(1, "STER-PCR"), AnalysisIn(2, "STER-PCR")],
        coas=[CoaIn("T-1", datetime(2026, 7, 2, 18, 0), True)],
        bench=[BenchIn("T-1", datetime(2026, 7, 2, 18, 0), None), BenchIn("T-1-2", datetime(2026, 7, 2, 18, 0), None)],
        excluded_sample_ids=frozenset({"T-1"}),
    )
    d1 = day(r, "2026-07-01")
    assert d1["samples"] == 1 and d1["ster"] == 1
    d2 = day(r, "2026-07-02")
    assert d2["coa"] == 0 and d2["bench_vials"] == 0 and d2["bench_rows"] == 0
    assert r["backlog_now"]["total"] == 1


# ---------------------------------------------------------------- COA output


def test_primary_and_additional_coas_count_on_publish_day():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0))],
        coas=[
            CoaIn("P-1", datetime(2026, 7, 2, 18, 0), True),
            CoaIn("P-1", datetime(2026, 7, 3, 18, 0), True),  # re-issue
            CoaIn("P-1", datetime(2026, 7, 3, 19, 0), False),  # additional
        ],
    )
    d2, d3 = day(r, "2026-07-02"), day(r, "2026-07-03")
    assert (d2["coa"], d2["acoa"], d2["fp"]) == (1, 0, 1)
    assert (d3["coa"], d3["acoa"], d3["fp"]) == (1, 1, 0)


def test_first_publication_never_lands_before_receipt_day():
    # published (clock skew / migration) before the receipt day -> counted on the receipt day
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 3, 18, 0))],
        coas=[CoaIn("P-1", datetime(2026, 7, 2, 18, 0), True)],
    )
    assert day(r, "2026-07-03")["fp"] == 1
    assert day(r, "2026-07-02")["fp"] == 0


# ---------------------------------------------------------------- backlog


def test_backlog_series_rises_on_receipt_and_falls_on_first_primary_publication():
    r = build(
        samples=[
            sample(1, "P-1", datetime(2026, 7, 1, 18, 0)),
            sample(2, "P-2", datetime(2026, 7, 1, 18, 0)),
            sample(3, "P-3", datetime(2026, 7, 2, 18, 0), status="cancelled"),
        ],
        coas=[CoaIn("P-1", datetime(2026, 7, 3, 18, 0), True)],
    )
    assert [day(r, f"2026-07-0{i}")["backlog"] for i in range(1, 5)] == [2, 2, 1, 1]


def test_backlog_now_buckets_open_samples_by_age_and_status():
    r = build(
        samples=[
            sample(1, "P-1", datetime(2026, 7, 6, 18, 0)),  # 1 day old
            sample(2, "P-2", datetime(2026, 7, 1, 18, 0), status="waiting_for_addon_results"),  # 6 days
            sample(3, "P-3", datetime(2026, 7, 1, 18, 0)),  # published -> not open
            sample(4, "P-4", datetime(2026, 7, 1, 18, 0), status="cancelled"),
        ],
        coas=[CoaIn("P-3", datetime(2026, 7, 2, 18, 0), True)],
        today=date(2026, 7, 7),
    )
    assert r["backlog_now"] == {
        "total": 2,
        "status": {"sample_received": 1, "waiting_for_addon_results": 1},
        "age": {"0-2d": 1, "3-7d": 1},
    }


# ---------------------------------------------------------------- vials & bench


def test_vial_counts_and_retests_roll_into_the_receipt_day():
    r = build(
        samples=[sample(1, "P-1", datetime(2026, 7, 1, 18, 0), retest=True)],
        vial_counts={1: 4},
    )
    d = day(r, "2026-07-01")
    assert d["vials"] == 4 and d["retest"] == 1


def test_distinct_clients_per_day():
    r = build(
        samples=[
            sample(1, "P-1", datetime(2026, 7, 1, 18, 0), client="a"),
            sample(2, "P-2", datetime(2026, 7, 1, 18, 0), client="a"),
            sample(3, "P-3", datetime(2026, 7, 1, 18, 0), client="b"),
        ]
    )
    assert day(r, "2026-07-01")["clients"] == 2


def test_bench_counts_distinct_vials_per_instrument_and_all_rows():
    r = build(
        bench=[
            BenchIn("P-1", datetime(2026, 7, 1, 18, 0), 1),
            BenchIn("P-1", datetime(2026, 7, 1, 19, 0), 1),  # re-processed
            BenchIn("P-2", datetime(2026, 7, 1, 19, 0), 2),
            BenchIn("P-3", datetime(2026, 7, 1, 19, 0), None),
        ],
        instruments={1: "1290a", 2: "1290b"},
    )
    d = day(r, "2026-07-01")
    assert d["bench_rows"] == 4
    assert d["bench_vials"] == 3
    assert d["bench_inst"] == {"1290a": 1, "1290b": 1, "unassigned": 1}
    assert r["instruments"] == ["1290a", "1290b", "unassigned"]


@pytest.mark.parametrize(
    "label,expected",
    [
        ("P-0142", "P-0142"),
        ("BW-0076", "BW-0076"),
        ("P-0142-2", "P-0142"),
        ("P-0134-S01", "P-0134"),  # native vial id
        ("P-0134-S01-R01", "P-0134"),  # retest of a vial
        ("PB-0301-S12", "PB-0301"),
    ],
)
def test_bench_sample_id_strips_vial_and_retest_suffixes(label, expected):
    assert bench_sample_id(label) == expected


def test_excluded_sample_hides_its_vial_labelled_bench_rows():
    r = build(
        samples=[sample(1, "T-1", datetime(2026, 7, 1, 18, 0))],
        bench=[
            BenchIn("T-1-S01", datetime(2026, 7, 2, 18, 0), 1),
            BenchIn("T-1-S02-R01", datetime(2026, 7, 2, 18, 0), 1),
            BenchIn("P-9-S01", datetime(2026, 7, 2, 18, 0), 1),
        ],
        instruments={1: "1290a"},
        excluded_sample_ids=frozenset({"T-1"}),
    )
    d = day(r, "2026-07-02")
    assert d["bench_rows"] == 1 and d["bench_vials"] == 1
    assert d["bench_inst"] == {"1290a": 1}


def test_coa_for_a_sample_missing_from_mk1_counts_as_published_but_not_completed():
    r = build(coas=[CoaIn("GHOST-1", datetime(2026, 7, 2, 18, 0), True)])
    d = day(r, "2026-07-02")
    assert d["coa"] == 1 and d["fp"] == 0


def test_null_status_is_reported_as_unknown_in_the_backlog_snapshot():
    r = build(samples=[sample(1, "P-1", datetime(2026, 7, 6, 18, 0), status=None)])
    assert r["backlog_now"]["status"] == {"unknown": 1}


# ---------------------------------------------------------------- filters (server-side)


def _two_customers():
    """acme: P-1 (HPLC + sterility, order 3271), P-2 (HPLC). beta: B-1 (heavy metals + endotoxin)."""
    return dict(
        samples=[
            sample(1, "P-1", datetime(2026, 7, 1, 18, 0), client="Acme Peptides", order="3271"),
            sample(2, "P-2", datetime(2026, 7, 2, 18, 0), client="Acme Peptides", order="3280"),
            sample(3, "B-1", datetime(2026, 7, 2, 18, 0), client="Beta Labs", order="4001"),
        ],
        analyses=[
            AnalysisIn(1, "HPLC-PUR"),
            AnalysisIn(1, "STER-PCR"),
            AnalysisIn(2, "HPLC-PUR"),
            AnalysisIn(3, "LEAD-PPM"),
            AnalysisIn(3, "ENDO-LAL"),
        ],
        vial_counts={1: 2, 2: 1, 3: 3},
        coas=[
            CoaIn("P-1", datetime(2026, 7, 3, 18, 0), True),
            CoaIn("B-1", datetime(2026, 7, 3, 18, 0), True),
            CoaIn("GHOST", datetime(2026, 7, 3, 18, 0), True),
        ],
        bench=[
            BenchIn("P-1-S01", datetime(2026, 7, 3, 18, 0), 1),
            BenchIn("B-1-S01", datetime(2026, 7, 3, 18, 0), 1),
        ],
        instruments={1: "1290a"},
    )


def test_client_filter_is_a_case_insensitive_exact_match_on_client_title():
    r = build(**_two_customers(), client="acme peptides")
    assert sum(d["samples"] for d in r["days"]) == 2
    assert day(r, "2026-07-01")["ster"] == 1
    assert day(r, "2026-07-02")["hm"] == 0
    assert r["filters"]["client"] == "acme peptides"


def test_order_filter_matches_the_client_order_number():
    r = build(**_two_customers(), order=" 3271 ")
    assert sum(d["samples"] for d in r["days"]) == 1
    assert day(r, "2026-07-01")["vials"] == 2


def test_department_filter_counts_only_that_departments_tests_and_samples():
    r = build(**_two_customers(), departments=frozenset({"microbiology"}))
    # P-1 (sterility) and B-1 (endotoxin) have microbiology tests; P-2 does not.
    assert sum(d["samples"] for d in r["days"]) == 2
    assert sum(d["tests"] for d in r["days"]) == 2
    assert sum(d["hplc"] for d in r["days"]) == 0
    assert sum(d["hm"] for d in r["days"]) == 0
    assert day(r, "2026-07-01")["ster"] == 1 and day(r, "2026-07-02")["endo"] == 1


def test_family_filter_narrows_within_the_department():
    r = build(**_two_customers(), departments=frozenset({"microbiology"}), families=frozenset({"endo"}))
    assert sum(d["samples"] for d in r["days"]) == 1
    assert sum(d["tests"] for d in r["days"]) == 1
    assert day(r, "2026-07-02")["endo"] == 1 and day(r, "2026-07-01")["ster"] == 0


def test_scoped_filters_restrict_coas_bench_and_backlog_to_the_kept_samples():
    r = build(**_two_customers(), client="Beta Labs")
    d3 = day(r, "2026-07-03")
    assert d3["coa"] == 1 and d3["fp"] == 1  # B-1 only; P-1 and GHOST dropped
    assert d3["bench_vials"] == 1 and d3["bench_inst"] == {"1290a": 1}
    assert r["backlog_now"]["total"] == 0  # B-1 published
    unfiltered = build(**_two_customers())
    assert day(unfiltered, "2026-07-03")["coa"] == 3  # GHOST still counts when nothing is scoped


def test_facets_are_computed_before_client_order_and_department_filters():
    r = build(**_two_customers(), client="Beta Labs", departments=frozenset({"heavy_metals"}))
    f = r["facets"]
    assert f["clients"] == [{"name": "Acme Peptides", "samples": 2}, {"name": "Beta Labs", "samples": 1}]
    assert [d["key"] for d in f["departments"]] == ["analytical", "microbiology", "heavy_metals"]
    by_key = {d["key"]: d for d in f["departments"]}
    assert by_key["analytical"] == {"key": "analytical", "name": "Analytical", "tests": 2}
    assert by_key["microbiology"]["tests"] == 2 and by_key["heavy_metals"]["tests"] == 1
    fam = {x["key"]: x for x in f["families"]}
    assert fam["ster"] == {"key": "ster", "name": "Sterility", "department": "microbiology", "tests": 1}
    assert fam["other"]["department"] == "analytical" and fam["other"]["tests"] == 0


def test_facets_honour_the_test_order_exclusion():
    r = build(**_two_customers(), excluded_sample_ids=frozenset({"B-1"}))
    assert [c["name"] for c in r["facets"]["clients"]] == ["Acme Peptides"]


def test_filters_echo_defaults_when_nothing_is_scoped():
    r = build(**_two_customers())
    assert r["filters"] == {"client": None, "order": None, "departments": [], "families": []}


# ---------------------------------------------------------------- envelope


def test_envelope_carries_window_calendar_and_notes():
    r = build(calendar=cal(holidays=[date(2026, 7, 3), date(2026, 1, 1)]))
    assert r["start"] == "2026-07-01" and r["today"] == "2026-07-07" and r["tz"] == LA
    assert r["holidays"] == ["2026-07-03"]  # only holidays inside the window
    assert r["notes"] == {"jan_excluded": True, "vials_from": "2026-06", "bench_from": "2026-03"}
