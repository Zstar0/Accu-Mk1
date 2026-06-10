# Variance-Bucket Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make variance an explicit per-vial assignment (`assignment_kind: core|variance`) set at check-in via drag buckets, so the workflow path (promote vs `variance_verify`) is a deterministic function of assignment rather than commercial entitlement.

**Architecture:** New nullable `assignment_kind` enum column on `lims_sub_samples` (orthogonal to `in_variance_set`/stats and to `assignment_role`/bench). Check-in drag sets `(role, kind)` together. Sign-off gates on `kind='variance'` (the commercial `ensure_variance_entitlement` gate is retired to display-only). Indicators re-key off `kind`. Parent stays canonical. Re-architecture of the variance model — supersedes the implicit `max()` demand + commercial gate.

**Tech Stack:** FastAPI + SQLAlchemy (Python), React + TS + dnd-kit, Vitest + pytest. Containers `accumark-subvial-*` (FE :5532, API :5530 `--reload`, Postgres `accumark_mk1`).

**Spec:** `docs/superpowers/specs/2026-06-10-variance-bucket-assignment-design.md`

---

## File Structure

- `backend/models.py` — `LimsSubSample.assignment_kind`.
- `backend/database.py` — idempotent migration (add column + backfill).
- `backend/sub_samples/schemas.py` — `assignment_kind` on `SubSampleResponse` + `VialPlanItem`; `kind` on `AssignmentPatchRequest`.
- `backend/sub_samples/service.py` — `set_assignment_role` accepts `kind`; re-assignment lock guard; `compute_vial_plan`/`auto_assign` carry + fill kind.
- `backend/sub_samples/routes.py` — patch passes `kind`.
- `backend/lims_analyses/service.py` — `apply_transition`: `variance_verify` requires vial `kind='variance'`; promote rejects `kind='variance'`.
- `backend/lims_analyses/routes.py` — retire the `ensure_variance_entitlement` gate call.
- `src/lib/api.ts` — `SubSample`/`VialPlanItem` types + `patchVialAssignment(role, kind)`.
- `src/lib/vial-assignment.ts` — `VialMatch.assignmentKind`.
- `src/components/intake/ReceiveWizard/AssignStep.tsx` — variance drop zones + kind-aware drag + paid-count marker.
- `src/components/senaite/AnalysisTable.tsx` — `isPromotable`/`canVarianceVerify`/`isVarianceMember`/`showVarianceChip` + badge re-key off kind; new `vialKind` prop.
- `src/components/senaite/SampleDetails.tsx` — pass `vialKind`.
- `src/components/senaite/SenaiteDashboard.tsx` — `subIsVarianceMember` keys off `sub.assignment_kind`.

## Conventions

- Per-task commit, footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Backend tests (LIVE `accumark_mk1` DB): `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -q"`. Use `ZZTEST-*` fixtures + teardown; assert no residue after.
- FE: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run <path>"`; typecheck `npx tsc --noEmit` (the only pre-existing error is `WorksheetsInboxPage.tsx`).
- Additive to files, but this feature intentionally supersedes the commercial gate + `max()` demand. Baseline superseded tests against the prior commit; don't chase unrelated pre-existing reds. Don't stage the dirty `package-lock.json`.
- This is dev/test data — `compute_vial_plan` PERSISTS auto-assign changes; tests must use ZZTEST parents, never PB-0076.

---

## Task 1: Backend — `assignment_kind` column, model, migration, serialization

**Files:**
- Modify: `backend/models.py` (`LimsSubSample`, ~line 773)
- Modify: `backend/database.py` (migration block, ~line 329)
- Modify: `backend/sub_samples/schemas.py` (`SubSampleResponse` ~line 27)
- Test: `backend/tests/test_assignment_kind.py` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_assignment_kind.py`:

```python
"""assignment_kind column: stored, serialized, defaults NULL. Live DB; ZZTEST fixtures."""
from datetime import datetime
import pytest
from sqlalchemy import text
from database import SessionLocal
from models import LimsSample, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback(); s.close()


