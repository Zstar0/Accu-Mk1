# SLA Tiers — model revision + settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace A's per-`(service,priority)` `sla_targets` with a first-class **SLA tier** entity that service groups and priorities reference, and ship the settings UI (sub-project C) to manage it.

**Architecture:** `sla_tiers` (named target) + `sla_priority_tiers` (sparse priority→tier map) + `service_groups.sla_tier_id`. Pure-function resolver (`resolve_sla_tier`) with fixed precedence — priority override → group tier → default tier — runs server-side in Python and client-side in TS for D2. FastAPI CRUD mirrors `/service-groups`; the UI is a new Preferences pane plus an SLA-tier dropdown on the existing Service Groups page.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (no Alembic — `create_all` + idempotent `_run_migrations`), pytest; React 19 + TanStack Query + shadcn/ui + react-i18next; Vitest. Spec: `docs/superpowers/specs/2026-05-27-sla-tiers-model-and-settings-design.md`.

**Reference (spec §Resolution):** the chain is
```python
prio_tier = priority_map.get(priority)   # None if unmapped OR priority is None
if prio_tier is not None: return prio_tier
if group_tier is not None: return group_tier
return default_tier
```

**Operational notes (from A's execution — apply throughout):**
- Edit/commit in this worktree only: `C:\tmp\accu-mk1-wave1`.
- After editing `models.py`/`database.py`/`main.py`: `docker restart accu-mk1-backend`, then `curl -fsS http://localhost:8012/health`.
- Backend tests run **in the container** at `/app/tests` (NOT `backend/tests`): `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/<file> -q'`. `pytest` is already pip-installed in the running container; if the container was rebuilt, re-run `docker exec accu-mk1-backend pip install --quiet pytest`.
- Engine/pure tests also run on the host from `backend/`: `python -m pytest tests/<file> -q`.
- After editing `src/`: `docker restart accu-mk1-frontend`. Frontend tests: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run <path>'`. Typecheck on host: `npm --prefix /c/tmp/accu-mk1-wave1 run typecheck`.
- Lint only changed files (host): `./node_modules/.bin/eslint <files>` — ignore the 3 pre-existing baseline errors in `api.ts` (lines 1730, 3224, 3757); never `Array<T>` (use `T[]`).
- Commit per task with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Backend (Phase 1):**
- `backend/models.py` — replace `SlaTarget` (≈ lines 699–740) with `SlaTier` + `SlaPriorityTier`; add `sla_tier_id` + relationship to `ServiceGroup` (≈ lines 171–189).
- `backend/database.py` — replace the `sla_targets` migration block (≈ lines 220–247) with the new tables/seed/ALTER.
- `backend/sla_engine.py` — replace `resolve_sla_target` with `resolve_sla_tier`; keep `compute_sla_status`, `PRIORITIES`.
- `backend/main.py` — imports; replace SLA Pydantic schemas (≈ 1825–1865) and the `/sla-targets` endpoint block (≈ 11865–11975) with `/sla-tiers` + `/sla-priority-tiers`; extend `ServiceGroup*` schemas + create/update with `sla_tier_id`.
- `backend/tests/` — rework `test_sla_engine.py`, `test_sla_schema.py`, `test_api_sla_targets.py` → tier versions; add `test_api_sla_priority_tiers.py`, `test_api_service_group_sla_tier.py`.

**Frontend (Phase 2):**
- `src/lib/api.ts` — replace the SLA block (`SlaTarget*`, `resolveSlaTarget`) with `SlaTier*`, `SlaPriorityTier*`, `resolveSlaTier`; add `sla_tier_id` to `ServiceGroup*` interfaces.
- `src/services/sla.ts` — **new**: TanStack Query hooks (mirror `src/services/preferences.ts`, but HTTP via `api.ts`).
- `src/components/preferences/PreferencesDialog.tsx` — add `'sla'` pane.
- `src/components/preferences/panes/SlaPane.tsx` — **new**: tier cards + priority overrides.
- `src/components/hplc/ServiceGroupsPage.tsx` — add SLA-tier dropdown to the editor.
- `locales/en.json` (+ `ar.json`, `fr.json`) — flat `preferences.sla.*` keys.
- `src/test/sla-resolver.test.ts` — rework → `resolveSlaTier`.

**Out of scope (this plan):** business-hours calendar (B), D2 column, labels/escalation, server-side `GET /sla/resolve` (YAGNI — D2 resolves client-side; add when a server flow needs it).

---

# PHASE 1 — Backend tier model (revises A)

### Task 1: Schema — ORM models + migration

**Files:**
- Modify: `backend/models.py` (replace `SlaTarget`; extend `ServiceGroup`)
- Modify: `backend/database.py` (`_run_migrations`)
- Test: `backend/tests/test_sla_schema.py` (rework)

- [ ] **Step 1: Rework the schema test (RED)**

Replace the entire contents of `backend/tests/test_sla_schema.py` with:

```python
"""Live-DB schema + seed tests for the SLA tier model (revises A).

Runs against the accumark_mk1 Postgres the backend is wired to. Verifies the
migration in database._run_migrations: sla_tiers + sla_priority_tiers exist,
service_groups has sla_tier_id, the default-tier seed is idempotent, and the
single-default partial index is present.

Run in the backend container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_sla_schema.py -q'
"""
from sqlalchemy import text

from database import _run_migrations, engine

_run_migrations()


def test_seed_default_tier_idempotent_when_run_twice():
    _run_migrations()
    _run_migrations()
    with engine.connect() as c:
        n = c.execute(
            text("SELECT count(*) FROM sla_tiers WHERE is_default")
        ).scalar()
    assert n == 1


def test_default_tier_encodes_old_24h_goal():
    with engine.connect() as c:
        row = c.execute(
            text("SELECT name, target_minutes FROM sla_tiers WHERE is_default")
        ).fetchone()
    assert row is not None
    name, target_minutes = row
    assert target_minutes == 1440


def test_sla_targets_table_dropped():
    with engine.connect() as c:
        exists = c.execute(
            text("SELECT to_regclass('public.sla_targets')")
        ).scalar()
    assert exists is None


def test_priority_tiers_table_and_service_group_column_exist():
    with engine.connect() as c:
        pt = c.execute(text("SELECT to_regclass('public.sla_priority_tiers')")).scalar()
        col = c.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='service_groups' AND column_name='sla_tier_id'"
            )
        ).fetchone()
    assert pt is not None
    assert col is not None


def test_single_default_partial_index_exists():
    with engine.connect() as c:
        rows = c.execute(
            text("SELECT indexname FROM pg_indexes WHERE tablename='sla_tiers'")
        ).fetchall()
    assert "uq_sla_tier_single_default" in {r[0] for r in rows}
```

- [ ] **Step 2: Run it — verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_sla_schema.py -q'`
Expected: FAIL — `sla_tiers` doesn't exist yet (and `sla_targets` still exists).

- [ ] **Step 3: Replace the migration block in `database.py`**

In `backend/database.py:_run_migrations`, find the `sla_targets` block (the `CREATE TABLE IF NOT EXISTS sla_targets …`, the four `uq_sla_*` indexes, and the seed `INSERT … sla_targets`) and replace those list entries with:

```python
        # ── SLA tiers (revises the former sla_targets model) ──
        # Drop the old per-(service,priority) model and its indexes.
        "DROP TABLE IF EXISTS sla_targets CASCADE",
        # Named SLA tier = a turnaround target. Referenced by service groups and
        # by the priority map. Raw DDL before create_all so the seed/index below
        # can run on first boot; the SlaTier ORM model maps the same table.
        """
        CREATE TABLE IF NOT EXISTS sla_tiers (
            id                  SERIAL PRIMARY KEY,
            name                VARCHAR(100) NOT NULL,
            target_minutes      INTEGER NOT NULL,
            business_hours_only BOOLEAN NOT NULL DEFAULT FALSE,
            is_default          BOOLEAN NOT NULL DEFAULT FALSE,
            created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        # At most one default (catch-all) tier.
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_tier_single_default ON sla_tiers (is_default) WHERE is_default",
        # Sparse priority -> tier override map. A row exists ONLY for priorities
        # that override; absence means "does not override".
        """
        CREATE TABLE IF NOT EXISTS sla_priority_tiers (
            priority    VARCHAR(20) PRIMARY KEY,
            sla_tier_id INTEGER NOT NULL REFERENCES sla_tiers(id) ON DELETE CASCADE,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        # Service groups reference a tier (NULL -> resolves to the default tier).
        "ALTER TABLE service_groups ADD COLUMN IF NOT EXISTS sla_tier_id INTEGER REFERENCES sla_tiers(id) ON DELETE SET NULL",
        # Seed the default tier = former hardcoded 24h goal. Idempotent.
        """
        INSERT INTO sla_tiers (name, target_minutes, business_hours_only, is_default, created_at, updated_at)
        SELECT 'Standard', 1440, FALSE, TRUE, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM sla_tiers WHERE is_default)
        """,
```

- [ ] **Step 4: Replace the `SlaTarget` model in `models.py`**

Replace the entire `class SlaTarget(Base): …` block with:

```python
class SlaTier(Base):
    """A named SLA turnaround target. Sub-project A (revised to tiers).

    Referenced by ServiceGroup.sla_tier_id and by SlaPriorityTier. Exactly one
    row has is_default=true (the catch-all, enforced by the partial unique index
    uq_sla_tier_single_default created in database._run_migrations).
    """

    __tablename__ = "sla_tiers"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    target_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    # Stored now; honored by the business-hours calendar in sub-project B.
    business_hours_only: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    def __repr__(self) -> str:
        return f"<SlaTier(id={self.id}, name='{self.name}', target_minutes={self.target_minutes})>"


class SlaPriorityTier(Base):
    """Sparse priority -> SLA tier override. A row exists only for priorities
    that override the group/default SLA (e.g. 'expedited'); 'normal' is normally
    absent. priority in {normal|high|expedited}."""

    __tablename__ = "sla_priority_tiers"

    priority: Mapped[str] = mapped_column(String(20), primary_key=True)
    sla_tier_id: Mapped[int] = mapped_column(
        ForeignKey("sla_tiers.id", ondelete="CASCADE"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    tier: Mapped["SlaTier"] = relationship("SlaTier")

    def __repr__(self) -> str:
        return f"<SlaPriorityTier(priority='{self.priority}', sla_tier_id={self.sla_tier_id})>"
```

- [ ] **Step 5: Add `sla_tier_id` to the `ServiceGroup` model**

In `class ServiceGroup(Base)`, after the `is_default` column add:

```python
    sla_tier_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("sla_tiers.id", ondelete="SET NULL"), nullable=True
    )
```

And after the `analysis_services` relationship add:

```python
    sla_tier: Mapped[Optional["SlaTier"]] = relationship("SlaTier")
```

- [ ] **Step 6: Restart backend and run the schema test (GREEN)**

Run:
```
docker restart accu-mk1-backend && sleep 3 && curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_sla_schema.py -q'
```
Expected: health OK; 5 passed. (If `accu-mk1-backend` fails to import — check the `SlaTarget` references in `main.py` will be fixed in Task 3; if startup errors on the import now, temporarily comment the SLA endpoint block — but prefer doing Task 3 before restarting for a live check. For this task, the schema test imports only `database`, which does not import `main`, so it passes independent of `main.py`.)

- [ ] **Step 7: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_sla_schema.py
git commit -m "feat(sla): replace sla_targets with sla_tiers + sla_priority_tiers + service_groups.sla_tier_id

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Engine — `resolve_sla_tier`

**Files:**
- Modify: `backend/sla_engine.py`
- Test: `backend/tests/test_sla_engine.py` (rework)

- [ ] **Step 1: Rework the engine test (RED)**

Replace the resolution tests in `backend/tests/test_sla_engine.py` with the block below. Keep the existing `compute_sla_status` tests unchanged (that function does not change). New top of file + resolution tests:

```python
"""Unit tests for the SLA tier resolution engine (A, revised to tiers).

Pure-function tests: resolve_sla_tier() takes the priority->tier map, the
service's group tier, the priority, and the default tier — no DB. The same
fixed-precedence chain runs server-side here and client-side in D2 (src/lib).
"""
from datetime import datetime, timedelta

from models import SlaTier
from sla_engine import compute_sla_status, resolve_sla_tier


def _tier(target_minutes=1440, *, name="t", is_default=False):
    return SlaTier(name=name, target_minutes=target_minutes, is_default=is_default)


DEFAULT = _tier(1440, name="Standard", is_default=True)
RUSH = _tier(240, name="Rush")
GROUP = _tier(2880, name="Microbiology")


# ── resolve_sla_tier: fixed precedence (priority override > group > default) ──

def test_priority_override_wins_over_group():
    pmap = {"expedited": RUSH}
    assert resolve_sla_tier(pmap, GROUP, "expedited", DEFAULT) is RUSH


def test_unmapped_priority_falls_to_group_tier():
    pmap = {"expedited": RUSH}  # 'normal' is not mapped
    assert resolve_sla_tier(pmap, GROUP, "normal", DEFAULT) is GROUP


def test_no_group_tier_falls_to_default():
    pmap = {"expedited": RUSH}
    assert resolve_sla_tier(pmap, None, "normal", DEFAULT) is DEFAULT


def test_none_priority_falls_to_group_then_default():
    pmap = {"expedited": RUSH}
    assert resolve_sla_tier(pmap, GROUP, None, DEFAULT) is GROUP
    assert resolve_sla_tier(pmap, None, None, DEFAULT) is DEFAULT


def test_empty_priority_map_uses_group_or_default():
    assert resolve_sla_tier({}, GROUP, "expedited", DEFAULT) is GROUP
    assert resolve_sla_tier({}, None, "expedited", DEFAULT) is DEFAULT


def test_returns_none_when_no_default_and_nothing_matches():
    assert resolve_sla_tier({}, None, "normal", None) is None
```

- [ ] **Step 2: Run it — verify it fails**

Run: `python -m pytest tests/test_sla_engine.py -q` (host, from `backend/`)
Expected: FAIL — `ImportError: cannot import name 'resolve_sla_tier'`.

- [ ] **Step 3: Replace `resolve_sla_target` with `resolve_sla_tier` in `sla_engine.py`**

Delete the `resolve_sla_target` function and its docstring; add:

```python
def resolve_sla_tier(
    priority_map: dict,
    group_tier: Optional[T],
    priority: Optional[str],
    default_tier: Optional[T],
) -> Optional[T]:
    """Resolve the effective SLA tier with fixed precedence.

    1. priority override — if ``priority`` has a row in ``priority_map`` -> that
       tier (per the lab's decision, priority beats the group SLA);
    2. else the service's ``group_tier`` (NULL = no tier on the group);
    3. else ``default_tier`` (the is_default tier, the 24h fallback).

    Sparsity contract: ``priority_map`` holds a row ONLY for priorities that
    override. An unmapped priority — including ``normal`` and ``None`` —
    ``.get()``s to None and falls through. Do not add a ``normal -> default``
    entry; it's operationally identical to no row.

    Returns None only if nothing matches and ``default_tier`` is None (the seed
    guarantees a default in production; this keeps the engine from raising).
    """
    prio_tier = priority_map.get(priority) if priority is not None else None
    if prio_tier is not None:
        return prio_tier
    if group_tier is not None:
        return group_tier
    return default_tier
```

Update the module docstring's "server-side flows … resolve_sla_target" line to reference `resolve_sla_tier`. Leave `compute_sla_status`, `PRIORITIES`, and the imports as-is.

- [ ] **Step 4: Run the engine tests (GREEN)**

Run: `python -m pytest tests/test_sla_engine.py -q`
Expected: PASS (resolution tests + the unchanged `compute_sla_status` tests).

- [ ] **Step 5: Commit**

```bash
git add backend/sla_engine.py backend/tests/test_sla_engine.py
git commit -m "feat(sla): resolve_sla_tier engine (priority override > group > default)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: SLA tier CRUD endpoints

**Files:**
- Modify: `backend/main.py` (imports, Pydantic schemas, endpoints)
- Test: `backend/tests/test_api_sla_targets.py` → rename to `test_api_sla_tiers.py`

- [ ] **Step 1: Fix imports in `main.py`**

- In the `from models import …` line: replace `SlaTarget` with `SlaTier, SlaPriorityTier`.
- Replace `from sla_engine import resolve_sla_target` with `from sla_engine import resolve_sla_tier`.

- [ ] **Step 2: Replace the SLA Pydantic schemas**

Replace the SLA target schema block (the `SlaPriority`, `SlaTargetCreate`, `SlaTargetUpdate`, `SlaTargetResponse` classes added in A) with:

```python
# ─── SLA tier schemas (sub-project A, revised to tiers) ───

# Priority tiers mirror SamplePriority/WorksheetItem.priority. Validated here at
# the API edge — the DB columns are unconstrained VARCHAR.
SlaPriority = Literal["normal", "high", "expedited"]


class SlaTierCreate(BaseModel):
    name: str
    target_minutes: int
    business_hours_only: bool = False
    is_default: bool = False


class SlaTierUpdate(BaseModel):
    name: Optional[str] = None
    target_minutes: Optional[int] = None
    business_hours_only: Optional[bool] = None
    is_default: Optional[bool] = None


class SlaTierResponse(BaseModel):
    id: int
    name: str
    target_minutes: int
    business_hours_only: bool
    is_default: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SlaPriorityTierResponse(BaseModel):
    priority: str
    sla_tier_id: int

    class Config:
        from_attributes = True


class SlaPriorityTierSet(BaseModel):
    sla_tier_id: int
```

- [ ] **Step 3: Rework the API test (RED)**

Rename `backend/tests/test_api_sla_targets.py` to `backend/tests/test_api_sla_tiers.py` (`git mv`) and replace contents with:

```python
"""API tests for /sla-tiers (sub-project A, revised to tiers).

Exercise CRUD + the always-one-default invariant against the live accumark_mk1
DB. Self-restoring: the autouse fixture deletes test-created tiers and
re-promotes the original default after each test.

Run in the backend container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_tiers.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _snapshot():
    with engine.connect() as c:
        return {
            r[0]: r[1]
            for r in c.execute(text("SELECT id, is_default FROM sla_tiers")).fetchall()
        }


@pytest.fixture(autouse=True)
def restore_sla_tiers():
    before = _snapshot()
    orig_default = next((i for i, d in before.items() if d), None)
    yield
    after = _snapshot()
    new_ids = [i for i in after if i not in before]
    with engine.begin() as c:
        if new_ids:
            c.execute(text("DELETE FROM sla_tiers WHERE id = ANY(:ids)"), {"ids": new_ids})
        if orig_default is not None:
            c.execute(text("UPDATE sla_tiers SET is_default = (id = :d)"), {"d": orig_default})


def test_list_returns_seeded_default():
    resp = client.get("/sla-tiers")
    assert resp.status_code == 200
    defaults = [r for r in resp.json() if r["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["target_minutes"] == 1440


def test_create_tier_returns_201():
    resp = client.post("/sla-tiers", json={"name": "Rush", "target_minutes": 240})
    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "Rush"
    assert resp.json()["target_minutes"] == 240


def test_create_default_demotes_previous_default():
    resp = client.post(
        "/sla-tiers", json={"name": "New default", "target_minutes": 720, "is_default": True}
    )
    assert resp.status_code == 201, resp.text
    new_id = resp.json()["id"]
    defaults = [r for r in client.get("/sla-tiers").json() if r["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["id"] == new_id


def test_cannot_delete_default():
    default_id = next(r["id"] for r in client.get("/sla-tiers").json() if r["is_default"])
    assert client.delete(f"/sla-tiers/{default_id}").status_code == 409


def test_cannot_unset_only_default():
    default_id = next(r["id"] for r in client.get("/sla-tiers").json() if r["is_default"])
    assert client.put(f"/sla-tiers/{default_id}", json={"is_default": False}).status_code == 409


def test_delete_non_default_tier():
    created = client.post("/sla-tiers", json={"name": "Temp", "target_minutes": 30}).json()
    assert client.delete(f"/sla-tiers/{created['id']}").status_code == 200
```

- [ ] **Step 4: Replace the endpoint block in `main.py`**

Replace the `/sla-targets` endpoint block (helper `_demote_other_defaults`, `list_sla_targets`, `resolve_sla_target_endpoint`, `create_sla_target`, `update_sla_target`, `delete_sla_target`) with:

```python
# ─── SLA tiers (sub-project A, revised to tiers) ──────────────────────────────


def _demote_other_default_tiers(db: Session, keep_id: Optional[int] = None) -> None:
    """Clear is_default on every tier except keep_id, flushing before the caller
    inserts/updates the promoted row (the partial unique index is immediate)."""
    q = db.query(SlaTier).filter(SlaTier.is_default == True)  # noqa: E712
    if keep_id is not None:
        q = q.filter(SlaTier.id != keep_id)
    q.update({"is_default": False})
    db.flush()


@app.get("/sla-tiers", response_model=list[SlaTierResponse])
async def list_sla_tiers(
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """All SLA tiers, default first. Consumed by the settings UI (C) and, cached,
    by D2 (which resolves client-side)."""
    return db.execute(
        select(SlaTier).order_by(SlaTier.is_default.desc(), SlaTier.name)
    ).scalars().all()


@app.post("/sla-tiers", response_model=SlaTierResponse, status_code=201)
async def create_sla_tier(
    data: SlaTierCreate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Create a tier. Setting is_default demotes any existing default."""
    tier = SlaTier(**data.model_dump())
    if tier.is_default:
        _demote_other_default_tiers(db)
    db.add(tier)
    db.commit()
    db.refresh(tier)
    return tier


@app.put("/sla-tiers/{tier_id}", response_model=SlaTierResponse)
async def update_sla_tier(
    tier_id: int,
    data: SlaTierUpdate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Update a tier. Promoting demotes the rest; demoting the only default is
    rejected (it's the 24h backstop for unmatched samples)."""
    tier = db.get(SlaTier, tier_id)
    if not tier:
        raise HTTPException(404, f"SLA tier {tier_id} not found")
    update_data = data.model_dump(exclude_unset=True)
    if "is_default" in update_data:
        if update_data["is_default"]:
            _demote_other_default_tiers(db, keep_id=tier_id)
        elif tier.is_default:
            raise HTTPException(
                409,
                "Cannot unset the only default SLA tier; set another as default instead",
            )
    for field, value in update_data.items():
        setattr(tier, field, value)
    db.commit()
    db.refresh(tier)
    return tier


@app.delete("/sla-tiers/{tier_id}")
async def delete_sla_tier(
    tier_id: int,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Delete a tier. The default cannot be deleted. Groups referencing it have
    sla_tier_id set NULL (FK); priority overrides referencing it cascade-delete."""
    tier = db.get(SlaTier, tier_id)
    if not tier:
        raise HTTPException(404, f"SLA tier {tier_id} not found")
    if tier.is_default:
        raise HTTPException(409, "Cannot delete the default SLA tier; promote another first")
    db.delete(tier)
    db.commit()
    return {"message": f"SLA tier {tier_id} deleted"}
```

- [ ] **Step 5: Restart and run the tier API tests (GREEN)**

Run:
```
docker restart accu-mk1-backend && sleep 3 && curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_tiers.py -q'
```
Expected: health OK; 6 passed. If backend won't boot, check the import edits in Step 1 and that no stray `SlaTarget`/`resolve_sla_target` reference remains: `grep -n "SlaTarget\b\|resolve_sla_target\b\|sla-targets" backend/main.py` should return nothing.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_api_sla_tiers.py
git rm --cached backend/tests/test_api_sla_targets.py 2>/dev/null || true
git commit -m "feat(sla): /sla-tiers CRUD with one-default invariant

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Priority → tier mapping endpoints

**Files:**
- Modify: `backend/main.py` (endpoints, after the tier block)
- Test: `backend/tests/test_api_sla_priority_tiers.py` (new)

- [ ] **Step 1: Write the API test (RED)**

Create `backend/tests/test_api_sla_priority_tiers.py`:

```python
"""API tests for /sla-priority-tiers (sparse priority -> tier map).

Self-restoring: deletes priority rows created during the test. Run in container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_priority_tiers.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _default_tier_id():
    with engine.connect() as c:
        return c.execute(text("SELECT id FROM sla_tiers WHERE is_default")).scalar()


@pytest.fixture(autouse=True)
def cleanup_priority_rows():
    with engine.connect() as c:
        before = {r[0] for r in c.execute(text("SELECT priority FROM sla_priority_tiers")).fetchall()}
    yield
    with engine.begin() as c:
        after = {r[0] for r in c.execute(text("SELECT priority FROM sla_priority_tiers")).fetchall()}
        new = list(after - before)
        if new:
            c.execute(text("DELETE FROM sla_priority_tiers WHERE priority = ANY(:p)"), {"p": new})


def test_list_empty_or_returns_rows():
    resp = client.get("/sla-priority-tiers")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_upsert_then_list_contains_mapping():
    tid = _default_tier_id()
    resp = client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tid})
    assert resp.status_code == 200, resp.text
    rows = {r["priority"]: r["sla_tier_id"] for r in client.get("/sla-priority-tiers").json()}
    assert rows.get("expedited") == tid


def test_upsert_is_idempotent_update():
    tid = _default_tier_id()
    client.put("/sla-priority-tiers/high", json={"sla_tier_id": tid})
    resp = client.put("/sla-priority-tiers/high", json={"sla_tier_id": tid})
    assert resp.status_code == 200


def test_invalid_priority_rejected():
    tid = _default_tier_id()
    assert client.put("/sla-priority-tiers/bogus", json={"sla_tier_id": tid}).status_code == 422


def test_delete_removes_override():
    tid = _default_tier_id()
    client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tid})
    assert client.delete("/sla-priority-tiers/expedited").status_code == 200
    rows = {r["priority"] for r in client.get("/sla-priority-tiers").json()}
    assert "expedited" not in rows
