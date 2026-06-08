"""
Service layer for lims_analyses.

All DB writes go through here. Every state change writes a
LimsAnalysisTransition audit row in the same DB transaction as the
LimsAnalysis update — the two stay consistent or both roll back.

Service functions raise typed exceptions (NotFoundError, BadRequestError,
plus the state-machine exceptions re-exported from state_machine.py).
The route layer translates them to HTTP responses.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.orm import Session

from lims_analyses.state_machine import (
    InvalidTransitionError,
    TierMismatchError,
    is_terminal,
    next_state,
    tier_allows,
    tier_of,
)
from models import LimsAnalysis, LimsAnalysisTransition, LimsSubSampleEvent


# ─── Typed exceptions ────────────────────────────────────────────────────────


class NotFoundError(LookupError):
    """Analysis (or related entity) not found."""


class BadRequestError(ValueError):
    """Request is structurally OK but semantically invalid (e.g. missing
    result on submit). Distinct from state-machine errors which are about
    the (from_state, kind) edge."""


# ─── Reads ───────────────────────────────────────────────────────────────────


def get_analysis(db: Session, analysis_id: int) -> LimsAnalysis:
    row = db.get(LimsAnalysis, analysis_id)
    if row is None:
        raise NotFoundError(f"lims_analysis id={analysis_id} not found")
    return row


def list_analyses_for_host(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    include_retests: bool = True,
) -> List[LimsAnalysis]:
    """List analyses attached to a single host. Retests included by default;
    set include_retests=False to filter to the current (non-retest) rows
    that drive the AnalysisTable view."""
    if host_kind == "sample":
        stmt = select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == host_pk)
    elif host_kind == "sub_sample":
        stmt = select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == host_pk)
    else:
        raise BadRequestError(f"invalid host_kind={host_kind!r}")
    if not include_retests:
        stmt = stmt.where(LimsAnalysis.retest_of_id.is_(None))
    return list(db.execute(stmt.order_by(LimsAnalysis.keyword, LimsAnalysis.id)).scalars().all())


# ─── Creation ────────────────────────────────────────────────────────────────


def create_analysis(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    analysis_service_id: int,
    keyword: str,
    title: str,
    result_value: Optional[str] = None,
    result_unit: Optional[str] = None,
    method_id: Optional[int] = None,
    instrument_id: Optional[int] = None,
    created_by_user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Insert a new lims_analyses row in state='unassigned'. Writes the
    initial audit row (from_state=NULL, to_state='unassigned',
    transition_kind='auto')."""
    if host_kind == "sample":
        lims_sample_pk, lims_sub_sample_pk = host_pk, None
    elif host_kind == "sub_sample":
        lims_sample_pk, lims_sub_sample_pk = None, host_pk
    else:
        raise BadRequestError(f"invalid host_kind={host_kind!r}")

    row = LimsAnalysis(
        lims_sample_pk=lims_sample_pk,
        lims_sub_sample_pk=lims_sub_sample_pk,
        analysis_service_id=analysis_service_id,
        keyword=keyword,
        title=title,
        result_value=result_value,
        result_unit=result_unit,
        review_state="unassigned",
        method_id=method_id,
        instrument_id=instrument_id,
        created_by_user_id=created_by_user_id,
    )
    db.add(row)
    db.flush()  # populate row.id before writing the audit log

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=None,
        to_state="unassigned",
        transition_kind="auto",
        user_id=created_by_user_id,
        reason="initial insert",
    ))
    db.commit()
    db.refresh(row)
    return row


# ─── Transitions ─────────────────────────────────────────────────────────────


