"""One-time backfill: apply `assign` to vial-tier rows an OPEN worksheet already
claims (2026-09-08 worksheet -> `assigned` state wiring).

Before that wiring, add-to-worksheet stamped `analyst_user_id` but never moved
`review_state`, so every claimed-but-not-yet-submitted row in prod still reads
`unassigned` (probe 2026-09-08: 76 vials on open worksheets, 0 rows ever
`assigned`). New adds are covered by worksheet_analyst.stamp_for_item; this
script catches up the rows claimed before the deploy.

Run INSIDE the backend container (dry-run is the default and writes nothing):

    docker exec -w /app -i accu-mk1-backend python -m scripts.backfill_worksheet_assign
    docker exec -w /app -i accu-mk1-backend python -m scripts.backfill_worksheet_assign --apply

Scope: OPEN worksheets only. Each item resolves to its vial's live rows with the
same department/group scoping the analyst stamp uses (worksheet_analyst._resolve),
and only rows still in `unassigned` move — submitted/promoted/dead rows are never
touched. The transition is the state machine's own `assign` (audited on
lims_analysis_transitions with reason "backfill_worksheet_assign ..."); the
analyst stamp already present on the rows is left as-is. Idempotent: a second
run finds nothing pending. One commit at the end of an --apply run.
"""
from __future__ import annotations

import argparse
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.worksheet_analyst import _assign_pending, _resolve
from models import Worksheet, WorksheetItem


def run(db: Session, *, apply: bool) -> dict:
    """Report (and with apply=True, perform) the backfill. Returns the stats
    dict the CLI prints; `per_worksheet` lists (id, title, rows) for every open
    worksheet that had pending rows."""
    worksheets = db.execute(
        select(Worksheet).where(Worksheet.status == "open").order_by(Worksheet.id)
    ).scalars().all()
    per_worksheet: list[tuple[int, Optional[str], int]] = []
    vials = 0
    total_rows = 0
    for ws in worksheets:
        items = db.execute(
            select(WorksheetItem).where(WorksheetItem.worksheet_id == ws.id)
        ).scalars().all()
        ws_rows = 0
        for item in items:
            sub, rows = _resolve(
                db, sample_uid=item.sample_uid,
                department_id=item.department_id, service_group_id=item.service_group_id,
            )
            if sub is None:
                continue
            pending = [r for r in rows if r.review_state == "unassigned"]
            if not pending:
                continue
            vials += 1
            ws_rows += len(pending)
            if apply:
                _assign_pending(
                    db, rows, user_id=None,
                    reason=f"backfill_worksheet_assign 2026-09-08: {ws.title}",
                )
        if ws_rows:
            per_worksheet.append((ws.id, ws.title, ws_rows))
        total_rows += ws_rows
    if apply:
        db.commit()
    return {
        "open_worksheets": len(worksheets),
        "vials": vials,
        "rows_to_assign": total_rows,
        "per_worksheet": per_worksheet,
        "applied": apply,
    }


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true",
                    help="write the transitions; without it this is a dry-run report")
    args = ap.parse_args(argv)
    from database import SessionLocal

    db = SessionLocal()
    try:
        report = run(db, apply=args.apply)
    finally:
        db.close()
    for ws_id, title, n in report["per_worksheet"]:
        print(f"  worksheet {ws_id} {title}: {n} row(s)")
    print(
        f"open_worksheets={report['open_worksheets']} vials={report['vials']} "
        f"rows_to_assign={report['rows_to_assign']}"
    )
    print("APPLIED" if report["applied"] else "DRY RUN -- nothing written (re-run with --apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
