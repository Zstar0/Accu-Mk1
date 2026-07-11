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
from typing import Optional, List, Any, Iterator, Tuple
import requests

log = logging.getLogger(__name__)

# Project convention: SENAITE_URL points at the Plone host (e.g.
# "http://senaite:8080" inside the docker network). The Plone site is mounted
# at /senaite, so all REST routes start with /senaite/@@API/...
# SENAITE_BASE_URL retained as an explicit override for tests and unusual setups.
_SENAITE_HOST = os.environ.get("SENAITE_URL", "http://localhost:8080").rstrip("/")
SENAITE_BASE_URL = os.environ.get("SENAITE_BASE_URL", f"{_SENAITE_HOST}/senaite")
SENAITE_USER = os.environ.get("SENAITE_USER", "admin")
SENAITE_PASSWORD = os.environ.get("SENAITE_PASSWORD", "admin")


class SecondaryFalloutError(RuntimeError):
    """Raised when SENAITE silently created a normal AR instead of a secondary.
    The orphan AR may or may not have been cleaned up — orphan_uid is provided
    so callers can surface it for manual cleanup in SENAITE UI."""

    def __init__(self, message: str, orphan_uid: str = "", orphan_sample_id: str = ""):
        super().__init__(message)
        self.orphan_uid = orphan_uid
        self.orphan_sample_id = orphan_sample_id


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
            f"{parent_sample_id}. Orphan cleanup may have failed — manual cleanup in "
            f"SENAITE UI may be required.",
            orphan_uid=new_uid,
            orphan_sample_id=new_id,
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


