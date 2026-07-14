"""Parent analysis SENAITE->Mk1 shadow mirror (SENAITE phase-out slice).

Best-effort dual-write: mirror parent-AR analysis line items into native
lims_analyses SHADOW rows. Shadow rows carry provenance='shadow' + sentinel
review_state=SHADOW_STATE so no live COA/variance/family reader picks them
up (fail-closed). SENAITE stays system-of-record; nothing reads shadows this slice.
"""
from __future__ import annotations
from datetime import datetime
from typing import Optional, Tuple
from sqlalchemy import or_, select
from sqlalchemy.orm import Session
from models import (
    AnalysisService, LimsAnalysis,
    LimsAnalysisTransition, LimsSample,
)

SHADOW_STATE = "senaite_mirror"


def resolve_shadow_target(db: Session, *, sample_id: str, keyword: str
                          ) -> Optional[Tuple[LimsSample, AnalysisService]]:
    """Resolve (parent LimsSample, AnalysisService) from a SENAITE getRequestID
    + Keyword. Returns None when the parent isn't in the registry yet, or the
    service keyword is unknown — the documented no-op contract.

    `AnalysisService.keyword` carries no unique constraint (prod precedent:
    a re-run of the analysis-services sync cloned two PUR_TB500BETA4 rows —
    see the same defensive pattern at `service.py:73-81`), so this uses
    `.order_by(AnalysisService.id).scalars().first()` rather than
    `scalar_one_or_none()`: a duplicate keyword must resolve deterministically
    to the lower/oldest id instead of raising MultipleResultsFound, which
    would otherwise be swallowed by the caller's best-effort guard and leave
    a permanent, silent mirror gap for every write against that keyword.
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return None
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword == keyword)
        .order_by(AnalysisService.id)
    ).scalars().first()
    if svc is None:
        return None
    return parent, svc


def _existing_shadow(db: Session, parent_id: int, service_id: int) -> Optional[LimsAnalysis]:
    """The live shadow row for (parent, service) — baseline or retest alike.

    Deliberately does NOT filter on retest_of_id: after a retest, the live
    row is the NEW row, which carries retest_of_id != NULL. Filtering on
    retest_of_id IS NULL would miss it and a subsequent update would CREATE
    a spurious third row instead of updating the live one. `retested` is
    the only liveness signal — the newest non-retested shadow row IS the
    live one. Ordered by id desc + take-first (not scalar_one_or_none): if
    an anomaly ever produces more than one live row, resolve deterministically
    to the newest rather than raising.
    """
    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_id,
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.provenance == "shadow",
            LimsAnalysis.retested.is_(False),
        ).order_by(LimsAnalysis.id.desc())
    ).scalars().first()


def mirror_parent_analysis(db: Session, *, sample_id: str, keyword: str,
                           mirror_review_state: Optional[str] = None,
                           result_value: Optional[str] = None,
                           result_unit: Optional[str] = None,
                           is_retest: bool = False,
                           old_mirror_review_state: Optional[str] = None) -> bool:
    """Upsert a parent shadow row. Returns False (no-op) if the parent isn't
    registered. Caller commits. Best-effort — callers wrap in try/except.

    method_id/instrument_id are Mk1-owned (read-flip spec §5) — this mirror
    never reads or writes them.

    `old_mirror_review_state` is honored ONLY in the `is_retest` branch: when
    provided, it's stamped onto the OLD (superseded) row's
    mirror_review_state before it's marked retested — modeling SENAITE's
    retract transition, which is retire-and-replace (the original line
    becomes 'retracted' and a NEW copy is born carrying the result, distinct
    from a plain retest where the old line simply stays at whatever state it
    was verified/submitted at). Default None preserves the exact prior
    behavior (old row's mirror_review_state left untouched) — every existing
    caller (plain retest) is unaffected. The audit reason is derived from
    this kwarg: "shadow mirror: superseded by retract" when it's "retracted",
    "shadow mirror: superseded by retest" otherwise (including the default
    None case)."""
    target = resolve_shadow_target(db, sample_id=sample_id, keyword=keyword)
    if target is None:
        return False
    parent, svc = target

    if is_retest:
        old = _existing_shadow(db, parent.id, svc.id)
        if old is not None:
            if old_mirror_review_state is not None:
                old.mirror_review_state = old_mirror_review_state
            old.retested = True
            superseded_reason = (
                "shadow mirror: superseded by retract"
                if old_mirror_review_state == "retracted"
                else "shadow mirror: superseded by retest"
            )
            db.add(LimsAnalysisTransition(
                analysis_id=old.id, from_state=old.review_state, to_state=old.review_state,
                transition_kind="retest", reason=superseded_reason,
            ))
            # Flush the old row's retested=True BEFORE inserting the new row:
            # the shadow partial unique index (lims_sample_pk,
            # analysis_service_id) WHERE provenance='shadow' AND retested=FALSE
            # must never see two "live" rows for this (parent, service) within
            # the same transaction, even momentarily.
            db.flush()
        new_row = LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            review_state=SHADOW_STATE, provenance="shadow",
            mirror_review_state=mirror_review_state,
            result_value=result_value, result_unit=result_unit,
            retest_of_id=(old.id if old is not None else None),
        )
        db.add(new_row)
        db.flush()
        db.add(LimsAnalysisTransition(
            analysis_id=new_row.id, from_state=None, to_state=SHADOW_STATE,
            transition_kind="auto", reason="shadow mirror: retest insert",
        ))
        db.flush()
        return True

    row = _existing_shadow(db, parent.id, svc.id)
    if row is None:
        row = LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            review_state=SHADOW_STATE, provenance="shadow",
        )
        db.add(row)
        db.flush()
        db.add(LimsAnalysisTransition(
            analysis_id=row.id, from_state=None, to_state=SHADOW_STATE,
            transition_kind="auto", reason="shadow mirror: initial insert",
        ))

    if mirror_review_state is not None:
        row.mirror_review_state = mirror_review_state
    if result_value is not None:
        row.result_value = result_value
    if result_unit is not None:
        row.result_unit = result_unit
    row.updated_at = datetime.utcnow()
    db.flush()
    return True


def _pick_newest_line(items: list[dict]) -> dict:
    """Newest remaining line in a keyword group. Items carrying a `created`
    value win, compared as strings (SENAITE's ISO-8601 timestamps sort
    correctly lexicographically); when NONE of the remaining items carry a
    created value, falls back to the last item in SENAITE's own catalog
    order (its natural insertion/brain order) rather than picking arbitrarily.

    Tie-break consistency: bare `max()` returns the FIRST maximal element,
    which would contradict the no-dates fallback's last-in-list rule whenever
    two lines share a created timestamp — so position is folded into the sort
    key and ties break toward the LAST item in catalog order, matching the
    fallback."""
    dated = [it for it in items if it.get("created")]
    if dated:
        return max(enumerate(dated), key=lambda p: (p[1]["created"], p[0]))[1]
    return items[-1]


def select_current_lines(items: list[dict]) -> dict[str, dict]:
    """Group analysis lines by keyword; drop any line whose uid is referenced
    by another line's `retest_of_uid` (superseded by a retest); return
    {keyword: newest remaining line} — exactly ONE line per keyword, the
    current state to mirror. Items without a keyword are skipped (nothing to
    key a shadow row on). If every line in a group were (implausibly)
    superseded — e.g. a cross-keyword retest_of_uid anomaly — falls back to
    the full group rather than dropping the keyword entirely (defensive:
    under-exclusion, not silent data loss, is the safe error direction here,
    same posture as senaite.py's `_INACTIVE_ANALYSIS_STATES` default-open
    comment).

    Shared by `scripts/backfill_parent_analysis_shadows.py` (one-time
    backfill) and main.py's registry-inspect debug panel analyses column
    (live current-state read) — both need the exact same "what's the current
    line per keyword" answer."""
    by_keyword: dict[str, list[dict]] = {}
    for it in items:
        kw = it.get("keyword")
        if not kw:
            continue
        by_keyword.setdefault(kw, []).append(it)

    superseded_uids = {it["retest_of_uid"] for it in items if it.get("retest_of_uid")}

    selected: dict[str, dict] = {}
    for kw, group in by_keyword.items():
        remaining = [it for it in group if it.get("uid") not in superseded_uids] or group
        selected[kw] = _pick_newest_line(remaining)
    return selected


def _norm_result(v: Optional[str]) -> Optional[str]:
    return None if v is None else str(v).strip()


def _analysis_row_status(senaite: Optional[dict], shadow: Optional[dict]) -> str:
    """Per-keyword sync status for the registry-inspect analyses column.

    - no_shadow: a current SENAITE line exists but no live shadow row yet
      (expected pre-backfill).
    - shadow_only: no current SENAITE line for this keyword, but SOME native
      record does exist — a live shadow row (the common case: the SENAITE
      line was itself removed/retested-away without a corresponding shadow
      update) or, rarely, only a canonical row with neither a current
      SENAITE line nor a live shadow (the union in `build_analysis_sync_rows`
      includes canonical-only keywords too — this branch keeps that case
      from raising instead of inventing a 5th status). Surfaced as a
      warning, not silently dropped.
    - in_sync / drift: both sides present; compares mirror_review_state to
      the live SENAITE review_state, and result values trimmed (so trailing
      whitespace never reads as drift)."""
    if senaite is not None and shadow is None:
        return "no_shadow"
    if senaite is None:
        return "shadow_only"
    state_match = shadow["mirror_review_state"] == senaite["review_state"]
    result_match = _norm_result(shadow["result"]) == _norm_result(senaite["result"])
    return "in_sync" if (state_match and result_match) else "drift"


def build_analysis_sync_rows(senaite_map: dict, shadow_map: dict, canonical_map: dict) -> dict:
    """Pure per-keyword comparison for the registry-inspect debug panel's
    analyses column: union of current SENAITE analysis lines (already
    reduced to one per keyword by `select_current_lines`) + native
    `lims_analyses` rows (live shadow + current canonical) for one parent.

    No I/O — all three maps are pre-fetched by the caller (main.py), keyed by
    keyword:
      senaite_map[kw]   = {"review_state": ..., "result": ...}
      shadow_map[kw]    = {"mirror_review_state": ..., "result": ..., "title": ...}
      canonical_map[kw] = {"review_state": ..., "result": ..., "title": ...}

    Returns {"rows": [...], "summary": {...}}. Summary counting follows the
    two natural identities a reader can eyeball:
      senaite = in_sync + drift + missing   (rows with a current SENAITE line)
      shadow  = in_sync + drift + shadow_only  (rows with a live shadow row)
    `missing` is the no_shadow count (the ○ glyph — expected pre-backfill).
    `shadow_only` has no dedicated summary slot (by design — it's implicit:
    shadow - in_sync - drift) but stays visible per-row via its own status
    value and ⚠ glyph on the frontend."""
    keywords = sorted(set(senaite_map) | set(shadow_map) | set(canonical_map))
    rows = []
    counts = {"senaite": 0, "shadow": 0, "in_sync": 0, "drift": 0, "missing": 0}
    for kw in keywords:
        s = senaite_map.get(kw)
        sh = shadow_map.get(kw)
        c = canonical_map.get(kw)
        title = (
            (sh or {}).get("title") or (c or {}).get("title")
            or (s or {}).get("title") or kw
        )
        if s is not None:
            counts["senaite"] += 1
        if sh is not None:
            counts["shadow"] += 1
        status = _analysis_row_status(s, sh)
        if status == "in_sync":
            counts["in_sync"] += 1
        elif status == "drift":
            counts["drift"] += 1
        elif status == "no_shadow":
            counts["missing"] += 1
        rows.append({
            "keyword": kw, "title": title,
            "senaite": {"review_state": s["review_state"], "result": s["result"]} if s else None,
            "shadow": ({"mirror_review_state": sh["mirror_review_state"], "result": sh["result"]}
                       if sh else None),
            "canonical": {"review_state": c["review_state"], "result": c["result"]} if c else None,
            "status": status,
        })
    return {"rows": rows, "summary": counts}


def mark_parent_shadows_published(db: Session, *, sample_id: str) -> int:
    """A6 publish: flip every LIVE shadow row for a parent to
    mirror_review_state='published'.

    Resolves the parent by LimsSample.sample_id (0 = not registered, no-op).
    Updates only provenance='shadow' AND retested=False rows — the live
    ones; a retested/superseded shadow row keeps whatever state it was
    superseded at, and canonical (native) rows are untouched (publish there
    runs its own native state machine). Also excludes live shadows already
    stamped mirror_review_state IN ('rejected', 'retracted') (from A7-remove /
    A5-replace): a removed/replaced analysis line doesn't publish with the
    AR. NULL mirror_review_state (never yet stamped) is NOT excluded — plain
    `NOT IN` would silently drop NULL rows since SQL's NOT IN against NULL is
    neither true nor false, so the exclusion is OR'd with an explicit
    `IS NULL` branch. Sets mirror_review_state="published" + updated_at,
    flushes, never commits (caller commits). Returns the count of rows
    updated; 0 = no-op (unregistered parent or no live shadow rows yet —
    both legitimate, not errors).
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return 0
    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.provenance == "shadow",
            LimsAnalysis.retested.is_(False),
            or_(
                LimsAnalysis.mirror_review_state.is_(None),
                LimsAnalysis.mirror_review_state.not_in(("rejected", "retracted")),
            ),
        )
    ).scalars().all()
    now = datetime.utcnow()
    count = 0
    for row in rows:
        row.mirror_review_state = "published"
        row.updated_at = now
        count += 1
    if count:
        db.flush()
    return count
