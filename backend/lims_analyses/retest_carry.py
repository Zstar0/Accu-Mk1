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

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from catalog.hplc_keys import LEGACY_HPLC_KEY, NATIVE_HPLC_KEY
from lims_analyses.service import BadRequestError
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample

logger = logging.getLogger(__name__)

CARRIED = "carried"
# Legacy WP key and the native-born key (catalog.hplc_keys); both are stamped in snapshots.
HPLC_PROFILE_KEYS = frozenset({"hplcpurity_identity", "hplc-purity-identity"})
_CARRY_SOURCE_STATES = ("verified", "published")
_DEAD_STATES = ("retracted", "rejected", "cancelled")
# A vial-tier row in one of these is a result on its way to the parent.
_PENDING_VIAL_STATES = ("unassigned", "assigned", "to_be_verified", "verified")
_FEES = ("paid", "free")
SHADOW_ONLY_REASON = "results only in SENAITE (never verified in Mk1)"
# Pre-flip samples whose HPLC was verified only in SENAITE (shadow rows, no
# canonical row). Off: 2026-09-30 ruled "do not fake a carry" of SENAITE-only
# results. True copies the shadow values into canonical carried rows.
CARRY_SHADOW_ONLY_HPLC = False


@dataclass(frozen=True)
class RetestSpec:
    retest_of_sample_id: str
    retest: tuple[str, ...]
    carry: tuple[str, ...]
    drop: tuple[str, ...]
    add_profiles: tuple[str, ...]
    variance_points: int
    additional_vials: int
    auto_checkin: bool
    fee: str
    reason: str
    requested_by_user_id: int | None
    requested_at: str | None

    @property
    def demand_keys(self) -> tuple[str, ...]:
        """Profiles the NEW sample must seed vials/placeholders for."""
        return tuple(dict.fromkeys(self.retest + self.add_profiles))

    def as_dict(self) -> dict:
        return {
            "retest_of_sample_id": self.retest_of_sample_id,
            "retest": list(self.retest),
            "carry": list(self.carry),
            "drop": list(self.drop),
            "add": {"profiles": list(self.add_profiles),
                    "variance_points": self.variance_points,
                    "additional_vials": self.additional_vials},
            "auto_checkin": self.auto_checkin,
            "fee": self.fee,
            "reason": self.reason,
            "requested_by_user_id": self.requested_by_user_id,
            "requested_at": self.requested_at,
        }


def _one(key: str) -> str:
    """The HPLC alias and its native twin are one profile wherever they meet."""
    return NATIVE_HPLC_KEY if key == LEGACY_HPLC_KEY else key


