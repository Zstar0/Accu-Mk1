# Promote Per-Substance Keyword Translation — Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Promoting a vial's per-substance `PUR_<X>`/`QTY_<X>` result writes back to the parent AR's matching `ANALYTE-{slot}` line (and stores the Mk1 parent-tier row under `ANALYTE-{slot}`), so purity/quantity promote like identity does. Also alias the parent-line lock states to vial keywords so promoted per-substance rows grey out.

**Root cause (confirmed):** the per-substance change made the vial seed `PUR_<X>`/`QTY_<X>`, but the parent SENAITE AR carries generic `ANALYTE-{n}-PUR/QTY`. `writeback_promotion`/`find_parent_analysis_line` match by keyword, so they can't find the parent line → fail-closed → 502 → vial row stuck at `to_be_verified`. Identity works because the parent carries `ID_<X>` natively. Verified live: `find_parent_analysis_line('PB-0076','PUR_BPC157')` raises; `ANALYTE-1-PUR` and `ID_BPC157` resolve.

**Architecture:** A standalone translation helper (route-layer, keeps `promote_to_parent` pure-DB per the design review) maps a vial per-substance keyword → the parent's `ANALYTE-{slot}` keyword (via the vial service's `peptide_id` → the peptide's `ID_<X>` title → the parent slot whose `Analyte{N}Peptide` title matches → `ANALYTE-{slot}`). The promote route resolves the parent target, passes it into `promote_to_parent` (which keys the parent-tier row under the parent keyword/service/title while still validating sources against the vial keyword), and writes back under the parent keyword. COA and the retest cascade need no change (parent-tier row is now in the `ANALYTE-{slot}` namespace; the cascade joins by the promotion FK, not keyword).

**Tech Stack:** FastAPI + SQLAlchemy. SENAITE slot read via `sub_samples.senaite.fetch_parent_analyte_slots`. Promote tests mock SENAITE; translation tests run against the live catalog. Run pytest in container: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -q"`.

**Grounded facts (don't re-derive):**
- Parent AR carries `ID_<X>` (matches vial) + `ANALYTE-{n}-PUR/QTY` (generic) for blends. The vial now carries `ID_<X>` + `PUR_<X>`/`QTY_<X>` + `BLEND-PUR` + `PEPT-Total` + `HPLC-ID`.
- `fetch_parent_analyte_slots(pid) -> {n: "{Name} - Identity (HPLC)"}`; the titles EXACTLY equal the corresponding `ID_<X>` service titles.
- A per-substance service (`PUR_<X>`) has `peptide_id`; its peptide's `ID_<X>` service has the same `peptide_id` and a title equal to the parent slot title.
- `promote_to_parent(db, *, keyword, result_value, result_unit, method_id, instrument_id, sources, user_id, reason, commit)` — validates every source row's `.keyword == keyword`, derives `parent_sample_pk`, and creates the parent-tier `LimsAnalysis` with `keyword=keyword`, `analysis_service_id=first_source.analysis_service_id`, `title=first_source.title`. The retest-supersession block queries old parent rows by `LimsAnalysis.keyword == keyword`. (service.py ~372-590.)
- The promote route (routes.py ~273-345): calls `promote_to_parent(keyword=req.keyword, ..., commit=False)`, derives `parent_sample_id` from `parent_row.lims_sample_pk`, then `writeback_promotion(parent_sample_id, req.keyword, ...)`; on `SenaiteWritebackError` → `db.rollback()` → 502; else `db.commit()`.
- `list_parent_line_states(parent_sample_id) -> {parent_keyword: state}` (senaite_writeback.py ~185). Route `GET .../parent-line-states` wraps it. The FE uses it to lock vial rows whose parent line is verified.
- Non-per-substance keywords (`ID_<X>`, `BLEND-PUR`, `PEPT-Total`, `HPLC-ID`) already match the parent — translation must be a no-op for them.

---

## Task 1: Vial→parent keyword translation helper

**Files:**
- Modify: `backend/lims_analyses/service.py` (add `resolve_parent_analyte_target`)
- Test: `backend/tests/test_parent_keyword_translation.py` (new; live catalog + monkeypatched slot read)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_parent_keyword_translation.py`:

```python
"""resolve_parent_analyte_target maps a vial per-substance keyword to the parent's
ANALYTE-{slot} keyword. Live catalog (PUR_/QTY_/ID_/ANALYTE services exist);
the SENAITE slot read is monkeypatched."""
from database import SessionLocal
from lims_analyses.service import resolve_parent_analyte_target


def _db():
    return SessionLocal()


def test_per_substance_translates_to_analyte_slot(monkeypatch):
    # GHK-Cu sits at slot 1 on this parent; BPC-157 slot 2; TB500 slot 3.
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: {1: "GHK-Cu - Identity (HPLC)",
                     2: "BPC-157 - Identity (HPLC)",
                     3: "TB500 (Thymosin Beta 4) - Identity (HPLC)"},
    )
    db = _db()
    try:
        # divergent-name case (the hard one): PUR_TB500BETA4 -> ANALYTE-3-PUR
        kw, svc_id, title = resolve_parent_analyte_target(
            db, vial_keyword="PUR_TB500BETA4", parent_sample_id="PB-0076")
        assert kw == "ANALYTE-3-PUR"
        assert title == "Analyte 3 (Purity)"          # the generic ANALYTE-3-PUR service title
        assert svc_id is not None
        # quantity + slot 1
        kw2, _, _ = resolve_parent_analyte_target(
            db, vial_keyword="QTY_GHKCU", parent_sample_id="PB-0076")
        assert kw2 == "ANALYTE-1-QTY"
    finally:
        db.close()


