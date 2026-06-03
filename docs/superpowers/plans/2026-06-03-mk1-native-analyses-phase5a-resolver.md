# Mk1-Native Analyses Phase 5a — COA Resolver Default-Path Rewrite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reap the Phase 4 two-tier model's first big win: the COA resolver no longer gathers candidates across vials or asks "which vial wins?" — it reads the supervisor's already-promoted parent-tier `lims_analyses` rows directly. Pins remain as the admin override. Legacy SENAITE-side parent analyses (HPLC analyses that haven't migrated to Mk1 yet) continue to flow through the existing proxy path for any analyte not covered by a Mk1 parent-tier row.

**Architecture:** The resolver gets a Mk1-first dispatch layer. `_resolve_mk1_parent_tier(db, parent)` returns one `SourceDecision(mode='auto')` per `lims_analyses` row WHERE `lims_sample_pk=parent.id AND review_state IN ('verified', 'published') AND reportable=True AND retest_of_id IS NULL`. The existing `_gather_candidates_for` / `_apply_reportable` / `_resolve_analyte` SENAITE path stays but is invoked ONLY for the parent AR (sub-samples no longer queried — Phase 4 routed their decisions through `promote_to_parent`). Pins are applied as a final override layer that can supersede either a Mk1 or SENAITE decision. Decision precedence per analyte: pin > Mk1 parent-tier row > SENAITE legacy decision > missing.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres. Reuses Phase 4a's `lims_analyses` parent-tier rows + `LimsAnalysisPromotion` link table. No FE changes, no schema changes.

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md` §"COA roll-up integration" + §"Pin / manifest as the override path" + §"Phase 5 acceptance" scenario #1 ("Resolver on BW-0013 (Model D family with promoted parent-tier rows) returns auto-resolved SourceDecisions for each analyte; no candidate gathering across vials in the default path."). Pin upsert regen unchanged.

**Predecessors:** Phase 4a (`promote_to_parent` + `lims_analysis_promotions` + parent-tier rows in `lims_analyses`). Phase 1 (`coa_result_pins` + `coa_generation_sources` + the existing resolver).

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (locked in; flag if you disagree before Task 1)

1. **Mk1 parent-tier rows take precedence over SENAITE parent-AR analyses for the same keyword.** Long-term direction is Mk1-replaces-SENAITE; same pattern as Phase 3.5 worksheet inbox + Phase 4b variance-set dual-source. SENAITE-side rows for the same keyword become "shadowed" and don't emit a separate decision.

2. **Sub-samples are NOT queried by the resolver anymore.** Under Phase 4a, sub-sample vial-tier rows feed into `promote_to_parent` which creates the parent-tier row. The resolver reads the parent-tier row directly. The existing `_gather_candidates_for` call for sub-samples is removed. Legacy SENAITE secondary ARs (Phase 2 pivot kept these alive but they were declared "dead-weight cloned analyses" — no value flows from them post-Phase-3).

3. **`reportable` filter stays at the Mk1 row level.** `lims_analyses.reportable` is the source of truth for Phase 4+ rows; the SENAITE-side `analysis_reportable` sidecar continues to apply to legacy SENAITE candidates only. No cross-source bridging.

4. **Pin source can target either `mk1:N` or a SENAITE UID.** Pin override logic checks both. If pin source_analysis_uid starts with `mk1:` and the row still exists + is reportable + verified, mode='pin'. If pin source matches a live SENAITE candidate, mode='pin'. Otherwise → blocked='stale_pin'.

5. **No "missing-required" check in 5a.** The spec's `expected_analytes_for(parent_sample_id)` would require an order-profile lookup that doesn't have a clean implementation today (profile services live in IS). For 5a, the resolver returns decisions only for analytes that have data (Mk1 parent-tier row OR SENAITE candidate). Defer required-analyte check to Phase 5b/5c with the family-state derivation work. The existing `is_blocked` property still surfaces `missing` when a SENAITE-side parent has zero verified analyses.

6. **No FE changes.** The `ResolverResult` / `SourceDecision` Pydantic shapes are unchanged. Existing FE consumers (the COA Sources panel) see the same payload structure — values just resolve more often via mode='auto' now.

7. **All Phase 1 manifest-write semantics preserved.** `coa_generation_sources` continues to write one row per generation per analyte with `resolution_mode` distinguishing `'auto'` (default), `'pin'` (manager override), and `'stale_pin_fallback'`. Phase 5a doesn't touch manifest.py.

If any decision is wrong, redirect before Task 1.

---

## File Structure

**Backend (modified):**
- `backend/coa/source_resolver.py` — add `_resolve_mk1_parent_tier(db, parent)` helper; refactor `resolve_sources` to dispatch Mk1-first, then merge with SENAITE parent-AR path; apply pin override last. Sub-sample SENAITE gathering removed.
- `backend/tests/test_coa_source_resolver.py` — append Phase 5a tests: Mk1-only-parent, mixed-with-SENAITE, Mk1+pin-override, SENAITE+pin-override, shadowing.
- `backend/tests/test_coa_source_resolver_integration.py` (CREATE) — integration tests against the live DB that exercise `resolve_sources` end-to-end with real `lims_analyses` rows seeded via `promote_to_parent`. Mirrors the test_variance_set.py pattern.

**Out of scope (Phase 5b / 5c / later):**
- Family-state derivation endpoint `GET /api/families/{parent_id}/state` (Phase 5b).
- WP signaling event emission (Phase 5c).
- Required-analyte missing check (Phase 5b — needs order-profile lookup design).
- COABuilder `result_sources` request body extension (cross-repo, separate phase).
- Drop SENAITE secondary AR creation entirely (Phase 5c cleanup once WP signaling is detached from SENAITE workflow events).
- Manifest writer changes (`coa_generation_sources` schema unchanged; the existing writer handles `mk1:` UIDs already because Phase 3 already produces them).
- Pin upsert UI (admin override flow — already exists from Phase 1).

---

## How to run tests

- Single file: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Filtered: append `-k <substr>`.
- Full backend: same harness, `tests/`. Baseline at end of Phase 4b: 462 passed (+3 from 458), 27 skipped, 13 baseline failures.

If the backend container was recreated, reinstall pytest:
```bash
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio
```

---

## Task 1: Add `_resolve_mk1_parent_tier` helper (Mk1-first decision source)

**Files:**
- Modify: `backend/coa/source_resolver.py`

- [ ] **Step 1: Append the helper**

In `backend/coa/source_resolver.py`, after `_resolve_analyte` (around line 222) and BEFORE the `# ─── Orchestration ───` section, add:

```python
def _resolve_mk1_parent_tier(
    db: Session,
    parent: LimsSample,
) -> Dict[str, SourceDecision]:
    """Phase 5a: read parent-tier verified rows directly from lims_analyses.

    These rows ARE the canonical results — the supervisor already chose them
    at verification time via promote_to_parent. One SourceDecision per row,
    mode='auto', keyed by analyte_keyword for the merge layer.

    Filters:
      lims_sample_pk = parent.id
      review_state IN ('verified', 'published')
      reportable = TRUE
      retest_of_id IS NULL  (canonical, not a retest sibling)

    Sub-sample rows are intentionally not queried — they fed into the parent
    row at promote time; reading them again would re-introduce the Phase 1
    multi-candidate decision the two-tier model eliminates.
    """
    from models import LimsAnalysis

    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.review_state.in_(("verified", "published")),
            LimsAnalysis.reportable == True,  # noqa: E712 — SQL equality
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalars().all()

    decisions: Dict[str, SourceDecision] = {}
    for r in rows:
        uid = f"mk1:{r.id}"
        candidate = CandidateInfo(
            source_sample_id=parent.sample_id,
            source_analysis_uid=uid,
            value=r.result_value,
            unit=r.result_unit,
            state=r.review_state,
            reportable=True,
            in_variance_set=False,
            is_parent_ar=True,
        )
        decisions[r.keyword] = SourceDecision(
            analyte_keyword=r.keyword,
            mode="auto",
            chosen=ResolvedSource(
                source_sample_id=parent.sample_id,
                source_analysis_uid=uid,
                value=r.result_value,
                unit=r.result_unit,
            ),
            candidates=[candidate],
            blocked=None,
        )
    return decisions
```

- [ ] **Step 2: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from coa.source_resolver import _resolve_mk1_parent_tier
import inspect
print('imports ok; params:', list(inspect.signature(_resolve_mk1_parent_tier).parameters.keys()))
"
```

Expected: `imports ok; params: ['db', 'parent']`

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/coa/source_resolver.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(coa): _resolve_mk1_parent_tier helper for Phase 5a default path

Phase 5a Task 1. Pure helper that returns one SourceDecision per
parent-tier lims_analyses row (filtered for verified/published +
reportable + non-retest). The supervisor already picked the
canonical vial at promote_to_parent time, so each row maps
directly to mode='auto'. Sub-samples not queried.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rewrite `resolve_sources` orchestration to dispatch Mk1-first

**Files:**
- Modify: `backend/coa/source_resolver.py` (the `resolve_sources` function)

- [ ] **Step 1: Replace the orchestration body**

In `backend/coa/source_resolver.py`, locate `async def resolve_sources(parent_sample_id, db, senaite_reader)` (around line 227) and replace its body. The function signature stays the same; only the internals change.

Find:

```python
async def resolve_sources(
    parent_sample_id: str,
    db: Session,
    senaite_reader: SenaiteAnalysesReader,
) -> ResolverResult:
    """
    Gather candidates for the parent + every linked sub-sample, then apply
    the per-analyte decision rule.
    """
    # 1. Load parent + sub-samples from Mk1 DB to know what ARs to fetch.
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()

    sample_ids: List[str] = [parent_sample_id]
    is_parent_lookup: Dict[str, bool] = {parent_sample_id: True}
    variance_lookup: Dict[str, bool] = {
        parent_sample_id: bool(parent.in_variance_set) if parent else True
    }
    if parent:
        subs = db.execute(
            select(LimsSubSample).where(
                LimsSubSample.parent_sample_pk == parent.id
            )
        ).scalars().all()
        for s in subs:
            sample_ids.append(s.sample_id)
            is_parent_lookup[s.sample_id] = False
            variance_lookup[s.sample_id] = bool(s.in_variance_set)

    # 2. Pull analyses for every AR in one round-trip per AR. (Future: bulk
    #    endpoint on the senaite_reader; not premature for Phase 1.)
    reader_payload: Dict[str, List[Dict]] = {}
    for sid in sample_ids:
        reader_payload[sid] = await senaite_reader.list_for_sample(sid)

    # 3. Build candidate map (analyte_keyword -> list[CandidateInfo]) from
    #    every AR's analyses, merging by analyte across ARs.
    merged: Dict[str, List[CandidateInfo]] = {}
    for sid in sample_ids:
        per_ar = _gather_candidates_for(
            sample_id=sid,
            is_parent_ar=is_parent_lookup[sid],
            reader_payload=reader_payload,
            in_variance_set=variance_lookup[sid],
        )
        for kw, cs in per_ar.items():
            merged.setdefault(kw, []).extend(cs)

    # 4. Stamp reportable from the Mk1 sidecar.
    merged = _apply_reportable(db, merged)

    # 5. Decision rule per analyte.
    decisions: List[SourceDecision] = []
    for kw, cs in merged.items():
        decisions.append(_resolve_analyte(kw, cs, db, parent_sample_id))

    return ResolverResult(
        parent_sample_id=parent_sample_id,
        decisions=decisions,
    )
