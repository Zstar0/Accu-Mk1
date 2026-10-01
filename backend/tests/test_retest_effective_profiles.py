"""Effective profile keys for the retest flow when the snapshot is empty
(spec docs/superpowers/specs/2026-09-30-retest-legacy-fallback-and-combined.md)."""
import os
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import auth
from database import Base, get_db
from lims_analyses.retest_carry import (
    LEGACY_CARRY_REASON,
    EffectiveProfile,
    dropped_profile_keys,
    effective_profiles,
    parse_retest_spec,
)
from main import app
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample

ENV = {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}


class _FakeUser:
    id = 9
    email = "josh@accumark.test"


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


@pytest.fixture
def client(db_session):
    app.dependency_overrides[get_db] = lambda: (yield db_session)
    app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
    with patch("lims_analyses.retest_routes.requests.get", side_effect=ConnectionError("down")):
        yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(auth.get_current_user, None)


def _catalog(db):
    """Native profiles, their legacy alias rows, and SENAITE-era services."""
    svc = {kw: AnalysisService(title=kw, keyword=kw, origin=origin) for kw, origin in (
        ("HPLC-PURITY", "mk1"), ("ENDO-USP85", "mk1"), ("STER-RPCR", "mk1"),
        ("BACTERIA", "mk1"), ("FUNGI", "mk1"),
        ("HPLC-PUR", "senaite"), ("PEPT-Total", "senaite"), ("ID_BPC157", "senaite"),
        ("ENDO-LAL", "senaite"), ("STER-PCR", "senaite"), ("PH-DETERM", "senaite"),
        ("PCR-BACTERIA", "senaite"), ("PCR-FUNGI", "senaite"),
        ("MYSTERY-X", "senaite"),
    )}
    profiles = {key: AnalysisProfile(key=key, name=name, is_addon=False, active=True, sort_order=order)
                for key, name, order in (
                    ("hplcpurity_identity", "HPLC (legacy alias)", 0),
                    ("hplc-purity-identity", "HPLC Purity & Identity", 0),
                    ("bac_water_panel", "Bac Water", 1),
                    ("endotoxin", "Endotoxin (legacy alias)", 2),
                    ("endotoxin-usp85-lal", "Endotoxin USP85", 2),
                    ("sterility_pcr", "Sterility (legacy alias)", 3),
                    ("rapid-sterility-pcr", "Rapid Sterility PCR", 3),
                    ("sterility-usp71", "Sterility USP 71", 4),
                )}
    db.add_all([*svc.values(), *profiles.values()])
    db.flush()
    profiles["hplc-purity-identity"].analysis_services.append(svc["HPLC-PURITY"])
    profiles["endotoxin-usp85-lal"].analysis_services.append(svc["ENDO-USP85"])
    profiles["rapid-sterility-pcr"].analysis_services.append(svc["STER-RPCR"])
    profiles["sterility-usp71"].analysis_services.extend([svc["BACTERIA"], svc["FUNGI"]])
    db.flush()
    return svc


def _sample(db, sample_id="P-1908", snapshot=None):
    s = LimsSample(sample_id=sample_id, external_lims_system="senaite", status="published",
                   client_order_number="WP-3555", catalog_snapshot=snapshot)
    db.add(s)
    db.flush()
    return s


def _shadow(db, sample, svc, mirror="published", value="99.1"):
    db.add(LimsAnalysis(lims_sample_pk=sample.id, analysis_service_id=svc.id, keyword=svc.keyword,
                        title=svc.title, provenance="shadow", review_state="senaite_mirror",
                        mirror_review_state=mirror, result_value=value))


def _canonical(db, sample, svc, state="verified"):
    db.add(LimsAnalysis(lims_sample_pk=sample.id, analysis_service_id=svc.id, keyword=svc.keyword,
                        title=svc.title, provenance="canonical", review_state=state, result_value="1",
                        verified_at=datetime(2026, 9, 1, 12, 0, 0)))  # noqa: DTZ001 (naive TIMESTAMP)


def _legacy_world(db):
    svc = _catalog(db)
    s = _sample(db, snapshot={"profiles": []})
    for kw in ("HPLC-PUR", "PEPT-Total", "ID_BPC157", "MYSTERY-X"):
        _shadow(db, s, svc[kw])
    _shadow(db, s, svc["ENDO-LAL"], mirror="verified")
    _shadow(db, s, svc["STER-PCR"], mirror="unassigned", value=None)
    # PB-0350 class: registered / rejected mirror lines are not on the sample.
    _shadow(db, s, svc["PH-DETERM"], mirror="registered", value=None)
    db.commit()
    return s, svc


def test_legacy_shadow_rows_map_to_native_keys(db_session):
    s, _ = _legacy_world(db_session)
    assert effective_profiles(db_session, s) == [
        EffectiveProfile("hplc-purity-identity", True, "rows"),
        EffectiveProfile("endotoxin-usp85-lal", True, "rows"),
        EffectiveProfile("rapid-sterility-pcr", True, "rows"),
    ]


