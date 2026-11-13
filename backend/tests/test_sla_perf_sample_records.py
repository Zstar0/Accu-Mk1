"""sample_records is the extracted loop: build_sla_performance output must not change."""
import inspect

import sla_perf


def test_sample_records_exists_and_build_uses_it() -> None:
    assert hasattr(sla_perf, "sample_records")
    params = inspect.signature(sla_perf.sample_records).parameters
    assert {"samples", "analyses", "coas", "tiers", "groups", "schedule", "holidays", "now"} <= set(params)
    assert "sample_records(" in inspect.getsource(sla_perf.build_sla_performance)


def test_family_bh_is_business_hours_to_each_family_verification() -> None:
    from datetime import datetime, time

    from sla_engine import BusinessSchedule
    from sla_perf import AnalysisIn, CoaIn, SampleIn, TierIn

    sched = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0), timezone="UTC",
                             working_days=frozenset({0, 1, 2, 3, 4}))
    recv = datetime(2026, 9, 7, 9, 0)  # Monday 09:00
    (r,) = sla_perf.sample_records(
        samples=[SampleIn(pk=1, sample_id="P-1", date_received=recv, status="published", client="A", order="WP-1")],
        analyses=[AnalysisIn(sample_pk=1, keyword="HPLC-PUR", category="HPLC", verified_at=datetime(2026, 9, 7, 13, 0),
                             service_id=10),
                  AnalysisIn(sample_pk=1, keyword="ENDO-LAL", category=None, verified_at=datetime(2026, 9, 8, 11, 0),
                             service_id=92)],
        coas=[CoaIn(sample_id="P-1", published_at=datetime(2026, 9, 8, 15, 0), is_primary=True)],
        tiers=[TierIn(id=1, name="Standard", target_minutes=1440, is_default=True)],
        groups=[], schedule=sched, holidays=frozenset(), now=datetime(2026, 9, 9, 12, 0),
    )
    assert r["family_bh"] == {"hplc": 4.0, "endo": 10.0}
    assert r["bh"] == 14.0  # received -> published; bench (10) + lag (4) add up