def fetch_parent_analyses(sample_id: str) -> List[dict]:
    """ONE throttled SENAITE Analysis-catalog query for every analysis line
    on a parent AR. Shared by `backfill_parent_analysis_shadows.py` and the
    registry-inspect debug panel's analyses column (main.py) — same endpoint
    + params + field-extraction shape as `coa.source_resolver
    .SenaiteAnalysesHttpReader.list_for_sample` (sync via `_get` rather than
    an async httpx client), plus two additions those callers need that the
    COA reader doesn't:

      * `instrument_uid` — the SENAITE Analysis catalog carries the
        instrument as a nested `Instrument` object ref ({"uid": ..., "title":
        ...}), the same shape main.py's AR-detail analyses fetch reads at
        ~12504-12510. Only the uid is extracted; None when absent.
      * `created` — best-effort creation timestamp for newest-line selection
        when a keyword has more than one non-superseded line (should not
        normally happen outside a retest chain, but the fallback exists so
        selection is deterministic instead of order-dependent). Falls back
        through the same field-name variants main.py's report-date code uses
        elsewhere (`created`/`creation_date`/`DateCreated`/`getDateCreated`);
        None when the catalog brain carries none of them (falls back to
        last-in-list — see `lims_analyses.parent_mirror.select_current_lines`).

    Raises RuntimeError on a non-2xx SENAITE response — callers wrap this in
    their own best-effort try/except, never letting one parent's failure
    abort a wider run or blank an unrelated panel section."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/Analysis"
    resp = _get(url, params={"getRequestID": sample_id, "complete": "yes", "limit": 200})
    if resp.status_code >= 300:
        raise RuntimeError(f"SENAITE fetch_parent_analyses failed ({resp.status_code}): {resp.text}")
    items = resp.json().get("items", []) or []
    out: List[dict] = []
    for it in items:
        instrument_obj = it.get("Instrument")
        instrument_uid = instrument_obj.get("uid") if isinstance(instrument_obj, dict) else None
        out.append({
            "uid": it.get("uid"),
            "keyword": it.get("getKeyword") or it.get("Keyword"),
            "result": it.get("Result"),
            "unit": it.get("Unit"),
            "review_state": it.get("review_state"),
            "retest_of_uid": (
                it.get("getRetestOfUID")
                or (it.get("RetestOf") or {}).get("uid")
                or None
            ),
            "instrument_uid": instrument_uid,
            "created": (
                it.get("created") or it.get("creation_date")
                or it.get("DateCreated") or it.get("getDateCreated")
            ),
        })
    return out


def iter_all_sample_ids(batch_size: int = 50, start: int = 0) -> Iterator[Tuple[str, int]]:
    """Yield (sample_id, page_b_start) for EVERY AnalysisRequest in SENAITE,
    paged via b_size/b_start against the plain list endpoint (minimal
    projection — deliberately NOT complete=true; per-sample detail is the
    caller's separate, throttled fetch).

    Yields the page cursor alongside each id so callers can checkpoint and
    resume via `start`. NOTE: includes secondary ARs (…-S01) and retests —
    filtering is caller policy. Mechanism only: no sleeping here; bulk-scan
    throttling (single Zope core!) is the caller's responsibility.

    Cursor advances by the number of items ACTUALLY RECEIVED, not the
    requested batch_size — if SENAITE clamps the page size server-side,
    advancing by the requested amount would silently skip ARs. Worst case
    (advancing by less than the server would have allowed) just re-sees a
    few items on the next page, which the caller's upsert handles
    idempotently."""
    b_start = start
    while True:
        resp = _get(
            f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest",
            params={"b_size": batch_size, "b_start": b_start, "sort_on": "created"},
        )
        if resp.status_code >= 300:
            raise RuntimeError(
                f"SENAITE enumerate failed ({resp.status_code}): {resp.text}"
            )
        items = resp.json().get("items", [])
        if not items:
            return
        for item in items:
            sid = item.get("id")
            if sid:
                yield sid, b_start
        b_start += len(items)


# Parent analyses in these review states are dead — they must not feed the
# vial mirror. A rejected service was explicitly removed from the offering;
# a retracted original always has an active retest sibling carrying the same
# keyword, so excluding the original never loses the keyword. Items WITHOUT
# a review_state key are kept (default-open — under-exclusion is the safe
# error direction here, consistent with the mirror's exclude-Micro stance).
_INACTIVE_ANALYSIS_STATES = frozenset({"rejected", "retracted", "cancelled"})


def fetch_parent_analysis_keywords(parent_sample_id: str) -> list[str]:
    """Return the parent AR's ACTIVE analysis keywords (e.g. ANALYTE-1-PUR,
    ID_GHKCU, HPLC-ID). Analyses in rejected/retracted/cancelled states are
    excluded — see _INACTIVE_ANALYSIS_STATES. Raises on SENAITE HTTP error —
    callers that must fail-hard rely on this propagating."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/search"
    resp = _get(url, params={
        "getRequestID": parent_sample_id,
        "catalog": "senaite_catalog_analysis",
        "complete": "true",
    })
    resp.raise_for_status()
    out: list[str] = []
    for item in resp.json().get("items", []):
        kw = item.get("getKeyword")
        if not kw:
            continue
        if item.get("review_state") in _INACTIVE_ANALYSIS_STATES:
            continue
        out.append(kw)
    return out


def _coerce_label(v: Any) -> Optional[str]:
    """SENAITE reference fields come back as str or {title/uid} dict."""
    if isinstance(v, dict):
        return v.get("title") or v.get("uid")
    return v or None


