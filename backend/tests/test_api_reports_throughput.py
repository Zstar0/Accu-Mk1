"""Tests for GET /reports/throughput.

The route is guarded by get_current_user (JWT). It loads Mk1 rows through
`_load_throughput_inputs(db)` and Integration Service COA rows through
`_fetch_throughput_coas()`, then delegates to the pure engine in throughput.py.
Both loaders are patched here (via monkeypatch, so a failing test cannot leak
the patch into later tests) so the route logic (auth, test-order exclusion,
from/to slicing, 503 on IS failure) is exercised without a database; the ORM
loader itself is covered separately against an in-memory SQLite session.
"""
from datetime import date, datetime, timezone
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

import main as main_module
from auth import get_current_user
from database import get_db
from main import app
from throughput import AnalysisIn, BenchIn, CoaIn, LabCalendar, SampleIn

client = TestClient(app)

LA = "America/Los_Angeles"


def _inputs(samples, analyses=(), bench=()):
    return {
        "samples": list(samples),
        "analyses": list(analyses),
        "vial_counts": {},
        "bench": list(bench),
        "instruments": {1: "1290a"},
        "service_categories": {},
        "calendar": LabCalendar(tz=LA, working_days=frozenset({0, 1, 2, 3, 4}), holidays=frozenset()),
    }


def _use(monkeypatch, inputs, coas=(), test_ids=frozenset(), fetch=None):
    def _fake_db():
        yield MagicMock()

    monkeypatch.setitem(app.dependency_overrides, get_current_user, lambda: MagicMock(id=1, email="lab@x"))
    monkeypatch.setitem(app.dependency_overrides, get_db, _fake_db)
    monkeypatch.setattr(main_module, "_load_throughput_inputs", lambda db: inputs)
    monkeypatch.setattr(main_module, "_fetch_throughput_coas", fetch or (lambda: list(coas)))
    monkeypatch.setattr(main_module, "_test_order_senaite_ids", lambda: set(test_ids))
    # Every test starts with a cold row cache so cached rows from one test never leak into the next.
    monkeypatch.setattr(main_module, "_throughput_rows_cache", {})


def _sample(pk, sid, received, status="sample_received"):
    return SampleIn(pk=pk, sample_id=sid, date_received=received, status=status, client="acme")


def _today_la():
    return datetime.now(timezone.utc).astimezone(ZoneInfo(LA)).date()


def test_requires_auth():
    resp = client.get("/reports/throughput")
    assert resp.status_code == 401


def test_returns_envelope_with_days_and_backlog(monkeypatch):
    _use(
        monkeypatch,
        _inputs(
            samples=[_sample(1, "P-1", datetime(2026, 7, 1, 18, 0)), _sample(2, "P-2", datetime(2026, 7, 1, 18, 0))],
            analyses=[AnalysisIn(1, "STER-PCR"), AnalysisIn(2, "HPLC-PUR")],
            bench=[BenchIn("P-1", datetime(2026, 7, 2, 18, 0), 1)],
        ),
        coas=[CoaIn("P-1", datetime(2026, 7, 2, 18, 0), True)],
    )
    resp = client.get("/reports/throughput")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tz"] == LA
    assert body["start"] == "2026-02-01"
    assert body["today"] == _today_la().isoformat()
    assert body["generated_at"].endswith("Z")
    assert body["instruments"] == ["1290a"]
    day = {d["d"]: d for d in body["days"]}
    assert day["2026-07-01"]["samples"] == 2
    assert day["2026-07-01"]["ster"] == 1 and day["2026-07-01"]["hplc"] == 1
    assert day["2026-07-02"]["coa"] == 1 and day["2026-07-02"]["fp"] == 1
    assert day["2026-07-02"]["bench_inst"] == {"1290a": 1}
    assert body["backlog_now"]["total"] == 1
    assert body["notes"]["jan_excluded"] is True


def test_test_orders_excluded_by_default_and_included_on_request(monkeypatch):
    inputs = _inputs(samples=[_sample(1, "P-1", datetime(2026, 7, 1, 18, 0)), _sample(2, "T-1", datetime(2026, 7, 1, 18, 0))])
    _use(monkeypatch, inputs, test_ids={"T-1"})
    default = client.get("/reports/throughput")
    included = client.get("/reports/throughput", params={"include_test_orders": "true"})
    assert default.status_code == 200 and included.status_code == 200
    d_default = {d["d"]: d for d in default.json()["days"]}["2026-07-01"]
    d_incl = {d["d"]: d for d in included.json()["days"]}["2026-07-01"]
    assert d_default["samples"] == 1
    assert d_incl["samples"] == 2


