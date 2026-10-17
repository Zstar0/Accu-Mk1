# ACOA Supersede + Revoke, Plan 3 of 3: Accu-Mk1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every certificate card in the sample details page (primary, Core, per-vial, ACOA and each ACOA's earlier versions) gets the same Forward switch and Revoke dialog; revoking a primary can take every other certificate of the sample; the backend records who revoked.

**Architecture:** Two thin admin-only proxy routes onto the Integration Service (preview + revoke), with `revoked_by` filled from the session server-side. One shared `RevokeCOADialog` and one shared `ForwardToCurrentToggle` component used by all three lists; a pure `selectEarlierVersions()` selector walks `superseded_by_id` to hang superseded ACOA versions under their current ACOA.

**Tech Stack:** Python 3 / FastAPI (backend proxy), React 19 + TypeScript + Zustand + shadcn/ui (frontend), vitest + Testing Library, ESLint, ast-grep, Prettier. npm only.

**Spec:** `C:\tmp\is-integrity\docs\superpowers\specs\2026-09-23-accuverify-acoa-supersede-revoke-design.md` (sections 4.4, 5, 6, 7). Depends on Plan 1 (IS routes and list fields) at runtime; unit tests here mock the IS calls, so the plan can be built before Plan 1 deploys.

## Global Constraints

- Worktree: `C:\tmp\Accu-Mk1-integrity`, branch `feat/coa-forward-revoke-controls`, based on `origin/master` = v1.27.0. `npm ci` already ran here. Never `cd` to the main checkout.
- Backend: run from `C:\tmp\Accu-Mk1-integrity\backend` with `PY="C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe"`; tests `$PY -m pytest -q -p no:cacheprovider <file>`. Never bare `python`.
- Frontend: run from `C:\tmp\Accu-Mk1-integrity`: `npx vitest run <files>`, `npm run -s typecheck`, `npx eslint <files>`, `npx ast-grep scan <files>`, `npx prettier --write <new files only>`. **Never** run repo-wide Prettier (1329 pre-existing style diffs). `SampleDetails.tsx` and `api.ts` are Prettier-dirty at master; leave them that way.
- Regression gates are failure-set diffs: backend baseline `/c/tmp/mk1-integrity-baseline-clean.txt` (156 lines, log-noise lines removed); frontend = typecheck clean + the named test files green + eslint/ast-grep clean on added lines.
- GitNexus (repo CLAUDE.md): before editing a named function or component run `gitnexus_impact({target: "<symbol>", direction: "upstream", repo: "Accu-Mk1"})` and report the blast radius. The index covers the main checkout (stale vs this worktree); still run it and say so.
- Zustand: selector syntax only (`useAuthStore(s => s.user?.role === 'admin')`), never destructuring (ast-grep enforces it).
- Files check out CRLF; prefer the Edit tool. No em dashes in new code, comments, copy or tests (an ellipsis character `…` is fine and already used).
- Commits: only when the Handler asks. **Before Task 1, ask the Handler whether to commit per task.** If not authorised, skip every Commit step. Pathspec commits, message trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/main.py` | `_proxy_explorer_send` gains GET; `RevokeCOARequest {reason, include_codes}`; preview/revoke response models; `_revoked_by_label()`; two admin routes; `superseded_by_id` + `revoked_by` on `ExplorerCOAGenerationResponse` |
| `backend/tests/test_coa_generation_state_proxy.py` | rewritten |
| `src/lib/api.ts` | `RevokePreview*`, `RevokeCOAResult` types; `getCoaRevokePreview()`, `revokeCoaGeneration(id, reason, includeCodes)`; `ExplorerCOAGeneration.superseded_by_id / revoked_by` |
| `src/components/senaite/SampleDetails.tsx` | `RevokeCOADialog` (replaces `RevokeCOAButton`), `ForwardToCurrentToggle`, `selectEarlierVersions`, `EarlierVersionsList`; controls on `GeneratedCOAFallbackList`, `AdditionalCoaCard`, `VialCOAList`; mount sites |
| `src/test/coa-revoke-api.test.ts`, `src/test/select-earlier-versions.test.ts`, `src/test/additional-coa-card-verdicts.test.tsx`, `src/test/vial-coa-list-verdicts.test.tsx` | new |
| `src/test/generated-coa-fallback-verdicts.test.tsx` | updated for the dialog |

---

### Task 1: Backend proxies: preview, revoke with `revoked_by`, list fields

**Files:**
- Modify: `backend/main.py` (`_proxy_explorer_send` at ~line 11703; the block from `# --- COA generation state: revoke / forward pointer` through `set_coa_forward_enabled`; `class ExplorerCOAGenerationResponse` at ~line 9559)
- Rewrite: `backend/tests/test_coa_generation_state_proxy.py`

**Interfaces:**
- Produces: `GET /explorer/coa-generations/{id}/revoke-preview` (admin) -> IS preview body verbatim; `POST /explorer/coa-generations/{id}/revoke` (admin) body `{reason, include_codes?}` -> IS revoke body verbatim, with `revoked_by` = `"First Last <email>"` added server-side; `PATCH .../forward` unchanged (any logged-in user). `ExplorerCOAGenerationResponse` gains `superseded_by_id`, `revoked_by`.
- Consumes: Plan 1 routes of the same paths under `/explorer`.

- [ ] **Step 1: GitNexus impact**

Run `gitnexus_impact({target: "revoke_coa_generation", direction: "upstream", repo: "Accu-Mk1"})` and `gitnexus_impact({target: "_proxy_explorer_send", direction: "upstream", repo: "Accu-Mk1"})`. Report the risk level. (Expected LOW; the index predates this branch, say so.)

- [ ] **Step 2: Rewrite the failing tests**

Replace the whole of `backend/tests/test_coa_generation_state_proxy.py` with:

