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
    out: Dict[str, List[CandidateInfo]] = {}
    for an in reader_payload.get(sample_id, []):
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
        if c.reportable and c.state in ("verified", "published")
    ]

    if not eligible:
        return SourceDecision(
            analyte_keyword=analyte_keyword,
            mode="auto",
            chosen=None,
            candidates=candidates,
            blocked="missing",
            blocked_detail=(
                f"no reportable verified result for {analyte_keyword!r} "
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
                "no longer matches a reportable verified candidate"
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
            f"{len(eligible)} reportable verified candidates for "
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
            LimsAnalysis.review_state.in_(("verified", "published")),
            LimsAnalysis.reportable == True,  # noqa: E712 — SQL equality
            LimsAnalysis.retest_of_id.is_(None),
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


# ─── Orchestration ───────────────────────────────────────────────────────────


async def resolve_sources(
    parent_sample_id: str,
    db: Session,
    senaite_reader: SenaiteAnalysesReader,
) -> ResolverResult:
    """
    Gather candidates for the parent + every linked sub-sample, then apply
    the per-analyte decision rule.
    """
    # 1. Load parent + sub-samples from Mk1 DB to know what ARs to fetch.
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()

    sample_ids: List[str] = [parent_sample_id]
    is_parent_lookup: Dict[str, bool] = {parent_sample_id: True}
    variance_lookup: Dict[str, bool] = {
        parent_sample_id: bool(parent.in_variance_set) if parent else True
    }
    if parent:
        subs = db.execute(
            select(LimsSubSample).where(
                LimsSubSample.parent_sample_pk == parent.id
            )
        ).scalars().all()
        for s in subs:
            sample_ids.append(s.sample_id)
            is_parent_lookup[s.sample_id] = False
            variance_lookup[s.sample_id] = bool(s.in_variance_set)

    # 2. Pull analyses for every AR in one round-trip per AR. (Future: bulk
    #    endpoint on the senaite_reader; not premature for Phase 1.)
    reader_payload: Dict[str, List[Dict]] = {}
    for sid in sample_ids:
        reader_payload[sid] = await senaite_reader.list_for_sample(sid)

    # 3. Build candidate map (analyte_keyword -> list[CandidateInfo]) from
    #    every AR's analyses, merging by analyte across ARs.
    merged: Dict[str, List[CandidateInfo]] = {}
    for sid in sample_ids:
        per_ar = _gather_candidates_for(
            sample_id=sid,
            is_parent_ar=is_parent_lookup[sid],
            reader_payload=reader_payload,
            in_variance_set=variance_lookup[sid],
        )
        for kw, cs in per_ar.items():
            merged.setdefault(kw, []).extend(cs)

    # 4. Stamp reportable from the Mk1 sidecar.
    merged = _apply_reportable(db, merged)

    # 5. Decision rule per analyte.
    decisions: List[SourceDecision] = []
    for kw, cs in merged.items():
        decisions.append(_resolve_analyte(kw, cs, db, parent_sample_id))

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
            })
        return out
