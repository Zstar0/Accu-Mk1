"""Calculated blend aggregates for NATIVE HPLC blends.

A native blend has two aggregate lines whose value is a function of the
per-slot lines, never an independent measurement:

    HPLC-BLEND-TOTAL   = sum of slot quantities
    HPLC-BLEND-PURITY  = quantity-weighted mean of slot purities

They used to be computed only when results arrived through Process HPLC
(prep_bridge). Typed results left them empty, the tech typed them too, and
they drifted: on PB-1002 (2026-09-21) Mk1 said 12 mg / 99 while the COA, which
recomputes them itself, printed 10.0 mg / 98.80%.

So they are ALWAYS calculated, on both tiers, by the one formula here:

  vial    recalc_vial_blend_aggregates    after any slot result lands on a vial
  parent  recalc_parent_blend_aggregates  after a parent slot row is minted or
                                          un-promoted. The parent needs its own
                                          pass: once slots are promoted from
                                          DIFFERENT vials, no vial's aggregate
                                          is the parent's truth.

They stay ordinary rows: they promote and get verified with the rest, so a
reviewer still signs the number.

Ruling A (Handler, 2026-09-21): when a slot changes after the parent
aggregates were verified, they drop back to 'parent_to_verify' with the new
value. A verified number whose inputs moved must be signed again. Published
rows are never touched (citable history; the re-promote flow supersedes them).

System-driven writes use transition_kind='auto' with a reason, like every
other derived change in lims_analyses.service.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import LimsAnalysis, LimsAnalysisTransition, LimsSubSample
from lims_analyses.hplc_native import (
    KW_BLEND_PURITY, KW_BLEND_TOTAL, KW_PURITY, KW_QUANTITY,
)
from lims_analyses.state_machine import RESULT_PENDING_STATES

logger = logging.getLogger(__name__)

_DEAD = ("retracted", "rejected", "cancelled")
# Parent aggregate states this module may write. 'published' is excluded on
# purpose: a published figure is citable history.
_PARENT_TOUCHABLE = ("parent_to_verify", "verified")


def _parse(s: Optional[str]) -> Optional[float]:
    try:
        return float(s) if s not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _fmt(v: Optional[float]) -> Optional[str]:
    # Same formatting the prep bridge has always used for these rows.
    return None if v is None else f"{v:.3f}".rstrip("0").rstrip(".")


def compute_blend_values(components: dict[int, dict[str, Optional[float]]],
                         expected_slots: Optional[set[int]] = None):
    """(total_str, purity_str) from {slot: {'pur', 'qty'}}, or None while the
    set is incomplete: every expected slot needs BOTH a purity and a quantity.
    A partial blend never yields a number."""
    slots = expected_slots if expected_slots is not None else set(components)
    if not slots:
        return None
    for s in slots:
        c = components.get(s) or {}
        if c.get("pur") is None or c.get("qty") is None:
            return None
    total = sum(components[s]["qty"] for s in slots)
    if total <= 0:
        return None
    weighted = sum(components[s]["qty"] * components[s]["pur"] for s in slots)
    return _fmt(total), _fmt(weighted / total)


def _components(rows) -> dict[int, dict[str, Optional[float]]]:
    comps: dict[int, dict[str, Optional[float]]] = {}
    for r in rows:
        kw = (r.keyword or "").upper()
        if r.slot is None or kw not in (KW_PURITY, KW_QUANTITY):
            continue
        comps.setdefault(r.slot, {})["pur" if kw == KW_PURITY else "qty"] = _parse(r.result_value)
    return comps


# ─── vial tier ───────────────────────────────────────────────────────────────

def recalc_vial_blend_aggregates(db: Session, *, lims_sub_sample_pk: int,
                                 user_id: Optional[int] = None) -> list[int]:
    """Fill or correct a native blend VIAL's two aggregate rows from its live
    slot rows. No-op on singles, on legacy vials, and while any slot is still
    pending. Writes through apply_transition(submit): first fill from a
    pending state, in-place correction ('to_be_verified' self-edge) when a slot
    was corrected before promotion. Promoted / variance-verified aggregates
    are frozen. Returns the aggregate row ids written. Commits (as the prep
    bridge always did)."""
    from lims_analyses.service import apply_transition

    rows = [r for r in db.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == lims_sub_sample_pk)
    ).scalars().all() if not r.retested and r.review_state not in _DEAD]

    aggs = {kw: [r for r in rows if (r.keyword or "").upper() == kw]
            for kw in (KW_BLEND_TOTAL, KW_BLEND_PURITY)}
    if not aggs[KW_BLEND_PURITY]:
        return []                                   # not a native blend vial
    if any(len(v) > 1 for v in aggs.values()):
        logger.warning("blend_aggregates: duplicate live aggregate rows on vial=%s, skipping",
                       lims_sub_sample_pk)
        return []

    slot_rows = [r for r in rows if r.slot is not None
                 and (r.keyword or "").upper() in (KW_PURITY, KW_QUANTITY)]
    if not slot_rows or any(r.review_state in RESULT_PENDING_STATES for r in slot_rows):
        return []
    values = compute_blend_values(_components(slot_rows))
    if values is None:
        return []
    new = {KW_BLEND_TOTAL: values[0], KW_BLEND_PURITY: values[1]}
    label = {KW_BLEND_TOTAL: "blend total quantity (sum of slot quantities)",
             KW_BLEND_PURITY: "blend purity (quantity-weighted mean of slot purities)"}

    written: list[int] = []
    for kw, found in aggs.items():
        if not found:
            continue
        row = found[0]
        if row.review_state in RESULT_PENDING_STATES:
            reason = f"auto: {label[kw]}"
        elif row.review_state == "to_be_verified" and _fmt(_parse(row.result_value)) != new[kw]:
            reason = f"auto: recalculated {label[kw]}, was {row.result_value}"
        else:
            continue
        apply_transition(db, analysis_id=row.id, kind="submit", result_value=new[kw],
                         reason=reason, user_id=user_id, processed_by_user_id=user_id)
        written.append(row.id)
    return written


def recalc_vial_aggregates_for_row(db: Session, row: LimsAnalysis,
                                   user_id: Optional[int] = None) -> list[int]:
    """Entry point for the manual result path: `row` just had a result
    submitted. Only a native per-slot purity/quantity row on a vial can change
    an aggregate, so everything else returns immediately (including the
    aggregate rows themselves, which keeps this from recursing)."""
    if (row.lims_sub_sample_pk is None or row.slot is None
            or (row.keyword or "").upper() not in (KW_PURITY, KW_QUANTITY)):
        return []
    return recalc_vial_blend_aggregates(
        db, lims_sub_sample_pk=row.lims_sub_sample_pk, user_id=user_id)


# ─── parent tier ─────────────────────────────────────────────────────────────

def recalc_parent_blend_aggregates(db: Session, *, parent_pk: int,
                                   user_id: Optional[int] = None) -> list[int]:
    """Recalculate a native blend PARENT's aggregate rows from the parent's
    own live slot rows. Does NOT commit: it runs inside promote / un-promote
    and rides their transaction.

    Complete inputs: a changed value is written; a 'verified' row whose value
    changed drops to 'parent_to_verify' (ruling A). An unchanged value is left
    entirely alone, so the usual all-from-one-vial promote is a no-op here.

    Incomplete inputs (a slot was just un-promoted): a 'verified' aggregate
    drops to 'parent_to_verify' and keeps its figure until the slot comes
    back, when the complete branch rewrites it. Nothing can vouch for it
    meanwhile."""
    from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
    from lims_analyses.service import _deltas, _snapshot

    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_pk,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
        )
    ).scalars().all()
    live = [r for r in rows if r.provenance == "canonical" and not r.retested
            and r.review_state not in _DEAD]
    aggs = [r for r in live if (r.keyword or "").upper() in (KW_BLEND_TOTAL, KW_BLEND_PURITY)
            and r.review_state in _PARENT_TOUCHABLE]
    if not aggs:
        return []

    # Every slot the sample was ordered with has an 'ordered' placeholder
    # (never retired), so they define the expected slot set even while a
    # slot's canonical row is missing.
    expected = {r.slot for r in rows if r.slot is not None
                and r.provenance in ("canonical", PROVENANCE_ORDERED)
                and (r.keyword or "").upper() in (KW_PURITY, KW_QUANTITY)
                and r.review_state not in ("rejected", "cancelled")}
    values = compute_blend_values(_components(live), expected)
    now = datetime.utcnow()
    written: list[int] = []

    for row in aggs:
        kw = (row.keyword or "").upper()
        if values is not None:
            new = values[0] if kw == KW_BLEND_TOTAL else values[1]
            if _fmt(_parse(row.result_value)) == new:
                continue
            reason = (f"auto: recalculated from the parent's slot rows, "
                      f"was {row.result_value}")
        else:
            if row.review_state != "verified":
                continue
            new = row.result_value
            reason = "auto: a slot this figure depends on changed, awaiting recalculation"

        before = _snapshot(row)
        prior = row.review_state
        row.result_value = new
        if prior == "verified":
            row.review_state = "parent_to_verify"
            row.verified_at = None
        row.updated_at = now
        db.add(LimsAnalysisTransition(
            analysis_id=row.id, from_state=prior, to_state=row.review_state,
            transition_kind="auto", user_id=user_id, reason=reason,
            details=_deltas(before, row),
        ))
        written.append(row.id)
    return written


def recalc_parent_aggregates_safely(db: Session, *, parent_pk: Optional[int],
                                    user_id: Optional[int] = None) -> None:
    """Promote and un-promote are the lab's critical actions; a derived figure
    must never be the reason one fails. Errors are logged loudly and the
    caller's transaction continues."""
    if parent_pk is None:
        return
    try:
        recalc_parent_blend_aggregates(db, parent_pk=parent_pk, user_id=user_id)
    except Exception:  # noqa: BLE001
        logger.exception("blend_aggregates: parent recalculation failed parent_pk=%s", parent_pk)


def parent_pk_of(db: Session, row: LimsAnalysis) -> Optional[int]:
    """The parent sample pk a row belongs to, whichever tier hosts it."""
    if row.lims_sample_pk is not None:
        return row.lims_sample_pk
    if row.lims_sub_sample_pk is None:
        return None
    sub = db.get(LimsSubSample, row.lims_sub_sample_pk)
    return sub.parent_sample_pk if sub is not None else None
