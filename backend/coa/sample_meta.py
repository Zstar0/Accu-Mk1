"""sample_meta producer (COA read-independence, spec §2).

Envelope scalars carry the AR-blob key SPELLINGS coab's engines read, so the
consumer synthesizes its sample_json without touching the engines. Attachment
descriptors carry explicit roles + absolute S2S download URLs — coab never
walks a SENAITE attachment list. Fail-closed (R1): empty matrix or missing
MK1_PUBLIC_BASE_URL aborts assembly; storage!='s3' rows are invisible.

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
    """{'Analyte1Peptide': label, ...} for slots 1..4 with a label."""
    try:
        slots = json.loads(parent.analytes) if parent.analytes else {}
    except (ValueError, TypeError):
        return {}
    out = {}
    if isinstance(slots, dict):
        for n in ("1", "2", "3", "4"):
            label = (slots.get(n) or {}).get("label") if isinstance(slots.get(n), dict) else None
            if label:
                out[f"Analyte{n}Peptide"] = label
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
    base = (os.environ.get(BASE_URL_ENV) or "").rstrip("/")
    if not base:
        raise NativeSectionsError(
            f"sample_meta: {BASE_URL_ENV} is not configured — cannot mint "
            f"attachment URLs; refusing to assemble (fail-closed)")
    if not (parent.sample_type_title or "").strip():
        raise NativeSectionsError(
            f"sample_meta: {parent.sample_id} has no sample_type_title — the "
            f"matrix selects the rendering engine; aborting")

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
        "CoaCompanyName": cm.get("CoaCompanyName", ""),
        "CoaEmail": cm.get("CoaEmail", ""),
        "CoaWebsite": cm.get("CoaWebsite", ""),
        "CoaAddress": cm.get("CoaAddress", ""),
        "CompanyLogoUrl": _resolve_wp_url(parent.company_logo_url) or "",
        "ChromatographBackgroundUrl": _resolve_wp_url(cm.get("ChromatographBackgroundUrl")) or None,
    }
    meta.update(_analyte_slots(parent))

    attachments = []
    for role, row in (("sample_image", _newest(db, parent.id, chromatogram=False)),
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
