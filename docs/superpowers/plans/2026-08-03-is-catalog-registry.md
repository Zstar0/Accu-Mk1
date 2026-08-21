# IS Catalog Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Integration Service's hand-maintained `NATIVE_SERVICE_KEYS` deploy-per-family bottleneck with a declared-key registry synced from Mk1's analysis-profiles catalog — persisted, refreshed on a schedule, never blocking an order on Mk1 being up, and never shrinking below the hardcoded boot floor.

**Architecture:** Three moving parts. (1) Mk1 gains one read-only S2S endpoint `GET /s2s/catalog/service-keys` returning EVERY `analysis_profiles.key` (active or not — recognition ≠ salability). (2) IS gains a `catalog_registry` module: module-memory working set consulted synchronously by both existing check sites via `known_service_keys()`, hydrated at startup from a new `catalog_registry_state` singleton row (mirroring `wc_sync_state`), refreshed by jobs on the existing APScheduler singleton (startup fetch with bounded retry + hourly), with a 2s-timeout live-fetch hook on the order path that fires only when an order carries an unknown key. (3) NEVER-SHRINK discipline: only a well-formed non-empty fetch replaces the set; empty `{"keys": []}` is a failure; the worst case is exactly today's behavior (the frozenset floor).

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy 2.0 async (IS) / sync (Mk1), alembic (IS only — Mk1 has none), APScheduler, httpx, pytest (`asyncio_mode=auto`), ruff + mypy (IS gate).

**Source spec:** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-08-03-is-catalog-registry-design.md`

## Global Constraints

- **Additive only.** `NATIVE_SERVICE_KEYS` is NOT deleted — it becomes the boot floor. `SampleServices` keeps `extra="allow"`. Both check sites keep their exact semantics (submit path records `validation_failed`; `/order-services-updated` returns HTTP 400) — only the SET they consult changes.
- **The registry answers "is this key real?", never "is this key sellable?"** The sync ingests every profile key regardless of `analysis_profiles.active`. Anyone filtering on `active` turns a bench-side checkbox into a money-path order rejector. This gets an explicit test + comment on BOTH sides, citing the spec.
- **Never shrink on failure.** A failed or empty fetch must not clear or reduce the stored/memory key set. `{"keys": []}` is treated as a failed sync. This is the most dangerous failure mode and has its own tests.
- **Never block startup or an order on Mk1.** Startup fetch is fire-and-forget on the scheduler with bounded retry; the live fetch uses a 2s adapter timeout, trips its fallback on timeout AND error, and a live-fetch failure is a warning, never a rejection.
- **TDD is enforced:** failing test → watch it fail for the right reason → implement → green → commit.
- **IS gates:** `pytest` (default excludes smoke via `addopts`), plus `ruff check . && mypy app` — both must be clean vs the Task-1 baseline. IS test-suite health on a clean tree is RECORDED in Task 1, not assumed.
- **Mk1 gate is the failure-set diff vs baseline, NEVER zero-failures** (~64 pre-existing).
- **Registry module state is process-global.** Every test that mutates it MUST reset via `reset_for_tests()` (autouse fixture in the new test files) or it will poison `tests/unit/test_native_service_keys.py` and `tests/unit/test_order_services_updated.py` in a full-suite run. Those two existing files are the ONLY existing tests touching `KNOWN_SERVICE_KEYS`; with an empty synced set the union equals the old constant, so they must pass UNCHANGED — any edit to them is a red flag.
- **Worktrees:**
  - Mk1: `C:\tmp\Accu-Mk1-catalog-s2s`, branch `feat/s2s-catalog-keys`, based on `feat/native-spec-ownership` @ `ccd9847` (keeps the program's PR chain linear: #91 → #93 → this).
  - IS: `C:\tmp\is-catalog-registry`, branch `feat/catalog-registry`, based on `feat/catalog-order-routing` @ `5cabb6f` (stacks on IS PR #20). The existing worktree `C:\tmp\is-order-routing` stays untouched.
- **Venvs:** Mk1 backend `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe`. IS: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\integration-service\.venv\Scripts\python.exe` (verify in Task 1; if absent, locate the IS venv before proceeding — do not pip-install a new one).
- **Commit footer** (every commit): `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Deploy order (for PR bodies only — nothing deploys now): Mk1 first, then IS.** IS-first is inert (404 → failed sync → boot floor = today); Mk1-first means the first sync succeeds. Rollback = clear the stored row's `service_keys` (no image revert). Attaches to the ONE combined deploy window.
- **Spec-interpretation note (live fetch), decided here:** the live fetch fires ONLY when an order carries a key not in the current union — "a key already cached passes either way" means cached-key orders never fetch and can never be affected by a fetch failure. An unknown key whose live fetch times out falls through to the cache-based decision (rejection), which is exactly today's behavior for a typo. The spec's "3 attempts at roughly 10s/30s/60s" startup retry is implemented as attempt-immediately then retries after 10s/30s/60s sleeps (4 attempts total, bounded — covers the stated timings).
- **ruff config:** line-length 100, py311 target. mypy runs over `app` — annotate all new code fully.

## File Structure

**Mk1** (`C:\tmp\Accu-Mk1-catalog-s2s`):
- Modify: `backend/main.py` — one new GET route beside the other S2S routes (`/s2s/lims-samples` block is at `main.py:19274`).
- Test: `backend/tests/test_s2s_catalog_keys.py` (new; idiom from `backend/tests/test_coa_sections_endpoint.py`).

**IS** (`C:\tmp\is-catalog-registry`):
- Modify: `app/models/persistence.py` — `CatalogRegistryState` singleton model directly after `WCSyncState` (ends ~line 330).
- Create: `migrations/versions/w1x2y3z4a5b6_add_catalog_registry_state.py` — down_revision `v0w1x2y3z4a5`.
- Modify: `app/adapters/accumk1.py` — one new GET method.
- Create: `app/services/catalog_registry.py` — module state, `known_service_keys()`, `is_floor_only()`, hydrate, sync (never-shrink), live-fetch hook, scheduler job coroutines.
- Modify: `app/services/order_validator.py` — `_service_extras_errors` consults `known_service_keys()`; `KNOWN_SERVICE_KEYS` constant kept as the documented floor.
- Modify: `app/api/webhook.py` — `/order-services-updated` consults `known_service_keys()` after `await ensure_keys_known(...)`.
- Modify: `app/services/order_processor.py` — `process()` awaits `ensure_keys_known` before `self.validator.validate(order)` (line 339).
- Modify: `app/services/wc_reconcile_scheduler.py` — registers the two catalog jobs on the existing singleton.
- Modify: `app/main.py` — lifespan hydrates the registry from DB immediately before `start_scheduler()`.
- Modify: `app/api/admin.py` — `POST /admin/refresh-catalog` mirroring `/reconcile-customers` (409 on lock contention + TOCTOU translate).
- Test: `tests/unit/test_catalog_registry.py` (new — the spec's test-plan core).
- Test: `tests/unit/test_catalog_registry_wiring.py` (new — check sites, live-fetch hook, admin route, scheduler registration).
- Test: `tests/unit/test_accumk1_adapter.py` (extend — new method, mirroring its existing `patch("httpx.AsyncClient.get")` idiom).

---

### Task 1: Worktrees + baselines

**Files:** none — setup only.

**Interfaces:**
- Consumes: local branches `feat/native-spec-ownership` (Mk1 @ `ccd9847`) and `feat/catalog-order-routing` (IS @ `5cabb6f`).
- Produces: both worktrees; Mk1 baseline at `C:\tmp\Accu-Mk1-catalog-s2s\.superpowers\sdd\2026-08-03-is-catalog-registry\mk1-baseline-failures.txt`; IS baselines at `C:\tmp\is-catalog-registry\.superpowers\sdd\2026-08-03-is-catalog-registry\` (`is-baseline-failures.txt`, `is-ruff-baseline.txt`, `is-mypy-baseline.txt`). Every later verify step diffs against these.

- [ ] **Step 1: Create both worktrees**

```bash
git -C "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1" worktree add /c/tmp/Accu-Mk1-catalog-s2s -b feat/s2s-catalog-keys feat/native-spec-ownership
git -C /c/tmp/is-order-routing worktree add /c/tmp/is-catalog-registry -b feat/catalog-registry feat/catalog-order-routing
git -C /c/tmp/Accu-Mk1-catalog-s2s log --oneline -1     # expect ccd9847
git -C /c/tmp/is-catalog-registry log --oneline -1      # expect 5cabb6f
```

- [ ] **Step 2: Verify the IS venv, record IS baselines (clean tree)**

```bash
ls "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe"
```

If that path does not exist, STOP and report BLOCKED naming what you found in `/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/` — do not create a venv.

```bash
mkdir -p /c/tmp/is-catalog-registry/.superpowers/sdd/2026-08-03-is-catalog-registry
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest -q 2>&1 | grep -E "^FAILED|^ERROR" | sed 's/ - .*//' | sort > .superpowers/sdd/2026-08-03-is-catalog-registry/is-baseline-failures.txt; wc -l .superpowers/sdd/2026-08-03-is-catalog-registry/is-baseline-failures.txt
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m ruff check . 2>&1 | tail -3 > .superpowers/sdd/2026-08-03-is-catalog-registry/is-ruff-baseline.txt; cat .superpowers/sdd/2026-08-03-is-catalog-registry/is-ruff-baseline.txt
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m mypy app 2>&1 | tail -3 > .superpowers/sdd/2026-08-03-is-catalog-registry/is-mypy-baseline.txt; cat .superpowers/sdd/2026-08-03-is-catalog-registry/is-mypy-baseline.txt
```

Record the observed counts in your report — these ARE the baseline, whatever they say. (The full-suite pytest run may take a few minutes; use a 600000 ms timeout.)

- [ ] **Step 3: Record the Mk1 baseline (clean tree)**

```bash
mkdir -p /c/tmp/Accu-Mk1-catalog-s2s/.superpowers/sdd/2026-08-03-is-catalog-registry
cd /c/tmp/Accu-Mk1-catalog-s2s/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > /c/tmp/Accu-Mk1-catalog-s2s/.superpowers/sdd/2026-08-03-is-catalog-registry/mk1-baseline-failures.txt
wc -l /c/tmp/Accu-Mk1-catalog-s2s/.superpowers/sdd/2026-08-03-is-catalog-registry/mk1-baseline-failures.txt   # expect ~64
```

---

### Task 2: Mk1 — `GET /s2s/catalog/service-keys`

**Files:**
- Modify: `backend/main.py` (insert the route directly ABOVE the `/s2s/lims-samples` block at `main.py:19274`, inside the same S2S section)
- Test: `backend/tests/test_s2s_catalog_keys.py` (new)

**Interfaces:**
- Consumes: `require_internal_service_token` (`backend/auth.py:137` — X-Service-Token, timing-safe, 401 on mismatch, 500 when env unset), `models.AnalysisProfile`, `get_db`.
- Produces: `{"keys": [<sorted str>...], "generated_at": "<iso8601>Z"}` — all `analysis_profiles.key` rows, active or not. Task 4's IS adapter calls this.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_s2s_catalog_keys.py`:

