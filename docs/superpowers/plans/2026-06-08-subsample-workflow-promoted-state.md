# Sub-sample `promoted` Workflow State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sub-sample analyses a distinct lifecycle ending at a new `promoted` state on Promote, make `verified`/`published` parent-tier-only, and remove the sub-sample `verify` escape hatch so a sub-sample result can never be stranded.

**Architecture:** Add `promoted` to the pure state machine + DB CHECK + FE badge; remove `verify` from the sub-sample tier matrix (which blocks it via the existing `TierMismatchError` path); change `promote_to_parent` to transition its source `to_be_verified → promoted`; allow retest from `promoted`; migrate existing already-promoted sub-samples to `promoted`. Type-agnostic — no new identifier names "vial".

**Tech Stack:** Python/FastAPI + SQLAlchemy (hand-rolled DDL + `_run_migrations`), pytest; React/TS + vitest.

**Spec:** `docs/superpowers/specs/2026-06-08-subsample-workflow-promoted-state-design.md`

**Worktree / branch:** `C:/tmp/Accu-Mk1-subvial`, branch `subvial/continue`. Containers: backend `accumark-subvial-accu-mk1-backend`, frontend `accumark-subvial-accu-mk1-frontend`. `MSYS_NO_PATHCONV=1` prefix is required for `docker exec` (Git-Bash-on-Windows). Backend hot-reloads; migrations run at startup, or manually via `python -c 'import database; database._run_migrations()'`. If pytest is missing after a container recreate: `docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Baseline (don't regress beyond):** the documented full-suite known failures (see handoff) + the two tests this plan **intentionally updates** (`test_lims_analyses_state_machine.py` verify assertion, `test_vial_retest.py` `_walk_to_verified`). FE `tsc` baseline: the one known `WorksheetsInboxPage.tsx` `prev` error.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/lims_analyses/state_machine.py` | Add `promoted` state; drop `verify` from `TIER_VIAL`. |
| `backend/tests/test_lims_analyses_state_machine.py` | Update the stale vial-`verify` assertion; add promoted-state + verify-blocked assertions. |
| `backend/database.py` | Add `promoted` to the `review_state` CHECK (CREATE TABLE + idempotent migration) + backfill. |
| `backend/lims_analyses/service.py` | `promote_to_parent`: source `to_be_verified → promoted`; retest source-state guard `+ promoted`. |
| `backend/tests/test_vial_retest.py` | Replace `_walk_to_verified`→`_walk_to_promoted`; retest-from-promoted. |
| `backend/tests/test_promote_sets_source_promoted.py` (new) | promote moves source → `promoted`; vial `verify` blocked. |
| `src/components/senaite/AnalysisTable.tsx` | `promoted` badge style+label; `ALLOWED_TRANSITIONS.promoted`; done-count includes `promoted`. |

---

## Task 1: State machine — add `promoted`, remove sub-sample `verify`

**Files:**
- Modify: `backend/lims_analyses/state_machine.py`
- Test: `backend/tests/test_lims_analyses_state_machine.py`

- [ ] **Step 1: Update the stale test + add new assertions**

In `backend/tests/test_lims_analyses_state_machine.py`, find the assertion block (≈ lines 215-224) that currently reads:

```python
    assert allowed_kinds("to_be_verified", tier=TIER_VIAL) == {
        "verify", "retract", "reject",
    }
    assert allowed_kinds("to_be_verified", tier=TIER_PARENT) == {"retract"}
```

Replace it with (verify is no longer a vial-tier kind):

```python
    # Sub-sample (vial) tier no longer self-verifies — verification is the
    # promote act; the vial moves to_be_verified -> promoted. So 'verify' is
    # gone from the vial-tier kinds. parent-tier shares only retract here.
    assert allowed_kinds("to_be_verified", tier=TIER_VIAL) == {
        "retract", "reject",
    }
    assert allowed_kinds("to_be_verified", tier=TIER_PARENT) == {"retract"}
```

Add two new tests at the end of the file:

```python
def test_promoted_is_a_known_nonterminal_state():
    from lims_analyses.state_machine import STATES, is_terminal
    assert "promoted" in STATES
    assert is_terminal("promoted") is False


def test_verify_not_allowed_on_vial_tier():
    from lims_analyses.state_machine import (
        next_state, TIER_VIAL, TierMismatchError,
    )
    with pytest.raises(TierMismatchError):
        next_state("to_be_verified", "verify", tier=TIER_VIAL)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_state_machine.py -q"`
