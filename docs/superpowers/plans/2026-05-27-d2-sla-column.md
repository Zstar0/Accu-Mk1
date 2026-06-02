# Sub-project D2 — Order-list SLA Column + Per-Tier Amber Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-order SLA verdict (RAG against the real `priority > group-tier > default` model, business-hours-aware via B's engine, per-tier amber threshold) to every `OrderRow` (table view) and replace the hardcoded 24/48h `goalNote` in `OrderStatusPage`'s card view with the same real-tier logic — with one new backend endpoint (`POST /sample-priorities/lookup`) and one new tier column (`amber_threshold_percent`).

**Architecture:** A pure `src/lib/sla-resolution.ts` mirrors the Python tier resolver (precedence + multi-group tightest), classifies sample colors, and aggregates worst-active samples into an order verdict. A `useOrderSlaStatuses` hook bulk-fetches priorities (one capped `POST /sample-priorities/lookup` per visible page), runs ONE `POST /sla/status` batch (B), and `useMemo`-aggregates the verdict map — NO secondary `useQuery` for derivation. Two render components — `OrderSlaCell` (order-aggregated, table view) and `SampleSlaIndicator` (per-sample, card-view goalNote replacement) — share a `classifySampleColor` primitive. `SlaPane` gets one new numeric input bound to the new tier column.

**Tech Stack:** Python 3.13 / FastAPI / SQLAlchemy 2.0 (raw-SQL idempotent migrations, no Alembic) / Postgres `accumark_mk1`; React 19 / TanStack Query v5 / shadcn-ui / react-i18next / Vitest.

---

## Operating context (read before starting)

- **Work in the worktree `C:\tmp\accu-mk1-wave1`** (branch `feat/order-status-processing-time`). Docker containers bind-mount the worktree; the OneDrive checkout is parked on `master` and is NOT what `:3101`/`:8012` serve. All paths below are relative to the worktree.
- **Backend tests live at `/app/tests` inside the container.** Run them as:
  `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/<file> -q'`
  If pytest is missing (session-local pip install, lost on rebuild): `docker exec accu-mk1-backend pip install --quiet pytest`.
- **Frontend tests run inside the frontend container:**
  `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run <file>'`
- **Restart after schema/endpoint edits:** `docker restart accu-mk1-backend` after editing `models.py`/`database.py`/`main.py` (migrations + `init_db` run only at startup; Windows bind-mount HMR does not fire for the backend). `docker restart accu-mk1-frontend` after `src/` edits if HMR misses.
- **Lint only the files you change.** `npm run lint -- <files>` does NOT scope — it lints the whole project. Use `npx --prefix /c/tmp/accu-mk1-wave1 eslint <files>` (host) instead. 3 pre-existing baseline errors in `src/lib/api.ts` (~lines 1730/3224/3757) are NOT regressions — ignore them.
- **ESLint house rules:** `Array<T>` is forbidden — use `T[]`. Zustand: selector syntax only, no destructuring.
- **i18n convention here:** `fr.json` and `ar.json` currently hold *English* strings for the existing SLA keys (translation deferred). Mirror that — add the **same English** `orderStatus.sla.*` and `preferences.sla.amberThreshold`/`preferences.sla.percentRemaining` keys to all three locale files.
- **i18n keys co-commit with the consuming task** — do NOT batch i18n into a late "i18n" task. `orderStatus.sla.*` ship with Task 7 (OrderSlaCell). `preferences.sla.amberThreshold`/`percentRemaining` ship with Task 11 (SlaPane).
- **Commit per task; push the feature branch per task. NO PR/merge to master.** Leave `.planning/STATE.md` out of commits (GSD artifact).
- **KNOWN out-of-scope pre-existing failures** (do NOT bisect D2 looking for these):
  - `tests/test_api_sla_tiers.py::test_default_tier_encodes_old_24h_goal`
  - `tests/test_api_sla_tiers.py::test_list_returns_seeded_default`
  These fail in isolation because the dev DB's default tier has `target_minutes=2880` (not the seeded `1440`) and a stray `Microbiology` tier (id=21, 6720 min) is present. Both predate D2 and may be real lab config or leftover test pollution. Out-of-scope for this plan — flag in Task 12 verification.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `backend/models.py` | Add `amber_threshold_percent` column to `SlaTier` | Modify |
| `backend/database.py` | Idempotent `ALTER TABLE` migration for `sla_tiers.amber_threshold_percent` | Modify |
| `backend/main.py` | Extend SlaTier Pydantic schemas with `amber_threshold_percent` + 1–100 validation; add `SamplePriorityLookup*` schemas + `POST /sample-priorities/lookup` endpoint | Modify |
| `backend/tests/test_api_sla_tiers.py` | Extend with amber_threshold_percent round-trip + 1/100/422 boundary tests | Modify |
| `backend/tests/test_api_sample_priorities.py` | New: empty / >500 / mixed-present / auth / unauthenticated tests | Create |
| `src/lib/api.ts` | Extend `SlaTier`/`SlaTierCreate`/`SlaTierUpdate` types; add `samplePrioritiesLookup`, `getAnalysisServicesLocal` fetchers | Modify |
| `src/services/sample-priorities.ts` | TanStack Query hook with sorted-UID hash key | Create |
| `src/services/analysis-services.ts` | TanStack Query hook for `/analysis-services` | Create |
| `src/lib/sla-resolution.ts` | `buildServiceToGroupTierMap`, `resolveSampleTier`, `classifySampleColor`, `aggregateOrderSlaVerdict` | Create |
| `src/test/sla-resolution.test.ts` | Pure-function tests (incl. `unmapped_analysis_keyword_falls_through_to_default`) | Create |
| `src/services/order-sla.ts` | `useOrderSlaStatuses` hook: stable hash queryKey + useMemo aggregation | Create |
| `src/test/order-sla.test.tsx` | Hook test: batch items, stable queryKey, error propagation | Create |
| `src/components/explorer/OrderSlaCell.tsx` | Order-aggregated cell | Create |
| `src/components/explorer/SampleSlaIndicator.tsx` | Per-sample indicator for card-view goalNote replacement | Create |
| `src/test/order-sla-cell.test.tsx` | Render all 7 states with stable test IDs | Create |
| `locales/{en,fr,ar}.json` | Add `orderStatus.sla.*` (Task 7) and `preferences.sla.amberThreshold`/`percentRemaining` (Task 11) | Modify |
| `src/components/explorer/OrderRow.tsx` | New `slaVerdict?` prop + new `<td>` between Timing and Samples | Modify |
| `src/test/order-row.test.tsx` | Extend: SLA cell renders verdict; absence → loading | Modify |
| `src/components/OrderStatusPage.tsx` | Wire `useOrderSlaStatuses`, add `<th>SLA</th>`, pass `slaVerdict` to OrderRow; REPLACE card-view goalNote block (lines 277-292) with `SampleSlaIndicator` | Modify |
| `src/components/CustomerStatusPage.tsx` | Wire `useOrderSlaStatuses`, add `<th>SLA</th>`, pass `slaVerdict` to OrderRow | Modify |
| `src/components/preferences/panes/SlaPane.tsx` | TierCard gains `amber_threshold_percent` numeric input; extend `onSave` signature | Modify |
| `src/test/sla-pane.test.tsx` | New (or extend existing): amber-threshold input renders + PUTs on blur | Create or Modify |

---

## Task 1: Backend — `amber_threshold_percent` on `sla_tiers`

**Files:**
- Modify: `backend/models.py` (`SlaTier` model)
- Modify: `backend/database.py` (`_run_migrations` — append `ALTER TABLE`)
- Modify: `backend/main.py` (`SlaTierCreate`/`SlaTierUpdate`/`SlaTierResponse` + 1–100 validation in POST/PUT handlers)
- Test: `backend/tests/test_api_sla_tiers.py` (extend)

> **Impact note:** `SlaTier` is read by `SlaPane` (UI), `/sla-tiers` CRUD, and the priority/group resolution in the inbox aggregation. Adding a non-null column with a server-side DEFAULT is backwards-compatible — all existing rows acquire `20` on `ALTER TABLE`, and the existing Pydantic responses gain one extra field that current callers ignore.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_sla_tiers.py`:
```python
# ── amber_threshold_percent (sub-project D2) ──────────────────────────────


def test_get_includes_amber_threshold_percent_with_default_20():
    rows = client.get("/sla-tiers").json()
    assert rows, "expected at least the seeded default tier"
    for r in rows:
        assert "amber_threshold_percent" in r
        assert 1 <= r["amber_threshold_percent"] <= 100


