"""sample_meta producer (COA read-independence, spec §2).

Envelope scalars carry the AR-blob key SPELLINGS coab's engines read, so the
consumer synthesizes its sample_json without touching the engines. Attachment
descriptors carry explicit roles + absolute S2S download URLs — coab never
walks a SENAITE attachment list. Fail-closed (R1): empty matrix, missing
MK1_PUBLIC_BASE_URL, or no eligible native sample-image row (Ruling R-13)
aborts assembly; a missing chromatogram is NOT fatal here (micro-only
samples legitimately lack one — see build_sample_meta's docstring);
storage!='s3' rows are invisible.

Twin contract: SAMPLE_META_SCALARS + ATTACHMENT_ROLES are byte-identical in
coabuilder src/coabuilder_core/sample_meta.py and pinned by
test_sample_meta_contract.py in BOTH repos. Move together.
"""
import json
import logging
import os
from pathlib import Path

from sqlalchemy import select

from coa.native_sections import NativeSectionsError

log = logging.getLogger(__name__)

SAMPLE_META_SCALARS = (
    "SampleID", "SampleTypeTitle", "ClientSampleID", "DateReceived",
    "DeclaredTotalQuantity", "ClientLot", "BatchID",
    "CoaCompanyName", "CoaEmail", "CoaWebsite", "CoaAddress",
    "CompanyLogoUrl", "ChromatographBackgroundUrl",
)
ATTACHMENT_ROLES = frozenset({"sample_image", "chromatogram_csv"})
BASE_URL_ENV = "MK1_PUBLIC_BASE_URL"


def _coa_meta(parent) -> dict:
    try:
        parsed = json.loads(parent.coa_meta) if parent.coa_meta else {}
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


def _analyte_slots(db, parent) -> dict:
    """{'Analyte1Peptide': name, ...} for the first 4 list entries with a
    name. `lims_samples.analytes` is a JSON LIST of
    {"name": str|None, "declared_quantity": str|None}, slot = list position
    (1-based) == SENAITE slot number; an empty middle slot is a name-less
    placeholder and is skipped here (models.py; written by
    sub_samples.service._parse_analyte_slots). Mirrors
    sub_samples.registry_inbox._analyte_slot_fields.

    Native-born parents (spec M7): the title comes from
    coa.hplc_shim.slot_wires instead of the stored (possibly stale/raw)
    label, so it is byte-identical to the Title legacy_rows puts on the
    identity row — the engine's Title == Analyte{N}Peptide match depends on
    it. An unresolved slot still falls through to its raw label here; the
    abort for that case belongs to legacy_rows, which runs in the same
    build_coa_wire_document call."""
    from coa.hplc_shim import slot_wires
    wires = slot_wires(db, parent)
    if wires:
        return {f"Analyte{w.slot}Peptide": w.identity_title for w in wires if w.slot <= 4}
    try:
        parsed = json.loads(parent.analytes) if parent.analytes else []
    except (ValueError, TypeError):
        return {}
    if not isinstance(parsed, list):
        return {}
    out = {}
    for slot, entry in enumerate(parsed[:4], start=1):
        name = (entry or {}).get("name") if isinstance(entry, dict) else None
        if name:
            out[f"Analyte{slot}Peptide"] = str(name)
    return out


