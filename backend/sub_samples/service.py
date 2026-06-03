"""Sub-sample business logic.

Ordering invariant: SENAITE write succeeds before any local DB row lands.
Vial sequence assignment uses row-level lock on the parent lims_samples row.

Defense-in-depth protections (per Task 5 spike findings):
  1. Children always inherit parent's Contact — refuse to create if missing.
  2. Pre-validate parent UID with SENAITE; refresh + retry on stale cache.
  3. Surface SecondaryFalloutError with orphan UID for manual cleanup.
"""
import logging
import os
import requests
from datetime import datetime, timedelta
from typing import Optional, Tuple, List
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from models import LimsSample, LimsSubSample
from sub_samples import senaite
from sub_samples.senaite import SecondaryFalloutError


CACHE_FRESHNESS = timedelta(minutes=5)
log = logging.getLogger(__name__)


def ensure_sample_row(db: Session, parent_sample_id: str) -> LimsSample:
    """Lazy upsert: return existing lims_samples row, or fetch from SENAITE."""
    existing = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if existing:
        return existing

    meta = senaite.fetch_parent_metadata(parent_sample_id)
    row = LimsSample(
        sample_id=parent_sample_id,
        external_lims_uid=meta.get("uid"),
        external_lims_system="senaite",
        client_uid=_extract_uid(meta.get("ClientUID") or meta.get("Client")),
        client_id=meta.get("ClientID"),
        contact_uid=_extract_uid(meta.get("ContactUID") or meta.get("Contact")),
        sample_type=_extract_uid(meta.get("SampleType")),
        status=meta.get("review_state"),
        # Analyte1Peptide may come back as a {uid, url} dict from
        # /complete=true; the lims_samples.peptide_name column is a string
        # (display label), so reduce to title/string. Falls back to None when
        # the parent has no analytes (non-peptide samples).
        peptide_name=_extract_label(meta.get("Analyte1Peptide")),
        client_sample_id=meta.get("ClientSampleID"),
        last_synced_at=datetime.utcnow(),
    )
    db.add(row)
    db.flush()
    return row


def _extract_uid(value):
    """SENAITE returns some fields as either a UID string or a dict {uid, url, ...}.
    Normalize to UID string."""
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get("uid")
    return value


