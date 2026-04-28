"""SENAITE adapter for AnalysisRequestSecondary creation/upload/fetch/delete.

Verified payload shape: docs/developer/senaite-secondary-api.md (Task 1).

Critical contract — keep in sync with that doc:
  * Field names are PascalCase (PrimaryAnalysisRequest, SampleType, Contact).
  * portal_type, NOT type.
  * Client and date fields MUST NOT be sent — SENAITE overrides.
  * Bad PrimaryAnalysisRequest UID returns 200 with a normal AR — silent
    fallthrough. Caller validates `^<parent_id>-S\\d{2}$`.
  * The list endpoint cannot filter by parent UID — use search?q=<parent_id>.
  * Photo upload is an HTML form (CSRF preflight + multipart POST), not JSON.
"""
import os
import re
import logging
from dataclasses import dataclass
from typing import Optional, List
import requests

log = logging.getLogger(__name__)

SENAITE_BASE_URL = os.environ.get("SENAITE_BASE_URL", "http://localhost:8080/senaite")
SENAITE_USER = os.environ.get("SENAITE_USER", "admin")
SENAITE_PASSWORD = os.environ.get("SENAITE_PASSWORD", "admin")


class SecondaryFalloutError(RuntimeError):
    """Raised when SENAITE silently created a normal AR instead of a secondary
    (because the PrimaryAnalysisRequest UID was bad). The orphan AR has been
    cleaned up before this is raised."""


@dataclass
class SecondaryCreateResult:
    uid: str
    sample_id: str
    path: str  # e.g. "/senaite/clients/client-8/P-0134-S01" — needed for upload_photo


def _post_json(url: str, **kwargs) -> requests.Response:
    return requests.post(url, auth=(SENAITE_USER, SENAITE_PASSWORD), timeout=30, **kwargs)


def _get(url: str, **kwargs) -> requests.Response:
    return requests.get(url, auth=(SENAITE_USER, SENAITE_PASSWORD), timeout=30, **kwargs)