def _newest(db, parent_pk: int, *, chromatogram: bool, source_sub_pks=None,
            or_unstamped: bool = False):
    """Newest eligible row; `source_sub_pks` (chromatogram only) narrows to
    rows linked to those vials via `source_sub_sample_pk`. With
    `or_unstamped` a row with no source qualifies as well, but a row stamped
    with any other vial never does."""
    from models import LimsParentAttachment as A
    q = select(A).where(A.lims_sample_pk == parent_pk, A.storage == "s3")
    if source_sub_pks is not None:
        linked = A.source_sub_sample_pk.in_(list(source_sub_pks))
        q = q.where((linked | A.source_sub_sample_pk.is_(None))
                    if or_unstamped else linked)
    if chromatogram:
        # kind='chromatogram' = the HPLC-prep push / Select-Vial flow. The
        # attachment_type arm (BW-0106, 2026-08-31) admits CSVs attached
        # manually from the sample page (kind='manual', SENAITE-typed
        # 'HPLC Graph'), symmetric with the image arm below. text/* only:
        # the coab wire role is chromatogram_csv and the renderer parses
        # CSV, so an image typed 'HPLC Graph' must not qualify. 'Sample
        # Image' is admitted too (P-1777, 2026-09-22): the May-2026 attach
        # flow filed chromatogram CSVs under that SENAITE type, and content
        # type, not the mirrored label, says what the file is. Twin of
        # main.py's _parent_attachment_kinds_native, keep in lockstep.
        q = q.where(
            (A.kind == "chromatogram")
            | (A.attachment_type.in_(("HPLC Graph", "Sample Image"))
               & A.content_type.ilike("text/%"))
        )
    else:
        # image/* only (P-1777, 2026-09-22): without this guard the newest
        # 'Sample Image'-typed row won even when it was a CSV, and coab drew
        # the CSV as the photo (blank frame) while the real jpeg was never
        # sent.
        q = q.where(
            A.render_in_report.is_(True),
            (A.kind == "receive_image") | (A.attachment_type == "Sample Image"),
            A.content_type.ilike("image/%"),
        )
    return db.execute(q.order_by(A.id.desc()).limit(1)).scalar_one_or_none()


def _materialize_vial_chromatogram(db, parent, vial):
    """Fallback for a vial with no stamped chromatogram row (P-5324,
    2026-10-19): the raw trace lives on the vial's own HPLC analysis as
    `chromatogram_data` ({times, signals}) and a pushed CSV is only a
    serialization of it. Take the newest analysis labelled EXACTLY
    `vial.sample_id` that carries both arrays, write its CSV as a
    chromatogram row stamped with the vial (same bytes, filename and kind the
    push routes write), commit, and return the row. Never a sibling's label
    and never the parent's newest row: no qualifying analysis means None and
    the caller fails closed as before. This is the one write in this module
    and it stays inside the vial branch. A writer failure propagates
    uncommitted, so no half-written row survives.
    """
    from models import HPLCAnalysis
    from hplc_csv import build_chromatogram_csv
    analyses = db.execute(
        select(HPLCAnalysis)
        .where(HPLCAnalysis.sample_id_label == vial.sample_id)
        .order_by(HPLCAnalysis.id.desc())
    ).scalars().all()
    analysis = next(
        (a for a in analyses
         if a.chromatogram_data and a.chromatogram_data.get("times")
         and a.chromatogram_data.get("signals")),
        None)
    if analysis is None:
        return None
    return _file_vial_row(
        db, parent, vial, file_bytes=build_chromatogram_csv(analysis),
        filename=f"chromatogram_{analysis.sample_id_label}.csv",
        content_type="text/csv", kind="chromatogram", render_in_report=False,
        attachment_type="HPLC Graph", origin=f"HPLC analysis {analysis.id}")


def _materialize_vial_photo(db, parent, vial):
    """Fallback for a vial with no stamped image row (P-5324, 2026-10-20:
    all four vial certificates printed vial 1's photo). The vial's own
    check-in photo lives in Mk1 storage under the `mk1://` key on
    `lims_sub_samples.photo_external_uid`; fetch those bytes and file them
    as a `vial_image` row stamped with the vial, the same shape the
    Select-Vial-Image copy writes. A missing, legacy (non mk1://) or
    non-image photo means None and the caller fails closed, never a
    sibling's photo. Writer rules as in `_file_vial_row`.
    """
    from sub_samples.photo_storage import (
        PhotoNotFoundError, _content_type_for_key, get_storage,
    )
    uid = vial.photo_external_uid or ""
    if not uid.startswith("mk1://"):
        return None
    key = uid[len("mk1://"):]
    content_type = _content_type_for_key(key)
    if not content_type.startswith("image/"):
        return None
    try:
        photo_bytes = get_storage().fetch_photo(key)
    except PhotoNotFoundError:
        return None
    return _file_vial_row(
        db, parent, vial, file_bytes=photo_bytes,
        filename=f"{vial.sample_id}-vial-photo{Path(key).suffix.lower()}",
        content_type=content_type, kind="vial_image", render_in_report=True,
        attachment_type="Sample Image", origin=f"vial photo {key}")


