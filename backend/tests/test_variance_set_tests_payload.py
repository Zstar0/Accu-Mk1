"""Variance overlay data (variance-run-rows): the `tests` payload, stable
value order, spec verdicts for categorical add-on results, the locker's
name, and no SENAITE call for a native-born family.

In-memory SQLite (StaticPool), so nothing touches the shared dev Postgres.
"""
from __future__ import annotations

import json
from decimal import Decimal
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec, LimsAnalysis,
                    LimsSample, LimsSubSample, Peptide, User, VialRole)
from sub_samples import service as sub_service
from sub_samples.routes import get_variance_set_endpoint


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


@pytest.fixture(autouse=True)
def no_senaite(monkeypatch):
    """Any SENAITE lookup fails the test: the family below is native-born."""
    calls: list[str] = []

    def boom(sample_id):
        calls.append(sample_id)
        raise AssertionError(f"SENAITE called for {sample_id}")
    monkeypatch.setattr(sub_service.senaite, "fetch_results_by_keyword", boom)
    return calls


def _svc(db, keyword, title, *, unit=None, options=None, spec=None):
    svc = AnalysisService(title=title, keyword=keyword, origin="mk1", unit=unit,
                          result_options=options)
    db.add(svc)
    db.flush()
    if spec is not None:
        db.add(AnalysisServiceSpec(analysis_service_id=svc.id, unit=unit, **spec))
        db.flush()
    return svc


def _vial(db, parent, seq, role, kind, *, in_set=True, reason=None):
    v = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                      parent_sample_pk=parent.id, external_lims_uid=f"mk1://{parent.sample_id}{seq}",
                      assignment_role=role, assignment_kind=kind, in_variance_set=in_set,
                      variance_exclusion_reason=reason)
    db.add(v)
    db.flush()
    return v


def _row(db, vial, svc, value, state, **kw):
    db.add(LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=kw.pop("title", svc.title),
                        result_value=value, result_unit=svc.unit, review_state=state, **kw))
    db.flush()


@pytest.fixture()
def family(db):
    """P-7001: HPLC (core S01 + replicate S04), endotoxin (core S02 + an
    in-set replicate S05 and an excluded one S06), Rapid PCR (core S03 +
    a pending replicate S07)."""
    for code in ("hplc", "endo85", "pcr"):
        db.add(VialRole(code=code, label=code.upper(), department_id=None, variance_eligible=True,
                        sort_order=1, boxable=False, frozen=False, is_system=False))
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    ident = _svc(db, "HPLC-IDENTITY", "HPLC Identity")
    pur = _svc(db, "HPLC-PURITY", "HPLC Purity", unit="%")
    qty = _svc(db, "HPLC-QUANTITY", "HPLC Quantity", unit="mg")
    endo = _svc(db, "ENDOTOXIN-USP85LAL", "Endotoxin", unit="EU/mL",
                spec={"rule_kind": "range", "max_value": Decimal("5")})
    pcr = _svc(db, "RAPID-PCR", "Rapid PCR",
               options=[{"value": "Not Detected", "label": "Not Detected"},
                        {"value": "Detected", "label": "Detected"}],
               spec={"rule_kind": "equals", "equals_value": "Not Detected"})
    for key, name, svcs in (("hplc-purity-identity", "HPLC Purity and Identity", [ident, pur, qty]),
                            ("endotoxin-usp85-lal", "Endotoxin", [endo]),
                            ("rapid-sterility-pcr", "Rapid Sterility PCR", [pcr])):
        db.add(AnalysisProfile(key=key, name=name, is_addon=False, active=True))
    user = User(email="lock@example.test", hashed_password="x", first_name="Dana", last_name="Lee")
    db.add(user)
    db.flush()
    parent = LimsSample(
        sample_id="P-7001", external_lims_system="mk1", external_lims_uid=None,
        container_mode=True, sample_type_title="Peptide",
        analytes=json.dumps([{"name": pep.name, "peptide_id": pep.id}]),
        catalog_snapshot={"profiles": [
            {"key": "hplc-purity-identity", "service_ids": [ident.id, pur.id, qty.id]},
            {"key": "endotoxin-usp85-lal", "service_ids": [endo.id]},
            {"key": "rapid-sterility-pcr", "service_ids": [pcr.id]},
        ]},
        variance_locked_at=datetime(2026, 11, 10, 9, 0), variance_locked_by_user_id=user.id,
    )
    db.add(parent)
    db.flush()
    s1 = _vial(db, parent, 1, "hplc", "core")
    s2 = _vial(db, parent, 2, "endo85", "core", in_set=False)
    s3 = _vial(db, parent, 3, "pcr", "core", in_set=False)
    s4 = _vial(db, parent, 4, "hplc", "variance")
    s5 = _vial(db, parent, 5, "endo85", "variance")
    s6 = _vial(db, parent, 6, "endo85", "variance", in_set=False, reason="Cracked vial")
    s7 = _vial(db, parent, 7, "pcr", "variance")
    # Inserted quantity first on purpose: the payload must not follow insert order.
    for vial, (i, p, q, st) in ((s1, ("Conforms", "98", "11", "promoted")),
                                (s4, ("Conforms", "97", "10.5", "variance_verified"))):
        _row(db, vial, qty, q, st, peptide_id=pep.id, slot=1)
        _row(db, vial, pur, p, st, peptide_id=pep.id, slot=1)
        _row(db, vial, ident, i, st, peptide_id=pep.id, slot=1)
    _row(db, s2, endo, "2", "promoted")
    _row(db, s5, endo, "1.5", "variance_verified")
    _row(db, s6, endo, "9", "to_be_verified")
    _row(db, s3, pcr, "Not Detected", "promoted")
    _row(db, s7, pcr, None, "unassigned")
    db.commit()
    return parent