```python
"""GET /s2s/catalog/service-keys — the IS catalog-registry feed.

Ships EVERY analysis_profiles.key, active or not, ON PURPOSE (IS
catalog-registry spec 2026-08-03: the registry answers "is this key real?",
never "is this key sellable?" — sale gating is WordPress's job, and
analysis_profiles.active means retired-from-the-bench, with fulfilment of
already-sold orders continuing). A future reader "fixing" this into an
active-only filter turns a bench checkbox into a money-path order rejector.

Fixture idiom copied from test_coa_sections_endpoint.py (StaticPool
in-memory SQLite + get_db override; ACCUMK1_INTERNAL_SERVICE_TOKEN set
per-test via patch.dict for run-order determinism).
"""
import os
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from database import get_db, Base

SVC_TOKEN = "test-internal-token"
SVC_TOKEN_HEADER = {"X-Service-Token": SVC_TOKEN}
URL = "/s2s/catalog/service-keys"


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db


def _mk_profile(db, key, *, active=True):
    from models import AnalysisProfile
    db.add(AnalysisProfile(key=key, name=key.title(), is_addon=True, active=active))
    db.flush()


def test_requires_service_token(client, db_session):
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get(URL)
    assert r.status_code == 401


def test_wrong_token_rejected(client, db_session):
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get(URL, headers={"X-Service-Token": "nope"})
    assert r.status_code == 401


def test_returns_all_keys_sorted_including_inactive(client, db_session):
    _mk_profile(db_session, "heavy_metals", active=True)
    _mk_profile(db_session, "sterility_usp71", active=False)   # deactivated: MUST still ship
    _mk_profile(db_session, "endotoxin", active=True)
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get(URL, headers=SVC_TOKEN_HEADER)
    assert r.status_code == 200
    body = r.json()
    assert body["keys"] == ["endotoxin", "heavy_metals", "sterility_usp71"]
    assert body["generated_at"].endswith("Z")


def test_empty_catalog_returns_empty_list(client, db_session):
    # Mk1 reports honestly; the IS side is what treats an empty list as a
    # suspect sync (never-shrink) — that guard lives there, not here.
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.get(URL, headers=SVC_TOKEN_HEADER)
    assert r.status_code == 200
    assert r.json()["keys"] == []
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/Accu-Mk1-catalog-s2s/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_s2s_catalog_keys.py -q
```

Expected: 4 failures with 404 status codes (route does not exist yet).

- [ ] **Step 3: Implement the route**

In `backend/main.py`, directly above the `# ── Registry creation signal (integration-service bridge) ─...` comment block that precedes `@app.post("/s2s/lims-samples", ...)` (`main.py:~19270`), insert:

```python
@app.get("/s2s/catalog/service-keys")
def s2s_catalog_service_keys(
    db: Session = Depends(get_db),
    _: None = Depends(require_internal_service_token),
):
    """Declared service-key catalog for the Integration Service registry
    sync (IS catalog-registry spec 2026-08-03). Ships EVERY profile key,
    active or not, ON PURPOSE: the registry answers "is this key real?",
    never "is this key sellable?" — analysis_profiles.active means retired
    from the bench (fulfilment of sold orders continues), and sale gating
    belongs to WordPress. Do NOT filter on active. Read-only, no pagination
    (the catalog is single-digit rows).
    """
    from models import AnalysisProfile

    keys = sorted(k for (k,) in db.execute(select(AnalysisProfile.key)).all())
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {"keys": keys, "generated_at": generated_at}
```

Before writing, verify `select`, `datetime`, `timezone`, `Session`, `Depends`, `get_db`, and `require_internal_service_token` are already imported at the top of `main.py` (they are used by neighboring routes); add any that are genuinely missing to the existing import lines. The `from models import AnalysisProfile` local import matches the ambient S2S-handler convention.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /c/tmp/Accu-Mk1-catalog-s2s/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_s2s_catalog_keys.py -q
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-catalog-s2s && git add backend/main.py backend/tests/test_s2s_catalog_keys.py && git commit -m "feat(s2s): catalog service-keys feed for the IS registry sync

Every analysis_profiles.key ships, active or not — recognition is not
salability; sale gating stays in WordPress. Read-only, token-guarded like
the other S2S routes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: IS — `CatalogRegistryState` model + alembic migration

**Files:**
- Modify: `app/models/persistence.py` (insert after `WCSyncState.__repr__`, ~line 330; mirror its style)
- Create: `migrations/versions/w1x2y3z4a5b6_add_catalog_registry_state.py`
- Test: `tests/unit/test_catalog_registry.py` (new file started here with the model-shape test; later tasks append)

**Interfaces:**
- Consumes: existing `Base`, `CheckConstraint`, `JSONB`, `func` imports in persistence.py (all already imported for `WCSyncState`).
- Produces: `CatalogRegistryState` with columns `id, service_keys, last_sync_at, last_sync_outcome, last_sync_error, key_count, updated_at`. Tasks 5+ import it. **Semantics contract:** `last_sync_at` = last SUCCESSFUL sync; failures touch only `last_sync_outcome`/`last_sync_error`/`updated_at`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/test_catalog_registry.py`:

```python
"""Catalog registry: model shape, resolution union, never-shrink, hydrate,
live-fetch hook (IS catalog-registry spec 2026-08-03).

Registry state is process-global (module memory) — the autouse fixture
resets it around every test so this file can never poison
test_native_service_keys.py / test_order_services_updated.py in a
full-suite run.
"""
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.fixture(autouse=True)
def _reset_registry_state():
    from app.services import catalog_registry
    catalog_registry.reset_for_tests()
    yield
    catalog_registry.reset_for_tests()


# =============================================================================
# Model shape
# =============================================================================


def test_catalog_registry_state_is_a_singleton_model():
    from app.models.persistence import CatalogRegistryState

    assert CatalogRegistryState.__tablename__ == "catalog_registry_state"
    check_names = {
        c.name
        for c in CatalogRegistryState.__table__.constraints
        if type(c).__name__ == "CheckConstraint"
    }
    assert "catalog_registry_state_singleton" in check_names
    cols = set(CatalogRegistryState.__table__.columns.keys())
    assert cols == {
        "id", "service_keys", "last_sync_at", "last_sync_outcome",
        "last_sync_error", "key_count", "updated_at",
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry.py -q
```

Expected: ImportError twice — `reset_for_tests` (module doesn't exist yet — the fixture import fails; that's the expected red for now, note it) and `CatalogRegistryState`. To keep this task self-contained, temporarily expect the collection error and confirm the failure names `catalog_registry`; the fixture's module lands in Task 5 — for THIS task, make the fixture import lazy-tolerant is NOT allowed; instead, create the minimal placeholder module now:

Create `app/services/catalog_registry.py` with ONLY:

```python
"""Declared service-key registry synced from Mk1's catalog (spec 2026-08-03).

Populated across tasks: Task 3 ships this stub so the test module imports;
Task 5 adds the real state + sync machinery.
"""
from __future__ import annotations


def reset_for_tests() -> None:
    """Reset module state between tests. Real state arrives in Task 5."""
```

Re-run: expected failure is now exactly `ImportError: cannot import name 'CatalogRegistryState'`.

- [ ] **Step 3: Add the model**

In `app/models/persistence.py`, directly after `WCSyncState.__repr__`:

```python
class CatalogRegistryState(Base):
    """Mk1 catalog-registry sync state — singleton (CHECK id=1).

    Mirrors WCSyncState's shape. service_keys is the synced declared-key
    list (NULL until the first successful sync). last_sync_at is the last
    SUCCESSFUL sync — failed syncs touch only last_sync_outcome /
    last_sync_error / updated_at (never-shrink rule: a failure must not
    clear or reduce the stored set). key_count is a cheap drift signal.

    IS catalog-registry spec 2026-08-03.
    """

    __tablename__ = "catalog_registry_state"
    __table_args__ = (
        CheckConstraint("id = 1", name="catalog_registry_state_singleton"),
        {"comment": "Mk1 catalog registry sync state — singleton (CHECK id=1)"},
    )

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False)
    service_keys: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    last_sync_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_sync_outcome: Mapped[str | None] = mapped_column(String, nullable=True)
    last_sync_error: Mapped[str | None] = mapped_column(String, nullable=True)
    key_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<CatalogRegistryState(id={self.id}, key_count={self.key_count}, "
            f"last_sync_at={self.last_sync_at}, outcome={self.last_sync_outcome})>"
        )