def apply_transition(
    db: Session,
    *,
    analysis_id: int,
    kind: str,
    result_value: Optional[str] = None,
    reason: Optional[str] = None,
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """
    Validate (from_state, kind) via the state machine, apply the
    state change, update timestamps, write the audit row, commit.

    Semantic guards beyond the state machine:
      - 'submit' requires a result_value (either already on the row or
        supplied in this call).
      - 'verify' requires the row to already carry a result_value.
    """
    row = get_analysis(db, analysis_id)
    from_state = row.review_state

    if is_terminal(from_state):
        # State machine will also reject this, but we surface a clearer
        # message: "this analysis is closed" rather than "kind not allowed".
        raise InvalidTransitionError(
            from_state, kind,
            message=f"analysis is in terminal state {from_state!r}; no transitions allowed",
        )

    # Tier guard. Vial-tier rows can't publish; parent-tier rows can't accept
    # assign/submit. The state machine's tier-aware next_state() raises
    # TierMismatchError on a violation — surfaced as 409 by the route layer.
    row_tier = tier_of(
        lims_sample_pk=row.lims_sample_pk,
        lims_sub_sample_pk=row.lims_sub_sample_pk,
        review_state=from_state,
    )

    # ── retest branch ────────────────────────────────────────────────────────
    # Retest is NOT a regular state transition. It creates a new linked row,
    # sets old.retested=True, writes audit on the old row, and returns the
    # NEW row — all in one transaction. Only legal on vial-tier rows from
    # 'to_be_verified' or 'verified'.
    if kind == "retest":
        if not tier_allows(row_tier, "retest"):
            raise TierMismatchError(row_tier, kind)
        if from_state not in ("to_be_verified", "verified", "promoted"):
            raise InvalidTransitionError(from_state, kind)

        now = datetime.utcnow()

        new_row = LimsAnalysis(
            lims_sample_pk=row.lims_sample_pk,
            lims_sub_sample_pk=row.lims_sub_sample_pk,
            analysis_service_id=row.analysis_service_id,
            keyword=row.keyword,
            title=row.title,
            result_value=None,
            result_unit=row.result_unit,
            review_state="unassigned",
            retest_of_id=row.id,
            created_by_user_id=user_id,
        )
        db.add(new_row)
        db.flush()  # populate new_row.id before audit rows

        # Audit on the new row (mirrors create_analysis initial audit)
        db.add(LimsAnalysisTransition(
            analysis_id=new_row.id,
            from_state=None,
            to_state="unassigned",
            transition_kind="auto",
            user_id=user_id,
            reason="initial insert",
        ))

        # Mark old row as retested + write audit on old row
        row.retested = True
        row.updated_at = now
        db.add(LimsAnalysisTransition(
            analysis_id=row.id,
            from_state=from_state,
            to_state=from_state,
            transition_kind="retest",
            user_id=user_id,
            reason=(
                f"retested: new analysis #{new_row.id}"
                + (f"; {reason}" if reason else "")
            ),
        ))

        db.commit()
        db.refresh(new_row)
        return new_row
    # ── end retest branch ────────────────────────────────────────────────────

    to_state = next_state(from_state, kind, tier=row_tier)

    # Semantic guards
    if kind == "submit":
        # Accept inline result_value as the submitted result.
        if result_value is not None:
            row.result_value = result_value
        if not row.result_value:
            raise BadRequestError(
                "submit requires a result_value (either pre-existing on the "
                "row or supplied in this request)"
            )
    elif kind == "verify":
        if not row.result_value:
            raise BadRequestError("verify requires a result_value on the row")
    elif kind == "reset":
        # Clear any draft result + provenance on the way back to unassigned.
        row.result_value = None
        row.result_unit = None
        row.method_id = None
        row.instrument_id = None
        row.captured_at = None
        row.submitted_at = None
    elif kind == "retract":
        # Clear timestamps from the verified attempt; the row is now an
        # auditable record of "this attempt was retracted." A new attempt
        # (retest) is a separate row pointing here via retest_of_id.
        row.verified_at = None

    now = datetime.utcnow()

    # Timestamp markers per state.
    if to_state == "to_be_verified":
        row.submitted_at = row.submitted_at or now
        if not row.captured_at:
            row.captured_at = now
    elif to_state == "verified":
        row.verified_at = now
    elif to_state == "published":
        row.published_at = now

    row.review_state = to_state
    row.updated_at = now

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=from_state,
        to_state=to_state,
        transition_kind=kind,
        user_id=user_id,
        reason=reason,
    ))
    db.commit()
    db.refresh(row)
    return row