def test_tests_payload_shape(db, family):
    out = sub_service.get_variance_set(db, family.sample_id)
    tests = {t["role"]: t for t in out["tests"]}
    assert list(tests) == ["hplc", "endo85", "pcr"]  # snapshot (section) order

    endo = tests["endo85"]
    assert endo["title"] == "Endotoxin"
    assert endo["section_key"] == "endotoxin-usp85-lal"
    assert endo["is_hplc"] is False
    assert [(r["sample_id"], r["kind"], r["in_variance_set"]) for r in endo["runs"]] == [
        ("P-7001-S02", "core", False), ("P-7001-S05", "variance", True),
        ("P-7001-S06", "variance", False)]
    excluded = endo["runs"][2]
    assert excluded["exclusion_reason"] == "Cracked vial"
    assert excluded["signed_off"] is False
    v = endo["runs"][1]["values"][0]
    assert (v["value"], v["unit"], v["conforms"], v["review_state"]) == (
        "1.5", "EU/mL", True, "variance_verified")
    # Core counts although it is out of the set; the excluded replicate does not.
    assert endo["summary"] == {"runs": 2, "runs_with_result": 2, "conforming": 2,
                               "replicates": 1, "replicates_signed_off": 1, "stats": []}

    pcr = tests["pcr"]
    pending = pcr["runs"][1]
    assert pending["has_result"] is False and pending["signed_off"] is False
    assert pcr["summary"]["runs_with_result"] == 1
    assert pcr["summary"]["replicates_signed_off"] == 0

    hplc = tests["hplc"]
    assert hplc["is_hplc"] is True
    assert hplc["title"] == "HPLC Purity and Identity"
    assert all(r["signed_off"] for r in hplc["runs"])
    stats = {s["keyword"]: s for s in hplc["summary"]["stats"]}
    assert stats["HPLC-PUR"]["mean"] == pytest.approx(97.5)
    assert stats["ANALYTE-1-ID"]["conforms_count"] == 2


def test_values_are_in_fixed_order(db, family):
    out = sub_service.get_variance_set(db, family.sample_id)
    hplc = next(t for t in out["tests"] if t["role"] == "hplc")
    for run in hplc["runs"]:
        assert [v["keyword"] for v in run["values"]] == ["ANALYTE-1-ID", "HPLC-PUR", "PEPT-Total"]
    s1 = next(v for v in out["vials"] if v["sample_id"] == "P-7001-S01")
    assert list(s1["results"]) == ["ANALYTE-1-ID", "HPLC-PUR", "PEPT-Total"]


def test_not_detected_pcr_conforms(db, family):
    # Count the PCR core in the stats (today's stats run over in-set vials).
    s3_row = next(s for s in family.sub_samples if s.sample_id == "P-7001-S03")
    s3_row.in_variance_set = True
    db.commit()
    out = sub_service.get_variance_set(db, family.sample_id)
    s3 = next(v for v in out["vials"] if v["sample_id"] == "P-7001-S03")
    assert s3["results"]["RAPID-PCR"]["conforms"] is True
    pcr_stat = out["stats"]["RAPID-PCR"]
    assert (pcr_stat["conforms_count"], pcr_stat["total"]) == (1, 1)
    assert pcr_stat["pass"] is True


def test_locked_by_name_and_route_declares_fields(db, family):
    resp = get_variance_set_endpoint(family.sample_id, db=db, _user=None)
    body = resp.model_dump(by_alias=True)
    assert body["locked_by_user_id"] is not None
    assert body["locked_by_name"] == "Dana Lee"
    assert [t["role"] for t in body["tests"]] == ["hplc", "endo85", "pcr"]
    assert body["tests"][1]["runs"][1]["values"][0]["conforms"] is True


def test_no_senaite_call_for_native_born_family(db, family, no_senaite):
    sub_service.get_variance_set(db, family.sample_id)
    assert no_senaite == []


def test_senaite_still_called_for_senaite_born_family(db, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(sub_service.senaite, "fetch_results_by_keyword",
                        lambda sid: calls.append(sid) or {})
    parent = LimsSample(sample_id="P-7002", external_lims_system="senaite",
                        external_lims_uid="abc", container_mode=False)
    db.add(parent)
    db.flush()
    _vial(db, parent, 1, "hplc", "core")
    db.commit()
    out = sub_service.get_variance_set(db, "P-7002")
    assert calls == ["P-7002", "P-7002-S01"]
    assert out["tests"] == []