```python
"""Mk1 -> IS proxy routes for COA generation state: preview, revoke, forward.

Thin proxies onto the Integration Service explorer routes. The tests pin: the
exact IS path and body each one sends, that revoked_by is composed on the
server from the session (never taken from the browser), that an IS HTTP error
keeps its status (a 409 there is a 409 here), that an unreachable IS is a 503,
and the role gates: revoke and its preview are admin only, the forward switch
stays at Publish's gate.

Direct-call tests drive the coroutines; the last group goes through the mounted
app so the URLs and the gates are real.
"""

import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from auth import get_current_user


class _FakeClient:
    def __init__(self, captured, *, status=200, body=None, error=None):
        self._captured = captured
        self._status = status
        self._body = body or {}
        self._error = error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def _send(self, method, url, json=None, headers=None):
        self._captured.update({"method": method, "url": url, "body": json, "headers": headers or {}})
        if self._error:
            raise self._error
        status, body = self._status, self._body

        def raise_for_status():
            if status >= 400:
                raise httpx.HTTPStatusError(
                    "err", request=httpx.Request(method, url), response=httpx.Response(status, text="is says no")
                )

        return SimpleNamespace(status_code=status, raise_for_status=raise_for_status, json=lambda: body)

    async def get(self, url, headers=None):
        return await self._send("GET", url, headers=headers)

    async def post(self, url, json=None, headers=None):
        return await self._send("POST", url, json=json, headers=headers)

    async def patch(self, url, json=None, headers=None):
        return await self._send("PATCH", url, json=json, headers=headers)


def _patch_is(monkeypatch, captured, **client_kwargs):
    monkeypatch.setattr(main, "INTEGRATION_SERVICE_URL", "http://is.test")
    monkeypatch.setattr(main, "INTEGRATION_SERVICE_API_KEY", "k-test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: _FakeClient(captured, **client_kwargs))


GEN = "11111111-1111-4111-8111-111111111111"
ADMIN = SimpleNamespace(id=1, role="admin", first_name="Ada", last_name="Lovelace", email="ada@lab.test")
PREVIEW = {
    "target": {"generation_id": GEN, "verification_code": "PRIM-0002", "status": "published", "kind": "primary", "brand": None},
    "others": [
        {"generation_id": "22222222-2222-4222-8222-222222222222", "verification_code": "ACOA-0002", "status": "published", "kind": "additional", "brand": "Acme"},
    ],
}
REVOKED = {
    "revoked": [
        {"generation_id": GEN, "verification_code": "PRIM-0002", "status": "revoked", "kind": "primary", "brand": None,
         "revoked_at": "2026-09-23T15:04:05+00:00", "revocation_reason": "Lot recalled"},
    ],
    "skipped": [],
    "wp_notified": True,
    "wp_error": None,
}


# --- direct calls ------------------------------------------------------------

def test_revoke_posts_reason_codes_and_a_server_composed_revoked_by(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)

    out = asyncio.run(
        main.revoke_coa_generation(GEN, main.RevokeCOARequest(reason="Lot recalled", include_codes=["ACOA-0002"]), admin=ADMIN)
    )

    assert captured["method"] == "POST"
    assert captured["url"] == f"http://is.test/explorer/coa-generations/{GEN}/revoke"
    assert captured["body"] == {"reason": "Lot recalled", "include_codes": ["ACOA-0002"], "revoked_by": "Ada Lovelace <ada@lab.test>"}
    assert captured["headers"]["X-API-Key"] == "k-test"
    assert out["revoked"][0]["status"] == "revoked" and out["wp_notified"] is True


def test_revoked_by_falls_back_to_the_email_when_no_name_is_set(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)
    nameless = SimpleNamespace(id=2, role="admin", first_name=None, last_name=None, email="ops@lab.test")
    asyncio.run(main.revoke_coa_generation(GEN, main.RevokeCOARequest(reason="r"), admin=nameless))
    assert captured["body"]["revoked_by"] == "ops@lab.test <ops@lab.test>"


def test_preview_proxies_a_get(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=PREVIEW)
    out = asyncio.run(main.revoke_coa_preview(GEN, _admin=ADMIN))
    assert captured["method"] == "GET"
    assert captured["url"] == f"http://is.test/explorer/coa-generations/{GEN}/revoke-preview"
    assert out["others"][0]["verification_code"] == "ACOA-0002"


def test_forward_patches_flag_to_is(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body={"generation_id": GEN, "verification_code": "OLD-0001", "status": "superseded",
                                            "forward_enabled": True, "revoked_at": None, "revocation_reason": None})
    out = asyncio.run(main.set_coa_forward_enabled(GEN, main.ForwardEnabledRequest(forward_enabled=True), _current_user=None))
    assert captured["method"] == "PATCH"
    assert captured["url"] == f"http://is.test/explorer/coa-generations/{GEN}/forward"
    assert captured["body"] == {"forward_enabled": True}
    assert out["forward_enabled"] is True


def test_is_http_error_keeps_its_status(monkeypatch):
    _patch_is(monkeypatch, {}, status=409)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.revoke_coa_generation(GEN, main.RevokeCOARequest(reason="x"), admin=ADMIN))
    assert exc.value.status_code == 409
    assert "is says no" in str(exc.value.detail)


def test_is_unreachable_is_503(monkeypatch):
    _patch_is(monkeypatch, {}, error=httpx.ConnectError("refused"))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.revoke_coa_preview(GEN, _admin=ADMIN))
    assert exc.value.status_code == 503


# --- mounted app: URLs and role gates ----------------------------------------

def _as(role):
    main.app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=1, role=role, first_name="Ada", last_name="Lovelace", email="ada@lab.test"
    )
    return TestClient(main.app)


def _clear():
    main.app.dependency_overrides.pop(get_current_user, None)


def test_non_admin_cannot_revoke_or_preview(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)
    try:
        r1 = _as("hplc").post(f"/explorer/coa-generations/{GEN}/revoke", json={"reason": "x"})
        r2 = _as("hplc").get(f"/explorer/coa-generations/{GEN}/revoke-preview")
    finally:
        _clear()
    assert r1.status_code == 403 and r2.status_code == 403
    assert "url" not in captured  # IS never called


def test_admin_revoke_and_preview_go_through_the_mounted_routes(monkeypatch):
    captured = {}
    _patch_is(monkeypatch, captured, body=REVOKED)
    try:
        resp = _as("admin").post(f"/explorer/coa-generations/{GEN}/revoke", json={"reason": "Lot recalled"})
    finally:
        _clear()
    assert resp.status_code == 200
    assert resp.json()["revoked"][0]["verification_code"] == "PRIM-0002"
    assert captured["body"]["revoked_by"] == "Ada Lovelace <ada@lab.test>"
    assert captured["body"]["include_codes"] == []

    captured.clear()
    _patch_is(monkeypatch, captured, body=PREVIEW)
    try:
        resp = _as("admin").get(f"/explorer/coa-generations/{GEN}/revoke-preview")
    finally:
        _clear()
    assert resp.status_code == 200 and resp.json()["target"]["kind"] == "primary"


def test_any_lab_user_can_set_the_forward_switch(monkeypatch):
    """Reversible and per-COA, so it stays at the same gate as Publish."""
    captured = {}
    _patch_is(monkeypatch, captured, body={"generation_id": GEN, "verification_code": "OLD-0001", "status": "superseded",
                                            "forward_enabled": True, "revoked_at": None, "revocation_reason": None})
    try:
        resp = _as("hplc").patch(f"/explorer/coa-generations/{GEN}/forward", json={"forward_enabled": True})
    finally:
        _clear()
    assert resp.status_code == 200 and resp.json()["forward_enabled"] is True


def test_generation_list_model_declares_the_chain_and_author_fields():
    fields = main.ExplorerCOAGenerationResponse.model_fields
    assert {"superseded_by_id", "revoked_by", "forward_enabled", "revoked_at", "revocation_reason"} <= set(fields)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `backend/`): `$PY -m pytest -q -p no:cacheprovider tests/test_coa_generation_state_proxy.py`
Expected: failures on `main.revoke_coa_preview` (AttributeError), `admin=` unexpected keyword, `include_codes` unknown field, and the list-model assertion.

- [ ] **Step 4: Teach the proxy helper GET**

In `backend/main.py`, replace the whole `_proxy_explorer_send` function with:

```python
async def _proxy_explorer_send(method: str, path: str, json: Optional[dict] = None) -> dict:
    """Proxy a request to the Integration Service explorer API.

    IS status codes pass through (a 409 there is a 409 here, not a 500);
    an unreachable IS is a 503. GET sends no body.
    """
    url = f"{INTEGRATION_SERVICE_URL}/explorer{path}"
    headers = {"X-API-Key": INTEGRATION_SERVICE_API_KEY}
    try:
        async with httpx.AsyncClient(verify=HTTPX_SSL_CONTEXT, timeout=15.0) as client:
            if method.upper() == "GET":
                resp = await client.get(url, headers=headers)
            else:
                send = getattr(client, method.lower())
                resp = await send(url, json=json, headers=headers)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=503, detail=f"Integration Service unavailable: {e}")
```

- [ ] **Step 5: Replace the request model and the revoke route; add preview**

In `backend/main.py`, replace

```python
class RevokeCOARequest(BaseModel):
    reason: str = Field(..., min_length=1, description="Printed on the public verdict")
