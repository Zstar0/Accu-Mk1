"""Backfill Mk1 worksheets from Dennis's endotoxin run log
(tools-dennis/tools/endotoxin-log/endotoxin-data.json).

Why: from 2026-09-01 the endo bench prepped from that log instead of Mk1
worksheets, so vial-tier ENDO rows stopped receiving analyst attribution
(probe 2026-09-18: 28 of 93 native endo rows in the week of 09-14 carry no
analyst; every one of the log's 250 sample ids resolves to an Mk1 vial).

Run INSIDE the backend container (dry-run is the default and writes nothing):

    docker cp endotoxin-data.json accu-mk1-backend:/tmp/endotoxin-data.json
    docker exec -w /app -i accu-mk1-backend python -m scripts.backfill_endo_worksheets /tmp/endotoxin-data.json
    docker exec -w /app -i accu-mk1-backend python -m scripts.backfill_endo_worksheets /tmp/endotoxin-data.json --apply

Per run in the log:
  * every row's sample id resolves to a vial: an exact lims_sub_samples.sample_id,
    else the parent's single endo/endo85-role vial; anything else is reported
    and skipped, never guessed
  * a vial already on any non-staging worksheet keeps that worksheet (the lab's
    own record and its analyst win); only its EMPTY prep overrides are filled in
  * the remaining vials go on ONE new worksheet per run: title from the run
    (`Endo 09/11/2026 #3`, or the run's label), analyst by first name, department
    Microbiology, created_at = the run date, status `completed` when every live
    endo row on its vials is past submission, else `open`
  * each new item is stamped through lims_analyses.worksheet_analyst.stamp_for_item,
    the same path the drawer uses: analyst on the live endo rows, `assign` on any
    still-unassigned row, a worksheet_assigned event on the vial
  * prep overrides (spec 2026-09-18-endo-worksheet-design §5): weight when the
    log's number differs from the parent's declared quantity, volume when the log
    carries an explicit `g`, dilution when a bac-water note names a factor other
    than 20; Mk1's own received date and effective priority are used, not the log's

Idempotent: a vial that already has a worksheet item is never placed again, so
a run whose vials are all placed creates nothing. One commit at the end of an
--apply run.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from lims_analyses.worksheet_analyst import stamp_for_item
from models import (
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    User,
    Worksheet,
    WorksheetItem,
)

ENDO_ROLES = ("endo", "endo85")
ENDO_KEYWORDS = ("ENDO-LAL", "ENDOTOXIN-USP85LAL")
_DEAD_STATES = ("retracted", "rejected")
_PAST_SUBMISSION = ("to_be_verified", "verified", "published", "promoted")
DEFAULT_DILUTION = 20.0
# The run date is a lab date; stored as 10:00 Pacific expressed in the naive-UTC
# convention every Mk1 timestamp uses, so week histograms land on the right week.
_RUN_HOUR_UTC = 17


def load_runs(path: str) -> list[dict]:
    """The live store: {savedAt, store: {"runs/<id>": run}}. Sorted by run name
    (MMDDYYYY[-n]), which is also chronological within a month."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    store = data.get("store", data) if isinstance(data, dict) else {}
    runs = [v for k, v in store.items() if k.startswith("runs/") and isinstance(v, dict)]
    return sorted(runs, key=lambda r: str(r.get("name") or ""))


_RUN_NAME = re.compile(r"^(\d{2})(\d{2})(\d{4})(?:-(\d+))?$")


def worksheet_title_for_run(run: dict) -> str:
    """The run's display label if it has one, else `Endo MM/DD/YYYY[ #n]`."""
    label = str(run.get("label") or "").strip()
    if label:
        return label
    m = _RUN_NAME.match(str(run.get("name") or ""))
    if m:
        mm, dd, yyyy, n = m.groups()
        base = f"Endo {mm}/{dd}/{yyyy}"
        return f"{base} #{n}" if n else base
    return f"Endo {run.get('dateMade') or run.get('name') or '?'}"


def run_datetime(run: dict) -> datetime:
    """When the run was made, from dateMade (ISO) else the MMDDYYYY run name."""
    made = str(run.get("dateMade") or "")
    try:
        d = date.fromisoformat(made)
    except ValueError:
        m = _RUN_NAME.match(str(run.get("name") or ""))
        d = date(int(m.group(3)), int(m.group(1)), int(m.group(2))) if m else date.today()
    return datetime(d.year, d.month, d.day, _RUN_HOUR_UTC, 0)


def _num(v) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip())
        except ValueError:
            return None
    return None


def dilution_factor_from_note(f) -> Optional[float]:
    """The "NNx" written in a bac-water weight note ("20X Dilution in 1 EU/mL Cartridge")."""
    if not isinstance(f, str):
        return None
    m = re.search(r"(\d+(?:\.\d+)?)\s*x\b", f, re.IGNORECASE)
    return float(m.group(1)) if m else None