```

- [ ] **Step 2: Run it — verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_priority_tiers.py -q'`
Expected: FAIL — 404s (routes don't exist).

- [ ] **Step 3: Add the priority-tier endpoints in `main.py`**

After the `delete_sla_tier` endpoint, add:

```python
@app.get("/sla-priority-tiers", response_model=list[SlaPriorityTierResponse])
async def list_sla_priority_tiers(
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """The sparse priority -> tier override map (only overriding priorities)."""
    return db.execute(select(SlaPriorityTier)).scalars().all()


@app.put("/sla-priority-tiers/{priority}", response_model=SlaPriorityTierResponse)
async def set_sla_priority_tier(
    priority: SlaPriority,
    data: SlaPriorityTierSet,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Upsert a priority -> tier override."""
    if not db.get(SlaTier, data.sla_tier_id):
        raise HTTPException(404, f"SLA tier {data.sla_tier_id} not found")
    row = db.get(SlaPriorityTier, priority)
    if row:
        row.sla_tier_id = data.sla_tier_id
    else:
        row = SlaPriorityTier(priority=priority, sla_tier_id=data.sla_tier_id)
        db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.delete("/sla-priority-tiers/{priority}")
async def delete_sla_priority_tier(
    priority: SlaPriority,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Remove a priority override (that priority falls back to group/default)."""
    row = db.get(SlaPriorityTier, priority)
    if not row:
        raise HTTPException(404, f"No override for priority '{priority}'")
    db.delete(row)
    db.commit()
    return {"message": f"Priority override '{priority}' removed"}
```

- [ ] **Step 4: Restart and run (GREEN)**

Run:
```
docker restart accu-mk1-backend && sleep 3 && curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_sla_priority_tiers.py -q'
```
Expected: health OK; 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_api_sla_priority_tiers.py
git commit -m "feat(sla): /sla-priority-tiers sparse priority->tier map

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Service groups reference a tier

**Files:**
- Modify: `backend/main.py` (`ServiceGroupCreate/Update/Response`, `create_service_group`, `update_service_group`)
- Test: `backend/tests/test_api_service_group_sla_tier.py` (new)

- [ ] **Step 1: Write the test (RED)**

Create `backend/tests/test_api_service_group_sla_tier.py`:

```python
"""Service groups carry an sla_tier_id (sub-project C). Self-restoring.

Run in container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_service_group_sla_tier.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _default_tier_id():
    with engine.connect() as c:
        return c.execute(text("SELECT id FROM sla_tiers WHERE is_default")).scalar()


@pytest.fixture(autouse=True)
def cleanup_groups():
    with engine.connect() as c:
        before = {r[0] for r in c.execute(text("SELECT id FROM service_groups")).fetchall()}
    yield
    with engine.begin() as c:
        after = {r[0] for r in c.execute(text("SELECT id FROM service_groups")).fetchall()}
        new = list(after - before)
        if new:
            c.execute(text("DELETE FROM service_groups WHERE id = ANY(:i)"), {"i": new})


def test_create_group_with_sla_tier():
    tid = _default_tier_id()
    resp = client.post(
        "/service-groups",
        json={"name": "Microbiology Test", "sla_tier_id": tid},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["sla_tier_id"] == tid


def test_update_group_sla_tier_and_clear():
    tid = _default_tier_id()
    gid = client.post("/service-groups", json={"name": "Grp X"}).json()["id"]
    assert client.put(f"/service-groups/{gid}", json={"sla_tier_id": tid}).json()["sla_tier_id"] == tid
    assert client.put(f"/service-groups/{gid}", json={"sla_tier_id": None}).json()["sla_tier_id"] is None
```

- [ ] **Step 2: Run it — verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_service_group_sla_tier.py -q'`
Expected: FAIL — `sla_tier_id` not accepted/returned (KeyError or 422 or value None on create).

- [ ] **Step 3: Add `sla_tier_id` to the ServiceGroup schemas**

In `main.py`: add `sla_tier_id: Optional[int] = None` to both `ServiceGroupCreate` and `ServiceGroupUpdate`, and `sla_tier_id: Optional[int] = None` to `ServiceGroupResponse`.

- [ ] **Step 4: Include `sla_tier_id` in the service-group responses**

In `create_service_group` and `update_service_group`, the `ServiceGroupResponse(...)` constructions add the field. Add to each `ServiceGroupResponse(` call:

```python
        sla_tier_id=group.sla_tier_id,
```

(`group = ServiceGroup(**data.model_dump())` in create already persists `sla_tier_id`; update's `for field, value in update_data.items(): setattr(...)` already applies it. Also add `sla_tier_id=group.sla_tier_id,` to the `get_service_groups` list response construction so the list endpoint returns it.)

- [ ] **Step 5: Restart and run (GREEN)**

Run:
```
docker restart accu-mk1-backend && sleep 3 && curl -fsS http://localhost:8012/health
docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_service_group_sla_tier.py tests/test_sla_engine.py tests/test_sla_schema.py tests/test_api_sla_tiers.py tests/test_api_sla_priority_tiers.py -q'
```
Expected: health OK; all pass. Also run one pre-existing route test to confirm no regression: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_peptide_requests_read.py -q'` → 7 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_api_service_group_sla_tier.py
git commit -m "feat(sla): service groups reference an SLA tier (sla_tier_id)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# PHASE 2 — Frontend (sub-project C UI)

### Task 6: API client + TS resolver

**Files:**
- Modify: `src/lib/api.ts` (replace SLA block; add `sla_tier_id` to `ServiceGroup*`)
- Test: `src/test/sla-resolver.test.ts` (rework)

- [ ] **Step 1: Rework the resolver test (RED)**

Replace `src/test/sla-resolver.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveSlaTier, type SlaTier } from '@/lib/api'

// Parity with backend/tests/test_sla_engine.py — keep the two resolvers in
// lockstep. Precedence: priority override > group tier > default.

function tier(target_minutes: number, partial: Partial<SlaTier> = {}): SlaTier {
  return {
    id: 0, name: 't', target_minutes,
    business_hours_only: false, is_default: false,
    created_at: '', updated_at: '', ...partial,
  }
}

const DEFAULT = tier(1440, { id: 1, name: 'Standard', is_default: true })
const RUSH = tier(240, { id: 2, name: 'Rush' })
const GROUP = tier(2880, { id: 3, name: 'Microbiology' })

describe('resolveSlaTier — priority override > group > default', () => {
  it('priority override wins over group', () => {
    expect(resolveSlaTier({ expedited: RUSH }, GROUP, 'expedited', DEFAULT)).toBe(RUSH)
  })
  it('unmapped priority falls to group', () => {
    expect(resolveSlaTier({ expedited: RUSH }, GROUP, 'normal', DEFAULT)).toBe(GROUP)
  })
  it('no group tier falls to default', () => {
    expect(resolveSlaTier({ expedited: RUSH }, null, 'normal', DEFAULT)).toBe(DEFAULT)
  })
  it('null priority falls to group then default', () => {
    expect(resolveSlaTier({ expedited: RUSH }, GROUP, null, DEFAULT)).toBe(GROUP)
    expect(resolveSlaTier({ expedited: RUSH }, null, null, DEFAULT)).toBe(DEFAULT)
  })
  it('returns null when nothing matches and no default', () => {
    expect(resolveSlaTier({}, null, 'normal', null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-resolver.test.ts'`
Expected: FAIL — `resolveSlaTier` / `SlaTier` not exported.

- [ ] **Step 3: Replace the SLA block in `api.ts`**

Replace the entire "SLA Targets (sub-project A)" block (the `SlaTarget`/`SlaTargetCreate`/`SlaTargetUpdate` interfaces, `getSlaTargets`/`createSlaTarget`/`updateSlaTarget`/`deleteSlaTarget`, and `resolveSlaTarget`) with:

```typescript
// ─── SLA tiers (sub-project A revised + C) ──────────────────────────────────

export interface SlaTier {
  id: number
  name: string
  target_minutes: number
  business_hours_only: boolean
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface SlaTierCreate {
  name: string
  target_minutes: number
  business_hours_only?: boolean
  is_default?: boolean
}

export interface SlaTierUpdate {
  name?: string
  target_minutes?: number
  business_hours_only?: boolean
  is_default?: boolean
}

export interface SlaPriorityTier {
  priority: InboxPriority
  sla_tier_id: number
}

export async function getSlaTiers(): Promise<SlaTier[]> {
  const response = await fetch(`${API_BASE_URL()}/sla-tiers`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`Failed to load SLA tiers: ${response.status}`)
  return response.json()
}

export async function createSlaTier(data: SlaTierCreate): Promise<SlaTier> {
  const response = await fetch(`${API_BASE_URL()}/sla-tiers`, {
    method: 'POST', headers: getBearerHeaders('application/json'), body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to create SLA tier: ${response.status}`)
  return response.json()
}