```

with

```python
class RevokeCOARequest(BaseModel):
    reason: str = Field(..., min_length=1, description="Printed on the public verdict")
    include_codes: list[str] = Field(
        default_factory=list,
        description="Other certificates of the sample to revoke too (primary only; exactly the previewed codes)",
    )


class RevokePreviewItem(BaseModel):
    generation_id: str
    verification_code: str
    status: str
    kind: str
    brand: Optional[str] = None


class RevokePreviewResponse(BaseModel):
    target: RevokePreviewItem
    others: list[RevokePreviewItem]


class RevokedCertificate(RevokePreviewItem):
    revoked_at: Optional[datetime] = None
    revocation_reason: Optional[str] = None


class RevokeCOAResponse(BaseModel):
    revoked: list[RevokedCertificate]
    skipped: list[str]
    wp_notified: bool
    wp_error: Optional[str] = None


def _revoked_by_label(user) -> str:
    """'First Last <email>' from the session user; the email stands in for a missing name."""
    name = " ".join(p for p in (getattr(user, "first_name", None), getattr(user, "last_name", None)) if p).strip()
    email = getattr(user, "email", "") or ""
    if not email:
        return name or "unknown"
    return f"{name or email} <{email}>"
```

Then replace the whole `revoke_coa_generation` route (decorator through its `return`) with:

```python
@app.get("/explorer/coa-generations/{generation_id}/revoke-preview", response_model=RevokePreviewResponse)
async def revoke_coa_preview(generation_id: str, _admin=Depends(require_admin)):
    """What 'also revoke every other certificate for this sample' would take. Admin only."""
    return await _proxy_explorer_send("GET", f"/coa-generations/{generation_id}/revoke-preview")


@app.post("/explorer/coa-generations/{generation_id}/revoke", response_model=RevokeCOAResponse)
async def revoke_coa_generation(
    generation_id: str, body: RevokeCOARequest, admin=Depends(require_admin)
):
    """Terminal: the certificate no longer stands and nothing replaces it.

    Admin only: revocation is public, irreversible through the UI, and the kind
    of withdrawal ISO 17025 expects to be an authorised act. revoked_by is taken
    from the session here, never from the request body.
    """
    payload = {**body.model_dump(), "revoked_by": _revoked_by_label(admin)}
    return await _proxy_explorer_send("POST", f"/coa-generations/{generation_id}/revoke", payload)
```

`set_coa_forward_enabled` stays exactly as it is.

- [ ] **Step 6: Extend the list model**

In `class ExplorerCOAGenerationResponse` (near line 9559), directly after

```python
    revocation_reason: Optional[str] = None
```

add

```python
    # Recorded replacement (the row that superseded this one) and who revoked.
    superseded_by_id: Optional[str] = None
    revoked_by: Optional[str] = None
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `$PY -m pytest -q -p no:cacheprovider tests/test_coa_generation_state_proxy.py`
Expected: `10 passed`.

- [ ] **Step 8: Commit (if authorised)**

```bash
cd /c/tmp/Accu-Mk1-integrity
git commit -m "feat(coa): admin-only revoke preview + batch revoke proxies; revoked_by from the session

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/main.py backend/tests/test_coa_generation_state_proxy.py
```

---

### Task 2: API client: types and functions

**Files:**
- Modify: `src/lib/api.ts` (`export interface ExplorerCOAGeneration` at ~line 1019; the `COA generation state` block at ~line 2092)
- Create: `src/test/coa-revoke-api.test.ts`

**Interfaces:**
- Produces:
  - `interface RevokePreviewItem { generation_id: string; verification_code: string; status: string; kind: 'primary' | 'additional' | 'vial' | 'regular'; brand: string | null }`
  - `interface RevokePreview { target: RevokePreviewItem; others: RevokePreviewItem[] }`
  - `interface RevokedCertificate extends RevokePreviewItem { revoked_at: string | null; revocation_reason: string | null }`
  - `interface RevokeCOAResult { revoked: RevokedCertificate[]; skipped: string[]; wp_notified: boolean; wp_error: string | null }`
  - `getCoaRevokePreview(generationId): Promise<RevokePreview>`
  - `revokeCoaGeneration(generationId, reason, includeCodes: string[] = []): Promise<RevokeCOAResult>` (signature change from Tier 1)
  - `ExplorerCOAGeneration.superseded_by_id?: string | null`, `revoked_by?: string | null`

- [ ] **Step 1: Write the failing test**

Create `src/test/coa-revoke-api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCoaRevokePreview, revokeCoaGeneration } from '@/lib/api'

// The wrappers must hit the Mk1 proxy paths with the exact body the backend
// expects; revoked_by is NOT sent from the browser.

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('revoke API client', () => {
  it('getCoaRevokePreview GETs the preview route', async () => {
    const fetchMock = stubFetch({ target: { generation_id: 'g1' }, others: [] })
    const out = await getCoaRevokePreview('g1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/explorer\/coa-generations\/g1\/revoke-preview$/)
    expect(init?.method ?? 'GET').toBe('GET')
    expect(out.others).toEqual([])
  })

  it('revokeCoaGeneration POSTs reason and include_codes only', async () => {
    const fetchMock = stubFetch({ revoked: [], skipped: [], wp_notified: true, wp_error: null })
    await revokeCoaGeneration('g1', 'Lot recalled', ['ACOA-0002'])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/explorer\/coa-generations\/g1\/revoke$/)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Lot recalled', include_codes: ['ACOA-0002'] })
  })

  it('revokeCoaGeneration defaults include_codes to an empty list', async () => {
    const fetchMock = stubFetch({ revoked: [], skipped: [], wp_notified: true, wp_error: null })
    await revokeCoaGeneration('g1', 'r')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reason: 'r', include_codes: [] })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/coa-revoke-api.test.ts`
Expected: `getCoaRevokePreview` is not exported (import error) and the body assertion fails.

- [ ] **Step 3: Extend the type**

In `src/lib/api.ts`, in `export interface ExplorerCOAGeneration`, directly after

```ts
  revocation_reason?: string | null
```

add

```ts
  /** The row that superseded this one (recorded at publish); null when nothing did. */
  superseded_by_id?: string | null
  revoked_by?: string | null
```

- [ ] **Step 4: Replace the client block**

In `src/lib/api.ts`, replace everything from the line `// ── COA generation state: revoke / forward pointer (2026-09-22)` through the end of `setCoaForwardEnabled` (its closing `}`) with:

```ts
// ── COA generation state: revoke / forward pointer (2026-09-22, batch revoke 2026-09-24) ──

export interface COAGenerationState {
  generation_id: string
  verification_code: string
  status: string
  forward_enabled: boolean
  revoked_at: string | null
  revocation_reason: string | null
}

export interface RevokePreviewItem {
  generation_id: string
  verification_code: string
  status: string
  kind: 'primary' | 'additional' | 'vial' | 'regular'
  brand: string | null
}

export interface RevokePreview {
  target: RevokePreviewItem
  others: RevokePreviewItem[]
}

export interface RevokedCertificate extends RevokePreviewItem {
  revoked_at: string | null
  revocation_reason: string | null
}

export interface RevokeCOAResult {
  revoked: RevokedCertificate[]
  skipped: string[]
  wp_notified: boolean
  wp_error: string | null
}

/** What "also revoke every other certificate issued for this sample" would take. Admin only. */
export async function getCoaRevokePreview(
  generationId: string
): Promise<RevokePreview> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/coa-generations/${encodeURIComponent(generationId)}/revoke-preview`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(await extractErrorMessage(response, `Revoke preview failed: ${response.status}`))
  return response.json()
}

/**
 * Terminal: the certificate no longer stands and nothing replaces it. The reason
 * is printed on the public verdict. includeCodes must be exactly the codes the
 * preview showed; the server skips anything else. Admin only.
 */
