"""Family-state derivation. Pure read function over lims_analyses + the
optional SENAITE proxy for legacy parent-AR analyses.

The function is intentionally split out from the route so it can be unit-
tested in isolation, called from Phase 5c event-emission paths, and
re-used by future FE consumers without re-implementing the rule.

Spec: docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md
§"Family state derivation" lines 175-203.
"""

from __future__ import annotations

from typing import Dict, List, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from families.schemas import AnalyteBreakdown, FamilyState, FamilyStateResponse
from models import LimsAnalysis, LimsSample, LimsSubSample


class SenaiteAnalysesReader(Protocol):
    """Same Protocol shape as coa.source_resolver — duck-typed."""
    async def list_for_sample(self, sample_id: str) -> List[Dict]:  # pragma: no cover
        ...


# ─── HPLC classifier ─────────────────────────────────────────────────────────

# Phase 5b heuristic: keywords starting with ENDO- or STER- are addons.
# Everything else is HPLC. This matches the Phase 2 seeder's role→keyword
# mapping: endo role seeds ENDO-LAL, ster role seeds STER-PCR, hplc role
# seeds the analyte-specific keywords (IDENTITY_*, BPC-*, etc).
# Phase 5c may switch to a service_group-based classifier if needed.
_ADDON_PREFIXES = ("ENDO-", "STER-")


def _is_hplc(keyword: str) -> bool:
    return not keyword.upper().startswith(_ADDON_PREFIXES)


# ─── Internal: gather per-analyte facts ──────────────────────────────────────


def _gather_analytes(
    db: Session,
    parent: LimsSample,
    senaite_parent_payload: List[Dict],
) -> Dict[str, AnalyteBreakdown]:
    """Build {keyword: AnalyteBreakdown} merging:
      - Mk1 parent-tier rows (parent.id, lims_sub_sample_pk IS NULL)
      - Mk1 vial-tier rows (parent.id, sub-samples)
      - SENAITE parent-AR analyses (legacy)

    For SENAITE-only analytes, parent_state comes from the SENAITE
    review_state. A Mk1 parent-tier row shadows SENAITE for the same
    keyword (Mk1 is the canonical source post-Phase-4).
    """
    breakdown: Dict[str, AnalyteBreakdown] = {}

    # Mk1 parent-tier rows
    parent_rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.reportable == True,  # noqa: E712
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalars().all()
    for r in parent_rows:
        breakdown[r.keyword] = AnalyteBreakdown(
            keyword=r.keyword,
            is_hplc=_is_hplc(r.keyword),
            parent_state=r.review_state,
            vial_states=[],
        )

    # Mk1 vial-tier rows (on sub-samples)
    sub_ids = [
        s.id for s in db.execute(
            select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
        ).scalars().all()
    ]
    if sub_ids:
        vial_rows = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sub_sample_pk.in_(sub_ids),
                LimsAnalysis.reportable == True,  # noqa: E712
                # Current vial row = retested IS False. retest_of_id IS NULL
                # would surface the superseded original's state once a vial
                # result is retested (P-0149 class). Parent-tier rows above keep
                # retest_of_id IS NULL — their canonical row updates in place.
                LimsAnalysis.retested.is_(False),
            )
        ).scalars().all()
        for r in vial_rows:
            ab = breakdown.setdefault(r.keyword, AnalyteBreakdown(
                keyword=r.keyword,
                is_hplc=_is_hplc(r.keyword),
                parent_state=None,
                vial_states=[],
            ))
            ab.vial_states.append(r.review_state)

    # SENAITE parent-AR analyses (legacy). Mk1 parent-tier row shadows.
    for an in senaite_parent_payload:
        kw = an.get("keyword")
        state = an.get("review_state")
        if not kw or not state:
            continue
        if kw in breakdown and breakdown[kw].parent_state is not None:
            # Mk1 parent-tier row already captured — SENAITE shadowed.
            continue
        ab = breakdown.setdefault(kw, AnalyteBreakdown(
            keyword=kw,
            is_hplc=_is_hplc(kw),
            parent_state=None,
            vial_states=[],
        ))
        # SENAITE-derived parent_state. Treat 'verified' / 'published' as
        # parent-tier-equivalent for this analyte (transition-window rule).
        ab.parent_state = state

    return breakdown