def test_native_keywords_pass_through(monkeypatch):
    # ID_/BLEND-/PEPT-/HPLC- already match the parent — no translation, no slot read.
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: (_ for _ in ()).throw(AssertionError("slot read must not happen")),
    )
    db = _db()
    try:
        for kw in ("ID_BPC157", "BLEND-PUR", "PEPT-Total", "HPLC-ID"):
            out_kw, svc_id, title = resolve_parent_analyte_target(
                db, vial_keyword=kw, parent_sample_id="PB-0076")
            assert out_kw == kw and svc_id is None and title is None
    finally:
        db.close()


def test_unresolvable_slot_falls_through(monkeypatch):
    # peptide not present in any parent slot -> can't translate -> return vial keyword
    # (promote will then fail writeback and surface a 502 rather than guess).
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: {})
    db = _db()
    try:
        kw, svc_id, title = resolve_parent_analyte_target(
            db, vial_keyword="PUR_GHKCU", parent_sample_id="PB-0076")
        assert kw == "PUR_GHKCU" and svc_id is None and title is None
    finally:
        db.close()
```

- [ ] **Step 2: Run, verify fail**

`MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_parent_keyword_translation.py -q"`
Expected: FAIL — `ImportError`/`AttributeError: resolve_parent_analyte_target`.

- [ ] **Step 3: Implement the helper**

In `backend/lims_analyses/service.py` (near the other helpers; `select`, `AnalysisService`, `re`, `Optional`, `Tuple` are imported — add `import re` / `from models import AnalysisService` if missing):

