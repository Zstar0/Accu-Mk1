# Vial Status Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only, department-scoped Vial Status Board (kanban + matrix table over sub-samples) at `#accumark-tools/vial-status`, backed by a new `GET /api/sub-samples/board` endpoint.

**Architecture:** New sync FastAPI route in the existing `backend/sub_samples/` package assembles the board from five bulk queries (no N+1) against the mk1 registry — stage truth comes from `lims_analyses.review_state` (the pure state machine), never the shadow workflow catalog. The frontend clones the Order Status shell (filters, kanban ⇄ table, localStorage persistence) and the Inbox's catalog-driven lane chips, with all placement/aggregation logic in a pure `src/lib/vial-board.ts` that unit-tests like `inbox-filters.ts`.

**Tech Stack:** FastAPI + SQLAlchemy (sync `def` routes) + Pydantic; React 19 + TypeScript + TanStack Query + Zustand + Tailwind v4; pytest (StaticPool SQLite) + vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-vial-status-board-design.md` — read it before starting any task. This plan implements it exactly; where the plan deviates (route sync-ness), the deviation is called out inline.

## Global Constraints

- Worktree: `C:\Projects\accumk1-vial-status-wt`, branch `feat/vial-status-board` (off `origin/master` @ `bdbcd352`). Never touch the main checkout at `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1`.
- **npm only** — never pnpm. Backend python: `backend/.venv/Scripts/python` (already provisioned in the worktree).
- **Additive only**: no changes to `/worksheets/inbox`, worksheets endpoints, the state machine, or the workflow shadow engine. No new tables, no migrations. The board writes nothing (read-only endpoint, no `db.commit()`).
- Stage truth = `lims_analyses.review_state` + `backend/lims_analyses/state_machine.py`. **Never read `lims_workflow_states`/`lims_workflow_transitions`.**
- **Routes are sync `def`, not `async def`** — deliberate deviation from spec §4's "async def": every route in `sub_samples/routes.py` is sync (runs in the threadpool), and an `async def` doing sync DB work would block the event loop.
- Current-row idiom: live analysis rows are `LimsAnalysis.retested.is_(False)` — **never** `retest_of_id IS NULL` (selects the superseded original after a retest; see `backend/main.py:19189-19192`).
- ast-grep gates (severity error): no `use*` exports from `src/lib/**`; no `useUIStore(selector)` inside `src/lib/**`; never destructure Zustand stores — selector syntax only (`useUIStore(state => state.x)`).
- ESLint runs `--max-warnings 0`; `react-refresh/only-export-components` means non-constant non-component exports must NOT live in `.tsx` files — helpers go in `src/lib/vial-board.ts`. Type imports are inline: `import { getX, type XRow } from '@/lib/api'`.
- Tailwind classes must be static string literals (Tailwind v4 scans source; no computed class names).
- UI strings: plain string literals (matching `OrderStatusPage.tsx` / `WorksheetsInboxPage.tsx`), not i18n `t()`.
- localStorage keys (spec §5): lane = `accu_mk1_vial_board_lane`, filter blob = `vial-board-filters`.
- Commit after every task, conventional style (`feat: …`, `test: …`), each ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Test gates are **failure-set diffs, never zero-failures**: frontend baseline (7 failures, listed in Task 9) and backend baseline (`backend/.baseline-pytest.txt` in the worktree). A task's own new tests must pass outright.
- GitNexus note: repo CLAUDE.md asks for impact analysis before editing symbols. The only existing-symbol edits here are additive insertions (union member, switch case, sidebar array entry, api.ts appends). If `mcp__gitnexus__impact` is reachable, run it on edited symbols; if not (worktree index may be stale), proceed — do not block.

---

### Task 1: Backend — board schemas, service core, route (inclusion rules)

**Files:**
- Modify: `backend/sub_samples/schemas.py` (append at end)
- Modify: `backend/sub_samples/service.py` (append at end)
- Modify: `backend/sub_samples/routes.py` (add route after the `list_sub_samples` route that ends near line 388)
- Create: `backend/tests/test_sub_samples_board.py`

**Interfaces:**
- Consumes: `models.LimsSubSample`, `models.LimsSample`, `models.LimsAnalysis`, `catalog.roles.inbox_lanes`.
- Produces (Task 2 and the frontend rely on these exact names):
  - `schemas.BoardWorksheetOut{id:int, title:str, status:str}`, `schemas.BoardAnalysisOut{id:int, title:str, review_state:str, analyst_user_id:Optional[int], analyst_name:Optional[str]}`, `schemas.BoardParentOut{id:int, sample_id:str, label:Optional[str], client_sample_id:Optional[str], priority:str="normal", is_test_order:bool=False}`, `schemas.BoardVialOut{id:int, sample_id:str, external_lims_uid:str, assignment_role:str, vial_sequence:int, received_at:datetime, parent:BoardParentOut, analyses:list[BoardAnalysisOut], worksheet:Optional[BoardWorksheetOut]=None}`, `schemas.VialBoardResponse{total:int, vials:list[BoardVialOut]}`
  - `service.BOARD_LIVE_STATES`, `service.UnknownLaneError(ValueError)`, `service.board_vials(db, *, hide_test_orders=True, show_xtra=False, lane=None) -> VialBoardResponse`
  - Route: `GET /api/sub-samples/board` (sync `def`, `response_model=VialBoardResponse`, params `hide_test_orders: bool = True`, `show_xtra: bool = False`, `lane: Optional[str] = None`)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_sub_samples_board.py`. Fixture harness is a direct clone of `backend/tests/test_worksheets_inbox_departments.py:55-183` (read that file first — it is the canonical pattern):

```python
"""GET /api/sub-samples/board — cross-order vial status board (spec
docs/superpowers/specs/2026-08-31-vial-status-board-design.md §4).

Hermetic: StaticPool SQLite + dependency_overrides; the test-order lookup
(main._test_order_senaite_ids) is monkeypatched per-test."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from main import app
from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    SamplePriority,
    User,
    VialRole,
    Worksheet,
    WorksheetItem,
)

DEPT_ANALYTICAL = 101
DEPT_MICRO = 102


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    _seed_catalog(session)
    yield session
    session.close()


@pytest.fixture
def client(db, monkeypatch):
    import main as main_module

    monkeypatch.setattr(main_module, "_test_order_senaite_ids", lambda: set())

    def _override_get_db():
        yield db

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
    try:
        yield TestClient(app)
    finally:
        if prev_db is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = prev_db
        if prev_user is None:
            app.dependency_overrides.pop(get_current_user, None)
        else:
            app.dependency_overrides[get_current_user] = prev_user


def _seed_catalog(db):
    db.add_all([
        Department(id=DEPT_ANALYTICAL, name="Analytical", color="blue", sort_order=1),
        Department(id=DEPT_MICRO, name="Microbiology", color="violet", sort_order=2),
    ])
    db.add_all([
        VialRole(code="hplc", label="HPLC", department_id=DEPT_ANALYTICAL, sort_order=1),
        VialRole(code="ster", label="Sterility", department_id=DEPT_MICRO, sort_order=2),
        VialRole(code="endo", label="Endotoxin", department_id=DEPT_MICRO, sort_order=3),
        VialRole(code="xtra", label="Extra", department_id=None, sort_order=9),
    ])
    svc = AnalysisService(title="Purity Hplc", keyword="PURITY", department_id=DEPT_ANALYTICAL)
    db.add(svc)
    db.commit()


def _svc(db):
    return db.query(AnalysisService).first()


def _parent(db, *, sid, uid=None, role="hplc", peptide=None):
    row = LimsSample(
        sample_id=sid,
        external_lims_uid=uid or f"uid-{sid}",
        status="sample_received",
        assignment_role=role,
        peptide_name=peptide,
    )
    db.add(row)
    db.flush()
    return row


def _vial(db, *, parent, seq=1, role="hplc"):
    row = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=f"uid-{parent.sample_id}-S{seq:02d}",
        sample_id=f"{parent.sample_id}-S{seq:02d}",
        vial_sequence=seq,
        assignment_role=role,
    )
    db.add(row)
    db.flush()
    return row


def _analysis(db, *, vial, state="unassigned", retested=False, analyst=None, title=None):
    svc = _svc(db)
    row = LimsAnalysis(
        lims_sub_sample_pk=vial.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=title or svc.title,
        review_state=state,
        retested=retested,
        analyst_user_id=analyst,
        provenance="canonical",
    )
    db.add(row)
    db.flush()
    return row


def _get_board(client, **params):
    resp = client.get("/api/sub-samples/board", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_mixed_state_vial_appears_with_full_analysis_list(client, db):
    """A vial with one live + one promoted + one rejected + one retracted
    analysis is on the board, and the payload carries ALL four rows (terminal
    columns render the vial's whole story while it is in flight — spec §4)."""
    p = _parent(db, sid="PB-9001", peptide="Semaglutide 5 mg")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="assigned")
    _analysis(db, vial=v, state="promoted")
    _analysis(db, vial=v, state="rejected")
    _analysis(db, vial=v, state="retracted")
    db.commit()

    body = _get_board(client)
    assert body["total"] == 1
    vial = body["vials"][0]
    assert vial["sample_id"] == "PB-9001-S01"
    assert vial["parent"]["sample_id"] == "PB-9001"
    assert vial["parent"]["label"] == "Semaglutide 5 mg"
    states = sorted(a["review_state"] for a in vial["analyses"])
    assert states == ["assigned", "promoted", "rejected", "retracted"]


def test_fully_promoted_vial_excluded(client, db):
    p = _parent(db, sid="PB-9002")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="promoted")
    _analysis(db, vial=v, state="variance_verified")
    db.commit()
    assert _get_board(client)["total"] == 0


def test_retracted_only_vial_excluded(client, db):
    p = _parent(db, sid="PB-9003")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="retracted")
    db.commit()
    assert _get_board(client)["total"] == 0


def test_superseded_retest_rows_do_not_include_or_surface(client, db):
    """A retested=True row in a live-looking state neither includes the vial
    nor appears in the payload (current-row idiom, main.py:19189)."""
    p = _parent(db, sid="PB-9004")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="assigned", retested=True)
    db.commit()
    assert _get_board(client)["total"] == 0

    _analysis(db, vial=v, state="to_be_verified")
    db.commit()
    body = _get_board(client)
    assert body["total"] == 1
    assert [a["review_state"] for a in body["vials"][0]["analyses"]] == ["to_be_verified"]


def test_null_role_excluded_and_xtra_gated_by_show_xtra(client, db):
    p = _parent(db, sid="PB-9005")
    v_null = _vial(db, parent=p, seq=1)
    v_null.assignment_role = None
    v_xtra = _vial(db, parent=p, seq=2, role="xtra")
    _analysis(db, vial=v_null, state="unassigned")
    _analysis(db, vial=v_xtra, state="unassigned")
    db.commit()

    assert _get_board(client)["total"] == 0
    body = _get_board(client, show_xtra="true")
    assert body["total"] == 1
    assert body["vials"][0]["assignment_role"] == "xtra"


def test_lane_filters_to_lane_role_codes(client, db):
    p = _parent(db, sid="PB-9006")
    v_hplc = _vial(db, parent=p, seq=1, role="hplc")
    v_endo = _vial(db, parent=p, seq=2, role="endo")
    _analysis(db, vial=v_hplc, state="assigned")
    _analysis(db, vial=v_endo, state="assigned")
    db.commit()

    body = _get_board(client, lane="microbiology")
    assert body["total"] == 1
    assert body["vials"][0]["assignment_role"] == "endo"


def test_unknown_lane_400(client, db):
    resp = client.get("/api/sub-samples/board", params={"lane": "nope"})
    assert resp.status_code == 400
    assert "nope" in resp.json()["detail"]


def test_vials_sorted_by_parent_then_sequence(client, db):
    p2 = _parent(db, sid="PB-9008")
    p1 = _parent(db, sid="PB-9007")
    vb = _vial(db, parent=p2, seq=1)
    va2 = _vial(db, parent=p1, seq=2)
    va1 = _vial(db, parent=p1, seq=1)
    for v in (vb, va2, va1):
        _analysis(db, vial=v, state="unassigned")
    db.commit()

    ids = [v["sample_id"] for v in _get_board(client)["vials"]]
    assert ids == ["PB-9007-S01", "PB-9007-S02", "PB-9008-S01"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `C:\Projects\accumk1-vial-status-wt\backend`):
`.venv/Scripts/python -m pytest tests/test_sub_samples_board.py -q`
Expected: every test FAILS with 404 (`assert resp.status_code == 200` → 404 Not Found) — the route doesn't exist yet.

- [ ] **Step 3: Implement schemas**

Append to `backend/sub_samples/schemas.py` (after the last class; module already imports `datetime`, `Optional`, `BaseModel`):

```python
# ── Vial Status Board (spec 2026-08-31) ─────────────────────────────────────


class BoardWorksheetOut(BaseModel):
    id: int
    title: str
    status: str


class BoardAnalysisOut(BaseModel):
    id: int
    title: str
    review_state: str
    analyst_user_id: Optional[int] = None
    analyst_name: Optional[str] = None


class BoardParentOut(BaseModel):
    id: int
    sample_id: str
    label: Optional[str] = None
    client_sample_id: Optional[str] = None
    priority: str = "normal"
    is_test_order: bool = False


class BoardVialOut(BaseModel):
    id: int
    sample_id: str
    external_lims_uid: str
    assignment_role: str
    vial_sequence: int
    received_at: datetime
    parent: BoardParentOut
    analyses: list[BoardAnalysisOut]
    worksheet: Optional[BoardWorksheetOut] = None


class VialBoardResponse(BaseModel):
    total: int
    vials: list[BoardVialOut]
```

- [ ] **Step 4: Implement service core**

Append to `backend/sub_samples/service.py`. Check the module's existing imports first — it already has `select`, `Session`, `Optional`, `log`; add missing model imports to the module-level import block (`LimsAnalysis` if absent) rather than importing inside functions. Task 1 implements selection + analyses + sorting; Task 2 fills in worksheets/analysts/priorities/test-orders (leave those fields at their defaults for now):

```python
# ── Vial Status Board (spec docs/superpowers/specs/2026-08-31-vial-status-board-design.md) ──

# A vial is ON the board while >=1 current (retested=False) vial-tier analysis
# sits in one of these states. This is the complement of the inbox's
# EXCLUDED_STATES (main.py:19203) restricted to the vial-tier lifecycle
# (lims_analyses/state_machine.py). Single source for the board's inclusion
# rule — the endpoint and tests both hang off this constant.
BOARD_LIVE_STATES = ("unassigned", "assigned", "to_be_verified")


class UnknownLaneError(ValueError):
    """Raised for a lane key not in the catalog lane set (route maps to 400)."""


def board_vials(
    db: Session,
    *,
    hide_test_orders: bool = True,
    show_xtra: bool = False,
    lane: Optional[str] = None,
):
    """Cross-order vial board: every vial with >=1 live vial-tier analysis,
    carrying ALL its current analyses so terminal columns can render a
    vial's whole story while it is in flight. Read-only; five bulk queries,
    no N+1 (spec §4). Multiple open worksheets for one vial: most recent
    added_at wins.
    """
    from sub_samples.schemas import (
        BoardAnalysisOut,
        BoardParentOut,
        BoardVialOut,
        BoardWorksheetOut,
        VialBoardResponse,
    )

    # Lane → allowed role codes (catalog-driven; unknown key = 400 upstream).
    allowed_roles: Optional[set] = None
    if lane is not None:
        from catalog.roles import inbox_lanes

        lanes = inbox_lanes(db)
        if lane not in lanes:
            raise UnknownLaneError(
                f"Invalid lane: {lane!r}. Expected one of {sorted(lanes)} or omit."
            )
        allowed_roles = set(lanes[lane].role_codes)
        if show_xtra:
            allowed_roles.add("xtra")

    # Query 1: candidate vials + parents via live vial-tier analyses.
    live_vial_pks = (
        select(LimsAnalysis.lims_sub_sample_pk)
        .where(LimsAnalysis.lims_sub_sample_pk.isnot(None))
        .where(LimsAnalysis.retested.is_(False))
        .where(LimsAnalysis.review_state.in_(BOARD_LIVE_STATES))
        .distinct()
    )
    pairs = db.execute(
        select(LimsSubSample, LimsSample)
        .join(LimsSample, LimsSample.id == LimsSubSample.parent_sample_pk)
        .where(LimsSubSample.id.in_(live_vial_pks))
        .where(LimsSubSample.assignment_role.isnot(None))
    ).all()

    def _role_ok(code: str) -> bool:
        if allowed_roles is not None:
            return code in allowed_roles
        if code == "xtra":
            return show_xtra
        return True

    pairs = [(sub, par) for sub, par in pairs if _role_ok(sub.assignment_role)]

    # Task 2 fills in: test-order filtering, worksheets, analysts, priorities.
    test_ids: set = set()
    ws_by_uid: dict = {}
    analyst_name_by_id: dict = {}
    priority_by_uid: dict = {}

    vial_pks = [sub.id for sub, _ in pairs]

    # Query 2: ALL current vial-tier analyses for the included vials.
    analyses_by_vial: dict = {}
    if vial_pks:
        for row in (
            db.execute(
                select(LimsAnalysis)
                .where(LimsAnalysis.lims_sub_sample_pk.in_(vial_pks))
                .where(LimsAnalysis.retested.is_(False))
                .order_by(LimsAnalysis.id)
            )
            .scalars()
            .all()
        ):
            analyses_by_vial.setdefault(row.lims_sub_sample_pk, []).append(row)

    out = []
    for sub, par in pairs:
        out.append(
            BoardVialOut(
                id=sub.id,
                sample_id=sub.sample_id,
                external_lims_uid=sub.external_lims_uid,
                assignment_role=sub.assignment_role,
                vial_sequence=sub.vial_sequence,
                received_at=sub.received_at,
                parent=BoardParentOut(
                    id=par.id,
                    sample_id=par.sample_id,
                    label=par.peptide_name,
                    client_sample_id=par.client_sample_id,
                    priority=priority_by_uid.get(par.external_lims_uid or "", "normal"),
                    is_test_order=par.sample_id in test_ids,
                ),
                analyses=[
                    BoardAnalysisOut(
                        id=a.id,
                        title=a.title or a.keyword or "",
                        review_state=a.review_state,
                        analyst_user_id=a.analyst_user_id,
                        analyst_name=analyst_name_by_id.get(a.analyst_user_id),
                    )
                    for a in analyses_by_vial.get(sub.id, [])
                ],
                worksheet=ws_by_uid.get(sub.external_lims_uid),
            )
        )

    out.sort(key=lambda v: (v.parent.sample_id, v.vial_sequence))

    if len(out) > 2000:
        log.warning("sub_samples.board_large_result count=%s", len(out))

    return VialBoardResponse(total=len(out), vials=out)
```

Analysis title rule is the inbox's: `a.title or a.keyword or ""` (`main.py:19224`). `label` = `LimsSample.peptide_name` (the parent display field the inbox exposes).

- [ ] **Step 5: Implement the route**

In `backend/sub_samples/routes.py`, add after the `list_sub_samples` route (which ends around line 388). Import additions at the top of the file: add `VialBoardResponse` to the existing `from sub_samples.schemas import (...)` block, and `Optional` is already available (check the file's typing imports; add if missing):

```python
@router.get("/board", response_model=VialBoardResponse)
def get_vial_board(
    hide_test_orders: bool = True,
    show_xtra: bool = False,
    lane: Optional[str] = None,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Cross-order Vial Status Board (spec 2026-08-31 §4).

    A vial is included while >=1 current vial-tier analysis is in
    unassigned/assigned/to_be_verified; the payload carries ALL its current
    analyses. Multiple open worksheets claiming one vial: most recent
    added_at wins. Read-only.
    """
    try:
        return service.board_vials(
            db,
            hide_test_orders=hide_test_orders,
            show_xtra=show_xtra,
            lane=lane,
        )
    except service.UnknownLaneError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_sub_samples_board.py -q`
Expected: all 8 tests PASS.

- [ ] **Step 7: Sanity-run neighbors**

Run: `.venv/Scripts/python -m pytest tests/test_sub_samples_routes.py tests/test_worksheets_inbox_departments.py -q`
Expected: same result as before your change (the routes file has 1 known-stale failure at baseline — `test_list_sub_samples_with_children`; see `backend/.baseline-pytest.txt`). Zero net-new failures.

- [ ] **Step 8: Commit**

```bash
git add backend/sub_samples/schemas.py backend/sub_samples/service.py backend/sub_samples/routes.py backend/tests/test_sub_samples_board.py
git commit -m "feat(board): sub-samples board endpoint core — live-state inclusion, full analysis payload"
```

---

### Task 2: Backend — enrichment (worksheets, analysts, priorities, test orders)

**Files:**
- Modify: `backend/sub_samples/service.py` (the `board_vials` function + one new helper)
- Modify: `backend/tests/test_sub_samples_board.py` (append tests)

**Interfaces:**
- Consumes: Task 1's `board_vials` skeleton (the four placeholder dicts: `test_ids`, `ws_by_uid`, `analyst_name_by_id`, `priority_by_uid`).
- Produces: fully-populated `worksheet`, `analyst_name`, `parent.priority`, `parent.is_test_order` fields; `hide_test_orders` filtering. New helper `service._board_test_order_sample_ids() -> set[str]`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_sub_samples_board.py`:

```python
def _worksheet(db, *, title, status="open", analyst=None):
    ws = Worksheet(title=title, status=status, assigned_analyst_id=analyst)
    db.add(ws)
    db.flush()
    return ws


def _claim(db, *, ws, vial, added_at=None):
    item = WorksheetItem(
        worksheet_id=ws.id,
        sample_uid=vial.external_lims_uid,
        sample_id=vial.sample_id,
    )
    if added_at is not None:
        item.added_at = added_at
    db.add(item)
    db.flush()
    return item


def test_worksheet_join_open_most_recent_wins(client, db):
    from datetime import datetime

    p = _parent(db, sid="PB-9101")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="assigned")

    ws_old = _worksheet(db, title="WS-2026-08-01-001")
    ws_new = _worksheet(db, title="WS-2026-08-29-043")
    ws_done = _worksheet(db, title="WS-DONE", status="completed")
    ws_cancelled = _worksheet(db, title="WS-CXL", status="cancelled")
    _claim(db, ws=ws_old, vial=v, added_at=datetime(2026, 8, 1, 9, 0))
    _claim(db, ws=ws_new, vial=v, added_at=datetime(2026, 8, 29, 9, 0))
    _claim(db, ws=ws_done, vial=v, added_at=datetime(2026, 8, 30, 9, 0))
    _claim(db, ws=ws_cancelled, vial=v, added_at=datetime(2026, 8, 31, 9, 0))
    db.commit()

    vial = _get_board(client)["vials"][0]
    assert vial["worksheet"]["title"] == "WS-2026-08-29-043"
    assert vial["worksheet"]["status"] == "open"


def test_vial_on_no_worksheet_returns_null(client, db):
    p = _parent(db, sid="PB-9102")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="unassigned")
    db.commit()
    assert _get_board(client)["vials"][0]["worksheet"] is None


def test_analyst_names_follow_display_rule(client, db):
    """First+Last when set; email fallback (backend/users_display.py)."""
    named = User(id=7, email="jchen@accumark.test", hashed_password="x",
                 first_name="J.", last_name="Chen")
    bare = User(id=8, email="bare@accumark.test", hashed_password="x")
    db.add_all([named, bare])
    p = _parent(db, sid="PB-9103")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="assigned", analyst=7)
    _analysis(db, vial=v, state="assigned", analyst=8)
    _analysis(db, vial=v, state="unassigned")
    db.commit()

    by_id = {a["analyst_user_id"]: a["analyst_name"]
             for a in _get_board(client)["vials"][0]["analyses"]}
    assert by_id[7] == "J. Chen"
    assert by_id[8] == "bare@accumark.test"
    assert by_id[None] is None


def test_priority_from_sample_priorities_default_normal(client, db):
    p_hi = _parent(db, sid="PB-9104", uid="uid-PB-9104")
    p_norm = _parent(db, sid="PB-9105")
    db.add(SamplePriority(sample_uid="uid-PB-9104", priority="expedited"))
    for p in (p_hi, p_norm):
        v = _vial(db, parent=p)
        _analysis(db, vial=v, state="unassigned")
    db.commit()

    by_parent = {v["parent"]["sample_id"]: v["parent"]["priority"]
                 for v in _get_board(client)["vials"]}
    assert by_parent["PB-9104"] == "expedited"
    assert by_parent["PB-9105"] == "normal"


def test_hide_test_orders_gating(client, db, monkeypatch):
    import sub_samples.service as svc_module

    p_test = _parent(db, sid="PB-9106")
    p_real = _parent(db, sid="PB-9107")
    for p in (p_test, p_real):
        v = _vial(db, parent=p)
        _analysis(db, vial=v, state="unassigned")
    db.commit()

    monkeypatch.setattr(
        svc_module, "_board_test_order_sample_ids", lambda: {"PB-9106"}
    )

    body = _get_board(client)  # hide_test_orders defaults true
    assert body["total"] == 1
    assert body["vials"][0]["parent"]["sample_id"] == "PB-9107"

    body = _get_board(client, hide_test_orders="false")
    assert body["total"] == 2
    flags = {v["parent"]["sample_id"]: v["parent"]["is_test_order"]
             for v in body["vials"]}
    assert flags == {"PB-9106": True, "PB-9107": False}
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `.venv/Scripts/python -m pytest tests/test_sub_samples_board.py -q`
Expected: Task 1's 8 tests still PASS; the 5 new ones FAIL (worksheet is null, analyst_name is None, priority "normal" everywhere, no test-order gating).

- [ ] **Step 3: Implement enrichment**

In `backend/sub_samples/service.py`:

(a) Add the test-order helper above `board_vials` (deferred import — `main` imports this package at startup, so a module-level import would be circular):

```python
def _board_test_order_sample_ids() -> set:
    """Parent sample_ids belonging to TEST_EMAILS orders. Wraps
    main._test_order_senaite_ids (main.py:9732) via deferred import; empty
    set on any failure (graceful degradation, inbox precedent)."""
    try:
        from main import _test_order_senaite_ids

        return _test_order_senaite_ids()
    except Exception:
        return set()
```

(b) Inside `board_vials`, replace the four placeholder dicts with real queries. Model imports needed at module top: `SamplePriority`, `User`, `Worksheet`, `WorksheetItem` (add to the existing `from models import (...)` block if absent), plus `from users_display import user_display_name` if the module doesn't already import it:

```python
    # Test orders: filter (hide_test_orders) or stamp (is_test_order).
    test_ids = _board_test_order_sample_ids()
    if hide_test_orders and test_ids:
        pairs = [(sub, par) for sub, par in pairs if par.sample_id not in test_ids]

    vial_pks = [sub.id for sub, _ in pairs]
    vial_uids = [sub.external_lims_uid for sub, _ in pairs]
    parent_uids = {par.external_lims_uid for _, par in pairs if par.external_lims_uid}

    # Query 3: open worksheets claiming these vials. Ascending added_at so the
    # dict's last write wins == most recent claim (endpoint docstring rule).
    ws_by_uid = {}
    if vial_uids:
        for uid, _added_at, ws in db.execute(
            select(WorksheetItem.sample_uid, WorksheetItem.added_at, Worksheet)
            .join(Worksheet, Worksheet.id == WorksheetItem.worksheet_id)
            .where(Worksheet.status == "open")
            .where(WorksheetItem.sample_uid.in_(vial_uids))
            .order_by(WorksheetItem.added_at)
        ).all():
            ws_by_uid[uid] = BoardWorksheetOut(id=ws.id, title=ws.title, status=ws.status)

    # Query 5: priorities keyed on the parent's external uid; missing = normal.
    priority_by_uid = {}
    if parent_uids:
        priority_by_uid = {
            row.sample_uid: row.priority
            for row in db.execute(
                select(SamplePriority).where(SamplePriority.sample_uid.in_(parent_uids))
            ).scalars()
        }
```

Note `BoardWorksheetOut` is already in the function's deferred schema import from Task 1.

(c) The analyst-name map goes AFTER Query 2 (it needs the analysis rows). Move the `analyst_name_by_id = {}` placeholder below the `analyses_by_vial` loop and replace it (batched IN-query — mirrors `lims_analyses/service.py:3346-3359`):

```python
    # Query 4: analyst display names, batched (users_display rule).
    analyst_ids = {
        a.analyst_user_id
        for rows in analyses_by_vial.values()
        for a in rows
        if a.analyst_user_id
    }
    analyst_name_by_id = {}
    if analyst_ids:
        analyst_name_by_id = {
            u.id: user_display_name(u)
            for u in db.execute(select(User).where(User.id.in_(analyst_ids))).scalars()
        }
```

Keep the query order inside the function: Query 1 (pairs) → test-order filter → Query 3 (worksheets) → Query 5 (priorities) → Query 2 (analyses) → Query 4 (analysts) → assembly. The assembly loop from Task 1 already consumes all four maps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_sub_samples_board.py -q`
Expected: all 13 tests PASS.

- [ ] **Step 5: Lint-adjacent sanity + full board file re-run**

Run: `.venv/Scripts/python -m pytest tests/test_sub_samples_board.py tests/test_sub_samples_routes.py tests/test_sub_samples_service.py -q`
Expected: board file all green; the other two match their baseline failure sets (`backend/.baseline-pytest.txt`).

- [ ] **Step 6: Commit**

```bash
git add backend/sub_samples/service.py backend/tests/test_sub_samples_board.py
git commit -m "feat(board): enrich board payload — worksheets, analyst names, priorities, test-order gating"
```

---

### Task 3: Frontend — API types, `getVialBoard`, `useVialBoard` hook

**Files:**
- Modify: `src/lib/api.ts` (append near the vial-roles section, after line ~5250)
- Create: `src/services/vial-board.ts`

**Interfaces:**
- Consumes: `apiFetch` (`api.ts:33`), `InboxPriority` type (already exported from `api.ts`; grep `export type InboxPriority` to confirm exact name before using).
- Produces (Tasks 4/6/7/8 import these exact names):
  - From `@/lib/api`: `BoardWorksheet{id,title,status}`, `BoardAnalysis{id,title,review_state,analyst_user_id,analyst_name}`, `BoardParent{id,sample_id,label,client_sample_id,priority,is_test_order}`, `BoardVial{id,sample_id,external_lims_uid,assignment_role,vial_sequence,received_at,parent,analyses,worksheet}`, `VialBoardResponse{total,vials}`, `getVialBoard(opts: {hideTestOrders: boolean; showXtra: boolean}): Promise<VialBoardResponse>`
  - From `@/services/vial-board`: `vialBoardQueryKeys`, `useVialBoard(params: {hideTestOrders: boolean; showXtra: boolean})`

- [ ] **Step 1: Append to `src/lib/api.ts`**

```ts
// ─── Vial Status Board ──────────────────────────────────────────────────────
// GET /api/sub-samples/board (spec docs/superpowers/specs/
// 2026-08-31-vial-status-board-design.md §4). Read-only cross-order vial
// board; a vial is present while >=1 current vial-tier analysis is live
// (unassigned/assigned/to_be_verified) and carries ALL its current analyses.

export interface BoardWorksheet {
  id: number
  title: string
  status: string
}

export interface BoardAnalysis {
  id: number
  title: string
  review_state: string
  analyst_user_id: number | null
  analyst_name: string | null
}

export interface BoardParent {
  id: number
  sample_id: string
  label: string | null
  client_sample_id: string | null
  priority: InboxPriority
  is_test_order: boolean
}

export interface BoardVial {
  id: number
  sample_id: string
  external_lims_uid: string
  assignment_role: string
  vial_sequence: number
  received_at: string
  parent: BoardParent
  analyses: BoardAnalysis[]
  /** Most recent OPEN worksheet claiming this vial, or null. */
  worksheet: BoardWorksheet | null
}

