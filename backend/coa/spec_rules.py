"""Native-section spec resolution + verdict (spec-ownership slice 1).

The verdict semantics mirror COABuilder's _verdict — inclusive bounds,
case-insensitive whitespace-trimmed equals — with two DELIBERATE fail-closed
divergences (non-finite false-pass, equals/range abort asymmetry). The
cross-repo parity table in tests/test_spec_rules.py is the contract; its
byte-identical twin lives in coabuilder tests/test_verdict_parity.py.
"""
from __future__ import annotations

import math
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

# MUST stay identical to coabuilder src/coabuilder_core/logic.py:5
# (_PEPTIDE_MATRICES) — a divergence silently changes which spec resolves.
# Pinned by test_peptide_matrices_parity_with_coabuilder.
_PEPTIDE_MATRICES = {"Peptide", "Peptide Blend"}


class SpecRuleError(Exception):
    """A spec rule that cannot be applied to a result (fail-closed)."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def normalize_matrix(raw: Optional[str]) -> Optional[str]:
    """Sample-type title -> spec-resolution matrix. Mirrors COABuilder's
    Peptide Blend -> Peptide fold. None/blank -> None (resolver then goes
    straight to the NULL-matrix default row)."""
    m = (raw or "").strip()
    if not m:
        return None
    return "Peptide" if m in _PEPTIDE_MATRICES else m


def resolve_spec(db: Session, service_id: int, matrix: Optional[str]):
    """Active spec for (service, matrix): exact row, else the NULL-matrix
    default, else None. scalar_one_or_none on purpose — the partial unique
    indexes guarantee at most one active row per slot, and if that invariant
    ever breaks, failing loud (which aborts COA generation) beats silently
    picking a limit."""
    from models import AnalysisServiceSpec

    if matrix is not None:
        row = db.execute(
            select(AnalysisServiceSpec).where(
                AnalysisServiceSpec.analysis_service_id == service_id,
                AnalysisServiceSpec.matrix == matrix,
                AnalysisServiceSpec.active.is_(True),
            )
        ).scalar_one_or_none()
        if row is not None:
            return row
    return db.execute(
        select(AnalysisServiceSpec).where(
            AnalysisServiceSpec.analysis_service_id == service_id,
            AnalysisServiceSpec.matrix.is_(None),
            AnalysisServiceSpec.active.is_(True),
        )
    ).scalar_one_or_none()


def evaluate(spec, result: str) -> bool:
    """Verdict of a result string against a spec (any object with rule_kind,
    equals_value, min_value, max_value). Pure. Raises SpecRuleError whenever
    the rule cannot actually be applied — a verdict is only ever emitted from
    a rule that ran; anything else fails closed. Bounds are INCLUSIVE."""
    text = str(result or "").strip()
    if spec.rule_kind == "equals":
        return text.lower() == str(spec.equals_value or "").strip().lower()
    if spec.rule_kind != "range":
        raise SpecRuleError(f"unknown rule_kind {spec.rule_kind!r}")
    try:
        value = float(text)
    except ValueError as e:
        raise SpecRuleError(
            f"result {result!r} is not numeric but the spec is a numeric range"
        ) from e
    if not math.isfinite(value):
        # The old engine false-passed NaN and -inf here. Deliberate divergence.
        raise SpecRuleError(f"result {result!r} is non-finite — cannot verdict")
    if spec.min_value is not None and value < float(spec.min_value):
        return False
    if spec.max_value is not None and value > float(spec.max_value):
        return False
    return True