def _meet(a, b) -> list[str]:
    """Keys of `a` that `b` also holds, the HPLC alias and twin counting as one."""
    bs = {_one(k) for k in b}
    return sorted(k for k in a if _one(k) in bs)


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
    drop = _keys(raw.get("drop"), "drop")
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

    overlap = _meet(retest, carry)
    if overlap:
        raise BadRequestError(f"profiles cannot be both retested and carried: {overlap}")
    overlap = _meet(retest, drop)
    if overlap:
        raise BadRequestError(f"profiles cannot be both retested and dropped: {overlap}")
    overlap = _meet(carry, drop)
    if overlap:
        raise BadRequestError(f"profiles cannot be both carried and dropped: {overlap}")
    overlap = _meet(add_profiles, retest + carry)
    if overlap:
        raise BadRequestError(f"added profiles cannot also be retested or carried: {overlap}")
    if not retest and not add_profiles and variance_points == 0:
        raise BadRequestError("retest_spec must retest or add at least one service")
    if variance_points not in (0, *range(2, 11)):
        raise BadRequestError("retest_spec.add.variance_points must be 0 or 2..10")
    if variance_points > 0 and not HPLC_PROFILE_KEYS & set(retest):
        raise BadRequestError("variance requires an HPLC purity/identity profile in the retest set")
    if additional_vials < 0 or additional_vials > 20:
        raise BadRequestError("retest_spec.add.additional_vials must be 0..20")
    if fee not in _FEES:
        raise BadRequestError("retest_spec.fee must be 'paid' or 'free'")
    if not reason:
        raise BadRequestError("retest_spec.reason is required")

    return RetestSpec(
        retest_of_sample_id=original_id, retest=retest, carry=carry, drop=drop,
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


def _legacy_hplc_rows(db: Session, original: LimsSample, provenance: str) -> list[LimsAnalysis]:
    """Live parent-tier rows of `provenance` on the original on SENAITE-era
    (non-mk1) services whose keyword is the legacy HPLC family ('core' in
    lims_analyses.service.legacy_family: HPLC-PUR, PEPT-Total, ID_*, ...).
    Shadow rows are live by mirror_review_state, canonical by review_state."""
    from lims_analyses.service import legacy_family  # local: import cycle
    rows = db.execute(select(LimsAnalysis, AnalysisService.origin)
                      .outerjoin(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
                      .where(LimsAnalysis.lims_sample_pk == original.id,
                             LimsAnalysis.lims_sub_sample_pk.is_(None),
                             LimsAnalysis.provenance == provenance,
                             LimsAnalysis.retested.is_(False))).all()
    state = "mirror_review_state" if provenance == "shadow" else "review_state"
    return [r for r, origin in rows
            if (origin or "") != "mk1" and getattr(r, state) not in _DEAD_STATES
            and (legacy_family(r.keyword) or (None,))[0] == "core"]


def _rerun_pending(db: Session, original: LimsSample, have: set) -> str | None:
    """Keyword of the first retracted old-service HPLC line (no live row in
    `have`) whose re-run is still on its way: a live (retested=False), not yet
    promoted row on the SAME vial and service as a source its promotion link
    names (the vial current-row idiom). Keyword-agnostic, because a blend
    promote stores vial PUR_<X>/QTY_<X> as parent ANALYTE-{n}-PUR/QTY. A line
    whose link is gone (Replace/remove) or with nothing pending is withdrawn."""
    from sqlalchemy.orm import aliased

    from lims_analyses.service import (  # local: import cycle
        legacy_family,
        own_promotion_clause,
    )
    from models import LimsAnalysisPromotion
    dead = db.execute(select(LimsAnalysis, AnalysisService.origin)
                      .outerjoin(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
                      .where(LimsAnalysis.lims_sample_pk == original.id,
                             LimsAnalysis.lims_sub_sample_pk.is_(None),
                             LimsAnalysis.provenance == "canonical",
                             LimsAnalysis.review_state == "retracted")
                      .order_by(LimsAnalysis.keyword, LimsAnalysis.id)).all()
    src = aliased(LimsAnalysis)
    for row, origin in dead:
        if ((origin or "") == "mk1" or (legacy_family(row.keyword) or (None,))[0] != "core"
                or (row.keyword, row.slot or 0) in have):
            continue
        sources = select(LimsAnalysisPromotion.source_analysis_id).where(
            LimsAnalysisPromotion.parent_analysis_id == row.id, own_promotion_clause())
        pending = db.execute(select(LimsAnalysis.id).join(src, and_(
            src.lims_sub_sample_pk == LimsAnalysis.lims_sub_sample_pk,
            src.analysis_service_id == LimsAnalysis.analysis_service_id,
        )).where(src.id.in_(sources), LimsAnalysis.lims_sub_sample_pk.isnot(None),
                 # the source itself is not its own re-run (an admin retract of
                 # the parent leaves a still-'verified' source behind)
                 LimsAnalysis.id.notin_(sources),
                 LimsAnalysis.retested.is_(False),
                 LimsAnalysis.review_state.in_(_PENDING_VIAL_STATES)).limit(1)).first()
        if pending is not None:
            return row.keyword
    return None


def _legacy_hplc_plan(db: Session, original: LimsSample) -> tuple[list[LimsAnalysis], str | None]:
    """(old-service HPLC rows to copy, why they cannot be) for the lines the
    original reports. A line is a (keyword, slot) on a non-mk1 'core' service
    held as: a live canonical row; a live shadow row no canonical row ever
    held (canonical_ever_keys: the original's COA prints it from the shadow);
    or a retracted canonical line whose re-run is pending (_rerun_pending). Every
    line needs a live verified/published canonical row (with
    CARRY_SHADOW_ONLY_HPLC, a shadow-only line may source from its
    mirror-verified shadow). A partial set never carries."""
    from lims_analyses.service import canonical_ever_keys  # local: import cycle
    canonical = _legacy_hplc_rows(db, original, "canonical")
    if any(r.review_state not in _CARRY_SOURCE_STATES for r in canonical):
        return [], "a result is still pending"
    rows = list(canonical)
    have = {(r.keyword, r.slot or 0) for r in canonical}
    ever = canonical_ever_keys(db, original.id)
    for r in _legacy_hplc_rows(db, original, "shadow"):
        key = (r.keyword, r.slot or 0)
        if key in ever:
            continue                    # the canonical tier owns this line
        if not (CARRY_SHADOW_ONLY_HPLC and r.mirror_review_state in _CARRY_SOURCE_STATES):
            return [], (f"HPLC {r.keyword} is not verified in Mk1" if canonical else SHADOW_ONLY_REASON)
        rows.append(r)
        have.add(key)
    rerun = _rerun_pending(db, original, have)
    if rerun:
        return [], f"HPLC {rerun} is being re-run"
    return rows, None


def _twin_services(db: Session) -> list:
    """Members of the alias's native twin (inactive on prod; looked up anyway)."""
    twin = _profiles_by_key(db, [NATIVE_HPLC_KEY]).get(NATIVE_HPLC_KEY)
    return list(twin.analysis_services) if twin else []


def _members(db: Session, prof: AnalysisProfile) -> list:
    """Its members; the member-less legacy HPLC alias also takes its native
    twin's members (a pre-flip sample benched natively)."""
    members = list(prof.analysis_services)
    if prof.key == LEGACY_HPLC_KEY:
        members += [s for s in _twin_services(db) if s not in members]
    return members


def _judged(db: Session, original: LimsSample, prof: AnalysisProfile):
    """(services, legacy canonical rows) `prof` is judged by on `original`:
    _members, plus for the alias the old HPLC services' live canonical parent
    rows actually on the sample."""
    legacy = _legacy_hplc_rows(db, original, "canonical") if prof.key == LEGACY_HPLC_KEY else []
    return _members(db, prof), legacy


def judged_service_ids(db: Session, original: LimsSample, prof: AnalysisProfile) -> set[int]:
    services, legacy = _judged(db, original, prof)
    return {s.id for s in services} | {r.analysis_service_id for r in legacy}


def _carry_plan(db: Session, original: LimsSample, prof: AnalysisProfile):
    """(rows to copy, withdrawn mk1 members) when `prof` may be carried, else None.

    Every mk1-origin member must have a live verified/published parent row,
    or be withdrawn by the lab (coa.native_sections._withdrawn_by_lab), or
    never have been on the sample at all (no row at any tier: the blend
    aggregates on a single-analyte sample). At least one row must carry.
    A pending member blocks the carry: the retest COA would abort on Rule 4.
    The alias's old-service HPLC lines must be complete (_legacy_hplc_plan)."""
    from coa.native_sections import _withdrawn_by_lab  # local: import cycle
    members = _members(db, prof)
    legacy: list[LimsAnalysis] = []
    if prof.key == LEGACY_HPLC_KEY:
        legacy, why = _legacy_hplc_plan(db, original)
        if why:
            return None
    rows = _live_carry_rows(db, original, {svc.id for svc in members}) + legacy
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
    """Snapshot profiles on the original that _carry_plan accepts.

    A member with no row at any tier on the original does not block the
    carry: such members were never seeded (e.g. the blend aggregate services
    on a single-analyte sample), so there is nothing pending to wait for."""
    profiles = _profiles_by_key(db, snapshot_profile_keys(original))
    return {key for key, prof in profiles.items() if _carry_plan(db, original, prof) is not None}


def carry_blocked_reason(db: Session, original: LimsSample, prof: AnalysisProfile | None) -> str:
    """Why a profile _carry_plan refused cannot be carried (the overlay text)."""
    if prof is None:
        return "not in the catalog"
    if prof.key == LEGACY_HPLC_KEY:
        why = _legacy_hplc_plan(db, original)[1]
        if why:
            return why
    if _live_carry_rows(db, original, judged_service_ids(db, original, prof)):
        return "a result is still pending"
    return "not verified yet"


def validate_retest_spec(db: Session, *, original: LimsSample, spec: RetestSpec) -> list[str]:
    """Raise BadRequestError on any hard rule; return the retest/carry keys the
    original's snapshot does not have (soft: caller mints without them and warns)."""
    if spec.retest_of_sample_id != original.sample_id:
        raise BadRequestError(
            f"retest_spec is for {spec.retest_of_sample_id!r}, not {original.sample_id!r}")
    have = set(snapshot_profile_keys(original))
    unknown_drop = [k for k in spec.drop if k not in have]
    if unknown_drop:
        raise BadRequestError(f"not on {original.sample_id}, cannot be dropped: {unknown_drop}")
    clash = _meet(spec.add_profiles, have)
    if clash:
        raise BadRequestError(f"already on the original, cannot be added: {clash}")
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


def dropped_profile_keys(original: LimsSample, spec: RetestSpec) -> list[str]:
    """Original snapshot profiles in neither retest nor carry: recorded as
    drop regardless of what the client's own `drop` list said (a 1.29 client
    omits it entirely; an incomplete/omitted drop is filled in here)."""
    demand = set(spec.retest) | set(spec.carry)
    return [k for k in snapshot_profile_keys(original) if k not in demand]


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
                           svc, user_id: int | None, now: datetime) -> None:
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
                  profile_keys, user_id: int | None) -> list[dict]:
    """Mint one verified parent row on `retest` per live verified/published
    parent row on `original` for each profile in `profile_keys`, linked
    (contribution_kind='carried') to the original vial's analysis. Idempotent
    per (retest, original parent row). Does NOT commit."""
    from models import LimsAnalysisPromotion, LimsAnalysisTransition, LimsSubSample

    profiles = _profiles_by_key(db, profile_keys)
    # Dedupe on the ORIGINAL parent row (M6): two original rows may share
    # one source link. The id rides on the mint transition's details.
    already = {d.get("carried_from_parent") for d in db.execute(
        select(LimsAnalysisTransition.details)
        .join(LimsAnalysis, LimsAnalysis.id == LimsAnalysisTransition.analysis_id)
        .join(LimsAnalysisPromotion, LimsAnalysisPromotion.parent_analysis_id == LimsAnalysis.id)
        .where(LimsAnalysis.lims_sample_pk == retest.id,
               LimsAnalysisPromotion.contribution_kind == CARRIED,
               LimsAnalysisTransition.from_state.is_(None))
    ).scalars().all() if d}
    now = datetime.utcnow()  # noqa: DTZ003 (naive TIMESTAMP columns)
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
            if src_parent.id in already:
                continue
            row = LimsAnalysis(
                lims_sample_pk=retest.id, lims_sub_sample_pk=None,
                analysis_service_id=src_parent.analysis_service_id,
                keyword=src_parent.keyword, title=src_parent.title,
                slot=src_parent.slot, peptide_id=src_parent.peptide_id,
                result_value=src_parent.result_value, result_unit=src_parent.result_unit,
                loq=src_parent.loq, lod=src_parent.lod, lod_unit=src_parent.lod_unit,
                result_floor=src_parent.result_floor,
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
                details={"changed": {}, "carried_from": source.id,
                         "carried_from_parent": src_parent.id},
            ))
            already.add(src_parent.id)
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


