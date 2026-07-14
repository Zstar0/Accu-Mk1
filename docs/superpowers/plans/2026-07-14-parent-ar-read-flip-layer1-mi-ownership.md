# Parent-AR Read-Flip — Layer 1: Method/Instrument Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lims_analyses.method_id`/`instrument_id` Mk1-owned on every row (including `provenance='shadow'`): the parent-analysis mirror and the shadow backfill stop writing them, so native M/I values can never be clobbered by SENAITE-derived data.

**Architecture:** Three write sites lose their M/I pass-through: (1) the A4 proxy endpoint's mirror call in `main.py`, (2) the `_mirror_parent_analysis_bg` uid-resolution block + `mirror_parent_analysis` params in `parent_mirror.py`, (3) the shadow backfill's `resolve_instrument_id` call. The native write path (`service.set_method_instrument`, prep bridge, promote) is untouched — it is already correct. No FE change (the `mk1:<id>` routing in `api.ts` ships already; the Layer-4 builder will use it).

**Tech Stack:** FastAPI + SQLAlchemy backend, pytest (live dev DB, TEST-prefixed rows). Worktree: `C:\tmp\Accu-Mk1-parent-readflip`, branch `feat/parent-ar-read-flip`. Backend tests run in a laptop container bind-mounted to this worktree (create as `readflip-test` the same way `state-system-test` was, or run pytest locally if the dev DB env is configured).

**Spec:** `docs/superpowers/specs/2026-07-14-parent-ar-read-flip-design.md` §5.

## Global Constraints

