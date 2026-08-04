# Native Parent Analyses Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only body of `NativeParentAnalysesCard` with the shared `AnalysisTable`, restricted to the parent-legal verb set (verified → retest via the promote cascade), per the approved spec `docs/superpowers/specs/2026-08-04-native-parent-analyses-table-design.md`.

**Architecture:** Backend grows a `?as=senaite_shape` projection on the existing native-parent-analyses read (reusing the shared `_serialize_senaite_shape_rows` helper, so field mapping cannot drift from the sub-sample section) and a dedicated `POST /api/lims-analyses/parent/{sample_id}/retest` route that fronts the existing, tested `cascade_parent_retest_to_sources`. The frontend adds an additive `verbPolicy` prop to `AnalysisTable` ("parent-native" = retest-only, routed through callbacks so the card owns the destructive confirm), and the card swaps its body for the table using the fold-the-header pattern from `VialsQuickLookDialog`.

**Tech Stack:** FastAPI + SQLAlchemy (Mk1 backend), React 19 + TanStack Query + shadcn/ui (Mk1 frontend), pytest, vitest.

## Spec corrections discovered during recon (authoritative for this plan)

The spec's *behavior* (Handler ruling) is unchanged; three *mechanisms* it assumed are corrected here after code verification on the base branch:

1. **Retest cannot go through the generic transition endpoint.** `state_machine._TIER_ALLOWED_KINDS[TIER_PARENT]` is `{publish, retract, auto}`; `apply_transition(kind="retest")` on a verified parent row raises `TierMismatchError` → 409, and `apply_transition` never calls the cascade (its only caller is the SENAITE proxy in `main.py:15299`). → We add a dedicated additive route that calls the cascade. The state machine is NOT touched.
2. **No FE adapter function is needed.** The sub-sample section's "adapter" is a server-side `senaite_shape` projection; we extend the same shared serializer to the native parent read. Cross-surface parity is by construction.
3. **The page's `analysisSlaMap` cannot serve the card.** `useAnalysisSlaMap` keys off `lookup.analyses` (the SENAITE rows); native keywords are absent. The card computes its own map from a synthetic lookup (`{...lookup, analyses: nativeRows}`) — the exact `VialsQuickLookDialog.tsx:275-279` pattern.

Open questions resolved: **remarks — deferred** (`lims_analyses` has no remarks column; spec said defer if absent). **PR #41 un-promote — out of scope** (no un-promote endpoint exists on the base branch; grepped `backend/` and `src/`, case-insensitive).

## Global Constraints

- Base branch: `feat/s2s-catalog-keys` @ `838ebec`. New branch: `feat/native-parent-analyses-table`. Worktree: `C:\tmp\Accu-Mk1-parent-table` (Windows) = `/c/tmp/Accu-Mk1-parent-table` (bash).
- Additive only: no edits to `backend/lims_analyses/state_machine.py` tier/transition tables; no SENAITE writes; existing endpoints' default responses unchanged; `AnalysisTable` default behavior byte-identical when `verbPolicy` is omitted; the main SENAITE-sourced Analyses table instance is untouched.
- Mk1 FE is **npm only**. In the worktree **NEVER run `npm run check:all`** — FE gates are `npx tsc --noEmit` + targeted `npx vitest run <files>`.
- Backend gate is a **failure-set diff vs the baseline captured in Task 1** (empty diff = green; the tree has ~64 pre-existing failures). Never expect zero failures.
- Backend python for all pytest runs: `"/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe"`.
- Stage files **by name** only. Never commit `.claude/settings.local.json`. Commit per task with conventional-commit messages.
- GitNexus is not indexed in worktrees — skip `gitnexus_impact`/`gitnexus_detect_changes` there (documented gotcha); the blast-radius evidence for the touched symbols is in this plan's recon notes.
- No result entry, submit, verify, variance verbs, reject, cancel, or Manage Analyses on the card — display-only except verified → retest.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/lims_analyses/service.py` | Modify | `list_native_parent_analyses_senaite_shape` (new), `parent_retest` (new), `cascade_parent_retest_to_sources` gains optional `source_reason` kwarg (default preserves behavior) |
| `backend/lims_analyses/routes.py` | Modify | `?as=` dispatch on the native-analyses GET; new `POST /parent/{sample_id}/retest` |
| `backend/lims_analyses/schemas.py` | Modify | `ParentRetestRequest`, `ParentRetestResponse` |
| `backend/tests/test_native_parent_analyses_endpoint.py` | Modify | senaite_shape read tests + default-shape back-compat pin |
| `backend/tests/test_parent_retest_route.py` | Create | route-level cascade tests + tier_mismatch pin on the generic endpoint |
| `src/lib/api.ts` | Modify | `listNativeParentAnalysesShaped`, `parentRetestAnalysis` |
| `src/lib/native-parent-analyses.ts` | Create | hoisted query key + pure confirm-impact helpers |
| `src/components/senaite/AnalysisTable.tsx` | Modify | `verbPolicy` prop + `onParentRetest`/`onParentBulkRetest`; wire the dormant `EditableSelectCell.readOnly`; policy-aware bulk toolbar |
| `src/components/senaite/ParentRetestConfirmDialog.tsx` | Create | destructive confirm naming the source blast radius |
| `src/components/senaite/SampleDetails.tsx` | Modify | card body swap, call-site props, `refreshSample` invalidation |
| `src/test/native-parent-analyses-lib.test.ts` | Create | impact-helper unit tests |
| `src/test/analysis-table-verb-policy.test.tsx` | Create | policy fn units + parent-native render gating |
| `src/test/parent-retest-confirm-dialog.test.tsx` | Create | dialog copy + fail-closed disable |
| `src/test/native-parent-analyses.test.tsx` | Modify | card renders table, verbs gated, retest flow end-to-end |

---

### Task 1: Worktree + backend baseline

**Files:** none in-repo (worktree creation + baseline artifact)

**Interfaces:**
- Produces: worktree at `/c/tmp/Accu-Mk1-parent-table` on branch `feat/native-parent-analyses-table`; baseline file `/c/tmp/Accu-Mk1-parent-table/.superpowers/sdd/2026-08-04-parent-analyses-table/baseline-failures.txt` consumed by every later backend gate.

- [ ] **Step 1: Create the worktree** (from the existing catalog-s2s worktree's repo)

```bash
git -C /c/tmp/Accu-Mk1-catalog-s2s worktree add -b feat/native-parent-analyses-table /c/tmp/Accu-Mk1-parent-table 838ebec
git -C /c/tmp/Accu-Mk1-parent-table log --oneline -1   # expect 838ebec
```

- [ ] **Step 2: Capture the backend failure baseline** (takes several minutes; this is the ~64-failure dirty baseline)

```bash
mkdir -p /c/tmp/Accu-Mk1-parent-table/.superpowers/sdd/2026-08-04-parent-analyses-table
cd /c/tmp/Accu-Mk1-parent-table/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > ../.superpowers/sdd/2026-08-04-parent-analyses-table/baseline-failures.txt
wc -l ../.superpowers/sdd/2026-08-04-parent-analyses-table/baseline-failures.txt
```

Expected: ~64 lines. Do NOT commit this file.

- [ ] **Step 3: Confirm the FE typechecks clean at baseline**

```bash
cd /c/tmp/Accu-Mk1-parent-table && npx tsc --noEmit
```

Expected: exit 0. (If not, record the baseline errors — later tasks gate on "no NEW errors".)

---

### Task 2: Backend senaite_shape projection for native parent analyses

**Files:**
- Modify: `backend/lims_analyses/service.py` (add function near `list_native_parent_analyses`, ~line 934)
- Modify: `backend/lims_analyses/routes.py:220-236`
- Test: `backend/tests/test_native_parent_analyses_endpoint.py`

**Interfaces:**
- Consumes: `_serialize_senaite_shape_rows(db, rows)` (service.py:2167 — omit `promo_by_source`; parent rows are never promotion sources), `NotFoundError` (service.py:37), existing models `LimsSample`, `LimsAnalysis`, `AnalysisService`.
- Produces: `GET /api/lims-analyses/parent/{sample_id}/native-analyses?as=senaite_shape` → `List[SenaiteShapeAnalysisResponse]` (uids `mk1:{id}`); default (`as` omitted) response unchanged. Service fn `list_native_parent_analyses_senaite_shape(db, sample_id) -> List[SenaiteShapeAnalysisResponse]`, raises `NotFoundError` for unknown sample (FE treats the 404 as no-rows).

**Row-set contract (differs from both existing reads, on purpose):** canonical + `AnalysisService.origin == "mk1"` + parent-hosted (`lims_sample_pk == parent.id`, `lims_sub_sample_pk IS NULL`), **all review states, full lineage** (retracted old roots and retest rows included; no latest-per-service dedup) — the table renders history itself via `groupAnalysesByTitle` (current = last row, hence `ORDER BY keyword, id`). Shadow rows and senaite-origin services stay excluded: this card is the native section, not an AR mirror. No `tier_of` filter: parent-acting-as-vial rows in early states are visible in today's card and stay visible (display-only — Task 5's verb policy shows verbs on `verified` only).

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_native_parent_analyses_endpoint.py`, reusing that file's existing TestClient + row-seeding fixtures — read the file's existing four tests first and mirror their setup idiom)