VARIANCE_KEY = "samplevariance"      # WP buy-flag (bool); the counts ride services["variance"]


def _event(db: Session, sample: LimsSample, event: str, details: dict,
           user_id: int | None = None) -> None:
    from models import LimsSubSampleEvent
    db.add(LimsSubSampleEvent(lims_sample_pk=sample.id, event=event, details=details,
                              user_id=user_id))


def _has_warning(db: Session, sample: LimsSample, reason: str, message: str) -> bool:
    from models import LimsSubSampleEvent
    for d in db.execute(select(LimsSubSampleEvent.details).where(
            LimsSubSampleEvent.lims_sample_pk == sample.id,
            LimsSubSampleEvent.event == "retest_spec_warning")).scalars():
        if (d or {}).get("reason") == reason and (d or {}).get("message") == message:
            return True
    return False


def _seed_keys(db: Session) -> dict[str, str]:
    """{alias: twin} when the HPLC alias has no members and its native twin
    does (prod since the native switch): a retest seeds and snapshots the
    twin in the alias's place. Empty otherwise."""
    profs = _profiles_by_key(db, [LEGACY_HPLC_KEY, NATIVE_HPLC_KEY])
    alias, twin = profs.get(LEGACY_HPLC_KEY), profs.get(NATIVE_HPLC_KEY)
    if (alias is None or not alias.analysis_services) and twin is not None and twin.analysis_services:
        return {LEGACY_HPLC_KEY: NATIVE_HPLC_KEY}
    return {}