def _is_bac_water(sample_id: str, parent: Optional[LimsSample]) -> bool:
    if sample_id.upper().startswith("BW-"):
        return True
    st = (getattr(parent, "sample_type_title", None) or getattr(parent, "sample_type", None) or "")
    return bool(re.search(r"bacteriostatic|bac\.?\s*water", st, re.IGNORECASE))


def prep_overrides_for_row(row: dict, parent: Optional[LimsSample], sample_id: str) -> dict:
    """Only what differs from what Mk1 computes on its own (spec §5)."""
    f = row.get("f")
    volume = _num(row.get("g"))
    out = {
        "prep_weight_mg": None,
        "prep_volume_ml": volume if volume and volume > 0 else None,
        "prep_dilution_factor": None,
    }
    if _is_bac_water(sample_id, parent):
        factor = dilution_factor_from_note(f)
        if factor and abs(factor - DEFAULT_DILUTION) > 1e-9:
            out["prep_dilution_factor"] = factor
        return out
    weight = _num(f)
    declared = _num(parent.declared_total_quantity) if parent is not None else None
    if weight is not None and weight > 0 and (declared is None or abs(declared - weight) > 1e-9):
        out["prep_weight_mg"] = weight
    return out


def resolve_vial(db: Session, sample_id: str) -> tuple[Optional[LimsSubSample], str]:
    """Exact vial id, else the parent's single endo-role vial. Returns
    (vial, how) with how in vial | parent | blank | unknown | no_endo_vial |
    multiple_endo_vials."""
    sid = (sample_id or "").strip()
    if not sid:
        return None, "blank"
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sid)
    ).scalar_one_or_none()
    if sub is not None:
        return sub, "vial"
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sid)
    ).scalar_one_or_none()
    if parent is None:
        return None, "unknown"
    vials = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_role.in_(ENDO_ROLES),
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    if len(vials) == 1:
        return vials[0], "parent"
    return None, ("no_endo_vial" if not vials else "multiple_endo_vials")


def analyst_for(db: Session, name) -> Optional[int]:
    """Exactly one active user whose first name matches (case-insensitive)."""
    n = str(name or "").strip()
    if not n:
        return None
    rows = db.execute(
        select(User).where(func.lower(User.first_name) == n.lower(), User.is_active.is_(True))
    ).scalars().all()
    return rows[0].id if len(rows) == 1 else None


def _endo_rows(db: Session, sub: LimsSubSample) -> list[LimsAnalysis]:
    return list(db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub.id,
            LimsAnalysis.keyword.in_(ENDO_KEYWORDS),
            ~LimsAnalysis.review_state.in_(_DEAD_STATES),
        )
    ).scalars().all())


def _existing_item(db: Session, uid: str) -> Optional[WorksheetItem]:
    return db.execute(
        select(WorksheetItem)
        .join(Worksheet, Worksheet.id == WorksheetItem.worksheet_id)
        .where(WorksheetItem.sample_uid == uid, Worksheet.status != "staging")
        .order_by(WorksheetItem.id)
    ).scalars().first()


def _effective_priorities(db: Session, uids: list[str]) -> dict:
    """Mk1's effective priority per vial uid in the legacy worksheet vocabulary.
    A stack with no priorities seeded (unit tests) falls back to "normal"."""
    try:
        from priority.service import legacy_priority_string, load_effective_for_uids
        eff = load_effective_for_uids(db, uids)
        return {uid: legacy_priority_string(e) for uid, e in eff.items()}
    except Exception:  # noqa: BLE001 -- priority is a display snapshot, never a blocker
        return {}


