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

import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, delete as sa_delete, or_, select
from sqlalchemy.orm import Session

from lims_analyses.state_machine import (
    TIER_PARENT,
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


class ConflictError(Exception):
    """A conflicting existing row blocks the requested write (mapped to 409
    by the route layer). Distinct from the raw IntegrityError the DB's
    partial unique index raises — this is for cases the service layer can
    diagnose ahead of the flush and explain in the caller-facing message."""


class StateLockedError(Exception):
    """Method/instrument restamp attempted on a reported or dead row (R7)."""

    def __init__(self, review_state: str):
        super().__init__(f"row is {review_state}; method/instrument locked")
        self.review_state = review_state


# ─── Parent keyword translation ──────────────────────────────────────────────


_PER_SUBSTANCE = re.compile(r"^(PUR|QTY)_(.+)$")


def resolve_parent_analyte_target(
    db: Session, *, vial_keyword: str, parent_sample_id: str,
) -> Tuple[str, Optional[int], Optional[str]]:
    """Map a vial per-substance keyword (PUR_<X>/QTY_<X>) to the parent AR's
    generic ANALYTE-{slot} target: (parent_keyword, parent_service_id, parent_title).

    The parent SENAITE AR carries generic ANALYTE-{n}-PUR/QTY (aliased to the
    substance via Analyte{N}Peptide), not PUR_<X>. Native keywords (ID_<X>,
    BLEND-*, PEPT-*, HPLC-*) already match the parent -> returns
    (vial_keyword, None, None) WITHOUT reading SENAITE. Unresolvable per-substance
    keywords (peptide not in any parent slot) also fall through to
    (vial_keyword, None, None) so the caller's writeback fails loudly rather than
    guessing.
    """
    from models import AnalysisService

    m = _PER_SUBSTANCE.match(vial_keyword)
    if not m:
        return vial_keyword, None, None
    cat = m.group(1)  # 'PUR' or 'QTY'

    # `keyword` is non-unique: a re-run of the analysis-services sync can clone
    # per-substance services (prod had two PUR_TB500BETA4 rows). Tolerate the
    # duplicates, but never guess across DIFFERENT peptides — that would target
    # the wrong parent analyte slot and corrupt the COA. Fail loudly instead.
    vsvc_rows = db.execute(
        select(AnalysisService)
        .where(AnalysisService.keyword == vial_keyword)
        .order_by(AnalysisService.id)
    ).scalars().all()
    distinct_peptides = {r.peptide_id for r in vsvc_rows if r.peptide_id is not None}
    if len(distinct_peptides) > 1:
        raise BadRequestError(
            f"Analysis-service keyword {vial_keyword!r} is duplicated across "
            f"multiple peptides {sorted(distinct_peptides)}; dedupe Analysis "
            f"Services before promoting."
        )
    vsvc = next(
        (r for r in vsvc_rows if r.peptide_id is not None),
        vsvc_rows[0] if vsvc_rows else None,
    )
    if vsvc is None or vsvc.peptide_id is None:
        return vial_keyword, None, None

    id_title = db.execute(
        select(AnalysisService.title).where(
            AnalysisService.peptide_id == vsvc.peptide_id,
            AnalysisService.keyword.like("ID" + r"\_" + "%", escape="\\"),
        ).order_by(AnalysisService.keyword).limit(1)
    ).scalar_one_or_none()
    if not id_title:
        return vial_keyword, None, None

    from sub_samples.senaite import fetch_parent_analyte_slots
    slots = fetch_parent_analyte_slots(parent_sample_id)  # raises -> fail-closed
    slot_n = next((n for n, t in slots.items() if t == id_title), None)
    if slot_n is None:
        return vial_keyword, None, None

    parent_keyword = f"ANALYTE-{slot_n}-{cat}"
    # Parent ANALYTE-* keywords can likewise be duplicated; the keyword string
    # is what the SENAITE write-back uses, so pick deterministically.
    psvc = db.execute(
        select(AnalysisService)
        .where(AnalysisService.keyword == parent_keyword)
        .order_by(AnalysisService.id)
    ).scalars().first()
    if psvc is None:
        return parent_keyword, None, None
    return parent_keyword, psvc.id, (psvc.title or parent_keyword)


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
        # SENAITE phase-out fail-closed: this branch has no review_state
        # filter, so a SENAITE-mirror SHADOW row (sentinel review_state=
        # 'senaite_mirror') would otherwise surface unfiltered straight into
        # the AnalysisTable API / senaite_shape adapter. provenance='canonical'
        # is a no-op for sub_sample-hosted rows (shadows are always parent-tier)
        # but REQUIRED here.
        stmt = select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == host_pk,
            LimsAnalysis.provenance == "canonical",
        )
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
    commit: bool = True,
) -> LimsAnalysis:
    """Insert a new lims_analyses row in state='unassigned'. Writes the
    initial audit row (from_state=NULL, to_state='unassigned',
    transition_kind='auto').

    commit=True (default) commits per row — the historical behavior every
    existing caller relies on. Pass commit=False to keep the row pending in
    the caller's outer transaction (it stays flushed, so row.id is populated);
    the caller is then responsible for the single commit. This is what makes
    set_assignment_role's role-flip + seeding genuinely atomic."""
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
        details={"changed": {}},
    ))
    if commit:
        db.commit()
        db.refresh(row)
    else:
        db.flush()  # row already has an id from the earlier flush; keep it pending in the outer txn
    return row


def record_placeholder_created(
    db: Session,
    row: LimsAnalysis,
    *,
    reason: str,
    user_id: Optional[int],
) -> LimsAnalysisTransition:
    """Audit row for a lab-minted parent placeholder (manage-analyses slice).

    Registration-time placeholders carry no transition (they are 'ordered' and
    nothing more); a lab-driven mint records *why it exists* on an 'auto'
    transition (from NULL → unassigned) whose `reason` names the action.
    Lives here — not in parent_placeholders.py — so the amendment-audit AST
    guard sees the construction and enforces details=. Flushes, never commits.
    """
    tr = LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=None,
        to_state="unassigned",
        transition_kind="auto",
        user_id=user_id,
        reason=reason,
        details={"changed": {}},
    )
    db.add(tr)
    db.flush()
    return tr


def soft_reject_parent_placeholder(
    db: Session,
    row: LimsAnalysis,
    *,
    reason: str,
    user_id: Optional[int],
) -> LimsAnalysis:
    """Ruling R1 (manage-analyses slice): a parent PLACEHOLDER (provenance
    'ordered', never worked) is removed by marking it 'rejected' — the row and
    its transitions survive as the trail, and the partial unique index
    (…_parent_service_ordered excludes rejected/retracted) frees the slot for
    a re-add. Written directly rather than through apply_transition: the
    generic tier gate forbids parent-tier 'reject' on purpose (workflow rows),
    and that gate is untouched — this is a placeholder-only primitive.
    Raises BadRequestError on anything that is not a live placeholder.
    Flushes, never commits.
    """
    if row.provenance != "ordered" or row.lims_sub_sample_pk is not None:
        raise BadRequestError(f"analysis id={row.id} is not a parent placeholder")
    if row.review_state in ("rejected", "retracted"):
        raise BadRequestError(f"analysis id={row.id} is already {row.review_state}")
    from_state = row.review_state
    row.review_state = "rejected"
    row.updated_at = datetime.utcnow()
    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=from_state,
        to_state="rejected",
        transition_kind="reject",
        user_id=user_id,
        reason=reason,
        details={"changed": {}},
    ))
    db.flush()
    return row


# ─── Amendment audit (spec 2026-08-07) ───────────────────────────────────────
# Fields whose changes are captured as before/after into
# lims_analysis_transitions.details. Values must stay JSON-serializable
# (str/int/bool/None) — never add a datetime here; per-state timestamps are
# derivable from the transition rows themselves.
TRACKED_FIELDS = (
    "result_value", "result_unit", "method_id", "instrument_id",
    "reportable", "reportable_reason", "analyst_user_id", "processed_by_user_id",
    "retested",
)


def _snapshot(row) -> dict:
    return {f: getattr(row, f) for f in TRACKED_FIELDS}


def _deltas(before: dict, row) -> dict:
    """{"changed": {field: {before, after}}} for tracked fields that differ.
    Always returns the envelope (possibly empty changed) — NULL details is
    reserved for rows that predate capture."""
    after = _snapshot(row)
    return {"changed": {
        f: {"before": before[f], "after": after[f]}
        for f in TRACKED_FIELDS if before[f] != after[f]
    }}


# ─── Transitions ─────────────────────────────────────────────────────────────


def _tee_parent_verify_to_senaite(db: Session, row: LimsAnalysis) -> None:
    """Origin-gated SENAITE tee for a parent-tier verify (see the call site in
    apply_transition's verify guard). SENAITE-origin service → verify the AR
    line via senaite_writeback.writeback_parent_verify (raises
    SenaiteWritebackError on failure — the caller's transaction aborts).
    mk1-origin service, or a row with no resolvable service (promote always
    stamps the FK, so this is a legacy-data guard, not a live path) → no-op.
    """
    from models import AnalysisService, LimsSample

    svc = (
        db.get(AnalysisService, row.analysis_service_id)
        if row.analysis_service_id is not None else None
    )
    if svc is None or (svc.origin or "") == "mk1":
        return
    parent = db.get(LimsSample, row.lims_sample_pk)
    if parent is None:
        raise BadRequestError(
            f"parent lims_samples row missing for analysis {row.id}"
        )
    from lims_analyses import senaite_writeback

    senaite_writeback.writeback_parent_verify(parent.sample_id, row.keyword)


def apply_transition(
    db: Session,
    *,
    analysis_id: int,
    kind: str,
    result_value: Optional[str] = None,
    reason: Optional[str] = None,
    user_id: Optional[int] = None,
    method_id: Optional[int] = None,
    instrument_id: Optional[int] = None,
    processed_by_user_id: Optional[int] = None,
) -> LimsAnalysis:
    """
    Validate (from_state, kind) via the state machine, apply the
    state change, update timestamps, write the audit row, commit.

    Semantic guards beyond the state machine:
      - 'submit' requires a result_value (either already on the row or
        supplied in this call).
      - 'verify' requires the row to already carry a result_value.

    method_id: optional method stamp, applied after the snapshot; None is a no-op.
    instrument_id: optional instrument stamp, applied after the snapshot; None is a no-op.
    processed_by_user_id: optional processor stamp (who ran the Process HPLC
    behind this result — NOT the acting user); same submit-only + after-snapshot
    rules as the method/instrument stamps.
    If any is provided with kind != 'submit', raises BadRequestError up
    front (Task 3, 2026-08-19 bench-stamping slice) — see the guard right
    after the row load.
    """
    row = get_analysis(db, analysis_id)

    # Task 3 (2026-08-19 bench-stamping slice): the public transition route
    # (TransitionRequest) exposes method_id/instrument_id only for
    # kind='submit' — explicit 400 on any other kind rather than silently
    # ignoring the fields ("explicit beats silent", per the slice design).
    # Placed before any state/tier validation so a stray stamp field on an
    # otherwise-illegal transition still reports the stamp misuse, not a
    # tier/state error. submit's only legal predecessor states (unassigned,
    # assigned) already fall inside STAMPABLE_STATES (state_machine.py), so
    # no separate R7 guard call is needed on this path — it can't trip here.
    if (method_id is not None or instrument_id is not None
            or processed_by_user_id is not None) and kind != "submit":
        raise BadRequestError(
            "method_id/instrument_id/processed_by_user_id only apply to kind='submit'"
        )

    from_state = row.review_state
    before = _snapshot(row)

    # Amendment audit (Handler ruling 2026-08-10): callers that used to stamp
    # method/instrument directly on the row pre-call (prep_bridge), and now
    # also the submit-transition route (Task 3 above), pass them here instead
    # — applied AFTER the snapshot so the change lands in details["changed"]
    # on this transition's audit row.
    if method_id is not None:
        row.method_id = method_id
    if instrument_id is not None:
        row.instrument_id = instrument_id
    if processed_by_user_id is not None:
        row.processed_by_user_id = processed_by_user_id

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
        # "verified": grandfathered vial rows from before vial-verify was removed
        # (kept for backward-compat); "promoted": cascade-driven (parent retest);
        # "variance_verified": variance replicates re-run safely — they never
        # touched the parent, so there is no SENAITE lock to collide with.
        # "parent_to_verify": the native second-sign-off state — a parent row
        # awaiting its verify can still be retested (pre-wires Task 4's guards).
        if from_state not in (
            "to_be_verified", "verified", "promoted", "variance_verified",
            "parent_to_verify",
        ):
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
            details={"changed": {}},
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
            details=_deltas(before, row),
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
        # Parent-tier verify tee (read-flip seam fix, 2026-08-20): a canonical
        # parent row whose service is SENAITE-origin must flip its SENAITE AR
        # line in the same act — otherwise SENAITE strands at to_be_verified
        # while Mk1 reads verified, a divergence the COA gate trips over
        # later. Fail-closed like promote's write-back: a SENAITE error
        # aborts the whole transition (nothing is committed yet — the only
        # prior mutations in this call are submit-only stamp fields, which
        # can't co-occur with kind='verify'). mk1-origin services have no
        # SENAITE line — nothing to sync. The tier guard is structural
        # (next_state above tier-blocks vial-tier verify) but kept explicit.
        if row_tier == TIER_PARENT:
            _tee_parent_verify_to_senaite(db, row)
    elif kind == "variance_verify":
        if not row.result_value:
            raise BadRequestError("variance_verify requires a result_value on the row")
        if row.lims_sub_sample_pk is None:
            # The parent acting as a vial always PROMOTES (it is the canonical);
            # variance sign-off exists only for sub-sample replicates.
            raise BadRequestError(
                "variance_verify is only valid on sub-sample-hosted rows"
            )
        from models import LimsSubSample
        vial = db.get(LimsSubSample, row.lims_sub_sample_pk)
        if vial is None or vial.assignment_kind != "variance":
            raise BadRequestError(
                "variance_verify requires the host vial to be assigned to a variance bucket"
            )
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
    elif to_state == "variance_verified":
        row.verified_at = now

    row.review_state = to_state
    row.updated_at = now

    # Activity event (Task 7): parent-tier verify is the second sign-off on
    # a promoted result — the only tier-gated event, written right before
    # the transition commit so it rides the same transaction.
    if kind == "verify" and row_tier == TIER_PARENT:
        from models import AnalysisService
        svc = db.get(AnalysisService, row.analysis_service_id)
        db.add(LimsSubSampleEvent(
            lims_sample_pk=row.lims_sample_pk,
            event="parent_analysis_verified",
            details={
                "keyword": row.keyword,
                "analysis_id": row.id,
                "service_origin": svc.origin if svc else None,
            },
            user_id=user_id,
        ))

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=from_state,
        to_state=to_state,
        transition_kind=kind,
        user_id=user_id,
        reason=reason,
        details=_deltas(before, row),
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
    """Flip the reportable flag and/or its reason. Not a state-machine
    transition — written to the audit log with transition_kind='auto' and
    from_state==to_state. A reason-only edit (same flag, different non-None
    reason) is an audited amendment, not a silent overwrite; reason=None on
    a same-flag call is a no-op (never clears an existing reason)."""
    row = get_analysis(db, analysis_id)
    # No-op iff nothing would change: same flag AND the caller either supplied
    # no reason (None = "not provided", never "clear it" on a same-flag call)
    # or the same reason. A reason-ONLY edit (same flag, different non-None
    # reason) falls through: it updates reportable_reason and writes an
    # audited transition row like any other amendment (Handler ruling
    # 2026-08-10 — closes the last known ISO 7.5.2 hole in this module).
    if row.reportable == reportable and (
        reason is None or reason == row.reportable_reason
    ):
        return row  # no-op

    before = _snapshot(row)
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
        details=_deltas(before, row),
    ))
    db.commit()
    db.refresh(row)
    return row


