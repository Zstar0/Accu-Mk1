"""Add-on test Variance, Task 12: the variance lock covers the four tests.

Gate that keeps other inputs identical: with no four-key entry in the
order (`has_variance_test_entry`) the plan is None, so the lock passes and
refuses exactly as at base. The tests marked "characterization" ran green
on the base checkout (ca191646) before the change.

Self-contained on purpose (no imports from other test files or from
`sub_samples.variance_tests`), so this file also runs on the base checkout.
In-memory SQLite except the two-session race tests at the bottom, which
need the dev Postgres and skip cleanly without it.
"""
from __future__ import annotations

import json
from datetime import datetime

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401  (register every ORM table before create_all)
from database import Base
from models import (
    AnalysisProfile, AnalysisService, AuditLog, Department, LimsAnalysis, LimsSample,
    LimsSubSample, VialRole,
)
from sub_samples import service as sub_service

ENDO85_KEY = "endotoxin-usp85-lal"
HM_KEY = "heavy_metals"
ENDO_KW = "ENDOTOXIN-USP85LAL"
HM_KWS = ("HM-PB", "HM-AS", "HM-CD", "HM-HG")
HPLC_ONLY = {"hplcpurity_identity": True, "variance": {"hplcpurity_identity": 3}}
INCOMPLETE = r"variance series incomplete . unfinished rows: "  # base text, any dash


@pytest.fixture()
def lite():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


def _catalog(db):
    """The four-test catalog the lock resolves against: endo85 (one vial a
    run) and hm (two vials a run, one analytical: a digest), both roles
    variance-eligible. Returns one analysis service id for the rows."""
    dep = Department(name="ZZ T12 Micro")
    db.add(dep)
    db.flush()
    for i, code in enumerate(("endo85", "hm"), 1):
        db.add(VialRole(code=code, label=code, department_id=dep.id, variance_eligible=True,
                        sort_order=100 + i, boxable=False, frozen=False, is_system=False))
    db.add(AnalysisProfile(key=ENDO85_KEY, name="ZZ Endo 85", is_addon=True, vials_required=1,
                           fulfillment_dim="role", fulfillment_role="endo85", active=True))
    db.add(AnalysisProfile(key=HM_KEY, name="ZZ HM", is_addon=True, vials_required=2,
                           analytical_vials=1, fulfillment_dim="role", fulfillment_role="hm",
                           active=True))
    svc = AnalysisService(title="ZZ T12", keyword="ZZ-T12", origin="mk1")
    db.add(svc)
    db.commit()
    return svc.id


def _world(db, sid, vials, services, monkeypatch):
    """A native parent with one vial per `vials` entry, in sequence order:
    (role, kind, [(keyword, review_state), ...]). Membership follows the
    production rule (sequence 1 or kind variance). An `unassigned` row has
    no result. Everything is COMMITTED (the lock rolls back before the
    order lookup). The order lookup is patched to answer `services`
    (None: the lookup raises) and records whether a transaction was open
    while it ran."""
    svc_id = _catalog(db)
    parent = LimsSample(sample_id=sid, external_lims_uid=f"{sid}-uid",
                        external_lims_system="mk1", container_mode=True, status="received")
    db.add(parent)
    db.flush()
    for seq, (role, kind, rows) in enumerate(vials, 1):
        v = LimsSubSample(sample_id=f"{sid}-S{seq:02d}", vial_sequence=seq,
                          parent_sample_pk=parent.id, external_lims_uid=f"{sid}-v{seq}",
                          assignment_role=role, assignment_kind=kind,
                          in_variance_set=(seq == 1 or kind == "variance"))
        db.add(v)
        db.flush()
        for kw, state in rows:
            db.add(LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=svc_id,
                                keyword=kw, title=kw, review_state=state,
                                result_value=None if state == "unassigned" else "1"))
    db.commit()
    txn_open: list[bool] = []

    def fake(sample_id):
        txn_open.append(db.in_transaction())
        if services is None:
            raise RuntimeError("IS down")
        return {"services": services}
    monkeypatch.setattr(sub_service, "fetch_sample_services", fake)
    return txn_open


def _lock(db, sid):
    return sub_service.lock_variance_set(db, sid, user_id=1)


def _locked(db, sid):
    db.expire_all()
    return db.query(LimsSample).filter_by(sample_id=sid).one().variance_locked_at is not None