def _extract_label(value):
    """For display-label fields (e.g. Analyte1Peptide) SENAITE may return a
    plain string OR a {uid, url, title, ...} dict from complete=true. Reduce
    to a human-readable string, preferring `title` then falling back to a
    UID/string.

    Mirrors _extract_uid but targets the human label rather than the UID,
    used for caching display strings into lims_samples.peptide_name.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get("title") or value.get("Title") or value.get("uid")
    return value


def _refresh_parent_from_senaite(db: Session, parent: LimsSample) -> None:
    """Refresh the cached lims_samples row from SENAITE in place."""
    meta = senaite.fetch_parent_metadata(parent.sample_id)
    parent.external_lims_uid = meta.get("uid")
    parent.client_uid = _extract_uid(meta.get("ClientUID") or meta.get("Client"))
    parent.contact_uid = _extract_uid(meta.get("ContactUID") or meta.get("Contact"))
    parent.sample_type = _extract_uid(meta.get("SampleType"))
    parent.status = meta.get("review_state")
    parent.last_synced_at = datetime.utcnow()
    db.flush()


def _next_vial_sequence(db: Session, parent_pk: int) -> int:
    """Assign vial_sequence under a row lock to prevent concurrent collisions."""
    db.execute(
        select(LimsSample).where(LimsSample.id == parent_pk).with_for_update()
    ).scalar_one()
    current_max = db.execute(
        select(func.coalesce(func.max(LimsSubSample.vial_sequence), 0))
        .where(LimsSubSample.parent_sample_pk == parent_pk)
    ).scalar_one()
    return current_max + 1


def create_sub_sample(
    db: Session,
    parent_sample_id: str,
    photo_bytes: bytes,
    photo_filename: str,
    remarks: Optional[str],
    user_id: int,
) -> LimsSubSample:
    """Create a sub-sample atomically with defense-in-depth protections."""
    parent = ensure_sample_row(db, parent_sample_id)

    # Defense in depth #1: parent must have a contact. Children inherit it.
    # Cheap local check; fail fast before any SENAITE round-trip.
    if not parent.contact_uid:
        raise RuntimeError(
            f"Cannot create sub-sample for {parent_sample_id}: parent has no "
            f"contact_uid. Set a Contact on the parent in SENAITE first, or "
            f"re-receive it through the order processor which sets one."
        )

    # Defense in depth #2: refresh cache if SENAITE doesn't recognize the UID.
    # If the cached UID is stale, refetch metadata and re-check the contact;
    # we then trust the refreshed UID and proceed (the create_secondary call
    # is the real validation — it'll error loudly if the UID is still wrong).
    if not senaite.uid_exists(parent.external_lims_uid):
        log.warning("sub_samples.parent_uid_stale parent=%s uid=%s; refreshing",
                    parent_sample_id, parent.external_lims_uid)
        _refresh_parent_from_senaite(db, parent)
        if not parent.external_lims_uid:
            raise RuntimeError(
                f"Cannot create sub-sample for {parent_sample_id}: parent has no "
                f"external_lims_uid even after refresh."
            )
        if not parent.contact_uid:
            raise RuntimeError(
                f"Cannot create sub-sample for {parent_sample_id}: parent has no "
                f"contact_uid even after refresh from SENAITE."
            )

    # 1. Fetch FRESH parent metadata so we have all Accumark-custom fields to
    #    copy onto the secondary. lims_samples cache is intentionally minimal
    #    (Client/Contact/SampleType + a couple peptide/order hints), so we
    #    must hit SENAITE directly to get ClientOrderNumber, Analyte*Peptide,
    #    Coa*, etc. Best-effort: if this fails we still create the secondary —
    #    only the inheritance step is degraded, not the whole vial.
    parent_meta: dict = {}
    try:
        parent_meta = senaite.fetch_parent_metadata(parent_sample_id)
    except Exception as e:
        log.warning(
            "sub_samples.parent_meta_fetch_failed parent=%s err=%s",
            parent_sample_id, e,
        )

    # 2. Create secondary in SENAITE. Children always inherit parent's contact.
    create_result = senaite.create_secondary(
        parent_sample_id=parent_sample_id,
        parent_uid=parent.external_lims_uid,
        client_uid=parent.client_uid,
        contact_uid=parent.contact_uid,   # explicit inheritance
        sample_type_uid=parent.sample_type or "",
    )
    # SecondaryFalloutError naturally propagates with orphan_uid attribute (#3).

    # 3. Copy inheritable Accumark-custom fields from parent → secondary.
    #    SENAITE's secondary-create natively inherits only Client/Contact/
    #    SampleType/DateSampled; everything else (ClientOrderNumber,
    #    Analyte*Peptide, Coa*, CompanyLogoUrl, VerificationCode, Profiles,
    #    DeclaredTotalQuantity, ClientLot, ClientSampleID, ClientReference)
    #    must be explicitly copied via /update. Best-effort: a failure here
    #    leaves the vial in SENAITE with empty Accumark fields rather than
    #    failing the whole create — the user can backfill via the field-update
    #    UI on the sample detail page.
    if parent_meta:
        inherited = senaite.extract_inheritable_fields(parent_meta)
        if inherited:
            try:
                senaite.update_secondary_fields(create_result.uid, inherited)
                log.info(
                    "sub_samples.field_inheritance_applied parent=%s child=%s fields=%s",
                    parent_sample_id, create_result.sample_id, sorted(inherited.keys()),
                )
            except Exception as e:
                log.warning(
                    "sub_samples.field_inheritance_failed parent=%s child=%s err=%s",
                    parent_sample_id, create_result.sample_id, e,
                )

    # 2. Upload photo. Compensate (delete the secondary) on failure so we don't
    #    leave a vial without a photo.
    try:
        senaite.upload_photo(create_result.path, photo_bytes, photo_filename)
    except Exception:
        try:
            senaite.delete_secondary(create_result.uid)
        except Exception as cleanup_err:
            log.error("sub_samples.photo_upload_orphan uid=%s cleanup_err=%s",
                      create_result.uid, cleanup_err)
        raise

    # 3. Set remarks if provided. Best-effort.
    if remarks:
        try:
            senaite.update_remarks(create_result.uid, remarks)
        except Exception as e:
            log.warning("sub_samples.remarks_set_failed uid=%s err=%s",
                        create_result.uid, e)

    # Local insert under row lock
    vial_seq = _next_vial_sequence(db, parent.id)
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=create_result.uid,
        sample_id=create_result.sample_id,
        vial_sequence=vial_seq,
        received_by_user_id=user_id,
        # The HTML form upload doesn't return an attachment UID, so we store
        # the AR's path; a backend proxy resolves attachments on demand.
        photo_external_uid=create_result.path,
        remarks=remarks,
    )
    db.add(sub)

    parent.last_synced_at = datetime.utcnow()
    db.commit()
    db.refresh(sub)

    # Phase 2 (mk1-native-analyses): seed lims_analyses rows in parallel with
    # the SENAITE-side cloned analyses. Defensive — at the moment, the wizard
    # doesn't pre-assign a role at create time, so this is usually a no-op
    # here and the actual seeding fires from the role-flip hook in
    # set_assignment_role. Best-effort: failure to seed must not roll back
    # the vial create.
    if sub.assignment_role and sub.assignment_role != "xtra":
        try:
            wp_services = _fetch_wp_services_for_parent(parent_sample_id) or {}
            from lims_analyses.seeder import seed_analyses_for_vial
            seed_analyses_for_vial(
                db,
                sub_sample=sub,
                role=sub.assignment_role,
                wp_services=wp_services,
                created_by_user_id=user_id,
            )
            db.refresh(sub)
        except Exception as e:
            log.warning(
                "sub_samples.create_seed_failed sub=%s role=%s err=%s",
                sub.sample_id, sub.assignment_role, e,
            )
    return sub


def _fetch_wp_services_for_parent(parent_sample_id: str) -> Optional[dict]:
    """Wrapper around fetch_sample_services that returns the services dict
    or None. Lifted to its own helper so the role-flip hook in
    set_assignment_role can reuse it without duplicating the None-handling."""
    raw = fetch_sample_services(parent_sample_id)
    if not raw:
        return None
    return raw.get("services") or {}


def list_sub_samples(db: Session, parent_sample_id: str) -> Tuple[Optional[LimsSample], List[LimsSubSample]]:
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        return None, []

    if datetime.utcnow() - parent.last_synced_at > CACHE_FRESHNESS:
        _reconcile_from_senaite(db, parent)

    return parent, list(parent.sub_samples)


def _reconcile_from_senaite(db: Session, parent: LimsSample) -> None:
    """SENAITE is canonical; insert SENAITE-only sub-samples missing locally.

    Never deletes local rows based on absence in SENAITE — surface to a human
    via WARN log instead.
    """
    if not parent.external_lims_uid:
        return
    remote = senaite.fetch_secondaries(parent.sample_id)
    local_uids = {s.external_lims_uid for s in parent.sub_samples}
    remote_uids = set()

    for item in remote:
        remote_uids.add(item["uid"])
        if item["uid"] in local_uids:
            continue
        log.warning(
            "sub_samples.drift: SENAITE-only secondary discovered parent=%s remote_uid=%s sample_id=%s",
            parent.sample_id, item["uid"], item.get("id"),
        )
        next_seq = (db.execute(
            select(func.coalesce(func.max(LimsSubSample.vial_sequence), 0))
            .where(LimsSubSample.parent_sample_pk == parent.id)
        ).scalar_one()) + 1
        db.add(LimsSubSample(
            parent_sample_pk=parent.id,
            external_lims_uid=item["uid"],
            sample_id=item["id"],
            vial_sequence=next_seq,
        ))

    local_only = local_uids - remote_uids
    if local_only:
        log.warning(
            "sub_samples.drift: Accu-Mk1 has sub-samples not in SENAITE parent=%s uids=%s",
            parent.sample_id, local_only,
        )

    parent.last_synced_at = datetime.utcnow()
    db.flush()


def update_sub_sample(
    db: Session,
    sample_id: str,
    photo_bytes: Optional[bytes],
    photo_filename: Optional[str],
    remarks: Optional[str],
) -> LimsSubSample:
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one()
    if remarks is not None:
        senaite.update_remarks(sub.external_lims_uid, remarks)
        sub.remarks = remarks
    if photo_bytes is not None:
        senaite.upload_photo(sub.photo_external_uid, photo_bytes, photo_filename or "vial.jpg")
    sub.parent_sample.last_synced_at = datetime.utcnow()
    db.commit()
    db.refresh(sub)
    return sub


def delete_sub_sample(db: Session, sample_id: str) -> None:
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one()
    senaite.delete_secondary(sub.external_lims_uid)
    parent = sub.parent_sample
    db.delete(sub)
    parent.last_synced_at = datetime.utcnow()
    db.commit()


def fetch_sample_services(sample_id: str) -> Optional[dict]:
    """Fetch the WP `services` dict for a SENAITE sample by hitting IS.

    Returns None on 404 (sample not in any order_submissions row); raises on
    network error / non-2xx so the caller can surface 503 to the wizard.

    Auth: Mk1 calls the IS desktop endpoints with X-API-Key. Historical
    naming: the env var is ACCU_MK1_API_KEY (matches IS's DESKTOP_API_KEYS
    allowlist), but main.py also rebinds it as INTEGRATION_SERVICE_API_KEY
    for use elsewhere. We read both names so the helper works regardless of
    which variable is set in any particular environment.
    """
    base = os.environ.get("INTEGRATION_SERVICE_URL", "").rstrip("/")
    key = (
        os.environ.get("ACCU_MK1_API_KEY")
        or os.environ.get("INTEGRATION_SERVICE_API_KEY")
        or ""
    )
    if not base or not key:
        raise RuntimeError(
            "INTEGRATION_SERVICE_URL / ACCU_MK1_API_KEY not configured"
        )
    resp = requests.get(
        f"{base}/explorer/orders/sample-services",
        params={"sample_id": sample_id},
        headers={"X-API-Key": key},
        timeout=15,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def derive_demand(services: dict) -> dict:
    """Translate WP services dict to vial demand per bucket.

    HPLC is satisfied by either `hplcpurity_identity` or `bac_water_panel` —
    both result in chromatography vials. Sterility is the only bucket that
    needs more than one vial (2 per the lab's protocol).
    """
    hplc = bool(services.get("hplcpurity_identity") or services.get("bac_water_panel"))
    endo = bool(services.get("endotoxin"))
    ster = bool(services.get("sterility_pcr"))
    return {
        "hplc": 1 if hplc else 0,
        "endo": 1 if endo else 0,
        "ster": 2 if ster else 0,
    }


_BUCKET_PRIORITY = ("hplc", "endo", "ster")
_REAL_BUCKETS = {"hplc", "endo", "ster"}


def compute_vial_plan(db: Session, parent_sample_id: str) -> dict:
    """Resolve services from IS, run auto-assign, persist new roles, return plan.

    Returns a dict matching VialPlanResponse. If IS is unreachable, returns
    `is_unreachable=True` with empty demand and all current roles preserved
    (no auto-assign mutation).
    """
    parent = ensure_sample_row(db, parent_sample_id)
    subs = list(parent.sub_samples)
    subs.sort(key=lambda s: s.vial_sequence)

    # Try IS — fail soft on any error (wizard handles via banner)
    try:
        services_resp = fetch_sample_services(parent_sample_id)
    except Exception as e:
        log.warning("vial_plan.is_fetch_failed parent=%s err=%s", parent_sample_id, e)
        services_resp = None

    if services_resp is None:
        return {
            "demand": {"hplc": 0, "endo": 0, "ster": 0},
            "wp_order_number": None,
            "is_unreachable": True,
            "vials": [
                {
                    "sample_id": parent.sample_id,
                    "is_parent": True,
                    "vial_sequence": 0,
                    "assignment_role": parent.assignment_role or "hplc",
                }
            ] + [
                {
                    "sample_id": s.sample_id,
                    "is_parent": False,
                    "vial_sequence": s.vial_sequence,
                    "assignment_role": s.assignment_role,
                }
                for s in subs
            ],
        }

    demand = derive_demand(services_resp.get("services") or {})

    # Build vial list with parent first, then sub-samples in vial_sequence order.
    # Parent's assignment_role is never NULL (default 'hplc' from migration).
    vials = [
        {
            "sample_id": parent.sample_id,
            "is_parent": True,
            "vial_sequence": 0,
            "assignment_role": parent.assignment_role or "hplc",
        }
    ] + [
        {
            "sample_id": s.sample_id,
            "is_parent": False,
            "vial_sequence": s.vial_sequence,
            "assignment_role": s.assignment_role,
        }
        for s in subs
    ]

    assigned = auto_assign(vials, demand)

    # Persist newly-set roles for sub-samples (parent never NULLs, so we never
    # write back to lims_samples here — Reset-to-auto goes through the PATCH endpoint).
    sub_by_id = {s.sample_id: s for s in subs}
    role_changed_subs: List[LimsSubSample] = []
    for v in assigned:
        if v["is_parent"]:
            continue
        original = sub_by_id.get(v["sample_id"])
        if original is None:
            continue
        if original.assignment_role != v["assignment_role"]:
            original.assignment_role = v["assignment_role"]
            role_changed_subs.append(original)
    db.commit()

    # Phase 2 (mk1-native-analyses): seed lims_analyses for any vial whose
    # role flipped into a real bucket. Mirrors the hook in set_assignment_role
    # — compute_vial_plan writes to assignment_role directly so we need a
    # second seeding site. Idempotent; best-effort.
    if role_changed_subs:
        wp_services = (services_resp.get("services") if services_resp else None) or {}
        from lims_analyses.seeder import seed_analyses_for_vial
        for s in role_changed_subs:
            if not s.assignment_role or s.assignment_role == "xtra":
                continue
            try:
                seed_analyses_for_vial(
                    db,
                    sub_sample=s,
                    role=s.assignment_role,
                    wp_services=wp_services,
                )
            except Exception as e:
                log.warning(
                    "vial_plan.seed_failed sub=%s role=%s err=%s",
                    s.sample_id, s.assignment_role, e,
                )

    return {
        "demand": demand,
        "wp_order_number": services_resp.get("wp_order_number"),
        "is_unreachable": False,
        "vials": assigned,
    }


def auto_assign(vials: list[dict], demand: dict) -> list[dict]:
    """Pure function: assign roles in-place to a list of vial dicts.

    Mutates vial['assignment_role'] for any vial where it is None. Vials
    whose role is already set are skipped — but their bucket counts toward
    decrementing demand so we don't double-fill.

    Vials are processed in input order (which the caller orders by
    vial_sequence with parent first).

    When filling None-role vials, prefer completing buckets that already have
    user-assigned vials, using priority order as the tiebreaker. Vials that
    don't fit any remaining demand land in 'xtra'.
    """
    remaining = dict(demand)  # copy so we don't mutate caller's dict
    assigned_buckets = set()

    # First pass: track existing assignments and decrement demand.
    for vial in vials:
        role = vial.get("assignment_role")
        if role in _REAL_BUCKETS:
            assigned_buckets.add(role)
            if remaining.get(role, 0) > 0:
                remaining[role] -= 1

    # Second pass: auto-assign None roles. Prefer completing already-assigned
    # buckets, then fall back to priority order.
    out = []
    for vial in vials:
        role = vial.get("assignment_role")
        if role is None:
            assigned = None
            # First try to complete buckets that already have assignments.
            for bucket in _BUCKET_PRIORITY:
                if bucket in assigned_buckets and remaining.get(bucket, 0) > 0:
                    assigned = bucket
                    remaining[bucket] -= 1
                    break
            # Then try remaining buckets in priority order.
            if assigned is None:
                for bucket in _BUCKET_PRIORITY:
                    if remaining.get(bucket, 0) > 0:
                        assigned = bucket
                        remaining[bucket] -= 1
                        break
            if assigned is None:
                assigned = "xtra"
            vial = {**vial, "assignment_role": assigned}
        out.append(vial)
    return out


_VALID_ROLES = {"hplc", "endo", "ster", "xtra"}


def set_assignment_role(db: Session, sample_id: str, role: Optional[str]) -> dict:
    """Set assignment_role on a sub-sample or parent. Routes by sample existence.

    For sub-samples: role can be None (resets, next /vial-plan auto-assigns).
    For parent (lims_samples): None is coerced to 'hplc' (parent never goes NULL).
    """
    if role is not None and role not in _VALID_ROLES:
        raise ValueError(f"Invalid role: {role!r}")

    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sub is not None:
        sub.assignment_role = role
        db.commit()
        # Phase 2 (mk1-native-analyses): if this assignment transitioned the
        # vial into a real (non-XTRA) role, seed its lims_analyses rows.
        # Idempotent — re-running on an already-seeded vial is a no-op.
        # Best-effort: failure must NOT roll back the role assignment.
        if role and role != "xtra":
            try:
                parent_row = db.get(LimsSample, sub.parent_sample_pk)
                parent_sid = parent_row.sample_id if parent_row else None
                if parent_sid:
                    wp_services = _fetch_wp_services_for_parent(parent_sid) or {}
                    from lims_analyses.seeder import seed_analyses_for_vial
                    seed_analyses_for_vial(
                        db,
                        sub_sample=sub,
                        role=role,
                        wp_services=wp_services,
                    )
            except Exception as e:
                log.warning(
                    "sub_samples.role_flip_seed_failed sub=%s role=%s err=%s",
                    sample_id, role, e,
                )
        return {"sample_id": sample_id, "assignment_role": role}

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise LookupError(f"No sample or sub-sample with sample_id={sample_id}")
    coerced = role if role in _VALID_ROLES else "hplc"
    parent.assignment_role = coerced
    db.commit()
    return {"sample_id": sample_id, "assignment_role": coerced}


def aggregate_by_parent(db: Session, parent_sample_ids: list[str]) -> dict[str, dict]:
    """Vial count + role for each requested sample_id.

    Two recognized inputs:

    1. Parent sample_ids (in lims_samples) with at least one sub-sample.
       Returned as {vial_count: 1+N, parent_role: <parent's role>}.
       Single-vial parents (no sub-samples) are omitted — the list-page
       column is meant to highlight multi-vial splits.

    2. Sub-sample sample_ids (in lims_sub_samples). Returned as
       {vial_count: 0, parent_role: <sub's own assignment_role>}.
       The list page treats vial_count=0 as "no chevron, no count",
       but renders the role badge so a search hit on a secondary AR
       shows what department it's been assigned to.

    Sample IDs not in either table are omitted; callers treat absence
    as "no role to show".
    """
    if not parent_sample_ids:
        return {}

    result: dict[str, dict] = {}

    # Path 1: parent rows. GROUP BY parent + count children.
    parent_rows = db.execute(
        select(
            LimsSample.sample_id,
            LimsSample.assignment_role,
            func.count(LimsSubSample.id).label("sub_count"),
        )
        .outerjoin(LimsSubSample, LimsSubSample.parent_sample_pk == LimsSample.id)
        .where(LimsSample.sample_id.in_(parent_sample_ids))
        .group_by(LimsSample.sample_id, LimsSample.assignment_role)
    ).all()
    for sample_id, parent_role, sub_count in parent_rows:
        if sub_count == 0:
            continue
        result[sample_id] = {
            "vial_count": sub_count + 1,
            "parent_role": parent_role or "hplc",
        }

    # Path 2: sub-sample rows. Skip any IDs already resolved as parents
    # to keep the query small.
    remaining = [sid for sid in parent_sample_ids if sid not in result]
    if remaining:
        sub_rows = db.execute(
            select(LimsSubSample.sample_id, LimsSubSample.assignment_role)
            .where(LimsSubSample.sample_id.in_(remaining))
        ).all()
        for sample_id, role in sub_rows:
            result[sample_id] = {
                "vial_count": 0,
                "parent_role": role or "unassigned",
            }

    return result


# ── Variance set helpers (worksheet-variance design 2026-06-02) ──────────────

from sub_samples.variance import compute_variance_stats


class VarianceLockedError(RuntimeError):
    """Raised when attempting to mutate a locked variance set."""


class VarianceTooFewVialsError(ValueError):
    """Raised when attempting to lock with fewer than 2 selected vials."""


def get_variance_set(db: Session, parent_sample_id: str) -> Optional[dict]:
    """Return variance set view for a parent: vials + stats + lock state.

    Per-vial `results` are fetched from SENAITE (Analysis endpoint, keyed by
    keyword). Fetch is soft-fail: a transport error leaves results={} for that
    vial and the variance summary still renders membership + lock state.
    Specs are not yet populated (separate AnalysisSpec fetch — follow-up).
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        return None

    subs = sorted(parent.sub_samples, key=lambda s: s.vial_sequence)

    vial_dicts: list[dict] = [
        {
            "sample_id": parent.sample_id,
            "vial_sequence": 0,
            "is_parent": True,
            "in_variance_set": parent.in_variance_set,
            "exclusion_reason": parent.variance_exclusion_reason,
            "review_state": parent.status,
            "results": senaite.fetch_results_by_keyword(parent.sample_id),
        }
    ] + [
        {
            "sample_id": s.sample_id,
            "vial_sequence": s.vial_sequence,
            "is_parent": False,
            "in_variance_set": s.in_variance_set,
            "exclusion_reason": s.variance_exclusion_reason,
            "review_state": None,
            "results": senaite.fetch_results_by_keyword(s.sample_id),
        }
        for s in subs
    ]

    stats = compute_variance_stats(vial_dicts)
    return {
        "parent": parent,
        "vials": vial_dicts,
        "stats": stats,
        "locked": parent.variance_locked_at is not None,
        "locked_at": parent.variance_locked_at,
        "locked_by_user_id": parent.variance_locked_by_user_id,
    }


def _resolve_variance_vial(db: Session, sample_id: str) -> tuple:
    """Find a row by sample_id (parent or sub) + its owning parent.

    Returns (row, parent). For a parent sample row equals parent.
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent:
        return parent, parent
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sub:
        return sub, sub.parent_sample
    raise LookupError(f"sample {sample_id} not found in lims_samples/lims_sub_samples")


def set_variance_membership(
    db: Session, sample_id: str, in_set: bool, reason: Optional[str]
) -> dict:
    """Update one vial's variance membership. Refuses when the family is locked."""
    row, parent = _resolve_variance_vial(db, sample_id)
    if parent.variance_locked_at is not None:
        raise VarianceLockedError(f"variance set for {parent.sample_id} is locked")
    row.in_variance_set = in_set
    row.variance_exclusion_reason = reason if not in_set else None
    db.commit()
    return {
        "sample_id": sample_id,
        "in_variance_set": row.in_variance_set,
        "exclusion_reason": row.variance_exclusion_reason,
    }


def lock_variance_set(db: Session, parent_sample_id: str, user_id: int) -> LimsSample:
    """Lock a family's variance set. Requires n_selected >= 2."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        raise LookupError(f"parent {parent_sample_id} not found")
    selected = (1 if parent.in_variance_set else 0) + sum(
        1 for s in parent.sub_samples if s.in_variance_set
    )
    if selected < 2:
        raise VarianceTooFewVialsError(
            f"need >=2 selected vials, have {selected}"
        )
    parent.variance_locked_at = datetime.utcnow()
    parent.variance_locked_by_user_id = user_id
    db.commit()
    return parent


def unlock_variance_set(db: Session, parent_sample_id: str) -> LimsSample:
    """Admin-only: clear lock fields."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        raise LookupError(f"parent {parent_sample_id} not found")
    parent.variance_locked_at = None
    parent.variance_locked_by_user_id = None
    db.commit()
    return parent