```

Replace with:

```python
async def resolve_sources(
    parent_sample_id: str,
    db: Session,
    senaite_reader: SenaiteAnalysesReader,
) -> ResolverResult:
    """
    Phase 5a: Mk1-first dispatch. Resolution precedence per analyte is:
      1. Pin override (admin path)         → mode='pin' or blocked='stale_pin'
      2. Mk1 parent-tier verified row      → mode='auto' (the happy path)
      3. SENAITE-side parent AR candidate  → existing _resolve_analyte rules
      4. None of the above                 → analyte simply isn't in decisions

    Sub-sample SENAITE ARs are no longer queried — Phase 4a moved their
    decisions into parent-tier rows via promote_to_parent. The supervisor's
    decision is recorded once at promote time, not re-derived per COA gen.
    """
    # 1. Load parent from Mk1 DB.
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()

    # If the parent doesn't exist in Mk1, the SENAITE reader can still
    # surface candidates — fall through with no Mk1 layer.
    mk1_decisions: Dict[str, SourceDecision] = (
        _resolve_mk1_parent_tier(db, parent) if parent else {}
    )

    # 2. Pull SENAITE analyses for the parent AR only. Subs no longer fetched.
    reader_payload: Dict[str, List[Dict]] = {
        parent_sample_id: await senaite_reader.list_for_sample(parent_sample_id)
    }

    # 3. Build SENAITE candidate map (parent AR only).
    senaite_candidates: Dict[str, List[CandidateInfo]] = _gather_candidates_for(
        sample_id=parent_sample_id,
        is_parent_ar=True,
        reader_payload=reader_payload,
        in_variance_set=(bool(parent.in_variance_set) if parent else True),
    )
    senaite_candidates = _apply_reportable(db, senaite_candidates)

    # 4. Merge: every analyte that has a Mk1 row OR a SENAITE candidate.
    all_keywords = set(mk1_decisions.keys()) | set(senaite_candidates.keys())
    decisions: List[SourceDecision] = []
    for kw in sorted(all_keywords):
        # Decide the base (no-pin) decision:
        if kw in mk1_decisions:
            base = mk1_decisions[kw]
        else:
            # Fall through to the legacy decision rule for SENAITE-only analytes.
            base = _resolve_analyte(kw, senaite_candidates[kw], db, parent_sample_id)
        # Layer pin override on top. _apply_pin_override may rewrite mode to
        # 'pin' or 'stale_pin'; otherwise returns base unchanged.
        decisions.append(_apply_pin_override(db, parent_sample_id, kw, base))

    return ResolverResult(
        parent_sample_id=parent_sample_id,
        decisions=decisions,
    )
```

- [ ] **Step 2: Verify import + signature unchanged**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from coa.source_resolver import resolve_sources
import inspect
print('signature:', inspect.signature(resolve_sources))
"
```

Expected: `signature: (parent_sample_id: str, db: sqlalchemy.orm.session.Session, senaite_reader: coa.source_resolver.SenaiteAnalysesReader) -> coa.schemas.ResolverResult`

NOTE: `_apply_pin_override` doesn't exist yet — Task 3 adds it. The import check will pass (Python only resolves at call time) but a call would fail. That's expected; Task 3 completes the orchestration.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/coa/source_resolver.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
refactor(coa): Mk1-first resolver dispatch (sub-samples no longer queried)

Phase 5a Task 2. resolve_sources now dispatches Mk1 parent-tier
rows first, falls through to legacy SENAITE parent-AR candidates
for analytes not covered by Mk1, and layers pin override on top
(_apply_pin_override lands in Task 3).

Sub-sample SENAITE ARs are intentionally no longer fetched —
Phase 4a moved their decisions into parent-tier rows via
promote_to_parent. Net effect: fewer SENAITE round-trips per
COA generation and the multi-candidate decision rule fires
only for analytes still living in SENAITE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `_apply_pin_override` helper (pin layer over base decisions)

**Files:**
- Modify: `backend/coa/source_resolver.py`

- [ ] **Step 1: Append the helper**

In `backend/coa/source_resolver.py`, after `_resolve_mk1_parent_tier` (added in Task 1) and BEFORE the `# ─── Orchestration ───` section, add:

```python
def _apply_pin_override(
    db: Session,
    parent_sample_id: str,
    analyte_keyword: str,
    base: SourceDecision,
) -> SourceDecision:
    """Phase 5a: layer admin pin overrides on top of a Mk1-or-SENAITE base.

    Decision matrix (given a base decision already computed):
      no pin row                  → return base unchanged
      pin.mode != 'pin'           → return base unchanged (treat as 'auto')
      pin source matches base     → mode='pin' (override credited but same value)
      pin source matches another  → mode='pin' with the pinned candidate's value
        live candidate in base       (Mk1 row lookup or SENAITE candidate match)
      pin source no longer valid  → blocked='stale_pin'

    For pins targeting a Mk1 row (uid like 'mk1:N'), we look up the row by
    id and verify it's still verified/published + reportable + non-retest.
    For SENAITE-side pins (32-char hex uid), we match against the base's
    candidates list (which carries SENAITE candidates when the base came
    from _resolve_analyte).
    """
    pin = db.execute(
        select(CoaResultPin).where(
            CoaResultPin.parent_sample_id == parent_sample_id,
            CoaResultPin.analyte_keyword == analyte_keyword,
        )
    ).scalar_one_or_none()
    if pin is None or pin.mode != "pin":
        return base
    if not (pin.source_sample_id and pin.source_analysis_uid):
        return base

    pin_uid = pin.source_analysis_uid
    pin_sid = pin.source_sample_id

    # Mk1 pin path: look up the lims_analyses row directly.
    if pin_uid.startswith("mk1:"):
        from models import LimsAnalysis
        try:
            row_id = int(pin_uid[len("mk1:"):])
        except ValueError:
            return base.model_copy(update={
                "blocked": "stale_pin",
                "blocked_detail": (
                    f"pin source_analysis_uid {pin_uid!r} is not a parseable mk1 id"
                ),
                "chosen": None,
            })
        row = db.get(LimsAnalysis, row_id)
        if (
            row is None
            or row.review_state not in ("verified", "published")
            or not row.reportable
            or row.retest_of_id is not None
            or row.keyword != analyte_keyword
        ):
            return base.model_copy(update={
                "blocked": "stale_pin",
                "blocked_detail": (
                    f"pin on {pin_sid}/{pin_uid} no longer matches a "
                    "reportable verified parent-tier row"
                ),
                "chosen": None,
            })
        return base.model_copy(update={
            "mode": "pin",
            "blocked": None,
            "blocked_detail": None,
            "chosen": ResolvedSource(
                source_sample_id=pin_sid,
                source_analysis_uid=pin_uid,
                value=row.result_value,
                unit=row.result_unit,
            ),
        })

    # SENAITE pin path: match the pinned (sample_id, uid) against base.candidates.
    # base.candidates always carries the candidates the base decision considered
    # (Mk1 path stamps one synthetic candidate; SENAITE path carries the real
    # SENAITE candidates).
    match = next(
        (c for c in base.candidates
         if c.source_sample_id == pin_sid
         and c.source_analysis_uid == pin_uid
         and c.reportable
         and c.state in ("verified", "published")),
        None,
    )
    if match is None:
        return base.model_copy(update={
            "blocked": "stale_pin",
            "blocked_detail": (
                f"pin on {pin_sid}/{pin_uid} no longer matches a "
                "reportable verified candidate"
            ),
            "chosen": None,
        })
    return base.model_copy(update={
        "mode": "pin",
        "blocked": None,
        "blocked_detail": None,
        "chosen": ResolvedSource(
            source_sample_id=pin_sid,
            source_analysis_uid=pin_uid,
            value=match.value,
            unit=match.unit,
        ),
    })
```