def _endo(n):
    return {ENDO85_KEY: True, "variance": {ENDO85_KEY: n}}


def _hm_rows(state):
    return [(kw, state) for kw in HM_KWS]


CORE_ENDO = ("endo85", "core", [(ENDO_KW, "promoted")])


def _rep_endo(state="variance_verified"):
    return ("endo85", "variance", [(ENDO_KW, state)])


HPLC_SIGNED = [("hplc", "core", [("ZZ-HPLC-KW1", "variance_verified")]),
               ("hplc", "variance", [("ZZ-HPLC-KW2", "variance_verified")])]


# ── Step 1: characterization (legacy-only orders; green on base) ────────────


def test_hplc_only_lock_unchanged(lite, monkeypatch):
    _world(lite, "ZZT12-H1", HPLC_SIGNED, HPLC_ONLY, monkeypatch)
    parent = _lock(lite, "ZZT12-H1")
    assert parent.variance_locked_at is not None
    assert parent.variance_locked_by_user_id == 1
    log = lite.query(AuditLog).filter_by(entity_id="ZZT12-H1",
                                         operation="variance_set_locked").one()
    assert log.details == {"user_id": 1, "selected_vials": 3}


def test_hplc_only_unfinished_row_refused_unchanged(lite, monkeypatch):
    vials = [HPLC_SIGNED[0], ("hplc", "variance", [("ZZ-HPLC-KW2", "to_be_verified")])]
    _world(lite, "ZZT12-H2", vials, HPLC_ONLY, monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError,
                       match=INCOMPLETE + "ZZT12-H2-S02:ZZ-HPLC-KW2$"):
        _lock(lite, "ZZT12-H2")
    assert not _locked(lite, "ZZT12-H2")


def test_hplc_only_excluded_and_retested_rows_unchanged(lite, monkeypatch):
    vials = [HPLC_SIGNED[0], ("hplc", "variance", [("ZZ-HPLC-KW2", "to_be_verified")]),
             ("hplc", "variance", [("ZZ-HPLC-KW3", "to_be_verified")])]
    _world(lite, "ZZT12-H3", vials, HPLC_ONLY, monkeypatch)
    sub_service.set_variance_membership(lite, "ZZT12-H3-S02", False, "Customer request")
    lite.query(LimsAnalysis).filter_by(keyword="ZZ-HPLC-KW3").one().retested = True
    lite.commit()
    assert _lock(lite, "ZZT12-H3").variance_locked_at is not None


def test_legacy_endo_bucket_unchanged(lite, monkeypatch):
    vials = [("hplc", "core", [("ZZ-HPLC-KW1", "promoted")]),
             ("endo", "variance", [("ZZ-ENDO", "to_be_verified")])]
    services = {"endotoxin": True, "variance": {"endotoxin": 2}}
    _world(lite, "ZZT12-LE", vials, services, monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError,
                       match=INCOMPLETE + "ZZT12-LE-S02:ZZ-ENDO$"):
        _lock(lite, "ZZT12-LE")


def test_hplc_only_order_never_checks_four_test_rows(lite, monkeypatch):
    # The additive line: an HPLC-only order locks over an unsigned endo85 row.
    vials = HPLC_SIGNED + [_rep_endo("to_be_verified")]
    _world(lite, "ZZT12-H4", vials, {**HPLC_ONLY, ENDO85_KEY: True}, monkeypatch)
    assert _lock(lite, "ZZT12-H4").variance_locked_at is not None


@pytest.mark.parametrize("services", [None, {"hplcpurity_identity": True}],
                         ids=["lookup_fails", "no_variance"])
def test_no_variance_or_lookup_failure_skips_guard_unchanged(lite, monkeypatch, services):
    vials = [HPLC_SIGNED[0], ("hplc", "variance", [("ZZ-HPLC-KW2", "to_be_verified")])]
    _world(lite, "ZZT12-H5", vials, services, monkeypatch)
    assert _lock(lite, "ZZT12-H5").variance_locked_at is not None


def test_four_key_entry_lookup_failure_stays_fail_soft(lite, monkeypatch):
    # IS down: today's fail-soft lock, even with an unsigned replicate
    # (the certificate builder is the hard gate, Task 14).
    _world(lite, "ZZT12-FS", [CORE_ENDO, _rep_endo("to_be_verified")], None, monkeypatch)
    assert _lock(lite, "ZZT12-FS").variance_locked_at is not None