def set_reportable(
    db: Session,
    *,
    analysis_id: int,
    reportable: bool,
    reason: Optional[str] = None,
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Flip the reportable flag. Not a state-machine transition — written
    to the audit log with transition_kind='auto' and from_state==to_state."""
    row = get_analysis(db, analysis_id)
    if row.reportable == reportable:
        return row  # no-op

    row.reportable = reportable
    row.reportable_reason = reason
    row.updated_at = datetime.utcnow()

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=row.review_state,
        to_state=row.review_state,
        transition_kind="auto",
        user_id=user_id,
        reason=(
            f"reportable={reportable}" + (f": {reason}" if reason else "")
        ),
    ))
    db.commit()
    db.refresh(row)
    return row


def set_method_instrument(
    db: Session,
    *,
    analysis_id: int,
    method_id: Optional[int],
    instrument_id: Optional[int],
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Phase 3.6: update method_id + instrument_id on a lims_analyses row.

    Either may be None (clear). No-op + early-return if both match the
    current row state. Writes an 'auto' audit transition with a
    machine-parseable reason — same pattern as set_reportable.
    """
    row = get_analysis(db, analysis_id)

    if row.method_id == method_id and row.instrument_id == instrument_id:
        return row

    row.method_id = method_id
    row.instrument_id = instrument_id
    row.updated_at = datetime.utcnow()

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=row.review_state,
        to_state=row.review_state,
        transition_kind="auto",
        user_id=user_id,
        reason=f"method_id={method_id},instrument_id={instrument_id}",
    ))
    db.commit()
    db.refresh(row)
    return row


# ─── Phase 4a: promote_to_parent ────────────────────────────────────────────