# Rows in these review_states are still bench-editable — method/instrument
# may be freely (re)stamped. Every other state (verified, published,
# promoted, variance_verified, parent_to_verify, senaite_mirror, rejected,
# retracted, ...) is reported-or-dead: restamping there is an amendment-class
# action, not a bench convenience (R7, 2026-08-19 bench-stamping design §4.5).
STAMPABLE_STATES = ("unassigned", "assigned", "to_be_verified")


def stamp_method_instrument(
    db: Session,
    row: LimsAnalysis,
    *,
    method_id: Optional[int],
    instrument_id: Optional[int],
    user_id: Optional[int] = None,
) -> bool:
    """No-commit core of set_method_instrument. Guards state (R7), applies
    the pair, writes the audit transition. Returns False on no-op. Callers
    commit.

    The state guard is checked unconditionally — even a would-be no-op
    (e.g. method_id=None/instrument_id=None on a row that already carries
    None/None) raises StateLockedError on a locked row. A reported/dead row
    is locked against this call entirely; "nothing would change anyway" is
    not an exemption a caller can rely on.

    Raises StateLockedError if row.review_state is outside STAMPABLE_STATES.
    """
    if row.review_state not in STAMPABLE_STATES:
        raise StateLockedError(row.review_state)

    if row.method_id == method_id and row.instrument_id == instrument_id:
        return False

    before = _snapshot(row)
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
        details=_deltas(before, row),
    ))
    return True


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

    Thin wrapper: load row → stamp_method_instrument (no-commit core,
    R7 state guard) → commit. Raises StateLockedError (mapped to 409 by the
    route layer) if the row is outside STAMPABLE_STATES and the pair would
    actually change.
    """
    row = get_analysis(db, analysis_id)
    if stamp_method_instrument(
        db, row, method_id=method_id, instrument_id=instrument_id, user_id=user_id,
    ):
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
    parent_keyword: Optional[str] = None,
    parent_analysis_service_id: Optional[int] = None,
    parent_title: Optional[str] = None,
    commit: bool = True,
) -> Tuple[LimsAnalysis, List["LimsAnalysisPromotion"]]:
    """Phase 4a: create a parent-tier verified row from N vial-tier sources.

    sources is a list of {analysis_id: int, contribution_kind: str}. The
    parent_sample_pk is derived from the first source's host (sub-sample →
    parent). All sources must:
      - exist
      - be in 'to_be_verified' state
      - share the same identity — keyword (matching the `keyword` arg) for
        origin='senaite' sources, or analysis_service_id (matching the first
        source's service) for origin='mk1' sources, which have no SENAITE
        keyword contract to hold identity steady (native COA sections, spec 2)
      - hang off the same parent_sample_pk

    contribution_kind rules:
      - exactly one source with 'chosen'  OR  every source with 'aggregated_in'
      - 'reference' may accompany 'chosen' but not 'aggregated_in'

    Performs in one transaction:
      1. INSERT parent-tier lims_analyses row (review_state='parent_to_verify',
         verified_at=NULL, analyst_user_id=user_id). Promotion is the
         submission, not the sign-off — a reviewer calls the generic
         transitions endpoint with kind='verify' to reach 'verified'
         (spec 2026-08-04).
      2. INSERT one lims_analysis_promotions per source.
      3. INSERT one audit transition per source (state-unchanged 'auto'
         kind, reason='promoted to parent #N (kind=...)').

    Retest-source supersession: if ALL sources carry retest_of_id IS NOT NULL
    (retest promotion), the active non-retest parent-tier row for
    (parent_sample_pk, keyword) — if 'verified' or 'parent_to_verify' — is
    retracted inside the same transaction before the new parent row is
    inserted, vacating the partial unique index slot. An audit transition
    (reason="superseded by retest promotion") is written on the old row. A
    'published' row is NOT silently retracted — it's a citable COA source, so
    this raises ConflictError instead. Non-retest sources leave the existing
    409 protection intact.

    Parent-target overrides (per-substance promotion): parent_keyword,
    parent_analysis_service_id, and parent_title decouple the parent-tier
    row's identity from the source vial keyword. Used when blend-vial
    per-substance results (e.g. vial PUR_<X> sources) must be stored under a
    generic parent-AR slot (e.g. ANALYTE-{slot}, ANALYTE-2-PUR). Sources are
    still validated against the source `keyword`; only the parent-tier row
    (and the retest-supersession lookup) use the effective parent target.
    Each defaults to None → unchanged behavior (parent row inherits the
    source keyword/service/title).

    When parent_analysis_service_id resolves to a real service row, the
    parent-tier result_unit is taken from THAT service and the caller's
    result_unit is ignored — a unit is a property of the service the result
    is stored under, and the caller sends the source vial's display unit.
    Non-translated promotes keep the caller's unit verbatim.

    Raises:
      - BadRequestError on validation failures.
      - sqlalchemy.exc.IntegrityError if an existing non-retest parent-tier
        row for (parent, keyword) blocks the partial unique index. The route
        layer translates this to 409.
    """
    from models import AnalysisService, LimsAnalysisPromotion, LimsSubSample

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

    # Native (origin='mk1') services have no SENAITE keyword contract to hold
    # identity steady — theirs is the catalog service FK instead. Detected off
    # the FIRST source; every source is then required to share that same
    # service id rather than a keyword string that can drift independently of
    # the FK (see test_native_source_validation_is_id_based).
    first_source_svc = db.get(AnalysisService, source_rows[source_ids[0]].analysis_service_id)
    is_native = first_source_svc is not None and first_source_svc.origin == "mk1"

    parent_sample_pk: Optional[int] = None
    for sid in source_ids:
        row = source_rows[sid]
        if is_native:
            if row.analysis_service_id != first_source_svc.id:
                raise BadRequestError(
                    f"source {sid} has analysis_service_id={row.analysis_service_id}, "
                    f"expected {first_source_svc.id} (native promote is service-keyed)"
                )
        elif row.keyword != keyword:
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
            if sub.assignment_kind == "variance":
                raise BadRequestError(
                    f"source {sid} (vial {sub.sample_id}) is assigned to a "
                    f"variance bucket and cannot be promoted; re-assign it to "
                    f"the core bucket first"
                )
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
    # Effective parent-tier identity: parent_* overrides decouple the
    # parent row from the source vial keyword (per-substance promotion).
    # Default None → inherit the source row's keyword/service/title.
    eff_parent_keyword = parent_keyword or keyword
    eff_service_id = parent_analysis_service_id or first_source.analysis_service_id
    eff_title = parent_title or first_source.title
    if is_native and parent_keyword is None:
        # Native identity comes from the catalog service, not the request
        # string or the (possibly drifted) source row label.
        eff_parent_keyword = first_source_svc.keyword
        eff_title = first_source_svc.title
        if result_unit is None:
            result_unit = first_source_svc.unit

    # The unit belongs to the TARGET service, not to the source vial. On a
    # translated promote the caller sends the SOURCE row's DISPLAY unit, which
    # falls back to the source SERVICE's unit whenever the vial row's
    # result_unit is NULL. Two rogue-seeded per-substance services
    # (PUR_BPC157 id=70, QTY_BPC157 id=4) carry unit='text', which is how 60
    # parent-tier ANALYTE-{n}-PUR/QTY rows were stamped 'text' instead of
    # '%' / 'mg' (measured in prod 2026-07-25). keyword/service/title were
    # already re-pointed above; result_unit was the one field left riding
    # from the source.
    #
    # Scope is deliberately narrow — the unit is re-derived ONLY when a target
    # service was actually resolved. The ordinary (non-translated) promote
    # keeps the caller's value verbatim, because some services legitimately
    # vary per sample: ENDO-LAL is EU/mg for a solid and EU/mL for a solution,
    # and must not be flattened to whatever the seed row happens to say.
    eff_result_unit = result_unit
    if parent_analysis_service_id is not None:
        target_svc = db.get(AnalysisService, parent_analysis_service_id)
        if target_svc is not None:
            # Taken even when the target's unit is NULL: carrying the source's
            # unit across a service change is precisely the defect above, so
            # "no unit on the target" must win over "the source said 'text'".
            eff_result_unit = target_svc.unit

    now = datetime.utcnow()

    # ── Retest-source supersession ────────────────────────────────────────────
    # When ALL sources are retest rows (retest_of_id IS NOT NULL), the caller
    # is re-promoting after a vial retest. The old canonical (non-retest) parent
    # row for (parent_sample_pk, keyword) — if active — must be retracted inside
    # this same transaction to vacate the partial unique index before the new
    # parent row is inserted. Non-retest sources leave the existing 409 guard.
    if all(source_rows[sid].retest_of_id is not None for sid in source_ids):
        # Native services key identity on the service FK (see is_native above);
        # a keyword-string match would miss a drifted label on the old row.
        _ident_clause = (
            LimsAnalysis.analysis_service_id == eff_service_id
            if is_native
            else LimsAnalysis.keyword == eff_parent_keyword
        )
        old_parent = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sample_pk == parent_sample_pk,
                _ident_clause,
                LimsAnalysis.retest_of_id.is_(None),
                # Awaiting (parent_to_verify), VERIFIED and PUBLISHED parents
                # are all superseded. Published joined the list with the
                # published-parent-retest ruling (2026-08-28): retesting a
                # published parent leaves its citable value live (the cascade
                # never retracts published), so the retest re-promote is
                # exactly where the supersede was deferred to — the issued
                # COA PDF is a stored snapshot and is not rewritten by this;
                # regeneration stays a deliberate, separate act.
                LimsAnalysis.review_state.in_(
                    ("verified", "parent_to_verify", "published")
                ),
                LimsAnalysis.lims_sub_sample_pk.is_(None),
                # SENAITE phase-out defense-in-depth: these states already
                # exclude the shadow sentinel ('senaite_mirror'), so this
                # can't change behavior — the canonical partial unique index
                # this lookup protects already scopes to provenance='canonical'
                # (Task 1), so this is a correctness clarification, not a
                # behavior change.
                LimsAnalysis.provenance == "canonical",
            )
        ).scalars().first()
        if old_parent is not None:
            prior_state = old_parent.review_state
            old_parent_before = _snapshot(old_parent)
            old_parent.review_state = "retracted"
            old_parent.updated_at = now
            db.add(LimsAnalysisTransition(
                analysis_id=old_parent.id,
                from_state=prior_state,
                to_state="retracted",
                transition_kind="auto",
                user_id=user_id,
                reason="superseded by retest promotion",
                details=_deltas(old_parent_before, old_parent),
            ))
            db.flush()   # emit UPDATE before INSERT so Postgres sees vacated index slot
        # The former else-branch ConflictError ("COA-snapshot deferral") is
        # gone: published parents are now superseded by the lookup above, so
        # there is no published blocker left for this branch to diagnose.
    # ── end retest-source supersession ───────────────────────────────────────

    # Promotion mints the parent-tier row in 'parent_to_verify' — it is the
    # submission, not the sign-off. verified_at stays NULL until a reviewer
    # calls the generic transitions endpoint with kind='verify' (state
    # machine: parent_to_verify -> verified, spec 2026-08-04).
    parent_row = LimsAnalysis(
        lims_sample_pk=parent_sample_pk,
        lims_sub_sample_pk=None,
        analysis_service_id=eff_service_id,
        keyword=eff_parent_keyword,
        title=eff_title,
        result_value=result_value,
        result_unit=eff_result_unit,
        review_state="parent_to_verify",
        method_id=method_id,
        instrument_id=instrument_id,
        analyst_user_id=user_id,
        created_by_user_id=user_id,
    )
    db.add(parent_row)
    db.flush()

    db.add(LimsAnalysisTransition(
        analysis_id=parent_row.id,
        from_state=None,
        to_state="parent_to_verify",
        transition_kind="auto",
        user_id=user_id,
        reason=f"promoted from sources {source_ids}",
        details={"changed": {}},
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
        src_before = _snapshot(src)
        src.review_state = "promoted"
        src.updated_at = now
        # "auto": a promote is a system-driven side-effect, not a user-initiated
        # transition kind (the reason string records the promote).
        db.add(LimsAnalysisTransition(
            analysis_id=sid,
            from_state=prev_state,
            to_state="promoted",
            transition_kind="auto",
            user_id=user_id,
            reason=f"promoted to parent #{parent_row.id} (kind={kind})",
            details=_deltas(src_before, src),
        ))

    if commit:
        db.commit()
        db.refresh(parent_row)
        for p in promotion_rows:
            db.refresh(p)
    return parent_row, promotion_rows


# ─── Task 5b: native parent analyses read ────────────────────────────────────


def list_native_parent_analyses(db: Session, sample_id: str) -> list:
    """Read-only "Accu-Mk1 Analyses" card (Task 5b): current, origin='mk1'
    parent-tier rows for a parent LimsSample identified by *sample_id*.

    Raises NotFoundError when the sample is unknown to Mk1 (unlike
    list_promotions_for_parent below, which returns [] for that case — this
    endpoint's card is 404-able because the route always names a real
    sample, whereas promotions are read speculatively for any parent page).

    Filters: `lims_sub_sample_pk IS NULL` (parent tier only), `retest_of_id
    IS NULL` (current row, mirrors _eligible_parent_row in
    coa/native_sections.py), `AnalysisService.origin == 'mk1'`, and
    `provenance == 'canonical'`. The last one is the direct exclusion for the
    dormant SENAITE dual-write shadow mirror (lims_analyses/parent_mirror.py)
    — origin alone would usually suffice in practice (mirror_parent_analysis
    only ever mirrors SENAITE AR lines, which resolve to senaite-origin
    services), but that's incidental to how resolve_shadow_target's keyword
    lookup happens to behave, not a guarantee this function should lean on.
    provenance is the discriminator the shadow mirror itself defines, and
    list_promotions_for_parent (below) already filters the identical risk
    the same way.

    No review_state filter: unlike the COA path (fail-closed, only
    verified/published), this is a display card — in-progress rows show too,
    with their review_state badge, same as the SENAITE table.
    """
    from models import AnalysisService, LimsSample
    from lims_analyses.schemas import NativeParentAnalysisRow

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise NotFoundError(f"sample not found: {sample_id}")

    rows = db.execute(
        select(LimsAnalysis)
        .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
        .where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.provenance == "canonical",
            AnalysisService.origin == "mk1",
        )
        .order_by(LimsAnalysis.id.desc())
    ).scalars().all()

    # Latest-per-service dedup: the partial unique index backing the
    # "parent_row_already_exists" 409 (routes.py) is keyed on (lims_sample_pk,
    # keyword), not analysis_service_id — a duplicate-keyword AnalysisService
    # clone (prod precedent: PUR_TB500BETA4, see parent_mirror.py's
    # resolve_shadow_target docstring) could still produce two "current" rows
    # for the same service id. order_by(id.desc()) + first-seen-wins mirrors
    # _eligible_parent_row's resolve-to-newest posture rather than depending
    # on an invariant this function doesn't own.
    seen_service_ids: set[int] = set()
    deduped: list = []
    for analysis in rows:
        if analysis.analysis_service_id in seen_service_ids:
            continue
        seen_service_ids.add(analysis.analysis_service_id)
        deduped.append(analysis)
    deduped.sort(key=lambda a: a.keyword)

    return [NativeParentAnalysisRow.model_validate(a) for a in deduped]


def _overlay_live_vial_state(db: Session, parent_pk: int, shaped: list) -> None:
    """Live vial-state overlay for 'ordered' placeholder rows, in place.

    A surviving placeholder's own review_state is the static mint-time
    'unassigned', but once the catalog seeder has put the work on a vial the
    bench state lives THERE — report the furthest-along LIVE vial state for
    the service instead. Most-advanced (not newest) wins: with multiple
    seeded sibling vials (P-0160 class) the idle later-seeded vial must not
    mask the anchor's progress. Dead rows (retested / retracted / rejected)
    are not live work — a placeholder backed only by those keeps
    'unassigned' (outstanding again). Mutates the serialized pydantic rows,
    never ORM rows — read paths must not flush state changes.

    Shared by the AR-shaped parent listing (the mk1 main table) and the
    native card feed (senaite mode) so a placeholder's badge can never
    disagree between the two surfaces.
    """
    from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
    from models import LimsSubSample

    ordered_service_ids = {
        r.analysis_service_id for r in shaped
        if r.provenance == PROVENANCE_ORDERED and r.analysis_service_id is not None
    }
    if not ordered_service_ids:
        return

    vial_rows = db.execute(
        select(LimsAnalysis)
        .join(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            LimsSubSample.parent_sample_pk == parent_pk,
            LimsAnalysis.analysis_service_id.in_(ordered_service_ids),
            LimsAnalysis.retested.is_(False),
            LimsAnalysis.review_state.notin_(("retracted", "rejected")),
        )
    ).scalars().all()
    _PROGRESS_RANK = {
        "unassigned": 0, "assigned": 1, "to_be_verified": 2, "verified": 3,
    }
    live_state_by_service: dict[int, str] = {}
    for vr in vial_rows:
        rank = _PROGRESS_RANK.get(vr.review_state, -1)
        best = _PROGRESS_RANK.get(
            live_state_by_service.get(vr.analysis_service_id, ""), -1
        )
        if rank > best:
            live_state_by_service[vr.analysis_service_id] = vr.review_state
    for shaped_row in shaped:
        if (shaped_row.provenance == PROVENANCE_ORDERED
                and shaped_row.analysis_service_id in live_state_by_service):
            shaped_row.review_state = live_state_by_service[shaped_row.analysis_service_id]


# Legacy family classifier (profile sections rule 2): SENAITE-era keywords
# mapped to their catalog profile KEYS. Grounded in the seeder's pinned
# legacy map (ROLE_TO_KEYWORDS: endo→ENDO-LAL, ster→STER-PCR; PCR-BACTERIA/
# PCR-FUNGI are the pre-split sterility pair) and the HPLC mirror carve-out
# keyword shapes (HPLC-PUR / PEPT-Total / ID_* / PUR_* / QTY_* / BLEND-*).
# Membership rows on these profiles stay EMPTY by ruling — they are
# load-bearing for the placeholder minter, snapshot, seeder, and COA
# sections; this display-side classifier is how legacy rows get sections
# without touching them. The Bac Water panel has its own SENAITE-era
# services (BW-0156 finding: Benzyl_Alcohol_Assay / FILL-NET-CONTENT /
# PH-DETERM); ENDO/STER lines on a BW sample still classify to their own
# families first — rule order is not load-bearing for them (disjoint
# patterns) but keeps intent readable.
_LEGACY_SECTION_RULES: tuple = (
    ("core", "Core HPLC", 0,
     ("ID_", "PUR_", "QTY_", "BLEND", "HPLC", "PEPT")),
    ("endotoxin", "Endotoxin", 1, ("ENDO",)),
    ("sterility_pcr", "Sterility", 2, ("STER", "PCR-")),
    ("bac_water_panel", "Bac Water", 3, ("BENZYL", "FILL-", "PH-")),
)


def _annotate_profile_sections(db: Session, parent, shaped: list) -> None:
    """Fill profile_section_* on shaped rows, in place (mk1 main table).

    Rule 1 — the sample's FROZEN catalog_snapshot: a row whose
    analysis_service_id appears in a snapshot profile's frozen service_ids
    gets that profile's section, in snapshot order (sort 10+idx). Frozen
    membership means a later catalog edit can never reshuffle an
    already-registered sample's sections — same posture as the seeder.

    Rule 2 — legacy keyword classifier (_LEGACY_SECTION_RULES) for rows the
    snapshot doesn't claim: the SENAITE-era families resolve to their
    catalog profile keys with fixed leading sorts (Core HPLC first).

    Rule 3 — no match: all three fields stay None; the FE renders those
    rows ungrouped with no header (never mislabels).

    Labels resolve live from analysis_profiles.name by key (one bulk
    query) so an admin rename flows through; the legacy fallback label is
    used only when the profile row is missing entirely.
    """
    from models import AnalysisProfile

    snap_profiles = ((getattr(parent, "catalog_snapshot", None) or {})
                     .get("profiles") or [])
    section_by_service: dict[int, tuple] = {}   # service_id -> (key, sort)
    for idx, entry in enumerate(snap_profiles):
        key = entry.get("key")
        if not key:
            continue
        for sid in (entry.get("service_ids") or []):
            section_by_service.setdefault(sid, (key, 10 + idx))

    def _classify(row) -> tuple:
        sid = row.analysis_service_id
        if sid is not None and sid in section_by_service:
            return section_by_service[sid]
        kw = (row.keyword or "").upper()
        if kw:
            for key, _label, sort, prefixes in _LEGACY_SECTION_RULES:
                if any(kw.startswith(p) or (len(p) > 3 and p in kw)
                       for p in prefixes):
                    return (key, sort)
        return (None, None)

    resolved = [_classify(r) for r in shaped]
    needed_keys = {key for key, _ in resolved if key}
    if not needed_keys:
        return
    names_by_key = {
        p.key: p.name for p in db.query(AnalysisProfile)
        .filter(AnalysisProfile.key.in_(needed_keys)).all()
    }
    legacy_labels = {key: label for key, label, _s, _p in _LEGACY_SECTION_RULES}
    for row, (key, sort) in zip(shaped, resolved):
        if key is None:
            continue
        row.profile_section_key = key
        row.profile_section_label = names_by_key.get(key) or legacy_labels.get(key) or key
        row.profile_section_sort = sort


def list_native_parent_analyses_senaite_shape(
    db: Session, sample_id: str
) -> List["SenaiteShapeAnalysisResponse"]:
    """Native (origin='mk1') parent-tier rows projected to the FE's
    SenaiteAnalysis shape for the shared AnalysisTable (native parent
    analyses card).

    Row set intentionally differs from list_native_parent_analyses (the
    6-field card read): ALL review states and the full lineage (retracted
    old roots, retest rows) are included with no latest-per-service dedup —
    the table groups by title and renders history rows itself, taking the
    LAST row as current (hence ORDER BY keyword, id). Shadow rows and
    senaite-origin services stay excluded: this is the native section, not
    a mirror of the SENAITE AR (that surface is
    list_parent_analyses_senaite_shape).

    provenance also admits PROVENANCE_ORDERED (registration-time
    placeholders — see lims_analyses/parent_placeholders.py) so a paid-for
    native test is visible before any vial/promotion exists. Placeholders
    are never retired once a canonical row lands for the same service
    (matching SENAITE shadow-row lifecycle), so the two can coexist here;
    they are deduped after fetch below, canonical winning.
    """
    from models import AnalysisService, LimsSample
    from lims_analyses.parent_placeholders import PROVENANCE_ORDERED

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise NotFoundError(f"sample {sample_id!r} not known to Mk1")
    fetched = list(
        db.execute(
            select(LimsAnalysis)
            .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .where(
                LimsAnalysis.lims_sample_pk == parent.id,
                LimsAnalysis.lims_sub_sample_pk.is_(None),
                LimsAnalysis.provenance.in_(("canonical", PROVENANCE_ORDERED)),
                AnalysisService.origin == "mk1",
            )
            .order_by(LimsAnalysis.keyword, LimsAnalysis.id)
        ).scalars().all()
    )

    # A service can legitimately have BOTH an 'ordered' placeholder and a
    # 'canonical' promoted row (the placeholder is never retired, matching
    # SENAITE shadow-row behaviour). Suppress the placeholder wherever a
    # LIVE canonical row exists for the same service — canonical wins. This
    # must NOT collapse multiple canonical rows for the same service: the
    # function's own contract (see docstring) is full lineage with no
    # latest-per-service dedup, e.g. a retracted old root alongside its
    # active replacement both stay. Only 'ordered' rows are ever dropped
    # here; 'canonical' rows are never suppressed against each other.
    #
    # "Live" excludes retracted/rejected on purpose: a placeholder means
    # "this paid test is still outstanding," and a retracted or rejected
    # canonical row does not discharge that — the result was thrown away,
    # so the test is outstanding again and the bench must still see it.
    # Suppressing against a dead canonical row would silently hide that
    # regression, recreating the exact invisibility this feature exists to
    # remove. Mirrors the live-only collapse in
    # list_parent_analyses_senaite_shape (shadow-vs-canonical). Do not
    # "simplify" this back to "any canonical" — that was tried and is wrong.
    services_with_live_canonical = {
        r.analysis_service_id for r in fetched
        if r.provenance == "canonical" and r.review_state not in ("retracted", "rejected")
    }
    rows = [
        r for r in fetched
        if r.provenance == "canonical" or r.analysis_service_id not in services_with_live_canonical
    ]

    shaped = _serialize_senaite_shape_rows(db, rows)
    _overlay_live_vial_state(db, parent.id, shaped)
    return shaped


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
            # SENAITE phase-out defense-in-depth: this query has no
            # review_state filter, so it would otherwise structurally match a
            # shadow row (same lims_sample_pk, lims_sub_sample_pk IS NULL). In
            # practice shadow rows never carry a LimsAnalysisPromotion link
            # (only promote_to_parent creates those, and it always writes
            # provenance='canonical'), so the `if not promo_rows: continue`
            # below already filters them out — this clause makes the exclusion
            # direct instead of incidental.
            LimsAnalysis.provenance == "canonical",
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


# ─── Read-flip L4/Task1: parent-tier analyses in senaite shape ──────────────


def list_parent_analyses_senaite_shape(
    db: Session,
    parent_sample_id: str,
) -> List["SenaiteShapeAnalysisResponse"]:
    """Parent-tier analyses (SENAITE AR line items), projected to the FE's
    SenaiteAnalysis shape via the shared _serialize_senaite_shape_rows
    helper -- the read-flip's native substitute for SENAITE's own analyses
    proxy on the parent AR page.

    Row selection: rows hosted directly on the parent (lims_sample_pk ==
    parent.id, lims_sub_sample_pk IS NULL), across BOTH provenances --
    'canonical' (native promote_to_parent results) and 'shadow' (SENAITE
    mirror rows written by parent_mirror.mirror_parent_analysis). Unlike
    list_promotions_for_parent just above (which deliberately scopes to
    provenance='canonical' -- it reports on *promotions*, a canonical-only
    concept), this reads the full parent-tier analysis surface regardless
    of which side authored the row -- that's the read-flip's whole point.

    Tier guard: host shape alone (lims_sample_pk set, no sub-sample) is NOT
    sufficient -- a parent can also host VIAL-tier rows. That shape is
    reachable, not hypothetical: create_analysis(host_kind="sample") mints
    a parent-hosted row in 'unassigned' via the authenticated
    POST /api/lims-analyses (routes.py passes host_kind straight through),
    and state_machine.tier_of explicitly models it ("the parent acting as
    a vial in a variance set, mid-run": parent-hosted +
    unassigned/assigned/to_be_verified => TIER_VIAL). Those rows belong to
    the variance UI, not this AR-shaped analyses view -- they have no
    SENAITE counterpart, so surfacing them here would be a guaranteed
    mk1-vs-senaite parity diff (phantom 'unassigned' lines in mk1 mode).
    Canonical rows are therefore filtered per-row through
    state_machine.tier_of itself (no parallel state list to drift), keeping
    only TIER_PARENT. Shadow rows bypass the check: they are parent-tier by
    construction (parent_mirror.py writes them only against the parent
    host), and their sentinel review_state ('senaite_mirror') is not in
    tier_of's parent-state set, so running them through tier_of would
    misclassify them as TIER_VIAL.

    "Current" row resolution mirrors resolve_shadow_target's shadow-side
    semantics (retested=False is the liveness signal, not retest_of_id --
    see parent_mirror.py's _existing_shadow docstring). Canonical parent-tier
    rows can never actually flip retested=True: state_machine.tier_allows
    for TIER_PARENT is {publish, retract, auto} -- 'retest' isn't among
    them, so apply_transition's retest branch (the only place that sets
    retested=True) is unreachable for a parent-hosted canonical row. Instead,
    a superseded canonical row is RETRACTED (promote_to_parent's retest-
    source supersession, cascade_parent_retest_to_sources's un-promote,
    force_retract_analysis) while retested stays False. So a
    retested==False-only filter would leave every superseded canonical row
    visible; review_state != 'retracted' is layered on for canonical rows
    only to close that gap. ('rejected' is deliberately not excluded
    alongside it, unlike the DB's uq_lims_analyses_parent_service_root
    partial index -- 'reject' is not a TIER_PARENT-legal kind, so a
    canonical parent-tier row can never reach review_state='rejected'; the
    asymmetry with the index is inert, not a gap.) Shadow rows don't need
    this extra clause: mirror_parent_analysis's is_retest branch DOES set
    retested=True on the row it supersedes, so retested==False already
    excludes it there. One accepted asymmetry this implies: a *live*
    (retested=False) shadow row whose mirror_review_state is 'retracted'
    (SENAITE retracted the line and no replacement has synced yet) still
    surfaces with review_state='retracted' in the output -- faithful to
    SENAITE's actual state, not filtered, since the shadow side has no
    review_state-based exclusion.

    review_state in the output: mirror_review_state for shadow rows (the
    true SENAITE state -- their own review_state column carries the
    sentinel 'senaite_mirror'), review_state for canonical rows. Resolved
    inside the shared helper.

    Returns [] when the parent sample_id is unknown (not a 404 -- mirrors
    list_promotions_for_parent's contract; parent pages for samples that
    were never promoted/mirrored call this too).
    """
    from models import LimsSample

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return []

    from lims_analyses.parent_placeholders import PROVENANCE_ORDERED

    rows = list(db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.retested.is_(False),
            or_(
                and_(
                    LimsAnalysis.provenance == "canonical",
                    LimsAnalysis.review_state != "retracted",
                ),
                LimsAnalysis.provenance == "shadow",
                # Pre-promotion native demand (parent_placeholders.py): the
                # mk1 main table is where a paid-for native test must be
                # visible before any promotion exists — the separate
                # transitional card no longer renders in mk1 read mode.
                LimsAnalysis.provenance == PROVENANCE_ORDERED,
            ),
        ).order_by(LimsAnalysis.keyword, LimsAnalysis.id)
    ).scalars().all())

    # Tier guard (see docstring): canonical rows must be parent-TIER per the
    # state machine's own discriminator -- a parent-acting-as-vial mid-run
    # row (TIER_VIAL) belongs to the variance UI, not this AR-shaped view.
    # In-memory filter on the already-fetched rows (no per-row queries);
    # tier_of is pure. Shadow rows bypass: parent-tier by construction,
    # and their sentinel review_state would misclassify under tier_of.
    # Ordered placeholders bypass for the same reason: their permanent
    # 'unassigned' would misclassify as TIER_VIAL, but they are demand
    # markers, not variance mid-run rows — the guard's target class is
    # provenance='canonical' only.
    rows = [
        r for r in rows
        if r.provenance in ("shadow", PROVENANCE_ORDERED)
        or tier_of(
            lims_sample_pk=r.lims_sample_pk,
            lims_sub_sample_pk=r.lims_sub_sample_pk,
            review_state=r.review_state,
        ) == TIER_PARENT
    ]

    # Canonical-wins placeholder suppression (mirrors the native card feed):
    # a service with a LIVE canonical row has been delivered — its
    # placeholder drops. Keyed by service id (placeholders always share the
    # service row they were minted from). Retracted canonicals are already
    # excluded from `rows` by the query, so a thrown-away result correctly
    # leaves the placeholder visible: the test is outstanding again.
    delivered_service_ids = {
        r.analysis_service_id for r in rows if r.provenance == "canonical"
    }
    rows = [
        r for r in rows
        if r.provenance != PROVENANCE_ORDERED
        or r.analysis_service_id not in delivered_service_ids
    ]

    # Cross-provenance keyword collapse (UAT catch, P-0143 promote flow):
    # promote_to_parent authors a live canonical row AND pushes the result to
    # SENAITE via the identity bridge, whose submit event the mirror echoes
    # straight back as a live shadow row for the same keyword — both are
    # "current" by their own provenance's liveness rules, and this AR-shaped
    # view would show the test twice. The canonical row IS the native
    # authority for that line, so a shadow is emitted only when no live
    # canonical shares its keyword. Keyword (not service id) is the collapse
    # key: the mirror resolves duplicate-keyword services to the lowest id
    # (resolve_shadow_target), so the two provenances can legitimately hold
    # different service ids for the same logical line.
    canonical_keywords = {r.keyword for r in rows if r.provenance == "canonical"}
    rows = [
        r for r in rows
        if r.provenance == "canonical" or r.keyword not in canonical_keywords
    ]

    shaped = _serialize_senaite_shape_rows(db, rows)
    _overlay_live_vial_state(db, parent.id, shaped)
    _annotate_profile_sections(db, parent, shaped)
    return shaped


def list_variance_verifications_for_parent(
    db: Session,
    parent_sample_id: str,
) -> list[dict]:
    """Return one grouped variance-verification event per vial for the parent
    LimsSample *parent_sample_id*, for the federated sample activity log.

    Variance replicate vials never get promoted — they terminate in the
    ``variance_verified`` state and feed the variance series. That act has no
    promotion row and so was invisible in the activity timeline. We derive it
    from the append-only ``lims_analysis_transitions`` log (to_state =
    ``variance_verified``), which means already-verified vials surface
    retroactively without any new write.

    Each dict: ``{vial_sample_id, vial_sequence, count, occurred_at, by_email}``
    where ``count`` is distinct analyses verified on that vial and
    ``occurred_at`` / ``by_email`` come from the latest such transition.
    Empty list when the sample is unknown or has no variance verifications.
    """
    from models import LimsSubSample, LimsAnalysisTransition, User
    from models import LimsSample

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return []

    vials = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
    ).scalars().all()
    if not vials:
        return []
    vial_by_id = {v.id: v for v in vials}

    rows = db.execute(
        select(LimsAnalysisTransition, LimsAnalysis.lims_sub_sample_pk)
        .join(LimsAnalysis, LimsAnalysisTransition.analysis_id == LimsAnalysis.id)
        .where(
            LimsAnalysisTransition.to_state == "variance_verified",
            LimsAnalysis.lims_sub_sample_pk.in_(list(vial_by_id.keys())),
        )
    ).all()

    # Group by vial. Count DISTINCT analyses (a vial re-verified after a
    # retract would log multiple transitions for the same analysis); the
    # latest transition supplies the timestamp + attribution.
    analyses_by_vial: dict[int, set[int]] = {}
    latest_txn_by_vial: dict[int, "LimsAnalysisTransition"] = {}
    for txn, vial_pk in rows:
        analyses_by_vial.setdefault(vial_pk, set()).add(txn.analysis_id)
        cur = latest_txn_by_vial.get(vial_pk)
        if cur is None or txn.occurred_at > cur.occurred_at:
            latest_txn_by_vial[vial_pk] = txn

    out: list[dict] = []
    for vial_pk, analysis_ids in analyses_by_vial.items():
        latest = latest_txn_by_vial[vial_pk]
        by_email: Optional[str] = None
        if latest.user_id is not None:
            u = db.get(User, latest.user_id)
            if u is not None:
                by_email = u.email
        vial = vial_by_id[vial_pk]
        out.append({
            "vial_sample_id": vial.sample_id,
            "vial_sequence": vial.vial_sequence,
            "count": len(analysis_ids),
            "occurred_at": latest.occurred_at,
            "by_email": by_email,
        })

    out.sort(key=lambda e: (e["vial_sequence"] or 0))
    return out


def transition_has_amendment(details) -> bool:
    """True when a transition row carries a non-empty details["changed"] —
    i.e. the curated amendment source will render it and the generic A1
    activity line should NOT (Handler ruling 2026-08-10, one line per event).
    NULL details (pre-slice / mirror-exempt) and {"changed": {}} both return
    False — those rows keep their generic line."""
    return bool((details or {}).get("changed"))


def list_analysis_change_events_for_parent(
    db: Session,
    parent_sample_id: str,
) -> list[dict]:
    """Amendment-audit events for the federated sample activity log
    (spec 2026-08-07 §2.6).

    Emits ONLY transitions whose details["changed"] is non-empty — the
    change history. State-only rows ({"changed": {}}) are skipped (promote /
    verify / variance already have richer dedicated events in the timeline);
    NULL-details rows predate capture and have nothing to render.

    Two event types:
      result_entered   — result_value went None -> value and nothing outside
                         {result_value, result_unit} changed
      analysis_amended — every other non-empty change (corrections,
                         method/instrument, reportable, un-promote clears)
    """
    from models import LimsAnalysisTransition, LimsSample, LimsSubSample, User

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return []

    vials = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
    ).scalars().all()
    vial_by_id = {v.id: v for v in vials}

    host_filter = LimsAnalysis.lims_sample_pk == parent.id
    if vial_by_id:
        host_filter = host_filter | LimsAnalysis.lims_sub_sample_pk.in_(
            list(vial_by_id.keys())
        )

    rows = db.execute(
        select(LimsAnalysisTransition, LimsAnalysis)
        .join(LimsAnalysis, LimsAnalysisTransition.analysis_id == LimsAnalysis.id)
        .where(host_filter, LimsAnalysisTransition.details.isnot(None))
        .order_by(LimsAnalysisTransition.occurred_at, LimsAnalysisTransition.id)
    ).all()

    events: list[dict] = []
    for t, a in rows:
        changed = (t.details or {}).get("changed") or {}
        if not changed:
            continue  # state-only move — dedicated events cover these

        by_email = None
        if t.user_id:
            u = db.get(User, t.user_id)
            by_email = u.email if u else None

        vial = vial_by_id.get(a.lims_sub_sample_pk)
        where = f" ({vial.sample_id})" if vial else ""

        rv = changed.get("result_value")
        only_result = set(changed) <= {"result_value", "result_unit"}
        if rv and rv["before"] is None and rv["after"] is not None and only_result:
            event = "result_entered"
            label = f"Result entered — {a.title}: {rv['after']}{where}"
        else:
            event = "analysis_amended"
            frags = ", ".join(
                f"{f} {c['before']} → {c['after']}" if f != "result_value"
                else f"{c['before']} → {c['after']}"
                for f, c in changed.items()
            )
            verb = "Result corrected" if rv else "Analysis amended"
            label = f"{verb} — {a.title}: {frags}{where}"

        events.append({
            "timestamp": t.occurred_at.isoformat() if t.occurred_at else None,
            "event": event,
            "label": label,
            "details": {"changed": changed, "by": by_email,
                        "vial": vial.sample_id if vial else None,
                        "analysis_id": a.id, "keyword": a.keyword},
            "source": "lims_analysis_transitions",
        })
    return events


# ─── Phase 4c: parent-retest cascade ────────────────────────────────────────


def _find_active_parent_row(
    db: Session,
    *,
    parent_sample_pk: int,
    keyword: str,
    analysis_service_id: Optional[int] = None,
    allow_native_rescue: bool = True,
) -> Optional[LimsAnalysis]:
    """Resolve the one active canonical parent-tier row a retest lineage hangs
    off. Shared by cascade_parent_retest_to_sources and parent_retest so the
    two can never drift apart — their predicates were already identical.

    Identity resolution (S3), in order:

      1. explicit `analysis_service_id` — the caller already holds the native
         identity key, so match on the service FK alone with no keyword term.
      2. exact stored keyword — byte-identical to the pre-S3 lookup.
      3. mk1 catalog rescue — ONLY when (2) misses: resolve `keyword` against
         the catalog scoped to origin='mk1' (unique per
         uq_analysis_services_mk1_keyword) and retry by service FK. This is
         what reaches a native row whose stored keyword drifted away from its
         catalog keyword.

    Deliberately NOT promote's `_ident_clause` ternary (:850-857). Promote
    holds the source ROW and reads its service FK before querying; these two
    callers hold only a keyword off a keyword-boundary wire, so a ternary
    would have to resolve keyword→service up front — which mis-routes when a
    drifted row squats on ANOTHER service's catalog keyword. Both root indexes
    permit row X (service 42, stored 'PUR_OLD', catalog 'PUR_NEW') and row Y
    (service 99, stored 'PUR_NEW') to be live on the same parent at once, and
    a caller sending 'PUR_NEW' means Y — that is the string Y answers to, and
    what the FE echoes (it sends row.keyword; see _serialize_senaite_shape_rows).
    Exact-first keeps that caller on Y and reaches X only when nothing answers
    to the string at all.

    senaite-origin services get no rescue leg: their keyword IS their identity
    contract, grandfathered.

    `allow_native_rescue=False` disables leg 3 entirely, for callers whose
    keyword arrives off a FOREIGN namespace — main.py's SENAITE-transition
    webhook. Scoping leg 3 to origin='mk1' is not sufficient protection there:
    uq_analysis_services_mk1_keyword is PARTIAL on origin='mk1', so it does not
    stop an mk1 service and a senaite service from sharing a keyword string
    (validate_new_keyword covers Mk1-side creation, not SENAITE sync). Without
    this opt-out a SENAITE retest for keyword K, finding no live canonical row
    for K, would rescue into an unrelated NATIVE line that merely shares the
    string and retract its vial results — and that caller swallows exceptions,
    so it would fail silently. For the SENAITE wire, legs 1-2 alone ARE the
    grandfathered pre-S3 behavior.

    provenance == 'canonical' is REQUIRED here, not defense-in-depth: unlike
    the other readers in this module, review_state.not_in(("retracted",
    "rejected")) does NOT exclude the shadow sentinel state ('senaite_mirror'),
    so a shadow row for this (parent, keyword) would match. Without the
    provenance term, `.first()` (no ORDER BY) could nondeterministically return
    the shadow row instead of the real canonical parent row when both exist.
    That shadow row never has a LimsAnalysisPromotion link, so the caller would
    find no sources and silently no-op instead of retesting the vials the
    canonical row actually promoted — a real (not cosmetic) correctness gap.
    """
    from models import AnalysisService

    base = (
        LimsAnalysis.lims_sample_pk == parent_sample_pk,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.retest_of_id.is_(None),
        LimsAnalysis.review_state.not_in(("retracted", "rejected")),
        LimsAnalysis.provenance == "canonical",
    )

    def _first(ident):
        return db.execute(
            select(LimsAnalysis).where(*base, ident)
        ).scalars().first()

    if analysis_service_id is not None:
        return _first(LimsAnalysis.analysis_service_id == analysis_service_id)

    row = _first(LimsAnalysis.keyword == keyword)
    if row is not None or not allow_native_rescue:
        return row

    native_svc = db.execute(
        select(AnalysisService).where(
            AnalysisService.keyword == keyword,
            AnalysisService.origin == "mk1",
        ).order_by(AnalysisService.id)
    ).scalars().first()
    if native_svc is None:
        return None
    return _first(LimsAnalysis.analysis_service_id == native_svc.id)


def cascade_parent_retest_to_sources(
    db: Session,
    *,
    parent_sample_id: str,
    keyword: str,
    user_id: Optional[int],
    source_reason: str = "cascaded from parent SENAITE retest",
    analysis_service_id: Optional[int] = None,
    allow_native_rescue: bool = True,
) -> list[int]:
    """When a PARENT-tier analysis is retested (via SENAITE), cascade the retest
    down to each source vial-tier analysis that was promoted into that parent.

    Resolution chain:
      parent_sample_id → LimsSample → active parent-tier LimsAnalysis
        (lims_sub_sample_pk IS NULL, retest_of_id IS NULL, not retracted/rejected)
        identified per _find_active_parent_row
      → LimsAnalysisPromotion.source_analysis_id rows
      → source LimsAnalysis rows that are eligible for retest
        (state in to_be_verified/verified/promoted AND not already retested)
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

    # 2. Find the active parent-tier analysis. Identity resolution (service id
    #    → exact keyword → mk1 catalog rescue), the reason the shape differs
    #    from promote's ternary, and why the SENAITE wire passes
    #    allow_native_rescue=False all live in _find_active_parent_row.
    parent_analysis = _find_active_parent_row(
        db,
        parent_sample_pk=parent_sample.id,
        keyword=keyword,
        analysis_service_id=analysis_service_id,
        allow_native_rescue=allow_native_rescue,
    )
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
        # "verified": grandfathered vial rows from before vial-verify was removed
        # (kept for backward-compat); "promoted": the post-promote normal path.
        if src.review_state not in ("to_be_verified", "verified", "promoted"):
            continue  # not retest-eligible
        try:
            new_row = apply_transition(
                db,
                analysis_id=src.id,
                kind="retest",
                reason=source_reason,
                user_id=user_id,
            )
            new_row_ids.append(new_row.id)
        except Exception:
            # Log at call site; don't let one bad source kill the rest.
            pass

    # 5. Un-promote the parent. Its promoted value came from a source we just
    #    retested, so it now reflects superseded data — clear it immediately
    #    rather than leaving the stale figure until a re-promote. Retracting
    #    (not deleting) mirrors the re-promote supersession in promote_to_parent
    #    and vacates the partial unique index (which excludes 'retracted'), so
    #    the eventual re-promote inserts cleanly. NEVER retract a PUBLISHED
    #    parent — it's a citable COA source; that path is invalidate→retest.
    #    'parent_to_verify' (awaiting sign-off) un-promotes too — an unverified
    #    row is not yet citable, but its stale value must not linger either.
    if new_row_ids and parent_analysis.review_state in ("verified", "parent_to_verify"):
        prior_state = parent_analysis.review_state
        parent_before = _snapshot(parent_analysis)
        parent_analysis.review_state = "retracted"
        # Clear the promoted figure too: the display serialization
        # (list_analyses_for_host) filters by retest_of_id, NOT state, so a
        # retracted parent still renders — leaving the stale value visible.
        # The superseded SOURCE vial row keeps the old value for history.
        parent_analysis.result_value = None
        parent_analysis.result_unit = None
        parent_analysis.updated_at = datetime.utcnow()
        db.add(LimsAnalysisTransition(
            analysis_id=parent_analysis.id,
            from_state=prior_state,
            to_state="retracted",
            transition_kind="auto",
            user_id=user_id,
            reason="un-promoted: source vial retested",
            details=_deltas(parent_before, parent_analysis),
        ))
        db.commit()

    return new_row_ids


def parent_retest(
    db: Session,
    *,
    sample_id: str,
    keyword: str,
    user_id: Optional[int],
    reason: Optional[str] = None,
    analysis_service_id: Optional[int] = None,
) -> tuple[list[int], Optional[str]]:
    """Native origination of a parent-tier retest: validate, then run the
    existing cascade (retest promoted sources + un-promote the verified or
    awaiting parent). The generic transitions endpoint tier-blocks 'retest' at
    TIER_PARENT on purpose — this is the dedicated, fail-closed path.

    Fail-closed guard: the active canonical parent row for the keyword must
    be 'verified' or 'parent_to_verify' (awaiting sign-off). Without it, a
    direct API caller could retract vial results under a PUBLISHED parent
    (the cascade retests sources regardless of parent state; only its
    un-promote step checks review_state).

    Activity event (Task 7): 'parent_analysis_retested' is written AFTER the
    cascade returns, in a commit of its own — not literally inside the
    cascade's transaction, since cascade_parent_retest_to_sources owns and
    commits its own per-source retests plus the un-promote step before this
    function regains control. This is a known, structural deviation from
    "same transaction as the act": the event lands in the commit
    immediately following the state change, not folded into it.
    """
    from models import LimsSample

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise NotFoundError(f"sample {sample_id!r} not known to Mk1")
    # Identity resolution (service id → exact keyword → mk1 catalog rescue) and
    # why the shape differs from promote's ternary: see _find_active_parent_row.
    active = _find_active_parent_row(
        db,
        parent_sample_pk=parent.id,
        keyword=keyword,
        analysis_service_id=analysis_service_id,
    )
    if active is None:
        # Name the identity that was actually used, not always the keyword —
        # a service-id caller passes keyword only as the legacy alias, so
        # echoing it would point the operator at the wrong thing.
        _asked = (
            f"analysis_service_id={analysis_service_id}"
            if analysis_service_id is not None
            else f"keyword {keyword!r}"
        )
        raise NotFoundError(
            f"no active native parent row for {_asked} on {sample_id!r}"
        )
    if active.review_state not in ("verified", "parent_to_verify", "published"):
        raise InvalidTransitionError(
            active.review_state,
            "retest",
            message=(
                "parent retest requires the parent row to be 'verified', "
                f"'parent_to_verify' or 'published'; row is "
                f"{active.review_state!r}"
            ),
        )
    # State AT THE CALL, before the cascade's un-promote can flip a
    # verified/awaiting row to 'retracted' — both the published branch below
    # and the activity event key off what the operator actually retested.
    state_at_retest = active.review_state
    # Thread the resolved row's own service FK down rather than letting the
    # cascade re-derive identity from the keyword: whatever leg found `active`
    # above, the cascade must act on the row this function just guarded — the
    # pre-S3 shape re-resolved and could in principle land elsewhere. Safe for
    # senaite rows too: uq_lims_analyses_parent_service_id_root (Task 2) is
    # origin-agnostic, so at most one live canonical row per (parent, service).
    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=sample_id,
        keyword=keyword,
        user_id=user_id,
        source_reason=reason or "retested from parent (native)",
        analysis_service_id=active.analysis_service_id,
    )
    db.refresh(active)

    # source_row_ids = the ORIGINAL (now-retested) source rows, not the new
    # replacement rows cascade minted — same vocabulary as
    # LimsAnalysisPromotion.source_analysis_id.
    source_row_ids: list[int] = []
    if new_ids:
        source_row_ids = [
            sid for sid in db.execute(
                select(LimsAnalysis.retest_of_id).where(LimsAnalysis.id.in_(new_ids))
            ).scalars().all()
            if sid is not None
        ]

    # Published branch (Handler ruling 2026-08-28): the cascade deliberately
    # never retracts a published parent — the published value stays the
    # citable figure until the retest's re-promote supersedes it
    # (promote_to_parent's retest-source supersession). Mark the row
    # `retested` so the FE stops offering the verb while the re-run is in
    # flight, and leave a row-level audit transition (published→published)
    # so the act is traceable on the row itself, not only in the sample
    # activity feed. Both only when the cascade actually created retest rows.
    if new_ids and state_at_retest == "published":
        active_before = _snapshot(active)
        active.retested = True
        active.updated_at = datetime.utcnow()
        db.add(LimsAnalysisTransition(
            analysis_id=active.id,
            from_state="published",
            to_state="published",
            transition_kind="auto",
            user_id=user_id,
            reason=(
                "parent retested; published value retained until re-promote "
                "supersedes it"
            ),
            details=_deltas(active_before, active),
        ))

    from models import AnalysisService
    svc = db.get(AnalysisService, active.analysis_service_id)
    # Record the RESOLVED row's identity, not the caller's input string: since
    # S3 the two can differ (service-id caller, or the catalog-rescue leg), and
    # an audit row whose keyword doesn't name the row that was retested is
    # worse than no keyword at all. Identical for every pre-S3 caller.
    _details = {
        "keyword": active.keyword,
        "analysis_service_id": active.analysis_service_id,
        "source_row_ids": source_row_ids,
        "unpromoted": active.review_state == "retracted",
        "parent_review_state_at_retest": state_at_retest,
        "service_origin": svc.origin if svc else None,
    }
    if keyword != active.keyword:
        _details["requested_keyword"] = keyword
    db.add(LimsSubSampleEvent(
        lims_sample_pk=active.lims_sample_pk,
        event="parent_analysis_retested",
        details=_details,
        user_id=user_id,
    ))
    db.commit()

    return new_ids, active.review_state


