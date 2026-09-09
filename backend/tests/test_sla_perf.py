"""Tests for the pure SLA performance engine (``backend/sla_perf.py``)."""
from datetime import date, datetime, time, timedelta

import pytest

from sla_perf import (
    AnalysisIn,
    CoaIn,
    GroupIn,
    SampleIn,
    TierIn,
    build_sla_performance,
    gating_family,
)
from sla_engine import BusinessSchedule

TZ = "America/Los_Angeles"
SCHEDULE = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0), timezone=TZ,
                            working_days=frozenset({0, 1, 2, 3, 4}))
HOLIDAYS: frozenset = frozenset()
NOW = datetime(2026, 9, 9, 18, 0)  # Wed, 11:00 lab time

STANDARD = TierIn(id=1, name="Standard", target_minutes=1440, is_default=True)
MICRO = TierIn(id=2, name="Microbiology", target_minutes=1440, is_default=False)
USP71 = TierIn(id=3, name="USP71", target_minutes=6720, is_default=False)
# Mirrors prod: only Microbiology carries a tier, and it holds three services.
MICRO_GROUP = GroupIn(id=2, name="Microbiology", sla_tier_id=2, service_ids=frozenset({91, 92, 93}))
CORE_GROUP = GroupIn(id=1, name="Core HPLC", sla_tier_id=None, service_ids=frozenset())


def sample(pk, sid, received, status="published", client="Acme", order="WP-1"):
    return SampleIn(pk=pk, sample_id=sid, date_received=received, status=status,
                    client=client, order=order)


def hplc(pk, verified=None, service_id=10):
    return AnalysisIn(sample_pk=pk, keyword="HPLC-PUR", category="HPLC",
                      verified_at=verified, service_id=service_id)


def ster(pk, verified=None, service_id=91):
    return AnalysisIn(sample_pk=pk, keyword="STER-PCR", category="Sterility",
                      verified_at=verified, service_id=service_id)


def endo(pk, verified=None, service_id=92):
    return AnalysisIn(sample_pk=pk, keyword="ENDO-LAL", category=None,
                      verified_at=verified, service_id=service_id)


def coa(sid, published, primary=True):
    return CoaIn(sample_id=sid, published_at=published, is_primary=primary)


def build(**over):
    kwargs = dict(samples=[], analyses=[], coas=[], tiers=[STANDARD, MICRO, USP71],
                  groups=[CORE_GROUP, MICRO_GROUP], schedule=SCHEDULE, holidays=HOLIDAYS, now=NOW)
    kwargs.update(over)
    return build_sla_performance(**kwargs)


# ── envelope ────────────────────────────────────────────────────────────────
def test_envelope_carries_the_default_target_and_the_lab_calendar():
    out = build()
    assert out["target_bh"] == 24.0
    assert out["tz"] == TZ
    assert out["today"] == "2026-09-09"
    assert out["start"] == "2026-02-01"


def test_january_samples_never_enter_the_report():
    out = build(samples=[sample(1, "P-1", datetime(2026, 1, 30, 17, 0))])
    assert out["totals"]["samples"] == 0


# ── elapsed + on time ───────────────────────────────────────────────────────
def test_elapsed_counts_business_hours_from_receipt_to_first_primary_coa():
    # Mon 09:00 lab (17:00Z) -> Tue 13:00 lab = 8 + 4 = 12 business hours.
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s], analyses=[hplc(1)],
                coas=[coa("P-1", datetime(2026, 7, 7, 20, 0))])
    m = out["months"][0]
    assert m["delivered"] == 1
    assert m["med"] == 12.0
    assert m["ontime"] == 1