def _hplc_key(spec: RetestSpec, seed_keys: dict | None = None) -> str:
    """The HPLC profile key the spec retests, as seeded (parse guarantees one
    when variance is set). Either primary key satisfies hplc_primary_count."""
    key = next(k for k in spec.retest if k in HPLC_PROFILE_KEYS)
    return (seed_keys or {}).get(key, key)


def _demand_services(spec: RetestSpec, services: dict, seed_keys: dict | None = None) -> dict:
    """The services dict the retest seeds and snapshots: its demand profiles,
    keys swapped per `seed_keys` (_seed_keys). The stored spec keeps the keys
    as sent."""
    keys = tuple(dict.fromkeys((seed_keys or {}).get(k, k) for k in spec.demand_keys))
    demand = {k: v for k, v in (services or {}).items() if k in keys}
    for k in keys:
        demand.setdefault(k, True)      # an added profile may be absent from the WP dict
    if spec.variance_points > 0:
        # The WP/IS wire shape normalize_variance_entitlement reads (prod
        # PB-1000): {"variance": {<hplc key>: points}, "samplevariance": True}.
        demand["variance"] = {_hplc_key(spec, seed_keys): spec.variance_points}
        demand[VARIANCE_KEY] = True
    return demand


def _demand_snapshot_profiles(db: Session, demand: dict, package, snap: dict) -> list:
    from catalog.snapshot import compute_catalog_snapshot  # call time: patchable
    try:
        return compute_catalog_snapshot(db, demand, package)["profiles"]
    except Exception as e:  # noqa: BLE001
        logger.warning("retest_spec.snapshot_failed err=%s", e)
        return snap.get("profiles") or []


