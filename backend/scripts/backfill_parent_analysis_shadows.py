"""One-time backfill: create native `lims_analyses` SHADOW rows for parent
analyses that ALREADY exist in SENAITE (2026-07-parent-analysis-native-mirror
design). The Task 4-8 write hooks only capture writes made AFTER they were
deployed — every parent AR created/edited before that point has no shadow row
until this script runs once.

Run INSIDE the backend container so the app's modules and env are available:

    docker exec -w /app -i <backend-container> \
        python -m scripts.backfill_parent_analysis_shadows --sleep 0.5 --batch-size 200

Idempotent: re-running only fills gaps / refreshes the current line per
keyword; `mirror_parent_analysis`'s get-or-create/update is the safety net —
this script can be re-run any number of times without duplicating rows. Use
--dry-run for a rehearsal that iterates the registry + fetches (throttled)
but writes nothing (no DB rows, no checkpoint), and --limit N for a smoke run.

MECHANISM (differs from backfill_lims_sample_basic_info.py's SENAITE-side
enumeration): this script iterates Mk1's OWN `lims_samples` registry table,
ordered by id — NOT a SENAITE-side page walk. Only rows already registered in
Mk1 (i.e. samples the receive wizard has touched) are candidates; a row with
NULL `external_lims_uid` is native-only (no SENAITE AR to mirror) and is
skipped. Per parent, exactly ONE throttled SENAITE Analysis-catalog query
fetches every analysis line on the AR; lines are grouped by keyword, retest-
superseded lines are dropped, and the newest remaining line per keyword is
the one mirrored — this backfill records CURRENT state, not the retest
history (is_retest=False always; the historical retest chain is not
reconstructed here — see project docs for that non-goal).

SENAITE BULK-SCAN SAFETY (load-bearing — do not "optimize" away): SENAITE
runs a single Zope core; an unthrottled sweep over every registered parent
has taken it down for ~15 minutes before (see feedback_senaite_bulk_scan_hazard).
This script therefore runs strictly sequentially (concurrency 1) and sleeps
between EVERY per-parent fetch; run off-hours.

Checkpoint retention: after ANY completed run (clean or with per-parent
errors) the checkpoint file remains at the id of the LAST PROCESSED
lims_samples row. Re-running with the same --checkpoint path resumes strictly
AFTER that row. To re-scan from the start — including retrying parents that
errored, since an errored parent still advances the checkpoint — DELETE the
checkpoint file first. Skipped rows (NULL uid / secondary) also advance the
checkpoint (a deliberate difference from basic-info's page-granular
checkpoint, which only advances on a real fetch attempt: our cursor is
row-granular, so re-skipping the same deterministic skip is pure waste with
no retry benefit, unlike a transient SENAITE error).

Known gap: HplcMethod has no reliable SENAITE-uid match key on parent
analyses (see lims_analyses/parent_mirror.py::resolve_method_id's docstring),
so `method_id` is never set by this backfill — mirrored rows land with
method_id=NULL until that gap is closed separately.

The final stats line on stdout is the coverage evidence for this one-time
migration — retain it with the run record.

Exit code contract: 0 = clean run, no per-parent errors. 1 = run completed
but one or more parents errored (see the "errors" count in the stats line).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from typing import Optional

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select

from database import SessionLocal
from lims_analyses.parent_mirror import mirror_parent_analysis, resolve_instrument_id, resolve_shadow_target
from models import LimsAnalysis, LimsSample
from sub_samples import senaite

log = logging.getLogger("backfill_parent_shadows")

# Sub-sample secondaries use `<parent>-S<NN>` ids; they are vials, not
# parents, and have no place in this parent-only mirror. Same unanchored
# convention as backfill_lims_sample_basic_info.py's `_SECONDARY_ID`: matches
# anywhere so a secondary's retest (`P-0134-S01-R01`) is also caught. This is
# a defensive backstop — `lims_samples` should only ever hold parent rows —
# not the expected common case.
_SECONDARY_ID = re.compile(r"-S\d+")

DEFAULT_CHECKPOINT = "/tmp/backfill_parent_analysis_shadows.checkpoint.json"


def load_checkpoint(path: str) -> int:
    """Return the last-processed lims_samples.id to resume AFTER (0 = fresh run)."""
    try:
        with open(path) as f:
            return int(json.load(f).get("last_id", 0))
    except (OSError, ValueError):
        return 0


def save_checkpoint(path: str, last_id: int, last_sample_id: str) -> None:
    """Persist the row cursor. Row-granular: resuming picks up strictly AFTER
    last_id, never reprocessing it — safe regardless because the mirror
    upsert is idempotent anyway."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"last_id": last_id, "last_sample_id": last_sample_id}, f)
    os.replace(tmp, path)