def test_too_few_vials_unchanged_and_never_calls_the_order(lite, monkeypatch):
    txn = _world(lite, "ZZT12-TF", [HPLC_SIGNED[0]], HPLC_ONLY, monkeypatch)
    sub_service.set_variance_membership(lite, "ZZT12-TF-S01", False, "Customer request")
    with pytest.raises(sub_service.VarianceTooFewVialsError, match="need >=2 selected vials"):
        _lock(lite, "ZZT12-TF")
    assert txn == []


# ── Step 2: the four tests ───────────────────────────────────────────────────


def test_lock_refuses_unsigned_endo_replicate(lite, monkeypatch):
    _world(lite, "ZZT12-E1", [CORE_ENDO, _rep_endo("to_be_verified")], _endo(2), monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError, match="ZZT12-E1-S02:" + ENDO_KW):
        _lock(lite, "ZZT12-E1")
    assert not _locked(lite, "ZZT12-E1")


def test_lock_refuses_never_entered_replicate(lite, monkeypatch):
    # Task 8 review: the replicate's row exists but was never entered.
    _world(lite, "ZZT12-E0", [CORE_ENDO, _rep_endo("unassigned")], _endo(2), monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError,
                       match=INCOMPLETE + "ZZT12-E0-S02:" + ENDO_KW + "$"):
        _lock(lite, "ZZT12-E0")
    assert not _locked(lite, "ZZT12-E0")


def test_lock_passes_when_every_replicate_signed_off(lite, monkeypatch):
    txn = _world(lite, "ZZT12-E2", [CORE_ENDO, _rep_endo()], _endo(2), monkeypatch)
    assert _lock(lite, "ZZT12-E2").variance_locked_at is not None
    assert txn == [False]  # no transaction open across the order lookup


def test_lock_passes_with_core_vial_outside_the_set(lite, monkeypatch):
    # A core vial at sequence 2 or later is outside the set by design; it
    # still anchors the core run.
    vials = HPLC_SIGNED[:1] + [CORE_ENDO, _rep_endo()]
    _world(lite, "ZZT12-E3", vials, {**_endo(2), "hplcpurity_identity": True}, monkeypatch)
    assert _lock(lite, "ZZT12-E3").variance_locked_at is not None


def test_lock_refuses_missing_replicate_run(lite, monkeypatch):
    _world(lite, "ZZT12-E4", [CORE_ENDO, _rep_endo()], _endo(3), monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError) as ei:
        _lock(lite, "ZZT12-E4")
    assert str(ei.value) == (f"variance series incomplete: {ENDO85_KEY} bought 3 runs, "
                             "1 replicate runs carry results")
    assert not _locked(lite, "ZZT12-E4")


def test_lock_refuses_extra_in_set_replicate(lite, monkeypatch):
    _world(lite, "ZZT12-E5", [CORE_ENDO, _rep_endo(), _rep_endo()], _endo(2), monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError,
                       match="bought 2 runs, 2 replicate runs"):
        _lock(lite, "ZZT12-E5")


def test_lock_ignores_out_of_set_extra_vial(lite, monkeypatch):
    _world(lite, "ZZT12-E6", [CORE_ENDO, _rep_endo(), _rep_endo()], _endo(2), monkeypatch)
    sub_service.set_variance_membership(lite, "ZZT12-E6-S03", False, "Customer request")
    assert _lock(lite, "ZZT12-E6").variance_locked_at is not None


def test_lock_refuses_missing_core_after_kind_flip(lite, monkeypatch):
    # The core vial was flipped to variance: two replicate anchors, no core.
    _world(lite, "ZZT12-E7", [_rep_endo(), _rep_endo()], _endo(2), monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError) as ei:
        _lock(lite, "ZZT12-E7")
    assert str(ei.value) == (
        f"variance series incomplete: {ENDO85_KEY} bought 2 runs, 2 replicate runs carry "
        f"results; variance series incomplete: {ENDO85_KEY} is missing the core run: "
        "no core vial of role endo85 carries results")


def test_lock_refuses_missing_replicate_after_kind_flip(lite, monkeypatch):
    # The replicate was flipped to core: two core anchors, no replicate.
    vials = [CORE_ENDO, ("endo85", "core", [(ENDO_KW, "promoted")]), HPLC_SIGNED[1]]
    _world(lite, "ZZT12-E8", vials, {**_endo(2), "hplcpurity_identity": True}, monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError) as ei:
        _lock(lite, "ZZT12-E8")
    assert str(ei.value) == (f"variance series incomplete: {ENDO85_KEY} bought 2 runs, "
                             "0 replicate runs carry results")


