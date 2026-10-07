"""sample_records is the extracted loop: build_sla_performance output must not change."""
import inspect

import sla_perf


def test_sample_records_exists_and_build_uses_it() -> None:
    assert hasattr(sla_perf, "sample_records")
    params = inspect.signature(sla_perf.sample_records).parameters
    assert {"samples", "analyses", "coas", "tiers", "groups", "schedule", "holidays", "now"} <= set(params)
    assert "sample_records(" in inspect.getsource(sla_perf.build_sla_performance)
