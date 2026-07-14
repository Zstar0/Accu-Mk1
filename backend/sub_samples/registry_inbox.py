"""Registry-sourced candidates for /worksheets/inbox (read-source 'mk1').

Replaces BOTH SENAITE fetch stages of the inbox endpoint — the 200-AR
`complete=yes` candidate query (Step 1) and the per-sample Analysis-catalog
fetches (Step 6) — with two local queries against the lims_ registry. The
emitted dict shapes mirror the SENAITE brain keys the endpoint's downstream
steps consume, so steps 2-7 run unchanged regardless of source.

Follows the read-source pattern of sub_samples/registry_read.py /
registry_list.py (PR #52): local rows in, senaite-shaped dicts out.
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import HplcMethod, LimsAnalysis, LimsSample


def _analyte_slot_fields(analytes_json: str | None) -> dict[str, str]:
    """Registry `analytes` JSON → SENAITE Analyte{N}Peptide keys. The stored
    names carry the same '{Peptide} - Identity (HPLC)' service-title shape
    SENAITE holds, so the endpoint's existing suffix-strip regex applies
    identically."""
    if not analytes_json:
        return {}
    try:
        parsed = json.loads(analytes_json)
    except (ValueError, TypeError):
        return {}
    if not isinstance(parsed, list):
        return {}
    out: dict[str, str] = {}
    for slot, entry in enumerate(parsed[:4], start=1):
        name = (entry or {}).get("name") if isinstance(entry, dict) else None
        if name:
            out[f"Analyte{slot}Peptide"] = str(name)
    return out


def inbox_candidates_from_registry(
    db: Session, *, limit: int = 200
) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """Return (items, analyses_by_sample) for read-source 'mk1'.

    items: senaite-brain-shaped dicts for every registry parent currently in
    'sample_received' (the same review_state filter + created-desc ordering +
    limit as the SENAITE query it replaces).

    analyses_by_sample: sample_id -> analysis-brain-shaped dicts from the
    parent-scope lims_analyses rows. Mirror rows (review_state
    'senaite_mirror') emit their mirror_review_state — the SENAITE-side truth
    the endpoint's state filters expect.
    """
    rows = db.execute(
        select(LimsSample)
        .where(LimsSample.status == "sample_received")
        .order_by(
            LimsSample.date_created.desc().nulls_last(), LimsSample.id.desc()
        )
        .limit(limit)
    ).scalars().all()

    items: list[dict[str, Any]] = []
    for r in rows:
        item: dict[str, Any] = {
            "uid": r.external_lims_uid or "",
            "id": r.sample_id,
            "title": r.sample_id,
            "review_state": r.status,
            "getClientTitle": r.client_title,
            "ClientID": r.client_title,
            "getClientOrderNumber": r.client_order_number,
            "ClientOrderNumber": r.client_order_number,
        }
        if r.date_received is not None:
            iso = r.date_received.isoformat()
            item["getDateReceived"] = iso
            item["DateReceived"] = iso
        item.update(_analyte_slot_fields(r.analytes))
        items.append(item)

    analyses_by_sample: dict[str, list[dict[str, Any]]] = {
        r.sample_id: [] for r in rows
    }
    if rows:
        pk_to_sample_id = {r.id: r.sample_id for r in rows}
        a_rows = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sample_pk.in_(list(pk_to_sample_id)),
                LimsAnalysis.lims_sub_sample_pk.is_(None),
            )
        ).scalars().all()
        method_ids = {a.method_id for a in a_rows if a.method_id}
        method_names: dict[int, str] = {}
        if method_ids:
            method_names = {
                m.id: getattr(m, "name", None) or ""
                for m in db.execute(
                    select(HplcMethod).where(HplcMethod.id.in_(method_ids))
                ).scalars()
            }
        for a in a_rows:
            state = a.mirror_review_state or a.review_state
            entry: dict[str, Any] = {
                "uid": f"mk1-analysis://{a.id}",
                "UID": f"mk1-analysis://{a.id}",
                "title": a.title or a.keyword or "",
                "getTitle": a.title or a.keyword or "",
                "keyword": a.keyword,
                "getKeyword": a.keyword,
                "review_state": state,
                "getReviewState": state,
                # Truthiness is all the dedup checks — prefer-retest rule.
                "RetestOf": a.retest_of_id,
                "getRetestOf": a.retest_of_id,
            }
            mname = method_names.get(a.method_id) if a.method_id else None
            if mname:
                entry["Method"] = {"title": mname}
                entry["getMethodTitle"] = mname
            sid = pk_to_sample_id.get(a.lims_sample_pk)
            if sid is not None:
                analyses_by_sample[sid].append(entry)

    return items, analyses_by_sample