```

(All names — `CheckConstraint`, `SmallInteger`, `JSONB`, `DateTime`, `String`, `Integer`, `func`, `Mapped`, `mapped_column`, `datetime` — are already imported at the top of persistence.py for `WCSyncState`; verify, add only what's genuinely missing.)

- [ ] **Step 4: Create the migration**

Create `migrations/versions/w1x2y3z4a5b6_add_catalog_registry_state.py`:

```python
"""Add catalog_registry_state singleton.

Declared-service-key registry synced from Mk1 (IS catalog-registry spec
2026-08-03). Singleton row (CHECK id = 1) mirroring wc_sync_state.
service_keys stays NULL until the first successful sync; last_sync_at is
the last SUCCESSFUL sync — failures write outcome/error only (never-shrink).
Additive; safe to apply online. Applied manually in production per the
existing deploy discipline.

Revision ID: w1x2y3z4a5b6
Revises: v0w1x2y3z4a5
Create Date: 2026-08-03
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "w1x2y3z4a5b6"
down_revision: Union[str, None] = "v0w1x2y3z4a5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "catalog_registry_state",
        sa.Column("id", sa.SmallInteger(), primary_key=True, autoincrement=False),
        sa.Column("service_keys", JSONB(), nullable=True),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sync_outcome", sa.String(), nullable=True),
        sa.Column("last_sync_error", sa.String(), nullable=True),
        sa.Column("key_count", sa.Integer(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="catalog_registry_state_singleton"),
        comment="Mk1 catalog registry sync state — singleton (CHECK id=1)",
    )


def downgrade() -> None:
    op.drop_table("catalog_registry_state")
```

Confirm the down_revision matches the current head first: `grep -l "down_revision" migrations/versions/v0w1x2y3z4a5_add_is_regular_coa_to_coa_generations.py` exists and no other file already revises `v0w1x2y3z4a5` (`grep -rl 'Revises: v0w1x2y3z4a5' migrations/versions/`). If another head exists, STOP and report BLOCKED with what you found.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry.py -q
```

Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
cd /c/tmp/is-catalog-registry && git add app/models/persistence.py app/services/catalog_registry.py migrations/versions/w1x2y3z4a5b6_add_catalog_registry_state.py tests/unit/test_catalog_registry.py && git commit -m "feat(catalog-registry): catalog_registry_state singleton model + migration

Mirrors wc_sync_state. last_sync_at records the last SUCCESSFUL sync;
failures write outcome/error only — the never-shrink rule's storage half.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: IS — adapter method `get_catalog_service_keys`

**Files:**
- Modify: `app/adapters/accumk1.py` (append the method to `AccuMk1Adapter`)
- Test: `tests/unit/test_accumk1_adapter.py` (append; mirror its existing `patch("httpx.AsyncClient.get")` idiom — read the file's existing GET tests first and copy their fake-response construction exactly)

**Interfaces:**
- Consumes: `self.base_url`, `self._headers()`, `self.timeout` (adapter ctor accepts `timeout_seconds` — Task 6's live fetch passes 2).
- Produces: `async get_catalog_service_keys() -> dict[str, Any]` returning the parsed JSON body; HTTP errors propagate via `raise_for_status` (the caller treats ANY exception as a failed sync).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/test_accumk1_adapter.py` (match the file's existing fake-response helper; if it builds `MagicMock` responses inline, do the same):

```python
@pytest.mark.asyncio
async def test_get_catalog_service_keys_request_shape():
    adapter = AccuMk1Adapter(base_url="http://mk1", service_token="tok")
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {"keys": ["heavy_metals"], "generated_at": "2026-08-03T00:00:00Z"}
    fake_response.raise_for_status = MagicMock()
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=fake_response)) as mock_get:
        body = await adapter.get_catalog_service_keys()
    assert body["keys"] == ["heavy_metals"]
    args, kwargs = mock_get.call_args
    assert args[0] == "http://mk1/s2s/catalog/service-keys"
    assert kwargs["headers"]["X-Service-Token"] == "tok"


@pytest.mark.asyncio
async def test_get_catalog_service_keys_raises_on_http_error():
    adapter = AccuMk1Adapter(base_url="http://mk1", service_token="tok")
    fake_500 = MagicMock()
    fake_500.status_code = 500
    fake_500.raise_for_status = MagicMock(
        side_effect=httpx.HTTPStatusError("boom", request=MagicMock(), response=MagicMock())
    )
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=fake_500)):
        with pytest.raises(httpx.HTTPStatusError):
            await adapter.get_catalog_service_keys()
```

(Adjust imports at the top of the test file only if `httpx`/`AsyncMock`/`MagicMock`/`patch`/`pytest` are not already imported — they are used by the existing tests.)

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_accumk1_adapter.py -q
```

Expected: the two new tests fail with `AttributeError: ... has no attribute 'get_catalog_service_keys'`; all existing tests still pass.

- [ ] **Step 3: Implement the method**

Append to `AccuMk1Adapter` in `app/adapters/accumk1.py` (match the file's existing GET-method style — read one first):

```python
    async def get_catalog_service_keys(self) -> dict[str, Any]:
        """Fetch the declared service-key catalog (GET /s2s/catalog/service-keys).

        Returns the raw {"keys": [...], "generated_at": ...} body. HTTP errors
        propagate via raise_for_status — the registry sync treats ANY exception
        as a failed sync (never-shrink handles the rest).
        """
        url = f"{self.base_url}/s2s/catalog/service-keys"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            return response.json()
```

- [ ] **Step 4: Run the adapter tests**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_accumk1_adapter.py -q
```

Expected: all pass (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/is-catalog-registry && git add app/adapters/accumk1.py tests/unit/test_accumk1_adapter.py && git commit -m "feat(catalog-registry): adapter read for the Mk1 service-key catalog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: IS — `catalog_registry` core (state, union, never-shrink sync, hydrate)

**Files:**
- Modify: `app/services/catalog_registry.py` (replace the Task-3 stub with the full module)
- Test: `tests/unit/test_catalog_registry.py` (append)

**Interfaces:**
- Consumes: `_LEGACY_FIELD_NAMES`, `_LEGACY_ALIASES`, `NATIVE_SERVICE_KEYS` from `app.services.order_validator` (import direction: catalog_registry → order_validator, never the reverse at module level); `AccuMk1Adapter`; `CatalogRegistryState`.
- Produces (Tasks 6-8 consume): `known_service_keys() -> frozenset[str]` (sync, cheap — the working set), `is_floor_only(key) -> bool`, `synced_keys()`, `get_catalog_sync_lock()`, `reset_for_tests()`, `async load_registry_from_db(db)`, `async sync_catalog_registry(db, adapter=None) -> dict` (raises `RuntimeError("catalog_sync_in_progress")` on lock contention — mirrors `run_reconcile`'s TOCTOU contract), `async ensure_keys_known(candidate_keys, db)`, `LIVE_FETCH_TIMEOUT_SECONDS = 2`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/test_catalog_registry.py`:

```python
# =============================================================================
# Fakes
# =============================================================================


class _FakeRegistryDb:
    """Minimal AsyncSession stub for the singleton-row read/write path."""

    def __init__(self, row=None):
        self.row = row
        self.commits = 0

    async def get(self, model, pk):
        return self.row

    def add(self, obj):
        self.row = obj

    async def commit(self):
        self.commits += 1


def _fake_adapter(payload=None, exc=None):
    adapter = SimpleNamespace()
    if exc is not None:
        adapter.get_catalog_service_keys = AsyncMock(side_effect=exc)
    else:
        adapter.get_catalog_service_keys = AsyncMock(return_value=payload)
    return adapter


# =============================================================================
# Resolution union
# =============================================================================


def test_boot_floor_without_any_sync_equals_legacy_constant():
    # Empty DB + Mk1 unreachable == today's behavior, exactly.
    from app.services.catalog_registry import known_service_keys
    from app.services.order_validator import KNOWN_SERVICE_KEYS

    assert known_service_keys() == KNOWN_SERVICE_KEYS


def test_legacy_alias_stays_in_union():
    from app.services.catalog_registry import known_service_keys

    assert "hplcpurity&identity" in known_service_keys()
    assert "rapidsterilityscreening(pcr)" in known_service_keys()


def test_synced_keys_join_the_union():
    from app.services import catalog_registry

    catalog_registry._set_synced({"sterility_usp71"}, datetime.now(UTC))
    assert "sterility_usp71" in catalog_registry.known_service_keys()
    # Floor keys survive alongside:
    assert "heavy_metals" in catalog_registry.known_service_keys()


def test_is_floor_only_flags_unsynced_hardcoded_key():
    from app.services import catalog_registry

    # heavy_metals is in NATIVE_SERVICE_KEYS but not synced -> floor-only.
    assert catalog_registry.is_floor_only("heavy_metals") is True
    catalog_registry._set_synced({"heavy_metals"}, datetime.now(UTC))
    assert catalog_registry.is_floor_only("heavy_metals") is False
    # A pydantic field name is never floor-only.
    assert catalog_registry.is_floor_only("endotoxin") is False


def test_staleness_warning_after_24h(caplog):
    from app.services import catalog_registry

    catalog_registry._set_synced({"k"}, datetime.now(UTC) - timedelta(hours=25))
    with caplog.at_level("WARNING"):
        catalog_registry.known_service_keys()
    assert "catalog_registry_stale" in caplog.text


def test_no_staleness_warning_when_never_synced(caplog):
    from app.services import catalog_registry

    with caplog.at_level("WARNING"):
        catalog_registry.known_service_keys()
    assert "catalog_registry_stale" not in caplog.text


# =============================================================================
# Sync: replace on success, NEVER SHRINK on failure/empty
# =============================================================================


async def test_successful_sync_replaces_memory_and_persists_row():
    from app.services import catalog_registry
    from app.models.persistence import CatalogRegistryState

    db = _FakeRegistryDb()
    adapter = _fake_adapter(payload={"keys": ["heavy_metals", "sterility_usp71"],
                                     "generated_at": "2026-08-03T00:00:00Z"})
    result = await catalog_registry.sync_catalog_registry(db, adapter=adapter)

    assert result["outcome"] == "ok" and result["key_count"] == 2
    assert catalog_registry.synced_keys() == frozenset({"heavy_metals", "sterility_usp71"})
    assert isinstance(db.row, CatalogRegistryState)
    assert db.row.service_keys == ["heavy_metals", "sterility_usp71"]
    assert db.row.key_count == 2
    assert db.row.last_sync_outcome == "ok"
    assert db.row.last_sync_at is not None
    assert db.commits == 1


async def test_failed_sync_never_shrinks_and_records_failure():
    from app.services import catalog_registry

    catalog_registry._set_synced({"sterility_usp71"}, datetime.now(UTC))
    db = _FakeRegistryDb()
    adapter = _fake_adapter(exc=RuntimeError("mk1 down"))
    result = await catalog_registry.sync_catalog_registry(db, adapter=adapter)

    assert result["outcome"] == "failed"
    assert catalog_registry.synced_keys() == frozenset({"sterility_usp71"})   # unchanged
    assert db.row.last_sync_outcome == "failed"
    assert db.row.service_keys is None          # failure never wrote keys
    assert db.row.last_sync_at is None          # last_sync_at = last SUCCESS only


async def test_empty_keys_is_treated_as_failure():
    # The single most dangerous failure mode: an empty catalog would reject
    # every native order. {"keys": []} must be SUSPECT, not applied.
    from app.services import catalog_registry

    catalog_registry._set_synced({"sterility_usp71"}, datetime.now(UTC))
    db = _FakeRegistryDb()
    adapter = _fake_adapter(payload={"keys": [], "generated_at": "x"})
    result = await catalog_registry.sync_catalog_registry(db, adapter=adapter)

    assert result["outcome"] == "failed"
    assert catalog_registry.synced_keys() == frozenset({"sterility_usp71"})


async def test_malformed_payload_is_treated_as_failure():
    from app.services import catalog_registry

    db = _FakeRegistryDb()
    adapter = _fake_adapter(payload={"keys": "not-a-list"})
    result = await catalog_registry.sync_catalog_registry(db, adapter=adapter)
    assert result["outcome"] == "failed"
    assert catalog_registry.synced_keys() == frozenset()


async def test_concurrent_sync_raises_lock_contention():
    from app.services import catalog_registry

    async with catalog_registry.get_catalog_sync_lock():
        with pytest.raises(RuntimeError, match="catalog_sync_in_progress"):
            await catalog_registry.sync_catalog_registry(_FakeRegistryDb(), adapter=_fake_adapter(payload={"keys": ["x"]}))


# =============================================================================
# Hydrate (startup fallback step 2)
# =============================================================================


async def test_hydrate_loads_last_known_good():
    from app.services import catalog_registry
    from app.models.persistence import CatalogRegistryState

    row = CatalogRegistryState(id=1, service_keys=["new_family"],
                               last_sync_at=datetime.now(UTC))
    await catalog_registry.load_registry_from_db(_FakeRegistryDb(row=row))
    # The restart-while-Mk1-down case persistence exists for:
    assert "new_family" in catalog_registry.known_service_keys()


async def test_hydrate_with_no_row_leaves_floor_in_force():
    from app.services import catalog_registry
    from app.services.order_validator import KNOWN_SERVICE_KEYS

    await catalog_registry.load_registry_from_db(_FakeRegistryDb(row=None))
    assert catalog_registry.known_service_keys() == KNOWN_SERVICE_KEYS


# =============================================================================
# Live-fetch hook (order path)
# =============================================================================


async def test_ensure_keys_known_noops_when_all_known(monkeypatch):
    from app.services import catalog_registry

    called = AsyncMock()
    monkeypatch.setattr(catalog_registry, "sync_catalog_registry", called)
    await catalog_registry.ensure_keys_known({"heavy_metals", "endotoxin"}, _FakeRegistryDb())
    called.assert_not_awaited()


async def test_ensure_keys_known_fetches_for_unknown_key(monkeypatch):
    from app.services import catalog_registry

    async def _fake_sync(db, adapter=None):
        catalog_registry._set_synced({"brand_new_family"}, datetime.now(UTC))
        return {"outcome": "ok", "key_count": 1}

    monkeypatch.setattr(catalog_registry, "sync_catalog_registry", _fake_sync)
    await catalog_registry.ensure_keys_known({"brand_new_family"}, _FakeRegistryDb())
    assert "brand_new_family" in catalog_registry.known_service_keys()


async def test_ensure_keys_known_swallows_timeout_with_warning(monkeypatch, caplog):
    # The bug people write in this pattern: the fallback must trip on
    # TIMEOUT, not only on connection error — and it must never raise.
    import httpx
    from app.services import catalog_registry

    async def _timeout_sync(db, adapter=None):
        raise httpx.TimeoutException("slow")

    monkeypatch.setattr(catalog_registry, "sync_catalog_registry", _timeout_sync)
    with caplog.at_level("WARNING"):
        await catalog_registry.ensure_keys_known({"who_dis"}, _FakeRegistryDb())
    assert "catalog_live_fetch_failed" in caplog.text


async def test_ensure_keys_known_skips_quietly_on_lock_contention(monkeypatch):
    from app.services import catalog_registry

    async def _contended(db, adapter=None):
        raise RuntimeError("catalog_sync_in_progress")

    monkeypatch.setattr(catalog_registry, "sync_catalog_registry", _contended)
    await catalog_registry.ensure_keys_known({"who_dis"}, _FakeRegistryDb())   # must not raise
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry.py -q
```

Expected: the new tests fail with AttributeError/ImportError on the stub module (`known_service_keys` etc. missing); the Task-3 model test still passes.

- [ ] **Step 3: Implement the full module**

Replace `app/services/catalog_registry.py` with:

```python
"""Declared service-key registry synced from Mk1's catalog (spec 2026-08-03).

