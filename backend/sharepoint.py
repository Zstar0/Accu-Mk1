"""
SharePoint integration via Microsoft Graph API.

Uses app-only (client credentials) auth to browse and download files
from the Valence Analytical SharePoint site.
"""

import os
import time
import logging
from io import BytesIO
from typing import Optional
from pathlib import PurePosixPath

import httpx
import msal

logger = logging.getLogger(__name__)

# ── Configuration ──────────────────────────────────────────────────
TENANT_ID = os.getenv("AZURE_TENANT_ID", "")
CLIENT_ID = os.getenv("AZURE_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("AZURE_CLIENT_SECRET", "")
SHAREPOINT_HOSTNAME = os.getenv("SHAREPOINT_HOSTNAME", "valenceanalytical.sharepoint.com")
SHAREPOINT_SITE_PATH = os.getenv("SHAREPOINT_SITE_PATH", "")  # e.g. "sites/CommunicationSite" or empty for root
SHAREPOINT_DOC_LIBRARY = os.getenv("SHAREPOINT_DOC_LIBRARY", "Documents")
SHAREPOINT_PEPTIDES_PATH = os.getenv("SHAREPOINT_PEPTIDES_PATH", "Analytical/Lab Reports/Purity and Quantity (HPLC)/Peptides")
SHAREPOINT_LIMS_CSV_PATH = os.getenv("SHAREPOINT_LIMS_CSV_PATH", "Analytical/Lab Reports/Purity and Quantity (HPLC)/LIMS CSVs (Chromatogram CSV and Peak Area CSV)")

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"
GRAPH_SCOPES = ["https://graph.microsoft.com/.default"]

# ── Token Cache ────────────────────────────────────────────────────
_token_cache: dict = {"access_token": None, "expires_at": 0}
_site_id_cache: Optional[str] = None
_drive_id_cache: Optional[str] = None


def _get_msal_app() -> msal.ConfidentialClientApplication:
    """Create MSAL app for client credentials flow."""
    return msal.ConfidentialClientApplication(
        client_id=CLIENT_ID,
        client_credential=CLIENT_SECRET,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
    )


def _get_access_token() -> str:
    """Acquire or reuse an access token via client credentials."""
    global _token_cache

    # Return cached token if still valid (with 60s buffer)
    if _token_cache["access_token"] and time.time() < _token_cache["expires_at"] - 60:
        return _token_cache["access_token"]

    app = _get_msal_app()
    result = app.acquire_token_for_client(scopes=GRAPH_SCOPES)

    if "access_token" not in result:
        error = result.get("error_description", result.get("error", "Unknown error"))
        raise RuntimeError(f"Failed to acquire Graph API token: {error}")

    _token_cache["access_token"] = result["access_token"]
    _token_cache["expires_at"] = time.time() + result.get("expires_in", 3600)
    logger.info("Acquired new Graph API access token")
    return result["access_token"]


def _invalidate_token():
    """Force token refresh on next request."""
    global _token_cache
    _token_cache = {"access_token": None, "expires_at": 0}
    logger.info("Invalidated cached Graph API token")


def _headers() -> dict:
    """Auth headers for Graph API requests."""
    return {"Authorization": f"Bearer {_get_access_token()}"}


# ── Site & Drive Discovery ─────────────────────────────────────────

async def _get_site_id() -> str:
    """Discover and cache the SharePoint site ID."""
    global _site_id_cache
    if _site_id_cache:
        return _site_id_cache

    async with httpx.AsyncClient() as client:
        if SHAREPOINT_SITE_PATH:
            # Named site: /sites/{hostname}:/{relative-path}
            url = f"{GRAPH_BASE_URL}/sites/{SHAREPOINT_HOSTNAME}:/{SHAREPOINT_SITE_PATH}"
        else:
            # Root site
            url = f"{GRAPH_BASE_URL}/sites/{SHAREPOINT_HOSTNAME}"

        resp = await client.get(url, headers=_headers())
        if resp.status_code == 401:
            _invalidate_token()
            resp = await client.get(url, headers=_headers())
        resp.raise_for_status()
        data = resp.json()
        _site_id_cache = data["id"]
        logger.info(f"SharePoint site ID: {_site_id_cache} ({data.get('displayName', 'root')})")
        return _site_id_cache


async def _get_drive_id() -> str:
    """Discover the document library drive ID."""
    global _drive_id_cache
    if _drive_id_cache:
        return _drive_id_cache

    site_id = await _get_site_id()
    async with httpx.AsyncClient() as client:
        url = f"{GRAPH_BASE_URL}/sites/{site_id}/drives"
        resp = await client.get(url, headers=_headers())
        if resp.status_code == 401:
            _invalidate_token()
            resp = await client.get(url, headers=_headers())
        resp.raise_for_status()
        drives = resp.json().get("value", [])

        # Find the matching document library
        for drive in drives:
            if drive.get("name") == SHAREPOINT_DOC_LIBRARY:
                _drive_id_cache = drive["id"]
                logger.info(f"Drive ID for '{SHAREPOINT_DOC_LIBRARY}': {_drive_id_cache}")
                return _drive_id_cache

        # Fallback: use first drive
        if drives:
            _drive_id_cache = drives[0]["id"]
            logger.warning(f"Library '{SHAREPOINT_DOC_LIBRARY}' not found, using: {drives[0]['name']}")
            return _drive_id_cache

        raise RuntimeError(f"No document libraries found on SharePoint site")


# ── File Operations ────────────────────────────────────────────────

async def _list_folder_at_root(root_path: str, path: str = "") -> list[dict]:
    """
    List children of a folder relative to a given root path.

    Args:
        root_path: The base path in the document library (e.g. Peptides or LIMS CSVs)
        path: Relative path within the root (empty = root itself)

    Returns:
        List of dicts with keys: name, type ('folder'|'file'), size, id, last_modified
    """
    drive_id = await _get_drive_id()

    # Build the full path within the document library
    if path:
        full_path = f"{root_path}/{path}"
    else:
        full_path = root_path

    # URL-encode the path — special chars like # must be escaped
    # (e.g. folder name "Std_#63162" contains # which is a URL fragment delimiter)
    from urllib.parse import quote
    encoded_path = quote(full_path, safe="/")  # keep / as path separator
    url = f"{GRAPH_BASE_URL}/drives/{drive_id}/root:/{encoded_path}:/children"
    params = {
        "$select": "id,name,size,createdDateTime,lastModifiedDateTime,folder,file,webUrl",
        "$top": "200",
    }

    items = []
    retried_auth = False
    async with httpx.AsyncClient() as client:
        while url:
            resp = await client.get(url, headers=_headers(), params=params)
            if resp.status_code == 401 and not retried_auth:
                logger.info("Got 401 from Graph API, refreshing token and retrying")
                _invalidate_token()
                retried_auth = True
                resp = await client.get(url, headers=_headers(), params=params)
            resp.raise_for_status()
            data = resp.json()

            for item in data.get("value", []):
                items.append({
                    "id": item["id"],
                    "name": item["name"],
                    "type": "folder" if "folder" in item else "file",
                    "size": item.get("size", 0),
                    "created": item.get("createdDateTime"),
                    "last_modified": item.get("lastModifiedDateTime"),
                    "web_url": item.get("webUrl"),
                    "child_count": item.get("folder", {}).get("childCount", 0) if "folder" in item else None,
                    "mime_type": item.get("file", {}).get("mimeType") if "file" in item else None,
                })

            # Handle pagination
            url = data.get("@odata.nextLink")
            params = {}  # nextLink already includes params

    return items


async def list_folder(path: str = "") -> list[dict]:
    """List children in the Peptides root."""
    return await _list_folder_at_root(SHAREPOINT_PEPTIDES_PATH, path)


async def list_lims_folder(path: str = "") -> list[dict]:
    """List children in the LIMS CSVs root."""
    return await _list_folder_at_root(SHAREPOINT_LIMS_CSV_PATH, path)


async def search_sample_folder(sample_id: str) -> Optional[dict]:
    """
    Search for a sample folder (e.g., P-0142) within the Peptides tree.

    Scans each peptide subfolder's "Raw Data" directory for a match.

    Returns:
        Dict with keys: path, name, peptide_folder, id  — or None
    """
    # List peptide folders (e.g., AOD-9604, BPC-157, etc.)
    peptide_folders = await list_folder("")
    peptide_dirs = [f for f in peptide_folders if f["type"] == "folder"]

    for peptide_dir in peptide_dirs:
        # Check for "Raw Data" subfolder
        try:
            raw_data_items = await list_folder(f"{peptide_dir['name']}/Raw Data")
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                continue
            raise

        # Search for matching sample folder
        for item in raw_data_items:
            if item["type"] == "folder" and sample_id.upper() in item["name"].upper():
                return {
                    "id": item["id"],
                    "name": item["name"],
                    "path": f"{peptide_dir['name']}/Raw Data/{item['name']}",
                    "peptide_folder": peptide_dir["name"],
                }

    return None


async def download_file(item_id: str) -> tuple[bytes, str]:
    """
    Download a file by its Graph API item ID.

    Returns:
        Tuple of (file_bytes, filename)
    """
    import asyncio

    drive_id = await _get_drive_id()
    max_retries = 3

    async with httpx.AsyncClient(follow_redirects=True) as client:
        # Get file metadata first for the filename
        meta_url = f"{GRAPH_BASE_URL}/drives/{drive_id}/items/{item_id}"
        meta_resp = await client.get(meta_url, headers=_headers())
        if meta_resp.status_code == 401:
            _invalidate_token()
            meta_resp = await client.get(meta_url, headers=_headers())
        meta_resp.raise_for_status()
        filename = meta_resp.json()["name"]

        # Download content with retry for rate-limiting and auth
        url = f"{GRAPH_BASE_URL}/drives/{drive_id}/items/{item_id}/content"
        for attempt in range(max_retries + 1):
            resp = await client.get(url, headers=_headers())
            if resp.status_code == 401:
                _invalidate_token()
                resp = await client.get(url, headers=_headers())
            if resp.status_code in (429, 503) and attempt < max_retries:
                retry_after = int(resp.headers.get("Retry-After", 2 ** attempt))
                await asyncio.sleep(retry_after)
                continue
            resp.raise_for_status()
            return resp.content, filename


async def download_file_by_path(path: str) -> tuple[bytes, str]:
    """
    Download a file by its path relative to the Peptides root.

    Returns:
        Tuple of (file_bytes, filename)
    """
    drive_id = await _get_drive_id()
    full_path = f"{SHAREPOINT_PEPTIDES_PATH}/{path}"

    async with httpx.AsyncClient(follow_redirects=True) as client:
        from urllib.parse import quote
        encoded_path = quote(full_path, safe="/")
        url = f"{GRAPH_BASE_URL}/drives/{drive_id}/root:/{encoded_path}:/content"
        resp = await client.get(url, headers=_headers())
        if resp.status_code == 401:
            _invalidate_token()
            resp = await client.get(url, headers=_headers())
        resp.raise_for_status()

        filename = PurePosixPath(path).name
        return resp.content, filename


async def list_files_recursive(
    path: str,
    extensions: Optional[list[str]] = None,
    root: str = "peptides",
) -> list[dict]:
    """
    Recursively list all files under a path.

    Args:
        path: Relative path within the chosen root
        extensions: Optional list of extensions to filter (e.g., ['.csv', '.xlsx'])
        root: Which root to use — 'peptides' or 'lims'

    Returns:
        List of dicts with keys: id, name, path, size, type, mime_type
    """
    result = []
    list_fn = list_lims_folder if root == "lims" else list_folder
    items = await list_fn(path)

    for item in items:
        item_path = f"{path}/{item['name']}" if path else item["name"]

        if item["type"] == "folder":
            # Recurse into subfolders
            result.extend(await list_files_recursive(item_path, extensions, root))
        else:
            # Filter by extension if specified
            if extensions:
                if not any(item["name"].lower().endswith(ext.lower()) for ext in extensions):
                    continue
            result.append({
                **item,
                "path": item_path,
            })

    return result


async def get_sample_files(sample_id: str) -> Optional[dict]:
    """
    Find a sample folder and list all CSV + Excel files within it.

    This combines search_sample_folder + list_files_recursive into a
    single convenience function for the HPLC analysis workflow.

    Returns:
        Dict with:
            - sample: { name, path, peptide_folder, id }
            - peak_data_files: list of CSV files containing 'PeakData'
            - chromatogram_files: list of CSV files containing 'dx_DAD1A'
            - excel_files: list of .xlsx files (lab workbooks)
        Or None if sample not found.
    """
    sample = await search_sample_folder(sample_id)
    if not sample:
        return None

    all_files = await list_files_recursive(sample["path"], extensions=[".csv", ".xlsx"])

    peak_data = []
    chromatograms = []
    excel_files = []

    for f in all_files:
        name_lower = f["name"].lower()
        if "peakdata" in name_lower and name_lower.endswith(".csv"):
            peak_data.append(f)
        elif "dx_dad1a" in name_lower and name_lower.endswith(".csv"):
            chromatograms.append(f)
        elif name_lower.endswith(".xlsx") and not f["name"].startswith("~$"):
            # Skip Agilent data exports
            if ".dx_" not in f["name"] and "_PeakData" not in f["name"]:
                excel_files.append(f)

    return {
        "sample": sample,
        "peak_data_files": peak_data,
        "chromatogram_files": chromatograms,
        "excel_files": excel_files,
    }


async def verify_connection() -> dict:
    """
    Test the SharePoint connection and return site info.

    Useful for health checks and setup verification.
    """
    try:
        site_id = await _get_site_id()
        drive_id = await _get_drive_id()

        # Try listing the Peptides root
        peptide_folders = await list_folder("")
        folder_names = [f["name"] for f in peptide_folders if f["type"] == "folder"]

        return {
            "status": "connected",
            "site_id": site_id,
            "drive_id": drive_id,
            "peptides_path": SHAREPOINT_PEPTIDES_PATH,
            "peptide_folders": folder_names,
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
        }


def get_sharepoint_file_url(relative_path: str, root: str = "peptides") -> str:
    """
    Build a SharePoint web viewer URL for a file.

    Args:
        relative_path: Path relative to the root (e.g. "KPV/Raw Data/file.xlsx")
        root: Which root — 'peptides' or 'lims'

    Returns:
        SharePoint AllItems.aspx URL that opens the file in the web viewer
    """
    from urllib.parse import quote
    root_path = SHAREPOINT_PEPTIDES_PATH if root == "peptides" else SHAREPOINT_LIMS_CSV_PATH
    full_path = f"/Shared Documents/{root_path}/{relative_path}"
    base = f"https://{SHAREPOINT_HOSTNAME}"
    # Use AllItems.aspx with id= parameter for web viewing instead of direct download
    encoded_id = quote(full_path, safe="")  # encode everything including /
    return f"{base}/Shared%20Documents/Forms/AllItems.aspx?id={encoded_id}&p=true&ga=1"
