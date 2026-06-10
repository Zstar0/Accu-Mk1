"""Sub-sample business logic.

Ordering invariant: SENAITE write succeeds before any local DB row lands.
Vial sequence assignment uses row-level lock on the parent lims_samples row.

Defense-in-depth protections (per Task 5 spike findings):
  1. Children always inherit parent's Contact — refuse to create if missing.
  2. Pre-validate parent UID with SENAITE; refresh + retry on stale cache.
  3. Surface SecondaryFalloutError with orphan UID for manual cleanup.
"""
import json
import logging
import os
import requests
from datetime import datetime, timedelta
from typing import Optional, Tuple, List
from sqlalchemy import select, func, delete
from sqlalchemy.orm import Session
from models import LimsSample, LimsSubSample, LimsSubSampleEvent
from sub_samples import native
from sub_samples import senaite
from sub_samples.senaite import SecondaryFalloutError


CACHE_FRESHNESS = timedelta(minutes=5)
log = logging.getLogger(__name__)


# Sub-sample assignment role -> the service group name(s) whose analyses belong
# to that role. endo/ster are both Microbiology; hplc is Analytics; xtra has none.
_ROLE_GROUP_NAMES: dict[str, set[str]] = {
    "hplc": {"Analytics"},
    "endo": {"Microbiology"},
    "ster": {"Microbiology"},
    "xtra": set(),
}


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
    """Create a sub-sample. Native path (flag ON) skips SENAITE entirely;
    legacy path (flag OFF) creates a SENAITE secondary AR as before."""
    parent = ensure_sample_row(db, parent_sample_id)

    if native.native_create_enabled():
        return _create_sub_sample_native(
            db, parent, photo_bytes, photo_filename, remarks, user_id,
        )
    return _create_sub_sample_legacy(
        db, parent, parent_sample_id, photo_bytes, photo_filename, remarks, user_id,
    )


def _create_sub_sample_native(
    db: Session,
    parent: LimsSample,
    photo_bytes: bytes,
    photo_filename: str,
    remarks: Optional[str],
    user_id: int,
) -> LimsSubSample:
    """Model-D create path. No SENAITE AR. sample_id + external_lims_uid
    generated locally; photo to Mk1 storage; remarks stored on the row.

    Ordering: assign vial_sequence + sample_id under the parent row lock, then
    persist the photo (raise before inserting on failure — no SENAITE orphan to
    clean up since we never created one), then insert the row and seed analyses.
    """
    vial_seq = _next_vial_sequence(db, parent.id)
    sample_id = native.next_native_sample_id(parent.sample_id, vial_seq)
    external_uid = native.generate_native_uid()

    from sub_samples.photo_storage import get_storage
    photo_key = get_storage().save_photo(sample_id, photo_bytes, photo_filename)

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=external_uid,
        sample_id=sample_id,
        vial_sequence=vial_seq,
        received_by_user_id=user_id,
        photo_external_uid=f"mk1://{photo_key}",
        remarks=remarks,
    )
    db.add(sub)
    parent.last_synced_at = datetime.utcnow()
    db.commit()
    db.refresh(sub)

    _seed_analyses_if_role(db, sub, parent.sample_id, user_id)
    return sub


def _create_sub_sample_legacy(
    db: Session,
    parent: LimsSample,
    parent_sample_id: str,
    photo_bytes: bytes,
    photo_filename: str,
    remarks: Optional[str],
    user_id: int,
) -> LimsSubSample:
    """Legacy SENAITE dual-write path. Caller has already called ensure_sample_row
    and passes parent as a parameter. Everything else is verbatim from the
    original create_sub_sample body."""

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

    # 2. Persist photo to Mk1 storage (Phase 2.5 — see
    #    docs/superpowers/plans/2026-06-03-mk1-native-analyses-phase2.5-photo-storage.md).
    #    Compensate (delete the SENAITE secondary) on failure so we don't
    #    leave a vial without a photo. The SENAITE secondary AR is kept for
    #    sample_id discoverability; only the photo write goes to Mk1 now.
    from sub_samples.photo_storage import get_storage
    photo_key: Optional[str] = None
    try:
        photo_key = get_storage().save_photo(
            create_result.sample_id, photo_bytes, photo_filename,
        )
    except Exception:
        try:
            senaite.delete_secondary(create_result.uid)
        except Exception as cleanup_err:
            log.error("sub_samples.photo_save_orphan uid=%s cleanup_err=%s",
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
        # Phase 2.5: mk1://{key} URI scheme distinguishes Mk1-stored photos
        # from legacy SENAITE secondary-AR paths during fetch-route dispatch.
        photo_external_uid=f"mk1://{photo_key}",
        remarks=remarks,
    )
    db.add(sub)

    parent.last_synced_at = datetime.utcnow()
    db.commit()
    db.refresh(sub)

    _seed_analyses_if_role(db, sub, parent_sample_id, user_id)
    return sub