export async function revokeCoaGeneration(
  generationId: string,
  reason: string,
  includeCodes: string[] = []
): Promise<RevokeCOAResult> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/coa-generations/${encodeURIComponent(generationId)}/revoke`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ reason, include_codes: includeCodes }),
    }
  )
  if (!response.ok) throw new Error(await extractErrorMessage(response, `COA revoke failed: ${response.status}`))
  return response.json()
}

/** Once superseded, the public verdict announces the supersession and links to the current COA only while this is on. */
export async function setCoaForwardEnabled(
  generationId: string,
  forwardEnabled: boolean
): Promise<COAGenerationState> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/coa-generations/${encodeURIComponent(generationId)}/forward`,
    { method: 'PATCH', headers: getBearerHeaders('application/json'), body: JSON.stringify({ forward_enabled: forwardEnabled }) }
  )
  if (!response.ok) throw new Error(await extractErrorMessage(response, `COA forward update failed: ${response.status}`))
  return response.json()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx prettier --write src/test/coa-revoke-api.test.ts && npx vitest run src/test/coa-revoke-api.test.ts && npm run -s typecheck`
Expected: 3 passed; typecheck reports errors only in `src/test/generated-coa-fallback-verdicts.test.tsx` (the old `mockRevoke.mockResolvedValue` shape) and in `SampleDetails.tsx` where `revokeCoaGeneration(gen.id, reason.trim())` still compiles (2 args are valid). If typecheck is clean, continue; Task 3 fixes the test file.

- [ ] **Step 6: Commit (if authorised)**

```bash
cd /c/tmp/Accu-Mk1-integrity
git add src/test/coa-revoke-api.test.ts
git commit -m "feat(api): revoke preview + batch revoke client, chain and author fields on generations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/lib/api.ts src/test/coa-revoke-api.test.ts
```

---

### Task 3: `RevokeCOADialog` and `ForwardToCurrentToggle` on the primary list

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (imports at ~line 82-90; `function RevokeCOAButton` at ~line 824-908; the row controls inside `GeneratedCOAFallbackList` at ~line 972-1010)
- Modify: `src/test/generated-coa-fallback-verdicts.test.tsx`

**Interfaces:**
- Produces: `export function RevokeCOADialog({ gen, onRevoked }: { gen: ExplorerCOAGeneration; onRevoked?: () => void })` (replaces `RevokeCOAButton`; hidden for non-admins); `export function ForwardToCurrentToggle({ gen, onChanged }: { gen: ExplorerCOAGeneration; onChanged?: () => void })`.
- Consumes: Task 2 `getCoaRevokePreview`, `revokeCoaGeneration(id, reason, includeCodes)`, `RevokePreviewItem`; `toast.warning` from sonner.

- [ ] **Step 1: GitNexus impact**

Run `gitnexus_impact({target: "GeneratedCOAFallbackList", direction: "upstream", repo: "Accu-Mk1"})` and report.

- [ ] **Step 2: Update the failing tests**

In `src/test/generated-coa-fallback-verdicts.test.tsx`:

(a) Change the api mock to also stub the preview, and the sonner mock to include `warning`:

```ts
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    setCoaForwardEnabled: vi.fn(),
    revokeCoaGeneration: vi.fn(),
    getCoaRevokePreview: vi.fn(),
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))
```

and after the existing imports add `import { getCoaRevokePreview } from '@/lib/api'` alongside the others, plus `const mockPreview = vi.mocked(getCoaRevokePreview)` and `mockPreview.mockReset()` inside `beforeEach`.

(b) In `offers Revoke on issued rows only, and sends the typed reason`, replace the `mockRevoke.mockResolvedValue({...})` block with

```ts
    mockRevoke.mockResolvedValue({
      revoked: [
        {
          generation_id: 'g2',
          verification_code: 'NEW-0002',
          status: 'revoked',
          kind: 'primary',
          brand: null,
          revoked_at: '2026-09-22T12:00:00Z',
          revocation_reason: 'Sample mix-up',
        },
      ],
      skipped: [],
      wp_notified: true,
      wp_error: null,
    })
```

change `fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))` to `fireEvent.click(screen.getByRole('button', { name: /^revoke 1 certificate$/i }))`, and the assertion to `expect(mockRevoke).toHaveBeenCalledWith('g2', 'Sample mix-up', [])`.

(c) Append these tests inside the `describe` block:

```ts
  it('on a primary, ticking the cascade box previews the others and sends exactly those codes', async () => {
    mockPreview.mockResolvedValue({
      target: { generation_id: 'g2', verification_code: 'NEW-0002', status: 'published', kind: 'primary', brand: null },
      others: [
        { generation_id: 'g9', verification_code: 'ACOA-0009', status: 'published', kind: 'additional', brand: 'Acme Peptides' },
        { generation_id: 'g1', verification_code: 'OLD-0001', status: 'superseded', kind: 'primary', brand: null },
      ],
    })
    mockRevoke.mockResolvedValue({ revoked: [], skipped: [], wp_notified: true, wp_error: null })

    render(<GeneratedCOAFallbackList generations={[PUBLISHED]} sampleId="P-0001" />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    fireEvent.click(screen.getByLabelText('Also revoke every other certificate issued for this sample'))

    expect(await screen.findByText('ACOA-0009')).toBeTruthy()
    expect(screen.getByText(/Acme Peptides/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^revoke 3 certificates$/i })).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: 'Lot recalled' } })
    fireEvent.click(screen.getByRole('button', { name: /^revoke 3 certificates$/i }))

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('g2', 'Lot recalled', ['ACOA-0009', 'OLD-0001']))
  })

  it('a child certificate never offers the cascade box', () => {
    const child = gen({ id: 'c1', status: 'published', parent_generation_id: 'g2', verification_code: 'ACOA-0001' })
    render(<GeneratedCOAFallbackList generations={[child]} sampleId="P-0001" />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(screen.queryByLabelText('Also revoke every other certificate issued for this sample')).toBeNull()
    expect(screen.getByRole('button', { name: /^revoke 1 certificate$/i })).toBeTruthy()
  })

  it('warns when WordPress was not updated or codes were skipped', async () => {
    const { toast } = await import('sonner')
    mockRevoke.mockResolvedValue({
      revoked: [{ generation_id: 'g2', verification_code: 'NEW-0002', status: 'revoked', kind: 'primary', brand: null, revoked_at: null, revocation_reason: 'r' }],
      skipped: ['GONE-0000'],
      wp_notified: false,
      wp_error: 'HTTP 500: boom',
    })
    render(<GeneratedCOAFallbackList generations={[PUBLISHED]} sampleId="P-0001" />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: 'r' } })
    fireEvent.click(screen.getByRole('button', { name: /^revoke 1 certificate$/i }))

    await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(2))
    expect(vi.mocked(toast.warning).mock.calls.some(c => String(c[0]).includes('customer was not updated'))).toBe(true)
    expect(vi.mocked(toast.warning).mock.calls.some(c => String(c[1]?.description).includes('GONE-0000'))).toBe(true)
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/test/generated-coa-fallback-verdicts.test.tsx`
Expected: the cascade test fails (no checkbox found); the "1 certificate" button name is not found; the warning test fails.

- [ ] **Step 4: Import the new client pieces**

In `src/components/senaite/SampleDetails.tsx`, in the `from '@/lib/api'` import list, add `getCoaRevokePreview,` next to `revokeCoaGeneration,` and add `type RevokePreviewItem,` in the type imports (next to `type ExplorerCOAGeneration,`).

- [ ] **Step 5: Replace `RevokeCOAButton` with `RevokeCOADialog` and add `ForwardToCurrentToggle`**

Replace the whole `function RevokeCOAButton({ ... })` (from its leading docblock through its closing `}`) with:

```tsx
/**
 * The lab's per-COA switch. Off (default): the public page shows this
 * superseded COA exactly as before. On: it shows a Superseded notice with a
 * link to the current certificate (the prelim-to-final flow).
 */
