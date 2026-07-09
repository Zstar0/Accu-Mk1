"""Bounded-crawl guard for SharePoint Graph folder listings.

Regression test for the 2026-07-08 prod OOM: `_list_folder_at_root` /
`list_folder_by_id` followed Graph's `@odata.nextLink` in an UNBOUNDED
`while url:` loop, accumulating every child of a folder into one list with
no cap, no page ceiling, and no time budget. The LIMS-CSV root (HPLC dumps,
grows daily) got large enough that browsing it crawled for hours, leaking
RSS to ~6 GiB until the kernel OOM-killed uvicorn (prod, ~18:20 local).

These tests pin the crawl as bounded: a folder that would page forever must
return a partial listing after a fixed number of pages / items, and signal
truncation to callers that ask for it.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import sharepoint as sp


def _page(n_items: int, next_link: str | None) -> MagicMock:
    """A Graph children response: `n_items` folders + an optional nextLink."""
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value={
        "value": [
            {"id": f"id-{i}", "name": f"P-{i:05d} Folder", "folder": {"childCount": 0}}
            for i in range(n_items)
        ],
        **({"@odata.nextLink": next_link} if next_link else {}),
    })
    return resp


def _never_ending_client(page_size: int = 999):
    """Patch httpx.AsyncClient so every GET returns a full page that ALWAYS
    points to a next page — i.e. an effectively infinite folder. Records how
    many GETs (pages) the code actually performs so we can assert the bound."""
    calls = {"n": 0}

    async def _get(url, headers=None, params=None):
        calls["n"] += 1
        # Always hand back another nextLink → the loop would never stop on its own.
        return _page(page_size, f"https://graph.microsoft.com/next/{calls['n']}")

    instance = AsyncMock()
    instance.get = AsyncMock(side_effect=_get)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p, calls


@pytest.fixture(autouse=True)
def _fake_graph_auth():
    """Skip real Azure auth / drive resolution — the crawl loop is under test."""
    with patch.object(sp, "_get_drive_id", AsyncMock(return_value="drive-1")), \
         patch.object(sp, "_headers", MagicMock(return_value={"Authorization": "Bearer x"})):
        yield


def test_list_folder_at_root_stops_on_an_infinite_folder():
    p, calls = _never_ending_client()
    try:
        items, truncated = asyncio.run(
            sp._list_folder_at_root("Some/Root", "", with_truncation=True)
        )
    finally:
        p.stop()

    # The loop MUST terminate on its own despite an endless nextLink stream.
    assert truncated is True
    # Bounded by the page ceiling — not thousands of Graph round-trips.
    assert calls["n"] <= sp._MAX_LIST_PAGES
    # Bounded accumulation — the leak was this list growing without limit.
    # The cap is checked per-page, so the result may overshoot by at most one
    # page (the page is already fetched; trimming it wouldn't reclaim memory).
    assert len(items) < sp._MAX_LIST_ITEMS + 1000


def test_list_folder_by_id_stops_on_an_infinite_folder():
    p, calls = _never_ending_client()
    try:
        items, truncated = asyncio.run(
            sp.list_folder_by_id("folder-1", with_truncation=True)
        )
    finally:
        p.stop()

    assert truncated is True
    assert calls["n"] <= sp._MAX_LIST_PAGES
    assert len(items) < sp._MAX_LIST_ITEMS + 1000


def test_small_folder_is_not_truncated_and_returns_all_items():
    """A folder that fits in one page paginates to completion, untruncated —
    the bound must not change behavior for normal-sized folders."""
    resp = _page(3, None)  # single page, no nextLink
    instance = AsyncMock()
    instance.get = AsyncMock(return_value=resp)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    try:
        items, truncated = asyncio.run(
            sp._list_folder_at_root("Some/Root", "", with_truncation=True)
        )
    finally:
        p.stop()

    assert truncated is False
    assert len(items) == 3
    assert instance.get.await_count == 1


def test_default_callers_still_get_a_plain_list():
    """Back-compat: without with_truncation the helpers return list[dict],
    so existing callers (search paths) are unchanged in shape."""
    resp = _page(2, None)
    instance = AsyncMock()
    instance.get = AsyncMock(return_value=resp)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    try:
        result = asyncio.run(sp.list_lims_folder(""))
    finally:
        p.stop()

    assert isinstance(result, list)
    assert len(result) == 2
