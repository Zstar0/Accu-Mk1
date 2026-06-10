# Variance Set Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundation and a working variance summary page so the lab can select which vials of a parent participate in variance computation, see mean/SD/CV% across selected vials, and lock the set for downstream COA aggregation.

**Architecture:** Five additive columns on `lims_samples`/`lims_sub_samples`. Pure stats helper isolates variance computation from the DB. Four new REST endpoints (GET, PATCH, lock, unlock) under `/api/sub-samples`. One new React page reachable from the sample detail action bar; no inbox/worksheet UI changes in this phase. Idempotent migrations follow Mk1's existing `_run_migrations()` pattern.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (Accu-Mk1 backend), React 19 + TanStack Query (frontend), Vitest + pytest, shadcn/ui Checkbox + Button components.

**Spec:** `docs/superpowers/specs/2026-06-02-worksheet-variance-grouping-design.md`

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`)

**Out of scope for this plan:** Inbox family card, worksheet sample-list grouping, per-vial entry replicate context strip, prev/next vial navigation. Those land in a follow-on plan once this foundation is in.

**How to run tests:**
- Backend unit: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Frontend unit: vite dev server already running in the subvial stack; tests via `npm run test -- <pattern>` (run inside the frontend container or against the worktree)

---

## File Structure

**Backend (new):**
- `backend/sub_samples/variance.py` — pure variance stats computation, no DB
- `backend/tests/test_variance_stats.py` — unit tests for `compute_variance_stats`
- `backend/tests/test_variance_set.py` — endpoint + service tests for the variance set surface

**Backend (modified):**
- `backend/database.py` — append 5 `ADD COLUMN IF NOT EXISTS` + 1 backfill UPDATE inside `_run_migrations()`
- `backend/models.py` — add new columns to `LimsSample` and `LimsSubSample`
- `backend/sub_samples/schemas.py` — variance-set request/response models
- `backend/sub_samples/service.py` — `set_variance_membership`, `lock_variance_set`, `unlock_variance_set`, `get_variance_set`
- `backend/sub_samples/routes.py` — 4 new routes under `/api/sub-samples`

**Frontend (new):**
- `src/pages/VarianceSummary.tsx` — the variance summary page
- `src/pages/VarianceSummary.test.tsx` — vitest unit tests

**Frontend (modified):**
- `src/lib/api.ts` — `getVarianceSet`, `patchVarianceMembership`, `lockVarianceSet`, `unlockVarianceSet`
- `src/App.tsx` (or wherever router lives) — register `/samples/:parentSampleId/variance-summary` route
- `src/components/senaite/SampleDetails.tsx` — surface a "Variance Summary" action button on parent pages with vial count ≥ 2

---

## Task 1: DB migration — 5 columns + backfill

**Files:**
- Modify: `backend/database.py` (append to `_run_migrations()`)

- [ ] **Step 1: Find the `_run_migrations()` function and read its existing structure**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -n "_run_migrations" /app/database.py | head
```

Expected: see the function definition with a series of `ALTER TABLE IF NOT EXISTS` statements wrapped in `try/except`.

- [ ] **Step 2: Append the variance-set columns and the backfill at the end of the migration list**

Inside `_run_migrations()`, append (preserving the existing per-statement `try/except` style):

```python
# Variance set membership + lock state (worksheet-variance design 2026-06-02)
try:
    db.execute(text("""
        ALTER TABLE lims_sub_samples
          ADD COLUMN IF NOT EXISTS in_variance_set BOOLEAN NOT NULL DEFAULT TRUE
    """))
except Exception as e:
    log.warning("migration lims_sub_samples.in_variance_set: %s", e)

try:
    db.execute(text("""
        ALTER TABLE lims_sub_samples
          ADD COLUMN IF NOT EXISTS variance_exclusion_reason TEXT
    """))
except Exception as e:
    log.warning("migration lims_sub_samples.variance_exclusion_reason: %s", e)

try:
    db.execute(text("""
        ALTER TABLE lims_samples
          ADD COLUMN IF NOT EXISTS in_variance_set BOOLEAN NOT NULL DEFAULT TRUE
    """))
except Exception as e:
    log.warning("migration lims_samples.in_variance_set: %s", e)

try:
    db.execute(text("""
        ALTER TABLE lims_samples
          ADD COLUMN IF NOT EXISTS variance_exclusion_reason TEXT
    """))
except Exception as e:
    log.warning("migration lims_samples.variance_exclusion_reason: %s", e)

try:
    db.execute(text("""
        ALTER TABLE lims_samples
          ADD COLUMN IF NOT EXISTS variance_locked_at TIMESTAMP
    """))
except Exception as e:
    log.warning("migration lims_samples.variance_locked_at: %s", e)

try:
    db.execute(text("""
        ALTER TABLE lims_samples
          ADD COLUMN IF NOT EXISTS variance_locked_by_user_id INTEGER REFERENCES users(id)
    """))
except Exception as e:
    log.warning("migration lims_samples.variance_locked_by_user_id: %s", e)

# Backfill — non-HPLC sub-samples are not variance candidates by default.
# Idempotent: rows already flipped won't match `in_variance_set = TRUE`.
try:
    db.execute(text("""
        UPDATE lims_sub_samples
           SET in_variance_set = FALSE,
               variance_exclusion_reason = 'auto: assignment_role != hplc'
         WHERE assignment_role IN ('endo', 'ster', 'xtra')
           AND in_variance_set = TRUE
    """))
except Exception as e:
    log.warning("migration backfill non-hplc variance default: %s", e)
```

