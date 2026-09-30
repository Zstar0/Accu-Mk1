"""Native retest HTTP surface (spec 2026-09-23, sections 4.1 and 5).

GET  /api/samples/{id}/retest-options  what the overlay renders
POST /api/samples/{id}/retest          validate + forward to IS (Task 9)
POST /api/samples/{id}/addon-order     same-sample add-on (spec 2026-09-29-addon-same-sample)
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Literal

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
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
        "original_published": sample.status == "published",
        "order_number": sample.client_order_number,
        "profiles": out_profiles, "addons": addons,
        "variance": {"point_price": ((context or {}).get("variance") or {}).get("point_price"),
                     "allowed": bool(HPLC_PROFILE_KEYS & set(have))},
        "prices_available": context is not None,
        "context": {"order": context.get("order"), "retest_fee": context.get("retest_fee"),
                    "pending_orders": _list_or_empty(context.get("pending_retest_orders")),
                    "orders": _orders_with_samples(db, sample, context.get("retest_orders"))}
                   if context is not None else None,
    }


def _orders_with_samples(db: Session, sample: LimsSample, orders) -> list[dict]:
    """WP `retest_orders`, each joined to the Mk1 retest sample minted from it
    (same forward query as retest-info's `retested_as`): sample_id and
    sample_status are None until the order is paid and the sample exists."""
    orders = [o for o in _list_or_empty(orders) if isinstance(o, dict)]
    forward = db.execute(select(LimsSample).where(
        LimsSample.retest_of_sample_id == sample.sample_id).order_by(LimsSample.id)).scalars().all()
    by_order = {f.client_order_number: f for f in forward if f.client_order_number}
    same_sample = {str(a.get("order_id")): a for a in _addon_orders(sample)}
    out = []
    for o in orders:
        hit = by_order.get(f"WP-{o.get('order_id')}")
        row = {**o, "sample_id": hit.sample_id if hit else None,
               "sample_status": hit.status if hit else None}
        addon = same_sample.get(str(o.get("order_id")))
        if addon is not None:
            row.update(same_sample=True, applied=bool(addon.get("applied")))
        out.append(row)
    return out


def _addon_orders(sample: LimsSample) -> list[dict]:
    return [a for a in _list_or_empty((sample.catalog_snapshot or {}).get("addon_orders"))
            if isinstance(a, dict)]


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


# Same-sample add-on (spec 2026-09-29-addon-same-sample)

class AddonOrderRequest(BaseModel):
    profiles: list[str] = []
    variance_points: int = Field(0, ge=0)
    additional_vials: int = Field(0, ge=0)
    fee: Literal["paid", "free"] = "paid"
    reason: str = Field(min_length=1)


def _profile_names(db: Session, keys) -> list[str]:
    by_key = {p.key: p.name for p in db.execute(
        select(AnalysisProfile).where(AnalysisProfile.key.in_(list(keys)))).scalars()} if keys else {}
    return [by_key.get(k) or k for k in keys]


def _validate_addon_profiles(db: Session, sample: LimsSample, keys: list[str]) -> None:
    from lims_analyses.manage_native import _is_all_native, _live_parent_service_ids
    have = set(snapshot_profile_keys(sample))
    live = _live_parent_service_ids(db, sample) if keys else set()
    for key in keys:
        prof = db.execute(select(AnalysisProfile).where(AnalysisProfile.key == key)).scalar_one_or_none()
        if prof is None:
            raise HTTPException(status_code=400, detail=f"unknown profile {key!r}")
        if not prof.active:
            raise HTTPException(status_code=400, detail=f"profile {key!r} is inactive")
        if key in LEGACY_ADDON_EXCLUDE or not _is_all_native(prof):
            raise HTTPException(status_code=400, detail=f"profile {key!r} is not a native profile")
        # Same predicate add_profile_to_parent uses: every member has a live parent row.
        if key in have or all(m.id in live for m in prof.analysis_services):
            raise HTTPException(status_code=400, detail=f"profile {key!r} is already on {sample.sample_id}")


@router.post("/{sample_id}/addon-order")
def create_addon_order(sample_id: str, req: AddonOrderRequest, db: Session = Depends(get_db),  # noqa: B008
                       user=Depends(get_current_user)):  # noqa: B008
    """In-progress original: a WP add-on order against the ORIGINAL order; the
    services land on this same sample once it is paid or waived (IS then calls
    /s2s/lims-samples/{id}/services). A published original uses the retest route."""
    sample = db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)).scalar_one_or_none()
    if sample is None:
        raise HTTPException(status_code=404, detail=f"sample {sample_id!r} not known to Mk1")
    if sample.status == "published":
        raise HTTPException(status_code=400, detail="sample is published; use the retest route")
    profiles = list(dict.fromkeys(req.profiles))
    if req.variance_points > 0:
        raise HTTPException(status_code=400, detail="variance is sold through a retest; use the Re-test tab")
    if not profiles:
        raise HTTPException(status_code=400, detail="nothing selected")
    _validate_addon_profiles(db, sample, profiles)
    base, key = _is_base_and_key()
    if not base or not key:
        raise HTTPException(status_code=502, detail="Integration Service not configured")
    body = {**req.model_dump(), "profiles": profiles, "sample_id": sample.sample_id,
            "requested_by_user_id": getattr(user, "id", None),
            "requested_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    headers = {"X-API-Key": key, "Idempotency-Key": _addon_idempotency_key(sample.sample_id, body)}
    try:
        resp = requests.post(f"{base}/api/service/addon-orders", json=body, headers=headers, timeout=30)
    except Exception as e:  # noqa: BLE001
        logger.warning("addon_order.is_unreachable sample_id=%s err=%s", sample.sample_id, e)
        raise HTTPException(status_code=502, detail="Integration Service unreachable")
    if resp.status_code < 200 or resp.status_code >= 300:
        logger.warning("addon_order.is_error sample_id=%s status=%s body=%s",
                       sample.sample_id, resp.status_code, (resp.text or "")[:500])
        raise HTTPException(status_code=502, detail=f"Integration Service returned {resp.status_code}")
    out = resp.json()
    _record_addon_order(db, sample, out, body, user_id=getattr(user, "id", None))
    db.commit()
    return out


def _addon_idempotency_key(sample_id: str, body: dict) -> str:
    rest = {k: v for k, v in body.items() if k != "requested_at"}
    digest = hashlib.sha256(json.dumps(rest, sort_keys=True, separators=(",", ":")).encode())
    return f"addon:{sample_id}:{digest.hexdigest()[:16]}"


def _record_addon_order(db: Session, sample: LimsSample, out: dict, body: dict, *, user_id) -> None:
    """The pending add-on order on the original (Orders tab "same sample"),
    plus its activity line. Replaces an entry with the same order_id."""
    from lims_analyses.retest_carry import _event
    out = out if isinstance(out, dict) else {}
    order_id = out.get("order_id")
    entry = {"order_id": order_id, "order_number": out.get("order_number"),
             "status": out.get("status"), "requested_at": body["requested_at"],
             "profiles": body["profiles"], "fee": body["fee"]}
    kept = [a for a in _addon_orders(sample) if str(a.get("order_id")) != str(order_id)]
    sample.catalog_snapshot = {**(sample.catalog_snapshot or {}), "addon_orders": [*kept, entry]}
    what = _profile_names(db, body["profiles"])
    fee = "waived" if body["fee"] == "free" else "charged"
    label = (f"Add-on order {entry['order_number'] or order_id} requested for this sample ({fee}): "
             f"{', '.join(what)}. Reason: {body['reason']}")
    _event(db, sample, "addon_order_requested", {**entry, "reason": body["reason"], "label": label},
           user_id=user_id)


def _minimal_snapshot_entry(prof: AnalysisProfile) -> dict:
    """Builder-shaped entry from the live row (catalog.snapshot keys plus name,
    is_addon, sort_order). Tagged so a reader can tell it was not frozen at
    registration; the snapshot resolver skips entries that are not role demand."""
    return {
        "key": prof.key, "profile_id": prof.id, "name": prof.name, "is_addon": prof.is_addon,
        "sort_order": prof.sort_order, "fulfillment_role": prof.fulfillment_role,
        "fulfillment_dim": prof.fulfillment_dim, "role_sort_order": None,
        "vials_required": prof.vials_required, "analytical_vials": prof.analytical_vials,
        "service_ids": [s.id for s in prof.analysis_services], "ride_host_roles": [],
        "source": "addon_apply",
    }


def apply_addon_services(db: Session, sample: LimsSample, *, services: dict, order_id,
                         variance_value=None, event_id=None) -> dict:
    """IS -> Mk1 after a same-sample add-on order is paid or waived. Adds every
    newly-true native profile via add_profile_to_parent; profiles already on the
    sample are skipped (replay-safe); unknown/legacy keys are ignored. Caller
    commits. The published refusal lives in the route."""
    from catalog.snapshot import compute_catalog_snapshot
    from lims_analyses.manage_native import (
        ProfileAlreadyOnSampleError,
        _is_all_native,
        add_profile_to_parent,
    )
    from lims_analyses.retest_carry import _event
    have = set(snapshot_profile_keys(sample))
    added: list[AnalysisProfile] = []
    skipped: list[str] = []
    ignored: list[str] = []
    for key, on in (services or {}).items():
        if not on:
            continue
        prof = db.execute(select(AnalysisProfile).where(AnalysisProfile.key == key)).scalar_one_or_none()
        if prof is None or key in LEGACY_ADDON_EXCLUDE or not _is_all_native(prof):
            ignored.append(key)
            continue
        if key in have:
            skipped.append(key)
            continue
        try:
            add_profile_to_parent(db, parent=sample, profile=prof, user_id=None)
        except ProfileAlreadyOnSampleError:
            skipped.append(key)
            continue
        added.append(prof)
    if ignored:
        logger.info("addon_services.ignored sample_id=%s order_id=%s keys=%s",
                    sample.sample_id, order_id, ignored)

    if sample.catalog_snapshot is not None:
        snap = dict(sample.catalog_snapshot)
        # Only extend a real freeze; a dict without "profiles" is stamped later by order_seed.
        if added and "profiles" in snap:
            try:
                fresh = compute_catalog_snapshot(db, {p.key: True for p in added}, None)["profiles"]
            except Exception as e:  # noqa: BLE001
                logger.warning("addon_services.snapshot_failed sample_id=%s err=%s", sample.sample_id, e)
                fresh = []
            fresh_keys = {e["key"] for e in fresh}
            # The registration builder freezes role-dim demand only; any other
            # applied profile gets a minimal entry so snapshot_profile_keys sees it.
            fresh += [_minimal_snapshot_entry(p) for p in added if p.key not in fresh_keys]
            known = {e.get("key") for e in snap["profiles"] or []}
            snap["profiles"] = [*(snap["profiles"] or []), *(e for e in fresh if e["key"] not in known)]
        if "addon_orders" in snap:
            on_sample = have | set(skipped) | {p.key for p in added}
            # IS forwards the PARENT order id, so match entries by profile set.
            snap["addon_orders"] = [
                {**a, "applied": True}
                if not a.get("applied") and a.get("profiles") and set(a["profiles"]) <= on_sample else a
                for a in _addon_orders(sample)]
        sample.catalog_snapshot = snap

    if added:
        m = re.match(r"^addon_(\d+)_", str(event_id or ""))
        addon_no = m.group(1) if m else None
        wanted = addon_no if addon_no is not None else str(order_id)
        entry = next((a for a in _addon_orders(sample)
                      if wanted in (str(a.get("order_number")), str(a.get("order_id")))), {})
        waived = " (waived)" if entry.get("fee") == "free" else ""
        where = f"WP add-on order {addon_no}" if addon_no else f"WP order {order_id}"
        label = f"Services added from {where}: {', '.join(p.name for p in added)}{waived}"
        _event(db, sample, "addon_services_applied", {
            "order_id": order_id, "event_id": event_id, "variance_value": variance_value,
            "added": [p.key for p in added], "skipped": skipped, "ignored": ignored, "label": label})
    db.flush()
    return {"added": [p.key for p in added], "skipped": skipped, "ignored": ignored}
