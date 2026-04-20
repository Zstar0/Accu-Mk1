"""Config for peptide request feature."""
import os
from dataclasses import dataclass, field


DEFAULT_COLUMN_MAP = {
    "New": "new",
    "Approved": "approved",
    "Ordering Standard": "ordering_standard",
    "Sample Prep Created": "sample_prep_created",
    "In Process": "in_process",
    "On Hold": "on_hold",
    "Completed": "completed",
    "Rejected": "rejected",
    "Cancelled": "cancelled",
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
    )
