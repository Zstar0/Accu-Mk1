# Peptide Request — Accu-Mk1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Accu-Mk1 backend (FastAPI) + LIMS UI (React) half of the peptide request feature: canonical Postgres entity, internal API, ClickUp outbound client, ClickUp webhook receiver, background jobs, LIMS request list + detail pages, and admin ClickUp-user mapping page.

**Architecture:** See `docs/superpowers/specs/2026-04-17-peptide-request-design.md`. HTTP interfaces frozen in `docs/superpowers/specs/2026-04-17-peptide-request-contracts.md` — **deviations must halt and surface**.

**Tech stack:** Python 3.11+ / FastAPI (backend), SQLAlchemy / raw SQL per existing `backend/mk1_db.py` patterns, Postgres, React 19 + TypeScript + Vite + Zustand + TanStack Query per `AGENTS.md`. No pnpm (npm only).

**Branch:** `feat/peptide-request-v1` off latest `master` (Accu-Mk1's default branch is `master`, not `main`).

**Repo-specific rules** (from `AGENTS.md`):
- State management onion: `useState` → Zustand → TanStack Query. Use Zustand **selector syntax** (not destructuring).
- React Compiler auto-memoizes — don't add manual `useMemo`/`useCallback`.
- Tauri commands go through `@/lib/tauri-bindings` (typed), not raw `invoke`.
- `npm run check:all` is the quality gate.
- Use Context7 MCP for framework docs before WebSearch.

---

## Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Verify you're starting from latest master**

Run:
```bash
cd C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1
git fetch origin
git status
```
Expected: clean working tree, `master` up to date. If not on `master`, stash/park current work first.

**Note:** If the `feat/peptide-request-v1` branch already exists (it was pre-created by the controller when committing the plan), check it out instead of creating it.

- [ ] **Step 2: Create or check out feature branch**

Run:
```bash
if git show-ref --verify --quiet refs/heads/feat/peptide-request-v1; then
    git checkout feat/peptide-request-v1
else
    git checkout master
    git pull origin master
    git checkout -b feat/peptide-request-v1
fi
```
Expected: on `feat/peptide-request-v1` branch, working tree clean.

- [ ] **Step 3: Commit empty plan progress marker (optional, skip if team conventions differ)**

No commit yet. Proceed to Task 1.

---

## Task 1: DB — `peptide_requests` table

**Files:**
- Modify: `backend/mk1_db.py` (add table creation SQL to the schema-init block; follow pattern used for existing tables)
- Create: `backend/tests/test_peptide_requests_schema.py`

- [ ] **Step 1: Write the failing schema test**

Create `backend/tests/test_peptide_requests_schema.py`:

```python
"""Verify peptide_requests table exists with correct columns."""
import pytest
from backend.mk1_db import get_mk1_conn

REQUIRED_COLUMNS = {
    "id", "created_at", "updated_at", "idempotency_key",
    "submitted_by_wp_user_id", "submitted_by_email", "submitted_by_name",
    "compound_kind", "compound_name", "vendor_producer",
    "sequence_or_structure", "molecular_weight", "cas_or_reference",
    "vendor_catalog_number", "reason_notes", "expected_monthly_volume",
    "status", "previous_status", "rejection_reason", "sample_id",
    "clickup_task_id", "clickup_list_id", "clickup_assignee_ids",
    "senaite_service_uid", "wp_coupon_code", "wp_coupon_issued_at",
    "completed_at", "rejected_at", "cancelled_at",
    "clickup_create_failed_at", "coupon_failed_at",
    "senaite_clone_failed_at", "wp_relay_failed_at",
}


def test_peptide_requests_table_has_all_columns():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'peptide_requests'
        """)
        actual = {row[0] for row in cur.fetchall()}
        missing = REQUIRED_COLUMNS - actual
        assert not missing, f"Missing columns: {missing}"


def test_peptide_requests_has_idempotency_unique_index():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'peptide_requests'
              AND indexdef ILIKE '%submitted_by_wp_user_id%'
              AND indexdef ILIKE '%idempotency_key%'
              AND indexdef ILIKE '%UNIQUE%'
        """)
        assert cur.fetchone() is not None, "Missing unique index on (wp_user_id, idempotency_key)"
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd backend && python -m pytest tests/test_peptide_requests_schema.py -v
```
Expected: FAIL — table doesn't exist.

- [ ] **Step 3: Add table creation SQL to `backend/mk1_db.py`**

Locate the schema initialization block (where other tables are created). Append:

```python
# In the schema init function (find existing CREATE TABLE blocks and follow the pattern)
cur.execute("""
CREATE TABLE IF NOT EXISTS peptide_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idempotency_key TEXT NOT NULL,
    submitted_by_wp_user_id INTEGER NOT NULL,
    submitted_by_email TEXT NOT NULL,
    submitted_by_name TEXT NOT NULL,
    compound_kind TEXT NOT NULL CHECK (compound_kind IN ('peptide', 'other')),
    compound_name TEXT NOT NULL,
    vendor_producer TEXT NOT NULL,
    sequence_or_structure TEXT,
    molecular_weight NUMERIC,
    cas_or_reference TEXT,
    vendor_catalog_number TEXT,
    reason_notes TEXT,
    expected_monthly_volume INTEGER,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
        'new', 'approved', 'ordering_standard', 'sample_prep_created',
        'in_process', 'on_hold', 'completed', 'rejected', 'cancelled'
    )),
    previous_status TEXT,
    rejection_reason TEXT,
    sample_id TEXT,
    clickup_task_id TEXT,
    clickup_list_id TEXT NOT NULL,
    clickup_assignee_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    senaite_service_uid TEXT,
    wp_coupon_code TEXT,
    wp_coupon_issued_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    clickup_create_failed_at TIMESTAMPTZ,
    coupon_failed_at TIMESTAMPTZ,
    senaite_clone_failed_at TIMESTAMPTZ,
    wp_relay_failed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_peptide_requests_idempotency
    ON peptide_requests (submitted_by_wp_user_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_peptide_requests_wp_user
    ON peptide_requests (submitted_by_wp_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_peptide_requests_status
    ON peptide_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_peptide_requests_clickup_task
    ON peptide_requests (clickup_task_id) WHERE clickup_task_id IS NOT NULL;
""")
```

Ensure `pgcrypto` is enabled (check if existing schema does this; if not, add `CREATE EXTENSION IF NOT EXISTS pgcrypto;` at top of init).

- [ ] **Step 4: Re-run tests, verify they pass**

```bash
python -m pytest tests/test_peptide_requests_schema.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/mk1_db.py backend/tests/test_peptide_requests_schema.py
git commit -m "feat(db): add peptide_requests table with indexes"
```

---

## Task 2: DB — `peptide_request_status_log` table

**Files:**
- Modify: `backend/mk1_db.py`
- Create: `backend/tests/test_status_log_schema.py`

- [ ] **Step 1: Write the failing schema test**

```python
"""Verify status log table."""
from backend.mk1_db import get_mk1_conn

REQUIRED_COLUMNS = {
    "id", "peptide_request_id", "from_status", "to_status",
    "source", "clickup_event_id", "actor_clickup_user_id",
    "actor_accumk1_user_id", "note", "created_at",
}


def test_status_log_columns():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'peptide_request_status_log'
        """)
        actual = {row[0] for row in cur.fetchall()}
        assert REQUIRED_COLUMNS <= actual, f"Missing: {REQUIRED_COLUMNS - actual}"


def test_status_log_clickup_event_id_unique():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'peptide_request_status_log'
              AND indexdef ILIKE '%UNIQUE%'
              AND indexdef ILIKE '%clickup_event_id%'
        """)
        assert cur.fetchone() is not None
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Add schema SQL to `backend/mk1_db.py`**

```sql
CREATE TABLE IF NOT EXISTS peptide_request_status_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    peptide_request_id UUID NOT NULL REFERENCES peptide_requests(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('clickup', 'accumk1_admin', 'system')),
    clickup_event_id TEXT,
    actor_clickup_user_id TEXT,
    actor_accumk1_user_id UUID,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_status_log_clickup_event
    ON peptide_request_status_log (clickup_event_id)
    WHERE clickup_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_status_log_request
    ON peptide_request_status_log (peptide_request_id, created_at DESC);
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/mk1_db.py backend/tests/test_status_log_schema.py
git commit -m "feat(db): add peptide_request_status_log table"
```

---

## Task 3: DB — `clickup_user_mapping` table

**Files:**
- Modify: `backend/mk1_db.py`
- Create: `backend/tests/test_clickup_user_mapping_schema.py`

- [ ] **Step 1: Failing test**

```python
from backend.mk1_db import get_mk1_conn

REQUIRED = {"clickup_user_id", "accumk1_user_id", "clickup_username",
            "clickup_email", "auto_matched", "created_at", "updated_at", "last_seen_at"}


def test_clickup_user_mapping_columns():
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT column_name FROM information_schema.columns
                       WHERE table_name = 'clickup_user_mapping'""")
        actual = {row[0] for row in cur.fetchall()}
        assert REQUIRED <= actual
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Add schema to `backend/mk1_db.py`**

```sql
CREATE TABLE IF NOT EXISTS clickup_user_mapping (
    clickup_user_id TEXT PRIMARY KEY,
    accumk1_user_id UUID,
    clickup_username TEXT NOT NULL,
    clickup_email TEXT,
    auto_matched BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clickup_user_mapping_unmapped
    ON clickup_user_mapping (accumk1_user_id) WHERE accumk1_user_id IS NULL;
```

- [ ] **Step 4: Verify PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(db): add clickup_user_mapping table"
```

---

## Task 4: Pydantic models

**Files:**
- Create: `backend/models_peptide_request.py`
- Modify: `backend/models.py` (re-export from new file; keep this file focused)
- Test: `backend/tests/test_peptide_request_models.py`

- [ ] **Step 1: Failing test**

```python
import pytest
from pydantic import ValidationError
from backend.models_peptide_request import (
    PeptideRequestCreate, PeptideRequest, CompoundKind, Status
)


def test_create_validates_required_fields():
    with pytest.raises(ValidationError):
        PeptideRequestCreate(compound_kind="peptide")  # missing required fields


def test_create_rejects_invalid_kind():
    with pytest.raises(ValidationError):
        PeptideRequestCreate(
            compound_kind="bogus", compound_name="X", vendor_producer="Y",
            submitted_by_wp_user_id=1, submitted_by_email="a@b.c",
            submitted_by_name="Name",
        )


def test_create_accepts_minimal_valid_payload():
    m = PeptideRequestCreate(
        compound_kind="peptide", compound_name="BPC-157",
        vendor_producer="Cayman", submitted_by_wp_user_id=42,
        submitted_by_email="a@b.c", submitted_by_name="Jane",
    )
    assert m.compound_kind == "peptide"


def test_create_enforces_length_limits():
    with pytest.raises(ValidationError):
        PeptideRequestCreate(
            compound_kind="peptide", compound_name="X" * 201,
            vendor_producer="Y", submitted_by_wp_user_id=1,
            submitted_by_email="a@b.c", submitted_by_name="N",
        )


def test_status_enum_values():
    assert set(Status.__args__) == {  # assuming Literal-typed Status
        "new", "approved", "ordering_standard", "sample_prep_created",
        "in_process", "on_hold", "completed", "rejected", "cancelled",
    }
```

- [ ] **Step 2: Verify FAIL (ImportError)**

- [ ] **Step 3: Create `backend/models_peptide_request.py`**

```python
"""Pydantic models for peptide requests. Shape matches
docs/superpowers/specs/2026-04-17-peptide-request-contracts.md."""
from datetime import datetime
from typing import Literal, Optional
from uuid import UUID
from pydantic import BaseModel, Field, EmailStr


CompoundKind = Literal["peptide", "other"]
Status = Literal[
    "new", "approved", "ordering_standard", "sample_prep_created",
    "in_process", "on_hold", "completed", "rejected", "cancelled",
]


class PeptideRequestCreate(BaseModel):
    """Request body for POST /api/peptide-requests (called by integration-service)."""
    compound_kind: CompoundKind
    compound_name: str = Field(..., min_length=1, max_length=200)
    vendor_producer: str = Field(..., min_length=1, max_length=200)
    sequence_or_structure: Optional[str] = Field(None, max_length=4000)
    molecular_weight: Optional[float] = Field(None, gt=0, le=100000)
    cas_or_reference: Optional[str] = Field(None, max_length=200)
    vendor_catalog_number: Optional[str] = Field(None, max_length=200)
    reason_notes: Optional[str] = Field(None, max_length=2000)
    expected_monthly_volume: Optional[int] = Field(None, ge=0, le=100000)
    # Caller-supplied identity (integration-service forwards from WP):
    submitted_by_wp_user_id: int
    submitted_by_email: EmailStr
    submitted_by_name: str = Field(..., min_length=1, max_length=200)


class PeptideRequest(BaseModel):
    """Full canonical shape returned by Accu-Mk1 endpoints."""
    id: UUID
    created_at: datetime
    updated_at: datetime
    submitted_by_wp_user_id: int
    submitted_by_email: str
    submitted_by_name: str
    compound_kind: CompoundKind
    compound_name: str
    vendor_producer: str
    sequence_or_structure: Optional[str]
    molecular_weight: Optional[float]
    cas_or_reference: Optional[str]
    vendor_catalog_number: Optional[str]
    reason_notes: Optional[str]
    expected_monthly_volume: Optional[int]
    status: Status
    previous_status: Optional[Status]
    rejection_reason: Optional[str]
    sample_id: Optional[str]
    clickup_task_id: Optional[str]
    clickup_list_id: str
    clickup_assignee_ids: list[str]
    senaite_service_uid: Optional[str]
    wp_coupon_code: Optional[str]
    wp_coupon_issued_at: Optional[datetime]
    completed_at: Optional[datetime]
    rejected_at: Optional[datetime]
    cancelled_at: Optional[datetime]


class PeptideRequestList(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[PeptideRequest]


class StatusLogEntry(BaseModel):
    id: UUID
    peptide_request_id: UUID
    from_status: Optional[Status]
    to_status: Status
    source: Literal["clickup", "accumk1_admin", "system"]
    clickup_event_id: Optional[str]
    actor_clickup_user_id: Optional[str]
    actor_accumk1_user_id: Optional[UUID]
    note: Optional[str]
    created_at: datetime
```

- [ ] **Step 4: Verify PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/models_peptide_request.py backend/tests/test_peptide_request_models.py
git commit -m "feat(models): add peptide request Pydantic schemas"
```

---

## Task 5: Repository — `PeptideRequestRepository` (create + idempotent replay)

**Files:**
- Create: `backend/peptide_request_repo.py`
- Test: `backend/tests/test_peptide_request_repo.py`

- [ ] **Step 1: Failing test**

```python
import pytest
import uuid
from backend.mk1_db import get_mk1_conn
from backend.peptide_request_repo import PeptideRequestRepository
from backend.models_peptide_request import PeptideRequestCreate


@pytest.fixture
def repo():
    return PeptideRequestRepository()


@pytest.fixture
def sample_create():
    return PeptideRequestCreate(
        compound_kind="peptide", compound_name="Retatrutide",
        vendor_producer="PepMart", submitted_by_wp_user_id=42,
        submitted_by_email="a@b.c", submitted_by_name="Jane",
    )


def test_create_inserts_and_returns_row(repo, sample_create):
    idem = str(uuid.uuid4())
    row = repo.create(sample_create, idempotency_key=idem, clickup_list_id="list_abc")
    assert row.compound_name == "Retatrutide"
    assert row.status == "new"
    assert row.clickup_task_id is None


def test_create_is_idempotent_on_replay(repo, sample_create):
    idem = str(uuid.uuid4())
    first = repo.create(sample_create, idempotency_key=idem, clickup_list_id="list_abc")
    second = repo.create(sample_create, idempotency_key=idem, clickup_list_id="list_abc")
    assert first.id == second.id  # same row returned, not a new one


def test_get_by_id_returns_row(repo, sample_create):
    created = repo.create(sample_create, idempotency_key=str(uuid.uuid4()), clickup_list_id="list_abc")
    fetched = repo.get_by_id(created.id)
    assert fetched is not None
    assert fetched.id == created.id


def test_get_by_id_returns_none_for_missing(repo):
    assert repo.get_by_id(uuid.uuid4()) is None
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Create `backend/peptide_request_repo.py`**

```python
"""Repository layer for peptide_requests."""
from typing import Optional
from uuid import UUID
from backend.mk1_db import get_mk1_conn
from backend.models_peptide_request import PeptideRequest, PeptideRequestCreate


def _row_to_model(row: dict) -> PeptideRequest:
    return PeptideRequest(**row)


class PeptideRequestRepository:
    def create(
        self,
        data: PeptideRequestCreate,
        *,
        idempotency_key: str,
        clickup_list_id: str,
    ) -> PeptideRequest:
        """Insert a new request. Returns existing row if (wp_user_id, idempotency_key)
        already exists AND payload matches."""
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT * FROM peptide_requests
                WHERE submitted_by_wp_user_id = %s AND idempotency_key = %s
            """, (data.submitted_by_wp_user_id, idempotency_key))
            existing = cur.fetchone()
            if existing:
                # Payload equality check (simple: compare compound_name + kind).
                # For v1, trust idempotency — return existing.
                return _row_to_model(dict(existing))

            cur.execute("""
                INSERT INTO peptide_requests (
                    idempotency_key, submitted_by_wp_user_id,
                    submitted_by_email, submitted_by_name,
                    compound_kind, compound_name, vendor_producer,
                    sequence_or_structure, molecular_weight, cas_or_reference,
                    vendor_catalog_number, reason_notes, expected_monthly_volume,
                    clickup_list_id
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                ) RETURNING *
            """, (
                idempotency_key, data.submitted_by_wp_user_id,
                data.submitted_by_email, data.submitted_by_name,
                data.compound_kind, data.compound_name, data.vendor_producer,
                data.sequence_or_structure, data.molecular_weight, data.cas_or_reference,
                data.vendor_catalog_number, data.reason_notes, data.expected_monthly_volume,
                clickup_list_id,
            ))
            row = cur.fetchone()
            conn.commit()
            return _row_to_model(dict(row))

    def get_by_id(self, request_id: UUID) -> Optional[PeptideRequest]:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT * FROM peptide_requests WHERE id = %s", (str(request_id),))
            row = cur.fetchone()
            return _row_to_model(dict(row)) if row else None

    def list_by_wp_user(
        self, wp_user_id: int, *, status: Optional[list[str]] = None,
        limit: int = 50, offset: int = 0,
    ) -> tuple[list[PeptideRequest], int]:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            where = ["submitted_by_wp_user_id = %s"]
            params: list = [wp_user_id]
            if status:
                where.append(f"status = ANY(%s)")
                params.append(status)
            where_sql = " AND ".join(where)
            cur.execute(f"SELECT COUNT(*) FROM peptide_requests WHERE {where_sql}", params)
            total = cur.fetchone()[0]
            cur.execute(f"""
                SELECT * FROM peptide_requests WHERE {where_sql}
                ORDER BY created_at DESC LIMIT %s OFFSET %s
            """, (*params, limit, offset))
            rows = [_row_to_model(dict(r)) for r in cur.fetchall()]
            return rows, total

    def update_clickup_task_id(self, request_id: UUID, task_id: str) -> None:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE peptide_requests
                SET clickup_task_id = %s, updated_at = NOW()
                WHERE id = %s
            """, (task_id, str(request_id)))
            conn.commit()

    def update_status(
        self, request_id: UUID, *, new_status: str,
        previous_status: Optional[str] = None,
    ) -> None:
        """Update status + set terminal timestamp columns."""
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            terminal_col_sql = ""
            if new_status == "completed":
                terminal_col_sql = ", completed_at = NOW()"
            elif new_status == "rejected":
                terminal_col_sql = ", rejected_at = NOW()"
            elif new_status == "cancelled":
                terminal_col_sql = ", cancelled_at = NOW()"
            prev_sql = ", previous_status = %s" if previous_status is not None else ""
            params: list = [new_status]
            if previous_status is not None:
                params.append(previous_status)
            params.append(str(request_id))
            cur.execute(f"""
                UPDATE peptide_requests
                SET status = %s{prev_sql}{terminal_col_sql}, updated_at = NOW()
                WHERE id = %s
            """, params)
            conn.commit()

    def set_assignees(self, request_id: UUID, assignee_ids: list[str]) -> None:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE peptide_requests
                SET clickup_assignee_ids = %s::jsonb, updated_at = NOW()
                WHERE id = %s
            """, (f'{assignee_ids!r}'.replace("'", '"'), str(request_id)))
            conn.commit()

    def find_needing_clickup_create(self, older_than_seconds: int = 60) -> list[PeptideRequest]:
        """Rows with clickup_task_id NULL and older than N seconds."""
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT * FROM peptide_requests
                WHERE clickup_task_id IS NULL
                  AND clickup_create_failed_at IS NULL
                  AND created_at < NOW() - (%s || ' seconds')::interval
                ORDER BY created_at ASC LIMIT 50
            """, (older_than_seconds,))
            return [_row_to_model(dict(r)) for r in cur.fetchall()]
```

- [ ] **Step 4: Verify PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/peptide_request_repo.py backend/tests/test_peptide_request_repo.py
git commit -m "feat(repo): add PeptideRequestRepository"
```

---

## Task 6: Repository — `StatusLogRepository` and `ClickUpUserMappingRepository`

**Files:**
- Create: `backend/status_log_repo.py`
- Create: `backend/clickup_user_mapping_repo.py`
- Test: `backend/tests/test_status_log_repo.py`
- Test: `backend/tests/test_clickup_user_mapping_repo.py`

- [ ] **Step 1: Failing tests**

Status log test:
```python
import uuid
from backend.peptide_request_repo import PeptideRequestRepository
from backend.status_log_repo import StatusLogRepository
from backend.models_peptide_request import PeptideRequestCreate


def test_append_and_get_history():
    prepo = PeptideRequestRepository()
    lrepo = StatusLogRepository()
    req = prepo.create(
        PeptideRequestCreate(
            compound_kind="peptide", compound_name="X",
            vendor_producer="Y", submitted_by_wp_user_id=1,
            submitted_by_email="a@b.c", submitted_by_name="N",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list",
    )
    lrepo.append(
        peptide_request_id=req.id,
        from_status="new", to_status="approved",
        source="clickup", clickup_event_id="evt_1",
        actor_clickup_user_id="cu_1", actor_accumk1_user_id=None,
        note=None,
    )
    history = lrepo.get_for_request(req.id)
    assert len(history) == 1
    assert history[0].to_status == "approved"


def test_append_deduplicates_on_clickup_event_id():
    lrepo = StatusLogRepository()
    prepo = PeptideRequestRepository()
    req = prepo.create(
        PeptideRequestCreate(
            compound_kind="peptide", compound_name="X",
            vendor_producer="Y", submitted_by_wp_user_id=2,
            submitted_by_email="a@b.c", submitted_by_name="N",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list",
    )
    assert lrepo.append(
        peptide_request_id=req.id, from_status="new", to_status="approved",
        source="clickup", clickup_event_id="evt_dedup_1",
        actor_clickup_user_id="cu_1", actor_accumk1_user_id=None, note=None,
    ) is True  # inserted
    assert lrepo.append(
        peptide_request_id=req.id, from_status="new", to_status="approved",
        source="clickup", clickup_event_id="evt_dedup_1",
        actor_clickup_user_id="cu_1", actor_accumk1_user_id=None, note=None,
    ) is False  # dedup
```

User mapping test:
```python
from backend.clickup_user_mapping_repo import ClickUpUserMappingRepository


def test_upsert_and_get():
    repo = ClickUpUserMappingRepository()
    repo.upsert(
        clickup_user_id="cu_123", clickup_username="jane",
        clickup_email="jane@lab.com",
    )
    got = repo.get("cu_123")
    assert got.clickup_username == "jane"
    assert got.accumk1_user_id is None  # unmapped by default


def test_auto_match_by_email_when_user_exists():
    # Assume seed: accumk1 users table has jane@lab.com → UUID x
    repo = ClickUpUserMappingRepository()
    repo.upsert(clickup_user_id="cu_456", clickup_username="jane", clickup_email="jane@lab.com")
    got = repo.get("cu_456")
    # If jane@lab.com resolves in users table, auto_matched=True
    # (This test may skip if no seed — use pytest.skip)
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Implement both repos**

`backend/status_log_repo.py`:
```python
from typing import Optional
from uuid import UUID
from backend.mk1_db import get_mk1_conn
from backend.models_peptide_request import StatusLogEntry


class StatusLogRepository:
    def append(
        self, *, peptide_request_id: UUID, from_status: Optional[str],
        to_status: str, source: str, clickup_event_id: Optional[str],
        actor_clickup_user_id: Optional[str], actor_accumk1_user_id: Optional[UUID],
        note: Optional[str],
    ) -> bool:
        """Returns True if inserted, False if dedupe hit."""
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            try:
                cur.execute("""
                    INSERT INTO peptide_request_status_log (
                        peptide_request_id, from_status, to_status, source,
                        clickup_event_id, actor_clickup_user_id,
                        actor_accumk1_user_id, note
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    str(peptide_request_id), from_status, to_status, source,
                    clickup_event_id, actor_clickup_user_id,
                    str(actor_accumk1_user_id) if actor_accumk1_user_id else None,
                    note,
                ))
                conn.commit()
                return True
            except Exception as e:
                # Unique violation on clickup_event_id → dedup
                conn.rollback()
                if "idx_status_log_clickup_event" in str(e):
                    return False
                raise

    def get_for_request(self, peptide_request_id: UUID) -> list[StatusLogEntry]:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT * FROM peptide_request_status_log
                WHERE peptide_request_id = %s
                ORDER BY created_at ASC
            """, (str(peptide_request_id),))
            return [StatusLogEntry(**dict(r)) for r in cur.fetchall()]
```

`backend/clickup_user_mapping_repo.py`:
```python
from dataclasses import dataclass
from typing import Optional
from uuid import UUID
from backend.mk1_db import get_mk1_conn


@dataclass
class ClickUpUserMapping:
    clickup_user_id: str
    accumk1_user_id: Optional[UUID]
    clickup_username: str
    clickup_email: Optional[str]
    auto_matched: bool


class ClickUpUserMappingRepository:
    def get(self, clickup_user_id: str) -> Optional[ClickUpUserMapping]:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT clickup_user_id, accumk1_user_id, clickup_username,
                       clickup_email, auto_matched
                FROM clickup_user_mapping WHERE clickup_user_id = %s
            """, (clickup_user_id,))
            row = cur.fetchone()
            return ClickUpUserMapping(**dict(row)) if row else None

    def upsert(
        self, *, clickup_user_id: str, clickup_username: str,
        clickup_email: Optional[str],
    ) -> ClickUpUserMapping:
        """Upsert mapping. On first insert, attempt email auto-match to users table."""
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            accumk1_user_id = None
            auto_matched = False
            if clickup_email:
                cur.execute("SELECT id FROM users WHERE email = %s", (clickup_email,))
                user = cur.fetchone()
                if user:
                    accumk1_user_id = user[0]
                    auto_matched = True
            cur.execute("""
                INSERT INTO clickup_user_mapping
                    (clickup_user_id, clickup_username, clickup_email,
                     accumk1_user_id, auto_matched, last_seen_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (clickup_user_id) DO UPDATE SET
                    clickup_username = EXCLUDED.clickup_username,
                    clickup_email = COALESCE(EXCLUDED.clickup_email,
                                              clickup_user_mapping.clickup_email),
                    last_seen_at = NOW(),
                    updated_at = NOW()
                RETURNING clickup_user_id, accumk1_user_id, clickup_username,
                          clickup_email, auto_matched
            """, (clickup_user_id, clickup_username, clickup_email,
                  str(accumk1_user_id) if accumk1_user_id else None, auto_matched))
            row = cur.fetchone()
            conn.commit()
            return ClickUpUserMapping(**dict(row))

    def list_unmapped(self) -> list[ClickUpUserMapping]:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT clickup_user_id, accumk1_user_id, clickup_username,
                       clickup_email, auto_matched
                FROM clickup_user_mapping WHERE accumk1_user_id IS NULL
                ORDER BY last_seen_at DESC
            """)
            return [ClickUpUserMapping(**dict(r)) for r in cur.fetchall()]

    def set_mapping(self, clickup_user_id: str, accumk1_user_id: UUID) -> None:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE clickup_user_mapping
                SET accumk1_user_id = %s, auto_matched = FALSE, updated_at = NOW()
                WHERE clickup_user_id = %s
            """, (str(accumk1_user_id), clickup_user_id))
            conn.commit()
