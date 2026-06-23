"""
COA source resolver. Pure function: given a parent sample and a DB session,
returns one SourceDecision per analyte the parent's order requires. Reads
SENAITE for analysis data; reads Mk1 DB for pins + reportable flags +
sub-sample linkage.

Layering (top-down):
  resolve_sources      — orchestration (async)
  _gather_candidates_for — read one AR's analyses into CandidateInfo
  _apply_reportable    — bulk-lookup Mk1 reportable sidecar
  _resolve_analyte     — apply the decision rule per analyte

See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
"""

from __future__ import annotations

from typing import Dict, List, Optional, Protocol, Set, Tuple

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.schemas import (
    CandidateInfo,
    ResolvedSource,
    ResolverResult,
    SourceDecision,
)
from models import (
    AnalysisReportable,
    CoaResultPin,
    LimsSample,
    LimsSubSample,
)

# Analyte review states that carry a usable (live) result.
# Retracted / rejected / invalid / no-result states are intentionally absent.
_LIVE_RESULT_STATES = ("submitted", "to_be_verified", "verified", "published")


class SenaiteAnalysesReader(Protocol):
    """
    Read interface for SENAITE analyses. The resolver doesn't care HOW the
    analyses are fetched — production wires it to the live SENAITE httpx
    client; tests inject a fake. Returns dicts with at least:
      { 'uid': str, 'keyword': str, 'result': str | None,
        'unit': str | None, 'review_state': str }
    """
    async def list_for_sample(self, sample_id: str) -> List[Dict]:  # pragma: no cover
        ...


# ─── Internal helpers ────────────────────────────────────────────────────────


def _gather_candidates_for(
    sample_id: str,
    is_parent_ar: bool,
    reader_payload: Dict[str, List[Dict]],
    in_variance_set: bool,
) -> Dict[str, List[CandidateInfo]]:
    """
    Build an `analyte_keyword -> [CandidateInfo]` map from one AR's analyses.
    `reader_payload[sample_id]` is the SENAITE analyses list for that AR.
    """
    analyses = reader_payload.get(sample_id, [])
    # A retest supersedes its original: any analysis whose UID is the target of
    # another analysis's `retest_of_uid` has been retested and must NOT be a COA
    # candidate. This uses SENAITE's authoritative retest link (getRetestOfUID) —
    # the same relationship the analyses view honors — so a verified-but-
    # superseded original (e.g. P-0895's pre-subsample retests, both left in
    # SENAITE 'verified') drops out instead of forcing a spurious needs_decision.
    superseded_uids = {
        an.get("retest_of_uid") for an in analyses if an.get("retest_of_uid")
    }
    out: Dict[str, List[CandidateInfo]] = {}
    for an in analyses:
        if an.get("uid") in superseded_uids:
            continue
        kw = an.get("keyword")
        if not kw:
            continue
        out.setdefault(kw, []).append(
            CandidateInfo(
                source_sample_id=sample_id,
                source_analysis_uid=an["uid"],
                value=an.get("result"),
                unit=an.get("unit"),
                state=an.get("review_state", ""),
                # Default TRUE; _apply_reportable stamps the real value from
                # the Mk1 sidecar for any candidate that has a row.
                reportable=True,
                in_variance_set=in_variance_set,
                is_parent_ar=is_parent_ar,
            )
        )
    return out


def _apply_reportable(
    db: Session,
    candidates_by_analyte: Dict[str, List[CandidateInfo]],
) -> Dict[str, List[CandidateInfo]]:
    """
    Look up the Mk1 reportable sidecar for every candidate and stamp the
    `.reportable` field. Absence of a row means reportable=True (default).
    """
    keys: Set[Tuple[str, str]] = {
        (c.source_sample_id, c.source_analysis_uid)
        for cs in candidates_by_analyte.values()
        for c in cs
    }
    if not keys:
        return candidates_by_analyte

    # Bulk fetch. The sidecar is small (only flipped instances have rows).
    rows = db.execute(
        select(
            AnalysisReportable.sample_id,
            AnalysisReportable.analysis_uid,
            AnalysisReportable.reportable,
        )
    ).all()
    reportable_lookup: Dict[Tuple[str, str], bool] = {
        (r.sample_id, r.analysis_uid): r.reportable for r in rows
    }
    for cs in candidates_by_analyte.values():
        for c in cs:
            key = (c.source_sample_id, c.source_analysis_uid)
            if key in reportable_lookup:
                c.reportable = reportable_lookup[key]
    return candidates_by_analyte