def test_lock_counts_hm_digests_not_vials(lite, monkeypatch):
    vials = [("hm", "core", _hm_rows("promoted")), ("hm", "core", []),
             ("hm", "variance", _hm_rows("variance_verified")), ("hm", "variance", [])]
    _world(lite, "ZZT12-HM", vials, {HM_KEY: True, "variance": {HM_KEY: 2}}, monkeypatch)
    assert _lock(lite, "ZZT12-HM").variance_locked_at is not None


def test_lock_refuses_missing_hm_core_digest(lite, monkeypatch):
    vials = [("hm", "core", []), ("hm", "core", []),
             ("hm", "variance", _hm_rows("variance_verified")), ("hm", "variance", [])]
    _world(lite, "ZZT12-HM0", vials, {HM_KEY: True, "variance": {HM_KEY: 2}}, monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError) as ei:
        _lock(lite, "ZZT12-HM0")
    assert str(ei.value) == (f"variance series incomplete: {HM_KEY} is missing the core "
                             "digest: no core vial of role hm carries results")


def test_lock_refuses_unfulfillable_entry(lite, monkeypatch):
    _world(lite, "ZZT12-UF", [CORE_ENDO, _rep_endo()],
           {**_endo(2), "variance": {ENDO85_KEY: 2, HM_KEY: 2}}, monkeypatch)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError) as ei:
        _lock(lite, "ZZT12-UF")
    assert str(ei.value) == ("variance cannot lock: Variance for heavy_metals: "
                             "the test is not on this sample")


# ── Steps B and C: the order lookup race (single connection) ────────────────


def test_lock_refused_when_override_written_during_lookup(lite, monkeypatch):
    # Raw SQL, no commit: only a fresh read under the row lock sees it.
    _world(lite, "ZZT12-RO", HPLC_SIGNED, {"hplcpurity_identity": True}, monkeypatch)
    pk = lite.query(LimsSample).filter_by(sample_id="ZZT12-RO").one().id

    def override_then_answer(sample_id):
        lite.execute(text("UPDATE lims_samples SET variance_override = :v WHERE id = :id"),
                     {"v": '{"hplcpurity_identity": 3}', "id": pk})
        return {"services": {"hplcpurity_identity": True}}
    monkeypatch.setattr(sub_service, "fetch_sample_services", override_then_answer)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError,
                       match="variance cannot lock: the variance override changed"):
        _lock(lite, "ZZT12-RO")
    assert not _locked(lite, "ZZT12-RO")


def test_lock_taken_by_another_request_during_lookup_writes_nothing(lite, monkeypatch):
    _world(lite, "ZZT12-RL", HPLC_SIGNED, HPLC_ONLY, monkeypatch)
    pk = lite.query(LimsSample).filter_by(sample_id="ZZT12-RL").one().id

    def lock_then_answer(sample_id):
        lite.execute(text("UPDATE lims_samples SET variance_locked_at = '2026-11-10 12:00:00', "
                          "variance_locked_by_user_id = 7 WHERE id = :id"), {"id": pk})
        lite.commit()
        return {"services": HPLC_ONLY}
    monkeypatch.setattr(sub_service, "fetch_sample_services", lock_then_answer)
    parent = _lock(lite, "ZZT12-RL")
    assert parent.variance_locked_by_user_id == 7
    assert lite.query(AuditLog).filter_by(entity_id="ZZT12-RL").count() == 0


def test_override_lookup_runs_with_no_transaction_open(lite, monkeypatch):
    _world(lite, "ZZT12-OV", [], None, monkeypatch)
    seen: list[bool] = []

    def fake(sample_id):
        seen.append(lite.in_transaction())
        return {"services": {ENDO85_KEY: True}}
    monkeypatch.setattr(sub_service, "fetch_sample_services", fake)
    assert sub_service.set_variance_override(lite, "ZZT12-OV", {ENDO85_KEY: 2}) == {ENDO85_KEY: 2}
    assert seen == [False]
    lite.expire_all()
    stored = lite.query(LimsSample).filter_by(sample_id="ZZT12-OV").one().variance_override
    assert json.loads(stored) == {ENDO85_KEY: 2}


