"""Unit tests for the COA source resolver decision rule.

Tests use a real SessionLocal (the existing convention from
test_variance_set.py) but each test cleans up CoaResultPin rows it
inserted so they're isolated from each other and from production data.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete

from coa.schemas import CandidateInfo
from coa.source_resolver import _resolve_analyte
from database import SessionLocal
from models import CoaResultPin


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def parent_id():
    # Use a synthetic ID that won't collide with any real parent in the
    # subvial DB — keeps pin inserts safe regardless of seed data.
    return "TEST-COA-RESOLVER-PARENT"


@pytest.fixture
def clean_pins(db, parent_id):
    """Wipe any pins for the synthetic parent before & after each test."""
    db.execute(delete(CoaResultPin).where(
        CoaResultPin.parent_sample_id == parent_id
    ))
    db.commit()
    yield
    db.execute(delete(CoaResultPin).where(
        CoaResultPin.parent_sample_id == parent_id
    ))
    db.commit()


def _make_candidate(
    sample_id: str = "BW-0013",
    analysis_uid: str = "uid-1",
    value: str = "98.5",
    unit: str = "%",
    state: str = "verified",
    reportable: bool = True,
    in_variance_set: bool = False,
    is_parent_ar: bool = True,
) -> CandidateInfo:
    return CandidateInfo(
        source_sample_id=sample_id,
        source_analysis_uid=analysis_uid,
        value=value,
        unit=unit,
        state=state,
        reportable=reportable,
        in_variance_set=in_variance_set,
        is_parent_ar=is_parent_ar,
    )


def test_zero_candidates_blocks_missing(db, parent_id, clean_pins):
    d = _resolve_analyte("IDENTITY_HPLC", [], db, parent_id)
    assert d.blocked == "missing"
    assert d.chosen is None


def test_zero_eligible_after_state_filter_blocks_missing(db, parent_id, clean_pins):
    cs = [_make_candidate(state="to_be_verified", reportable=True)]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db, parent_id)
    assert d.blocked == "missing"


def test_zero_eligible_after_reportable_filter_blocks_missing(db, parent_id, clean_pins):
    cs = [_make_candidate(state="verified", reportable=False)]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db, parent_id)
    assert d.blocked == "missing"


def test_one_eligible_auto_resolves(db, parent_id, clean_pins):
    cs = [_make_candidate(value="98.5", unit="%")]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db, parent_id)
    assert d.blocked is None
    assert d.mode == "auto"
    assert d.chosen is not None
    assert d.chosen.value == "98.5"
    assert d.chosen.unit == "%"


def test_many_eligible_without_pin_blocks_needs_decision(db, parent_id, clean_pins):
    cs = [
        _make_candidate(sample_id=parent_id,        analysis_uid="uid-p"),
        _make_candidate(sample_id=f"{parent_id}-S02", analysis_uid="uid-s2", is_parent_ar=False),
    ]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db, parent_id)
    assert d.blocked == "needs_decision"
    assert d.chosen is None
    assert len(d.candidates) == 2


def test_many_eligible_with_matching_pin_resolves_to_pinned(db, parent_id, clean_pins):
    db.add(CoaResultPin(
        parent_sample_id=parent_id,
        analyte_keyword="IDENTITY_HPLC",
        mode="pin",
        source_sample_id=f"{parent_id}-S02",
        source_analysis_uid="uid-s2",
    ))
    db.commit()
    cs = [
        _make_candidate(sample_id=parent_id,        analysis_uid="uid-p",  value="96.2"),
        _make_candidate(sample_id=f"{parent_id}-S02", analysis_uid="uid-s2", value="98.5", is_parent_ar=False),
    ]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db, parent_id)
    assert d.blocked is None
    assert d.mode == "pin"
    assert d.chosen is not None
    assert d.chosen.source_sample_id == f"{parent_id}-S02"
    assert d.chosen.value == "98.5"


def test_pin_referencing_missing_candidate_blocks_stale_pin(db, parent_id, clean_pins):
    db.add(CoaResultPin(
        parent_sample_id=parent_id,
        analyte_keyword="IDENTITY_HPLC",
        mode="pin",
        source_sample_id=f"{parent_id}-S99",   # no such sub-sample
        source_analysis_uid="uid-ghost",
    ))
    db.commit()
    cs = [
        _make_candidate(sample_id=parent_id,        analysis_uid="uid-p"),
        _make_candidate(sample_id=f"{parent_id}-S02", analysis_uid="uid-s2", is_parent_ar=False),
    ]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db, parent_id)
    assert d.blocked == "stale_pin"
    assert d.chosen is None


def test_pin_mode_auto_falls_through_to_needs_decision(db, parent_id, clean_pins):
    db.add(CoaResultPin(
        parent_sample_id=parent_id,
        analyte_keyword="IDENTITY_HPLC",
        mode="auto",
        source_sample_id=None,
        source_analysis_uid=None,
    ))
    db.commit()
    cs = [
        _make_candidate(sample_id=parent_id,        analysis_uid="uid-p"),
        _make_candidate(sample_id=f"{parent_id}-S02", analysis_uid="uid-s2", is_parent_ar=False),
    ]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db, parent_id)
    # mode='auto' pin means "explicitly let the resolver decide" — with >1
    # eligible candidates and no actionable pin, we still need a human.
    assert d.blocked == "needs_decision"