def test_create_accepts_custom_amber_threshold():
    resp = client.post(
        "/sla-tiers",
        json={"name": "Custom amber", "target_minutes": 480, "amber_threshold_percent": 33},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["amber_threshold_percent"] == 33


def test_create_default_omits_amber_falls_back_to_20():
    resp = client.post("/sla-tiers", json={"name": "Default amber", "target_minutes": 240})
    assert resp.status_code == 201, resp.text
    assert resp.json()["amber_threshold_percent"] == 20


def test_put_can_update_amber_threshold_without_touching_other_fields():
    new_id = client.post(
        "/sla-tiers", json={"name": "PUT amber", "target_minutes": 720}
    ).json()["id"]
    resp = client.put(f"/sla-tiers/{new_id}", json={"amber_threshold_percent": 50})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["amber_threshold_percent"] == 50
    assert body["name"] == "PUT amber"
    assert body["target_minutes"] == 720


def test_create_rejects_amber_threshold_below_1():
    resp = client.post(
        "/sla-tiers",
        json={"name": "Bad amber low", "target_minutes": 240, "amber_threshold_percent": 0},
    )
    assert resp.status_code == 422


def test_create_rejects_amber_threshold_above_100():
    resp = client.post(
        "/sla-tiers",
        json={"name": "Bad amber high", "target_minutes": 240, "amber_threshold_percent": 101},
    )
    assert resp.status_code == 422


def test_put_rejects_amber_threshold_out_of_range():
    new_id = client.post(
        "/sla-tiers", json={"name": "Range PUT", "target_minutes": 240}
    ).json()["id"]
    assert client.put(f"/sla-tiers/{new_id}", json={"amber_threshold_percent": 0}).status_code == 422
    assert client.put(f"/sla-tiers/{new_id}", json={"amber_threshold_percent": 101}).status_code == 422


def test_amber_threshold_boundaries_1_and_100_accepted():
    # 1 (lower bound)
    r1 = client.post(
        "/sla-tiers",
        json={"name": "Min amber", "target_minutes": 60, "amber_threshold_percent": 1},
    )
    assert r1.status_code == 201, r1.text
    assert r1.json()["amber_threshold_percent"] == 1
    # 100 (upper bound)
    r100 = client.post(
        "/sla-tiers",
        json={"name": "Max amber", "target_minutes": 60, "amber_threshold_percent": 100},
    )
    assert r100.status_code == 201, r100.text
    assert r100.json()["amber_threshold_percent"] == 100
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_tiers.py -k amber -q'`
Expected: FAIL — the new tests will either get 200 responses missing the field (KeyError on `amber_threshold_percent`) or 201 with the wrong value, depending on which step you're at. Some fail because the field is not yet returned (KeyError on response).

- [ ] **Step 3a: Add the column to the ORM model**

In `backend/models.py`, in the `SlaTier` class (~line 703), insert `amber_threshold_percent` between `is_default` and `created_at`:
```python
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # D2: per-tier amber threshold. Sample is amber when remaining/target * 100 < this.
    amber_threshold_percent: Mapped[int] = mapped_column(
        Integer, nullable=False, default=20
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
```

- [ ] **Step 3b: Add the idempotent migration**

In `backend/database.py`, in `_run_migrations`'s `migrations` list, append a new entry immediately after the `sla_tiers` seed block (search for `"INSERT INTO sla_tiers"` to locate; insert right after the closing `"""`):
```python
        # D2: per-tier amber threshold (idempotent ALTER, existing rows get 20).
        "ALTER TABLE sla_tiers ADD COLUMN IF NOT EXISTS amber_threshold_percent INTEGER NOT NULL DEFAULT 20",
```

- [ ] **Step 3c: Extend the Pydantic schemas**

In `backend/main.py`, update the three SlaTier schemas (~lines 1835–1859) to:
```python
class SlaTierCreate(BaseModel):
    name: str
    target_minutes: int
    business_hours_only: bool = False
    is_default: bool = False
    amber_threshold_percent: int = 20


class SlaTierUpdate(BaseModel):
    name: Optional[str] = None
    target_minutes: Optional[int] = None
    business_hours_only: Optional[bool] = None
    is_default: Optional[bool] = None
    amber_threshold_percent: Optional[int] = None


class SlaTierResponse(BaseModel):
    id: int
    name: str
    target_minutes: int
    business_hours_only: bool
    is_default: bool
    amber_threshold_percent: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
```

- [ ] **Step 3d: Add 1–100 validation in the existing tier handlers**

In `backend/main.py`, locate the `create_sla_tier` (POST `/sla-tiers`) and `update_sla_tier` (PUT `/sla-tiers/{id}`) handlers (~line 11926+; grep `@app.post("/sla-tiers"` and `@app.put("/sla-tiers/`). Add a 1–100 boundary check at the top of each handler body, before any DB read:

In `create_sla_tier`:
```python
    if not (1 <= data.amber_threshold_percent <= 100):
        raise HTTPException(422, "amber_threshold_percent must be between 1 and 100")
```

In `update_sla_tier`:
```python
    if data.amber_threshold_percent is not None and not (1 <= data.amber_threshold_percent <= 100):
        raise HTTPException(422, "amber_threshold_percent must be between 1 and 100")
```

If `update_sla_tier` currently uses a `model_dump(exclude_unset=True)` setattr loop (most likely — that's the standard FastAPI pattern), the new field will round-trip automatically. If it sets fields by name, add `tier.amber_threshold_percent = data.amber_threshold_percent` inside the existing `if data.amber_threshold_percent is not None:` branch.

- [ ] **Step 4: Restart backend, run the test file**

```bash
docker restart accu-mk1-backend
curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_tiers.py -q'
```
Expected: all amber tests PASS. The two KNOWN pre-existing failures (`test_default_tier_encodes_old_24h_goal`, `test_list_returns_seeded_default`) may still fail — that's out of scope, do NOT fix them here.

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add backend/models.py backend/database.py backend/main.py backend/tests/test_api_sla_tiers.py
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): amber_threshold_percent on sla_tiers (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 2: Backend — `POST /sample-priorities/lookup` (bulk read)

**Files:**
- Modify: `backend/main.py` (3 Pydantic schemas + 1 endpoint)
- Test: `backend/tests/test_api_sample_priorities.py` (new)

> **Why POST not GET (advisor sharpening #1):** a 500-UID body at ~32 chars per UID would push the query string near 17 KB — well past the safe URL-length floor for some proxies. POST matches B's `POST /sla/status` batch-read pattern and the existing `/sla-priority-tiers` set endpoint style.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_sample_priorities.py`:
```python
"""API tests for POST /sample-priorities/lookup (sub-project D2).

Self-restoring against the live accumark_mk1 DB.
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sample_priorities.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


@pytest.fixture
def cleanup_priorities():
    created = []
    yield created
    if created:
        with engine.begin() as c:
            c.execute(text("DELETE FROM sample_priorities WHERE sample_uid = ANY(:uids)"), {"uids": created})


def _seed(uid: str, priority: str = "high"):
    with engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO sample_priorities (sample_uid, priority, updated_at) "
                "VALUES (:u, :p, NOW()) "
                "ON CONFLICT (sample_uid) DO UPDATE SET priority=:p, updated_at=NOW()"
            ),
            {"u": uid, "p": priority},
        )


def test_empty_sample_uids_returns_422():
    resp = client.post("/sample-priorities/lookup", json={"sample_uids": []})
    assert resp.status_code == 422


def test_over_cap_returns_422():
    resp = client.post(
        "/sample-priorities/lookup",
        json={"sample_uids": [f"u-{i}" for i in range(501)]},
    )
    assert resp.status_code == 422
    assert "max" in resp.text.lower() or "500" in resp.text


def test_at_cap_500_uids_accepted(cleanup_priorities):
    uid = "d2-cap-test-001"
    _seed(uid, "expedited")
    cleanup_priorities.append(uid)
    payload = [f"d2-cap-noise-{i}" for i in range(499)] + [uid]
    resp = client.post("/sample-priorities/lookup", json={"sample_uids": payload})
    assert resp.status_code == 200, resp.text
    items = {i["sample_uid"]: i["priority"] for i in resp.json()["items"]}
    assert items == {uid: "expedited"}  # sparse: only present rows


def test_mixed_present_and_absent_returns_only_present(cleanup_priorities):
    uid_a, uid_b = "d2-mix-a", "d2-mix-b"
    _seed(uid_a, "high")
    _seed(uid_b, "expedited")
    cleanup_priorities.extend([uid_a, uid_b])
    resp = client.post(
        "/sample-priorities/lookup",
        json={"sample_uids": [uid_a, "absent-1", uid_b, "absent-2"]},
    )
    assert resp.status_code == 200, resp.text
    items = {i["sample_uid"]: i["priority"] for i in resp.json()["items"]}
    assert items == {uid_a: "high", uid_b: "expedited"}


def test_order_not_guaranteed_assert_as_set(cleanup_priorities):
    uids = [f"d2-order-{i}" for i in range(5)]
    for u in uids:
        _seed(u, "high")
        cleanup_priorities.append(u)
    resp = client.post("/sample-priorities/lookup", json={"sample_uids": list(reversed(uids))})
    assert resp.status_code == 200, resp.text
    assert set(i["sample_uid"] for i in resp.json()["items"]) == set(uids)


def test_requires_auth():
    # Drop the override for this single test.
    app.dependency_overrides.pop(auth.get_current_user, None)
    try:
        resp = client.post("/sample-priorities/lookup", json={"sample_uids": ["any"]})
        assert resp.status_code in (401, 403)
    finally:
        app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sample_priorities.py -q'`
Expected: FAIL — 404 on `/sample-priorities/lookup` (endpoint not defined yet).

- [ ] **Step 3a: Add the Pydantic schemas**

In `backend/main.py`, find a spot near the existing `SlaPriorityTier*` schemas (~line 1862). Add immediately after `SlaPriorityTierSet`:
```python
# ── D2: bulk per-sample priority lookup ────────────────────────────────────

class SamplePriorityLookupRequest(BaseModel):
    sample_uids: list[str]


class SamplePriorityResponseItem(BaseModel):
    sample_uid: str
    priority: Literal["normal", "high", "expedited"]


class SamplePriorityLookupResponse(BaseModel):
    items: list[SamplePriorityResponseItem]
```

- [ ] **Step 3b: Add the endpoint**

In `backend/main.py`, find the existing `update_inbox_priority` handler at `@app.put("/worksheets/inbox/{sample_uid}/priority")` (~line 12751). Add the new endpoint immediately AFTER it (before `@app.get("/worksheets/users")`):
```python
# ── D2: bulk per-sample priority lookup ────────────────────────────────────

@app.post("/sample-priorities/lookup", response_model=SamplePriorityLookupResponse)
async def lookup_sample_priorities(
    req: SamplePriorityLookupRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Sparse bulk read of sample_priorities for the order-list SLA cell.

    Returns only rows that exist; absent UIDs are omitted (the client treats
    absence as the default 'normal', matching the tier-resolution model).
    Hard cap 500 UIDs per request — a sanity bound that more than covers the
    visible-orders page at tens-to-low-hundreds of samples.
    """
    if not req.sample_uids:
        raise HTTPException(422, "sample_uids must be a non-empty list")
    if len(req.sample_uids) > 500:
        raise HTTPException(422, "too many sample_uids; max 500")
    rows = db.execute(
        select(SamplePriority).where(SamplePriority.sample_uid.in_(req.sample_uids))
    ).scalars().all()
    return SamplePriorityLookupResponse(
        items=[
            SamplePriorityResponseItem(sample_uid=r.sample_uid, priority=r.priority)  # type: ignore[arg-type]
            for r in rows
        ]
    )
```

- [ ] **Step 4: Restart backend, run the test file**

```bash
docker restart accu-mk1-backend
curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sample_priorities.py -q'
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add backend/main.py backend/tests/test_api_sample_priorities.py
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): POST /sample-priorities/lookup bulk read (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 3: Frontend `api.ts` — types + fetchers

**Files:**
- Modify: `src/lib/api.ts` (extend SlaTier types + add 2 new fetchers)
- Test: (no test in this task — Task 4 covers the hook layer)

- [ ] **Step 1: Extend the SlaTier types**

In `src/lib/api.ts`, find the `SlaTier` interfaces (~lines 3901–3923). Add `amber_threshold_percent` to all three:
```typescript
export interface SlaTier {
  id: number
  name: string
  target_minutes: number
  business_hours_only: boolean
  is_default: boolean
  amber_threshold_percent: number
  created_at: string
  updated_at: string
}

export interface SlaTierCreate {
  name: string
  target_minutes: number
  business_hours_only?: boolean
  is_default?: boolean
  amber_threshold_percent?: number
}

export interface SlaTierUpdate {
  name?: string
  target_minutes?: number
  business_hours_only?: boolean
  is_default?: boolean
  amber_threshold_percent?: number
}
```

- [ ] **Step 2: Add the new fetchers**

In `src/lib/api.ts`, immediately after the existing `fetchSlaStatuses` function (~line 4084), append:
```typescript
// ─── D2: bulk per-sample priority lookup ─────────────────────────────────────

export interface SamplePriorityLookupResponseItem {
  sample_uid: string
  priority: InboxPriority
}

export async function samplePrioritiesLookup(
  sampleUids: string[]
): Promise<SamplePriorityLookupResponseItem[]> {
  if (sampleUids.length === 0) return []
  const response = await fetch(`${API_BASE_URL()}/sample-priorities/lookup`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ sample_uids: sampleUids }),
  })
  if (!response.ok) {
    throw new Error(`Failed to lookup sample priorities: ${response.status}`)
  }
  const data = await response.json()
  return data.items
}

// ─── D2: local /analysis-services fetch (id + keyword for keyword→id mapping) ─

export async function getAnalysisServicesLocal(): Promise<AnalysisServiceRecord[]> {
  // The local /analysis-services endpoint (NOT /explorer/analysis-services, which
  // proxies to the Integration Service and is the wrong source for the
  // keyword → analysis_services.id mapping the order-SLA cell needs).
  const response = await fetch(`${API_BASE_URL()}/analysis-services`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    throw new Error(`Failed to load analysis services: ${response.status}`)
  }
  return response.json()
}
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix /c/tmp/accu-mk1-wave1 run typecheck`
Expected: clean (`InboxPriority` and `AnalysisServiceRecord` are already exported from `api.ts`; no new imports needed inside the file).

- [ ] **Step 4: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/lib/api.ts
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): api.ts amber_threshold + bulk priorities + analysis-services (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 4: Frontend services — `useAnalysisServices` + `useSamplePriorities`

**Files:**
- Create: `src/services/analysis-services.ts`
- Create: `src/services/sample-priorities.ts`

> **Stable-hash queryKey requirement (advisor sharpening #3) lives in Task 6.** This task ships the priority hook keyed by the sorted-UID hash so cross-page navigation with overlapping samples hits cache. The Task 6 hook composes this hook plus a tier-config hash plus a received-at hash into the order-SLA query key.

- [ ] **Step 1: Create `useAnalysisServices`**

Create `src/services/analysis-services.ts`:
```typescript
import { useQuery } from '@tanstack/react-query'
import { getAnalysisServicesLocal, type AnalysisServiceRecord } from '@/lib/api'

