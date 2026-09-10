"""Tests for GET /reports/sla-performance.

The route is guarded by get_current_user (JWT). It loads Mk1 rows through
`_load_sla_perf_inputs(db)` and Integration Service COA rows through
`_fetch_throughput_coas()` (shared with the throughput report), then delegates
to the pure engine in sla_perf.py. Both loaders are patched here via monkeypatch
so a failing test cannot leak the patch into later tests, and every test starts
with a cold row cache. The ORM loader itself is covered separately against an
in-memory SQLite session.
"""
from datetime import datetime, time, timezone
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main as main_module
from auth import get_current_user
from database import get_db
from main import app
from sla_engine import BusinessSchedule
from sla_perf import AnalysisIn, CoaIn, GroupIn, SampleIn, TierIn

client = TestClient(app)

LA = "America/Los_Angeles"
SCHEDULE = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0), timezone=LA,
                            working_days=frozenset({0, 1, 2, 3, 4}))
STANDARD = TierIn(id=1, name="Standard", target_minutes=1440, is_default=True)


def _inputs(samples, analyses=(), tiers=(STANDARD,), groups=()):
    return {
        "samples": list(samples),
        "analyses": list(analyses),
        "tiers": list(tiers),
        "groups": list(groups),
        "schedule": SCHEDULE,
        "holidays": frozenset(),
    }


def _use(monkeypatch, inputs, coas=(), test_ids=frozenset(), fetch=None):
    def _fake_db():
        yield MagicMock()

    monkeypatch.setitem(app.dependency_overrides, get_current_user, lambda: MagicMock(id=1, email="lab@x"))
    monkeypatch.setitem(app.dependency_overrides, get_db, _fake_db)
    monkeypatch.setattr(main_module, "_load_sla_perf_inputs", lambda db: inputs)
    monkeypatch.setattr(main_module, "_fetch_throughput_coas", fetch or (lambda: list(coas)))
    monkeypatch.setattr(main_module, "_test_order_senaite_ids", lambda: set(test_ids))
    monkeypatch.setattr(main_module, "_sla_perf_rows_cache", {})


def _sample(pk, sid, received, status="published", client_title="acme", order="WP-1"):
    return SampleIn(pk=pk, sample_id=sid, date_received=received, status=status,
                    client=client_title, order=order)


def _hplc(pk, verified=None):
    return AnalysisIn(sample_pk=pk, keyword="HPLC-PUR", category="HPLC",
                      verified_at=verified, service_id=10)


def _ster(pk, verified=None):
    return AnalysisIn(sample_pk=pk, keyword="STER-PCR", category="Sterility",
                      verified_at=verified, service_id=91)


def _coa(sid, published):
    return CoaIn(sample_id=sid, published_at=published, is_primary=True)


def test_requires_auth():
    assert client.get("/reports/sla-performance").status_code == 401


def test_returns_the_full_envelope(monkeypatch):
    _use(
        monkeypatch,
        _inputs(samples=[_sample(1, "P-1", datetime(2026, 7, 6, 16, 0))], analyses=[_hplc(1)]),
        coas=[_coa("P-1", datetime(2026, 7, 7, 20, 0, tzinfo=timezone.utc))],
    )
    resp = client.get("/reports/sla-performance")
    assert resp.status_code == 200
    body = resp.json()
    for key in ("start", "today", "tz", "generated_at", "target_bh", "targets", "totals",
                "overall", "kpi", "months", "curve", "stages", "gating", "at_risk",
                "filters", "facets", "cache", "notes"):
        assert key in body, key
    assert body["tz"] == LA
    assert body["target_bh"] == 24.0
    assert body["totals"]["delivered"] == 1
    assert body["months"][0]["ontime"] == 1
    assert body["cache"]["stale"] is False


def test_test_orders_are_excluded_until_the_toggle_is_set(monkeypatch):
    _use(
        monkeypatch,
        _inputs(samples=[_sample(1, "P-1", datetime(2026, 7, 6, 16, 0))], analyses=[_hplc(1)]),
        coas=[_coa("P-1", datetime(2026, 7, 7, 20, 0, tzinfo=timezone.utc))],
        test_ids={"P-1"},
    )
    assert client.get("/reports/sla-performance").json()["totals"]["samples"] == 0
    monkeypatch.setattr(main_module, "_sla_perf_rows_cache", {})
    included = client.get("/reports/sla-performance?include_test_orders=true").json()
    assert included["totals"]["samples"] == 1


