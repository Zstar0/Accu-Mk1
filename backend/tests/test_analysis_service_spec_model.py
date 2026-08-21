"""analysis_service_specs constraints: one active spec per (service, matrix),
one active spec per (service, peptide), the both-NULL wildcard slot, the
tier CHECK (matrix and peptide_id are mutually exclusive), and the
rule-shape CHECK. Enforced via __table_args__ so SQLite test DBs carry them
(prod gets the same shapes via raw boot DDL)."""
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError

# Module-level import (matches tests/test_vial_roles_catalog.py:6): registers
# AnalysisServiceSpec on Base.metadata before conftest's db_session fixture
# calls create_all(). Without it, whichever test runs first in an isolated
# `pytest tests/test_analysis_service_spec_model.py` invocation hits
# "no such table: analysis_services", since the helpers below otherwise do
# their first `from models import ...` only after create_all() has already run.
from models import AnalysisService, AnalysisServiceSpec, Peptide
from catalog.service_spec_audit import snapshot_spec


def _mk_service(db, keyword="HM-XX"):
    from models import AnalysisService
    svc = AnalysisService(title=keyword, keyword=keyword, origin="mk1")
    db.add(svc)
    db.flush()
    return svc


def _mk_spec(db, svc, **over):
    from models import AnalysisServiceSpec
    kw = dict(analysis_service_id=svc.id, matrix=None, rule_kind="range",
              max_value=Decimal("0.5"), unit="ppm")
    kw.update(over)
    spec = AnalysisServiceSpec(**kw)
    db.add(spec)
    db.flush()
    return spec


@pytest.fixture
def svc(db_session):
    return _mk_service(db_session)


@pytest.fixture
def peptide(db_session):
    # Minimal shape mirrors tests/test_prep_bridge.py:_peptide.
    p = Peptide(name="BPC-157", abbreviation="BPC157")
    db_session.add(p)
    db_session.flush()
    return p


def test_valid_range_and_equals_rows_insert(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc)
    svc2 = _mk_service(db_session, keyword="STER-XX")
    _mk_spec(db_session, svc2, rule_kind="equals", max_value=None,
             equals_value="Not Detected", unit=None)


def test_second_active_null_matrix_spec_rejected(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc)


def test_second_active_same_matrix_spec_rejected(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc, matrix="Peptide")
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, matrix="Peptide")


def test_deactivated_row_frees_the_slot(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc, active=False)
    _mk_spec(db_session, svc)   # active row alongside the dead one: fine


def test_null_and_named_matrix_coexist(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc)
    _mk_spec(db_session, svc, matrix="Bacteriostatic Water",
             max_value=Decimal("0.25"))


def test_range_with_equals_value_rejected(db_session):
    svc = _mk_service(db_session)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, equals_value="nope")


def test_range_without_bounds_rejected(db_session):
    svc = _mk_service(db_session)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, max_value=None)


def test_equals_with_bounds_rejected(db_session):
    svc = _mk_service(db_session)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, rule_kind="equals",
                 equals_value="Not Detected")   # max_value 0.5 still set


# ── spec-ownership slice 2: peptide tier ────────────────────────────────────

def test_tier_check_rejects_peptide_and_matrix_together(db_session, svc, peptide):
    spec = AnalysisServiceSpec(
        analysis_service_id=svc.id, matrix="Peptide", peptide_id=peptide.id,
        rule_kind="range", max_value=Decimal("1"),
    )
    db_session.add(spec)
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_one_active_peptide_row_per_service_peptide(db_session, svc, peptide):
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svc.id, peptide_id=peptide.id,
        rule_kind="range", max_value=Decimal("1")))
    db_session.flush()
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svc.id, peptide_id=peptide.id,
        rule_kind="range", max_value=Decimal("2")))
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_wildcard_and_peptide_rows_coexist(db_session, svc, peptide):
    db_session.add_all([
        AnalysisServiceSpec(analysis_service_id=svc.id,
                            rule_kind="range", max_value=Decimal("1")),
        AnalysisServiceSpec(analysis_service_id=svc.id, peptide_id=peptide.id,
                            rule_kind="range", max_value=Decimal("2")),
    ])
    db_session.flush()  # must NOT raise — the old null_matrix index would have collided these


def test_snapshot_spec_carries_peptide_id(db_session, svc, peptide):
    spec = AnalysisServiceSpec(analysis_service_id=svc.id, peptide_id=peptide.id,
                               rule_kind="range", max_value=Decimal("1"))
    db_session.add(spec); db_session.flush()
    assert snapshot_spec(spec)["peptide_id"] == peptide.id