```python
def test_senaite_shape_returns_full_table_fields(client_and_seed):
    """?as=senaite_shape projects rows through the shared serializer."""
    client, sample_id = client_and_seed  # adapt to the file's fixture naming
    r = client.get(f"/api/lims-analyses/parent/{sample_id}/native-analyses?as=senaite_shape")
    assert r.status_code == 200
    rows = r.json()
    assert rows
    row = rows[0]
    for field in (
        "uid", "keyword", "title", "result", "result_options", "unit",
        "method", "method_uid", "instrument", "instrument_uid", "analyst",
        "review_state", "captured", "retested", "promoted_to_parent_id",
    ):
        assert field in row, f"missing {field}"
    assert row["uid"].startswith("mk1:")


def test_senaite_shape_includes_lineage_current_last(client_and_seed):
    """A retracted old root and the active root for the same keyword are BOTH
    returned, active last (groupAnalysesByTitle takes the last row as current)."""
    # Seed: one canonical mk1-origin parent row review_state='retracted',
    # then a second (higher id) same keyword review_state='verified'.
    ...
    rows = [r for r in resp.json() if r["keyword"] == KW]
    assert [r["review_state"] for r in rows] == ["retracted", "verified"]


def test_senaite_shape_excludes_shadow_and_senaite_origin_and_subsample_rows(client_and_seed):
    """Shadow provenance, senaite-origin services, and vial-hosted rows never appear."""
    ...
    keywords = {r["keyword"] for r in resp.json()}
    assert SHADOW_KW not in keywords
    assert SENAITE_ORIGIN_KW not in keywords
    assert VIAL_HOSTED_KW not in keywords


def test_default_shape_unchanged(client_and_seed):
    """Back-compat pin: without ?as= the response is still the 6-field rows."""
    client, sample_id = client_and_seed
    r = client.get(f"/api/lims-analyses/parent/{sample_id}/native-analyses")
    assert r.status_code == 200
    assert set(r.json()[0].keys()) == {
        "keyword", "title", "result_value", "result_unit", "review_state", "updated_at",
    }


def test_senaite_shape_unknown_sample_404(client_and_seed):
    client, _ = client_and_seed
    r = client.get("/api/lims-analyses/parent/NOPE-404/native-analyses?as=senaite_shape")
    assert r.status_code == 404
```