def _file_vial_row(db, parent, vial, *, file_bytes, filename, content_type,
                   kind, render_in_report, attachment_type, origin):
    """Write `file_bytes` as a parent-attachment row stamped with `vial`,
    commit, log one line and return it: the one write in this module. The
    writer dropping the stamp (lineage mismatch) rolls back and returns
    None so the caller fails closed; a storage or DB error propagates
    uncommitted, so no half-written row survives.
    """
    from main import write_parent_attachment  # lazy: main imports this module
    row = write_parent_attachment(
        db, parent, file_bytes=file_bytes, filename=filename,
        content_type=content_type, kind=kind,
        source_sample_id=vial.sample_id, user_id=None,
        render_in_report=render_in_report, attachment_type=attachment_type,
    )
    if row.source_sub_sample_pk != vial.id:
        db.rollback()
        return None
    db.commit()
    log.info("sample_meta: %s %s row %s materialized from %s for vial %s",
             parent.sample_id, kind, row.id, origin, vial.sample_id)
    return row


def _select_parent_row(db, parent, *, chromatogram: bool, materialize):
    """Parent-COA selection shared by chromatogram and image (P-5324 guard):
    the newest row stamped with a core HPLC vial; else the core vial's own
    source materialized via `materialize(db, parent, core_vial)` (core
    vials in vial_sequence order, first that qualifies wins); else
    NativeSectionsError (Handler ruling 2026-10-21: only the vial's own
    media, never a parent-level or another vial's row). A parent with no
    core HPLC vial keeps the plain newest rule and may return None.
    """
    from models import LimsSubSample
    what = "chromatogram" if chromatogram else "image"
    core_vials = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_role == "hplc",
            LimsSubSample.assignment_kind == "core",
        ).order_by(LimsSubSample.vial_sequence, LimsSubSample.id)
    ).scalars().all()
    core_ids = [v.id for v in core_vials]
    if core_ids:
        # Handler ruling 2026-10-21: a certificate uses ONLY its own vial's
        # chromatogram and photo. For the sample COA that vial is the core
        # HPLC vial: a row stamped with it, else its own source materialized,
        # else fail closed. Never an unstamped parent-level row, never another
        # vial's, never a guess.
        row = _newest(db, parent.id, chromatogram=chromatogram, source_sub_pks=core_ids)
        if row is not None:
            log.info("sample_meta: %s %s row %s picked by core-vial rule "
                     "(vial pk %s)", parent.sample_id, what, row.id,
                     row.source_sub_sample_pk)
            return row
        for core in core_vials:
            row = materialize(db, parent, core)
            if row is not None:
                log.info("sample_meta: %s %s row %s picked by core-vial "
                         "materialized rule (vial %s)", parent.sample_id,
                         what, row.id, core.sample_id)
                return row
        core = core_vials[0].sample_id
        if chromatogram:
            raise NativeSectionsError(
                f"No chromatogram is linked to core vial {core} of "
                f"{parent.sample_id}: push it from the vial's HPLC analysis, or "
                f"upload the CSV with that vial selected as the source.")
        raise NativeSectionsError(
            f"No vial photo is on file for core vial {core} of "
            f"{parent.sample_id}: retake it from the vial page, or upload the "
            f"photo with that vial selected as the source.")
    # No core HPLC vial (micro-only samples, vials never assigned): there is
    # no vial to read from, so the sample-level newest rule stands.
    row = _newest(db, parent.id, chromatogram=chromatogram)
    if row is not None:
        log.info("sample_meta: %s %s row %s picked by newest rule (no "
                 "core HPLC vial)", parent.sample_id, what, row.id)
    return row


