# Container-Mode Parent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New families get a `container_mode` parent that is a pure depository for cumulated vial reports — every physical vial is a sub-sample (S01 = "Vial 1"), the parent never consumes demand or appears as a draggable vial, and its analysis rows render as a read-only report view. Legacy families unchanged bit-for-bit.

**Architecture:** A `container_mode` boolean on `lims_samples`, set TRUE at the single parent-creation path (`ensure_sample_row`). Two-mode branches live in exactly four places: `_current_vials()`/variance-summary vial listing (backend), a shared `vialLabel()` helper (FE), the received-count, and a `depositOnly` prop on `AnalysisTable`. Promote, retest cascade, COA pins, SENAITE: untouched. Soft lock only — the server still accepts parent-row transitions.

**Tech Stack:** FastAPI + SQLAlchemy, React + TS, pytest + Vitest. Containers `accumark-subvial-*` (FE :5532, API :5530 `--reload`, Postgres `accumark_mk1`).

**Spec:** `docs/superpowers/specs/2026-06-10-container-parent-design.md`

---

## File Structure

- `backend/models.py` — `LimsSample.container_mode`.
- `backend/database.py` — idempotent ALTER.
- `backend/sub_samples/service.py` — `ensure_sample_row` sets the flag; `_current_vials()` container branch (~line 640); variance-summary vial listing container branch (~line 1157).
- `backend/sub_samples/schemas.py` — `container_mode` on `ParentSampleSummary` + `VialPlanResponse`.
- `backend/sub_samples/routes.py` — pass `container_mode` at the three `ParentSampleSummary(...)` construction sites (~lines 124, 135, 455) and on the vial-plan response.
- `backend/main.py` — HPLC-inbox `vial_meta`/`family_sizes` mode-aware (~lines 13656-13974).
- `src/lib/vial-label.ts` — NEW: single mode-aware labeling helper.
- `src/lib/api.ts` — `container_mode` on the parent-summary + vial-plan types.
- Label call sites: `SampleDetails.tsx:1913,2717`, `VialsQuickLookDialog.tsx:303`, `VialsList.tsx:154,165`, `VialDetailsTab.tsx:126`, `PrintStep.tsx:140`, `InboxVialCard.tsx:144-145`, `VarianceSummary.tsx:256`.
- `src/components/intake/ReceiveWizard/ReceiveWizard.tsx:43` — received count mode-aware.
- `src/components/senaite/AnalysisTable.tsx` — `depositOnly` prop.
- `src/components/senaite/SampleDetails.tsx` — wire `depositOnly`.
- Tests: `backend/tests/test_container_mode.py` (new), `src/test/vial-label.test.ts` (new), extend `src/test/assign-step.test.tsx`, `src/test/vials-quicklook.test.tsx`, new `src/test/deposit-only.test.tsx`.

## Conventions

- Per-task commit, footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Backend tests (LIVE `accumark_mk1` DB): `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -q"`. ZZTEST-* fixtures + teardown; assert zero residue after.
- FE: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run <path>"`; typecheck `npx tsc --noEmit` (only pre-existing error: `WorksheetsInboxPage.tsx(434,38)`).
- Pre-existing failures NOT yours: FE `App.test.tsx`, `peptide-requests-list.test.tsx`; backend `test_sub_samples_service.py` create_sub_sample ×5, `test_list_sub_samples_with_children`, `test_assign_role_fail_hard.py::test_partial_seed_failure_rolls_back_role` (data-dependent). Don't stage `package-lock.json`.
- `compute_vial_plan` PERSISTS auto-assign changes — tests use ZZTEST parents only, never PB-0076.
- LEGACY BEHAVIOR IS SACRED: every container branch must leave `container_mode=False` behavior byte-identical. Existing tests are the legacy regression net — they must stay green untouched (except where a fixture needs an explicit `container_mode=False`, which is the default anyway).

---

## Task 1: Backend — `container_mode` column, migration, creation-path flag, serialization