def vial_source_retest(
    db: Session,
    *,
    analysis_id: int,
    user_id: Optional[int],
    reason: Optional[str] = None,
) -> tuple[int, bool, Optional[str]]:
    """Native origination of a vial-side (source) retest: the up-cascade
    mirror of parent_retest's down-cascade. Retests ONE named promoted
    source row directly (rather than every source under a parent+keyword),
    then resolves its promotion and un-promotes the parent if it's still
    unverified-citable.

    Fail-closed guards (resolve -> guard -> act -> re-read), in the order
    the route's error table specifies:
      1. row must exist (NotFoundError -> 404)
      2. row must be vial-hosted (lims_sub_sample_pk IS NOT NULL) and in
         review_state == 'promoted' (InvalidTransitionError -> 409) —
         this explicitly excludes the "parent acting as a vial" promotion
         source (state_machine.tier_of's other TIER_VIAL shape); that one
         has no dedicated up-cascade route yet.
      3. row must not already be retested (InvalidTransitionError -> 409)
         — apply_transition's retest branch never mutates review_state
         (only retested + a new linked row), so a row stays 'promoted'
         forever after being retested once and would otherwise still
         clear guard 2 on a second call. See the idempotency comment at
         the guard site for why this is a 409, not the pristine-delete
         path's 400.
      4. the row's AnalysisService.origin must be 'mk1' (BadRequestError ->
         400) — SENAITE-origin sources retest from the parent AR; this
         route only understands the native identity path.

    Un-promote guard mirrors cascade_parent_retest_to_sources step 5
    exactly: parent in ('verified', 'parent_to_verify') -> retract + clear
    result + audit; parent 'published' (a citable COA source) is left
    untouched and parent_unverified is False.

    Transaction shape: apply_transition(kind='retest') owns and commits its
    own single-row transaction (new retest row insert + retested=True flag
    + audit, all before it returns) — that commit boundary is intentionally
    not widened here, same as cascade_parent_retest_to_sources's per-source
    retest calls. Everything after is a SECOND, separate commit: the
    un-promote mutation (when the parent is still 'verified' or
    'parent_to_verify') AND the 'promoted_source_retested' activity event
    (Task 7, written unconditionally — even when there's no un-promote to
    do) now share that one commit. This is deliberately two commits, not
    one wrapping transaction: if the second commit were to fail, the retest
    stays durable and visible (correct — the source really was retested)
    while the parent is left carrying a now-stale promoted value AND no
    activity event is recorded for this act — a display-staleness gap that
    now also means the event log is incomplete for that one call. Recovery
    for THAT gap is NOT re-running this route (guard 3 above now 409s on
    the already-retested row) — it's the parent-tier retest route (which
    cascades off the parent+keyword rather than this row) or an admin fix.
    That is the same accepted trade-off cascade_parent_retest_to_sources
    already makes for the down-cascade's multi-source loop; sequencing the
    un-promote+event AFTER the retest commit (never before) is what
    guarantees "retest committed, un-promote-and-event lost" is the only
    possible partial-failure shape — never the reverse.
    """
    from models import AnalysisService, LimsAnalysisPromotion

    row = get_analysis(db, analysis_id)  # NotFoundError -> 404

    if row.lims_sub_sample_pk is None or row.review_state != "promoted":
        raise InvalidTransitionError(
            row.review_state,
            "retest",
            message=(
                "source retest requires a vial-hosted row in 'promoted' "
                "state; row is "
                + (
                    "parent-hosted"
                    if row.lims_sub_sample_pk is None
                    else f"{row.review_state!r}"
                )
            ),
        )

    # Idempotency guard: apply_transition's retest branch (service.py
    # ~284-343) only sets retested=True and inserts the new linked row —
    # it never touches review_state, so the row above stays 'promoted'
    # forever and would otherwise still pass the guard just above on a
    # second identical POST (double-click, retried request). Without this,
    # a repeat call would mint a SECOND unassigned retest row with
    # retest_of_id == row.id — an orphan the partial unique index doesn't
    # catch (it only covers retest_of_id IS NULL) — plus a second
    # un-promote pass. retested=True is the codebase's established
    # has-activity sentinel (mirrors the per-source skip in
    # cascade_parent_retest_to_sources: `if src.retested: continue`,
    # service.py ~1400, and the pristine-delete guard at ~2410). We raise
    # InvalidTransitionError/409 here — not that pristine-delete
    # function's BadRequestError/400 — because this is the SAME kind of
    # question as the guard immediately above (is this row's state shape
    # legal for a retest transition right now), not a structural
    # request-shape question like the mk1-origin check below.
    if row.retested:
        raise InvalidTransitionError(
            row.review_state,
            "retest",
            message=(
                f"analysis id={row.id} has already been retested "
                "(retested=True) — source retest is not repeatable "
                "from this row"
            ),
        )

    svc = db.get(AnalysisService, row.analysis_service_id)
    if svc is None or svc.origin != "mk1":
        raise BadRequestError(
            "SENAITE-origin rows retest from the parent AR — sub-side "
            "retest dead-ends on the write-back"
        )

    new_row = apply_transition(
        db,
        analysis_id=row.id,
        kind="retest",
        reason=reason or "retested from vial (source retest)",
        user_id=user_id,
    )

    parent_unverified = False
    parent_review_state: Optional[str] = None
    parent_state_before: Optional[str] = None
    parent = None

    # No unique constraint on source_analysis_id — a row that somehow gets
    # promoted twice (e.g. reopened outside apply_transition, as the
    # review_state CHECK-constraint backfill in database.py demonstrates is
    # possible for this exact column) would otherwise resolve
    # nondeterministically. order_by(id.desc()) + first-wins mirrors
    # list_native_parent_analyses' latest-per-service dedup (service.py
    # ~963) for the identical reason: "rather than depending on an
    # invariant this function doesn't own." Unlike the down-cascade's
    # active-parent query (retest_of_id IS NULL, not
    # retracted/rejected, provenance='canonical'), this doesn't filter on
    # parent state — a stale promotion's parent naturally reads as
    # published/retracted/etc. below and the un-promote step no-ops.
    promo = db.execute(
        select(LimsAnalysisPromotion)
        .where(LimsAnalysisPromotion.source_analysis_id == row.id)
        .order_by(LimsAnalysisPromotion.id.desc())
    ).scalars().first()
    if promo is not None:
        parent = db.get(LimsAnalysis, promo.parent_analysis_id)
        if parent is not None:
            parent_state_before = parent.review_state
            if parent.review_state in ("verified", "parent_to_verify"):
                prior_state = parent.review_state
                parent_before = _snapshot(parent)
                parent.review_state = "retracted"
                # Clear the promoted figure too — mirrors
                # cascade_parent_retest_to_sources step 5 exactly: the
                # display serialization filters by retest_of_id, not
                # state, so a retracted parent still renders otherwise.
                parent.result_value = None
                parent.result_unit = None
                parent.updated_at = datetime.utcnow()
                db.add(LimsAnalysisTransition(
                    analysis_id=parent.id,
                    from_state=prior_state,
                    to_state="retracted",
                    transition_kind="auto",
                    user_id=user_id,
                    reason="un-promoted: source retested from vial",
                    details=_deltas(parent_before, parent),
                ))
                parent_unverified = True

    # Activity event (Task 7): written unconditionally — rides the
    # un-promote commit above when there is one, otherwise gets this commit
    # to itself. svc.origin is always 'mk1' here (guard 4 above fails
    # closed on anything else before this point is reachable).
    db.add(LimsSubSampleEvent(
        sub_sample_pk=row.lims_sub_sample_pk,
        event="promoted_source_retested",
        details={
            "keyword": row.keyword,
            "new_row_id": new_row.id,
            "parent_state_before": parent_state_before,
            "parent_unverified": parent_unverified,
            "service_origin": svc.origin,
        },
        user_id=user_id,
    ))
    db.commit()
    if parent is not None:
        db.refresh(parent)
        parent_review_state = parent.review_state

    return new_row.id, parent_unverified, parent_review_state


