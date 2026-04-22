# Peptide Request Retraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer hard-delete their own peptide request from the portal detail page while it's still `new` or `rejected`, dropping a ClickUp comment on the task so lab staff see the retraction.

**Architecture:** Accu-Mk1 is the authoritative layer (gate check + hard DELETE + best-effort ClickUp comment). integration-service forwards. wpstar renders a gated button + modal and deletes its local snapshot on upstream success. No schema changes.

**Tech Stack:** FastAPI + SQLAlchemy + Postgres (Accu-Mk1), FastAPI + httpx (integration-service), WordPress REST + vanilla JS (wpstar theme).

**Spec:** `docs/superpowers/specs/2026-04-22-peptide-request-retraction-design.md` (this repo).

**Branch:** `feat/peptide-request-v1` (already checked out across all three repos; commits go on this branch; big-bang cutover holds).

**Repo paths (host):**
- Accu-Mk1: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1`
- integration-service: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\integration-service`
- wpstar: `\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs\wp-content\themes\wpstar` (edit via `docker exec devkinsta_fpm ...` when host path is unreachable)

**How to run tests:**
- Accu-Mk1: `docker exec accu-mk1-backend python -m pytest backend/tests/<file> -v`
- integration-service: from repo root, `.venv/Scripts/python.exe -m pytest tests/unit/<file> -v`
- wpstar: no test suite; PHP lint via `docker exec devkinsta_fpm php8.2 -l <file>`

---

## Task 1: Add `post_task_comment` to ClickUpClient (Accu-Mk1)

**Files:**
- Modify: `backend/clickup_client.py` (add method to `ClickUpClient` class)
- Test: `backend/tests/test_clickup_client.py` (existing file — append new tests)

- [ ] **Step 1: Read existing ClickUpClient to confirm style**

Read `backend/clickup_client.py` lines 1-60 (imports + class init + `_headers`) and lines 195-215 (`set_custom_field` — closest analog: POST to `/task/{id}/...` with 15s timeout, raises on ≥300). The new method will use the same shape but a 2-second timeout.

- [ ] **Step 2: Read existing test file to confirm mocking style**

Read `backend/tests/test_clickup_client.py` to see how existing tests stub `requests.post`. Use the same style for the new tests.

- [ ] **Step 3: Write the failing tests**

Append to `backend/tests/test_clickup_client.py`:

```python
from unittest.mock import patch, MagicMock
from clickup_client import ClickUpClient


def _make_client():
    return ClickUpClient(
        api_token="t",
        list_id="L",
        accumk1_base_url="https://accumk1.example",
    )


def test_post_task_comment_sends_expected_body():
    client = _make_client()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    with patch("clickup_client.requests.post", return_value=mock_resp) as m:
        client.post_task_comment("TASK123", "hello world")
    args, kwargs = m.call_args
    assert args[0] == "https://api.clickup.com/api/v2/task/TASK123/comment"
    assert kwargs["json"] == {"comment_text": "hello world", "notify_all": False}
    assert kwargs["timeout"] == 2


def test_post_task_comment_raises_on_non_2xx():
    client = _make_client()
    mock_resp = MagicMock()
    mock_resp.status_code = 500
    mock_resp.text = "boom"
    with patch("clickup_client.requests.post", return_value=mock_resp):
        import pytest
        with pytest.raises(RuntimeError, match="ClickUp post_task_comment failed"):
            client.post_task_comment("TASK123", "hi")
```

- [ ] **Step 4: Run tests to verify they fail**

```
docker exec accu-mk1-backend python -m pytest backend/tests/test_clickup_client.py::test_post_task_comment_sends_expected_body backend/tests/test_clickup_client.py::test_post_task_comment_raises_on_non_2xx -v
```

Expected: FAIL with `AttributeError: 'ClickUpClient' object has no attribute 'post_task_comment'`.

- [ ] **Step 5: Implement the method**

Add to `backend/clickup_client.py` inside the `ClickUpClient` class, after `set_custom_field`:

```python
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
```

- [ ] **Step 6: Run tests to verify they pass**

```
docker exec accu-mk1-backend python -m pytest backend/tests/test_clickup_client.py -v
```

Expected: all `test_clickup_client.py` tests pass (new + existing).

- [ ] **Step 7: Commit**

```
git -C Accu-Mk1 add backend/clickup_client.py backend/tests/test_clickup_client.py
git -C Accu-Mk1 commit -m "feat(clickup): add post_task_comment helper for best-effort breadcrumbs"
```

---

## Task 2: Add `delete_by_id` to PeptideRequestRepository (Accu-Mk1)

**Files:**
- Modify: `backend/peptide_request_repo.py`
- Test: `backend/tests/test_peptide_request_repo.py` (existing — append)

- [ ] **Step 1: Read existing repo to confirm session/style**

Read `backend/peptide_request_repo.py` — confirm the pattern for `get_by_id` (SQLAlchemy session, scalar_one_or_none, etc.) and match it for `delete_by_id`.

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/test_peptide_request_repo.py`:

```python
def test_delete_by_id_removes_row(db_session):
    repo = PeptideRequestRepository()
    row = repo.create(
        PeptideRequestCreate(
            compound_kind="peptide", compound_name="DeleteMe",
            vendor_producer="V", submitted_by_wp_user_id=1,
            submitted_by_email="a@b.c", submitted_by_name="N",
        ),
        idempotency_key="idem-del-1",
        clickup_list_id="L",
    )
    deleted = repo.delete_by_id(row.id)
    assert deleted is True
    assert repo.get_by_id(row.id) is None


def test_delete_by_id_returns_false_when_missing(db_session):
    repo = PeptideRequestRepository()
    import uuid as _uuid
    assert repo.delete_by_id(_uuid.uuid4()) is False
```

Make sure imports at the top of the file already cover `PeptideRequestRepository` and `PeptideRequestCreate`; if not, add:
```python
from peptide_request_repo import PeptideRequestRepository
from models_peptide_request import PeptideRequestCreate
```
(Don't duplicate existing imports.)

- [ ] **Step 3: Run tests to verify they fail**

```
docker exec accu-mk1-backend python -m pytest backend/tests/test_peptide_request_repo.py::test_delete_by_id_removes_row backend/tests/test_peptide_request_repo.py::test_delete_by_id_returns_false_when_missing -v
```

Expected: FAIL with `AttributeError: 'PeptideRequestRepository' object has no attribute 'delete_by_id'`.

- [ ] **Step 4: Implement `delete_by_id`**

Add a method to `PeptideRequestRepository` in `backend/peptide_request_repo.py`:

```python
    def delete_by_id(self, request_id) -> bool:
        """Hard-delete a peptide_requests row by id.

        Returns True if a row was removed, False if the id did not exist.
        Commits the session on success. No cascade handling — the repo
        caller is expected to gate on status before invoking.
        """
        from uuid import UUID as _UUID
        rid = request_id if isinstance(request_id, _UUID) else _UUID(str(request_id))
        with self._session() as session:  # match existing session-context pattern
            row = session.get(PeptideRequest, rid)
            if row is None:
                return False
            session.delete(row)
            session.commit()
            return True