def promote_to_parent(
    db: Session,
    *,
    keyword: str,
    result_value: str,
    result_unit: Optional[str],
    method_id: Optional[int],
    instrument_id: Optional[int],
    sources: List[Dict[str, Any]],
    user_id: Optional[int] = None,
    reason: Optional[str] = None,
    commit: bool = True,
) -> Tuple[LimsAnalysis, List["LimsAnalysisPromotion"]]:
    """Phase 4a: create a parent-tier verified row from N vial-tier sources.

    sources is a list of {analysis_id: int, contribution_kind: str}. The
    parent_sample_pk is derived from the first source's host (sub-sample →
    parent). All sources must:
      - exist
      - be in 'to_be_verified' state
      - share the same keyword (matching the `keyword` arg)
      - hang off the same parent_sample_pk

    contribution_kind rules:
      - exactly one source with 'chosen'  OR  every source with 'aggregated_in'
      - 'reference' may accompany 'chosen' but not 'aggregated_in'

    Performs in one transaction:
      1. INSERT parent-tier lims_analyses row (review_state='verified',
         verified_at=NOW, analyst_user_id=user_id).
      2. INSERT one lims_analysis_promotions per source.
      3. INSERT one audit transition per source (state-unchanged 'auto'
         kind, reason='promoted to parent #N (kind=...)').

    Retest-source supersession: if ALL sources carry retest_of_id IS NOT NULL
    (retest promotion), any active (non-retracted/non-rejected) non-retest
    parent-tier row for (parent_sample_pk, keyword) is retracted inside the
    same transaction before the new parent row is inserted — vacating the
    partial unique index slot. An audit transition (reason="superseded by
    retest promotion") is written on the old row. Non-retest sources leave
    the existing 409 protection intact.

    Raises:
      - BadRequestError on validation failures.
      - sqlalchemy.exc.IntegrityError if an existing non-retest parent-tier
        row for (parent, keyword) blocks the partial unique index. The route
        layer translates this to 409.
    """
    from models import LimsAnalysisPromotion, LimsSubSample

    if not sources:
        raise BadRequestError("promote_to_parent requires at least one source")

    kinds = [s["contribution_kind"] for s in sources]
    n_chosen = sum(1 for k in kinds if k == "chosen")
    n_agg = sum(1 for k in kinds if k == "aggregated_in")
    n_ref = sum(1 for k in kinds if k == "reference")
    if n_agg > 0 and (n_chosen > 0 or n_ref > 0):
        raise BadRequestError(
            "aggregated_in cannot mix with chosen or reference; "
            "use either pick-one (one 'chosen' + Ns of 'reference') "
            "or aggregate (every source 'aggregated_in')"
        )
    if n_agg == 0 and n_chosen != 1:
        raise BadRequestError(
            f"pick-one promotion requires exactly one 'chosen' source; "
            f"got {n_chosen}"
        )

    source_ids = [s["analysis_id"] for s in sources]
    source_rows = {
        r.id: r for r in db.execute(
            select(LimsAnalysis).where(LimsAnalysis.id.in_(source_ids))
        ).scalars().all()
    }
    missing = [sid for sid in source_ids if sid not in source_rows]
    if missing:
        raise NotFoundError(f"source analyses not found: {missing}")

    parent_sample_pk: Optional[int] = None
    for sid in source_ids:
        row = source_rows[sid]
        if row.keyword != keyword:
            raise BadRequestError(
                f"source {sid} has keyword={row.keyword!r}, "
                f"expected {keyword!r}"
            )
        if row.review_state != "to_be_verified":
            raise BadRequestError(
                f"source {sid} is in {row.review_state!r}; "
                f"only 'to_be_verified' rows can be promoted"
            )
        if row.lims_sub_sample_pk is not None:
            sub = db.get(LimsSubSample, row.lims_sub_sample_pk)
            if sub is None:
                raise NotFoundError(f"sub-sample id={row.lims_sub_sample_pk} not found")
            this_parent_pk = sub.parent_sample_pk
        elif row.lims_sample_pk is not None:
            this_parent_pk = row.lims_sample_pk
        else:
            raise BadRequestError(
                f"source {sid} has neither lims_sample_pk nor lims_sub_sample_pk"
            )
        if parent_sample_pk is None:
            parent_sample_pk = this_parent_pk
        elif parent_sample_pk != this_parent_pk:
            raise BadRequestError(
                f"sources hang off different parents: "
                f"{parent_sample_pk} vs {this_parent_pk}"
            )

    if parent_sample_pk is None:
        raise BadRequestError("could not derive parent_sample_pk from sources")

    first_source = source_rows[source_ids[0]]
    analysis_service_id = first_source.analysis_service_id
    title = first_source.title

    now = datetime.utcnow()

    # ── Retest-source supersession ────────────────────────────────────────────
    # When ALL sources are retest rows (retest_of_id IS NOT NULL), the caller
    # is re-promoting after a vial retest. The old canonical (non-retest) parent
    # row for (parent_sample_pk, keyword) — if active — must be retracted inside
    # this same transaction to vacate the partial unique index before the new
    # parent row is inserted. Non-retest sources leave the existing 409 guard.
    if all(source_rows[sid].retest_of_id is not None for sid in source_ids):
        old_parent = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sample_pk == parent_sample_pk,
                LimsAnalysis.keyword == keyword,
                LimsAnalysis.retest_of_id.is_(None),
                # Only VERIFIED parents are superseded. A published parent is
                # a citable COA source — superseding it silently could invalidate
                # an issued COA; that conflict surfaces as the 409 instead.
                LimsAnalysis.review_state == "verified",
                LimsAnalysis.lims_sub_sample_pk.is_(None),
            )
        ).scalars().first()
        if old_parent is not None:
            prior_state = old_parent.review_state
            old_parent.review_state = "retracted"
            old_parent.updated_at = now
            db.add(LimsAnalysisTransition(
                analysis_id=old_parent.id,
                from_state=prior_state,
                to_state="retracted",
                transition_kind="auto",
                user_id=user_id,
                reason="superseded by retest promotion",
            ))
            db.flush()   # emit UPDATE before INSERT so Postgres sees vacated index slot
    # ── end retest-source supersession ───────────────────────────────────────

    parent_row = LimsAnalysis(
        lims_sample_pk=parent_sample_pk,
        lims_sub_sample_pk=None,
        analysis_service_id=analysis_service_id,
        keyword=keyword,
        title=title,
        result_value=result_value,
        result_unit=result_unit,
        review_state="verified",
        method_id=method_id,
        instrument_id=instrument_id,
        analyst_user_id=user_id,
        verified_at=now,
        created_by_user_id=user_id,
    )
    db.add(parent_row)
    db.flush()

    db.add(LimsAnalysisTransition(
        analysis_id=parent_row.id,
        from_state=None,
        to_state="verified",
        transition_kind="auto",
        user_id=user_id,
        reason=f"promoted from sources {source_ids}",
    ))

    promotion_rows: List[LimsAnalysisPromotion] = []
    for s in sources:
        sid = s["analysis_id"]
        kind = s["contribution_kind"]
        prom = LimsAnalysisPromotion(
            parent_analysis_id=parent_row.id,
            source_analysis_id=sid,
            contribution_kind=kind,
            promoted_by_user_id=user_id,
            promoted_at=now,
            reason=reason,
        )
        db.add(prom)
        promotion_rows.append(prom)

    for s in sources:
        sid = s["analysis_id"]
        kind = s["contribution_kind"]
        src = source_rows[sid]
        prev_state = src.review_state
        src.review_state = "promoted"
        src.updated_at = now
        db.add(LimsAnalysisTransition(
            analysis_id=sid,
            from_state=prev_state,
            to_state="promoted",
            transition_kind="auto",
            user_id=user_id,
            reason=f"promoted to parent #{parent_row.id} (kind={kind})",
        ))

    if commit:
        db.commit()
        db.refresh(parent_row)
        for p in promotion_rows:
            db.refresh(p)
    return parent_row, promotion_rows