def test_a_breach_is_strictly_over_target_not_equal_to_it():
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))  # Mon 09:00 lab
    # Wed 17:00 lab is exactly 24 business hours later (8 + 8 + 8), and sitting
    # on the limit is not a breach.
    at_target = build(samples=[s], analyses=[hplc(1)],
                      coas=[coa("P-1", datetime(2026, 7, 9, 0, 0))])
    assert at_target["months"][0]["late"] == 0
    # An hour past close is still 24: the clock only runs inside the window.
    after_close = build(samples=[s], analyses=[hplc(1)],
                        coas=[coa("P-1", datetime(2026, 7, 9, 1, 0))])
    assert after_close["months"][0]["late"] == 0
    # Thu 10:00 lab is the first hour that actually counts.
    over = build(samples=[s], analyses=[hplc(1)],
                 coas=[coa("P-1", datetime(2026, 7, 9, 17, 0))])
    assert over["months"][0]["late"] == 1


def test_the_earliest_primary_coa_wins_and_additional_coas_are_ignored():
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s], analyses=[hplc(1)], coas=[
        coa("P-1", datetime(2026, 7, 8, 20, 0)),                 # re-issue
        coa("P-1", datetime(2026, 7, 7, 20, 0)),                 # first primary
        coa("P-1", datetime(2026, 7, 6, 18, 0), primary=False),  # branded ACOA
    ])
    assert out["months"][0]["med"] == 12.0


def test_an_unpublished_sample_is_open_and_its_clock_runs_to_now():
    out = build(samples=[sample(1, "P-1", datetime(2026, 9, 8, 16, 0), status="sample_received")],
                analyses=[hplc(1)])
    assert out["totals"]["open"] == 1
    assert out["totals"]["delivered"] == 0
    # Tue 09:00 lab -> Wed 11:00 lab = 8 + 2.
    assert out["at_risk"]["rows"][0]["bh"] == 10.0


def test_cancelled_samples_are_counted_but_never_scored():
    out = build(samples=[sample(1, "P-1", datetime(2026, 7, 6, 16, 0), status="cancelled")],
                analyses=[hplc(1)])
    assert out["totals"]["cancelled"] == 1
    assert out["totals"]["open"] == 0
    assert out["months"] == []


def test_excluded_sample_ids_drop_out_entirely():
    out = build(samples=[sample(1, "P-1", datetime(2026, 7, 6, 16, 0)),
                         sample(2, "P-2", datetime(2026, 7, 6, 16, 0))],
                analyses=[hplc(1), hplc(2)],
                coas=[coa("P-1", datetime(2026, 7, 7, 20, 0)),
                      coa("P-2", datetime(2026, 7, 7, 20, 0))],
                excluded_sample_ids=frozenset({"P-2"}))
    assert out["totals"]["samples"] == 1


# ── target resolution ───────────────────────────────────────────────────────
def test_a_sample_with_no_tiered_service_takes_the_default_tier():
    out = build(samples=[sample(1, "P-1", datetime(2026, 7, 6, 16, 0))], analyses=[hplc(1)],
                coas=[coa("P-1", datetime(2026, 7, 7, 20, 0))])
    assert out["targets"] == [{"name": "Standard", "bh": 24.0, "samples": 1}]


def test_a_sample_touching_a_tiered_group_takes_that_groups_tier():
    micro = GroupIn(id=2, name="Microbiology", sla_tier_id=3, service_ids=frozenset({91}))
    out = build(samples=[sample(1, "P-1", datetime(2026, 7, 6, 16, 0))],
                analyses=[hplc(1), ster(1)],
                coas=[coa("P-1", datetime(2026, 7, 7, 20, 0))],
                groups=[CORE_GROUP, micro])
    assert out["targets"] == [{"name": "USP71", "bh": 112.0, "samples": 1}]