export interface VialBoardResponse {
  total: number
  vials: BoardVial[]
}

export async function getVialBoard(opts: {
  hideTestOrders: boolean
  showXtra: boolean
}): Promise<VialBoardResponse> {
  const params = new URLSearchParams()
  params.set('hide_test_orders', String(opts.hideTestOrders))
  if (opts.showXtra) params.set('show_xtra', 'true')
  return apiFetch<VialBoardResponse>(`/api/sub-samples/board?${params}`)
}
```

Uses `apiFetch` (the sanctioned wrapper for new endpoints per its docstring), not the older raw-fetch idiom. If `InboxPriority` is exported under a different name, use that exact export.

- [ ] **Step 2: Create `src/services/vial-board.ts`**

Template: `src/services/inbox-lanes.ts` (entire pattern), plus the polling knobs from `src/hooks/use-inbox-samples.ts:27-46`:

```ts
import { useQuery } from '@tanstack/react-query'
import { getVialBoard, type VialBoardResponse } from '@/lib/api'

export const vialBoardQueryKeys = {
  board: (hideTestOrders: boolean, showXtra: boolean) =>
    ['vial-board', { hideTestOrders, showXtra }] as const,
}

export function useVialBoard(params: {
  hideTestOrders: boolean
  showXtra: boolean
}) {
  return useQuery({
    queryKey: vialBoardQueryKeys.board(params.hideTestOrders, params.showXtra),
    queryFn: () => getVialBoard(params),
    refetchInterval: 30_000, // 30s polling — inbox parity (spec §5)
    staleTime: 0, // live queue, always fresh
  })
}