- [ ] **Step 2: Verify import + that resolve_sources is now callable end-to-end**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from coa.source_resolver import _apply_pin_override, resolve_sources
import inspect
print('apply_pin_override params:', list(inspect.signature(_apply_pin_override).parameters.keys()))
print('resolve_sources callable: True')
"
```

Expected: `apply_pin_override params: ['db', 'parent_sample_id', 'analyte_keyword', 'base']`

- [ ] **Step 3: Restart backend + smoke `resolve_sources` once**

```bash
cd /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/accumark-stack
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio 2>&1 | tail -1

docker exec accumark-subvial-accu-mk1-backend python -c "
import asyncio
from database import SessionLocal
from coa.source_resolver import resolve_sources

class _FakeReader:
    async def list_for_sample(self, sample_id):
        return []

async def main():
    db = SessionLocal()
    res = await resolve_sources('BW-0013', db, _FakeReader())
    print(f'parent BW-0013: {len(res.decisions)} decisions; is_blocked={res.is_blocked}')
    for d in res.decisions[:5]:
        chosen = d.chosen
        print(f'  {d.analyte_keyword}: mode={d.mode} blocked={d.blocked} '
              f'chosen={chosen.value if chosen else None!r}')
    db.close()

asyncio.run(main())
"
```

Expected: prints a few decisions (or zero if BW-0013 has no Mk1 parent-tier rows yet — Phase 5a's hot path is empty until a promote lands).

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/coa/source_resolver.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(coa): pin override layer for Phase 5a resolver

Phase 5a Task 3. _apply_pin_override layers admin pin decisions
on top of the Mk1-first base decision. Three paths:
  - mk1: pin -> look up lims_analyses row directly (verify still
    verified/published + reportable + non-retest)
  - SENAITE pin -> match against base.candidates
  - no live match -> blocked='stale_pin'

Completes the resolve_sources orchestration started in Task 2;
the function is now callable end-to-end against the live DB.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Existing-test compatibility audit

The Phase 1 resolver tests in `test_coa_source_resolver.py` call `_resolve_analyte` directly with synthetic candidates. They should keep passing — `_resolve_analyte` is unchanged. The orchestration-level tests will need to adapt.

**Files:**
- Modify: `backend/tests/test_coa_source_resolver.py` (verify only)

- [ ] **Step 1: Re-run the existing suite**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_coa_source_resolver.py -v 2>&1 | tail -15"
```

Expected: 8 pre-existing tests still passing (no behavior change in `_resolve_analyte`).

- [ ] **Step 2: Re-run any other resolver-touching test**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_coa_manifest.py tests/test_coa_pins.py -v --tb=short 2>&1 | tail -15"
```

Expected: all pass. If anything fails, STOP and investigate before continuing — Phase 5a's design assumes `_resolve_analyte` semantics are preserved for legacy SENAITE candidates.

If `test_coa_pins.py` doesn't exist, skip it (the pin admin endpoints may live elsewhere; the resolver semantics are the contract).

- [ ] **Step 3: No commit needed (verification-only)**

---

## Task 5: Phase 5a unit tests (Mk1 base + pin override)

**Files:**
- Modify: `backend/tests/test_coa_source_resolver.py`

- [ ] **Step 1: Append Phase 5a tests**

At the end of `backend/tests/test_coa_source_resolver.py`, append:

```python
# ── Phase 5a: _apply_pin_override unit tests ────────────────────────────────


def test_apply_pin_override_no_pin_returns_base_unchanged(db, parent_id, clean_pins):
    from coa.source_resolver import _apply_pin_override
    from coa.schemas import SourceDecision, ResolvedSource
    base = SourceDecision(
        analyte_keyword="IDENTITY_HPLC",
        mode="auto",
        chosen=ResolvedSource(
            source_sample_id=parent_id,
            source_analysis_uid="uid-1",
            value="98.5",
            unit="%",
        ),
        candidates=[_make_candidate(sample_id=parent_id, analysis_uid="uid-1")],
        blocked=None,
    )
    out = _apply_pin_override(db, parent_id, "IDENTITY_HPLC", base)
    assert out is base or out.mode == "auto"
    assert out.chosen and out.chosen.value == "98.5"


