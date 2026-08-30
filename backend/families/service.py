"""Family-state derivation. Pure read function over lims_analyses + the
optional SENAITE proxy for legacy parent-AR analyses.

The function is intentionally split out from the route so it can be unit-
tested in isolation, called from Phase 5c event-emission paths, and
re-used by future FE consumers without re-implementing the rule.

Spec: docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md
§"Family state derivation" lines 175-203.
"""

from __future__ import annotations

import logging
from typing import Callable, Dict, List, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from families.schemas import AnalyteBreakdown, FamilyState, FamilyStateResponse
from models import LimsAnalysis, LimsSample, LimsSubSample

_log = logging.getLogger(__name__)


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


def _build_hplc_classifier(db: Session) -> Callable[[str], bool]:
    """Catalog-first is_hplc classifier, built once per family-state
    computation (never per-row).

    A keyword's catalog department wins when the keyword is known to the
    catalog: Analytical -> HPLC, anything else (Microbiology, Heavy Metals,
    future departments) -> addon. This is what makes a brand-new catalog
    family (e.g. an HM-* keyword under Heavy Metals) classify as addon
    without a code change. `_is_hplc`'s prefix rule is the fallback for
    keywords the catalog doesn't know about (SENAITE-legacy rows, unknowns).

    The query below INNER JOINs Department, so a mk1 AnalysisService with a
    NULL department_id is invisible to catalog_map and falls back to the
    prefix rule BY DESIGN — flagging department-less mk1 services is the
    demand-catalog verify's follow-up territory (S9), not this classifier's.
    """
    from catalog.departments import ANALYTICAL_DEPARTMENT
    from models import AnalysisService, Department

    # AnalysisService.keyword carries no unique constraint (the mk1 keyword
    # unique index is PARTIAL on origin='mk1' — senaite-origin duplicates
    # exist legitimately), so the SAME keyword string can legally appear
    # under two different departments. Resolve deterministically to the
    # lowest AnalysisService.id — the same precedent
    # lims_analyses/parent_mirror.py:resolve_shadow_target and
    # lims_analyses/service.py:88,125 use (`.order_by(AnalysisService.id)`
    # before taking the first match) — via first-wins over an id-ordered
    # scan below, rather than leaving this execution-plan-dependent.
    rows = db.execute(
        select(AnalysisService.keyword, Department.name)
        .join(Department, AnalysisService.department_id == Department.id)
        .where(AnalysisService.keyword.isnot(None))
        .order_by(AnalysisService.id)
    ).all()
    catalog_map: Dict[str, bool] = {}
    for keyword, dept_name in rows:
        upper_kw = keyword.upper()
        if upper_kw in catalog_map:
            continue  # lowest-id row already claimed this keyword
        catalog_map[upper_kw] = (dept_name == ANALYTICAL_DEPARTMENT)

    def classify(keyword: str) -> bool:
        catalog_hit = catalog_map.get(keyword.upper())
        if catalog_hit is not None:
            return catalog_hit
        return _is_hplc(keyword)

    return classify


# ─── Internal: gather per-analyte facts ──────────────────────────────────────


def _gather_analytes(
    db: Session,
    parent: LimsSample,
    senaite_parent_payload: List[Dict],
    is_hplc: Callable[[str], bool] = _is_hplc,
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
            # SENAITE phase-out fail-closed: this query carries NO review_state
            # filter, so without this clause a SENAITE-mirror SHADOW row (sentinel
            # review_state='senaite_mirror') would surface here with a fabricated
            # parent_state — the MANDATORY filter for this reader (see
            # docs/superpowers/sdd/task-7-brief.md).
            LimsAnalysis.provenance == "canonical",
        )
    ).scalars().all()
    for r in parent_rows:
        breakdown[r.keyword] = AnalyteBreakdown(
            keyword=r.keyword,
            is_hplc=is_hplc(r.keyword),
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
                is_hplc=is_hplc(r.keyword),
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
        # Review 2026-08-29 finding 3: honour an explicit de-selection.
        # In mk1 mode this payload comes from ShadowAnalysesReader, which
        # carries the row's own `reportable`; without this a canonical row
        # the Mk1 leg above correctly dropped (reportable == True filter)
        # re-entered here and stamped parent_state, letting a result the
        # lab excluded drive family state. The SENAITE HTTP reader never
        # emits the key, so absence still means reportable — senaite mode
        # is byte-identical.
        if not an.get("reportable", True):
            continue
        if kw in breakdown and breakdown[kw].parent_state is not None:
            # Mk1 parent-tier row already captured — SENAITE shadowed.
            continue
        ab = breakdown.setdefault(kw, AnalyteBreakdown(
            keyword=kw,
            is_hplc=is_hplc(kw),
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
        # 'parent_to_verify' (the promoted-parent-awaiting-sign-off state)
        # counts as to-be-verified work here too — mirrors the read-flip
        # collapse in workflow/engine.py's _live_parent_line_states. Without
        # this, a promote (source vial -> 'promoted', parent -> non-vial
        # 'parent_to_verify') has no vial in 'to_be_verified' and no settled
        # parent_state, so the family would fall through to the Rule 4/5
        # fallback and regress backward to 'pending' post-promote.
        return (
            any(v == "to_be_verified" for v in ab.vial_states)
            or ab.parent_state == "parent_to_verify"
        )

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

    # Review 2026-08-29 finding 5: ShadowAnalysesReader is FAIL-CLOSED — it
    # raises on a row with no resolvable review_state (a shadow row whose
    # mirror_review_state is NULL). That contract was written for COA
    # generation, whose caller has its own fail-open catch; here it would
    # surface as a bare HTTP 500 and take out the family panel for a sample
    # that senaite mode reported on fine. Family state is a display
    # derivation, not a certificate: degrade to the Mk1-only view (and, when
    # there is no parent row either, the existing not-found error) rather
    # than failing the request.
    try:
        senaite_payload: List[Dict] = await senaite_reader.list_for_sample(
            parent_sample_id
        )
    except Exception as e:  # noqa: BLE001 — display path, never fatal
        _log.warning(
            "family-state reader failed for %s (%s: %s) — deriving from Mk1 rows only",
            parent_sample_id, e.__class__.__name__, e,
        )
        senaite_payload = []

    if parent is None and not senaite_payload:
        raise FamilyNotFoundError(
            f"no parent {parent_sample_id!r} in lims_samples and no SENAITE analyses"
        )

    # Built once per computation (never per-row) and threaded into both
    # branches below, so a single catalog query backs the whole response.
    is_hplc = _build_hplc_classifier(db)

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
                is_hplc=is_hplc(kw),
                parent_state=state,
                vial_states=[],
            )
    else:
        analytes = _gather_analytes(db, parent, senaite_payload, is_hplc)

    state = _derive_state(analytes)
    return FamilyStateResponse(
        parent_sample_id=parent_sample_id,
        state=state,
        analytes=sorted(analytes.values(), key=lambda a: a.keyword),
    )