def test_a_longer_group_target_keeps_a_slow_sample_inside_its_sla():
    """The USP71 wiring gap made visible: 40 bh is late at 24, on time at 112."""
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    coas = [coa("P-1", datetime(2026, 7, 13, 0, 0))]  # 40 business hours
    untiered = build(samples=[s], analyses=[hplc(1), ster(1)], coas=coas,
                     groups=[CORE_GROUP, GroupIn(id=2, name="Microbiology", sla_tier_id=2,
                                                 service_ids=frozenset({91}))])
    assert untiered["months"][0]["late"] == 1
    tiered = build(samples=[s], analyses=[hplc(1), ster(1)], coas=coas,
                   groups=[CORE_GROUP, GroupIn(id=2, name="Microbiology", sla_tier_id=3,
                                               service_ids=frozenset({91}))])
    assert tiered["months"][0]["late"] == 0


# ── receipt cohorts ─────────────────────────────────────────────────────────
def test_cohorts_group_by_receipt_month_and_count_open_work_against_the_rate():
    samples = [sample(1, "P-1", datetime(2026, 7, 6, 16, 0)),
               sample(2, "P-2", datetime(2026, 7, 6, 16, 0)),
               sample(3, "P-3", datetime(2026, 7, 7, 16, 0), status="sample_received")]
    out = build(samples=samples, analyses=[hplc(1), hplc(2), hplc(3)],
                coas=[coa("P-1", datetime(2026, 7, 7, 20, 0)),                 # on time
                      coa("P-2", datetime(2026, 7, 20, 20, 0))])               # late
    m = out["months"][0]
    assert (m["received"], m["delivered"], m["open"]) == (3, 2, 1)
    assert (m["ontime"], m["late"]) == (1, 1)
    assert m["rate_delivered"] == 50.0   # ignores the open sample
    assert m["rate_received"] == 33.3    # counts it against us
    assert m["open_late"] == 1


def test_a_cohort_month_is_labelled_for_display():
    out = build(samples=[sample(1, "P-1", datetime(2026, 7, 6, 16, 0))], analyses=[hplc(1)],
                coas=[coa("P-1", datetime(2026, 7, 7, 20, 0))])
    assert out["months"][0]["m"] == "2026-07"
    assert out["months"][0]["label"] == "Jul 2026"


# ── delivery curve ──────────────────────────────────────────────────────────
def test_the_curve_is_cumulative_and_reports_the_share_inside_target():
    samples, analyses, coas = [], [], []
    # Four samples at 4, 12, 20 and 40 business hours from Mon 09:00 lab.
    for i, hours in enumerate([4, 12, 20, 40], start=1):
        received = datetime(2026, 7, 6, 16, 0)
        samples.append(sample(i, "P-%d" % i, received))
        analyses.append(hplc(i))
        day, rem = divmod(hours, 8)
        pub = datetime(2026, 7, 6 + day, 16, 0) + timedelta(hours=rem)
        # skip the weekend for the 40 bh case
        if hours == 40:
            pub = datetime(2026, 7, 13, 0, 0)
        coas.append(coa("P-%d" % i, pub))
    out = build(samples=samples, analyses=analyses, coas=coas)
    curve = out["curve"]["all"]
    assert curve[0]["bh"] == 4
    assert [c["cum_pct"] for c in curve][-1] == 100.0
    assert out["curve"]["within_target"] == 75.0  # three of four inside 24 bh


# ── gating: which department finished last ──────────────────────────────────
def test_gating_family_is_the_one_verified_last():
    assert gating_family({"hplc": datetime(2026, 7, 6), "ster": datetime(2026, 7, 8)}) == "ster"
    assert gating_family({"hplc": datetime(2026, 7, 9), "ster": datetime(2026, 7, 8)}) == "hplc"


def test_gating_needs_two_families_so_a_single_test_sample_is_not_counted():
    assert gating_family({"hplc": datetime(2026, 7, 6)}) is None
    assert gating_family({}) is None


def test_the_family_finishing_last_is_credited_with_holding_the_late_sample():
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s],
                analyses=[hplc(1, verified=datetime(2026, 7, 7, 20, 0)),
                          ster(1, verified=datetime(2026, 7, 20, 18, 0))],
                coas=[coa("P-1", datetime(2026, 7, 20, 20, 0))])  # late
    trend = out["gating"]["trend"][0]
    assert trend["late_total"] == 1
    assert trend["ster_gate_late"] == 1
    assert trend["hplc_gate_late"] == 0
    assert out["gating"]["late_mixed"] == 1


