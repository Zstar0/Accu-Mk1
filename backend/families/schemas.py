"""Pydantic models for the family-state endpoint.

Family state aggregates `lims_analyses` for {parent + all subs} into a
single enum value summarizing where the family is in the workflow. The
breakdown lets callers (IS, FE) inspect WHY the family is in that state
without re-running the derivation themselves.
"""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


FamilyState = Literal[
    "pending",
    "to_be_verified",
    "waiting_for_addon_results",
    "verified",
    "published",
]


class AnalyteBreakdown(BaseModel):
    """Per-analyte facts that drove the family-state decision.

    `keyword` is the analyte (e.g. 'ENDO-LAL', 'IDENTITY_HPLC').
    `is_hplc` discriminates HPLC vs addon — drives waiting_for_addon_results.
    `parent_state` is the parent-tier row's review_state if one exists,
    else None. (Sourced from Mk1 lims_analyses OR legacy SENAITE.)
    `vial_states` is the multiset of vial-tier review_states for this
    analyte across all sub-samples — used to discriminate pending vs
    to_be_verified.
    """
    keyword: str
    is_hplc: bool
    parent_state: Optional[str] = None
    vial_states: List[str] = Field(default_factory=list)


class FamilyStateResponse(BaseModel):
    """`GET /api/families/{parent_sample_id}/state` response."""
    parent_sample_id: str
    state: FamilyState
    analytes: List[AnalyteBreakdown]