def _seed_analyses_if_role(
    db: Session, sub: LimsSubSample, parent_sample_id: str, user_id: int,
) -> None:
    """Seed lims_analyses for a freshly-created vial IF it already has a
    real (non-xtra) role. Usually a no-op at create time — the role-flip
    hooks do the real seeding. Best-effort: never rolls back the vial."""
    if sub.assignment_role and sub.assignment_role != "xtra":
        try:
            wp_services = _fetch_wp_services_for_parent(parent_sample_id) or {}
            from lims_analyses.seeder import seed_analyses_for_vial
            seed_analyses_for_vial(
                db,
                sub_sample=sub,
                role=sub.assignment_role,
                wp_services=wp_services,
                parent_sample_id=parent_sample_id,
                created_by_user_id=user_id,
            )
            db.refresh(sub)
        except Exception as e:
            log.warning(
                "sub_samples.create_seed_failed sub=%s role=%s err=%s",
                sub.sample_id, sub.assignment_role, e,
            )


def _fetch_wp_services_for_parent(parent_sample_id: str) -> Optional[dict]:
    """Wrapper around fetch_sample_services that returns the services dict
    or None. Lifted to its own helper so the role-flip hook in
    set_assignment_role can reuse it without duplicating the None-handling."""
    raw = fetch_sample_services(parent_sample_id)
    if not raw:
        return None
    return raw.get("services") or {}