@pytest.fixture()
def fixture(db):
    parent = LimsSample(sample_id="ZZTEST-AK", peptide_name="ZZ", status="received", assignment_role="hplc")
    db.add(parent); db.flush()
    db.add(LimsSubSample(sample_id="ZZTEST-AK-S01", parent_sample_pk=parent.id, vial_sequence=1,
                         received_at=datetime.utcnow(), assignment_role="hplc",
                         external_lims_uid="zz-ak-s01", assignment_kind="variance"))
    db.commit()
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AK%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AK%'"))
    db.commit()


def test_assignment_kind_round_trips(db, fixture):
    sub = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S01'")).scalar_one()
    assert sub == "variance"


def test_assignment_kind_defaults_null(db, fixture):
    db.execute(text("INSERT INTO lims_sub_samples (sample_id, parent_sample_pk, vial_sequence, received_at, external_lims_uid) "
                    "SELECT 'ZZTEST-AK-S02', id, 2, now(), 'zz-ak-s02' FROM lims_samples WHERE sample_id='ZZTEST-AK'"))
    db.commit()
    k = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S02'")).scalar_one()
    assert k is None
```

- [ ] **Step 2: Run to verify failure**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assignment_kind.py -q"`
Expected: FAIL — column `assignment_kind` does not exist (or model attr missing).

- [ ] **Step 3: Add the model column**

In `backend/models.py`, in `LimsSubSample` right after `assignment_role` (~line 773), add:

```python
    # core | variance — workflow bucket set at check-in. NULL = not yet
    # designated. Orthogonal to in_variance_set (stats inclusion).
    assignment_kind: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
```

- [ ] **Step 4: Add the migration**

In `backend/database.py`, in the same statement list right after the `lims_sub_samples ... assignment_role` ALTER (~line 329), add:

```python
        # Variance bucket assignment (core|variance) — set at check-in; NULL until then.
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS assignment_kind VARCHAR(8)",
        # Backfill: vials assigned pre-buckets behaved as promote-path -> 'core'.
        # Idempotent: matches no rows once set. Unassigned (role NULL) stays NULL.
        """UPDATE lims_sub_samples
              SET assignment_kind = 'core'
            WHERE assignment_role IS NOT NULL
              AND assignment_role <> 'xtra'
              AND assignment_kind IS NULL""",
```

- [ ] **Step 5: Serialize it**

In `backend/sub_samples/schemas.py`, in `SubSampleResponse` after `assignment_role` (~line 27), add:

```python
    assignment_kind: Optional[str] = None
```

- [ ] **Step 6: Run to verify pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assignment_kind.py -q"`
Expected: PASS (the API container's startup ran migrations on reload; if the column isn't present, restart: `docker restart accumark-subvial-accu-mk1-backend` then re-run). Confirm no ZZTEST residue:
`docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -t -c "SELECT count(*) FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AK%'"` → 0.

- [ ] **Step 7: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/models.py backend/database.py backend/sub_samples/schemas.py backend/tests/test_assignment_kind.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): assignment_kind column + migration + serialization

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Backend — `set_assignment_role` accepts `kind`; patch route; lock guard

**Files:**
- Modify: `backend/sub_samples/service.py` (`set_assignment_role`, ~line 837)
- Modify: `backend/sub_samples/schemas.py` (`AssignmentPatchRequest`, ~line 74)
- Modify: `backend/sub_samples/routes.py` (`patch_assignment`, ~line 257-270)
- Test: `backend/tests/test_assignment_kind.py` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_assignment_kind.py`:

```python
from sub_samples import service as sub_service


def test_set_assignment_role_sets_kind(db, fixture):
    sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "hplc", kind="core")
    k = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S01'")).scalar_one()
    assert k == "core"


def test_set_assignment_rejects_bad_kind(db, fixture):
    with pytest.raises(ValueError):
        sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "hplc", kind="bogus")