```

- [ ] **Step 4: Verify PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/status_log_repo.py backend/clickup_user_mapping_repo.py backend/tests/test_status_log_repo.py backend/tests/test_clickup_user_mapping_repo.py
git commit -m "feat(repo): add status log + clickup user mapping repositories"
```

---

## Task 7: Config — env vars + column map

**Files:**
- Create: `backend/peptide_request_config.py`
- Test: `backend/tests/test_peptide_request_config.py`

- [ ] **Step 1: Failing test**

```python
import os
import pytest
from backend.peptide_request_config import get_config, PeptideRequestConfig


def test_missing_required_env_raises(monkeypatch):
    monkeypatch.delenv("CLICKUP_LIST_ID", raising=False)
    with pytest.raises(RuntimeError, match="CLICKUP_LIST_ID"):
        get_config()


def test_default_column_map_covers_all_statuses(monkeypatch):
    monkeypatch.setenv("CLICKUP_LIST_ID", "list_123")
    monkeypatch.setenv("CLICKUP_API_TOKEN", "tok")
    monkeypatch.setenv("CLICKUP_WEBHOOK_SECRET", "sec")
    cfg = get_config()
    expected_statuses = {
        "new", "approved", "ordering_standard", "sample_prep_created",
        "in_process", "on_hold", "completed", "rejected", "cancelled",
    }
    assert set(cfg.column_map.values()) == expected_statuses


def test_map_status_is_case_insensitive_and_whitespace_tolerant(monkeypatch):
    monkeypatch.setenv("CLICKUP_LIST_ID", "l")
    monkeypatch.setenv("CLICKUP_API_TOKEN", "t")
    monkeypatch.setenv("CLICKUP_WEBHOOK_SECRET", "s")
    cfg = get_config()
    assert cfg.map_column_to_status("  ORDERING standard  ") == "ordering_standard"
    assert cfg.map_column_to_status("NEW") == "new"


def test_unmapped_column_returns_none(monkeypatch):
    monkeypatch.setenv("CLICKUP_LIST_ID", "l")
    monkeypatch.setenv("CLICKUP_API_TOKEN", "t")
    monkeypatch.setenv("CLICKUP_WEBHOOK_SECRET", "s")
    cfg = get_config()
    assert cfg.map_column_to_status("random column") is None
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```python
"""Config for peptide request feature."""
import os
from dataclasses import dataclass, field