```python
import re  # confirm at module top
_PER_SUBSTANCE = re.compile(r"^(PUR|QTY)_(.+)$")


def resolve_parent_analyte_target(
    db: Session, *, vial_keyword: str, parent_sample_id: str,
) -> Tuple[str, Optional[int], Optional[str]]:
    """Map a vial per-substance keyword (PUR_<X>/QTY_<X>) to the parent AR's
    generic ANALYTE-{slot} target: (parent_keyword, parent_service_id, parent_title).

    The parent SENAITE AR carries generic ANALYTE-{n}-PUR/QTY (aliased to the
    substance via Analyte{N}Peptide), not PUR_<X>. Promotion/COA/writeback key on
    the parent keyword, so a per-substance vial row must be promoted under the
    parent's ANALYTE-{slot} keyword.

    Native keywords (ID_<X>, BLEND-*, PEPT-*, HPLC-*) already match the parent →
    returns (vial_keyword, None, None) and does NOT read SENAITE. Unresolvable
    per-substance keywords (peptide not in any parent slot) also fall through to
    (vial_keyword, None, None) so the caller's writeback fails loudly rather than
    guessing.
    """
    m = _PER_SUBSTANCE.match(vial_keyword)
    if not m:
        return vial_keyword, None, None
    cat = m.group(1)  # 'PUR' or 'QTY'

    vsvc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword == vial_keyword)
    ).scalar_one_or_none()
    if vsvc is None or vsvc.peptide_id is None:
        return vial_keyword, None, None

    # The peptide's ID_<X> service title equals the parent slot title.
    id_title = db.execute(
        select(AnalysisService.title).where(
            AnalysisService.peptide_id == vsvc.peptide_id,
            AnalysisService.keyword.like("ID" + r"\_" + "%", escape="\\"),
        ).order_by(AnalysisService.keyword).limit(1)
    ).scalar_one_or_none()
    if not id_title:
        return vial_keyword, None, None

    from sub_samples.senaite import fetch_parent_analyte_slots
    slots = fetch_parent_analyte_slots(parent_sample_id)  # raises -> fail-closed
    slot_n = next((n for n, t in slots.items() if t == id_title), None)
    if slot_n is None:
        return vial_keyword, None, None

    parent_keyword = f"ANALYTE-{slot_n}-{cat}"
    psvc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword == parent_keyword)
    ).scalar_one_or_none()
    if psvc is None:
        return parent_keyword, None, None
    return parent_keyword, psvc.id, (psvc.title or parent_keyword)
```

- [ ] **Step 4: Run, verify pass**

`MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_parent_keyword_translation.py -q"` → 3 passed. `python -c 'import main'` clean.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/service.py backend/tests/test_parent_keyword_translation.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(promote): vial per-substance -> parent ANALYTE-{slot} keyword translation"
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

---

## Task 2: promote_to_parent stores the parent-tier row under the parent target

**Files:**
- Modify: `backend/lims_analyses/service.py` (`promote_to_parent`)
- Test: `backend/tests/test_lims_analyses_service.py` (extend) or a new focused test

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_lims_analyses_service.py` (read the file's existing promote tests + fixtures first to match the pattern; uses in-memory SQLite `db_session`, builds `AnalysisService`/`LimsSample`/`LimsSubSample`/`LimsAnalysis` rows). The test: two vial `PUR_BPC157` sources promote, but the parent-tier row is created under the passed parent target (`ANALYTE-2-PUR`):

```python
def test_promote_uses_parent_target_for_parent_row(db_session):
    db = db_session
    # ... build a parent LimsSample, a sub-sample, and a vial-tier PUR_BPC157 row
    #     in 'to_be_verified' (analysis_service_id of the PUR_BPC157 service) ...
    # (Follow the existing promote test setup in this file.)
    parent_row, _ = promote_to_parent(
        db, keyword="PUR_BPC157", result_value="98.5", result_unit="%",
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": <vial_row_id>, "contribution_kind": "chosen"}],
        user_id=1,
        parent_keyword="ANALYTE-2-PUR",
        parent_analysis_service_id=<analyte2pur_service_id>,
        parent_title="Analyte 2 (Purity)",
        commit=False,
    )
    assert parent_row.keyword == "ANALYTE-2-PUR"
    assert parent_row.title == "Analyte 2 (Purity)"
    assert parent_row.review_state == "verified"
    # the source vial row flipped to 'promoted'
    db.refresh(<vial_row>)
    assert <vial_row>.review_state == "promoted"