export type { VialBoardResponse }
```

(Query hooks must live in `src/services/`, not `src/lib/` — ast-grep `hooks-in-hooks-dir` is severity error.)

- [ ] **Step 3: Verify by typecheck + lint**

Run: `npm run typecheck && npm run lint && npm run ast:lint`
Expected: clean (0 errors, 0 warnings). No unit test for a thin fetch wrapper — the component tests in Tasks 6-8 mock `getVialBoard` and exercise the hook path.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts src/services/vial-board.ts
git commit -m "feat(board): vial-board API types, fetch, and query hook"
```

---

### Task 4: Frontend — `src/lib/vial-board.ts` columns, placement, filters (+ tests)

**Files:**
- Create: `src/lib/vial-board.ts`
- Create: `src/lib/__tests__/vial-board.test.ts`

**Interfaces:**
- Consumes: nothing (pure module — local structural interfaces, NO imports from `api.ts`, matching `inbox-filters.ts`).
- Produces (Tasks 5-8 rely on these exact names):
  - `VialStage` union, `VialStageColumn{key,label,pillClass}`, `VIAL_STAGE_COLUMNS: VialStageColumn[]`, `DEFAULT_COLLAPSED_COLUMNS: VialStage[]`
  - `BoardAnalysisLike` / `BoardVialLike` (exported structural interfaces)
  - `placeableAnalyses(analyses)`, `stageCounts(vial): Partial<Record<VialStage, number>>`, `vialColumns(vial): VialStage[]`, `isSplitVial(vial): boolean`
  - `VialBoardFilters` interface + `DEFAULT_VIAL_BOARD_FILTERS`
  - `vialMatchesSampleId/vialMatchesAnalyte/vialMatchesTech/vialMatchesWorksheet/vialMatchesStages/vialMatchesRole(vial, arg): boolean`, `applyBoardFilters(vials, filters, laneRoleCodes, subRole)`, `sortVials(vials, sortKey, sortDir)`, `toggleKey(keys: string[], key: string): string[]`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/vial-board.test.ts` (style: `src/lib/__tests__/inbox-filters.test.ts` — inline literal fixtures, one `describe` per function, behavioral `it` names):

```ts
import { describe, it, expect } from 'vitest'
import {
  VIAL_STAGE_COLUMNS,
  DEFAULT_COLLAPSED_COLUMNS,
  DEFAULT_VIAL_BOARD_FILTERS,
  placeableAnalyses,
  stageCounts,
  vialColumns,
  isSplitVial,
  vialMatchesSampleId,
  vialMatchesAnalyte,
  vialMatchesTech,
  vialMatchesWorksheet,
  vialMatchesStages,
  vialMatchesRole,
  applyBoardFilters,
  sortVials,
  toggleKey,
  type BoardVialLike,
} from '@/lib/vial-board'

function vial(over: Partial<BoardVialLike> = {}): BoardVialLike {
  return {
    sample_id: 'PB-0001-S01',
    assignment_role: 'hplc',
    received_at: '2026-08-27T14:02:00Z',
    parent: { sample_id: 'PB-0001', label: 'Semaglutide 5 mg' },
    analyses: [],
    worksheet: null,
    ...over,
  }
}

describe('VIAL_STAGE_COLUMNS', () => {
  it('has the six stages in lifecycle order and rejected collapsed by default', () => {
    expect(VIAL_STAGE_COLUMNS.map(c => c.key)).toEqual([
      'unassigned',
      'assigned',
      'to_be_verified',
      'promoted',
      'variance_verified',
      'rejected',
    ])
    expect(DEFAULT_COLLAPSED_COLUMNS).toEqual(['rejected'])
    expect(DEFAULT_VIAL_BOARD_FILTERS.collapsedCols).toEqual(['rejected'])
  })
})