def fetch_parent_analyte_slots(parent_sample_id: str) -> dict[int, str]:
    """Return {slot: AnalyteNPeptide title} for slots 1-4 that are populated.
    Values are identity-service titles, e.g. 'GHK-Cu - Identity (HPLC)'.
    Raises on SENAITE HTTP error."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/search"
    resp = _get(url, params={
        "getId": parent_sample_id,
        "catalog": "senaite_catalog_sample",
        "complete": "true",
    })
    resp.raise_for_status()
    items = resp.json().get("items", [])
    if not items:
        return {}
    ar = items[0]
    out: dict[int, str] = {}
    for n in range(1, 5):
        label = _coerce_label(ar.get(f"Analyte{n}Peptide"))
        if label:
            out[n] = label
    return out


def uid_exists(uid: Optional[str]) -> bool:
    """Defense-in-depth: cheap check that SENAITE recognizes a UID before we try
    to create a secondary against it. Returns False on 404 or empty result."""
    if not uid:
        return False
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest/{uid}"
    try:
        resp = _get(url)
    except Exception:
        return False
    if resp.status_code == 404:
        return False
    if resp.status_code >= 300:
        # Network / 500 etc — don't false-positive a "doesn't exist" claim
        raise RuntimeError(f"SENAITE uid_exists check failed ({resp.status_code}): {resp.text[:200]}")
    items = resp.json().get("items", [])
    return bool(items)


# Whitelist of SENAITE AR field names that should be copied parent → secondary
# after the secondary is created. SENAITE's AnalysisRequestSecondary natively
# inherits only Client / Contact / SampleType / DateSampled (and dates); all
# Accumark-custom fields below are blank on the secondary unless explicitly
# copied.
#
# Sources (verified 2026-04-27):
#   * integration-service/app/adapters/senaite.py
#       AnalysisRequestData.to_senaite_payload()  — these are the Accumark
#       fields populated when the parent AR is first created from a WP order.
#   * Accu-Mk1/backend/main.py
#       lookup_senaite_sample()                   — confirms parser key names
#       update_senaite_sample_fields()            — confirms /update accepts them
#       publish_sample_coa()                      — confirms VerificationCode
#   * Accu-Mk1/src/components/senaite/SampleDetails.tsx
#       senaiteField="..." attributes on EditableDataRow — confirms the UI
#       reads/writes these exact keys.
#
# DO NOT include:
#   * uid, id, path, review_state               — SENAITE-managed identifiers
#   * Client, Contact, SampleType               — already passed on create
#   * PrimaryAnalysisRequest                    — already set on create
#   * DateSampled, DateReceived, DatePublished  — SENAITE inherits/manages
#   * Analyses                                  — secondary inherits its own
#   * Remarks                                   — handled separately by
#                                                 service.create_sub_sample
#                                                 (the create_sub_sample
#                                                 caller passes vial-specific
#                                                 remarks; we don't want to
#                                                 clobber those with parent's)
INHERITABLE_FIELDS: list[str] = [
    # Order / client identification
    "ClientOrderNumber",
    "ClientSampleID",
    "ClientLot",
    "ClientReference",
    # Profiles (list of profile UIDs)
    "Profiles",
    # Declared quantities
    "DeclaredTotalQuantity",
    # Accumark analyte slots — 4 in Accu-Mk1 UI, 8 in integration-service
    # payload. Copy all 8 to be safe; SENAITE will accept whichever exist.
    "Analyte1Peptide", "Analyte1DeclaredQuantity",
    "Analyte2Peptide", "Analyte2DeclaredQuantity",
    "Analyte3Peptide", "Analyte3DeclaredQuantity",
    "Analyte4Peptide", "Analyte4DeclaredQuantity",
    "Analyte5Peptide", "Analyte5DeclaredQuantity",
    "Analyte6Peptide", "Analyte6DeclaredQuantity",
    "Analyte7Peptide", "Analyte7DeclaredQuantity",
    "Analyte8Peptide", "Analyte8DeclaredQuantity",
    # COA Info block — exact field names confirmed via SampleDetails.tsx and
    # the SENAITE update endpoint in main.py.
    "CoaCompanyName",
    "CoaEmail",
    "CoaWebsite",
    "CoaAddress",
    "CompanyLogoUrl",
    "ChromatographBackgroundUrl",
    "VerificationCode",
]


def extract_inheritable_fields(parent_meta: dict) -> dict:
    """Pull fields from parent SENAITE metadata that should be copied to a
    secondary. Skips empty / null / SENAITE-managed values.

    Reference fields come back from the SENAITE complete=true endpoint as
    {"uid": "...", "url": "..."} dicts; reduce to UID strings. List fields
    (Profiles) come back as lists of such dicts; reduce to a list of UIDs.
    """
    out: dict = {}
    for field in INHERITABLE_FIELDS:
        value = parent_meta.get(field)
        if value is None or value == "":
            continue
        # Reference field as a single dict {uid, url, ...} → reduce to UID
        if isinstance(value, dict):
            uid = value.get("uid")
            if uid:
                out[field] = uid
            continue
        # List of references (e.g. Profiles) → list of UIDs
        if isinstance(value, list):
            uids: list = []
            for item in value:
                if isinstance(item, dict):
                    if item.get("uid"):
                        uids.append(item["uid"])
                elif item not in (None, ""):
                    uids.append(item)
            if uids:
                out[field] = uids
            continue
        out[field] = value
    return out


def _do_field_update(secondary_uid: str, fields: dict) -> None:
    """Single round-trip update; raises on any non-success response."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/update/{secondary_uid}"
    resp = _post_json(url, json=fields)
    if resp.status_code >= 300:
        raise RuntimeError(
            f"SENAITE update failed ({resp.status_code}): {resp.text[:300]}"
        )
    body = resp.json()
    if body.get("success") is False:
        raise RuntimeError(f"SENAITE update rejected: {body.get('message') or body}")
    if not body.get("items"):
        raise RuntimeError(f"SENAITE update returned no items: {body}")