def test_rejected_shadow_and_dead_canonical_rows_are_ignored(db_session):
    svc = _catalog(db_session)
    s = _sample(db_session)
    _shadow(db_session, s, svc["ENDO-LAL"], mirror="rejected")
    _shadow(db_session, s, svc["PH-DETERM"], mirror="cancelled")
    _canonical(db_session, s, svc["HPLC-PURITY"], state="retracted")
    db_session.commit()
    assert effective_profiles(db_session, s) == []


def test_native_canonical_rows_resolve_through_membership(db_session):
    svc = _catalog(db_session)
    s = _sample(db_session)
    # Prod USP-71 = mk1 services BACTERIA + FUNGI: membership, never the keyword map.
    for kw in ("HPLC-PURITY", "BACTERIA", "FUNGI"):
        _canonical(db_session, s, svc[kw])
    db_session.commit()
    assert effective_profiles(db_session, s) == [
        EffectiveProfile("hplc-purity-identity", False, "rows"),
        EffectiveProfile("sterility-usp71", False, "rows"),
    ]


def test_native_row_wins_the_dedupe_over_a_legacy_one(db_session):
    svc = _catalog(db_session)
    s = _sample(db_session)
    _shadow(db_session, s, svc["HPLC-PUR"])
    _canonical(db_session, s, svc["HPLC-PURITY"])
    db_session.commit()
    assert effective_profiles(db_session, s) == [EffectiveProfile("hplc-purity-identity", False, "rows")]


def test_snapshot_wins_and_rows_are_not_read(db_session):
    svc = _catalog(db_session)
    s = _sample(db_session, snapshot={"profiles": [{"key": "endotoxin-usp85-lal"}]})
    _shadow(db_session, s, svc["HPLC-PUR"])
    db_session.commit()
    assert effective_profiles(db_session, s) == [EffectiveProfile("endotoxin-usp85-lal", False, "snapshot")]


def test_dropped_keys_use_effective_keys_only_with_db(db_session):
    s, _ = _legacy_world(db_session)
    spec = parse_retest_spec({"retest_of_sample_id": "P-1908", "retest": ["hplc-purity-identity"],
                              "fee": "paid", "reason": "r"})
    assert dropped_profile_keys(s, spec) == []
    assert dropped_profile_keys(s, spec, db_session) == ["endotoxin-usp85-lal", "rapid-sterility-pcr"]


def test_options_for_a_legacy_sample(client, db_session):
    _legacy_world(db_session)
    body = client.get("/api/samples/P-1908/retest-options").json()
    assert body["profiles_source"] == "rows"
    assert [p["key"] for p in body["profiles"]] == [
        "hplc-purity-identity", "endotoxin-usp85-lal", "rapid-sterility-pcr"]
    for p in body["profiles"]:
        assert p["legacy"] is True and p["carry_eligible"] is False
        assert p["carry_blocked_reason"] == "SENAITE-era result: cannot be carried, re-test it instead"
        assert p["verified_at"] is None
    # State comes from the SENAITE mirror state, never the native "Not verified".
    assert [(p["state"], p["state_label"]) for p in body["profiles"]] == [
        ("published", "Published (SENAITE)"),
        ("verified", "Verified (SENAITE)"),
        (None, "Not verified (SENAITE)"),
    ]
    assert LEGACY_CARRY_REASON == "SENAITE-era result: cannot be carried, re-test it instead"
    assert body["variance"]["allowed"] is True
    # Derived keys are on the original: never offered as add-ons.
    assert {"hplc-purity-identity", "endotoxin-usp85-lal", "rapid-sterility-pcr"}.isdisjoint(
        a["key"] for a in body["addons"])


def test_options_native_rows_carry_eligibility_and_reasons(client, db_session):
    svc = _catalog(db_session)
    s = _sample(db_session)
    _canonical(db_session, s, svc["HPLC-PURITY"])                   # verified: carryable
    _canonical(db_session, s, svc["BACTERIA"])                      # FUNGI pending: blocked
    _canonical(db_session, s, svc["FUNGI"], state="to_be_verified")
    _canonical(db_session, s, svc["ENDO-USP85"], state="to_be_verified")  # nothing verified
    db_session.commit()
    body = client.get("/api/samples/P-1908/retest-options").json()
    by_key = {p["key"]: p for p in body["profiles"]}
    assert by_key["hplc-purity-identity"]["carry_blocked_reason"] is None
    assert by_key["sterility-usp71"]["carry_blocked_reason"] == "a member result is still pending"
    assert by_key["endotoxin-usp85-lal"]["carry_blocked_reason"] == "not verified yet"
    for p in body["profiles"]:
        assert p["legacy"] is False
        assert p["carry_eligible"] is (p["carry_blocked_reason"] is None)


def test_options_snapshot_key_without_a_profile_row(client, db_session):
    _catalog(db_session)
    _sample(db_session, snapshot={"profiles": [{"key": "gone-profile"}]})
    db_session.commit()
    [p] = client.get("/api/samples/P-1908/retest-options").json()["profiles"]
    assert p["carry_eligible"] is False and p["carry_blocked_reason"] == "not verified yet"