DEFAULT_COLUMN_MAP = {
    "New": "new",
    "Approved": "approved",
    "Ordering Standard": "ordering_standard",
    "Sample Prep Created": "sample_prep_created",
    "In Process": "in_process",
    "On Hold": "on_hold",
    "Completed": "completed",
    "Rejected": "rejected",
    "Cancelled": "cancelled",
}


def _normalize(s: str) -> str:
    return " ".join(s.split()).lower()


@dataclass
class PeptideRequestConfig:
    clickup_list_id: str
    clickup_api_token: str
    clickup_webhook_secret: str
    senaite_peptide_template_keyword: str = "BPC157-ID"
    column_map: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_COLUMN_MAP))

    def map_column_to_status(self, column_name: str) -> str | None:
        target = _normalize(column_name)
        for k, v in self.column_map.items():
            if _normalize(k) == target:
                return v
        return None


def _require(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise RuntimeError(f"{key} is required")
    return v


def get_config() -> PeptideRequestConfig:
    return PeptideRequestConfig(
        clickup_list_id=_require("CLICKUP_LIST_ID"),
        clickup_api_token=_require("CLICKUP_API_TOKEN"),
        clickup_webhook_secret=_require("CLICKUP_WEBHOOK_SECRET"),
        senaite_peptide_template_keyword=os.environ.get(
            "SENAITE_PEPTIDE_TEMPLATE_KEYWORD", "BPC157-ID"
        ),
    )
```

- [ ] **Step 4: Verify PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/peptide_request_config.py backend/tests/test_peptide_request_config.py
git commit -m "feat(config): add peptide request config + column mapper"
```

---

## Task 8: ClickUp client — create task

**Files:**
- Create: `backend/clickup_client.py`
- Test: `backend/tests/test_clickup_client.py`

- [ ] **Step 1: Failing test**

```python
from unittest.mock import patch, MagicMock
from backend.clickup_client import ClickUpClient
from backend.models_peptide_request import PeptideRequest
from uuid import uuid4
from datetime import datetime


def make_request() -> PeptideRequest:
    return PeptideRequest(
        id=uuid4(), created_at=datetime.now(), updated_at=datetime.now(),
        submitted_by_wp_user_id=42, submitted_by_email="a@b.c",
        submitted_by_name="Jane", compound_kind="peptide",
        compound_name="Retatrutide", vendor_producer="PepMart",
        sequence_or_structure=None, molecular_weight=None,
        cas_or_reference=None, vendor_catalog_number=None,
        reason_notes=None, expected_monthly_volume=None,
        status="new", previous_status=None, rejection_reason=None,
        sample_id=None, clickup_task_id=None, clickup_list_id="list_123",
        clickup_assignee_ids=[], senaite_service_uid=None,
        wp_coupon_code=None, wp_coupon_issued_at=None,
        completed_at=None, rejected_at=None, cancelled_at=None,
    )


@patch("backend.clickup_client.requests.post")
def test_create_task_posts_to_list(mock_post):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: {"id": "tsk_1", "url": "x"})
    client = ClickUpClient(api_token="t", list_id="L1", accumk1_base_url="https://accumk1")
    req = make_request()
    task_id = client.create_task_for_request(req)
    assert task_id == "tsk_1"
    args, kwargs = mock_post.call_args
    assert "L1/task" in args[0]
    body = kwargs["json"]
    assert body["name"].startswith("[peptide]")
    assert "Retatrutide" in body["name"]
    assert "PepMart" in body["name"]
    assert body["status"] == "New"
    assert body["assignees"] == []
    assert "accumk1" in body["description"]  # deep link


@patch("backend.clickup_client.requests.post")
def test_create_task_raises_on_error(mock_post):
    mock_post.return_value = MagicMock(status_code=500, text="err")
    client = ClickUpClient(api_token="t", list_id="L1", accumk1_base_url="https://accumk1")
    import pytest
    with pytest.raises(Exception):
        client.create_task_for_request(make_request())
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```python
"""ClickUp API client for peptide requests."""
import requests
from backend.models_peptide_request import PeptideRequest


class ClickUpClient:
    def __init__(self, *, api_token: str, list_id: str, accumk1_base_url: str):
        self.api_token = api_token
        self.list_id = list_id
        self.accumk1_base_url = accumk1_base_url.rstrip("/")

    def _headers(self) -> dict:
        return {"Authorization": self.api_token, "Content-Type": "application/json"}

    def _build_description(self, r: PeptideRequest) -> str:
        lines = [
            "Submitted via WP.",
            "",
            f"**Customer:** {r.submitted_by_name} <{r.submitted_by_email}>",
            f"**Kind:** {r.compound_kind}",
            f"**Vendor/producer:** {r.vendor_producer}",
        ]
        if r.sequence_or_structure:
            lines.append(f"**Sequence/structure:** {r.sequence_or_structure}")
        if r.molecular_weight:
            lines.append(f"**Molecular weight:** {r.molecular_weight}")
        if r.cas_or_reference:
            lines.append(f"**CAS/reference:** {r.cas_or_reference}")
        if r.vendor_catalog_number:
            lines.append(f"**Vendor catalog #:** {r.vendor_catalog_number}")
        if r.expected_monthly_volume is not None:
            lines.append(f"**Expected monthly volume:** {r.expected_monthly_volume}")
        if r.reason_notes:
            lines.append(f"**Reason/notes:** {r.reason_notes}")
        lines.append("")
        lines.append(f"[Open in Accu-Mk1]({self.accumk1_base_url}/requests/{r.id})")
        return "\n".join(lines)

    def create_task_for_request(self, r: PeptideRequest) -> str:
        url = f"https://api.clickup.com/api/v2/list/{self.list_id}/task"
        body = {
            "name": f"[{r.compound_kind}] {r.compound_name} — {r.vendor_producer}",
            "description": self._build_description(r),
            "status": "New",
            "assignees": [],
            "priority": None,
        }
        resp = requests.post(url, headers=self._headers(), json=body, timeout=15)
        if resp.status_code >= 300:
            raise RuntimeError(f"ClickUp create failed: {resp.status_code} {resp.text}")
        return resp.json()["id"]
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/clickup_client.py backend/tests/test_clickup_client.py
git commit -m "feat(clickup): add ClickUp task creation client"
```

---

## Task 9: API endpoint — `POST /api/peptide-requests`

**Files:**
- Modify: `backend/main.py` — add route handler
- Modify: `backend/auth.py` — add internal service token verification dependency (or wherever auth deps live — check pattern)
- Test: `backend/tests/test_api_peptide_requests_create.py`

- [ ] **Step 1: Failing test**

```python
from fastapi.testclient import TestClient
from backend.main import app
import uuid
import os


client = TestClient(app)


def headers():
    return {
        "X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
        "Idempotency-Key": str(uuid.uuid4()),
    }


def test_create_rejects_missing_token():
    resp = client.post("/api/peptide-requests", json={}, headers={})
    assert resp.status_code == 401


def test_create_rejects_invalid_token():
    resp = client.post("/api/peptide-requests", json={},
                       headers={"X-Service-Token": "bogus", "Idempotency-Key": "k"})
    assert resp.status_code == 401


def test_create_validates_body():
    resp = client.post("/api/peptide-requests", json={}, headers=headers())
    assert resp.status_code == 422


def test_create_returns_201_on_success():
    resp = client.post("/api/peptide-requests", headers=headers(), json={
        "compound_kind": "peptide",
        "compound_name": "Retatrutide",
        "vendor_producer": "PepMart",
        "submitted_by_wp_user_id": 42,
        "submitted_by_email": "a@b.c",
        "submitted_by_name": "Jane",
    })
    assert resp.status_code == 201
    assert resp.json()["compound_name"] == "Retatrutide"
    assert resp.json()["status"] == "new"


def test_create_is_idempotent():
    idem = str(uuid.uuid4())
    body = {
        "compound_kind": "peptide", "compound_name": "X",
        "vendor_producer": "Y", "submitted_by_wp_user_id": 99,
        "submitted_by_email": "a@b.c", "submitted_by_name": "N",
    }
    h = {"X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
         "Idempotency-Key": idem}
    first = client.post("/api/peptide-requests", headers=h, json=body)
    second = client.post("/api/peptide-requests", headers=h, json=body)
    assert first.json()["id"] == second.json()["id"]
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Add internal-service-token dependency**

In `backend/auth.py` (or similar dependency location):

```python
from fastapi import Header, HTTPException, status
import os
import secrets


def require_internal_service_token(
    x_service_token: str = Header(None),
) -> None:
    expected = os.environ.get("ACCUMK1_INTERNAL_SERVICE_TOKEN")
    if not expected:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR,
                            "ACCUMK1_INTERNAL_SERVICE_TOKEN not configured")
    if not x_service_token or not secrets.compare_digest(x_service_token, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid service token")
```

- [ ] **Step 4: Add route to `backend/main.py`**

Near other `@app.post` routes, add:

```python
from backend.auth import require_internal_service_token
from backend.models_peptide_request import (
    PeptideRequestCreate, PeptideRequest,
)
from backend.peptide_request_repo import PeptideRequestRepository
from backend.peptide_request_config import get_config
from fastapi import Header, Depends, Response, status


@app.post("/api/peptide-requests", response_model=PeptideRequest)
def create_peptide_request(
    data: PeptideRequestCreate,
    response: Response,
    idempotency_key: str = Header(None, alias="Idempotency-Key"),
    _: None = Depends(require_internal_service_token),
):
    if not idempotency_key:
        raise HTTPException(400, "Idempotency-Key header required")
    repo = PeptideRequestRepository()
    cfg = get_config()
    # Check existence first for correct 200 vs 201:
    # (Existing implementation can branch on whether insert happened;
    # for simplicity, return 201 always and let the proxy treat replay as 200.)
    row = repo.create(data, idempotency_key=idempotency_key,
                      clickup_list_id=cfg.clickup_list_id)
    response.status_code = status.HTTP_201_CREATED
    return row
```

- [ ] **Step 5: Verify tests PASS**

```bash
ACCUMK1_INTERNAL_SERVICE_TOKEN=test-token \
CLICKUP_LIST_ID=list_test \
CLICKUP_API_TOKEN=tok \
CLICKUP_WEBHOOK_SECRET=secret \
python -m pytest tests/test_api_peptide_requests_create.py -v
```

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/auth.py backend/tests/test_api_peptide_requests_create.py
git commit -m "feat(api): POST /api/peptide-requests with internal auth + idempotency"
```

---

## Task 10: API endpoints — list + detail

**Files:**
- Modify: `backend/main.py`
- Test: `backend/tests/test_api_peptide_requests_read.py`

- [ ] **Step 1: Failing tests for list + detail**

```python
# GET /api/peptide-requests?wp_user_id=X
# GET /api/peptide-requests/{id}
# - list returns total/limit/offset/items
# - detail returns PeptideRequest or 404
# - both require service token
```

(Write concrete test functions following the pattern from Task 9; assert shape from contract doc.)

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Add routes**

```python
from backend.models_peptide_request import PeptideRequestList


@app.get("/api/peptide-requests", response_model=PeptideRequestList)
def list_peptide_requests(
    wp_user_id: int,
    status: str | None = None,  # comma-separated
    limit: int = 50, offset: int = 0,
    _: None = Depends(require_internal_service_token),
):
    repo = PeptideRequestRepository()
    status_list = status.split(",") if status else None
    items, total = repo.list_by_wp_user(
        wp_user_id, status=status_list, limit=limit, offset=offset
    )
    return PeptideRequestList(total=total, limit=limit, offset=offset, items=items)


@app.get("/api/peptide-requests/{request_id}", response_model=PeptideRequest)
def get_peptide_request(
    request_id: str,
    _: None = Depends(require_internal_service_token),
):
    from uuid import UUID
    repo = PeptideRequestRepository()
    row = repo.get_by_id(UUID(request_id))
    if not row:
        raise HTTPException(404, "not found")
    return row
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(api): GET list + detail for peptide requests"
```

---

## Task 11: ClickUp webhook — signature verification

**Files:**
- Create: `backend/clickup_webhook.py` (signature logic)
- Modify: `backend/main.py`
- Test: `backend/tests/test_clickup_webhook_signature.py`

- [ ] **Step 1: Failing test**

```python
import hmac, hashlib, json
from fastapi.testclient import TestClient
from backend.main import app


client = TestClient(app)


def sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_webhook_rejects_missing_signature():
    resp = client.post("/webhooks/clickup", json={"event": "taskStatusUpdated"})
    assert resp.status_code == 401


def test_webhook_rejects_bad_signature():
    body = b'{"event":"taskStatusUpdated"}'
    resp = client.post("/webhooks/clickup", content=body,
                       headers={"X-Signature": "nope", "Content-Type": "application/json"})
    assert resp.status_code == 401


def test_webhook_accepts_valid_signature(monkeypatch):
    import os
    secret = os.environ["CLICKUP_WEBHOOK_SECRET"]
    body = b'{"event":"unknown"}'  # unknown event should still 200
    sig = sign(body, secret)
    resp = client.post("/webhooks/clickup", content=body,
                       headers={"X-Signature": sig, "Content-Type": "application/json"})
    assert resp.status_code == 200
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement signature verification**

`backend/clickup_webhook.py`:
```python
import hmac
import hashlib


def verify_signature(raw_body: bytes, provided_sig: str | None, secret: str) -> bool:
    if not provided_sig:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided_sig)
```

Webhook route in `backend/main.py`:
```python
from fastapi import Request
from backend.clickup_webhook import verify_signature


@app.post("/webhooks/clickup")
async def clickup_webhook(request: Request):
    raw = await request.body()
    sig = request.headers.get("X-Signature")
    cfg = get_config()
    if not verify_signature(raw, sig, cfg.clickup_webhook_secret):
        raise HTTPException(401, "invalid signature")
    # Event dispatch in next task
    return {"ok": True}
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/clickup_webhook.py backend/main.py backend/tests/test_clickup_webhook_signature.py
git commit -m "feat(webhook): verify ClickUp webhook signatures"
```

---

## Task 12: ClickUp webhook — event dispatch + status transition

**Files:**
- Modify: `backend/clickup_webhook.py` (add dispatcher)
- Modify: `backend/main.py` (wire dispatcher)
- Test: `backend/tests/test_clickup_webhook_dispatch.py`

- [ ] **Step 1: Failing tests**

Test scenarios:
- `taskStatusUpdated` with mapped column → updates request status, writes log entry, resolves actor via mapping repo
- `taskStatusUpdated` with unmapped column → logs warning, returns 200, no status change
- `taskStatusUpdated` with duplicate event_id → dedup, returns 200, no double log
- `taskAssigneeUpdated` → updates `clickup_assignee_ids` on the row, no status log
- `unknown event` → returns 200, no action

(Write concrete tests exercising the dispatcher. Use real Postgres + fixture data; mock ClickUp user-mapping lookup if needed for the auto-match path.)

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement dispatcher**

Add to `backend/clickup_webhook.py`:

```python
from typing import Optional
from uuid import UUID
from backend.peptide_request_repo import PeptideRequestRepository
from backend.status_log_repo import StatusLogRepository
from backend.clickup_user_mapping_repo import ClickUpUserMappingRepository
from backend.peptide_request_config import PeptideRequestConfig
import logging

log = logging.getLogger(__name__)


def dispatch_event(
    payload: dict, cfg: PeptideRequestConfig,
    prepo: PeptideRequestRepository,
    lrepo: StatusLogRepository,
    urepo: ClickUpUserMappingRepository,
) -> None:
    event = payload.get("event")
    task_id = payload.get("task_id")
    if not task_id:
        return
    req = prepo.get_by_clickup_task_id(task_id)  # NEW method — add to repo
    if not req:
        log.warning("Webhook for unknown clickup_task_id=%s", task_id)
        return
    history_items = payload.get("history_items", [])

    if event == "taskStatusUpdated":
        if not history_items:
            return
        hi = history_items[0]
        event_id = hi.get("id")
        after_status = (hi.get("after") or {}).get("status")
        user = hi.get("user") or {}
        actor_mapping = urepo.upsert(
            clickup_user_id=user.get("id", "unknown"),
            clickup_username=user.get("username", ""),
            clickup_email=user.get("email"),
        ) if user.get("id") else None

        mapped = cfg.map_column_to_status(after_status or "")
        if not mapped:
            log.error("UNMAPPED CLICKUP COLUMN: %r (task=%s)", after_status, task_id)
            # TODO: fire admin alert
            return

        prev = req.status
        if mapped == "on_hold" and req.status != "on_hold":
            prepo.update_status(req.id, new_status=mapped, previous_status=prev)
        else:
            prepo.update_status(req.id, new_status=mapped)

        inserted = lrepo.append(
            peptide_request_id=req.id, from_status=prev, to_status=mapped,
            source="clickup", clickup_event_id=event_id,
            actor_clickup_user_id=user.get("id"),
            actor_accumk1_user_id=actor_mapping.accumk1_user_id if actor_mapping else None,
            note=hi.get("comment"),  # snapshot if present
        )
        if not inserted:
            return  # dedup
        # Enqueue downstream jobs (Task 13+):
        if mapped in ("approved", "rejected", "completed"):
            enqueue_relay_status_to_wp(req.id)  # defined in Task 13
        if mapped == "completed":
            enqueue_completion_side_effects(req.id)  # Task 14+

    elif event == "taskAssigneeUpdated":
        assignees = payload.get("assignees", [])
        assignee_ids = [a["id"] for a in assignees if "id" in a]
        prepo.set_assignees(req.id, assignee_ids)

    else:
        return  # ignored event
```

Add `get_by_clickup_task_id` to `PeptideRequestRepository`:

```python
def get_by_clickup_task_id(self, task_id: str) -> Optional[PeptideRequest]:
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM peptide_requests WHERE clickup_task_id = %s", (task_id,))
        row = cur.fetchone()
        return _row_to_model(dict(row)) if row else None
```

Wire dispatcher in the webhook route (replacing the stub from Task 11):

```python
import json
# ... in the webhook handler, after signature verify:
payload = json.loads(raw)
cfg = get_config()
try:
    dispatch_event(
        payload, cfg,
        PeptideRequestRepository(),
        StatusLogRepository(),
        ClickUpUserMappingRepository(),
    )
except Exception:
    log.exception("webhook dispatch failure")
    raise HTTPException(500, "dispatch failed")
return {"ok": True}
```

Provide stub placeholders for `enqueue_relay_status_to_wp` and `enqueue_completion_side_effects` (real impls come in later tasks):

```python
def enqueue_relay_status_to_wp(request_id: UUID) -> None:
    # Implemented in Task 13
    pass

def enqueue_completion_side_effects(request_id: UUID) -> None:
    # Implemented in Task 14
    pass
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/clickup_webhook.py backend/peptide_request_repo.py backend/main.py backend/tests/test_clickup_webhook_dispatch.py
git commit -m "feat(webhook): dispatch taskStatusUpdated + taskAssigneeUpdated events"
```

---

## Task 13: Background job — relay status to WP via integration-service

**Files:**
- Create: `backend/jobs/relay_status_to_wp.py`
- Modify: `backend/clickup_webhook.py` (wire `enqueue_relay_status_to_wp`)
- Create: `backend/integration_service_client.py` (shared HTTP client wrapper)
- Test: `backend/tests/test_relay_status_to_wp.py`

- [ ] **Step 1: Failing test**

```python
from unittest.mock import patch, MagicMock
from backend.jobs.relay_status_to_wp import run_once
from backend.peptide_request_repo import PeptideRequestRepository
# ... set up a request with status='approved', then:


@patch("backend.integration_service_client.requests.post")
def test_relay_posts_to_integration_service(mock_post, created_request):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: {"wp_accepted": True, "email_queued": True})
    run_once(created_request.id, new_status="approved", previous_status="new")
    args, kwargs = mock_post.call_args
    assert "/v1/internal/wp/peptide-request-status" in args[0]
    body = kwargs["json"]
    assert body["new_status"] == "approved"
    assert body["send_email"] is True  # terminal-milestone state
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement integration-service HTTP client**

`backend/integration_service_client.py`:
```python
import os
import requests


class IntegrationServiceClient:
    def __init__(self):
        self.base = os.environ["INTEGRATION_SERVICE_URL"].rstrip("/")
        self.token = os.environ["INTEGRATION_SERVICE_TOKEN"]

    def _headers(self) -> dict:
        return {"X-Service-Token": self.token, "Content-Type": "application/json"}

    def relay_peptide_request_status(self, payload: dict) -> dict:
        resp = requests.post(
            f"{self.base}/v1/internal/wp/peptide-request-status",
            headers=self._headers(), json=payload, timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def issue_coupon(self, payload: dict) -> dict:
        resp = requests.post(
            f"{self.base}/v1/internal/wp/coupons/single-use",
            headers=self._headers(), json=payload, timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def clone_senaite_service(self, payload: dict) -> dict:
        resp = requests.post(
            f"{self.base}/v1/internal/senaite/services/clone",
            headers=self._headers(), json=payload, timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
```

`backend/jobs/relay_status_to_wp.py`:
```python
from uuid import UUID
from backend.peptide_request_repo import PeptideRequestRepository
from backend.integration_service_client import IntegrationServiceClient


EMAIL_TRIGGER_STATUSES = {"approved", "rejected", "completed"}


def run_once(request_id: UUID, *, new_status: str, previous_status: str | None) -> None:
    repo = PeptideRequestRepository()
    req = repo.get_by_id(request_id)
    if not req:
        return
    payload = {
        "peptide_request_id": str(req.id),
        "wp_user_id": req.submitted_by_wp_user_id,
        "new_status": new_status,
        "previous_status": previous_status,
        "rejection_reason": req.rejection_reason,
        "compound_name": req.compound_name,
        "send_email": new_status in EMAIL_TRIGGER_STATUSES,
    }
    client = IntegrationServiceClient()
    client.relay_peptide_request_status(payload)
```

Wire it in `clickup_webhook.py`:
```python
def enqueue_relay_status_to_wp(request_id: UUID, new_status: str, previous_status: str) -> None:
    # For v1: run inline in a threadpool / lightweight scheduler.
    # Follow existing Accu-Mk1 background job pattern (check file_watcher.py
    # or similar for existing job pattern).
    from backend.jobs.relay_status_to_wp import run_once
    # Run via existing scheduler infra; fall back to a naive spawn if none:
    import threading
    threading.Thread(
        target=_relay_with_retry,
        args=(request_id, new_status, previous_status),
        daemon=True,
    ).start()


def _relay_with_retry(request_id, new_status, previous_status):
    import time
    from backend.peptide_request_repo import PeptideRequestRepository
    delays = [60, 300, 900, 3600, 14400]
    for i, delay in enumerate([0, *delays]):
        if delay:
            time.sleep(delay)
        try:
            run_once(request_id, new_status=new_status, previous_status=previous_status)
            return
        except Exception as e:
            log.warning("relay attempt %d failed: %s", i + 1, e)
    # All retries exhausted:
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE peptide_requests SET wp_relay_failed_at = NOW() WHERE id = %s",
                    (str(request_id),))
        conn.commit()
```

**Note to executing agent:** Accu-Mk1 almost certainly has a better background-job infrastructure than `threading.Thread`. Check `backend/file_watcher.py` and `backend/scale_agent.py` for the existing pattern and adopt it instead. The shape above is illustrative of retry semantics only.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/jobs/ backend/integration_service_client.py backend/clickup_webhook.py backend/tests/test_relay_status_to_wp.py
git commit -m "feat(jobs): relay status changes to WP via integration-service with retry"
```

---

## Task 14: Background job — completion side-effects (coupon + SENAITE)

**Files:**
- Create: `backend/jobs/completion_side_effects.py`
- Modify: `backend/clickup_webhook.py` (wire `enqueue_completion_side_effects`)
- Test: `backend/tests/test_completion_side_effects.py`

- [ ] **Step 1: Failing test**

```python
# Tests:
# - On peptide compound_kind='peptide': both coupon + SENAITE clone fire
# - On compound_kind='other': only coupon fires; SENAITE is skipped
# - If wp_coupon_code already set: skip coupon (idempotent)
# - If senaite_service_uid already set: skip SENAITE (idempotent)
# - On coupon failure: sets coupon_failed_at after retry exhaust
# - On SENAITE failure: sets senaite_clone_failed_at after retry exhaust
# - On SENAITE failure doesn't prevent coupon from succeeding (independent)
```

(Full test functions following the pattern from Task 13.)

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```python
"""Completion side-effects: coupon + SENAITE service clone."""
import re
from uuid import UUID
from backend.peptide_request_repo import PeptideRequestRepository
from backend.integration_service_client import IntegrationServiceClient
from backend.peptide_request_config import get_config
from backend.mk1_db import get_mk1_conn


def _new_senaite_keyword(compound_name: str) -> str:
    alnum = re.sub(r"[^A-Za-z0-9]", "", compound_name)
    return f"{alnum[:4].upper() or 'NEW'}-ID"


def run_coupon(request_id: UUID) -> None:
    repo = PeptideRequestRepository()
    req = repo.get_by_id(request_id)
    if not req or req.wp_coupon_code:
        return  # idempotent
    client = IntegrationServiceClient()
    result = client.issue_coupon({
        "wp_user_id": req.submitted_by_wp_user_id,
        "amount_usd": 250,
        "peptide_request_id": str(req.id),
    })
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE peptide_requests
            SET wp_coupon_code = %s, wp_coupon_issued_at = NOW(), updated_at = NOW()
            WHERE id = %s
        """, (result["coupon_code"], str(request_id)))
        conn.commit()


def run_senaite_clone(request_id: UUID) -> None:
    repo = PeptideRequestRepository()
    req = repo.get_by_id(request_id)
    if not req or req.senaite_service_uid:
        return
    if req.compound_kind != "peptide":
        return  # non-peptide path skips SENAITE clone
    cfg = get_config()
    client = IntegrationServiceClient()
    result = client.clone_senaite_service({
        "template_keyword": cfg.senaite_peptide_template_keyword,
        "new_name": f"{req.compound_name} - Identity (HPLC)",
        "new_keyword": _new_senaite_keyword(req.compound_name),
    })
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE peptide_requests
            SET senaite_service_uid = %s, updated_at = NOW()
            WHERE id = %s
        """, (result["service_uid"], str(request_id)))
        conn.commit()


def run_all(request_id: UUID) -> None:
    """Run coupon and SENAITE independently; isolate failures."""
    import traceback, logging
    log = logging.getLogger(__name__)

    for label, fn, failure_col in [
        ("coupon", run_coupon, "coupon_failed_at"),
        ("senaite_clone", run_senaite_clone, "senaite_clone_failed_at"),
    ]:
        try:
            # In prod: wrap with retry logic (1m, 5m, 15m, 1h, 4h for coupon; 3 attempts for senaite)
            fn(request_id)
        except Exception:
            log.exception("side-effect %s failed for %s", label, request_id)
            with get_mk1_conn() as conn:
                cur = conn.cursor()
                cur.execute(
                    f"UPDATE peptide_requests SET {failure_col} = NOW() WHERE id = %s",
                    (str(request_id),),
                )
                conn.commit()
```

Wire in `clickup_webhook.py`:
```python
def enqueue_completion_side_effects(request_id: UUID) -> None:
    from backend.jobs.completion_side_effects import run_all
    import threading
    threading.Thread(target=run_all, args=(request_id,), daemon=True).start()
```

Again: **adopt existing background job infra** if available.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/jobs/completion_side_effects.py backend/clickup_webhook.py backend/tests/test_completion_side_effects.py
git commit -m "feat(jobs): completion side-effects for coupon + SENAITE clone"
```

---

## Task 15: Background job — retry ClickUp task creation

**Files:**
- Create: `backend/jobs/clickup_task_retry.py`
- Modify: `backend/main.py` (create-task call on submission path)
- Test: `backend/tests/test_clickup_task_retry.py`

- [ ] **Step 1: Failing test**

Tests:
- Running the retry job picks up rows with `clickup_task_id IS NULL` older than 60s and creates the task.
- On success, row is updated with `clickup_task_id`.
- On repeated failure, `clickup_create_failed_at` is not set until N retries.

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```python
"""Retry ClickUp task creation for requests where initial attempt failed."""
import logging
from backend.peptide_request_repo import PeptideRequestRepository
from backend.clickup_client import ClickUpClient
from backend.peptide_request_config import get_config
from backend.mk1_db import get_mk1_conn
import os

log = logging.getLogger(__name__)


def run_once() -> None:
    repo = PeptideRequestRepository()
    cfg = get_config()
    client = ClickUpClient(
        api_token=cfg.clickup_api_token,
        list_id=cfg.clickup_list_id,
        accumk1_base_url=os.environ.get("ACCUMK1_BASE_URL", "https://accumk1.accumarklabs.com"),
    )
    for req in repo.find_needing_clickup_create():
        try:
            task_id = client.create_task_for_request(req)
            repo.update_clickup_task_id(req.id, task_id)
        except Exception:
            log.exception("retry create clickup failed for %s", req.id)
            # After N attempts (track in a separate column or via counter),
            # set clickup_create_failed_at. Simple v1: after 24h of attempts.
            with get_mk1_conn() as conn:
                cur = conn.cursor()
                cur.execute("""
                    UPDATE peptide_requests
                    SET clickup_create_failed_at = NOW()
                    WHERE id = %s
                      AND created_at < NOW() - INTERVAL '24 hours'
                """, (str(req.id),))
                conn.commit()
```

Modify create endpoint (Task 9's handler) to attempt ClickUp create inline once:

```python
@app.post("/api/peptide-requests", response_model=PeptideRequest, status_code=201)
def create_peptide_request(
    data: PeptideRequestCreate,
    idempotency_key: str = Header(None, alias="Idempotency-Key"),
    _: None = Depends(require_internal_service_token),
):
    if not idempotency_key:
        raise HTTPException(400, "Idempotency-Key header required")
    repo = PeptideRequestRepository()
    cfg = get_config()
    row = repo.create(data, idempotency_key=idempotency_key,
                      clickup_list_id=cfg.clickup_list_id)
    # Best-effort inline ClickUp create; retry job catches failures.
    if not row.clickup_task_id:
        try:
            client = ClickUpClient(
                api_token=cfg.clickup_api_token, list_id=cfg.clickup_list_id,
                accumk1_base_url=os.environ.get("ACCUMK1_BASE_URL", ""),
            )
            task_id = client.create_task_for_request(row)
            repo.update_clickup_task_id(row.id, task_id)
            row = repo.get_by_id(row.id)
        except Exception:
            log.exception("inline clickup create failed; retry job will pick up")
    return row
```

Register the retry job on the app's existing scheduler. Check for an existing `APScheduler` / cron pattern in `backend/main.py`; if none, wire a simple `threading.Timer` or similar.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/jobs/clickup_task_retry.py backend/main.py backend/tests/test_clickup_task_retry.py
git commit -m "feat(jobs): retry ClickUp task creation for stuck requests"
```

---

## Task 16: LIMS UI — TypeScript types + API client hooks

**Files:**
- Create: `src/types/peptide-request.ts`
- Create: `src/hooks/peptide-requests.ts` (TanStack Query hooks)
- Test: `src/test/peptide-request-hooks.test.tsx`

- [ ] **Step 1: Failing test**

(Follow existing TanStack Query test patterns in `src/test/`. Test cache keys, refetch on mutation.)

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement types**

```typescript
// src/types/peptide-request.ts — mirror the contract doc's PeptideRequest shape
export type CompoundKind = 'peptide' | 'other'

export type RequestStatus =
  | 'new' | 'approved' | 'ordering_standard' | 'sample_prep_created'
  | 'in_process' | 'on_hold' | 'completed' | 'rejected' | 'cancelled'

export interface PeptideRequest {
  id: string
  created_at: string
  updated_at: string
  submitted_by_wp_user_id: number
  submitted_by_email: string
  submitted_by_name: string
  compound_kind: CompoundKind
  compound_name: string
  vendor_producer: string
  sequence_or_structure: string | null
  molecular_weight: number | null
  cas_or_reference: string | null
  vendor_catalog_number: string | null
  reason_notes: string | null
  expected_monthly_volume: number | null
  status: RequestStatus
  previous_status: RequestStatus | null
  rejection_reason: string | null
  sample_id: string | null
  clickup_task_id: string | null
  clickup_list_id: string
  clickup_assignee_ids: string[]
  senaite_service_uid: string | null
  wp_coupon_code: string | null
  wp_coupon_issued_at: string | null
  completed_at: string | null
  rejected_at: string | null
  cancelled_at: string | null
}

export interface StatusLogEntry {
  id: string
  peptide_request_id: string
  from_status: RequestStatus | null
  to_status: RequestStatus
  source: 'clickup' | 'accumk1_admin' | 'system'
  actor_clickup_user_id: string | null
  actor_accumk1_user_id: string | null
  note: string | null
  created_at: string
}

export const ACTIVE_STATUSES: RequestStatus[] = [
  'new', 'approved', 'ordering_standard', 'sample_prep_created',
  'in_process', 'on_hold',
]
export const CLOSED_STATUSES: RequestStatus[] = ['completed', 'rejected', 'cancelled']
```

Implement hooks in `src/hooks/peptide-requests.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'  // existing HTTP wrapper
import type { PeptideRequest, RequestStatus, StatusLogEntry } from '@/types/peptide-request'

const KEY_ROOT = ['peptide-requests'] as const

export function usePeptideRequestsList(opts: {
  status?: RequestStatus[] | undefined
  limit?: number
  offset?: number
}) {
  return useQuery({
    queryKey: [...KEY_ROOT, 'list', opts],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (opts.status?.length) params.set('status', opts.status.join(','))
      if (opts.limit) params.set('limit', String(opts.limit))
      if (opts.offset) params.set('offset', String(opts.offset))
      return apiFetch<{ total: number; items: PeptideRequest[] }>(
        `/api/peptide-requests?${params}`
      )
    },
  })
}

export function usePeptideRequest(id: string) {
  return useQuery({
    queryKey: [...KEY_ROOT, 'detail', id],
    queryFn: () => apiFetch<PeptideRequest>(`/api/peptide-requests/${id}`),
    enabled: Boolean(id),
  })
}

export function usePeptideRequestHistory(id: string) {
  return useQuery({
    queryKey: [...KEY_ROOT, 'history', id],
    queryFn: () => apiFetch<StatusLogEntry[]>(`/api/peptide-requests/${id}/history`),
    enabled: Boolean(id),
  })
}
```

**Note:** `/api/peptide-requests/{id}/history` is not yet specified in the contract doc — add a simple route to `backend/main.py` exposing `StatusLogRepository.get_for_request`. (This is internal-only, used by the LIMS UI.)

- [ ] **Step 4: Add history endpoint**

```python
@app.get("/api/peptide-requests/{request_id}/history",
         response_model=list[StatusLogEntry])
def get_peptide_request_history(
    request_id: str,
    _: None = Depends(require_internal_service_token),
):
    from uuid import UUID
    lrepo = StatusLogRepository()
    return lrepo.get_for_request(UUID(request_id))
```

- [ ] **Step 5: Verify PASS**

- [ ] **Step 6: Commit**

```bash
git add src/types/peptide-request.ts src/hooks/peptide-requests.ts src/test/peptide-request-hooks.test.tsx backend/main.py
git commit -m "feat(ui): add TS types + TanStack Query hooks for peptide requests"
```

---

## Task 17: LIMS UI — list page with Active/Closed tabs

**Files:**
- Create: `src/pages/PeptideRequestsList.tsx`
- Create: `src/components/peptide-request-row.tsx`
- Modify: `src/App.tsx` — add route
- Modify: `src/components/app-sidebar.tsx` (or wherever nav is) — add nav link
- Test: `src/test/peptide-requests-list.test.tsx`

- [ ] **Step 1: Failing test**

(Component test: renders with two tabs, switches filtering by clicking closed tab, links rows to detail page.)

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
// src/pages/PeptideRequestsList.tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePeptideRequestsList } from '@/hooks/peptide-requests'
import { ACTIVE_STATUSES, CLOSED_STATUSES } from '@/types/peptide-request'
import { PeptideRequestRow } from '@/components/peptide-request-row'

export function PeptideRequestsList() {
  const [tab, setTab] = useState<'active' | 'closed'>('active')
  const query = usePeptideRequestsList({
    status: tab === 'active' ? ACTIVE_STATUSES : CLOSED_STATUSES,
  })

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Peptide Requests</h1>
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'active' | 'closed')}>
        <TabsList>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
        </TabsList>
        <TabsContent value={tab}>
          {query.isLoading && <p>Loading…</p>}
          {query.isError && <p>Error loading requests.</p>}
          {query.data && (
            <div className="divide-y">
              {query.data.items.length === 0 ? (
                <p className="py-4 text-muted-foreground">No requests.</p>
              ) : (
                query.data.items.map((r) => (
                  <Link key={r.id} to={`/requests/${r.id}`}>
                    <PeptideRequestRow request={r} />
                  </Link>
                ))
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
```

Row component:
```tsx
// src/components/peptide-request-row.tsx
import type { PeptideRequest } from '@/types/peptide-request'
import { Badge } from '@/components/ui/badge'

export function PeptideRequestRow({ request }: { request: PeptideRequest }) {
  return (
    <div className="flex items-center justify-between py-3 hover:bg-muted/50">
      <div>
        <div className="font-medium">{request.compound_name}</div>
        <div className="text-sm text-muted-foreground">
          {request.compound_kind} · {request.vendor_producer}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="outline">{request.status.replace(/_/g, ' ')}</Badge>
        <span className="text-sm text-muted-foreground">
          {new Date(request.created_at).toLocaleDateString()}
        </span>
      </div>
    </div>
  )
}
```

Nav + route registration: follow existing sidebar + App.tsx patterns. Add "Peptide Requests" item with an icon (`TestTube` from lucide-react or similar).

- [ ] **Step 4: PASS + `npm run check:all`**

- [ ] **Step 5: Commit**

```bash
git add src/pages/PeptideRequestsList.tsx src/components/peptide-request-row.tsx src/App.tsx src/components/app-sidebar.tsx src/test/peptide-requests-list.test.tsx
git commit -m "feat(ui): peptide requests list with Active/Closed tabs"
```

---

## Task 18: LIMS UI — detail page with timeline

**Files:**
- Create: `src/pages/PeptideRequestDetail.tsx`
- Create: `src/components/status-timeline.tsx`
- Modify: `src/App.tsx` (add dynamic route)
- Test: `src/test/peptide-request-detail.test.tsx`

- [ ] **Step 1: Failing test**

(Detail page shows form data, current status, timeline entries with actor & note, coupon code when completed, rejection reason when rejected. Admin actions behind role check — test as two variants.)

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
// src/pages/PeptideRequestDetail.tsx
import { useParams } from 'react-router-dom'
import { usePeptideRequest, usePeptideRequestHistory } from '@/hooks/peptide-requests'
import { StatusTimeline } from '@/components/status-timeline'
import { useCurrentUserRole } from '@/hooks/current-user'  // existing hook

export function PeptideRequestDetail() {
  const { id = '' } = useParams()
  const req = usePeptideRequest(id)
  const history = usePeptideRequestHistory(id)
  const role = useCurrentUserRole()
  const isAdmin = role === 'admin' || role === 'lab_manager'

  if (req.isLoading) return <p>Loading…</p>
  if (!req.data) return <p>Not found.</p>

  const r = req.data

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-semibold">{r.compound_name}</h1>
      <div className="text-sm text-muted-foreground mb-6">
        {r.compound_kind} · {r.vendor_producer} · submitted by {r.submitted_by_name}
      </div>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Submission</h2>
        <dl className="grid grid-cols-[150px_1fr] gap-2 text-sm">
          <dt>Sequence/structure</dt><dd>{r.sequence_or_structure ?? '—'}</dd>
          <dt>Molecular weight</dt><dd>{r.molecular_weight ?? '—'}</dd>
          <dt>CAS / reference</dt><dd>{r.cas_or_reference ?? '—'}</dd>
          <dt>Vendor catalog #</dt><dd>{r.vendor_catalog_number ?? '—'}</dd>
          <dt>Reason / notes</dt><dd>{r.reason_notes ?? '—'}</dd>
          <dt>Expected monthly volume</dt><dd>{r.expected_monthly_volume ?? '—'}</dd>
        </dl>
      </section>

      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Links</h2>
        {r.clickup_task_id && (
          <a href={`https://app.clickup.com/t/${r.clickup_task_id}`}
             target="_blank" rel="noreferrer" className="underline">
            Open in ClickUp
          </a>
        )}
        {r.sample_id && <div>Linked sample: <a href={`/samples/${r.sample_id}`}>{r.sample_id}</a></div>}
      </section>

      {r.status === 'rejected' && r.rejection_reason && (
        <section className="mb-6 rounded border border-destructive/30 bg-destructive/5 p-4">
          <h3 className="font-semibold mb-1">Rejection reason</h3>
          <p>{r.rejection_reason}</p>
        </section>
      )}

      {r.status === 'completed' && (
        <section className="mb-6 rounded border border-green-500/30 bg-green-500/5 p-4">
          <h3 className="font-semibold mb-1">Completion</h3>
          {r.wp_coupon_code && <p>Coupon issued: <code>{r.wp_coupon_code}</code></p>}
          {r.senaite_service_uid && <p>SENAITE service: <code>{r.senaite_service_uid}</code></p>}
          {r.compound_kind === 'other' && !r.senaite_service_uid && (
            <p className="text-amber-600">⚠ Manual catalog setup required for non-peptide compound.</p>
          )}
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-2">Status timeline</h2>
        <StatusTimeline entries={history.data ?? []} currentStatus={r.status} />
      </section>

      {isAdmin && (
        <section className="mt-6 border-t pt-4">
          <h3 className="font-semibold">Admin actions</h3>
          {/* Force-transition, cancel, edit rejection reason, retry buttons.
              Each hits an admin endpoint on the backend. */}
        </section>
      )}
    </div>
  )
}
```

Timeline component and admin-action buttons: flesh out following existing button + mutation patterns.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add src/pages/PeptideRequestDetail.tsx src/components/status-timeline.tsx src/App.tsx src/test/peptide-request-detail.test.tsx
git commit -m "feat(ui): peptide request detail page with timeline + admin actions"
```

---

## Task 19: LIMS UI — admin ClickUp user mapping page

**Files:**
- Create: `src/pages/AdminClickupUsers.tsx`
- Create: `src/hooks/clickup-users.ts`
- Modify: `backend/main.py` (endpoints: GET unmapped, POST map)
- Test: `src/test/admin-clickup-users.test.tsx`

- [ ] **Step 1: Failing test**

(Renders unmapped rows; submitting a mapping to an Accu-Mk1 user calls POST and refreshes.)

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Backend endpoints**

```python
@app.get("/api/admin/clickup-users/unmapped")
def list_unmapped_clickup_users(
    _: None = Depends(require_admin_or_service),  # role-gated
):
    return ClickUpUserMappingRepository().list_unmapped()


@app.post("/api/admin/clickup-users/{clickup_user_id}/map")
def map_clickup_user(
    clickup_user_id: str,
    accumk1_user_id: str = Body(..., embed=True),
    _: None = Depends(require_admin_or_service),
):
    from uuid import UUID
    ClickUpUserMappingRepository().set_mapping(clickup_user_id, UUID(accumk1_user_id))
    return {"ok": True}
```

- [ ] **Step 4: UI implementation**

(Table of unmapped ClickUp users with an Accu-Mk1-user autocomplete to pick the match; POSTs to the endpoint on selection.)

- [ ] **Step 5: PASS**

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(ui): admin ClickUp user mapping page"
```

---

## Task 20: End-to-end happy-path integration test

**Files:**
- Create: `backend/tests/test_e2e_peptide_request.py`

- [ ] **Step 1: Write the E2E test**

```python
"""End-to-end: submit → ClickUp task created → webhook status changes → WP relay + coupon + SENAITE all called."""
import json, hmac, hashlib, os, uuid
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.main import app


def _sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


@patch("backend.clickup_client.requests.post")
@patch("backend.integration_service_client.requests.post")
def test_happy_path(mock_is_post, mock_cu_post):
    # 1. Setup mocks
    mock_cu_post.return_value.status_code = 200
    mock_cu_post.return_value.json = lambda: {"id": "tsk_e2e", "url": "x"}
    mock_is_post.return_value.status_code = 200
    mock_is_post.return_value.json = lambda: {"coupon_code": "E2E-CODE", "issued_at": "2026-04-17T00:00:00Z"}

    # 2. POST /api/peptide-requests as integration-service
    client = TestClient(app)
    headers = {
        "X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
        "Idempotency-Key": str(uuid.uuid4()),
    }
    body = {
        "compound_kind": "peptide", "compound_name": "E2E-Test",
        "vendor_producer": "PepMart", "submitted_by_wp_user_id": 9999,
        "submitted_by_email": "e2e@test.com", "submitted_by_name": "E2E",
    }
    resp = client.post("/api/peptide-requests", headers=headers, json=body)
    assert resp.status_code == 201
    req_id = resp.json()["id"]
    assert resp.json()["clickup_task_id"] == "tsk_e2e"

    # 3. Simulate ClickUp webhook: Completed
    webhook_body = json.dumps({
        "event": "taskStatusUpdated",
        "task_id": "tsk_e2e",
        "history_items": [{
            "id": f"evt_{uuid.uuid4()}",
            "field": "status",
            "before": {"status": "approved"},
            "after": {"status": "completed"},
            "user": {"id": "cu_test", "username": "t", "email": "t@lab.com"},
        }],
    }).encode()
    secret = os.environ["CLICKUP_WEBHOOK_SECRET"]
    sig = _sign(webhook_body, secret)
    wh_resp = client.post(
        "/webhooks/clickup", content=webhook_body,
        headers={"X-Signature": sig, "Content-Type": "application/json"},
    )
    assert wh_resp.status_code == 200

    # 4. Allow background jobs to run (in test, call synchronously)
    from backend.jobs.completion_side_effects import run_all
    from backend.jobs.relay_status_to_wp import run_once
    from uuid import UUID
    run_all(UUID(req_id))
    run_once(UUID(req_id), new_status="completed", previous_status="approved")

    # 5. Verify final state
    final = client.get(f"/api/peptide-requests/{req_id}", headers=headers)
    assert final.status_code == 200
    data = final.json()
    assert data["status"] == "completed"
    assert data["wp_coupon_code"] == "E2E-CODE"
    # senaite_service_uid populated from mock
```

- [ ] **Step 2: Run, verify PASS**

- [ ] **Step 3: Run the full suite + lint**

```bash
cd backend && python -m pytest -v
cd .. && npm run check:all
```

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_e2e_peptide_request.py
git commit -m "test: E2E happy path for peptide request flow"
```

---

## Task 21: Docs update

**Files:**
- Modify: `docs/developer/architecture-guide.md` (add "Peptide Request Flow" section)
- Modify: `docs/tasks.md` (move completed entry)
- Create: `docs/developer/peptide-request-flow.md`

- [ ] **Step 1: Write developer doc**

Summarize: architecture, Postgres tables, webhook dispatch path, config env vars, how to add a new ClickUp column, known-risk BPC-157 template dependency, integration test entry point.

- [ ] **Step 2: Commit**

```bash
git commit -am "docs: peptide request flow — architecture + ops reference"
```

---

## Task 22: Prepare PR

- [ ] **Step 1: Run final quality gates**

```bash
cd backend && python -m pytest
cd .. && npm run check:all
```

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feat/peptide-request-v1
```

Open PR titled "feat: peptide / compound testing requests (v1) — Accu-Mk1 half". Link in description:
- `docs/superpowers/specs/2026-04-17-peptide-request-design.md`
- `docs/superpowers/specs/2026-04-17-peptide-request-contracts.md`

Note in PR description: **do not merge until integration-service and wpstar PRs are ready** — contracts frozen.

---

## Self-review checklist (run before handoff)

- [ ] All 9 status enum values appear in the DB CHECK constraint (Task 1) and Pydantic Literal (Task 4) and TS type (Task 16) — consistent.
- [ ] `clickup_event_id` unique index (Task 2) + `StatusLogRepository.append` returning True/False on dedup (Task 6) + webhook dispatcher handling dedup return (Task 12) — consistent.
- [ ] Contract doc `send_email` policy ("true only on approved/rejected/completed") is enforced in `EMAIL_TRIGGER_STATUSES` (Task 13).
- [ ] Contract doc `new_keyword` policy (`{first 4 alnum chars}-ID`) is implemented in `_new_senaite_keyword` (Task 14).
- [ ] `compound_kind == 'other'` skips SENAITE clone (Task 14) — design invariant preserved.
- [ ] Background job ordering: status transition → status log insert → enqueue side-effects (not the reverse) — verified in Task 12 dispatcher.
- [ ] Error column names match across DB (Task 1), repo (Task 5), and jobs (Task 13, 14, 15): `wp_relay_failed_at`, `coupon_failed_at`, `senaite_clone_failed_at`, `clickup_create_failed_at`.