Expected: FAIL — `'promoted' in STATES` fails (state not added yet) and the vial-tier verify assertion still includes `verify`.

- [ ] **Step 3: Add `promoted` to STATES**

In `state_machine.py`, the `STATES` frozenset (≈ lines 64-72) currently lists the 7 states. Add `"promoted"`:

```python
STATES: FrozenSet[str] = frozenset({
    "unassigned",
    "assigned",
    "to_be_verified",
    "verified",
    "published",
    "promoted",
    "rejected",
    "retracted",
})
```

(`promoted` is intentionally NOT in `TERMINAL_STATES` — retest is legal from it, handled at the service layer.)

- [ ] **Step 4: Remove `verify` from the sub-sample tier matrix**

In `_TIER_ALLOWED_KINDS` (≈ lines 116-123), drop `"verify"` from `TIER_VIAL`:

```python
_TIER_ALLOWED_KINDS: Dict[str, FrozenSet[str]] = {
    TIER_VIAL: frozenset({
        "assign", "submit", "retract", "reject", "reset", "retest", "auto",
    }),
    TIER_PARENT: frozenset({
        "publish", "retract", "auto",
    }),
}
```

Also update the comment just above it (≈ lines 110-115) so it no longer describes a vial "verify in place" path — replace that paragraph with:

```python
# Tier × kind matrix. Sub-sample (vial) rows do bench work (assign through
# to_be_verified, plus retract/reject/reset/retest); they NEVER self-verify —
# verification is promotion (promote_to_parent moves the source to 'promoted').
# 'verify'/'publish' are parent-tier concerns; parent rows are created in
# 'verified' by promote and only publish or admin-retract from there.
```