describe('placement (spec §2 multi-column rule)', () => {
  it('places a card in every column with >=1 analysis in that state', () => {
    const v = vial({
      analyses: [
        { title: 'A', review_state: 'assigned' },
        { title: 'B', review_state: 'assigned' },
        { title: 'C', review_state: 'to_be_verified' },
      ],
    })
    expect(vialColumns(v)).toEqual(['assigned', 'to_be_verified'])
    expect(stageCounts(v)).toEqual({ assigned: 2, to_be_verified: 1 })
    expect(isSplitVial(v)).toBe(true)
  })

  it('single-column vial is not split', () => {
    const v = vial({ analyses: [{ title: 'A', review_state: 'unassigned' }] })
    expect(vialColumns(v)).toEqual(['unassigned'])
    expect(isSplitVial(v)).toBe(false)
  })

  it('retracted rows never place cards or count', () => {
    const v = vial({
      analyses: [
        { title: 'A', review_state: 'retracted' },
        { title: 'B', review_state: 'promoted' },
      ],
    })
    expect(placeableAnalyses(v.analyses).map(a => a.title)).toEqual(['B'])
    expect(vialColumns(v)).toEqual(['promoted'])
  })

  it('unknown states (defensive) place nothing', () => {
    const v = vial({ analyses: [{ title: 'A', review_state: 'parent_to_verify' }] })
    expect(vialColumns(v)).toEqual([])
  })
})

describe('filters', () => {
  it('sample-id search matches vial or parent id, empty query is a no-op', () => {
    const v = vial()
    expect(vialMatchesSampleId(v, '')).toBe(true)
    expect(vialMatchesSampleId(v, 'pb-0001-s01')).toBe(true)
    expect(vialMatchesSampleId(v, 'PB-0001')).toBe(true)
    expect(vialMatchesSampleId(v, 'PB-0002')).toBe(false)
  })

  it('analyte search matches analysis titles, ignoring retracted rows', () => {
    const v = vial({
      analyses: [
        { title: 'ENDO-LAL Endotoxin', review_state: 'retracted' },
        { title: 'Purity HPLC', review_state: 'assigned' },
      ],
    })
    expect(vialMatchesAnalyte(v, 'purity')).toBe(true)
    expect(vialMatchesAnalyte(v, 'endo')).toBe(false)
    expect(vialMatchesAnalyte(v, '')).toBe(true)
  })

  it('tech filter matches by analyst_user_id string', () => {
    const v = vial({
      analyses: [{ title: 'A', review_state: 'assigned', analyst_user_id: 7 }],
    })
    expect(vialMatchesTech(v, '')).toBe(true)
    expect(vialMatchesTech(v, '7')).toBe(true)
    expect(vialMatchesTech(v, '8')).toBe(false)
  })

  it('worksheet filter is exact-title, stage filter matches placement columns', () => {
    const v = vial({
      worksheet: { title: 'WS-2026-08-29-043' },
      analyses: [{ title: 'A', review_state: 'to_be_verified' }],
    })
    expect(vialMatchesWorksheet(v, 'WS-2026-08-29-043')).toBe(true)
    expect(vialMatchesWorksheet(v, 'WS-other')).toBe(false)
    expect(vialMatchesStages(v, [])).toBe(true)
    expect(vialMatchesStages(v, ['to_be_verified'])).toBe(true)
    expect(vialMatchesStages(v, ['assigned'])).toBe(false)
  })

  it('applyBoardFilters composes lane roles, sub-role, and all axes', () => {
    const hplc = vial({ analyses: [{ title: 'A', review_state: 'assigned' }] })
    const endo = vial({
      sample_id: 'PB-0002-S02',
      assignment_role: 'endo',
      parent: { sample_id: 'PB-0002' },
      analyses: [{ title: 'B', review_state: 'assigned' }],
    })
    const filters = {
      activeStages: [],
      sampleIdFilter: '',
      analyteFilter: '',
      techFilter: '',
      worksheetFilter: '',
    }
    expect(applyBoardFilters([hplc, endo], filters, ['endo', 'ster'], '')).toEqual([endo])
    expect(applyBoardFilters([hplc, endo], filters, null, '')).toEqual([hplc, endo])
    expect(applyBoardFilters([hplc, endo], filters, null, 'endo')).toEqual([endo])
    expect(vialMatchesRole(hplc, 'hplc')).toBe(true)
  })
})

