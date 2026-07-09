# Productionize Accu-Mk1-as-default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make read-from-Accu-Mk1 safe + cheap as the prod default: registry-owned analytes (Replace dual-write), a catalog-only slim SENAITE refresh for the samples list, a details-overlay `review_state` freshness correction, and provenance icons on SENAITE-pulled values.

**Architecture:** Backend closes the one registry-staleness gap (Replace) and adds a `slim` mode to the shared `/senaite/samples` handler that skips `complete=yes` (catalog brains only — spike-verified 2026-07-08: brains carry `review_state`/`id`/`uid` + most getters, but NOT `Analyte{N}Peptide`/`VerificationCode`). Frontend's mk1-mode background refresh switches to slim and merges `review_state` only. A shared `FieldSourceGlyph` marks SENAITE-pulled values on the list (State column header) and details (per-field via `field_sources`).

**Tech Stack:** FastAPI + SQLAlchemy + pytest (backend), React + TypeScript + vitest + shadcn (frontend).

**Spec:** `C:\tmp\Accu-Mk1-panel\docs\superpowers\specs\2026-07-08-productionize-mk1-default-design.md`

## Global Constraints

- Branch: `feat/productionize-mk1-default` (stacks on `feat/read-source-settings-multipage`). Repo root: `C:\tmp\Accu-Mk1-panel`.
- Frontend is **npm only** (never pnpm). Frontend tests: `npm run test:run -- <paths>`; typecheck: `npm run typecheck` — both from `C:\tmp\Accu-Mk1-panel`.
- Backend tests run in the laptop container: `docker exec accu-mk1-panel-test python -m pytest <paths> -q` (bind-mounts `C:\tmp\Accu-Mk1-panel\backend`).
- Additive only — do not restructure existing handlers/components beyond what each task states.
- `git add` explicit file paths only, never `-A`. Commit trailer (every commit):
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01E26bb4ATJSK7z63mTXF5Jd`
- SENAITE-mode behavior must be pixel/byte-identical throughout — every new behavior is gated on mk1 mode (`slim` param opt-in, glyphs render `null` otherwise).
- Known-benign noise: backend start logs `migration_skipped lims_analyses_review_state_check` — ignore it. Backend full suite has ~19 known baseline failures, frontend 34 (flag-hook pollution); gate on *your files'* tests passing + no NEW failures elsewhere.

---

### Task 1: Backend — `slim` param on `GET /senaite/samples`

**Files:**
- Modify: `C:\tmp\Accu-Mk1-panel\backend\main.py` (handler `list_senaite_samples`, ~line 12894: signature, docstring, `base_params` at ~12924)
- Test: `C:\tmp\Accu-Mk1-panel\backend\tests\test_senaite_samples_slim.py` (create)

**Interfaces:**
- Produces: `GET /senaite/samples?slim=true` — same `SenaiteSamplesResponse` shape; when `slim=true` the outbound SENAITE query has NO `complete` param (catalog brains only), so items carry live `review_state`/`id`/`uid` but `analytes=[]`, `verification_code=None`. Default (`slim=false`) is byte-identical to today. Task 4's frontend passes `slim=true`.

- [ ] **Step 1: Write the failing tests**

Create `C:\tmp\Accu-Mk1-panel\backend\tests\test_senaite_samples_slim.py`:

```python
"""GET /senaite/samples?slim=true — catalog-brains listing (no complete=yes).

slim mode is the mk1-read-mode list refresh's path: review_state is a catalog
index (cheap, no object wake-up); Analyte{N}Peptide/VerificationCode are NOT
in the brains, but the sole slim caller merges review_state only. Default
(non-slim) requests must keep sending complete=yes — SENAITE mode needs the
full payload."""
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, get_db
import main
from auth import get_current_user

BRAIN_ITEM = {
    "uid": "UID-1", "id": "P-0001", "title": "P-0001",
    "review_state": "sample_received", "created": "2026-07-01T00:00:00",
    "getClientTitle": "client@example.com", "getClientOrderNumber": "WP-1",
    "getDateReceived": "2026-07-02T00:00:00", "getDateSampled": None,
    "getSampleTypeTitle": "Peptide",
    # deliberately NO Analyte1Peptide / VerificationCode — catalog brains
    # don't carry them (spike-verified 2026-07-08 on the registry stack).
}


@pytest.fixture
def client(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setattr(main, "SENAITE_URL", "http://senaite.test")
    monkeypatch.setattr(main, "SENAITE_USER", "u")
    monkeypatch.setattr(main, "SENAITE_PASSWORD", "p")
    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "a@x", "role": "admin"}
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def _mock_senaite(captured):
    """Patch httpx.AsyncClient so client.get(url, params=...) records params."""
    mock_instance = AsyncMock()

    async def _get(url, params=None, **kw):
        captured.append({"url": url, "params": dict(params or {})})
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json = MagicMock(return_value={"items": [BRAIN_ITEM], "count": 1})
        return resp

    mock_instance.get = AsyncMock(side_effect=_get)
    p = patch("httpx.AsyncClient")
    mock_cls = p.start()
    mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


def test_slim_listing_omits_complete_and_passes_review_state(client):
    captured = []
    p = _mock_senaite(captured)
    try:
        r = client.get("/senaite/samples?slim=true&review_state=sample_received")
    finally:
        p.stop()
    assert r.status_code == 200
    assert len(captured) == 1
    assert "complete" not in captured[0]["params"]
    item = r.json()["items"][0]
    assert item["review_state"] == "sample_received"
    assert item["id"] == "P-0001"
    assert item["analytes"] == []          # brains have no Analyte fields
    assert item["verification_code"] is None


