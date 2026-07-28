# Registry-inspect full-log tab + parity convergence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the registry-inspect panel full transition/trajectory histories (log tab) and an on-demand full-payload parity scan powered by the existing `scripts/parity_sample_details.py` harness (parity tab).

**Architecture:** Two new admin-gated sync-`def` endpoints under the existing `/debug/sample-registry/{sample_id}` prefix — `/log` (pure DB, unlimited histories) and `/parity` (thin adapter over `compare_sample` + `fetch_pair_in_process`; the harness stays the only rule engine). The FE Sheet gains an `overview | log | parity` tab row; overview stays byte-for-byte today's content.

**Tech Stack:** FastAPI (sync routes, threadpool), SQLAlchemy, pytest; React + TypeScript, vitest, existing `apiFetch` client.

**Spec:** `docs/superpowers/specs/2026-07-27-registry-inspect-parity-convergence-design.md` (read it before starting your task).

## Global Constraints

- Work in `C:\tmp\Accu-Mk1-sidebyside` on branch `feat/side-by-side-workflow-engine` (grows PR #84). NEVER commit `package-lock.json` (pre-existing churn) or anything under `docs/superpowers/handoffs/`.
- Backend pytest interpreter (worktree has no venv): `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe`, run from `C:\tmp\Accu-Mk1-sidebyside\backend`.
- FE commands run from the worktree root `C:\tmp\Accu-Mk1-sidebyside` (npm only — never pnpm).
- Additive only: existing `/debug/sample-registry/{id}` + `/refresh` routes, `_build_shadow_block`, and the overview render path must not change behavior. The ONLY signature change allowed is `_build_sample_transitions` gaining `limit: int | None = 5` (default preserves today's behavior).
- Zero writes on the new endpoints. NO live SENAITE calls in any test.
- Never auto-fire the parity scan: only its explicit run button may call `/parity` (header refresh is a no-op / disabled on the parity tab).
- Classification vocabulary comes from the harness (`equal` / `known_expected` / real kinds `differing`,`mk1_only`,`senaite_only`); bucket by `is_real` + `classification == "known_expected"`, never by re-deriving rules.

---

### Task 1: Backend `GET /debug/sample-registry/{sample_id}/log`

**Files:**
- Modify: `backend/main.py` — `_build_sample_transitions` (~line 17977, add `limit` param); add `_build_shadow_trajectory` + route after `refresh_sample_registry_debug` (~line 18200)
- Test: `backend/tests/test_registry_debug_log.py` (new)

**Interfaces:**
- Consumes: `main._build_sample_transitions(db, row)` (existing), `models.LimsWorkflowShadowEvaluation` (columns: `lims_sample_pk, evaluated_at, trigger, verb, from_status, to_status, outcome, requirements_met, outcomes`).
- Produces: route `get_sample_registry_log(sample_id)` returning `{sample_id, exists, transitions: {rows, error, latest_to_status, log_in_sync, current_status}, trajectory: {rows: [{evaluated_at, trigger, verb, from_status, to_status, outcome, requirements_met, outcomes}], error}}` — Task 3's FE types mirror this exactly.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_registry_debug_log.py`. House pattern is the live-dev-DB idiom from `tests/test_registry_debug_transitions.py` (read its docstring first): `TestClient(main.app)` with only `require_admin` overridden, `SessionLocal()` seeding, TEST-prefixed ids, FK-safe cleanup.

```python
"""Registry-inspect /log endpoint: full transition + shadow-trajectory
histories (2026-07-27 parity-convergence spec). Live-dev-DB idiom from
test_registry_debug_transitions.py."""
from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

import main
from auth import require_admin
from database import SessionLocal
from models import LimsSample, LimsSampleTransition, LimsWorkflowShadowEvaluation

TEST_SAMPLE_ID = "TEST-RDLOG-PARENT"


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def client():
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[require_admin] = (
        lambda: SimpleNamespace(id=1, role="admin", email="admin@test"))
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


@pytest.fixture(autouse=True)
def cleanup(db):
    def _wipe():
        pk = db.execute(
            LimsSample.__table__.select().where(
                LimsSample.sample_id == TEST_SAMPLE_ID)
        ).first()
        if pk is not None:
            db.execute(delete(LimsWorkflowShadowEvaluation).where(
                LimsWorkflowShadowEvaluation.lims_sample_pk == pk.id))
            db.execute(delete(LimsSampleTransition).where(
                LimsSampleTransition.lims_sample_pk == pk.id))
            db.execute(delete(LimsSample).where(LimsSample.id == pk.id))
            db.commit()
    _wipe()
    yield
    _wipe()


def _seed_sample(db, status="verified") -> LimsSample:
    row = LimsSample(sample_id=TEST_SAMPLE_ID, status=status,
                     external_lims_system="senaite")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_log_returns_all_transitions_newest_first(client, db):
    row = _seed_sample(db)
    t0 = datetime(2026, 7, 1, 12, 0, 0)
    for i in range(7):  # > the overview's limit of 5
        db.add(LimsSampleTransition(
            lims_sample_pk=row.id, verb=f"v{i}", from_status="a",
            to_status="b", source="mk1", occurred_at=t0 + timedelta(hours=i)))
    db.commit()
    out = client.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").json()
    assert out["exists"] is True
    assert len(out["transitions"]["rows"]) == 7
    assert [r["verb"] for r in out["transitions"]["rows"]] == [
        "v6", "v5", "v4", "v3", "v2", "v1", "v0"]
    assert out["transitions"]["error"] is None


def test_log_trajectory_full_outcomes_met_and_unmet(client, db):
    row = _seed_sample(db)
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=row.id, evaluated_at=datetime(2026, 7, 2, 8, 0),
        trigger="receive", verb="receive", from_status="sample_due",
        to_status="sample_received", outcome="advanced", requirements_met=True,
        outcomes=[{"kind": "all_analyses_in_state", "value": "verified",
                   "met": True, "detail": None}]))
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=row.id, evaluated_at=datetime(2026, 7, 2, 9, 0),
        trigger="publish", verb="publish", from_status="sample_received",
        to_status=None, outcome="requirements_unmet", requirements_met=False,
        outcomes=[{"kind": "coa_published", "value": None,
                   "met": False, "detail": "no attestation"}]))
    db.commit()
    out = client.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").json()
    rows = out["trajectory"]["rows"]
    assert [r["trigger"] for r in rows] == ["publish", "receive"]  # newest first
    assert rows[1]["outcomes"][0]["met"] is True   # met rows included
    assert rows[0]["outcomes"][0]["met"] is False
    assert rows[0]["requirements_met"] is False
    assert out["trajectory"]["error"] is None


def test_log_unknown_sample_exists_false(client):
    out = client.get("/debug/sample-registry/TEST-RDLOG-NOPE/log").json()
    assert out["exists"] is False
    assert out["transitions"]["rows"] == []
    assert out["trajectory"]["rows"] == []


def test_log_admin_gate(db):
    tc = TestClient(main.app)  # no require_admin override
    assert tc.get(
        f"/debug/sample-registry/{TEST_SAMPLE_ID}/log").status_code in (401, 403)


def test_trajectory_query_exception_returns_error_surface(db):
    """Independent-failure posture: a DB error inside the trajectory block
    surfaces as trajectory.error, never an exception. Tightly-scoped patch
    (test_registry_debug_transitions.py idiom) so cleanup runs unpatched."""
    from unittest.mock import patch
    row = _seed_sample(db)
    with patch.object(db, "execute", side_effect=RuntimeError("boom")):
        out = main._build_shadow_trajectory(db, row)
    assert out["rows"] == [] and "boom" in out["error"]


def test_overview_transitions_still_capped_at_5(client, db):
    """The limit param must default to today's behavior on the overview route."""
    row = _seed_sample(db)
    t0 = datetime(2026, 7, 1, 12, 0, 0)
    for i in range(7):
        db.add(LimsSampleTransition(
            lims_sample_pk=row.id, verb=f"v{i}", from_status="a",
            to_status="b", source="mk1", occurred_at=t0 + timedelta(hours=i)))
    db.commit()
    tail = main._build_sample_transitions(db, row)
    assert len(tail["rows"]) == 5
```

NOTE for the implementer: check `LimsSample`'s NOT NULL columns before relying on `_seed_sample` (read the model + how `test_registry_debug_transitions.py` seeds); add any required fields there the same way that file does. Same for `LimsSampleTransition` (e.g. `occurred_at` may be required).

- [ ] **Step 2: Run tests to verify they fail**

Run from `C:\tmp\Accu-Mk1-sidebyside\backend`:
`<venv-python> -m pytest tests/test_registry_debug_log.py -q -p no:warnings`
Expected: FAIL — 404 (route missing) / assertion errors. `test_overview_transitions_still_capped_at_5` PASSES already (guards existing behavior).

- [ ] **Step 3: Implement**

In `backend/main.py`:

(a) `_build_sample_transitions` (~17977): change signature to
`def _build_sample_transitions(db: Session, row: LimsSample, limit: int | None = 5) -> dict:` and build the query as:

```python
        q = (
            select(LimsSampleTransition)
            .where(LimsSampleTransition.lims_sample_pk == row.id)
            .order_by(LimsSampleTransition.occurred_at.desc(), LimsSampleTransition.id.desc())
        )
        if limit is not None:
            q = q.limit(limit)
        rows = db.execute(q).scalars().all()
```

Do not touch the existing call site (`transitions = _build_sample_transitions(db, row)` keeps the 5-row default).

(b) Add after `refresh_sample_registry_debug`:

```python
def _build_shadow_trajectory(db: Session, row: LimsSample) -> dict:
    """Full side-by-side trajectory for the /log tab (2026-07-27 parity-
    convergence spec): every shadow evaluation, newest first, FULL outcomes
    list (met AND unmet — the overview block shows unmet-only). Same
    independent-failure posture as its siblings."""
    from models import LimsWorkflowShadowEvaluation as Ev
    try:
        rows = db.execute(
            select(Ev).where(Ev.lims_sample_pk == row.id)
            .order_by(Ev.evaluated_at.desc(), Ev.id.desc())
        ).scalars().all()
        return {
            "rows": [
                {
                    "evaluated_at": r.evaluated_at.isoformat(),
                    "trigger": r.trigger, "verb": r.verb,
                    "from_status": r.from_status, "to_status": r.to_status,
                    "outcome": r.outcome,
                    "requirements_met": r.requirements_met,
                    "outcomes": r.outcomes or [],
                }
                for r in rows
            ],
            "error": None,
        }
    except Exception as e:
        return {"rows": [], "error": str(e)}


@app.get("/debug/sample-registry/{sample_id}/log")
def get_sample_registry_log(
    sample_id: str,
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin forensic log — the /log tab's payload: ALL transitions + the
    full shadow trajectory. Pure DB, no SENAITE I/O, zero writes. Sync `def`
    for consistency with its siblings (threadpool; nothing blocking here
    but the panel's routes share one posture)."""
    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if row is None:
        return {
            "sample_id": sample_id, "exists": False,
            "transitions": {"rows": [], "error": None, "latest_to_status": None,
                            "log_in_sync": None, "current_status": None},
            "trajectory": {"rows": [], "error": None},
        }
    return {
        "sample_id": sample_id, "exists": True,
        "transitions": _build_sample_transitions(db, row, limit=None),
        "trajectory": _build_shadow_trajectory(db, row),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

`<venv-python> -m pytest tests/test_registry_debug_log.py -q -p no:warnings` → all pass.
Then the neighbors: `<venv-python> -m pytest tests/test_registry_debug_transitions.py tests/test_registry_debug.py tests/test_registry_debug_endpoint.py tests/test_registry_debug_analyses.py tests/test_workflow_shadow_touchpoints.py -q -p no:warnings` → no new failures.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_registry_debug_log.py
git commit -m "feat(sbs): /debug/sample-registry/{id}/log — full transition + shadow-trajectory histories"
```

---

### Task 2: Backend `GET /debug/sample-registry/{sample_id}/parity`

**Files:**
- Modify: `backend/main.py` — add route directly under `get_sample_registry_log` (Task 1)
- Test: `backend/tests/test_registry_debug_parity.py` (new)

**Interfaces:**
- Consumes: `scripts.parity_sample_details.fetch_pair_in_process(sample_id, db_factory) -> tuple[dict, dict]`, `compare_sample(mk1, senaite) -> list[FieldDiff]`, `FieldDiff(path, classification, rule_id=None, mk1_value=None, senaite_value=None)` with `.is_real`.
- Produces: route `get_sample_registry_parity(sample_id)` returning `{sample_id, fields: [{path, classification, rule_id, mk1_value, senaite_value, is_real}] (real → known_expected → equal, stable within buckets), summary: {total, equal, known_expected, real} | null, verdict: bool | null, error: str | null}` — Task 4's FE mirrors this.

- [ ] **Step 1: Write the failing tests**

```python
"""Registry-inspect /parity endpoint: thin adapter over
scripts.parity_sample_details (2026-07-27 parity-convergence spec).
NO live SENAITE: fetch_pair_in_process is always patched."""
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import main
from auth import require_admin
from scripts.parity_sample_details import FieldDiff

SAMPLE = "TEST-RDPAR-1"


@pytest.fixture
def client():
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[require_admin] = (
        lambda: SimpleNamespace(id=1, role="admin", email="admin@test"))
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


def test_parity_orders_real_then_known_then_equal(client):
    diffs = [
        FieldDiff("a_equal", "equal"),
        FieldDiff("b_known", "known_expected", "cached_at_timestamps", "x", "y"),
        FieldDiff("c_real", "differing", None, "1", "2"),
        FieldDiff("d_real2", "mk1_only", None, "v", None),
    ]
    with patch("scripts.parity_sample_details.fetch_pair_in_process",
               return_value=({}, {})), \
         patch("scripts.parity_sample_details.compare_sample",
               return_value=diffs):
        out = client.get(f"/debug/sample-registry/{SAMPLE}/parity").json()
    assert out["error"] is None
    assert [f["path"] for f in out["fields"]] == [
        "c_real", "d_real2", "b_known", "a_equal"]  # stable within buckets
    assert out["fields"][0]["is_real"] is True
    assert out["fields"][2]["rule_id"] == "cached_at_timestamps"
    assert out["summary"] == {"total": 4, "equal": 1,
                              "known_expected": 1, "real": 2}
    assert out["verdict"] is False


def test_parity_clean_verdict_true(client):
    with patch("scripts.parity_sample_details.fetch_pair_in_process",
               return_value=({}, {})), \
         patch("scripts.parity_sample_details.compare_sample",
               return_value=[FieldDiff("a", "equal")]):
        out = client.get(f"/debug/sample-registry/{SAMPLE}/parity").json()
    assert out["verdict"] is True and out["summary"]["real"] == 0


def test_parity_real_pipeline_smoke(client):
    """Real compare_sample over empty payloads: exercises the lazy import
    and the full adapter path with zero SENAITE."""
    with patch("scripts.parity_sample_details.fetch_pair_in_process",
               return_value=({}, {})):
        resp = client.get(f"/debug/sample-registry/{SAMPLE}/parity")
    out = resp.json()
    assert resp.status_code == 200
    assert out["error"] is None
    assert out["summary"]["total"] == len(out["fields"]) > 0


def test_parity_fetch_failure_is_error_payload_not_500(client):
    with patch("scripts.parity_sample_details.fetch_pair_in_process",
               side_effect=RuntimeError("SENAITE unreachable")):
        resp = client.get(f"/debug/sample-registry/{SAMPLE}/parity")
    assert resp.status_code == 200
    out = resp.json()
    assert "SENAITE unreachable" in out["error"]
    assert out["fields"] == [] and out["summary"] is None and out["verdict"] is None


def test_parity_admin_gate():
    tc = TestClient(main.app)
    assert tc.get(
        f"/debug/sample-registry/{SAMPLE}/parity").status_code in (401, 403)
```

- [ ] **Step 2: Run tests to verify they fail**

`<venv-python> -m pytest tests/test_registry_debug_parity.py -q -p no:warnings`
Expected: FAIL (404 route missing).

- [ ] **Step 3: Implement**

Add to `backend/main.py` directly under `get_sample_registry_log`:

```python
@app.get("/debug/sample-registry/{sample_id}/parity")
def get_sample_registry_parity(
    sample_id: str,
    admin=Depends(require_admin),
):
    """On-demand full-payload parity scan (2026-07-27 parity-convergence
    spec): thin adapter over scripts.parity_sample_details — the harness
    stays the ONLY rule engine. Heavyweight (live SENAITE fetches for this
    one sample) so it is button-fired from the panel, never auto-loaded.
    Zero writes: native side is a pure read builder; the senaite lookup's
    cache is an in-memory dict. No get_db dependency ON PURPOSE —
    fetch_pair_in_process opens/closes its own session, and holding a
    request session across seconds of SENAITE I/O would waste a pool slot.
    Sync `def`: fetch_pair_in_process's internal asyncio.run needs a thread
    with no running event loop (threadpool provides exactly that)."""
    from database import SessionLocal
    try:
        from scripts import parity_sample_details as parity
        mk1, senaite = parity.fetch_pair_in_process(sample_id, SessionLocal)
        diffs = parity.compare_sample(mk1, senaite)
    except Exception as e:
        return {"sample_id": sample_id, "fields": [], "summary": None,
                "verdict": None, "error": str(e)}

    def _bucket(d) -> int:
        if d.is_real:
            return 0
        return 1 if d.classification == "known_expected" else 2

    fields = [
        {"path": d.path, "classification": d.classification,
         "rule_id": d.rule_id, "mk1_value": d.mk1_value,
         "senaite_value": d.senaite_value, "is_real": d.is_real}
        for d in sorted(diffs, key=_bucket)  # sorted() is stable
    ]
    summary = {
        "total": len(fields),
        "equal": sum(1 for d in diffs if _bucket(d) == 2),
        "known_expected": sum(1 for d in diffs if _bucket(d) == 1),
        "real": sum(1 for d in diffs if d.is_real),
    }
    return {"sample_id": sample_id, "fields": fields, "summary": summary,
            "verdict": summary["real"] == 0, "error": None}
```

- [ ] **Step 4: Run tests to verify they pass**

`<venv-python> -m pytest tests/test_registry_debug_parity.py tests/test_registry_debug_log.py tests/test_parity_sample_details.py -q -p no:warnings` → all pass (last one guards the harness itself is untouched; if that filename doesn't exist, find the harness's test file via `grep -rl parity_sample_details tests/`).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_registry_debug_parity.py
git commit -m "feat(sbs): /debug/sample-registry/{id}/parity — on-demand harness-classified payload diff"
```

---

### Task 3: FE — API client, tab row, log tab

**Files:**
- Modify: `src/lib/api.ts` (new types + fetchers next to `getSampleRegistryDebug`, ~line 5196)
- Modify: `src/components/senaite/SampleRegistryDebug.tsx`
- Test: `src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 1's `/log` payload, existing `SampleTransitionsTail` type, `apiFetch`.
- Produces: `getSampleRegistryLog(sampleId): Promise<SampleRegistryLog>`; types `SampleRegistryLog`, `ShadowTrajectoryRow`; component tab state `'overview' | 'log' | 'parity'` with a rendered-but-inert `parity` tab button (Task 4 fills it; render `parity tab: coming in Task 4` placeholder text inside so Task 4's diff is contained).

- [ ] **Step 1: Write the failing tests**

Append to `SampleRegistryDebug.test.tsx` (reuse the file's existing `base`/`transitionsBase` fixtures and its `vi.spyOn(api, ...)` idiom — read the existing `beforeEach` first and mirror how `getSampleRegistryDebug` is spied):

```tsx
const logBase: api.SampleRegistryLog = {
  sample_id: 'P-1',
  exists: true,
  transitions: {
    rows: [
      { verb: 'publish', from_status: 'verified', to_status: 'published',
        source: 'senaite', occurred_at: '2026-07-11T09:00:00' },
      { verb: 'receive', from_status: 'sample_due', to_status: 'sample_received',
        source: 'mk1', occurred_at: '2026-07-10T12:00:00' },
    ],
    error: null, latest_to_status: 'published', log_in_sync: true,
    current_status: 'published',
  },
  trajectory: {
    rows: [
      { evaluated_at: '2026-07-11T09:00:01', trigger: 'publish', verb: 'publish',
        from_status: 'verified', to_status: 'published', outcome: 'advanced',
        requirements_met: true,
        outcomes: [{ kind: 'coa_published', value: null, met: true, detail: null }] },
    ],
    error: null,
  },
}

describe('log tab', () => {
  it('lazy-fetches /log on first activation only', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue(base)
    const logSpy = vi.spyOn(api, 'getSampleRegistryLog').mockResolvedValue(logBase)
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(api.getSampleRegistryDebug).toHaveBeenCalled())
    expect(logSpy).not.toHaveBeenCalled()          // overview default: no log fetch
    screen.getByText('log').click()
    await waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1))
    screen.getByText('overview').click()
    screen.getByText('log').click()
    expect(logSpy).toHaveBeenCalledTimes(1)        // cached per open
  })

  it('renders full transition history with source badges and trajectory rows', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue(base)
    vi.spyOn(api, 'getSampleRegistryLog').mockResolvedValue(logBase)
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(api.getSampleRegistryDebug).toHaveBeenCalled())
    screen.getByText('log').click()
    await waitFor(() => screen.getByText('publish'))
    expect(screen.getByText('senaite')).toBeTruthy()       // source badge
    expect(screen.getByText(/advanced/)).toBeTruthy()      // trajectory outcome
  })
})
```

(If the existing file uses `mockApi`-style module mocks instead of spies, follow the file's own idiom — the assertions stay the same.)

- [ ] **Step 2: Run tests to verify they fail**

From worktree root: `npx vitest run src/components/senaite/__tests__/SampleRegistryDebug.test.tsx`
Expected: FAIL — `getSampleRegistryLog` not exported / no `log` tab in DOM.

- [ ] **Step 3: Implement**

(a) `src/lib/api.ts`, directly under `refreshSampleRegistry`:

```ts
// 2026-07-27 parity-convergence spec: /log tab payload — full histories.
export interface ShadowTrajectoryRow {
  evaluated_at: string
  trigger: string
  verb: string | null
  from_status: string | null
  to_status: string | null
  outcome: string
  requirements_met: boolean | null
  outcomes: Array<{ kind: string; value: string | null; met: boolean; detail: string | null }>
}

export interface SampleRegistryLog {
  sample_id: string
  exists: boolean
  transitions: SampleTransitionsTail
  trajectory: { rows: ShadowTrajectoryRow[]; error: string | null }
}

export async function getSampleRegistryLog(sampleId: string): Promise<SampleRegistryLog> {
  return apiFetch<SampleRegistryLog>(
    `/debug/sample-registry/${encodeURIComponent(sampleId)}/log`)
}
```

(b) `SampleRegistryDebug.tsx`:
- New state: `const [tab, setTab] = useState<'overview' | 'log' | 'parity'>('overview')`, `logData/logLoading/logError`. In the existing `useEffect` on `[open, sampleId]`, also `setTab('overview')` and clear `logData` (reset per open).
- `loadLog()` mirroring `load()` but calling `getSampleRegistryLog`. Tab click handler for `log`: `setTab('log'); if (!logData && !logLoading) loadLog()`.
- Tab row right under the title-bar `<div>` (inside the `bg-[#0d0d0d]` body, above content), same button treatment as the source toggle:

```tsx
<div className="flex items-center gap-0.5 rounded border border-zinc-800 p-0.5 w-fit mb-2 shrink-0">
  {(['overview', 'log', 'parity'] as const).map(t => (
    <button key={t} onClick={() => selectTab(t)}
      className={cn('px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors',
        tab === t ? 'bg-emerald-600/30 text-emerald-300' : 'text-zinc-600 hover:text-zinc-300')}>
      {t}
    </button>
  ))}
</div>
```

- Wrap the ENTIRE existing two-column block in `{tab === 'overview' && (...)}` — zero changes inside it.
- Log tab content (`{tab === 'log' && (...)}`): loading spinner + error line idioms copied from overview; then two full-width sections:
  - transitions: header `─── transitions (all) ───` + the `log_in_sync` ✔/⚠ glyph (copy the overview's conditional block, reading from `logData.transitions`); rows as in the overview's transition tail BUT `new Date(t.occurred_at).toLocaleString()` (date + time) and `source` wrapped in a badge span: `mk1` → `text-emerald-400`, `senaite` → `text-sky-400`, `reconcile` → `text-amber-400`, `is_seed` → `text-zinc-500`, unknown → `text-zinc-500`.
  - trajectory: header `─── shadow trajectory ───`; per row line 1: `{trigger} · {verb ?? '—'} · {from_status ?? '∅'} → {to_status ?? '∅'} · {outcome} · reqs={String(requirements_met)}` with outcome colored (`advanced` `text-emerald-400`, `requirements_unmet` `text-amber-400`, else `text-zinc-500`) + `toLocaleString()` timestamp; a `▸/▾` toggle (per-row `expanded: Set<number>` state) revealing the outcomes list: `{met ? '✔' : '✖'} {kind}: {value ?? '∅'} {detail ?? ''}` (✔ `text-emerald-400`, ✖ `text-amber-400`).
- Parity tab button renders but its pane shows only `<div className="font-mono text-[11px] text-zinc-600">parity tab: coming in Task 4</div>`.
- Header refresh button becomes tab-aware: `onClick` → overview: `load()`; log: `loadLog()`; parity: no-op (`disabled={tab === 'parity'}`).

- [ ] **Step 4: Run tests + typecheck**

`npx vitest run src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` → all pass (existing 17 + new).
`npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/components/senaite/SampleRegistryDebug.tsx src/components/senaite/__tests__/SampleRegistryDebug.test.tsx
git commit -m "feat(sbs): registry-inspect tab row + full-history log tab"
```

---

### Task 4: FE — parity tab

**Files:**
- Modify: `src/lib/api.ts` (parity types + fetcher, under Task 3's additions)
- Modify: `src/components/senaite/SampleRegistryDebug.tsx` (replace the Task 3 placeholder pane)
- Test: `src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 2's `/parity` payload; Task 3's `tab` state and placeholder pane.
- Produces: `getSampleRegistryParity(sampleId): Promise<SampleParityResult>`; the finished parity pane.

- [ ] **Step 1: Write the failing tests**

```tsx
const parityBase: api.SampleParityResult = {
  sample_id: 'P-1',
  fields: [
    { path: 'analyses[PUR_KPV].result_unit', classification: 'differing',
      rule_id: null, mk1_value: 'mg/mL', senaite_value: 'text', is_real: true },
    { path: 'cached_at', classification: 'known_expected',
      rule_id: 'cached_at_timestamps', mk1_value: 'a', senaite_value: 'b', is_real: false },
    { path: 'client_name', classification: 'equal', rule_id: null,
      mk1_value: null, senaite_value: null, is_real: false },
  ],
  summary: { total: 3, equal: 1, known_expected: 1, real: 1 },
  verdict: false,
  error: null,
}

describe('parity tab', () => {
  it('never fetches on tab open; only the run button fires', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue(base)
    const paritySpy = vi.spyOn(api, 'getSampleRegistryParity').mockResolvedValue(parityBase)
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(api.getSampleRegistryDebug).toHaveBeenCalled())
    screen.getByText('parity').click()
    expect(paritySpy).not.toHaveBeenCalled()             // THE invariant
    screen.getByText(/run parity scan/i).click()
    await waitFor(() => expect(paritySpy).toHaveBeenCalledTimes(1))
    await waitFor(() => screen.getByText(/REAL DIFFS/i))
    expect(screen.getByText(/result_unit/)).toBeTruthy()          // real bucket
    expect(screen.getByText('cached_at_timestamps')).toBeTruthy() // rule tag
  })

  it('renders error payload as an error line', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue(base)
    vi.spyOn(api, 'getSampleRegistryParity').mockResolvedValue({
      sample_id: 'P-1', fields: [], summary: null, verdict: null,
      error: 'SENAITE unreachable',
    })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(api.getSampleRegistryDebug).toHaveBeenCalled())
    screen.getByText('parity').click()
    screen.getByText(/run parity scan/i).click()
    await waitFor(() => screen.getByText(/SENAITE unreachable/))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

`npx vitest run src/components/senaite/__tests__/SampleRegistryDebug.test.tsx`
Expected: FAIL — `getSampleRegistryParity` not exported / placeholder pane.

- [ ] **Step 3: Implement**

(a) `src/lib/api.ts`:

```ts
// 2026-07-27 parity-convergence spec: on-demand /parity scan. Classifications
// are the harness's vocabulary — equal / known_expected / differing /
// mk1_only / senaite_only; is_real mirrors FieldDiff.is_real.
export interface SampleParityField {
  path: string
  classification: string
  rule_id: string | null
  mk1_value: unknown
  senaite_value: unknown
  is_real: boolean
}

export interface SampleParityResult {
  sample_id: string
  fields: SampleParityField[]
  summary: { total: number; equal: number; known_expected: number; real: number } | null
  verdict: boolean | null
  error: string | null
}

export async function getSampleRegistryParity(sampleId: string): Promise<SampleParityResult> {
  return apiFetch<SampleParityResult>(
    `/debug/sample-registry/${encodeURIComponent(sampleId)}/parity`)
}
```

(b) `SampleRegistryDebug.tsx` — replace the Task 3 placeholder pane. State: `parityData/parityLoading/parityError` (cleared on the per-open reset alongside `logData`), plus `showEqual` boolean. `runParity()` mirrors `load()`. Pane:

- No result yet: explanation lines (font-mono, zinc): `compares the full mk1 vs senaite read-path payloads via the parity harness (16 known-expected rules)` and `hits live SENAITE for this one sample · takes a few seconds`; button `run parity scan` (same border/button treatment as the source toggle, amber accent).
- Loading: existing spinner idiom with `scanning {sampleId}...`.
- `parityData.error`: red error line (same class as overview's `senaite_error`).
- Result: summary header line: `` `total=${s.total} equal=${s.equal} known_expected=${s.known_expected} real=${s.real}` `` followed by verdict span — `verdict === true`: `✔ PASS — read paths agree` (`text-emerald-400`); `false`: `⚠ REAL DIFFS` (`text-red-400`). Then buckets in field order (already server-sorted):
  - `is_real` rows: red (`text-red-400` glyph `⚠`), `path` in `text-zinc-300`, then the overview field-diff two-line idiom: `reg {String(mk1_value)}` / `sen {String(senaite_value)}` (use the existing `val()` helper for objects/null).
  - `known_expected` rows: zinc, glyph `○`, path + `rule_id` in a bordered tag span (`border border-zinc-800 rounded px-1 text-zinc-500`), values on one dimmed line.
  - `equal` rows: hidden behind `▸ {summary.equal} equal fields` toggle (`showEqual`); expanded = one `✔ {path}` line each (`text-zinc-600`).
  - `re-run` button under the list (same styling as run).

- [ ] **Step 4: Run tests + typecheck**

`npx vitest run src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` → all pass.
`npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/components/senaite/SampleRegistryDebug.tsx src/components/senaite/__tests__/SampleRegistryDebug.test.tsx
git commit -m "feat(sbs): registry-inspect parity tab — button-fired harness scan"
```

---

### Task 5: Gates + push (controller-level; no code changes)

**Files:** none created; verification only.

- [ ] **Step 1: Feature suites**

From `C:\tmp\Accu-Mk1-sidebyside\backend`:
`<venv-python> -m pytest tests/test_registry_debug_log.py tests/test_registry_debug_parity.py tests/test_workflow_engine.py tests/test_workflow_shadow_summary.py tests/test_workflow_shadow_touchpoints.py tests/test_workflow_catalog_api.py tests/test_registry_debug_transitions.py tests/test_registry_debug_endpoint.py tests/test_registry_debug.py tests/test_registry_debug_analyses.py -q -p no:warnings` → 0 failures.

- [ ] **Step 2: FE gate**

From worktree root: `npx vitest run src/components/senaite/__tests__/SampleRegistryDebug.test.tsx` and `npx tsc --noEmit` → clean.

- [ ] **Step 3: Full-suite gate**

Branch run (worktree backend) vs master run (main checkout `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend`, detached @ `9ba3e79`), SAME venv, `-q -p no:warnings`; sorted `FAILED` names, `comm -23 branch master` → must be empty.

- [ ] **Step 4: Push (updates PR #84)**

```bash
git push origin feat/side-by-side-workflow-engine
```

Then comment on PR #84 summarizing the added slice + fresh gate evidence.
