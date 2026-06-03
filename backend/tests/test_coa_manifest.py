"""Round-trip tests for the COA generation manifest writer."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete

from coa.manifest import read_generation_manifest, write_generation_manifest
from coa.schemas import (
    CandidateInfo,
    ResolvedSource,
    ResolverResult,
    SourceDecision,
)
from database import SessionLocal
from models import CoaGenerationSource


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def gen_id(db):
    """Generate a unique generation_id per test; wipe its rows pre & post."""
    g = uuid.uuid4()
    db.execute(delete(CoaGenerationSource).where(
        CoaGenerationSource.generation_id == g
    ))
    db.commit()
    yield g
    db.execute(delete(CoaGenerationSource).where(
        CoaGenerationSource.generation_id == g
    ))
    db.commit()


def _make_resolver_result(parent: str = "TEST-COA-MANIFEST-PARENT") -> ResolverResult:
    return ResolverResult(
        parent_sample_id=parent,
        decisions=[
            SourceDecision(
                analyte_keyword="IDENTITY_HPLC",
                mode="pin",
                chosen=ResolvedSource(
                    source_sample_id=f"{parent}-S02",
                    source_analysis_uid="uid-s2",
                    value="98.55",
                    unit="%",
                ),
                candidates=[
                    CandidateInfo(
                        source_sample_id=parent,
                        source_analysis_uid="uid-p",
                        value="96.2", unit="%",
                        state="verified", reportable=True,
                        is_parent_ar=True,
                    ),
                    CandidateInfo(
                        source_sample_id=f"{parent}-S02",
                        source_analysis_uid="uid-s2",
                        value="98.55", unit="%",
                        state="verified", reportable=True,
                        is_parent_ar=False,
                    ),
                ],
            ),
            SourceDecision(
                analyte_keyword="ENDOTOXIN",
                mode="auto",
                chosen=ResolvedSource(
                    source_sample_id=f"{parent}-S01",
                    source_analysis_uid="uid-endo",
                    value="<0.5",
                    unit="EU/mg",
                ),
                candidates=[
                    CandidateInfo(
                        source_sample_id=f"{parent}-S01",
                        source_analysis_uid="uid-endo",
                        value="<0.5", unit="EU/mg",
                        state="verified", reportable=True,
                        is_parent_ar=False,
                    ),
                ],
            ),
        ],
    )


def test_write_and_read_round_trip(db, gen_id):
    result = _make_resolver_result()
    write_generation_manifest(
        db,
        generation_id=gen_id,
        generation_number=2,
        result=result,
    )

    rows = read_generation_manifest(db, generation_id=gen_id)
    assert len(rows) == 2
    by_analyte = {r.analyte_keyword: r for r in rows}

    identity = by_analyte["IDENTITY_HPLC"]
    assert identity.resolution_mode == "pin"
    assert identity.source_sample_id == "TEST-COA-MANIFEST-PARENT-S02"
    assert identity.result_value == "98.55"
    assert identity.candidates_count == 2
    # Snapshot round-tripped as JSON
    assert identity.candidates_snapshot is not None
    assert len(identity.candidates_snapshot) == 2

    endo = by_analyte["ENDOTOXIN"]
    assert endo.resolution_mode == "auto"
    assert endo.source_sample_id == "TEST-COA-MANIFEST-PARENT-S01"
    assert endo.candidates_count == 1


def test_blocked_decisions_are_skipped(db, gen_id):
    result = ResolverResult(
        parent_sample_id="TEST-COA-MANIFEST-PARENT",
        decisions=[
            SourceDecision(
                analyte_keyword="IDENTITY_HPLC",
                mode="auto",
                chosen=None,
                candidates=[],
                blocked="missing",
                blocked_detail="no candidates",
            ),
        ],
    )
    write_generation_manifest(
        db,
        generation_id=gen_id,
        generation_number=1,
        result=result,
    )
    rows = read_generation_manifest(db, generation_id=gen_id)
    assert rows == []