def normalize_variance_entitlement(services: Optional[dict]) -> dict[str, int]:
    """Extract the per-service variance map from a WP services payload.
    Keeps only int counts >= 2 (n=1 means no variance). Unknown/future service
    keys pass through — variance support is key-agnostic by design."""
    variance = (services or {}).get("variance") or {}
    out: dict[str, int] = {}
    for key, n in variance.items():
        if isinstance(n, int) and n >= 2:
            out[key] = n
    return out


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

    Model-D exception: if any vial in the family is native (mk1:// prefix) OR
    the family is empty while the native-create flag is on, Mk1 is canonical
    and the SENAITE pull is skipped. This prevents the BW-0013 IntegrityError
    (orphan SENAITE secondaries being re-inserted against the unique index).
    """
    if not parent.external_lims_uid:
        return

    # Model-D guard: if any vial in this family is native, OR the family is
    # empty while the native flag is on, Mk1 owns the sub-sample set. Pulling
    # from SENAITE would re-insert orphan secondaries — exactly the BW-0013
    # IntegrityError. Skip the pull; just refresh the sync timestamp.
    subs = list(parent.sub_samples)
    any_native = any(native.is_native_vial(s) for s in subs)
    empty_and_native_mode = not subs and native.native_create_enabled()
    if any_native or empty_and_native_mode:
        parent.last_synced_at = datetime.utcnow()
        db.flush()
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
    user_id: Optional[int] = None,
) -> LimsSubSample:
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one()
    if remarks is not None:
        # Native vials store remarks locally only; legacy vials mirror to SENAITE.
        if not native.is_native_vial(sub):
            senaite.update_remarks(sub.external_lims_uid, remarks)
        sub.remarks = remarks
        db.add(LimsSubSampleEvent(
            sub_sample_pk=sub.id,
            event="remarks_updated",
            details={"preview": remarks[:120]},
            user_id=user_id,
        ))
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
    # Native vials have no SENAITE AR to delete; legacy vials do.
    if not native.is_native_vial(sub):
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
    return _apply_variance_override(sample_id, resp.json())


def set_variance_override(db: Session, parent_sample_id: str, variance: Optional[dict]) -> dict:
    """Store the lab-side variance override (None/empty clears). Counts are
    normalized like the WP map (int >= 2 only); invalid entries are dropped.
    Blocked while the variance set is locked."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        raise LookupError(f"parent {parent_sample_id} not found")
    if parent.variance_locked_at is not None:
        raise VarianceLockedError(f"variance set for {parent.sample_id} is locked")
    cleaned = normalize_variance_entitlement({"variance": variance or {}})
    parent.variance_override = json.dumps(cleaned) if cleaned else None
    db.commit()
    return cleaned


def _apply_variance_override(sample_id: str, result: Optional[dict]) -> Optional[dict]:
    """Merge a lab-side variance override into a services payload (override
    wins when set). Opens its own short session; fail-soft — any error returns
    the payload unchanged. Called from fetch_sample_services so every consumer
    (entitlement, verify gate, vial plan/demand, lock guard, seeder) inherits
    the override with no signature changes."""
    if not isinstance(result, dict):
        return result
    try:
        from database import SessionLocal
        db = SessionLocal()
        try:
            row = db.execute(
                select(LimsSample.variance_override)
                .where(LimsSample.sample_id == sample_id)
            ).scalar_one_or_none()
        finally:
            db.close()
        if row:
            override = json.loads(row)
            if override:
                services = result.get("services") or {}
                services["variance"] = override
                result["services"] = services
    except Exception:
        log.warning("variance_override.merge_failed sample=%s", sample_id, exc_info=True)
    return result


# Bucket (== vial assignment_role) -> WP service key carrying variance counts.
# Must stay identical to lims_analyses.service._ROLE_VARIANCE_KEYS (the
# variance_verify gate) — a test asserts equality. Coarse keys only, never
# per-analyte (variance addon spec, "The scoping rule").
VARIANCE_BUCKET_KEYS: dict[str, str] = {
    "hplc": "hplcpurity_identity",
    "endo": "endotoxin",
    "ster": "sterility_pcr",
}


def derive_variance_demand(services: dict) -> dict:
    """Per-bucket variance target (purchased count n) from a WP services
    payload. 0 when not purchased. Under the explicit-bucket model this is the
    auto-assign target for variance-kind vials, a SEPARATE bucket on top of
    core demand. Uses the same normalization as the entitlement endpoint so
    counts are int-filtered (>= 2) in one place."""
    entitlement = normalize_variance_entitlement({"variance": (services or {}).get("variance")})
    return {
        bucket: entitlement.get(key, 0)
        for bucket, key in VARIANCE_BUCKET_KEYS.items()
    }


def derive_base_demand(services: dict) -> dict:
    """Pre-variance vial demand per bucket (the lab-protocol baseline)."""
    hplc = bool(services.get("hplcpurity_identity") or services.get("bac_water_panel"))
    endo = bool(services.get("endotoxin"))
    ster = bool(services.get("sterility_pcr"))
    return {
        "hplc": 1 if hplc else 0,
        "endo": 1 if endo else 0,
        "ster": 2 if ster else 0,
    }


def derive_demand(services: dict) -> dict:
    """Translate WP services dict to CORE vial demand per bucket.

    HPLC is satisfied by either `hplcpurity_identity` or `bac_water_panel` —
    both result in chromatography vials. Sterility is the only bucket that
    needs more than one vial (2 per the lab's protocol).

    Explicit-bucket model (2026-06-10-variance-bucket-assignment-design.md §2):
    variance is a SEPARATE bucket with its own target (derive_variance_demand),
    not an inflation of core demand — the old max(base, n) math is retired.
    Core demand therefore equals the base lab-protocol demand.
    """
    return derive_base_demand(services)


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

    def _current_vials() -> list[dict]:
        """Parent first, then sub-samples in vial_sequence order, as-stored.
        Parent's assignment_role is never NULL (default 'hplc' from migration)
        and the parent has no kind — it IS the canonical."""
        return [
            {
                "sample_id": parent.sample_id,
                "is_parent": True,
                "vial_sequence": 0,
                "assignment_role": parent.assignment_role or "hplc",
                "assignment_kind": None,
            }
        ] + [
            {
                "sample_id": s.sample_id,
                "is_parent": False,
                "vial_sequence": s.vial_sequence,
                "assignment_role": s.assignment_role,
                "assignment_kind": s.assignment_kind,
            }
            for s in subs
        ]

    if services_resp is None:
        return {
            "demand": {"hplc": 0, "endo": 0, "ster": 0},
            "variance": {"hplc": 0, "endo": 0, "ster": 0},
            "base_demand": {"hplc": 0, "endo": 0, "ster": 0},
            "wp_order_number": None,
            "is_unreachable": True,
            "vials": _current_vials(),
        }

    services = services_resp.get("services") or {}
    demand = derive_demand(services)  # core demand == base (inflation retired)
    variance = derive_variance_demand(services)
    base_demand = derive_base_demand(services)

    # Variance lock guard: a locked set blocks re-assignment of its members
    # (spec §5), so a locked parent must NOT have vials auto-assigned under it.
    # set_assignment_role enforces this per-call; mirror it here by skipping
    # auto-assign entirely and returning the stored state.
    if parent.variance_locked_at is not None:
        return {
            "demand": demand,
            "variance": variance,
            "base_demand": base_demand,
            "wp_order_number": services_resp.get("wp_order_number"),
            "is_unreachable": False,
            "vials": _current_vials(),
        }

    assigned = auto_assign(_current_vials(), demand, variance)

    # Persist newly-set (role, kind) for sub-samples through set_assignment_role
    # so validation, the variance-lock guard, audit events, stale-role cleanup
    # and lims_analyses seeding apply uniformly (previously a direct column
    # write that bypassed all of those). Parent never NULLs, so we never write
    # back to lims_samples here — Reset-to-auto goes through the PATCH endpoint.
    # Best-effort per vial: set_assignment_role commits (or rolls back) each
    # vial atomically; a failed vial keeps its NULL role and is retried on the
    # next /vial-plan call. n is small (one family), so per-vial commits are fine.
    db.commit()  # persist ensure_sample_row's lazy upsert before per-vial commits
    sub_by_id = {s.sample_id: s for s in subs}
    for v in assigned:
        if v["is_parent"]:
            continue
        original = sub_by_id.get(v["sample_id"])
        if original is None:
            continue
        if (original.assignment_role != v["assignment_role"]
                or original.assignment_kind != v["assignment_kind"]):
            try:
                set_assignment_role(
                    db, v["sample_id"], v["assignment_role"],
                    kind=v["assignment_kind"],
                )
            except Exception as e:
                db.rollback()
                log.warning(
                    "vial_plan.assign_failed sub=%s role=%s kind=%s err=%s",
                    v["sample_id"], v["assignment_role"], v["assignment_kind"], e,
                )

    return {
        "demand": demand,
        "variance": variance,
        "base_demand": base_demand,
        "wp_order_number": services_resp.get("wp_order_number"),
        "is_unreachable": False,
        "vials": assigned,
    }


def _take_slot(remaining: dict, assigned_buckets: set) -> Optional[str]:
    """Pick a bucket with remaining slots: prefer completing buckets that
    already have assignments, priority order as tiebreaker. Decrements the
    chosen bucket. Returns None when nothing remains."""
    for bucket in _BUCKET_PRIORITY:
        if bucket in assigned_buckets and remaining.get(bucket, 0) > 0:
            remaining[bucket] -= 1
            return bucket
    for bucket in _BUCKET_PRIORITY:
        if remaining.get(bucket, 0) > 0:
            remaining[bucket] -= 1
            return bucket
    return None


def auto_assign(vials: list[dict], demand: dict,
                variance: Optional[dict] = None) -> list[dict]:
    """Pure function: assign (role, kind) to a list of vial dicts.

    Fills vial['assignment_role'] / vial['assignment_kind'] for any vial whose
    role is None. Vials whose role is already set are skipped — but they count
    toward decrementing the targets so we don't double-fill: a vial with
    assignment_kind='variance' consumes a variance slot; anything else (core /
    NULL kind, incl. the parent) consumes a core slot first, overflowing to
    variance.

    Fill order (explicit-bucket model, spec §2): core buckets to base `demand`
    first (kind='core'), then variance buckets up to the `variance` target
    (kind='variance'), then 'xtra' (kind=None). Within each tier, prefer
    completing buckets that already have user-assigned vials, with priority
    order as the tiebreaker.

    Vials are processed in input order (caller orders by vial_sequence with
    parent first). `variance=None` means zero variance targets (legacy call
    shape — all fills are core).
    """
    remaining = dict(demand)  # copies so we don't mutate caller's dicts
    remaining_var = dict(variance or {})
    assigned_buckets = set()

    # First pass: track existing assignments and decrement targets.
    for vial in vials:
        role = vial.get("assignment_role")
        if role in _REAL_BUCKETS:
            assigned_buckets.add(role)
            if vial.get("assignment_kind") == "variance":
                if remaining_var.get(role, 0) > 0:
                    remaining_var[role] -= 1
            elif remaining.get(role, 0) > 0:
                remaining[role] -= 1
            elif remaining_var.get(role, 0) > 0:
                remaining_var[role] -= 1

    # Second pass: fill None-role vials — core tier, then variance tier.
    out = []
    for vial in vials:
        if vial.get("assignment_role") is None:
            assigned = _take_slot(remaining, assigned_buckets)
            kind = "core" if assigned else None
            if assigned is None:
                assigned = _take_slot(remaining_var, assigned_buckets)
                kind = "variance" if assigned else None
            if assigned is None:
                assigned = "xtra"
            vial = {**vial, "assignment_role": assigned, "assignment_kind": kind}
        out.append(vial)
    return out


_VALID_ROLES = {"hplc", "endo", "ster", "xtra"}


def _drop_stale_role_rows(db: Session, *, sub: LimsSubSample, old_role: Optional[str], new_role: Optional[str]) -> int:
    """Delete the vial's UNASSIGNED (no-result) rows whose service group belongs
    to the OLD role but not the NEW role — so a re-assigned vial sheds the
    previous role's stale seeded analyses (e.g. a Microbiology STER-PCR left on a
    now-HPLC vial). Rows that already carry a result/promotion are NEVER touched.
    Returns the count deleted."""
    if not old_role:
        return 0
    old_groups = _ROLE_GROUP_NAMES.get(old_role, set())
    new_groups = _ROLE_GROUP_NAMES.get(new_role or "", set())
    clear_groups = old_groups - new_groups
    if not clear_groups:
        return 0
    from models import LimsAnalysis, LimsAnalysisTransition, AnalysisService, ServiceGroup, service_group_members
    # candidate analysis_service ids in the groups we're clearing
    svc_ids = db.execute(
        select(service_group_members.c.analysis_service_id)
        .join(ServiceGroup, ServiceGroup.id == service_group_members.c.service_group_id)
        .where(ServiceGroup.name.in_(clear_groups))
    ).scalars().all()
    if not svc_ids:
        return 0
    stale = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub.id,
            LimsAnalysis.analysis_service_id.in_(svc_ids),
            LimsAnalysis.review_state == "unassigned",
            LimsAnalysis.result_value.is_(None),
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalars().all()
    n = 0
    for row in stale:
        db.execute(delete(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == row.id))
        db.delete(row)
        n += 1
    if n:
        log.info("sub_samples.role_change_cleanup sub=%s old=%s new=%s dropped=%s",
                 sub.sample_id, old_role, new_role, n)
    return n


_VALID_KINDS = {"core", "variance"}


def set_assignment_role(db: Session, sample_id: str, role: Optional[str],
                        kind: Optional[str] = None, user_id: Optional[int] = None) -> dict:
    """Set assignment_role on a sub-sample or parent. Routes by sample existence.

    For sub-samples: role can be None (resets, next /vial-plan auto-assigns).
    For parent (lims_samples): None is coerced to 'hplc' (parent never goes NULL).

    kind: 'core' | 'variance' | None. Only persisted for testable (non-xtra) roles;
    coerced to None for xtra/unassigned. Blocked when parent's variance_locked_at is set.
    NOTE: a role-only call (kind omitted) clobbers any existing kind to NULL —
    plan-prescribed semantics; kind is ignored on the parent-AR branch.
    """
    if role is not None and role not in _VALID_ROLES:
        raise ValueError(f"Invalid role: {role!r}")
    if kind is not None and kind not in _VALID_KINDS:
        raise ValueError(f"Invalid assignment_kind: {kind!r}")

    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sub is not None:
        # Lock guard: block re-assignment while variance set is locked.
        # Must fire BEFORE any mutation so the transaction is still clean on raise.
        parent_row = db.get(LimsSample, sub.parent_sample_pk)
        if parent_row is not None and parent_row.variance_locked_at is not None:
            raise VarianceLockedError(
                f"variance set for {parent_row.sample_id} is locked; "
                "unlock before re-assigning vials"
            )
        old_role = sub.assignment_role
        old_kind = sub.assignment_kind
        sub.assignment_role = role
        sub.assignment_kind = kind if (role and role != "xtra") else None
        db.add(LimsSubSampleEvent(
            sub_sample_pk=sub.id,
            event="role_assigned",
            details={"from": old_role, "to": role,
                     "kind_from": old_kind, "kind_to": sub.assignment_kind},
            user_id=user_id,
        ))
        # Role re-assignment cleanup: drop the OLD role's stale (unassigned,
        # no-result) seeded rows so the vial only carries its current role's
        # analyses. Runs in THIS transaction (before the commit=False seed and
        # the single db.commit() below), so flip + cleanup + seed are atomic.
        _drop_stale_role_rows(db, sub=sub, old_role=old_role, new_role=role)
        # Phase 2 (mk1-native-analyses): if this assignment transitioned the
        # vial into a real (non-XTRA) role, seed its lims_analyses rows.
        # Idempotent — re-running on an already-seeded vial is a no-op.
        #
        # ATOMIC: seed with commit=False so the seeded analysis rows stay
        # pending in THIS transaction, then the single db.commit() below is the
        # only commit. Role flip + audit event + every analysis row commit
        # together or not at all — a SENAITE read error OR a DB error partway
        # through the seed loop rolls back the whole unit and propagates.
        # (create path + compute_vial_plan keep commit=True / per-row commits:
        # they run after their own commits, so fail-hard there would orphan a
        # committed vial — they stay deliberately best-effort.)
        if role and role != "xtra":
            parent_sid = parent_row.sample_id if parent_row else None
            if parent_sid:
                wp_services = _fetch_wp_services_for_parent(parent_sid) or {}
                from lims_analyses.seeder import seed_analyses_for_vial
                seed_analyses_for_vial(
                    db,
                    sub_sample=sub,
                    role=role,
                    wp_services=wp_services,
                    parent_sample_id=parent_sid,
                    created_by_user_id=user_id,
                    commit=False,
                )
        db.commit()
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


def _variance_buckets_from_override(override: Optional[str]) -> dict:
    """Bucket map {hplc,endo,ster} from a parent's variance_override JSON.
    Direct override read (NOT the fetch_sample_services chokepoint) — identical
    today since WP emits no variance until Phase 3; this is an AR-list display
    hint, not the authoritative sign-off gate (which stays server-side)."""
    try:
        parsed = json.loads(override) if override else {}
    except (ValueError, TypeError):
        parsed = {}
    return derive_variance_demand({"variance": parsed})


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
            LimsSample.variance_override,
            func.count(LimsSubSample.id).label("sub_count"),
        )
        .outerjoin(LimsSubSample, LimsSubSample.parent_sample_pk == LimsSample.id)
        .where(LimsSample.sample_id.in_(parent_sample_ids))
        .group_by(
            LimsSample.sample_id,
            LimsSample.assignment_role,
            LimsSample.variance_override,
        )
    ).all()
    for sample_id, parent_role, variance_override, sub_count in parent_rows:
        if sub_count == 0:
            continue
        result[sample_id] = {
            "vial_count": sub_count + 1,
            "parent_role": parent_role or "hplc",
            "variance": _variance_buckets_from_override(variance_override),
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
                "variance": {"hplc": 0, "endo": 0, "ster": 0},
            }

    return result


