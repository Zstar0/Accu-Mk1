"""ClickUp API client for peptide requests."""
import requests
from backend.models_peptide_request import PeptideRequest


class ClickUpClient:
    def __init__(self, *, api_token: str, list_id: str, accumk1_base_url: str):
        self.api_token = api_token
        self.list_id = list_id
        self.accumk1_base_url = accumk1_base_url.rstrip("/")

    def _headers(self) -> dict:
        return {"Authorization": self.api_token, "Content-Type": "application/json"}

    def _build_description(self, r: PeptideRequest) -> str:
        lines = [
            "Submitted via WP.",
            "",
            f"**Customer:** {r.submitted_by_name} <{r.submitted_by_email}>",
            f"**Kind:** {r.compound_kind}",
            f"**Vendor/producer:** {r.vendor_producer}",
        ]
        if r.sequence_or_structure:
            lines.append(f"**Sequence/structure:** {r.sequence_or_structure}")
        if r.molecular_weight:
            lines.append(f"**Molecular weight:** {r.molecular_weight}")
        if r.cas_or_reference:
            lines.append(f"**CAS/reference:** {r.cas_or_reference}")
        if r.vendor_catalog_number:
            lines.append(f"**Vendor catalog #:** {r.vendor_catalog_number}")
        if r.expected_monthly_volume is not None:
            lines.append(f"**Expected monthly volume:** {r.expected_monthly_volume}")
        if r.reason_notes:
            lines.append(f"**Reason/notes:** {r.reason_notes}")
        lines.append("")
        lines.append(f"[Open in Accu-Mk1]({self.accumk1_base_url}/requests/{r.id})")
        return "\n".join(lines)

    def create_task_for_request(self, r: PeptideRequest) -> str:
        url = f"https://api.clickup.com/api/v2/list/{self.list_id}/task"
        body = {
            "name": f"[{r.compound_kind}] {r.compound_name} — {r.vendor_producer}",
            "description": self._build_description(r),
            "status": "New",
            "assignees": [],
            "priority": None,
        }
        resp = requests.post(url, headers=self._headers(), json=body, timeout=15)
        if resp.status_code >= 300:
            raise RuntimeError(f"ClickUp create failed: {resp.status_code} {resp.text}")
        return resp.json()["id"]