Resolution order — the union NEVER shrinks below the boot floor:

    pydantic field names ∪ pydantic aliases ∪ NATIVE_SERVICE_KEYS (floor)
                        ∪ synced catalog keys

The synced set lives in module memory so the (synchronous) check sites in
order_validator/webhook can consult it without I/O, and is persisted in
catalog_registry_state so a restart does not require Mk1 to be reachable.

NEVER-SHRINK: only a well-formed NON-EMPTY fetch replaces the set. A fetch
returning {"keys": []} is treated as a failed sync — an empty catalog is far
more likely a bug than a real state, and applying it would reject every
native order.

The registry answers "is this key real?", never "is this key sellable?" —
the sync ingests EVERY profile key regardless of analysis_profiles.active.
Sale gating belongs to WordPress; Mk1's active flag means retired-from-the-
bench with fulfilment of sold orders continuing. Do NOT "fix" this by
filtering on active (see the deactivated-profile tests + the spec's top
design decision).

Import direction: this module imports the floor pieces from order_validator;
order_validator must never import this module at module level (its check
site uses a function-local import).
"""
from __future__ import annotations

import asyncio
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.accumk1 import AccuMk1Adapter
from app.models.persistence import CatalogRegistryState
from app.observability import get_logger
from app.services.order_validator import (
    _LEGACY_ALIASES,
    _LEGACY_FIELD_NAMES,
    NATIVE_SERVICE_KEYS,
)

logger = get_logger(__name__)

_synced_keys: frozenset[str] = frozenset()
_synced_at: Optional[datetime] = None
_lock: asyncio.Lock = asyncio.Lock()  # module-level — admin route + jobs share this instance

_STALE_AFTER = timedelta(hours=24)
# Checkout-webhook budget for the order-path live fetch; the adapter's 15s
# default is unacceptable there.
LIVE_FETCH_TIMEOUT_SECONDS = 2


def get_catalog_sync_lock() -> asyncio.Lock:
    """Shared lock between scheduler jobs and the admin manual-trigger route
    (mirrors wc_reconcile_scheduler.get_reconcile_lock)."""
    return _lock


def synced_keys() -> frozenset[str]:
    return _synced_keys


def known_service_keys() -> frozenset[str]:
    """The working set both check sites consult. Warns when serving from a
    synced cache older than 24h (the scheduler-died signal); a never-synced
    registry is the boot floor, which is not staleness."""
    if _synced_at is not None and datetime.now(timezone.utc) - _synced_at > _STALE_AFTER:
        logger.warning("catalog_registry_stale", synced_at=_synced_at.isoformat())
    return _LEGACY_FIELD_NAMES | _LEGACY_ALIASES | NATIVE_SERVICE_KEYS | _synced_keys


def is_floor_only(key: str) -> bool:
    """True when a key passes ONLY because of the NATIVE_SERVICE_KEYS floor —
    the sync has not seen a key the code still hardcodes. The post-deploy
    drift signal worth watching."""
    return (
        key in NATIVE_SERVICE_KEYS
        and key not in _LEGACY_FIELD_NAMES
        and key not in _LEGACY_ALIASES
        and key not in _synced_keys
    )


def _set_synced(keys: Iterable[str], at: datetime) -> None:
    global _synced_keys, _synced_at
    _synced_keys = frozenset(keys)
    _synced_at = at


def reset_for_tests() -> None:
    """Reset module state between tests (registry state is process-global)."""
    global _synced_keys, _synced_at
    _synced_keys = frozenset()
    _synced_at = None


async def load_registry_from_db(db: AsyncSession) -> None:
    """Startup hydrate — fallback step 2 (last known good). Never raises: a
    missing or empty row leaves the boot floor in force."""
    try:
        row = await db.get(CatalogRegistryState, 1)
    except Exception as e:
        logger.warning("catalog_registry_hydrate_failed", error=str(e)[:200])
        return
    if row is not None and row.service_keys:
        _set_synced(row.service_keys, row.last_sync_at or datetime.now(timezone.utc))
        logger.info("catalog_registry_hydrated", key_count=len(row.service_keys))


async def sync_catalog_registry(
    db: AsyncSession, adapter: AccuMk1Adapter | None = None
) -> dict[str, Any]:
    """One sync pass. Replaces memory + the stored row ONLY on a well-formed
    non-empty key list; anything else records a failed sync and changes no
    keys. Raises RuntimeError on lock contention (mirrors run_reconcile's
    TOCTOU contract — callers translate to 409 or skip)."""
    if _lock.locked():
        raise RuntimeError("catalog_sync_in_progress")
    async with _lock:
        live_adapter = adapter if adapter is not None else AccuMk1Adapter()
        now = datetime.now(timezone.utc)
        try:
            payload = await live_adapter.get_catalog_service_keys()
            keys = payload.get("keys") if isinstance(payload, dict) else None
            if (
                not isinstance(keys, list)
                or not keys
                or not all(isinstance(k, str) for k in keys)
            ):
                raise ValueError(f"suspect catalog payload (keys={keys!r})")
        except Exception as e:
            logger.warning("catalog_sync_failed", reason=str(e)[:200])
            await _write_state(db, ok=False, error=str(e)[:500], at=now, keys=None)
            return {"outcome": "failed", "error": str(e)[:200]}
        clean = sorted(set(keys))
        _set_synced(clean, now)
        await _write_state(db, ok=True, error=None, at=now, keys=clean)
        logger.info("catalog_sync_ok", key_count=len(clean))
        return {"outcome": "ok", "key_count": len(clean)}


async def _write_state(
    db: AsyncSession,
    *,
    ok: bool,
    error: Optional[str],
    at: datetime,
    keys: Optional[list[str]],
) -> None:
    row = await db.get(CatalogRegistryState, 1)
    if row is None:
        row = CatalogRegistryState(id=1)
        db.add(row)
    row.last_sync_outcome = "ok" if ok else "failed"
    row.last_sync_error = error
    if ok:
        row.service_keys = keys
        row.key_count = len(keys) if keys is not None else None
        row.last_sync_at = at
    await db.commit()


async def ensure_keys_known(candidate_keys: Iterable[str], db: AsyncSession) -> None:
    """Order-path freshness hook: when an order carries a key not in the
    union, attempt ONE sync with a 2s adapter timeout, then return — the
    caller's cache-based check decides either way. EVERY failure (timeout
    included) is a warning, never a rejection; a success opportunistically
    refreshes memory + the stored row. Orders whose keys are all known never
    trigger a fetch at all."""
    unknown = [k for k in candidate_keys if k not in known_service_keys()]
    if not unknown:
        return
    try:
        await sync_catalog_registry(
            db, adapter=AccuMk1Adapter(timeout_seconds=LIVE_FETCH_TIMEOUT_SECONDS)
        )
    except RuntimeError:
        logger.info("catalog_live_fetch_skipped_lock_contention", unknown=unknown)
    except Exception as e:
        # Defense-in-depth: sync_catalog_registry already catches fetch
        # failures internally; this guards the adapter CONSTRUCTOR and any
        # future refactor — the order path must never raise from here.
        logger.warning("catalog_live_fetch_failed", error=str(e)[:200], unknown=unknown)
```

- [ ] **Step 4: Run the registry tests, then the two guarded legacy files**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry.py tests/unit/test_native_service_keys.py tests/unit/test_order_services_updated.py -q
```

Expected: all pass — the legacy files UNCHANGED and green (empty synced set ⇒ union == old constant).

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/is-catalog-registry && git add app/services/catalog_registry.py tests/unit/test_catalog_registry.py && git commit -m "feat(catalog-registry): registry core — union, never-shrink sync, hydrate, live-fetch hook

Boot floor preserved (worst case == today); empty or malformed fetch is a
failed sync that changes no keys; staleness warns at 24h; floor-only
acceptance is the post-deploy drift signal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: IS — check sites consult the registry + order-path live fetch

**Files:**
- Modify: `app/services/order_validator.py:465-488` (`_service_extras_errors`) and the `KNOWN_SERVICE_KEYS` docstring block at :154-168
- Modify: `app/api/webhook.py` (~:24 import, ~:1188-1206 check site)
- Modify: `app/services/order_processor.py` (immediately before `validation = self.validator.validate(order)` at :339)
- Test: `tests/unit/test_catalog_registry_wiring.py` (new)

**Interfaces:**
- Consumes: `known_service_keys`, `is_floor_only`, `ensure_keys_known` (Task 5).
- Produces: both check sites decide from `known_service_keys()`; the submit path and the update path each `await ensure_keys_known(...)` BEFORE their check (and before any `db.add` on the request session — `_write_state` commits the session it is given).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/test_catalog_registry_wiring.py`:

```python
"""Check-site wiring: validator + webhook consult the registry union; the
order path live-fetches only for unknown keys (IS catalog-registry spec
2026-08-03). Reuses the fake-session idiom from test_native_service_keys.py."""
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.order import Sample, SampleServices
from app.services.order_validator import DefaultOrderValidator


@pytest.fixture(autouse=True)
def _reset_registry_state():
    from app.services import catalog_registry
    catalog_registry.reset_for_tests()
    yield
    catalog_registry.reset_for_tests()


def _sample(services: SampleServices) -> Sample:
    return Sample(
        number=1,
        analytical_test="Single Peptide",
        sample_identity="BPC-157",
        sample_weight="10",
        services=services,
    )


def _order(sample: Sample):
    # Local import: reuse the order factory from the sibling test module so
    # the OrderSubmission shape stays defined in exactly one test helper.
    from tests.unit.test_native_service_keys import _order as mk_order
    return mk_order(sample)


class TestValidatorConsultsRegistry:
    def test_synced_key_accepted_by_validator(self):
        # THE feature: a family minted in Mk1 passes with no IS deploy.
        from app.services import catalog_registry

        catalog_registry._set_synced({"brand_new_family"}, datetime.now(UTC))
        result = DefaultOrderValidator().validate(
            _order(_sample(SampleServices(brand_new_family=True)))
        )
        assert result.valid, result.errors

    def test_unsynced_key_still_rejected(self):
        result = DefaultOrderValidator().validate(
            _order(_sample(SampleServices(brand_new_family=True)))
        )
        assert not result.valid
        assert any("brand_new_family" in e.message for e in result.errors)

    def test_synced_key_must_still_be_boolean(self):
        from app.services import catalog_registry

        catalog_registry._set_synced({"brand_new_family"}, datetime.now(UTC))
        result = DefaultOrderValidator().validate(
            _order(_sample(SampleServices(brand_new_family="yes please")))
        )
        assert not result.valid

    def test_deactivated_profile_key_accepted(self):
        # Recognition != salability (spec top design decision): the sync
        # ingests every profile key regardless of active, so a deactivated
        # profile's key validates. Do NOT "fix" this by filtering on active.
        from app.services import catalog_registry

        catalog_registry._set_synced({"retired_family"}, datetime.now(UTC))
        result = DefaultOrderValidator().validate(
            _order(_sample(SampleServices(retired_family=True)))
        )
        assert result.valid, result.errors

    def test_floor_only_acceptance_logs_drift_signal(self, caplog):
        # heavy_metals passes via NATIVE_SERVICE_KEYS with an empty synced
        # set -> the catalog_key_accepted_via_floor drift signal fires.
        with caplog.at_level("WARNING"):
            result = DefaultOrderValidator().validate(
                _order(_sample(SampleServices(heavy_metals=True)))
            )
        assert result.valid
        assert "catalog_key_accepted_via_floor" in caplog.text

    def test_synced_floor_key_does_not_log_drift(self, caplog):
        from app.services import catalog_registry

        catalog_registry._set_synced({"heavy_metals"}, datetime.now(UTC))
        with caplog.at_level("WARNING"):
            result = DefaultOrderValidator().validate(
                _order(_sample(SampleServices(heavy_metals=True)))
            )
        assert result.valid
        assert "catalog_key_accepted_via_floor" not in caplog.text


class TestOrderPathLiveFetch:
    @pytest.mark.asyncio
    async def test_processor_calls_ensure_before_validate(self, monkeypatch):
        from app.services import catalog_registry
        from tests.unit.test_native_service_keys import (
            _FakeAsyncSession,
            _new_processor,
        )

        seen: list[set] = []

        async def _spy(candidate, db):
            seen.append(set(candidate))

        monkeypatch.setattr(
            "app.services.order_processor.ensure_keys_known", _spy, raising=False
        )
        # Patch the name where order_processor looks it up. If order_processor
        # imports it function-locally, patch catalog_registry.ensure_keys_known
        # instead — match the implementation.
        monkeypatch.setattr(catalog_registry, "ensure_keys_known", _spy)

        sample = _sample(SampleServices(hplcpurity_identity=True, heavy_metals=True))
        processor, _ = _new_processor()
        await processor.process(_order(sample), db=_FakeAsyncSession())

        assert seen and seen[0] == {"heavy_metals"}   # extras only, not field names

    @pytest.mark.asyncio
    async def test_processor_skips_ensure_with_no_extras(self, monkeypatch):
        from app.services import catalog_registry
        from tests.unit.test_native_service_keys import (
            _FakeAsyncSession,
            _new_processor,
        )

        spy = AsyncMock()
        monkeypatch.setattr(catalog_registry, "ensure_keys_known", spy)

        sample = _sample(SampleServices(hplcpurity_identity=True))
        processor, _ = _new_processor()
        await processor.process(_order(sample), db=_FakeAsyncSession())

        spy.assert_not_awaited()
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry_wiring.py -q
```

Expected: `test_synced_key_accepted_by_validator`, `test_deactivated_profile_key_accepted`, `test_floor_only_acceptance_logs_drift_signal`, and both live-fetch tests FAIL (validator still reads the frozen constant; processor never calls the hook). `test_unsynced_key_still_rejected` and `test_synced_key_must_still_be_boolean` may pass already — note which.

- [ ] **Step 3: Implement the wiring**

**3a — `app/services/order_validator.py`.** Update the registry block comment (:154-168): keep all four constants, and change `KNOWN_SERVICE_KEYS`'s comment to:

```python
# The BOOT FLOOR union (fields ∪ aliases ∪ NATIVE_SERVICE_KEYS). Since the
# catalog-registry spec (2026-08-03) this is no longer the working set the
# check sites consult — that is catalog_registry.known_service_keys(), which
# adds the keys synced from Mk1. NATIVE_SERVICE_KEYS stays as the floor so
# an empty DB plus an unreachable Mk1 degrades to exactly this constant.
KNOWN_SERVICE_KEYS: frozenset[str] = _LEGACY_FIELD_NAMES | _LEGACY_ALIASES | NATIVE_SERVICE_KEYS
```

Replace the body of `_service_extras_errors` (:465-488) with:

```python
    def _service_extras_errors(self, sample: Sample) -> list[ValidationError]:
        """Validate sample.services' undeclared (extra="allow") keys.

        Consults catalog_registry.known_service_keys() — the boot-floor
        union PLUS the keys synced from Mk1's catalog — so a new family
        needs no IS deploy. An unrecognized key is a recorded rejection
        (not the unrecorded parse-time 422 extra="forbid" would produce); a
        recognized native key must still be boolean. Function-local import:
        catalog_registry imports this module's floor constants, so a
        module-level import here would be circular.
        """
        from app.services.catalog_registry import is_floor_only, known_service_keys

        errors: list[ValidationError] = []
        extras: dict[str, Any] = sample.services.model_extra or {}
        working = known_service_keys()
        for key, value in extras.items():
            if key not in working:
                errors.append(ValidationError(
                    field="services",
                    message=f"Unknown service key '{key}' — order rejected "
                            "(create the Analysis Profile in Mk1, or wait for "
                            "the registry sync, before publishing the product)",
                    sample_number=sample.number))
            elif not isinstance(value, bool):
                errors.append(ValidationError(
                    field="services",
                    message=f"Service key '{key}' must be boolean, got {type(value).__name__}",
                    sample_number=sample.number))
            elif is_floor_only(key):
                logger.warning("catalog_key_accepted_via_floor", key=key)
        return errors
```

Check the top of order_validator.py for a module logger (`logger = get_logger(__name__)` or `logging.getLogger`); if none exists, add `from app.observability import get_logger` + `logger = get_logger(__name__)` beside the existing imports.

**3b — `app/api/webhook.py`.** The import at :24 currently reads `from app.services.order_validator import KNOWN_SERVICE_KEYS`. Replace with `from app.services.catalog_registry import ensure_keys_known, known_service_keys` (webhook → catalog_registry → order_validator is acyclic). In the `/order-services-updated` handler, directly BEFORE the `extras = normalized_model.model_extra or {}` line (:1192), insert:

```python
        # Order-path freshness: a key minted in Mk1 since the last sync gets
        # one 2s-bounded fetch before the check below decides. Failures are
        # warnings — the cache-based check still governs.
        await ensure_keys_known((normalized_model.model_extra or {}).keys(), db)
```

then change both membership checks (:1193, :1196) from `KNOWN_SERVICE_KEYS` to a `working = known_service_keys()` snapshot taken right after the ensure call:

```python
        working = known_service_keys()
        extras = normalized_model.model_extra or {}
        unknown_keys = [key for key in extras if key not in working]
        invalid_type_keys = [
            key for key, value in extras.items()
            if key in working and not isinstance(value, bool)
        ]
```

(The handler already has `db` in scope — verify from the function signature while editing; the comment at :1173 referencing "the KNOWN_SERVICE_KEYS check" should be updated to say "the known_service_keys() registry check".)

**3c — `app/services/order_processor.py`.** Directly before `validation = self.validator.validate(order)` (:339), insert:

```python
        # Catalog-registry freshness hook (spec 2026-08-03): if any sample
        # carries a service key outside the current union, give the registry
        # one 2s-bounded chance to learn it from Mk1 before validation.
        # Runs BEFORE any db.add on this session — the sync commits it.
        from app.services.catalog_registry import ensure_keys_known

        candidate_keys = {
            key
            for s in order.samples
            for key in (s.services.model_extra or {})
        }
        if candidate_keys:
            await ensure_keys_known(candidate_keys, db)
```

**3d — test spy target.** The wiring test patches `catalog_registry.ensure_keys_known`; with the function-local import in 3c that patch target is correct (the name is looked up at call time). Delete the `raising=False` monkeypatch line from the test if the module-level attribute does not exist — match what you built and note it in the report.

- [ ] **Step 4: Run the wiring file + the guarded legacy files + the full unit tree**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry_wiring.py tests/unit/test_native_service_keys.py tests/unit/test_order_services_updated.py -q
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit -q
```

Expected: first command all green with ZERO edits to the two legacy files; second command's failure set identical to the Task-1 baseline's unit-tree subset.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/is-catalog-registry && git add app/services/order_validator.py app/api/webhook.py app/services/order_processor.py tests/unit/test_catalog_registry_wiring.py && git commit -m "feat(catalog-registry): check sites consult the synced union; order-path live fetch

Both check sites keep their exact semantics (recorded validation_failed /
HTTP 400) — only the set changes. Unknown-key orders get one 2s-bounded
fetch; cached-key orders never fetch. Floor-only acceptance logs the
post-deploy drift signal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: IS — scheduler jobs + lifespan hydrate

**Files:**
- Modify: `app/services/catalog_registry.py` (append the two job coroutines)
- Modify: `app/services/wc_reconcile_scheduler.py` (register both catalog jobs in `start_scheduler`, :49-83)
- Modify: `app/main.py` (lifespan: hydrate before `start_scheduler()`)
- Test: `tests/unit/test_catalog_registry.py` (append)

**Interfaces:**
- Consumes: `get_scheduler()`/`start_scheduler()` singleton, `app.core.db.get_session_factory` (the same factory `run_reconcile_via_scheduler` uses at `wc_customer_sync.py:733-745`).
- Produces: jobs `catalog_sync_startup` (DateTrigger now; immediate attempt + retries after 10s/30s/60s sleeps — the combined-deploy race is the reason) and `catalog_sync_periodic` (IntervalTrigger hourly); lifespan hydrates last-known-good before the scheduler starts.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/test_catalog_registry.py`:

```python
# =============================================================================
# Startup retry + scheduler registration
# =============================================================================


async def test_startup_retry_stops_on_first_success(monkeypatch):
    from app.services import catalog_registry

    outcomes = iter([{"outcome": "failed"}, {"outcome": "ok", "key_count": 3}])
    calls = []

    async def _fake_sync(db, adapter=None):
        calls.append(1)
        return next(outcomes)

    sleeps: list[float] = []

    async def _fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(catalog_registry, "sync_catalog_registry", _fake_sync)
    monkeypatch.setattr(catalog_registry.asyncio, "sleep", _fake_sleep)
    monkeypatch.setattr(
        "app.core.db.get_session_factory",
        lambda: (lambda: _AsyncCtx(_FakeRegistryDb())),
    )
    await catalog_registry.run_catalog_sync_startup()

    assert len(calls) == 2          # immediate attempt failed, first retry succeeded
    assert sleeps == [10]           # only the first backoff was consumed


async def test_startup_retry_exhausts_bounded(monkeypatch, caplog):
    from app.services import catalog_registry

    async def _always_fail(db, adapter=None):
        return {"outcome": "failed"}

    sleeps: list[float] = []

    async def _fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(catalog_registry, "sync_catalog_registry", _always_fail)
    monkeypatch.setattr(catalog_registry.asyncio, "sleep", _fake_sleep)
    monkeypatch.setattr(
        "app.core.db.get_session_factory",
        lambda: (lambda: _AsyncCtx(_FakeRegistryDb())),
    )
    with caplog.at_level("WARNING"):
        await catalog_registry.run_catalog_sync_startup()

    assert sleeps == [10, 30, 60]   # bounded: immediate + 3 retries, then stop
    assert "catalog_sync_startup_exhausted" in caplog.text


class _AsyncCtx:
    """async-with wrapper handing out a fake session (mirrors get_session_factory()())."""

    def __init__(self, db):
        self._db = db

    async def __aenter__(self):
        return self._db

    async def __aexit__(self, *exc):
        return False


async def test_scheduler_registers_catalog_jobs(monkeypatch):
    # start_scheduler wires catalog_sync_startup + catalog_sync_periodic onto
    # the SAME singleton as the reconcile jobs — no new scheduler, no new
    # lifecycle. Assert via the registered job ids (asyncio_mode=auto runs
    # this coroutine directly).
    from app.services import wc_reconcile_scheduler as sched_mod

    added: list[str] = []

    class _FakeScheduler:
        running = False

        def add_job(self, *a, **kw):
            added.append(kw.get("id"))

        def start(self):
            self.running = True

        def get_jobs(self):
            return []

    monkeypatch.setattr(sched_mod, "_scheduler", None)
    monkeypatch.setattr(sched_mod, "get_scheduler", lambda: _FakeScheduler())
    await sched_mod.start_scheduler()

    assert "catalog_sync_startup" in added
    assert "catalog_sync_periodic" in added
    assert "reconcile_startup" in added      # existing jobs unharmed
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry.py -q
```

Expected: the three new tests fail (`run_catalog_sync_startup` missing; job ids not registered).

- [ ] **Step 3: Implement**

**3a — append to `app/services/catalog_registry.py`:**

```python
async def run_catalog_sync_startup() -> None:
    """Startup fetch (fallback step 1) with bounded retry: immediate attempt,
    then retries after 10s/30s/60s. During a combined deploy IS very likely
    boots while Mk1 is still starting — one attempt followed by an hour of
    waiting would leave new families unrecognised for that hour. Constructs
    its own session per attempt (scheduler entry point, mirrors
    run_reconcile_via_scheduler)."""
    from app.core.db import get_session_factory

    for delay in (0, 10, 30, 60):
        if delay:
            await asyncio.sleep(delay)
        factory = get_session_factory()
        async with factory() as db:
            try:
                result = await sync_catalog_registry(db)
            except RuntimeError:
                # Another sync (admin/live-fetch) owns freshness right now.
                return
        if result.get("outcome") == "ok":
            return
    logger.warning("catalog_sync_startup_exhausted", attempts=4)


async def run_catalog_sync_periodic() -> None:
    """Hourly refresh — the mechanism that makes a new family orderable
    within the hour with zero deploys."""
    from app.core.db import get_session_factory

    factory = get_session_factory()
    async with factory() as db:
        try:
            await sync_catalog_registry(db)
        except RuntimeError:
            logger.info("catalog_sync_periodic_skipped_lock_contention")
```

**3b — `app/services/wc_reconcile_scheduler.py`:** add `from apscheduler.triggers.interval import IntervalTrigger` beside the existing trigger imports, and in `start_scheduler()` after the two reconcile `add_job` calls (before `scheduler.start()`), insert:

```python
    # Catalog-registry sync (spec 2026-08-03) rides the SAME singleton —
    # no new scheduler, no new lifecycle. Local import mirrors the
    # run_reconcile_via_scheduler pattern above.
    from app.services.catalog_registry import (
        run_catalog_sync_periodic,
        run_catalog_sync_startup,
    )

    scheduler.add_job(
        run_catalog_sync_startup,
        trigger=DateTrigger(run_date=datetime.now(timezone.utc)),
        id="catalog_sync_startup",
        max_instances=1,
        misfire_grace_time=300,
        replace_existing=True,
    )
    scheduler.add_job(
        run_catalog_sync_periodic,
        trigger=IntervalTrigger(hours=1),
        id="catalog_sync_periodic",
        max_instances=1,
        misfire_grace_time=600,
        replace_existing=True,
    )
```

Also update the module docstring's job list (lines 4-9) to mention the two catalog jobs.

**3c — `app/main.py` lifespan:** locate the `await start_scheduler()` call in the lifespan startup block. Directly BEFORE it, insert:

```python
    # Hydrate the catalog registry from the last known good row BEFORE any
    # job or order can consult it (fallback step 2; the startup job then
    # fetches fresh). Never blocks on Mk1 — this is a local DB read.
    from app.core.db import get_session_factory
    from app.services.catalog_registry import load_registry_from_db

    async with get_session_factory()() as _registry_db:
        await load_registry_from_db(_registry_db)
```

(Match the surrounding lifespan code's import placement/style; if `get_session_factory` is already imported in `main.py`, do not re-import.)

- [ ] **Step 4: Run the tests**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry.py tests/unit/test_wc_reconcile_scheduler.py -q
```

Expected: all pass, including the pre-existing scheduler tests (if any of them assert an exact job-id list, that is a legitimately stale expectation this task changes — update ONLY the job-id list assertion and record it in your report).

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/is-catalog-registry && git add app/services/catalog_registry.py app/services/wc_reconcile_scheduler.py app/main.py tests/unit/test_catalog_registry.py && git commit -m "feat(catalog-registry): startup retry + hourly sync on the existing scheduler; lifespan hydrate

Startup: immediate attempt then 10s/30s/60s retries (combined-deploy race);
hydrate from last-known-good runs before the scheduler so a restart never
requires Mk1. The lifespan never awaits a fetch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: IS — `POST /admin/refresh-catalog`

**Files:**
- Modify: `app/api/admin.py` (append after `admin_reconcile_customers`, mirroring :136-180)
- Test: `tests/unit/test_catalog_registry_wiring.py` (append)

**Interfaces:**
- Consumes: `require_admin_api_key`, `get_db`, `get_catalog_sync_lock`, `sync_catalog_registry`.
- Produces: manual refresh returning the sync result dict; 409 `catalog_sync_in_progress` on lock contention (pre-check AND TOCTOU translate, mirroring the reconcile route).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/test_catalog_registry_wiring.py`:

```python
class TestAdminRefreshCatalog:
    def _client_with_overrides(self, test_app, db):
        from fastapi.testclient import TestClient
        from app.core.db import get_db as real_get_db

        test_app.dependency_overrides[real_get_db] = lambda: db
        return TestClient(test_app)

    def test_refresh_catalog_runs_sync(self, test_app, monkeypatch):
        from app.services import catalog_registry

        ran = AsyncMock(return_value={"outcome": "ok", "key_count": 7})
        monkeypatch.setattr(catalog_registry, "sync_catalog_registry", ran)
        client = self._client_with_overrides(test_app, MagicMock())

        r = client.post("/admin/refresh-catalog", headers=_admin_headers())

        assert r.status_code == 200, r.text
        assert r.json()["outcome"] == "ok"
        ran.assert_awaited_once()

    def test_refresh_catalog_409_on_contention(self, test_app, monkeypatch):
        # A fake held lock beats event-loop gymnastics: the route's
        # function-local `from ... import get_catalog_sync_lock` resolves the
        # name at call time, so patching the module attribute is effective.
        from app.services import catalog_registry

        fake_lock = MagicMock()
        fake_lock.locked.return_value = True
        monkeypatch.setattr(catalog_registry, "get_catalog_sync_lock", lambda: fake_lock)

        client = self._client_with_overrides(test_app, MagicMock())
        r = client.post("/admin/refresh-catalog", headers=_admin_headers())
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "catalog_sync_in_progress"


def _admin_headers() -> dict[str, str]:
    # Mirror however the existing admin-route tests authenticate
    # (X-API-Key from settings). READ an existing admin test first and copy
    # its exact auth fixture/header helper; if none exists, use
    # get_settings().desktop_api_key style per require_admin_api_key's
    # implementation in app/api/admin.py.
    from app.core.config import get_settings

    return {"X-API-Key": get_settings().desktop_api_key}
```

**Before running:** open `app/api/admin.py` and any existing admin-route test to confirm the auth header name and settings attribute `require_admin_api_key` actually checks; correct `_admin_headers` to match reality (the helper above is the expected shape, not gospel — the route contract in Step 3 is what's fixed). Record what you found.

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry_wiring.py -q
```

Expected: the two new tests fail with 404 (route missing); everything else in the file still passes.

- [ ] **Step 3: Implement the route**

Append to `app/api/admin.py` after `admin_reconcile_customers`:

```python
@router.post(
    "/refresh-catalog",
    summary="Run a manual catalog-registry sync",
    description=(
        "Triggers sync_catalog_registry() inline (GET /s2s/catalog/service-keys "
        "from Mk1; never-shrink on failure). Returns 200 with the sync result. "
        "Returns 409 if a sync is already in progress (scheduled job, order-path "
        "live fetch, or another manual trigger). Auth: X-API-Key header."
    ),
    dependencies=[Depends(require_admin_api_key)],
)
async def admin_refresh_catalog(
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Manual catalog refresh — mirrors admin_reconcile_customers' lock
    contract: pre-check for a fast 409, TOCTOU RuntimeError translated to
    the same 409 so it never leaks as a 500."""
    from app.services.catalog_registry import get_catalog_sync_lock, sync_catalog_registry

    if get_catalog_sync_lock().locked():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "catalog_sync_in_progress",
                "message": "A catalog sync is already running",
            },
        )

    logger.info("admin_refresh_catalog_started")
    try:
        result = await sync_catalog_registry(db)
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "catalog_sync_in_progress",
                "message": "A catalog sync is already running",
            },
        )
    logger.info("admin_refresh_catalog_completed", outcome=result.get("outcome"))
    return result