```

Also add a regression test that WITHOUT the parent_* overrides, behavior is unchanged (parent row keyword == source keyword) — promote a generic/native keyword and assert `parent_row.keyword == keyword`.

- [ ] **Step 2: Run, verify fail**

Expected: `TypeError: promote_to_parent() got an unexpected keyword argument 'parent_keyword'`.

- [ ] **Step 3: Implement**

In `promote_to_parent`, add optional params (after `reason`): `parent_keyword: Optional[str] = None`, `parent_analysis_service_id: Optional[int] = None`, `parent_title: Optional[str] = None`. Keep source validation against `keyword` (unchanged). Resolve the parent-tier values once, before the supersession block:

```python
    first_source = source_rows[source_ids[0]]
    eff_parent_keyword = parent_keyword or keyword
    eff_service_id = parent_analysis_service_id or first_source.analysis_service_id
    eff_title = parent_title or first_source.title
```
Then use `eff_parent_keyword` in the retest-supersession query (`LimsAnalysis.keyword == eff_parent_keyword`) and `eff_parent_keyword`/`eff_service_id`/`eff_title` in the `parent_row = LimsAnalysis(... keyword=eff_parent_keyword, analysis_service_id=eff_service_id, title=eff_title ...)`. (Replace the existing `analysis_service_id = first_source.analysis_service_id` / `title = first_source.title` / `keyword=keyword` usages for the parent row only.) Update the docstring to note parent_* overrides decouple the parent-tier row's identity from the source vial keyword (used for per-substance promotion).

- [ ] **Step 4: Run promote tests + import**

`MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_service.py -q"` → all green (existing promote tests unchanged since the params default to old behavior). `python -c 'import main'` clean.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/service.py backend/tests/test_lims_analyses_service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(promote): parent-tier row uses parent target keyword/service/title overrides"
```

---

## Task 3: Wire translation into the promote route + writeback

**Files:**
- Modify: `backend/lims_analyses/routes.py` (`promote`)
- Test: `backend/tests/test_promote_writeback_route.py` (extend — read it first; it mocks `senaite_writeback`)

- [ ] **Step 1: Write the failing test**

Read `backend/tests/test_promote_writeback_route.py` for its fixture/mock pattern (it patches `senaite_writeback.writeback_promotion` and builds vial rows). Add a test: promoting a `PUR_BPC157` vial row results in `writeback_promotion` being called with the PARENT keyword `ANALYTE-{slot}-PUR` (not `PUR_BPC157`), and the parent-tier row is keyed `ANALYTE-{slot}-PUR`. Monkeypatch `resolve_parent_analyte_target` (or `fetch_parent_analyte_slots`) so the slot resolves deterministically, and capture the keyword passed to the mocked `writeback_promotion`.

- [ ] **Step 2: Run, verify fail**

Expected: the asserted writeback keyword is `PUR_BPC157` (today the route passes `req.keyword`) → assertion fails.

- [ ] **Step 3: Implement the route change**

In `backend/lims_analyses/routes.py` `promote`, BEFORE calling `promote_to_parent`, resolve the parent target. The route needs `parent_sample_id` first — derive it from the first source:

```python
    from models import LimsAnalysis, LimsAnalysisPromotion, LimsSample, LimsSubSample

    # Resolve the parent SENAITE sample_id + the parent-AR target keyword BEFORE
    # promoting, so per-substance vial keywords (PUR_<X>/QTY_<X>) land on the
    # parent's generic ANALYTE-{slot} line. Native keywords pass through unchanged.
    first_src = db.get(LimsAnalysis, req.sources[0].analysis_id)
    if first_src is None:
        raise HTTPException(status_code=404, detail="source analysis not found")
    if first_src.lims_sub_sample_pk is not None:
        _sub = db.get(LimsSubSample, first_src.lims_sub_sample_pk)
        _parent = db.get(LimsSample, _sub.parent_sample_pk) if _sub else None
    else:
        _parent = db.get(LimsSample, first_src.lims_sample_pk)
    parent_sample_id = _parent.sample_id if _parent else None

    try:
        if parent_sample_id:
            parent_keyword, parent_service_id, parent_title = service.resolve_parent_analyte_target(
                db, vial_keyword=req.keyword, parent_sample_id=parent_sample_id)
        else:
            parent_keyword, parent_service_id, parent_title = req.keyword, None, None
    except Exception as e:
        # A SENAITE slot-read failure during translation is fail-closed, like writeback.
        raise HTTPException(status_code=502, detail=f"parent slot resolution failed: {e}")

    try:
        parent_row, promotion_rows = service.promote_to_parent(
            db,
            keyword=req.keyword,
            result_value=req.result_value,
            result_unit=req.result_unit,
            method_id=req.method_id,
            instrument_id=req.instrument_id,
            sources=[s.model_dump() for s in req.sources],
            user_id=getattr(current_user, "id", None),
            reason=req.reason,
            parent_keyword=parent_keyword,
            parent_analysis_service_id=parent_service_id,
            parent_title=parent_title,
            commit=False,
        )
    except Exception as e:
        raise _handle_service_error(e)
