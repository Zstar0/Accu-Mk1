"""Lookup-shape Pydantic models for the sample-details read path.

Moved out of main.py (read-flip Layer 4 / Task 2) so the native details
builder (sub_samples/registry_details.py) can type its return value without
importing main (circular). main.py imports every name back verbatim, so all
existing references — response_model annotations, `main.SenaiteAnalyte`
attribute access in tests, isinstance checks — keep working unchanged.

The classes themselves are byte-identical to their main.py originals.
"""
from typing import Optional

from pydantic import BaseModel


class SenaiteAnalyte(BaseModel):
    raw_name: str
    slot_number: int  # 1-4, corresponding to Analyte1..Analyte4 in SENAITE
    matched_peptide_id: Optional[int] = None
    matched_peptide_name: Optional[str] = None
    declared_quantity: Optional[float] = None  # per-analyte declared qty (mg)


class SenaiteCOAInfo(BaseModel):
    company_logo_url: Optional[str] = None
    chromatograph_background_url: Optional[str] = None
    company_name: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    address: Optional[str] = None
    verification_code: Optional[str] = None


class SenaiteRemark(BaseModel):
    content: str  # HTML string from SENAITE
    user_id: Optional[str] = None
    created: Optional[str] = None


class SenaiteAnalysis(BaseModel):
    uid: Optional[str] = None
    keyword: Optional[str] = None
    title: str
    result: Optional[str] = None
    result_options: list[dict] = []  # [{value: str, label: str}] for selection-type analyses
    unit: Optional[str] = None
    method: Optional[str] = None
    method_uid: Optional[str] = None  # UID for editing
    method_options: list[dict] = []   # [{uid: str, title: str}] allowed methods for this analysis
    instrument: Optional[str] = None
    instrument_uid: Optional[str] = None  # UID for editing
    instrument_options: list[dict] = []   # [{uid: str, title: str}] allowed instruments for this analysis
    analyst: Optional[str] = None
    due_date: Optional[str] = None
    review_state: Optional[str] = None
    sort_key: Optional[float] = None
    captured: Optional[str] = None
    retested: bool = False
    # Mk1-local enrichment: which service_group this analysis belongs to
    # (resolved from analysis_services table by keyword). Drives the
    # per-vial "primary analysis" highlight on the sample detail page.
    service_group_id: Optional[int] = None
    service_group_name: Optional[str] = None


class SenaiteAttachment(BaseModel):
    uid: str
    filename: str
    content_type: Optional[str] = None
    attachment_type: Optional[str] = None  # e.g. "Sample Image", "HPLC Graph"
    download_url: Optional[str] = None  # proxied through our backend


class SenaitePublishedCOA(BaseModel):
    report_uid: str
    filename: str
    file_size_bytes: Optional[int] = None
    published_date: Optional[str] = None
    published_by: Optional[str] = None
    download_url: str  # proxied through our backend


class SenaiteLookupResult(BaseModel):
    sample_id: str
    sample_uid: Optional[str] = None
    client: Optional[str] = None
    contact: Optional[str] = None
    sample_type: Optional[str] = None
    date_received: Optional[str] = None
    date_sampled: Optional[str] = None
    profiles: list[str] = []
    client_order_number: Optional[str] = None
    client_sample_id: Optional[str] = None
    client_lot: Optional[str] = None
    review_state: Optional[str] = None
    declared_weight_mg: Optional[float] = None
    analytes: list[SenaiteAnalyte]
    coa: SenaiteCOAInfo = SenaiteCOAInfo()
    remarks: list[SenaiteRemark] = []
    analyses: list[SenaiteAnalysis] = []
    attachments: list[SenaiteAttachment] = []
    published_coa: Optional[SenaitePublishedCOA] = None
    senaite_url: Optional[str] = None  # e.g. "/clients/client-8/PB-0057"
    cached_at: Optional[str] = None  # ISO timestamp when this result was cached


class RegistrySampleReadResult(SenaiteLookupResult):
    """SenaiteLookupResult as served by the registry details endpoint.

    mk1 mode (read-flip L4): every field is native-sourced by
    sub_samples/registry_details.py's builder; field_sources covers the full
    response — 'mk1' (native), 'senaite' (SENAITE-era artifact not served
    natively yet, e.g. published_coa), or 'unavailable' (no native source,
    e.g. senaite_url). There is no per-field SENAITE fallback in mk1 mode."""
    read_source: str = "mk1"
    registry_missing: bool = False
    field_sources: dict[str, str] = {}