def test_the_client_filter_scopes_the_report_and_is_echoed_back(monkeypatch):
    _use(
        monkeypatch,
        _inputs(
            samples=[_sample(1, "P-1", datetime(2026, 7, 6, 16, 0), client_title="acme"),
                     _sample(2, "P-2", datetime(2026, 7, 6, 16, 0), client_title="beta")],
            analyses=[_hplc(1), _hplc(2)],
        ),
        coas=[_coa("P-1", datetime(2026, 7, 7, 20, 0, tzinfo=timezone.utc)),
              _coa("P-2", datetime(2026, 7, 7, 20, 0, tzinfo=timezone.utc))],
    )
    body = client.get("/reports/sla-performance?client=beta").json()
    assert body["totals"]["samples"] == 1
    assert body["filters"]["client"] == "beta"
    # Facets are computed before scoping, so both customers stay selectable.
    assert [c["name"] for c in body["facets"]["clients"]] == ["acme", "beta"]


def test_department_and_family_filters_are_applied(monkeypatch):
    _use(
        monkeypatch,
        _inputs(
            samples=[_sample(1, "P-1", datetime(2026, 7, 6, 16, 0)),
                     _sample(2, "P-2", datetime(2026, 7, 6, 16, 0))],
            analyses=[_hplc(1), _hplc(2), _ster(2)],
        ),
        coas=[_coa("P-1", datetime(2026, 7, 7, 20, 0, tzinfo=timezone.utc)),
              _coa("P-2", datetime(2026, 7, 7, 20, 0, tzinfo=timezone.utc))],
    )
    body = client.get("/reports/sla-performance?department=microbiology").json()
    assert body["totals"]["samples"] == 1
    assert body["filters"]["departments"] == ["microbiology"]


def test_an_unknown_department_is_rejected_by_the_route(monkeypatch):
    _use(monkeypatch, _inputs(samples=[]))
    assert client.get("/reports/sla-performance?department=chemistry").status_code == 422


def test_the_gating_cut_names_the_family_that_finished_last(monkeypatch):
    _use(
        monkeypatch,
        _inputs(
            samples=[_sample(1, "P-1", datetime(2026, 7, 6, 16, 0))],
            analyses=[_hplc(1, verified=datetime(2026, 7, 7, 20, 0)),
                      _ster(1, verified=datetime(2026, 7, 20, 18, 0))],
        ),
        coas=[_coa("P-1", datetime(2026, 7, 20, 20, 0, tzinfo=timezone.utc))],
    )
    gating = client.get("/reports/sla-performance").json()["gating"]
    assert gating["late_mixed"] == 1
    assert gating["trend"][0]["ster_gate_late"] == 1
    assert {f["k"] for f in gating["families"]} == {"hplc", "ster"}


def test_integration_service_failure_with_a_cold_cache_is_a_503(monkeypatch):
    def _boom():
        raise RuntimeError("IS unreachable")

    _use(monkeypatch, _inputs(samples=[]), fetch=_boom)
    resp = client.get("/reports/sla-performance")
    assert resp.status_code == 503
    assert "Reports database error" in resp.json()["detail"]


def test_a_warm_cache_is_served_stale_when_the_refresh_fails(monkeypatch):
    state = {"fail": False}

    def _fetch():
        if state["fail"]:
            raise RuntimeError("IS unreachable")
        return [_coa("P-1", datetime(2026, 7, 7, 20, 0, tzinfo=timezone.utc))]

    _use(
        monkeypatch,
        _inputs(samples=[_sample(1, "P-1", datetime(2026, 7, 6, 16, 0))], analyses=[_hplc(1)]),
        fetch=_fetch,
    )
    assert client.get("/reports/sla-performance").json()["cache"]["stale"] is False
    # Expire the cache, then fail the refresh: the warm rows are served instead.
    state["fail"] = True
    main_module._sla_perf_rows_cache["at"] -= main_module._SLA_PERF_CACHE_TTL_SECONDS + 1
    body = client.get("/reports/sla-performance").json()
    assert body["cache"]["stale"] is True
    assert body["totals"]["delivered"] == 1