# ─── Phase 4b: parent promotions read ───────────────────────────────────────


def list_promotions_for_parent(
    db: Session,
    parent_sample_id: str,
) -> list:
    """Return a list of ParentPromotionInfo for all promoted analyses on a
    parent LimsSample identified by *parent_sample_id*.

    Empty list when the sample is unknown — not a 404, because parent pages
    for samples that were never promoted call this too.
    """
    from models import LimsAnalysisPromotion, LimsSubSample, User
    from lims_analyses.schemas import ParentPromotionInfo, PromotionSourceInfo
    from models import LimsSample

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return []

    # Parent-tier analyses = rows with lims_sample_pk set (no sub-sample) and
    # at least one promotion link.
    parent_analyses = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
        )
    ).scalars().all()

    result = []
    for pa in parent_analyses:
        promo_rows = db.execute(
            select(LimsAnalysisPromotion).where(
                LimsAnalysisPromotion.parent_analysis_id == pa.id
            )
        ).scalars().all()
        if not promo_rows:
            # Directly-created parent analyses are not promotions — skip.
            continue

        # Use the first promotion row for metadata (all share same user/time).
        first_prom = promo_rows[0]

        # Resolve promoter email (nullable FK)
        promoted_by_email: Optional[str] = None
        if first_prom.promoted_by_user_id is not None:
            user_obj = db.get(User, first_prom.promoted_by_user_id)
            if user_obj is not None:
                promoted_by_email = user_obj.email

        sources = []
        for prom in promo_rows:
            src_analysis = db.get(LimsAnalysis, prom.source_analysis_id)
            vial_sample_id: Optional[str] = None
            if src_analysis and src_analysis.lims_sub_sample_pk is not None:
                sub = db.get(LimsSubSample, src_analysis.lims_sub_sample_pk)
                if sub is not None:
                    vial_sample_id = sub.sample_id
            sources.append(PromotionSourceInfo(
                sample_id=vial_sample_id,
                contribution_kind=prom.contribution_kind,
            ))

        result.append(ParentPromotionInfo(
            keyword=pa.keyword,
            parent_analysis_id=pa.id,
            result_value=pa.result_value,
            promoted_at=first_prom.promoted_at,
            promoted_by_email=promoted_by_email,
            sources=sources,
        ))

    return result