```

(All names — `router`, `Depends`, `HTTPException`, `status`, `AsyncSession`, `get_db`, `require_admin_api_key`, `logger` — already exist in admin.py for the reconcile route; verify, never duplicate imports.)

- [ ] **Step 4: Run the wiring file**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_catalog_registry_wiring.py -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/is-catalog-registry && git add app/api/admin.py tests/unit/test_catalog_registry_wiring.py && git commit -m "feat(catalog-registry): manual refresh endpoint with 409 lock contract

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification, both repos

**Files:** none — gates only.

- [ ] **Step 1: IS suite (failure-set diff vs Task-1 baseline)**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest -q 2>&1 | grep -E "^FAILED|^ERROR" | sed 's/ - .*//' | sort > /tmp/is-catalog-now.txt; diff .superpowers/sdd/2026-08-03-is-catalog-registry/is-baseline-failures.txt /tmp/is-catalog-now.txt && echo IS-GATE-GREEN
```

Expected: `IS-GATE-GREEN`.

- [ ] **Step 2: IS lint + types vs baseline**

```bash
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m ruff check . 2>&1 | tail -3
cd /c/tmp/is-catalog-registry && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m mypy app 2>&1 | tail -3
```

Expected: outputs no worse than the Task-1 baselines (`is-ruff-baseline.txt` / `is-mypy-baseline.txt`). Any NEW ruff error or mypy error in files this branch touched is a regression — fix it before proceeding.

