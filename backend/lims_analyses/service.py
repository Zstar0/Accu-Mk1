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
    ))
    if commit:
        db.commit()
        db.refresh(row)
    else:
        db.flush()  # row already has an id from the earlier flush; keep it pending in the outer txn
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
        # "verified": grandfathered vial rows from before vial-verify was removed
        # (kept for backward-compat); "promoted": cascade-driven (parent retest);
        # "variance_verified": variance replicates re-run safely — they never
        # touched the parent, so there is no SENAITE lock to collide with.
        if from_state not in ("to_be_verified", "verified", "promoted", "variance_verified"):
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


# ─── Variance entitlement gate (Variance Addon Phase 1) ─────────────────────

# Vial assignment_role → the WP service key whose variance entitlement covers
# rows on that vial. Coarse service keys only — never per-analyte (spec
# 2026-06-10-variance-testing-addon-design.md, "The scoping rule").
_ROLE_VARIANCE_KEYS: Dict[str, str] = {
    "hplc": "hplcpurity_identity",
    "endo": "endotoxin",
    "ster": "sterility_pcr",
}


def ensure_variance_entitlement(
    db: Session,
    *,
    analysis_id: int,
    fetch_services=None,
) -> None:
    """Display-only helper — no longer a transition gate (2026-06-10 variance-bucket-assignment).

    Raise BadRequestError unless the parent's WP order purchased variance
    for the service that covers this row's host vial role. FAIL CLOSED: an
    unreachable services payload rejects the transition (retry later) — it
    never silently allows.

    fetch_services is injectable for tests; defaults to the same WP/IS lookup
    the vial plan uses. NO production callers remain — the AssignStep
    paid-count display uses sub_samples.service.normalize_variance_entitlement,
    and the transition route is governed by the assignment_kind gate. Retained
    only as reference for a possible future commercial re-gate.
    """
    from models import LimsSample, LimsSubSample

    row = get_analysis(db, analysis_id)
    if row.lims_sub_sample_pk is None:
        raise BadRequestError("variance_verify is only valid on sub-sample analyses")
    vial = db.get(LimsSubSample, row.lims_sub_sample_pk)
    if vial is None:
        raise NotFoundError(f"sub-sample id={row.lims_sub_sample_pk} not found")
    parent = db.get(LimsSample, vial.parent_sample_pk)
    if parent is None:
        raise NotFoundError(f"parent sample pk={vial.parent_sample_pk} not found")

    # CAVEAT (2026-06-17): NOT BW-aware. _ROLE_VARIANCE_KEYS maps hplc ->
    # "hplcpurity_identity" only, but a Bacteriostatic Water order carries its
    # variance count under "bac_water_panel". This fn has no production callers
    # today; if it's ever re-activated as a gate, mirror the BW-aware OR logic in
    # sub_samples.service.derive_variance_demand (max of both keys) or BW variance
    # will be wrongly blocked.
    key = _ROLE_VARIANCE_KEYS.get(vial.assignment_role or "")
    if key is None:
        raise BadRequestError(
            f"vial {vial.sample_id} role {vial.assignment_role!r} has "
            f"no variance service mapping"
        )

    if fetch_services is None:
        from sub_samples.service import _fetch_wp_services_for_parent
        fetch_services = _fetch_wp_services_for_parent
    services = fetch_services(parent.sample_id)
    if services is None:
        raise BadRequestError(
            "variance entitlement could not be verified (order services "
            "unreachable) — try again"
        )
    variance = services.get("variance") or {}
    n = variance.get(key)
    if not isinstance(n, int) or n < 2:
        raise BadRequestError(
            f"variance was not purchased for {key} on {parent.sample_id}"
        )


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

    Parent-target overrides (per-substance promotion): parent_keyword,
    parent_analysis_service_id, and parent_title decouple the parent-tier
    row's identity from the source vial keyword. Used when blend-vial
    per-substance results (e.g. vial PUR_<X> sources) must be stored under a
    generic parent-AR slot (e.g. ANALYTE-{slot}, ANALYTE-2-PUR). Sources are
    still validated against the source `keyword`; only the parent-tier row
    (and the retest-supersession lookup) use the effective parent target.
    Each defaults to None → unchanged behavior (parent row inherits the
    source keyword/service/title).

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
                LimsAnalysis.keyword == eff_parent_keyword,
                LimsAnalysis.retest_of_id.is_(None),
                # Only VERIFIED parents are superseded. A published parent is
                # a citable COA source — superseding it silently could invalidate
                # an issued COA; that conflict surfaces as the 409 instead.
                LimsAnalysis.review_state == "verified",
                LimsAnalysis.lims_sub_sample_pk.is_(None),
                # SENAITE phase-out defense-in-depth: review_state=='verified'
                # already excludes the shadow sentinel ('senaite_mirror'), so
                # this can't change behavior — the canonical partial unique
                # index this lookup protects already scopes to
                # provenance='canonical' (Task 1), so this is a correctness
                # clarification, not a behavior change.
                LimsAnalysis.provenance == "canonical",
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
        analysis_service_id=eff_service_id,
        keyword=eff_parent_keyword,
        title=eff_title,
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
        # "auto": a promote is a system-driven side-effect, not a user-initiated
        # transition kind (the reason string records the promote).
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
    Note: this selection is host-shape only (lims_sample_pk set, no
    sub-sample) -- it does not additionally require review_state to be one
    of the "true" parent-tier states, so a parent-acting-as-a-vial row
    (variance set, mid-run: unassigned/assigned/to_be_verified per
    state_machine.tier_of) also matches if present. Matches the brief's
    literal selection contract; no live seeding path produces such a row
    with lims_sub_sample_pk NULL today, but a caller expanding this in the
    future should be aware.

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
            ),
        ).order_by(LimsAnalysis.keyword, LimsAnalysis.id)
    ).scalars().all())

    return _serialize_senaite_shape_rows(db, rows)


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

    # 2. Find the active parent-tier analysis for this keyword
    #    (lims_sub_sample_pk IS NULL, retest_of_id IS NULL, state not terminal-bad)
    #
    # SENAITE phase-out fail-closed (REQUIRED, not defense-in-depth): unlike
    # the other readers in this module, `review_state.not_in(("retracted",
    # "rejected"))` does NOT exclude the shadow sentinel state
    # ('senaite_mirror') — a shadow row for this (parent, keyword) would match
    # this filter. Without provenance=='canonical', `.scalars().first()` (no
    # ORDER BY) could nondeterministically return the shadow row instead of
    # the real canonical parent row when both exist for the same keyword. That
    # shadow row never has a LimsAnalysisPromotion link, so step 3 below would
    # find `promo_rows == []` and this cascade would silently no-op instead of
    # retesting the vial sources the canonical row actually promoted — a real
    # (not cosmetic) correctness gap.
    parent_analysis = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_sample.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.keyword == keyword,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.not_in(("retracted", "rejected")),
            LimsAnalysis.provenance == "canonical",
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
        # "verified": grandfathered vial rows from before vial-verify was removed
        # (kept for backward-compat); "promoted": the post-promote normal path.
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

    # 5. Un-promote the parent. Its promoted value came from a source we just
    #    retested, so it now reflects superseded data — clear it immediately
    #    rather than leaving the stale figure until a re-promote. Retracting
    #    (not deleting) mirrors the re-promote supersession in promote_to_parent
    #    and vacates the partial unique index (which excludes 'retracted'), so
    #    the eventual re-promote inserts cleanly. NEVER retract a PUBLISHED
    #    parent — it's a citable COA source; that path is invalidate→retest.
    if new_row_ids and parent_analysis.review_state == "verified":
        prior_state = parent_analysis.review_state
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
        ))
        db.commit()

    return new_row_ids


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
) -> None:
    """Strong-confirm retract of a worked/promoted/verified vial row, for the
    wrong-variant Replace: the whole analyte is invalid, so its results are
    discarded with an audit trail.

      - published      -> refuse (BadRequestError): a published COA result must
                          be invalidated via SENAITE, not auto-retracted here.
      - promoted       -> un-promote: retract each parent canonical row it fed
                          (verified -> retracted), drop the promotion link(s),
                          then reject the source (promoted -> rejected).
      - verified (vial)-> retract (verified -> retracted).
      - else (worked)  -> reject.

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
                if canonical.review_state == "verified":
                    apply_transition(
                        db, analysis_id=canonical.id, kind="retract",
                        reason="wrong-variant Replace: canonical result invalidated",
                        user_id=user_id,
                    )
            db.delete(link)
        db.flush()
        apply_transition(
            db, analysis_id=analysis_id, kind="reject",
            reason="wrong-variant Replace: promoted source abandoned",
            user_id=user_id,
        )
        return

    kind = "retract" if row.review_state == "verified" else "reject"
    apply_transition(
        db, analysis_id=analysis_id, kind=kind,
        reason="wrong-variant Replace: result discarded", user_id=user_id,
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

        row_review_state = (
            r.mirror_review_state if r.provenance == "shadow" else r.review_state
        )

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
            review_state=row_review_state,
            sort_key=None,
            captured=r.captured_at.isoformat() if r.captured_at else None,
            retested=r.retested,
            service_group_id=None,
            service_group_name=None,
            promoted_to_parent_id=promo_by_source.get(r.id),
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