- [ ] **Step 3: Restart backend so migration runs**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend
sleep 5
```

- [ ] **Step 4: Verify columns exist + backfill ran**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "\d lims_sub_samples" | grep -E "in_variance_set|variance_exclusion"
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "\d lims_samples" | grep -E "in_variance_set|variance_exclusion|variance_locked"
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT assignment_role, in_variance_set, variance_exclusion_reason FROM lims_sub_samples ORDER BY assignment_role;"
```

Expected:
- Both tables show the new columns
- All `assignment_role IN ('endo','ster','xtra')` rows show `in_variance_set = f` and the auto reason
- All `assignment_role = 'hplc'` or NULL rows stay `in_variance_set = t`

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/database.py
git commit -m "feat(mk1): add variance set columns + non-hplc backfill"
```

---

## Task 2: ORM model extensions

**Files:**
- Modify: `backend/models.py`

- [ ] **Step 1: Add new columns to `LimsSample`**

Locate the `LimsSample` class and append:

```python
    in_variance_set = Column(Boolean, nullable=False, default=True, server_default="true")
    variance_exclusion_reason = Column(Text, nullable=True)
    variance_locked_at = Column(DateTime, nullable=True)
    variance_locked_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
```

Add `ForeignKey` and `Text` to the imports if not already present.

- [ ] **Step 2: Add new columns to `LimsSubSample`**

Locate the `LimsSubSample` class and append:

```python
    in_variance_set = Column(Boolean, nullable=False, default=True, server_default="true")
    variance_exclusion_reason = Column(Text, nullable=True)
```

- [ ] **Step 3: Verify model loads without import error**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "import sys; sys.path.insert(0, '/app'); from models import LimsSample, LimsSubSample; print(sorted([c.name for c in LimsSample.__table__.columns if 'variance' in c.name])); print(sorted([c.name for c in LimsSubSample.__table__.columns if 'variance' in c.name]))"
```

Expected output:
```
['in_variance_set', 'variance_exclusion_reason', 'variance_locked_at', 'variance_locked_by_user_id']
['in_variance_set', 'variance_exclusion_reason']
```

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/models.py
git commit -m "feat(mk1): extend LimsSample + LimsSubSample with variance columns"
```

---

## Task 3: Pure variance stats — failing tests first

**Files:**
- Create: `backend/tests/test_variance_stats.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_variance_stats.py`:

```python
"""Unit tests for sub_samples.variance.compute_variance_stats.

Pure function — no DB. Vials are dicts with `in_variance_set` flag and
`results` dict keyed by analysis keyword.
"""
import math

import pytest

from sub_samples.variance import compute_variance_stats


def _vial(sample_id, in_set=True, results=None, reason=None):
    return {
        "sample_id": sample_id,
        "in_variance_set": in_set,
        "exclusion_reason": reason,
        "results": results or {},
    }


def test_empty_family_returns_empty_stats():
    assert compute_variance_stats([]) == {}


def test_singleton_selected_returns_mean_no_sd():
    vials = [_vial("P-1", results={"Purity": {"value": 98.5, "kind": "numeric"}})]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["mean"] == 98.5
    assert stats["Purity"]["n"] == 1
    assert stats["Purity"]["sd"] is None
    assert stats["Purity"]["cv_pct"] is None