# ─── Phase 4c: parent-retest cascade ────────────────────────────────────────


def cascade_parent_retest_to_sources(
    db: Session,
    *,
    parent_sample_id: str,
    keyword: str,
    user_id: Optional[int],
) -> list[int]:
    """When a PARENT-tier analysis is retested (via SENAITE), cascade the retest
    down to each source vial-tier analysis that was promoted into that parent.

    Resolution chain:
      parent_sample_id → LimsSample → active parent-tier LimsAnalysis
        (lims_sub_sample_pk IS NULL, retest_of_id IS NULL, not retracted/rejected)
        with matching keyword
      → LimsAnalysisPromotion.source_analysis_id rows
      → source LimsAnalysis rows that are eligible for retest
        (state in to_be_verified/verified AND not already retested)
      → apply_transition(kind="retest") on each eligible source

    Returns a list of the newly-created vial retest row ids (may be empty when
    any link in the chain is missing, or all sources are already retested).

    Never raises — caller wraps in try/except. Each source's retest commits
    independently; if one fails (should not happen for eligible rows), the
    others still proceed.
    """
    from models import LimsAnalysisPromotion, LimsSample

    # 1. Resolve parent LimsSample
    parent_sample = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent_sample is None:
        return []

    # 2. Find the active parent-tier analysis for this keyword
    #    (lims_sub_sample_pk IS NULL, retest_of_id IS NULL, state not terminal-bad)
    parent_analysis = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_sample.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.keyword == keyword,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.not_in(("retracted", "rejected")),
        )
    ).scalars().first()
    if parent_analysis is None:
        return []

    # 3. Find all promotion sources for this parent analysis
    promo_rows = db.execute(
        select(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.parent_analysis_id == parent_analysis.id
        )
    ).scalars().all()
    if not promo_rows:
        return []

    # 4. Apply retest to each eligible source
    new_row_ids: list[int] = []
    for prom in promo_rows:
        src = db.get(LimsAnalysis, prom.source_analysis_id)
        if src is None:
            continue
        if src.retested:
            continue  # already retested — skip
        if src.review_state not in ("to_be_verified", "verified", "promoted"):
            continue  # not retest-eligible
        try:
            new_row = apply_transition(
                db,
                analysis_id=src.id,
                kind="retest",
                reason="cascaded from parent SENAITE retest",
                user_id=user_id,
            )
            new_row_ids.append(new_row.id)
        except Exception:
            # Log at call site; don't let one bad source kill the rest.
            pass

    return new_row_ids


# ─── Native vial add/remove (Phase 6 — native Manage Analyses) ──────────────


def add_analysis_to_native_vial(
    db: Session,
    *,
    sub_sample_pk: int,
    senaite_service_uid: Optional[str],
    keyword: Optional[str],
    user_id: Optional[int],
) -> "LimsAnalysis":
    """Add an analysis to a native (mk1://) sub-sample.

    Resolution order:
      1. If senaite_service_uid is given → match analysis_services.senaite_uid.
      2. Else if keyword is given → match analysis_services.keyword.
      3. Else → BadRequestError (no identifier).

    Raises:
      - BadRequestError when no identifier is supplied.
      - NotFoundError when the AnalysisService cannot be resolved.
      - BadRequestError (409-style) when an active non-retest row for that
        keyword already exists on the vial (idempotent guard).
    """
    from models import AnalysisService

    if senaite_service_uid is not None:
        svc = db.execute(
            select(AnalysisService).where(AnalysisService.senaite_uid == senaite_service_uid)
        ).scalars().first()
        if svc is None:
            raise NotFoundError(
                f"AnalysisService with senaite_uid={senaite_service_uid!r} not found"
            )
    elif keyword is not None:
        svc = db.execute(
            select(AnalysisService).where(AnalysisService.keyword == keyword)
        ).scalars().first()
        if svc is None:
            raise NotFoundError(
                f"AnalysisService with keyword={keyword!r} not found"
            )
    else:
        raise BadRequestError(
            "add_analysis_to_native_vial requires either senaite_service_uid or keyword"
        )

    # Duplicate guard: active (non-retest) row with same keyword on this vial
    existing = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample_pk,
            LimsAnalysis.keyword == svc.keyword,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise BadRequestError(
            f"vial already has an active analysis with keyword={svc.keyword!r} "
            f"(id={existing.id}); remove or retract it first"
        )

    return create_analysis(
        db,
        host_kind="sub_sample",
        host_pk=sub_sample_pk,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        result_unit=svc.unit,
        created_by_user_id=user_id,
    )