def test_reassignment_blocked_when_variance_locked(db, fixture):
    db.execute(text("UPDATE lims_samples SET variance_locked_at = now() WHERE sample_id='ZZTEST-AK'"))
    db.commit()
    from errors import BadRequestError  # adjust import to the project's error module
    with pytest.raises(BadRequestError):
        sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "endo", kind="core")
```

NOTE: confirm the project's `BadRequestError` import path (grep `class BadRequestError`); if it lives in `lims_analyses.service` or a shared `errors` module, import accordingly. If the codebase raises a different error type for locked operations, match it.

- [ ] **Step 2: Run to verify failure**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assignment_kind.py -q"`
Expected: FAIL — `set_assignment_role` has no `kind` param.

- [ ] **Step 3: Extend `set_assignment_role`**

In `backend/sub_samples/service.py`, change the signature (~line 837) and set the kind + lock guard. Read the function first; add `kind` as a keyword param and, right after the role validation (~line 844), add the kind validation + lock guard, and set `sub.assignment_kind` next to `sub.assignment_role = role`:

```python
_VALID_KINDS = {"core", "variance"}


def set_assignment_role(db: Session, sample_id: str, role: Optional[str],
                        kind: Optional[str] = None, user_id: Optional[int] = None) -> dict:
    if role is not None and role not in _VALID_ROLES:
        raise ValueError(f"Invalid role: {role!r}")
    if kind is not None and kind not in _VALID_KINDS:
        raise ValueError(f"Invalid assignment_kind: {kind!r}")
    # ... existing sub lookup ...
    if sub is not None:
        parent_row = db.get(LimsSample, sub.parent_sample_pk)
        if parent_row is not None and parent_row.variance_locked_at is not None:
            from lims_analyses.service import BadRequestError  # match project error type
            raise BadRequestError("variance set is locked; unlock before re-assigning vials")
        old_role = sub.assignment_role
        sub.assignment_role = role
        sub.assignment_kind = kind if role and role != "xtra" else None
        # ... existing event + cleanup + seed ...
```

(`xtra`/unassigned coerce `kind=None` — kind only applies to testable roles.)

- [ ] **Step 4: Thread `kind` through the request + route**

In `backend/sub_samples/schemas.py`, `AssignmentPatchRequest` (~line 74):

```python
class AssignmentPatchRequest(BaseModel):
    role: Optional[str]  # 'hplc' | 'endo' | 'ster' | 'xtra' | None
    kind: Optional[str] = None  # 'core' | 'variance' | None
```

In `backend/sub_samples/routes.py`, `patch_assignment` (~line 270):

```python
        return service.set_assignment_role(db, sample_id, body.role, kind=body.kind, user_id=user.id)
```

- [ ] **Step 5: Run to verify pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assignment_kind.py -q"`
Expected: PASS. ZZTEST residue 0.

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/sub_samples/service.py backend/sub_samples/schemas.py backend/sub_samples/routes.py backend/tests/test_assignment_kind.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): set_assignment_role accepts kind; lock guard on re-assignment

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Backend — sign-off gate moves from entitlement to assignment

**Files:**
- Modify: `backend/lims_analyses/service.py` (`apply_transition` variance_verify branch ~line 318; promote path)
- Modify: `backend/lims_analyses/routes.py` (`transition`, ~line 220-223)
- Test: `backend/tests/test_variance_kind_gate.py` (new); baseline `test_variance_verify.py` entitlement-gate tests as superseded

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_variance_kind_gate.py` (ZZTEST fixtures; mirrors `test_variance_verify.py` shape — a ZZTEST parent + hplc vial + a `to_be_verified` analysis with a result). Two vials: one `assignment_kind='variance'`, one `'core'`:

```python
"""variance_verify gates on assignment_kind='variance', not commercial entitlement."""
from datetime import datetime
import pytest
from sqlalchemy import text
from database import SessionLocal
from lims_analyses import service
from lims_analyses.service import BadRequestError
from models import LimsAnalysis, LimsSample, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try: yield s
    finally: s.rollback(); s.close()