- Additive-only posture: no schema changes in this layer; behavior change is *removal of unwanted writes* only.
- `senaite`-mode UX unchanged: the A4 proxy endpoint still updates SENAITE and still returns the same response shape; only its shadow-side M/I copy stops.
- Mirror invariants hold: mirror calls never raise into the request path; state/result mirroring continues exactly as before.
- Gate: backend full-suite failure-set must diff clean against the 60-name baseline (`C:\Users\forre\Downloads\Obsidian\TerraVex\TerraVex\Sessions\handoffs\gate-backend-failures-v140-master.txt`).
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01L7mtRqLeMEzMfN5oCSUxAA`

---

### Task 1: Remove the M/I pass-through from the mirror path (A4 + bg wrapper + mirror fn)

**Files:**
- Modify: `backend/main.py:14201-14206` (A4 proxy's mirror call — drop two kwargs)
- Modify: `backend/main.py:13914-13952` (`_mirror_parent_analysis_bg` — remove uid-resolution block)
- Modify: `backend/main.py:8793` (comment referencing `resolve_instrument_id`'s note — reword)
- Modify: `backend/lims_analyses/parent_mirror.py` (delete `resolve_method_id` + `resolve_instrument_id`; remove `method_id`/`instrument_id` params and writes from `mirror_parent_analysis`)
- Test: `backend/tests/test_parent_mirror_hooks.py` (rewrite the two Task-6/A4 tests at ~line 606-673)

**Interfaces:**
- Consumes: existing fixtures `db`, `seed_parent_and_service`, `seed_method_instrument`, helpers `_mock_senaite_update`, `_client()` in `test_parent_mirror_hooks.py`; `service.set_method_instrument(db, analysis_id=..., method_id=..., instrument_id=..., user_id=...)`.
- Produces: `mirror_parent_analysis(db, *, sample_id, keyword, ...)` **without** `method_id`/`instrument_id` params — Task 2's backfill edit and the Layer-4 reconcile rider rely on this narrowed signature.

- [ ] **Step 1: Rewrite the two A4 tests as ownership tests (RED)**

In `backend/tests/test_parent_mirror_hooks.py`, replace `test_method_instrument_mirrors_resolved_ids` and `test_method_instrument_unresolvable_uids_writes_row_with_none` (the whole Task-6 section, ~lines 606-673) with:

```python
def test_method_instrument_proxy_never_writes_shadow_mi(
        db, seed_parent_and_service, seed_method_instrument):
    """Ownership rule (read-flip spec §5): method_id/instrument_id are
    Mk1-OWNED on every lims_analyses row. The A4 proxy still updates SENAITE
    and still mirrors state, but never copies M/I onto the shadow — even when
    the uids resolve to real Mk1 rows."""
    parent, svc = seed_parent_and_service
    method, instrument = seed_method_instrument
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword=svc.keyword,
        get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-1/method-instrument",
                json={
                    "method_uid": method.senaite_id,
                    "instrument_uid": instrument.senaite_uid,
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is True

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    # state still mirrors; M/I never does
    assert row.mirror_review_state == "to_be_verified"
    assert row.method_id is None
    assert row.instrument_id is None


def test_method_instrument_proxy_preserves_native_mi(
        db, seed_parent_and_service, seed_method_instrument):
    """A natively-set M/I value on the shadow row survives an A4 proxy call
    that would previously have overwritten it with the SENAITE-derived id."""
    from lims_analyses import service as la_service

    parent, svc = seed_parent_and_service
    method, instrument = seed_method_instrument

    # First proxy call creates the shadow row (state-only mirror).
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword=svc.keyword,
        get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            _client().post(
                "/wizard/senaite/analyses/UID-1/method-instrument",
                json={"method_uid": None, "instrument_uid": None},
            )
    finally:
        proxy.stop()

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()

    # Native write (the path that must win forever).
    la_service.set_method_instrument(
        db, analysis_id=row.id,
        method_id=method.id, instrument_id=instrument.id, user_id=None,
    )

    # Second proxy call carries DIFFERENT resolvable uids.
    proxy = _mock_senaite_update(
        review_state="verified", keyword=svc.keyword,
        get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-1/method-instrument",
                json={
                    "method_uid": method.senaite_id,
                    "instrument_uid": instrument.senaite_uid,
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    db.expire_all()
    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    # state healed by the mirror; native M/I untouched
    assert row.mirror_review_state == "verified"
    assert row.method_id == method.id
    assert row.instrument_id == instrument.id
```

Keep the section banner comment but retitle it:
`# Task 6: hook A4 — M/I ownership (mirror never writes method/instrument)`.

- [ ] **Step 2: Run the two tests to verify they fail**

Run: `python -m pytest tests/test_parent_mirror_hooks.py -q -k "method_instrument"`
Expected: `test_method_instrument_proxy_never_writes_shadow_mi` FAILS (instrument_id lands as `instrument.id`, not None). `test_method_instrument_proxy_preserves_native_mi` FAILS on the final `instrument_id` assert.

- [ ] **Step 3: Remove the pass-through in `backend/main.py`**

At `main.py:14201-14206`, drop the two kwargs from the A4 mirror call:

```python
            if _sid and _kw:
                await run_in_threadpool(
                    _mirror_parent_analysis_bg,
                    sample_id=_sid, keyword=_kw,
                    mirror_review_state=item.get("review_state"),
                )
```

In `_mirror_parent_analysis_bg` (`main.py:13914`), delete the resolution block —
remove these lines from the `try:` body:

```python
        from lims_analyses.parent_mirror import (
            mirror_parent_analysis, resolve_instrument_id, resolve_method_id,
        )
        method_uid = kwargs.pop("method_uid", None)
        instrument_uid = kwargs.pop("instrument_uid", None)
        db = SessionLocal()
        method_id = resolve_method_id(db, method_uid)
        instrument_id = resolve_instrument_id(db, instrument_uid)
        if method_id is not None:
            kwargs["method_id"] = method_id
        if instrument_id is not None:
            kwargs["instrument_id"] = instrument_id
```

and replace with:

```python
        from lims_analyses.parent_mirror import mirror_parent_analysis
        db = SessionLocal()
```

Rewrite the docstring's middle paragraph (the one starting "Accepts optional
`method_uid`/`instrument_uid`") to:

```python
    method_id/instrument_id are Mk1-OWNED (read-flip spec §5): this wrapper
    and mirror_parent_analysis never write them. The A4 proxy used to pass
    method_uid/instrument_uid for shadow-side resolution — removed 2026-07-14;
    the native path (service.set_method_instrument, prep bridge, promote) is
    the only M/I writer.
```

At `main.py:8793`, reword the comment so it no longer references the deleted
resolver (keep the factual content):

```python
    # unique — Instrument.senaite_uid has no unique constraint, hence
    # order_by + first()).
```

- [ ] **Step 4: Narrow `mirror_parent_analysis` and delete the resolvers in `backend/lims_analyses/parent_mirror.py`**

Delete `resolve_method_id` (lines ~21-42) and `resolve_instrument_id`
(lines ~44-~60) entirely. In `mirror_parent_analysis`, remove the
`method_id: Optional[int] = None,` and `instrument_id: Optional[int] = None,`
parameters (lines ~118-119) and the write block (lines ~201-204):

```python
    if method_id is not None:
        row.method_id = method_id
    if instrument_id is not None:
        row.instrument_id = instrument_id
```

Add one line to the function docstring:

```
    method_id/instrument_id are Mk1-owned (read-flip spec §5) — this mirror
    never reads or writes them.
```

Remove `Optional[int]` imports only if now unused (check with a quick grep of
the file — other params use Optional, so likely keep).

- [ ] **Step 5: Run the rewritten tests + the whole hooks file**

Run: `python -m pytest tests/test_parent_mirror_hooks.py -q`
Expected: PASS (all — the two new ownership tests plus every pre-existing hook test; A1/A2/A3 hooks never passed M/I kwargs, so nothing else breaks).

- [ ] **Step 6: Grep for orphaned references**

Run: `grep -rn "resolve_method_id\|resolve_instrument_id\|method_uid=req\|instrument_uid=req" backend/ --include="*.py" | grep -v tests`
Expected: only `main.py`'s A4 request-model/payload lines (`req.method_uid` writing the SENAITE payload — those stay); zero references to the deleted resolvers.

- [ ] **Step 7: Commit**

```bash
git add backend/main.py backend/lims_analyses/parent_mirror.py backend/tests/test_parent_mirror_hooks.py
git commit -m "feat(readflip-l1): M/I ownership — mirror path never writes method/instrument

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01L7mtRqLeMEzMfN5oCSUxAA"
```

---

### Task 2: Remove instrument extraction from the shadow backfill

**Files:**
- Modify: `backend/scripts/backfill_parent_analysis_shadows.py` (drop `resolve_instrument_id` import + `instrument_id=` kwarg at ~lines 81, 227-233; update the "Known gap" docstring at ~lines 51-54)
- Modify: `backend/sub_samples/senaite.py` (`fetch_parent_analyses` — remove the `instrument_uid` field from the projection; it has no consumers after this task)
- Test: `backend/tests/test_backfill_parent_analysis_shadows.py`

**Interfaces:**
- Consumes: Task 1's narrowed `mirror_parent_analysis` signature (no M/I params — passing them now raises `TypeError`, which is exactly why this task must remove the backfill's kwarg).
- Produces: backfill/reconcile core that is M/I-blind — the Layer-4 nightly reconcile rider reuses it as-is.

- [ ] **Step 1: Rewrite the instrument test as ownership tests (RED)**

Replace `test_backfill_resolves_instrument_uid_onto_shadow_row` (~line 361) with:

```python
def test_backfill_never_writes_instrument(
        db, checkpoint_from_now, two_analysis_services, seeded_instrument):
    """Ownership rule (read-flip spec §5): the backfill mirrors state/result
    but never writes method_id/instrument_id — even when the SENAITE line
    carries a resolvable instrument uid."""
    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)

    items = [_item("A", svc_a.keyword, result="1",
                   instrument_uid=seeded_instrument.senaite_uid)]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items):
        _run(checkpoint_from_now)

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id, provenance="shadow"
    ).one()
    assert row.instrument_id is None
    assert row.method_id is None


def test_backfill_preserves_native_mi_on_update(
        db, checkpoint_from_now, two_analysis_services, seeded_instrument):
    """Re-running the backfill over a shadow row that has natively-set M/I
    (the Layer-4 reconcile-rider scenario) must leave those values untouched
    while still updating result/state."""
    from lims_analyses import service as la_service

    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-NATIVE-MI", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-2")
    db.add(parent); db.commit(); db.refresh(parent)

    items = [_item("A", svc_a.keyword, result="OLD")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items):
        _run(checkpoint_from_now)

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id, provenance="shadow"
    ).one()
    la_service.set_method_instrument(
        db, analysis_id=row.id,
        method_id=None, instrument_id=seeded_instrument.id, user_id=None,
    )

    items = [_item("A", svc_a.keyword, result="NEW",
                   instrument_uid="TEST-SOME-OTHER-UID")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items):
        _run(checkpoint_from_now)

    db.expire_all()
    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id, provenance="shadow"
    ).one()
    assert row.result_value == "NEW"                      # mirror still mirrors
    assert row.instrument_id == seeded_instrument.id      # native M/I survives
```

Note: `_item(...)` already accepts `instrument_uid=` (existing helper). After
Step 3 strips `instrument_uid` from the `fetch_parent_analyses` projection,
`_item` passing it through the patched fetch is still fine — the backfill
simply no longer looks at it.

- [ ] **Step 2: Run to verify the first fails**

Run: `python -m pytest tests/test_backfill_parent_analysis_shadows.py -q -k "instrument or native_mi"`
Expected: `test_backfill_never_writes_instrument` FAILS (`instrument_id == seeded_instrument.id`); `test_backfill_preserves_native_mi_on_update` FAILS (clobbered — resolve of "TEST-SOME-OTHER-UID" returns None so the mirror's None-guard may actually preserve it; if it passes for that reason, keep it — it locks the behavior regardless).

- [ ] **Step 3: Implement**

In `backend/scripts/backfill_parent_analysis_shadows.py`:
- Line ~81: change the import to `from lims_analyses.parent_mirror import (mirror_parent_analysis, resolve_shadow_target, ...)` — drop `resolve_instrument_id` (keep the others currently imported).
- Lines ~227-233: delete `instrument_id = resolve_instrument_id(db, line.get("instrument_uid"))` and the `instrument_id=instrument_id,` kwarg from the `mirror_parent_analysis(...)` call.
- Replace the "Known gap" docstring paragraph (~lines 51-54) with:

```
M/I ownership (read-flip spec §5, 2026-07-14): method_id/instrument_id are
Mk1-owned columns — this backfill (and the reconcile rider built on it)
never reads or writes them. The native writers are the vial picker, the
prep bridge, and promote_to_parent.
```

In `backend/sub_samples/senaite.py` `fetch_parent_analyses` (~line 261): remove
the `instrument_uid` key from the projected dict (the nested-`Instrument`
extraction block). In `backend/tests/test_backfill_parent_analysis_shadows.py`,
delete `test_fetch_parent_analyses_instrument_uid_from_nested_instrument_object`
(~line 248) — the projection no longer carries the field.

- [ ] **Step 4: Run the backfill suite**

Run: `python -m pytest tests/test_backfill_parent_analysis_shadows.py -q`
Expected: PASS (all remaining tests).

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/backfill_parent_analysis_shadows.py backend/sub_samples/senaite.py backend/tests/test_backfill_parent_analysis_shadows.py
git commit -m "feat(readflip-l1): backfill/reconcile core is M/I-blind

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01L7mtRqLeMEzMfN5oCSUxAA"
```

---

### Task 3: Layer gate — mirror suites + full-suite failure-set diff + push

**Files:**
- No source changes. Test-run + push only.

**Interfaces:**
- Consumes: Tasks 1-2 committed on `feat/parent-ar-read-flip`.
- Produces: pushed branch, gate evidence for the layer's PR.

- [ ] **Step 1: Run the slice-2 mirror suites (the blast-radius set)**

Run: `python -m pytest tests/test_parent_mirror_hooks.py tests/test_parent_mirror_helper.py tests/test_parent_mirror_fail_closed.py tests/test_parent_mirror_schema.py tests/test_backfill_parent_analysis_shadows.py tests/test_lims_analyses_service.py tests/test_lims_analyses_routes.py -q`
Expected: failure set limited to the known baseline names in
`test_lims_analyses_service.py`/`test_lims_analyses_routes.py` (they appear in
the 60-name baseline); all mirror/backfill files fully green.

- [ ] **Step 2: Full-suite failure-set diff**

Run: `python -m pytest tests/ -q --tb=no 2>&1 | grep '^FAILED' | sed 's/^FAILED //;s/ .*$//' | sort > /tmp/gate-l1.txt`
Then: `diff <(sed 's/^FAILED //;s/ .*$//' "C:\Users\forre\Downloads\Obsidian\TerraVex\TerraVex\Sessions\handoffs\gate-backend-failures-v140-master.txt" | sort) /tmp/gate-l1.txt`
Expected: empty diff (byte-identical failure set). Any new name = stop and fix before pushing.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/parent-ar-read-flip
```

Expected: branch on origin; no PR yet (stacked-PR review happens at layer
boundaries per the spec's packaging decision — Handler-gated).