- [ ] **Step 3: Mk1 gate (failure-set diff)**

```bash
cd /c/tmp/Accu-Mk1-catalog-s2s/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > /tmp/mk1-catalog-now.txt; diff /c/tmp/Accu-Mk1-catalog-s2s/.superpowers/sdd/2026-08-03-is-catalog-registry/mk1-baseline-failures.txt /tmp/mk1-catalog-now.txt && echo MK1-GATE-GREEN
```

Expected: `MK1-GATE-GREEN`.

- [ ] **Step 4: Working-tree hygiene**

```bash
git -C /c/tmp/is-catalog-registry status --porcelain | grep -v "^?? \.superpowers"     # expect empty
git -C /c/tmp/Accu-Mk1-catalog-s2s status --porcelain | grep -v "^?? \.superpowers"    # expect empty
```

---

### Task 10: Push + PRs

**Files:** none.

- [ ] **Step 1: Push both branches**

```bash
git -C /c/tmp/Accu-Mk1-catalog-s2s push -u origin feat/s2s-catalog-keys
git -C /c/tmp/is-catalog-registry push -u origin feat/catalog-registry
```

- [ ] **Step 2: Open the PRs**

```bash
cd /c/tmp/Accu-Mk1-catalog-s2s && gh pr create --base feat/native-spec-ownership --title "S2S catalog service-keys feed for the IS registry sync" --body "Implements the Mk1 half of docs/superpowers/specs/2026-08-03-is-catalog-registry-design.md. Plan: docs/superpowers/plans/2026-08-03-is-catalog-registry.md.

- GET /s2s/catalog/service-keys (require_internal_service_token): every analysis_profiles.key, active or not, sorted, plus generated_at
- Recognition != salability ON PURPOSE: active means retired-from-the-bench; sale gating stays in WordPress. The route and its tests carry the do-NOT-filter-on-active comment the spec mandates.

Gate: backend failure-set diff vs baseline EMPTY.

Stacks on #93. Companion: integration-service feat/catalog-registry. Deploy order within the ONE combined window: Mk1 first, then IS (IS-first is inert — 404 -> failed sync -> boot floor == today's behavior). No independent deploy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

```bash
cd /c/tmp/is-catalog-registry && gh pr create --base feat/catalog-order-routing --title "Catalog registry: declared service keys sync from Mk1" --body "Implements the IS half of docs/superpowers/specs/2026-08-03-is-catalog-registry-design.md (in the Accu-Mk1 repo).

