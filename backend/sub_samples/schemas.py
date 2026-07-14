"""Pydantic schemas for sub-samples API."""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class CreateSubSampleRequest(BaseModel):
    parent_sample_id: str = Field(..., description="Parent SENAITE sample ID, e.g. 'P-0134'")
    photo_base64: str = Field(..., description="Photo as base64-encoded JPEG/PNG")
    remarks: Optional[str] = None


class UpdateSubSampleRequest(BaseModel):
    photo_base64: Optional[str] = None
    remarks: Optional[str] = None


class SubSampleResponse(BaseModel):
    id: int
    sample_id: str
    parent_sample_id: str
    vial_sequence: int
    received_at: datetime
    received_by_user_id: Optional[int]
    photo_external_uid: Optional[str]
    remarks: Optional[str]
    assignment_role: Optional[str] = None
    assignment_kind: Optional[str] = None
    # Provenance: 'mk1://...' for Model-D native vials (no SENAITE AR),
    # a SENAITE hex UID for legacy dual-written vials. Lets the frontend
    # load native vials from Mk1 without calling SENAITE.
    external_lims_uid: Optional[str] = None
    # FK to lims_boxes.id — which physical box this vial is assigned to, or
    # None when unboxed. Lets the boxing UI reflect server-side assignments.
    box_id: Optional[int] = None
    # Human box label ("BOX-<order#>-<box_number>", e.g. "BOX-3267-1"). Populated
    # by the LIST endpoint via a batched box lookup; single-item responses
    # leave it None (their callers key off box_id).
    box_label: Optional[str] = None
    # Receiver display name — who checked the vial in (and took its check-in
    # photo). Populated by the LIST endpoint via a batched user lookup;
    # single-item responses leave it None.
    received_by: Optional[str] = None

    class Config:
        from_attributes = True


class CreateBulkSubSamplesRequest(BaseModel):
    parent_sample_id: str = Field(..., description="Parent SENAITE sample ID, e.g. 'P-0134'")
    photo_base64: str = Field(
        ..., description="Photo as base64-encoded JPEG/PNG — one image, reused for every vial"
    )
    count: int = Field(..., ge=1, le=50, description="Number of identical vials to create (1..50)")
    remarks: Optional[str] = None


class BulkSubSampleResponse(BaseModel):
    """Result of a bulk create. `created` carries assignment_role=NULL until the
    caller refreshes the vial-plan. `failed` = requested - len(created) (>0 only
    on partial failure)."""
    created: list[SubSampleResponse]
    requested: int
    failed: int


class ParentSampleSummary(BaseModel):
    sample_id: str
    external_lims_uid: Optional[str]
    peptide_name: Optional[str]
    status: Optional[str]
    sub_sample_count: int
    last_synced_at: datetime
    assignment_role: Optional[str] = None
    # TRUE = container family: parent is a pure report depository, S01 is
    # Vial 1, no parent bench affordances (container-parent design).
    container_mode: bool = False
    # Customer-facing remarks delivered with the published COA.
    customer_remarks: Optional[str] = None
    # "Include with Publish?" + the Mk1-side delivery timestamp.
    customer_remarks_include: bool = True
    customer_remarks_delivered_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class CustomerRemarksUpdate(BaseModel):
    remarks: str
    include: bool = True


class SubSampleListResponse(BaseModel):
    parent: ParentSampleSummary
    sub_samples: list[SubSampleResponse]


class VialPlanItem(BaseModel):
    sample_id: str
    is_parent: bool
    vial_sequence: int
    assignment_role: Optional[str]
    # 'core' | 'variance' | None. Parent is always None (it has no kind —
    # it IS the canonical). Set by auto-assign / AssignStep drag.
    assignment_kind: Optional[str] = None


class VialPlanResponse(BaseModel):
    # Core (base) vial demand per bucket. Since the explicit-bucket model
    # (2026-06-10-variance-bucket-assignment-design.md) this equals base_demand
    # — the old max(base, n) inflation is retired; variance is a separate
    # bucket below. base_demand is kept alongside for FE compatibility.
    demand: dict
    # Per-bucket variance target (purchased count from the order/override);
    # zeros when none purchased. Informational — auto-assign fills core to
    # demand first, then the variance bucket up to this target. Never blocks.
    variance: dict = {"hplc": 0, "endo": 0, "ster": 0}
    base_demand: dict = {"hplc": 0, "endo": 0, "ster": 0}
    wp_order_number: Optional[str] = None
    vials: list[VialPlanItem]
    is_unreachable: bool = False
    # Container family: parent is a pure depository — `vials` contains no
    # parent entry when TRUE (legacy families list the parent first).
    container_mode: bool = False


