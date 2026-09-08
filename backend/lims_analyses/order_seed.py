"""Seed native parent-tier placeholders from a services dict, whoever hands
it to us (order upsert, registration signal, heal script), plus the finder
the heal script uses.

Why this exists (2026-09-08): the registration-time background task used to
ask IS for the sample's services and IS answered 404 until it committed the
whole order — so every sample but the last in a multi-sample order silently
got no placeholders (prod P-2687/P-2688/P-2689 vs P-2690). The order upsert
now carries the services, and every caller funnels through here.
"""
from __future__ import annotations

import logging
from typing import List, Optional, Set, Tuple

from sqlalchemy import select

from catalog.snapshot import compute_catalog_snapshot
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample

logger = logging.getLogger(__name__)

_DEAD_STATES = ("rejected", "retracted")


def seed_parent_from_services(db, *, parent: LimsSample, services: Optional[dict],
                              package, source: str) -> dict:
    """Mint pending parent-tier rows for the parent's ordered native services
    and stamp the once-only catalog snapshot. Does NOT commit — the caller
    owns the transaction.

    `source` is a log tag only ("order_upsert" / "registration_signal" /
    "heal") so the three callers stay distinguishable in prod logs.
    """
    from sub_samples.service import _apply_variance_override  # local: avoids the import cycle

    raw = _apply_variance_override(
        parent.sample_id, {"services": dict(services or {}), "package": package}
    ) or {}
    services = raw.get("services") or {}
    package = raw.get("package")
    stats = seed_parent_placeholders(db, parent=parent, services=services, package=package)
    # Once-only: freeze what was resolved the FIRST time. Isolated so a
    # snapshot failure never undoes the seed above (bench visibility is the
    # load-bearing guarantee); catalog_snapshot stays NULL and the next
    # caller retries.
    if parent.catalog_snapshot is None:
        try:
            parent.catalog_snapshot = compute_catalog_snapshot(db, services, package)
        except Exception as snapshot_err:  # noqa: BLE001
            logger.warning("catalog_snapshot.stamp_failed source=%s sample_id=%s err=%s",
                           source, parent.sample_id, snapshot_err)
    logger.info(
        "registry.native_placeholder_seed source=%s sample_id=%s created=%s existing=%s skipped=%s",
        source, parent.sample_id, stats["created"], stats["existing"], stats["skipped"],
    )
    return stats


def find_parents_missing_native_placeholders(db) -> List[Tuple[LimsSample, Set[int]]]:
    """Parents whose LIVE native (origin='mk1') vial-tier rows reference a
    service with no parent-tier row (live canonical or any 'ordered').
    Read-only. Returns [(parent, missing_service_ids)]."""
    mk1_ids: Set[int] = set(db.execute(
        select(AnalysisService.id).where(AnalysisService.origin == "mk1")
    ).scalars().all())
    if not mk1_ids:
        return []
    out: List[Tuple[LimsSample, Set[int]]] = []
    for parent in db.execute(select(LimsSample).order_by(LimsSample.id)).scalars().all():
        sub_ids = list(db.execute(
            select(LimsSubSample.id).where(LimsSubSample.parent_sample_pk == parent.id)
        ).scalars().all())
        if not sub_ids:
            continue
        vial_rows = db.execute(select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk.in_(sub_ids),
            LimsAnalysis.analysis_service_id.in_(mk1_ids),
        )).scalars().all()
        wanted = {r.analysis_service_id for r in vial_rows if r.review_state not in _DEAD_STATES}
        if not wanted:
            continue
        parent_rows = db.execute(select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
        )).scalars().all()
        have = {
            r.analysis_service_id for r in parent_rows
            if r.provenance == PROVENANCE_ORDERED
            or (r.provenance == "canonical" and r.review_state not in _DEAD_STATES)
        }
        missing = wanted - have
        if missing:
            out.append((parent, missing))
    return out