**Files:**
- Modify: `backend/models.py` (`LimsSample`, near its other booleans)
- Modify: `backend/database.py` (migration list, after the `lims_sub_samples ... assignment_kind` ALTER)
- Modify: `backend/sub_samples/service.py` (`ensure_sample_row`, ~line 48)
- Modify: `backend/sub_samples/schemas.py` (`ParentSampleSummary` ~38, `VialPlanResponse` ~66)
- Modify: `backend/sub_samples/routes.py` (3 `ParentSampleSummary(...)` sites ~124/135/455; vial-plan route response)
- Test: `backend/tests/test_container_mode.py` (new)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_container_mode.py`:

```python
"""container_mode: stored, set at creation, serialized. Live DB; ZZTEST fixtures."""
from datetime import datetime
import pytest
from sqlalchemy import text
from database import SessionLocal
from models import LimsSample, LimsSubSample
from sub_samples import service as sub_service


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback(); s.close()


@pytest.fixture()
def cleanup(db):
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-CM%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-CM%'"))
    db.commit()


def test_container_mode_defaults_false_for_existing_rows(db, cleanup):
    db.execute(text(
        "INSERT INTO lims_samples (sample_id, status) VALUES ('ZZTEST-CM-LEGACY', 'received')"))
    db.commit()
    v = db.execute(text(
        "SELECT container_mode FROM lims_samples WHERE sample_id='ZZTEST-CM-LEGACY'")).scalar_one()
    assert v is False


def test_ensure_sample_row_creates_container_parent(db, cleanup, monkeypatch):
    # ensure_sample_row is the single parent-creation path — new parents are containers.
    from sub_samples import service
    monkeypatch.setattr(service.senaite, "fetch_parent_metadata", lambda sid: {
        "uid": "zz-cm-uid", "review_state": "received"})
    row = sub_service.ensure_sample_row(db, "ZZTEST-CM-NEW")
    db.commit()
    assert row.container_mode is True


def test_parent_summary_serializes_container_mode(db, cleanup):
    parent = LimsSample(sample_id="ZZTEST-CM-SER", status="received", container_mode=True)
    db.add(parent); db.commit()
    from sub_samples.schemas import ParentSampleSummary
    # match how routes.py constructs it — read routes.py and use the same path;
    # the assertion that matters: the field exists and carries the DB value.
    s = ParentSampleSummary(
        sample_id=parent.sample_id, external_lims_uid=None, peptide_name=None,
        status=parent.status, sub_sample_count=0, last_synced_at=datetime.utcnow(),
        container_mode=parent.container_mode,
    )
    assert s.container_mode is True
```

NOTE: read `ensure_sample_row` first — `senaite.fetch_parent_metadata` is imported at module scope in `sub_samples/service.py`; monkeypatch the symbol the function actually resolves. If the insert in the first test trips a NOT NULL on another column, add the minimal extra columns.

- [ ] **Step 2: Run to verify failure**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_container_mode.py -q"`
Expected: FAIL — column `container_mode` does not exist.

- [ ] **Step 3: Model + migration**

