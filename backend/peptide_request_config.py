"""Config for peptide request feature."""
import os
from dataclasses import dataclass, field


# Maps ClickUp list column names (as they appear in the ClickUp webhook
# payload) to our internal peptide_request.status enum. Keys match the
# actual statuses on the sandbox list `testing_Peptide Requests` (list id
# 901713092705). `_normalize` lowercases + collapses whitespace before
# compare, so these keys are effectively case-insensitive.
#
# Two ClickUp columns ("verified" and "added to accumk") both map to our
# internal `completed` value. `verified` is the tech's signal that testing
# finished; `added to accumk` is a post-completion tracking-only state in
# ClickUp. Completion side-effects are idempotent, so the redundant
# mapping is safe.
#
# The internal enum still includes "approved" for the admin-set path in
# main.py (manual approval endpoint, not driven by ClickUp); no ClickUp
# column maps to it.
DEFAULT_COLUMN_MAP = {
    "requested": "new",
    "ordered": "ordering_standard",
    "received": "sample_prep_created",
    "analyzing": "in_process",
    "verified": "completed",
    "added to accumk": "completed",
    "on_hold": "on_hold",
    "rejected": "rejected",
    "cancelled": "cancelled",
}


def _normalize(s: str) -> str:
    return " ".join(s.split()).lower()


@dataclass
class PeptideRequestConfig:
    clickup_list_id: str
    clickup_api_token: str
    clickup_webhook_secret: str
    senaite_peptide_template_keyword: str = "BPC157-ID"
    senaite_clone_enabled: bool = False
    coupon_enabled: bool = False
    column_map: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_COLUMN_MAP))
    # Custom-field IDs for the ClickUp list (sandbox list 901713092705).
    # Each defaults to empty string; the ClickUp client treats empty as
    # "skip this field" so task-create/update never fails because a single
    # field id is missing from env. Fill via env vars to enable population.
    clickup_field_compound_kind: str = ""
    clickup_field_customer_email: str = ""
    clickup_field_vendor_producer: str = ""
    clickup_field_cas: str = ""
    clickup_field_accumk1_link: str = ""
    clickup_field_sample_id: str = ""
    # Dropdown option ids for the "Compound Kind" field. Required only if
    # clickup_field_compound_kind is populated. Same empty-string-as-skip
    # semantics apply per option.
    clickup_opt_compound_kind_peptide: str = ""
    clickup_opt_compound_kind_other: str = ""

    def map_column_to_status(self, column_name: str) -> str | None:
        target = _normalize(column_name)
        for k, v in self.column_map.items():
            if _normalize(k) == target:
                return v
        return None

    # ------------------------------------------------------------------
    # Reverse-mapping helpers used by the taskUpdated webhook branch and
    # the sync field_drift bucket.
    #
    # Inbound payloads reference custom fields by their UUID (never by
    # our column name), so the webhook dispatcher needs a way to go from
    # "here is the field that changed" back to "here is the DB column it
    # maps to". We keep the mapping inline (not a module-level dict)
    # because every field id lives on the config instance — the mapping
    # only exists once per config load.
    #
    # Unset field ids (empty string) never match: the `if field_id`
    # guard trips first, and an empty key wouldn't be useful to match on
    # anyway because every field id in a real payload is a non-empty
    # UUID.
    # ------------------------------------------------------------------
    def custom_field_id_to_column(self, field_id: str) -> str | None:
        """Reverse-map a ClickUp custom field UUID to the Accu-Mk1 column name.

        Returns None for unknown / unconfigured field ids so callers can
        treat them as "not one of ours" without branching on the specific
        mapping shape.
        """
        if not field_id:
            return None
        mapping = {
            self.clickup_field_sample_id:       "sample_id",
            self.clickup_field_cas:             "cas_or_reference",
            self.clickup_field_vendor_producer: "vendor_producer",
            self.clickup_field_customer_email:  "submitted_by_email",
            self.clickup_field_compound_kind:   "compound_kind",
        }
        # Drop unset keys (empty string) so a missing-from-env field id
        # never accidentally matches an empty lookup.
        mapping.pop("", None)
        return mapping.get(field_id)

    def compound_kind_option_to_value(self, option_id: str) -> str | None:
        """Reverse-map a Compound Kind dropdown option UUID to 'peptide' / 'other'.

        Mirrors the forward mapping in ClickUpClient._build_custom_fields
        where we pick an option id based on the column value. Returns
        None for unknown / unconfigured option ids.
        """
        if not option_id:
            return None
        if option_id == self.clickup_opt_compound_kind_peptide:
            return "peptide"
        if option_id == self.clickup_opt_compound_kind_other:
            return "other"
        return None


def _require(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise RuntimeError(f"{key} is required")
    return v


def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def get_config() -> PeptideRequestConfig:
    return PeptideRequestConfig(
        clickup_list_id=_require("CLICKUP_LIST_ID"),
        clickup_api_token=_require("CLICKUP_API_TOKEN"),
        clickup_webhook_secret=_require("CLICKUP_WEBHOOK_SECRET"),
        senaite_peptide_template_keyword=os.environ.get(
            "SENAITE_PEPTIDE_TEMPLATE_KEYWORD", "BPC157-ID"
        ),
        senaite_clone_enabled=_parse_bool(
            os.environ.get("PEPTIDE_SENAITE_CLONE_ENABLED"), default=False
        ),
        coupon_enabled=_parse_bool(
            os.environ.get("PEPTIDE_COUPON_ENABLED"), default=False
        ),
        # Custom-field IDs — all optional; empty string means "skip this field".
        clickup_field_compound_kind=os.environ.get(
            "CLICKUP_FIELD_COMPOUND_KIND", ""
        ),
        clickup_field_customer_email=os.environ.get(
            "CLICKUP_FIELD_CUSTOMER_EMAIL", ""
        ),
        clickup_field_vendor_producer=os.environ.get(
            "CLICKUP_FIELD_VENDOR_PRODUCER", ""
        ),
        clickup_field_cas=os.environ.get("CLICKUP_FIELD_CAS", ""),
        clickup_field_accumk1_link=os.environ.get(
            "CLICKUP_FIELD_ACCUMK1_LINK", ""
        ),
        clickup_field_sample_id=os.environ.get("CLICKUP_FIELD_SAMPLE_ID", ""),
        clickup_opt_compound_kind_peptide=os.environ.get(
            "CLICKUP_OPT_COMPOUND_KIND_PEPTIDE", ""
        ),
        clickup_opt_compound_kind_other=os.environ.get(
            "CLICKUP_OPT_COMPOUND_KIND_OTHER", ""
        ),
    )
