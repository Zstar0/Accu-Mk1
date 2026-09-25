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


def _on_sample(db: Session, sample: LimsSample, service_id: int) -> bool:
    """Any row for the service on the sample, parent tier or any vial."""
    from models import LimsSubSample
    vial_ids = select(LimsSubSample.id).where(LimsSubSample.parent_sample_pk == sample.id)
    return db.execute(select(LimsAnalysis.id).where(
        LimsAnalysis.analysis_service_id == service_id,
        (LimsAnalysis.lims_sample_pk == sample.id) | LimsAnalysis.lims_sub_sample_pk.in_(vial_ids),
    ).limit(1)).first() is not None


def _carry_plan(db: Session, original: LimsSample, prof: AnalysisProfile):
    """(rows to copy, withdrawn mk1 members) when `prof` may be carried, else None.

    Every mk1-origin member must have a live verified/published parent row,
    or be withdrawn by the lab (coa.native_sections._withdrawn_by_lab), or
    never have been on the sample at all (no row at any tier: the blend
    aggregates on a single-analyte sample). At least one row must carry.
    A pending member blocks the carry: the retest COA would abort on Rule 4."""
    from coa.native_sections import _withdrawn_by_lab  # local: import cycle
    members = list(prof.analysis_services)
    rows = _live_carry_rows(db, original, {svc.id for svc in members})
    if not rows:
        return None
    live = {r.analysis_service_id for r in rows}
    withdrawn = []
    for svc in members:
        if (svc.origin or "") != "mk1" or svc.id in live:
            continue
        if _withdrawn_by_lab(db, original.id, svc.id):
            withdrawn.append(svc)
        elif _on_sample(db, original, svc.id):
            return None
    return rows, withdrawn


def carry_eligible_profile_keys(db: Session, original: LimsSample) -> set[str]:
    """Snapshot profiles on the original that _carry_plan accepts."""
    profiles = _profiles_by_key(db, snapshot_profile_keys(original))
    return {key for key, prof in profiles.items() if _carry_plan(db, original, prof) is not None}


def validate_retest_spec(db: Session, *, original: LimsSample, spec: RetestSpec) -> list[str]:
    """Raise BadRequestError on any hard rule; return the retest/carry keys the
    original's snapshot does not have (soft: caller mints without them and warns)."""
    if spec.retest_of_sample_id != original.sample_id:
        raise BadRequestError(
            f"retest_spec is for {spec.retest_of_sample_id!r}, not {original.sample_id!r}")
    have = set(snapshot_profile_keys(original))
    demand = set(spec.retest) | set(spec.carry)
    omitted = have - demand
    if omitted:
        raise BadRequestError(
            f"every profile on {original.sample_id} must be retested or carried; missing: {sorted(omitted)}")
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


def _ultimate_source(db: Session, row: LimsAnalysis) -> LimsAnalysis:
    """Follow promotion links from a parent row to the vial analysis that
    produced it. A 'chosen'/'aggregated_in' link points at the vial; a
    'carried' link points at the previous carry's ultimate source, so one hop
    is always enough. Legacy rows with no link are their own source."""
    from models import LimsAnalysisPromotion
    link = db.execute(select(LimsAnalysisPromotion).where(
        LimsAnalysisPromotion.parent_analysis_id == row.id
    ).order_by(LimsAnalysisPromotion.id)).scalars().first()
    if link is None:
        return row
    src = db.get(LimsAnalysis, link.source_analysis_id)
    if src is None:
        return row
    if link.contribution_kind == CARRIED:
        return src                      # already the ultimate source
    if src.lims_sub_sample_pk is None:
        return row                      # parent-hosted source: keep the parent row
    return src


def _mint_withdrawn_marker(db: Session, *, original: LimsSample, retest: LimsSample,
                           svc, user_id: Optional[int], now: datetime) -> None:
    """A rejected canonical parent row for a member the lab withdrew on the
    original, so native_sections._withdrawn_by_lab reads it as withdrawn on
    the retest too. No promotion link. Idempotent per (retest, service)."""
    from models import LimsAnalysisTransition
    exists = db.execute(select(LimsAnalysis.id).where(
        LimsAnalysis.lims_sample_pk == retest.id, LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.analysis_service_id == svc.id, LimsAnalysis.provenance == "canonical",
        LimsAnalysis.review_state == "rejected",
    ).limit(1)).first()
    if exists is not None:
        return
    row = LimsAnalysis(
        lims_sample_pk=retest.id, lims_sub_sample_pk=None, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title, result_value=None,
        review_state="rejected", provenance="canonical",
        created_by_user_id=user_id, created_at=now, updated_at=now,
    )
    db.add(row)
    db.flush()
    db.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state=None, to_state="rejected", transition_kind="auto",
        user_id=user_id, reason=f"withdrawn on {original.sample_id}", details={"changed": {}},
    ))