def delete_pristine_analysis(
    db: Session,
    *,
    sub_sample_pk: int,
    keyword: str,
    user_id: Optional[int],
) -> None:
    """Hard-delete a pristine (mistake-correction) analysis from a native vial.

    "Pristine" means: review_state == 'unassigned' AND result_value IS NULL
    AND not retested AND no promotion link. Any other state raises BadRequestError.

    Raises:
      - NotFoundError when no active row with that keyword exists on the vial.
      - BadRequestError when the row has activity (result, non-unassigned state,
        retested flag, or promotion link) — instruct caller to retract instead.
    """
    from models import LimsAnalysisPromotion

    row = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample_pk,
            LimsAnalysis.keyword == keyword,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError(
            f"no active lims_analysis with keyword={keyword!r} on sub_sample_pk={sub_sample_pk}"
        )

    # Pristine guards
    if row.review_state != "unassigned":
        raise BadRequestError(
            f"analysis has activity (state={row.review_state!r}) — retract it instead"
        )
    if row.result_value is not None:
        raise BadRequestError(
            "analysis has activity (result_value set) — retract it instead"
        )
    if row.retested:
        raise BadRequestError(
            "analysis has activity (retested=True) — retract it instead"
        )
    # Promotion-link guard: this row is a source in any promotion
    promo_link = db.execute(
        select(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.source_analysis_id == row.id
        )
    ).scalar_one_or_none()
    if promo_link is not None:
        raise BadRequestError(
            "analysis has activity (promotion link exists) — retract it instead"
        )

    # Write event before hard-delete: the analysis row is gone after commit,
    # but the event preserves the fact that it existed and was removed.
    db.add(LimsSubSampleEvent(
        sub_sample_pk=sub_sample_pk,
        event="analysis_removed",
        details={"keyword": keyword},
        user_id=user_id,
    ))
    # Hard-delete: transition rows first (FK), then the row itself.
    db.execute(
        sa_delete(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id
        )
    )
    db.delete(row)
    db.commit()


# ─── Phase 3 adapter: SenaiteAnalysis-shape projection ──────────────────────