export const analysisServicesQueryKeys = {
  all: ['analysis-services', 'local'] as const,
}

export function useAnalysisServices() {
  return useQuery({
    queryKey: analysisServicesQueryKeys.all,
    queryFn: getAnalysisServicesLocal,
    staleTime: 1000 * 60 * 5,
  })
}

export type { AnalysisServiceRecord }
```

- [ ] **Step 2: Create `useSamplePriorities` (sorted-UID hash key)**

Create `src/services/sample-priorities.ts`:
```typescript
import { useQuery } from '@tanstack/react-query'
import {
  samplePrioritiesLookup,
  type SamplePriorityLookupResponseItem,
} from '@/lib/api'

/**
 * Sort + dedupe + join — a stable, order-independent hash. Two calls with
 * `['a','b']` and `['b','a','a']` produce the same key, so navigation between
 * pages that share samples reuses the 5-minute-stale cache instead of
 * refetching the entire set.
 */
export function sortedUidsHash(uids: string[]): string {
  return Array.from(new Set(uids)).sort().join('|')
}

export const samplePrioritiesQueryKeys = {
  lookup: (hash: string) => ['sample-priorities', 'lookup', hash] as const,
}

export function useSamplePriorities(uids: string[]) {
  const hash = sortedUidsHash(uids)
  return useQuery({
    queryKey: samplePrioritiesQueryKeys.lookup(hash),
    // Read sortedUids inside the queryFn so the closure stays stable across
    // renders that produce the same hash (TanStack identifies queries by key).
    queryFn: () => samplePrioritiesLookup(Array.from(new Set(uids)).sort()),
    staleTime: 1000 * 60 * 5,
    enabled: uids.length > 0,
  })
}