```
Then change the writeback call to use the parent keyword (the parent_row now carries it):
```python
        senaite_writeback.writeback_promotion(
            parent_sample_id,
            parent_row.keyword,        # was req.keyword — now the parent ANALYTE-{slot}
            req.result_value,
            remark,
        )
```
(Remove the now-redundant later `parent_sample_id` re-derivation from `parent_row.lims_sample_pk` if it duplicates the one above — or keep one source of truth. Ensure `parent_sample_id` is defined for the writeback + the error-log line.)

- [ ] **Step 4: Run the route + promote suites + import**

`MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_promote_writeback_route.py tests/test_lims_analyses_service.py tests/test_parent_keyword_translation.py tests/test_promote_sets_source_promoted.py -q"` → all green. `python -c 'import main'` clean.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/routes.py backend/tests/test_promote_writeback_route.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(promote): route translates per-substance keyword to parent target for writeback"
```

---

## Task 4: Alias parent-line lock states to vial keywords

**Files:**
- Modify: `backend/lims_analyses/routes.py` (the parent-line-states route) and/or `backend/lims_analyses/senaite_writeback.py`
- Test: extend the parent-line-states test (find it: grep `parent-line-states` / `list_parent_line_states` in tests)

- [ ] **Step 1: Understand the consumer + write the failing test**

`list_parent_line_states` returns `{parent_keyword: state}` (e.g. `{"ANALYTE-2-PUR": "verified"}`). The FE locks a vial row by looking up its keyword in this map; per-substance rows (`PUR_BPC157`) won't be found. Add vial-keyword ALIASES: for each `ANALYTE-{slot}-{PUR|QTY}` state, also emit the corresponding `PUR_<X>`/`QTY_<X>` keyword (resolved via the slot map + per-substance services), so the FE finds either form. Add a test asserting that when the parent has `ANALYTE-2-PUR: verified` and slot 2 = BPC-157, the returned states include `PUR_BPC157: verified`.

- [ ] **Step 2: Run, verify fail**

Expected: returned states have only `ANALYTE-2-PUR`, not `PUR_BPC157`.

- [ ] **Step 3: Implement the alias**

Add a function (route layer, where DB is available — the route handler, since `list_parent_line_states` in senaite_writeback.py has no DB) that, given the `{parent_keyword: state}` map + `parent_sample_id`, augments it with vial-keyword aliases: for each `ANALYTE-{n}-{cat}` key, look up slot n's peptide (via `fetch_parent_analyte_slots` + the ID-title→peptide_id catalog join, reusing the inverse of Task 1) → that peptide's `PUR_<X>`/`QTY_<X>` keyword → add `{vial_keyword: state}`. Keep the original `ANALYTE-{n}` keys too (don't break existing consumers). Apply it in the parent-line-states route handler before returning. (Reuse a shared slot→peptide resolver; avoid duplicating the join logic from Task 1 — extract a small helper if cleaner.)

- [ ] **Step 4: Run + import**

Run the parent-line-states test + `python -c 'import main'`. Green + clean.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/routes.py backend/tests/<the test file>
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(promote): alias parent-line lock states to per-substance vial keywords"
```

