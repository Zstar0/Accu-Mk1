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
import os

from sqlalchemy import select

from coa.native_sections import NativeSectionsError

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


def _analyte_slots(parent) -> dict:
    """{'Analyte1Peptide': name, ...} for the first 4 list entries with a
    name. `lims_samples.analytes` is a JSON LIST of
    {"name": str, "declared_quantity": str|None}, slot = list position
    (1-based), empty slots omitted (models.py:1236-1238; written by
    sub_samples.service._parse_analyte_slots). Mirrors
    sub_samples.registry_inbox._analyte_slot_fields."""
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


def _newest(db, parent_pk: int, *, chromatogram: bool):
    from models import LimsParentAttachment as A
    q = select(A).where(A.lims_sample_pk == parent_pk, A.storage == "s3")
    if chromatogram:
        q = q.where(A.kind == "chromatogram")
    else:
        q = q.where(
            A.render_in_report.is_(True),
            (A.kind == "receive_image") | (A.attachment_type == "Sample Image"),
        )
    return db.execute(q.order_by(A.id.desc()).limit(1)).scalar_one_or_none()


def build_sample_meta(db, parent) -> dict:
    """Assemble the sample_meta wire block (spec §2). Fail-closed (R1): no
    SENAITE fallback -- a missing MK1_PUBLIC_BASE_URL, an empty
    sample_type_title, or no eligible native sample-image row all abort
    with NativeSectionsError (Ruling R-13 for the image case). A missing
    chromatogram is NOT fatal here -- micro-only samples legitimately have
    none; the generate-flow attachments gate is what enforces the
    per-sample chromatogram requirement.

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
    image_row = _newest(db, parent.id, chromatogram=False)
    if image_row is None:
        raise NativeSectionsError(
            f"sample_meta: {parent.sample_id} has no native sample image — "
            f"upload one or run the image backfill")

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
    meta.update(_analyte_slots(parent))

    attachments = []
    for role, row in (("sample_image", image_row),
                      ("chromatogram_csv", _newest(db, parent.id, chromatogram=True))):
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
