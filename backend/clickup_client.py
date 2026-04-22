"""ClickUp API client for peptide requests."""
import requests
from typing import Optional
from models_peptide_request import PeptideRequest
from peptide_request_config import PeptideRequestConfig, get_config


class ClickUpClient:
    def __init__(
        self,
        *,
        api_token: str,
        list_id: str,
        accumk1_base_url: str,
        config: Optional[PeptideRequestConfig] = None,
    ):
        self.api_token = api_token
        self.list_id = list_id
        self.accumk1_base_url = accumk1_base_url.rstrip("/")
        # Lazy-load config for custom-field IDs. Callers may pass an
        # explicit config (tests, or code that already has one); otherwise
        # we resolve via get_config() on first use. We do NOT call get_config
        # eagerly here because it raises when required env vars are missing,
        # and some test paths construct the client with fake tokens but no
        # env. Deferred resolution keeps those paths working.
        self._config = config

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
        if r.molecular_weight is not None:
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

    def list_tasks(
        self,
        *,
        include_closed: bool = True,
        include_subtasks: bool = False,
    ) -> list[dict]:
        """Fetch every task on ``self.list_id`` as a flat list.

        ClickUp v2 paginates list/{list_id}/task with a 0-indexed ``page``
        query param and signals the last page via ``last_page=True`` in the
        response body. We loop until that flag fires (or until we've pulled
        a pathological 50 pages, as a belt-and-suspenders guard against an
        API that forgets to flip the flag).

        ``include_closed=True`` is the safe default for the sync-diff use
        case: we need to see tasks in terminal columns (REJECTED, CANCELLED,
        ADDED TO ACCUMK) so we don't flag the corresponding DB rows as
        "in Accu-Mk1, not in ClickUp" and accidentally retire them.

        Returns the raw task dicts unchanged — callers (compute_diff) pluck
        whatever nested shape they need (status, creator, url, etc.). No
        projection here keeps the client generic; the sync module owns
        the view-model.
        """
        url = f"https://api.clickup.com/api/v2/list/{self.list_id}/task"
        out: list[dict] = []
        page = 0
        # Hard upper bound prevents an infinite loop if ClickUp ever
        # regresses on last_page. 50 * ~100 tasks/page = 5000 tasks;
        # well beyond the sandbox list's size.
        while page < 50:
            params = {
                "page": page,
                "include_closed": "true" if include_closed else "false",
                "subtasks": "true" if include_subtasks else "false",
            }
            resp = requests.get(
                url, headers=self._headers(), params=params, timeout=15
            )
            if resp.status_code >= 300:
                raise RuntimeError(
                    f"ClickUp list_tasks failed: {resp.status_code} {resp.text}"
                )
            body = resp.json()
            out.extend(body.get("tasks", []) or [])
            if body.get("last_page", True):
                break
            page += 1
        return out

    def get_task(self, task_id: str) -> dict:
        """Fetch a task detail payload from ClickUp.

        Used by the taskCreated webhook branch: the inbound webhook gives us
        a task id, but we need name/status/creator/etc. to materialize a
        peptide_requests row. Returns the raw JSON dict from ClickUp so the
        caller can pluck whatever nested shape it needs (e.g. status.status,
        creator.username, creator.id).
        """
        url = f"https://api.clickup.com/api/v2/task/{task_id}"
        resp = requests.get(url, headers=self._headers(), timeout=15)
        if resp.status_code >= 300:
            raise RuntimeError(f"ClickUp get_task failed: {resp.status_code} {resp.text}")
        return resp.json()

    def _resolve_config(self) -> Optional[PeptideRequestConfig]:
        """Return a config or None. Suppresses RuntimeError from missing
        required env so create_task_for_request never fails because we
        couldn't resolve optional custom-field IDs."""
        if self._config is not None:
            return self._config
        try:
            self._config = get_config()
        except Exception:
            self._config = None
        return self._config

    def _build_custom_fields(self, r: PeptideRequest) -> list[dict]:
        """Build the custom_fields array for task create. Skips any field
        whose ID is empty in config (graceful degrade). Skips individual
        fields whose source data is None/empty so we don't push empty
        strings into ClickUp for values the user never provided.
        """
        cfg = self._resolve_config()
        if cfg is None:
            return []
        fields: list[dict] = []

        # Compound Kind is a dropdown — value is the option id, not the string.
        if cfg.clickup_field_compound_kind:
            option_id = ""
            if r.compound_kind == "peptide":
                option_id = cfg.clickup_opt_compound_kind_peptide
            elif r.compound_kind == "other":
                option_id = cfg.clickup_opt_compound_kind_other
            if option_id:
                fields.append(
                    {"id": cfg.clickup_field_compound_kind, "value": option_id}
                )

        if cfg.clickup_field_customer_email and r.submitted_by_email:
            fields.append(
                {
                    "id": cfg.clickup_field_customer_email,
                    "value": r.submitted_by_email,
                }
            )
        if cfg.clickup_field_vendor_producer and r.vendor_producer:
            fields.append(
                {
                    "id": cfg.clickup_field_vendor_producer,
                    "value": r.vendor_producer,
                }
            )
        if cfg.clickup_field_cas and r.cas_or_reference:
            fields.append(
                {"id": cfg.clickup_field_cas, "value": r.cas_or_reference}
            )
        if cfg.clickup_field_accumk1_link and self.accumk1_base_url:
            fields.append(
                {
                    "id": cfg.clickup_field_accumk1_link,
                    "value": f"{self.accumk1_base_url}/requests/{r.id}",
                }
            )
        return fields

    def create_task_for_request(self, r: PeptideRequest) -> str:
        url = f"https://api.clickup.com/api/v2/list/{self.list_id}/task"
        # No `status` — ClickUp defaults to the list's initial (open-type)
        # column. Keeps this client decoupled from the lab's column
        # naming in ClickUp; the webhook-side column_map handles the
        # reverse translation when status changes come back.
        body = {
            "name": f"[{r.compound_kind}] {r.compound_name} — {r.vendor_producer}",
            "description": self._build_description(r),
            "assignees": [],
            "priority": None,
        }
        custom_fields = self._build_custom_fields(r)
        if custom_fields:
            body["custom_fields"] = custom_fields
        resp = requests.post(url, headers=self._headers(), json=body, timeout=15)
        if resp.status_code >= 300:
            raise RuntimeError(f"ClickUp create failed: {resp.status_code} {resp.text}")
        return resp.json()["id"]

    def set_custom_field(self, task_id: str, field_id: str, value) -> None:
        """Set a single custom field on an existing task. Used for fields
        that are edited after task creation (e.g. sample_id). Raises on
        non-2xx so callers can log and surface a sync warning to the UI.
        """
        url = f"https://api.clickup.com/api/v2/task/{task_id}/field/{field_id}"
        resp = requests.post(
            url, headers=self._headers(), json={"value": value}, timeout=15
        )
        if resp.status_code >= 300:
            raise RuntimeError(
                f"ClickUp set_custom_field failed: {resp.status_code} {resp.text}"
            )

    def post_task_comment(self, task_id: str, comment_text: str, timeout: int = 2) -> None:
        """Post a comment on an existing ClickUp task.

        Used for low-priority breadcrumbs (e.g. customer retractions) where
        failure is acceptable. Short timeout + raise-on-non-2xx so callers
        can log-and-continue. `notify_all=False` keeps the comment quiet.
        """
        url = f"https://api.clickup.com/api/v2/task/{task_id}/comment"
        body = {"comment_text": comment_text, "notify_all": False}
        resp = requests.post(url, headers=self._headers(), json=body, timeout=timeout)
        if resp.status_code >= 300:
            raise RuntimeError(
                f"ClickUp post_task_comment failed: {resp.status_code} {resp.text}"
            )

    def set_task_status(self, task_id: str, status: str, timeout: int = 2) -> None:
        """Programmatically move a ClickUp task to a named column.

        Used for low-priority state changes (e.g., parking retracted requests
        in the RETRACTED column). Short timeout + raise-on-non-2xx so callers
        can log-and-continue. Status name must match an existing column on the
        list (case-insensitive per ClickUp).
        """
        url = f"https://api.clickup.com/api/v2/task/{task_id}"
        resp = requests.put(
            url,
            headers=self._headers(),
            json={"status": status},
            timeout=timeout,
        )
        if resp.status_code >= 300:
            raise RuntimeError(
                f"ClickUp set_task_status failed: {resp.status_code} {resp.text}"
            )
