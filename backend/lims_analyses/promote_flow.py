"""Promote to parent: the body of POST /api/lims-analyses/promote, shared with
the worksheet endpoint (endo slice 3, spec 2026-10-12 section 5.3 step 3).

run_promote resolves the parent target, runs service.promote_to_parent,
commits Accu-Mk1 first, tees SENAITE for SENAITE-origin services (skipped for
origin='mk1'), records how the tee went, then runs the side-by-side cascade.
Every refusal is a PromoteError; the route re-raises it as the HTTPException it
always raised, so the sample page sees the same status and body as before.

SENAITE and slot resolution are reached through their module attributes
(senaite_writeback.writeback_promotion, service.resolve_parent_analyte_target)
because tests patch them there.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any, Optional

from fastapi import BackgroundTasks
from sqlalchemy.orm import Session

from lims_analyses import senaite_writeback, service
from lims_analyses.schemas import AnalysisResponse, PromoteRequest, PromoteResponse, PromotionRow
from lims_analyses.senaite_writeback import SenaiteParentLineLocked, SenaiteWritebackError

logger = logging.getLogger(__name__)

# The code of a refusal whose HTTP body is a plain string; dict bodies carry
# their own "code".
_CODE_BY_STATUS = {400: "bad_request", 404: "not_found", 502: "senaite_writeback_failed"}


class PromoteError(Exception):
    """A promote refusal. `code` and `detail` are for callers that report per
    row (the worksheet endpoint); `status` and `body` are exactly the status
    and detail of the HTTPException the sample page's route raised before the
    move (a string, or a dict such as {"code", "message"})."""

    def __init__(self, code: str, status: int, detail: str, body: Any = None):
        super().__init__(detail)
        self.code = code
        self.status = status
        self.detail = detail
        self.body = detail if body is None else body


def _refusal(e: Exception) -> PromoteError:
    """promote_to_parent's exception as a PromoteError, through the route's own
    mapping (routes._handle_service_error) so status and body stay identical.
    An exception that mapping does not know is re-raised unchanged (a 500, as
    before)."""
    from lims_analyses.routes import _handle_service_error  # call time: routes imports this module

    http = _handle_service_error(e)
    if isinstance(http.detail, dict):
        message = http.detail.get("message") or str(e)
        return PromoteError(http.detail["code"], http.status_code, message, body=http.detail)
    return PromoteError(_CODE_BY_STATUS.get(http.status_code, "error"), http.status_code,
                        http.detail)


class _RunNow:
    """BackgroundTasks stand-in for a caller outside a request: the promote is
    already committed, so the task runs at once."""

    def add_task(self, func, *args, **kwargs) -> None:
        func(*args, **kwargs)


def run_promote(
    db: Session,
    current_user,
    req: PromoteRequest,
    *,
    background_tasks: Optional[BackgroundTasks] = None,
    audit_reason: Optional[str] = None,
) -> PromoteResponse:
    """Promote req.sources to one parent-tier row and commit it.

    Raises PromoteError for every refusal (404 unknown source, 502 parent slot
    resolution, 400 / 404 validation, 409 parent row already exists). Before
    raising, the session is rolled back, so a caller's uncommitted writes in
    the same session (the worksheet's fill of the vial result) go with it: the
    fill and the promote land together or not at all. A failed commit is
    logged, rolled back and re-raised as is.

    audit_reason, when given, is appended to the reason of every transition
    row the promote writes ("promoted from worksheet WS-24 row P-3001-S02").

    background_tasks is the request's when called from a route: the cascade
    is then scheduled post-response, as the route always did. Without it the
    cascade runs inline after the commit.
    """
    from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample

    user_id = getattr(current_user, "id", None)

    # Resolve the parent SENAITE sample_id + parent-AR target keyword BEFORE
    # promoting, so per-substance vial keywords (PUR_<X>/QTY_<X>) land on the
    # parent's generic ANALYTE-{slot} line. Native keywords pass through
    # unchanged (no SENAITE read).
    first_src = db.get(LimsAnalysis, req.sources[0].analysis_id)
    if first_src is None:
        db.rollback()
        raise PromoteError("source_not_found", 404, "source analysis not found")
    if first_src.lims_sub_sample_pk is not None:
        _sub = db.get(LimsSubSample, first_src.lims_sub_sample_pk)
        _parent = db.get(LimsSample, _sub.parent_sample_pk) if _sub else None
    else:
        _parent = db.get(LimsSample, first_src.lims_sample_pk)
    parent_sample_id = _parent.sample_id if _parent else None

    # Native (origin='mk1') sources have no per-substance SENAITE translation
    # and no SENAITE keyword contract at all; the caller-supplied req.keyword
    # is advisory, not identity. Force promote_to_parent's native-identity
    # override (service-derived keyword/title/unit, service.py step 4c) to
    # fire by passing None through, instead of trusting a request string that
    # can drift or arrive empty. Detected off the FIRST SOURCE's service:
    # native keywords never match the PUR_/QTY_ per-substance regex, so
    # resolve_parent_analyte_target would be a no-op for them anyway; this
    # just skips the call and is explicit about why.
    _first_src_svc = db.get(AnalysisService, first_src.analysis_service_id)
    _first_src_is_native = _first_src_svc is not None and _first_src_svc.origin == "mk1"

    if _first_src_is_native:
        parent_keyword, parent_service_id, parent_title = None, None, None
    else:
        try:
            if parent_sample_id:
                parent_keyword, parent_service_id, parent_title = service.resolve_parent_analyte_target(
                    db, vial_keyword=req.keyword, parent_sample_id=parent_sample_id)
            else:
                parent_keyword, parent_service_id, parent_title = req.keyword, None, None
        except Exception as e:
            db.rollback()
            raise PromoteError("parent_slot_resolution_failed", 502,
                               f"parent slot resolution failed: {e}") from e

    try:
        parent_row, promotion_rows = service.promote_to_parent(
            db,
            keyword=req.keyword,
            result_value=req.result_value,
            result_unit=req.result_unit,
            method_id=req.method_id,
            instrument_id=req.instrument_id,
            sources=[s.model_dump() for s in req.sources],
            user_id=user_id,
            reason=req.reason,
            parent_keyword=parent_keyword,
            parent_analysis_service_id=parent_service_id,
            parent_title=parent_title,
            loq=req.loq,
            lod=req.lod,
            lod_unit=req.lod_unit,
            result_floor=req.result_floor,
            audit_reason=audit_reason,
            commit=False,
        )
    except Exception as e:
        # A unique-index IntegrityError on the parent insert (a second parent
        # row: double click, two tabs) leaves the session unusable until this
        # rollback; it maps to 409 parent_row_already_exists below.
        db.rollback()
        raise _refusal(e) from e

    # ── SENAITE write-back (fail-closed) ──────────────────────────────────────
    # parent_sample_id was derived above (one definition). If it could not be
    # resolved, fall back to the parent-tier row's sample_id label.
    if parent_sample_id is None:
        parent_sample_obj = db.get(LimsSample, parent_row.lims_sample_pk)
        parent_sample_id = parent_sample_obj.sample_id if parent_sample_obj else str(parent_row.lims_sample_pk)

    # Collect source-vial sample_id labels from sub-sample rows.
    vial_ids: list[str] = []
    for prom in promotion_rows:
        src_analysis = db.get(LimsAnalysis, prom.source_analysis_id)
        if src_analysis and src_analysis.lims_sub_sample_pk is not None:
            sub = db.get(LimsSubSample, src_analysis.lims_sub_sample_pk)
            if sub is not None:
                vial_ids.append(sub.sample_id)

    email = getattr(current_user, "email", None) or "unknown"
    remark = (
        f"Promoted from {', '.join(vial_ids) if vial_ids else '(unknown vials)'} "
        f"(Accu-Mk1) by {email} on {date.today().isoformat()}"
    )

    # ── Origin gate (native COA sections, spec 2) ─────────────────────────────
    # A service with origin='mk1' has no SENAITE representation: there is no
    # analysis line to write back to, so the Mk1-side commit IS the promotion.
    # Read origin from the service backing the PARENT row, never the vial row:
    # resolve_parent_analyte_target translates per-substance keywords, and its
    # notion of "native" (not PUR_/QTY_) is a different predicate from
    # origin='mk1'.
    _parent_svc = db.get(AnalysisService, parent_row.analysis_service_id)
    _skip_writeback = _parent_svc is not None and _parent_svc.origin == "mk1"

    # ── Accu-Mk1 writes FIRST (Handler ruling 2026-09-10) ────────────────────
    # Post read-independence Mk1 is the canonical tier: these rows are what
    # Sample Details and the COA wire read, and SENAITE's analysis line is the
    # mirror. Committing the mirror first and the source of truth second is
    # what allowed a lost Mk1 commit to strand a family with a verified SENAITE
    # line, no Mk1 promotion, and (because the lock map then read that mirror)
    # no Promote verb in the UI either (P-2553, P-2606; both needed a by-hand
    # replay of promote_to_parent against prod).
    #
    # So the local write is made durable BEFORE SENAITE is touched, and the
    # write-back becomes a tee that can fail without taking the promotion down
    # with it. A commit failure here means nothing was written anywhere, which
    # is a clean failure with no divergence to reconcile.
    try:
        db.commit()
    except Exception:
        logger.exception(
            "promote_commit_failed parent=%s keyword=%s: SENAITE was not called, "
            "nothing to reconcile",
            parent_sample_id, parent_row.keyword,
        )
        db.rollback()
        raise
    db.refresh(parent_row)
    for p in promotion_rows:
        db.refresh(p)

    # ── Tee to SENAITE (best effort; the promotion above already stands) ─────
    _sync_event: Optional[tuple] = None
    if not _skip_writeback:
        try:
            senaite_writeback.writeback_promotion(
                parent_sample_id,
                parent_row.keyword,        # parent ANALYTE-{slot} (was req.keyword)
                req.result_value,
                remark,
            )
        except SenaiteParentLineLocked as e:
            # Locked line (verified/published): SENAITE can never retract it,
            # so aborting here would dead-end every retest re-promote on a
            # senaite-origin family. Handler ruling 2026-08-30: the canonical
            # row is the certificate authority post read-independence, so
            # diverge deliberately: record it and promote natively.
            logger.warning(
                "senaite_promote_divergence parent=%s keyword=%s senaite_state=%s uid=%s "
                "(native promote proceeds, SENAITE line left as-is)",
                parent_sample_id, parent_row.keyword, e.state, e.uid,
            )
            _sync_event = ("senaite_line_diverged", {
                "keyword": parent_row.keyword,
                "senaite_state": e.state,
                "senaite_uid": e.uid,
                "reason": "promote over locked SENAITE line — canonical value takes control",
            })
        except SenaiteWritebackError as e:
            # Unreachable / refused / line missing. The promotion is already
            # committed, so this is the MIRROR falling behind, not lost work.
            # Recorded on the parent so it is visible in the activity feed
            # rather than living only in a log line that rotates.
            logger.error(
                "senaite_promote_writeback_failed parent=%s keyword=%s: the Mk1 "
                "promotion stands, SENAITE's line is now behind: %s",
                parent_sample_id, parent_row.keyword, e,
            )
            _sync_event = ("senaite_promote_writeback_failed", {
                "keyword": parent_row.keyword,
                "error": str(e)[:500],
                "reason": "SENAITE unreachable or refused — Mk1 promotion committed, mirror lagging",
            })
    else:
        logger.info(
            "native_promote_writeback_skipped parent_analysis_id=%s service_id=%s keyword=%s",
            parent_row.id, parent_row.analysis_service_id, parent_row.keyword,
        )

    if _sync_event is not None:
        # Its own transaction: the promotion is committed and must not be put
        # at risk by the bookkeeping that records how the tee went.
        try:
            from models import LimsSubSampleEvent
            db.add(LimsSubSampleEvent(
                lims_sample_pk=parent_row.lims_sample_pk,
                event=_sync_event[0],
                details=_sync_event[1],
                user_id=user_id,
            ))
            db.commit()
        except Exception:
            db.rollback()
            logger.exception(
                "promote_sync_event_write_failed parent=%s keyword=%s event=%s",
                parent_sample_id, parent_row.keyword, _sync_event[0],
            )

    # The side-by-side cascade, through the one helper routes.transition also
    # uses (kill switch, parent pk, never-raise): post-response on the
    # request's BackgroundTasks, else inline now that the promote is committed.
    from lims_analyses.routes import _schedule_sbs_cascade  # call time: routes imports this module
    _schedule_sbs_cascade(background_tasks if background_tasks is not None else _RunNow(),
                          db, parent_row, current_user)

    return PromoteResponse(
        parent=AnalysisResponse.model_validate(parent_row),
        promotions=[PromotionRow.model_validate(p) for p in promotion_rows],
    )