describe('sortVials + toggleKey', () => {
  it('sorts by received_at asc (oldest first) and flips on dir', () => {
    const older = vial({ received_at: '2026-08-01T00:00:00Z' })
    const newer = vial({ sample_id: 'PB-0009-S01', received_at: '2026-08-30T00:00:00Z' })
    expect(sortVials([newer, older], 'received_at', 'asc')).toEqual([older, newer])
    expect(sortVials([newer, older], 'received_at', 'desc')).toEqual([newer, older])
    expect(sortVials([newer, older], 'sample_id', 'asc')[0].sample_id).toBe('PB-0001-S01')
  })

  it('toggleKey adds absent keys and removes present ones', () => {
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleKey(['a', 'b'], 'b')).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/vial-board.test.ts`
Expected: FAIL — module `@/lib/vial-board` does not exist.

- [ ] **Step 3: Implement `src/lib/vial-board.ts`**

```ts
// Pure, framework-free helpers for the Vial Status Board. See
// docs/superpowers/specs/2026-08-31-vial-status-board-design.md §5.
// No hooks, no store subscriptions (ast-grep hooks-in-hooks-dir applies).

export type VialStage =
  | 'unassigned'
  | 'assigned'
  | 'to_be_verified'
  | 'promoted'
  | 'variance_verified'
  | 'rejected'

export interface VialStageColumn {
  key: VialStage
  /** Keep labels in sync with STATUS_LABELS (components/senaite/AnalysisTable.tsx). */
  label: string
  /** Count-pill tint — static Tailwind literals (v4 scans source). */
  pillClass: string
}

// Single source for kanban column list/order/labels (spec §5 "Stage truth &
// forward-compat"): when the workflow catalog becomes authoritative after the
// authority swap, this constant flips to a catalog read (lims_workflow_states
// already carries label/category/sort_order) without touching either view.
export const VIAL_STAGE_COLUMNS: VialStageColumn[] = [
  { key: 'unassigned', label: 'Unassigned', pillClass: 'bg-zinc-500/15 text-zinc-400' },
  { key: 'assigned', label: 'Assigned', pillClass: 'bg-amber-500/15 text-amber-400' },
  { key: 'to_be_verified', label: 'To Verify', pillClass: 'bg-orange-500/15 text-orange-400' },
  { key: 'promoted', label: 'Promoted', pillClass: 'bg-teal-500/15 text-teal-400' },
  { key: 'variance_verified', label: 'Verified — Variance', pillClass: 'bg-teal-500/15 text-teal-400' },
  { key: 'rejected', label: 'Rejected', pillClass: 'bg-red-500/15 text-red-400' },
]

export const DEFAULT_COLLAPSED_COLUMNS: VialStage[] = ['rejected']

const STAGE_KEYS = new Set<string>(VIAL_STAGE_COLUMNS.map(c => c.key))

// Structural interfaces (inbox-filters.ts precedent) — keeps helpers testable
// with hand-built literals and decoupled from api.ts wire types, which
// satisfy these structurally.
export interface BoardAnalysisLike {
  title: string
  review_state: string
  analyst_user_id?: number | null
  analyst_name?: string | null
}

export interface BoardVialLike {
  sample_id: string
  assignment_role: string
  received_at: string
  parent: { sample_id: string; label?: string | null }
  analyses: BoardAnalysisLike[]
  worksheet?: { title: string } | null
}

/** Analyses that can place cards / feed matrix cells — retracted never
 *  counts (mirrors the worksheet analyst-stamping exclusion; spec §5). */
export function placeableAnalyses<A extends BoardAnalysisLike>(analyses: A[]): A[] {
  return analyses.filter(a => a.review_state !== 'retracted')
}

/** Per-column analysis counts for one vial (multi-column placement, spec §2). */
export function stageCounts(vial: BoardVialLike): Partial<Record<VialStage, number>> {
  const counts: Partial<Record<VialStage, number>> = {}
  for (const a of placeableAnalyses(vial.analyses)) {
    if (STAGE_KEYS.has(a.review_state)) {
      const stage = a.review_state as VialStage
      counts[stage] = (counts[stage] ?? 0) + 1
    }
  }
  return counts
}

/** Columns this vial's card appears in, in column order. */
export function vialColumns(vial: BoardVialLike): VialStage[] {
  const counts = stageCounts(vial)
  return VIAL_STAGE_COLUMNS.map(c => c.key).filter(k => (counts[k] ?? 0) > 0)
}

/** A vial with live work in more than one column gets the split outline. */
export function isSplitVial(vial: BoardVialLike): boolean {
  return vialColumns(vial).length > 1
}

// ── Filters (persisted as 'vial-board-filters', Order Status pattern) ──────

export interface VialBoardFilters {
  activeStages: string[]
  sampleIdFilter: string
  analyteFilter: string
  /** '' = all; else String(analyst_user_id) from the tech dropdown. */
  techFilter: string
  /** '' = all; else exact open-worksheet title. */
  worksheetFilter: string
  hideTestOrders: boolean
  showXtra: boolean
  showAnalyses: boolean
  collapsedCols: string[]
  viewMode: 'kanban' | 'table'
  groupBySample: boolean
  sortKey: 'received_at' | 'sample_id'
  sortDir: 'asc' | 'desc'
}

export const DEFAULT_VIAL_BOARD_FILTERS: VialBoardFilters = {
  activeStages: [],
  sampleIdFilter: '',
  analyteFilter: '',
  techFilter: '',
  worksheetFilter: '',
  hideTestOrders: true,
  showXtra: false,
  showAnalyses: false,
  collapsedCols: [...DEFAULT_COLLAPSED_COLUMNS],
  viewMode: 'kanban',
  groupBySample: false,
  sortKey: 'received_at',
  sortDir: 'asc',
}

export function vialMatchesSampleId(vial: BoardVialLike, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    vial.sample_id.toLowerCase().includes(needle) ||
    vial.parent.sample_id.toLowerCase().includes(needle)
  )
}

export function vialMatchesAnalyte(vial: BoardVialLike, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return placeableAnalyses(vial.analyses).some(a =>
    a.title.toLowerCase().includes(needle)
  )
}

export function vialMatchesTech(vial: BoardVialLike, techId: string): boolean {
  if (!techId) return true
  return placeableAnalyses(vial.analyses).some(
    a => a.analyst_user_id != null && String(a.analyst_user_id) === techId
  )
}

export function vialMatchesWorksheet(vial: BoardVialLike, title: string): boolean {
  if (!title) return true
  return vial.worksheet?.title === title
}

export function vialMatchesStages(vial: BoardVialLike, activeStages: string[]): boolean {
  if (activeStages.length === 0) return true
  return vialColumns(vial).some(c => activeStages.includes(c))
}

export function vialMatchesRole(vial: BoardVialLike, subRole: string): boolean {
  if (!subRole) return true
  return vial.assignment_role === subRole
}

/** One pass over the board rows applying lane + sub-role + every filter axis.
 *  laneRoleCodes null = no lane restriction (caller adds 'xtra' when the
 *  show-xtra toggle is on — the server already gates xtra server-side). */
export function applyBoardFilters<V extends BoardVialLike>(
  vials: V[],
  filters: Pick<
    VialBoardFilters,
    'activeStages' | 'sampleIdFilter' | 'analyteFilter' | 'techFilter' | 'worksheetFilter'
  >,
  laneRoleCodes: string[] | null,
  subRole: string
): V[] {
  return vials.filter(
    v =>
      (laneRoleCodes === null || laneRoleCodes.includes(v.assignment_role)) &&
      vialMatchesRole(v, subRole) &&
      vialMatchesStages(v, filters.activeStages) &&
      vialMatchesSampleId(v, filters.sampleIdFilter) &&
      vialMatchesAnalyte(v, filters.analyteFilter) &&
      vialMatchesTech(v, filters.techFilter) &&
      vialMatchesWorksheet(v, filters.worksheetFilter)
  )
}

export function sortVials<V extends BoardVialLike>(
  vials: V[],
  sortKey: 'received_at' | 'sample_id',
  sortDir: 'asc' | 'desc'
): V[] {
  const sorted = [...vials].sort((a, b) => {
    const cmp =
      sortKey === 'received_at'
        ? a.received_at.localeCompare(b.received_at)
        : a.sample_id.localeCompare(b.sample_id)
    return sortDir === 'asc' ? cmp : -cmp
  })
  return sorted
}

/** Toggle membership of key in a string-key list (order-filters.ts precedent). */
export function toggleKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/vial-board.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/vial-board.ts src/lib/__tests__/vial-board.test.ts
git commit -m "feat(board): pure vial-board helpers — columns, placement, filters"
```

---

### Task 5: Frontend — matrix aggregation helpers (+ tests)

**Files:**
- Modify: `src/lib/vial-board.ts` (append)
- Modify: `src/lib/__tests__/vial-board.test.ts` (append)

**Interfaces:**
- Consumes: Task 4's `BoardVialLike`, `BoardAnalysisLike`, `placeableAnalyses`.
- Produces (Task 8 relies on these exact names):
  - `MatrixCellStatus = 'not_ordered' | 'not_started' | 'in_progress' | 'complete' | 'rejected'`
  - `MatrixCell{status: MatrixCellStatus, done: number, submitted: number, total: number}`
  - `MatrixRow{parentSampleId: string, label: string | null, cells: Record<string, MatrixCell>, overall: 'complete' | 'in_progress' | 'issue', techs: string[], worksheets: string[], earliestReceived: string}`
  - `matrixCell(analyses: BoardAnalysisLike[]): MatrixCell`
  - `matrixOverall(cells: MatrixCell[]): 'complete' | 'in_progress' | 'issue'`
  - `buildMatrixRows(vials, roleCodes: string[]): MatrixRow[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/vial-board.test.ts` (add `matrixCell`, `matrixOverall`, `buildMatrixRows` to the import list):

```ts
describe('matrixCell (spec §5 cell-status ladder)', () => {
  it('no analyses → not_ordered (visually distinct from not started)', () => {
    expect(matrixCell([])).toEqual({ status: 'not_ordered', done: 0, submitted: 0, total: 0 })
  })

  it('any rejected wins the ladder', () => {
    expect(
      matrixCell([
        { title: 'A', review_state: 'rejected' },
        { title: 'B', review_state: 'promoted' },
      ]).status
    ).toBe('rejected')
  })

  it('all promoted/variance_verified → complete', () => {
    const cell = matrixCell([
      { title: 'A', review_state: 'promoted' },
      { title: 'B', review_state: 'variance_verified' },
    ])
    expect(cell).toEqual({ status: 'complete', done: 2, submitted: 0, total: 2 })
  })

  it('any assigned/to_be_verified → in_progress with n/m counts', () => {
    const cell = matrixCell([
      { title: 'A', review_state: 'promoted' },
      { title: 'B', review_state: 'to_be_verified' },
      { title: 'C', review_state: 'assigned' },
    ])
    expect(cell).toEqual({ status: 'in_progress', done: 1, submitted: 1, total: 3 })
  })

  it('all unassigned → not_started; retracted rows are ignored entirely', () => {
    expect(
      matrixCell([
        { title: 'A', review_state: 'unassigned' },
        { title: 'B', review_state: 'retracted' },
      ])
    ).toEqual({ status: 'not_started', done: 0, submitted: 0, total: 1 })
  })

  it('promoted + unassigned mix is not_started per the spec ladder (no assigned/to_be_verified rows)', () => {
    // Deliberate spec choice (§5): In Progress requires >=1 assigned or
    // to_be_verified; done-but-not-all with the rest untouched reads as
    // Not Started with the n/m visible via done/total.
    const cell = matrixCell([
      { title: 'A', review_state: 'promoted' },
      { title: 'B', review_state: 'unassigned' },
    ])
    expect(cell.status).toBe('not_started')
    expect(cell.done).toBe(1)
  })
})

describe('matrixOverall (worst-of, spec §5)', () => {
  const cell = (status: MatrixCellStatus): MatrixCell =>
    ({ status, done: 0, submitted: 0, total: status === 'not_ordered' ? 0 : 1 })

  it('any rejected → issue', () => {
    expect(matrixOverall([cell('rejected'), cell('complete')])).toBe('issue')
  })

  it('any ordered role not complete → in_progress; not_ordered ignored', () => {
    expect(matrixOverall([cell('complete'), cell('in_progress'), cell('not_ordered')])).toBe('in_progress')
    expect(matrixOverall([cell('complete'), cell('not_started')])).toBe('in_progress')
  })

  it('all ordered complete → complete', () => {
    expect(matrixOverall([cell('complete'), cell('not_ordered')])).toBe('complete')
  })
})

describe('buildMatrixRows', () => {
  it('groups by parent, keys cells by role, aggregates techs/worksheets/received', () => {
    const rows = buildMatrixRows(
      [
        vial({
          sample_id: 'PB-0001-S01',
          assignment_role: 'hplc',
          received_at: '2026-08-27T14:02:00Z',
          worksheet: { title: 'WS-A' },
          analyses: [
            { title: 'Purity', review_state: 'promoted', analyst_name: 'J. Chen' },
          ],
        }),
        vial({
          sample_id: 'PB-0001-S02',
          assignment_role: 'endo',
          received_at: '2026-08-26T09:00:00Z',
          worksheet: { title: 'WS-B' },
          analyses: [
            { title: 'Endotoxin', review_state: 'assigned', analyst_name: 'R. Patel' },
          ],
        }),
      ],
      ['hplc', 'endo', 'ster']
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.parentSampleId).toBe('PB-0001')
    expect(row.cells.hplc.status).toBe('complete')
    expect(row.cells.endo.status).toBe('in_progress')
    expect(row.cells.ster.status).toBe('not_ordered')
    expect(row.overall).toBe('in_progress')
    expect(row.techs.sort()).toEqual(['J. Chen', 'R. Patel'])
    expect(row.worksheets.sort()).toEqual(['WS-A', 'WS-B'])
    expect(row.earliestReceived).toBe('2026-08-26T09:00:00Z')
  })

  it('parents sort by sample_id and distinct-dedupes techs/worksheets', () => {
    const rows = buildMatrixRows(
      [
        vial({ parent: { sample_id: 'PB-0002' }, sample_id: 'PB-0002-S01' }),
        vial({
          sample_id: 'PB-0001-S01',
          worksheet: { title: 'WS-A' },
          analyses: [
            { title: 'A', review_state: 'assigned', analyst_name: 'J. Chen' },
            { title: 'B', review_state: 'assigned', analyst_name: 'J. Chen' },
          ],
        }),
      ],
      ['hplc']
    )
    expect(rows.map(r => r.parentSampleId)).toEqual(['PB-0001', 'PB-0002'])
    expect(rows[0].techs).toEqual(['J. Chen'])
    expect(rows[0].worksheets).toEqual(['WS-A'])
  })
})
```

Also add `type MatrixCell, type MatrixCellStatus` to the test imports.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/__tests__/vial-board.test.ts`
Expected: Task 4 tests PASS; new ones FAIL (`matrixCell` not exported).

- [ ] **Step 3: Implement**

Append to `src/lib/vial-board.ts`:

```ts
// ── Matrix view aggregation (spec §5 "Matrix view") ─────────────────────────

export type MatrixCellStatus =
  | 'not_ordered'
  | 'not_started'
  | 'in_progress'
  | 'complete'
  | 'rejected'

export interface MatrixCell {
  status: MatrixCellStatus
  /** promoted + variance_verified count. */
  done: number
  /** to_be_verified count (the "n/m submitted" sub-line when done === 0). */
  submitted: number
  /** All non-retracted analyses for the (parent, role). */
  total: number
}

export interface MatrixRow {
  parentSampleId: string
  label: string | null
  /** Keyed by role code — columns come from the selected lane's catalog roles. */
  cells: Record<string, MatrixCell>
  overall: 'complete' | 'in_progress' | 'issue'
  /** Distinct analyst names across the row's non-retracted analyses. */
  techs: string[]
  /** Distinct open-worksheet titles across the row's vials. */
  worksheets: string[]
  /** Earliest vial received_at (ISO string; '' when impossible). */
  earliestReceived: string
}

/** Cell-status ladder over all vial-tier analyses on that parent's vials
 *  with that role — retracted ignored (spec §5, in ladder order):
 *  none → not_ordered; any rejected → rejected; all done → complete;
 *  any assigned/to_be_verified → in_progress; else not_started. */
export function matrixCell(analyses: BoardAnalysisLike[]): MatrixCell {
  const live = placeableAnalyses(analyses)
  const total = live.length
  const done = live.filter(
    a => a.review_state === 'promoted' || a.review_state === 'variance_verified'
  ).length
  const submitted = live.filter(a => a.review_state === 'to_be_verified').length
  if (total === 0) return { status: 'not_ordered', done: 0, submitted: 0, total: 0 }
  if (live.some(a => a.review_state === 'rejected'))
    return { status: 'rejected', done, submitted, total }
  if (done === total) return { status: 'complete', done, submitted, total }
  if (live.some(a => a.review_state === 'assigned' || a.review_state === 'to_be_verified'))
    return { status: 'in_progress', done, submitted, total }
  return { status: 'not_started', done, submitted, total }
}

/** Worst-of roll-up: any rejected → issue; any ordered role not complete →
 *  in_progress; else complete. not_ordered never counts against a row. */
export function matrixOverall(cells: MatrixCell[]): 'complete' | 'in_progress' | 'issue' {
  const ordered = cells.filter(c => c.status !== 'not_ordered')
  if (ordered.some(c => c.status === 'rejected')) return 'issue'
  if (ordered.some(c => c.status !== 'complete')) return 'in_progress'
  return 'complete'
}

/** Rows = parent samples of the passed (already-filtered) vials; columns =
 *  the selected lane's role codes. Sorted by parent sample_id. */
export function buildMatrixRows<V extends BoardVialLike>(
  vials: V[],
  roleCodes: string[]
): MatrixRow[] {
  const byParent = new Map<string, V[]>()
  for (const v of vials) {
    const group = byParent.get(v.parent.sample_id) ?? []
    group.push(v)
    byParent.set(v.parent.sample_id, group)
  }
  return [...byParent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([parentSampleId, group]) => {
      const cells: Record<string, MatrixCell> = {}
      for (const code of roleCodes) {
        cells[code] = matrixCell(
          group.filter(v => v.assignment_role === code).flatMap(v => v.analyses)
        )
      }
      const techs = [
        ...new Set(
          group
            .flatMap(v => placeableAnalyses(v.analyses))
            .map(a => a.analyst_name)
            .filter((n): n is string => !!n)
        ),
      ]
      const worksheets = [
        ...new Set(group.map(v => v.worksheet?.title).filter((t): t is string => !!t)),
      ]
      const earliestReceived = group.map(v => v.received_at).sort()[0] ?? ''
      return {
        parentSampleId,
        label: group[0]?.parent.label ?? null,
        cells,
        overall: matrixOverall(Object.values(cells)),
        techs,
        worksheets,
        earliestReceived,
      }
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/vial-board.test.ts`
Expected: PASS (all, both tasks' suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/vial-board.ts src/lib/__tests__/vial-board.test.ts
git commit -m "feat(board): matrix aggregation — cell ladder, worst-of overall, row builder"
```

---

### Task 6: Frontend — registration + `VialStatusPage` shell (+ component test)

**Files:**
- Modify: `src/store/ui-store.ts:44-52` (add `'vial-status'` to `AccuMarkToolsSubSection`)
- Modify: `src/components/AccuMarkTools.tsx` (import + case)
- Modify: `src/components/layout/AppSidebar.tsx:127-140` (SubItem)
- Create: `src/components/vial-board/VialStatusPage.tsx`
- Create: `src/test/vial-status-page.test.tsx`

**Interfaces:**
- Consumes: `useInboxLanes` (`@/services/inbox-lanes`), `useVialRoles` (`@/services/vial-roles`), `useDepartments` (`@/services/departments`), `useVialBoard` (Task 3), `useFlagUsers`/`nameForUser` (`@/components/flags/flag-users`), everything from `@/lib/vial-board` (Tasks 4-5), `ROLE_COLOR_BADGE`/`roleColorForCode` (`@/lib/role-display`), `cn` (`@/lib/utils`).
- Produces (Tasks 7-8 rely on these):
  - `VialStatusPage` (named export) — renders `<VialBoardKanban .../>` / `<VialBoardMatrix .../>` (stub placeholders in this task; replaced in Tasks 7-8)
  - Kanban stub props contract: `{ vials: BoardVial[]; filters: VialBoardFilters; showAnalyses: boolean; groupBySample: boolean; collapsedCols: string[]; onToggleCollapse: (key: string) => void; roleShort: (code: string) => string; roleChipClass: (code: string) => string; techNameById: Map<number, string> }`
  - Matrix stub props contract: `{ vials: BoardVial[]; roleCodes: string[]; roleLabel: (code: string) => string }`
  - localStorage helpers exported for tests: `loadVialBoardFilters(): VialBoardFilters` (from the page file is NOT allowed — put `loadVialBoardFilters`/`saveVialBoardFilters` in `src/lib/vial-board.ts` as pure functions with try/catch, mirroring `loadOrderFilters` at `OrderStatusPage.tsx:842-903`)

- [ ] **Step 1: Add persistence helpers to `src/lib/vial-board.ts`**

Append (localStorage access is fine in lib — `inbox-filters.ts` peers do it via the page, but `loadOrderFilters` lives beside its component; keeping these in lib keeps the `.tsx` export surface component-only for `react-refresh`):

```ts
// ── localStorage persistence (Order Status pattern; spec §5) ────────────────

export const VIAL_BOARD_FILTERS_LS_KEY = 'vial-board-filters'
export const VIAL_BOARD_LANE_LS_KEY = 'accu_mk1_vial_board_lane'

export function loadVialBoardFilters(): VialBoardFilters {
  try {
    const raw = localStorage.getItem(VIAL_BOARD_FILTERS_LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VialBoardFilters>
      return { ...DEFAULT_VIAL_BOARD_FILTERS, ...parsed }
    }
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_VIAL_BOARD_FILTERS, collapsedCols: [...DEFAULT_COLLAPSED_COLUMNS] }
}

export function saveVialBoardFilters(filters: VialBoardFilters): void {
  try {
    localStorage.setItem(VIAL_BOARD_FILTERS_LS_KEY, JSON.stringify(filters))
  } catch {
    // ignore quota errors
  }
}

export function loadStoredBoardLane(): string | null {
  return typeof window !== 'undefined'
    ? window.localStorage.getItem(VIAL_BOARD_LANE_LS_KEY)
    : null
}
```

- [ ] **Step 2: Registration edits (three files)**

`src/store/ui-store.ts` — extend the union (line ~44):

```ts
export type AccuMarkToolsSubSection =
  | 'overview'
  | 'order-explorer'
  | 'order-status'
  | 'customers'
  | 'customer-detail'
  | 'coa-explorer'
  | 'chromatographs'
  | 'digital-coa'
  | 'vial-status'
```

`src/components/AccuMarkTools.tsx` — add import + case (before the default arm):

```tsx
import { VialStatusPage } from '@/components/vial-board/VialStatusPage'
```
```tsx
    case 'vial-status':
      return <VialStatusPage />
```

`src/components/layout/AppSidebar.tsx` — in the `accumark-tools` `subItems` array, after `{ id: 'order-status', label: 'Order Status' },`:

```ts
      { id: 'vial-status', label: 'Vial Status' },
```

- [ ] **Step 3: Write the failing component test**

Create `src/test/vial-status-page.test.tsx` (harness: clone of `src/test/worksheets-inbox-lanes.test.tsx:14-108` — read it first):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { VialStatusPage } from '@/components/vial-board/VialStatusPage'
import { VIAL_BOARD_LANE_LS_KEY } from '@/lib/vial-board'
import type { InboxLaneRow, VialBoardResponse } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getVialBoard: vi.fn(),
    getInboxLanes: vi.fn(),
    getVialRoles: vi.fn(),
    getDepartments: vi.fn(),
    getWorksheetUsers: vi.fn(),
  }
})

import {
  getVialBoard,
  getInboxLanes,
  getVialRoles,
  getDepartments,
  getWorksheetUsers,
} from '@/lib/api'

const mockGetVialBoard = vi.mocked(getVialBoard)
const mockGetInboxLanes = vi.mocked(getInboxLanes)

const LANES: InboxLaneRow[] = [
  { key: 'hplc', label: 'Analytical', role_codes: ['hplc'], sort_order: 0 },
  { key: 'microbiology', label: 'Microbiology', role_codes: ['endo', 'ster'], sort_order: 1 },
]

const EMPTY_BOARD: VialBoardResponse = { total: 0, vials: [] }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <VialStatusPage />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockGetInboxLanes.mockResolvedValue(LANES)
  mockGetVialBoard.mockResolvedValue(EMPTY_BOARD)
  vi.mocked(getVialRoles).mockResolvedValue([])
  vi.mocked(getDepartments).mockResolvedValue([])
  vi.mocked(getWorksheetUsers).mockResolvedValue([])
})

describe('VialStatusPage — lane chips + persistence', () => {
  it('renders a chip per catalog lane once lanes resolve', async () => {
    renderPage()
    expect(await screen.findByRole('button', { name: 'Analytical' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Microbiology' })).toBeInTheDocument()
  })

  it('falls back to the first lane when the stored key is stale, and persists the correction', async () => {
    window.localStorage.setItem(VIAL_BOARD_LANE_LS_KEY, 'a_deleted_department')
    renderPage()
    await screen.findByRole('button', { name: 'Analytical' })
    await waitFor(() =>
      expect(window.localStorage.getItem(VIAL_BOARD_LANE_LS_KEY)).toBe('hplc')
    )
  })

  it('shows the empty state when the board has no vials', async () => {
    renderPage()
    expect(await screen.findByText(/no vials/i)).toBeInTheDocument()
  })
})
```

Before writing it, confirm the departments fetch function's exact export name in `src/services/departments.ts` (`getDepartments` assumed — adjust the mock to the real name).

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/test/vial-status-page.test.tsx`
Expected: FAIL — `VialStatusPage` module missing.

- [ ] **Step 5: Implement `src/components/vial-board/VialStatusPage.tsx`**

Model: `WorksheetsInboxPage.tsx` (lanes/chips/derived-role idiom, lines 128-200) + `OrderStatusPage.tsx` (toolbar toggles, lines 1391-1578). Structure:

```tsx
import { useEffect, useState } from 'react'
import { RefreshCw, Columns3, LayoutList, Layers, ListTree } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useInboxLanes } from '@/services/inbox-lanes'
import { useVialRoles } from '@/services/vial-roles'
import { useDepartments } from '@/services/departments'
import { useVialBoard } from '@/services/vial-board'
import { useFlagUsers, nameForUser } from '@/components/flags/flag-users'
import { ROLE_COLOR_BADGE, ROLE_COLOR_CHIP, roleColorForCode, roleShortLabel, roleFullLabel } from '@/lib/role-display'
import {
  VIAL_STAGE_COLUMNS,
  DEFAULT_VIAL_BOARD_FILTERS,
  type VialBoardFilters,
  applyBoardFilters,
  sortVials,
  toggleKey,
  loadVialBoardFilters,
  saveVialBoardFilters,
  loadStoredBoardLane,
  VIAL_BOARD_LANE_LS_KEY,
} from '@/lib/vial-board'
import { VialBoardKanban } from '@/components/vial-board/VialBoardKanban'
import { VialBoardMatrix } from '@/components/vial-board/VialBoardMatrix'

/**
 * Vial Status Board — department-scoped kanban/matrix over sub-samples
 * (spec docs/superpowers/specs/2026-08-31-vial-status-board-design.md).
 * Read-only v1: cards click through to sample details; stage changes stay
 * in worksheets/verify flows.
 */
export function VialStatusPage() {
  const lanesQ = useInboxLanes()
  const lanes = lanesQ.data ?? []
  const vialRolesQ = useVialRoles()
  const departmentsQ = useDepartments()
  const userMap = useFlagUsers()

  // Lane persistence: raw stored key, validated against the fetched lane set
  // (WorksheetsInboxPage.tsx:142-172 idiom — a stale admin-deleted key must
  // never 400; role is DERIVED, not stateful).
  const [storedLane, setStoredLane] = useState<string | null>(loadStoredBoardLane)
  const [firstLane] = lanes
  const lane: string | null = firstLane
    ? lanes.some(l => l.key === storedLane)
      ? storedLane
      : firstLane.key
    : null
  const currentLane = lanes.find(l => l.key === lane)

  useEffect(() => {
    if (lane !== null) window.localStorage.setItem(VIAL_BOARD_LANE_LS_KEY, lane)
  }, [lane])

  // Persisted filter blob (Order Status pattern).
  const [filters, setFilters] = useState<VialBoardFilters>(loadVialBoardFilters)
  const updateFilters = (partial: Partial<VialBoardFilters>) => {
    setFilters(prev => {
      const next = { ...prev, ...partial }
      saveVialBoardFilters(next)
      return next
    })
  }

  // Sub-role selection is transient and resets on lane change (inbox precedent).
  const [subRole, setSubRole] = useState('')
  useEffect(() => {
    setSubRole('')
  }, [lane])

  const boardQ = useVialBoard({
    hideTestOrders: filters.hideTestOrders,
    showXtra: filters.showXtra,
  })

  // ... derived data, chips, toolbar, views (see steps below)
}
```

The rest of the component, in order:

(a) **Derived rows** — lane restriction + filters + sort:

```tsx
  const laneCodes = currentLane
    ? [...currentLane.role_codes, ...(filters.showXtra ? ['xtra'] : [])]
    : null
  const allVials = boardQ.data?.vials ?? []
  const vials = sortVials(
    applyBoardFilters(allVials, filters, laneCodes, subRole),
    filters.sortKey,
    filters.sortDir
  )
```

(b) **Lane chips + sub-chips** — clone `WorksheetsInboxPage.tsx:631-690` including `laneBadgeClass` (re-declare it locally — it is not exported) and the `laneSubChips` sort from lines 174-194. Lane counts come client-side from `allVials` (`allVials.filter(v => currentLaneCodesFor(l).includes(v.assignment_role)).length` per lane).

(c) **Filter bar** — search input (sample/vial ID), analyte input, tech `<select>` from `userMap` (options `[...userMap.values()]` → `value=String(id)`, label via `nameForUser`), worksheet `<select>` whose options are the distinct `worksheet.title` values present in `allVials`, and toolbar toggle buttons copied from OrderStatusPage's house style (active `'bg-foreground text-background border-foreground'` / inactive `'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'`): Hide test orders, Show xtra, Show analyses (`ListTree` icon), By Sample (`Layers`), Columns dropdown (kanban only — clone `OrderStatusPage.tsx:1437-1481` swapping `KANBAN_COLUMNS`→`VIAL_STAGE_COLUMNS` and `collapsedKanbanCols`→`collapsedCols`), Table/Kanban view toggle (clone `OrderStatusPage.tsx:1532-1577`), manual Refresh button calling `boardQ.refetch()` with `RefreshCw` spinner on `boardQ.isFetching`.

(d) **Stage filter chips** (both views) — one button per `VIAL_STAGE_COLUMNS` entry toggling `activeStages` via `updateFilters({ activeStages: toggleKey(filters.activeStages, col.key) })`.

(e) **States** — loading skeleton while `lanesQ.isLoading || lane === null || boardQ.isLoading`; error panel with Retry button when `lanesQ.isError || boardQ.isError` (`onClick={() => { lanesQ.refetch(); boardQ.refetch() }}`) — never render half a board; empty state naming active filters when `vials.length === 0` (must contain the literal text "No vials" — the test greps `/no vials/i`).

(f) **View render**:

```tsx
      {filters.viewMode === 'kanban' ? (
        <VialBoardKanban
          vials={vials}
          filters={filters}
          showAnalyses={filters.showAnalyses}
          groupBySample={filters.groupBySample}
          collapsedCols={filters.collapsedCols}
          onToggleCollapse={key =>
            updateFilters({ collapsedCols: toggleKey(filters.collapsedCols, key) })
          }
          roleShort={code => roleShortLabel(code, vialRolesQ.data)}
          roleChipClass={code =>
            ROLE_COLOR_CHIP[roleColorForCode(code, vialRolesQ.data, departmentsQ.data)]
          }
          techNameById={userMap}
        />
      ) : (
        <VialBoardMatrix
          vials={vials}
          roleCodes={currentLane?.role_codes ?? []}
          roleLabel={code => roleFullLabel(code, vialRolesQ.data)}
        />
      )}
```

For THIS task, create `VialBoardKanban.tsx` and `VialBoardMatrix.tsx` as minimal placeholder components with the exact prop signatures above rendering `<div>Kanban — {vials.length} vials</div>` / `<div>Matrix — {vials.length} vials</div>`; Tasks 7-8 replace their bodies. Zustand rules: any store read uses selector syntax; `useUIStore.getState().navigateToSample(...)` in handlers only.

- [ ] **Step 6: Run tests + gates**

Run: `npx vitest run src/test/vial-status-page.test.tsx && npm run typecheck && npm run lint && npm run ast:lint`
Expected: 3 tests PASS; gates clean.

- [ ] **Step 7: Commit**

```bash
git add src/store/ui-store.ts src/components/AccuMarkTools.tsx src/components/layout/AppSidebar.tsx src/components/vial-board/ src/lib/vial-board.ts src/test/vial-status-page.test.tsx
git commit -m "feat(board): Vial Status page shell — registration, lane chips, filters, persistence"
```

---

### Task 7: Frontend — kanban view (+ component test)

**Files:**
- Modify: `src/components/vial-board/VialBoardKanban.tsx` (replace placeholder body)
- Create: `src/test/vial-board-kanban.test.tsx`

**Interfaces:**
- Consumes: props contract from Task 6 (unchanged), `VIAL_STAGE_COLUMNS`, `stageCounts`, `vialColumns`, `isSplitVial`, `placeableAnalyses` from `@/lib/vial-board`; `parseReceivedAtMs`, `formatAge` from `@/components/hplc/AgingTimer`; `type BoardVial` from `@/lib/api`; `useUIStore` (getState in handler only).
- Produces: final `VialBoardKanban`.

- [ ] **Step 1: Write the failing test**

Create `src/test/vial-board-kanban.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VialBoardKanban } from '@/components/vial-board/VialBoardKanban'
import { DEFAULT_VIAL_BOARD_FILTERS } from '@/lib/vial-board'
import type { BoardVial } from '@/lib/api'

const navigateToSample = vi.fn()
vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(vi.fn(), {
    getState: () => ({ navigateToSample }),
  }),
}))