def test_apply_pin_override_mk1_pin_with_stale_uid_blocks_stale_pin(db, parent_id, clean_pins):
    """Pin targets a mk1:N row that doesn't exist → blocked='stale_pin'."""
    from coa.source_resolver import _apply_pin_override
    from coa.schemas import SourceDecision
    db.add(CoaResultPin(
        parent_sample_id=parent_id,
        analyte_keyword="IDENTITY_HPLC",
        mode="pin",
        source_sample_id=parent_id,
        source_analysis_uid="mk1:99999999",
    ))
    db.commit()
    base = SourceDecision(
        analyte_keyword="IDENTITY_HPLC", mode="auto", chosen=None,
        candidates=[], blocked=None,
    )
    out = _apply_pin_override(db, parent_id, "IDENTITY_HPLC", base)
    assert out.blocked == "stale_pin"
    assert out.chosen is None


def test_apply_pin_override_mk1_pin_with_unparseable_uid_blocks_stale_pin(db, parent_id, clean_pins):
    """Pin source_analysis_uid is 'mk1:not_an_int' → stale_pin."""
    from coa.source_resolver import _apply_pin_override
    from coa.schemas import SourceDecision
    db.add(CoaResultPin(
        parent_sample_id=parent_id,
        analyte_keyword="IDENTITY_HPLC",
        mode="pin",
        source_sample_id=parent_id,
        source_analysis_uid="mk1:not_an_int",
    ))
    db.commit()
    base = SourceDecision(
        analyte_keyword="IDENTITY_HPLC", mode="auto", chosen=None,
        candidates=[], blocked=None,
    )
    out = _apply_pin_override(db, parent_id, "IDENTITY_HPLC", base)
    assert out.blocked == "stale_pin"


def test_apply_pin_override_senaite_pin_matches_candidate_resolves_to_pin(db, parent_id, clean_pins):
    """Pin targets a SENAITE uid that's still in base.candidates → mode='pin'."""
    from coa.source_resolver import _apply_pin_override
    from coa.schemas import SourceDecision, ResolvedSource
    db.add(CoaResultPin(
        parent_sample_id=parent_id,
        analyte_keyword="IDENTITY_HPLC",
        mode="pin",
        source_sample_id=parent_id,
        source_analysis_uid="senaite-uid-match",
    ))
    db.commit()
    base = SourceDecision(
        analyte_keyword="IDENTITY_HPLC", mode="auto", chosen=None,
        candidates=[
            _make_candidate(sample_id=parent_id, analysis_uid="senaite-uid-match",
                            value="99.0"),
        ],
        blocked="needs_decision",
    )
    out = _apply_pin_override(db, parent_id, "IDENTITY_HPLC", base)
    assert out.blocked is None
    assert out.mode == "pin"
    assert out.chosen is not None
    assert out.chosen.value == "99.0"


def test_apply_pin_override_senaite_pin_no_live_candidate_blocks_stale_pin(db, parent_id, clean_pins):
    """SENAITE pin with no matching candidate in base → stale_pin."""
    from coa.source_resolver import _apply_pin_override
    from coa.schemas import SourceDecision
    db.add(CoaResultPin(
        parent_sample_id=parent_id,
        analyte_keyword="IDENTITY_HPLC",
        mode="pin",
        source_sample_id=parent_id,
        source_analysis_uid="senaite-uid-gone",
    ))
    db.commit()
    base = SourceDecision(
        analyte_keyword="IDENTITY_HPLC", mode="auto", chosen=None,
        candidates=[_make_candidate(sample_id=parent_id, analysis_uid="different-uid")],
        blocked="needs_decision",
    )
    out = _apply_pin_override(db, parent_id, "IDENTITY_HPLC", base)
    assert out.blocked == "stale_pin"
```

- [ ] **Step 2: Run the new tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_coa_source_resolver.py -v -k 'apply_pin_override' 2>&1 | tail -15"
```

Expected: 5 new tests passed.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_coa_source_resolver.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
test(coa): _apply_pin_override unit tests

Phase 5a Task 5. 5 unit tests for the pin override helper: no-pin
returns base, mk1 stale-pin (missing row + unparseable id),
SENAITE pin matches candidate, SENAITE pin no live candidate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Phase 5a integration tests (Mk1 parent-tier rows → resolver)

**Files:**
- Create: `backend/tests/test_coa_source_resolver_integration.py`

Integration tests against the live DB. Seeds a parent-tier row via `promote_to_parent`, drives `resolve_sources` with a fake SENAITE reader, asserts the decision.

- [ ] **Step 1: Create the integration test file**