def select_chromatogram_row(db, parent, *, vial=None):
    """The chromatogram row the certificate embeds (P-2627, 2026-09-14).

    Per-vial COA (`vial` given): ONLY a row linked to that vial
    (`source_sub_sample_pk`); none -> the vial's own HPLC-analysis trace is
    materialized as a stamped row (`_materialize_vial_chromatogram`, P-5324);
    no such analysis -> NativeSectionsError. Never a sibling's
    trace — vial 1's COA once printed vial 2's chromatogram because the
    parent's newest row was the only rule.

    Parent COA (`vial=None`): the core HPLC vial's own chromatogram, by the
    same rule as a vial COA (`_select_parent_row`); none -> NativeSectionsError.
    A parent with no core HPLC vial (micro-only samples) keeps the newest
    row on the parent and may return None.
    """
    if vial is not None:
        row = _newest(db, parent.id, chromatogram=True, source_sub_pks=[vial.id])
        if row is None:
            row = _materialize_vial_chromatogram(db, parent, vial)
        if row is None:
            raise NativeSectionsError(
                f"No chromatogram is linked to vial {vial.sample_id} — push it "
                f"from the vial's HPLC analysis, or upload the CSV with that "
                f"vial selected as the source.")
        log.info("sample_meta: %s chromatogram row %s picked by vial-linked "
                 "rule (vial %s)", parent.sample_id, row.id, vial.sample_id)
        return row
    return _select_parent_row(db, parent, chromatogram=True,
                              materialize=_materialize_vial_chromatogram)


def select_image_row(db, parent, *, vial=None):
    """The sample-image row the certificate embeds (P-5324, 2026-10-20).

    Per-vial COA (`vial` given): ONLY a row stamped with that vial; none ->
    the vial's own check-in photo is materialized as a stamped row
    (`_materialize_vial_photo`); no usable photo -> NativeSectionsError.
    Never a sibling's photo: all four P-5324 vial certificates printed
    vial 1's because the parent's newest image was the only rule.

    Parent COA (`vial=None`): the core HPLC vial's own photo
    (`_select_parent_row`); none -> NativeSectionsError. With no core HPLC
    vial the newest image on the parent stands; None still fails closed in
    build_sample_meta (Ruling R-13).
    """
    if vial is not None:
        row = _newest(db, parent.id, chromatogram=False, source_sub_pks=[vial.id])
        if row is None:
            row = _materialize_vial_photo(db, parent, vial)
        if row is None:
            raise NativeSectionsError(
                f"No vial photo is on file for {vial.sample_id}: retake it "
                f"from the vial page, or upload the photo with that vial "
                f"selected as the source.")
        log.info("sample_meta: %s image row %s picked by vial-linked rule "
                 "(vial %s)", parent.sample_id, row.id, vial.sample_id)
        return row
    return _select_parent_row(db, parent, chromatogram=False,
                              materialize=_materialize_vial_photo)


def _guard_unhonourable_reportable_flags(db, parent) -> None:
    """Fail closed when this sample carries a reportable de-selection mk1
    mode cannot apply (review 2026-08-29, finding 2).

    `analysis_reportable` is keyed by SENAITE analysis UID, but every
    mk1-mode candidate carries `uid="mk1:{id}"` (the shadow reader emits the
    Mk1 row id), so `coa.source_resolver._apply_reportable` can never match a
    sidecar row in this mode — the flag is silently dropped and a result the
    lab marked "not fit to report" becomes eligible again.

    Only `reportable=False` rows block: a `True` row merely restates the
    default, so ignoring it changes nothing. Scoped to this sample.

    This is the fail-closed stand-in for the real fix (give the flag a native
    home so it survives the read flip); it is inert on today's prod, which
    has zero sidecar rows.
    """
    from models import AnalysisReportable

    uids = db.execute(
        select(AnalysisReportable.analysis_uid).where(
            AnalysisReportable.sample_id == parent.sample_id,
            AnalysisReportable.reportable.is_(False),
        ).order_by(AnalysisReportable.analysis_uid)
    ).scalars().all()
    if uids:
        raise NativeSectionsError(
            f"sample_meta: {parent.sample_id} carries "
            f"{len(uids)} reportable de-selection(s) "
            f"({', '.join(uids)}) that mk1 mode cannot honour — the sidecar "
            f"is keyed by SENAITE analysis UID and native candidates are "
            f"not. Refusing to certify a sample whose excluded results "
            f"would silently reappear; generate this one in senaite mode or "
            f"clear the flag."
        )


