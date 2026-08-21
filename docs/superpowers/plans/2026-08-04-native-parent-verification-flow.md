# Native Parent Verification Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native promotion becomes submission (`parent_to_verify`); an explicit verify at the parent is the second sign-off; corrections flow through retest in both directions; everything is activity-logged — per the approved spec `docs/superpowers/specs/2026-08-04-native-parent-verification-flow-design.md`.

**Architecture:** All changes ride the hardcoded state machine (no workflow-catalog reads). One new review_state slug `parent_to_verify` threads through: state machine → promotion mint → verify via the existing generic transitions endpoint → retest guards (down-cascade) → a new dedicated vial-side retest route (up-cascade) → COA fail-closed alignment → activity events with service origin → a one-line shadow-engine mapping → FE badge/verb surfaces.

**Tech Stack:** FastAPI + SQLAlchemy, React 19 + TanStack Query, pytest, vitest.

## Global Constraints

- Base branch: `feat/native-parent-analyses-table` @ `f15c77d` (keeps the chain #91 → #93 → #94 → #95 → this linear). New branch: `feat/native-parent-verification`. Worktree: `C:\tmp\Accu-Mk1-parent-verify` = `/c/tmp/Accu-Mk1-parent-verify`.
- **Gate discipline (learned the hard way on PR #95):** backend gate = failure-set diff vs the baseline captured in Task 1, run with EXACTLY `"/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe"` and with NO `backend/.env` file in the worktree. Never bare `python`. Never create a `.env`. If the gate reddens, check those two conditions before anything else.
- **Spec-driven test updates are expected in Tasks 3-4:** existing tests that pin "promote mints `verified`" (e.g. in `backend/tests/test_lims_analyses_service.py`, `test_parent_retest_cascade.py`, `test_native_parent_analyses_endpoint.py`, `test_parent_retest_route.py` fixtures) now pin superseded behavior. Each task lists its expected-changed test set; updating those is the spec talking, not "test is stale" doctrine. Any OTHER failure-set delta is a regression.
- Mk1 FE is npm only; NEVER `npm run check:all` in the worktree — gates are `npx tsc --noEmit` + targeted `npx vitest run <files>`.
- Additive only: no workflow-catalog/seed changes (except the §7 engine mapping); no SENAITE writes; published parent rows never mutated; default AnalysisTable behavior byte-identical unless a new optional prop is passed; existing `verified` rows grandfathered (no backfill).
- The review_state CHECK is the known-stale one — Task 2 ADDS the value through the existing idempotent boot-DDL idiom; do not tighten or "fix" the list otherwise.
- Stage files by name. Never commit `.claude/settings.local.json` or anything under `.superpowers/`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/lims_analyses/state_machine.py` | Modify | `parent_to_verify` in `_ALLOWED`, `_TIER_ALLOWED_KINDS[TIER_PARENT] += verify`, `tier_of` branch |
| `backend/lims_analyses/schemas.py` | Modify | `ReviewState` literal + `SenaiteShapeAnalysisResponse.service_origin` |
| `backend/database.py` | Modify | review_state CHECK gains the slug; `lims_sub_sample_events.lims_sample_pk` DDL |
| `backend/lims_analyses/service.py` | Modify | promote mint + supersession; cascade/parent-retest guards; new `vial_source_retest`; serializer origin field; verify-event write |
| `backend/lims_analyses/routes.py` | Modify | new `POST /{analysis_id}/source-retest`; events on verify/parent-retest |
| `backend/models.py` | Modify | `LimsSubSampleEvent.lims_sample_pk` (nullable) + `sub_sample_pk` → nullable |
| `backend/sub_samples/…` (family activity read, ~routes.py:619) | Modify | fan-out includes parent-hosted events |
| `backend/coa/source_resolver.py` | Modify | parent-tier resolution → verified/published only; docstring fix |
| `backend/workflow/engine.py` | Modify | `_live_parent_line_states` maps `parent_to_verify` → `to_be_verified` |
| `src/components/senaite/AnalysisTable.tsx` | Modify | state maps/badge; parent-native verify verb; `onPromotedNativeRetest` seam |
| `src/components/senaite/senaite-utils.tsx` | Modify | badge entry for `parent_to_verify` |
| `src/components/senaite/SampleDetails.tsx` | Modify | card: verify wiring + `onTransitionComplete`; sub-sample section: promoted-native retest modal |
| `src/components/senaite/PromotedSourceRetestDialog.tsx` | Create | up-cascade warning modal |
| `src/lib/api.ts` | Modify | `vialSourceRetest` fn; `SenaiteAnalysis.service_origin` |
| Backend tests: `test_state_machine_parent_verify.py` (new), extensions to `test_lims_analyses_routes.py`, `test_parent_retest_route.py`, `test_source_retest_route.py` (new), `test_native_sections*/test_source_resolver*`, `test_activity_family_fanout.py`, `test_workflow_engine*` | Create/Modify | per-task sections below |
| FE tests: `analysis-table-verb-policy.test.tsx`, `native-parent-analyses.test.tsx` (extend), `promoted-source-retest.test.tsx` (new) | Create/Modify | per-task sections below |

---

### Task 1: Worktree + baselines

**Files:** none in-repo.

**Interfaces:**
- Produces: worktree `/c/tmp/Accu-Mk1-parent-verify` on `feat/native-parent-verification` @ base `f15c77d`; baseline `/c/tmp/Accu-Mk1-parent-verify/.superpowers/sdd/2026-08-04-parent-verification/baseline-failures.txt`.

- [ ] **Step 1:** `git -C /c/tmp/Accu-Mk1-parent-table worktree add -b feat/native-parent-verification /c/tmp/Accu-Mk1-parent-verify f15c77d` then verify head + branch.
- [ ] **Step 2:** Confirm NO `backend/.env` exists in the new worktree (`ls /c/tmp/Accu-Mk1-parent-verify/backend/.env` → not found). Then capture the baseline:

```bash
mkdir -p /c/tmp/Accu-Mk1-parent-verify/.superpowers/sdd/2026-08-04-parent-verification
cd /c/tmp/Accu-Mk1-parent-verify/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > ../.superpowers/sdd/2026-08-04-parent-verification/baseline-failures.txt
wc -l ../.superpowers/sdd/2026-08-04-parent-verification/baseline-failures.txt
```

Expected ≈64 lines. Do not commit.
- [ ] **Step 3:** `cd /c/tmp/Accu-Mk1-parent-verify && npx tsc --noEmit` — expect exit 0.

---

### Task 2: State machine + schema + CHECK

**Files:**
- Modify: `backend/lims_analyses/state_machine.py` (`_ALLOWED` ~102-129, `_TIER_ALLOWED_KINDS` ~136-144, `tier_of` ~184-211)
- Modify: `backend/lims_analyses/schemas.py:55` (`ReviewState`)
- Modify: `backend/database.py` (review_state CHECK ~1093-1100 idiom)
- Test: `backend/tests/test_state_machine_parent_verify.py` (new)

**Interfaces:**
- Produces (all later tasks): state slug `"parent_to_verify"`; `tier_of(parent-hosted, parent_to_verify) == TIER_PARENT`; legal kinds at TIER_PARENT = `{publish, retract, auto, verify}`; `next_state("parent_to_verify","verify")=="verified"`, `("parent_to_verify","retract")=="retracted"`, `("parent_to_verify","auto")=="parent_to_verify"`; retest-eligibility sets that admit parent states now include `parent_to_verify` (`apply_transition` gate service.py:281-285 — edited HERE so Task 4's guards compose).

- [ ] **Step 1: Failing tests** — `backend/tests/test_state_machine_parent_verify.py`:

```python
"""parent_to_verify: the native second-sign-off state (spec 2026-08-04)."""
import pytest
from lims_analyses.state_machine import (
    TIER_PARENT, TIER_VIAL, TierMismatchError, next_state, tier_of,
)


def test_parent_hosted_parent_to_verify_is_parent_tier():
    assert tier_of(lims_sample_pk=1, lims_sub_sample_pk=None,
                   review_state="parent_to_verify") == TIER_PARENT


def test_parent_hosted_to_be_verified_stays_vial_tier():
    """The variance parent-acting-as-vial shape is untouched."""
    assert tier_of(lims_sample_pk=1, lims_sub_sample_pk=None,
                   review_state="to_be_verified") == TIER_VIAL


def test_verify_legal_at_parent_tier_from_parent_to_verify():
    assert next_state("parent_to_verify", "verify", tier=TIER_PARENT) == "verified"


def test_retract_and_auto_from_parent_to_verify():
    assert next_state("parent_to_verify", "retract", tier=TIER_PARENT) == "retracted"
    assert next_state("parent_to_verify", "auto", tier=TIER_PARENT) == "parent_to_verify"


def test_verify_still_blocked_at_vial_tier():
    with pytest.raises(TierMismatchError):
        next_state("to_be_verified", "verify", tier=TIER_VIAL)


@pytest.mark.parametrize("kind", ["submit", "retest", "reject", "assign", "variance_verify"])
def test_other_kinds_blocked_at_parent_tier_from_parent_to_verify(kind):
    with pytest.raises(Exception):
        next_state("parent_to_verify", kind, tier=TIER_PARENT)
```

- [ ] **Step 2:** Run → FAIL (unknown state / TierMismatch on verify).
- [ ] **Step 3: Implement.** In `state_machine.py`: add the three `_ALLOWED` entries; add `"verify"` to `_TIER_ALLOWED_KINDS[TIER_PARENT]` and update its comment block (verification is now a real parent verb — promotion mints `parent_to_verify`); in `tier_of`, change the membership to `("parent_to_verify", "verified", "published", "retracted")` and extend the docstring's Parent-tier sentence. Register the state wherever the module enumerates known states (`_ALLOWED` keys drive `UnknownStateError` — verify by reading `known states` handling ~90-100). In `schemas.py:55` add `"parent_to_verify"` to `ReviewState`. In `service.py:281-285` (retest gate) add `"parent_to_verify"` to the from-state tuple. In `database.py`, extend the review_state CHECK value list via the existing idempotent drop/recreate idiom used by the sibling CHECK updates (read the surrounding `migration_skipped` pattern first; ADD the value only).
- [ ] **Step 4:** Run the new file + `tests/test_lims_analyses_state_machine.py` → PASS.
- [ ] **Step 5:** Failure-set gate (Task 1 baseline) → empty diff expected (nothing mints the state yet).
- [ ] **Step 6:** Commit: `git add backend/lims_analyses/state_machine.py backend/lims_analyses/schemas.py backend/lims_analyses/service.py backend/database.py backend/tests/test_state_machine_parent_verify.py && git commit -m "feat(parent-verify): parent_to_verify state — verify becomes a real parent-tier verb"`

---

### Task 3: Promotion mints `parent_to_verify`; verify via the generic endpoint

**Files:**
- Modify: `backend/lims_analyses/service.py` (`promote_to_parent` mint ~798-823; supersession ~756-796)
- Modify: `backend/lims_analyses/routes.py` (published-supersede 409 message)
- Test: extend `backend/tests/test_lims_analyses_routes.py`; expected-changed set below.

**Interfaces:**
- Consumes: Task 2 slug + legality.
- Produces: promoted canonical parent rows carry `review_state="parent_to_verify"`, `verified_at=None`; `POST /api/lims-analyses/{id}/transitions {"kind":"verify"}` on such a row → 200, `review_state="verified"`, `verified_at` stamped, transition row `user_id` = verifier; supersession retires old parents in (`verified`, `parent_to_verify`); published old parent → 409 whose detail message contains `"COA-snapshot release"`.

**Expected-changed tests (spec-driven, update them):** any test asserting promote yields `review_state == "verified"` or `verified_at is not None` on the parent row — sweep `grep -rn "promote" backend/tests | grep -il verified` and fix each to the new contract (most add one verify call where the OLD flow's post-state is needed). `test_parent_retest_route.py` fixtures that build verified parents via promote must add the verify step.

- [ ] **Step 1: Failing tests** (append to `test_lims_analyses_routes.py`, reusing its fixtures):

```python
def test_promote_mints_parent_to_verify(...):
    """Promotion is submission, not sign-off (spec 2026-08-04)."""
    # promote via POST /api/lims-analyses/promote (existing fixture idiom)
    assert parent_row.review_state == "parent_to_verify"
    assert parent_row.verified_at is None
    # from-None transition row says to_state='parent_to_verify'


def test_parent_verify_via_generic_endpoint(...):
    r = client.post(f"/api/lims-analyses/{parent_id}/transitions", json={"kind": "verify"})
    assert r.status_code == 200
    assert r.json()["review_state"] == "verified"
    # DB: verified_at stamped; transition row user_id == verifier


def test_verify_on_vial_row_still_409(...):
    """Pin: verify stays illegal at the vial tier."""
    r = client.post(f"/api/lims-analyses/{vial_row_id}/transitions", json={"kind": "verify"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "tier_mismatch"


def test_repromote_supersedes_parent_to_verify(...):
    """Retest + re-promote over an awaiting parent retires it (retracted), new row takes the slot."""


def test_repromote_over_published_409_names_deferral(...):
    r = ...  # promote at a keyword whose active parent is published
    assert r.status_code == 409
    assert "COA-snapshot release" in str(r.json()["detail"])
```

- [ ] **Step 2:** Run → new tests FAIL (promote still mints verified).
- [ ] **Step 3: Implement.** In `promote_to_parent`: mint block sets `review_state="parent_to_verify"` and drops `verified_at=now` (keep `analyst_user_id=user_id`); from-None transition row `to_state="parent_to_verify"`; update the docstring contract lines (:586-591). Supersession (:756-796): the `== "verified"` old-parent match (:772) becomes `in ("verified", "parent_to_verify")`. The published-collision 409 (surface it where the IntegrityError/citable-COA guard translates — routes/service): message gains `"published parent — supersede/republish ships with the COA-snapshot release"`. `apply_transition`'s verify branch needs no edit (Task 2 made it reachable; it already requires `result_value` and stamps `verified_at` at :385-386).
- [ ] **Step 4:** Update the expected-changed test set (list each file touched + why in the report).
- [ ] **Step 5:** Run the route file + service tests → PASS. Failure-set gate → diff must contain ONLY the expected-changed set (report it verbatim), which after your updates means EMPTY.
- [ ] **Step 6:** Commit: `feat(parent-verify): promotion mints parent_to_verify; verify is the second sign-off`

---

### Task 4: Down-cascade guards accept `parent_to_verify`

**Files:**
- Modify: `backend/lims_analyses/service.py` — `parent_retest` guard (~1442-1451) and cascade step-5 un-promote (~1380)
- Test: extend `backend/tests/test_parent_retest_route.py` + `test_parent_retest_cascade.py`

**Interfaces:**
- Consumes: Tasks 2-3.
- Produces: `POST /api/lims-analyses/parent/{sample_id}/retest` legal when the active parent row is `verified` OR `parent_to_verify`; the cascade's un-promote fires for both (retract + clear + transition row, reason unchanged).

- [ ] **Step 1: Failing tests:** `test_parent_retest_on_awaiting_parent_unpromotes` (parent in `parent_to_verify` + promoted sources → 200, sources retested, parent `retracted`, result cleared) and a cascade service-level twin.
- [ ] **Step 2:** Run → FAIL (guard 409s / step-5 skips).
- [ ] **Step 3: Implement.** Guard: `if active.review_state not in ("verified", "parent_to_verify"):` (message updated to name both). Cascade step-5: `if new_row_ids and parent_analysis.review_state in ("verified", "parent_to_verify"):` (comment updated — an awaiting row's stale value must not linger either).
- [ ] **Step 4:** Run both files + gate → PASS / empty diff.
- [ ] **Step 5:** Commit: `feat(parent-verify): parent retest cascades from awaiting rows too`

---

### Task 5: Vial-side retest route (up-cascade) + `service_origin` on the wire

**Files:**
- Modify: `backend/lims_analyses/service.py` (new `vial_source_retest`; `_serialize_senaite_shape_rows` gains `service_origin`)
- Modify: `backend/lims_analyses/schemas.py` (`SenaiteShapeAnalysisResponse.service_origin: Optional[str]`; `SourceRetestResponse`)
- Modify: `backend/lims_analyses/routes.py` (new route)
- Test: `backend/tests/test_source_retest_route.py` (new)

**Interfaces:**
- Consumes: promotion records, `apply_transition(kind="retest")`, Task 2 legality.
- Produces: `POST /api/lims-analyses/{analysis_id}/source-retest` (body `{"reason"?: str}`) → `{"new_row_id": int, "parent_unverified": bool, "parent_review_state": str|null}`. Semantics: `analysis_id` must be a vial-hosted row with `review_state=="promoted"` on an `origin=="mk1"` service (else 400/409 per table below); retests it via `apply_transition`; resolves its promotion's parent row; parent in (`verified`,`parent_to_verify`) → retract + clear + transition row reason `"un-promoted: source retested from vial"`; parent `published` → untouched, `parent_unverified=false`. One transaction. Serializer: every senaite-shape row now carries `service_origin` (`"mk1"`/`"senaite"` from `AnalysisService.origin`, resolved in the existing bulk-load — no per-row query).

Error table: unknown id → 404; row not vial-hosted or not `promoted` → 409 `invalid_transition`; service not mk1-origin → 400 `BadRequestError` ("SENAITE-origin rows retest from the parent AR — sub-side retest dead-ends on the write-back").

- [ ] **Step 1: Failing tests** — new file, fixtures modeled on `test_parent_retest_route.py`:

```python
def test_source_retest_unverifies_verified_parent(...):
    # promoted mk1 source + verified parent → 200
    assert body["parent_unverified"] is True and body["parent_review_state"] == "retracted"
    # DB: source retested=True + new retest row; parent retracted, result cleared

def test_source_retest_unverifies_awaiting_parent(...):     # parent_to_verify → same
def test_source_retest_published_parent_untouched(...):
    assert body["parent_unverified"] is False
    # DB: parent still published, result intact
def test_source_retest_senaite_origin_400(...):
def test_source_retest_not_promoted_409(...):
def test_senaite_shape_rows_carry_service_origin(...):      # both reads, both values
```

- [ ] **Step 2:** RED. **Step 3:** Implement per the interface (service fn mirrors `parent_retest`'s shape: resolve → guard → act → re-read; route mirrors the parent-retest route incl. `_handle_service_error`). **Step 4:** GREEN + gate empty. **Step 5:** Commit: `feat(parent-verify): vial-side source retest with upward un-promote + service_origin on the wire`

---

### Task 6: COA alignment (fail-closed everywhere)

**Files:**
- Modify: `backend/coa/source_resolver.py` (`_LIVE_RESULT_STATES` usage in `_resolve_mk1_parent_tier` ~244-280 + its docstring)
- Test: extend the source_resolver/native_sections test files (locate via `grep -rl "_resolve_mk1_parent_tier\|native_sections" backend/tests`)

**Interfaces:**
- Produces: parent-tier COA resolution accepts ONLY (`verified`, `published`) — a module constant `_PARENT_RESULT_STATES = ("verified", "published")` passed by `_resolve_mk1_parent_tier`; vial-tier resolution keeps `_LIVE_RESULT_STATES` untouched.

- [ ] **Step 1: Failing tests:** parent row in `to_be_verified` → not resolved (pin the divergence fix); parent row in `parent_to_verify` → not resolved; `verified` still resolves; a native_sections pin that `parent_to_verify` aborts generation (extend the existing eligible-states test).
- [ ] **Step 2-4:** RED → implement (docstring now matches code) → GREEN + gate empty.
- [ ] **Step 5:** Commit: `fix(coa): parent-tier source resolution is verified/published only — fail closed`

---

### Task 7: Activity events with parent host + service origin

**Files:**
- Modify: `backend/models.py` (`LimsSubSampleEvent`: `sub_sample_pk` → nullable, new nullable `lims_sample_pk` FK)
- Modify: `backend/database.py` (additive DDL: column + one-host CHECK `(sub_sample_pk IS NULL) <> (lims_sample_pk IS NULL)`)
- Modify: `backend/lims_analyses/service.py` / `routes.py` — event writes
- Modify: the family activity read (`backend/sub_samples/routes.py` ~619 area + its service) to include parent-hosted events
- Test: extend `backend/tests/test_activity_family_fanout.py` + route tests

**Interfaces:**
- Produces events (written in the same transaction as their act, `details` includes `service_origin`):
  - parent verify (in `apply_transition`, gated `kind=="verify" and row_tier==TIER_PARENT`): `event="parent_analysis_verified"`, `details={"keyword", "analysis_id", "service_origin"}`, host `lims_sample_pk`.
  - parent retest route: `event="parent_analysis_retested"`, `details={"keyword", "source_row_ids", "unpromoted": bool, "service_origin"}`, host `lims_sample_pk`.
  - source retest route: `event="promoted_source_retested"`, `details={"keyword", "new_row_id", "parent_state_before", "parent_unverified": bool, "service_origin"}`, host `sub_sample_pk` (the vial).
- Family fan-out returns parent-hosted events alongside vial events, newest first (existing contract).

- [ ] **Step 1: Failing tests:** each event asserted at DB level after its route fires (extend Tasks 3-5's route test files with event assertions is acceptable — keep them in THIS task's commits); fan-out test: seed one parent-hosted + one vial-hosted event → both returned ordered.
- [ ] **Step 2-4:** RED → implement (model + DDL idiom copied from the sibling two-host pattern on `lims_analyses`; read the existing fan-out query and extend its WHERE to `sub_sample_pk IN (family vials) OR lims_sample_pk == parent.id`) → GREEN + gate empty.
- [ ] **Step 5:** Commit: `feat(parent-verify): activity events for verify/retest with senaite-vs-mk1 origin, parent-hosted`

---

### Task 8: Shadow-engine containment

**Files:**
- Modify: `backend/workflow/engine.py` (`_live_parent_line_states` ~38-61)
- Test: extend the engine's test file (locate via `grep -rl "_live_parent_line_states\|all_analyses_in_state" backend/tests`)

**Interfaces:**
- Produces: the collapsed per-keyword state map reports `parent_to_verify` as `"to_be_verified"` (one mapping line + comment: keeps the seeded `all_analyses_in_state` value lists and the flip-readiness report meaningful without catalog data edits — catalog modeling ships with the catalog release).

- [ ] **Step 1: Failing test:** sample with one canonical parent line in `parent_to_verify` → `_live_parent_line_states` yields `to_be_verified` for that keyword; the seeded sample `submit` edge's requirement (`"to_be_verified,verified,published"`) evaluates met.
- [ ] **Step 2-4:** RED → one-line mapping → GREEN + gate empty.
- [ ] **Step 5:** Commit: `feat(parent-verify): shadow engine reads parent_to_verify as to_be_verified`

---

### Task 9: FE — card verify verb, badges, bulk

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx` (state-label map ~:88, `StatusBadge` ~:413 if state-keyed styling lives there, `visibleRowTransitionsForPolicy` ~:299, `deriveBulkActionsForPolicy` ~:315, row-menu branch ~:1511, bulk toolbar branch ~:1972)
- Modify: `src/components/senaite/senaite-utils.tsx:11` map
- Modify: `src/components/senaite/SampleDetails.tsx` — card instance
- Modify: `src/lib/api.ts` — `SenaiteAnalysis.service_origin?: string | null`
- Test: extend `src/test/analysis-table-verb-policy.test.tsx` + `src/test/native-parent-analyses.test.tsx`

**Interfaces:**
- Consumes: Task 5's `service_origin` field (type only here), existing `useAnalysisTransition`.
- Produces: `parent_to_verify` renders badge "To Verify" (orange styling, same as the SENAITE to-verify class in senaite-utils); parent-native policy: `parent_to_verify` → `['verify', 'retest']`, verified → `['retest']` (unchanged), others `[]`; the Verify menu item routes through `transition.executeTransition(uid, 'verify')` (the generic endpoint is now legal — retest keeps `onParentRetest`); bulk: all-`parent_to_verify` selection → `['verify']` executing `bulk.executeBulk(uids, 'verify')`, all-verified → `['retest']` via `onParentBulkRetest`, mixed → `[]`; the card's `AnalysisTable` gains `onTransitionComplete` wiring: `() => { void queryClient.invalidateQueries({queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY]}); onParentDataStale?.() }`.

Policy fn shape (extend, keep default-mode delegation untouched — the mutation pins from PR #95 must stay green):

```ts
  if (policy === 'parent-native') {
    if (!a.uid) return []
    if (a.review_state === 'parent_to_verify') return ['verify', 'retest']
    return a.review_state === 'verified' ? ['retest'] : []
  }
```

Row-menu branch: `verify` in parent-native mode goes to `void transition.executeTransition(analysis.uid, 'verify')`; `retest` keeps `onParentRetest?.(analysis)`.

- [ ] **Step 1: Failing tests:** policy units (awaiting → verify+retest; verified → retest; delegation pins still pass); render test: awaiting row menu shows Verify + Retest, clicking Verify calls the mocked `transitionAnalysis(uid,'verify')` and NOT `onParentRetest`; badge text "To Verify" in the card; bulk: two awaiting rows selected → "Verify selected" fires `transitionAnalysis` per uid; card test: verify completion invalidates + calls `onParentDataStale`.
- [ ] **Step 2-4:** RED → implement → GREEN; run the FULL PR-#95 FE test set (`native-parent-analyses`, `analysis-table-verb-policy`, `parent-retest-confirm-dialog`, `native-parent-analyses-lib`) + `npx tsc --noEmit`.
- [ ] **Step 5:** Commit: `feat(parent-verify): card offers Verify on awaiting rows; To Verify badge; bulk verify`

---

### Task 10: FE — promoted-source retest seam + warning modal

**Files:**
- Create: `src/components/senaite/PromotedSourceRetestDialog.tsx`
- Modify: `src/components/senaite/AnalysisTable.tsx` (new optional prop `onPromotedNativeRetest?: (analysis: SenaiteAnalysis) => void`)
- Modify: `src/components/senaite/SampleDetails.tsx` (enable on the sub-sample instance; handler + dialog)
- Modify: `src/lib/api.ts` (`vialSourceRetest(analysisId, reason?)`)
- Test: `src/test/promoted-source-retest.test.tsx` (new)

**Interfaces:**
- Consumes: Task 5 route + `service_origin`; `listNativeParentAnalysesShaped` (parent-state lookup for modal copy); `parentSampleId` derivation in SampleDetails.
- Produces:
  - `vialSourceRetest(analysisId: number, reason?: string): Promise<{new_row_id: number, parent_unverified: boolean, parent_review_state: string | null}>` POSTing `/api/lims-analyses/{analysisId}/source-retest`.
  - AnalysisTable: when `onPromotedNativeRetest` is provided AND a row has `review_state==='promoted'` AND `uid?.startsWith('mk1:')` AND `service_origin === 'mk1'`, the row menu shows exactly `['retest']` routed to the callback. Prop omitted (all existing surfaces) → `promoted: []` byte-identical. Default-policy internals untouched otherwise.
  - `PromotedSourceRetestDialog({state, pending, onCancel, onConfirm})` with `state: {title: string, parentSampleId: string, parentState: string | null} | null` — copy per spec §4: parent `verified`/`parent_to_verify` → "Retesting this promoted result will un-verify the parent value on {parentSampleId} — it returns to awaiting re-promotion."; parent `published` → "The published parent value and its COA are NOT touched. The re-run's new value cannot be re-promoted until the COA-snapshot release."; unknown/null parent state → fail-closed explanatory copy + disabled confirm (same pattern as ParentRetestConfirmDialog). Radix `preventDefault` + pending guards copied from `ParentRetestConfirmDialog.tsx` (the PR #95 lessons).
  - SampleDetails sub-sample instance (`parentSampleId !== null`) passes `onPromotedNativeRetest`; handler: fetch `listNativeParentAnalysesShaped(parentSampleId)`, find the newest row for the keyword → `parentState`; open dialog; confirm → `vialSourceRetest(parseInt(uid.slice(4)))` → toast (named per `parent_unverified`) → `refreshSample(sampleId)`.

- [ ] **Step 1: Failing tests:** seam gating (promoted+mk1+origin-mk1+prop → Retest; any leg missing → no verb; prop omitted → no verb — the PR #95 regression pins must stay green); dialog copy per parent state incl. fail-closed null; confirm flow fires `vialSourceRetest` and refresh; cancel doesn't.
- [ ] **Step 2-4:** RED → implement → GREEN; full FE sweep (`npx vitest run` on all six touched/new FE test files) + `npx tsc --noEmit`.
- [ ] **Step 5:** Commit: `feat(parent-verify): native promoted rows retest from the vial with an un-verify warning`

---

### Task 11: Full verification sweep + push + PR

- [ ] **Step 1:** Backend failure-set gate (spec venv, no `.env`) → empty diff vs Task 1 baseline.
- [ ] **Step 2:** `npx tsc --noEmit` → no new errors.
- [ ] **Step 3:** Full targeted vitest: the six FE files from Tasks 9-10 + every file from the PR #95 sweep list (grep idiom from that plan) → all pass.
- [ ] **Step 4:** Push `feat/native-parent-verification`; `gh pr create --base feat/native-parent-analyses-table` — title `feat: native parent verification flow — promotion submits, verify signs off`; body: spec link, Handler rulings (incl. the published-deferral + catalog-release deferral), expected-changed test list from Task 3, UAT items (verify click on s3rehe P-0141 after re-promote; badge; vial-side retest modal both parent states; activity feed entries), chain note `#91→#93→#94→#95→this`, no deploy until the combined window. Footer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 5:** Report: PR number, gate evidence, deferred items.

## Self-Review (completed at write time)

- **Spec coverage:** §1→T2 · §2→T3 · §3→T6 · §4 down→T4, up→T5+T10 · §5→T9+T10 · §6→T7 · §7→T8 · deferrals→T3's 409 message + T11 PR body · testing section→per-task tests + T11 sweep. No spec requirement without a task.
- **Placeholder scan:** fixture-dependent test bodies are marked with explicit "reusing its fixtures" instructions and named model files — same convention the PR #95 plan used successfully; no TBDs.
- **Type consistency:** `parent_to_verify` slug string identical everywhere; `SourceRetestResponse` field names (`new_row_id`, `parent_unverified`, `parent_review_state`) match FE `vialSourceRetest` return type; event names/details match between T7 table and route tasks; `service_origin` values `"mk1"|"senaite"` consistent across serializer, FE type, and seam gate.