# ── Variance set helpers (worksheet-variance design 2026-06-02) ──────────────

from sub_samples.variance import compute_variance_stats


class VarianceLockedError(RuntimeError):
    """Raised when attempting to mutate a locked variance set."""


class VarianceTooFewVialsError(ValueError):
    """Raised when attempting to lock with fewer than 2 selected vials."""


class VarianceSeriesIncompleteError(Exception):
    """Lock refused: variance-purchased buckets still have unfinished rows."""


def _fetch_mk1_results_for_host(
    db: Session, *, host_kind: str, host_pk: int
) -> dict:
    """Phase 4b: collect lims_analyses rows for a vial host and project them
    into the variance result shape.

    Returns: { "<keyword>": {"value": str, "kind": "numeric"|"categorical",
                              "spec": None, "uid": "mk1:<N>",
                              "promoted_to_parent_id": int|None} }

    Skips:
      - rows without a result_value (no result entered yet)
      - retest siblings (we only show the canonical non-retest row)
    """
    from models import LimsAnalysis, LimsAnalysisPromotion

    if host_kind == "sample":
        stmt = select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == host_pk,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.result_value.is_not(None),
        )
    elif host_kind == "sub_sample":
        stmt = select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == host_pk,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.result_value.is_not(None),
        )
    else:
        return {}
    rows = db.execute(stmt).scalars().all()
    if not rows:
        return {}

    # Bulk-load promotion links for these rows
    row_ids = [r.id for r in rows]
    promo_by_source: dict[int, int] = {}
    for p in db.execute(
        select(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.source_analysis_id.in_(row_ids)
        )
    ).scalars().all():
        promo_by_source[p.source_analysis_id] = p.parent_analysis_id

    out: dict = {}
    for r in rows:
        # Heuristic: numeric vs categorical. Mk1 doesn't currently track this
        # explicitly per analysis. Try float-parse the result; if it parses,
        # call it numeric. Otherwise categorical. Matches what SENAITE-side
        # fetch_results_by_keyword does indirectly via ResultOptions.
        kind = "numeric"
        try:
            float(r.result_value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            kind = "categorical"
        out[r.keyword] = {
            "value": str(r.result_value),
            "kind": kind,
            "spec": None,
            "uid": f"mk1:{r.id}",
            "promoted_to_parent_id": promo_by_source.get(r.id),
        }
    return out


def _merge_variance_results(mk1_results: dict, senaite_results: dict) -> dict:
    """Merge Mk1-sourced + SENAITE-sourced result dicts. Mk1 takes precedence
    per the long-term Mk1-replaces-SENAITE direction. SENAITE entries that
    don't appear in Mk1 are carried through with uid=None (the FE filters
    these out of the Promote stage since only mk1: UIDs can promote)."""
    out = dict(mk1_results)
    for kw, entry in senaite_results.items():
        if kw not in out:
            # Carry forward without uid; FE won't render a Promote affordance
            # but the value still shows in the variance summary table.
            out[kw] = {**entry, "uid": None, "promoted_to_parent_id": None}
    return out


def get_variance_set(db: Session, parent_sample_id: str) -> Optional[dict]:
    """Return variance set view for a parent: vials + stats + lock state.

    Per-vial `results` come from Mk1 lims_analyses first (with uid prefixed
    "mk1:<N>" and a `promoted_to_parent_id` field for the Phase 4b promote UI),
    falling back to SENAITE for any keywords missing in Mk1. SENAITE fetch is
    soft-fail: a transport error leaves Mk1-only results.
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        return None

    subs = sorted(parent.sub_samples, key=lambda s: s.vial_sequence)

    parent_results = _merge_variance_results(
        _fetch_mk1_results_for_host(db, host_kind="sample", host_pk=parent.id),
        senaite.fetch_results_by_keyword(parent.sample_id),
    )
    vial_dicts: list[dict] = [
        {
            "sample_id": parent.sample_id,
            "vial_sequence": 0,
            "is_parent": True,
            "in_variance_set": parent.in_variance_set,
            "exclusion_reason": parent.variance_exclusion_reason,
            "review_state": parent.status,
            "results": parent_results,
        }
    ] + [
        {
            "sample_id": s.sample_id,
            "vial_sequence": s.vial_sequence,
            "is_parent": False,
            "in_variance_set": s.in_variance_set,
            "exclusion_reason": s.variance_exclusion_reason,
            "review_state": None,
            "results": _merge_variance_results(
                _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=s.id),
                senaite.fetch_results_by_keyword(s.sample_id),
            ),
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
    # Series-complete guard (variance addon Phase 2, spec §5): when the order
    # purchased variance, every live analysis row on in-set sub vials in a
    # variance-purchased bucket must be signed off (promoted or
    # variance_verified). Fail-soft: no variance / WP unreachable -> no guard
    # (lock keeps its original semantics for non-variance work).
    try:
        services_resp = fetch_sample_services(parent_sample_id)
    except Exception:
        services_resp = None
    variance = derive_variance_demand(
        (services_resp or {}).get("services") or {}
    )
    variance_buckets = {b for b, n in variance.items() if n >= 2}
    if variance_buckets:
        from models import LimsAnalysis
        unfinished: list[str] = []
        for s in parent.sub_samples:
            if not s.in_variance_set:
                continue
            if (s.assignment_role or "") not in variance_buckets:
                continue
            rows = db.execute(
                select(LimsAnalysis).where(
                    LimsAnalysis.lims_sub_sample_pk == s.id,
                    LimsAnalysis.review_state.not_in(
                        ("retracted", "rejected", "promoted", "variance_verified")
                    ),
                    LimsAnalysis.retested.is_(False),
                )
            ).scalars().all()
            unfinished.extend(f"{s.sample_id}:{r.keyword}" for r in rows)
        if unfinished:
            raise VarianceSeriesIncompleteError(
                "variance series incomplete — unfinished rows: "
                + ", ".join(sorted(unfinished))
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