def build_sample_meta(db, parent, *, vial=None) -> dict:
    """Assemble the sample_meta wire block (spec §2). Fail-closed (R1): no
    SENAITE fallback -- a missing MK1_PUBLIC_BASE_URL, an empty
    sample_type_title, or no eligible native sample-image row all abort
    with NativeSectionsError (Ruling R-13 for the image case). A missing
    chromatogram is NOT fatal here -- micro-only samples legitimately have
    none; the generate-flow attachments gate is what enforces the
    per-sample chromatogram requirement. `vial` (a LimsSubSample, per-vial
    COAs) makes the chromatogram and image selection vial-strict; see
    select_chromatogram_row and select_image_row.

    MK1_PUBLIC_BASE_URL mints the absolute S2S attachment URLs coab
    downloads. PREFERRED value: an origin coab reaches DIRECTLY --
    same-docker-network container origin, e.g. http://accu-mk1-backend:8012.
    If routed through the public nginx instead, the base MUST include the
    /api prefix (e.g. https://accumk1.valenceanalytical.com/api) --
    nginx.conf's `location /api/` rewrite strips /api before proxying to
    the backend, so a bare host base falls through to the SPA route
    (`location /`) and returns 200 + index.html for /s2s/... paths. coab's
    download guard currently trusts status 200 + a non-empty body, so a
    bare base SILENTLY corrupts every attachment (an HTML page saved as
    the "image"/"CSV") with no error anywhere. Do NOT reuse MK1_PUBLIC_URL
    or ACCUMK1_BASE_URL verbatim here -- both resolve to the SPA host
    without /api and land in this exact trap."""
    base = (os.environ.get(BASE_URL_ENV) or "").rstrip("/")
    if not base:
        raise NativeSectionsError(
            f"sample_meta: {BASE_URL_ENV} is not configured — cannot mint "
            f"attachment URLs; refusing to assemble (fail-closed)")
    if not (parent.sample_type_title or "").strip():
        raise NativeSectionsError(
            f"sample_meta: {parent.sample_id} has no sample_type_title — the "
            f"matrix selects the rendering engine; aborting")
    image_row = select_image_row(db, parent, vial=vial)
    if image_row is None:
        raise NativeSectionsError(
            f"sample_meta: {parent.sample_id} has no native sample image — "
            f"upload one or run the image backfill")
    _guard_unhonourable_reportable_flags(db, parent)

    from sub_samples.registry_details import _resolve_wp_url
    cm = _coa_meta(parent)
    lot = parent.client_lot or ""
    meta = {
        "source": "mk1",
        "SampleID": parent.sample_id,
        "SampleTypeTitle": parent.sample_type_title,
        "ClientSampleID": parent.client_sample_id or "",
        "DateReceived": parent.date_received.isoformat() if parent.date_received else "",
        "DeclaredTotalQuantity": parent.declared_total_quantity or "",
        "ClientLot": lot,
        "BatchID": lot,
        # (final review C1): lims_samples.coa_meta always carries ALL
        # _COA_META_FIELDS keys once a row has been through
        # sub_samples.service._merge_coa_meta (`{k: meta.get(k) for k in
        # _COA_META_FIELDS}`) -- a SENAITE payload that supplied nothing for
        # a Coa* field leaves the key PRESENT holding None, not absent.
        # `dict.get(k, "")` only substitutes the default for a MISSING key,
        # so it returned the stored None unchanged and rode the wire as JSON
        # null -- coab's non-nullable-scalar validator then 422s. `or ""`
        # coerces both "missing" and "present-but-None" to the empty string.
        "CoaCompanyName": cm.get("CoaCompanyName") or "",
        "CoaEmail": cm.get("CoaEmail") or "",
        "CoaWebsite": cm.get("CoaWebsite") or "",
        "CoaAddress": cm.get("CoaAddress") or "",
        "CompanyLogoUrl": _resolve_wp_url(parent.company_logo_url) or "",
        "ChromatographBackgroundUrl": _resolve_wp_url(cm.get("ChromatographBackgroundUrl")) or None,
    }
    meta.update(_analyte_slots(db, parent))

    attachments = []
    for role, row in (("sample_image", image_row),
                      ("chromatogram_csv", select_chromatogram_row(db, parent, vial=vial))):
        if row is not None:
            attachments.append({
                "role": role,
                "attachment_id": row.id,
                "filename": row.filename,
                "content_type": row.content_type,
                "url": f"{base}/s2s/samples/{parent.sample_id}/attachments/{row.id}",
            })
    meta["attachments"] = attachments
    return meta