def _resolve_analyte(
    analyte_keyword: str,
    candidates: List[CandidateInfo],
    db: Session,
    parent_sample_id: str,
) -> SourceDecision:
    """
    Apply the resolution rule for one analyte. Decision flow:
      0 reportable+verified candidates -> blocked='missing'
      1 reportable+verified candidate  -> mode='auto'
      >1 reportable+verified, pinned   -> mode='pin' if pin matches a live candidate;
                                          else blocked='stale_pin'
      >1 reportable+verified, no pin   -> blocked='needs_decision'

    Variance-set mode is NOT implemented in Phase 1 — that's Phase 5.
    """
    eligible = [
        c for c in candidates
        if c.reportable
        and c.state in _LIVE_RESULT_STATES
        and c.value not in (None, "")
    ]

    if not eligible:
        return SourceDecision(
            analyte_keyword=analyte_keyword,
            mode="auto",
            chosen=None,
            candidates=candidates,
            blocked="missing",
            blocked_detail=(
                f"no reportable result for {analyte_keyword!r} "
                "across parent + sub-samples"
            ),
        )

    if len(eligible) == 1:
        c = eligible[0]
        return SourceDecision(
            analyte_keyword=analyte_keyword,
            mode="auto",
            chosen=ResolvedSource(
                source_sample_id=c.source_sample_id,
                source_analysis_uid=c.source_analysis_uid,
                value=c.value,
                unit=c.unit,
            ),
            candidates=candidates,
            blocked=None,
        )

    # > 1 eligible — consult pins.
    pin = db.execute(
        select(CoaResultPin).where(
            CoaResultPin.parent_sample_id == parent_sample_id,
            CoaResultPin.analyte_keyword == analyte_keyword,
        )
    ).scalar_one_or_none()

    if pin and pin.mode == "pin" and pin.source_sample_id and pin.source_analysis_uid:
        match = next(
            (c for c in eligible
             if c.source_sample_id == pin.source_sample_id
             and c.source_analysis_uid == pin.source_analysis_uid),
            None,
        )
        if match:
            return SourceDecision(
                analyte_keyword=analyte_keyword,
                mode="pin",
                chosen=ResolvedSource(
                    source_sample_id=match.source_sample_id,
                    source_analysis_uid=match.source_analysis_uid,
                    value=match.value,
                    unit=match.unit,
                ),
                candidates=candidates,
                blocked=None,
            )
        # Pin exists but no live candidate matches.
        return SourceDecision(
            analyte_keyword=analyte_keyword,
            mode="auto",
            chosen=None,
            candidates=candidates,
            blocked="stale_pin",
            blocked_detail=(
                f"pin on {pin.source_sample_id}/{pin.source_analysis_uid} "
                "no longer matches a reportable live candidate"
            ),
        )

    # >1 eligible, no actionable pin -> human decision required.
    return SourceDecision(
        analyte_keyword=analyte_keyword,
        mode="auto",
        chosen=None,
        candidates=candidates,
        blocked="needs_decision",
        blocked_detail=(
            f"{len(eligible)} reportable live candidates for "
            f"{analyte_keyword!r}; pick one via the COA Sources panel"
        ),
    )


def _resolve_mk1_parent_tier(
    db: Session,
    parent: LimsSample,
) -> Dict[str, SourceDecision]:
    """Phase 5a: read parent-tier verified rows directly from lims_analyses.

    These rows ARE the canonical results — the supervisor already chose them
    at verification time via promote_to_parent. One SourceDecision per row,
    mode='auto', keyed by analyte_keyword for the merge layer.

    Filters:
      lims_sample_pk = parent.id
      review_state IN ('verified', 'published')
      reportable = TRUE
      retest_of_id IS NULL  (canonical, not a retest sibling)

    Sub-sample rows are intentionally not queried — they fed into the parent
    row at promote time; reading them again would re-introduce the Phase 1
    multi-candidate decision the two-tier model eliminates.
    """
    from models import LimsAnalysis

    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.review_state.in_(_LIVE_RESULT_STATES),
            LimsAnalysis.reportable == True,  # noqa: E712 — SQL equality
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.result_value.isnot(None),
            LimsAnalysis.result_value != "",
        )
    ).scalars().all()

    decisions: Dict[str, SourceDecision] = {}
    for r in rows:
        uid = f"mk1:{r.id}"
        candidate = CandidateInfo(
            source_sample_id=parent.sample_id,
            source_analysis_uid=uid,
            value=r.result_value,
            unit=r.result_unit,
            state=r.review_state,
            reportable=True,
            in_variance_set=False,
            is_parent_ar=True,
        )
        decisions[r.keyword] = SourceDecision(
            analyte_keyword=r.keyword,
            mode="auto",
            chosen=ResolvedSource(
                source_sample_id=parent.sample_id,
                source_analysis_uid=uid,
                value=r.result_value,
                unit=r.result_unit,
            ),
            candidates=[candidate],
            blocked=None,
        )
    return decisions