export async function updateSlaTier(id: number, data: SlaTierUpdate): Promise<SlaTier> {
  const response = await fetch(`${API_BASE_URL()}/sla-tiers/${id}`, {
    method: 'PUT', headers: getBearerHeaders('application/json'), body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to update SLA tier: ${response.status}`)
  return response.json()
}

export async function deleteSlaTier(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/sla-tiers/${id}`, {
    method: 'DELETE', headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to delete SLA tier: ${response.status}`)
}

export async function getSlaPriorityTiers(): Promise<SlaPriorityTier[]> {
  const response = await fetch(`${API_BASE_URL()}/sla-priority-tiers`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`Failed to load priority overrides: ${response.status}`)
  return response.json()
}

export async function setSlaPriorityTier(priority: InboxPriority, slaTierId: number): Promise<SlaPriorityTier> {
  const response = await fetch(`${API_BASE_URL()}/sla-priority-tiers/${priority}`, {
    method: 'PUT', headers: getBearerHeaders('application/json'), body: JSON.stringify({ sla_tier_id: slaTierId }),
  })
  if (!response.ok) throw new Error(`Failed to set priority override: ${response.status}`)
  return response.json()
}

export async function deleteSlaPriorityTier(priority: InboxPriority): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/sla-priority-tiers/${priority}`, {
    method: 'DELETE', headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to remove priority override: ${response.status}`)
}

/**
 * Client-side SLA resolution — TS mirror of the Python resolve_sla_tier.
 * Precedence: priority override > group tier > default. priorityMap is sparse
 * (a key exists only for overriding priorities). D2 caches getSlaTiers() +
 * getSlaPriorityTiers() and resolves per sample here. Keep in lockstep with
 * backend/sla_engine.py.
 */
export function resolveSlaTier(
  priorityMap: Partial<Record<InboxPriority, SlaTier>>,
  groupTier: SlaTier | null,
  priority: InboxPriority | null,
  defaultTier: SlaTier | null
): SlaTier | null {
  const prioTier = priority ? priorityMap[priority] : undefined
  if (prioTier) return prioTier
  if (groupTier) return groupTier
  return defaultTier
}
```

- [ ] **Step 4: Add `sla_tier_id` to the ServiceGroup interfaces**

In `api.ts`, add `sla_tier_id: number | null` to `interface ServiceGroup`, and `sla_tier_id?: number | null` to both `ServiceGroupCreate` and `ServiceGroupUpdate`.

- [ ] **Step 5: Run the resolver test + typecheck (GREEN)**

Run:
```
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-resolver.test.ts'
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: 5 passed; typecheck clean. Lint changed file: `./node_modules/.bin/eslint src/lib/api.ts src/test/sla-resolver.test.ts` — no NEW errors (ignore the 3 baseline).

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/test/sla-resolver.test.ts
git commit -m "feat(sla): tier API client + resolveSlaTier TS resolver

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: TanStack Query service hooks

**Files:**
- Create: `src/services/sla.ts`

- [ ] **Step 1: Create the service hooks**

Create `src/services/sla.ts` (mirrors `src/services/preferences.ts`, but HTTP via `api.ts`):

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getSlaTiers, createSlaTier, updateSlaTier, deleteSlaTier,
  getSlaPriorityTiers, setSlaPriorityTier, deleteSlaPriorityTier,
  type SlaTier, type SlaTierCreate, type SlaTierUpdate, type InboxPriority,
} from '@/lib/api'

export const slaQueryKeys = {
  tiers: ['sla', 'tiers'] as const,
  priorityTiers: ['sla', 'priority-tiers'] as const,
}

export function useSlaTiers() {
  return useQuery({ queryKey: slaQueryKeys.tiers, queryFn: getSlaTiers, staleTime: 1000 * 60 * 5 })
}

export function useSlaPriorityTiers() {
  return useQuery({ queryKey: slaQueryKeys.priorityTiers, queryFn: getSlaPriorityTiers, staleTime: 1000 * 60 * 5 })
}

export function useCreateSlaTier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: SlaTierCreate) => createSlaTier(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: slaQueryKeys.tiers }); toast.success('SLA tier created') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateSlaTier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: SlaTierUpdate }) => updateSlaTier(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: slaQueryKeys.tiers }); toast.success('SLA tier saved') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteSlaTier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteSlaTier(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: slaQueryKeys.tiers }); toast.success('SLA tier deleted') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSetPriorityTier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ priority, slaTierId }: { priority: InboxPriority; slaTierId: number }) =>
      setSlaPriorityTier(priority, slaTierId),
    onSuccess: () => qc.invalidateQueries({ queryKey: slaQueryKeys.priorityTiers }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeletePriorityTier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (priority: InboxPriority) => deleteSlaPriorityTier(priority),
    onSuccess: () => qc.invalidateQueries({ queryKey: slaQueryKeys.priorityTiers }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export type { SlaTier }
```

- [ ] **Step 2: Typecheck (GREEN)**

Run: `npm --prefix /c/tmp/accu-mk1-wave1 run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/sla.ts
git commit -m "feat(sla): TanStack Query hooks for tiers + priority overrides

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: i18n keys

**Files:**
- Modify: `locales/en.json` (+ `ar.json`, `fr.json`)

- [ ] **Step 1: Add flat keys to `locales/en.json`**

Add these key/value pairs (flat keys, matching the existing `preferences.*` convention):

```json
  "preferences.sla": "SLAs",
  "preferences.sla.tiers": "SLA Tiers",
  "preferences.sla.tiersDescription": "Turnaround targets. Services inherit their group's tier; priorities can override.",
  "preferences.sla.addTier": "Add SLA",
  "preferences.sla.name": "Name",
  "preferences.sla.target": "Target",
  "preferences.sla.hours": "hours",
  "preferences.sla.minutes": "minutes",
  "preferences.sla.businessHoursOnly": "Only during business hours",
  "preferences.sla.businessHoursHint": "Takes effect once the business-hours calendar ships.",
  "preferences.sla.default": "Default",
  "preferences.sla.priorityOverrides": "Priority overrides",
  "preferences.sla.priorityOverridesDescription": "Map a priority to a tier. A mapped priority overrides the service group's SLA. Unmapped priorities use the group/default.",
  "preferences.sla.noOverride": "No override",
  "preferences.sla.readOnly": "You have read-only access to SLA settings."
```

Add the same keys with English values (or translations if known) to `ar.json` and `fr.json` so lookups don't miss; react-i18next falls back to the key otherwise.

- [ ] **Step 2: Verify JSON parses**

Run: `node -e "require('./locales/en.json'); require('./locales/ar.json'); require('./locales/fr.json'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add locales/en.json locales/ar.json locales/fr.json
git commit -m "feat(sla): i18n keys for the SLA preferences pane

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: SLA preferences pane

**Files:**
- Create: `src/components/preferences/panes/SlaPane.tsx`
- Modify: `src/components/preferences/PreferencesDialog.tsx`

- [ ] **Step 1: Create `SlaPane.tsx`**

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useSlaTiers, useSlaPriorityTiers, useCreateSlaTier, useUpdateSlaTier,
  useDeleteSlaTier, useSetPriorityTier, useDeletePriorityTier,
} from '@/services/sla'
import type { SlaTier } from '@/lib/api'

const OVERRIDABLE: Array<'high' | 'expedited'> = ['high', 'expedited']

function minutesToHM(m: number) {
  return { hours: Math.floor(m / 60), minutes: m % 60 }
}

export function SlaPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const tiersQuery = useSlaTiers()
  const prioQuery = useSlaPriorityTiers()
  const createTier = useCreateSlaTier()
  const updateTier = useUpdateSlaTier()
  const deleteTier = useDeleteSlaTier()
  const setPrio = useSetPriorityTier()
  const delPrio = useDeletePriorityTier()

  const tiers = tiersQuery.data ?? []
  const sorted = [...tiers].sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name))
  const prioMap = new Map((prioQuery.data ?? []).map(p => [p.priority, p.sla_tier_id]))

  if (tiersQuery.isLoading) {
    return <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">{t('preferences.sla.readOnly')}</p>
      )}

      <SettingsSection title={t('preferences.sla.tiers')}>
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{t('preferences.sla.tiersDescription')}</p>
          {isAdmin && (
            <Button size="sm" onClick={() => createTier.mutate({ name: 'New tier', target_minutes: 1440 })}>
              <Plus className="mr-1 h-4 w-4" /> {t('preferences.sla.addTier')}
            </Button>
          )}
        </div>
        <div className="space-y-3">
          {sorted.map(tier => (
            <TierCard
              key={tier.id}
              tier={tier}
              readOnly={!isAdmin}
              onSave={(data) => updateTier.mutate({ id: tier.id, data })}
              onDelete={() => deleteTier.mutate(tier.id)}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('preferences.sla.priorityOverrides')}>
        <p className="text-sm text-muted-foreground">{t('preferences.sla.priorityOverridesDescription')}</p>
        <div className="space-y-2">
          {OVERRIDABLE.map(priority => (
            <div key={priority} className="flex items-center gap-3">
              <span className="w-24 text-sm capitalize">{priority}</span>
              <Select
                disabled={!isAdmin}
                value={prioMap.has(priority) ? String(prioMap.get(priority)) : 'none'}
                onValueChange={(v) =>
                  v === 'none' ? delPrio.mutate(priority) : setPrio.mutate({ priority, slaTierId: Number(v) })
                }
              >
                <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('preferences.sla.noOverride')}</SelectItem>
                  {tiers.map(ti => (
                    <SelectItem key={ti.id} value={String(ti.id)}>{ti.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </SettingsSection>
    </div>
  )
}

function TierCard({
  tier, readOnly, onSave, onDelete,
}: {
  tier: SlaTier
  readOnly: boolean
  onSave: (data: { name: string; target_minutes: number; business_hours_only: boolean }) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const hm = minutesToHM(tier.target_minutes)
  const [name, setName] = useState(tier.name)
  const [hours, setHours] = useState(String(hm.hours))
  const [minutes, setMinutes] = useState(String(hm.minutes))
  const [bh, setBh] = useState(tier.business_hours_only)

  const commit = () => {
    if (readOnly) return
    const total = (parseInt(hours, 10) || 0) * 60 + (parseInt(minutes, 10) || 0)
    onSave({ name: name.trim() || tier.name, target_minutes: total, business_hours_only: bh })
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Input
            className="h-8 w-48 font-medium" value={name} disabled={readOnly}
            onChange={e => setName(e.target.value)} onBlur={commit}
          />
          {tier.is_default && <Badge variant="outline" className="text-[10px]">{t('preferences.sla.default')}</Badge>}
        </div>
        {!readOnly && !tier.is_default && (
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('preferences.sla.target')}:</span>
        <Input className="h-8 w-16" type="number" min={0} value={hours} disabled={readOnly}
          onChange={e => setHours(e.target.value)} onBlur={commit} />
        <span className="text-muted-foreground">{t('preferences.sla.hours')}</span>
        <Input className="h-8 w-16" type="number" min={0} max={59} value={minutes} disabled={readOnly}
          onChange={e => setMinutes(e.target.value)} onBlur={commit} />
        <span className="text-muted-foreground">{t('preferences.sla.minutes')}</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={bh} disabled={readOnly} onCheckedChange={(v) => { setBh(v); if (!readOnly) onSave({ name: name.trim() || tier.name, target_minutes: (parseInt(hours,10)||0)*60+(parseInt(minutes,10)||0), business_hours_only: v }) }} />
        <span className="text-sm">{t('preferences.sla.businessHoursOnly')}</span>
        <span className="text-xs text-muted-foreground">— {t('preferences.sla.businessHoursHint')}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the pane into `PreferencesDialog.tsx`**

- Add to the icon import: `import { Settings, Palette, Zap, Database, Timer } from 'lucide-react'`.
- Add `import { SlaPane } from './panes/SlaPane'`.
- Extend the type: `type PreferencePane = 'general' | 'appearance' | 'dataPipeline' | 'sla' | 'advanced'`.
- Add to `navigationItems` (before `advanced`):
  ```typescript
  { id: 'sla' as const, labelKey: 'preferences.sla', icon: Timer },
  ```
- Add to the render block:
  ```tsx
  {activePane === 'sla' && <SlaPane />}
  ```

- [ ] **Step 3: Restart frontend, typecheck, manual verify**

Run:
```
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
docker restart accu-mk1-frontend
```
Then verify on `:3101`: open Preferences (the SLAs nav item appears), confirm the default "Standard" tier card shows 24h with a Default badge and disabled delete, "Add SLA" creates a card, editing hours/minutes + blur persists (toast), and the priority overrides dropdowns list tiers. (Use Playwright MCP: `browser_navigate http://localhost:3101`, open Preferences via the command palette / menu, `browser_snapshot`.) Lint: `./node_modules/.bin/eslint src/components/preferences/panes/SlaPane.tsx src/components/preferences/PreferencesDialog.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/components/preferences/panes/SlaPane.tsx src/components/preferences/PreferencesDialog.tsx
git commit -m "feat(sla): SLA settings pane (tier cards + priority overrides)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: SLA-tier dropdown on the Service Groups page

**Files:**
- Modify: `src/components/hplc/ServiceGroupsPage.tsx`

- [ ] **Step 1: Add `sla_tier_id` to FormState + DEFAULT_FORM**

- Add `sla_tier_id: string` to `interface FormState`.
- Add `sla_tier_id: ''` to `DEFAULT_FORM`.

- [ ] **Step 2: Load tiers + seed/clear the field**

- Add imports: `getSlaTiers, type SlaTier` from `@/lib/api`, and the `Select*` components from `@/components/ui/select`.
- Add state: `const [tiers, setTiers] = useState<SlaTier[]>([])`.
- In `loadGroups` (or a new `useEffect`), fetch tiers once: in the existing initial `useEffect`, also call `getSlaTiers().then(setTiers).catch(() => {})`.
- In `openEdit`'s `setForm({...})`, add: `sla_tier_id: group.sla_tier_id != null ? String(group.sla_tier_id) : '',`.

- [ ] **Step 3: Include `sla_tier_id` in the save payload**

In `handleSave`'s `payload`, add:

```typescript
        sla_tier_id: form.sla_tier_id ? Number(form.sla_tier_id) : null,
```

- [ ] **Step 4: Add the dropdown to the form**

In the slide-out panel, after the Description field block, add:

```tsx
                {/* SLA tier */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">SLA tier</label>
                  <Select
                    value={form.sla_tier_id || 'default'}
                    onValueChange={v =>
                      setForm(f => ({ ...f, sla_tier_id: v === 'default' ? '' : v }))
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Use default SLA</SelectItem>
                      {tiers.map(ti => (
                        <SelectItem key={ti.id} value={String(ti.id)}>{ti.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
```

- [ ] **Step 5: Typecheck, restart, manual verify**

Run:
```
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
docker restart accu-mk1-frontend
```
Verify on `:3101`: Service Groups → edit "Microbiology" → set its SLA tier to a longer tier → save → reopen → the dropdown retains the selection; "Core HPLC" left on "Use default SLA". Lint: `./node_modules/.bin/eslint src/components/hplc/ServiceGroupsPage.tsx` (ignore pre-existing baseline).

- [ ] **Step 6: Commit**

```bash
git add src/components/hplc/ServiceGroupsPage.tsx
git commit -m "feat(sla): SLA-tier dropdown on the Service Groups editor

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Backend suite (container): `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_sla_engine.py tests/test_sla_schema.py tests/test_api_sla_tiers.py tests/test_api_sla_priority_tiers.py tests/test_api_service_group_sla_tier.py -q'` → all pass.
- [ ] No stray old references: `grep -rn "sla_targets\|SlaTarget\b\|resolve_sla_target\b\|sla-targets\|resolveSlaTarget\|SlaTargetCreate" backend/ src/` → nothing (except the 2026-05-26 spec history).
- [ ] Frontend: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-resolver.test.ts src/test/explorer-helpers.test.ts src/test/order-row.test.tsx'` → all pass; `npm run typecheck` clean.
- [ ] Existing route regression: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_api_peptide_requests_read.py -q'` → 7 passed.
- [ ] `gitnexus_detect_changes()` before final push (additive/replacement on a feature branch; index targets the OneDrive checkout — note in commit if it reports nothing).
- [ ] Push: `git push origin feat/order-status-processing-time`.

## Self-review notes (done while writing)

- **Spec coverage:** sla_tiers + sla_priority_tiers + service_groups.sla_tier_id (Task 1); resolution precedence (Task 2); migration/drop (Task 1); tier CRUD + one-default invariant (Task 3); sparse priority map (Task 4); group→tier (Task 5); SLA pane with tier cards + priority overrides + read-only (Task 9); Service Groups dropdown (Task 10); TS resolver parity + hours/minutes input (Tasks 6, 9); i18n (Task 8); TanStack data layer (Task 7). The server-side `GET /sla/resolve` is intentionally omitted (YAGNI — noted).
- **Type consistency:** `resolve_sla_tier(priority_map, group_tier, priority, default_tier)` ↔ `resolveSlaTier(priorityMap, groupTier, priority, defaultTier)`; `SlaTier`/`SlaPriorityTier` shapes match the Pydantic responses; `sla_tier_id` is `number | null` everywhere on the wire.
- **Open assumption for the executor:** D2 (later) is what actually *calls* `resolveSlaTier` per sample; this plan ships the resolver + data but not the column.