def _mk_vial(db, parent, seq, kind):
    v = LimsSubSample(sample_id=f"ZZTEST-VK-S0{seq}", parent_sample_pk=parent.id, vial_sequence=seq,
                      received_at=datetime.utcnow(), assignment_role="hplc",
                      external_lims_uid=f"zz-vk-s0{seq}", assignment_kind=kind)
    db.add(v); db.flush()
    svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
    row = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=svc_id,
                       keyword=f"ZZTEST-VK-{seq}", title="ZZ", result_value="99", review_state="to_be_verified")
    db.add(row); db.flush()
    return row


@pytest.fixture()
def fixture(db):
    p = LimsSample(sample_id="ZZTEST-VK", peptide_name="ZZ", status="received"); db.add(p); db.flush()
    var_row = _mk_vial(db, p, 1, "variance")
    core_row = _mk_vial(db, p, 2, "core")
    db.commit()
    yield {"var": var_row.id, "core": core_row.id}
    db.rollback()
    db.execute(text("DELETE FROM lims_analyses WHERE keyword LIKE 'ZZTEST-VK%'"))
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-VK%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-VK%'"))
    db.commit()


def test_variance_verify_allowed_on_variance_kind(db, fixture):
    row = service.apply_transition(db, analysis_id=fixture["var"], kind="variance_verify")
    assert row.review_state == "variance_verified"


def test_variance_verify_rejected_on_core_kind(db, fixture):
    with pytest.raises(BadRequestError):
        service.apply_transition(db, analysis_id=fixture["core"], kind="variance_verify")
```

Also: in `backend/tests/test_variance_verify.py`, the `ensure_variance_entitlement` service tests (~lines 160-220) are **superseded** by this gate change. Mark the class skipped with a reason, or delete it, and note it in the commit. (Stash-baseline: confirm they were green before; they're being intentionally retired, not regressed.)

- [ ] **Step 2: Run to verify failure**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_kind_gate.py -q"`
Expected: FAIL — `variance_verify` currently succeeds regardless of kind (no kind check yet).

- [ ] **Step 3: Add the kind gate in `apply_transition`**

In `backend/lims_analyses/service.py`, the `variance_verify` branch (~line 318-326) already checks result + sub-hosted. Add the kind check after the sub-hosted check:

```python
    elif kind == "variance_verify":
        if not row.result_value:
            raise BadRequestError("variance_verify requires a result_value on the row")
        if row.lims_sub_sample_pk is None:
            raise BadRequestError("variance_verify is only valid on sub-sample-hosted rows")
        from models import LimsSubSample
        vial = db.get(LimsSubSample, row.lims_sub_sample_pk)
        if vial is None or vial.assignment_kind != "variance":
            raise BadRequestError(
                "variance_verify requires the host vial to be assigned to a variance bucket"
            )
```

- [ ] **Step 4: Reject promote on a variance-kind vial**

Find the promote entry point in `backend/lims_analyses/service.py` (grep `def promote`). At the start of the promote of a single source vial, after loading the source vial's sub-sample (the code already loads `sub = db.get(LimsSubSample, ...)` ~line 613/804), add a guard:

```python
        if sub is not None and sub.assignment_kind == "variance":
            raise BadRequestError(
                f"{sid} is assigned to a variance bucket and cannot be promoted; "
                f"re-assign it to the core bucket first"
            )
```

(Place it where the promote source vial is resolved. If promote handles multiple sources, guard each.)

- [ ] **Step 5: Retire the commercial gate in the route**

In `backend/lims_analyses/routes.py` (~line 220-223), remove the `ensure_variance_entitlement` pre-check (the assignment gate in `apply_transition` now governs):

```python
    try:
        row = service.apply_transition(
            db,
            analysis_id=analysis_id,
            kind=req.kind,
            result_value=req.result_value,
            reason=req.reason,
            user_id=getattr(current_user, "id", None),
        )
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)
```