def test_a_family_row_reports_its_own_receipt_to_verified_timing():
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s],
                analyses=[hplc(1, verified=datetime(2026, 7, 7, 20, 0)),    # 12 bh
                          ster(1, verified=datetime(2026, 7, 8, 20, 0))],   # 20 bh
                coas=[coa("P-1", datetime(2026, 7, 9, 0, 0))])
    rows = {r["k"]: r for r in out["gating"]["families"]}
    assert rows["hplc"]["med"] == 12.0
    assert rows["ster"]["med"] == 20.0
    assert rows["ster"]["over_target"] == 0


def test_the_verified_timestamps_are_de_duplicated_across_provenance():
    """Shadow rows carry no verified_at; the canonical row must win, not None."""
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s],
                analyses=[hplc(1, verified=None),                            # shadow
                          hplc(1, verified=datetime(2026, 7, 7, 20, 0)),     # canonical
                          ster(1, verified=datetime(2026, 7, 8, 20, 0))],
                coas=[coa("P-1", datetime(2026, 7, 9, 0, 0))])
    rows = {r["k"]: r for r in out["gating"]["families"]}
    assert rows["hplc"]["med"] == 12.0


def test_the_micro_wait_is_the_time_a_sample_waits_after_hplc_is_done():
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s],
                analyses=[hplc(1, verified=datetime(2026, 7, 7, 20, 0)),    # 12 bh
                          endo(1, verified=datetime(2026, 7, 8, 20, 0))],   # 20 bh
                coas=[coa("P-1", datetime(2026, 7, 9, 0, 0))])
    assert out["gating"]["wait_med"] == 8.0
    assert out["gating"]["wait_n"] == 1


def test_no_micro_wait_when_microbiology_finished_before_the_hplc_panel():
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s],
                analyses=[hplc(1, verified=datetime(2026, 7, 8, 20, 0)),
                          endo(1, verified=datetime(2026, 7, 7, 20, 0))],
                coas=[coa("P-1", datetime(2026, 7, 9, 0, 0))])
    assert out["gating"]["wait_n"] == 0


# ── stages ──────────────────────────────────────────────────────────────────
def test_stages_split_bench_time_from_the_publishing_handoff():
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s],
                analyses=[hplc(1, verified=datetime(2026, 7, 7, 20, 0))],   # 12 bh bench
                coas=[coa("P-1", datetime(2026, 7, 7, 22, 0))])             # +2 bh lag
    st = out["stages"]
    assert (st["bench_med"], st["lag_med"]) == (12.0, 2.0)
    assert st["n"] == 1


def test_a_coa_published_before_the_last_verification_reports_no_negative_lag():
    s = sample(1, "P-1", datetime(2026, 7, 6, 16, 0))
    out = build(samples=[s],
                analyses=[hplc(1, verified=datetime(2026, 7, 8, 20, 0))],
                coas=[coa("P-1", datetime(2026, 7, 7, 20, 0))])
    assert out["stages"]["lag_med"] == 0.0


def test_samples_with_no_verified_timestamp_are_outside_the_stage_coverage():
    samples = [sample(1, "P-1", datetime(2026, 7, 6, 16, 0)),
               sample(2, "P-2", datetime(2026, 7, 6, 16, 0))]
    out = build(samples=samples,
                analyses=[hplc(1, verified=datetime(2026, 7, 7, 20, 0)), hplc(2)],
                coas=[coa("P-1", datetime(2026, 7, 7, 22, 0)),
                      coa("P-2", datetime(2026, 7, 7, 22, 0))])
    assert out["stages"]["n"] == 1
    assert out["stages"]["coverage"] == 50.0