def test_default_listing_still_sends_complete_yes(client):
    captured = []
    p = _mock_senaite(captured)
    try:
        r = client.get("/senaite/samples?review_state=sample_received")
    finally:
        p.stop()
    assert r.status_code == 200
    assert captured[0]["params"].get("complete") == "yes"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_senaite_samples_slim.py -q`
Expected: FIRST test FAILS (slim param unknown → `complete` still sent / 422 ignored-param behavior: FastAPI ignores unknown query params, so it fails on `"complete" not in captured[0]["params"]`). Second test PASSES already (that's fine — it pins today's behavior).

- [ ] **Step 3: Implement**

In `C:\tmp\Accu-Mk1-panel\backend\main.py`, `list_senaite_samples` (~12894):

Add the param after `include_sub_samples: bool = False,`:

```python
    include_sub_samples: bool = False,
    slim: bool = False,
```

Extend the docstring's query-params block:

```
    - slim: when True, skip SENAITE's complete=yes hydration and serve
      catalog brains only — review_state/id/uid are live, but analytes and
      verification_code come back empty (brains don't carry the custom
      Analyte{N}Peptide/VerificationCode schema fields; spike-verified
      2026-07-08). Used by the mk1-read-mode list refresh, which merges
      review_state only. SENAITE-mode callers must NOT pass it.
```

Change the `base_params` line (~12924) from:

```python
    base_params: dict = {"complete": "yes", "sort_on": "created", "sort_order": "descending"}
```

to:

```python
    base_params: dict = {"sort_on": "created", "sort_order": "descending"}
    if not slim:
        # Full hydration wakes every object in Zope — the expensive mode.
        base_params["complete"] = "yes"
```

No other change — both the search `_query` path and the browse path build on `base_params`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_senaite_samples_slim.py -q`
Expected: 2 passed.

- [ ] **Step 5: Regression-check the neighboring suites**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_list.py tests/test_registry_read.py tests/test_registry_read_endpoint.py -q`
Expected: all pass (23+).

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/Accu-Mk1-panel
git add backend/main.py backend/tests/test_senaite_samples_slim.py
git commit -m "feat(senaite): slim=true catalog-only listing on GET /senaite/samples"
```

---

### Task 2: Backend — Replace dual-writes the registry row (registry-owned analytes)