class AssignmentPatchRequest(BaseModel):
    role: Optional[str]  # 'hplc' | 'endo' | 'ster' | 'xtra' | None
    kind: Optional[str] = None  # 'core' | 'variance' | None


class AggregatesRequest(BaseModel):
    parent_sample_ids: list[str] = Field(
        ..., min_length=1, max_length=500,
        description="Parent SENAITE sample IDs to look up aggregates for"
    )


class ParentAggregate(BaseModel):
    vial_count: int = Field(
        ...,
        description="Total vials = parent + sub-samples. Zero when the parent "
                    "has no sub-samples (single-vial samples aren't interesting "
                    "on the list page; UI renders a dash)."
    )
    parent_role: str = Field(
        ...,
        description="The parent AR's assignment_role. The list page renders "
                    "this badge on the parent row; sub-sample roles are shown "
                    "on expansion. Defaults to 'hplc' if NULL in the DB."
    )
    variance: dict[str, int] = Field(
        default_factory=lambda: {"hplc": 0, "endo": 0, "ster": 0},
        description="Per-bucket variance-vial counts (in addition to core "
                    "demand — additive-bucket contract) read from the parent's "
                    "variance_override. Zeros when none. "
                    "AR-list display hint — the authoritative gate is server-side "
                    "at sign-off (fail-closed).",
    )
    has_variance_subs: bool = Field(
        default=False,
        description="True when at least one sub-sample vial is assigned to the "
                    "variance bucket (assignment_kind='variance'). Drives the "
                    "list-page parent variance indicator independently of "
                    "entitlement (`variance`) — a parent can have variance vials "
                    "with no purchased override.",
    )


class AggregatesResponse(BaseModel):
    aggregates: dict[str, ParentAggregate] = Field(
        ...,
        description="Keyed by parent_sample_id. Sample IDs not present locally "
                    "(no row in lims_samples) are omitted from the response — "
                    "callers should treat absence as 'no sub-samples'."
    )


# ── Sub-sample image attachments (2026-06-11 design) ─────────────────────────

class SubSampleAttachmentResponse(BaseModel):
    id: int
    filename: str
    content_type: str
    created_at: datetime
    # Uploader display name ("First Last", email fallback). Populated by the
    # LIST endpoint via a batched user lookup; single-item responses leave it
    # None (mirrors the box_label pattern on SubSampleResponse).
    created_by: Optional[str] = None

    class Config:
        from_attributes = True


class SubSampleAttachmentListResponse(BaseModel):
    attachments: list[SubSampleAttachmentResponse]


class AddSubSampleAttachmentRequest(BaseModel):
    image_base64: str = Field(..., description="Image as base64 (data: URL prefix ok)")
    filename: str = Field(..., min_length=1, max_length=255)


# ── Variance set schemas (worksheet-variance design 2026-06-02) ──────────────

class VarianceVialResult(BaseModel):
    sample_id: str
    vial_sequence: int
    is_parent: bool
    in_variance_set: bool
    exclusion_reason: Optional[str] = None
    review_state: Optional[str] = None
    results: dict = {}  # keyword -> {value, kind, spec}


class VarianceStatsEntry(BaseModel):
    kind: str  # "numeric" | "categorical"
    mean: Optional[float] = None
    sd: Optional[float] = None
    cv_pct: Optional[float] = None
    n: int
    conforms_count: Optional[int] = None
    total: Optional[int] = None
    spec: Optional[dict] = None
    pass_: Optional[bool] = Field(default=None, alias="pass")

    class Config:
        populate_by_name = True


class VarianceSetResponse(BaseModel):
    parent: ParentSampleSummary
    vials: list[VarianceVialResult]
    stats: dict[str, VarianceStatsEntry]
    locked: bool
    locked_at: Optional[datetime] = None
    locked_by_user_id: Optional[int] = None


class PatchVarianceMembershipRequest(BaseModel):
    in_variance_set: bool
    exclusion_reason: Optional[str] = None


class VarianceEntitlementResponse(BaseModel):
    """Per-service variance-vial counts the parent's order purchased (n =
    variance vials in addition to the core/canonical — additive-bucket
    contract; display-only paid marker). Empty when none purchased;
    `unreachable` distinguishes 'none' from 'could not check'."""
    variance: dict[str, int]
    unreachable: bool


class VarianceOverrideRequest(BaseModel):
    """Lab-side per-service variance-vial counts (int >= 2; n = variance
    vials in addition to core — additive-bucket contract). None or {} clears
    the override."""
    variance: Optional[dict] = None


class OrderedProduct(BaseModel):
    key: str
    label: str
    is_addon: bool
    fulfillment_role: Optional[str] = None
    fulfillment_dim: str = "role"


class OrderedProductsResponse(BaseModel):
    sample_id: str
    wp_order_number: Optional[str] = None
    products: list[OrderedProduct]