---

## Task 5: Live end-to-end verification (TB500 — the divergent-name case)

**No code.** Stack: API :5530, Postgres `accumark_mk1`. PB-0076-S05 (pk 172) is an HPLC vial with per-substance rows; slot 3 = TB500.

- [ ] **Step 1: Suites + import green**

`MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import main' && python -m pytest tests/test_parent_keyword_translation.py tests/test_lims_analyses_service.py tests/test_promote_writeback_route.py tests/test_promote_sets_source_promoted.py tests/test_parent_retest_cascade.py tests/test_coa_source_resolver_integration.py -q"` → green (incl. COA + cascade, proving no regression there).

- [ ] **Step 2: Promote a per-substance purity result (TB500) via the real path**

Drive the promote endpoint (or call `service.promote_to_parent` + the route logic) for `PUR_TB500BETA4` on PB-0076-S05. Confirm:
- The local vial `PUR_TB500BETA4` row flips to `promoted`.
- A parent-tier Mk1 `LimsAnalysis` exists for PB-0076 keyed `ANALYTE-3-PUR` (NOT `PUR_TB500BETA4`), `review_state='verified'`.
- The parent SENAITE AR `ANALYTE-3-PUR` line now carries the value (`find_parent_analysis_line('PB-0076','ANALYTE-3-PUR')` shows it at `to_be_verified` with the result).
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT keyword, review_state, result_value FROM lims_analyses WHERE lims_sample_pk=33 AND keyword LIKE 'ANALYTE-3-%' ORDER BY keyword;"
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT keyword, review_state FROM lims_analyses WHERE lims_sub_sample_pk=172 AND keyword='PUR_TB500BETA4';"
```
Expected: parent-tier `ANALYTE-3-PUR` verified; vial `PUR_TB500BETA4` promoted.

- [ ] **Step 3: Re-promote guard / idempotency**

Re-promote the same row → expect the writeback "already verified / already exists" guard (409/502) rather than a duplicate. Confirm no duplicate parent-tier row.

- [ ] **Step 4: Cleanup**

Reset any test-mutated PB-0076 vials/parent-tier rows to baseline (scoped delete of the created parent-tier `ANALYTE-3-*` row + restore the vial row state), per the user's dev-data curation authorization. Report what was reset.

---

## Self-review notes
- **Root cause addressed:** per-substance vial keyword → parent `ANALYTE-{slot}` for writeback (T3) AND parent-tier row (T2) via the translation helper (T1). COA + retest-cascade come free (parent-tier row now in the `ANALYTE-{slot}` namespace; cascade uses the promotion FK). Lock states aliased (T4).
- **Type consistency:** `resolve_parent_analyte_target(db, *, vial_keyword, parent_sample_id) -> (str, Optional[int], Optional[str])` used in the route (T3) and reused/extracted for the lock alias (T4). `promote_to_parent(..., parent_keyword=, parent_analysis_service_id=, parent_title=)` consistent T2↔T3.
- **No placeholders** except the two flagged "read the existing test file's fixture pattern" adaptation points (T2 Step1, T3 Step1, T4 Step1) — each names the file to read.
- **Backward compat:** native keywords (ID_/BLEND/PEPT/HPLC) pass through with no slot read and no behavior change; `promote_to_parent` params default to old behavior so existing callers/tests are unaffected.
- **Out of scope (separate follow-up):** greying out non-assigned-role AR rows on the sub-sample (e.g. Micro rows on an HPLC vial) — needs its own investigation (incl. why a STER-PCR row exists on an HPLC vial) and FE work.