Leave `ensure_variance_entitlement` defined (it may still be useful for the AssignStep paid-count display via its endpoint) but it is no longer a transition gate. Add a one-line docstring note that it is display-only now.

- [ ] **Step 6: Run to verify pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_kind_gate.py tests/test_lims_analyses_state_machine.py -q"`
Expected: PASS (the new gate tests; state-machine green except documented pre-existing). ZZTEST residue 0.

- [ ] **Step 7: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/service.py backend/lims_analyses/routes.py backend/tests/test_variance_kind_gate.py backend/tests/test_variance_verify.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): gate variance_verify on assignment_kind; retire commercial gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Backend — vial plan carries + auto-fills `assignment_kind`

**Files:**
- Modify: `backend/sub_samples/schemas.py` (`VialPlanItem`, ~line 55)
- Modify: `backend/sub_samples/service.py` (`compute_vial_plan` ~622, `auto_assign` ~740)
- Test: `backend/tests/test_variance_demand.py` (extend) or `test_assignment_kind.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_assignment_kind.py` a pure-function test of the auto-assign fill order (no DB), modeled on the existing `auto_assign` signature (read it first, ~line 740, to match its dict shape). The intent:

```python
def test_auto_assign_fills_core_then_variance():
    # 1 base HPLC + variance target 2 => parent/first vial core, surplus variance.
    vials = [
        {"sample_id": "P-S01", "is_parent": False, "assignment_role": None, "assignment_kind": None},
        {"sample_id": "P-S02", "is_parent": False, "assignment_role": None, "assignment_kind": None},
    ]
    out = sub_service.auto_assign(vials, demand={"hplc": 1, "endo": 0, "ster": 0},
                                  variance={"hplc": 2, "endo": 0, "ster": 0})
    kinds = {v["sample_id"]: (v["assignment_role"], v["assignment_kind"]) for v in out}
    assert kinds["P-S01"] == ("hplc", "core")
    assert kinds["P-S02"] == ("hplc", "variance")
```

Adjust the assertion to match the real `auto_assign` contract after reading it — the key behavior to assert is: base demand filled with `kind='core'`, surplus up to the variance target filled with `kind='variance'`.

- [ ] **Step 2: Run to verify failure**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assignment_kind.py -k auto_assign -q"`
Expected: FAIL — `auto_assign` doesn't accept `variance` / doesn't set `assignment_kind`.

- [ ] **Step 3: Carry kind in the plan + auto_assign**

Read `compute_vial_plan` (~622) and `auto_assign` (~740). In `VialPlanItem` (`schemas.py:55`) add:

```python
    assignment_kind: Optional[str] = None
```

In `compute_vial_plan`, include each vial's `assignment_kind` in the returned `vials` dicts (alongside `assignment_role`). In `auto_assign`, accept a `variance` dict param and, when assigning a role to fill demand, set `assignment_kind='core'` up to `base/demand` per bucket, then `assignment_kind='variance'` for surplus vials up to the variance target. Persisted assignments go through `set_assignment_role(..., kind=...)` (Task 2) so the kind is saved. Match the existing persistence path in `compute_vial_plan` — it calls `set_assignment_role`; pass the chosen kind.

- [ ] **Step 4: Run to verify pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assignment_kind.py tests/test_variance_demand.py -q"`
Expected: PASS (baseline any superseded `derive_demand` `max()` assertions — the variance target is now a separate bucket, not an inflation of the base bucket; update those tests to the new model).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/sub_samples/schemas.py backend/sub_samples/service.py backend/tests/test_assignment_kind.py backend/tests/test_variance_demand.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): vial plan carries assignment_kind; auto-assign fills core then variance

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: FE — AssignStep variance drop zones + kind-aware patch + paid-count marker

