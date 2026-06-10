"""
Internal contracts for the COA source resolver.

These types are NOT exposed via API endpoints in Phase 1 — they're the shape
the resolver returns to the COA generation handler, and the shape the
manifest writer persists. Phase 2+ frontends will use a parallel public
schema in main.py / sub_samples/schemas.py.

See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
"""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


ResolutionMode = Literal["auto", "pin", "variance_set", "stale_pin_fallback"]
BlockingReason = Literal["missing", "needs_decision", "stale_pin"]


class CandidateInfo(BaseModel):
    """One reportable-eligible analysis instance for a (parent, analyte)."""
    source_sample_id: str
    source_analysis_uid: str
    value: Optional[str] = None
    unit: Optional[str] = None
    state: str  # SENAITE review_state, e.g. 'verified' | 'published'
    reportable: bool = True
    in_variance_set: bool = False
    # Whether the SENAITE AR for this candidate is the parent (vs. a sub).
    is_parent_ar: bool = False


class ResolvedSource(BaseModel):
    """The single source chosen for a (parent, analyte) when resolution succeeded."""
    source_sample_id: str
    source_analysis_uid: str
    value: Optional[str] = None
    unit: Optional[str] = None


class SourceDecision(BaseModel):
    """
    Per-analyte outcome of the resolver. `mode` indicates how the decision
    was reached; `chosen` is None iff `blocked` is set.
    """
    analyte_keyword: str
    mode: ResolutionMode
    chosen: Optional[ResolvedSource] = None
    candidates: List[CandidateInfo] = Field(default_factory=list)
    blocked: Optional[BlockingReason] = None
    blocked_detail: Optional[str] = None


class ResolverResult(BaseModel):
    """
    Aggregate output of the resolver for one parent's COA. `decisions` is one
    SourceDecision per analyte the resolver considered; `is_blocked` is a
    convenience for the caller (True iff any decision has `blocked` set).
    """
    parent_sample_id: str
    decisions: List[SourceDecision]

    @property
    def is_blocked(self) -> bool:
        return any(d.blocked is not None for d in self.decisions)

    def unresolved_analytes(self) -> List[str]:
        return [d.analyte_keyword for d in self.decisions if d.blocked is not None]