# ─── Parent-reject cascade ───────────────────────────────────────────────────


# Matches the seeder's generic per-analyte keyword on blend parents
# (lims_analyses/seeder.py:_PARENT_ANALYTE — kept in sync by hand).
_PARENT_ANALYTE_KW = re.compile(r"^ANALYTE-([1-4])-(PUR|QTY)$")


def _candidate_vial_keywords(
    db: Session, *, parent_sample_id: str, keyword: str
) -> set[str]:
    """Vial-tier keywords that mirror a given PARENT analysis keyword.

    Non-analyte keywords mirror unchanged → {keyword}. Generic per-analyte
    keywords (ANALYTE-{n}-PUR/QTY) were translated by the seeder to the slot
    peptide's per-substance PUR_<X>/QTY_<X> service → resolve the same chain
    (slot map → ID_<X> title → peptide → PUR_/QTY_ sibling) and return BOTH
    the translated keyword and the generic one (the seeder falls back to the
    generic row when translation fails, so both shapes can exist on vials).

    Best-effort: a SENAITE slot-read failure degrades to {keyword} rather
    than raising — the caller never fails the SENAITE transition.
    """
    from models import AnalysisService

    m = _PARENT_ANALYTE_KW.match(keyword)
    if not m:
        return {keyword}

    out = {keyword}  # generic fallback rows
    slot_n, cat = int(m.group(1)), m.group(2)
    try:
        from sub_samples import senaite as senaite_mod
        slot_map = senaite_mod.fetch_parent_analyte_slots(parent_sample_id)
    except Exception:
        return out
    title = slot_map.get(slot_n)
    if not title:
        return out

    id_svc = db.execute(
        select(AnalysisService).where(
            AnalysisService.title == title,
            AnalysisService.keyword.startswith("ID_"),
        )
    ).scalars().first()
    if id_svc is None or id_svc.peptide_id is None:
        return out

    prefix = "PUR_" if cat == "PUR" else "QTY_"
    # Lowest keyword wins — matches the seeder's deterministic pick.
    per = db.execute(
        select(AnalysisService)
        .where(
            AnalysisService.peptide_id == id_svc.peptide_id,
            AnalysisService.keyword.startswith(prefix),
        )
        .order_by(AnalysisService.keyword)
    ).scalars().first()
    if per is not None and per.keyword:
        out.add(per.keyword)
    return out