def run_backfill(db: Session, runs: list[dict], *, apply: bool, today: date) -> dict:
    micro = db.execute(
        select(Department).where(Department.name == "Microbiology")
    ).scalar_one_or_none()
    if micro is None:
        raise RuntimeError("Microbiology department not found; refusing to backfill")

    report_runs: list[dict] = []
    for run in runs:
        analyst_name = str(run.get("analyst") or "").strip()
        analyst_id = analyst_for(db, analyst_name)
        entry = {
            "name": run.get("name"),
            "title": worksheet_title_for_run(run),
            "analyst": analyst_name,
            "analyst_user_id": analyst_id,
            "analyst_unresolved": analyst_name if analyst_name and analyst_id is None else None,
            "resolved": 0,
            "unresolved": [],
            "existing": 0,
            "new": 0,
            "status": None,
            "worksheet_id": None,
        }
        placed: list[tuple[LimsSubSample, Optional[LimsSample], dict]] = []
        for row in run.get("rows") or []:
            sid = str(row.get("c") or "").strip()
            if not sid and not (row.get("d") or row.get("b")):
                continue  # an entirely blank row in the log
            sub, _how = resolve_vial(db, sid)
            if sub is None:
                entry["unresolved"].append(sid or "(blank)")
                continue
            entry["resolved"] += 1
            parent = db.get(LimsSample, sub.parent_sample_pk)
            overrides = prep_overrides_for_row(row, parent, sub.sample_id)
            existing = _existing_item(db, sub.external_lims_uid)
            if existing is not None:
                entry["existing"] += 1
                if apply:
                    for key, value in overrides.items():
                        if value is not None and getattr(existing, key) is None:
                            setattr(existing, key, value)
                continue
            placed.append((sub, parent, overrides))

        entry["new"] = len(placed)
        if placed:
            live = [r for sub, _, _ in placed for r in _endo_rows(db, sub)]
            done = all(r.review_state in _PAST_SUBMISSION for r in live)
            entry["status"] = "completed" if done else "open"
            if apply:
                made = run_datetime(run)
                ws = Worksheet(
                    title=entry["title"],
                    status=entry["status"],
                    assigned_analyst_id=analyst_id,
                    created_at=made,
                    updated_at=made,
                    completed_at=(made + timedelta(hours=2)) if done else None,
                    notes=json.dumps({
                        "text": (
                            f"Backfilled from Dennis's endotoxin log run {run.get('name')} "
                            f"on {today.isoformat()}. Prep figures as pipetted at the bench; "
                            f"analyst from the log."
                        )
                    }),
                )
                db.add(ws)
                db.flush()
                entry["worksheet_id"] = ws.id
                priorities = _effective_priorities(db, [s.external_lims_uid for s, _, _ in placed])
                for order, (sub, parent, overrides) in enumerate(placed):
                    analyses = [
                        {"title": a.title, "keyword": a.keyword, "peptide_name": None, "method": None}
                        for a in _endo_rows(db, sub)
                    ]
                    item = WorksheetItem(
                        worksheet_id=ws.id,
                        sample_uid=sub.external_lims_uid,
                        sample_id=sub.sample_id,
                        department_id=micro.id,
                        assigned_analyst_id=analyst_id,
                        priority=priorities.get(sub.external_lims_uid, "normal"),
                        date_received=parent.date_received if parent is not None else None,
                        analyses_json=json.dumps(analyses) if analyses else None,
                        sort_order=order,
                        added_at=made,
                        **overrides,
                    )
                    db.add(item)
                    db.flush()
                    stamp_for_item(
                        db,
                        sample_uid=sub.external_lims_uid,
                        service_group_id=None,
                        department_id=micro.id,
                        analyst_user_id=analyst_id,
                        acting_user_id=None,
                        worksheet_id=ws.id,
                        worksheet_title=ws.title,
                    )
        report_runs.append(entry)

    if apply:
        db.commit()
    return {
        "runs": report_runs,
        "applied": apply,
        "resolved": sum(r["resolved"] for r in report_runs),
        "unresolved": sum(len(r["unresolved"]) for r in report_runs),
        "existing": sum(r["existing"] for r in report_runs),
        "new": sum(r["new"] for r in report_runs),
        "worksheets_created": sum(1 for r in report_runs if r["new"]),
    }


def main(argv: Optional[list[str]] = None) -> int:
    # __doc__ is None when the script is piped through `python -` (the prod recipe).
    ap = argparse.ArgumentParser(description=(__doc__ or "Backfill endotoxin worksheets").splitlines()[0])
    ap.add_argument("path", help="endotoxin-data.json from tools-dennis/tools/endotoxin-log")
    ap.add_argument("--apply", action="store_true",
                    help="write the worksheets; without it this is a dry-run report")
    args = ap.parse_args(argv)
    from database import SessionLocal

    runs = load_runs(args.path)
    db = SessionLocal()
    try:
        report = run_backfill(db, runs, apply=args.apply, today=date.today())
    finally:
        db.close()
    for r in report["runs"]:
        who = r["analyst"] or "-"
        if r["analyst_unresolved"]:
            who += " (NO MATCHING USER)"
        print(
            f"  {r['name']:<12} {r['title']:<24} analyst={who:<26} resolved={r['resolved']:<3} "
            f"existing={r['existing']:<3} new={r['new']:<3} status={r['status'] or '-':<9} "
            f"ws={r['worksheet_id'] or '-'}"
        )
        if r["unresolved"]:
            print(f"               unresolved: {', '.join(r['unresolved'])}")
    print(
        f"runs={len(report['runs'])} resolved={report['resolved']} unresolved={report['unresolved']} "
        f"existing={report['existing']} new={report['new']} worksheets={report['worksheets_created']}"
    )
    print("APPLIED" if report["applied"] else "DRY RUN -- nothing written (re-run with --apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