(The `("to_be_verified","verify"):"verified"` edge in `_ALLOWED` and `verify` in `TRANSITION_KINDS` stay — they're harmless: with `verify` gone from `TIER_VIAL` and absent from `TIER_PARENT`, no tier permits it, so the edge is unreachable. Leaving them avoids touching the `transition_kind` CHECK and SENAITE-parity code.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_state_machine.py -q"`
Expected: PASS — all state-machine tests green (incl. the two new ones).

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/state_machine.py backend/tests/test_lims_analyses_state_machine.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(workflow): add sub-sample 'promoted' state; remove vial-tier verify

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: DB constraint (`promoted`) + idempotent migration + backfill

**Files:**
- Modify: `backend/database.py`

Verification is the migration running clean + a DB check (the data effects are covered by Task 3's service tests on a fresh DB).

- [ ] **Step 1: Add `promoted` to the CREATE TABLE CHECK (fresh DBs / tests)**

In `backend/database.py`, the `lims_analyses` CREATE TABLE has (≈ lines 505-509):

```python
            review_state          TEXT NOT NULL DEFAULT 'unassigned'
                                  CHECK (review_state IN (
                                      'unassigned', 'assigned', 'to_be_verified',
                                      'verified', 'published', 'rejected', 'retracted'
                                  )),
```

Change the CHECK list to include `'promoted'`:

```python
            review_state          TEXT NOT NULL DEFAULT 'unassigned'
                                  CHECK (review_state IN (
                                      'unassigned', 'assigned', 'to_be_verified',
                                      'verified', 'published', 'rejected', 'retracted',
                                      'promoted'
                                  )),
```

- [ ] **Step 2: Add the idempotent migration + backfill to `_run_migrations`**

In `_run_migrations()` (the list of ALTER statements starting ≈ line 132), append these entries to the migration list (order matters — drop, re-add with `promoted`, then backfill):

```python
        # Sub-sample 'promoted' workflow state. Re-create the review_state CHECK
        # to allow 'promoted', then backfill: sub-samples promoted under the old
        # model were left at 'to_be_verified'; defensively re-home any stray
        # vial-tier 'verified' rows (verification is now parent-only).
        "ALTER TABLE lims_analyses DROP CONSTRAINT IF EXISTS lims_analyses_review_state_check",
        """
        ALTER TABLE lims_analyses ADD CONSTRAINT lims_analyses_review_state_check
            CHECK (review_state IN (
                'unassigned','assigned','to_be_verified','verified',
                'published','rejected','retracted','promoted'
            ))
        """,
        """
        UPDATE lims_analyses SET review_state='promoted'
         WHERE lims_sub_sample_pk IS NOT NULL
           AND review_state='to_be_verified'
           AND id IN (SELECT source_analysis_id FROM lims_analysis_promotions)
        """,
        """
        UPDATE lims_analyses SET review_state='promoted'
         WHERE lims_sub_sample_pk IS NOT NULL
           AND review_state='verified'
           AND id IN (SELECT source_analysis_id FROM lims_analysis_promotions)
        """,
        """
        UPDATE lims_analyses SET review_state='to_be_verified'
         WHERE lims_sub_sample_pk IS NOT NULL
           AND review_state='verified'
           AND id NOT IN (SELECT source_analysis_id FROM lims_analysis_promotions)
        """,
```

(If `_run_migrations` executes each list entry in its own statement/transaction, these run in order. The auto-generated inline-CHECK constraint name on PostgreSQL is `lims_analyses_review_state_check`; the `DROP ... IF EXISTS` makes the re-create idempotent.)

- [ ] **Step 3: Apply the migration to the running dev DB + verify**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import database; database._run_migrations()'"`
Then verify the constraint accepts `promoted` and the backfill is consistent:
Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT review_state, count(*) FROM lims_analyses WHERE lims_sub_sample_pk IS NOT NULL GROUP BY review_state ORDER BY 1;"`
Expected: no error; some rows now in `promoted` (the previously-promoted sub-samples); zero sub-sample rows in `verified`.

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/database.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(workflow): allow 'promoted' review_state + backfill promoted sub-samples

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Service — promote moves source to `promoted`; retest from `promoted`

**Files:**
- Modify: `backend/lims_analyses/service.py`
- Test: `backend/tests/test_vial_retest.py`, `backend/tests/test_promote_sets_source_promoted.py` (new)

- [ ] **Step 1: Write the new promote-state test**

Create `backend/tests/test_promote_sets_source_promoted.py`. Mirror the fixtures/imports an existing promote test uses (read `backend/tests/test_promote_writeback_route.py` or the resolver tests for the exact `db`/`sub_sample`/`analysis_service` fixtures and the `promote_to_parent` signature). The test must assert: after promoting a `to_be_verified` sub-sample source, the **source row's `review_state` is `promoted`** and a parent-tier `verified` row was created. Skeleton (adapt fixture names to the file you copied from):

```python
import pytest
from lims_analyses import service
from lims_analyses.service import apply_transition, promote_to_parent


def _vial_to_tbv(db, sub_sample, analysis_service, result="42.0"):
    row = service.add_analysis_to_native_vial(
        db, sub_sample_pk=sub_sample.id, analysis_service_id=analysis_service.id,
    )
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=result,
                     reason="TEST: submit")
    return row


def test_promote_moves_source_to_promoted(db, sub_sample, analysis_service):
    src = _vial_to_tbv(db, sub_sample, analysis_service)
    assert src.review_state == "to_be_verified"
    promote_to_parent(
        db,
        keyword=src.keyword,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
        user_id=None,
    )
    db.refresh(src)
    assert src.review_state == "promoted"


def test_verify_blocked_on_vial(db, sub_sample, analysis_service):
    from lims_analyses.state_machine import TierMismatchError
    src = _vial_to_tbv(db, sub_sample, analysis_service)
    with pytest.raises(TierMismatchError):
        apply_transition(db, analysis_id=src.id, kind="verify", reason="TEST")
```

**Note for the implementer:** confirm the real `add_analysis_to_native_vial` / `apply_transition` / `promote_to_parent` signatures and required parent-context args against the source before finalizing — adjust the helper and the `promote_to_parent(...)` call to match (e.g. it may need a parent sample resolved from the sub-sample). If the existing promote tests use a different construction, copy theirs.

- [ ] **Step 2: Run to verify failure**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_promote_sets_source_promoted.py -q"`
Expected: `test_promote_moves_source_to_promoted` FAILS (source stays `to_be_verified`); `test_verify_blocked_on_vial` should already PASS (Task 1 removed verify from the vial tier).

- [ ] **Step 3: Make promote move the source to `promoted`**

In `service.py` `promote_to_parent`, the source audit loop (≈ lines 556-567) currently writes an `auto` audit row with `from_state==to_state` and does NOT change the source state:

```python
    for s in sources:
        sid = s["analysis_id"]
        kind = s["contribution_kind"]
        src = source_rows[sid]
        db.add(LimsAnalysisTransition(
            analysis_id=sid,
            from_state=src.review_state,
            to_state=src.review_state,
            transition_kind="auto",
            user_id=user_id,
            reason=f"promoted to parent #{parent_row.id} (kind={kind})",
        ))
```

Replace it with a version that transitions the source `to_be_verified → promoted`:

```python
    for s in sources:
        sid = s["analysis_id"]
        kind = s["contribution_kind"]
        src = source_rows[sid]
        prev_state = src.review_state
        src.review_state = "promoted"
        src.updated_at = now
        db.add(LimsAnalysisTransition(
            analysis_id=sid,
            from_state=prev_state,
            to_state="promoted",
            transition_kind="auto",
            user_id=user_id,
            reason=f"promoted to parent #{parent_row.id} (kind={kind})",
        ))
```

(The source-state guard at ≈ lines 447-451 already requires `to_be_verified`, so `prev_state` is always `to_be_verified` here. `kind='auto'` is kept deliberately — the `reason` documents it and we avoid extending the `transition_kind` CHECK.)

- [ ] **Step 4: Allow retest from `promoted`**

`service.py` has two retest source-state guards that currently allow `("to_be_verified", "verified")`. Add `"promoted"` to both (keep `"verified"` so parent-tier retest is unaffected):

- In `apply_transition`'s retest branch (≈ line 181):
```python
        if from_state not in ("to_be_verified", "verified", "promoted"):
```
- In the other retest path (≈ line 724):
```python
        if src.review_state not in ("to_be_verified", "verified", "promoted"):
```
Read both call sites first to confirm they are the retest source-state checks (they raise an "only … can be retested"-style error); adjust only those two tuples.

- [ ] **Step 5: Update the stale `test_vial_retest.py`**

`backend/tests/test_vial_retest.py` has `_walk_to_verified` (≈ lines 109-112) that drives a vial to `verified` via `apply_transition(kind="verify")` — which now raises `TierMismatchError`. Replace the helper and its uses:

Replace `_walk_to_verified` with `_walk_to_promoted` (walk to `to_be_verified`, then set `promoted` directly — this isolates the retest-from-promoted behavior without needing full promote machinery):

```python
def _walk_to_promoted(db, sub, svc, result="98.55"):
    """Create a fresh vial-tier row and put it in 'promoted' (post-promote)."""
    row = _walk_to_tbv(db, sub, svc, result=result)
    row.review_state = "promoted"
    db.commit()
    db.refresh(row)
    return row
```

Then update the tests that called `_walk_to_verified` (e.g. `test_retest_from_verified_creates_linked_row`, `test_retest_from_verified_does_not_change_old_row_state`, and any others — grep `_walk_to_verified` and `"verified"` in the file): rename them to `..._from_promoted`, call `_walk_to_promoted`, and change the asserted `old.review_state` / `old_state` expectations from `"verified"` to `"promoted"`. Also update the module docstring line that says "retest from verified works" → "retest from promoted works", and the regression line mentioning `verify` (the vial can no longer verify) — change "vial retract/reject/verify behavior unchanged" to "vial retract/reject behavior unchanged".

- [ ] **Step 6: Run the service tests**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_promote_sets_source_promoted.py tests/test_vial_retest.py -q"`
Expected: PASS — promote moves source to `promoted`; verify is blocked; retest-from-promoted works.

- [ ] **Step 7: Run the broader lims_analyses suite (regression)**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_state_machine.py tests/test_vial_retest.py tests/test_promote_sets_source_promoted.py -q"` plus any `test_promote_*`/`test_coa_*` files that touch promote — confirm green, or that any failure is a deliberately-updated stale expectation (fix those too). Investigate any genuine new failure before committing.

- [ ] **Step 8: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/service.py backend/tests/test_vial_retest.py backend/tests/test_promote_sets_source_promoted.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(workflow): promote moves source sub-sample to 'promoted'; retest from promoted

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: FE — `promoted` badge, transition, done-count

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx`

Verification is typecheck + manual smoke (the logic is backend-tested).

- [ ] **Step 1: Add the `promoted` badge style + label + row tint**

In `AnalysisTable.tsx`, add a `promoted` entry to `STATUS_COLORS` (≈ line 46, after `verified`) — a teal tone distinct from `verified` (emerald) and `to_be_verified` (orange):

```ts
  promoted:
    'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-400 dark:border-teal-500/20',
```

Add to `STATUS_LABELS` (≈ line 76):

```ts
  promoted: 'Promoted',
```

Add to `ROW_STATUS_STYLE` (≈ line 104, optional row tint to match):

```ts
  promoted:
    'border-l-2 border-l-teal-500 bg-teal-50/60 dark:bg-teal-500/[0.06]',
```

(`StatusBadge` at ≈ line 276 reads `STATUS_COLORS` + `STATUS_LABELS`, so it now renders "Promoted".)

- [ ] **Step 2: Allow retest from `promoted` in the row menu**

In `ALLOWED_TRANSITIONS` (≈ lines 129-135), add a `promoted` entry (keep the existing `verified: ['retest']` for parent rows):

```ts
  to_be_verified: ['retest', 'verify', 'retract', 'reject'],
  // A promoted sub-sample (its result rolled up to the parent) can be retested
  // to correct it (re-run, re-promote). verified stays for parent-tier rows.
  promoted: ['retest'],
  verified: ['retest'],
```

- [ ] **Step 3: Count `promoted` as done in the analysis filter/progress**

Two spots key on `verified`/`published` for the "done" bucket. Update both to include `promoted` (a `promoted` sub-sample is complete, not pending):

- ≈ line 1503:
```ts
    a => a.review_state === 'verified' || a.review_state === 'published' || a.review_state === 'promoted'
```
- ≈ line 1512:
```ts
      return a.review_state === 'verified' || a.review_state === 'published' || a.review_state === 'promoted'
```

(Parent views have no `promoted` rows, so this is a no-op there and correct on sub-sample views. The shared "Verified" tab label is left as-is; a per-view "Promoted" label is an optional follow-up — out of scope here.)

- [ ] **Step 4: Typecheck**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"`
Expected: only the known `WorksheetsInboxPage.tsx` baseline error.

- [ ] **Step 5: Manual smoke**

On `:5532`, open `P-0142-S01`, Promote the Endotoxin row (now `to_be_verified` with result 128). After Promote: the sub-sample's Endotoxin row shows a **"Promoted"** badge (teal), counts toward the "done" tab (not Pending), and its row menu offers **Retest** (not Verify). The result now appears on the parent `P-0142`. Hard-reload if HMR served stale modules.

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/senaite/AnalysisTable.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(workflow): 'Promoted' status badge + retest action + done-count on sub-sample analyses

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- New `promoted` sub-sample state → Task 1 (STATES) + Task 2 (CHECK) + Task 4 (badge). ✓
- Promote moves source `to_be_verified → promoted` → Task 3 Step 3. ✓
- `verify`/`published` parent-only; block sub-sample verify → Task 1 Step 4 (removes verify from `TIER_VIAL`; `TierMismatchError` enforces it — tested Task 1/Task 3). ✓
- Retest from `promoted` → Task 3 Step 4 (+ FE Task 4 Step 2). ✓
- Migration: backfill promoted sub-samples; defensive `verified` re-home → Task 2 Step 2. ✓
- FE badge + done-count → Task 4. ✓
- Type-agnostic (no new "vial" identifier) → `promoted`/all names generic. ✓
- Stale tests updated → Task 1 Step 1, Task 3 Step 5. ✓
- Out of scope honored (no admin un-promote, no type model, no per-view label) → none added. ✓

**Placeholder scan:** No TBD/TODO. The two "confirm signature/call sites against source" notes (Task 3 Step 1 fixtures, Step 4 guard lines) are explicit verification instructions with concrete targets, not placeholders — the implementer adapts to the real signatures, which is necessary because the exact `promote_to_parent` parent-context args weren't fully read at plan time.

**Type/name consistency:** `promoted` is the single state string used identically across state_machine STATES, the DB CHECK (both CREATE TABLE and migration), `service.py` (`src.review_state = "promoted"`, retest guards), the tests, and FE (`STATUS_COLORS`/`STATUS_LABELS`/`ALLOWED_TRANSITIONS`/done-count). `kind='auto'` retained for the promote audit (no `transition_kind` CHECK change). Task ordering (state machine → DDL → service → FE) ensures `promoted` is a valid DB state before any service test writes it.