def test_all_excluded_returns_n_zero():
    vials = [
        _vial("P-1", in_set=False, results={"Purity": {"value": 98.5, "kind": "numeric"}}),
        _vial("P-2", in_set=False, results={"Purity": {"value": 98.6, "kind": "numeric"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["n"] == 0
    assert stats["Purity"]["mean"] is None


def test_two_vials_mean_sd_cv():
    vials = [
        _vial("P-1", results={"Purity": {"value": 98.0, "kind": "numeric"}}),
        _vial("P-2", results={"Purity": {"value": 99.0, "kind": "numeric"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["mean"] == pytest.approx(98.5)
    # sample stddev of [98, 99] = sqrt(0.5) ≈ 0.7071
    assert stats["Purity"]["sd"] == pytest.approx(math.sqrt(0.5))
    # CV% = (sd / mean) * 100
    assert stats["Purity"]["cv_pct"] == pytest.approx((math.sqrt(0.5) / 98.5) * 100)
    assert stats["Purity"]["n"] == 2


def test_excluded_vial_skipped_from_stats():
    vials = [
        _vial("P-1", results={"Purity": {"value": 98.0, "kind": "numeric"}}),
        _vial("P-2", results={"Purity": {"value": 99.0, "kind": "numeric"}}),
        _vial("P-3", in_set=False, results={"Purity": {"value": 50.0, "kind": "numeric"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["n"] == 2
    assert stats["Purity"]["mean"] == pytest.approx(98.5)


def test_identity_categorical_returns_conforms_count():
    vials = [
        _vial("P-1", results={"Identity": {"value": "Conforms", "kind": "categorical"}}),
        _vial("P-2", results={"Identity": {"value": "Conforms", "kind": "categorical"}}),
        _vial("P-3", results={"Identity": {"value": "Does not conform", "kind": "categorical"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Identity"]["kind"] == "categorical"
    assert stats["Identity"]["conforms_count"] == 2
    assert stats["Identity"]["total"] == 3
    assert stats["Identity"]["mean"] is None  # no numeric mean for categorical


def test_missing_result_on_one_vial_reduces_n():
    vials = [
        _vial("P-1", results={"Purity": {"value": 98.0, "kind": "numeric"}}),
        _vial("P-2", results={}),  # no result yet
        _vial("P-3", results={"Purity": {"value": 99.0, "kind": "numeric"}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["n"] == 2
    assert stats["Purity"]["mean"] == pytest.approx(98.5)


def test_multiple_keywords_independent_stats():
    vials = [
        _vial("P-1", results={
            "Purity": {"value": 98.0, "kind": "numeric"},
            "Quantity": {"value": 5.0, "kind": "numeric"},
        }),
        _vial("P-2", results={
            "Purity": {"value": 99.0, "kind": "numeric"},
            "Quantity": {"value": 5.2, "kind": "numeric"},
        }),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["mean"] == pytest.approx(98.5)
    assert stats["Quantity"]["mean"] == pytest.approx(5.1)
    assert stats["Purity"]["n"] == 2
    assert stats["Quantity"]["n"] == 2


def test_spec_pass_status_when_provided():
    vials = [
        _vial("P-1", results={"Purity": {"value": 98.5, "kind": "numeric", "spec": {"min": 98.0}}}),
        _vial("P-2", results={"Purity": {"value": 99.0, "kind": "numeric", "spec": {"min": 98.0}}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["spec"] == {"min": 98.0}
    assert stats["Purity"]["pass"] is True


def test_spec_fail_status():
    vials = [
        _vial("P-1", results={"Purity": {"value": 97.0, "kind": "numeric", "spec": {"min": 98.0}}}),
        _vial("P-2", results={"Purity": {"value": 97.5, "kind": "numeric", "spec": {"min": 98.0}}}),
    ]
    stats = compute_variance_stats(vials)
    assert stats["Purity"]["pass"] is False
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_stats.py -v 2>&1 | tail -10"
```

Expected: `ModuleNotFoundError: No module named 'sub_samples.variance'`.

---

## Task 4: Implement compute_variance_stats

**Files:**
- Create: `backend/sub_samples/variance.py`

- [ ] **Step 1: Write the module**

Create `backend/sub_samples/variance.py`:

```python
"""Pure variance statistics — no DB, no I/O.

Input shape (per vial):
    {
        "sample_id": str,
        "in_variance_set": bool,
        "exclusion_reason": str | None,
        "results": {
            "<keyword>": {
                "value": float | str,
                "kind": "numeric" | "categorical",
                "spec": dict | None,  # e.g. {"min": 98.0} or {"target": 6.0, "tolerance_pct": 5}
            },
            ...
        },
    }

Output shape (per keyword):
    Numeric — {kind, mean, sd, cv_pct, n, spec, pass}
    Categorical — {kind, conforms_count, total, n, spec, pass, mean=None}
"""
from __future__ import annotations

import math
from typing import Any, Optional


CONFORMS_VALUES = {"conforms", "pass", "passes", "passing", "ok"}


def compute_variance_stats(vials: list[dict]) -> dict[str, dict[str, Any]]:
    """Compute per-keyword stats over vials with in_variance_set=True."""
    selected = [v for v in vials if v.get("in_variance_set")]
    keywords = _collect_keywords(vials)
    out: dict[str, dict[str, Any]] = {}
    for kw in keywords:
        kind = _detect_kind(vials, kw)
        if kind == "categorical":
            out[kw] = _categorical_stats(selected, kw)
        else:
            out[kw] = _numeric_stats(selected, kw)
    return out


def _collect_keywords(vials: list[dict]) -> list[str]:
    seen: list[str] = []
    for v in vials:
        for kw in (v.get("results") or {}).keys():
            if kw not in seen:
                seen.append(kw)
    return seen


def _detect_kind(vials: list[dict], kw: str) -> str:
    for v in vials:
        r = (v.get("results") or {}).get(kw)
        if r and r.get("kind"):
            return r["kind"]
    return "numeric"


def _numeric_stats(selected: list[dict], kw: str) -> dict[str, Any]:
    values: list[float] = []
    spec: Optional[dict] = None
    for v in selected:
        r = (v.get("results") or {}).get(kw)
        if not r:
            continue
        val = r.get("value")
        if val is None:
            continue
        try:
            values.append(float(val))
        except (TypeError, ValueError):
            continue
        if spec is None and r.get("spec"):
            spec = r["spec"]

    n = len(values)
    mean = sum(values) / n if n else None
    sd = _sample_stddev(values) if n >= 2 else None
    cv = (sd / mean * 100) if (sd is not None and mean) else None
    pass_ = _check_spec(mean, spec) if mean is not None else None
    return {
        "kind": "numeric",
        "mean": mean,
        "sd": sd,
        "cv_pct": cv,
        "n": n,
        "spec": spec,
        "pass": pass_,
    }


def _categorical_stats(selected: list[dict], kw: str) -> dict[str, Any]:
    total = 0
    conforms = 0
    spec: Optional[dict] = None
    for v in selected:
        r = (v.get("results") or {}).get(kw)
        if not r:
            continue
        val = str(r.get("value", "")).strip().lower()
        if not val:
            continue
        total += 1
        if val in CONFORMS_VALUES:
            conforms += 1
        if spec is None and r.get("spec"):
            spec = r["spec"]
    return {
        "kind": "categorical",
        "mean": None,
        "sd": None,
        "cv_pct": None,
        "n": total,
        "conforms_count": conforms,
        "total": total,
        "spec": spec,
        "pass": (conforms == total) if total else None,
    }


def _sample_stddev(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    m = sum(values) / n
    return math.sqrt(sum((x - m) ** 2 for x in values) / (n - 1))


def _check_spec(mean: float, spec: Optional[dict]) -> Optional[bool]:
    if not spec or mean is None:
        return None
    if "min" in spec and mean < spec["min"]:
        return False
    if "max" in spec and mean > spec["max"]:
        return False
    if "target" in spec and "tolerance_pct" in spec:
        target = spec["target"]
        tol = spec["tolerance_pct"] / 100
        if not (target * (1 - tol) <= mean <= target * (1 + tol)):
            return False
    return True
```

- [ ] **Step 2: Run tests, confirm pass**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_stats.py -v 2>&1 | tail -15"
```

Expected: all 10 tests PASS.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/sub_samples/variance.py backend/tests/test_variance_stats.py
git commit -m "feat(mk1): pure variance stats helper with unit tests"
```

---

## Task 5: Pydantic schemas for variance-set endpoints

**Files:**
- Modify: `backend/sub_samples/schemas.py`

- [ ] **Step 1: Append schemas**

Add to `backend/sub_samples/schemas.py`:

```python
class VarianceVialResult(BaseModel):
    sample_id: str
    vial_sequence: int
    is_parent: bool
    in_variance_set: bool
    exclusion_reason: Optional[str] = None
    review_state: Optional[str] = None
    results: dict = {}  # keyword -> {value, kind, spec}


class VarianceStatsEntry(BaseModel):
    kind: str  # "numeric" | "categorical"
    mean: Optional[float] = None
    sd: Optional[float] = None
    cv_pct: Optional[float] = None
    n: int
    conforms_count: Optional[int] = None
    total: Optional[int] = None
    spec: Optional[dict] = None
    pass_: Optional[bool] = Field(default=None, alias="pass")

    class Config:
        populate_by_name = True


class VarianceSetResponse(BaseModel):
    parent: ParentSampleSummary
    vials: list[VarianceVialResult]
    stats: dict[str, VarianceStatsEntry]
    locked: bool
    locked_at: Optional[datetime] = None
    locked_by_user_id: Optional[int] = None


class PatchVarianceMembershipRequest(BaseModel):
    in_variance_set: bool
    exclusion_reason: Optional[str] = None
```

- [ ] **Step 2: Verify schemas import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "import sys; sys.path.insert(0, '/app'); from sub_samples.schemas import VarianceSetResponse, PatchVarianceMembershipRequest, VarianceVialResult, VarianceStatsEntry; print('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/sub_samples/schemas.py
git commit -m "feat(mk1): variance-set Pydantic schemas"
```

---

## Task 6: Service helpers — variance set get + mutations

**Files:**
- Modify: `backend/sub_samples/service.py`

- [ ] **Step 1: Add helpers at the end of service.py**

```python
# ── Variance set helpers ─────────────────────────────────────────────────────

from sub_samples.variance import compute_variance_stats


def get_variance_set(db: Session, parent_sample_id: str) -> Optional[dict]:
    """Return variance set view for a parent: vials + stats + lock state."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        return None

    subs = sorted(parent.sub_samples, key=lambda s: s.vial_sequence)

    # Build vial dicts. Parent is vial 1 (vial_sequence=0), then sub-samples.
    # `results` is left empty for now — populated when we wire the SENAITE
    # result fetch in a follow-on task. Stats compute over whatever is present.
    vial_dicts: list[dict] = [
        {
            "sample_id": parent.sample_id,
            "vial_sequence": 0,
            "is_parent": True,
            "in_variance_set": parent.in_variance_set,
            "exclusion_reason": parent.variance_exclusion_reason,
            "review_state": parent.status,
            "results": {},
        }
    ] + [
        {
            "sample_id": s.sample_id,
            "vial_sequence": s.vial_sequence,
            "is_parent": False,
            "in_variance_set": s.in_variance_set,
            "exclusion_reason": s.variance_exclusion_reason,
            "review_state": None,  # sub-sample SENAITE state not cached
            "results": {},
        }
        for s in subs
    ]

    stats = compute_variance_stats(vial_dicts)
    return {
        "parent": parent,
        "vials": vial_dicts,
        "stats": stats,
        "locked": parent.variance_locked_at is not None,
        "locked_at": parent.variance_locked_at,
        "locked_by_user_id": parent.variance_locked_by_user_id,
    }


class VarianceLockedError(RuntimeError):
    """Raised when attempting to mutate a locked variance set."""


def _resolve_vial_owner(db: Session, sample_id: str) -> tuple[LimsSample, bool]:
    """Find the row (parent or sub) by sample_id. Returns (row, is_parent).
    Also returns the parent for lock checking."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent:
        return parent, True
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sub:
        return sub, False
    raise LookupError(f"sample {sample_id} not found in lims_samples/lims_sub_samples")


def set_variance_membership(db: Session, sample_id: str, in_set: bool, reason: Optional[str]) -> dict:
    """Update one vial's variance membership. Refuses when the family is locked."""
    row, is_parent = _resolve_vial_owner(db, sample_id)
    parent = row if is_parent else row.parent_sample
    if parent.variance_locked_at is not None:
        raise VarianceLockedError(f"variance set for {parent.sample_id} is locked")
    row.in_variance_set = in_set
    row.variance_exclusion_reason = reason if not in_set else None
    db.commit()
    return {
        "sample_id": sample_id,
        "in_variance_set": row.in_variance_set,
        "exclusion_reason": row.variance_exclusion_reason,
    }


class VarianceTooFewVialsError(ValueError):
    """Raised when attempting to lock with fewer than 2 selected vials."""


def lock_variance_set(db: Session, parent_sample_id: str, user_id: int) -> LimsSample:
    """Lock a family's variance set. Requires n_selected >= 2."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        raise LookupError(f"parent {parent_sample_id} not found")
    selected = int(parent.in_variance_set) + sum(
        1 for s in parent.sub_samples if s.in_variance_set
    )
    if selected < 2:
        raise VarianceTooFewVialsError(f"need >=2 selected vials, have {selected}")
    parent.variance_locked_at = datetime.utcnow()
    parent.variance_locked_by_user_id = user_id
    db.commit()
    return parent


def unlock_variance_set(db: Session, parent_sample_id: str) -> LimsSample:
    """Admin-only: clear lock fields."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if not parent:
        raise LookupError(f"parent {parent_sample_id} not found")
    parent.variance_locked_at = None
    parent.variance_locked_by_user_id = None
    db.commit()
    return parent
```

- [ ] **Step 2: Verify imports + smoke**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
import sys; sys.path.insert(0, '/app')
from sub_samples import service
print(hasattr(service, 'get_variance_set'),
      hasattr(service, 'set_variance_membership'),
      hasattr(service, 'lock_variance_set'),
      hasattr(service, 'unlock_variance_set'),
      hasattr(service, 'VarianceLockedError'),
      hasattr(service, 'VarianceTooFewVialsError'))
"
```

Expected: `True True True True True True`.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/sub_samples/service.py
git commit -m "feat(mk1): variance set service helpers"
```

---

## Task 7: Routes for variance-set GET / PATCH / lock / unlock

**Files:**
- Modify: `backend/sub_samples/routes.py`

- [ ] **Step 1: Append routes**

```python
from sub_samples.schemas import VarianceSetResponse, PatchVarianceMembershipRequest, VarianceVialResult, VarianceStatsEntry
from sub_samples.service import (
    get_variance_set, set_variance_membership, lock_variance_set, unlock_variance_set,
    VarianceLockedError, VarianceTooFewVialsError,
)


@router.get("/{parent_sample_id}/variance-set", response_model=VarianceSetResponse)
def get_variance_set_endpoint(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    result = get_variance_set(db, parent_sample_id)
    if not result:
        raise HTTPException(status_code=404, detail=f"parent {parent_sample_id} has no variance set yet")
    parent = result["parent"]
    return VarianceSetResponse(
        parent=ParentSampleSummary(
            sample_id=parent.sample_id,
            external_lims_uid=parent.external_lims_uid,
            peptide_name=parent.peptide_name,
            status=parent.status,
            sub_sample_count=len(parent.sub_samples),
            last_synced_at=parent.last_synced_at,
        ),
        vials=[VarianceVialResult(**v) for v in result["vials"]],
        stats={k: VarianceStatsEntry(**v) for k, v in result["stats"].items()},
        locked=result["locked"],
        locked_at=result["locked_at"],
        locked_by_user_id=result["locked_by_user_id"],
    )


@router.patch("/{sample_id}/variance-set")
def patch_variance_membership_endpoint(
    sample_id: str,
    body: PatchVarianceMembershipRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    try:
        return set_variance_membership(db, sample_id, body.in_variance_set, body.exclusion_reason)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except VarianceLockedError as e:
        raise HTTPException(status_code=409, detail={"code": "variance_locked", "message": str(e)})


@router.post("/{parent_sample_id}/variance-set/lock")
def lock_variance_set_endpoint(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    try:
        parent = lock_variance_set(db, parent_sample_id, user.id)
        return {
            "parent_sample_id": parent.sample_id,
            "locked_at": parent.variance_locked_at,
            "locked_by_user_id": parent.variance_locked_by_user_id,
        }
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except VarianceTooFewVialsError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": "variance_too_few_vials", "message": str(e)},
        )


@router.post("/{parent_sample_id}/variance-set/unlock")
def unlock_variance_set_endpoint(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin role required to unlock variance sets")
    try:
        parent = unlock_variance_set(db, parent_sample_id)
        return {"parent_sample_id": parent.sample_id, "locked": False}
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
```

- [ ] **Step 2: Restart backend (route registration happens at startup)**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend
sleep 6
```

- [ ] **Step 3: Verify routes registered**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
import sys; sys.path.insert(0, '/app')
from main import app
routes = [r for r in app.routes if hasattr(r,'path') and 'variance' in r.path]
for r in routes:
    methods = ','.join(sorted(r.methods - {'HEAD','OPTIONS'}))
    print(f'[{methods}] {r.path}')
"
```

Expected:
```
[PATCH] /api/sub-samples/{sample_id}/variance-set
[GET] /api/sub-samples/{parent_sample_id}/variance-set
[POST] /api/sub-samples/{parent_sample_id}/variance-set/lock
[POST] /api/sub-samples/{parent_sample_id}/variance-set/unlock
```

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/sub_samples/routes.py
git commit -m "feat(mk1): variance-set GET/PATCH/lock/unlock endpoints"
```

---

## Task 8: Integration test — full round-trip against the live stack

**Files:**
- Create: `backend/tests/test_variance_set.py`

- [ ] **Step 1: Write tests**

```python
"""Integration tests for variance-set endpoints + service helpers.

Uses subvial stack DB. Pick a parent that has at least 2 sub-samples
already in lims_sub_samples; manipulate variance flags, lock, unlock.
"""
from datetime import datetime

import pytest
from sqlalchemy import select

from database import SessionLocal
from models import LimsSample, LimsSubSample
from sub_samples import service
from sub_samples.service import (
    VarianceLockedError, VarianceTooFewVialsError,
    set_variance_membership, lock_variance_set, unlock_variance_set, get_variance_set,
)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def parent_with_subs(db):
    """Pick a parent that has ≥2 sub-samples for testing."""
    row = db.execute(
        select(LimsSample).join(LimsSubSample, LimsSubSample.parent_sample_pk == LimsSample.id)
        .group_by(LimsSample.id).having(LimsSample.id.is_not(None))
    ).scalars().first()
    if not row or len(row.sub_samples) < 2:
        pytest.skip("no parent with >=2 sub-samples available in subvial DB")
    return row


def test_get_variance_set_includes_parent_and_subs(db, parent_with_subs):
    result = get_variance_set(db, parent_with_subs.sample_id)
    assert result is not None
    assert len(result["vials"]) == len(parent_with_subs.sub_samples) + 1
    assert result["vials"][0]["is_parent"] is True
    assert all(v.get("in_variance_set") in (True, False) for v in result["vials"])


def test_set_variance_membership_flips_flag(db, parent_with_subs):
    sub = parent_with_subs.sub_samples[0]
    original = sub.in_variance_set
    out = set_variance_membership(db, sub.sample_id, in_set=not original, reason="test toggle")
    assert out["in_variance_set"] != original
    # restore
    set_variance_membership(db, sub.sample_id, in_set=original, reason=None)


def test_lock_requires_two_selected(db, parent_with_subs):
    """Force all-but-1 out of variance, expect lock to fail."""
    # Exclude all subs from variance — only parent stays in
    for s in parent_with_subs.sub_samples:
        set_variance_membership(db, s.sample_id, in_set=False, reason="lock-test exclude")
    try:
        with pytest.raises(VarianceTooFewVialsError):
            lock_variance_set(db, parent_with_subs.sample_id, user_id=2)
    finally:
        # restore
        for s in parent_with_subs.sub_samples:
            set_variance_membership(db, s.sample_id, in_set=True, reason=None)


def test_lock_and_unlock_round_trip(db, parent_with_subs):
    parent = parent_with_subs
    # Ensure at least 2 selected
    parent.in_variance_set = True
    parent.sub_samples[0].in_variance_set = True
    db.commit()

    locked = lock_variance_set(db, parent.sample_id, user_id=2)
    assert locked.variance_locked_at is not None
    assert locked.variance_locked_by_user_id == 2

    # PATCH on locked family raises
    with pytest.raises(VarianceLockedError):
        set_variance_membership(db, parent.sub_samples[0].sample_id, in_set=False, reason="should fail")

    unlocked = unlock_variance_set(db, parent.sample_id)
    assert unlocked.variance_locked_at is None
    assert unlocked.variance_locked_by_user_id is None
```

- [ ] **Step 2: Run tests**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_set.py -v 2>&1 | tail -25"
```

Expected: all 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/tests/test_variance_set.py
git commit -m "test(mk1): variance set service integration tests"
```

---

## Task 9: Frontend API client wrappers

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Append types and wrappers near existing sub-sample functions**

```typescript
// ── Variance set ─────────────────────────────────────────────────────────────

export interface VarianceVial {
  sample_id: string
  vial_sequence: number
  is_parent: boolean
  in_variance_set: boolean
  exclusion_reason: string | null
  review_state: string | null
  results: Record<string, { value: number | string | null; kind: 'numeric' | 'categorical'; spec?: Record<string, number> }>
}

export interface VarianceStatsEntry {
  kind: 'numeric' | 'categorical'
  mean: number | null
  sd: number | null
  cv_pct: number | null
  n: number
  conforms_count?: number | null
  total?: number | null
  spec: Record<string, number> | null
  pass: boolean | null
}

export interface VarianceSetResponse {
  parent: ParentSampleSummary
  vials: VarianceVial[]
  stats: Record<string, VarianceStatsEntry>
  locked: boolean
  locked_at: string | null
  locked_by_user_id: number | null
}

export async function getVarianceSet(parentSampleId: string): Promise<VarianceSetResponse> {
  const r = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-set`,
    { headers: getBearerHeaders() }
  )
  if (!r.ok) throw new Error(`getVarianceSet failed: ${r.status}`)
  return r.json()
}

export async function patchVarianceMembership(args: {
  sampleId: string
  inVarianceSet: boolean
  exclusionReason?: string | null
}): Promise<{ sample_id: string; in_variance_set: boolean; exclusion_reason: string | null }> {
  const r = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(args.sampleId)}/variance-set`,
    {
      method: 'PATCH',
      headers: { ...getBearerHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        in_variance_set: args.inVarianceSet,
        exclusion_reason: args.exclusionReason ?? null,
      }),
    }
  )
  if (r.status === 409) {
    const body = await r.json()
    throw new Error(body.detail?.message ?? 'variance set is locked')
  }
  if (!r.ok) throw new Error(`patchVarianceMembership failed: ${r.status}`)
  return r.json()
}

export async function lockVarianceSet(parentSampleId: string): Promise<{ parent_sample_id: string; locked_at: string }> {
  const r = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-set/lock`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (r.status === 422) {
    const body = await r.json()
    throw new Error(body.detail?.message ?? 'need >=2 selected vials to lock')
  }
  if (!r.ok) throw new Error(`lockVarianceSet failed: ${r.status}`)
  return r.json()
}

export async function unlockVarianceSet(parentSampleId: string): Promise<{ parent_sample_id: string; locked: boolean }> {
  const r = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-set/unlock`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (r.status === 403) throw new Error('admin role required to unlock variance sets')
  if (!r.ok) throw new Error(`unlockVarianceSet failed: ${r.status}`)
  return r.json()
}
```

- [ ] **Step 2: Verify TypeScript compiles (vite picks up via HMR)**

```bash
docker compose -p accumark-subvial logs --tail 30 accu-mk1-frontend 2>&1 | grep -iE "error|vite" | tail -5
```

Expected: no `TS error` lines. HMR may report a non-fatal update.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/lib/api.ts
git commit -m "feat(mk1-fe): variance-set API client wrappers"
```

---

## Task 10: VarianceSummary page component

**Files:**
- Create: `src/pages/VarianceSummary.tsx`

- [ ] **Step 1: Write the component**

Create `src/pages/VarianceSummary.tsx`:

```tsx
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Lock, Unlock } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  getVarianceSet,
  patchVarianceMembership,
  lockVarianceSet,
  unlockVarianceSet,
  type VarianceVial,
  type VarianceStatsEntry,
} from '@/lib/api'

function StatCell({ stat }: { stat: VarianceStatsEntry }) {
  if (stat.kind === 'categorical') {
    return <span>{stat.conforms_count} of {stat.total} conform</span>
  }
  if (stat.mean === null) return <span className="text-muted-foreground">—</span>
  const parts: string[] = [`Mean ${stat.mean.toFixed(2)}`]
  if (stat.sd !== null) parts.push(`SD ${stat.sd.toFixed(2)}`)
  if (stat.cv_pct !== null) parts.push(`CV ${stat.cv_pct.toFixed(2)}%`)
  parts.push(`n=${stat.n}`)
  return <span>{parts.join(' · ')}</span>
}

function PassBadge({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="text-muted-foreground">—</span>
  return pass
    ? <span className="text-green-700 font-medium">✓ PASS</span>
    : <span className="text-red-700 font-medium">✗ FAIL</span>
}

export default function VarianceSummary() {
  const { parentSampleId } = useParams<{ parentSampleId: string }>()
  const queryClient = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['variance-set', parentSampleId],
    queryFn: () => getVarianceSet(parentSampleId!),
    enabled: !!parentSampleId,
  })

  const membership = useMutation({
    mutationFn: patchVarianceMembership,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] }),
    onError: (e: Error) => toast.error('Failed to update vial', { description: e.message }),
  })

  const lock = useMutation({
    mutationFn: () => lockVarianceSet(parentSampleId!),
    onSuccess: () => {
      toast.success('Variance set locked')
      queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })
    },
    onError: (e: Error) => toast.error('Could not lock', { description: e.message }),
  })

  const unlock = useMutation({
    mutationFn: () => unlockVarianceSet(parentSampleId!),
    onSuccess: () => {
      toast.success('Variance set unlocked')
      queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })
    },
    onError: (e: Error) => toast.error('Could not unlock', { description: e.message }),
  })

  if (isLoading) return <div className="p-6"><Loader2 className="animate-spin" /></div>
  if (isError) return <div className="p-6 text-red-600">Error: {(error as Error)?.message}</div>
  if (!data) return null

  const selectedCount =
    (data.vials.find(v => v.is_parent)?.in_variance_set ? 1 : 0) +
    data.vials.filter(v => !v.is_parent && v.in_variance_set).length

  const allSelected = data.vials.every(v => v.in_variance_set)
  const noneSelected = data.vials.every(v => !v.in_variance_set)
  const locked = data.locked

  const setAll = (val: boolean) => {
    data.vials.forEach(v => {
      if (v.in_variance_set !== val) {
        membership.mutate({ sampleId: v.sample_id, inVarianceSet: val })
      }
    })
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{data.parent.sample_id} — Variance Summary</h1>
        <p className="text-sm text-muted-foreground">
          {data.vials.length} vials in family · {selectedCount} in variance set
        </p>
      </header>

      {locked && (
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-4 text-sm">
          <Lock className="inline w-4 h-4 mr-1" />
          Locked at {new Date(data.locked_at!).toLocaleString()} by user #{data.locked_by_user_id}.
          {' '}
          <button
            onClick={() => unlock.mutate()}
            className="underline text-amber-900 cursor-pointer disabled:opacity-50"
            disabled={unlock.isPending}
          >
            Unlock
          </button>
        </div>
      )}

      <section className="border rounded-md">
        <header className="px-4 py-2 border-b font-semibold">
          Select which vials participate in variance
        </header>
        <ul>
          {data.vials.map(v => (
            <VialRow
              key={v.sample_id}
              vial={v}
              locked={locked}
              onChange={(checked) =>
                membership.mutate({
                  sampleId: v.sample_id,
                  inVarianceSet: checked,
                  exclusionReason: !checked ? v.exclusion_reason ?? null : null,
                })
              }
            />
          ))}
        </ul>
        <footer className="px-4 py-2 border-t flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setAll(true)} disabled={allSelected || locked}>
            Select all
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAll(false)} disabled={noneSelected || locked}>
            Clear all
          </Button>
        </footer>
      </section>

      <section className="border rounded-md">
        <header className="px-4 py-2 border-b font-semibold">
          Computed across selected (n={selectedCount})
        </header>
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="p-2 text-left">Analysis</th>
              <th className="p-2 text-left">Stats</th>
              <th className="p-2 text-left">Spec</th>
              <th className="p-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.stats).map(([kw, stat]) => (
              <tr key={kw} className="border-t">
                <td className="p-2 font-medium">{kw}</td>
                <td className="p-2"><StatCell stat={stat} /></td>
                <td className="p-2 text-muted-foreground">
                  {stat.spec ? JSON.stringify(stat.spec) : '—'}
                </td>
                <td className="p-2"><PassBadge pass={stat.pass} /></td>
              </tr>
            ))}
            {Object.keys(data.stats).length === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">
                No results entered yet — stats will populate as vial results land.
              </td></tr>
            )}
          </tbody>
        </table>
      </section>

      <div>
        <Button
          onClick={() => lock.mutate()}
          disabled={selectedCount < 2 || locked || lock.isPending}
          className="gap-2"
        >
          <Lock className="w-4 h-4" />
          Lock variance set
        </Button>
        {selectedCount < 2 && !locked && (
          <span className="ml-3 text-xs text-muted-foreground">
            Need ≥2 selected vials to lock.
          </span>
        )}
      </div>
    </div>
  )
}

function VialRow({
  vial, locked, onChange,
}: {
  vial: VarianceVial
  locked: boolean
  onChange: (checked: boolean) => void
}) {
  const [reason, setReason] = useState(vial.exclusion_reason ?? '')
  return (
    <li className="px-4 py-2 border-t flex items-center gap-3 text-sm">
      <Checkbox
        checked={vial.in_variance_set}
        disabled={locked}
        onCheckedChange={(c) => onChange(Boolean(c))}
      />
      <code className="min-w-[10rem]">{vial.sample_id}</code>
      <span className="min-w-[10rem] text-muted-foreground">
        {vial.is_parent ? `Vial 1 (parent)` : `Vial ${vial.vial_sequence + 1}`}
      </span>
      <span className="flex-1 text-muted-foreground text-xs">
        {Object.entries(vial.results).length === 0
          ? '— no results yet'
          : Object.entries(vial.results).map(([k, r]) =>
              <span key={k} className="mr-3">{k}: {String(r.value ?? '—')}</span>
            )}
      </span>
      {!vial.in_variance_set && (
        <input
          type="text"
          placeholder="reason"
          value={reason}
          disabled={locked}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => {
            if (reason !== (vial.exclusion_reason ?? '')) {
              // PATCH with same in_set but updated reason
              onChange(false)  // triggers parent's onChange with the updated reason path
            }
          }}
          className="text-xs px-2 py-1 border rounded w-40"
        />
      )}
    </li>
  )
}
```

- [ ] **Step 2: Verify HMR + no TS errors**

```bash
sleep 3 && docker compose -p accumark-subvial logs --tail 30 accu-mk1-frontend 2>&1 | grep -iE "TS|error" | tail -5
```

Expected: no `TS error` lines.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/pages/VarianceSummary.tsx
git commit -m "feat(mk1-fe): variance summary page"
```

---

## Task 11: Wire route + entry-point button on SampleDetails

**Files:**
- Modify: `src/App.tsx` (or wherever React Router routes are registered)
- Modify: `src/components/senaite/SampleDetails.tsx`

- [ ] **Step 1: Find the router file**

```bash
grep -rl "Route path=" C:/tmp/Accu-Mk1-subvial/src --include "*.tsx" | head
```

Take the first match; that's the router file.

- [ ] **Step 2: Add the route**

In the router file, near other `/samples/...` routes, add:

```tsx
import VarianceSummary from '@/pages/VarianceSummary'
// ...
<Route path="/samples/:parentSampleId/variance-summary" element={<VarianceSummary />} />
```

- [ ] **Step 3: Add a "Variance Summary" action on `SampleDetails.tsx`**

Inside the action-button row in `SampleDetails.tsx` near the existing `Manage Sub-Samples` button (around the previously edited block), add (gated on isParent + subCount >= 2):

```tsx
{isParent && subCount >= 2 && (
  <Button
    variant="outline"
    size="sm"
    className="gap-1.5 cursor-pointer"
    onClick={() => navigate(`/samples/${sampleId}/variance-summary`)}
  >
    <Sigma size={13} />
    Variance Summary
  </Button>
)}
```

Add `import { Sigma } from 'lucide-react'` and ensure `navigate` is in scope (it already is from `useNavigate`).

- [ ] **Step 4: Verify HMR + click-through**

```bash
sleep 3 && docker compose -p accumark-subvial logs --tail 20 accu-mk1-frontend 2>&1 | grep -iE "TS|error" | tail -5
```

Expected: no errors. Manual: navigate to a parent with 2+ vials (e.g. BW-0009), click `Variance Summary`, see the page.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/App.tsx src/components/senaite/SampleDetails.tsx
git commit -m "feat(mk1-fe): route + entry button for variance summary page"
```

---

## Final check

- [ ] **All unit + integration tests green**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_stats.py tests/test_variance_set.py tests/test_sub_samples_service.py tests/test_sub_samples_routes.py -v 2>&1 | tail -15"
```

Expected: all variance tests pass; sub-sample tests still pass (no regression).

- [ ] **Browser smoke**: navigate to a parent with 2+ vials, click Variance Summary, exclude a vial, lock the set, verify locked banner, unlock as admin.

- [ ] **Branch status**: `subvial/continue` is N commits ahead of `feat/vial-assignment-step`.