def test_rows_are_reused_inside_the_cache_window(monkeypatch):
    calls = {"n": 0}

    def _fetch():
        calls["n"] += 1
        return []

    _use(monkeypatch, _inputs(samples=[]), fetch=_fetch)
    client.get("/reports/sla-performance")
    client.get("/reports/sla-performance?client=acme")
    assert calls["n"] == 1


# ── the ORM loader, against in-memory SQLite ────────────────────────────────
@pytest.fixture()
def sqlite_session():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from models import (
        AnalysisService,
        Base,
        BusinessHoursConfig,
        LabHoliday,
        LimsSample,
        ServiceGroup,
        SlaTier,
        service_group_members,
    )
    from models import LimsAnalysis

    engine = create_engine("sqlite://")
    Base.metadata.create_all(
        engine,
        tables=[
            LimsSample.__table__, LimsAnalysis.__table__, AnalysisService.__table__,
            SlaTier.__table__, ServiceGroup.__table__, service_group_members,
            BusinessHoursConfig.__table__, LabHoliday.__table__,
        ],
    )
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def test_the_loader_reads_the_schedule_tiers_and_group_membership(sqlite_session):
    from models import (
        AnalysisService,
        BusinessHoursConfig,
        LimsAnalysis,
        LimsSample,
        ServiceGroup,
        SlaTier,
        service_group_members,
    )

    sqlite_session.add(BusinessHoursConfig(id=1, open_time=time(8, 0), close_time=time(18, 0),
                                           timezone=LA, working_days=[0, 1, 2, 3, 4]))
    svc = AnalysisService(id=91, keyword="STER-PCR", title="Sterility", category="Sterility")
    sqlite_session.add(svc)
    sqlite_session.add(SlaTier(id=1, name="Standard", target_minutes=1440, is_default=True))
    sqlite_session.add(SlaTier(id=3, name="USP71", target_minutes=6720, is_default=False))
    sqlite_session.add(ServiceGroup(id=2, name="Microbiology", sla_tier_id=3))
    sqlite_session.flush()
    sqlite_session.execute(service_group_members.insert().values(service_group_id=2, analysis_service_id=91))
    s = LimsSample(id=1, sample_id="P-1", date_received=datetime(2026, 7, 6, 16, 0),
                   status="published", client_title="acme", client_order_number="WP-9")
    sqlite_session.add(s)
    sqlite_session.flush()
    sqlite_session.add(LimsAnalysis(lims_sample_pk=1, keyword="STER-PCR", title="Sterility",
                                    analysis_service_id=91,
                                    verified_at=datetime(2026, 7, 7, 20, 0)))
    sqlite_session.commit()

    inputs = main_module._load_sla_perf_inputs(sqlite_session)
    assert inputs["schedule"].open_time == time(8, 0)
    assert inputs["schedule"].timezone == LA
    assert [t.name for t in inputs["tiers"]] == ["Standard", "USP71"]
    micro = next(g for g in inputs["groups"] if g.name == "Microbiology")
    assert micro.sla_tier_id == 3 and micro.service_ids == frozenset({91})
    assert inputs["samples"][0].order == "WP-9"
    a = inputs["analyses"][0]
    assert (a.keyword, a.category, a.service_id) == ("STER-PCR", "Sterility", 91)
    assert a.verified_at == datetime(2026, 7, 7, 20, 0)


def test_the_loader_pre_filters_january_at_the_database(sqlite_session):
    from models import BusinessHoursConfig, LimsSample

    sqlite_session.add(BusinessHoursConfig(id=1, open_time=time(9, 0), close_time=time(17, 0),
                                           timezone=LA, working_days=[0, 1, 2, 3, 4]))
    sqlite_session.add(LimsSample(id=1, sample_id="P-jan", date_received=datetime(2026, 1, 15, 12, 0),
                                  status="published"))
    sqlite_session.add(LimsSample(id=2, sample_id="P-feb", date_received=datetime(2026, 2, 15, 12, 0),
                                  status="published"))
    sqlite_session.commit()
    inputs = main_module._load_sla_perf_inputs(sqlite_session)
    assert [s.sample_id for s in inputs["samples"]] == ["P-feb"]


