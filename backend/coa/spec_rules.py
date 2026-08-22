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


def resolve_spec(db: Session, service_id: int, matrix: Optional[str],
                 peptide_id: Optional[int] = None):
    """Active spec by precedence: (service, peptide) -> (service, matrix) ->
    (service, wildcard) -> None. scalar_one_or_none on purpose — the partial
    unique indexes guarantee at most one active row per slot, and if that
    invariant ever breaks, failing loud (which aborts COA generation) beats
    silently picking a limit.

    peptide_id=None (the default, preserving every pre-slice-2 caller) skips
    tier 1 entirely — R4/R5: an unresolved peptide anchor, a blend (multiple
    distinct peptide anchors), or a non-peptide sample all coarsen straight
    to matrix/wildcard, never abort here."""
    from models import AnalysisServiceSpec

    if peptide_id is not None:
        row = db.execute(
            select(AnalysisServiceSpec).where(
                AnalysisServiceSpec.analysis_service_id == service_id,
                AnalysisServiceSpec.peptide_id == peptide_id,
                AnalysisServiceSpec.active.is_(True),
            )
        ).scalar_one_or_none()
        if row is not None:
            return row
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
    # CRITICAL: the wildcard arm also requires peptide_id IS NULL — without
    # it, a peptide-bound row could masquerade as the default when no true
    # wildcard row exists for this service.
    return db.execute(
        select(AnalysisServiceSpec).where(
            AnalysisServiceSpec.analysis_service_id == service_id,
            AnalysisServiceSpec.matrix.is_(None),
            AnalysisServiceSpec.peptide_id.is_(None),
            AnalysisServiceSpec.active.is_(True),
        )
    ).scalar_one_or_none()


def sample_peptide_id(db: Session, parent_pk: int) -> Optional[int]:
    """The parent's peptide identity anchor (R6): the DISTINCT peptide_id
    over every family analysis (hosted on the parent OR any of its
    sub-samples) whose service is peptide-linked. The join is always the
    AnalysisService.peptide_id FK — never _fuzzy_match_peptide or a
    peptide_name string. Exactly one distinct id -> that id; zero (no
    peptide-linked service) or many (a blend) -> None, so the caller
    coarsens to the matrix/wildcard tier (R4/R5) instead of aborting.

    review_state != 'retracted' is the ONLY state filter here, on purpose: a
    retracted row is a real incident class (a sample relabeled from one
    peptide to another leaves the old, wrong-identity analysis behind as
    retracted) and must not add a phantom second anchor that demotes a
    single-peptide sample to blend-treatment. Every other state — including
    'ordered' placeholders and 'shadow' SENAITE mirror rows — stays IN the
    anchor query; over-filtering would return None for samples whose anchor
    is in fact knowable, which is exactly the coarsening R4 wants avoided
    when it isn't necessary."""
    from models import AnalysisService, LimsAnalysis, LimsSubSample

    ids = db.execute(
        select(AnalysisService.peptide_id)
        .join(LimsAnalysis, LimsAnalysis.analysis_service_id == AnalysisService.id)
        .outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            AnalysisService.peptide_id.is_not(None),
            LimsAnalysis.review_state != "retracted",
            (LimsAnalysis.lims_sample_pk == parent_pk)
            | (LimsSubSample.parent_sample_pk == parent_pk),
        )
        .distinct()
    ).scalars().all()
    return ids[0] if len(ids) == 1 else None


def evaluate(spec, result: str) -> Optional[bool]:
    """Verdict of a result string against a spec (any object with rule_kind,
    equals_value, min_value, max_value). Pure. Raises SpecRuleError whenever
    the rule cannot actually be applied — a verdict is only ever emitted from
    a rule that ran; anything else fails closed. Bounds are INCLUSIVE.

    rule_kind='informational' returns None — "report as measured", no
    verdict by design (report-only spec, 2026-08-22). This is NOT the
    fail-closed None-shaped anything: the row still required a real,
    deliberately-filed spec row to get here (rule 5 untouched), and no
    numeric parsing applies — the measured value prints verbatim."""
    if spec.rule_kind == "informational":
        return None
    text = str(result or "").strip()
    if spec.rule_kind == "equals":
        expected = str(spec.equals_value or "").strip()
        if not expected:
            raise SpecRuleError(
                "spec has a blank equals_value — file a real expected value on the catalog row"
            )
        return text.lower() == expected.lower()
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
