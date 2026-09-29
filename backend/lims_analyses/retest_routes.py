"""Native retest HTTP surface (spec 2026-09-23, sections 4.1 and 5).

GET  /api/samples/{id}/retest-options  what the overlay renders
POST /api/samples/{id}/retest          validate + forward to IS (Task 9)
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from lims_analyses.retest_carry import (
    HPLC_PROFILE_KEYS,
    carry_eligible_profile_keys,
    parse_retest_spec,
    snapshot_profile_keys,
    validate_retest_spec,
)
from lims_analyses.service import BadRequestError
from models import AnalysisProfile, LimsAnalysis, LimsSample

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/samples", tags=["retest"])

# Catalog rows that are aliases of a native profile or are sold through another control
# (variance = points on the Re-test tab). Never offered as add-ons.
LEGACY_ADDON_EXCLUDE = frozenset({"hplcpurity_identity", "endotoxin", "sterility_pcr", "variance"})

WP_ADDON_TYPE_BY_PROFILE = {
    "endotoxin-usp85-lal": "endotoxin",
    "rapid-sterility-pcr": "sterility_pcr",
    "heavy_metals": "heavy_metals",
}


def _is_base_and_key() -> tuple[str, str]:
    base = os.environ.get("INTEGRATION_SERVICE_URL", "").rstrip("/")
    key = os.environ.get("ACCU_MK1_API_KEY") or os.environ.get("INTEGRATION_SERVICE_API_KEY") or ""
    return base, key


def _list_or_empty(v):
    """WP sends a list; anything else (missing, null, a stray dict) must not reach the dialog."""
    return v if isinstance(v, list) else []


def _fetch_retest_context(sample_id: str) -> dict | None:
    """IS resolves the sample's WP order, retest fee, add-on prices and the
    variance point price. None when unreachable, or 404 (sample is in no
    WP order): the overlay still renders, with prices and the order block
    blank."""
    base, key = _is_base_and_key()
    if not base or not key:
        return None
    try:
        resp = requests.get(f"{base}/api/service/retest-context",
                           params={"sample_id": sample_id},
                           headers={"X-API-Key": key}, timeout=10)
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("retest_options.context_unavailable sample_id=%s err=%s", sample_id, e)
        return None


def _best_state(db: Session, sample: LimsSample, service_ids: set[int]) -> str | None:
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


def _latest_verified_at(db: Session, sample: LimsSample, service_ids: set[int]):
    """Latest verification time of a verified/published parent row for these
    services, whatever field carries it (verified_at, else published_at)."""
    if not service_ids:
        return None
    rows = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == sample.id, LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.provenance == "canonical", LimsAnalysis.retested.is_(False),
        LimsAnalysis.analysis_service_id.in_(service_ids),
        LimsAnalysis.review_state.in_(("verified", "published")),
    )).scalars().all()
    times = [r.verified_at or r.published_at for r in rows if (r.verified_at or r.published_at)]
    return max(times) if times else None


def _state_label(state: str | None, verified_at) -> str:
    if verified_at:
        return f"Verified {verified_at.month}/{verified_at.day}"
    if state == "parent_to_verify":
        return "Pending"
    return "Not verified"


@router.get("/{sample_id}/retest-options")
def retest_options(sample_id: str, db: Session = Depends(get_db), _user=Depends(get_current_user)):  # noqa: B008
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
        state = _best_state(db, sample, svc_ids)
        verified_at = _latest_verified_at(db, sample, svc_ids)
        out_profiles.append({
            "key": key, "name": prof.name if prof else key,
            "carry_eligible": key in eligible,
            "state": state,
            "verified_at": verified_at.isoformat() if verified_at else None,
            "state_label": _state_label(state, verified_at),
        })
    context = _fetch_retest_context(sample.sample_id)
    price_map = (context or {}).get("addons") or {}
    candidates = []
    for prof in db.execute(select(AnalysisProfile).where(
            AnalysisProfile.active.is_(True)
    ).order_by(AnalysisProfile.sort_order, AnalysisProfile.key)).scalars().all():
        if prof.key in have or prof.key in LEGACY_ADDON_EXCLUDE:
            continue
        wp_type = WP_ADDON_TYPE_BY_PROFILE.get(prof.key)
        # WordPress keys add-on prices by its ADDON_TYPES key, which has been the
        # native LIMS key since theme 2.57.1; older themes used the short type.
        priced = price_map.get(prof.key) or (price_map.get(wp_type) if wp_type else None)
        price = (priced or {}).get("price")
        candidates.append((prof.sort_order, prof.key, {
            "key": prof.key, "name": prof.name, "wp_type": wp_type,
            "price": price, "sellable": price is not None,
            "vials": (priced or {}).get("vials", prof.vials_required),
        }))
    # Sellable (priced) add-ons first, then catalog sort_order/key.
    addons = [row for _, _, row in sorted(candidates, key=lambda c: (not c[2]["sellable"], c[0], c[1]))]
    return {
        "sample_id": sample.sample_id, "status": sample.status,
        "order_number": sample.client_order_number,
        "profiles": out_profiles, "addons": addons,
        "variance": {"point_price": ((context or {}).get("variance") or {}).get("point_price"),
                     "allowed": bool(HPLC_PROFILE_KEYS & set(have))},
        "prices_available": context is not None,
        "context": {"order": context.get("order"), "retest_fee": context.get("retest_fee"),
                    "pending_orders": _list_or_empty(context.get("pending_retest_orders"))}
                   if context is not None else None,
    }


class RetestRequest(BaseModel):
    retest: list[str] = []
    carry: list[str] = []
    drop: list[str] = []
    add: dict | None = None
    auto_checkin: bool = False
    fee: str = "paid"
    reason: str


@router.post("/{sample_id}/retest")
def create_retest(sample_id: str, req: RetestRequest, db: Session = Depends(get_db),  # noqa: B008
                  user=Depends(get_current_user)):  # noqa: B008
    sample = db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)).scalar_one_or_none()
    if sample is None:
        raise HTTPException(status_code=404, detail=f"sample {sample_id!r} not known to Mk1")
    raw = {
        **req.model_dump(),
        "retest_of_sample_id": sample.sample_id,
        "requested_by_user_id": getattr(user, "id", None),
        "requested_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    try:
        spec = parse_retest_spec(raw)
        missing = validate_retest_spec(db, original=sample, spec=spec)
    except BadRequestError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if missing:
        raise HTTPException(status_code=400, detail=f"not on {sample.sample_id}: {missing}")
    base, key = _is_base_and_key()
    if not base or not key:
        raise HTTPException(status_code=502, detail="Integration Service not configured")
    headers = {"X-API-Key": key, "Idempotency-Key": _idempotency_key(sample.sample_id, spec)}
    try:
        resp = requests.post(f"{base}/api/service/retest-orders",
                             json={"sample_id": sample.sample_id, "retest_spec": spec.as_dict()},
                             headers=headers, timeout=30)
    except Exception as e:  # noqa: BLE001
        logger.warning("retest.is_unreachable sample_id=%s err=%s", sample.sample_id, e)
        raise HTTPException(status_code=502, detail="Integration Service unreachable")
    if resp.status_code < 200 or resp.status_code >= 300:
        logger.warning("retest.is_error sample_id=%s status=%s body=%s",
                       sample.sample_id, resp.status_code, (resp.text or "")[:500])
        raise HTTPException(status_code=502,
                            detail=f"Integration Service returned {resp.status_code}")
    return resp.json()


def _idempotency_key(sample_id: str, spec) -> str:
    """Same spec (requested_at aside) -> same key, so a double-click cannot
    mint two WP orders once IS honours the header."""
    body = {k: v for k, v in spec.as_dict().items() if k != "requested_at"}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())
    return f"retest:{sample_id}:{digest.hexdigest()[:16]}"