export function ForwardToCurrentToggle({
  gen,
  onChanged,
}: {
  gen: ExplorerCOAGeneration
  onChanged?: () => void
}) {
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none"
      title="Off (default): the public page shows this COA exactly as before. On: it shows a Superseded notice with a link to the current certificate."
    >
      <Checkbox
        aria-label="Forward to current"
        checked={!!gen.forward_enabled}
        onCheckedChange={async checked => {
          const enabled = checked === true
          try {
            await setCoaForwardEnabled(gen.id, enabled)
            toast.success(enabled ? 'Forwarding enabled' : 'Forwarding disabled', {
              description: gen.verification_code,
            })
            onChanged?.()
          } catch (err) {
            toast.error('Forward update failed', {
              description: err instanceof Error ? err.message : 'Unknown error',
            })
          }
        }}
      />
      <span>Forward to current</span>
    </span>
  )
}

/**
 * Revoke an issued COA generation. Terminal: the public page shows
 * "Certificate Revoked" with the reason and no results; nothing replaces it.
 *
 * On a primary the lab may also take every other certificate issued for the
 * sample (published and superseded, any kind, whichever primary it hangs
 * off). The dialog previews exactly which codes that is and sends that list
 * back, so the server revokes what was shown and nothing more. Admin only:
 * the server refuses anyone else, so the trigger is hidden for everyone else.
 */