def create_secondary(
    parent_sample_id: str,
    parent_uid: str,
    client_uid: str,
    contact_uid: Optional[str],
    sample_type_uid: str,
) -> SecondaryCreateResult:
    """Create an AnalysisRequestSecondary. Validates id matches `<parent>-S<NN>`
    and raises SecondaryFalloutError (with orphan cleanup) if not."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/create"
    payload = {
        "portal_type": "AnalysisRequest",
        "parent_uid": client_uid,
        "PrimaryAnalysisRequest": parent_uid,
        "SampleType": sample_type_uid,
    }
    if contact_uid:
        payload["Contact"] = contact_uid
    resp = _post_json(url, json=payload)
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE create_secondary failed ({resp.status_code}): {resp.text}")

    body = resp.json()
    items = body.get("items") or []
    if not items:
        raise RuntimeError(f"SENAITE create_secondary returned no items: {body}")
    item = items[0]
    new_uid, new_id = item["uid"], item["id"]
    new_path = item.get("path", "")

    expected = re.compile(rf"^{re.escape(parent_sample_id)}-S\d{{2}}$")
    if not expected.match(new_id):
        log.error(
            "sub_samples.silent_fallthrough parent=%s expected_pattern=%s got_id=%s",
            parent_sample_id, expected.pattern, new_id,
        )
        try:
            delete_secondary(new_uid)
        except Exception as e:
            log.error("sub_samples.orphan_cleanup_failed uid=%s err=%s", new_uid, e)
        raise SecondaryFalloutError(
            f"SENAITE silently created a normal AR ({new_id}) instead of a secondary of "
            f"{parent_sample_id}. Likely cause: bad PrimaryAnalysisRequest UID. Orphan deleted."
        )

    return SecondaryCreateResult(uid=new_uid, sample_id=new_id, path=new_path)


def upload_photo(secondary_path: str, photo_bytes: bytes, filename: str = "vial.jpg") -> None:
    """Upload a photo as a SENAITE attachment via the HTML form flow.

    Mirrors the existing primary-sample upload at backend/main.py:10912-10950
    (read that as the canonical reference). The JSON API does NOT have a clean
    attachment route for ARs; we have to drive the HTML view.

    secondary_path is the full SENAITE path returned in the create response,
    e.g. "/senaite/clients/client-8/P-0134-S01".
    """
    # SENAITE_BASE_URL is e.g. "http://host/senaite"; secondary_path starts
    # with "/senaite/...". Strip the trailing "/senaite" from the base so we
    # don't double it when concatenating with the path.
    base_root = SENAITE_BASE_URL.rstrip("/")
    if base_root.endswith("/senaite"):
        base_root = base_root[: -len("/senaite")]
    page_url = f"{base_root}{secondary_path}"

    # 1. Preflight: GET the AR detail page to scrape the CSRF token and the
    #    "Sample Image" AttachmentType UID.
    detail = _get(page_url)
    if detail.status_code >= 300:
        raise RuntimeError(
            f"SENAITE upload_photo preflight failed ({detail.status_code}): {detail.text[:200]}"
        )

    auth_match = re.search(r'name="_authenticator"\s+value="([^"]+)"', detail.text)
    if not auth_match:
        raise RuntimeError("SENAITE upload_photo: could not scrape _authenticator from AR page")
    authenticator = auth_match.group(1)

    # AttachmentType UID is on the same page in the attachments form. Pattern
    # is roughly <select name="AttachmentType:list">...<option value="UID">Sample Image</option>...
    type_match = re.search(
        r'<option[^>]+value="([^"]+)"[^>]*>\s*Sample Image\s*</option>',
        detail.text,
    )
    if not type_match:
        # Fall back to any first option — most setups have only Sample Image
        # configured for AR attachments.
        type_match = re.search(
            r'name="AttachmentType:list"[^>]*>.*?<option[^>]+value="([^"]+)"',
            detail.text,
            re.DOTALL,
        )
    if not type_match:
        raise RuntimeError("SENAITE upload_photo: could not find Sample Image AttachmentType UID")
    attachment_type_uid = type_match.group(1)

    # 2. POST multipart form-data
    form_url = f"{page_url}/@@attachments_view/add"
    form = {
        "submitted": "1",
        "_authenticator": authenticator,
        "AttachmentType": attachment_type_uid,
        "Analysis": "",
        "AttachmentKeys": "",
        "RenderInReport:boolean": "True",
        "RenderInReport:boolean:default": "False",
        "addARAttachment": "Add Attachment",
    }
    files = {"AttachmentFile_file": (filename, photo_bytes, "image/jpeg")}
    upload_resp = requests.post(
        form_url,
        data=form,
        files=files,
        auth=(SENAITE_USER, SENAITE_PASSWORD),
        timeout=60,
        allow_redirects=False,
    )
    if upload_resp.status_code not in (200, 301, 302):
        raise RuntimeError(
            f"SENAITE upload_photo failed ({upload_resp.status_code}): {upload_resp.text[:200]}"
        )


def update_remarks(secondary_uid: str, remarks: str) -> None:
    """Update Remarks via the JSON API.

    Verified shape (Task 5 spike, 2026-04-27):
      POST /@@API/senaite/v1/update  body: {"uid": ..., "Remarks": ...}
      → 200 with `success: true` when the AR has all required fields populated.

    Sharp edge: the /update route validates the FULL AR schema, not just the
    fields you send. If the AR is missing a required field (e.g. Contact —
    secondaries created without one), the call returns HTTP 400 with
    `{"Contact": "Contact is required, please correct."}` BUT the Remarks
    side-effect still applies (Remarks accumulate as a list). We treat HTTP
    >=300 as failure here; callers must ensure secondaries are created with
    a Contact so this stays clean.
    """
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/update"
    resp = _post_json(url, json={"uid": secondary_uid, "Remarks": remarks})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE update_remarks failed ({resp.status_code}): {resp.text}")
    body = resp.json()
    if not body.get("items") or body.get("success") is False:
        raise RuntimeError(f"SENAITE update_remarks returned no items: {body}")


def delete_secondary(secondary_uid: str) -> None:
    """Delete via the JSON API.

    Verified shape (Task 5 spike, 2026-04-27):
      POST /@@API/senaite/v1/delete  body: {"uid": ...}
      → ALWAYS HTTP 200, success determined by body `success` field.

    Sharp edge: the /delete route maps to the `deactivate` workflow
    transition. For ARs already past `sample_due` (e.g. `sample_received`,
    `to_be_verified`) the transition is invalid and SENAITE returns:
      {"success": false, "message": "Failed to perform transition 'deactivate'..."}
    A freshly silent-fallthrough orphan is in `sample_received` (auto-received
    from primary's date), so this cleanup path WILL fail in practice. The
    orphan must then be cancelled/removed manually from the SENAITE UI. We
    log loudly and surface the failure so reconciliation can flag it.
    """
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/delete"
    resp = _post_json(url, json={"uid": secondary_uid})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE delete_secondary failed ({resp.status_code}): {resp.text}")
    body = resp.json()
    if body.get("success") is False:
        raise RuntimeError(
            f"SENAITE delete_secondary returned success=false: {body.get('message')}"
        )


def fetch_parent_metadata(parent_sample_id: str) -> dict:
    """Fetch parent AR metadata for lazy upsert into lims_samples.

    Two-step: id-lookup → uid-lookup with `?complete=true` (the list form
    returns a minimal projection)."""
    list_url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest"
    resp = _get(list_url, params={"id": parent_sample_id})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE fetch_parent failed ({resp.status_code}): {resp.text}")
    items = resp.json().get("items", [])
    if not items:
        raise RuntimeError(f"SENAITE has no AR with id={parent_sample_id}")
    parent_uid = items[0]["uid"]

    detail_url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest/{parent_uid}"
    resp = _get(detail_url, params={"complete": "true"})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE fetch_parent detail failed ({resp.status_code}): {resp.text}")
    detail_items = resp.json().get("items", [])
    if not detail_items:
        raise RuntimeError(f"SENAITE detail empty for uid={parent_uid}")
    return detail_items[0]


def fetch_secondaries(parent_sample_id: str) -> List[dict]:
    """Fetch all secondaries for a parent. The list endpoint can NOT filter
    by parent UID — use SearchableText `q=<parent_id>` and filter client-side
    for `<parent_id>-SNN`."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/search"
    resp = _get(url, params={"portal_type": "AnalysisRequest", "q": parent_sample_id})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE fetch_secondaries failed ({resp.status_code}): {resp.text}")
    pattern = re.compile(rf"^{re.escape(parent_sample_id)}-S\d{{2}}$")
    return [it for it in resp.json().get("items", []) if pattern.match(it.get("id", ""))]