def fetch_parent_analyses(sample_id: str) -> list[dict]:
    """ONE throttled SENAITE Analysis-catalog query for every analysis line
    on a parent AR. Same endpoint + params + field-extraction shape as
    `coa.source_resolver.SenaiteAnalysesHttpReader.list_for_sample` (sync via
    `sub_samples.senaite._get` rather than an async httpx client), plus two
    additions this backfill needs that the COA reader doesn't:

      * `instrument_uid` — the SENAITE Analysis catalog carries the
        instrument as a nested `Instrument` object ref ({"uid": ..., "title":
        ...}), the same shape backend/main.py's AR-detail analyses fetch
        reads at ~12504-12510 (same `/v1/Analysis?getRequestID=...` endpoint).
        Only the uid is extracted; None when absent (SENAITE analyses with no
        instrument assigned yet, or instrument recorded as free text only).
      * `created` — best-effort creation timestamp for newest-line selection
        when a keyword has more than one non-superseded line (should not
        normally happen outside a retest chain, but the fallback exists so
        selection is deterministic instead of order-dependent). Falls back
        through the same field-name variants main.py's report-date code uses
        elsewhere (`created`/`creation_date`/`DateCreated`/`getDateCreated`);
        None when the catalog brain carries none of them (falls back to
        last-in-list — see `_pick_newest_line`).

    Raises RuntimeError on a non-2xx SENAITE response — the caller's
    per-parent try/except turns this into a logged error + stats increment,
    never aborting the whole run.
    """
    url = f"{senaite.SENAITE_BASE_URL}/@@API/senaite/v1/Analysis"
    resp = senaite._get(url, params={"getRequestID": sample_id, "complete": "yes", "limit": 200})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE fetch_parent_analyses failed ({resp.status_code}): {resp.text}")
    items = resp.json().get("items", []) or []
    out: list[dict] = []
    for it in items:
        instrument_obj = it.get("Instrument")
        instrument_uid = instrument_obj.get("uid") if isinstance(instrument_obj, dict) else None
        out.append({
            "uid": it.get("uid"),
            "keyword": it.get("getKeyword") or it.get("Keyword"),
            "result": it.get("Result"),
            "unit": it.get("Unit"),
            "review_state": it.get("review_state"),
            "retest_of_uid": (
                it.get("getRetestOfUID")
                or (it.get("RetestOf") or {}).get("uid")
                or None
            ),
            "instrument_uid": instrument_uid,
            "created": (
                it.get("created") or it.get("creation_date")
                or it.get("DateCreated") or it.get("getDateCreated")
            ),
        })
    return out


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
    comment)."""
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


def iter_registry_rows(db_factory, *, start_id: int, page_size: int):
    """Yield (id, sample_id, external_lims_uid) for every lims_samples row
    with id > start_id, ordered by id, paged so no single DB session is held
    open across the (throttled, potentially slow) per-parent SENAITE calls."""
    last_id = start_id
    while True:
        db = db_factory()
        try:
            rows = db.execute(
                select(LimsSample.id, LimsSample.sample_id, LimsSample.external_lims_uid)
                .where(LimsSample.id > last_id)
                .order_by(LimsSample.id)
                .limit(page_size)
            ).all()
        finally:
            db.close()
        if not rows:
            return
        for row in rows:
            yield row.id, row.sample_id, row.external_lims_uid
        last_id = rows[-1].id


def _has_live_shadow(db, sample_id: str, keyword: str) -> bool:
    """Whether a LIVE shadow row already exists for (sample_id, keyword) —
    used only for created-vs-updated bookkeeping; never mutates. Does not
    touch mirror_parent_analysis's own return contract (still just True/False
    for "did it write")."""
    target = resolve_shadow_target(db, sample_id=sample_id, keyword=keyword)
    if target is None:
        return False
    parent, svc = target
    return db.execute(
        select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.analysis_service_id == svc.id,
            LimsAnalysis.provenance == "shadow",
            LimsAnalysis.retested.is_(False),
        )
    ).scalar() is not None


def backfill(db_factory, *, sleep_s: float, batch_size: int,
             checkpoint_path: str, dry_run: bool,
             limit: Optional[int]) -> dict:
    """Iterate the lims_samples registry; for each PARENT with a SENAITE AR,
    fetch its analyses ONCE and mirror the current line per keyword. One
    parent's failure never aborts the run. Returns coverage stats.

    Stats integrity: created/updated are accumulated in per-parent LOCALS
    and folded into `stats` only AFTER that parent's `db.commit()` returns —
    a later keyword's exception rolls back the parent's ENTIRE transaction
    (nothing persisted), so counting per-call would let the stats line (the
    documented coverage evidence for this migration) overcount rows that
    never landed. On any per-parent exception only `errors` increments."""
    stats = {"seen": 0, "created": 0, "updated": 0,
             "skipped_no_uid": 0, "skipped_secondary": 0, "errors": 0}
    start_id = load_checkpoint(checkpoint_path)
    if start_id:
        log.info("resuming from checkpoint id=%s", start_id)

    for row_id, sample_id, external_uid in iter_registry_rows(
            db_factory, start_id=start_id, page_size=batch_size):
        if limit is not None and stats["seen"] >= limit:
            break
        stats["seen"] += 1

        if external_uid is None:
            stats["skipped_no_uid"] += 1
            if not dry_run:
                save_checkpoint(checkpoint_path, row_id, sample_id)
            time.sleep(sleep_s)  # bulk-scan safety: throttle even skip-only rows
            continue

        if _SECONDARY_ID.search(sample_id):
            stats["skipped_secondary"] += 1
            if not dry_run:
                save_checkpoint(checkpoint_path, row_id, sample_id)
            time.sleep(sleep_s)
            continue

        try:
            items = fetch_parent_analyses(sample_id)  # ONE throttled query per parent
            selected = select_current_lines(items)
            if not dry_run:
                db = db_factory()
                created_here = 0
                updated_here = 0
                try:
                    for keyword, line in selected.items():
                        existed = _has_live_shadow(db, sample_id, keyword)
                        instrument_id = resolve_instrument_id(db, line.get("instrument_uid"))
                        ok = mirror_parent_analysis(
                            db, sample_id=sample_id, keyword=keyword,
                            mirror_review_state=line.get("review_state"),
                            result_value=line.get("result"),
                            result_unit=line.get("unit"),
                            instrument_id=instrument_id,
                            is_retest=False,  # backfill records CURRENT state, not history
                        )
                        if ok:
                            if existed:
                                updated_here += 1
                            else:
                                created_here += 1
                        else:
                            log.debug(
                                "backfill_no_op sample=%s keyword=%s "
                                "(unresolved parent or unknown service keyword)",
                                sample_id, keyword,
                            )
                    db.commit()
                    # Fold in ONLY after the commit succeeded — see docstring.
                    stats["created"] += created_here
                    stats["updated"] += updated_here
                finally:
                    db.close()
        except Exception as e:
            stats["errors"] += 1
            log.warning("backfill error sample=%s err=%s", sample_id, e, exc_info=True)

        if not dry_run:
            save_checkpoint(checkpoint_path, row_id, sample_id)
        time.sleep(sleep_s)  # bulk-scan safety: throttle EVERY parent

    log.info("backfill done: %s", stats)
    if not dry_run:
        log.info("checkpoint retained at %s — delete it to re-scan from the start "
                 "/ retry errored parents", checkpoint_path)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Backfill lims_analyses shadow rows for existing parent "
                    "analyses from SENAITE (throttled, resumable — see module docstring).",
        epilog="Exit codes: 0 = clean, 1 = completed with per-parent errors "
               "(see stats line). Checkpoint is retained after completion — "
               "delete it to re-scan from the start / retry errored parents.")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="seconds between per-parent SENAITE fetches (bulk-scan safety; default 0.5)")
    ap.add_argument("--batch-size", type=int, default=200,
                    help="lims_samples registry page size (default 200)")
    ap.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT,
                    help=f"resume-cursor JSON path (default {DEFAULT_CHECKPOINT})")
    ap.add_argument("--dry-run", action="store_true",
                    help="iterate + fetch but write nothing (no DB rows, no checkpoint)")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N parents (smoke runs)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stats = backfill(SessionLocal, sleep_s=args.sleep, batch_size=args.batch_size,
                     checkpoint_path=args.checkpoint, dry_run=args.dry_run,
                     limit=args.limit)
    print(json.dumps(stats))  # coverage evidence line — retain
    return 1 if stats["errors"] else 0  # nonzero so unattended runs surface partial failure


if __name__ == "__main__":
    raise SystemExit(main())