def _apply_pin_override(
    db: Session,
    parent_sample_id: str,
    analyte_keyword: str,
    base: SourceDecision,
) -> SourceDecision:
    """Phase 5a: layer admin pin overrides on top of a Mk1-or-SENAITE base.

    Decision matrix (given a base decision already computed):
      no pin row                  → return base unchanged
      pin.mode != 'pin'           → return base unchanged (treat as 'auto')
      pin source matches base     → mode='pin' (override credited but same value)
      pin source matches another  → mode='pin' with the pinned candidate's value
        live candidate in base       (Mk1 row lookup or SENAITE candidate match)
      pin source no longer valid  → blocked='stale_pin'

    For pins targeting a Mk1 row (uid like 'mk1:N'), we look up the row by
    id and verify it's still verified/published + reportable + non-retest.
    For SENAITE-side pins (32-char hex uid), we match against the base's
    candidates list (which carries SENAITE candidates when the base came
    from _resolve_analyte).
    """
    pin = db.execute(
        select(CoaResultPin).where(
            CoaResultPin.parent_sample_id == parent_sample_id,
            CoaResultPin.analyte_keyword == analyte_keyword,
        )
    ).scalar_one_or_none()
    if pin is None or pin.mode != "pin":
        return base
    if not (pin.source_sample_id and pin.source_analysis_uid):
        return base

    pin_uid = pin.source_analysis_uid
    pin_sid = pin.source_sample_id

    # Mk1 pin path: look up the lims_analyses row directly.
    if pin_uid.startswith("mk1:"):
        from models import LimsAnalysis
        try:
            row_id = int(pin_uid[len("mk1:"):])
        except ValueError:
            return base.model_copy(update={
                "blocked": "stale_pin",
                "blocked_detail": (
                    f"pin source_analysis_uid {pin_uid!r} is not a parseable mk1 id"
                ),
                "chosen": None,
            })
        row = db.get(LimsAnalysis, row_id)
        if (
            row is None
            or row.review_state not in _LIVE_RESULT_STATES
            or not row.reportable
            or row.retest_of_id is not None
            or row.keyword != analyte_keyword
            or row.result_value in (None, "")
        ):
            return base.model_copy(update={
                "blocked": "stale_pin",
                "blocked_detail": (
                    f"pin on {pin_sid}/{pin_uid} no longer matches a "
                    "reportable live parent-tier row"
                ),
                "chosen": None,
            })
        return base.model_copy(update={
            "mode": "pin",
            "blocked": None,
            "blocked_detail": None,
            "chosen": ResolvedSource(
                source_sample_id=pin_sid,
                source_analysis_uid=pin_uid,
                value=row.result_value,
                unit=row.result_unit,
            ),
        })

    # SENAITE pin path: match the pinned (sample_id, uid) against base.candidates.
    # base.candidates always carries the candidates the base decision considered
    # (Mk1 path stamps one synthetic candidate; SENAITE path carries the real
    # SENAITE candidates).
    match = next(
        (c for c in base.candidates
         if c.source_sample_id == pin_sid
         and c.source_analysis_uid == pin_uid
         and c.reportable
         and c.state in _LIVE_RESULT_STATES
         and c.value not in (None, "")),
        None,
    )
    if match is None:
        return base.model_copy(update={
            "blocked": "stale_pin",
            "blocked_detail": (
                f"pin on {pin_sid}/{pin_uid} no longer matches a "
                "reportable live candidate"
            ),
            "chosen": None,
        })
    return base.model_copy(update={
        "mode": "pin",
        "blocked": None,
        "blocked_detail": None,
        "chosen": ResolvedSource(
            source_sample_id=pin_sid,
            source_analysis_uid=pin_uid,
            value=match.value,
            unit=match.unit,
        ),
    })