```python
"""Phase 5a: integration tests for the COA source resolver against the live DB.

Seeds real lims_analyses parent-tier rows (via promote_to_parent) so the
Mk1-first dispatch fires against the production code path. Mirrors
test_variance_set.py / test_lims_analyses_service.py conventions: each
test cleans up its TEST: titled rows after running.
"""

from __future__ import annotations

import asyncio
from typing import Dict, List

import pytest
from sqlalchemy import delete, select, func

from coa.source_resolver import resolve_sources
from database import SessionLocal
from lims_analyses.service import (
    apply_transition, create_analysis, promote_to_parent,
)
from models import (
    AnalysisService,
    CoaResultPin,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)


class _FakeSenaiteReader:
    """Test double — returns whatever the test set up in `payload`."""

    def __init__(self, payload: Dict[str, List[dict]] | None = None):
        self.payload = payload or {}

    async def list_for_sample(self, sample_id: str) -> List[dict]:
        return list(self.payload.get(sample_id, []))


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def clean_sub(db, analysis_service):
    """Find a sub-sample with no non-retest row for the analysis_service's
    keyword. Returns the sub OR skips."""
    stmt = (
        select(LimsSubSample)
        .where(~select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id,
            LimsAnalysis.keyword == analysis_service.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        ).exists())
    )
    sub = db.execute(stmt).scalars().first()
    if sub is None:
        pytest.skip("no sub-sample free of keyword")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    """Wipe any TEST: titled rows + their cascades after each test."""
    yield
    # Promotions first (no cascade from analyses-via-source if source still exists)
    db.execute(delete(LimsAnalysisPromotion).where(
        LimsAnalysisPromotion.parent_analysis_id.in_(
            select(LimsAnalysis.id).where(LimsAnalysis.title.like("TEST:%"))
        )
    ))
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.reason.like("TEST:%")
    ))
    db.execute(delete(LimsAnalysis).where(LimsAnalysis.title.like("TEST:%")))
    db.commit()


def _make_vial_to_be_verified(db, sub, svc, result="98.55"):
    """Create a vial-tier analysis on `sub` for `svc` + walk to to_be_verified."""
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=sub.id,
        analysis_service_id=svc.id, keyword=svc.keyword,
        title=f"TEST: integration {svc.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: integration assign")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value=result, reason="TEST: integration submit")
    return row


def _promote_to_parent_row(db, src, svc, value):
    """Promote `src` to a parent-tier row, return the parent_row."""
    parent_row, _ = promote_to_parent(
        db, keyword=svc.keyword, result_value=value, result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
        reason="TEST: integration promote",
    )
    parent_row.title = "TEST: parent " + parent_row.title
    db.commit()
    return parent_row


# ── Tests ────────────────────────────────────────────────────────────────────


def test_resolve_sources_returns_mode_auto_for_promoted_parent_tier_row(db, clean_sub, analysis_service):
    """Spec Phase 5 acceptance #1: a Model D family with a promoted parent-tier
    row resolves to mode='auto' with no SENAITE round-trip needed for that analyte."""
    src = _make_vial_to_be_verified(db, clean_sub, analysis_service)
    parent_row = _promote_to_parent_row(db, src, analysis_service, "98.55")
    parent = db.get(LimsSample, parent_row.lims_sample_pk)
    assert parent is not None

    reader = _FakeSenaiteReader()  # empty — SENAITE has nothing for this parent
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching, f"no decision for {analysis_service.keyword!r}; got {[d.analyte_keyword for d in res.decisions]}"
    d = matching[0]
    assert d.mode == "auto"
    assert d.blocked is None
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == f"mk1:{parent_row.id}"
    assert d.chosen.value == "98.55"


def test_resolve_sources_does_not_query_sub_sample_senaite_ars(db, clean_sub, analysis_service):
    """A sub-sample with a SENAITE candidate but NO Mk1 parent-tier row
    produces no decision for that analyte under Phase 5a (sub ARs aren't
    queried; the only SENAITE data the resolver consults is the parent AR)."""
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)
    fake_payload = {
        # SENAITE returns a verified candidate on the SUB, NOT the parent
        clean_sub.sample_id: [
            {"uid": "should-not-be-read", "keyword": analysis_service.keyword,
             "result": "ignored", "unit": "%", "review_state": "verified"},
        ],
        parent.sample_id: [],  # parent AR has nothing
    }
    reader = _FakeSenaiteReader(payload=fake_payload)
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching == [], (
        f"expected no decision for {analysis_service.keyword!r} (sub-sample SENAITE "
        f"candidates ignored under Phase 5a); got {matching}"
    )


def test_resolve_sources_mk1_parent_tier_shadows_senaite_parent_candidate(db, clean_sub, analysis_service):
    """If both a Mk1 parent-tier row AND a SENAITE parent-AR candidate exist
    for the same keyword, the Mk1 row wins (mode='auto', uid=mk1:N)."""
    src = _make_vial_to_be_verified(db, clean_sub, analysis_service)
    parent_row = _promote_to_parent_row(db, src, analysis_service, "98.55")
    parent = db.get(LimsSample, parent_row.lims_sample_pk)

    fake_payload = {
        parent.sample_id: [
            {"uid": "senaite-uid-shadowed", "keyword": analysis_service.keyword,
             "result": "99.99", "unit": "%", "review_state": "verified"},
        ],
    }
    reader = _FakeSenaiteReader(payload=fake_payload)
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    decisions_for_kw = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert len(decisions_for_kw) == 1
    d = decisions_for_kw[0]
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == f"mk1:{parent_row.id}"
    assert d.chosen.value == "98.55"  # Mk1's value, not SENAITE's "99.99"


def test_resolve_sources_senaite_only_parent_uses_legacy_path(db, analysis_service):
    """A parent with NO Mk1 parent-tier row but a SENAITE candidate falls
    through to _resolve_analyte → mode='auto' with the SENAITE uid."""
    parent = db.execute(select(LimsSample).limit(1)).scalars().first()
    if parent is None:
        pytest.skip("no parent samples in DB")
    # Skip if this parent happens to have a Mk1 row for this keyword
    existing = db.execute(
        select(func.count(LimsAnalysis.id)).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.keyword == analysis_service.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalar()
    if existing > 0:
        pytest.skip("parent already has a Mk1 row for the keyword")

    fake_payload = {
        parent.sample_id: [
            {"uid": "senaite-legacy-uid", "keyword": analysis_service.keyword,
             "result": "42.0", "unit": "%", "review_state": "verified"},
        ],
    }
    reader = _FakeSenaiteReader(payload=fake_payload)
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching, "expected a decision from the SENAITE legacy path"
    d = matching[0]
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == "senaite-legacy-uid"
    assert d.chosen.value == "42.0"


def test_resolve_sources_mk1_pin_override_supersedes_default(db, clean_sub, analysis_service):
    """A pin targeting a different Mk1 row supersedes the default parent-tier row."""
    src1 = _make_vial_to_be_verified(db, clean_sub, analysis_service, result="98.55")
    parent_row = _promote_to_parent_row(db, src1, analysis_service, "98.55")
    parent = db.get(LimsSample, parent_row.lims_sample_pk)

    # Insert a second parent-tier row simulating an override — direct insert
    # since promote_to_parent would hit the unique index. Mark with TEST: title.
    override_row = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title="TEST: parent override " + (analysis_service.title or analysis_service.keyword),
        result_value="99.99",
        review_state="verified",
        retest_of_id=parent_row.id,  # treat as a "retest" so partial unique doesn't fire
    )
    db.add(override_row)
    db.flush()
    db.add(LimsAnalysisTransition(
        analysis_id=override_row.id, from_state=None, to_state="verified",
        transition_kind="auto", user_id=None, reason="TEST: override insert",
    ))
    # Pin the override
    db.add(CoaResultPin(
        parent_sample_id=parent.sample_id,
        analyte_keyword=analysis_service.keyword,
        mode="pin",
        source_sample_id=parent.sample_id,
        source_analysis_uid=f"mk1:{override_row.id}",
    ))
    db.commit()

    reader = _FakeSenaiteReader()
    res = asyncio.run(resolve_sources(parent.sample_id, db, reader))

    matching = [d for d in res.decisions if d.analyte_keyword == analysis_service.keyword]
    assert matching, "expected a decision"
    d = matching[0]
    assert d.mode == "pin"
    assert d.chosen is not None
    assert d.chosen.source_analysis_uid == f"mk1:{override_row.id}"
    assert d.chosen.value == "99.99"

    # Cleanup pin (analysis cleanup is handled by autouse)
    db.execute(delete(CoaResultPin).where(
        CoaResultPin.parent_sample_id == parent.sample_id,
        CoaResultPin.analyte_keyword == analysis_service.keyword,
    ))
    db.commit()
```