- catalog_registry_state singleton (mirrors wc_sync_state) + alembic migration w1x2y3z4a5b6 (manual apply in prod per existing discipline)
- catalog_registry module: known_service_keys() = fields ∪ aliases ∪ NATIVE_SERVICE_KEYS (kept as the boot floor) ∪ synced keys; NEVER-SHRINK (empty/malformed fetch = failure that changes no keys); staleness WARNING at 24h; catalog_key_accepted_via_floor drift signal
- Startup: hydrate last-known-good from the row, then fire-and-forget fetch with bounded retry (immediate + 10s/30s/60s — the combined-deploy race); hourly refresh on the EXISTING scheduler singleton
- Order path: both check sites (validator + /order-services-updated) consult the union with unchanged semantics; unknown-key orders get ONE 2s-bounded live fetch (timeout AND error fall through to the cache; never a rejection cause)
- POST /admin/refresh-catalog with the reconcile route's 409 lock contract

Worst case is exactly today's behavior: empty DB + unreachable Mk1 = the hardcoded floor. Rollback = clear the stored row's service_keys (no image revert).

Gates: pytest failure-set diff vs baseline EMPTY; ruff + mypy no worse than baseline.

Stacks on #20. Companion: Accu-Mk1 feat/s2s-catalog-keys (deploys FIRST in the combined window). Net effect: adding a test family stops requiring an IS deploy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 11: s3rehe rehearsal (agent-run UAT)