def test_from_to_slice_the_series_but_keep_the_carried_backlog(monkeypatch):
    _use(monkeypatch, _inputs(samples=[_sample(1, "P-1", datetime(2026, 7, 1, 18, 0))]))
    resp = client.get("/reports/throughput", params={"from": "2026-07-05", "to": "2026-07-06"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [d["d"] for d in body["days"]] == ["2026-07-05", "2026-07-06"]
    assert body["days"][0]["backlog"] == 1  # received on 1 Jul, still open
    assert body["start"] == "2026-07-05" and body["end"] == "2026-07-06"


def test_integration_db_failure_is_503(monkeypatch):
    def _boom():
        raise RuntimeError("no IS")

    _use(monkeypatch, _inputs(samples=[]), fetch=_boom)
    resp = client.get("/reports/throughput")
    assert resp.status_code == 503
    assert "Reports database error" in resp.json()["detail"]


# ---------------------------------------------------------------- filters + facets + row cache


def _customers():
    return _inputs(
        samples=[
            SampleIn(pk=1, sample_id="P-1", date_received=datetime(2026, 7, 1, 18, 0), status="sample_received", client="Acme Peptides", order="3271"),
            SampleIn(pk=2, sample_id="B-1", date_received=datetime(2026, 7, 2, 18, 0), status="sample_received", client="Beta Labs", order="4001"),
        ],
        analyses=[AnalysisIn(1, "STER-PCR"), AnalysisIn(2, "LEAD-PPM")],
    )


def test_client_order_department_and_family_params_reach_the_engine(monkeypatch):
    _use(monkeypatch, _customers())
    by_client = client.get("/reports/throughput", params={"client": "Beta Labs"}).json()
    assert sum(d["samples"] for d in by_client["days"]) == 1
    assert by_client["filters"]["client"] == "Beta Labs"

    by_order = client.get("/reports/throughput", params={"order": "3271"}).json()
    assert sum(d["samples"] for d in by_order["days"]) == 1

    by_dept = client.get("/reports/throughput", params=[("department", "microbiology"), ("department", "heavy_metals")]).json()
    assert by_dept["filters"]["departments"] == ["microbiology", "heavy_metals"]
    assert sum(d["tests"] for d in by_dept["days"]) == 2

    by_family = client.get("/reports/throughput", params={"department": "microbiology", "family": "ster"}).json()
    assert by_family["filters"]["families"] == ["ster"]
    assert sum(d["samples"] for d in by_family["days"]) == 1


def test_unknown_department_or_family_is_a_422(monkeypatch):
    _use(monkeypatch, _customers())
    assert client.get("/reports/throughput", params={"department": "plumbing"}).status_code == 422
    assert client.get("/reports/throughput", params={"family": "plumbing"}).status_code == 422


def test_facets_ride_in_the_response_and_ignore_the_active_filters(monkeypatch):
    _use(monkeypatch, _customers())
    body = client.get("/reports/throughput", params={"client": "Beta Labs"}).json()
    assert [c["name"] for c in body["facets"]["clients"]] == ["Acme Peptides", "Beta Labs"]
    assert [d["key"] for d in body["facets"]["departments"]] == ["analytical", "microbiology", "heavy_metals"]
    assert any(f["key"] == "hm" and f["tests"] == 1 for f in body["facets"]["families"])


def test_rows_are_fetched_once_per_ttl_window_across_filter_changes(monkeypatch):
    calls = {"inputs": 0, "coas": 0, "ids": 0}
    inputs = _customers()

    def _load(db):
        calls["inputs"] += 1
        return inputs

    def _coas():
        calls["coas"] += 1
        return []

    def _ids():
        calls["ids"] += 1
        return set()

    _use(monkeypatch, inputs)
    monkeypatch.setattr(main_module, "_load_throughput_inputs", _load)
    monkeypatch.setattr(main_module, "_fetch_throughput_coas", _coas)
    monkeypatch.setattr(main_module, "_test_order_senaite_ids", _ids)

    assert client.get("/reports/throughput").status_code == 200
    assert client.get("/reports/throughput", params={"client": "Beta Labs"}).status_code == 200
    assert client.get("/reports/throughput", params={"include_test_orders": "true"}).status_code == 200
    assert calls == {"inputs": 1, "coas": 1, "ids": 1}

    # Past the TTL the next request refreshes every source.
    monkeypatch.setattr(main_module, "_THROUGHPUT_CACHE_TTL_SECONDS", 0)
    assert client.get("/reports/throughput").status_code == 200
    assert calls == {"inputs": 2, "coas": 2, "ids": 2}


def test_integration_db_failure_after_a_warm_cache_still_serves_the_cached_rows(monkeypatch):
    _use(monkeypatch, _customers())
    assert client.get("/reports/throughput").status_code == 200

    def _boom():
        raise RuntimeError("no IS")

    monkeypatch.setattr(main_module, "_fetch_throughput_coas", _boom)
    monkeypatch.setattr(main_module, "_THROUGHPUT_CACHE_TTL_SECONDS", 0)
    resp = client.get("/reports/throughput")
    assert resp.status_code == 200
    assert resp.json()["cache"]["stale"] is True


# ---------------------------------------------------------------- ORM loader


def test_load_throughput_inputs_reads_the_orm_tables(db_session):
    from models import (
        AnalysisService,
        BusinessHoursConfig,
        HPLCAnalysis,
        Instrument,
        LabHoliday,
        LimsAnalysis,
        LimsSample,
        LimsSubSample,
    )
    from datetime import time as _time

    db = db_session
    db.add(BusinessHoursConfig(id=1, open_time=_time(9, 0), close_time=_time(17, 0), timezone=LA, working_days=[0, 1, 2, 3, 4]))
    db.add(LabHoliday(holiday_date=date(2026, 7, 3), name="Independence Day (observed)", source="federal"))
    svc = AnalysisService(title="Sterility (PCR)", keyword="STER-PCR", category="Microbiology")
    db.add(svc)
    inst = Instrument(name="1290a")
    db.add(inst)
    old = LimsSample(sample_id="P-OLD", external_lims_uid="u0", date_received=datetime(2026, 1, 15, 18, 0), status="published")
    s = LimsSample(sample_id="P-1", external_lims_uid="u1", date_received=datetime(2026, 7, 1, 18, 0), status="sample_received", client_title="acme", is_retest=True, client_order_number="3271")
    bare = LimsSample(sample_id="P-2", external_lims_uid="u2", date_received=datetime(2026, 7, 1, 19, 0), status=None, client_title=None)
    db.add_all([old, s, bare])
    db.flush()
    db.add_all(
        [
            LimsAnalysis(lims_sample_pk=s.id, analysis_service_id=svc.id, keyword="STER-PCR", title="Sterility", provenance="shadow"),
            LimsAnalysis(lims_sample_pk=s.id, analysis_service_id=svc.id, keyword="STER-PCR", title="Sterility", provenance="canonical"),
            LimsSubSample(parent_sample_pk=s.id, external_lims_uid="v1", sample_id="P-1-S01", vial_sequence=1),
            LimsSubSample(parent_sample_pk=s.id, external_lims_uid="v2", sample_id="P-1-S02", vial_sequence=2),
            HPLCAnalysis(
                sample_id_label="P-1-S01",
                peptide_id=1,
                stock_vial_empty=0,
                stock_vial_with_diluent=0,
                dil_vial_empty=0,
                dil_vial_with_diluent=0,
                dil_vial_with_diluent_and_sample=0,
                created_at=datetime(2026, 7, 2, 18, 0),
                instrument_id=inst.id,
            ),
        ]
    )
    db.commit()

    out = main_module._load_throughput_inputs(db)

    assert [x.sample_id for x in out["samples"]] == ["P-1", "P-2"]  # January row filtered at the DB
    assert out["samples"][0].is_retest is True and out["samples"][0].client == "acme"
    assert out["samples"][0].order == "3271"
    assert out["samples"][1].status is None and out["samples"][1].client is None  # engine normalises these
    assert out["analyses"] == [AnalysisIn(s.id, "STER-PCR")]  # DISTINCT across provenance
    assert out["vial_counts"] == {s.id: 2}
    assert out["bench"] == [BenchIn("P-1-S01", datetime(2026, 7, 2, 18, 0), inst.id)]
    assert out["instruments"] == {inst.id: "1290a"}
    assert out["service_categories"] == {"STER-PCR": "Microbiology"}
    cal = out["calendar"]
    assert cal.tz == LA and cal.working_days == frozenset({0, 1, 2, 3, 4})
    assert date(2026, 7, 3) in cal.holidays