- [ ] **Step 2: Run the integration tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_coa_source_resolver_integration.py -v 2>&1 | tail -15"
```

Expected: 5 tests, at least 3 pass (the cross-keyword / no-clean-sub fixtures may skip in a stack with limited test data). If anything UNEXPECTEDLY fails, STOP — don't paper over.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_coa_source_resolver_integration.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
test(coa): Phase 5a resolver integration tests

Phase 5a Task 6. 5 integration tests against the live DB: Mk1
parent-tier row -> mode='auto', sub-sample SENAITE candidates
ignored, Mk1 row shadows SENAITE for same keyword, SENAITE-only
parent falls through to legacy path, mk1 pin override
supersedes the default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Full suite + live HTTP smoke

Verification-only — no commit.

- [ ] **Step 1: Full backend suite**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/ -q --tb=no 2>&1 | tail -5"
```

Expected: ≥ 467 passed (was 462 at end of Phase 4b; +5 pin override unit + 3-5 integration = 8-10 new minus skips). Floor: 465. 13 baseline failures unchanged. Zero regressions.

- [ ] **Step 2: End-to-end HTTP smoke through `resolve_sources`**

Mimics what `/wizard/senaite/samples/{sample_id}/generate-coa` triggers during the pre-flight resolver call.

```bash
docker exec accumark-subvial-accu-mk1-backend bash -c "cat > /app/_smoke_p5a.py << 'PYEOF'
import asyncio
from sqlalchemy import select, delete, text
from database import SessionLocal
from models import (
    LimsSample, LimsSubSample, LimsAnalysis, LimsAnalysisTransition,
    LimsAnalysisPromotion,
)
from sub_samples.photo_storage import get_storage
from sub_samples import service as ss, senaite
from lims_analyses.service import apply_transition, promote_to_parent
from coa.source_resolver import resolve_sources


class _FakeReader:
    async def list_for_sample(self, sample_id):
        return []


# Setup: fresh vial + endo result + promote → parent-tier row
db = SessionLocal()
parent = db.execute(select(LimsSample).where(LimsSample.sample_id == 'PB-0071')).scalar_one()
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000004949454e44ae426082')
sub = ss.create_sub_sample(db, parent.sample_id, png, 'p5a.png', 'P5a smoke', 1)
ss.set_assignment_role(db, sub.sample_id, 'endo')
db.refresh(sub)
endo = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == sub.id)).scalars().first()
apply_transition(db, analysis_id=endo.id, kind='assign', reason='smoke')
apply_transition(db, analysis_id=endo.id, kind='submit', result_value='<0.5 EU/mg', reason='smoke')
parent_row, _ = promote_to_parent(
    db, keyword=endo.keyword, result_value='<0.5 EU/mg', result_unit='EU/mg',
    method_id=None, instrument_id=None,
    sources=[{'analysis_id': endo.id, 'contribution_kind': 'chosen'}],
    reason='smoke',
)
print(f'setup: sub={sub.sample_id} parent_row.id={parent_row.id} keyword={endo.keyword}')

# Run resolver
res = asyncio.run(resolve_sources(parent.sample_id, db, _FakeReader()))
print(f'decisions: {len(res.decisions)}; is_blocked={res.is_blocked}')
for d in res.decisions:
    if d.analyte_keyword == endo.keyword:
        chosen = d.chosen
        print(f'  ENDO-LAL decision: mode={d.mode} blocked={d.blocked} '
              f'uid={chosen.source_analysis_uid if chosen else None!r} '
              f'value={chosen.value if chosen else None!r}')
db.close()

# Cleanup
db = SessionLocal()
db.execute(text('DELETE FROM lims_analyses WHERE id = :id'), {'id': parent_row.id})
get_storage().delete_photo(sub.photo_external_uid[len('mk1://'):])
aids = db.execute(select(LimsAnalysis.id).where(LimsAnalysis.lims_sub_sample_pk == sub.id)).scalars().all()
if aids:
    db.execute(delete(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id.in_(aids)))
    db.execute(delete(LimsAnalysis).where(LimsAnalysis.id.in_(aids)))
db.execute(delete(LimsSubSample).where(LimsSubSample.id == sub.id))
db.commit()
try:
    senaite.delete_secondary(sub.external_lims_uid)
except Exception:
    pass
db.close()
print('CLEAN')
PYEOF
python /app/_smoke_p5a.py; rc=\$?; rm -f /app/_smoke_p5a.py; exit \$rc"
```