# ── the response model must not silently drop engine keys ───────────────────
def _walk_for_dropped_keys(path, payload, model, gaps, freeform):
    """Collect payload keys the Pydantic model does not declare.

    FastAPI's ``response_model`` serialises only declared fields, and Pydantic
    ignores extras on the way in, so an engine key the model forgot is dropped
    with no error anywhere -- it simply never reaches the browser.
    """
    declared = set(model.model_fields)
    for extra in sorted(set(payload) - declared):
        gaps.append(f"{path}.{extra}")
    for fname, field in model.model_fields.items():
        if fname not in payload or fname in freeform:
            continue
        ann = field.annotation
        if hasattr(ann, "model_fields"):
            _walk_for_dropped_keys(f"{path}.{fname}", payload[fname], ann, gaps, freeform)
            continue
        inner = next((a for a in getattr(ann, "__args__", ()) if hasattr(a, "model_fields")), None)
        if inner and isinstance(payload[fname], list) and payload[fname]:
            _walk_for_dropped_keys(f"{path}.{fname}[0]", payload[fname][0], inner, gaps, freeform)


def test_response_model_declares_every_key_the_engine_emits(monkeypatch):
    """Guards the whole envelope, not one field.

    `thin` shipped to production in 1.16.2 invisible to the UI because
    SlaPerfGatingFamilyOut never declared it: the engine set it, the frontend
    typed it, every unit test asserted it -- and response_model stripped it in
    between. This walks the real payload against the real models so the next
    added key cannot repeat that.
    """
    from main import SlaPerfReportOut
    from sla_perf import build_sla_performance

    rec = datetime(2026, 7, 6, 16, 0)
    hplc_done = datetime(2026, 7, 7, 20, 0)
    ster_done = datetime(2026, 7, 8, 20, 0)
    samples, analyses, coas = [], [], []
    for pk in range(4):
        sid = f"P-{pk}"
        samples.append(_sample(pk, sid, rec))
        analyses += [_hplc(pk, hplc_done), _ster(pk, ster_done)]
        coas.append(_coa(sid, datetime(2026, 7, 9, 20, 0)))
    samples.append(_sample(99, "P-99", rec))  # open, so at_risk has a row
    analyses.append(_hplc(99))
    _use(monkeypatch, _inputs(samples, analyses), coas=coas)

    # Walk the ENGINE's output, not the route's. The response is what the model
    # already filtered, so a dropped key is gone from it and this test would
    # vacuously pass -- which is exactly how 1.16.2 shipped.
    body = build_sla_performance(
        **_inputs(samples, analyses), coas=coas,
        now=datetime(2026, 7, 10, 18, 0),
    )
    body["generated_at"] = "2026-07-10T18:00:00+00:00"
    body["cache"] = {"stale": False, "age_seconds": 0}
    assert body["gating"]["families"], "fixture must produce at least one family row"
    assert body["at_risk"]["rows"], "fixture must produce at least one at-risk row"
    assert body["months"], "fixture must produce at least one cohort month"

    gaps: list[str] = []
    # notes/trend/status are declared as bare dict on purpose -- family keys there
    # are data, not schema.
    _walk_for_dropped_keys("report", body, SlaPerfReportOut, gaps,
                           freeform={"notes", "trend", "status"})
    assert gaps == [], f"response_model drops engine keys: {gaps}"


def test_the_thin_flag_and_its_floor_survive_the_response_model(monkeypatch):
    """The two keys 1.16.2 dropped, asserted by name over the wire."""
    rec = datetime(2026, 7, 6, 16, 0)
    samples = [_sample(1, "P-1", rec)]
    analyses = [_hplc(1, datetime(2026, 7, 7, 20, 0)), _ster(1, datetime(2026, 7, 8, 20, 0))]
    _use(monkeypatch, _inputs(samples, analyses), coas=[_coa("P-1", datetime(2026, 7, 9, 20, 0))])

    gating = client.get("/reports/sla-performance").json()["gating"]
    assert "min_timed_for_family" in gating
    assert gating["min_timed_for_family"] > 0
    for fam in gating["families"]:
        assert "thin" in fam, f"{fam['k']} lost its thin flag"
    # One timed sample is far under the floor, so it must read as thin.
    assert all(f["thin"] is True for f in gating["families"])