# ── at-risk board ───────────────────────────────────────────────────────────
def test_open_work_is_bucketed_by_business_hours_left_before_target():
    samples = [sample(1, "P-old", datetime(2026, 8, 3, 16, 0), status="sample_received"),
               sample(2, "P-new", datetime(2026, 9, 9, 16, 0), status="sample_received")]
    out = build(samples=samples, analyses=[hplc(1), hplc(2)])
    buckets = {b["label"]: b["n"] for b in out["at_risk"]["buckets"]}
    assert buckets["Already past target"] == 1
    assert out["at_risk"]["total"] == 2
    assert out["at_risk"]["status"]["sample_received"] == 2


def test_the_at_risk_list_is_worst_first_and_says_how_far_past_target():
    samples = [sample(1, "P-old", datetime(2026, 8, 3, 16, 0), status="sample_received"),
               sample(2, "P-new", datetime(2026, 9, 9, 16, 0), status="sample_received")]
    out = build(samples=samples, analyses=[hplc(1), hplc(2)])
    rows = out["at_risk"]["rows"]
    assert [r["sid"] for r in rows] == ["P-old", "P-new"]
    assert rows[0]["over"] > 0 and rows[1]["over"] < 0


# ── filters + facets ────────────────────────────────────────────────────────
def _two_clients():
    return dict(
        samples=[sample(1, "P-1", datetime(2026, 7, 6, 16, 0), client="Acme", order="WP-1"),
                 sample(2, "P-2", datetime(2026, 7, 6, 16, 0), client="Beta", order="WP-2")],
        analyses=[hplc(1), hplc(2), ster(2)],
        coas=[coa("P-1", datetime(2026, 7, 7, 20, 0)),
              coa("P-2", datetime(2026, 7, 7, 20, 0))],
    )


def test_the_client_filter_scopes_the_report_to_one_customer():
    out = build(**_two_clients(), client="Beta")
    assert out["totals"]["samples"] == 1
    assert out["filters"]["client"] == "Beta"


def test_the_order_filter_matches_on_a_substring_of_the_order_number():
    out = build(**_two_clients(), order="wp-2")
    assert out["totals"]["samples"] == 1


def test_the_department_filter_keeps_only_samples_carrying_that_department():
    out = build(**_two_clients(), departments=["microbiology"])
    assert out["totals"]["samples"] == 1


def test_facets_are_computed_before_scoping_so_the_chips_never_empty_themselves():
    out = build(**_two_clients(), client="Beta")
    assert [c["name"] for c in out["facets"]["clients"]] == ["Acme", "Beta"]
    micro = next(d for d in out["facets"]["departments"] if d["key"] == "microbiology")
    assert micro["samples"] == 1


def test_an_unknown_department_key_is_rejected():
    with pytest.raises(ValueError):
        build(departments=["nope"])


# ── KPI windows ─────────────────────────────────────────────────────────────
def test_the_kpi_windows_compare_the_last_thirty_delivered_days_with_the_prior_thirty():
    samples, analyses, coas = [], [], []
    # One on-time sample published 10 days ago, one late sample published 45 days ago.
    for i, (recv, pub) in enumerate([
        (datetime(2026, 8, 28, 16, 0), datetime(2026, 8, 31, 20, 0)),
        (datetime(2026, 7, 20, 16, 0), datetime(2026, 8, 3, 20, 0)),
    ], start=1):
        samples.append(sample(i, "P-%d" % i, recv))
        analyses.append(hplc(i))
        coas.append(coa("P-%d" % i, pub))
    out = build(samples=samples, analyses=analyses, coas=coas)
    assert out["kpi"]["last30"]["n"] == 1
    assert out["kpi"]["prev30"]["n"] == 1


def test_an_empty_window_reports_zeroes_rather_than_missing_keys():
    out = build()
    for key in ("n", "rate", "med", "p90", "ontime", "late"):
        assert out["kpi"]["last30"][key] == 0
