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
    return sub


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
    """
    base = os.environ.get("INTEGRATION_SERVICE_URL", "").rstrip("/")
    key = os.environ.get("INTEGRATION_SERVICE_API_KEY", "")
    if not base or not key:
        raise RuntimeError(
            "INTEGRATION_SERVICE_URL / INTEGRATION_SERVICE_API_KEY not configured"
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