# ─── Derivation: apply the precedence ladder ─────────────────────────────────


_PARENT_SETTLED = ("verified", "published")
_VIAL_PENDING = ("unassigned", "assigned")


def _derive_state(analytes: Dict[str, AnalyteBreakdown]) -> FamilyState:
    """Apply the spec's precedence ladder. Earliest match wins.

    If `analytes` is empty (no rows anywhere for this family), the family
    is `pending` — nothing has happened yet.
    """
    if not analytes:
        return "pending"

    def is_settled(ab: AnalyteBreakdown) -> bool:
        return ab.parent_state in _PARENT_SETTLED

    def is_published(ab: AnalyteBreakdown) -> bool:
        return ab.parent_state == "published"

    def has_pending_vial(ab: AnalyteBreakdown) -> bool:
        return any(v in _VIAL_PENDING for v in ab.vial_states)

    def has_to_be_verified_vial(ab: AnalyteBreakdown) -> bool:
        return any(v == "to_be_verified" for v in ab.vial_states)

    # Rule 1: pending — any unsettled analyte has unassigned/assigned vial
    for ab in analytes.values():
        if not is_settled(ab) and has_pending_vial(ab):
            return "pending"

    # Rule 2: to_be_verified — any unsettled analyte has to_be_verified vial
    for ab in analytes.values():
        if not is_settled(ab) and has_to_be_verified_vial(ab):
            return "to_be_verified"

    # Rule 3: waiting_for_addon_results — every HPLC settled AND any addon unsettled
    hplc_settled = all(
        is_settled(ab) for ab in analytes.values() if ab.is_hplc
    )
    has_unsettled_addon = any(
        not is_settled(ab) for ab in analytes.values() if not ab.is_hplc
    )
    has_any_hplc = any(ab.is_hplc for ab in analytes.values())
    if has_any_hplc and hplc_settled and has_unsettled_addon:
        return "waiting_for_addon_results"

    # Rule 4 / 5: verified vs published — every analyte settled
    if all(is_settled(ab) for ab in analytes.values()):
        if all(is_published(ab) for ab in analytes.values()):
            return "published"
        return "verified"

    # Fallback: any unsettled analyte with no vial activity → pending
    # (e.g. an addon row exists at the SENAITE level but no Mk1 vials yet).
    return "pending"


# ─── Public ──────────────────────────────────────────────────────────────────


class FamilyNotFoundError(LookupError):
    """Raised when no parent + no SENAITE candidates exist for the given id."""


async def derive_family_state(
    db: Session,
    parent_sample_id: str,
    senaite_reader: SenaiteAnalysesReader,
) -> FamilyStateResponse:
    """Compute family state for a parent_sample_id.

    Raises FamilyNotFoundError if the parent has no Mk1 row AND the
    SENAITE reader returns nothing — we can't infer state for a family
    we've never heard of.
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()

    senaite_payload: List[Dict] = await senaite_reader.list_for_sample(parent_sample_id)

    if parent is None and not senaite_payload:
        raise FamilyNotFoundError(
            f"no parent {parent_sample_id!r} in lims_samples and no SENAITE analyses"
        )

    if parent is None:
        # SENAITE-only: build breakdown directly from the SENAITE payload.
        analytes: Dict[str, AnalyteBreakdown] = {}
        for an in senaite_payload:
            kw = an.get("keyword")
            state = an.get("review_state")
            if not kw:
                continue
            analytes[kw] = AnalyteBreakdown(
                keyword=kw,
                is_hplc=_is_hplc(kw),
                parent_state=state,
                vial_states=[],
            )
    else:
        analytes = _gather_analytes(db, parent, senaite_payload)

    state = _derive_state(analytes)
    return FamilyStateResponse(
        parent_sample_id=parent_sample_id,
        state=state,
        analytes=sorted(analytes.values(), key=lambda a: a.keyword),
    )