Expected:
- `setup: sub=PB-0071-S<N> parent_row.id=<P> keyword=ENDO-LAL`
- `decisions: 1; is_blocked=False`
- `ENDO-LAL decision: mode=auto blocked=None uid='mk1:<P>' value='<0.5 EU/mg'`
- `CLEAN`

- [ ] **Step 3: psql sanity — sub-sample-tier rows are not feeding decisions**

A targeted check that the resolver is no longer multi-querying SENAITE per sub. Tail backend log during the smoke and confirm only ONE SENAITE list_for_sample call per generate-coa (was: 1 + N subs). If you have access to the backend logs:

```bash
docker logs --tail 50 accumark-subvial-accu-mk1-backend 2>&1 | grep -i "list_for_sample\|/Analysis" | tail -10
```

Expected: at most 1 entry per smoke run (parent AR only). Note: this is opportunistic — the smoke uses `_FakeReader` so production SENAITE isn't hit; this step is for the real-stack path via generate-coa.

---

## Verification (Phase 5a acceptance)

- [ ] **`_resolve_mk1_parent_tier` returns one mode='auto' SourceDecision per parent-tier verified row** (Task 1 + Task 6 integration test #1)
- [ ] **`resolve_sources` consults Mk1 parent-tier rows first; sub-sample SENAITE ARs no longer queried** (Task 2 + Task 6 integration test #2)
- [ ] **Mk1 row shadows SENAITE for the same keyword (Mk1 wins)** (Task 6 integration test #3)
- [ ] **Parents with NO Mk1 row + a SENAITE candidate fall through to `_resolve_analyte` (legacy path preserved)** (Task 6 integration test #4)
- [ ] **`_apply_pin_override` for a mk1: pin targeting a live row → mode='pin' with that row's value** (Task 6 integration test #5)
- [ ] **`_apply_pin_override` for a mk1: pin targeting a missing/non-verified row → blocked='stale_pin'** (Task 5 unit test #2)
- [ ] **`_apply_pin_override` for a SENAITE pin matching a candidate → mode='pin'** (Task 5 unit test #4)
- [ ] **Existing `_resolve_analyte` tests still pass** (Task 4)
- [ ] **Existing `test_coa_manifest.py` tests still pass** (Task 4)
- [ ] **Full backend suite ≥ 465 passed, 13 baseline failures unchanged, zero regressions** (Task 7 Step 1)
- [ ] **Live `resolve_sources` smoke returns mode='auto' for a promoted endo vial** (Task 7 Step 2)

---

## Risks and unknowns

- **The current `_resolve_analyte` logic accepts a `parent_sample_id` arg that's used for the pin lookup.** Under Phase 5a, pin lookup moves to `_apply_pin_override`. The old in-line pin logic at the bottom of `_resolve_analyte` becomes dead code for the legacy SENAITE path (since `_apply_pin_override` will run on every decision regardless of source). This is fine — the in-line pin logic returns `mode='auto'` blocked='needs_decision' for >1 eligible without pin, which is still the correct fallback for SENAITE-only analytes. But pin RESOLUTION on legacy SENAITE will hit BOTH the old in-line code AND `_apply_pin_override`. Risk: double-apply of pin → no behavior change (idempotent) but worth flagging. If a future cleanup wants to remove the in-line pin code in `_resolve_analyte`, that's a separate phase.

- **The new `_resolve_mk1_parent_tier` writes `is_parent_ar=True` on the synthetic candidate.** This is technically correct (it's a parent-tier Mk1 row, not a sub-sample-tier row) but `is_parent_ar` was historically a SENAITE-AR concept. The field is descriptive only; nothing downstream branches on it for Mk1 rows. If we want true source-discrimination we'd need a new field (Phase 6+ candidate per spec Open Question 4).

- **Pin precedence is "pin wins over everything".** A pin can override a Mk1 parent-tier row that has a perfectly valid value. That's by design (admin override) but worth documenting in the resolver docstring. If a manager pins the wrong vial, the parent-tier row is still in the DB — they can clear the pin to revert.

- **The integration tests use `parent_with_subs`-style fixtures.** If the live stack's `lims_sub_samples` table is empty (fresh dev environment), the fixtures skip. Floor of ≥ 465 in Task 7 Step 1 already accounts for this.

- **`resolve_sources` no longer fetches sub-sample SENAITE data**, so any SENAITE-side reportable flag flipped on a sub-sample analysis is silently ignored. This is consistent with Phase 3+ where Mk1 owns the reportable flag for sub-sample analyses, but worth flagging if anyone relied on sidecar overrides for sub-samples post-Phase-3.

## Open questions (carried forward)

1. **`expected_analytes_for(parent_sample_id)`** — the spec's required-analyte check. Deferred to Phase 5b along with the family-state derivation work.
2. **Drop in-line pin logic in `_resolve_analyte`** — clean once `_apply_pin_override` is proven in production. Phase 5b or later.
3. **Pin's `mode='variance_set'`** — not implemented in Phase 1, listed in the `ResolutionMode` literal. Phase 4b's variance promote path handles the variance case at promote time, not at resolve time, so this mode may never be needed. Document + drop in a future cleanup.

## Out of scope (carried forward)

- Family-state derivation endpoint `GET /api/families/{parent_id}/state` — Phase 5b.
- WP signaling event emission — Phase 5c (cross-repo Mk1 + IS + WP).
- Required-analyte missing check — Phase 5b.
- Drop SENAITE secondary AR entirely — Phase 5c cleanup.
- COABuilder `result_sources` request body extension — separate cross-repo phase.
- Prelim-COA opt-in customer flow — Phase 6.