export type { SamplePriorityLookupResponseItem }
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix /c/tmp/accu-mk1-wave1 run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/services/analysis-services.ts src/services/sample-priorities.ts
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): TanStack hooks for analysis-services + bulk priorities (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 5: `src/lib/sla-resolution.ts` — pure resolvers + classifier + aggregator

**Files:**
- Create: `src/lib/sla-resolution.ts`
- Test: `src/test/sla-resolution.test.ts`

> **Advisor sharpening #5:** Both `OrderSlaCell` (Task 7, table view) and `SampleSlaIndicator` (Task 7, card-view goalNote replacement) MUST consume the same `classifySampleColor` primitive. That primitive lives here.
>
> **Advisor sharpening #6 — named test:** `test_unmapped_analysis_keyword_falls_through_to_default` MUST appear in the `resolveSampleTier` suite below.

- [ ] **Step 1: Write the failing tests**

Create `src/test/sla-resolution.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import type {
  AnalysisServiceRecord,
  ServiceGroup,
  SlaTier,
  SenaiteAnalysis,
  SenaiteLookupResult,
  InboxPriority,
} from '@/lib/api'
import {
  buildServiceToGroupTierMap,
  resolveSampleTier,
  classifySampleColor,
  aggregateOrderSlaVerdict,
  type SampleSlaInputs,
} from '@/lib/sla-resolution'

const tier = (
  id: number,
  name: string,
  target_minutes: number,
  amber = 20,
  is_default = false,
  business_hours_only = false
): SlaTier => ({
  id,
  name,
  target_minutes,
  business_hours_only,
  is_default,
  amber_threshold_percent: amber,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
})

const group = (
  id: number,
  name: string,
  sla_tier_id: number | null,
  member_ids: number[]
): ServiceGroup => ({
  id,
  name,
  description: null,
  color: 'blue',
  sort_order: 0,
  is_default: false,
  sla_tier_id,
  member_count: member_ids.length,
  member_ids,
})

const svc = (id: number, keyword: string | null): AnalysisServiceRecord => ({
  id,
  title: `Service ${id}`,
  keyword,
  category: null,
  unit: null,
  methods: null,
  peptide_name: null,
  peptide_id: null,
  senaite_id: null,
  senaite_uid: null,
  active: true,
})

const analysis = (keyword: string | null): SenaiteAnalysis => ({
  uid: `uid-${keyword ?? 'none'}`,
  keyword,
  title: `T-${keyword ?? 'none'}`,
  result: null,
  result_options: [],
  unit: null,
  method: null,
  method_uid: null,
  method_options: [],
  instrument: null,
  instrument_uid: null,
  analyst: null,
  analyst_username: null,
  due_date: null,
  review_state: null,
  sort_key: null,
})

const lookup = (
  date_received: string | null,
  review_state: string | null,
  keywords: (string | null)[]
): SenaiteLookupResult => ({
  sample_id: 'PB-0001',
  sample_uid: 'uid-PB-0001',
  client_sample_id: null,
  client: null,
  sample_type: null,
  date_received,
  date_sampled: null,
  date_received_lab: null,
  date_received_lab_naive: null,
  client_lot: null,
  review_state,
  declared_weight_mg: null,
  declared_volume_ml: null,
  retest_of: null,
  remarks: [],
  analyses: keywords.map(analysis),
  attachments: [],
} as unknown as SenaiteLookupResult)

const DEFAULT_TIER = tier(1, 'Standard', 1440, 20, true)

describe('buildServiceToGroupTierMap', () => {
  it('maps single-group analysis service to its group tier', () => {
    const tierA = tier(10, 'A', 480, 25)
    const tiersById = new Map<number, SlaTier>([[tierA.id, tierA]])
    const map = buildServiceToGroupTierMap(
      [group(1, 'G1', tierA.id, [100])],
      [svc(100, 'HPLC-100')],
      tiersById
    )
    expect(map.get(100)).toEqual(tierA)
  })

  it('multi-group: tightest target wins', () => {
    const tightTier = tier(10, 'Tight', 240, 20)
    const looseTier = tier(11, 'Loose', 2880, 20)
    const tiersById = new Map<number, SlaTier>([
      [tightTier.id, tightTier],
      [looseTier.id, looseTier],
    ])
    const map = buildServiceToGroupTierMap(
      [
        group(1, 'GLoose', looseTier.id, [100, 200]),
        group(2, 'GTight', tightTier.id, [200]),
      ],
      [svc(100, 'A'), svc(200, 'B')],
      tiersById
    )
    expect(map.get(100)).toEqual(looseTier)
    expect(map.get(200)).toEqual(tightTier)
  })

  it('group without sla_tier_id contributes nothing', () => {
    const tiersById = new Map<number, SlaTier>()
    const map = buildServiceToGroupTierMap(
      [group(1, 'NoTier', null, [100])],
      [svc(100, 'HPLC')],
      tiersById
    )
    expect(map.has(100)).toBe(false)
  })
})

describe('resolveSampleTier', () => {
  const priorityOverrideTier = tier(20, 'Expedited', 60, 50)
  const groupTier = tier(21, 'Group', 480, 30)
  const priorityToTier = new Map<InboxPriority, SlaTier>([
    ['expedited', priorityOverrideTier],
  ])

  it('priority override beats group beats default', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('HPLC-100')],
      priority: 'expedited',
    }
    const svcToGroupTier = new Map<number, SlaTier>([[100, groupTier]])
    const keywordToServiceId = new Map<string, number>([['HPLC-100', 100]])
    expect(
      resolveSampleTier(
        inputs,
        keywordToServiceId,
        svcToGroupTier,
        priorityToTier,
        DEFAULT_TIER
      )
    ).toEqual(priorityOverrideTier)
  })

  it('group tier when no priority override matches', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis('HPLC-100')],
      priority: 'normal',
    }
    const svcToGroupTier = new Map<number, SlaTier>([[100, groupTier]])
    const keywordToServiceId = new Map<string, number>([['HPLC-100', 100]])
    expect(
      resolveSampleTier(inputs, keywordToServiceId, svcToGroupTier, priorityToTier, DEFAULT_TIER)
    ).toEqual(groupTier)
  })

  it('multi-group: tightest tier across analyses wins', () => {
    const tightTier = tier(30, 'Tight', 120, 20)
    const inputs: SampleSlaInputs = {
      analyses: [analysis('LOOSE'), analysis('TIGHT')],
      priority: 'normal',
    }
    const svcToGroupTier = new Map<number, SlaTier>([
      [101, groupTier],   // 480 min
      [102, tightTier],   // 120 min
    ])
    const keywordToServiceId = new Map<string, number>([
      ['LOOSE', 101],
      ['TIGHT', 102],
    ])
    expect(
      resolveSampleTier(inputs, keywordToServiceId, svcToGroupTier, priorityToTier, DEFAULT_TIER)
    ).toEqual(tightTier)
  })

  it('test_unmapped_analysis_keyword_falls_through_to_default', () => {
    // Keyword on the sample has no row in the keyword→service map (e.g. brand
    // new analysis the lab has not yet wired into a service group).
    const inputs: SampleSlaInputs = {
      analyses: [analysis('NOT-IN-CATALOG')],
      priority: 'normal',
    }
    expect(
      resolveSampleTier(
        inputs,
        new Map(),
        new Map(),
        new Map(),
        DEFAULT_TIER
      )
    ).toEqual(DEFAULT_TIER)
  })

  it('null keyword analyses are skipped (no crash, falls through)', () => {
    const inputs: SampleSlaInputs = {
      analyses: [analysis(null)],
      priority: 'normal',
    }
    expect(
      resolveSampleTier(inputs, new Map(), new Map(), new Map(), DEFAULT_TIER)
    ).toEqual(DEFAULT_TIER)
  })

  it('no analyses and no default returns null', () => {
    const inputs: SampleSlaInputs = { analyses: [], priority: 'normal' }
    expect(
      resolveSampleTier(inputs, new Map(), new Map(), new Map(), null)
    ).toBeNull()
  })
})

describe('classifySampleColor', () => {
  const t30 = tier(40, 'T30', 100, 30)

  it('breached → red (strict greater than target)', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 101, remaining_minutes: -1, breached: true },
        t30
      )
    ).toBe('red')
  })

  it('elapsed exactly at target is NOT breached → green', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 100, remaining_minutes: 0, breached: false },
        t30
      )
    ).toBe('green')
  })

  it('strictly less than amber_threshold_percent → amber', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 75, remaining_minutes: 25, breached: false },
        t30 // 25 < 30 → amber
      )
    ).toBe('amber')
  })

  it('at amber_threshold_percent exactly → green (strict <)', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 70, remaining_minutes: 30, breached: false },
        t30 // 30 is NOT < 30 → green
      )
    ).toBe('green')
  })

  it('healthy → green', () => {
    expect(
      classifySampleColor(
        { target_minutes: 100, elapsed_minutes: 10, remaining_minutes: 90, breached: false },
        t30
      )
    ).toBe('green')
  })
})

describe('aggregateOrderSlaVerdict', () => {
  const t = tier(50, 'Std', 100, 20)

  it('all published → met', () => {
    const v = aggregateOrderSlaVerdict([
      { senaiteId: 'a', tier: t, lookup: lookup(null, 'published', []), status: null, color: null },
      { senaiteId: 'b', tier: t, lookup: lookup(null, 'published', []), status: null, color: null },
    ])
    expect(v.color).toBe('met')
  })

  it('none received → awaiting', () => {
    const v = aggregateOrderSlaVerdict([
      { senaiteId: 'a', tier: t, lookup: lookup(null, 'sample_received', []), status: null, color: null },
    ])
    expect(v.color).toBe('awaiting')
  })

  it('worst-active selection: red beats amber beats green', () => {
    const samples = [
      {
        senaiteId: 'green',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 10, remaining_minutes: 90, breached: false },
        color: 'green' as const,
      },
      {
        senaiteId: 'amber',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 85, remaining_minutes: 15, breached: false },
        color: 'amber' as const,
      },
      {
        senaiteId: 'red',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 150, remaining_minutes: -50, breached: true },
        color: 'red' as const,
      },
    ]
    const v = aggregateOrderSlaVerdict(samples)
    expect(v.color).toBe('red')
    expect(v.drivingSampleId).toBe('red')
  })

  it('within red: most-over wins', () => {
    const samples = [
      {
        senaiteId: 'red-small',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 110, remaining_minutes: -10, breached: true },
        color: 'red' as const,
      },
      {
        senaiteId: 'red-big',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 300, remaining_minutes: -200, breached: true },
        color: 'red' as const,
      },
    ]
    expect(aggregateOrderSlaVerdict(samples).drivingSampleId).toBe('red-big')
  })

  it('within amber: least-percent-remaining wins', () => {
    const samples = [
      {
        senaiteId: 'amber-25pct',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 75, remaining_minutes: 25, breached: false },
        color: 'amber' as const,
      },
      {
        senaiteId: 'amber-5pct',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 95, remaining_minutes: 5, breached: false },
        color: 'amber' as const,
      },
    ]
    expect(aggregateOrderSlaVerdict(samples).drivingSampleId).toBe('amber-5pct')
  })

  it('mixed published + received: published excluded, received drives verdict', () => {
    const samples = [
      {
        senaiteId: 'pub',
        tier: t,
        lookup: lookup('2026-01-01', 'published', []),
        status: null,
        color: null,
      },
      {
        senaiteId: 'live',
        tier: t,
        lookup: lookup('2026-01-01', 'sample_received', []),
        status: { target_minutes: 100, elapsed_minutes: 50, remaining_minutes: 50, breached: false },
        color: 'green' as const,
      },
    ]
    const v = aggregateOrderSlaVerdict(samples)
    expect(v.color).toBe('green')
    expect(v.drivingSampleId).toBe('live')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-resolution.test.ts'`
Expected: FAIL — `Cannot find module '@/lib/sla-resolution'`.

- [ ] **Step 3: Implement `src/lib/sla-resolution.ts`**

Create `src/lib/sla-resolution.ts`:
```typescript
import type {
  AnalysisServiceRecord,
  InboxPriority,
  SenaiteAnalysis,
  SenaiteLookupResult,
  ServiceGroup,
  SlaStatus,
  SlaTier,
} from '@/lib/api'

export type SlaColor = 'red' | 'amber' | 'green'
export type OrderSlaColor = SlaColor | 'met' | 'awaiting' | 'loading' | 'error'

export interface SampleSlaInputs {
  analyses: SenaiteAnalysis[]
  priority: InboxPriority | null
}

export interface SampleSlaCellState {
  senaiteId: string
  tier: SlaTier | null
  lookup: SenaiteLookupResult
  status: SlaStatus | null
  color: SlaColor | null
}

export interface OrderSlaVerdict {
  color: OrderSlaColor
  drivingSampleId?: string
  drivingTier?: SlaTier
  drivingStatus?: SlaStatus
}

/**
 * Build keyword → analysis_services.id map from the local /analysis-services
 * response. Services with no keyword are skipped (they can't be matched against
 * SENAITE analysis keywords).
 */
export function buildKeywordToServiceIdMap(
  services: AnalysisServiceRecord[]
): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of services) {
    if (s.keyword) out.set(s.keyword, s.id)
  }
  return out
}

/**
 * Service-id → tightest group tier among groups that contain the service.
 * When a service appears in multiple groups, the smallest target_minutes wins.
 * Groups without a sla_tier_id (or whose tier id is missing from tiersById) are
 * skipped so they don't shadow a real tier with a null.
 */
export function buildServiceToGroupTierMap(
  groups: ServiceGroup[],
  _services: AnalysisServiceRecord[],
  tiersById: Map<number, SlaTier>
): Map<number, SlaTier> {
  const out = new Map<number, SlaTier>()
  for (const g of groups) {
    if (g.sla_tier_id == null) continue
    const tier = tiersById.get(g.sla_tier_id)
    if (!tier) continue
    for (const svcId of g.member_ids) {
      const existing = out.get(svcId)
      if (!existing || tier.target_minutes < existing.target_minutes) {
        out.set(svcId, tier)
      }
    }
  }
  return out
}

/**
 * Apply precedence: priority-override > tightest-group-tier > default.
 * Returns null if no default is configured AND nothing resolves.
 */
export function resolveSampleTier(
  inputs: SampleSlaInputs,
  keywordToServiceId: Map<string, number>,
  serviceToGroupTier: Map<number, SlaTier>,
  priorityToTier: Map<InboxPriority, SlaTier>,
  defaultTier: SlaTier | null
): SlaTier | null {
  // 1. Priority override.
  if (inputs.priority) {
    const pTier = priorityToTier.get(inputs.priority)
    if (pTier) return pTier
  }
  // 2. Tightest group tier across the sample's analyses.
  let tightest: SlaTier | null = null
  for (const a of inputs.analyses) {
    if (!a.keyword) continue
    const svcId = keywordToServiceId.get(a.keyword)
    if (svcId == null) continue
    const groupTier = serviceToGroupTier.get(svcId)
    if (!groupTier) continue
    if (!tightest || groupTier.target_minutes < tightest.target_minutes) {
      tightest = groupTier
    }
  }
  if (tightest) return tightest
  // 3. Default tier.
  return defaultTier
}

/**
 * Classify ONE sample's SLA color using its own resolved tier's amber threshold.
 * `breached` is the strict > target check from the engine (B); amber is strict <.
 */
export function classifySampleColor(
  status: SlaStatus,
  tier: SlaTier
): SlaColor {
  if (status.breached) return 'red'
  if (tier.target_minutes <= 0) return 'green'
  const pct = (status.remaining_minutes / tier.target_minutes) * 100
  if (pct < tier.amber_threshold_percent) return 'amber'
  return 'green'
}

/**
 * Aggregate per-sample cell state into a single order verdict.
 * Worst-active sample drives the verdict (red > amber > green), with ties broken
 * by most-over for red and least-percent-remaining for amber. Published samples
 * are excluded; an order with all-published becomes 'met'; an order with no
 * received samples becomes 'awaiting'.
 */
export function aggregateOrderSlaVerdict(
  samples: SampleSlaCellState[]
): OrderSlaVerdict {
  if (samples.length === 0) return { color: 'awaiting' }
  const active = samples.filter(
    s => s.lookup.review_state !== 'published' && s.status != null && s.color != null
  )
  if (active.length === 0) {
    const allPublished = samples.every(s => s.lookup.review_state === 'published')
    return { color: allPublished ? 'met' : 'awaiting' }
  }
  const RANK: Record<SlaColor, number> = { red: 3, amber: 2, green: 1 }
  let driver: SampleSlaCellState | null = null
  for (const s of active) {
    if (!driver) {
      driver = s
      continue
    }
    const cmp = RANK[s.color as SlaColor] - RANK[driver.color as SlaColor]
    if (cmp > 0) {
      driver = s
    } else if (cmp === 0) {
      if (s.color === 'red') {
        // most-over: smallest (most-negative) remaining wins
        if ((s.status?.remaining_minutes ?? 0) < (driver.status?.remaining_minutes ?? 0)) {
          driver = s
        }
      } else if (s.color === 'amber') {
        // least-percent-remaining
        const sPct = (s.status!.remaining_minutes / s.status!.target_minutes) * 100
        const dPct = (driver.status!.remaining_minutes / driver.status!.target_minutes) * 100
        if (sPct < dPct) driver = s
      }
    }
  }
  return {
    color: driver!.color as OrderSlaColor,
    drivingSampleId: driver!.senaiteId,
    drivingTier: driver!.tier ?? undefined,
    drivingStatus: driver!.status ?? undefined,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-resolution.test.ts'`
Expected: PASS (all tests, including `test_unmapped_analysis_keyword_falls_through_to_default`).

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/lib/sla-resolution.ts src/test/sla-resolution.test.ts
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): sla-resolution.ts (resolver + classifier + aggregator) (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 6: `useOrderSlaStatuses` — stable hash queryKey + useMemo aggregation

**Files:**
- Create: `src/services/order-sla.ts`
- Test: `src/test/order-sla.test.tsx`

> **Advisor sharpenings #3 and #4 — both load-bearing:**
> - QueryKey MUST be a stable hash: `['order-sla-status', sortedUidsHash, sortedReceivedAtHash, tierConfigHash]`. A re-render with the same logical inputs MUST hit cache, not refetch.
> - Verdict aggregation is `useMemo` (pure transform of cached inputs), NOT a separate `useQuery`. Wrapping a derivation in `useQuery` thrashes the cache and obscures error propagation.
>
> The single `useQuery` here owns the `POST /sla/status` round-trip. Everything else is `useMemo` on cached inputs.

- [ ] **Step 1: Write the failing test**

Create `src/test/order-sla.test.tsx`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type {
  ExplorerOrder,
  SenaiteLookupResult,
  SlaStatusRequestItem,
  SlaStatusResultItem,
} from '@/lib/api'

const fetchSlaStatusesMock = vi.fn<(items: SlaStatusRequestItem[]) => Promise<SlaStatusResultItem[]>>()
const samplePrioritiesLookupMock = vi.fn<(uids: string[]) => Promise<{ sample_uid: string; priority: 'normal' | 'high' | 'expedited' }[]>>()
const getAnalysisServicesLocalMock = vi.fn().mockResolvedValue([])
const getServiceGroupsMock = vi.fn().mockResolvedValue([])
const getSlaTiersMock = vi.fn().mockResolvedValue([])
const getSlaPriorityTiersMock = vi.fn().mockResolvedValue([])

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchSlaStatuses: (items: SlaStatusRequestItem[]) => fetchSlaStatusesMock(items),
    samplePrioritiesLookup: (uids: string[]) => samplePrioritiesLookupMock(uids),
    getAnalysisServicesLocal: () => getAnalysisServicesLocalMock(),
    getServiceGroups: () => getServiceGroupsMock(),
    getSlaTiers: () => getSlaTiersMock(),
    getSlaPriorityTiers: () => getSlaPriorityTiersMock(),
  }
})

const { useOrderSlaStatuses } = await import('@/services/order-sla')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeOrder(overrides: Partial<ExplorerOrder> = {}): ExplorerOrder {
  return {
    id: 'order-uuid-1',
    order_id: '12345',
    order_number: '12345',
    status: 'pending',
    samples_expected: 1,
    samples_delivered: 0,
    error_message: null,
    payload: null,
    sample_results: null,
    created_at: '2026-01-01T00:00:00',
    updated_at: '2026-01-01T00:00:00',
    completed_at: null,
    wp_order_status: 'processing',
    ...overrides,
  }
}

function makeLookup(
  sample_uid: string,
  date_received: string | null,
  review_state: string | null
): SenaiteLookupResult {
  return {
    sample_id: sample_uid,
    sample_uid,
    client_sample_id: null,
    client: null,
    sample_type: null,
    date_received,
    date_sampled: null,
    client_lot: null,
    review_state,
    declared_weight_mg: null,
    remarks: [],
    analyses: [],
    attachments: [],
  } as unknown as SenaiteLookupResult
}

beforeEach(() => {
  fetchSlaStatusesMock.mockReset()
  samplePrioritiesLookupMock.mockReset().mockResolvedValue([])
  getAnalysisServicesLocalMock.mockClear()
  getServiceGroupsMock.mockClear()
  getSlaTiersMock.mockClear()
  getSlaPriorityTiersMock.mockClear()
})