export function RevokeCOADialog({
  gen,
  onRevoked,
}: {
  gen: ExplorerCOAGeneration
  onRevoked?: () => void
}) {
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [includeOthers, setIncludeOthers] = useState(false)
  const [preview, setPreview] = useState<RevokePreviewItem[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const isPrimary = gen.parent_generation_id == null

  const loadPreview = async () => {
    setPreviewError(null)
    try {
      const p = await getCoaRevokePreview(gen.id)
      setPreview(p.others)
    } catch (err) {
      setPreview(null)
      setPreviewError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const includeCodes =
    includeOthers && preview ? preview.map(p => p.verification_code) : []
  const count = 1 + includeCodes.length
  const canSubmit =
    !busy && reason.trim().length > 0 && (!includeOthers || preview !== null)

  const reset = () => {
    setReason('')
    setIncludeOthers(false)
    setPreview(null)
    setPreviewError(null)
  }

  const handleRevoke = async () => {
    setBusy(true)
    try {
      const result = await revokeCoaGeneration(gen.id, reason.trim(), includeCodes)
      const codes = result.revoked.map(r => r.verification_code)
      toast.success(
        codes.length === 1 ? `Revoked ${codes[0]}` : `Revoked ${codes.length} certificates`,
        { description: codes.length > 1 ? codes.join(', ') : undefined }
      )
      if (result.skipped.length > 0) {
        toast.warning('Some certificates were not revoked', {
          description: `${result.skipped.join(', ')} changed since the preview. Open Revoke again to see the current list.`,
        })
      }
      if (!result.wp_notified) {
        toast.warning('Revoked, but the customer was not updated', {
          description:
            result.wp_error ??
            'WordPress did not accept the notice. The portal and email need a manual follow-up.',
        })
      }
      setOpen(false)
      reset()
      onRevoked?.()
    } catch (err) {
      toast.error('Revoke failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusy(false)
    }
  }

  if (!isAdmin) return null

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px] text-red-600 hover:text-red-700"
        onClick={() => setOpen(true)}
      >
        Revoke…
      </Button>
      <Dialog
        open={open}
        onOpenChange={o => {
          setOpen(o)
          if (!o) reset()
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke COA {gen.verification_code}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">
            This is final. The public verification page will show &quot;Certificate
            Revoked&quot; with the reason below and no results. Nothing replaces a
            revoked certificate; regenerate if a corrected COA is needed.
          </p>
          <Textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Reason (printed on the public verdict)"
            rows={3}
          />
          {isPrimary && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-xs select-none cursor-pointer">
                <Checkbox
                  aria-label="Also revoke every other certificate issued for this sample"
                  checked={includeOthers}
                  onCheckedChange={checked => {
                    const on = checked === true
                    setIncludeOthers(on)
                    if (on && preview === null) void loadPreview()
                  }}
                />
                <span>Also revoke every other certificate issued for this sample</span>
              </label>
              {includeOthers && previewError && (
                <p className="text-[11px] text-red-500 pl-6">
                  Could not load the list: {previewError}
                </p>
              )}
              {includeOthers && preview !== null && preview.length === 0 && (
                <p className="text-[11px] text-muted-foreground pl-6">
                  Nothing else is issued for this sample.
                </p>
              )}
              {includeOthers && preview !== null && preview.length > 0 && (
                <ul
                  className="text-[11px] pl-6 space-y-0.5"
                  aria-label="Certificates that will also be revoked"
                >
                  {preview.map(p => (
                    <li key={p.generation_id} className="flex items-center gap-2">
                      <span className="font-mono">{p.verification_code}</span>
                      <span className="text-muted-foreground">
                        {p.kind}
                        {p.brand ? ` (${p.brand})` : ''} · {p.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">The customer will be emailed.</p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void handleRevoke()}
              disabled={!canSubmit}
            >
              {busy
                ? 'Revoking…'
                : `Revoke ${count} certificate${count === 1 ? '' : 's'}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

- [ ] **Step 6: Use them on the primary list rows**

In `GeneratedCOAFallbackList`, replace the inline Forward block (from `{gen.status === 'superseded' && (` with the `<span className="flex items-center gap-1.5 ...` through its closing `)}`) and the `<RevokeCOAButton .../>` line with:

```tsx
                  {gen.status === 'superseded' && (
                    <ForwardToCurrentToggle gen={gen} onChanged={onStateChanged} />
                  )}
                  {(gen.status === 'published' || gen.status === 'superseded') && (
                    <RevokeCOADialog gen={gen} onRevoked={onStateChanged} />
                  )}
```

Confirm `grep -n RevokeCOAButton src/components/senaite/SampleDetails.tsx` prints nothing.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx prettier --write src/test/generated-coa-fallback-verdicts.test.tsx && npx vitest run src/test/generated-coa-fallback-verdicts.test.tsx src/test/generated-coa-fallback-regen.test.tsx src/test/coa-generation-verdicts.test.ts && npm run -s typecheck`
Expected: all green, typecheck clean.

- [ ] **Step 8: Commit (if authorised)**

```bash
cd /c/tmp/Accu-Mk1-integrity
git commit -m "feat(coa): RevokeCOADialog with cascade preview; shared ForwardToCurrentToggle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/senaite/SampleDetails.tsx src/test/generated-coa-fallback-verdicts.test.tsx
```

---

### Task 4: ACOA cards: Revoke, and earlier versions with Forward

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (`selectRootGenerations` neighbourhood at ~line 563 for the selector; `function AdditionalCoaCard` at ~line 3131; its mount at ~line 6453)
- Create: `src/test/select-earlier-versions.test.ts`, `src/test/additional-coa-card-verdicts.test.tsx`

**Interfaces:**
- Produces: `export function selectEarlierVersions(gens: ExplorerCOAGeneration[], currentId: string | null): ExplorerCOAGeneration[]`; `export function AdditionalCoaCard(...)` gains props `generation: ExplorerCOAGeneration | null`, `earlierVersions: ExplorerCOAGeneration[]`, `onStateChanged: () => void`; internal `EarlierVersionsList`.
- Consumes: Task 3 components; `superseded_by_id` on generations (Task 2 type, Plan 1 data).

- [ ] **Step 1: GitNexus impact**

Run `gitnexus_impact({target: "AdditionalCoaCard", direction: "upstream", repo: "Accu-Mk1"})` and report.

- [ ] **Step 2: Write the failing selector test**

Create `src/test/select-earlier-versions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { selectEarlierVersions } from '@/components/senaite/SampleDetails'
import type { ExplorerCOAGeneration } from '@/lib/api'

// Earlier versions of an ACOA are the superseded generations whose recorded
// replacement chain (superseded_by_id) ends at the ACOA's current generation.
// Brand isolation falls out of the chain: another brand's history never points
// here. A broken link (hand-retired rows) or a cycle drops out, never crashes.

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'CODE',
    content_hash: 'h',
    status: 'superseded',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: null,
    superseded_at: null,
    created_at: '2026-09-01T00:00:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: 'root',
    vial_sequence: null,
    is_regular_coa: false,
    ingestion_status: null,
    forward_enabled: false,
    revoked_at: null,
    revocation_reason: null,
    superseded_by_id: null,
    revoked_by: null,
    ...overrides,
  }
}

describe('selectEarlierVersions', () => {
  it('walks the chain to the current generation, newest first', () => {
    const cur = gen({ id: 'x3', status: 'published', generation_number: 3 })
    const x2 = gen({ id: 'x2', generation_number: 2, superseded_by_id: 'x3' })
    const x1 = gen({ id: 'x1', generation_number: 1, superseded_by_id: 'x2' })
    expect(selectEarlierVersions([x1, cur, x2], 'x3').map(g => g.id)).toEqual(['x2', 'x1'])
  })

  it('keeps brands apart because only the recorded chain counts', () => {
    const x2 = gen({ id: 'x2', status: 'published' })
    const x1 = gen({ id: 'x1', superseded_by_id: 'x2' })
    const y2 = gen({ id: 'y2', status: 'published' })
    const y1 = gen({ id: 'y1', superseded_by_id: 'y2' })
    expect(selectEarlierVersions([x1, x2, y1, y2], 'x2').map(g => g.id)).toEqual(['x1'])
    expect(selectEarlierVersions([x1, x2, y1, y2], 'y2').map(g => g.id)).toEqual(['y1'])
  })

  it('drops rows with no recorded link and survives a cycle', () => {
    const cur = gen({ id: 'c', status: 'published' })
    const orphan = gen({ id: 'o', superseded_by_id: null })
    const a = gen({ id: 'a', superseded_by_id: 'b' })
    const b = gen({ id: 'b', superseded_by_id: 'a' })
    expect(selectEarlierVersions([cur, orphan, a, b], 'c')).toEqual([])
  })

  it('returns nothing without a current id', () => {
    expect(selectEarlierVersions([gen({ id: 'x1', superseded_by_id: 'x2' })], null)).toEqual([])
  })
})
```

- [ ] **Step 3: Write the failing card test**

Create `src/test/additional-coa-card-verdicts.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type * as ApiModule from '@/lib/api'
import type { AdditionalCOAConfig, ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    setCoaForwardEnabled: vi.fn(),
    revokeCoaGeneration: vi.fn(),
    getCoaRevokePreview: vi.fn(),
    updateAdditionalCOAConfig: vi.fn(),
    regenAdditionalCOA: vi.fn(),
    getExplorerCOASignedUrl: vi.fn(),
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { AdditionalCoaCard } from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'

// An ACOA card carries the same controls as the primary list: Revoke on its
// current certificate (admin only) and, under "Earlier versions", a Forward
// switch and Revoke on each superseded version of this ACOA.

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'CODE',
    content_hash: 'h',
    status: 'published',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: '2026-09-10T00:00:00Z',
    superseded_at: null,
    created_at: '2026-09-10T00:00:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: 'root',
    vial_sequence: null,
    is_regular_coa: false,
    ingestion_status: null,
    forward_enabled: false,
    revoked_at: null,
    revocation_reason: null,
    superseded_by_id: null,
    revoked_by: null,
    ...overrides,
  }
}

const CONFIG: AdditionalCOAConfig = {
  config_id: 'cfg-1',
  coa_index: 1,
  status: 'published',
  wp_profile_id: null,
  coa_info: { company_name: 'Acme Peptides' },
  generation_id: 'acoa-2',
  verification_code: 'NEW-0002',
  generation_number: 2,
}
const CURRENT = gen({ id: 'acoa-2', verification_code: 'NEW-0002', generation_number: 2 })
const OLD = gen({ id: 'acoa-1', verification_code: 'OLD-0001', status: 'superseded', superseded_by_id: 'acoa-2', superseded_at: '2026-09-10T00:00:00Z' })

function renderCard(props: Partial<ComponentProps<typeof AdditionalCoaCard>> = {}) {
  return render(
    <AdditionalCoaCard
      coa={CONFIG}
      sampleId="P-0001"
      onUpdateState={vi.fn()}
      onRegenerated={vi.fn()}
      generation={CURRENT}
      earlierVersions={[OLD]}
      onStateChanged={vi.fn()}
      {...props}
    />
  )
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, email: 'lab@example.com', role: 'admin' } as never })
})

describe('AdditionalCoaCard verdict controls', () => {
  it('offers Revoke on the current certificate once opened', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Acme Peptides/ }))
    expect(screen.getByRole('button', { name: /revoke/i })).toBeTruthy()
  })

  it('lists earlier versions with a Forward switch and their own Revoke', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Acme Peptides/ }))
    fireEvent.click(screen.getByRole('button', { name: /Earlier versions \(1\)/ }))
    expect(screen.getByText('OLD-0001')).toBeTruthy()
    expect(screen.getByLabelText('Forward to current')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /revoke/i })).toHaveLength(2)
  })

  it('shows the generation status (revoked) over the config status', () => {
    renderCard({ generation: gen({ id: 'acoa-2', status: 'revoked', revocation_reason: 'Lot recalled' }), earlierVersions: [] })
    expect(screen.getByText('revoked')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Acme Peptides/ }))
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('hides Revoke from non-admins', () => {
    useAuthStore.setState({ user: { id: 2, email: 'tech@example.com', role: 'hplc' } as never })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Acme Peptides/ }))
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })
})
```

- [ ] **Step 4: Run both to verify they fail**

Run: `npx vitest run src/test/select-earlier-versions.test.ts src/test/additional-coa-card-verdicts.test.tsx`
Expected: `selectEarlierVersions` and `AdditionalCoaCard` are not exported.

- [ ] **Step 5: Add the selector**

In `SampleDetails.tsx`, directly before `export function selectRootGenerations(`, add:

```tsx
/**
 * Earlier versions of a certificate: the superseded generations whose recorded
 * replacement chain (superseded_by_id) ends at `currentId`. Brand-correct by
 * construction (another brand's history never points here). A row with no
 * recorded link, or a cycle, is left out. Newest first.
 */
export function selectEarlierVersions(
  gens: ExplorerCOAGeneration[],
  currentId: string | null
): ExplorerCOAGeneration[] {
  if (!currentId) return []
  const byId = new Map(gens.map(g => [g.id, g]))
  const endsAtCurrent = (start: ExplorerCOAGeneration): boolean => {
    const seen = new Set<string>()
    let cur: ExplorerCOAGeneration | undefined = start
    while (cur && cur.superseded_by_id && !seen.has(cur.id)) {
      if (cur.superseded_by_id === currentId) return true
      seen.add(cur.id)
      cur = byId.get(cur.superseded_by_id)
    }
    return false
  }
  return gens
    .filter(g => g.status === 'superseded' && g.id !== currentId && endsAtCurrent(g))
    .sort((a, b) => b.generation_number - a.generation_number)
}
```

- [ ] **Step 6: Add `EarlierVersionsList` and extend `AdditionalCoaCard`**

(a) Directly before `// --- Additional COA Card (collapsible) ---`, add:

```tsx
/** Superseded versions of one certificate, each with its Forward switch and Revoke. */
function EarlierVersionsList({
  versions,
  onStateChanged,
}: {
  versions: ExplorerCOAGeneration[]
  onStateChanged?: () => void
}) {
  const [open, setOpen] = useState(false)
  if (versions.length === 0) return null
  return (
    <div className="py-1.5 border-b border-border/50">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Earlier versions ({versions.length})
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1.5 pl-4">
          {versions.map(v => (
            <li key={v.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="flex items-center gap-2 min-w-0">
                <a
                  href={accuverifyUrl(v.verification_code)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono hover:underline truncate"
                >
                  {v.verification_code}
                </a>
                <span className="text-muted-foreground shrink-0">Gen #{v.generation_number}</span>
                <span className="text-muted-foreground shrink-0">
                  {v.superseded_at ? `superseded ${formatDate(v.superseded_at)}` : 'superseded'}
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <ForwardToCurrentToggle gen={v} onChanged={onStateChanged} />
                <RevokeCOADialog gen={v} onRevoked={onStateChanged} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

(b) Change `function AdditionalCoaCard({` to `export function AdditionalCoaCard({` and extend its props. The destructuring becomes

```tsx
export function AdditionalCoaCard({
  coa,
  sampleId,
  onUpdateState,
  onRegenerated,
  generation,
  earlierVersions,
  onStateChanged,
}: {
  coa: AdditionalCOAConfig
  sampleId: string
  onUpdateState: (
    field: keyof AdditionalCOAConfig['coa_info'],
    newValue: string | number | null
  ) => void
  onRegenerated: () => void
  /** The ACOA's current generation (by coa.generation_id); null before the first publish. */
  generation: ExplorerCOAGeneration | null
  /** Superseded versions of this ACOA (selectEarlierVersions). */
  earlierVersions: ExplorerCOAGeneration[]
  /** After a verdict change (forward toggle, revoke): refetch the lists. */
  onStateChanged: () => void
}) {
```

(c) Directly after `const [regenerating, setRegenerating] = useState(false)` add

```tsx
  // The generation's status is the truth once it exists (a revoke never
  // touches the config row); fall back to the config status before publish.
  const displayStatus = generation?.status ?? coa.status
```

and in the header `<Badge variant={ ... }>` replace every `coa.status` with `displayStatus`, add `displayStatus === 'revoked' ? 'destructive' :` as the first branch of the variant ternary, and change the badge text `{coa.status}` to `{displayStatus}`.

(d) Inside the open panel, in the `<div className="flex items-center gap-2 shrink-0 ml-2">` that holds the PDF and Regen buttons, add after the Regen button's closing `)}`:

```tsx
              {generation &&
                (generation.status === 'published' || generation.status === 'superseded') && (
                  <RevokeCOADialog gen={generation} onRevoked={onStateChanged} />
                )}
```

(e) Directly before `<EditableDataRow` `label="Company"` add

```tsx
          <EarlierVersionsList versions={earlierVersions} onStateChanged={onStateChanged} />
```

- [ ] **Step 7: Pass the data at the mount site**

At the `<AdditionalCoaCard` mount (~line 6453), add three props after `sampleId={data.sample_id}`:

```tsx
                            generation={
                              coaGenerations.find(g => g.id === coa.generation_id) ?? null
                            }
                            earlierVersions={selectEarlierVersions(coaGenerations, coa.generation_id)}
                            onStateChanged={refreshGeneratedCoas}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx prettier --write src/test/select-earlier-versions.test.ts src/test/additional-coa-card-verdicts.test.tsx && npx vitest run src/test/select-earlier-versions.test.ts src/test/additional-coa-card-verdicts.test.tsx src/test/generated-coa-fallback-verdicts.test.tsx && npm run -s typecheck`
Expected: all green, typecheck clean.

- [ ] **Step 9: Commit (if authorised)**

```bash
cd /c/tmp/Accu-Mk1-integrity
git add src/test/select-earlier-versions.test.ts src/test/additional-coa-card-verdicts.test.tsx
git commit -m "feat(coa): Revoke and earlier-versions Forward controls on ACOA cards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/senaite/SampleDetails.tsx src/test/select-earlier-versions.test.ts src/test/additional-coa-card-verdicts.test.tsx
```

---

### Task 5: Per-vial COAs get the same controls

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (`function VialCOAList` at ~line 1061; its mount `<VialCOAList generations={vialGens} />` at ~line 6393)
- Create: `src/test/vial-coa-list-verdicts.test.tsx`

**Interfaces:**
- Produces: `export function VialCOAList({ generations, onStateChanged }: { generations: ExplorerCOAGeneration[]; onStateChanged?: () => void })`.

- [ ] **Step 1: GitNexus impact**

Run `gitnexus_impact({target: "VialCOAList", direction: "upstream", repo: "Accu-Mk1"})` and report.

- [ ] **Step 2: Write the failing test**

Create `src/test/vial-coa-list-verdicts.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, setCoaForwardEnabled: vi.fn(), revokeCoaGeneration: vi.fn(), getCoaRevokePreview: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { VialCOAList } from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'CODE',
    content_hash: 'h',
    status: 'published',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: '2026-09-10T00:00:00Z',
    superseded_at: null,
    created_at: '2026-09-10T00:00:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: 'root',
    vial_sequence: 1,
    is_regular_coa: false,
    ingestion_status: null,
    forward_enabled: false,
    revoked_at: null,
    revocation_reason: null,
    superseded_by_id: null,
    revoked_by: null,
    ...overrides,
  }
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, email: 'lab@example.com', role: 'admin' } as never })
})

