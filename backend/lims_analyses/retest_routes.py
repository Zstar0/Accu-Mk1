"""Native retest HTTP surface (spec 2026-09-23, sections 4.1 and 5).

GET  /api/samples/{id}/retest-options  what the overlay renders
POST /api/samples/{id}/retest          validate + forward to IS (Task 9)
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import requests
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from lims_analyses.retest_carry import (HPLC_PROFILE_KEY, carry_eligible_profile_keys,
                                        snapshot_profile_keys)
from models import AnalysisProfile, LimsAnalysis, LimsSample

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/samples", tags=["retest"])

WP_ADDON_TYPE_BY_PROFILE = {
    "endotoxin-usp85-lal": "endotoxin",
    "rapid-sterility-pcr": "sterility_pcr",
    "heavy_metals": "heavy_metals",
}


def _is_base_and_key() -> tuple[str, str]:
    base = os.environ.get("INTEGRATION_SERVICE_URL", "").rstrip("/")
    key = os.environ.get("ACCU_MK1_API_KEY") or os.environ.get("INTEGRATION_SERVICE_API_KEY") or ""
    return base, key


def _fetch_addon_prices() -> Optional[dict]:
    """IS proxies WP's add-on product prices. None when unreachable: the
    overlay still renders, with prices blank."""
    base, key = _is_base_and_key()
    if not base or not key:
        return None
    try:
        resp = requests.get(f"{base}/api/service/addon-prices", headers={"X-API-Key": key}, timeout=10)
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("retest_options.prices_unavailable err=%s", e)
        return None


def _best_state(db: Session, sample: LimsSample, service_ids: set[int]) -> Optional[str]:
    if not service_ids:
        return None
    rank = {"published": 3, "verified": 2, "parent_to_verify": 1}
    rows = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == sample.id, LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.provenance == "canonical", LimsAnalysis.retested.is_(False),
        LimsAnalysis.analysis_service_id.in_(service_ids),
    )).scalars().all()
    best = None
    for r in rows:
        if r.review_state in ("retracted", "rejected"):
            continue
        if best is None or rank.get(r.review_state, 0) > rank.get(best, 0):
            best = r.review_state
    return best


@router.get("/{sample_id}/retest-options")
def retest_options(sample_id: str, db: Session = Depends(get_db), _user=Depends(get_current_user)):
    sample = db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)).scalar_one_or_none()
    if sample is None:
        raise HTTPException(status_code=404, detail=f"sample {sample_id!r} not known to Mk1")
    have = snapshot_profile_keys(sample)
    profiles = {p.key: p for p in db.execute(
        select(AnalysisProfile).where(AnalysisProfile.key.in_(have))).scalars().all()} if have else {}
    eligible = carry_eligible_profile_keys(db, sample)
    out_profiles = []
    for key in have:
        prof = profiles.get(key)
        svc_ids = {s.id for s in prof.analysis_services} if prof else set()
        out_profiles.append({
            "key": key, "name": prof.name if prof else key,
            "carry_eligible": key in eligible,
            "state": _best_state(db, sample, svc_ids),
        })
    prices = _fetch_addon_prices()
    price_map = (prices or {}).get("addons") or {}
    addons = []
    for prof in db.execute(select(AnalysisProfile).where(
            AnalysisProfile.is_addon.is_(True), AnalysisProfile.active.is_(True)
    ).order_by(AnalysisProfile.sort_order, AnalysisProfile.key)).scalars().all():
        if prof.key in have:
            continue
        wp_type = WP_ADDON_TYPE_BY_PROFILE.get(prof.key)
        priced = price_map.get(wp_type) if wp_type else None
        addons.append({
            "key": prof.key, "name": prof.name, "wp_type": wp_type,
            "price": (priced or {}).get("price"),
            "vials": (priced or {}).get("vials", prof.vials_required),
        })
    return {
        "sample_id": sample.sample_id, "status": sample.status,
        "order_number": sample.client_order_number,
        "profiles": out_profiles, "addons": addons,
        "variance": {"point_price": ((prices or {}).get("variance") or {}).get("point_price"),
                     "allowed": HPLC_PROFILE_KEY in have},
        "prices_available": prices is not None,
    }