**Files:** none local — devbox stack `s3rehe` (all state reversible test data). Stack facts: `forrestparker@100.73.137.3`; Mk1 backend :5770; IS :5765; postgres container `accumark-s3rehe-postgres` (`accumark_mk1`, `accumark_integration`); Mk1 worktree `~/worktrees/Accu-Mk1-s3rehe` (currently on `feat/native-spec-ownership`); IS worktree `~/worktrees/integration-service-s3rehe` — **only `app/` is bind-mounted into the container** (`/app/app`), so the alembic migration must be applied inside the container (docker cp) or via psql.

- [ ] **Step 1: Check out the rehearsal branches and restart (Mk1 first — deploy order)**

```bash
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-s3rehe fetch && git -C ~/worktrees/Accu-Mk1-s3rehe checkout feat/s2s-catalog-keys && docker restart accumark-s3rehe-accu-mk1-backend && git -C ~/worktrees/integration-service-s3rehe fetch && git -C ~/worktrees/integration-service-s3rehe checkout feat/catalog-registry && echo "--- heads ---" && git -C ~/worktrees/Accu-Mk1-s3rehe log --oneline -1 && git -C ~/worktrees/integration-service-s3rehe log --oneline -1'
```

(If the IS worktree checkout complains about a tracked-file conflict, inspect before forcing — report what you find rather than discarding unknown local state.)

- [ ] **Step 2: Prove the Mk1 endpoint live (token from the stack's IS env)**

```bash
ssh forrestparker@100.73.137.3 'TOKEN=$(docker exec accumark-s3rehe-integration-service printenv ACCUMK1_INTERNAL_SERVICE_TOKEN); curl -s -H "X-Service-Token: $TOKEN" http://localhost:5770/s2s/catalog/service-keys'
```

Expected: JSON with `keys` including `sterility_usp71` and `heavy_metals` (the s3rehe catalog), plus `generated_at`. Also probe once with a wrong token — expect 401.

- [ ] **Step 3: Apply the IS migration in the container, then restart IS**

```bash
ssh forrestparker@100.73.137.3 'docker cp ~/worktrees/integration-service-s3rehe/migrations/versions/w1x2y3z4a5b6_add_catalog_registry_state.py accumark-s3rehe-integration-service:/app/migrations/versions/ && docker exec accumark-s3rehe-integration-service alembic upgrade head && docker restart accumark-s3rehe-integration-service'
```

This rehearses the manual-alembic prod step. If `alembic upgrade head` fails (config/path), fall back to applying the table via psql with EXACTLY the migration's DDL, and report that the alembic path needs attention before the real deploy:

```bash
ssh forrestparker@100.73.137.3 "docker exec -i accumark-s3rehe-postgres psql -U postgres -d accumark_integration" <<'SQL'
CREATE TABLE IF NOT EXISTS catalog_registry_state (
    id SMALLINT PRIMARY KEY,
    service_keys JSONB,
    last_sync_at TIMESTAMPTZ,
    last_sync_outcome VARCHAR,
    last_sync_error VARCHAR,
    key_count INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT catalog_registry_state_singleton CHECK (id = 1)
);
SQL
```

- [ ] **Step 4: Verify the startup sync landed (DB, not logs)**

Wait for the IS container to become healthy, then:

```bash
ssh forrestparker@100.73.137.3 "docker exec -i accumark-s3rehe-postgres psql -U postgres -d accumark_integration" <<'SQL'
select service_keys, key_count, last_sync_outcome, last_sync_at from catalog_registry_state;
SQL
```

Expected: one row, `last_sync_outcome = 'ok'`, `key_count` ≥ 5, `service_keys` including `sterility_usp71`. If the startup attempt raced the restart, `curl -s -X POST` the admin refresh (`/admin/refresh-catalog` on :5765 with the stack's admin API key from the IS env) and re-check.

- [ ] **Step 5: Restart-resilience probe (the case persistence exists for)**

```bash
ssh forrestparker@100.73.137.3 'docker stop accumark-s3rehe-accu-mk1-backend && docker restart accumark-s3rehe-integration-service && sleep 20 && docker exec -i accumark-s3rehe-postgres psql -U postgres -d accumark_integration -t -A -c "select key_count, last_sync_outcome from catalog_registry_state;" && docker start accumark-s3rehe-accu-mk1-backend'
```

Expected: with Mk1 DOWN, IS restarts cleanly (startup sync fails/retries but never blocks), and the stored row still holds the previous good `service_keys` — hydration preserved last-known-good. `last_sync_outcome` may read `failed` (the startup attempts) — the keys row is the point. Restart Mk1 afterward (the command does) and confirm a follow-up sync (admin refresh) returns `ok`.

- [ ] **Step 6: Restore + report**

Leave both devbox worktrees on the rehearsal branches (supersets of the PR chain) and note it. Confirm stack validate:

```bash
ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack validate s3rehe 2>&1 | tail -2'
```

Expected: `OK: 21/21 checks passed`. Report the before/after registry row and the Mk1-down probe outcome.

---

## Explicitly NOT in this plan (spec-scoped exclusions)

- The WordPress admin dropdown and ordering-wizard card grid (commercial-layer program; the endpoint is shaped so WP can consume it later without change — richer response fields were explicitly declined, spec open question 2).
- Faster-than-hourly cadence (spec open question 1: pointless while WP work gates sale anyway).
- Deleting `NATIVE_SERVICE_KEYS` (it is the boot floor — permanent by design in this slice).
- Any change to `SampleServices` parsing, the rejection semantics, or `SERVICE_TO_PROFILE`.
- Mk1-side write surfaces or auth changes — one read-only route only.