```

> If the existing repo uses a different session pattern (e.g. `SessionLocal()` directly, not a `_session` contextmanager), match that pattern instead. Read the file first to confirm.

- [ ] **Step 5: Run tests to verify they pass**

```
docker exec accu-mk1-backend python -m pytest backend/tests/test_peptide_request_repo.py -v
```

Expected: all repo tests pass.

- [ ] **Step 6: Commit**

```
git -C Accu-Mk1 add backend/peptide_request_repo.py backend/tests/test_peptide_request_repo.py
git -C Accu-Mk1 commit -m "feat(peptide-request): add repo.delete_by_id for customer retraction"
```

---

## Task 3: Add `POST /peptide-requests/{id}/retract` endpoint (Accu-Mk1)

**Files:**
- Modify: `backend/main.py` (add route near existing peptide-request handlers ~line 12612)
- Modify: `backend/models_peptide_request.py` (add `PeptideRequestRetract` model)
- Create: `backend/tests/test_api_peptide_requests_retract.py`

- [ ] **Step 1: Add the request model**

Edit `backend/models_peptide_request.py`, appending:

```python
class PeptideRequestRetract(BaseModel):
    """Body for POST /peptide-requests/{id}/retract.

    `reason` is optional free-text captured from the customer. Length is
    capped server-side at 500 chars (trim anything longer — don't 422;
    the WP layer already caps at submission time and a hostile client
    could still send more).
    """
    reason: str | None = None
```

(Keep the import style consistent with the rest of the file — uses `from pydantic import BaseModel` already.)

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_api_peptide_requests_retract.py`:

```python
from fastapi.testclient import TestClient
from unittest.mock import patch
import os
import uuid

from main import app

client = TestClient(app)


def _headers():
    return {
        "X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
        "Idempotency-Key": str(uuid.uuid4()),
    }


def _make_request(status_override: str | None = None) -> str:
    """Create a peptide_request row and optionally force its status.

    Returns the id. Follows the fixture pattern already used in
    test_api_peptide_requests_read.py.
    """
    body = {
        "compound_kind": "peptide",
        "compound_name": "Retractatide",
        "vendor_producer": "V",
        "submitted_by_wp_user_id": 7,
        "submitted_by_email": "a@b.c",
        "submitted_by_name": "N",
    }
    resp = client.post("/peptide-requests", headers=_headers(), json=body)
    assert resp.status_code == 201, resp.text
    rid = resp.json()["id"]
    if status_override is not None and status_override != "new":
        # Flip the status directly via the repo. Matches the pattern used
        # in other tests to simulate status transitions without going
        # through the ClickUp webhook path.
        from peptide_request_repo import PeptideRequestRepository
        from uuid import UUID
        repo = PeptideRequestRepository()
        repo.update_status(UUID(rid), status_override)
    return rid


def test_retract_rejects_missing_token():
    resp = client.post("/peptide-requests/00000000-0000-0000-0000-000000000000/retract", json={})
    assert resp.status_code == 401


def test_retract_happy_path_new_status():
    rid = _make_request()
    with patch("main.ClickUpClient.post_task_comment") as comment_mock:
        resp = client.post(
            f"/peptide-requests/{rid}/retract",
            headers=_headers(),
            json={"reason": "wrong compound"},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    comment_mock.assert_called_once()
    # Comment body includes the reason
    args, kwargs = comment_mock.call_args
    # post_task_comment(task_id, comment_text) — positional
    assert "wrong compound" in args[1]
    # Row is gone
    follow = client.get(f"/peptide-requests/{rid}", headers=_headers())
    assert follow.status_code == 404


def test_retract_omits_reason_line_when_empty():
    rid = _make_request()
    with patch("main.ClickUpClient.post_task_comment") as comment_mock:
        resp = client.post(
            f"/peptide-requests/{rid}/retract",
            headers=_headers(),
            json={},
        )
    assert resp.status_code == 200
    args, _ = comment_mock.call_args
    assert "Reason:" not in args[1]
    assert "retracted" in args[1].lower()


def test_retract_rejected_status_is_retractable():
    rid = _make_request(status_override="rejected")
    with patch("main.ClickUpClient.post_task_comment"):
        resp = client.post(f"/peptide-requests/{rid}/retract", headers=_headers(), json={})
    assert resp.status_code == 200


def test_retract_blocks_on_approved_status():
    rid = _make_request(status_override="approved")
    with patch("main.ClickUpClient.post_task_comment") as comment_mock:
        resp = client.post(f"/peptide-requests/{rid}/retract", headers=_headers(), json={})
    assert resp.status_code == 409
    body = resp.json()
    # FastAPI error-envelope convention already in use by other handlers
    assert body["detail"]["code"] == "request_not_retractable"
    assert body["detail"]["current_status"] == "approved"
    comment_mock.assert_not_called()
    # Row still exists
    follow = client.get(f"/peptide-requests/{rid}", headers=_headers())
    assert follow.status_code == 200


def test_retract_still_succeeds_when_clickup_fails():
    rid = _make_request()
    with patch(
        "main.ClickUpClient.post_task_comment",
        side_effect=RuntimeError("clickup down"),
    ):
        resp = client.post(f"/peptide-requests/{rid}/retract", headers=_headers(), json={})
    assert resp.status_code == 200
    follow = client.get(f"/peptide-requests/{rid}", headers=_headers())
    assert follow.status_code == 404


def test_retract_returns_404_when_missing():
    resp = client.post(
        "/peptide-requests/00000000-0000-0000-0000-000000000000/retract",
        headers=_headers(),
        json={},
    )
    assert resp.status_code == 404
```

> Note: `repo.update_status` is assumed to exist (used by the ClickUp webhook path). If it's named differently in `peptide_request_repo.py`, substitute the correct method name — check the file first.

- [ ] **Step 3: Run tests to verify they fail**

```
docker exec accu-mk1-backend python -m pytest backend/tests/test_api_peptide_requests_retract.py -v
```

Expected: FAIL with 404 or 405 on the new URL (route not registered yet).

- [ ] **Step 4: Implement the route**

Add to `backend/main.py` immediately after the existing `GET /peptide-requests/{request_id}/history` handler (~line 12652):