def list_analyses_in_senaite_shape(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    include_retests: bool = False,
):
    """List analyses for a host, projected to the FE's SenaiteAnalysis shape.

    UID carries the 'mk1:' prefix so the FE can dispatch transitions to the
    Mk1 endpoints. method_options + instrument_options are left empty in
    Phase 3 — editing method/instrument on Mk1 vials would need new Mk1
    PATCH endpoints; deferred to a later phase. Bench-tech result-entry +
    state transitions DO work via the Phase 1 transitions endpoint.
    """
    from models import AnalysisService, HplcMethod, Instrument
    from lims_analyses.schemas import (
        SenaiteShapeAnalysisResponse,
        SenaiteShapeInstrumentOption,
        SenaiteShapeMethodOption,
        SenaiteShapeResultOption,
    )

    rows = list_analyses_for_host(
        db, host_kind=host_kind, host_pk=host_pk,
        include_retests=include_retests,
    )
    if not rows:
        return []

    # Phase 4b: bulk-load promotion links so we can surface promoted_to_parent_id
    # on each vial-tier row. Single-query, indexed lookup on source_analysis_id.
    # senaite-writeback: ignore links whose parent row was retracted/rejected —
    # "retract the parent row, then re-promote" must restore promotability.
    from models import LimsAnalysisPromotion
    row_ids = [r.id for r in rows]
    promo_by_source: Dict[int, int] = {}
    if row_ids:
        for p, parent_state in db.execute(
            select(LimsAnalysisPromotion, LimsAnalysis.review_state)
            .join(LimsAnalysis, LimsAnalysis.id == LimsAnalysisPromotion.parent_analysis_id)
            .where(LimsAnalysisPromotion.source_analysis_id.in_(row_ids))
        ).all():
            if parent_state not in ("retracted", "rejected"):
                promo_by_source[p.source_analysis_id] = p.parent_analysis_id

    # Bulk-load services for unit / method-name display
    service_ids = {r.analysis_service_id for r in rows}
    services_by_id = {
        s.id: s
        for s in db.execute(
            select(AnalysisService).where(AnalysisService.id.in_(service_ids))
        ).scalars().all()
    }

    # Phase 3.6: bulk-load ALL hplc_methods + instruments for the option
    # arrays the FE dropdowns render. Wider scope than the per-row chosen
    # FK lookup — but the catalog is small (~3-10 of each in practice), so
    # the full load is cheap.
    methods_by_id = {
        m.id: m
        for m in db.execute(select(HplcMethod)).scalars().all()
    }
    instruments_by_id = {
        i.id: i
        for i in db.execute(select(Instrument)).scalars().all()
    }

    # Analyst display: "First Last" (email fallback). Mirrors the FE rule in
    # src/lib/user-display.ts; helper in backend/users_display.py.
    from models import User
    from users_display import user_display_name
    analyst_ids = {r.analyst_user_id for r in rows if r.analyst_user_id}
    analyst_name_by_id = {}
    if analyst_ids:
        analyst_name_by_id = {
            u.id: user_display_name(u)
            for u in db.execute(select(User).where(User.id.in_(analyst_ids))).scalars()
        }

    method_options = [
        SenaiteShapeMethodOption(uid=str(m.id), title=getattr(m, "name", None) or f"Method {m.id}")
        for m in sorted(methods_by_id.values(), key=lambda m: m.id)
    ]
    instrument_options = [
        SenaiteShapeInstrumentOption(uid=str(i.id), title=getattr(i, "name", None) or f"Instrument {i.id}")
        for i in sorted(instruments_by_id.values(), key=lambda i: i.id)
    ]

    out = []
    for r in rows:
        svc = services_by_id.get(r.analysis_service_id)
        method_name = None
        if r.method_id and r.method_id in methods_by_id:
            method_name = getattr(methods_by_id[r.method_id], "name", None)
        instrument_name = None
        if r.instrument_id and r.instrument_id in instruments_by_id:
            instrument_name = getattr(instruments_by_id[r.instrument_id], "name", None)

        svc_options = [
            SenaiteShapeResultOption(value=o["value"], label=o["label"])
            for o in (getattr(svc, "result_options", None) or [])
            if isinstance(o, dict) and "value" in o and "label" in o
        ]

        out.append(SenaiteShapeAnalysisResponse(
            uid=f"mk1:{r.id}",
            keyword=r.keyword,
            title=r.title,
            result=r.result_value,
            result_options=svc_options,
            result_type=getattr(svc, "result_type", None),
            unit=r.result_unit or (svc.unit if svc else None),
            method=method_name,
            method_uid=str(r.method_id) if r.method_id else None,
            method_options=method_options,
            instrument=instrument_name,
            instrument_uid=str(r.instrument_id) if r.instrument_id else None,
            instrument_options=instrument_options,
            analyst=analyst_name_by_id.get(r.analyst_user_id),
            review_state=r.review_state,
            sort_key=None,
            captured=r.captured_at.isoformat() if r.captured_at else None,
            retested=r.retested,
            service_group_id=None,
            service_group_name=None,
            promoted_to_parent_id=promo_by_source.get(r.id),
        ))
    return out