The `...` seeding bodies must be written out using the file's existing helper that inserts `LimsSample`/`LimsAnalysis`/`AnalysisService` rows (the existing `test_returns_current_native_row_excludes_shadow_and_superseded` at line 81 already seeds shadow + retracted rows — copy its idiom).

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /c/tmp/Accu-Mk1-parent-table/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_native_parent_analyses_endpoint.py -q
```

Expected: the 5 new tests FAIL (the `?as=` param is currently ignored by FastAPI → default shape comes back → missing-field assertions fail).

- [ ] **Step 3: Implement the service function** (in `service.py`, directly after `list_native_parent_analyses`)

```python
def list_native_parent_analyses_senaite_shape(
    db: Session, sample_id: str
) -> List["SenaiteShapeAnalysisResponse"]:
    """Native (origin='mk1') parent-tier rows projected to the FE's
    SenaiteAnalysis shape for the shared AnalysisTable (native parent
    analyses card).

    Row set intentionally differs from list_native_parent_analyses (the
    6-field card read): ALL review states and the full lineage (retracted
    old roots, retest rows) are included with no latest-per-service dedup —
    the table groups by title and renders history rows itself, taking the
    LAST row as current (hence ORDER BY keyword, id). Shadow rows and
    senaite-origin services stay excluded: this is the native section, not
    a mirror of the SENAITE AR (that surface is
    list_parent_analyses_senaite_shape).
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise NotFoundError(f"sample {sample_id!r} not known to Mk1")
    rows = list(
        db.execute(
            select(LimsAnalysis)
            .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .where(
                LimsAnalysis.lims_sample_pk == parent.id,
                LimsAnalysis.lims_sub_sample_pk.is_(None),
                LimsAnalysis.provenance == "canonical",
                AnalysisService.origin == "mk1",
            )
            .order_by(LimsAnalysis.keyword, LimsAnalysis.id)
        ).scalars().all()
    )
    return _serialize_senaite_shape_rows(db, rows)
```

Match the file's existing import pattern — `LimsSample` is imported locally inside sibling functions (`from models import LimsSample`); mirror whichever style `list_native_parent_analyses` uses at line ~895.

- [ ] **Step 4: Implement the route dispatch** (replace the decorator + signature of `list_native_parent_analyses` in `routes.py:220-236`, copying the `as_` idiom from `list_for_host` at routes.py:156-163)

```python
@router.get(
    "/parent/{sample_id}/native-analyses",
    response_model=Union[List[NativeParentAnalysisRow], List[SenaiteShapeAnalysisResponse]],
)
def list_native_parent_analyses(
    sample_id: str,
    as_: Literal["default", "senaite_shape"] = Query("default", alias="as"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    # (keep the existing docstring, append:)
    # ?as=senaite_shape projects the rows through the shared senaite-shape
    # serializer for the AnalysisTable-backed card — full lineage, all states.
    try:
        if as_ == "senaite_shape":
            return service.list_native_parent_analyses_senaite_shape(db, sample_id)
        return service.list_native_parent_analyses(db, sample_id)
    except Exception as e:
        raise _handle_service_error(e)
```

`Union`, `Literal`, `Query`, and `SenaiteShapeAnalysisResponse` are already imported in routes.py (used by `list_for_host`); verify before adding imports.

- [ ] **Step 5: Run the test file to verify pass**

Same command as Step 2. Expected: all tests in the file PASS (4 pre-existing + 5 new).

- [ ] **Step 6: Backend failure-set gate**

```bash
cd /c/tmp/Accu-Mk1-parent-table/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > /tmp/now.txt; diff /c/tmp/Accu-Mk1-parent-table/.superpowers/sdd/2026-08-04-parent-analyses-table/baseline-failures.txt /tmp/now.txt
```

Expected: empty diff.

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/Accu-Mk1-parent-table && git add backend/lims_analyses/service.py backend/lims_analyses/routes.py backend/tests/test_native_parent_analyses_endpoint.py && git commit -m "feat(parent-analyses): senaite_shape projection on the native parent analyses read"
```

---

### Task 3: Backend parent-retest route

**Files:**
- Modify: `backend/lims_analyses/service.py` (`cascade_parent_retest_to_sources` ~1237: add `source_reason` kwarg; new `parent_retest` fn)
- Modify: `backend/lims_analyses/schemas.py` (two models)
- Modify: `backend/lims_analyses/routes.py` (new POST route, placed next to the native-analyses GET)
- Test: `backend/tests/test_parent_retest_route.py` (new), `backend/tests/test_lims_analyses_routes.py` (one pin test)

**Interfaces:**
- Consumes: `cascade_parent_retest_to_sources` (existing semantics: retests eligible promoted sources, un-promotes a *verified* parent — retract + clear — never touches published), `InvalidTransitionError(from_state, kind, message=...)` (state_machine.py:150, already imported by service.py), `NotFoundError`.
- Produces: `POST /api/lims-analyses/parent/{sample_id}/retest`, body `{"keyword": str, "reason"?: str}` → `{"new_row_ids": [int], "parent_review_state": str|null}`. Errors: 404 unknown sample / no active native row for keyword; 409 `invalid_transition` when the active parent row is not `verified` (fail-closed: an API caller must not retract vial results under a published parent). Service fn `parent_retest(db, *, sample_id, keyword, user_id, reason) -> tuple[list[int], Optional[str]]`.

- [ ] **Step 1: Write the failing tests** — new file `backend/tests/test_parent_retest_route.py`. Reuse the fixture idiom from `backend/tests/test_parent_retest_cascade.py` (it already builds parent sample + promoted source vial rows + `LimsAnalysisPromotion` records) and the TestClient setup from `backend/tests/test_native_parent_analyses_endpoint.py:56`.

```python
def test_parent_retest_happy_path(client_with_promoted_parent):
    """Verified parent + 2 promoted sources: both sources get retest rows,
    parent is un-promoted (retracted, result cleared)."""
    client, sample_id, keyword, source_ids = client_with_promoted_parent
    r = client.post(
        f"/api/lims-analyses/parent/{sample_id}/retest",
        json={"keyword": keyword},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["new_row_ids"]) == 2
    assert body["parent_review_state"] == "retracted"
    # DB-level: sources flagged retested, new rows linked via retest_of_id,
    # parent row retracted with result_value cleared. Assert all three.


def test_parent_retest_not_verified_409(client_with_promoted_parent_published):
    """Published (or any non-verified) active parent row → 409, nothing retested."""
    client, sample_id, keyword, source_ids = client_with_promoted_parent_published
    r = client.post(
        f"/api/lims-analyses/parent/{sample_id}/retest", json={"keyword": keyword}
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "invalid_transition"
    # DB-level: no source row gained retested=True.


def test_parent_retest_no_eligible_sources_returns_empty(client_with_already_retested_source):
    """Sources already retested → 200, new_row_ids [], parent STAYS verified
    (the cascade only un-promotes when it actually created retest rows)."""
    ...
    assert r.status_code == 200
    assert r.json()["new_row_ids"] == []
    assert r.json()["parent_review_state"] == "verified"


def test_parent_retest_unknown_sample_404(plain_client):
    r = plain_client.post(
        "/api/lims-analyses/parent/NOPE-404/retest", json={"keyword": "HM-ICPMS"}
    )
    assert r.status_code == 404


def test_parent_retest_unknown_keyword_404(client_with_promoted_parent):
    client, sample_id, _, _ = client_with_promoted_parent
    r = client.post(
        f"/api/lims-analyses/parent/{sample_id}/retest", json={"keyword": "NOPE"}
    )
    assert r.status_code == 404
```

And in `backend/tests/test_lims_analyses_routes.py`, add the mirror image of `test_publish_on_vial_tier_returns_409_tier_mismatch` (line 125 — copy its fixture usage):

```python
def test_retest_on_parent_tier_returns_409_tier_mismatch(...):
    """Pins WHY the dedicated parent-retest route exists: the generic
    transitions endpoint tier-blocks retest on a verified parent row."""
    r = client.post(f"/api/lims-analyses/{parent_row_id}/transitions", json={"kind": "retest"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "tier_mismatch"
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/Accu-Mk1-parent-table/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_parent_retest_route.py tests/test_lims_analyses_routes.py -q
```

Expected: new-route tests FAIL with 404/405 (route absent); the tier_mismatch pin may already PASS (behavior exists — the test is a pin, that's fine).

- [ ] **Step 3: Implement.** Three edits:

(a) `cascade_parent_retest_to_sources` — additive kwarg; the ONLY body change is the `reason=` line:

```python
def cascade_parent_retest_to_sources(
    db: Session,
    *,
    parent_sample_id: str,
    keyword: str,
    user_id: Optional[int],
    source_reason: str = "cascaded from parent SENAITE retest",
) -> list[int]:
    ...
            new_row = apply_transition(
                db,
                analysis_id=src.id,
                kind="retest",
                reason=source_reason,
                user_id=user_id,
            )
```

The existing caller (`main.py:15299`) passes no `source_reason` → byte-identical audit text; the cascade's 8 existing tests must stay green untouched.

(b) new service fn (place directly after the cascade):

```python
def parent_retest(
    db: Session,
    *,
    sample_id: str,
    keyword: str,
    user_id: Optional[int],
    reason: Optional[str] = None,
) -> tuple[list[int], Optional[str]]:
    """Native origination of a parent-tier retest: validate, then run the
    existing cascade (retest promoted sources + un-promote the verified
    parent). The generic transitions endpoint tier-blocks 'retest' at
    TIER_PARENT on purpose — this is the dedicated, fail-closed path.

    Fail-closed guard: the active canonical parent row for the keyword must
    be 'verified'. Without it, a direct API caller could retract vial
    results under a PUBLISHED parent (the cascade retests sources
    regardless of parent state; only its un-promote step checks verified).
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise NotFoundError(f"sample {sample_id!r} not known to Mk1")
    active = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.keyword == keyword,
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.not_in(("retracted", "rejected")),
            LimsAnalysis.provenance == "canonical",
        )
    ).scalars().first()
    if active is None:
        raise NotFoundError(
            f"no active native parent row for keyword {keyword!r} on {sample_id!r}"
        )
    if active.review_state != "verified":
        raise InvalidTransitionError(
            active.review_state,
            "retest",
            message=(
                "parent retest requires the parent row to be 'verified'; "
                f"row is {active.review_state!r} (published parents go "
                "through invalidate→retest)"
            ),
        )
    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=sample_id,
        keyword=keyword,
        user_id=user_id,
        source_reason=reason or "retested from parent (native)",
    )
    db.refresh(active)
    return new_ids, active.review_state