function boardVial(over: Partial<BoardVial> = {}): BoardVial {
  return {
    id: 1,
    sample_id: 'PB-0463-S02',
    external_lims_uid: 'mk1://sub/1',
    assignment_role: 'endo',
    vial_sequence: 2,
    received_at: '2026-08-27T14:02:00Z',
    parent: {
      id: 401,
      sample_id: 'PB-0463',
      label: 'Semaglutide 5 mg',
      client_sample_id: null,
      priority: 'normal',
      is_test_order: false,
    },
    analyses: [],
    worksheet: null,
    ...over,
  }
}

const baseProps = {
  filters: DEFAULT_VIAL_BOARD_FILTERS,
  showAnalyses: false,
  groupBySample: false,
  collapsedCols: [] as string[],
  onToggleCollapse: vi.fn(),
  roleShort: (code: string) => code.toUpperCase(),
  roleChipClass: () => 'bg-sky-500/15',
  techNameById: new Map<number, never>(),
}

describe('VialBoardKanban', () => {
  it('places a split vial card in every column with live work, with counts', () => {
    const v = boardVial({
      analyses: [
        { id: 1, title: 'Endotoxin', review_state: 'assigned', analyst_user_id: null, analyst_name: null },
        { id: 2, title: 'Sterility', review_state: 'to_be_verified', analyst_user_id: null, analyst_name: null },
      ],
    })
    render(<VialBoardKanban {...baseProps} vials={[v]} />)
    expect(screen.getAllByText('PB-0463-S02')).toHaveLength(2)
  })

  it('collapsed column hides its cards until the header is clicked', () => {
    const v = boardVial({
      analyses: [
        { id: 1, title: 'Endotoxin', review_state: 'rejected', analyst_user_id: null, analyst_name: null },
        { id: 2, title: 'Sterility', review_state: 'assigned', analyst_user_id: null, analyst_name: null },
      ],
    })
    const onToggleCollapse = vi.fn()
    render(
      <VialBoardKanban
        {...baseProps}
        vials={[v]}
        collapsedCols={['rejected']}
        onToggleCollapse={onToggleCollapse}
      />
    )
    // Card renders once (assigned) — the rejected copy is collapsed away.
    expect(screen.getAllByText('PB-0463-S02')).toHaveLength(1)
    fireEvent.click(screen.getByTitle('Expand Rejected'))
    expect(onToggleCollapse).toHaveBeenCalledWith('rejected')
  })

  it('card click navigates to the parent sample details', () => {
    const v = boardVial({
      analyses: [
        { id: 1, title: 'Endotoxin', review_state: 'assigned', analyst_user_id: null, analyst_name: null },
      ],
    })
    render(<VialBoardKanban {...baseProps} vials={[v]} />)
    fireEvent.click(screen.getByText('PB-0463-S02'))
    expect(navigateToSample).toHaveBeenCalledWith('PB-0463')
  })

  it('showAnalyses lists matching analysis titles on the card', () => {
    const v = boardVial({
      analyses: [
        { id: 1, title: 'Endotoxin USP<85>', review_state: 'assigned', analyst_user_id: null, analyst_name: null },
      ],
    })
    render(<VialBoardKanban {...baseProps} vials={[v]} showAnalyses={true} />)
    expect(screen.getByText('Endotoxin USP<85>')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/vial-board-kanban.test.tsx`
Expected: FAIL (placeholder renders no cards).

- [ ] **Step 3: Implement the kanban view**

Replace the placeholder body. Blueprint (clone mechanisms from `OrderStatusPage.tsx` KanbanView, lines 525-765 — read it first):

- **Item build:** for each vial, one entry per column from `vialColumns(vial)` with `count = stageCounts(vial)[col]`.
- **Collapse override:** `const effectiveCollapsed = filters.activeStages.length > 0 ? [] : collapsedCols` (an explicit stage filter overrides collapse — `OrderStatusPage.tsx:596-608` rationale).
- **Flat grid:** verbatim grid-template trick from `OrderStatusPage.tsx:614-624` (`'minmax(40px, auto)'` collapsed vs `'minmax(180px, 1fr)'`), column header button with `ChevronRight`/`ChevronDown` + `title={collapsed ? `Expand ${col.label}` : `Collapse ${col.label}`}` + count `Badge` — the test greps `getByTitle('Expand Rejected')`.
- **Swimlanes (`groupBySample`):** clone `OrderStatusPage.tsx:683-765` — group by `vial.parent.sample_id`, lane header shows parent id + `label`, columns = non-collapsed only.
- **Card** (hook-free function component in the same file, spec §5 "Card"):

```tsx
function VialCard({
  vial,
  col,
  count,
  split,
  showAnalyses,
  roleShort,
  roleChipClass,
  pillClass,
}: {
  vial: BoardVial
  col: VialStage
  count: number
  split: boolean
  showAnalyses: boolean
  roleShort: (code: string) => string
  roleChipClass: (code: string) => string
  pillClass: string
}) {
  const inCol = placeableAnalyses(vial.analyses).filter(a => a.review_state === col)
  const techs = [...new Set(inCol.map(a => a.analyst_name).filter((n): n is string => !!n))]
  const age = formatAge(Date.now() - parseReceivedAtMs(vial.received_at))
  return (
    <div
      onClick={() => useUIStore.getState().navigateToSample(vial.parent.sample_id)}
      title={placeableAnalyses(vial.analyses).map(a => `${a.title} — ${a.review_state}`).join('\n')}
      className={cn(
        'rounded border bg-indigo-500/10 border-indigo-500/35 px-2 py-1 cursor-pointer hover:border-indigo-400/60 transition-colors',
        split && 'ring-1 ring-sky-400/40'
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-mono text-[11px] font-semibold truncate">{vial.sample_id}</span>
        <span className={cn('text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0', roleChipClass(vial.assignment_role))}>
          {roleShort(vial.assignment_role)}
        </span>
        {vial.parent.priority !== 'normal' && (
          <span
            title={vial.parent.priority}
            className={cn(
              'h-1.5 w-1.5 rounded-full shrink-0',
              vial.parent.priority === 'expedited' ? 'bg-red-400 animate-pulse' : 'bg-amber-400'
            )}
          />
        )}
        <span className={cn('ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none shrink-0', pillClass)}>
          {count}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground min-w-0">
        <span className="truncate">
          {techs.length > 0 ? techs.join(', ') : col === 'unassigned' ? 'no worksheet yet' : '—'}
        </span>
        {vial.worksheet && (
          <span className="font-mono truncate text-muted-foreground/80">{vial.worksheet.title}</span>
        )}
        <span className="ml-auto font-mono tabular-nums shrink-0">{age}</span>
      </div>
      {showAnalyses && inCol.length > 0 && (
        <div className="mt-1 pt-1 border-t border-border/30">
          {inCol.map(a => (
            <div key={a.id} className="text-[10px] text-muted-foreground/70 leading-relaxed truncate">
              {a.title}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

Imports for the file: `import { useUIStore } from '@/store/ui-store'`, `import { parseReceivedAtMs, formatAge } from '@/components/hplc/AgingTimer'`, `import { ChevronDown, ChevronRight } from 'lucide-react'`, `import { Badge } from '@/components/ui/badge'`, plus lib helpers. Compact chip style source: `AssignStep.tsx:909-944` (navy = `bg-indigo-500/10 border-indigo-500/35`; mini badge = `text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wide` + chip class).

- [ ] **Step 4: Run tests + gates**

Run: `npx vitest run src/test/vial-board-kanban.test.tsx src/test/vial-status-page.test.tsx && npm run typecheck && npm run lint && npm run ast:lint`
Expected: all PASS, gates clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/vial-board/VialBoardKanban.tsx src/test/vial-board-kanban.test.tsx
git commit -m "feat(board): kanban view — multi-column placement, compact chips, collapse, swimlanes"
```

---

### Task 8: Frontend — matrix view (+ component test)

**Files:**
- Modify: `src/components/vial-board/VialBoardMatrix.tsx` (replace placeholder body)
- Create: `src/test/vial-board-matrix.test.tsx`

**Interfaces:**
- Consumes: Task 6's matrix props contract (`vials`, `roleCodes`, `roleLabel`), `buildMatrixRows`, `type MatrixCell`, `type MatrixRow` from `@/lib/vial-board`, `parseReceivedAtMs`/`formatAge` optional for Received display, `useUIStore` getState for row-click navigation.
- Produces: final `VialBoardMatrix`.

- [ ] **Step 1: Write the failing test**

Create `src/test/vial-board-matrix.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VialBoardMatrix } from '@/components/vial-board/VialBoardMatrix'
import type { BoardVial } from '@/lib/api'

vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(vi.fn(), {
    getState: () => ({ navigateToSample: vi.fn() }),
  }),
}))

function boardVial(over: Partial<BoardVial> = {}): BoardVial {
  return {
    id: 1,
    sample_id: 'PB-0463-S01',
    external_lims_uid: 'mk1://sub/1',
    assignment_role: 'hplc',
    vial_sequence: 1,
    received_at: '2026-08-27T14:02:00Z',
    parent: {
      id: 401,
      sample_id: 'PB-0463',
      label: 'Semaglutide 5 mg',
      client_sample_id: null,
      priority: 'normal',
      is_test_order: false,
    },
    analyses: [],
    worksheet: null,
    ...over,
  }
}

describe('VialBoardMatrix', () => {
  it('renders one row per parent with role columns; not-ordered renders as a dash', () => {
    const v = boardVial({
      analyses: [
        { id: 1, title: 'Purity', review_state: 'promoted', analyst_user_id: 7, analyst_name: 'J. Chen' },
      ],
      worksheet: { id: 5, title: 'WS-2026-08-29-043', status: 'open' },
    })
    render(
      <VialBoardMatrix
        vials={[v]}
        roleCodes={['hplc', 'endo']}
        roleLabel={code => (code === 'hplc' ? 'HPLC' : 'Endotoxin')}
      />
    )
    expect(screen.getByText('PB-0463')).toBeInTheDocument()
    expect(screen.getByText('HPLC')).toBeInTheDocument()
    expect(screen.getByText('Endotoxin')).toBeInTheDocument()
    expect(screen.getByText('Complete')).toBeInTheDocument()
    expect(screen.getByText('— not ordered')).toBeInTheDocument()
    expect(screen.getByText('J. Chen')).toBeInTheDocument()
    expect(screen.getByText('WS-2026-08-29-043')).toBeInTheDocument()
  })

  it('in-progress cell shows the n/m promoted sub-line (or submitted when none promoted)', () => {
    const promoted = boardVial({
      analyses: [
        { id: 1, title: 'A', review_state: 'promoted', analyst_user_id: null, analyst_name: null },
        { id: 2, title: 'B', review_state: 'assigned', analyst_user_id: null, analyst_name: null },
        { id: 3, title: 'C', review_state: 'to_be_verified', analyst_user_id: null, analyst_name: null },
      ],
    })
    const { rerender } = render(
      <VialBoardMatrix vials={[promoted]} roleCodes={['hplc']} roleLabel={() => 'HPLC'} />
    )
    expect(screen.getByText('1/3 promoted')).toBeInTheDocument()

    const submittedOnly = boardVial({
      analyses: [
        { id: 1, title: 'A', review_state: 'to_be_verified', analyst_user_id: null, analyst_name: null },
        { id: 2, title: 'B', review_state: 'assigned', analyst_user_id: null, analyst_name: null },
      ],
    })
    rerender(
      <VialBoardMatrix vials={[submittedOnly]} roleCodes={['hplc']} roleLabel={() => 'HPLC'} />
    )
    expect(screen.getByText('1/2 submitted')).toBeInTheDocument()
  })

  it('overall is worst-of: a rejected role renders Issue', () => {
    const v = boardVial({
      analyses: [
        { id: 1, title: 'A', review_state: 'rejected', analyst_user_id: null, analyst_name: null },
      ],
    })
    render(<VialBoardMatrix vials={[v]} roleCodes={['hplc']} roleLabel={() => 'HPLC'} />)
    expect(screen.getByText('Issue')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/vial-board-matrix.test.tsx`
Expected: FAIL (placeholder).

- [ ] **Step 3: Implement the matrix view**

Replace the placeholder body:

```tsx
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import {
  buildMatrixRows,
  type MatrixCell,
  type MatrixCellStatus,
} from '@/lib/vial-board'
import type { BoardVial } from '@/lib/api'

const CELL_STATUS_CLASS: Record<MatrixCellStatus, string> = {
  not_ordered: 'text-muted-foreground/40',
  not_started: 'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20',
  in_progress: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/20',
  complete: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-400 dark:border-teal-500/20',
  rejected: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/20',
}

const CELL_STATUS_LABEL: Record<Exclude<MatrixCellStatus, 'not_ordered'>, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  complete: 'Complete',
  rejected: 'Rejected',
}

const OVERALL_CLASS: Record<'complete' | 'in_progress' | 'issue', string> = {
  complete: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-400 dark:border-teal-500/20',
  in_progress: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/20',
  issue: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/20',
}

const OVERALL_LABEL: Record<'complete' | 'in_progress' | 'issue', string> = {
  complete: 'Complete',
  in_progress: 'In Progress',
  issue: 'Issue',
}

function MatrixCellView({ cell }: { cell: MatrixCell }) {
  if (cell.status === 'not_ordered') {
    // "not ordered ≠ not started": an empty cell must never read as
    // forgotten work (spec §5).
    return <span className={cn('text-xs', CELL_STATUS_CLASS.not_ordered)}>— not ordered</span>
  }
  const subline =
    cell.status === 'in_progress'
      ? cell.done > 0
        ? `${cell.done}/${cell.total} promoted`
        : `${cell.submitted}/${cell.total} submitted`
      : null
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium', CELL_STATUS_CLASS[cell.status])}>
        {CELL_STATUS_LABEL[cell.status]}
      </span>
      {subline && <span className="text-[10px] text-muted-foreground tabular-nums">{subline}</span>}
    </div>
  )
}

export function VialBoardMatrix({
  vials,
  roleCodes,
  roleLabel,
}: {
  vials: BoardVial[]
  roleCodes: string[]
  roleLabel: (code: string) => string
}) {
  const rows = buildMatrixRows(vials, roleCodes)
  return (
    <div className="overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/50 bg-muted/30 text-left">
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sample</th>
            {roleCodes.map(code => (
              <th key={code} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {roleLabel(code)}
              </th>
            ))}
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overall</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tech</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Worksheet</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Received</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr
              key={row.parentSampleId}
              onClick={() => useUIStore.getState().navigateToSample(row.parentSampleId)}
              className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 cursor-pointer"
            >
              <td className="px-3 py-2">
                <div className="font-mono text-[13px] font-semibold text-primary">{row.parentSampleId}</div>
                {row.label && <div className="text-xs text-muted-foreground truncate max-w-[180px]">{row.label}</div>}
              </td>
              {roleCodes.map(code => (
                <td key={code} className="px-3 py-2 align-top">
                  <MatrixCellView cell={row.cells[code]} />
                </td>
              ))}
              <td className="px-3 py-2 align-top">
                <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium', OVERALL_CLASS[row.overall])}>
                  {OVERALL_LABEL[row.overall]}
                </span>
              </td>
              <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                {row.techs.length === 0
                  ? '—'
                  : row.techs.length <= 2
                    ? row.techs.join(', ')
                    : `${row.techs.slice(0, 2).join(', ')} +${row.techs.length - 2}`}
              </td>
              <td className="px-3 py-2 align-top">
                {row.worksheets.length === 0 ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {row.worksheets.map(t => (
                      <span key={t} className="font-mono text-[10px] rounded border border-border/60 bg-muted/40 px-1.5 py-0.5">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 align-top font-mono text-xs tabular-nums text-muted-foreground">
                {row.earliestReceived ? row.earliestReceived.slice(0, 10) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

(Sub-lines are counts only in v1 — per-analysis completion dates are deferred, spec §5.)

- [ ] **Step 4: Run tests + gates**

Run: `npx vitest run src/test/vial-board-matrix.test.tsx src/test/vial-board-kanban.test.tsx src/test/vial-status-page.test.tsx src/lib/__tests__/vial-board.test.ts && npm run typecheck && npm run lint && npm run ast:lint`
Expected: all PASS, gates clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/vial-board/VialBoardMatrix.tsx src/test/vial-board-matrix.test.tsx
git commit -m "feat(board): matrix view — role columns, cell ladder rendering, worst-of overall"
```

---

### Task 9: Full gates, baseline diffs, PR

**Files:**
- Modify: none expected (fix-ups only if gates fail)

- [ ] **Step 1: Format**

Run: `npm run format` then `git diff --stat` — commit any formatting churn it produces on the new files:
```bash
git add -A && git diff --cached --quiet || git commit -m "style: prettier pass on vial-board files"
```

- [ ] **Step 2: Frontend full gate**

Run: `npm run check:all`
Expected: typecheck/lint/ast:lint/format:check clean. `test:run` gate is the **failure-set diff**, not zero: the branch-base baseline is exactly these 7 failures (6 files) —
```
src/App.test.tsx > App > renders main window layout
src/components/flags/__tests__/FlagsFlyout.test.tsx > FlagsFlyout > renders the cards for the default (assigned) tab
src/components/intake/ReceiveWizard/__tests__/PackagingPanel.test.tsx > PackagingPanel > file-path + Save calls createPackagingPhoto with a base64 string
src/test/analysis-profiles-coa-display.test.tsx > AnalysisProfilesPage — COA display fields > clearing basis/method/prep and removing all footnotes sends nulls
src/test/analysis-profiles-coa-display.test.tsx > AnalysisProfilesPage — COA display fields > fills basis note, method, prep, and two footnotes, and PATCH carries all four
src/test/peptide-requests-list.test.tsx > PeptideRequestsList > re-queries with CLOSED_STATUSES when the Closed tab is clicked
src/test/worksheets-inbox-lanes.test.tsx > WorksheetsInboxPage — catalog-driven lane sub-chips (2026-08-24 slice) > sub-chip filters by role_tags — rider work (fentanyl on an hplc host vial) is reachable under its own chip
```
Zero net-new failures = pass. If the Rust steps (`rust:fmt:check`/`rust:clippy`/`rust:test`) fail for environment reasons (cargo not on PATH in this shell), run the frontend chain (`npm run typecheck && npm run lint && npm run ast:lint && npm run format:check && npm run test:run`) and record in the task report that Rust steps were skipped and why — no Rust files are touched by this branch.

- [ ] **Step 3: Backend full gate**

Run (from `backend/`): `.venv/Scripts/python -m pytest tests/ -q 2>&1 | grep -E "^(FAILED|ERROR)" | sort -u > /tmp/branch-pytest.txt` then diff against the pre-work baseline `backend/.baseline-pytest.txt` (captured on `72630f3b` before Task 1). Zero net-new FAILED/ERROR lines = pass. (`backend/.baseline-pytest.txt` is untracked scratch — do not commit it.)

- [ ] **Step 4: Spec §7 checklist sweep**

Verify each spec test requirement maps to a passing test: mixed-state payload ✓ (T1), fully-promoted excluded ✓ (T1), retracted-only excluded ✓ (T1), hide_test_orders + show_xtra gating ✓ (T1/T2), lane + unknown-lane 400 ✓ (T1), worksheet open-most-recent ✓ (T2), analyst display rule ✓ (T2), worksheet null ✓ (T2), placement multi-column + retracted ignored ✓ (T4), split detection ✓ (T4), matrix ladder + not-ordered vs not-started ✓ (T5), overall worst-of ✓ (T5), filter application ✓ (T4). Report any gap and fix before the PR.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/vial-status-board
gh pr create --repo Zstar0/Accu-Mk1 --base master --title "feat: Vial Status Board — department kanban + matrix over sub-samples (read-only v1)" --body "$(cat <<'EOF'
## Summary
- New **Vial Status Board** at `#accumark-tools/vial-status` (AccuMark Tools sidebar, next to Order Status): department-scoped kanban + matrix table answering "where is every open vial right now?"
- New read-only `GET /api/sub-samples/board`: a vial is included while ≥1 current vial-tier analysis is live (`unassigned`/`assigned`/`to_be_verified`) and the payload carries ALL its current analyses; 5 bulk queries, no N+1; open-most-recent worksheet join; analyst names via the users_display rule; priorities; test-order gating.
- Kanban: multi-column placement (card per column with live work, count pills, split-vial outline), compact assignment-page chips, collapsible columns (Rejected starts collapsed), per-sample swimlanes, "Show analyses" toggle.
- Matrix: rows = parent samples, columns = the lane's catalog roles, cell ladder with "— not ordered" ≠ "Not Started", worst-of Overall, Tech/Worksheet/Received.
- Stage truth = the pure state machine (`review_state`); the shadow workflow catalog is deliberately not read (columns centralized in `VIAL_STAGE_COLUMNS` for the post-authority-swap flip).

Spec: `docs/superpowers/specs/2026-08-31-vial-status-board-design.md` · Plan: `docs/superpowers/plans/2026-09-01-vial-status-board.md`
Design mockups: https://claude.ai/code/artifact/f091ce31-aa33-4cb4-be9e-f85f6ca18609

## Test plan
- [x] `backend/tests/test_sub_samples_board.py` — 13 hermetic endpoint tests (inclusion rules, gating, lane 400, worksheet/analyst/priority enrichment)
- [x] `src/lib/__tests__/vial-board.test.ts` — placement, split detection, filters, matrix ladder, worst-of
- [x] Component tests: page shell (lane persistence + stale-key self-heal), kanban (multi-column, collapse, click-through, show-analyses), matrix (cells, sub-lines, overall)
- [x] `npm run check:all` + full backend pytest: zero net-new failures vs branch-base baseline

Read-only slice: no writes, no migrations, no changes to inbox/worksheets/state machine/shadow engine.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Do NOT merge — the PR waits for the Handler.

- [ ] **Step 6: Report**

Final report: PR URL, commit list, gate results (including the exact failure-set diffs), and any deviations from this plan.

---

## Self-review notes (already applied)

- Spec §4 says `async def`; every route in `sub_samples/routes.py` is sync `def` and the sync-DB-work-in-async-route pattern blocks the event loop — plan uses sync `def` (called out in Global Constraints).
- Spec's five-query strategy is preserved (candidates+parents / analyses / worksheets / users / priorities); test-order lookup is a sixth out-of-band read via the existing `main._test_order_senaite_ids` helper, monkeypatched in hermetic tests.
- `main.py:19203`'s `EXCLUDED_STATES` is function-local and not importable; the board defines its own `BOARD_LIVE_STATES` complement (the spec's inclusion rule is stated positively, so no refactor of `main.py` is needed).
- The matrix "promoted + unassigned mix → Not Started" edge follows the spec ladder literally and carries a dedicated test documenting the choice.
- `parent.label` = `LimsSample.peptide_name` (nullable), with `client_sample_id` also exposed for future card use.