def test_options_no_snapshot_no_rows_is_none(client, db_session):
    _catalog(db_session)
    _sample(db_session)
    db_session.commit()
    body = client.get("/api/samples/P-1908/retest-options").json()
    assert body["profiles_source"] == "none" and body["profiles"] == []


def test_carry_of_a_legacy_key_is_refused(client, db_session):
    _legacy_world(db_session)
    with patch("lims_analyses.retest_routes.requests.post") as post:
        r = client.post("/api/samples/P-1908/retest", json={
            "retest": ["hplc-purity-identity"], "carry": ["endotoxin-usp85-lal"],
            "fee": "paid", "reason": "r"})
    assert r.status_code == 400
    assert r.json()["detail"] == ("cannot carry SENAITE-era result(s): ['endotoxin-usp85-lal']; "
                                  "re-test them instead")
    post.assert_not_called()


def test_retest_of_a_legacy_key_forwards_with_the_rest_dropped(client, db_session):
    _legacy_world(db_session)
    ok = MagicMock(status_code=200)
    ok.json.return_value = {"order_id": 1, "order_number": "WP-1", "status": "pending"}
    with patch.dict(os.environ, ENV), \
            patch("lims_analyses.retest_routes.requests.post", return_value=ok) as post:
        r = client.post("/api/samples/P-1908/retest", json={
            "retest": ["hplc-purity-identity"], "fee": "paid", "reason": "r"})
    assert r.status_code == 200, r.text
    spec = post.call_args.kwargs["json"]["retest_spec"]
    assert spec["retest"] == ["hplc-purity-identity"] and spec["carry"] == []


def test_apply_records_derived_keys_as_dropped(db_session):
    """Registration side: the retest sample stamps the other derived keys as drop."""
    from lims_analyses.retest_carry import apply_retest_spec
    s, _ = _legacy_world(db_session)
    retest = _sample(db_session, sample_id="P-4001")
    raw = {"retest_of_sample_id": s.sample_id, "retest": ["hplc-purity-identity"],
           "fee": "paid", "reason": "r"}
    with patch("lims_analyses.order_seed.seed_parent_from_services"), \
            patch("lims_analyses.retest_carry._demand_snapshot_profiles", return_value=[]):
        out = apply_retest_spec(db_session, parent=retest, raw_spec=raw,
                                services={"hplc-purity-identity": True}, package=None, source="test")
    assert out["applied"] is True and out["missing"] == []
    assert retest.catalog_snapshot["retest"]["drop"] == ["endotoxin-usp85-lal", "rapid-sterility-pcr"]


def test_split_pcr_pair_maps_to_rapid_sterility_with_best_mirror_state(client, db_session):
    svc = _catalog(db_session)
    s = _sample(db_session)
    _shadow(db_session, s, svc["PCR-BACTERIA"], mirror="unassigned", value=None)
    _shadow(db_session, s, svc["PCR-FUNGI"], mirror="to_be_verified")
    db_session.commit()
    assert effective_profiles(db_session, s) == [EffectiveProfile("rapid-sterility-pcr", True, "rows")]
    [p] = client.get("/api/samples/P-1908/retest-options").json()["profiles"]
    assert (p["state"], p["state_label"], p["verified_at"]) == (
        "to_be_verified", "Awaiting verification (SENAITE)", None)


def _hplc_only_legacy(db, *, native_active):
    svc = _catalog(db)
    db.execute(AnalysisProfile.__table__.update()
               .where(AnalysisProfile.key == "hplc-purity-identity").values(active=native_active))
    s = _sample(db)
    _shadow(db, s, svc["HPLC-PUR"])
    _shadow(db, s, svc["ID_BPC157"])
    db.commit()
    db.expire_all()
    return s


def test_legacy_hplc_resolves_to_the_active_alias_when_native_is_inactive(client, db_session):
    """Prod: hplc-purity-identity inactive, hplcpurity_identity active."""
    s = _hplc_only_legacy(db_session, native_active=False)
    assert effective_profiles(db_session, s) == [EffectiveProfile("hplcpurity_identity", True, "rows")]
    body = client.get("/api/samples/P-1908/retest-options").json()
    [p] = body["profiles"]
    assert p["key"] == "hplcpurity_identity" and p["legacy"] is True
    assert p["state_label"] == "Published (SENAITE)"
    assert body["variance"]["allowed"] is True
    # The alias may be a re-test profile but never an add-on candidate.
    assert "hplcpurity_identity" not in [a["key"] for a in body["addons"]]


def test_legacy_hplc_prefers_the_native_key_when_both_are_active(db_session):
    s = _hplc_only_legacy(db_session, native_active=True)
    assert effective_profiles(db_session, s) == [EffectiveProfile("hplc-purity-identity", True, "rows")]


def test_legacy_family_with_no_active_member_is_dropped(db_session):
    svc = _catalog(db_session)
    db_session.execute(AnalysisProfile.__table__.update()
                       .where(AnalysisProfile.key.in_(("endotoxin-usp85-lal", "endotoxin")))
                       .values(active=False))
    s = _sample(db_session)
    _shadow(db_session, s, svc["ENDO-LAL"])
    db_session.commit()
    db_session.expire_all()
    assert effective_profiles(db_session, s) == []
