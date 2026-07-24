"""Native sample-details builder (read-flip spec §8, Layer 4 / Task 2).

`build_native_details(db, sample_id)` assembles the full
RegistrySampleReadResult for the endpoint's `mk1` read mode from Mk1 tables
plus the IS DB — ZERO SENAITE HTTP (spec §9 invariant 2, test-enforced).
Read-only: no writes anywhere.

Field-source matrix (spec §8):
- basic info / dates / client fields / declared_weight_mg:
  `registry_read.registry_row_to_display` (same values the overlay serves)
- review_state: `lims_samples.status` (slice-3 mirrored + healed)
- analytes: `analytes_from_registry_json` adapter (registry JSON → typed
  SenaiteAnalyte)
- analyses: `lims_analyses.service.list_parent_analyses_senaite_shape`
  (Layer 4 / Task 1 — shared serializer, `mk1:` uids)
- remarks: `native_sample_remarks` (Layer 2 authority flip — this helper
  MOVED here from main.py so the builder needs no main import; main.py
  re-imports it as `_native_sample_remarks` for the L2 call sites)
- attachments: `lims_parent_attachments` (Layer 3), uid =
  senaite_attachment_uid or `mk1att:{id}`; download_url routes s3 rows to
  the new native download route and senaite rows to the existing
  /wizard/senaite/attachment proxy
- coa: SenaiteCOAInfo from lims_samples' coa_meta/company_logo_url columns
  + the ACTIVE verification code from the IS DB (v1.1.1 precedent:
  `integration_db.fetch_verification_codes_for_samples`, stored column as
  the no-code fallback). IS DB unavailable → EMPTY block +
  field_sources["coa"]="unavailable" (honest, never raises).
  chromatograph_background_url is not persisted in lims_samples → None.
- published_coa: ALWAYS None in mk1 mode. It describes SENAITE's ARReport
  artifact, which stays SENAITE-era until the section-5 COABuilder re-wire;
  field_sources["published_coa"]="senaite" says so honestly. (The Task-5
  parity harness classifies this as a known-expected diff.)
- senaite_url: None. The SENAITE deep link needs the client FOLDER id
  (e.g. 'client-8' in /clients/client-8/PB-0057); lims_samples stores
  ClientID/client_uid but not the folder path, so the link cannot be
  constructed without a SENAITE round-trip. field_sources tags it
  "unavailable" (link-out is a nicety, not a contract).
- cached_at: now-ISO (UTC) — no cache in the native path.

Resilience: never raises for missing sub-resources. No lims_samples row →
`registry_missing=True` with empty lists/None everywhere (remarks/analyses
helpers already return [] for unknown samples). The IS-DB block is the one
external call and is try/except-guarded as above; the missing-row path
skips it entirely (no registry row → nothing to overlay onto).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import LimsParentAttachment, LimsSample, LimsSampleRemark, User
from sub_samples.lookup_models import (
    RegistrySampleReadResult,
    SenaiteAnalysis,
    SenaiteAnalyte,
    SenaiteAttachment,
    SenaiteCOAInfo,
    SenaiteRemark,
)
from sub_samples.registry_read import registry_row_to_display

log = logging.getLogger(__name__)

# Every SenaiteLookupResult data field, tagged for the mk1 read mode.
# Deliberately an EXPLICIT literal (not derived from model_fields): adding a
# field to the response model must fail the completeness test and force an
# honest sourcing decision here, never silently inherit "mk1".
_MK1_FIELD_SOURCES: dict[str, str] = {
    "sample_id": "mk1",
    "sample_uid": "mk1",
    "client": "mk1",
    "contact": "mk1",
    "sample_type": "mk1",
    "date_received": "mk1",
    "date_sampled": "mk1",
    "profiles": "mk1",
    "client_order_number": "mk1",
    "client_sample_id": "mk1",
    "client_lot": "mk1",
    "review_state": "mk1",
    "declared_weight_mg": "mk1",
    "analytes": "mk1",
    "coa": "mk1",
    "remarks": "mk1",
    "analyses": "mk1",
    "attachments": "mk1",
    "published_coa": "senaite",   # SENAITE-era artifact — see module docstring
    "senaite_url": "unavailable",  # not constructible from stored fields
    "cached_at": "mk1",
}


def native_sample_remarks(db: Session, sample_id: str) -> list[SenaiteRemark]:
    """lims_sample_remarks → SenaiteRemark list (read-flip spec §6).

    Native in BOTH read modes: SENAITE's Remarks field is stale by design
    since the 2026-07-14 write flip. Backfilled rows carry the SENAITE login
    in author_label; Mk1-era rows resolve the users FK to "First Last",
    falling back to email.

    Moved verbatim from main.py (`_native_sample_remarks`) in Layer 4 /
    Task 2 so the builder can call it without a main import; main.py
    re-imports it under the old private name.
    """
    rows = db.execute(
        select(LimsSampleRemark, User)
        .outerjoin(User, LimsSampleRemark.author_user_id == User.id)
        .join(LimsSample, LimsSampleRemark.lims_sample_pk == LimsSample.id)
        .where(LimsSample.sample_id == sample_id.strip().upper())
        .order_by(LimsSampleRemark.created_at, LimsSampleRemark.id)
    ).all()
    out: list[SenaiteRemark] = []
    for remark, user in rows:
        label = remark.author_label
        if not label and user is not None:
            label = (f"{user.first_name or ''} {user.last_name or ''}".strip()
                     or user.email)
        out.append(SenaiteRemark(
            content=remark.content,
            user_id=label,
            created=(remark.created_at.isoformat()
                     if remark.created_at else None),
        ))
    return out


def analytes_from_registry_json(raw: Optional[str]) -> list[SenaiteAnalyte]:
    """lims_samples.analytes JSON → typed SenaiteAnalyte list.

    Registry shape (dual-write slice 1): a JSON list of
    `{"name": str, "declared_quantity": str|None}`, analyte slots in order,
    empty slots omitted. The typed model wants more than the registry
    stores — every default chosen here, explicitly:

    - `raw_name`: `str(entry["name"])` verbatim. The registry stores the
      display label (SENAITE's Analyte{N}Peptide title); no method-suffix
      stripping is applied because the registry writer already stores the
      bare label.
    - `slot_number` (required, no natural source): the 1-based POSITION in
      the stored list. The original SENAITE slot index is not persisted
      (empty slots are omitted at write time), so position is the best
      available approximation. A malformed entry is skipped but still
      consumes its position, so surviving entries keep stable slots.
    - `matched_peptide_id` / `matched_peptide_name`: None. senaite mode
      fuzzy-matches the raw name against the local peptides table at lookup
      time (main._fuzzy_match_peptide); the registry stores no match and
      this builder deliberately does not re-derive one (display-only field,
      and re-deriving would couple the builder to main's matcher).
    - `declared_quantity`: float() of the stored value when parseable
      (registry stores it as a string), else None.

    Malformed payloads are never an error: None/empty → [], unparseable
    JSON → [], non-list JSON → [], non-dict or name-less entries skipped.
    """
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    out: list[SenaiteAnalyte] = []
    for idx, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not name:
            continue
        declared: Optional[float] = None
        dq = entry.get("declared_quantity")
        if dq not in (None, ""):
            try:
                declared = float(dq)
            except (ValueError, TypeError):
                declared = None
        out.append(SenaiteAnalyte(
            raw_name=str(name),
            slot_number=idx + 1,
            declared_quantity=declared,
        ))
    return out


def _analyses_block(db: Session, sample_id: str) -> list[SenaiteAnalysis]:
    """Parent-tier analyses via the Task-1 listing, re-typed to the lookup
    shape. SenaiteShapeAnalysisResponse is field-compatible; its one extra
    field (promoted_to_parent_id) is dropped by pydantic's default
    extra='ignore'. Unknown sample → [] (the listing's own contract)."""
    from lims_analyses.service import list_parent_analyses_senaite_shape

    return [SenaiteAnalysis(**r.model_dump())
            for r in list_parent_analyses_senaite_shape(db, sample_id)]


def _attachments_block(db: Session, row: LimsSample) -> list[SenaiteAttachment]:
    """lims_parent_attachments rows → SenaiteAttachment list (Layer 3).

    uid: senaite_attachment_uid when the sweep adopted one, else the
    `mk1att:{id}` synthetic form (capture-time rows have no SENAITE uid).
    download_url routing:
    - storage='s3'      → the native download route (DB-typed headers)
    - storage='senaite' + uid → the existing /wizard/senaite/attachment proxy
    - storage='senaite' without an adopted uid → None (no reachable URL —
      the proxy needs a SENAITE uid; honest absence beats a dead link).
    """
    atts = db.execute(
        select(LimsParentAttachment)
        .where(LimsParentAttachment.lims_sample_pk == row.id)
        .order_by(LimsParentAttachment.created_at, LimsParentAttachment.id)
    ).scalars().all()
    out: list[SenaiteAttachment] = []
    for a in atts:
        if a.storage == "s3":
            download_url = (f"/registry/sample/{row.sample_id}"
                            f"/attachments/{a.id}/download")
        elif a.senaite_attachment_uid:
            download_url = f"/wizard/senaite/attachment/{a.senaite_attachment_uid}"
        else:
            download_url = None
        out.append(SenaiteAttachment(
            uid=a.senaite_attachment_uid or f"mk1att:{a.id}",
            filename=a.filename,
            content_type=a.content_type,
            attachment_type=a.attachment_type,
            download_url=download_url,
        ))
    return out


def _resolve_wp_url(raw: Optional[str]) -> Optional[str]:
    """Prepend the WordPress host to relative asset paths (mirrors main.py's
    resolve_wp_url in the senaite lookup — env-derived, zero HTTP)."""
    if not raw:
        return None
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    from integration_db import get_wordpress_host
    return get_wordpress_host().rstrip("/") + "/" + raw.lstrip("/")


def _coa_block(row: LimsSample) -> tuple[SenaiteCOAInfo, str]:
    """(SenaiteCOAInfo, field_source) for the sample.

    Meta (company name/email/website/address) from the coa_meta JSON column
    (verbatim SENAITE Coa* map, dual-write slice 1); logo from
    company_logo_url. Verification code per the v1.1.1 precedent: the IS DB
    is the authority (codes are REPLACED on COA regeneration), the stored
    lims_samples column is only the no-code fallback. IS DB unreachable →
    EMPTY block + "unavailable" (task-brief binding behavior, never raises).
    """
    try:
        from integration_db import fetch_verification_codes_for_samples
        codes = fetch_verification_codes_for_samples([row.sample_id])
    except Exception as exc:  # noqa: BLE001 — IS DB down must never raise
        log.warning("registry_details.coa_is_db_unavailable sample_id=%s err=%s",
                    row.sample_id, exc)
        return SenaiteCOAInfo(), "unavailable"

    meta: dict = {}
    if row.coa_meta:
        try:
            parsed = json.loads(row.coa_meta)
            if isinstance(parsed, dict):
                meta = parsed
        except (ValueError, TypeError):
            pass

    return SenaiteCOAInfo(
        company_logo_url=_resolve_wp_url(row.company_logo_url),
        chromatograph_background_url=None,  # not persisted in lims_samples
        company_name=meta.get("CoaCompanyName") or None,
        email=meta.get("CoaEmail") or None,
        website=meta.get("CoaWebsite") or None,
        address=meta.get("CoaAddress") or None,
        verification_code=codes.get(row.sample_id) or row.verification_code or None,
    ), "mk1"


def build_native_details(db: Session, sample_id: str) -> RegistrySampleReadResult:
    """Assemble the mk1-mode sample-details response. Zero SENAITE HTTP.

    See the module docstring for the per-field source matrix and defaults.
    """
    sid = sample_id.strip().upper()
    now_iso = datetime.now(timezone.utc).isoformat()
    field_sources = dict(_MK1_FIELD_SOURCES)

    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sid)
    ).scalar_one_or_none()

    # Native in both paths — the helpers return [] for unknown samples.
    remarks = native_sample_remarks(db, sid)
    analyses = _analyses_block(db, sid)

    if row is None:
        return RegistrySampleReadResult(
            sample_id=sid,
            analytes=[],
            coa=SenaiteCOAInfo(),
            remarks=remarks,
            analyses=analyses,
            attachments=[],
            published_coa=None,
            senaite_url=None,
            cached_at=now_iso,
            read_source="mk1",
            registry_missing=True,
            field_sources=field_sources,
        )

    display = registry_row_to_display(row)
    coa, coa_source = _coa_block(row)
    field_sources["coa"] = coa_source

    return RegistrySampleReadResult(
        sample_id=sid,
        sample_uid=row.external_lims_uid,
        client=display.get("client"),
        contact=display.get("contact"),
        sample_type=display.get("sample_type"),
        date_received=display.get("date_received"),
        date_sampled=display.get("date_sampled"),
        profiles=[],  # not persisted in lims_samples — missing → empty, still mk1
        client_order_number=display.get("client_order_number"),
        client_sample_id=display.get("client_sample_id"),
        client_lot=display.get("client_lot"),
        review_state=row.status,
        declared_weight_mg=display.get("declared_weight_mg"),
        analytes=analytes_from_registry_json(row.analytes),
        coa=coa,
        remarks=remarks,
        analyses=analyses,
        attachments=_attachments_block(db, row),
        published_coa=None,  # SENAITE-era artifact — module docstring
        senaite_url=None,    # not constructible from stored fields
        cached_at=now_iso,
        read_source="mk1",
        registry_missing=False,
        field_sources=field_sources,
    )