def cascade_parent_reject_to_vials(
    db: Session,
    *,
    parent_sample_id: str,
    keyword: str,
    user_id: Optional[int],
) -> list[int]:
    """When a PARENT analysis is rejected (via SENAITE — service removed from
    the offering), cascade the reject to the UNPOPULATED vial-tier mirror rows
    of that service across the family.

    Targets: lims_analyses rows on the parent's sub-samples whose keyword is
    in the candidate set (analyte-bridge translated for blend parents) AND
    review_state in (unassigned, assigned) AND result_value IS NULL.

    Rows carrying results (assigned-with-result, to_be_verified, promoted,
    variance_verified, …) are NEVER touched — discarding submitted bench work
    is a human decision, not a cascade.

    Returns the list of rejected row ids (empty when nothing matched).
    Never raises — caller wraps in try/except; each reject commits
    independently so one bad row doesn't kill the rest.
    """
    from models import LimsSample, LimsSubSample

    parent_sample = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent_sample is None:
        return []

    candidate_kws = _candidate_vial_keywords(
        db, parent_sample_id=parent_sample_id, keyword=keyword
    )

    # SENAITE phase-out audit (Task 7): evaluated, no provenance filter needed.
    # This is a vial-tier query (INNER JOIN on LimsSubSample.id ==
    # LimsAnalysis.lims_sub_sample_pk) — shadow rows are always parent-tier
    # only (lims_sub_sample_pk IS NULL, per parent_mirror.py), so they can
    # never satisfy this join regardless of review_state. Safe by construction.
    targets = db.execute(
        select(LimsAnalysis)
        .join(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            LimsSubSample.parent_sample_pk == parent_sample.id,
            LimsAnalysis.keyword.in_(candidate_kws),
            LimsAnalysis.review_state.in_(("unassigned", "assigned")),
            LimsAnalysis.result_value.is_(None),
        )
    ).scalars().all()

    rejected_ids: list[int] = []
    for row in targets:
        try:
            apply_transition(
                db,
                analysis_id=row.id,
                kind="reject",
                reason="cascaded from parent SENAITE reject",
                user_id=user_id,
            )
            rejected_ids.append(row.id)
        except Exception:
            # Log at call site; don't let one bad row kill the rest.
            pass

    return rejected_ids


