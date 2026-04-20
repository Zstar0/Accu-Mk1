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

    def map_column_to_status(self, column_name: str) -> str | None:
        target = _normalize(column_name)
        for k, v in self.column_map.items():
            if _normalize(k) == target:
                return v
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
    )