**Files:**
- Modify: `C:\tmp\Accu-Mk1-panel\backend\main.py` (`replace_analyte` endpoint tail, immediately before its `return {...}` at ~8895)
- Test: `C:\tmp\Accu-Mk1-panel\backend\tests\test_native_manage_analyses.py` (extend `TestReplaceAnalyteGates`'s neighborhood with a new class)

**Interfaces:**
- Consumes: `_refresh_parent_from_senaite(db, parent)` from `backend/sub_samples/service.py:331` (sync; fetches the AR complete=true and rewrites the FULL basic-info set incl. `lims_samples.analytes` via `_populate_basic_info`).
- Produces: after a successful Replace, `lims_samples.analytes` reflects the new slot — the samples list (mk1 mode) shows the new analyte from the registry alone. Best-effort: refresh failure logs a warning, never fails the request.

- [ ] **Step 1: Write the failing tests**

Add to `C:\tmp\Accu-Mk1-panel\backend\tests\test_native_manage_analyses.py` (after `TestReplaceAnalyteGates`; reuse that class's `_peptide`/`_svc` idiom and the module's `_make_sample`/`_make_sub` helpers — copy the fixture pattern from `test_replace_412_when_worked_rows_need_confirm` but WITHOUT submitting any analysis, so no confirm gate fires):

```python
class TestReplaceRegistryDualWrite:
    """POST …/analytes/{slot}/replace refreshes lims_samples (registry-owned
    analytes): the samples list in Accu-Mk1 read mode serves analytes from
    the registry, and Replace is the only Mk1-side mutation of the slots.
    Best-effort — a refresh failure must never fail the replace itself."""

    def _peptide(self, db, name, abbr):
        p = Peptide(name=name, abbreviation=abbr)
        db.add(p)
        db.flush()
        return p

    def _svc(self, db, *, keyword, peptide_id):
        s = AnalysisService(title=keyword, keyword=keyword, peptide_id=peptide_id,
                            senaite_uid=f"SN-{keyword}")
        db.add(s)
        db.flush()
        return s

    def _setup(self, db):
        old_pep = self._peptide(db, "TP500", "TP500")
        new_pep = self._peptide(db, "TB500 (Thymosin Beta 4)", "TB500B4")
        self._svc(db, keyword="ID_TP500", peptide_id=old_pep.id)
        self._svc(db, keyword="PUR_TP500", peptide_id=old_pep.id)
        for cat in ("ID", "PUR", "QTY"):
            self._svc(db, keyword=f"{cat}_TB500B4", peptide_id=new_pep.id)
        parent = _make_sample(db, sample_id="P-RDW01")
        sub = _make_sub(db, parent, uid="mk1://rdw01-v1", sample_id="P-RDW01-S01")
        sub.assignment_role = "hplc"
        db.commit()
        return old_pep, new_pep, parent

    def _field_write_ok(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch as _patch
        return _patch.object(
            main, "update_senaite_sample_fields",
            AsyncMock(return_value=SimpleNamespace(success=True)),
        )

    def _is_proxy_mock(self):
        """Steps 4/5 (alias reset + IS identity swap) are best-effort httpx
        calls — give them a happy mock so no real network is attempted."""
        from unittest.mock import AsyncMock, MagicMock, patch as _patch
        mock_instance = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"success": True})
        mock_instance.post = AsyncMock(return_value=mock_resp)
        mock_instance.delete = AsyncMock(return_value=mock_resp)
        mock_instance.get = AsyncMock(return_value=mock_resp)
        p = _patch("httpx.AsyncClient")
        cls = p.start()
        cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
        cls.return_value.__aexit__ = AsyncMock(return_value=False)
        return p

    def test_replace_refreshes_registry_analytes(self, route_client):
        import json as _json
        from unittest.mock import patch as _patch
        db = route_client._test_session
        old_pep, new_pep, parent = self._setup(db)

        meta = {
            "uid": "AR-RDW01",
            "Analyte2Peptide": "TB500 (Thymosin Beta 4) - Identity (HPLC)",
            "review_state": "sample_received",
        }
        proxy = self._is_proxy_mock()
        try:
            with self._field_write_ok(), \
                 _patch("sub_samples.senaite.fetch_parent_metadata", return_value=meta):
                resp = route_client.post(
                    "/explorer/samples/P-RDW01/analytes/2/replace",
                    json={"new_peptide_id": new_pep.id, "old_peptide_id": old_pep.id,
                          "senaite_uid": "AR-RDW01"},
                )
        finally:
            proxy.stop()

        assert resp.status_code == 200, resp.json()
        db.expire_all()
        row = db.execute(
            select(LimsSample).where(LimsSample.sample_id == "P-RDW01")
        ).scalar_one()
        assert row.analytes is not None
        names = [a["name"] for a in _json.loads(row.analytes)]
        assert any("TB500" in n for n in names)

    def test_registry_refresh_failure_is_non_fatal(self, route_client):
        from unittest.mock import patch as _patch
        db = route_client._test_session
        old_pep, new_pep, parent = self._setup(db)

        proxy = self._is_proxy_mock()
        try:
            with self._field_write_ok(), \
                 _patch("sub_samples.senaite.fetch_parent_metadata",
                        side_effect=RuntimeError("senaite down")):
                resp = route_client.post(
                    "/explorer/samples/P-RDW01/analytes/2/replace",
                    json={"new_peptide_id": new_pep.id, "old_peptide_id": old_pep.id,
                          "senaite_uid": "AR-RDW01"},
                )
        finally:
            proxy.stop()

        assert resp.status_code == 200, resp.json()
```

Match the file's existing imports (`Peptide`, `AnalysisService`, `LimsSample`, `select`, `main` are already imported there — check the module head and reuse; add any that are missing to the module head, not the class).

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_native_manage_analyses.py::TestReplaceRegistryDualWrite -q`
Expected: `test_replace_refreshes_registry_analytes` FAILS (row.analytes unchanged/None — no refresh yet). The non-fatal test may PASS already (nothing calls fetch_parent_metadata yet) — that's fine, it pins the contract.

- [ ] **Step 3: Implement**

In `C:\tmp\Accu-Mk1-panel\backend\main.py`, `replace_analyte`, insert between the step-6 `summary = replace_analyte_slot(...)` block and the final `return {...}`:

```python
    # ── 7. refresh the registry row (registry-owned analytes) ────────────────
    # lims_samples.analytes is the samples-list's authoritative analyte source
    # in Accu-Mk1 read mode, and this endpoint is the only Mk1-side mutation
    # of the slots. Re-read SENAITE truth (not in-memory state) so whatever
    # Replace actually landed is what the registry serves. Best-effort: a
    # failure never fails the replace — repair via the registry-debug refresh
    # or the backfill re-sweep. Commit the replace work FIRST so a refresh
    # error can't roll it back; run the sync SENAITE fetch in the threadpool
    # (this is an async-def handler — a blocking call would freeze the loop).
    db.commit()
    if not _is_presubsample:
        from starlette.concurrency import run_in_threadpool
        from sub_samples.service import _refresh_parent_from_senaite
        try:
            _row = db.execute(
                _select(LimsSample).where(LimsSample.sample_id == sample_id)
            ).scalar_one_or_none()
            if _row is not None:
                await run_in_threadpool(_refresh_parent_from_senaite, db, _row)
                db.commit()
        except Exception as _e:
            db.rollback()
            _rep_logger.warning(
                "replace_analyte: registry refresh failed for %s: %s", sample_id, _e
            )
```

Notes for the implementer:
- `_is_presubsample`, `_select`, `LimsSample`, `_rep_logger` all already exist in this function's scope (defined earlier in the handler).
- Do NOT move or reorder steps 1–6; this is a pure tail append before `return`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_native_manage_analyses.py -q`
Expected: the 2 new tests pass; every previously-passing test in the file still passes.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-panel
git add backend/main.py backend/tests/test_native_manage_analyses.py
git commit -m "feat(registry): Replace dual-writes lims_samples — registry-owned analytes"
```

---

### Task 3: Backend — details overlay stops shadowing live `review_state`

**Files:**
- Modify: `C:\tmp\Accu-Mk1-panel\backend\sub_samples\registry_read.py` (OVERLAY_FIELDS + `registry_row_to_display`)
- Test: `C:\tmp\Accu-Mk1-panel\backend\tests\test_registry_read.py`, `C:\tmp\Accu-Mk1-panel\backend\tests\test_registry_read_endpoint.py` (update + add)

**Interfaces:**
- Produces: `GET /registry/sample/{id}/details` keeps SENAITE's live `review_state` (never overlaid); `field_sources` no longer contains a `review_state` key. Task 5's frontend helper treats an absent key as SENAITE-sourced.

- [ ] **Step 1: Write the failing test**

Add to `C:\tmp\Accu-Mk1-panel\backend\tests\test_registry_read_endpoint.py` (reuse the module's `client` fixture, `_seed`, `_senaite_result`, `_mock_lookup`):

```python
def test_review_state_is_never_overlaid(client):
    # Workflow state is SENAITE-owned (mutates after order time) — the
    # registry's cached status may lag. The live lookup value must stand.
    _seed(client, status="sample_due")  # stale registry status
    with _mock_lookup(_senaite_result(review_state="published")):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["review_state"] == "published"
    assert "review_state" not in body["field_sources"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read_endpoint.py::test_review_state_is_never_overlaid -q`
Expected: FAIL — `body["review_state"] == "sample_due"` (registry overlays it today).

- [ ] **Step 3: Implement**

In `C:\tmp\Accu-Mk1-panel\backend\sub_samples\registry_read.py`:

Remove `"review_state"` from `OVERLAY_FIELDS`:

```python
# Every SenaiteLookupResult field this mapper can populate. The overlay's
# field_sources map is built over exactly this set. review_state is
# deliberately ABSENT: workflow state is SENAITE-owned (it mutates after
# order time), and the details endpoint has the live value in hand — the
# registry's cached status may lag and must never shadow it.
OVERLAY_FIELDS: tuple[str, ...] = (
    "client", "contact", "sample_type",
    "date_received", "date_sampled", "client_order_number",
    "client_sample_id", "client_lot",
    "declared_weight_mg", "analytes",
)
```

And delete the line `put("review_state", row.status)` from `registry_row_to_display`.

- [ ] **Step 4: Run and repair the two suites**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_registry_read.py tests/test_registry_read_endpoint.py -q`
Expected: the new test passes. Any pre-existing assertion that `review_state` is overlaid or appears in `field_sources`/mapper output now fails — update those assertions to the new contract (mapper emits no `review_state`; `field_sources` has no such key). `test_field_sources_covers_overlay_fields` uses set-equality against `OVERLAY_FIELDS` and self-heals.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-panel
git add backend/sub_samples/registry_read.py backend/tests/test_registry_read.py backend/tests/test_registry_read_endpoint.py
git commit -m "fix(registry): details overlay never shadows live review_state"
```

---

### Task 4: Frontend — slim refresh, `review_state`-only merge

**Files:**
- Modify: `C:\tmp\Accu-Mk1-panel\src\lib\api.ts` (`getSenaiteSamples`, line ~4085)
- Modify: `C:\tmp\Accu-Mk1-panel\src\components\senaite\SenaiteDashboard.tsx` (`startBackgroundRefresh`, ~line 733)
- Test: `C:\tmp\Accu-Mk1-panel\src\components\senaite\__tests__\SenaiteDashboard.readsource.test.tsx`

**Interfaces:**
- Consumes: Task 1's `slim=true` query param.
- Produces: `getSenaiteSamples(reviewState?, limit?, bStart?, search?, searchField?, slim?)` — new optional trailing `slim?: boolean` (positional arg 6). mk1-mode refresh calls it with `true` and merges `review_state` only.

- [ ] **Step 1: Update/add the failing tests**

In `C:\tmp\Accu-Mk1-panel\src\components\senaite\__tests__\SenaiteDashboard.readsource.test.tsx`:

(a) In the first test (`mk1 mode: fast registry render + one batched SENAITE refresh merged by id`), after the `Registered` assertion, add:

```tsx
    // The refresh is slim (catalog-only, arg 6) and merges review_state ONLY:
    // analytes are registry-owned now (Replace dual-writes lims_samples), so
    // the refreshed item's extra analyte must NOT appear.
    expect(getSenaite.mock.calls[0]![5]).toBe(true)
    expect(screen.queryByText('DSIP - Purity (HPLC)')).not.toBeInTheDocument()
```

(b) In the second test (`mk1 mode: SENAITE refresh merges only review_state + analytes — client_id is left registry-native`), rename it to `mk1 mode: SENAITE refresh merges only review_state — client_id and analytes stay registry-native` (the merge no longer takes analytes; the body's assertions still hold since `refreshedItem`'s analytes are now ignored — additionally assert the refreshed analyte is absent):

```tsx
    // …but client_id did not: the row survives hide-test.
    expect(screen.getByText('P-1')).toBeInTheDocument()
    // …and analytes did not merge either (registry-owned).
    expect(screen.queryByText('DSIP - Purity (HPLC)')).not.toBeInTheDocument()
```

(c) In the senaite-mode test, add after the existing assertions:

```tsx
    // SENAITE mode never asks for the slim payload — it needs full hydration.
    expect(getSenaite.mock.calls[0]![5]).toBeUndefined()
```

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `cd C:/tmp/Accu-Mk1-panel && npm run test:run -- src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx`
Expected: (a) fails on `calls[0][5]` (undefined) and on the merged analyte chip appearing; (b) fails on the analyte chip; (c) passes.

- [ ] **Step 3: Implement**

`C:\tmp\Accu-Mk1-panel\src\lib\api.ts` — extend `getSenaiteSamples`:

```ts
export async function getSenaiteSamples(
  reviewState?: string,
  limit = 50,
  bStart = 0,
  search?: string,
  searchField?: 'verification_code' | 'order_number',
  /** Catalog-brains only (no complete=yes hydration on the SENAITE side).
   *  Items carry live review_state/id/uid but empty analytes/verification
   *  code. Only the mk1-read-mode list refresh passes this. */
  slim?: boolean
): Promise<SenaiteSamplesResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    b_start: String(bStart),
  })
  if (reviewState) params.set('review_state', reviewState)
  if (search) params.set('search', search)
  if (searchField) params.set('search_field', searchField)
  if (slim) params.set('slim', 'true')
  const response = await fetch(`${API_BASE_URL()}/senaite/samples?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `SENAITE samples failed: ${response.status}`)
  }
  return response.json()
}
```

`C:\tmp\Accu-Mk1-panel\src\components\senaite\SenaiteDashboard.tsx` — in `startBackgroundRefresh`:

Change the fetch line to pass slim:

```ts
      getSenaiteSamples(reviewState, limit, bStart, search, searchField, true)
```

Change the merge to review_state-only, and update the block comment above `startBackgroundRefresh` (the "refresh review_state + analytes" sentence) to say it refreshes `review_state` only:

```ts
            baseItems.map(item => {
              const live = liveById.get(item.id)
              // Merge ONLY review_state — the one field SENAITE alone mutates
              // (receive/verify/publish workflow). Analytes are registry-owned
              // now (Replace dual-writes lims_samples), and the slim payload
              // deliberately has none. Everything else is IS→registry-native.
              return live ? { ...item, review_state: live.review_state } : item
            })
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd C:/tmp/Accu-Mk1-panel && npm run test:run -- src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-panel
git add src/lib/api.ts src/components/senaite/SenaiteDashboard.tsx src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx
git commit -m "feat(read-source): mk1 list refresh goes slim — review_state-only merge"
```

---

### Task 5: Frontend — `FieldSourceGlyph` + `detailsFieldSource` helper

**Files:**
- Create: `C:\tmp\Accu-Mk1-panel\src\components\senaite\FieldSourceGlyph.tsx`
- Modify: `C:\tmp\Accu-Mk1-panel\src\lib\read-source.ts` (add `detailsFieldSource`)
- Test: `C:\tmp\Accu-Mk1-panel\src\components\senaite\__tests__\FieldSourceGlyph.test.tsx` (create)

**Interfaces:**
- Produces:
  - `detailsFieldSource(readSource: string | undefined, fieldSources: Record<string, 'mk1' | 'senaite'> | undefined, field: string): ReadSource | undefined` — `undefined` outside mk1 mode (glyphs render nothing); in mk1 mode, the map's value, with **absent key → `'senaite'`** (e.g. `review_state`, which Task 3 removed from `field_sources`).
  - `<FieldSourceGlyph source field note? className?>` — renders a small flask glyph + rich tooltip ONLY when `source === 'senaite'`; `null` otherwise. Self-wraps in `TooltipProvider` (usable anywhere, incl. tests). Tasks 6 and 7 consume both.

- [ ] **Step 1: Write the failing tests**

Create `C:\tmp\Accu-Mk1-panel\src\components\senaite\__tests__\FieldSourceGlyph.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FieldSourceGlyph } from '@/components/senaite/FieldSourceGlyph'
import { detailsFieldSource } from '@/lib/read-source'

describe('detailsFieldSource', () => {
  const sources = { client: 'mk1', client_lot: 'senaite' } as const

  it('is undefined outside mk1 mode (no glyphs in SENAITE mode)', () => {
    expect(detailsFieldSource(undefined, sources, 'client')).toBeUndefined()
    expect(detailsFieldSource('senaite', sources, 'client')).toBeUndefined()
  })

  it('returns the mapped source in mk1 mode', () => {
    expect(detailsFieldSource('mk1', sources, 'client')).toBe('mk1')
    expect(detailsFieldSource('mk1', sources, 'client_lot')).toBe('senaite')
  })

  it('treats an absent key as SENAITE-owned (review_state rule)', () => {
    expect(detailsFieldSource('mk1', sources, 'review_state')).toBe('senaite')
    expect(detailsFieldSource('mk1', undefined, 'client')).toBe('senaite')
  })
})

describe('FieldSourceGlyph', () => {
  it('renders nothing unless the field is SENAITE-sourced', () => {
    const { container: c1 } = render(<FieldSourceGlyph source="mk1" field="Client" />)
    expect(c1).toBeEmptyDOMElement()
    const { container: c2 } = render(<FieldSourceGlyph source={undefined} field="Client" />)
    expect(c2).toBeEmptyDOMElement()
  })

  it('renders the glyph for a SENAITE-sourced field', () => {
    render(<FieldSourceGlyph source="senaite" field="State" />)
    expect(screen.getByLabelText('State: live from SENAITE')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/tmp/Accu-Mk1-panel && npm run test:run -- src/components/senaite/__tests__/FieldSourceGlyph.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Append to `C:\tmp\Accu-Mk1-panel\src\lib\read-source.ts`:

```ts
/** Per-field provenance for the sample-details page. Returns undefined
 *  outside mk1 read mode (glyphs render nothing — SENAITE mode is untouched).
 *  In mk1 mode, an ABSENT key means SENAITE-owned: the backend deliberately
 *  keeps workflow state (review_state) out of field_sources because the
 *  registry must never shadow it. */
export function detailsFieldSource(
  readSource: string | undefined,
  fieldSources: Record<string, 'mk1' | 'senaite'> | undefined,
  field: string,
): ReadSource | undefined {
  if (readSource !== 'mk1') return undefined
  return (fieldSources ?? {})[field] ?? 'senaite'
}
```

Create `C:\tmp\Accu-Mk1-panel\src\components\senaite\FieldSourceGlyph.tsx`:

```tsx
import { FlaskConical } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ReadSource } from '@/lib/read-source'