**Files:**
- Modify: `src/lib/api.ts` (`patchVialAssignment`, `VialPlanItem`, `SubSample` types)
- Modify: `src/components/intake/ReceiveWizard/AssignStep.tsx`
- Test: `src/test/assign-step.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `src/test/assign-step.test.tsx` (uses `VARIANCE_PLAN`, `getVialPlan`, `patchVialAssignment` mocks already imported). The drag is hard to simulate; instead test the bucket→(role,kind) mapping helper and the marker. First add an exported pure helper to AssignStep (Step 3 defines it), then:

```tsx
import { bucketToAssignment } from '@/components/intake/ReceiveWizard/AssignStep'

describe('bucketToAssignment', () => {
  it('maps variance buckets to (role, variance)', () => {
    expect(bucketToAssignment('hplc_variance')).toEqual({ role: 'hplc', kind: 'variance' })
    expect(bucketToAssignment('endo_variance')).toEqual({ role: 'endo', kind: 'variance' })
    expect(bucketToAssignment('ster_variance')).toEqual({ role: 'ster', kind: 'variance' })
  })
  it('maps core buckets to (role, core)', () => {
    expect(bucketToAssignment('hplc')).toEqual({ role: 'hplc', kind: 'core' })
    expect(bucketToAssignment('xtra')).toEqual({ role: 'xtra', kind: null })
  })
})