# ─── Orchestration ───────────────────────────────────────────────────────────


async def resolve_sources(
    parent_sample_id: str,
    db: Session,
    senaite_reader: SenaiteAnalysesReader,
) -> ResolverResult:
    """
    Phase 5a: Mk1-first dispatch. Resolution precedence per analyte is:
      1. Pin override (admin path)         → mode='pin' or blocked='stale_pin'
      2. Mk1 parent-tier verified row      → mode='auto' (the happy path)
      3. SENAITE-side parent AR candidate  → existing _resolve_analyte rules
      4. None of the above                 → analyte simply isn't in decisions

    Sub-sample SENAITE ARs are no longer queried — Phase 4a moved their
    decisions into parent-tier rows via promote_to_parent. The supervisor's
    decision is recorded once at promote time, not re-derived per COA gen.
    """
    # 1. Load parent from Mk1 DB.
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()

    # If the parent doesn't exist in Mk1, the SENAITE reader can still
    # surface candidates — fall through with no Mk1 layer.
    mk1_decisions: Dict[str, SourceDecision] = (
        _resolve_mk1_parent_tier(db, parent) if parent else {}
    )

    # 2. Pull SENAITE analyses for the parent AR only. Subs no longer fetched.
    reader_payload: Dict[str, List[Dict]] = {
        parent_sample_id: await senaite_reader.list_for_sample(parent_sample_id)
    }

    # 3. Build SENAITE candidate map (parent AR only).
    senaite_candidates: Dict[str, List[CandidateInfo]] = _gather_candidates_for(
        sample_id=parent_sample_id,
        is_parent_ar=True,
        reader_payload=reader_payload,
        in_variance_set=(bool(parent.in_variance_set) if parent else True),
    )
    senaite_candidates = _apply_reportable(db, senaite_candidates)

    # 4. Merge: every analyte that has a Mk1 row OR a SENAITE candidate.
    all_keywords = set(mk1_decisions.keys()) | set(senaite_candidates.keys())
    decisions: List[SourceDecision] = []
    for kw in sorted(all_keywords):
        # Decide the base (no-pin) decision:
        if kw in mk1_decisions:
            base = mk1_decisions[kw]
        else:
            # Fall through to the legacy decision rule for SENAITE-only analytes.
            base = _resolve_analyte(kw, senaite_candidates[kw], db, parent_sample_id)
        # Layer pin override on top. _apply_pin_override may rewrite mode to
        # 'pin' or 'stale_pin'; otherwise returns base unchanged.
        decisions.append(_apply_pin_override(db, parent_sample_id, kw, base))

    return ResolverResult(
        parent_sample_id=parent_sample_id,
        decisions=decisions,
    )


# ─── Production SENAITE adapter ──────────────────────────────────────────────


class SenaiteAnalysesHttpReader:
    """
    Production adapter — uses an httpx async client to hit SENAITE's
    Analysis endpoint per sample. The resolver receives an instance; tests
    inject a fake satisfying `SenaiteAnalysesReader`.
    """

    def __init__(self, base_url: str, auth, timeout: float = 30.0):
        self._base_url = base_url.rstrip("/")
        self._auth = auth
        self._timeout = timeout

    async def list_for_sample(self, sample_id: str) -> List[Dict]:
        url = f"{self._base_url}/senaite/@@API/senaite/v1/Analysis"
        params = {"getRequestID": sample_id, "complete": "yes", "limit": 200}
        async with httpx.AsyncClient(
            timeout=self._timeout, auth=self._auth, follow_redirects=True,
        ) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
        items = data.get("items", []) or []
        out: List[Dict] = []
        for it in items:
            out.append({
                "uid": it.get("uid"),
                "keyword": it.get("getKeyword") or it.get("Keyword"),
                "result": it.get("Result"),
                "unit": it.get("Unit"),
                "review_state": it.get("review_state"),
                # SENAITE retest link: a non-empty getRetestOfUID / RetestOf.uid
                # means THIS analysis is a retest of that UID (which is therefore
                # superseded). Captured so _gather_candidates_for can drop the
                # superseded original from COA candidates.
                "retest_of_uid": (
                    it.get("getRetestOfUID")
                    or (it.get("RetestOf") or {}).get("uid")
                    or None
                ),
            })
        return out
