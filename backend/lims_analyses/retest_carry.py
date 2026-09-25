"""Native retest: spec parsing, validation, carried-result minting.

Spec: docs/superpowers/specs/2026-09-23-mk1-native-retest-design.md.

A retest sample is a NEW sample. Profiles in `retest` (and `add`) are its
demand; profiles in `carry` are minted as verified parent rows that link,
through lims_analysis_promotions(contribution_kind='carried'), to the
ORIGINAL vial's analysis. No sub-sample rows are created for carried work.
Nothing here commits; callers own the transaction.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.service import BadRequestError
from models import AnalysisProfile, LimsAnalysis, LimsSample

logger = logging.getLogger(__name__)

CARRIED = "carried"
HPLC_PROFILE_KEY = "hplcpurity_identity"
_CARRY_SOURCE_STATES = ("verified", "published")
_FEES = ("paid", "free")


@dataclass(frozen=True)
class RetestSpec:
    retest_of_sample_id: str
    retest: tuple[str, ...]
    carry: tuple[str, ...]
    add_profiles: tuple[str, ...]
    variance_points: int
    additional_vials: int
    auto_checkin: bool
    fee: str
    reason: str
    requested_by_user_id: Optional[int]
    requested_at: Optional[str]

    @property
    def demand_keys(self) -> tuple[str, ...]:
        """Profiles the NEW sample must seed vials/placeholders for."""
        return tuple(dict.fromkeys(self.retest + self.add_profiles))

    def as_dict(self) -> dict:
        return {
            "retest_of_sample_id": self.retest_of_sample_id,
            "retest": list(self.retest),
            "carry": list(self.carry),
            "add": {"profiles": list(self.add_profiles),
                    "variance_points": self.variance_points,
                    "additional_vials": self.additional_vials},
            "auto_checkin": self.auto_checkin,
            "fee": self.fee,
            "reason": self.reason,
            "requested_by_user_id": self.requested_by_user_id,
            "requested_at": self.requested_at,
        }


def _keys(value, field: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)) or not all(isinstance(k, str) and k for k in value):
        raise BadRequestError(f"retest_spec.{field} must be a list of profile keys")
    return tuple(dict.fromkeys(value))


def parse_retest_spec(raw: dict) -> RetestSpec:
    """Shape + intra-spec rules. Anything needing the DB is validate_retest_spec."""
    if not isinstance(raw, dict):
        raise BadRequestError("retest_spec must be an object")
    original_id = str(raw.get("retest_of_sample_id") or "").strip()
    if not original_id:
        raise BadRequestError("retest_spec.retest_of_sample_id is required")
    retest = _keys(raw.get("retest"), "retest")
    carry = _keys(raw.get("carry"), "carry")
    add = raw.get("add") or {}
    if not isinstance(add, dict):
        raise BadRequestError("retest_spec.add must be an object")
    add_profiles = _keys(add.get("profiles"), "add.profiles")
    try:
        variance_points = int(add.get("variance_points") or 0)
        additional_vials = int(add.get("additional_vials") or 0)
    except (TypeError, ValueError):
        raise BadRequestError("retest_spec.add counts must be integers")
    fee = str(raw.get("fee") or "").strip().lower()
    reason = str(raw.get("reason") or "").strip()

    overlap = set(retest) & set(carry)
    if overlap:
        raise BadRequestError(f"profiles cannot be both retested and carried: {sorted(overlap)}")
    overlap = set(add_profiles) & (set(retest) | set(carry))
    if overlap:
        raise BadRequestError(f"added profiles cannot also be retested or carried: {sorted(overlap)}")
    if not retest and not add_profiles and variance_points == 0:
        raise BadRequestError("retest_spec must retest or add at least one service")
    if variance_points not in (0, *range(2, 11)):
        raise BadRequestError("retest_spec.add.variance_points must be 0 or 2..10")
    if variance_points > 0 and HPLC_PROFILE_KEY not in retest:
        raise BadRequestError("variance requires hplcpurity_identity in the retest set")
    if additional_vials < 0 or additional_vials > 20:
        raise BadRequestError("retest_spec.add.additional_vials must be 0..20")
    if fee not in _FEES:
        raise BadRequestError("retest_spec.fee must be 'paid' or 'free'")
    if not reason:
        raise BadRequestError("retest_spec.reason is required")

    return RetestSpec(
        retest_of_sample_id=original_id, retest=retest, carry=carry,
        add_profiles=add_profiles, variance_points=variance_points,
        additional_vials=additional_vials,
        auto_checkin=bool(raw.get("auto_checkin")), fee=fee, reason=reason,
        requested_by_user_id=raw.get("requested_by_user_id"),
        requested_at=raw.get("requested_at"),
    )


def snapshot_profile_keys(sample: LimsSample) -> list[str]:
    snap = sample.catalog_snapshot or {}
    return [p.get("key") for p in (snap.get("profiles") or []) if p.get("key")]


def _live_carry_rows(db: Session, original: LimsSample, service_ids: set[int]) -> list[LimsAnalysis]:
    """Parent-tier canonical rows on the original that a carry may copy."""
    if not service_ids:
        return []
    return list(db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == original.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.provenance == "canonical",
        LimsAnalysis.retested.is_(False),
        LimsAnalysis.review_state.in_(_CARRY_SOURCE_STATES),
        LimsAnalysis.analysis_service_id.in_(service_ids),
    )).scalars().all())


def _profiles_by_key(db: Session, keys) -> dict[str, AnalysisProfile]:
    if not keys:
        return {}
    rows = db.execute(select(AnalysisProfile).where(AnalysisProfile.key.in_(list(keys)))).scalars().all()
    return {p.key: p for p in rows}


def carry_eligible_profile_keys(db: Session, original: LimsSample) -> set[str]:
    """Snapshot profiles on the original with at least one verified/published
    parent-tier canonical row for one of their services."""
    profiles = _profiles_by_key(db, snapshot_profile_keys(original))
    out: set[str] = set()
    for key, prof in profiles.items():
        svc_ids = {svc.id for svc in prof.analysis_services}
        if _live_carry_rows(db, original, svc_ids):
            out.add(key)
    return out


def validate_retest_spec(db: Session, *, original: LimsSample, spec: RetestSpec) -> list[str]:
    """Raise BadRequestError on any hard rule; return the retest/carry keys the
    original's snapshot does not have (soft: caller mints without them and warns)."""
    if spec.retest_of_sample_id != original.sample_id:
        raise BadRequestError(
            f"retest_spec is for {spec.retest_of_sample_id!r}, not {original.sample_id!r}")
    have = set(snapshot_profile_keys(original))
    clash = set(spec.add_profiles) & have
    if clash:
        raise BadRequestError(f"already on the original, cannot be added: {sorted(clash)}")
    known = _profiles_by_key(db, spec.add_profiles)
    unknown = [k for k in spec.add_profiles if k not in known]
    if unknown:
        raise BadRequestError(f"unknown profile(s): {unknown}")
    eligible = carry_eligible_profile_keys(db, original)
    not_eligible = [k for k in spec.carry if k in have and k not in eligible]
    if not_eligible:
        raise BadRequestError(
            f"cannot carry unverified profile(s): {not_eligible}; retest them instead")
    return [k for k in (*spec.retest, *spec.carry) if k not in have]