def carry_results(db: Session, *, original: LimsSample, retest: LimsSample,
                  profile_keys, user_id: Optional[int]) -> list[dict]:
    """Mint one verified parent row on `retest` per live verified/published
    parent row on `original` for each profile in `profile_keys`, linked
    (contribution_kind='carried') to the original vial's analysis. Idempotent
    per (retest, source). Does NOT commit."""
    from models import LimsAnalysisPromotion, LimsAnalysisTransition, LimsSubSample

    profiles = _profiles_by_key(db, profile_keys)
    already = set(db.execute(
        select(LimsAnalysisPromotion.source_analysis_id)
        .join(LimsAnalysis, LimsAnalysis.id == LimsAnalysisPromotion.parent_analysis_id)
        .where(LimsAnalysis.lims_sample_pk == retest.id,
               LimsAnalysisPromotion.contribution_kind == CARRIED)
    ).scalars().all())
    now = datetime.utcnow()
    out: list[dict] = []
    for key in profile_keys:
        prof = profiles.get(key)
        if prof is None:
            continue
        plan = _carry_plan(db, original, prof)
        if plan is None:
            continue                    # never carry a profile partially
        live_rows, withdrawn = plan
        for svc in withdrawn:
            _mint_withdrawn_marker(db, original=original, retest=retest, svc=svc,
                                   user_id=user_id, now=now)
        for src_parent in live_rows:
            source = _ultimate_source(db, src_parent)
            if source.id in already:
                continue
            row = LimsAnalysis(
                lims_sample_pk=retest.id, lims_sub_sample_pk=None,
                analysis_service_id=src_parent.analysis_service_id,
                keyword=src_parent.keyword, title=src_parent.title,
                slot=src_parent.slot, peptide_id=src_parent.peptide_id,
                result_value=src_parent.result_value, result_unit=src_parent.result_unit,
                method_id=src_parent.method_id, instrument_id=src_parent.instrument_id,
                analyst_user_id=src_parent.analyst_user_id,
                captured_at=src_parent.captured_at, submitted_at=src_parent.submitted_at,
                verified_at=src_parent.verified_at, published_at=None,
                review_state="verified", provenance="canonical",
                created_by_user_id=user_id, created_at=now, updated_at=now,
            )
            db.add(row)
            db.flush()
            db.add(LimsAnalysisPromotion(
                parent_analysis_id=row.id, source_analysis_id=source.id,
                contribution_kind=CARRIED, promoted_by_user_id=user_id, promoted_at=now,
                reason=f"carried from {original.sample_id} on retest",
            ))
            db.add(LimsAnalysisTransition(
                analysis_id=row.id, from_state=None, to_state="verified",
                transition_kind="auto", user_id=user_id,
                reason=f"carried from {original.sample_id}",
                details={"changed": {}, "carried_from": source.id},
            ))
            already.add(source.id)
            vial_id = None
            if source.lims_sub_sample_pk is not None:
                sub = db.get(LimsSubSample, source.lims_sub_sample_pk)
                vial_id = sub.sample_id if sub else None
            out.append({
                "analysis_id": row.id, "keyword": row.keyword, "title": row.title,
                "result_value": row.result_value, "result_unit": row.result_unit,
                "source_analysis_id": source.id, "source_sample_id": original.sample_id,
                "source_vial_id": vial_id, "verified_at": row.verified_at,
                "analyst_user_id": row.analyst_user_id,
            })
    db.flush()
    return out


VARIANCE_KEY = "samplevariance"


def _event(db: Session, sample: LimsSample, event: str, details: dict,
           user_id: Optional[int] = None) -> None:
    from models import LimsSubSampleEvent
    db.add(LimsSubSampleEvent(lims_sample_pk=sample.id, event=event, details=details,
                              user_id=user_id))


def _demand_services(spec: RetestSpec, services: dict) -> dict:
    keys = set(spec.demand_keys)
    demand = {k: v for k, v in (services or {}).items() if k in keys}
    for k in spec.demand_keys:
        demand.setdefault(k, True)      # an added profile may be absent from the WP dict
    if spec.variance_points > 0:
        demand[VARIANCE_KEY] = (services or {}).get(VARIANCE_KEY) or {
            "varianceMap": {HPLC_PROFILE_KEY: spec.variance_points}}
    return demand


def _demand_snapshot_profiles(db: Session, demand: dict, package, snap: dict) -> list:
    from catalog.snapshot import compute_catalog_snapshot  # call time: patchable
    try:
        return compute_catalog_snapshot(db, demand, package)["profiles"]
    except Exception as e:  # noqa: BLE001
        logger.warning("retest_spec.snapshot_failed err=%s", e)
        return snap.get("profiles") or []