```

(`from models import LimsSample` — mirror the cascade's own local-import style. The `active` resolution query is deliberately the same shape as the cascade's step-2 query so the two can't disagree about which row is active.)

(c) schemas + route:

```python
# schemas.py
class ParentRetestRequest(BaseModel):
    keyword: str
    reason: Optional[str] = None


class ParentRetestResponse(BaseModel):
    new_row_ids: list[int]
    parent_review_state: Optional[str] = None
```

```python
# routes.py — place directly after the native-analyses GET
@router.post("/parent/{sample_id}/retest", response_model=ParentRetestResponse)
def parent_retest(
    sample_id: str,
    req: ParentRetestRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Native parent-tier retest (AnalysisTable card verb): retests the
    promoted source vial rows and un-promotes the verified parent row via
    cascade_parent_retest_to_sources. 409 invalid_transition unless the
    active parent row is 'verified' — published parents are protected."""
    try:
        new_ids, state = service.parent_retest(
            db,
            sample_id=sample_id,
            keyword=req.keyword,
            user_id=getattr(current_user, "id", None),
            reason=req.reason,
        )
        return ParentRetestResponse(new_row_ids=new_ids, parent_review_state=state)
    except Exception as e:
        raise _handle_service_error(e)
```

- [ ] **Step 4: Run the two test files — expect all PASS.** Also run the cascade's existing suites untouched:

```bash
cd /c/tmp/Accu-Mk1-parent-table/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_parent_retest_route.py tests/test_lims_analyses_routes.py tests/test_parent_retest_cascade.py tests/test_lims_analyses_service.py tests/test_parent_mirror_fail_closed.py -q
```

- [ ] **Step 5: Backend failure-set gate** (same diff command as Task 2 Step 6). Expected: empty diff.

- [ ] **Step 6: Commit**

```bash
cd /c/tmp/Accu-Mk1-parent-table && git add backend/lims_analyses/service.py backend/lims_analyses/routes.py backend/lims_analyses/schemas.py backend/tests/test_parent_retest_route.py backend/tests/test_lims_analyses_routes.py && git commit -m "feat(parent-analyses): dedicated native parent-retest route over the promote cascade"
```

---

### Task 4: FE API functions + lib module

**Files:**
- Modify: `src/lib/api.ts` (place both next to `getNativeParentAnalyses` ~5905)
- Create: `src/lib/native-parent-analyses.ts`
- Test: `src/test/native-parent-analyses-lib.test.ts`

**Interfaces:**
- Consumes: `SenaiteAnalysis`, `ParentPromotionInfo` (api.ts:5872-5879: `{keyword, parent_analysis_id, result_value?, promoted_at, promoted_by_email?, sources: {sample_id?: string|null, contribution_kind: string}[]}`), `API_BASE_URL()`, `getBearerHeaders()`.
- Produces (used by Tasks 6-7): `listNativeParentAnalysesShaped(sampleId): Promise<SenaiteAnalysis[]>`; `parentRetestAnalysis(sampleId, keyword, reason?): Promise<ParentRetestResponse>` where `ParentRetestResponse = {new_row_ids: number[], parent_review_state: string | null}`; `NATIVE_PARENT_ANALYSES_QUERY_KEY = 'native-parent-analyses'`; `ParentRetestImpact = {sourceCount: number, vialIds: string[]}`; `buildParentRetestImpact(promotion): ParentRetestImpact`; `buildBulkParentRetestImpact(keywords, promotionsByKeyword): ParentRetestImpact`.

- [ ] **Step 1: Write the failing unit tests** — `src/test/native-parent-analyses-lib.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildBulkParentRetestImpact,
  buildParentRetestImpact,
} from '@/lib/native-parent-analyses'
import type { ParentPromotionInfo } from '@/lib/api'

const promo = (keyword: string, ids: (string | null)[]): ParentPromotionInfo => ({
  keyword,
  parent_analysis_id: 1,
  promoted_at: '2026-08-01T00:00:00Z',
  sources: ids.map(sample_id => ({ sample_id, contribution_kind: 'primary' })),
})

describe('buildParentRetestImpact', () => {
  it('counts sources and collects vial ids', () => {
    expect(buildParentRetestImpact(promo('HM', ['P-1-S01', 'P-1-S02']))).toEqual({
      sourceCount: 2,
      vialIds: ['P-1-S01', 'P-1-S02'],
    })
  })
  it('null-sample_id sources count toward sourceCount but not vialIds', () => {
    expect(buildParentRetestImpact(promo('HM', ['P-1-S01', null]))).toEqual({
      sourceCount: 2,
      vialIds: ['P-1-S01'],
    })
  })
  it('fails closed on missing promotion', () => {
    expect(buildParentRetestImpact(undefined)).toEqual({ sourceCount: 0, vialIds: [] })
  })
})

describe('buildBulkParentRetestImpact', () => {
  it('aggregates across keywords and dedupes vial ids', () => {
    const map = new Map([
      ['HM', promo('HM', ['P-1-S01'])],
      ['STER', promo('STER', ['P-1-S01', 'P-1-S03'])],
    ])
    expect(buildBulkParentRetestImpact(['HM', 'STER'], map)).toEqual({
      sourceCount: 3,
      vialIds: ['P-1-S01', 'P-1-S03'],
    })
  })
  it('missing map or keywords contribute zero', () => {
    expect(buildBulkParentRetestImpact(['HM'], undefined)).toEqual({ sourceCount: 0, vialIds: [] })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/Accu-Mk1-parent-table && npx vitest run src/test/native-parent-analyses-lib.test.ts
```

Expected: FAIL — module `src/lib/native-parent-analyses.ts` does not exist.

- [ ] **Step 3: Implement `src/lib/native-parent-analyses.ts`**

```ts
import type { ParentPromotionInfo } from './api'

/** Query-key literal for the native parent analyses card, hoisted so
 *  SampleDetails.refreshSample can invalidate it — the literal used to live
 *  inline in the component and NOTHING invalidated it (staleTime 30s masked
 *  the gap while the card was read-only). Same drift-prevention move as
 *  PARENT_OVERLAY_QUERY_KEY in lib/vial-assignment.ts. */
export const NATIVE_PARENT_ANALYSES_QUERY_KEY = 'native-parent-analyses'

export interface ParentRetestImpact {
  sourceCount: number
  vialIds: string[]
}

/** Blast radius for the parent-retest confirm: how many promoted source
 *  results get retracted, on which vials. Missing promotion record → zero
 *  impact; the confirm dialog fails closed on it (disabled action). */
export function buildParentRetestImpact(
  promotion: ParentPromotionInfo | undefined
): ParentRetestImpact {
  if (!promotion) return { sourceCount: 0, vialIds: [] }
  return {
    sourceCount: promotion.sources.length,
    vialIds: promotion.sources
      .map(s => s.sample_id)
      .filter((s): s is string => !!s),
  }
}

/** Aggregate impact for bulk retest across keywords (vial ids deduped). */
export function buildBulkParentRetestImpact(
  keywords: string[],
  promotionsByKeyword: Map<string, ParentPromotionInfo> | undefined
): ParentRetestImpact {
  const per = keywords.map(k => buildParentRetestImpact(promotionsByKeyword?.get(k)))
  return {
    sourceCount: per.reduce((n, p) => n + p.sourceCount, 0),
    vialIds: Array.from(new Set(per.flatMap(p => p.vialIds))),
  }
}
```

- [ ] **Step 4: Add the two API functions to `src/lib/api.ts`** (directly after `getNativeParentAnalyses`; keep the old function — the endpoint's default shape stays live and pinned server-side)

```ts
/** Native parent rows projected to the SenaiteAnalysis shape for the shared
 *  AnalysisTable (native parent analyses card). Full lineage, all states;
 *  uids carry the mk1: prefix. 404 (sample unknown to Mk1) is treated as
 *  "no native rows", same as getNativeParentAnalyses. */
export async function listNativeParentAnalysesShaped(
  sampleId: string
): Promise<SenaiteAnalysis[]> {
  const response = await fetch(
    `${API_BASE_URL()}/api/lims-analyses/parent/${encodeURIComponent(sampleId)}/native-analyses?as=senaite_shape`,
    { headers: getBearerHeaders() }
  )
  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`listNativeParentAnalysesShaped failed: ${response.status}`)
  }
  return response.json()
}

export interface ParentRetestResponse {
  new_row_ids: number[]
  parent_review_state: string | null
}

/** Native parent-tier retest for one keyword: retests the promoted source
 *  vial rows and un-promotes the verified parent (existing cascade
 *  semantics — published parents 409 server-side). The generic
 *  /transitions endpoint tier-blocks parent retest; only this route works. */
export async function parentRetestAnalysis(
  sampleId: string,
  keyword: string,
  reason?: string
): Promise<ParentRetestResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/api/lims-analyses/parent/${encodeURIComponent(sampleId)}/retest`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(reason ? { keyword, reason } : { keyword }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    const detail = err?.detail
    throw new Error(
      (typeof detail === 'string' ? detail : detail?.message) ||
        `parentRetestAnalysis failed: ${response.status}`
    )
  }
  return response.json()
}
```

- [ ] **Step 5: Run tests + typecheck — expect PASS / no new errors**

```bash
cd /c/tmp/Accu-Mk1-parent-table && npx vitest run src/test/native-parent-analyses-lib.test.ts && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
cd /c/tmp/Accu-Mk1-parent-table && git add src/lib/api.ts src/lib/native-parent-analyses.ts src/test/native-parent-analyses-lib.test.ts && git commit -m "feat(parent-analyses): shaped read + parent-retest API fns and confirm-impact helpers"
```

---

### Task 5: AnalysisTable verb policy

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx`
- Test: `src/test/analysis-table-verb-policy.test.tsx`

**Interfaces:**
- Consumes: existing exports `visibleRowTransitions`, `deriveBulkActions`, `BulkTransition`, `SenaiteAnalysis`.
- Produces (used by Task 7): props `verbPolicy?: 'default' | 'parent-native'`, `onParentRetest?: (analysis: SenaiteAnalysis) => void`, `onParentBulkRetest?: (analyses: SenaiteAnalysis[]) => void`; exported pure fns `visibleRowTransitionsForPolicy(a, policy, parentLineStates?)` and `deriveBulkActionsForPolicy(selected, policy, parentLineStates?, vialKind?)`.

**Design notes (from recon — implementer must respect all four):**
- The table has NO transition callback prop; verbs fire internal hooks keyed on the `mk1:` uid prefix (`transitionAnalysis` would 409 `tier_mismatch` on a parent row). In `parent-native` policy the retest menu item and the bulk retest button MUST route to the new callbacks and never touch `transition.executeTransition` / `bulk` execution / `bulkPendingConfirm`.
- `DESTRUCTIVE_TRANSITIONS` (line ~192) only routes retract/reject to the built-in AlertDialog, whose copy is hardcoded two-way — do NOT extend it; the card owns the retest confirm (Task 6).
- Promote / variance side channels (`canPromote`, `canVarVerify` at lines ~1244-1247) must be forced false under `parent-native`.
- `EditableSelectCell` already has a dormant `readOnly` prop (declared ~798-801, gated at ~816, never passed at ~1351-1370) — wire it; do not invent a second mechanism.

- [ ] **Step 1: Write the failing tests** — `src/test/analysis-table-verb-policy.test.tsx`. First read the existing consumer of `ALLOWED_TRANSITIONS_TEST_EXPORT` (grep `src/test` for it) and mirror its row-builder helpers.

```tsx
import { describe, expect, it } from 'vitest'
import {
  deriveBulkActions,
  deriveBulkActionsForPolicy,
  visibleRowTransitions,
  visibleRowTransitionsForPolicy,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const row = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis => ({
  uid: 'mk1:7', keyword: 'HM', title: 'Heavy Metals', result: '1', result_options: [],
  unit: null, method: null, method_uid: null, method_options: [], instrument: null,
  instrument_uid: null, instrument_options: [], analyst: null, due_date: null,
  review_state: 'verified', sort_key: null, captured: null, retested: false,
  service_group_id: null, service_group_name: null, ...over,
})

describe('visibleRowTransitionsForPolicy', () => {
  it('parent-native: verified row offers exactly retest', () => {
    expect(visibleRowTransitionsForPolicy(row({}), 'parent-native')).toEqual(['retest'])
  })
  it.each(['retracted', 'published', 'to_be_verified', 'unassigned'])(
    'parent-native: %s row is display-only',
    state => {
      expect(
        visibleRowTransitionsForPolicy(row({ review_state: state }), 'parent-native')
      ).toEqual([])
    }
  )
  it('default policy delegates to the legacy fn unchanged', () => {
    const a = row({ review_state: 'to_be_verified' })
    expect(visibleRowTransitionsForPolicy(a, 'default')).toEqual(visibleRowTransitions(a))
  })
})

describe('deriveBulkActionsForPolicy', () => {
  it('parent-native: all-verified selection offers retest only, no side channels', () => {
    expect(deriveBulkActionsForPolicy([row({}), row({ uid: 'mk1:8' })], 'parent-native')).toEqual({
      actions: ['retest'], showPromote: false, showVarianceVerify: false,
    })
  })
  it('parent-native: mixed states offer nothing', () => {
    expect(
      deriveBulkActionsForPolicy([row({}), row({ review_state: 'retracted' })], 'parent-native')
        .actions
    ).toEqual([])
  })
  it('default policy delegates to the legacy fn unchanged', () => {
    const sel = [row({ review_state: 'to_be_verified' })]
    expect(deriveBulkActionsForPolicy(sel, 'default')).toEqual(deriveBulkActions(sel))
  })
})
```

Plus one render test in the same file (reuse the render harness from the existing AnalysisTable test file): mount `<AnalysisTable analyses={[verifiedRow, retractedRow]} analyteNameMap={new Map()} verbPolicy="parent-native" resultsReadOnly onParentRetest={spy} />`, open the verified row's action menu, assert: only "Retest" appears (no Promote, no Verify), clicking it calls `spy` with the row and does NOT open the built-in retract/reject AlertDialog; the retracted row renders no menu trigger at all.

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/test/analysis-table-verb-policy.test.tsx`) — FAIL: the `...ForPolicy` exports don't exist.

- [ ] **Step 3: Implement.** Five edits inside `AnalysisTable.tsx`:

(a) Pure policy fns, next to `visibleRowTransitions` (~line 290):

```ts
export type AnalysisVerbPolicy = 'default' | 'parent-native'

/** Policy-aware row verbs. 'parent-native' (the native parent analyses card)
 *  offers exactly one verb — retest on a 'verified' row — and routes it via
 *  onParentRetest (the generic transition endpoint tier-blocks parent
 *  retest; the card calls the dedicated parent-retest route and owns the
 *  destructive confirm). Everything else is display-only. */
export function visibleRowTransitionsForPolicy(
  a: SenaiteAnalysis,
  policy: AnalysisVerbPolicy,
  parentLineStates?: Record<string, string>,
): string[] {
  if (policy === 'parent-native') {
    return a.uid && a.review_state === 'verified' ? ['retest'] : []
  }
  return visibleRowTransitions(a, parentLineStates)
}

/** Policy-aware bulk actions. 'parent-native' reduces the toolbar to bulk
 *  retest over an all-verified selection; promote/variance never show. */
export function deriveBulkActionsForPolicy(
  selected: SenaiteAnalysis[],
  policy: AnalysisVerbPolicy,
  parentLineStates?: Record<string, string>,
  vialKind?: string | null,
): { actions: BulkTransition[]; showPromote: boolean; showVarianceVerify: boolean } {
  if (policy === 'parent-native') {
    const allVerified =
      selected.length > 0 && selected.every(a => a.review_state === 'verified')
    return { actions: allVerified ? ['retest'] : [], showPromote: false, showVarianceVerify: false }
  }
  return deriveBulkActions(selected, parentLineStates, vialKind)
}
```

(b) Props (append to `AnalysisTableProps` ~1589-1662, destructure with `verbPolicy = 'default'` default ~1664-1685):

```ts
  /** Verb policy. Omit ('default') = existing behavior byte-identical.
   *  'parent-native' = the native parent analyses card: retest-only on
   *  verified rows via onParentRetest/onParentBulkRetest; method/instrument
   *  editing suppressed; promote/variance side channels suppressed. */
  verbPolicy?: AnalysisVerbPolicy
  /** parent-native only: row retest requested — open the card's confirm. */
  onParentRetest?: (analysis: SenaiteAnalysis) => void
  /** parent-native only: bulk retest over the selected current rows. */
  onParentBulkRetest?: (analyses: SenaiteAnalysis[]) => void
```

(c) Row-level gating (~1244-1247) — swap in the policy fn and kill side channels:

```ts
  const allowedTransitions = visibleRowTransitionsForPolicy(analysis, verbPolicy, parentLineStates)
  const canPromote = verbPolicy !== 'parent-native' && isPromotable(analysis, vialKind) && !locked
  const canVarVerify = verbPolicy !== 'parent-native' && canVarianceVerify(analysis, vialKind)
```

(`verbPolicy` and `onParentRetest` must be threaded into `AnalysisRow` as props — follow how `vialKind` is threaded today.) Menu-item click (~1467-1473):

```ts
  onClick={() => {
    if (!analysis.uid) return
    if (verbPolicy === 'parent-native') {
      onParentRetest?.(analysis)
    } else if (DESTRUCTIVE_TRANSITIONS.has(t)) {
      transition.requestConfirm(analysis.uid, t, analysis.title)
    } else {
      void transition.executeTransition(analysis.uid, t)
    }
  }}
```

(d) Method/instrument read-only: pass `readOnly={verbPolicy === 'parent-native'}` to BOTH `EditableSelectCell` instances (~1351-1370) — the dormant prop's gate at ~816 does the rest.

(e) Bulk toolbar: replace the `deriveBulkActions(...)` call (~1769-1770) with `deriveBulkActionsForPolicy(selectedAnalyses, verbPolicy, parentLineStates, vialKind)` (keep the existing local variable names), and in the retest button's onClick branch:

```ts
  if (verbPolicy === 'parent-native') {
    onParentBulkRetest?.(selectedAnalyses)
    return
  }
  // existing flow unchanged
```

- [ ] **Step 4: Run the new test file AND the existing AnalysisTable-related suites** (grep `src/test` for files importing from `AnalysisTable` and run them all) + `npx tsc --noEmit`. Expected: all PASS, no new type errors — the default-policy delegation tests are the regression pin.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-parent-table && git add src/components/senaite/AnalysisTable.tsx src/test/analysis-table-verb-policy.test.tsx && git commit -m "feat(parent-analyses): parent-native verb policy on the shared AnalysisTable"
```

---

### Task 6: ParentRetestConfirmDialog

**Files:**
- Create: `src/components/senaite/ParentRetestConfirmDialog.tsx`
- Test: `src/test/parent-retest-confirm-dialog.test.tsx`

**Interfaces:**
- Consumes: `ParentRetestImpact` from `@/lib/native-parent-analyses`; shadcn `AlertDialog` primitives (copy the import list from AnalysisTable.tsx's existing AlertDialog usage ~2036).
- Produces (used by Task 7): `ParentRetestConfirmState = {titles: string[], keywords: string[], impact: ParentRetestImpact}`; component `ParentRetestConfirmDialog({state, pending, onCancel, onConfirm}: {state: ParentRetestConfirmState | null, pending: boolean, onCancel: () => void, onConfirm: () => void})`.

- [ ] **Step 1: Write the failing tests** — `src/test/parent-retest-confirm-dialog.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ParentRetestConfirmDialog } from '@/components/senaite/ParentRetestConfirmDialog'

const state = {
  titles: ['Heavy Metals'],
  keywords: ['HM'],
  impact: { sourceCount: 2, vialIds: ['P-0120-S01', 'P-0120-S02'] },
}

describe('ParentRetestConfirmDialog', () => {
  it('names the blast radius', () => {
    render(<ParentRetestConfirmDialog state={state} pending={false} onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText(/retracts 2 promoted source results/i)).toBeInTheDocument()
    expect(screen.getByText(/P-0120-S01, P-0120-S02/)).toBeInTheDocument()
  })
  it('confirm fires onConfirm', async () => {
    const onConfirm = vi.fn()
    render(<ParentRetestConfirmDialog state={state} pending={false} onCancel={() => {}} onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: /^retest$/i }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
  it('fails closed: zero-impact state disables the action', () => {
    render(
      <ParentRetestConfirmDialog
        state={{ ...state, impact: { sourceCount: 0, vialIds: [] } }}
        pending={false} onCancel={() => {}} onConfirm={() => {}}
      />
    )
    expect(screen.getByText(/no promoted source results/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).toBeDisabled()
  })
  it('renders nothing when state is null', () => {
    const { container } = render(
      <ParentRetestConfirmDialog state={null} pending={false} onCancel={() => {}} onConfirm={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/test/parent-retest-confirm-dialog.test.tsx`) — FAIL: module missing.

- [ ] **Step 3: Implement**

```tsx
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { ParentRetestImpact } from '@/lib/native-parent-analyses'

export interface ParentRetestConfirmState {
  titles: string[]
  keywords: string[]
  impact: ParentRetestImpact
}

/** Destructive confirm for the native parent-tier retest. Names the exact
 *  blast radius (N promoted source results on vials X, Y) and fails closed:
 *  with no promotion provenance the cascade would silently no-op, so the
 *  action is disabled rather than offering a do-nothing button. */
export function ParentRetestConfirmDialog({
  state, pending, onCancel, onConfirm,
}: {
  state: ParentRetestConfirmState | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const impact = state?.impact
  const blocked = !impact || impact.sourceCount === 0
  return (
    <AlertDialog open={!!state} onOpenChange={open => { if (!open) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {state && state.titles.length > 1
              ? `Retest ${state.titles.length} analyses?`
              : 'Retest analysis?'}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <div><strong>{state?.titles.join(', ')}</strong></div>
              {blocked ? (
                <div>
                  No promoted source results found for this row — a retest here
                  would have no effect. Retest the vial rows directly instead.
                </div>
              ) : (
                <div>
                  This retracts {impact.sourceCount} promoted source{' '}
                  {impact.sourceCount === 1 ? 'result' : 'results'}
                  {impact.vialIds.length > 0 && (
                    <> on vial{impact.vialIds.length === 1 ? '' : 's'}{' '}
                      <span className="font-mono">{impact.vialIds.join(', ')}</span></>
                  )}
                  , creates fresh retest rows there, and un-promotes this parent
                  result. Published COAs are not affected.
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={blocked || pending} onClick={onConfirm}>
            {pending ? 'Retesting…' : 'Retest'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

- [ ] **Step 4: Run to verify pass** + `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-parent-table && git add src/components/senaite/ParentRetestConfirmDialog.tsx src/test/parent-retest-confirm-dialog.test.tsx && git commit -m "feat(parent-analyses): destructive confirm naming the source blast radius"
```

---

### Task 7: Card body swap + SampleDetails wiring

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` — `NativeParentAnalysesCard` (~3345-3415), call site (~6564-6572), `refreshSample` (~4121-4138)
- Test: `src/test/native-parent-analyses.test.tsx` (rewrite)

**Interfaces:**
- Consumes: everything produced by Tasks 4-6, plus existing page values: `data` (`SenaiteLookupResult`), `promotionsByKeyword` (`Map<string, ParentPromotionInfo>`, state ~3528-3530), `refreshSample`, `queryClient` (~3667), `useAnalysisSlaMap` (`@/services/analysis-sla` — already imported on the page).
- Produces: the shipped feature. Card props change to `{sampleId, isParentPage, lookup, promotionsByKeyword, onParentDataStale?}`.

- [ ] **Step 1: Rewrite the failing component tests** — `src/test/native-parent-analyses.test.tsx`. Keep the file's existing render harness (QueryClientProvider etc.) and mock module surface, switching the api mock to `listNativeParentAnalysesShaped` + `parentRetestAnalysis`. `useAnalysisSlaMap`'s underlying queries (`useAnalysisServices`/`useServiceGroups`/`useSlaTiers`) must be mocked the way `src/test/vials-quicklook.test.tsx` does. Test list (write all of them out):

```tsx
// helpers: shapedRow(over) builds a SenaiteAnalysis (copy Task 5's builder);
// renderCard(rows, promos) mounts NativeParentAnalysesCard with
// lookup={fakeLookup({date_received: '2026-08-01'})},
// promotionsByKeyword=promos, onParentDataStale=staleSpy.

it('renders the shared AnalysisTable with the card header folded in', ...)
  // assert "Accu-Mk1 Analyses" heading present AND a table row with the
  // analysis title + a state badge; assert the OLD flat list markup is gone
  // (e.g. no `divide-y` wrapper) — the table's column headers are visible.

it('renders nothing while empty', ...)
  // mock resolves [] → container empty (parity with today's behavior).

it('verified row offers only Retest; lineage rows are display-only', ...)
  // rows: verified + retracted (same title) → one "N prev" history chevron;
  // open verified row menu → only Retest; retracted row → no menu trigger.

it('results and method/instrument are not editable', ...)
  // no pencil / editor affordance on the result cell; method cell static.

it('retest confirm names the blast radius and fires the parent-retest route', async ...)
  // promos: HM → 2 sources on P-0120-S01/S02. Click row Retest →
  // dialog shows "retracts 2 promoted source results on vials P-0120-S01, P-0120-S02"
  // → confirm → expect parentRetestAnalysis('P-0120', 'HM') called once,
  // staleSpy called, query invalidated (spy on queryClient.invalidateQueries
  // or assert refetch of listNativeParentAnalysesShaped).

it('retest confirm fails closed with no promotion record', async ...)
  // promos empty → dialog explains + Retest disabled; parentRetestAnalysis
  // never called.
```

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/test/native-parent-analyses.test.tsx`) — FAIL against the current flat-list card.

- [ ] **Step 3: Rewrite `NativeParentAnalysesCard`** (keep name, keep export, keep the leading comment block updated to say the body is now the shared table). Full replacement body:

```tsx
export function NativeParentAnalysesCard({
  sampleId,
  isParentPage,
  lookup,
  promotionsByKeyword,
  onParentDataStale,
}: {
  sampleId: string | null | undefined
  isParentPage: boolean
  lookup: SenaiteLookupResult | null
  promotionsByKeyword: Map<string, ParentPromotionInfo>
  onParentDataStale?: () => void
}) {
  const queryClient = useQueryClient()
  const { data: rows } = useQuery({
    queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY, sampleId, 'senaite_shape'],
    queryFn: () => listNativeParentAnalysesShaped(sampleId!),
    enabled: isParentPage && !!sampleId,
    staleTime: 30_000,
  })
  const analyses = rows ?? []
  // Same code path the Vials Quick Look uses: SLA needs a lookup whose
  // analyses are THESE rows (the page's map is keyed off the SENAITE rows,
  // which never contain native keywords) and a non-null date_received.
  const slaLookup = useMemo(
    () => (lookup ? { ...lookup, analyses } : null),
    [lookup, analyses]
  )
  const sla = useAnalysisSlaMap(slaLookup)
  const [confirm, setConfirm] = useState<ParentRetestConfirmState | null>(null)
  const [retestPending, setRetestPending] = useState(false)

  if (analyses.length === 0) return null

  const requestRetest = (targets: SenaiteAnalysis[]) => {
    const keywords = targets
      .map(a => a.keyword)
      .filter((k): k is string => !!k)
    setConfirm({
      titles: targets.map(a => a.title),
      keywords,
      impact: buildBulkParentRetestImpact(keywords, promotionsByKeyword),
    })
  }

  const executeRetest = async () => {
    if (!confirm || !sampleId) return
    setRetestPending(true)
    try {
      let retested = 0
      for (const keyword of confirm.keywords) {
        const resp = await parentRetestAnalysis(sampleId, keyword)
        retested += resp.new_row_ids.length
      }
      if (retested > 0) {
        toast.success(`Retest cascaded — ${retested} source row${retested === 1 ? '' : 's'} retested`)
      } else {
        toast.warning('No eligible source rows — nothing changed')
      }
    } catch (e) {
      toast.error('Parent retest failed', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRetestPending(false)
      setConfirm(null)
      void queryClient.invalidateQueries({ queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY] })
      onParentDataStale?.()
    }
  }

  const header = (
    <div className="flex items-center gap-1.5">
      <h3 className="text-sm font-semibold">Accu-Mk1 Analyses</h3>
      <HoverTooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex text-muted-foreground/70"
            aria-label="Accu-Mk1 Analyses: provenance"
          >
            <Info size={12} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="p-0 max-w-xs">
          <div className="flex flex-col gap-1.5 p-3 text-xs font-mono">
            <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
              native to Accu-Mk1
            </div>
            <div>
              Results measured and promoted natively in Accu-Mk1 — not part
              of the SENAITE AR.
            </div>
            <div className="border-t border-primary-foreground/20 pt-1.5">
              Results are entered and submitted on the vials. Retesting a
              verified row here retracts its promoted source results and
              un-promotes the parent value.
            </div>
          </div>
        </TooltipContent>
      </HoverTooltip>
    </div>
  )

  return (
    <>
      <AnalysisTable
        analyses={analyses}
        analyteNameMap={EMPTY_ANALYTE_NAME_MAP}
        promotionsByKeyword={promotionsByKeyword}
        headerContent={header}
        hideProgress
        resultsReadOnly
        verbPolicy="parent-native"
        onParentRetest={a => requestRetest([a])}
        onParentBulkRetest={requestRetest}
        analysisSlaMap={sla.byKeyword}
        isAnalysisSlaLoading={sla.isLoading}
        isAnalysisSlaError={sla.isError}
        isAnalysisSlaPublished={sla.isPublished}
        analysisSlaPriority={sla.priority}
      />
      <ParentRetestConfirmDialog
        state={confirm}
        pending={retestPending}
        onCancel={() => setConfirm(null)}
        onConfirm={executeRetest}
      />
    </>
  )
}
```

Module-level, near the component: `const EMPTY_ANALYTE_NAME_MAP = new Map<number, string>()` (native families have no analyte-slot tinting; a stable const avoids a fresh Map per render). New imports into SampleDetails.tsx: `listNativeParentAnalysesShaped`, `parentRetestAnalysis` (from `@/lib/api` — extend the existing import), `NATIVE_PARENT_ANALYSES_QUERY_KEY`, `buildBulkParentRetestImpact` (from `@/lib/native-parent-analyses`), `ParentRetestConfirmDialog`, `ParentRetestConfirmState` (from `./ParentRetestConfirmDialog`). `useQueryClient`, `useMemo`, `useState`, `toast`, `AnalysisTable`, `useAnalysisSlaMap`, `SenaiteAnalysis`, `SenaiteLookupResult`, `ParentPromotionInfo` are all already imported on the page — verify, don't duplicate.

- [ ] **Step 4: Update the call site** (~6564-6572):

```tsx
      {parentSampleId === null && data.sample_id && (
        <NativeParentAnalysesCard
          sampleId={data.sample_id}
          isParentPage={parentSampleId === null}
          lookup={data}
          promotionsByKeyword={promotionsByKeyword}
          onParentDataStale={() => refreshSample(data.sample_id)}
        />
      )}
```

- [ ] **Step 5: Close the invalidation gap in `refreshSample`** (~4131-4137) — add one line to the parent-only branch and update its comment to name all FOUR surfaces:

```tsx
    if (parentSampleId === null) {
      invalidateParentVialOverlay(queryClient)
      refreshPromotions(id)
      void queryClient.invalidateQueries({ queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY] })
    }
```

- [ ] **Step 6: Run the card tests + typecheck — expect PASS**

```bash
cd /c/tmp/Accu-Mk1-parent-table && npx vitest run src/test/native-parent-analyses.test.tsx && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/Accu-Mk1-parent-table && git add src/components/senaite/SampleDetails.tsx src/test/native-parent-analyses.test.tsx && git commit -m "feat(parent-analyses): native parent card renders the shared AnalysisTable with parent-legal verbs"
```

---

### Task 8: Full verification sweep + push + PR

**Files:** none (verification only)

- [ ] **Step 1: Backend failure-set gate** (Task 2 Step 6 command). Expected: empty diff.
- [ ] **Step 2: FE typecheck**: `cd /c/tmp/Accu-Mk1-parent-table && npx tsc --noEmit` — no new errors vs Task 1 Step 3.
- [ ] **Step 3: Full targeted vitest sweep** — the four new/rewritten files PLUS every existing test file that imports from `AnalysisTable`, `SampleDetails`, or `analysis-sla` (derive the list):

```bash
cd /c/tmp/Accu-Mk1-parent-table && grep -rl "senaite/AnalysisTable\|senaite/SampleDetails\|services/analysis-sla" src/test --include="*.test.*" | sort -u
npx vitest run src/test/native-parent-analyses.test.tsx src/test/native-parent-analyses-lib.test.ts src/test/analysis-table-verb-policy.test.tsx src/test/parent-retest-confirm-dialog.test.tsx <files from the grep>
```

Expected: all PASS.
- [ ] **Step 4: Push + PR** (base `feat/s2s-catalog-keys` — keeps the #91 → #93 → #94 → this chain linear):

```bash
cd /c/tmp/Accu-Mk1-parent-table && git push -u origin feat/native-parent-analyses-table
gh pr create --repo <Mk1 repo> --base feat/s2s-catalog-keys --title "feat: native parent analyses table — shared AnalysisTable with parent-legal verbs" --body "<summary per spec + plan; note the three mechanism corrections; note remarks deferred + PR #41 out of scope>"
```

- [ ] **Step 5: Report** — PR number, verification evidence (gate outputs), and the deferred items (remarks; PR #41 verb; devbox s3rehe UAT happens at the Handler's request — worktree pull + container restart per the handoff gotcha).

## Self-Review (completed at write time)

- **Spec coverage:** data read → Task 2; adapter → obsoleted by server-side projection (correction 2); read-only results → `resultsReadOnly` (Task 7); parent verb map + no side channels → Task 5; bulk retest → Tasks 5+7; SLA chips → Task 7 synthetic lookup (correction 3); retest confirm blast radius → Tasks 4+6; verbs via existing cascade semantics → Task 3 (correction 1: dedicated route, state machine untouched); "what does not change" → verb-policy default pins + default-shape pin + untouched main-table instance; testing section → route-level tier_mismatch pin (the exact gap recon found), read-field tests, FE gating tests; risks table → confirm naming (T6), no-drift-by-construction serializer (T2), prop gating + absence test (T5), burn-in untouched (no main-table edits).
- **Placeholder scan:** the `...` bodies in Task 2/3 test skeletons are explicitly instructed to be written from named existing fixtures at named line numbers; no TBDs remain.
- **Type consistency:** `ParentRetestImpact`/`ParentRetestConfirmState`/`ParentRetestResponse`/`verbPolicy` names and shapes match across Tasks 4→5→6→7; `parent_review_state` naming matches backend schema ↔ FE interface.