/** Marks a SENAITE-pulled value in Accu-Mk1 read mode (per-field provenance,
 *  driven by the details endpoint's field_sources / the list's slim refresh).
 *  Renders nothing for registry-sourced fields or outside mk1 mode — zero
 *  visual change in SENAITE mode. Self-wraps in TooltipProvider so it works
 *  standalone (rich sectioned tooltip per docs/developer/ui-patterns.md). */
export function FieldSourceGlyph({
  source,
  field,
  note,
  className,
}: {
  source: ReadSource | undefined
  field: string
  note?: string
  className?: string
}) {
  if (source !== 'senaite') return null
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn('inline-flex text-muted-foreground/70', className)}
            aria-label={`${field}: live from SENAITE`}
          >
            <FlaskConical size={10} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="p-0 max-w-xs">
          <div className="flex flex-col gap-1.5 p-3 text-xs font-mono">
            <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
              live from SENAITE
            </div>
            <div>{field} is read from SENAITE, not the Accu-Mk1 registry.</div>
            {note && (
              <div className="border-t border-primary-foreground/20 pt-1.5">
                {note}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
```

(If `@/components/ui/tooltip` exports differ — check the file — adjust imports to what exists; `ReadSourceBanner.test.tsx` shows the test-render idiom.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/tmp/Accu-Mk1-panel && npm run test:run -- src/components/senaite/__tests__/FieldSourceGlyph.test.tsx && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-panel
git add src/components/senaite/FieldSourceGlyph.tsx src/lib/read-source.ts src/components/senaite/__tests__/FieldSourceGlyph.test.tsx
git commit -m "feat(read-source): FieldSourceGlyph + detailsFieldSource provenance helper"
```

---

### Task 6: Frontend — wire per-field glyphs into sample details

**Files:**
- Modify: `C:\tmp\Accu-Mk1-panel\src\components\senaite\SampleDetails.tsx` (`DataRow` ~2427, `SectionHeader` ~2458, status badge ~4477, Sample Info card ~5023, Order Details card ~5055, Analytes card ~5519, Total Declared Qty ~5671)
- Modify: `C:\tmp\Accu-Mk1-panel\src\components\dashboard\EditableField.tsx` (`EditableDataRow` ~200)

**Interfaces:**
- Consumes: Task 5's `FieldSourceGlyph` + `detailsFieldSource`; the details payload's `read_source`/`field_sources` (already on `data`, fed to `ReadSourceBanner` at ~4630).
- Produces: `DataRow`/`EditableDataRow` accept optional `sourceGlyph?: React.ReactNode` (rendered after the label); `SectionHeader` accepts optional `titleSuffix?: React.ReactNode`.

- [ ] **Step 1: Add the `sourceGlyph` prop to the row primitives**

`SampleDetails.tsx` `DataRow` (~2427) — add prop and render after the label text:

```tsx
function DataRow({
  label,
  value,
  mono = false,
  emphasis = false,
  sourceGlyph,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  emphasis?: boolean
  /** Per-field provenance marker (FieldSourceGlyph) — mk1 read mode only. */
  sourceGlyph?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0 min-w-28 mr-3 inline-flex items-center gap-1">
        {label}
        {sourceGlyph}
      </span>
```

(rest of the component unchanged.)

`EditableField.tsx` `EditableDataRow` (~200) — same addition: add `sourceGlyph?: React.ReactNode` to `EditableDataRowProps` (with the same doc comment), destructure it, and change the label span to:

```tsx
      <span className="text-xs text-muted-foreground shrink-0 min-w-28 mr-3 inline-flex items-center gap-1">
        {label}
        {sourceGlyph}
      </span>
```

`SampleDetails.tsx` `SectionHeader` (~2458) — add `titleSuffix?: React.ReactNode` prop and render it immediately after the title text in the header row (read the component body first; place `{titleSuffix}` inside the same flex container as `{title}`).

- [ ] **Step 2: Wire the glyphs**

In `SampleDetails.tsx`, inside the component where `data` is in scope (near the `ReadSourceBanner` usage, before the return that renders the cards), add:

```tsx
  // Per-field provenance markers (mk1 read mode only; null in SENAITE mode).
  const fieldGlyph = (field: string, label: string) => (
    <FieldSourceGlyph
      source={detailsFieldSource(data.read_source, data.field_sources, field)}
      field={label}
    />
  )
```

Add imports: `import { FieldSourceGlyph } from '@/components/senaite/FieldSourceGlyph'` and `detailsFieldSource` from `@/lib/read-source`.

Wire each render site (field_sources key → rendered row):

| Render site (approx line) | Component | Add prop |
|---|---|---|
| Sample Type (~5023) | DataRow | `sourceGlyph={fieldGlyph('sample_type', 'Sample Type')}` |
| Date Sampled (~5028) | EditableDataRow | `sourceGlyph={fieldGlyph('date_sampled', 'Date Sampled')}` |
| Date Received (~5042) | DataRow | `sourceGlyph={fieldGlyph('date_received', 'Date Received')}` |
| Order # (~5055) | EditableDataRow | `sourceGlyph={fieldGlyph('client_order_number', 'Order #')}` |
| Client Sample ID (~5097) | EditableDataRow | `sourceGlyph={fieldGlyph('client_sample_id', 'Client Sample ID')}` |
| Client Lot (~5111) | EditableDataRow | `sourceGlyph={fieldGlyph('client_lot', 'Client Lot')}` |
| Contact (~5125) | DataRow | `sourceGlyph={fieldGlyph('contact', 'Contact')}` |
| Client (~5126) | DataRow | `sourceGlyph={fieldGlyph('client', 'Client')}` |
| Total Declared Qty (~5673) | DataRow | `sourceGlyph={fieldGlyph('declared_weight_mg', 'Total Declared Qty')}` |
| Analytes card header (~5519) | SectionHeader | `titleSuffix={fieldGlyph('analytes', 'Analytes')}` |
| Status badge (~4477) | wrap | see below |

Status badge — change:

```tsx
{data.review_state && <StatusBadge state={data.review_state} />}
```

to:

```tsx
{data.review_state && (
  <span className="inline-flex items-center gap-1">
    <StatusBadge state={data.review_state} />
    {fieldGlyph('review_state', 'Status')}
  </span>
)}
```

(`review_state` is absent from `field_sources` by Task 3's design → absent-key rule marks it SENAITE-owned in mk1 mode.)

- [ ] **Step 3: Verify**

Run: `cd C:/tmp/Accu-Mk1-panel && npm run typecheck && npm run test:run -- src/components/senaite`
Expected: typecheck clean; all senaite suites pass (glyph behavior itself is unit-tested in Task 5 — this task is presentational wiring; `data.read_source` is undefined in SENAITE mode so every glyph is null there).

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-panel
git add src/components/senaite/SampleDetails.tsx src/components/dashboard/EditableField.tsx
git commit -m "feat(read-source): per-field SENAITE provenance glyphs on sample details"
```

---

### Task 7: Frontend — State column-header glyph on the samples list

**Files:**
- Modify: `C:\tmp\Accu-Mk1-panel\src\components\senaite\SenaiteDashboard.tsx` (`SampleTable` props ~206; header render ~417; usage site ~1023)
- Test: `C:\tmp\Accu-Mk1-panel\src\components\senaite\__tests__\SenaiteDashboard.readsource.test.tsx`

**Interfaces:**
- Consumes: Task 5's `FieldSourceGlyph`; `effective` from `useEffectiveReadSource('samples_list')` (already destructured at line ~655).
- Produces: `SampleTable` accepts `readSource?: ReadSource`; in mk1 mode the State header shows the glyph (aria-label `State: live from SENAITE`).

- [ ] **Step 1: Write the failing tests**

Add to `SenaiteDashboard.readsource.test.tsx`:

```tsx
  it('mk1 mode: State column header carries the SENAITE provenance glyph', async () => {
    vi.spyOn(api, 'getSenaiteStatus').mockResolvedValue({ enabled: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue([
      { key: 'registry_read_source', value: '{"samples_list":"mk1"}' } as api.Setting,
    ])
    vi.spyOn(api, 'fetchSampleAggregates').mockResolvedValue({ aggregates: {} })
    vi.spyOn(api, 'getRegistrySamples').mockResolvedValue({
      items: [registryItem], total: 1, b_start: 0,
    })
    vi.spyOn(api, 'getSenaiteSamples').mockResolvedValue({
      items: [refreshedItem], total: 1, b_start: 0,
    })

    renderDashboard()

    await waitFor(() =>
      expect(screen.getAllByLabelText('State: live from SENAITE').length).toBeGreaterThan(0)
    )
  })

  it('senaite mode: no provenance glyph anywhere', async () => {
    vi.spyOn(api, 'getSenaiteStatus').mockResolvedValue({ enabled: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue([])
    vi.spyOn(api, 'fetchSampleAggregates').mockResolvedValue({ aggregates: {} })
    vi.spyOn(api, 'getRegistrySamples').mockResolvedValue({ items: [], total: 0, b_start: 0 })
    const getSenaite = vi.spyOn(api, 'getSenaiteSamples').mockResolvedValue({
      items: [registryItem], total: 1, b_start: 0,
    })

    renderDashboard()

    await waitFor(() => expect(getSenaite).toHaveBeenCalled())
    expect(screen.queryByLabelText('State: live from SENAITE')).not.toBeInTheDocument()
  })
```

(`getAllByLabelText`: the tab structure renders one `SampleTable` per tab, so the header may appear multiple times — any non-zero count is the point.)

- [ ] **Step 2: Run tests to verify the mk1 one fails**

Run: `cd C:/tmp/Accu-Mk1-panel && npm run test:run -- src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx`
Expected: mk1 header test FAILS (no glyph yet); senaite one passes.

- [ ] **Step 3: Implement**

In `SenaiteDashboard.tsx`:

1. Import `FieldSourceGlyph` (top of file): `import { FieldSourceGlyph } from '@/components/senaite/FieldSourceGlyph'`. `ReadSource` type is already imported via `@/lib/read-source` — if not, add `import type { ReadSource } from '@/lib/read-source'`.
2. `SampleTable` props (~206): add `readSource` to the destructure and the prop type:

```tsx
  readSource?: ReadSource
```

3. Header render (~417) — inside the `columns.map` `TableHead`, change the label span to:

```tsx
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.key === 'review_state' && readSource === 'mk1' && (
                    <FieldSourceGlyph
                      source="senaite"
                      field="State"
                      note="Refreshed live from SENAITE on each page load. All other columns read from the Accu-Mk1 registry."
                    />
                  )}
                  <SortIcon column={col.key} sort={sort} />
                </span>
```

4. Usage site (~1023): pass `readSource={effective}` alongside the existing `SampleTable` props.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd C:/tmp/Accu-Mk1-panel && npm run test:run -- src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-panel
git add src/components/senaite/SenaiteDashboard.tsx src/components/senaite/__tests__/SenaiteDashboard.readsource.test.tsx
git commit -m "feat(read-source): SENAITE provenance glyph on the State column header"
```

---

### Task 8: Integration — full gates, stack deploy, eyeball

**Files:** none created — verification + deploy only.

- [ ] **Step 1: Full frontend gate**

Run: `cd C:/tmp/Accu-Mk1-panel && npm run test:run -- src/components/senaite src/lib/__tests__/read-source.test.ts src/lib/__tests__/effective-read-source.test.ts && npm run typecheck`
Expected: all pass (compare failures, if any, against the known flag-hook baseline — no NEW failures).

- [ ] **Step 2: Full backend gate (targeted suites)**

Run: `docker exec accu-mk1-panel-test python -m pytest tests/test_senaite_samples_slim.py tests/test_native_manage_analyses.py tests/test_registry_read.py tests/test_registry_read_endpoint.py tests/test_registry_list.py tests/test_replace_analyte.py -q`
Expected: all pass.

- [ ] **Step 3: Push and deploy to the `registry` stack**

```bash
cd C:/tmp/Accu-Mk1-panel
git push -u origin feat/productionize-mk1-default
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-registry fetch origin && git -C ~/worktrees/Accu-Mk1-registry merge origin/feat/productionize-mk1-default --no-edit && docker restart accumark-registry-accu-mk1-backend accumark-registry-accu-mk1-frontend'
```

Then confirm both containers healthy:

```bash
ssh forrestparker@100.73.137.3 'sleep 10; docker ps --filter name=accumark-registry-accu-mk1 --format "{{.Names}}  {{.Status}}"'
```

- [ ] **Step 4: Live verification on the stack**

1. Slim call fires: load the samples list in mk1 mode at `http://100.73.137.3:5652` (admin `forrest@valenceanalytical.com` / `zJaZkasv9NJtMDil`; set the Data Source pref or the per-page override to Accu-Mk1), then:
   `ssh forrestparker@100.73.137.3 'docker logs --since 3m accumark-registry-accu-mk1-backend 2>&1 | grep -E "GET /(registry|senaite)/samples"'`
   Expected: paired `GET /registry/samples` + `GET /senaite/samples?...slim=true` 200s.
2. Glyphs: State header shows the flask glyph with the rich tooltip in mk1 mode; details page shows per-field glyphs on SENAITE-sourced fields (status badge at minimum) and none in SENAITE mode.
3. Replace dual-write: on a stack sample with a replaceable slot, run Replace from the Analytes card; then confirm the LIST (mk1 mode) shows the new analyte — which now comes from the registry alone:
   `ssh forrestparker@100.73.137.3 'docker exec accumark-registry-devstack-postgres psql -U postgres -d accumark_mk1 -c "SELECT sample_id, analytes FROM lims_samples WHERE sample_id = '"'"'<SAMPLE>'"'"';"'`
   (adjust the postgres container name via `docker ps | grep postgres` on the devbox if it differs). Expected: analytes JSON contains the new peptide name.
4. Note the caveat: the mounted dev frontend over Tailscale has the known `/api/api/` shadowing for some calls — if something 404s, check the console URL for the doubled prefix before suspecting the code.

- [ ] **Step 5: Report**

Summarize: gates run + results, stack verification evidence (log lines, SQL output), any deviations. Do NOT open a PR yet — Handler reviews first.

---

## Self-review (done at plan time)

- **Spec coverage:** Replace dual-write → Task 2; slim listing → Task 1; overlay correction → Task 3; FE slim merge → Task 4; icons (list + details + component) → Tasks 5–7; testing + stack eyeball → per-task + Task 8. Prod flip: out of scope (spec).
- **Type consistency:** `slim` is positional arg 6 of `getSenaiteSamples` everywhere; `detailsFieldSource(readSource, fieldSources, field)` signature consistent across Tasks 5–6; `sourceGlyph`/`titleSuffix` prop names consistent; aria-label format `"<field>: live from SENAITE"` consistent between Tasks 5 and 7 tests.
- **Placeholder scan:** clean — every code step carries the actual code; the two "check the file first" notes (tooltip exports, SectionHeader body, postgres container name) are deliberate read-before-edit instructions, not deferred design.