describe('VialCOAList verdict controls', () => {
  it('offers Revoke on published vials and Forward plus Revoke on superseded ones', () => {
    render(
      <VialCOAList
        generations={[
          gen({ id: 'v1', vial_sequence: 1, verification_code: 'V1-0002' }),
          gen({ id: 'v2', vial_sequence: 2, status: 'superseded', verification_code: 'V2-0001' }),
        ]}
        onStateChanged={vi.fn()}
      />
    )
    expect(screen.getAllByRole('button', { name: /revoke/i })).toHaveLength(2)
    expect(screen.getAllByLabelText('Forward to current')).toHaveLength(1)
  })

  it('offers nothing on a draft or a revoked vial', () => {
    render(
      <VialCOAList
        generations={[
          gen({ id: 'd', status: 'draft', published_at: null }),
          gen({ id: 'r', status: 'revoked', revocation_reason: 'x' }),
        ]}
      />
    )
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
    expect(screen.queryByLabelText('Forward to current')).toBeNull()
    expect(screen.getByText('Revoked')).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/test/vial-coa-list-verdicts.test.tsx`
Expected: `VialCOAList` is not exported.

- [ ] **Step 4: Add the controls**

In `SampleDetails.tsx`, change `function VialCOAList({` to `export function VialCOAList({`, and its props to

```tsx
export function VialCOAList({
  generations,
  onStateChanged,
}: {
  generations: ExplorerCOAGeneration[]
  /** After a verdict change (forward toggle, revoke): refetch the lists. */
  onStateChanged?: () => void
}) {
```

Then inside each row, directly after the status badge `<span title={release.title} ...>{release.label}</span>` (still inside the `<div className="flex items-center gap-2 min-w-0">`), add:

```tsx
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {gen.status === 'superseded' && (
                    <ForwardToCurrentToggle gen={gen} onChanged={onStateChanged} />
                  )}
                  {(gen.status === 'published' || gen.status === 'superseded') && (
                    <RevokeCOADialog gen={gen} onRevoked={onStateChanged} />
                  )}
                </span>
```

At the mount site change `<VialCOAList generations={vialGens} />` to `<VialCOAList generations={vialGens} onStateChanged={refreshGeneratedCoas} />`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx prettier --write src/test/vial-coa-list-verdicts.test.tsx && npx vitest run src/test/vial-coa-list-verdicts.test.tsx && npm run -s typecheck`
Expected: green, typecheck clean.

- [ ] **Step 6: Commit (if authorised)**

```bash
cd /c/tmp/Accu-Mk1-integrity
git add src/test/vial-coa-list-verdicts.test.tsx
git commit -m "feat(coa): Forward and Revoke controls on per-vial COAs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/senaite/SampleDetails.tsx src/test/vial-coa-list-verdicts.test.tsx
```

---

### Task 6: Gates, then the cross-repo browser check

**Files:** none new. Needs Plans 1 and 2 built in their worktrees.

- [ ] **Step 1: Frontend gates on this branch's lines**

Run from `C:\tmp\Accu-Mk1-integrity`:

```bash
npm run -s typecheck
npx vitest run src/test/coa-revoke-api.test.ts src/test/generated-coa-fallback-verdicts.test.tsx src/test/generated-coa-fallback-regen.test.tsx src/test/coa-generation-verdicts.test.ts src/test/select-root-generations.test.ts src/test/select-earlier-versions.test.ts src/test/additional-coa-card-verdicts.test.tsx src/test/vial-coa-list-verdicts.test.tsx
npx eslint src/components/senaite/SampleDetails.tsx src/lib/api.ts src/test/coa-revoke-api.test.ts src/test/select-earlier-versions.test.ts src/test/additional-coa-card-verdicts.test.tsx src/test/vial-coa-list-verdicts.test.tsx src/test/generated-coa-fallback-verdicts.test.tsx
npx ast-grep scan src/components/senaite/SampleDetails.tsx src/lib/api.ts
```

Expected: typecheck clean; every test green; eslint and ast-grep findings only on lines that predate this branch (check each against `git diff -U0 origin/master -- <file>`; fix any on added lines). Prettier: new test files clean (`npx prettier --check` on them).

- [ ] **Step 2: Backend gate**

Run from `backend/`:

```bash
$PY -m pytest -q -p no:cacheprovider -rfE 2>&1 | grep -E "^(FAILED|ERROR) " | sed -E 's/ - .*//' | grep -v "jobs.completion_side_effects" | sort -u > /c/tmp/mk1-integrity-after3-failures.txt
echo "baseline $(wc -l < /c/tmp/mk1-integrity-baseline-clean.txt) after $(wc -l < /c/tmp/mk1-integrity-after3-failures.txt)"; echo NEW:; comm -13 /c/tmp/mk1-integrity-baseline-clean.txt /c/tmp/mk1-integrity-after3-failures.txt
```

Expected: `NEW:` prints nothing.

- [ ] **Step 3: Em dash sweep**

```bash
git diff -U0 origin/master | grep '^+' | grep -v '^+++' | grep -P '\x{2014}'; git ls-files --others --exclude-standard | grep -v node_modules | xargs grep -ln $'\u2014' 2>/dev/null
```

Expected: no output.

- [ ] **Step 4: Stand up an isolated stack with all three worktrees**

Invoke the `accumark-stack-platform` skill and follow it to create a stack (name it `coa-revoke`) from the current golden, mounting `C:\tmp\is-integrity`, `C:\tmp\wpstar-integrity` and `C:\tmp\Accu-Mk1-integrity`. Per memory, `mount` recreates every service and re-runs alembic-init, which applies migration `y3z4a5b6c7d8`. Confirm it applied:

```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'coa_generations' AND column_name IN ('forward_enabled', 'revoked_at', 'revocation_reason', 'revoked_by');
```

Expected: four rows. Also run `scripts/coa_hash_census.py` against the stack DB (exit 0 expected on golden data; a nonzero exit means investigate before going further).

- [ ] **Step 5: Drive the flows in the browser**

Use `playwright-cli` (memory: the browser pane blocks stack scripts). Stack URLs come from the stack's env output. Sign in to Accu-Mk1 as an admin. Pick a sample that has a published primary COA and at least one published ACOA. For each step, save a screenshot into the session scratchpad and note the codes used.

1. **Prelim to final.** Generate a new primary draft, then Publish. In the COA console the old primary now reads Superseded. Open the WordPress verify page for the OLD code: it must still say "Verified & Secured" with no Superseded notice (switch off). Tick **Forward to current** on the old row. Reload the verify page: Superseded header, the notice, and a link to the NEW code. Untick: back to the original rendering.
2. **Revoke one ACOA.** Open the ACOA card, click Revoke…, enter a reason, confirm "Revoke 1 certificate". Check: the ACOA's verify page shows "Certificate Revoked" with the reason; `GET /wp-json/accumark/v1/badge/<code>` returns a 404 JSON body with `"revoked": true` and the reason; the customer's portal order page shows the **Revoked** marker beside that code; the primary's page is unchanged; in wp-admin open the email preview for **COA Revoked** and confirm it renders on the branded template; if the stack has a mail catcher, one email arrived at the order's billing address with the code and reason.
3. **Revoke the primary with the cascade.** On the current primary, click Revoke…, tick "Also revoke every other certificate issued for this sample", confirm the list names the superseded prelim and every remaining live child, and the button reads "Revoke N certificates" with the matching N. Confirm. Check: every listed code's verify page is revoked; the Mk1 lists show Revoked on all of them; the ACOA card's "Earlier versions" rows show Revoked; one email lists every code.
4. **Permissions.** Sign in as a non-admin user: no Revoke buttons anywhere; Forward to current still available on a superseded row.

- [ ] **Step 6: Report**

Attach the screenshots and list any deviation from the expected behaviour above as findings. Append one dated line to `C:\Users\forre\.claude\projects\C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace\memory\project_accuverify_tier1_integrity_build.md`: `Mk1 plan 3 (ACOA supersede+revoke) BUILT + stack E2E <PASSED|findings: ...>: RevokeCOADialog cascade, ForwardToCurrentToggle, ACOA earlier versions, vial controls, admin proxies with revoked_by`. Tear the stack down per the skill when the Handler has seen the screenshots.

---

## Self-review (done while writing)

- Spec 4.4 backend -> Task 1; frontend dialog, ACOA card with earlier versions, per-vial, refresh, warnings -> Tasks 3, 4, 5; `revoked_by` server-side -> Task 1. Spec 5 skipped-codes and WP-failure reporting -> Task 3 warnings. Spec 6 Mk1 tests -> Tasks 1 to 5; E2E in a browser -> Task 6. Spec 7 migration-before-image and census -> Task 6 step 4.
- Types: `revokeCoaGeneration(id, reason, includeCodes)` defined in Task 2, called with three args in Task 3; `RevokePreviewItem.kind` union matches Plan 1's `generation_kind()` values; `selectEarlierVersions(gens, currentId)` defined in Task 4 and used at the mount site with `coa.generation_id` (`string | null`).
- Every step has real code or an exact command.