def _retire_carried_placeholders(db: Session, *, parent: LimsSample, original: LimsSample,
                                 carry_keys, demand_keys, user_id: Optional[int]) -> int:
    """Soft-reject every live 'ordered' placeholder on the retest whose
    service belongs to a carried profile and to no demand profile (the
    Manage Analyses remove primitive). Returns the count."""
    from lims_analyses.service import soft_reject_parent_placeholder
    carried_ids = {s.id for p in _profiles_by_key(db, carry_keys).values() for s in p.analysis_services}
    carried_ids -= {s.id for p in _profiles_by_key(db, demand_keys).values() for s in p.analysis_services}
    if not carried_ids:
        return 0
    rows = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == parent.id, LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.provenance == "ordered",
        LimsAnalysis.review_state.notin_(("rejected", "retracted")),
        LimsAnalysis.analysis_service_id.in_(carried_ids),
    )).scalars().all()
    for row in rows:
        soft_reject_parent_placeholder(db, row, reason=f"carried from {original.sample_id}",
                                       user_id=user_id)
    return len(rows)


def apply_retest_spec(db: Session, *, parent: LimsSample, raw_spec: dict,
                      services: Optional[dict], package, source: str) -> dict:
    """Retest-aware sibling of seed_parent_from_services. Sets lineage, seeds
    only the demand profiles (retest + add), stamps the `retest` snapshot
    rider, carries the rest, writes the activity events. A bad spec or a
    missing original degrades to the plain seed with a warning event: the
    sample must never lose its placeholders over the spec. Does NOT commit."""
    from lims_analyses.order_seed import seed_parent_from_services

    def _fallback(reason: str, message: str) -> dict:
        logger.warning("retest_spec.ignored sample_id=%s reason=%s msg=%s",
                       parent.sample_id, reason, message)
        seed_parent_from_services(db, parent=parent, services=services, package=package, source=source)
        _event(db, parent, "retest_spec_warning",
               {"reason": reason, "message": message, "spec": raw_spec})
        return {"applied": False, "carried": 0, "missing": [], "demand_keys": []}

    try:
        spec = parse_retest_spec(raw_spec)
    except BadRequestError as e:
        return _fallback("invalid_spec", str(e))
    original = db.execute(select(LimsSample).where(
        LimsSample.sample_id == spec.retest_of_sample_id)).scalar_one_or_none()
    if original is None:
        return _fallback("original_missing", f"{spec.retest_of_sample_id} not in Mk1")
    try:
        missing = validate_retest_spec(db, original=original, spec=spec)
    except BadRequestError as e:
        return _fallback("invalid_spec", str(e))

    first_time = "retest" not in (parent.catalog_snapshot or {})
    user_id = spec.requested_by_user_id

    parent.is_retest = True
    parent.retest_of_sample_id = original.sample_id
    demand = _demand_services(spec, services or {})
    seed_parent_from_services(db, parent=parent, services=demand, package=package, source=source)
    snap = dict(parent.catalog_snapshot or {})
    if first_time:
        # The registration fallback may have seeded + stamped the FULL
        # services dict before this ran (C2): freeze the demand profiles only.
        snap["profiles"] = _demand_snapshot_profiles(db, demand, package, snap)
    snap["retest"] = {**spec.as_dict(), "missing": missing}
    parent.catalog_snapshot = snap

    carry_keys = [k for k in spec.carry if k not in missing]
    if first_time:
        _retire_carried_placeholders(db, parent=parent, original=original,
                                     carry_keys=carry_keys, demand_keys=spec.demand_keys,
                                     user_id=user_id)

    carried = carry_results(db, original=original, retest=parent, profile_keys=carry_keys,
                            user_id=user_id)
    for c in carried:
        _event(db, parent, "analysis_carried",
               {**c, "verified_at": c["verified_at"].isoformat() if c["verified_at"] else None},
               user_id)

    if first_time:
        _event(db, parent, "retest_created", {
            "original": original.sample_id, "fee": spec.fee, "auto_checkin": spec.auto_checkin,
            "reason": spec.reason, "requested_by_user_id": user_id,
            "retest": list(spec.retest), "carry": carry_keys, "add": list(spec.add_profiles),
            "variance_points": spec.variance_points, "additional_vials": spec.additional_vials,
        }, user_id)
        _event(db, original, "retested_as", {
            "sample_id": parent.sample_id, "retest": list(spec.retest),
            "carry": carry_keys, "add": list(spec.add_profiles),
        }, user_id)
        if missing:
            _event(db, parent, "retest_spec_warning",
                   {"reason": "profiles_missing_on_original", "missing": missing}, user_id)
    db.flush()
    return {"applied": True, "carried": len(carried), "missing": missing,
            "demand_keys": list(spec.demand_keys)}