# ── Step D: two sessions on the dev Postgres ────────────────────────────────


@pytest.fixture()
def pg():
    """A dev Postgres session factory, or skip. Every row a test makes
    starts ZZT12PG; teardown deletes them and closes every session."""
    from database import SessionLocal
    probe = SessionLocal()
    try:
        probe.execute(text("SELECT 1"))
    except Exception:
        pytest.skip("dev Postgres not reachable")
    finally:
        probe.rollback()
        probe.close()
    opened = []

    def session():
        s = SessionLocal()
        opened.append(s)
        return s
    try:
        yield session
    finally:
        for s in opened:
            s.rollback()
            s.close()
        clean = SessionLocal()
        try:
            clean.execute(text("DELETE FROM lims_analyses WHERE keyword LIKE 'ZZT12PG%'"))
            clean.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZT12PG%'"))
            clean.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZT12PG%'"))
            clean.execute(text("DELETE FROM audit_logs WHERE entity_id LIKE 'ZZT12PG%'"))
            clean.commit()
        finally:
            clean.close()


def _pg_parent(db, sid, *, vials=0):
    parent = LimsSample(sample_id=sid, peptide_name="ZZ", status="received",
                        external_lims_system="mk1")
    db.add(parent)
    db.flush()
    svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
    for seq in range(1, vials + 1):
        v = LimsSubSample(sample_id=f"{sid}-S{seq:02d}", parent_sample_pk=parent.id,
                          external_lims_uid=f"zzt12pg-{sid}-{seq}", vial_sequence=seq,
                          received_at=datetime.utcnow(), assignment_role="hplc")
        db.add(v)
        db.flush()
        db.add(LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=svc_id,
                            keyword=f"ZZT12PG-KW{seq}", title="ZZ", result_value="9",
                            review_state="to_be_verified" if seq == 2 else "variance_verified"))
    db.commit()
    return parent.id


def _commit_in_other_session(session, sql, params):
    b = session()
    try:
        b.execute(text("SET LOCAL lock_timeout = '5s'"))
        b.execute(text(sql), params)
        b.commit()
    finally:
        b.close()


def test_pg_override_refused_when_locked_by_another_session(pg, monkeypatch):
    a = pg()
    pk = _pg_parent(a, "ZZT12PG-OV")
    seen: list[bool] = []

    def lock_elsewhere(sample_id):
        seen.append(a.in_transaction())
        _commit_in_other_session(pg, "UPDATE lims_samples SET variance_locked_at = now() "
                                     "WHERE id = :id", {"id": pk})
        return {"services": {ENDO85_KEY: True}}
    monkeypatch.setattr(sub_service, "fetch_sample_services", lock_elsewhere)
    with pytest.raises(sub_service.VarianceLockedError, match="ZZT12PG-OV is locked"):
        sub_service.set_variance_override(a, "ZZT12PG-OV", {ENDO85_KEY: 2})
    assert seen == [False]
    assert not a.in_transaction()
    check = pg()
    assert check.execute(text("SELECT variance_override FROM lims_samples WHERE id = :id"),
                         {"id": pk}).scalar_one() is None
    check.rollback()


def test_pg_lock_judges_override_written_by_another_session(pg, monkeypatch):
    # Legacy order, no variance at lookup time, one in-set row unsigned:
    # without the fresh read A would lock. B buys HPLC Variance meanwhile.
    a = pg()
    pk = _pg_parent(a, "ZZT12PG-LK", vials=2)
    seen: list[bool] = []

    def override_elsewhere(sample_id):
        seen.append(a.in_transaction())
        _commit_in_other_session(pg, "UPDATE lims_samples SET variance_override = :v "
                                     "WHERE id = :id",
                                 {"v": '{"hplcpurity_identity": 3}', "id": pk})
        return {"services": {"hplcpurity_identity": True}}
    monkeypatch.setattr(sub_service, "fetch_sample_services", override_elsewhere)
    with pytest.raises(sub_service.VarianceSeriesIncompleteError,
                       match="variance cannot lock: the variance override changed"):
        sub_service.lock_variance_set(a, "ZZT12PG-LK", user_id=1)
    assert seen == [False]
    assert not a.in_transaction()
    check = pg()
    assert check.execute(text("SELECT variance_locked_at FROM lims_samples WHERE id = :id"),
                         {"id": pk}).scalar_one() is None
    check.rollback()