```python
@app.post("/peptide-requests/{request_id}/retract")
def retract_peptide_request(
    request_id: str,
    data: PeptideRequestRetract,
    _: None = Depends(require_internal_service_token),
):
    """Hard-delete a peptide request that's still in a customer-retractable state.

    Gate: status must be in {"new", "rejected"}. ClickUp comment is
    best-effort (2s timeout, failure logged but not raised). Delete is
    atomic and authoritative.
    """
    import logging as _logging
    log = _logging.getLogger(__name__)
    rid = UUID(request_id)
    repo = PeptideRequestRepository()
    row = repo.get_by_id(rid)
    if not row:
        raise HTTPException(
            status_code=404,
            detail={"code": "request_not_found", "message": "Peptide request not found"},
        )
    if row.status not in ("new", "rejected"):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "request_not_retractable",
                "message": "This request can no longer be retracted.",
                "current_status": row.status,
            },
        )

    reason = (data.reason or "").strip()
    if len(reason) > 500:
        reason = reason[:500]

    # Best-effort ClickUp comment. Don't block the delete on ClickUp.
    if row.clickup_task_id:
        try:
            from datetime import date as _date
            lines = [f"Customer retracted this request on {_date.today().isoformat()}."]
            if reason:
                lines.append(f"Reason: {reason}")
            cfg = get_peptide_request_config()
            client = ClickUpClient(
                api_token=cfg.clickup_api_token,
                list_id=cfg.clickup_list_id,
                accumk1_base_url=os.environ.get("ACCUMK1_BASE_URL", ""),
            )
            client.post_task_comment(row.clickup_task_id, "\n".join(lines))
            log.info(
                "clickup_retraction_comment_posted request_id=%s task_id=%s",
                row.id, row.clickup_task_id,
            )
        except Exception:
            log.exception(
                "clickup_retraction_comment_failed request_id=%s task_id=%s",
                row.id, row.clickup_task_id,
            )
    else:
        log.warning(
            "clickup_retraction_comment_skipped_no_task_id request_id=%s", row.id,
        )

    prior = row.status
    repo.delete_by_id(rid)
    log.info(
        "peptide_request_retracted request_id=%s prior_status=%s had_reason=%s",
        rid, prior, bool(reason),
    )
    return {"ok": True}
```

Verify the imports at the top of `main.py` already include `HTTPException`, `Depends`, `UUID`, `ClickUpClient`, `PeptideRequestRepository`, `PeptideRequestRetract`, `get_peptide_request_config`, `require_internal_service_token`, and `os`. All should be present from existing handlers — if any is missing, add it to the import block.

> If `PeptideRequestRetract` is not auto-imported via the existing `from models_peptide_request import (...)` block, add it to that block.

- [ ] **Step 5: Run tests to verify they pass**

```
docker exec accu-mk1-backend python -m pytest backend/tests/test_api_peptide_requests_retract.py -v
```

Expected: 7 passed.

- [ ] **Step 6: Run the full backend suite to catch regressions**

```
docker exec accu-mk1-backend python -m pytest --tb=short -q
```

Expected: `172 passed` (165 existing + 7 new). If any previously-green test fails, stop and investigate before committing.

- [ ] **Step 7: Commit**

```
git -C Accu-Mk1 add backend/main.py backend/models_peptide_request.py backend/tests/test_api_peptide_requests_retract.py
git -C Accu-Mk1 commit -m "feat(peptide-request): POST /peptide-requests/{id}/retract endpoint

Hard-deletes the row when status is new or rejected. Best-effort
ClickUp comment. 409 on non-retractable status."
```

---

## Task 4: Add `retract_peptide_request` adapter method (integration-service)

**Files:**
- Modify: `integration-service/app/adapters/accumk1.py`
- Test: `integration-service/tests/unit/test_accumk1_adapter.py` (existing — append)

- [ ] **Step 1: Write the failing tests**