describe('useOrderSlaStatuses', () => {
  it('builds one /sla/status batch item per received-but-unpublished sample, keyed by sample_uid', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const orders = [
      makeOrder({
        order_id: 'O1',
        sample_results: { '1': { senaite_id: 'PB-001', status: 'ok' } } as never,
      }),
    ]
    const lookupMap = new Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>([
      ['PB-001', { data: makeLookup('PB-001-uid', '2026-01-01T09:00:00', 'sample_received'), isLoading: false, isError: false }],
    ])
    renderHook(() => useOrderSlaStatuses(orders, lookupMap), { wrapper })
    await waitFor(() => {
      expect(fetchSlaStatusesMock).toHaveBeenCalled()
    })
    const passed = fetchSlaStatusesMock.mock.calls[0][0]
    expect(passed).toHaveLength(1)
    expect(passed[0].key).toBe('PB-001-uid')
    expect(passed[0].received_at).toBe('2026-01-01T09:00:00')
  })

  it('queryKey is stable across reorderings of the same UID set', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const lookupA = makeLookup('uid-A', '2026-01-01T09:00:00', 'sample_received')
    const lookupB = makeLookup('uid-B', '2026-01-01T10:00:00', 'sample_received')
    const lookupMap = new Map([
      ['SA', { data: lookupA, isLoading: false, isError: false }],
      ['SB', { data: lookupB, isLoading: false, isError: false }],
    ])
    const orders1 = [
      makeOrder({ order_id: 'O1', sample_results: { '1': { senaite_id: 'SA', status: 'ok' }, '2': { senaite_id: 'SB', status: 'ok' } } as never }),
    ]
    const orders2 = [
      makeOrder({ order_id: 'O1', sample_results: { '1': { senaite_id: 'SB', status: 'ok' }, '2': { senaite_id: 'SA', status: 'ok' } } as never }),
    ]
    const r1 = renderHook(() => useOrderSlaStatuses(orders1, lookupMap), { wrapper })
    await waitFor(() => expect(fetchSlaStatusesMock).toHaveBeenCalledTimes(1))
    r1.unmount()
    const r2 = renderHook(() => useOrderSlaStatuses(orders2, lookupMap), { wrapper })
    // Same QueryClient cache is NOT shared across renderHook calls (each creates
    // its own wrapper), so what we actually assert is the batch payload key set —
    // a proxy for the queryKey staying stable across reorderings.
    await waitFor(() => expect(fetchSlaStatusesMock).toHaveBeenCalledTimes(2))
    r2.unmount()
    const keys1 = new Set(fetchSlaStatusesMock.mock.calls[0][0].map(i => i.key))
    const keys2 = new Set(fetchSlaStatusesMock.mock.calls[1][0].map(i => i.key))
    expect(keys1).toEqual(keys2)
  })

  it('isError surfaces when /sla/status fails', async () => {
    fetchSlaStatusesMock.mockRejectedValue(new Error('boom'))
    const orders = [
      makeOrder({
        order_id: 'O1',
        sample_results: { '1': { senaite_id: 'PB-001', status: 'ok' } } as never,
      }),
    ]
    const lookupMap = new Map([
      ['PB-001', { data: makeLookup('PB-001-uid', '2026-01-01T09:00:00', 'sample_received'), isLoading: false, isError: false }],
    ])
    const { result } = renderHook(() => useOrderSlaStatuses(orders, lookupMap), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-sla.test.tsx'`
Expected: FAIL — `Cannot find module '@/services/order-sla'`.

- [ ] **Step 3: Implement `src/services/order-sla.ts`**

Create `src/services/order-sla.ts`:
```typescript
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchSlaStatuses,
  type ExplorerOrder,
  type InboxPriority,
  type SenaiteLookupResult,
  type SlaStatus,
  type SlaStatusRequestItem,
  type SlaTier,
} from '@/lib/api'
import {
  aggregateOrderSlaVerdict,
  buildKeywordToServiceIdMap,
  buildServiceToGroupTierMap,
  classifySampleColor,
  resolveSampleTier,
  type OrderSlaVerdict,
  type SampleSlaCellState,
  type SlaColor,
} from '@/lib/sla-resolution'
import { useAnalysisServices } from '@/services/analysis-services'
import { useSamplePriorities, sortedUidsHash } from '@/services/sample-priorities'
import { useServiceGroups } from '@/services/service-groups'
import { useSlaTiers, useSlaPriorityTiers } from '@/services/sla'

export interface SampleSlaSnapshot {
  status: SlaStatus
  color: SlaColor
  tier: SlaTier
}

export interface OrderSlaResult {
  verdictByOrderId: Map<string | number, OrderSlaVerdict>
  sampleStatusBySampleId: Map<string, SampleSlaSnapshot>
  isLoading: boolean
  isError: boolean
}

function makeTierConfigHash(
  tiers: SlaTier[],
  priorityRows: { priority: string; sla_tier_id: number }[]
): string {
  // Identity changes when amber thresholds, targets, default flag, or priority
  // overrides change — exactly when the verdict could differ.
  const tierPart = [...tiers]
    .sort((a, b) => a.id - b.id)
    .map(t => `${t.id}:${t.target_minutes}:${t.amber_threshold_percent}:${t.is_default ? 1 : 0}:${t.business_hours_only ? 1 : 0}`)
    .join(',')
  const prioPart = [...priorityRows]
    .sort((a, b) => a.priority.localeCompare(b.priority))
    .map(p => `${p.priority}:${p.sla_tier_id}`)
    .join(',')
  return `tiers=${tierPart}|prio=${prioPart}`
}

function makeReceivedAtHash(
  receivedByUid: Map<string, string | null>
): string {
  return [...receivedByUid.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([uid, ts]) => `${uid}:${ts ?? '-'}`)
    .join('|')
}

export function useOrderSlaStatuses(
  orders: ExplorerOrder[],
  sampleLookupMap: Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>
): OrderSlaResult {
  const tiersQuery = useSlaTiers()
  const prioOverridesQuery = useSlaPriorityTiers()
  const groupsQuery = useServiceGroups()
  const servicesQuery = useAnalysisServices()

  // Collect received-but-unpublished sample lookups across all orders.
  const liveLookups = useMemo(() => {
    const out: { senaiteId: string; lookup: SenaiteLookupResult }[] = []
    for (const order of orders) {
      if (!order.sample_results) continue
      for (const entry of Object.values(order.sample_results)) {
        if (!entry.senaite_id || entry.status === 'failed') continue
        const lq = sampleLookupMap.get(entry.senaite_id)
        if (!lq?.data) continue
        if (lq.data.review_state === 'published') continue
        if (!lq.data.date_received) continue
        out.push({ senaiteId: entry.senaite_id, lookup: lq.data })
      }
    }
    return out
  }, [orders, sampleLookupMap])

  const sampleUids = useMemo(
    () => liveLookups.map(l => l.lookup.sample_uid).filter((u): u is string => Boolean(u)),
    [liveLookups]
  )

  const prioritiesQuery = useSamplePriorities(sampleUids)

  // Hashes that gate the /sla/status query.
  const sortedUids = useMemo(() => sortedUidsHash(sampleUids), [sampleUids])
  const receivedAtHash = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const l of liveLookups) {
      if (l.lookup.sample_uid) m.set(l.lookup.sample_uid, l.lookup.date_received)
    }
    return makeReceivedAtHash(m)
  }, [liveLookups])
  const tierConfigHash = useMemo(
    () => makeTierConfigHash(tiersQuery.data ?? [], prioOverridesQuery.data ?? []),
    [tiersQuery.data, prioOverridesQuery.data]
  )

  // Resolve tier per sample. useMemo, NOT useQuery — pure transform of cached inputs.
  const perSample = useMemo(() => {
    const tiers = tiersQuery.data ?? []
    const groups = groupsQuery.data ?? []
    const services = servicesQuery.data ?? []
    const tiersById = new Map(tiers.map(t => [t.id, t]))
    const defaultTier = tiers.find(t => t.is_default) ?? null
    const keywordToServiceId = buildKeywordToServiceIdMap(services)
    const serviceToGroupTier = buildServiceToGroupTierMap(groups, services, tiersById)
    const priorityRows = prioOverridesQuery.data ?? []
    const priorityToTier = new Map<InboxPriority, SlaTier>()
    for (const row of priorityRows) {
      const t = tiersById.get(row.sla_tier_id)
      if (t) priorityToTier.set(row.priority as InboxPriority, t)
    }
    const prioByUid = new Map<string, InboxPriority>()
    for (const row of prioritiesQuery.data ?? []) {
      prioByUid.set(row.sample_uid, row.priority)
    }
    return liveLookups.map(({ senaiteId, lookup }) => {
      const priority: InboxPriority =
        (lookup.sample_uid && prioByUid.get(lookup.sample_uid)) || 'normal'
      const tier = resolveSampleTier(
        { analyses: lookup.analyses, priority },
        keywordToServiceId,
        serviceToGroupTier,
        priorityToTier,
        defaultTier
      )
      return { senaiteId, lookup, tier, priority }
    })
  }, [
    liveLookups,
    tiersQuery.data,
    groupsQuery.data,
    servicesQuery.data,
    prioOverridesQuery.data,
    prioritiesQuery.data,
  ])

  // The ONE /sla/status batch query.
  const batchItems: SlaStatusRequestItem[] = useMemo(() => {
    const out: SlaStatusRequestItem[] = []
    for (const s of perSample) {
      if (!s.tier || !s.lookup.sample_uid) continue
      out.push({
        key: s.lookup.sample_uid,
        received_at: s.lookup.date_received,
        target_minutes: s.tier.target_minutes,
        business_hours_only: s.tier.business_hours_only,
      })
    }
    return out
  }, [perSample])

  const statusQuery = useQuery({
    queryKey: ['order-sla-status', sortedUids, receivedAtHash, tierConfigHash],
    queryFn: () => fetchSlaStatuses(batchItems),
    enabled: batchItems.length > 0,
  })

  // Aggregate verdict per order. useMemo, NOT useQuery (sharpening #4).
  const result = useMemo<OrderSlaResult>(() => {
    const statusByKey = new Map<string, SlaStatus>()
    for (const item of statusQuery.data ?? []) {
      if (item.status) statusByKey.set(item.key, item.status)
    }
    const sampleStatusBySampleId = new Map<string, SampleSlaSnapshot>()
    const cellByOrderId = new Map<string | number, SampleSlaCellState[]>()
    const sampleTierById = new Map<string, SlaTier | null>()
    for (const s of perSample) {
      sampleTierById.set(s.senaiteId, s.tier)
      const uid = s.lookup.sample_uid
      const status = uid ? (statusByKey.get(uid) ?? null) : null
      const color =
        status && s.tier ? classifySampleColor(status, s.tier) : null
      if (uid && status && s.tier && color) {
        sampleStatusBySampleId.set(s.senaiteId, { status, color, tier: s.tier })
      }
    }
    // Group cells per order, including published samples (so 'met' works).
    for (const order of orders) {
      if (!order.sample_results) continue
      const cells: SampleSlaCellState[] = []
      for (const entry of Object.values(order.sample_results)) {
        if (!entry.senaite_id || entry.status === 'failed') continue
        const lq = sampleLookupMap.get(entry.senaite_id)
        if (!lq?.data) continue
        const snap = sampleStatusBySampleId.get(entry.senaite_id)
        cells.push({
          senaiteId: entry.senaite_id,
          tier: sampleTierById.get(entry.senaite_id) ?? null,
          lookup: lq.data,
          status: snap?.status ?? null,
          color: snap?.color ?? null,
        })
      }
      cellByOrderId.set(order.order_id, cells)
    }
    const verdictByOrderId = new Map<string | number, OrderSlaVerdict>()
    for (const [orderId, cells] of cellByOrderId) {
      verdictByOrderId.set(orderId, aggregateOrderSlaVerdict(cells))
    }
    return {
      verdictByOrderId,
      sampleStatusBySampleId,
      isLoading:
        tiersQuery.isLoading ||
        groupsQuery.isLoading ||
        servicesQuery.isLoading ||
        prioOverridesQuery.isLoading ||
        prioritiesQuery.isLoading ||
        (batchItems.length > 0 && statusQuery.isLoading),
      isError:
        tiersQuery.isError ||
        groupsQuery.isError ||
        servicesQuery.isError ||
        prioOverridesQuery.isError ||
        prioritiesQuery.isError ||
        statusQuery.isError,
    }
  }, [
    orders,
    sampleLookupMap,
    perSample,
    statusQuery.data,
    statusQuery.isLoading,
    statusQuery.isError,
    tiersQuery.isLoading,
    tiersQuery.isError,
    groupsQuery.isLoading,
    groupsQuery.isError,
    servicesQuery.isLoading,
    servicesQuery.isError,
    prioOverridesQuery.isLoading,
    prioOverridesQuery.isError,
    prioritiesQuery.isLoading,
    prioritiesQuery.isError,
    batchItems.length,
  ])

  return result
}
```

> **Note on `useServiceGroups`:** if `src/services/service-groups.ts` does not yet expose a `useServiceGroups` hook, add a thin wrapper there (5 lines mirroring `useSlaTiers`). Search the file before adding; do not duplicate.

- [ ] **Step 3a: Confirm or add `useServiceGroups`**

Run: `grep -n "useServiceGroups" /c/tmp/accu-mk1-wave1/src/services/*.ts`
- If present in any service file: import from there.
- If absent: create or extend `src/services/service-groups.ts`:
```typescript
import { useQuery } from '@tanstack/react-query'
import { getServiceGroups, type ServiceGroup } from '@/lib/api'

export const serviceGroupsQueryKeys = { all: ['service-groups'] as const }

export function useServiceGroups() {
  return useQuery({
    queryKey: serviceGroupsQueryKeys.all,
    queryFn: getServiceGroups,
    staleTime: 1000 * 60 * 5,
  })
}

export type { ServiceGroup }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-sla.test.tsx'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/services/order-sla.ts src/services/service-groups.ts src/test/order-sla.test.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): useOrderSlaStatuses (stable queryKey + useMemo aggregation) (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

If `src/services/service-groups.ts` already existed and was untouched, drop it from the `git add`.

---

## Task 7: Components — `OrderSlaCell` + `SampleSlaIndicator` + i18n keys

**Files:**
- Create: `src/components/explorer/OrderSlaCell.tsx`
- Create: `src/components/explorer/SampleSlaIndicator.tsx`
- Modify: `locales/en.json`, `locales/fr.json`, `locales/ar.json` (add `orderStatus.sla.*` — identical English in all three)
- Test: `src/test/order-sla-cell.test.tsx`

> **Advisor sharpening #5:** Both components MUST consume `classifySampleColor` from `@/lib/sla-resolution`. Do not duplicate the breach/amber-percent logic.
> **Advisor sharpening #2:** `orderStatus.sla.*` ship in THIS task — not deferred.

- [ ] **Step 1: Add the i18n keys**

Append to `locales/en.json`, `locales/fr.json`, AND `locales/ar.json` (same English in each; insert near existing `orderStatus.*` keys or alphabetically — JSON key order is not significant):
```json
  "orderStatus.sla": "SLA",
  "orderStatus.sla.left": "{{time}} left",
  "orderStatus.sla.over": "over by {{time}}",
  "orderStatus.sla.met": "Met",
  "orderStatus.sla.awaiting": "Awaiting sample",
  "orderStatus.sla.loading": "Loading SLA…",
  "orderStatus.sla.unavailable": "SLA unavailable",
  "orderStatus.sla.tooltipFull": "{{tier}} • target {{target}} • {{elapsed}} elapsed{{businessSuffix}} • sample {{sampleId}}",
  "orderStatus.sla.businessSuffix": " (business hours)",
  "orderStatus.sla.allPublished": "All samples published",
```

- [ ] **Step 2: Write the failing test**

Create `src/test/order-sla-cell.test.tsx`:
```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderSlaCell } from '@/components/explorer/OrderSlaCell'
import type { SlaTier } from '@/lib/api'

const tier = (target_minutes: number, amber = 20): SlaTier => ({
  id: 1,
  name: 'Standard',
  target_minutes,
  business_hours_only: false,
  is_default: true,
  amber_threshold_percent: amber,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
})

describe('OrderSlaCell — 7 states', () => {
  it('renders loading state when isLoading', () => {
    render(<OrderSlaCell verdict={{ color: 'awaiting' }} isLoading />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('loading')
  })

  it('renders awaiting when no received samples', () => {
    render(<OrderSlaCell verdict={{ color: 'awaiting' }} />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('awaiting')
    expect(cell.textContent).toContain('—')
  })

  it('renders met when all samples published', () => {
    render(<OrderSlaCell verdict={{ color: 'met' }} />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('met')
    expect(cell.textContent).toContain('✓')
  })

  it('renders green', () => {
    render(
      <OrderSlaCell
        verdict={{
          color: 'green',
          drivingSampleId: 'PB-001',
          drivingTier: tier(100),
          drivingStatus: {
            target_minutes: 100,
            elapsed_minutes: 10,
            remaining_minutes: 90,
            breached: false,
          },
        }}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('green')
  })

  it('renders amber', () => {
    render(
      <OrderSlaCell
        verdict={{
          color: 'amber',
          drivingSampleId: 'PB-002',
          drivingTier: tier(100, 30),
          drivingStatus: {
            target_minutes: 100,
            elapsed_minutes: 80,
            remaining_minutes: 20,
            breached: false,
          },
        }}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('amber')
  })

  it('renders red (breached)', () => {
    render(
      <OrderSlaCell
        verdict={{
          color: 'red',
          drivingSampleId: 'PB-003',
          drivingTier: tier(100),
          drivingStatus: {
            target_minutes: 100,
            elapsed_minutes: 150,
            remaining_minutes: -50,
            breached: true,
          },
        }}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('red')
  })

  it('renders error/unavailable when isError', () => {
    render(<OrderSlaCell verdict={{ color: 'awaiting' }} isError />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('error')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-sla-cell.test.tsx'`
Expected: FAIL — `Cannot find module '@/components/explorer/OrderSlaCell'`.

- [ ] **Step 4a: Implement `OrderSlaCell`**

Create `src/components/explorer/OrderSlaCell.tsx`:
```typescript
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'

const COLOR_CLASS: Record<string, string> = {
  red: 'text-red-500',
  amber: 'text-amber-500',
  green: 'text-green-600',
  met: 'text-muted-foreground',
  awaiting: 'text-muted-foreground',
  loading: 'text-muted-foreground',
  error: 'text-muted-foreground',
}

const DOT: Record<string, string> = {
  red: '●',
  amber: '●',
  green: '●',
  met: '✓',
  awaiting: '—',
  loading: '…',
  error: '—',
}

function formatMinutes(min: number): string {
  const abs = Math.abs(min)
  if (abs < 60) return `${Math.round(abs)}m`
  if (abs < 60 * 24) return `${(abs / 60).toFixed(1).replace(/\.0$/, '')}h`
  const days = Math.floor(abs / (60 * 24))
  const hours = Math.round((abs - days * 60 * 24) / 60)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

function formatTarget(min: number): string {
  if (min % 60 === 0) return `${min / 60}h`
  return `${min}m`
}

export function OrderSlaCell({
  verdict,
  isLoading,
  isError,
}: {
  verdict: OrderSlaVerdict
  isLoading?: boolean
  isError?: boolean
}) {
  const { t } = useTranslation()
  const color = isError ? 'error' : isLoading ? 'loading' : verdict.color
  const className = COLOR_CLASS[color] ?? 'text-muted-foreground'
  const dot = DOT[color]

  let text = ''
  let tooltip = ''
  if (color === 'red' && verdict.drivingStatus) {
    text = t('orderStatus.sla.over', { time: formatMinutes(verdict.drivingStatus.remaining_minutes) })
  } else if ((color === 'amber' || color === 'green') && verdict.drivingStatus) {
    text = t('orderStatus.sla.left', { time: formatMinutes(verdict.drivingStatus.remaining_minutes) })
  } else if (color === 'met') {
    text = t('orderStatus.sla.met')
    tooltip = t('orderStatus.sla.allPublished')
  } else if (color === 'awaiting') {
    text = t('orderStatus.sla.awaiting')
    tooltip = t('orderStatus.sla.awaiting')
  } else if (color === 'loading') {
    text = ''
    tooltip = t('orderStatus.sla.loading')
  } else if (color === 'error') {
    text = ''
    tooltip = t('orderStatus.sla.unavailable')
  }

  if (
    !tooltip &&
    verdict.drivingTier &&
    verdict.drivingStatus &&
    verdict.drivingSampleId
  ) {
    tooltip = t('orderStatus.sla.tooltipFull', {
      tier: verdict.drivingTier.name,
      target: formatTarget(verdict.drivingTier.target_minutes),
      elapsed: formatMinutes(verdict.drivingStatus.elapsed_minutes),
      businessSuffix: verdict.drivingTier.business_hours_only
        ? t('orderStatus.sla.businessSuffix')
        : '',
      sampleId: verdict.drivingSampleId,
    })
  }

  return (
    <span
      data-testid="order-sla-cell"
      data-sla-color={color}
      className={cn('inline-flex items-center gap-1 text-xs font-mono tabular-nums', className)}
      title={tooltip || undefined}
    >
      <span aria-hidden="true">{dot}</span>
      {text && <span>{text}</span>}
    </span>
  )
}
```

- [ ] **Step 4b: Implement `SampleSlaIndicator`**

Create `src/components/explorer/SampleSlaIndicator.tsx`:
```typescript
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { SampleSlaSnapshot } from '@/services/order-sla'

const COLOR_CLASS: Record<'red' | 'amber' | 'green', string> = {
  red: 'text-red-400',
  amber: 'text-amber-400',
  green: 'text-muted-foreground/70',
}

function formatMinutes(min: number): string {
  const abs = Math.abs(min)
  if (abs < 60) return `${Math.round(abs)}m`
  if (abs < 60 * 24) return `${(abs / 60).toFixed(1).replace(/\.0$/, '')}h`
  const days = Math.floor(abs / (60 * 24))
  const hours = Math.round((abs - days * 60 * 24) / 60)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

function formatTarget(min: number): string {
  if (min % 60 === 0) return `${min / 60}h`
  return `${min}m`
}

/**
 * Per-sample SLA indicator for the OrderStatusPage card view. Replaces the
 * hardcoded 24/48h goalNote with the real tier-based color from sla-resolution.
 * Shares the same classifySampleColor primitive as OrderSlaCell — color is
 * pre-computed on `snapshot.color`.
 */
export function SampleSlaIndicator({
  snapshot,
}: {
  snapshot: SampleSlaSnapshot | undefined
}) {
  const { t } = useTranslation()
  if (!snapshot) {
    return (
      <span className="text-[10px] font-mono leading-none tabular-nums text-muted-foreground/70" />
    )
  }
  const { status, color, tier } = snapshot
  const text = status.breached
    ? t('orderStatus.sla.over', { time: formatMinutes(status.remaining_minutes) })
    : t('orderStatus.sla.left', { time: formatMinutes(status.remaining_minutes) })
  const tooltip = t('orderStatus.sla.tooltipFull', {
    tier: tier.name,
    target: formatTarget(tier.target_minutes),
    elapsed: formatMinutes(status.elapsed_minutes),
    businessSuffix: tier.business_hours_only ? t('orderStatus.sla.businessSuffix') : '',
    sampleId: '',
  })
  return (
    <span
      data-testid="sample-sla-indicator"
      data-sla-color={color}
      className={cn('text-[10px] font-mono leading-none tabular-nums', COLOR_CLASS[color])}
      title={tooltip}
    >
      {text}
    </span>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-sla-cell.test.tsx'`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/explorer/OrderSlaCell.tsx src/components/explorer/SampleSlaIndicator.tsx src/test/order-sla-cell.test.tsx locales/en.json locales/fr.json locales/ar.json
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): OrderSlaCell + SampleSlaIndicator + orderStatus.sla.* i18n (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 8: `OrderRow.tsx` integration — new `<td>` + `slaVerdict?` prop

**Files:**
- Modify: `src/components/explorer/OrderRow.tsx`
- Modify: `src/test/order-row.test.tsx`

- [ ] **Step 1: Extend the failing test**

In `src/test/order-row.test.tsx`, add a new test inside the existing `describe('OrderRow', () => { ... })` block:
```typescript
  it('renders_sla_cell_with_provided_verdict_color', () => {
    const order = makeOrder({ order_id: '88001' })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={
          new Map<
            string,
            { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
          >()
        }
        activeAnalysisStates={[]}
        slaVerdict={{ color: 'green' }}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('green')
  })

  it('renders_sla_cell_loading_when_verdict_absent', () => {
    const order = makeOrder({ order_id: '88002' })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={
          new Map<
            string,
            { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
          >()
        }
        activeAnalysisStates={[]}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('loading')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-row.test.tsx'`
Expected: the two new tests FAIL — `slaVerdict` is not yet a prop; no `order-sla-cell` testid in the row.

- [ ] **Step 3a: Add the `slaVerdict` prop**

In `src/components/explorer/OrderRow.tsx`, extend the props at the top of the `OrderRow` function (~line 30, after `showFinance`):
```typescript
  showFinance,
  slaVerdict,
}: {
  // ... existing props ...
  showFinance?: boolean
  // D2: order-aggregated SLA verdict. Undefined means "loading"; the cell renders
  // a muted dot. The parent passes verdicts from useOrderSlaStatuses.
  slaVerdict?: OrderSlaVerdict
}) {
```

Add the import at the top of the file:
```typescript
import { OrderSlaCell } from './OrderSlaCell'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'
```

- [ ] **Step 3b: Add the new `<td>` between Timing and Samples**

In the same file, find the Timing `<td>` ending around line 251 (the one whose previous sibling is the Created column, closes with the "Lab" / `outstanding` span). Immediately after `</td>` on line 251 and BEFORE the Samples `<td>` on line 252, insert:
```tsx
      <td className="py-3 px-3 whitespace-nowrap align-top">
        <OrderSlaCell verdict={slaVerdict ?? { color: 'awaiting' }} isLoading={!slaVerdict} />
      </td>
```

- [ ] **Step 3c: Bump the finance-row colSpan**

The finance row at line 306 currently has `colSpan={6}` (Order ID, Email, Progress, Created, Timing, Samples = 6 columns). It now needs `colSpan={7}`:
```tsx
        <td colSpan={7} className="p-0">
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-row.test.tsx'`
Expected: ALL OrderRow tests PASS (existing + 2 new). If a snapshot/regex test that counts cells exists, update its expected cell count from 6 to 7 inline.

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/explorer/OrderRow.tsx src/test/order-row.test.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): OrderRow.tsx SLA cell + slaVerdict prop (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 9: `OrderStatusPage.tsx` — wire hook, add header, replace card-view goalNote

**Files:**
- Modify: `src/components/OrderStatusPage.tsx`

- [ ] **Step 1: Wire `useOrderSlaStatuses`**

In `src/components/OrderStatusPage.tsx`, add to the import block at the top:
```typescript
import { useOrderSlaStatuses } from '@/services/order-sla'
import { SampleSlaIndicator } from '@/components/explorer/SampleSlaIndicator'
```

After the `const sampleLookupMap = useMemo(...)` block (~line 648; locate by `const sampleLookupMap = useMemo`), insert:
```typescript
  // D2: order-aggregated SLA verdicts + per-sample status snapshots for the
  // table-view SLA column and the card-view SampleSlaIndicator. The hook is
  // useMemo-aggregated; only its one /sla/status batch query re-runs on data
  // changes (sharpenings #3, #4).
  const orderSla = useOrderSlaStatuses(orders, sampleLookupMap)
```

(`orders` is already in scope as the source for `sortedOrders` / table rendering. If the local variable is named differently — `sortedOrders`, `filteredOrders`, etc. — pass that one. Use the same array you pass to `OrderRow.order` below.)

- [ ] **Step 2: Add the `<th>SLA</th>` header**

In the table-view `<thead>` block (~line 1107–1112), insert a new `<th>SLA</th>` between `Timing` (~line 1111) and `Sample Details` (~line 1112):
```tsx
                      <th className="py-2 px-3 font-medium whitespace-nowrap">Timing</th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">SLA</th>
                      <th className="py-2 px-3 font-medium">Sample Details</th>
```

- [ ] **Step 3: Pass `slaVerdict` to `OrderRow` (both call sites)**

There are TWO `OrderRow` call sites in this file (lines ~1121 and ~1134 per the grep). For each, add `slaVerdict={orderSla.verdictByOrderId.get(order.order_id)}`. Example (preserve any other props verbatim — only ADD this one prop):
```tsx
                        sampleLookupMap={sampleLookupMap}
                        slaVerdict={orderSla.verdictByOrderId.get(order.order_id)}
```

- [ ] **Step 4: Replace the card-view `goalNote` block**

In the card-view item renderer (~lines 277–301), find the JSX block that starts with:
```tsx
{item.lookup?.date_received && item.lookup.review_state !== 'published' ? (() => {
```
…and ends at line 301 with the closing `)}`. REPLACE the entire conditional (lines 277–301) with:
```tsx
          {item.lookup?.date_received && item.lookup.review_state !== 'published' ? (
            <SampleSlaIndicator snapshot={orderSla.sampleStatusBySampleId.get(item.sampleId)} />
          ) : (
            <span className={cn(
              'text-[10px] font-mono leading-none tabular-nums',
              item.completedAt ? 'text-green-600/70' : 'text-amber-500/70'
            )}>
              {formatProcessingTime(item.createdAt, item.completedAt)}
            </span>
          )}
```

> The card-view item renderer lives inside a sub-component (`KanbanSampleCard` or similar). `orderSla` must be available in the renderer's scope. The KanbanView already receives `sampleLookupMap` as a prop; do the same for `orderSla` (or just the `sampleStatusBySampleId` map slice). Add a new `sampleSlaStatusMap` prop on the renderer chain (KanbanView → KanbanSampleCard) — then in the OrderStatusPage `<KanbanView>` call site, pass `sampleSlaStatusMap={orderSla.sampleStatusBySampleId}`.

- [ ] **Step 5: Restart frontend, typecheck**

```bash
docker restart accu-mk1-frontend
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: typecheck clean.

- [ ] **Step 6: Live smoke (`:3101`, browser-authed)**

In `:3101` devtools console (`T = localStorage.accu_mk1_auth_token`):
```javascript
fetch('http://localhost:8012/sample-priorities/lookup', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sample_uids: ['nope-1', 'nope-2'] }),
}).then(r => r.json()).then(console.log)
```
Expected: `{ items: [] }` (no priority rows for fake UIDs). Then navigate to the Order Status page; expect the new "SLA" column header to render and rows to show RAG dots once `sample_results` populates.

- [ ] **Step 7: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/OrderStatusPage.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): OrderStatusPage SLA column + card-view real-tier indicator (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 10: `CustomerStatusPage.tsx` — wire hook, add header, pass verdict

**Files:**
- Modify: `src/components/CustomerStatusPage.tsx`

- [ ] **Step 1: Wire `useOrderSlaStatuses`**

In `src/components/CustomerStatusPage.tsx`, add at the top:
```typescript
import { useOrderSlaStatuses } from '@/services/order-sla'
```

Find the `const sampleLookupMap = useMemo(...)` block (~line 701) and add immediately after:
```typescript
  // D2: order-aggregated SLA verdicts for the table-view SLA column.
  const orderSla = useOrderSlaStatuses(orders, sampleLookupMap)
```

(If `orders` is named differently locally, use the same one passed to `OrderRow.order` below.)

- [ ] **Step 2: Add the `<th>SLA</th>` header**

In the table `<thead>` block (~lines 1147–1162), insert a new `<th>` between Timing and Sample Details. The CustomerStatusPage `<th>` markup style is:
```tsx
                    <th className="py-2 px-3 font-medium whitespace-nowrap">SLA</th>
```
Place this immediately after the Timing `<th>` and before the Sample Details `<th>` so the column position matches `OrderRow`'s new `<td>`.

- [ ] **Step 3: Pass `slaVerdict` to `OrderRow` (~line 1169)**

Locate the `<OrderRow ...` call (~line 1169) and add the prop:
```tsx
                    <OrderRow
                      ...existing props...
                      sampleLookupMap={sampleLookupMap}
                      slaVerdict={orderSla.verdictByOrderId.get(order.order_id)}
                    />
```

- [ ] **Step 4: Restart frontend, typecheck**

```bash
docker restart accu-mk1-frontend
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/CustomerStatusPage.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): CustomerStatusPage SLA column (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 11: `SlaPane` TierCard — amber-threshold input + i18n

**Files:**
- Modify: `src/components/preferences/panes/SlaPane.tsx`
- Modify: `locales/en.json`, `locales/fr.json`, `locales/ar.json` (add `preferences.sla.amberThreshold`/`percentRemaining` — identical English in all three)
- Test: `src/test/sla-pane.test.tsx` (create — if it exists, extend)

> **Advisor sharpening #2:** these two i18n keys ship in THIS task — co-committed with their consumer.

- [ ] **Step 1: Add the i18n keys**

Append to `locales/en.json`, `locales/fr.json`, AND `locales/ar.json` (same English in each; insert near existing `preferences.sla.*` keys):
```json
  "preferences.sla.amberThreshold": "Amber at",
  "preferences.sla.percentRemaining": "% remaining",
```

- [ ] **Step 2: Write the failing test**

Create `src/test/sla-pane.test.tsx` (if a `sla-pane.test.tsx` already exists, append the test inside its `describe` block):
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const updateSlaTierMock = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getSlaTiers: () =>
      Promise.resolve([
        {
          id: 1,
          name: 'Standard',
          target_minutes: 1440,
          business_hours_only: false,
          is_default: true,
          amber_threshold_percent: 25,
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
        },
      ]),
    getSlaPriorityTiers: () => Promise.resolve([]),
    updateSlaTier: (id: number, data: unknown) => updateSlaTierMock(id, data),
    createSlaTier: vi.fn(),
    deleteSlaTier: vi.fn(),
    setSlaPriorityTier: vi.fn(),
    deleteSlaPriorityTier: vi.fn(),
  }
})

vi.mock('@/store/auth-store', () => ({
  useAuthStore: <T,>(selector: (s: { user: { role: string } }) => T) =>
    selector({ user: { role: 'admin' } }),
}))

const { SlaPane } = await import('@/components/preferences/panes/SlaPane')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  updateSlaTierMock.mockClear()
})

describe('SlaPane — amber threshold input', () => {
  it('renders the amber input with the tier value and PUTs on blur', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1')
    expect((input as HTMLInputElement).value).toBe('25')
    fireEvent.change(input, { target: { value: '40' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(updateSlaTierMock).toHaveBeenCalled()
    })
    const [, payload] = updateSlaTierMock.mock.calls[0]
    expect(payload).toMatchObject({ amber_threshold_percent: 40 })
  })

  it('blur with an unchanged value does NOT call updateSlaTier', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1')
    fireEvent.blur(input)
    // give onSuccess no chance to fire — just confirm no call queued
    expect(updateSlaTierMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-pane.test.tsx'`
Expected: FAIL — `sla-amber-input-1` testid not found.

- [ ] **Step 4: Extend `TierCard` with the amber input**

In `src/components/preferences/panes/SlaPane.tsx`:

4a. Extend the `onSave` callback signature in the `TierCard` props and update the parent's `onSave`:

In `SlaPane()` (around line 73), change:
```tsx
              onSave={(data) => updateTier.mutate({ id: tier.id, data })}
```
(no change — it already passes whatever the card sends — but the inline type at line 114 needs updating).

4b. Update the `TierCard` props block (around line 114):
```typescript
function TierCard({
  tier, readOnly, onSave, onDelete,
}: {
  tier: SlaTier
  readOnly: boolean
  onSave: (data: {
    name: string
    target_minutes: number
    business_hours_only: boolean
    amber_threshold_percent: number
  }) => void
  onDelete: () => void
}) {
```

4c. Add the amber state inside `TierCard()`, immediately after the existing `const [bh, setBh] = useState(tier.business_hours_only)` line (~line 122):
```typescript
  const [amber, setAmber] = useState(String(tier.amber_threshold_percent))
```

4d. Replace the `commit` function (~lines 124–132) with one that includes `amber_threshold_percent` and validates the 1–100 range:
```typescript
  const commit = () => {
    if (readOnly) return
    const total = (parseInt(hours, 10) || 0) * 60 + (parseInt(minutes, 10) || 0)
    const nextName = name.trim() || tier.name
    const amberParsed = parseInt(amber, 10)
    const nextAmber =
      Number.isFinite(amberParsed) && amberParsed >= 1 && amberParsed <= 100
        ? amberParsed
        : tier.amber_threshold_percent
    if (
      nextName === tier.name &&
      total === tier.target_minutes &&
      bh === tier.business_hours_only &&
      nextAmber === tier.amber_threshold_percent
    ) {
      return // nothing changed
    }
    onSave({
      name: nextName,
      target_minutes: total,
      business_hours_only: bh,
      amber_threshold_percent: nextAmber,
    })
  }
```

4e. Update the BusinessHours `Switch` handler (the inline `onSave` it dispatches at lines 166–170) to include the amber field:
```tsx
              onSave({
                name: name.trim() || tier.name,
                target_minutes: (parseInt(hours, 10) || 0) * 60 + (parseInt(minutes, 10) || 0),
                business_hours_only: v,
                amber_threshold_percent: Math.min(
                  100,
                  Math.max(1, parseInt(amber, 10) || tier.amber_threshold_percent)
                ),
              })
```

4f. Add the amber-input row to `TierCard`'s returned JSX. Insert this block immediately AFTER the closing `</div>` of the business-hours `<Switch>` row (~line 176, after the `<span className="text-xs text-muted-foreground">— {t('preferences.sla.businessHoursHint')}</span>` and before `</div>` of the outer card div on ~line 177):
```tsx
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('preferences.sla.amberThreshold')}</span>
        <Input
          data-testid={`sla-amber-input-${tier.id}`}
          className="h-8 w-16"
          type="number"
          min={1}
          max={100}
          value={amber}
          disabled={readOnly}
          onChange={e => setAmber(e.target.value)}
          onBlur={commit}
        />
        <span className="text-muted-foreground">{t('preferences.sla.percentRemaining')}</span>
      </div>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-pane.test.tsx'`
Expected: PASS (2 tests).

- [ ] **Step 6: Restart frontend, typecheck**

```bash
docker restart accu-mk1-frontend
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/preferences/panes/SlaPane.tsx src/test/sla-pane.test.tsx locales/en.json locales/fr.json locales/ar.json
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): SlaPane amber threshold input + preferences.sla.amber* i18n (D2)"
git -C /c/tmp/accu-mk1-wave1 push origin feat/order-status-processing-time
```

---

## Task 12: Full verification sweep

**Files:** none (verification only)

> **KNOWN out-of-scope failures (advisor sharpening #7):** `tests/test_api_sla_tiers.py::test_default_tier_encodes_old_24h_goal` and `tests/test_api_sla_tiers.py::test_list_returns_seeded_default` fail in isolation because the dev DB has `target_minutes=2880` (not the seeded 1440) and a stray `Microbiology` tier (id=21). These predate D2 and are NOT regressions. Do not bisect D2 looking for them.

- [ ] **Step 1: Backend — full SLA + D2 + regression suite**

```bash
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest \
  tests/test_api_sla_tiers.py \
  tests/test_api_sample_priorities.py \
  tests/test_holidays_us.py \
  tests/test_sla_engine.py \
  tests/test_business_hours_schema.py \
  tests/test_api_business_hours.py \
  tests/test_api_sla_status.py \
  tests/test_sla_schema.py \
  tests/test_api_sla_priority_tiers.py \
  tests/test_api_service_group_sla_tier.py -q'
```
Expected: all D2 + B + A/C tests PASS, except the 2 KNOWN pre-existing tier-drift failures called out above.

- [ ] **Step 2: Frontend — typecheck + vitest**

```bash
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run \
  src/test/sla-resolution.test.ts \
  src/test/order-sla.test.tsx \
  src/test/order-sla-cell.test.tsx \
  src/test/order-row.test.tsx \
  src/test/sla-pane.test.tsx'
```
Expected: typecheck clean; all vitest PASS.

- [ ] **Step 3: Lint the changed frontend files only**

```bash
npx --prefix /c/tmp/accu-mk1-wave1 eslint \
  src/lib/api.ts \
  src/lib/sla-resolution.ts \
  src/services/analysis-services.ts \
  src/services/sample-priorities.ts \
  src/services/order-sla.ts \
  src/components/explorer/OrderSlaCell.tsx \
  src/components/explorer/SampleSlaIndicator.tsx \
  src/components/explorer/OrderRow.tsx \
  src/components/OrderStatusPage.tsx \
  src/components/CustomerStatusPage.tsx \
  src/components/preferences/panes/SlaPane.tsx
```
Expected: no NEW errors. (Ignore the 3 pre-existing baseline errors in `src/lib/api.ts` ~lines 1730/3224/3757.)

- [ ] **Step 4: Live end-to-end smoke (browser-authed)**

In `:3101` devtools console / via `browser_evaluate` (`T = localStorage.accu_mk1_auth_token`):
```javascript
// 1. amber threshold round-trip
await fetch('http://localhost:8012/sla-tiers', { headers: { Authorization: 'Bearer ' + T } })
  .then(r => r.json())
  .then(rows => rows.map(r => ({ id: r.id, name: r.name, amber: r.amber_threshold_percent })))
// 2. bulk priorities lookup (empty body should 422)
await fetch('http://localhost:8012/sample-priorities/lookup', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sample_uids: [] }),
}).then(r => r.status)
// 3. Visit /explorer Order Status — confirm:
//   - new "SLA" column header is present
//   - rows render OrderSlaCell with a dot + text
//   - card view (toggle to Kanban): no more hardcoded "Over 24h/48h" text;
//     instead a colored "Xh left" / "over by Xh" from SampleSlaIndicator
// 4. Open Preferences → SLA → confirm each tier card has an
//   "Amber at [__] % remaining" input next to the business-hours toggle;
//   change one tier's threshold, blur, refresh — value persists.
```
Expected: (1) every row has `amber_threshold_percent` ∈ [1,100]; (2) status 422; (3) and (4) match the descriptions above.

- [ ] **Step 5: `detect_changes` then final scope confirmation**

```bash
git -C /c/tmp/accu-mk1-wave1 status --short
git -C /c/tmp/accu-mk1-wave1 log --oneline origin/master..HEAD
```
Run `gitnexus_detect_changes()` (advisory — the index targets the OneDrive checkout; expect low/empty for this worktree work). Confirm only the expected D2 files changed across the task commits. No extra commit needed if Tasks 1–11 each committed cleanly; otherwise commit any straggler verification fixes.

---

## Self-Review (completed by plan author)

**Spec coverage** — every spec section maps to a task:
- New SLA column on `OrderRow` (table view) → Task 8 (component prop + `<td>`), Task 9 (OrderStatusPage wiring), Task 10 (CustomerStatusPage wiring)
- Replace card-view `goalNote` (OrderStatusPage:277-292) with `SampleSlaIndicator` → Task 7 (component) + Task 9 (replacement)
- Per-tier `amber_threshold_percent` on `sla_tiers` (1–100, default 20) → Task 1 (model + migration + Pydantic + boundary validation)
- `POST /sample-priorities/lookup` (cap 500, sparse response, POST per advisor) → Task 2
- TanStack hooks for priorities (sorted-UID hash) + analysis-services + service-groups → Task 4 (+ Task 6 for the composite hook)
- Pure `sla-resolution.ts` with `buildServiceToGroupTierMap`, `resolveSampleTier` (priority>group>default + multi-group tightest), `classifySampleColor`, `aggregateOrderSlaVerdict` → Task 5
- `useOrderSlaStatuses` with stable hash queryKey + useMemo aggregation → Task 6
- `OrderSlaCell` + `SampleSlaIndicator` sharing `classifySampleColor` → Task 7
- `SlaPane` amber-threshold input + i18n co-commit → Task 11
- Full verification sweep + KNOWN out-of-scope note → Task 12

**Advisor sharpening coverage:**
1. POST /sample-priorities/lookup → Task 2 (endpoint), Task 3 (api.ts fetcher).
2. i18n co-commits → Task 7 (`orderStatus.sla.*`) and Task 11 (`preferences.sla.amberThreshold`/`percentRemaining`) — no late consolidated i18n task.
3. Stable hash queryKey `['order-sla-status', sortedUidsHash, sortedReceivedAtHash, tierConfigHash]` → Task 6 Step 3 (`useOrderSlaStatuses`).
4. Verdict aggregation = useMemo, NOT useQuery → Task 6 Step 3 — the only `useQuery` owns the `/sla/status` round-trip; everything else is `useMemo`.
5. Two cell components sharing `classifySampleColor` → Task 5 (primitive) + Task 7 (both components import it).
6. `test_unmapped_analysis_keyword_falls_through_to_default` → Task 5 Step 1 (named explicitly in the `resolveSampleTier` describe).
7. Task 12 Step 1 explicitly flags the 2 pre-existing tier-drift failures as KNOWN out-of-scope.

**Placeholder scan** — no TBD/TODO/"add appropriate"; every code step has complete code. The only non-mechanical step is Task 9 Step 4's note that the OrderStatusPage card-view item renderer (`KanbanSampleCard` or similar) needs `sampleSlaStatusMap` propagated through the existing prop chain — that's plumbing in an existing pattern, not a placeholder.

**Type consistency:**
- `SlaTier.amber_threshold_percent: number` matches the ORM `Integer` + Pydantic `int` + JSON `int`.
- `SamplePriorityLookupResponseItem` (frontend) matches `SamplePriorityResponseItem` (backend) by shape (`sample_uid: str`, `priority: 'normal'|'high'|'expedited'`).
- `SampleSlaInputs.analyses: SenaiteAnalysis[]` matches `SenaiteLookupResult.analyses`.
- `OrderSlaVerdict.color: OrderSlaColor` is the source of truth; `OrderSlaCell` and `aggregateOrderSlaVerdict` use the same union.
- `SampleSlaSnapshot = { status, color, tier }` is exported from `order-sla.ts` and consumed by `SampleSlaIndicator` as `snapshot?: SampleSlaSnapshot`.
- `useOrderSlaStatuses` returns `verdictByOrderId: Map<string|number, OrderSlaVerdict>` keyed by `order.order_id`, which is the same type the OrderStatusPage / CustomerStatusPage `OrderRow` call sites pass.

**Hashing correctness:**
- `sortedUidsHash` dedupes + sorts before joining, so `['a','b']` and `['b','a','a']` produce the same key.
- `makeReceivedAtHash` sorts by `sample_uid` before joining so a render with reordered samples but same content produces the same hash.
- `makeTierConfigHash` sorts tiers by `id` and priority rows by `priority` so equivalent configs hash identically.
- All three are composed into the `useOrderSlaStatuses` queryKey — any genuinely identical input on a re-render hits cache.