def _retire_carried_placeholders(db: Session, *, parent: LimsSample, original: LimsSample,
                                 carry_keys, demand_keys, user_id: int | None) -> int:
    """Soft-reject every live 'ordered' placeholder on the retest whose
    service belongs to a carried profile and to no demand profile (the
    Manage Analyses remove primitive). A carried legacy HPLC alias also
    retires its native twin's placeholders, unless HPLC is in demand.
    Returns the count."""
    from lims_analyses.service import soft_reject_parent_placeholder
    carried = _profiles_by_key(db, carry_keys)
    carried_ids = {s.id for p in carried.values() for s in p.analysis_services}
    if LEGACY_HPLC_KEY in carried and not HPLC_PROFILE_KEYS & set(demand_keys):
        carried_ids |= {s.id for s in _twin_services(db)}
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
                      services: dict | None, package, source: str) -> dict:
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
        if not _has_warning(db, parent, reason, message):   # re-pushes stay quiet (M1)
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
    demand = _demand_services(spec, services or {}, _seed_keys(db))
    seed_parent_from_services(db, parent=parent, services=demand, package=package, source=source)
    snap = dict(parent.catalog_snapshot or {})
    if first_time:
        # The registration fallback may have seeded + stamped the FULL
        # services dict before this ran (C2): freeze the demand profiles only.
        snap["profiles"] = _demand_snapshot_profiles(db, demand, package, snap)
    drop_keys = dropped_profile_keys(original, spec)
    snap["retest"] = {**spec.as_dict(), "missing": missing, "drop": drop_keys}
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
        if drop_keys:
            dropped = _profiles_by_key(db, drop_keys)
            names = ", ".join(dropped[k].name if k in dropped else k for k in drop_keys)
            message = f"dropped {names} (not carried to {parent.sample_id})"
            _event(db, parent, "retest_spec_warning",
                   {"reason": "profiles_dropped", "message": message, "drop": drop_keys}, user_id)
    db.flush()
    return {"applied": True, "carried": len(carried), "missing": missing,
            "demand_keys": list(spec.demand_keys)}