Append to `integration-service/tests/unit/test_accumk1_adapter.py` (use the existing test file's httpx-mocking style; read the file first if unsure):

```python
import pytest
import httpx
from unittest.mock import AsyncMock, patch
from app.adapters.accumk1 import AccuMk1Adapter


@pytest.mark.asyncio
async def test_retract_peptide_request_posts_with_service_token_and_idempotency(monkeypatch):
    monkeypatch.setenv("ACCUMK1_BASE_URL", "https://mk1.example")
    monkeypatch.setenv("ACCUMK1_INTERNAL_SERVICE_TOKEN", "tok")
    from app.core.config import get_settings
    get_settings.cache_clear()  # if @lru_cache
    adapter = AccuMk1Adapter()

    fake_resp = httpx.Response(200, json={"ok": True})
    async def _fake_post(self, url, headers=None, json=None):
        _fake_post.called_with = {"url": url, "headers": headers, "json": json}
        return fake_resp
    with patch.object(httpx.AsyncClient, "post", new=_fake_post):
        out = await adapter.retract_peptide_request(
            request_id="abc-123",
            body={"reason": "oops"},
        )
    assert out == {"ok": True}
    call = _fake_post.called_with
    assert call["url"] == "https://mk1.example/peptide-requests/abc-123/retract"
    assert call["headers"]["X-Service-Token"] == "tok"
    assert call["headers"]["Idempotency-Key"] == "abc-123:retract"
    assert call["json"] == {"reason": "oops"}


@pytest.mark.asyncio
async def test_retract_peptide_request_raises_on_non_2xx(monkeypatch):
    monkeypatch.setenv("ACCUMK1_BASE_URL", "https://mk1.example")
    monkeypatch.setenv("ACCUMK1_INTERNAL_SERVICE_TOKEN", "tok")
    from app.core.config import get_settings
    get_settings.cache_clear()
    adapter = AccuMk1Adapter()

    fake_resp = httpx.Response(
        409,
        json={"detail": {"code": "request_not_retractable", "message": "x", "current_status": "approved"}},
    )
    async def _fake_post(self, url, headers=None, json=None):
        return fake_resp
    with patch.object(httpx.AsyncClient, "post", new=_fake_post):
        with pytest.raises(httpx.HTTPStatusError):
            await adapter.retract_peptide_request(request_id="x", body={})
```

> If the existing tests use `pytest_httpx` or `respx` instead of `patch.object`, follow that pattern. Read the file first.

- [ ] **Step 2: Run tests to verify they fail**

```
cd integration-service && .venv/Scripts/python.exe -m pytest tests/unit/test_accumk1_adapter.py::test_retract_peptide_request_posts_with_service_token_and_idempotency tests/unit/test_accumk1_adapter.py::test_retract_peptide_request_raises_on_non_2xx -v
```

Expected: FAIL with `AttributeError: 'AccuMk1Adapter' object has no attribute 'retract_peptide_request'`.

- [ ] **Step 3: Implement the adapter method**

Add to `integration-service/app/adapters/accumk1.py` inside the `AccuMk1Adapter` class (after `get_peptide_request`):

```python
    async def retract_peptide_request(
        self,
        *,
        request_id: str,
        body: dict,
    ) -> dict:
        """Retract (hard-delete) a peptide request in Accu-Mk1.

        Calls POST /peptide-requests/{request_id}/retract with
        X-Service-Token and Idempotency-Key headers. The idempotency key
        is derived from `{request_id}:retract` so retries dedupe without
        the caller having to manage a key.

        Args:
            request_id: Accu-Mk1 request id.
            body: {"reason": str | None}.

        Returns:
            Raw response dict (`{"ok": True}` on success).

        Raises:
            httpx.HTTPStatusError: On 4xx/5xx response (service layer maps
                to envelope).
        """
        url = f"{self.base_url}/peptide-requests/{request_id}/retract"
        idem = f"{request_id}:retract"
        logger.info("accumk1_retract_start", url=url, request_id=request_id)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    url,
                    headers=self._headers(idem),
                    json=body,
                )
        except httpx.TimeoutException:
            logger.error("accumk1_retract_timeout", url=url, request_id=request_id)
            raise
        except httpx.RequestError as e:
            logger.error(
                "accumk1_retract_connection_error",
                url=url, request_id=request_id, error=str(e),
            )
            raise
        logger.info(
            "accumk1_retract_response",
            http_status=response.status_code, request_id=request_id,
        )
        response.raise_for_status()
        return response.json()
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd integration-service && .venv/Scripts/python.exe -m pytest tests/unit/test_accumk1_adapter.py -v
```

Expected: all adapter tests pass.

- [ ] **Step 5: Commit**

```
git -C integration-service add app/adapters/accumk1.py tests/unit/test_accumk1_adapter.py
git -C integration-service commit -m "feat(accumk1-adapter): add retract_peptide_request"
```

---

## Task 5: Add retract model + service method (integration-service)

**Files:**
- Modify: `integration-service/app/models/peptide_request.py`
- Modify: `integration-service/app/services/peptide_request.py`
- Test: `integration-service/tests/unit/test_peptide_request_service.py` (existing — append)

- [ ] **Step 1: Add the retract input model**

Append to `integration-service/app/models/peptide_request.py`:

```python
class PeptideRequestRetract(BaseModel):
    """Body for POST /v1/peptide-requests/{id}/retract.

    Customer-provided optional reason. Max 500 chars; anything longer
    is rejected at the WP boundary (this layer just forwards).
    """
    reason: str | None = Field(default=None, max_length=500)
```

(Verify `Field` is already imported at the top; if not, add it to the `from pydantic import ...` line.)

- [ ] **Step 2: Write the failing service test**

Append to `integration-service/tests/unit/test_peptide_request_service.py`:

```python
@pytest.mark.asyncio
async def test_retract_passes_through_to_adapter():
    accumk1 = AsyncMock()
    accumk1.retract_peptide_request.return_value = {"ok": True}
    wp = AsyncMock()
    svc = PeptideRequestService(accumk1=accumk1, wordpress=wp)

    out = await svc.retract(
        customer=WPCustomer(wp_user_id=42, email="a@b.c", name="N"),
        request_id="req-abc",
        reason="wrong compound",
    )
    assert out == {"ok": True}
    accumk1.retract_peptide_request.assert_awaited_once_with(
        request_id="req-abc",
        body={"reason": "wrong compound"},
    )


@pytest.mark.asyncio
async def test_retract_forwards_none_reason_as_null():
    accumk1 = AsyncMock()
    accumk1.retract_peptide_request.return_value = {"ok": True}
    wp = AsyncMock()
    svc = PeptideRequestService(accumk1=accumk1, wordpress=wp)
    await svc.retract(
        customer=WPCustomer(wp_user_id=1, email="a@b.c", name="N"),
        request_id="r",
        reason=None,
    )
    accumk1.retract_peptide_request.assert_awaited_once_with(
        request_id="r",
        body={"reason": None},
    )
```

> The existing file already imports `PeptideRequestService`, `WPCustomer`, and `AsyncMock`. If it uses different fixture/import patterns, match those instead.

- [ ] **Step 3: Run tests to verify they fail**

```
cd integration-service && .venv/Scripts/python.exe -m pytest tests/unit/test_peptide_request_service.py::test_retract_passes_through_to_adapter tests/unit/test_peptide_request_service.py::test_retract_forwards_none_reason_as_null -v
```

Expected: FAIL with `AttributeError: 'PeptideRequestService' object has no attribute 'retract'`.

- [ ] **Step 4: Implement the service method**

Add to `integration-service/app/services/peptide_request.py` on `PeptideRequestService` (after `get_for_customer`):

```python
    async def retract(
        self,
        *,
        customer: WPCustomer,
        request_id: str,
        reason: str | None,
    ) -> dict[str, Any]:
        """Forward a customer retraction to Accu-Mk1.

        Authorization note: Accu-Mk1 does not verify the caller is the
        request owner — it trusts the service-token. The wpstar layer
        verifies ownership against its local snapshot before the JWT is
        minted. We log the customer's wp_user_id here so cross-customer
        retractions would be visible in logs.
        """
        logger.info(
            "peptide_request_retract_forward",
            request_id=request_id,
            wp_user_id=customer.wp_user_id,
            has_reason=reason is not None and reason != "",
        )
        return await self._accumk1.retract_peptide_request(
            request_id=request_id,
            body={"reason": reason},
        )
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd integration-service && .venv/Scripts/python.exe -m pytest tests/unit/test_peptide_request_service.py -v
```

Expected: all service tests pass.

- [ ] **Step 6: Commit**

```
git -C integration-service add app/models/peptide_request.py app/services/peptide_request.py tests/unit/test_peptide_request_service.py
git -C integration-service commit -m "feat(peptide-request): service.retract + PeptideRequestRetract model"
```

---

## Task 6: Add retract route (integration-service)

**Files:**
- Modify: `integration-service/app/api/peptide_requests.py`
- Test: `integration-service/tests/unit/test_api.py` (existing — append; this is where the other peptide_requests API tests live per the existing suite)

- [ ] **Step 1: Write the failing API tests**

Append to `integration-service/tests/unit/test_api.py` (or create `test_peptide_request_retract_api.py` — match whichever convention the rest of the peptide_requests API tests use; check the file first):

```python
def test_retract_requires_jwt(client_no_auth):
    resp = client_no_auth.post("/v1/peptide-requests/abc/retract", json={})
    assert resp.status_code == 401


def test_retract_forwards_to_service(client, monkeypatch):
    # Patch the service dependency so we can assert on its args.
    from app.api import peptide_requests as pr_mod
    called = {}

    async def fake_retract(*, customer, request_id, reason):
        called["args"] = (customer.wp_user_id, request_id, reason)
        return {"ok": True}

    # Swap the service's retract method on the dep-injected instance.
    # Uses the app dependency_overrides mechanism; pattern matches the
    # other tests in this file.
    from app.dependencies import get_peptide_request_service
    class _Fake:
        async def retract(self, *, customer, request_id, reason):
            return await fake_retract(customer=customer, request_id=request_id, reason=reason)
    client.app.dependency_overrides[get_peptide_request_service] = lambda: _Fake()
    try:
        resp = client.post(
            "/v1/peptide-requests/req-xyz/retract",
            json={"reason": "ordered wrong thing"},
        )
    finally:
        client.app.dependency_overrides.pop(get_peptide_request_service, None)

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert called["args"][1] == "req-xyz"
    assert called["args"][2] == "ordered wrong thing"


def test_retract_passes_through_409_envelope(client, monkeypatch):
    import httpx
    from app.dependencies import get_peptide_request_service
    class _Fake:
        async def retract(self, *, customer, request_id, reason):
            resp = httpx.Response(
                409,
                json={"detail": {"code": "request_not_retractable", "message": "x", "current_status": "approved"}},
                request=httpx.Request("POST", "http://x"),
            )
            raise httpx.HTTPStatusError("409", request=resp.request, response=resp)
    client.app.dependency_overrides[get_peptide_request_service] = lambda: _Fake()
    try:
        resp = client.post("/v1/peptide-requests/req-xyz/retract", json={})
    finally:
        client.app.dependency_overrides.pop(get_peptide_request_service, None)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "request_not_retractable"
```

> Fixtures `client` and `client_no_auth` are assumed to exist in `conftest.py` and match the existing test style. If they don't, read `tests/unit/test_peptide_request_service.py` or `conftest.py` to find the real fixture names and adjust.

- [ ] **Step 2: Run tests to verify they fail**

```
cd integration-service && .venv/Scripts/python.exe -m pytest tests/unit/test_api.py::test_retract_requires_jwt tests/unit/test_api.py::test_retract_forwards_to_service tests/unit/test_api.py::test_retract_passes_through_409_envelope -v
```

Expected: FAIL with 404 on the new URL (route not registered).

- [ ] **Step 3: Implement the route**

Add to `integration-service/app/api/peptide_requests.py` after the existing `get_peptide_request` handler (before the `internal_router` block):

```python
@router.post(
    "/{request_id}/retract",
    status_code=http_status.HTTP_200_OK,
    summary="Retract (hard-delete) a customer's peptide request",
)
async def retract_peptide_request(
    request_id: str,
    body: PeptideRequestRetract,
    customer: WPCustomerDep,
    service: PeptideRequestServiceDep,
) -> dict:
    """Forward a customer retraction to Accu-Mk1.

    Gate enforcement is authoritative in Accu-Mk1 (409 when status has
    advanced past retractable). This layer just forwards with the
    customer's JWT-verified identity logged.
    """
    import httpx
    try:
        return await service.retract(
            customer=customer,
            request_id=request_id,
            reason=body.reason,
        )
    except httpx.HTTPStatusError as e:
        # Pass the Accu-Mk1 error envelope straight through. Matches the
        # error-shape convention used elsewhere in this module.
        try:
            payload = e.response.json()
        except Exception:
            payload = {"detail": {"code": "upstream_error", "message": str(e)}}
        raise HTTPException(status_code=e.response.status_code, detail=payload.get("detail", payload))
```

Also extend the import block at the top to add `PeptideRequestRetract`:

```python
from app.models.peptide_request import (
    CouponIssueRequest,
    CouponIssueResponse,
    PeptideRequestForWP,
    PeptideRequestListForWP,
    PeptideRequestRetract,     # ← new
    PeptideRequestStatusRelay,
    PeptideRequestStatusRelayResponse,
    PeptideRequestSubmit,
)
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd integration-service && .venv/Scripts/python.exe -m pytest tests/unit/test_api.py -v
```

Expected: the 3 new tests pass; none of the existing tests regress.

- [ ] **Step 5: Run the full integration-service suite**

```
cd integration-service && .venv/Scripts/python.exe -m pytest tests/ --tb=short -q
```

Expected: `263 passed / 4 pre-existing WP-adapter failures` (260 + 3 new). Watch for regressions — if any previously-green test flips to red, stop.

- [ ] **Step 6: Commit**

```
git -C integration-service add app/api/peptide_requests.py tests/unit/test_api.py
git -C integration-service commit -m "feat(peptide-request): POST /v1/peptide-requests/{id}/retract route"
```

---

## Task 7: Add `delete_snapshot` helper (wpstar)

**Files:**
- Modify: `wp-content/themes/wpstar/includes/peptide-requests/db.php`

This one is trivial; no tests (no PHP test suite). Lint-only verification.

- [ ] **Step 1: Append the helper**

Append to `db.php` (before the final closing PHP tag if any, otherwise at EOF):

```php
/**
 * Hard-delete a snapshot row by peptide_request_id.
 *
 * Called after a successful retract round-trip to Accu-Mk1. Not
 * ownership-scoped — the caller (REST proxy) is responsible for
 * asserting current-user ownership before invoking.
 *
 * @param string $peptide_request_id
 * @return bool True if a row was removed.
 */
function delete_snapshot(string $peptide_request_id): bool
{
    global $wpdb;
    $table = get_table_name();
    $affected = $wpdb->delete($table, ['peptide_request_id' => $peptide_request_id], ['%s']);
    return $affected !== false && $affected > 0;
}
```

- [ ] **Step 2: PHP lint**

```
docker exec devkinsta_fpm php8.2 -l /www/kinsta/public/accumarklabs/wp-content/themes/wpstar/includes/peptide-requests/db.php
```

Expected: `No syntax errors detected`.

- [ ] **Step 3: Commit**

wpstar is inside the WSL DevKinsta volume. Run git from the container:

```
docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && git add includes/peptide-requests/db.php && git commit -m "feat(peptide-request): delete_snapshot helper for retraction"'
```

---

## Task 8: Add retract REST route (wpstar)

**Files:**
- Modify: `wp-content/themes/wpstar/includes/peptide-requests/rest-proxy.php`

- [ ] **Step 1: Add the route registration**

Find the existing `register_submit_route()` function in `rest-proxy.php`. Add a second `add_action` below the existing one at the top of the file (near line 32):

```php
add_action('rest_api_init', __NAMESPACE__ . '\\register_retract_route');
```

Add the new registration function just below `register_submit_route`:

```php
function register_retract_route(): void
{
    register_rest_route('accumark/v1', '/peptide-requests/(?P<id>[A-Za-z0-9-]+)/retract', [
        'methods'             => 'POST',
        'permission_callback' => __NAMESPACE__ . '\\submit_permission_callback',
        'callback'            => __NAMESPACE__ . '\\handle_retract',
    ]);
}
```

- [ ] **Step 2: Add the handler**

Append to the file (after `handle_submit`):

```php
/**
 * Retract a pending peptide request.
 *
 * Ownership: snapshot row must belong to the current WP user. If it
 * doesn't, return 404 so existence is not leaked across accounts.
 *
 * Upstream: integration-service verifies the JWT (same signing chain
 * as submit); Accu-Mk1 is authoritative on the gate (status ∈ {new,
 * rejected}) — we surface its 409 verbatim.
 */
function handle_retract(\WP_REST_Request $request)
{
    $integration_url = defined('ACCUMARK_INTEGRATION_URL') ? ACCUMARK_INTEGRATION_URL : '';
    $jwt_secret      = defined('ACCUMARK_JWT_SECRET') ? ACCUMARK_JWT_SECRET : '';
    if ($integration_url === '' || $jwt_secret === '') {
        return new \WP_Error('integration_not_configured', 'Integration service is not configured.', ['status' => 503]);
    }

    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
        return new \WP_Error('unauthorized', 'Login required.', ['status' => 401]);
    }

    $request_id = (string) $request->get_param('id');
    if ($request_id === '') {
        return new \WP_Error('validation_error', 'Missing request id.', ['status' => 400]);
    }

    // Ownership check — must own the snapshot.
    $snapshot = get_snapshot($request_id, (int) $user->ID);
    if (!$snapshot) {
        return new \WP_Error('not_found', 'Request not found.', ['status' => 404]);
    }

    $body = $request->get_json_params();
    $reason = '';
    if (is_array($body) && isset($body['reason'])) {
        $reason = trim((string) $body['reason']);
        if (strlen($reason) > 500) {
            return new \WP_Error('validation_error', 'Reason is too long (500 char max).', ['status' => 400]);
        }
    }

    $jwt = build_customer_jwt($user, $jwt_secret);
    $endpoint = rtrim((string) $integration_url, '/') . '/v1/peptide-requests/' . rawurlencode($request_id) . '/retract';

    $response = wp_remote_post($endpoint, [
        'headers' => [
            'Authorization' => 'Bearer ' . $jwt,
            'Content-Type'  => 'application/json',
        ],
        'body'    => wp_json_encode(['reason' => $reason === '' ? null : $reason]),
        'timeout' => 20,
    ]);

    if (is_wp_error($response)) {
        error_log('[peptide-request] retract network error: ' . $response->get_error_message());
        return new \WP_Error('upstream_unavailable', 'Could not reach the integration service.', ['status' => 502]);
    }

    $code = (int) wp_remote_retrieve_response_code($response);
    $raw  = (string) wp_remote_retrieve_body($response);
    $decoded = json_decode($raw, true);

    if ($code >= 200 && $code < 300) {
        delete_snapshot($request_id);
        return new \WP_REST_Response(['ok' => true], 200);
    }

    // 409 (gate) and other errors — surface the envelope.
    $payload = is_array($decoded) && isset($decoded['detail']) ? $decoded['detail'] : ['code' => 'upstream_error', 'message' => $raw];
    return new \WP_REST_Response($payload, $code ?: 502);
}
```

- [ ] **Step 3: PHP lint**

```
docker exec devkinsta_fpm php8.2 -l /www/kinsta/public/accumarklabs/wp-content/themes/wpstar/includes/peptide-requests/rest-proxy.php
```

Expected: `No syntax errors detected`.

- [ ] **Step 4: Smoke the route from the host**

```
curl -sS -X POST "https://accumarklabs.local/wp-json/accumark/v1/peptide-requests/00000000-0000-0000-0000-000000000000/retract" -H "Content-Type: application/json" -d '{}' -k
```

Expected: JSON response with a `rest_forbidden` / 401 envelope (not 404 — 404 would mean the route didn't register).

- [ ] **Step 5: Commit**

```
docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && git add includes/peptide-requests/rest-proxy.php && git commit -m "feat(peptide-request): REST retract endpoint proxies to integration-service"'
```

---

## Task 9: Add Retract button + modal markup to detail page (wpstar)

**Files:**
- Modify: `wp-content/themes/wpstar/templates/portal-peptide-request-detail.php`

- [ ] **Step 1: Add the button above the closing `</main>`**

Find the closing of the "What you submitted" block (the `<?php endif; ?>` near the end of the `<main>`). Add this immediately before `</main>`:

```php
        <?php
        // Retract action — only while pre-approval (status=new) or after a
        // rejection. Other states are staff-owned; gate is authoritative
        // in Accu-Mk1 and will 409 any stale attempts.
        $can_retract = in_array($status, ['new', 'rejected'], true);
        if ($can_retract) : ?>
            <section class="portal-card peptide-retract-card">
                <div class="peptide-retract-header">
                    <h2>Retract this request</h2>
                    <p>
                        <?php if ($status === 'rejected') : ?>
                            Remove this rejected request from your list. This cannot be undone.
                        <?php else : ?>
                            Changed your mind? You can retract this request before our team approves it. This cannot be undone.
                        <?php endif; ?>
                    </p>
                </div>
                <button type="button" class="btn btn-danger-outline peptide-retract-open"
                        data-request-id="<?php echo esc_attr($snapshot['peptide_request_id']); ?>">
                    Retract this request
                </button>
            </section>

            <div class="peptide-retract-modal" role="dialog" aria-modal="true" aria-hidden="true" hidden>
                <div class="peptide-retract-modal-backdrop"></div>
                <div class="peptide-retract-modal-content">
                    <h3>Retract this request?</h3>
                    <p class="peptide-retract-modal-body">
                        This cannot be undone. Our team will be notified that you retracted it.
                    </p>
                    <label for="peptide-retract-reason" class="peptide-retract-reason-label">
                        Reason (optional)
                    </label>
                    <textarea id="peptide-retract-reason" rows="3" maxlength="500"
                              placeholder="e.g., ordered the wrong compound"></textarea>
                    <div class="peptide-retract-modal-actions">
                        <button type="button" class="btn btn-secondary peptide-retract-cancel">Cancel</button>
                        <button type="button" class="btn btn-danger peptide-retract-confirm">Retract</button>
                    </div>
                    <div class="peptide-retract-modal-error" role="alert" hidden></div>
                </div>
            </div>
        <?php endif; ?>
```

- [ ] **Step 2: PHP lint**

```
docker exec devkinsta_fpm php8.2 -l /www/kinsta/public/accumarklabs/wp-content/themes/wpstar/templates/portal-peptide-request-detail.php
```

Expected: `No syntax errors detected`.

- [ ] **Step 3: Commit**

```
docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && git add templates/portal-peptide-request-detail.php && git commit -m "feat(peptide-request): retract button + modal markup on detail page"'
```

---

## Task 10: Create `peptide-request-retract.js` + enqueue (wpstar)

**Files:**
- Create: `wp-content/themes/wpstar/assets/js/peptide-request-retract.js`
- Modify: `wp-content/themes/wpstar/functions.php` (or wherever other peptide-request assets are enqueued — grep for `peptide-request-form` or similar first)

- [ ] **Step 1: Find the existing enqueue site**

```
docker exec devkinsta_fpm sh -c 'grep -rn "peptide-request" /www/kinsta/public/accumarklabs/wp-content/themes/wpstar/functions.php /www/kinsta/public/accumarklabs/wp-content/themes/wpstar/includes/ 2>/dev/null | grep -i enqueue'
```

Use the output to locate where JS for the detail-page is enqueued (likely keyed by `is_page_template('templates/portal-peptide-request-detail.php')`). If nothing exists yet for the detail page, add an enqueue alongside the form-page enqueue.

- [ ] **Step 2: Create the JS file**

Create `wp-content/themes/wpstar/assets/js/peptide-request-retract.js`:

```javascript
/* Peptide Request — retract modal (detail page) */
(function () {
    'use strict';

    const openBtn = document.querySelector('.peptide-retract-open');
    const modal = document.querySelector('.peptide-retract-modal');
    if (!openBtn || !modal) return;

    const cancelBtn = modal.querySelector('.peptide-retract-cancel');
    const confirmBtn = modal.querySelector('.peptide-retract-confirm');
    const backdrop = modal.querySelector('.peptide-retract-modal-backdrop');
    const reasonEl = modal.querySelector('#peptide-retract-reason');
    const errorEl = modal.querySelector('.peptide-retract-modal-error');

    function showModal() {
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        reasonEl.value = '';
        errorEl.hidden = true;
        errorEl.textContent = '';
        confirmBtn.disabled = false;
        setTimeout(() => reasonEl.focus(), 0);
    }

    function hideModal() {
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
    }

    function showError(msg, lockOut) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
        if (lockOut) {
            confirmBtn.disabled = true;
            cancelBtn.textContent = 'Close';
        }
    }

    async function submitRetract() {
        const requestId = openBtn.getAttribute('data-request-id');
        if (!requestId) return;

        confirmBtn.disabled = true;
        errorEl.hidden = true;

        try {
            const resp = await fetch(
                '/wp-json/accumark/v1/peptide-requests/' + encodeURIComponent(requestId) + '/retract',
                {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-WP-Nonce': (window.wpApiSettings && window.wpApiSettings.nonce) || '',
                    },
                    body: JSON.stringify({
                        reason: reasonEl.value.trim() || null,
                    }),
                }
            );

            if (resp.ok) {
                // Redirect to list with a flash marker; the list page reads
                // ?retracted=1 and renders a dismiss-able banner.
                window.location.href = '/portal/peptide-requests/?retracted=1';
                return;
            }

            if (resp.status === 409) {
                // Stale snapshot — status advanced. Lock out and point at reload.
                showError('This request can no longer be retracted. Reloading…', true);
                setTimeout(() => window.location.reload(), 1800);
                return;
            }

            let msg = 'Something went wrong. Please try again.';
            try {
                const body = await resp.json();
                if (body && body.message) msg = body.message;
            } catch (_) { /* ignore parse error */ }
            showError(msg, false);
            confirmBtn.disabled = false;
        } catch (err) {
            showError('Network error. Please try again.', false);
            confirmBtn.disabled = false;
        }
    }

    openBtn.addEventListener('click', showModal);
    cancelBtn.addEventListener('click', hideModal);
    backdrop.addEventListener('click', hideModal);
    confirmBtn.addEventListener('click', submitRetract);
    document.addEventListener('keydown', function (e) {
        if (!modal.hidden && e.key === 'Escape') hideModal();
    });
})();
```

- [ ] **Step 3: Enqueue the JS on the detail-page template**

Add an enqueue near the existing peptide-request enqueue (exact location depends on step 1 output). Pattern:

```php
if (is_page_template('templates/portal-peptide-request-detail.php')) {
    wp_enqueue_script(
        'peptide-request-retract',
        get_stylesheet_directory_uri() . '/assets/js/peptide-request-retract.js',
        [],
        filemtime(get_stylesheet_directory() . '/assets/js/peptide-request-retract.js'),
        true
    );
    // Expose wpApiSettings.nonce to the JS (needed for X-WP-Nonce).
    wp_localize_script('peptide-request-retract', 'wpApiSettings', [
        'nonce' => wp_create_nonce('wp_rest'),
    ]);
}
```

- [ ] **Step 4: PHP lint whatever file received the enqueue**

```
docker exec devkinsta_fpm php8.2 -l /www/kinsta/public/accumarklabs/wp-content/themes/wpstar/<file-that-was-modified>.php
```

Expected: `No syntax errors detected`.

- [ ] **Step 5: Hard-reload the detail page**

Ask the user to hard-reload `/portal/peptide-request/?id=<any-existing-new-or-rejected-id>` and confirm:
- "Retract this request" button appears below the submitted-fields card.
- Clicking it opens the modal.
- Clicking Cancel closes the modal.

- [ ] **Step 6: Commit**

```
docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && git add assets/js/peptide-request-retract.js <functions-or-includes-file> && git commit -m "feat(peptide-request): retract modal JS + enqueue on detail page"'
```

---

## Task 11: Add CSS for retract button + modal (wpstar)

**Files:**
- Modify: existing portal CSS (find it — likely `assets/css/portal-peptide-request.css` per the existing file list; otherwise add to the closest existing portal stylesheet).

- [ ] **Step 1: Find the existing portal CSS**

```
docker exec devkinsta_fpm sh -c 'ls /www/kinsta/public/accumarklabs/wp-content/themes/wpstar/assets/css/ | grep -i -E "portal|peptide"'
```

Pick the closest stylesheet that's already enqueued on the detail page (look for the .peptide-stepper, .portal-card, etc. rules — extend that one).

- [ ] **Step 2: Append the styles**

Append to the chosen stylesheet:

```css
/* ── Peptide Request — retract button + modal ───────────────────────── */

.peptide-retract-card { margin-top: 1rem; }
.peptide-retract-header h2 { margin: 0 0 .25rem; font-size: 1rem; }
.peptide-retract-header p  { margin: 0 0 1rem; color: #6b7280; font-size: .875rem; }

.btn.btn-danger-outline {
    background: transparent;
    color: #b91c1c;
    border: 1px solid #b91c1c;
}
.btn.btn-danger-outline:hover { background: #fef2f2; }
.btn.btn-danger {
    background: #b91c1c; color: #fff; border: 1px solid #b91c1c;
}
.btn.btn-danger:hover { background: #991b1b; }
.btn.btn-danger:disabled { opacity: .6; cursor: not-allowed; }

.peptide-retract-modal {
    position: fixed; inset: 0;
    z-index: 9999;
    display: flex; align-items: center; justify-content: center;
}
.peptide-retract-modal[hidden] { display: none; }
.peptide-retract-modal-backdrop {
    position: absolute; inset: 0;
    background: rgba(17, 24, 39, .55);
}
.peptide-retract-modal-content {
    position: relative;
    background: #fff;
    border-radius: 12px;
    padding: 1.5rem;
    max-width: 480px; width: calc(100% - 2rem);
    box-shadow: 0 10px 25px rgba(0, 0, 0, .15);
}
.peptide-retract-modal-content h3 { margin: 0 0 .5rem; }
.peptide-retract-modal-body       { margin: 0 0 1rem; color: #374151; font-size: .875rem; }
.peptide-retract-reason-label     { display: block; margin-bottom: .25rem; font-size: .875rem; color: #6b7280; }
.peptide-retract-modal-content textarea {
    width: 100%; box-sizing: border-box;
    padding: .5rem .75rem;
    border: 1px solid #d1d5db; border-radius: 6px;
    font-family: inherit; font-size: .875rem;
    resize: vertical;
}
.peptide-retract-modal-actions {
    display: flex; justify-content: flex-end; gap: .5rem;
    margin-top: 1rem;
}
.peptide-retract-modal-error {
    margin-top: .75rem;
    padding: .5rem .75rem;
    background: #fef2f2; color: #991b1b;
    border-radius: 6px; font-size: .875rem;
}
```

- [ ] **Step 3: Reload the detail page and confirm visual**

Ask the user to reload and confirm:
- Button is red-outlined, not filled.
- Modal backdrop darkens the page.
- Textarea fits the modal width.
- "Cancel" is secondary, "Retract" is red-filled.

- [ ] **Step 4: Commit**

```
docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && git add assets/css/<filename>.css && git commit -m "style(peptide-request): retract button + modal styling"'
```

---

## Task 12: End-to-end verification

- [ ] **Step 1: Verify Accu-Mk1 tests**

```
docker exec accu-mk1-backend python -m pytest --tb=short -q
```

Expected: `172 passed` (or strictly greater; never fewer). Stop the plan here if anything regressed.

- [ ] **Step 2: Verify integration-service tests**

```
cd integration-service && .venv/Scripts/python.exe -m pytest tests/ --tb=short -q
```

Expected: `263 passed, 4 failed` (the 4 pre-existing WP-adapter failures from the handoff). Any NEW failures = regression, stop.

- [ ] **Step 3: Manual E2E — happy path (new → retracted)**

In a browser, logged in as `forrest@valenceanalytical.com`:

1. Submit a new peptide request via `/portal/new-peptide-request/` with a reason note and some form fields.
2. Go to `/portal/peptide-request/?id={the-new-id}` — confirm the Retract button is visible.
3. Click Retract → fill in reason "E2E test retraction" → confirm.
4. Expect redirect to `/portal/peptide-requests/?retracted=1`.
5. Expect the request to be gone from the list.
6. In ClickUp, find the card for that compound — confirm a comment was posted: `Customer retracted this request on {today}. Reason: E2E test retraction`.
7. Check the Accu-Mk1 DB directly: `docker exec accu-mk1-backend python -c "from peptide_request_repo import PeptideRequestRepository; from uuid import UUID; r = PeptideRequestRepository(); print(r.get_by_id(UUID('{id}')))"` → expect `None`.

- [ ] **Step 4: Manual E2E — gate enforcement**

1. Submit another new peptide request.
2. In ClickUp, drag the card to APPROVED.
3. Wait for the webhook + WP relay (check `docker logs --tail 20 accu-mk1-backend | grep -i webhook`).
4. Reload the detail page — expect the Retract button is gone (because status is now `approved`).
5. (Optional stale-snapshot test) Manually tamper: `DELETE` the snapshot row, submit a new one via form, then in the DB directly bump status to `approved` without triggering a relay. Reload the detail page with the old snapshot showing — button still shows. Click Retract → expect the 409-modal "This request can no longer be retracted" + auto-reload.

- [ ] **Step 5: Manual E2E — rejected → retracted**

1. Submit another request.
2. In ClickUp, drag it to REJECTED.
3. Wait for the relay.
4. Reload the detail page — Retract button still shows (copy reads "Remove this rejected request…").
5. Retract → expect same success flow as Task 12/Step 3, with a ClickUp comment on the rejected card.

- [ ] **Step 6: Final commit — push branch heads**

**HOLD for user confirmation before pushing.** Per handoff rule: ask before any push or PR open.

When user says go:

```
git -C Accu-Mk1 push origin feat/peptide-request-v1
git -C integration-service push origin feat/peptide-request-v1
docker exec devkinsta_fpm sh -c 'cd /www/kinsta/public/accumarklabs/wp-content/themes/wpstar && git push origin feat/peptide-request-v1'
```

PR status unchanged — Accu-Mk1 and integration-service remain OPEN on #1 each; wpstar remains not-opened per the big-bang hold.

- [ ] **Step 7: Rebake `accu-mk1-backend` image**

The new route lands via source, but the container runs a baked image. `docker cp` is still the previous-session ephemeral; a rebuild locks in both the `approved` column-map fix AND the retraction endpoint:

```
cd Accu-Mk1 && docker compose build accu-mk1-backend && docker compose up -d accu-mk1-backend
```

After restart, re-run the Accu-Mk1 test suite against the restarted container to confirm everything is wired:

```
docker exec accu-mk1-backend python -m pytest --tb=short -q
```

---

## Notes on scope

This plan is **one focused feature** spanning three repos. Each repo's tasks are independent of the others only up to the service boundary — don't merge out of order. The big-bang cutover rule from the handoff still applies: all three PRs ship together.