`backend/models.py`, in `LimsSample` (match neighbors' style):

```python
    # TRUE = parent is a pure report depository (container-mode families,
    # 2026-06-10-container-parent-design.md): every physical vial is a
    # sub-sample (S01 = Vial 1), the parent never consumes demand and never
    # appears as a draggable vial. FALSE = legacy parent-is-vial-1 behavior.
    container_mode: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
```

`backend/database.py`, in the migration list right after the `lims_sub_samples ... assignment_kind` statements:

```python
        # Container-mode parents (new families only; legacy rows stay FALSE).
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS container_mode BOOLEAN NOT NULL DEFAULT FALSE",
```

- [ ] **Step 4: Set the flag at the single creation path**

`backend/sub_samples/service.py` `ensure_sample_row` (~line 48), add to the `LimsSample(...)` constructor:

```python
        container_mode=True,  # all parents created post-cutover are containers
```

Verify with `grep -rn "LimsSample(" backend --include="*.py" | grep -v test` that `ensure_sample_row` is still the only production construction site; if a new one appeared, set the flag there too and note it in your report.

- [ ] **Step 5: Serialize**

`backend/sub_samples/schemas.py`:
- `ParentSampleSummary` (~38): add `container_mode: bool = False`
- `VialPlanResponse` (~66): add `container_mode: bool = False` with a one-line comment ("parent is a pure depository; vials list contains no parent entry when TRUE").

`backend/sub_samples/routes.py`: pass `container_mode=parent.container_mode` at the two real `ParentSampleSummary(...)` sites (~135, ~455); the missing-parent fallback (~124) keeps the default `False`. In the vial-plan route, thread `container_mode` from the service result onto the response (Task 2 makes the service return it; for this task have `compute_vial_plan` include `"container_mode": parent.container_mode` in its result dict and the route pass it through — a 2-line change that Task 2 builds on).

- [ ] **Step 6: Run to verify pass + regression sweep**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_container_mode.py tests/test_sub_samples_routes.py tests/test_assignment_kind.py -q"`
Expected: new tests PASS; only the documented pre-existing red (`test_list_sub_samples_with_children`). ZZTEST residue 0:
`docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -t -c "SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST-CM%'"` → 0.
NOTE: the backend runs migrations at startup with `--reload`; if the column is missing, `docker restart accumark-subvial-accu-mk1-backend`, wait, re-run.
ALSO: the routes-test mocks (`_mock_sub` / parent mocks in `tests/test_sub_samples_routes.py`) may need `container_mode = False` set on the parent MagicMock — the Task-1-of-variance regression taught us Pydantic rejects bare MagicMock attrs. Check and fix proactively.

- [ ] **Step 7: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/models.py backend/database.py backend/sub_samples/service.py backend/sub_samples/schemas.py backend/sub_samples/routes.py backend/tests/test_container_mode.py backend/tests/test_sub_samples_routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(container): container_mode flag — column, migration, creation path, serialization

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Backend — vial plan and variance summary drop the synthetic parent in container mode

**Files:**
- Modify: `backend/sub_samples/service.py` (`_current_vials` ~640; the second `is_parent: True` listing in the variance-summary builder ~1157)
- Test: `backend/tests/test_container_mode.py` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_container_mode.py`:

```python
def _mk_container_family(db, n_vials=2):
    p = LimsSample(sample_id="ZZTEST-CM-VP", status="received", container_mode=True)
    db.add(p); db.flush()
    for i in range(1, n_vials + 1):
        db.add(LimsSubSample(
            sample_id=f"ZZTEST-CM-VP-S0{i}", parent_sample_pk=p.id, vial_sequence=i,
            received_at=datetime.utcnow(), external_lims_uid=f"zz-cm-vp-s0{i}"))
    db.commit()
    return p


@pytest.fixture()
def vp_cleanup(db):
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-CM-VP%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-CM-VP%'"))
    db.commit()


def test_vial_plan_omits_parent_in_container_mode(db, vp_cleanup, monkeypatch):
    _mk_container_family(db)
    # IS/SENAITE-free: no services -> no demand -> no auto-assign persistence
    monkeypatch.setattr(sub_service, "fetch_sample_services", lambda sid: {})
    plan = sub_service.compute_vial_plan(db, "ZZTEST-CM-VP")
    ids = [v["sample_id"] for v in plan["vials"]]
    assert "ZZTEST-CM-VP" not in ids                       # no synthetic parent entry
    assert ids == ["ZZTEST-CM-VP-S01", "ZZTEST-CM-VP-S02"]
    assert not any(v["is_parent"] for v in plan["vials"])
    assert plan["container_mode"] is True


def test_container_auto_assign_fills_core_with_first_vial(db, vp_cleanup, monkeypatch):
    _mk_container_family(db)
    # demand hplc=1: in container mode a REAL vial takes the core slot
    # (legacy: the parent consumed it). Stub services to produce hplc demand 1,
    # variance 0 — read derive_demand/fetch shape first and stub at the right level.
    monkeypatch.setattr(sub_service, "fetch_sample_services", lambda sid: {})
    monkeypatch.setattr(sub_service, "derive_demand", lambda services: {"hplc": 1, "endo": 0, "ster": 0})
    monkeypatch.setattr(sub_service, "derive_variance_demand", lambda services: {"hplc": 0, "endo": 0, "ster": 0})
    # keep persistence side-effect-free: no-op the seeder via set_assignment_role's import
    import lims_analyses.seeder as seeder
    monkeypatch.setattr(seeder, "seed_analyses_for_vial", lambda *a, **k: None)
    plan = sub_service.compute_vial_plan(db, "ZZTEST-CM-VP")
    role, kind = db.execute(text(
        "SELECT assignment_role, assignment_kind FROM lims_sub_samples "
        "WHERE sample_id='ZZTEST-CM-VP-S01'")).one()
    assert (role, kind) == ("hplc", "core")
    # parent untouched
    prole = db.execute(text(
        "SELECT assignment_role FROM lims_samples WHERE sample_id='ZZTEST-CM-VP'")).scalar_one()
    assert prole is None or prole == "hplc"  # whatever it was — plan must not have written it
```

NOTE: read `compute_vial_plan` + the existing Task-4-of-variance tests in `test_assignment_kind.py` (`test_compute_vial_plan_persists_roles_and_kinds`) FIRST and copy their working monkeypatch mechanics (they already solved the IS/seeder stubbing). Adjust the stubs above to match — the *assertions* are the contract, the stub plumbing should mirror the proven pattern.

- [ ] **Step 2: Run to verify failure**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_container_mode.py -q"`
Expected: FAIL — parent entry present in `plan["vials"]`; S01 not auto-assigned core.

- [ ] **Step 3: Branch `_current_vials`**

In `backend/sub_samples/service.py` `_current_vials()` (~640): when `parent.container_mode`, return only the sub-sample entries (no synthetic parent dict). Update the docstring:

```python
    def _current_vials() -> list[dict]:
        """Sub-samples in vial_sequence order. Legacy families prepend a
        synthetic parent entry (parent IS vial 1 / the canonical); container
        families don't — the parent is a pure depository and never holds a
        bench role or consumes demand."""
        subs = [
            {
                "sample_id": s.sample_id,
                "is_parent": False,
                "vial_sequence": s.vial_sequence,
                "assignment_role": s.assignment_role,
                "assignment_kind": s.assignment_kind,
            }
            for s in sub_rows
        ]
        if parent.container_mode:
            return subs
        return [{
            "sample_id": parent.sample_id,
            "is_parent": True,
            "vial_sequence": 0,
            "assignment_role": parent.assignment_role or "hplc",
            "assignment_kind": None,
        }] + subs
```

(Adapt to the real local variable names.) `auto_assign` needs NO change — parent handling is driven by `is_parent` entries in its input, and container mode simply never feeds it one. The persist loop's `if v["is_parent"]` skip also becomes a no-op naturally. Confirm `compute_vial_plan`'s result dict includes `"container_mode": parent.container_mode` (added in Task 1).

- [ ] **Step 4: Same branch at the variance-summary listing (~1157)**

The variance-summary builder also prepends an `is_parent: True` entry. In container mode the parent's deposit rows are copies of promoted vial results — listing the parent as a variance member would double-count. Apply the same `if parent.container_mode: skip parent entry` branch there. Read the surrounding function first; keep legacy untouched.

- [ ] **Step 5: Run to verify pass + legacy sweep**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_container_mode.py tests/test_assignment_kind.py tests/test_variance_demand.py tests/test_variance_aggregate.py -q"`
Expected: PASS — the legacy suites (which all use `container_mode=False` fixtures by default) must be untouched green. ZZTEST residue 0 (CM% and the suites' own prefixes).

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/sub_samples/service.py backend/tests/test_container_mode.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(container): vial plan + variance summary omit synthetic parent for container families

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: FE — shared `vialLabel` helper + label sweep

**Files:**
- Create: `src/lib/vial-label.ts`
- Modify: `src/lib/api.ts` (parent-summary + vial-plan types get `container_mode`)
- Modify label sites: `src/components/senaite/SampleDetails.tsx:1913,2717`, `src/components/senaite/VialsQuickLookDialog.tsx:303`, `src/components/intake/ReceiveWizard/VialsList.tsx:154,165`, `src/components/intake/ReceiveWizard/VialDetailsTab.tsx:126`, `src/components/intake/ReceiveWizard/PrintStep.tsx:140`, `src/components/samples/VarianceSummary.tsx:256`
- Test: `src/test/vial-label.test.ts` (new)

(`InboxVialCard.tsx` is Task 6 — it needs a backend payload change.)

- [ ] **Step 1: Write the failing tests**

Create `src/test/vial-label.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { vialLabel, vialPosition, vialTotal } from '@/lib/vial-label'

describe('vialLabel', () => {
  it('container mode: S01 is Vial 1', () => {
    expect(vialLabel(1, true)).toBe('Vial 1')
    expect(vialLabel(6, true)).toBe('Vial 6')
  })
  it('legacy: parent is Vial 1, so S01 is Vial 2', () => {
    expect(vialLabel(1, false)).toBe('Vial 2')
    expect(vialLabel(6, false)).toBe('Vial 7')
  })
  it('vialPosition mirrors the numbering for print labels', () => {
    expect(vialPosition(1, true)).toBe(1)
    expect(vialPosition(1, false)).toBe(2)
  })
  it('vialTotal: legacy counts the parent, container does not', () => {
    expect(vialTotal(6, false)).toBe(7)
    expect(vialTotal(6, true)).toBe(6)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/vial-label.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: The helper**

Create `src/lib/vial-label.ts`:

```ts
/** Mode-aware vial numbering. Legacy families: the parent IS Vial 1, so a
 *  sub-sample with vial_sequence N is "Vial N+1". Container families
 *  (parent.container_mode — 2026-06-10-container-parent-design.md): the
 *  parent is a pure depository, S01 IS Vial 1, label = vial_sequence.
 *  EVERY surface that renders a vial number must go through these. */

export function vialPosition(vialSequence: number, containerMode: boolean): number {
  return containerMode ? vialSequence : vialSequence + 1
}

export function vialLabel(vialSequence: number, containerMode: boolean): string {
  return `Vial ${vialPosition(vialSequence, containerMode)}`
}

/** Family-size denominator for "Vial K of N" strings. */
export function vialTotal(subSampleCount: number, containerMode: boolean): number {
  return containerMode ? subSampleCount : subSampleCount + 1
}
```

- [ ] **Step 4: Types + sweep**

`src/lib/api.ts`: add `container_mode: boolean` to the parent-summary interface (the one matching backend `ParentSampleSummary` — grep `sub_sample_count` to find it) and `container_mode?: boolean` to `VialPlanResponse`.

Sweep each site to the helper, sourcing `container_mode` from the data each already has:
- `SampleDetails.tsx:1913` (VialInput map): `label: vialLabel(v.vial_sequence, subData?.parent.container_mode ?? false)` — `subData` is the `listSubSamples` response already in scope.
- `SampleDetails.tsx:2717` ("Vial X of N"): numerator via `vialPosition`, denominator via `vialTotal(...)` with the same flag.
- `VialsQuickLookDialog.tsx:303`: `{vialLabel(vial.vial_sequence, parent.container_mode)} of {vialTotal(parent.sub_sample_count, parent.container_mode)}` — `parent` prop is the summary.
- `VialsList.tsx:154,165` + `VialDetailsTab.tsx:126` + `PrintStep.tsx:140`: these live inside the ReceiveWizard — read how each gets parent/plan data; the vial-plan response now carries `container_mode`, and the wizard has the parent summary. Thread the flag down via existing props (add a `containerMode: boolean` prop where a component has neither — keep it explicit, no context magic).
- `VarianceSummary.tsx:256`: keep the `is_parent` branch (legacy renders "Vial 1 (parent)"); the sub-label becomes `vialLabel(vial.vial_sequence, containerMode)`. Container families never receive a parent entry after Task 2, so the parent branch is naturally legacy-only. Source the flag from whatever parent payload the component already receives (read it first; if it truly has none, extend its props from the caller).

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/vial-label.test.ts src/test/vials-quicklook.test.tsx src/test/assign-step.test.tsx"` → PASS (quicklook fixtures need `container_mode: false` added to the parent mock — legacy labels must not shift).
Typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"` → only the pre-existing error.

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/lib/vial-label.ts src/lib/api.ts src/components/senaite/SampleDetails.tsx src/components/senaite/VialsQuickLookDialog.tsx src/components/intake/ReceiveWizard/VialsList.tsx src/components/intake/ReceiveWizard/VialDetailsTab.tsx src/components/intake/ReceiveWizard/PrintStep.tsx src/components/samples/VarianceSummary.tsx src/test/vial-label.test.ts src/test/vials-quicklook.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(container): mode-aware vial labeling via shared helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: FE — ReceiveWizard received count + AssignStep container behavior

**Files:**
- Modify: `src/components/intake/ReceiveWizard/ReceiveWizard.tsx` (~line 43)
- Test: `src/test/assign-step.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests**

In `src/test/assign-step.test.tsx`, add a container-mode plan fixture (copy `VARIANCE_PLAN`, set `container_mode: true`, remove the `is_parent: true` entry from `vials`) and:

```tsx
describe('container mode', () => {
  it('renders no parent chip — only sub-sample vials', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(CONTAINER_PLAN)
    renderStep()
    await screen.findByText(/HPLC Variance/i)              // step rendered
    expect(screen.queryByText(CONTAINER_PLAN_PARENT_ID)).not.toBeInTheDocument()
  })
})
```

(Adapt names to the file's fixture style. The chip disappears automatically because the plan's `vials` has no parent entry — this test pins the contract against regression.)

- [ ] **Step 2: Run to verify failure-or-pass honestly**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/assign-step.test.tsx"`
This test may already PASS (the behavior is emergent from Task 2's payload shape). That's fine — it's a regression pin, not TDD red; note it in your report rather than manufacturing a failure.

- [ ] **Step 3: Received count**

`src/components/intake/ReceiveWizard/ReceiveWizard.tsx` (~43):

```tsx
  // Received count: legacy families count the parent as a received vial
  // (parent IS vial 1); container families count only physical sub-samples.
  const receivedCount =
    (containerMode ? 0 : (wiz.parentReceived ? 1 : 0)) + wiz.vials.length
```

Read how the wizard learns about the parent (it has `parent.sample_id` ~line 248) and source `containerMode` from the parent summary / vial-plan response it already fetches; if neither is in scope at line 43, fetch-free option: thread it from whatever loaded `wiz` state holds the parent payload. Keep legacy `false` default.

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/assign-step.test.tsx"` → PASS.
Typecheck clean (except pre-existing).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/intake/ReceiveWizard/ReceiveWizard.tsx src/test/assign-step.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(container): received count excludes parent; pin no-parent-chip contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: FE — `depositOnly` report view on the parent page

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx`
- Modify: `src/components/senaite/SampleDetails.tsx`
- Test: `src/test/deposit-only.test.tsx` (new)

- [ ] **Step 1: Write the failing tests**

Create `src/test/deposit-only.test.tsx` (model the render scaffolding on `src/test/vials-quicklook.test.tsx`'s "AnalysisTable default header" block — QueryClientProvider + i18n wrapper):

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const mk = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    uid: 'mk1:900', keyword: 'PUR_GHKCU', title: 'GHK-Cu - Purity',
    result: '99', review_state: 'to_be_verified', promoted_to_parent_id: null,
    ...over,
  }) as SenaiteAnalysis

describe('AnalysisTable depositOnly (container-mode parent page)', () => {
  it('hides row action menus', () => {
    renderTable({ analyses: [mk({})], depositOnly: true })
    expect(screen.queryByRole('button', { name: /analysis actions/i })).not.toBeInTheDocument()
  })
  it('keeps promote provenance visible', () => {
    renderTable({
      analyses: [mk({ review_state: 'promoted', promoted_to_parent_id: 7 })],
      depositOnly: true,
    })
    expect(screen.getByText(/Promoted → #7/)).toBeInTheDocument()
  })
  it('default (legacy) keeps the menus', () => {
    renderTable({ analyses: [mk({})] })
    expect(screen.getByRole('button', { name: /analysis actions/i })).toBeInTheDocument()
  })
})
```

(Write the `renderTable` helper with the required providers; pass minimal required props per `AnalysisTableProps`. Adjust the promote-badge text matcher to the real rendering. Note: `mk1:` + `to_be_verified` rows normally show a menu — that's why the first/third tests are a real pair.)

- [ ] **Step 2: Run to verify failure**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/deposit-only.test.tsx"`
Expected: FAIL — `depositOnly` prop doesn't exist (tsc/type error or menus still render).

- [ ] **Step 3: The prop**

`src/components/senaite/AnalysisTable.tsx`:
- Add to `AnalysisTableProps` + destructure:

```tsx
  /** Container-mode parent page: render as the cumulative report view. Hides
   *  bench affordances (result editing, row transition menus, bulk bench
   *  actions) — SOFT lock, the server still accepts transitions (SENAITE sync
   *  needs them; the hard gate ships with SENAITE elimination). Promote
   *  provenance, variance indicators, and the vial overlay stay. */
  depositOnly?: boolean
```

- Thread `depositOnly` into `AnalysisRow`. In the row: when `depositOnly`, render the actions cell empty (skip the DropdownMenu entirely — `canPromote`/`canVarVerify`/`allowedTransitions` UI all suppressed), and pass read-only into the result cell: read `EditableResultCell` first — if it already supports a disabled/read-only path reuse it; otherwise render the plain value the way non-editable rows already render.
- Bulk: when `depositOnly`, skip rendering the selection checkboxes and bulk toolbar (simplest honest "no bench actions" — read the toolbar block and suppress at the top).
- Badges, `PromotedFromBadge`, `Promoted → #id` text, variance chips, the first-column vial overlay: UNCHANGED.

- [ ] **Step 4: Wire from SampleDetails**

`src/components/senaite/SampleDetails.tsx`: parent pages fetch `subData` (`listSubSamples(sampleId)`) — compute:

```tsx
  // Container-mode parent page = cumulative report view (soft lock; spec
  // 2026-06-10-container-parent-design.md).
  const depositOnly = parentSampleId === null && (subData?.parent.container_mode ?? false)
```

and pass `depositOnly={depositOnly}` to the `AnalysisTable` call (~line 3660 area). Verify `subData` is fetched on parent pages even when there are zero sub-samples (read the query's `enabled` condition; if it only runs with subs present, fix the gate so container parents without vials still get the flag).

- [ ] **Step 5: Run to verify pass + sweep + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/deposit-only.test.tsx src/test/vials-quicklook.test.tsx src/test/variance-verify-gating.test.tsx"` → PASS (quicklook must be untouched — it never passes `depositOnly`).
Typecheck: only pre-existing error.

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/senaite/AnalysisTable.tsx src/components/senaite/SampleDetails.tsx src/test/deposit-only.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(container): depositOnly report view on container-mode parent pages

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: HPLC inbox — mode-aware family size and vial position

**Files:**
- Modify: `backend/main.py` (inbox vial-meta block ~13650-13980: `family_sizes`, `vial_total`, new `container_mode` per item)
- Modify: `src/components/hplc/InboxVialCard.tsx` (~144-145)
- Modify: `src/lib/api.ts` (inbox vial type gets `container_mode?: boolean`)
- Test: extend whichever test covers the inbox payload (grep `vial_total` under `backend/tests/` and `src/test/`; if none exists, add a focused backend test in `backend/tests/test_container_mode.py` against the meta-building logic)

- [ ] **Step 1: Read first**

Read `backend/main.py:13640-13990`. Facts: `family_sizes` initializes every parent at `1` ("parent itself counts as 1", line ~13669) and increments per sub; items carry `vial_total=family_size` and `is_parent`/`vial_sequence`. The FE renders `Vial ${vial_sequence + 1} / ${vial_total}` for subs.

- [ ] **Step 2: Write the failing test**

The family-size computation is inline in a giant route (`backend/main.py` ~13669-13719). As part of this task, extract it into a small pure helper in `backend/main.py` (next to the route) and test THAT:

```python
def _inbox_family_sizes(parent_rows, sub_rows) -> dict[int, int]:
    """Family size per parent pk for 'Vial K of N'. Legacy parents count as
    a vial themselves (+1); container parents are pure depositories (0)."""
    sizes = {r.id: (0 if r.container_mode else 1) for r in parent_rows}
    for s in sub_rows:
        sizes[s.parent_sample_pk] = sizes.get(s.parent_sample_pk, 0) + 1
    return sizes
```

(Adapt to the real loop semantics at ~13712-13719 — there is a `setdefault` branch for parents discovered via subs; preserve it, defaulting those to legacy `1` unless their row carries `container_mode`.) Test, appended to `backend/tests/test_container_mode.py` (pure, no DB):

```python
def test_inbox_family_size_excludes_container_parent():
    from main import _inbox_family_sizes
    from types import SimpleNamespace as NS
    legacy = NS(id=1, container_mode=False)
    container = NS(id=2, container_mode=True)
    subs = [NS(parent_sample_pk=1), NS(parent_sample_pk=1),
            NS(parent_sample_pk=2), NS(parent_sample_pk=2)]
    sizes = _inbox_family_sizes([legacy, container], subs)
    assert sizes[1] == 3   # legacy: parent counts as a vial
    assert sizes[2] == 2   # container: physical vials only
```

- [ ] **Step 3: Implement**

- `family_sizes` init: `{r.id: (0 if r.container_mode else 1) for r in parent_rows}`.
- Add `container_mode` to `vial_meta_by_uid[...]` dicts and to the response item model next to `vial_total` (find the Pydantic model at ~13245).
- `src/lib/api.ts`: `container_mode?: boolean` on the inbox vial interface (the one with `vial_total`, ~4380).
- `src/components/hplc/InboxVialCard.tsx` (~144): use the Task-3 helper:

```tsx
  const positionLabel = vial.is_parent
    ? vial.vial_total > 1 ? `Vial 1 / ${vial.vial_total}` : null
    : `${vialLabel(vial.vial_sequence, vial.container_mode ?? false)} / ${vial.vial_total}`
```

(Container parents have no bench work so `is_parent` cards shouldn't occur for them in practice — leave the parent branch legacy-only, same reasoning as VarianceSummary.)

- [ ] **Step 4: Run to verify**

Backend: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_container_mode.py -q"` → PASS.
FE: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run"` relevant inbox tests + typecheck → only pre-existing issues.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/main.py src/components/hplc/InboxVialCard.tsx src/lib/api.ts backend/tests/test_container_mode.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(container): HPLC inbox family size + vial position are mode-aware

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Backend: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_container_mode.py tests/test_assignment_kind.py tests/test_variance_kind_gate.py tests/test_variance_demand.py tests/test_sub_samples_routes.py tests/test_lims_analyses_state_machine.py -q"` → green except documented pre-existing. ZZTEST residue 0.
- [ ] Full FE: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run"` → only the 2 documented pre-existing failures. `npx tsc --noEmit` → only `WorksheetsInboxPage.tsx`.
- [ ] **Live on the stack** (restart `accumark-subvial-accu-mk1-frontend` first — SampleDetails/AnalysisTable are big files, the Vite stale-transform trap applies; browser needs the localhost:5530/5535 overrides):
  - Create a fresh dev family (new parent via check-in) → parent row has `container_mode=true` in DB.
  - Receive wizard: received count = sub count; first vial lands S01 labeled "Vial 1"; AssignStep shows NO parent chip; auto-assign gives S01 the core HPLC slot.
  - Parent page: analyses render with no row menus / no editors / no bulk checkboxes; promote badges and vial overlay intact.
  - **Legacy regression:** PB-0076 still renders exactly as before — parent chip in HPLC bucket, "Vial 7 — S06" labels, row menus on parent page, received 7/6.

## Notes

- Soft lock means NO changes to `tier_of`, `apply_transition`, promote, retest, COA pins, or SENAITE surfaces. If a task seems to need one, stop — that's the hard-gate arc.
- The known later-arc items (do NOT do): legacy backfill, hard server gate, COA reading vials directly, SENAITE elimination.
