"""_select_photo_attachment: pick the most-recent IMAGE attachment off an AR.

Regression: the parent-fallback photo endpoint used to proxy the AR's LAST
attachment outright. After COA generation appends a COA PDF and HPLC-graph CSVs
to the parent AR, that last attachment is no longer the vial photo, so the
header <img> received CSV/PDF bytes and rendered broken. The selector must skip
non-images and return the newest image.
"""
from __future__ import annotations

from sub_samples.routes import _select_photo_attachment


def _meta(content_type=None, att_type=None, download="http://dl/x", filename=""):
    return {
        "AttachmentFile": {"download": download, "content_type": content_type, "filename": filename},
        "AttachmentType": att_type,
    }


def _fetch(table):
    """Build a fetch_meta(api_url) -> att_item from a {api_url: meta} table."""
    return lambda url: table[url]


def test_picks_newest_image_when_csv_is_last():
    refs = [
        {"uid": "1", "api_url": "u-image"},
        {"uid": "2", "api_url": "u-csv"},
    ]
    table = {
        "u-image": _meta(content_type="image/jpeg", filename="vial.jpg"),
        "u-csv": _meta(content_type="text/comma-separated-values", filename="peaks.csv"),
    }
    chosen = _select_photo_attachment(refs, _fetch(table))
    assert chosen["AttachmentFile"]["download"] == "http://dl/x"
    assert chosen["AttachmentFile"]["content_type"] == "image/jpeg"


def test_prefers_most_recent_image_when_several():
    refs = [
        {"uid": "1", "api_url": "u-old"},
        {"uid": "2", "api_url": "u-new"},
        {"uid": "3", "api_url": "u-pdf"},
    ]
    table = {
        "u-old": _meta(content_type="image/png", download="http://dl/old"),
        "u-new": _meta(content_type="image/png", download="http://dl/new"),
        "u-pdf": _meta(content_type="application/pdf", download="http://dl/coa"),
    }
    chosen = _select_photo_attachment(refs, _fetch(table))
    assert chosen["AttachmentFile"]["download"] == "http://dl/new"


def test_sample_image_type_counts_even_without_image_content_type():
    refs = [{"uid": "1", "api_url": "u"}]
    table = {"u": _meta(content_type="application/octet-stream", att_type="Sample Image")}
    assert _select_photo_attachment(refs, _fetch(table)) is not None


def test_none_when_no_image_attachments():
    refs = [{"uid": "1", "api_url": "u-csv"}, {"uid": "2", "api_url": "u-pdf"}]
    table = {
        "u-csv": _meta(content_type="text/csv"),
        "u-pdf": _meta(content_type="application/pdf"),
    }
    assert _select_photo_attachment(refs, _fetch(table)) is None


def test_skips_unfetchable_refs():
    refs = [{"uid": "1"}, {"uid": "2", "api_url": "u-image"}]  # first has no api_url
    table = {"u-image": _meta(content_type="image/webp")}
    chosen = _select_photo_attachment(refs, _fetch(table))
    assert chosen is not None