def update_secondary_fields(secondary_uid: str, fields: dict) -> None:
    """Copy arbitrary AR fields onto a freshly-created secondary.

    Two-tier strategy:
      1. Try the whole batch in one call (fast, common case).
      2. If the batch is rejected, fall back to one call per field — that way
         text fields land even when one decimal field trips Plone's isDecimal
         validator (which rejects strings, ints, AND floats from Python 3
         clients; a known SENAITE/Plone-5 bug). Without per-field fallback,
         the path-style /update/{uid} endpoint stops at the first validation
         failure and silently drops everything after it.

    Path-style /update/{uid} is required: the body-style /update validates
    the FULL AR schema and 400s on partial payloads. main.py's
    update_senaite_sample_fields() uses the same path shape in production.
    """
    if not fields:
        return
    try:
        _do_field_update(secondary_uid, fields)
        return
    except RuntimeError as bulk_err:
        log.warning(
            "sub_samples.bulk_inheritance_failed uid=%s falling_back_per_field err=%s",
            secondary_uid, bulk_err,
        )

    rejected = []
    for key, value in fields.items():
        try:
            _do_field_update(secondary_uid, {key: value})
        except RuntimeError as field_err:
            rejected.append((key, str(field_err)[:160]))
            log.warning(
                "sub_samples.inherit_field_rejected uid=%s field=%s err=%s",
                secondary_uid, key, field_err,
            )
    if rejected:
        # Inherit-as-best-we-can: caller logs but does not abort the create.
        log.info(
            "sub_samples.inheritance_partial uid=%s applied=%d rejected=%d rejected_fields=%s",
            secondary_uid,
            len(fields) - len(rejected),
            len(rejected),
            [k for k, _ in rejected],
        )


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


def fetch_results_by_keyword(sample_id: str) -> dict:
    """Fetch SENAITE analysis results for one sample, keyed by analysis keyword.

    Returns the shape consumed by sub_samples.variance.compute_variance_stats:
        { "<keyword>": {"value": str, "kind": "numeric"|"categorical", "spec": None} }

    Rules:
      * No review_state filter — to_be_verified results are still results.
      * Result field has three SENAITE name variants (Result, getResult, result).
      * Selection-type analyses (non-empty ResultOptions) → categorical; else numeric.
      * Specs are NOT inline in the Analysis response (ResultsRange comes back null);
        spec stays None pending a follow-up AnalysisSpec fetch.
      * Analyses with no result are omitted — they show as "no results yet" downstream.
    Soft-fails to {} on transport / SENAITE errors so the variance summary can still
    render membership + lock state when result fetch is degraded."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/Analysis"
    try:
        resp = _get(
            url,
            params={"getRequestID": sample_id, "complete": "yes", "limit": "100"},
        )
    except requests.RequestException as e:
        log.warning("sub_samples.fetch_results_transport sample=%s err=%s", sample_id, e)
        return {}
    if resp.status_code >= 300:
        log.warning(
            "sub_samples.fetch_results_http sample=%s status=%d",
            sample_id, resp.status_code,
        )
        return {}

    out: dict = {}
    for an in resp.json().get("items", []):
        keyword = an.get("getKeyword")
        if not keyword:
            continue
        raw = an.get("Result")
        if raw is None:
            raw = an.get("getResult")
        if raw is None:
            raw = an.get("result")
        if raw in (None, ""):
            continue
        opts = an.get("ResultOptions") or an.get("getResultOptions") or []
        kind = "categorical" if (isinstance(opts, list) and len(opts) > 0) else "numeric"
        out[str(keyword)] = {"value": str(raw), "kind": kind, "spec": None}
    return out