describe('variance drop zones', () => {
  it('renders an HPLC Variance zone with the paid-count marker', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)  // variance.hplc = 3
    renderStep()
    expect(await screen.findByText(/HPLC Variance/i)).toBeInTheDocument()
    expect(screen.getByText(/paid 3/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/assign-step.test.tsx"`
Expected: FAIL — `bucketToAssignment` not exported; no "HPLC Variance" zone.

- [ ] **Step 3: API client — kind param**

In `src/lib/api.ts`: `patchVialAssignment(sampleId, role, kind = null)` sends `{ role, kind }`; add `assignment_kind?: 'core' | 'variance' | null` to `SubSample` and `VialPlanItem` interfaces. Read the current `patchVialAssignment` signature and `VialPlanItem`/`SubSample` defs to match style.

- [ ] **Step 4: AssignStep — buckets, mapping, drag, marker**

In `src/components/intake/ReceiveWizard/AssignStep.tsx`:
- Extend `BucketId` to include `'hplc_variance' | 'endo_variance' | 'ster_variance'`.
- Add the exported helper:

```tsx
export function bucketToAssignment(b: string): { role: string; kind: 'core' | 'variance' | null } {
  if (b.endsWith('_variance')) return { role: b.replace('_variance', ''), kind: 'variance' }
  if (b === 'xtra') return { role: 'xtra', kind: null }
  return { role: b, kind: 'core' }
}
```

- In `handleDragEnd` (~line 72), replace the single `patchVialAssignment(sampleId, target)` with:

```tsx
      const { role, kind } = bucketToAssignment(target)
      // optimistic: store role + kind on the vial
      const next = { ...plan, vials: plan.vials.map(v =>
        v.sample_id === sampleId ? { ...v, assignment_role: role, assignment_kind: kind } : v) }
      setPlan(next)
      await patchVialAssignment(sampleId, role, kind)
```

- Render a Variance drop zone per role (reuse the `Bucket`/`SubDropZone` droppable pattern). Each variance zone: droppable id `${role}_variance`, header shows the paid-count marker e.g. `Variance · paid {plan.variance[role]}`, and holds vials where `assignment_role===role && assignment_kind==='variance'`. Core zones hold `assignment_kind!=='variance'`. Mark vials beyond the paid count visually (e.g. a subtle "extra" tag) but never block.

- [ ] **Step 5: Run to verify pass**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/assign-step.test.tsx"` → PASS.
Typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"` → no new errors.

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/lib/api.ts src/components/intake/ReceiveWizard/AssignStep.tsx src/test/assign-step.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): AssignStep variance drop zones + kind-aware assignment + paid marker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: FE — lifecycle + indicators re-key off `assignment_kind`

**Files:**
- Modify: `src/lib/vial-assignment.ts` (`VialMatch.assignmentKind`)
- Modify: `src/components/senaite/AnalysisTable.tsx` (predicates + badge + `vialKind` prop)
- Modify: `src/components/senaite/SampleDetails.tsx` (pass `vialKind`; carry kind into VialInput)
- Modify: `src/components/senaite/SenaiteDashboard.tsx` (`subIsVarianceMember` on `assignment_kind`)
- Test: `src/test/variance-verify-gating.test.tsx`, `src/test/dashboard-variance.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `src/test/variance-verify-gating.test.tsx`, the predicates now take a `kind` instead of entitlement. Update the existing suites and add:

```tsx
describe('canVarianceVerify (kind-based)', () => {
  it('true for an mk1 to_be_verified row whose vial kind is variance', () => {
    expect(canVarianceVerify(mk({}), 'variance')).toBe(true)
  })
  it('false when the vial kind is core', () => {
    expect(canVarianceVerify(mk({}), 'core')).toBe(false)
  })
  it('false for promoted / wrong state regardless of kind', () => {
    expect(canVarianceVerify(mk({ review_state: 'promoted' }), 'variance')).toBe(false)
    expect(canVarianceVerify(mk({ promoted_to_parent_id: 7 }), 'variance')).toBe(false)
  })
})

describe('isPromotable (kind-aware)', () => {
  it('false when vial kind is variance', () => {
    expect(isPromotable(mk({}), 'variance')).toBe(false)
  })
  it('true for a core to_be_verified mk1 row', () => {
    expect(isPromotable(mk({}), 'core')).toBe(true)
  })
})
```

In `src/test/dashboard-variance.test.tsx`, change `subIsVarianceMember` to read `sub.assignment_kind === 'variance'`:

```tsx
it('true when the sub is assigned to a variance bucket', () => {
  expect(subIsVarianceMember(sub('hplc', 'variance'))).toBe(true)
})
it('false for a core sub', () => {
  expect(subIsVarianceMember(sub('hplc', 'core'))).toBe(false)
})
```

(Update the `sub()` helper to take a kind and set `assignment_kind`.)

- [ ] **Step 2: Run to verify failure**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx src/test/dashboard-variance.test.tsx"`
Expected: FAIL — predicates still take entitlement.

- [ ] **Step 3: Re-key the predicates**

In `src/components/senaite/AnalysisTable.tsx`:
- `isPromotable(a, kind?)`: return false when `kind === 'variance'`; otherwise the existing logic.
- `canVarianceVerify(a, kind?)`: replace the entitlement check with `kind === 'variance'`, keep `mk1:` + `to_be_verified` + not-promoted:

```tsx
export function canVarianceVerify(a: SenaiteAnalysis, kind: string | null | undefined): boolean {
  if (!a.uid || !a.uid.startsWith('mk1:')) return false
  if (a.review_state !== 'to_be_verified') return false
  if (a.promoted_to_parent_id != null) return false
  return kind === 'variance'
}
```

- `isVarianceMember(a, kind)` / `showVarianceChip(a, kind)`: member = `mk1:` + `kind === 'variance'` (state-independent); `showVarianceChip` keeps the promoted/variance_verified suppression.
- Add a `vialKind?: string | null` prop to `AnalysisTable` + `AnalysisRow` (parallel to `vialRole`); the row computes `canVarVerify = canVarianceVerify(analysis, vialKind)` and `isPromotable(analysis, vialKind)`.
- Badge: `varianceReady={canVarVerify}` — **drop the `&& locked`** (no parent-lock dependency).
- The first-column vial-list overlay: use `m.assignmentKind` (Step 5) instead of `vialListVarianceEntitlement`. Remove the `vialListVarianceEntitlement` prop and its plumbing (added in `829ce36`) — superseded.
- **Sweep all callers of the changed signatures** (grep `canVarianceVerify(` and `isPromotable(` in `AnalysisTable.tsx`): `deriveBulkActions` (the bulk "Verify (Variance) selected" path) calls `canVarianceVerify(a, vialRole, varianceEntitlement)` and `isPromotable(a)` — re-point them to the kind form. Bulk needs each selected row's kind; on a sub-sample page all rows share the table `vialKind`, so pass `vialKind` into `deriveBulkActions` instead of `(primaryRole, varianceEntitlement)`. Update its tests in `variance-verify-gating.test.tsx` (the `deriveBulkActions — showVarianceVerify` suite) to the kind form. Compile-check (`tsc`) catches any missed caller.

- [ ] **Step 4: Carry kind to the FE — VialMatch + SampleDetails**

In `src/lib/vial-assignment.ts`: add `assignmentKind?: string | null` to `VialMatch` and `VialInput`; the builder sets `assignmentKind: v.assignmentKind` (mirror the `assignmentRole` plumbing already there from `829ce36`).
In `src/components/senaite/SampleDetails.tsx`: the VialInput map adds `assignmentKind: v.assignment_kind`; compute `currentAssignmentKind = isParent ? subData?.parent... (parent has no kind → null) : parentSummary?.sub_samples.find(...)?.assignment_kind ?? null` and pass `vialKind={currentAssignmentKind}` to `AnalysisTable`. Remove the `vialListVarianceEntitlement` hook + prop.

- [ ] **Step 5: Dashboard predicate**

In `src/components/senaite/SenaiteDashboard.tsx`: `subIsVarianceMember(sub) => sub.assignment_kind === 'variance'`. Drop the `agg`/`variance`-map dependency for the sub-name treatment (parent flag can stay if you keep the aggregates `variance` map, or switch the parent flag to "any sub has assignment_kind==='variance'" — simplest: parent flag = `subs.some(s => s.assignment_kind === 'variance')` once subs are loaded, else keep the aggregate map). Keep it minimal: re-point the sub-name treatment to `assignment_kind`; leave the parent flag as-is if it still reads.

- [ ] **Step 6: Run to verify pass + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx src/test/dashboard-variance.test.tsx src/test/assign-step.test.tsx src/test/vials-quicklook.test.tsx"` → PASS.
Typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"` → no new errors.

- [ ] **Step 7: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/lib/vial-assignment.ts src/components/senaite/AnalysisTable.tsx src/components/senaite/SampleDetails.tsx src/components/senaite/SenaiteDashboard.tsx src/test/variance-verify-gating.test.tsx src/test/dashboard-variance.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): re-key lifecycle + indicators off assignment_kind; drop parent-lock + entitlement gating

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Backend: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assignment_kind.py tests/test_variance_kind_gate.py tests/test_variance_demand.py tests/test_lims_analyses_state_machine.py -q"` → green except documented pre-existing. ZZTEST residue 0.
- [ ] Full FE: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run"` → only the 2 documented pre-existing failures.
- [ ] **Live on the stack** (the step that matters — drive the browser, don't trust tests):
  - AssignStep on a ZZTEST/dev parent: drag a vial into "HPLC Variance" → it lands there; "HPLC" core zone separate; paid-count marker shows.
  - That vial's sub-sample page: rows show "Ready to Verify" (NOT "Ready to Promote"), ⋯ menu offers Verify (Variance), NOT Promote; no parent-lock wait.
  - A core vial: shows "Ready to Promote", offers Promote, not Verify.
  - Re-assign the variance vial → core (drag): its rows flip to the promote path. Re-assign with the variance set locked → blocked.
  - AR list + sample-details indicators light off assignment_kind.

## Notes / superseded

- Retires: the commercial `ensure_variance_entitlement` *gate* (kept as display-only endpoint), the `max()` demand inflation, the parent-lock badge gate, and the `vialListVarianceEntitlement` plumbing from `829ce36`.
- Out of scope (deferred): auto-cleanup of artifacts on re-assignment; vial-based parent-as-container model.