# ─── Parent-remove cascade ───────────────────────────────────────────────────


def cascade_parent_remove_from_vials(
    db: Session,
    *,
    parent_sample_id: str,
    keyword: str,
    user_id: Optional[int],
) -> Dict[str, List[str]]:
    """When an analysis is REMOVED from a parent AR (Manage Analyses → IS
    proxy → SENAITE delete), hard-delete the PRISTINE vial-tier mirror rows
    of that service across the family.

    Remove is a mistake-correction — the rows vanish (each with an
    analysis_removed event via delete_pristine_analysis, which also defines
    "pristine": unassigned, no result, not retested, no promotion link).
    Rows with ANY activity are skipped; reject is the audited path for
    taking a worked service off the offering.

    Keyword matching reuses the reject cascade's candidate set (analyte-
    bridge translated for blend parents, generic kept as fallback).

    Returns {vial_sample_id: [removed keywords]}. Never raises — caller
    wraps in try/except; each delete commits independently.
    """
    from models import LimsSample, LimsSubSample

    parent_sample = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent_sample is None:
        return {}

    candidate_kws = _candidate_vial_keywords(
        db, parent_sample_id=parent_sample_id, keyword=keyword
    )

    # SENAITE phase-out audit (Task 7): evaluated, no provenance filter needed
    # — same reasoning as cascade_parent_reject_to_vials above (vial-tier join,
    # shadow rows are parent-tier only). Safe by construction.
    targets = db.execute(
        select(LimsAnalysis.lims_sub_sample_pk, LimsAnalysis.keyword,
               LimsSubSample.sample_id)
        .join(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            LimsSubSample.parent_sample_pk == parent_sample.id,
            LimsAnalysis.keyword.in_(candidate_kws),
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).all()

    out: Dict[str, List[str]] = {}
    for sub_pk, kw, vial_sample_id in targets:
        try:
            delete_pristine_analysis(
                db,
                sub_sample_pk=sub_pk,
                keyword=kw,
                user_id=user_id,
            )
        except Exception:
            # Non-pristine (activity) or already gone — skip; log at call
            # site. One bad row must not kill the rest.
            db.rollback()
            continue
        out.setdefault(vial_sample_id, []).append(kw)

    return out


# ─── Parent-add cascade ──────────────────────────────────────────────────────


def cascade_parent_add_to_vials(
    db: Session,
    *,
    parent_sample_id: str,
    user_id: Optional[int],
) -> Dict[str, List[str]]:
    """When an analysis service is ADDED to a parent AR (Manage Analyses →
    IS proxy → SENAITE), re-run the idempotent seeder for every non-xtra vial
    of the family so the new service lands on the bench without an Extra
    round-trip.

    The seeder skips keywords a vial already carries, so only the addition
    lands (as an unassigned row). HPLC vials mirror the parent's CURRENT
    active analysis set (rejected/retracted parent rows and Microbiology
    keywords stay excluded by the existing mirror predicates); endo/ster
    vials re-seed their fixed whitelist — a no-op when already seeded.

    Returns {vial_sample_id: [newly seeded keywords]} for vials that gained
    rows. Never raises — the WP profile fetch and each vial's seed run are
    individually guarded so one failure doesn't kill the rest (or the add).
    """
    from models import LimsSample, LimsSubSample

    parent_sample = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent_sample is None:
        return {}

    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent_sample.id,
            LimsSubSample.assignment_role.is_not(None),
            LimsSubSample.assignment_role != "xtra",
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    if not subs:
        return {}

    # One WP fetch for the whole family (same threading pattern as
    # compute_vial_plan). None/{} → role_implies_seeding gates everything off.
    try:
        from sub_samples import service as ss_service
        wp_services = ss_service._fetch_wp_services_for_parent(parent_sample_id) or {}
    except Exception:
        wp_services = {}

    from lims_analyses.seeder import seed_analyses_for_vial

    out: Dict[str, List[str]] = {}
    for sub in subs:
        try:
            new_rows = seed_analyses_for_vial(
                db,
                sub_sample=sub,
                role=sub.assignment_role,
                wp_services=wp_services,
                parent_sample_id=parent_sample_id,
                created_by_user_id=user_id,
                commit=True,
            )
        except Exception:
            # Log at call site; the seeder's fail-hard SENAITE read must not
            # kill the other vials or the parent add itself.
            db.rollback()
            continue
        if new_rows:
            out[sub.sample_id] = [r.keyword for r in new_rows]

    return out


# ─── Removal-impact classification (retract-on-remove) ──────────────────────


def classify_removal_impact(
    db: Session, *, parent_sample_id: str, keyword: str,
) -> Dict[str, List[dict]]:
    """Classify the vial-tier rows a parent-service removal would touch into
    pristine / worked_unverified / blocked. Drives the confirmation modal and
    the delete-vs-reject decision. Pure read; never mutates.

    Tiers (see the wrong-variant Replace design):
      - pristine:          unassigned, no result, not retested, no promotion
      - worked_unverified: active row with activity, not verified/published,
                           not promoted -> audited reject on confirm
      - blocked:           verified / published / promoted -> invalidate first

    Keyword matching reuses the reject/remove cascade candidate set (analyte-
    bridge translated for blend parents, generic kept as fallback).
    """
    from models import LimsSample, LimsSubSample, LimsAnalysisPromotion

    out: Dict[str, List[dict]] = {"pristine": [], "worked_unverified": [], "blocked": []}
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return out

    candidate_kws = _candidate_vial_keywords(
        db, parent_sample_id=parent_sample_id, keyword=keyword
    )

    rows = db.execute(
        select(LimsAnalysis, LimsSubSample.sample_id)
        .join(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsAnalysis.keyword.in_(candidate_kws),
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).all()

    for row, vial_sample_id in rows:
        entry = {
            "analysis_id": row.id,
            "sample_id": vial_sample_id,
            "keyword": row.keyword,
            "review_state": row.review_state,
        }
        out[_analysis_removal_tier(db, row)].append(entry)
    return out


def _analysis_removal_tier(db: Session, row: "LimsAnalysis") -> str:
    """Classify a single analysis row for removal: 'pristine' (safe to delete),
    'worked_unverified' (retract-on-confirm), or 'blocked' (verified/published/
    promoted — invalidate/retest first). Shared by classify_removal_impact and
    the slot-replace re-mirror so both honor the same tiers."""
    from models import LimsAnalysisPromotion

    promoted = db.execute(
        select(LimsAnalysisPromotion.id).where(
            LimsAnalysisPromotion.source_analysis_id == row.id
        )
    ).scalar_one_or_none() is not None
    if row.review_state in ("verified", "published") or promoted:
        return "blocked"
    if row.review_state == "unassigned" and row.result_value is None and not row.retested:
        return "pristine"
    return "worked_unverified"


def reject_vials_for_parent_keyword(
    db: Session, *, parent_sample_id: str, keyword: str, user_id: Optional[int],
) -> List[int]:
    """Reject (audited clear, restorable on re-add) the worked_unverified vial
    rows of a parent service. Pristine rows are left for the delete path;
    verified/published/promoted rows are blocked and never touched. Returns the
    rejected analysis ids. Never raises on a single bad row — one failure must
    not kill the rest (mirrors cascade_parent_reject_to_vials)."""
    impact = classify_removal_impact(
        db, parent_sample_id=parent_sample_id, keyword=keyword
    )
    out: List[int] = []
    for entry in impact["worked_unverified"]:
        try:
            apply_transition(
                db,
                analysis_id=entry["analysis_id"],
                kind="reject",
                reason="rejected via Manage Analyses remove (worked result)",
                user_id=user_id,
            )
            out.append(entry["analysis_id"])
        except Exception:
            db.rollback()
            continue
    return out


# ─── Replace analyte (wrong-variant correction) ─────────────────────────────


def peptide_has_full_service_set(db: Session, *, peptide_id: int) -> bool:
    """True iff the peptide has the complete per-substance HPLC service set:
    an ID_, a PUR_, and a QTY_ AnalysisService (all keyed by peptide_id).

    Gates the offer-only Replace picker — a peptide without a full set can't be
    swapped in (purity/quantity/identity would silently fall back to generics)."""
    from models import AnalysisService

    kws = db.execute(
        select(AnalysisService.keyword).where(AnalysisService.peptide_id == peptide_id)
    ).scalars().all()
    prefixes = {k.split("_", 1)[0] for k in kws if k and "_" in k}
    return {"ID", "PUR", "QTY"}.issubset(prefixes)


def force_retract_analysis(
    db: Session, *, analysis_id: int, user_id: Optional[int],
    reason: Optional[str] = None,
) -> None:
    """Strong-confirm retract of a worked/promoted/verified vial row, for the
    wrong-variant Replace: the whole analyte is invalid, so its results are
    discarded with an audit trail.

      - published      -> refuse (BadRequestError): a published COA result must
                          be invalidated via SENAITE, not auto-retracted here.
      - promoted       -> un-promote: retract each parent canonical row it fed
                          (verified or parent_to_verify -> retracted), drop the
                          promotion link(s), then reject the source
                          (promoted -> rejected).
      - verified (vial)-> retract (verified -> retracted).
      - else (worked)  -> reject.

    `reason` is keyword-only and defaults to None, in which case every
    internal apply_transition call keeps its current, call-site-specific
    string (byte-identical default behavior for the wrong-variant Replace
    callers). When given, that string is used for every transition this call
    applies (canonical retract(s), and the source's own retract/reject) —
    used by manage_native's remove path to stamp "manage_analyses:remove"
    instead of the wrong-variant Replace wording. Goes through
    apply_transition throughout, so it never constructs a
    LimsAnalysisTransition directly.

    Idempotent on the canonical row (skipped if already terminal). Raises only
    on published; transition errors propagate to the caller's per-row guard.
    """
    from models import LimsAnalysisPromotion

    row = get_analysis(db, analysis_id)
    if row.review_state == "published":
        raise BadRequestError(
            "result is on a published COA — invalidate/retest in SENAITE first"
        )

    if row.review_state == "promoted":
        links = list(db.execute(
            select(LimsAnalysisPromotion).where(
                LimsAnalysisPromotion.source_analysis_id == analysis_id
            )
        ).scalars().all())
        for link in links:
            canonical = db.get(LimsAnalysis, link.parent_analysis_id)
            if canonical is not None and not is_terminal(canonical.review_state):
                if canonical.review_state in ("verified", "parent_to_verify"):
                    apply_transition(
                        db, analysis_id=canonical.id, kind="retract",
                        reason=reason or "wrong-variant Replace: canonical result invalidated",
                        user_id=user_id,
                    )
            db.delete(link)
        db.flush()
        apply_transition(
            db, analysis_id=analysis_id, kind="reject",
            reason=reason or "wrong-variant Replace: promoted source abandoned",
            user_id=user_id,
        )
        return

    kind = "retract" if row.review_state == "verified" else "reject"
    apply_transition(
        db, analysis_id=analysis_id, kind=kind,
        reason=reason or "wrong-variant Replace: result discarded", user_id=user_id,
    )


def classify_slot_replacement_impact(
    db: Session, *, parent_sample_id: str, old_peptide_id: int,
) -> Dict[str, List[dict]]:
    """Classify the family's vial rows that a slot replacement would touch —
    the OLD peptide's per-substance rows (PUR_/QTY_/ID_) across non-xtra vials
    — into pristine / worked_unverified / blocked. Pure read; drives the
    endpoint's pre-write 409/412 gate and the replace_analyte_slot action loop.
    Entries carry analysis_id + sub_sample_pk + sample_id + keyword."""
    from models import AnalysisService, LimsSample, LimsSubSample

    out: Dict[str, List[dict]] = {"pristine": [], "worked_unverified": [], "blocked": []}
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return out

    rows = db.execute(
        select(LimsAnalysis, LimsSubSample.sample_id)
        .join(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
        .where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_role.is_not(None),
            LimsSubSample.assignment_role != "xtra",
            AnalysisService.peptide_id == old_peptide_id,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).all()

    for row, vial_sample_id in rows:
        out[_analysis_removal_tier(db, row)].append({
            "analysis_id": row.id,
            "sub_sample_pk": row.lims_sub_sample_pk,
            "sample_id": vial_sample_id,
            "keyword": row.keyword,
            "review_state": row.review_state,
        })
    return out


def presubsample_slot_blocked_keywords(
    states: Dict[str, str], *, slot: int, identity_keyword: Optional[str],
) -> List[str]:
    """Pre-subsample (pre-vial) Replace guard.

    The vial-based ``classify_slot_replacement_impact`` is blind to pre-subsample
    samples — their results live only on the SENAITE AR, not in Mk1 vial rows. So
    given SENAITE ``keyword -> review_state`` for the sample, return the slot's
    analysis keywords (its identity service + ``ANALYTE-{slot}-PUR/QTY``) that
    carry a worked result (``verified`` or ``published``) and would be invalidated
    by replacing the analyte. Empty list => safe to replace; non-empty => the
    caller should block (invalidate/retest in SENAITE first)."""
    candidates = [f"ANALYTE-{slot}-PUR", f"ANALYTE-{slot}-QTY"]
    if identity_keyword:
        candidates.insert(0, identity_keyword)
    return [kw for kw in candidates if states.get(kw) in ("verified", "published")]


def replace_analyte_slot(
    db: Session,
    *,
    parent_sample_id: str,
    slot: int,
    old_peptide_id: int,
    new_peptide_id: int,
    confirm_retract: bool,
    user_id: Optional[int],
    force: bool = False,
) -> Dict[str, object]:
    """Re-mirror one analyte slot from old_peptide -> new_peptide across the
    family's non-xtra vials (the Mk1 side of a Replace).

    Caller (the endpoint) is responsible for resolving old_peptide_id from the
    slot BEFORE overwriting Analyte{slot}Peptide on the SENAITE AR, and for
    reconciling the parent Identity service. This function only touches the
    Mk1 vial rows:
      - find each vial's per-substance rows for old_peptide_id
      - pristine -> hard delete; worked_unverified -> reject (only when
        confirm_retract); blocked (verified/published/promoted) -> left as-is
        and reported
      - re-seed every non-xtra vial so the seeder translates the (now updated)
        slot title into the new peptide's PUR_/QTY_/ID_ rows.

    Never raises per-row — one bad vial must not strand the rest. Raises
    BadRequestError only on the offer-only gate (new peptide lacks services)
    or NotFoundError when the parent is unknown.
    """
    from models import LimsSample, LimsSubSample
    from lims_analyses import seeder as _seeder

    if not peptide_has_full_service_set(db, peptide_id=new_peptide_id):
        raise BadRequestError(
            f"peptide id={new_peptide_id} has no full ID_/PUR_/QTY_ service set"
        )

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        # Pre-subsample (pre-vial) sample: it has no Mk1 LimsSample/vial rows to
        # mirror. The caller has already applied the SENAITE-side slot + identity
        # changes, which are the ENTIRE operation for these older samples — so
        # the vial re-mirror is a no-op, not an error. Returning here (instead of
        # raising NotFoundError) is what lets Replace work on pre-subsample
        # samples; the `pre_subsample` flag surfaces that to the caller/FE.
        return {
            "slot": slot,
            "old_peptide_id": old_peptide_id,
            "new_peptide_id": new_peptide_id,
            "vials": {"deleted": [], "retracted": [], "blocked": [], "reseeded": []},
            "pre_subsample": True,
        }

    summary: Dict[str, object] = {
        "slot": slot,
        "old_peptide_id": old_peptide_id,
        "new_peptide_id": new_peptide_id,
        "vials": {"deleted": [], "retracted": [], "blocked": [], "reseeded": []},
    }
    vials = summary["vials"]  # type: ignore[assignment]

    impact = classify_slot_replacement_impact(
        db, parent_sample_id=parent_sample_id, old_peptide_id=old_peptide_id
    )

    def _brief(e):
        return {"sample_id": e["sample_id"], "keyword": e["keyword"]}

    for e in impact["blocked"]:
        if force:
            # Strong-confirm: un-promote/retract verified+promoted rows. Published
            # rows raise inside force_retract_analysis -> stay blocked + reported.
            try:
                force_retract_analysis(db, analysis_id=e["analysis_id"], user_id=user_id)
                vials["retracted"].append(_brief(e))
            except Exception:
                db.rollback()
                vials["blocked"].append(_brief(e))
        else:
            vials["blocked"].append(_brief(e))
    for e in impact["pristine"]:
        try:
            delete_pristine_analysis(
                db, sub_sample_pk=e["sub_sample_pk"], keyword=e["keyword"], user_id=user_id,
            )
            vials["deleted"].append(_brief(e))
        except Exception:
            db.rollback()
            continue
    for e in impact["worked_unverified"]:
        if not (confirm_retract or force):
            # Endpoint gates this (412) before any write; defensive here.
            vials["blocked"].append(_brief(e))
            continue
        try:
            apply_transition(
                db, analysis_id=e["analysis_id"], kind="reject",
                reason=f"replaced analyte slot {slot} ({old_peptide_id}->{new_peptide_id})",
                user_id=user_id,
            )
            vials["retracted"].append(_brief(e))
        except Exception:
            db.rollback()
            continue

    # Re-seed each non-xtra vial: the seeder reads the (caller-updated) slot
    # title and translates it into the new peptide's per-substance rows. Skips
    # keywords a vial already carries, so this only adds the new rows.
    try:
        from sub_samples import service as ss_service
        wp_services = ss_service._fetch_wp_services_for_parent(parent_sample_id) or {}
    except Exception:
        wp_services = {}

    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_role.is_not(None),
            LimsSubSample.assignment_role != "xtra",
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    for sub in subs:
        try:
            _seeder.seed_analyses_for_vial(
                db, sub_sample=sub, role=sub.assignment_role,
                wp_services=wp_services, parent_sample_id=parent_sample_id,
            )
            vials["reseeded"].append(sub.sample_id)
        except Exception:
            db.rollback()
            continue

    return summary


# ─── Native vial add/remove (Phase 6 — native Manage Analyses) ──────────────


def add_analysis_to_native_vial(
    db: Session,
    *,
    sub_sample_pk: int,
    senaite_service_uid: Optional[str],
    keyword: Optional[str],
    user_id: Optional[int],
    analysis_service_id: Optional[int] = None,
) -> "LimsAnalysis":
    """Add an analysis to a native (mk1://) sub-sample.

    Resolution order:
      1. If analysis_service_id is given → match analysis_services.id.
      2. Else if senaite_service_uid is given → match analysis_services.senaite_uid.
      3. Else if keyword is given → match analysis_services.keyword.
      4. Else → BadRequestError (no identifier).

    The service id is checked first because it is the only identifier that
    cannot drift; the other two stay as compatibility aliases for the callers
    (and the FE wire) that still send them.

    Raises:
      - BadRequestError when no identifier is supplied.
      - NotFoundError when the AnalysisService cannot be resolved.
      - BadRequestError (409-style) when the vial already carries an active
        non-retest row for that service (idempotent guard).
    """
    from models import AnalysisService

    if analysis_service_id is not None:
        svc = db.get(AnalysisService, analysis_service_id)
        if svc is None:
            raise NotFoundError(
                f"AnalysisService with id={analysis_service_id!r} not found"
            )
    elif senaite_service_uid is not None:
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
            "add_analysis_to_native_vial requires analysis_service_id, "
            "senaite_service_uid or keyword"
        )

    # Duplicate guard (S3): native services guard by the service FK — the
    # pre-S3 keyword guard resolved a service then compared strings, the exact
    # drift class this slice retires (a vial already carrying the service under
    # a drifted stored keyword read as "not present" and a second row was
    # minted). senaite services keep the keyword as their identity contract.
    # scalar_one_or_none stays: uq_lims_analyses_sub_service_id_root enforces
    # singularity for the FK leg, and the keyword leg is unchanged.
    _ident = (
        LimsAnalysis.analysis_service_id == svc.id
        if svc.origin == "mk1"
        else LimsAnalysis.keyword == svc.keyword
    )
    existing = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample_pk,
            _ident,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise BadRequestError(
            f"vial already has an active analysis for service "
            f"{svc.keyword!r} (id={existing.id}, keyword={existing.keyword!r}); "
            f"remove or retract it first"
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
    keyword: Optional[str] = None,
    user_id: Optional[int],
    analysis_service_id: Optional[int] = None,
) -> None:
    """Hard-delete a pristine (mistake-correction) analysis from a native vial.

    "Pristine" means: review_state == 'unassigned' AND result_value IS NULL
    AND not retested AND no promotion link. Any other state raises BadRequestError.

    The row is identified by EXACTLY ONE of analysis_service_id (S3: reaches a
    row whose stored keyword has drifted from its catalog's) or keyword (the
    pre-S3 wire, kept as a compatibility alias). Both together is a
    BadRequestError rather than a precedence rule: the two can name different
    rows, and silently preferring one would delete a row the caller didn't ask
    for — on a surface whose whole job is a hard delete.

    Raises:
      - BadRequestError when the identifiers are not exactly one.
      - NotFoundError when no active row with that identity exists on the vial.
      - BadRequestError when the row has activity (result, non-unassigned state,
        retested flag, or promotion link) — instruct caller to retract instead.
    """
    from models import LimsAnalysisPromotion

    if (analysis_service_id is None) == (keyword is None):
        raise BadRequestError(
            "delete_pristine_analysis requires exactly one of "
            "analysis_service_id or keyword"
        )

    if analysis_service_id is not None:
        _ident = LimsAnalysis.analysis_service_id == analysis_service_id
        _named = f"analysis_service_id={analysis_service_id!r}"
    else:
        _ident = LimsAnalysis.keyword == keyword
        _named = f"keyword={keyword!r}"

    row = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample_pk,
            _ident,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError(
            f"no active lims_analysis with {_named} on sub_sample_pk={sub_sample_pk}"
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
    # but the event preserves the fact that it existed and was removed. The
    # keyword recorded is the ROW's, not the caller's input — on the service-id
    # path there is no caller keyword, and a drifted one would name nothing.
    db.add(LimsSubSampleEvent(
        sub_sample_pk=sub_sample_pk,
        event="analysis_removed",
        details={"keyword": row.keyword},
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


def _serialize_senaite_shape_rows(
    db: Session,
    rows: List[LimsAnalysis],
    *,
    promo_by_source: Optional[Dict[int, int]] = None,
) -> List["SenaiteShapeAnalysisResponse"]:
    """Shared per-row projection to the FE's SenaiteAnalysis shape.

    Used by both the vial-tier listing (list_analyses_in_senaite_shape) and
    the parent-tier listing (list_parent_analyses_senaite_shape) so the two
    surfaces can never drift in field-mapping behavior — this is the whole
    body of what used to be list_analyses_in_senaite_shape's bulk-load +
    per-row loop, generalized to take an already-resolved row list instead
    of fetching them itself.

    UID carries the 'mk1:' prefix so the FE can dispatch transitions to the
    Mk1 endpoints.

    review_state resolution: shadow rows (provenance='shadow') report
    mirror_review_state (the true SENAITE state — their own review_state
    column carries the sentinel SHADOW_STATE 'senaite_mirror'); canonical
    rows report their own review_state. Vial-tier rows are always
    provenance='canonical' (shadows are parent-tier only — see
    parent_mirror.py), so this is a no-op widening for the existing
    vial-tier caller: r.provenance == "shadow" is never true for a
    sub-sample-hosted row, so it always falls through to r.review_state,
    unchanged from before this helper existed.

    promo_by_source: optional {source_analysis_id: parent_analysis_id} —
    only meaningful for vial-tier rows (only vial-tier rows can be sources
    of a promotion; see SenaiteShapeAnalysisResponse.promoted_to_parent_id's
    docstring). Parent-tier callers omit it; every row's
    promoted_to_parent_id then resolves to None via the empty-dict default,
    matching the schema's documented contract for parent-tier rows.
    """
    from models import AnalysisService, HplcMethod, Instrument, User
    from lims_analyses.schemas import (
        SenaiteShapeAnalysisResponse,
        SenaiteShapeInstrumentOption,
        SenaiteShapeMethodOption,
        SenaiteShapeResultOption,
    )
    from users_display import user_display_name

    if not rows:
        return []

    promo_by_source = promo_by_source or {}

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
    # src/lib/user-display.ts; helper in backend/users_display.py. Batched
    # (single IN-query) — never per-row, mirroring the lightbox created_by
    # batched-names idiom.
    analyst_ids = (
        {r.analyst_user_id for r in rows if r.analyst_user_id}
        | {r.processed_by_user_id for r in rows if r.processed_by_user_id}
    )
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

        row_review_state = (
            r.mirror_review_state if r.provenance == "shadow" else r.review_state
        )

        # A row's uid is its WRITE AUTHORITY, not just its name. The FE
        # branches on the `mk1:` prefix to choose between the Mk1 endpoints
        # and the SENAITE wizard endpoints, so a SHADOW row — which mirrors
        # a line SENAITE owns — must serialize under that line's own uid, or
        # mk1-mode reads address a SENAITE-owned line as native and every
        # write dies on the Mk1 tier/state guards (the BW result-entry and
        # legacy-retest outage, 2026-08-29). Canonical rows are Mk1's to
        # write and always keep mk1:{id}; a shadow row with no recorded uid
        # falls back to mk1:{id} and stays display-only, which is strictly
        # better than routing a write at a line we cannot name.
        _uid = f"mk1:{r.id}"
        if r.provenance == "shadow" and (r.senaite_analysis_uid or "").strip():
            _uid = r.senaite_analysis_uid.strip()

        out.append(SenaiteShapeAnalysisResponse(
            uid=_uid,
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
            processed_by=analyst_name_by_id.get(r.processed_by_user_id),
            review_state=row_review_state,
            sort_key=None,
            captured=r.captured_at.isoformat() if r.captured_at else None,
            retested=r.retested,
            service_group_id=None,
            service_group_name=None,
            promoted_to_parent_id=promo_by_source.get(r.id),
            service_origin=svc.origin if svc else None,
            # S3: the row's own FK, not svc.id — svc is None when the FK
            # doesn't resolve, and the identity key must ship regardless.
            analysis_service_id=r.analysis_service_id,
            provenance=r.provenance,
            # COA read-independence (Task 5): straight off the row, no
            # extra lookup. See SenaiteShapeAnalysisResponse docstring.
            retest_of_id=r.retest_of_id,
            reportable=r.reportable,
        ))
    return out


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

    Per-row projection is delegated to the shared _serialize_senaite_shape_rows
    helper (also used by list_parent_analyses_senaite_shape) so the two
    surfaces can't drift in field-mapping behavior.
    """
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

    return _serialize_senaite_shape_rows(db, rows, promo_by_source=promo_by_source)
