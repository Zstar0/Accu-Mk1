# Native COA Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Mk1-native result (first tenant: Heavy Metals) reach a customer certificate — promote without SENAITE, emit catalog-derived COA sections, push them to COABuilder, render them fail-closed on both the primary and additional-COA paths.

**Architecture:** Mk1 gains an origin-gated promote (native results commit without SENAITE write-back, keyed by service id not keyword) and a section-builder that turns Analysis Profiles + verified parent rows into a wire document; the document rides the existing COABuilder request bodies (in-process attach on the primary path, a new S2S endpoint fetched by Integration Service on the additional path); COABuilder validates it fail-closed, renders it with the variance-page recipe (blank background + programmatic ReportLab), folds it into the digital `coa_data` JSON, and downgrades the overall badge on any non-conforming native row.

**Tech Stack:** FastAPI + SQLAlchemy (Mk1, IS), ReportLab + pypdf (COABuilder), httpx (S2S), pytest everywhere.

## Global Constraints

- **Three repos, three worktrees, one branch name each:** Accu-Mk1 work on branch `feat/native-coa-sections` cut from `feat/catalog-foundation` (worktree `C:\tmp\Accu-Mk1-coa-sections`); COABuilder on branch `feat/native-coa-sections` cut from **`origin/master` (`49ff801`)** — NEVER from the parked detached-HEAD tree, it is 64 commits stale (worktree `C:\tmp\coabuilder-coa-sections`); Integration Service on branch `feat/native-coa-sections` cut from `origin/master` (worktree `C:\tmp\is-coa-sections`). Each task names its repo.
- **Additive only.** A failing pre-existing test defaults to "the test is stale"; production-behavior changes need Handler sign-off. The SENAITE-origin promote path must be byte-identical in behavior.
- **Eligibility for native rows is `review_state IN ('verified','published')` — exactly these two.** Deliberately narrower than `_LIVE_RESULT_STATES`. Anything else in a required section ABORTS, never skips.
- **All-native profiles only:** a section is emitted only when every member service has `origin = 'mk1'`.
- **`ordered_profiles` means ordered AND reportable:** the order bought it, all members `origin='mk1'`, and `coa_archetype` is non-NULL.
- **`specification` and `conforms` are sent as `null` by Mk1, always.** COABuilder fills them from baked specs. The wire format must survive the future conformance migration unchanged.
- **One archetype: `limit_table`** (Test | Result | Unit | Specification | Verdict). COABuilder aborts on any other value. Do not add archetypes.
- **The six fail-closed rules** (each aborts with its own distinct error): (1) section fetch fails; (2) a profile in `ordered_profiles` has no matching section; (3) a section has zero rows or any row has null/empty `result`; (4) a member service has no eligible result row; (5) a row's keyword is absent from baked specs and not marked informational; (6) unrecognised `archetype`.
- **Native promote is ID-based:** derive the service from the source row's `analysis_service_id` FK; key parent-row lookups on `(lims_sample_pk, analysis_service_id)`; never key native logic on `peptide_id` (generic-services trap). The legacy per-substance keyword/slot translation is untouched.
- **Origin gate reads the PARENT row's service, never the vial row's** — `resolve_parent_analyte_target` translates keywords, and its docstring's "native" is a different predicate from `origin='mk1'`.
- **Mk1 gates:** backend suite gates on a failure-set DIFF vs the 64-failure baseline (never zero); interpreter = main checkout's `.venv` (`/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`) with the worktree's `backend/` as cwd; frontend gate is `npx tsc --noEmit` only (never `npm run check:all`); npm only; Zustand selector syntax; explicit-path staging, never `git add -A`.
- **IS gates:** `ruff check . && mypy app` (mypy is `strict = true`) plus `pytest`.
- **COABuilder:** no venv/toolchain change; run `pytest` from repo root. GitNexus impact analysis before editing existing symbols where the index is available.
- **COABuilder renderer traps (bind every renderer task):** `resolve_templates` early-returns for non-peptide matrices — the native append must live in BOTH branches; the page-2 dynamic-background condition must become an ALLOW-list (apply the override only to the two `Blend Page 2 - *` templates), not grow another name on a deny-list; pagination derives row capacity from frame height — silent truncation is forbidden, a section that cannot lay out aborts.
- **ENDO-LAL guard:** ENDO-LAL is SENAITE-origin and can never appear in a native section under the all-native rule. Nothing in this plan may weaken that rule; the catalog unit fix (`EU/mg`→`EU/mL`, lab-entered) is a deploy-runbook item, not a code change here.

---

### Task 1: Origin-gated SENAITE write-back and ID-based native promote (Accu-Mk1)

**Files:**
- Modify: `backend/lims_analyses/routes.py` (promote route, write-back block ~:333-388)
- Modify: `backend/lims_analyses/service.py` (`promote_to_parent`, ~:553-832)
- Test: `backend/tests/test_native_promote.py` (new)

**Interfaces:**
- Consumes: `AnalysisService.origin` (spec 1), `promote_to_parent(...)` existing signature, `senaite_writeback.writeback_promotion`.
- Produces: promote of an `origin='mk1'` parent service commits WITHOUT any SENAITE call; `promote_to_parent` gains keyword-derivation-from-service for native sources. No signature changes.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_native_promote.py`. Model fixtures on `backend/tests/test_analysis_service_routes.py` (auth override + SQLite session) and the promote fixtures in existing `backend/tests/` promote tests (grep `promote_to_parent` for the canonical fixture shape — reuse, don't reinvent). The essential cases:

```python
"""Native (origin='mk1') promote: no SENAITE write-back, ID-keyed identity.

The SENAITE-origin path must stay byte-identical: write-back still runs and
still rolls the whole promote back on failure (fail-closed).
"""
import pytest
from unittest.mock import patch

from lims_analyses.senaite_writeback import SenaiteWritebackError


def _mk_service(db, *, keyword, origin, unit=None):
    from models import AnalysisService
    svc = AnalysisService(title=keyword.title(), keyword=keyword, origin=origin, unit=unit)
    db.add(svc)
    db.flush()
    return svc


def _mk_parent_and_vial_rows(db, svc, *, n_vials=1):
    """One LimsSample parent + n sub-samples, each with a to_be_verified
    lims_analyses row for svc. Returns (parent, [vial_rows])."""
    from models import LimsAnalysis, LimsSample, LimsSubSample
    parent = LimsSample(sample_id="P-9001")
    db.add(parent); db.flush()
    rows = []
    for i in range(n_vials):
        sub = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"P-9001-S{i+1:02d}")
        db.add(sub); db.flush()
        row = LimsAnalysis(
            lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            result_value="0.12", review_state="to_be_verified",
        )
        db.add(row); db.flush()
        rows.append(row)
    return parent, rows


def test_native_promote_never_touches_senaite(client, db_session):
    """origin='mk1' parent service: promote succeeds with the write-back
    hard-broken. If the gate is deleted, this test fails with a 502."""
    svc = _mk_service(db_session, keyword="HM-PB", origin="mk1", unit="ppm")
    parent, rows = _mk_parent_and_vial_rows(db_session, svc)
    db_session.commit()
    with patch(
        "lims_analyses.routes.senaite_writeback.writeback_promotion",
        side_effect=AssertionError("SENAITE write-back must not be called for a native promote"),
    ):
        resp = client.post("/api/lims-analyses/promote", json={
            "keyword": "HM-PB", "result_value": "0.12", "result_unit": "ppm",
            "sources": [{"analysis_id": rows[0].id, "contribution_kind": "chosen"}],
        })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["parent"]["review_state"] == "verified"
    assert body["parent"]["analysis_service_id"] == svc.id


def test_senaite_origin_promote_still_fail_closed(client, db_session):
    """origin='senaite' path unchanged: write-back failure -> 502 AND the
    parent row is rolled back (not committed)."""
    svc = _mk_service(db_session, keyword="STER-XYZ", origin="senaite")
    parent, rows = _mk_parent_and_vial_rows(db_session, svc)
    db_session.commit()
    with patch(
        "lims_analyses.routes.senaite_writeback.writeback_promotion",
        side_effect=SenaiteWritebackError("boom"),
    ):
        resp = client.post("/api/lims-analyses/promote", json={
            "keyword": "STER-XYZ", "result_value": "ND",
            "sources": [{"analysis_id": rows[0].id, "contribution_kind": "chosen"}],
        })
    assert resp.status_code == 502
    from models import LimsAnalysis
    parents = db_session.query(LimsAnalysis).filter(
        LimsAnalysis.lims_sample_pk == parent.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
    ).all()
    assert parents == []  # rolled back


def test_native_source_validation_is_id_based(client, db_session):
    """A native source row whose keyword string was mangled (but whose
    service FK is right) still promotes: identity comes from the FK."""
    svc = _mk_service(db_session, keyword="HM-PB", origin="mk1", unit="ppm")
    parent, rows = _mk_parent_and_vial_rows(db_session, svc)
    rows[0].keyword = "HM-PB-LEGACY-LABEL"   # drifted display string
    db_session.commit()
    with patch(
        "lims_analyses.routes.senaite_writeback.writeback_promotion",
        side_effect=AssertionError("must not be called"),
    ):
        resp = client.post("/api/lims-analyses/promote", json={
            "keyword": "HM-PB", "result_value": "0.12",
            "sources": [{"analysis_id": rows[0].id, "contribution_kind": "chosen"}],
        })
    assert resp.status_code == 201, resp.text
    # Parent row's keyword is the SERVICE's keyword, not the drifted string.
    assert resp.json()["parent"]["keyword"] == "HM-PB"


def test_native_retest_supersession_is_id_keyed(client, db_session):
    """Retest promotion of a native service retracts the old parent row even
    when its keyword string drifted — the supersession lookup keys on
    analysis_service_id for origin='mk1'."""
    from models import LimsAnalysis
    svc = _mk_service(db_session, keyword="HM-PB", origin="mk1", unit="ppm")
    parent, rows = _mk_parent_and_vial_rows(db_session, svc, n_vials=2)
    old_parent_row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="HM-PB-OLD-LABEL", title=svc.title,
        result_value="0.50", review_state="verified",
    )
    db_session.add(old_parent_row)
    retest_row = rows[1]
    retest_row.retest_of_id = rows[0].id
    rows[0].review_state = "retracted"
    db_session.commit()
    with patch(
        "lims_analyses.routes.senaite_writeback.writeback_promotion",
        side_effect=AssertionError("must not be called"),
    ):
        resp = client.post("/api/lims-analyses/promote", json={
            "keyword": "HM-PB", "result_value": "0.11",
            "sources": [{"analysis_id": retest_row.id, "contribution_kind": "chosen"}],
        })
    assert resp.status_code == 201, resp.text
    db_session.expire_all()
    assert db_session.get(LimsAnalysis, old_parent_row.id).review_state == "retracted"
```

Adjust fixture/model kwargs to the real constructors (read the existing promote tests first — `LimsSample`/`LimsSubSample` have required fields this sketch may omit; `provenance` on `LimsAnalysis` defaults to `'canonical'`, keep it). The four behaviors above are the requirements; the mechanics of client/db fixtures follow the existing test files.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_native_promote.py -v`
Expected: `test_native_promote_never_touches_senaite` FAILS (the AssertionError side-effect fires → 502); `test_native_source_validation_is_id_based` FAILS (400, keyword mismatch); `test_native_retest_supersession_is_id_keyed` FAILS; `test_senaite_origin_promote_still_fail_closed` PASSES already (pins the status quo).

- [ ] **Step 3: Implement the origin gate in the route**

In `backend/lims_analyses/routes.py`, the write-back block currently reads (:375-387):

```python
    try:
        senaite_writeback.writeback_promotion(
            parent_sample_id,
            parent_row.keyword,        # parent ANALYTE-{slot} (was req.keyword)
            req.result_value,
            remark,
        )
    except SenaiteWritebackError as e:
        db.rollback()
        raise HTTPException(
            status_code=502,
            detail=f"SENAITE write-back failed — promote aborted: {e}",
        )
```

Wrap it in the origin gate, reading the PARENT row's service:

```python
    # ── Origin gate (native COA sections, spec 2) ─────────────────────────────
    # A service with origin='mk1' has no SENAITE representation: there is no
    # analysis line to write back to, so the Mk1-side commit IS the promotion.
    # Read origin from the service backing the PARENT row — never the vial row:
    # resolve_parent_analyte_target translates per-substance keywords, and its
    # notion of "native" (not PUR_/QTY_) is a different predicate from
    # origin='mk1'.
    from models import AnalysisService
    _parent_svc = db.get(AnalysisService, parent_row.analysis_service_id)
    _skip_writeback = _parent_svc is not None and _parent_svc.origin == "mk1"

    if not _skip_writeback:
        try:
            senaite_writeback.writeback_promotion(
                parent_sample_id,
                parent_row.keyword,        # parent ANALYTE-{slot} (was req.keyword)
                req.result_value,
                remark,
            )
        except SenaiteWritebackError as e:
            db.rollback()
            raise HTTPException(
                status_code=502,
                detail=f"SENAITE write-back failed — promote aborted: {e}",
            )
    else:
        log.info(
            "native_promote_writeback_skipped parent_analysis_id=%s service_id=%s keyword=%s",
            parent_row.id, parent_row.analysis_service_id, parent_row.keyword,
        )
```

(`log` already exists in the module — `logging.getLogger` at the top; verify the name.)

- [ ] **Step 4: Implement ID-based native identity in `promote_to_parent`**

In `backend/lims_analyses/service.py`, inside `promote_to_parent`:

(a) After `source_rows` are loaded and before the per-source loop, resolve the first source's service and detect native:

```python
    first_source_svc = db.get(AnalysisService, source_rows[source_ids[0]].analysis_service_id)
    is_native = first_source_svc is not None and first_source_svc.origin == "mk1"
```

(`AnalysisService` is already imported inside the function — move/reuse that import so it precedes this.)

(b) In the per-source validation loop, replace the keyword equality check with an origin-conditional check:

```python
        if is_native:
            if row.analysis_service_id != first_source_svc.id:
                raise BadRequestError(
                    f"source {sid} has analysis_service_id={row.analysis_service_id}, "
                    f"expected {first_source_svc.id} (native promote is service-keyed)"
                )
        elif row.keyword != keyword:
            raise BadRequestError(
                f"source {sid} has keyword={row.keyword!r}, "
                f"expected {keyword!r}"
            )
```

(c) Where the effective parent identity is computed, derive keyword/title/unit from the SERVICE for native (the request string is advisory):

```python
    eff_parent_keyword = parent_keyword or keyword
    eff_service_id = parent_analysis_service_id or first_source.analysis_service_id
    eff_title = parent_title or first_source.title
    if is_native and parent_keyword is None:
        # Native identity comes from the catalog service, not the request
        # string or the (possibly drifted) source row label.
        eff_parent_keyword = first_source_svc.keyword
        eff_title = first_source_svc.title
        if result_unit is None:
            result_unit = first_source_svc.unit
```

(d) In the retest-supersession lookup, key on the service id for native:

```python
        _ident_clause = (
            LimsAnalysis.analysis_service_id == eff_service_id
            if is_native
            else LimsAnalysis.keyword == eff_parent_keyword
        )
        old_parent = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sample_pk == parent_sample_pk,
                _ident_clause,
                LimsAnalysis.retest_of_id.is_(None),
                LimsAnalysis.review_state == "verified",
                LimsAnalysis.lims_sub_sample_pk.is_(None),
                LimsAnalysis.provenance == "canonical",
            )
        ).scalars().first()
```

Everything else (contribution-kind rules, variance-bucket refusal, transitions, promotion rows) is origin-agnostic and stays untouched.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_native_promote.py -v`
Expected: all PASS.

- [ ] **Step 6: Mutation-prove the gate, then run the promote-adjacent suite**

Temporarily delete the `_skip_writeback` condition (always call write-back); confirm `test_native_promote_never_touches_senaite` fails with the AssertionError-driven 502; restore; confirm green. Paste real output in the report.

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > /tmp/t1.txt && diff /c/tmp/Accu-Mk1-coa-sections/.superpowers/sdd/2026-07-30-native-coa-sections/baseline-failures.txt /tmp/t1.txt`
Expected: empty diff (the controller records the baseline at branch point before Task 1).

- [ ] **Step 7: Commit**

```bash
git add backend/lims_analyses/routes.py backend/lims_analyses/service.py backend/tests/test_native_promote.py
git commit -m "feat(coa): origin-gated SENAITE write-back; ID-keyed native promote"
```

---

### Task 2: Profile COA columns — `coa_section_title`, `coa_archetype`, `coa_sort_order` (Accu-Mk1)

**Files:**
- Modify: `backend/models.py` (`AnalysisProfile`, ~:276-321)
- Modify: `backend/database.py` (migrations list, after the `analysis_profile_members` CREATE, ~:1445)
- Modify: `backend/main.py` (profile schemas ~:2348-2391, `_profile_to_response`)
- Modify: `src/lib/api.ts` (`AnalysisProfile` interface + `updateAnalysisProfile` payload type)
- Modify: `src/components/hplc/AnalysisProfilesPage.tsx` (edit-panel fields)
- Test: `backend/tests/test_profile_coa_columns.py` (new)

**Interfaces:**
- Consumes: spec-1 `AnalysisProfile` model + CRUD.
- Produces: `AnalysisProfile.coa_section_title: str|None`, `.coa_archetype: str|None` (only legal non-NULL value: `'limit_table'`; NULL = not reported on the COA), `.coa_sort_order: int` — readable and PATCHable; Task 3 reads all three.

- [ ] **Step 1: Write the failing tests**

```python
"""COA columns on analysis_profiles: nullable archetype gates reportability."""


def test_profile_coa_columns_roundtrip(client, db_session):
    r = client.post("/analysis-profiles", json={
        "key": "heavy_metals", "name": "Heavy Metals", "is_addon": True,
    })
    assert r.status_code == 201
    body = r.json()
    # Defaults: not reported until the lab opts in.
    assert body["coa_archetype"] is None
    assert body["coa_section_title"] is None
    assert body["coa_sort_order"] == 0

    pid = body["id"]
    r = client.patch(f"/analysis-profiles/{pid}", json={
        "coa_archetype": "limit_table",
        "coa_section_title": "Heavy Metals Panel",
        "coa_sort_order": 10,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["coa_archetype"] == "limit_table"
    assert body["coa_section_title"] == "Heavy Metals Panel"
    assert body["coa_sort_order"] == 10


def test_profile_coa_archetype_rejects_unknown_value(client, db_session):
    r = client.post("/analysis-profiles", json={
        "key": "hm2", "name": "HM2", "is_addon": True,
    })
    pid = r.json()["id"]
    r = client.patch(f"/analysis-profiles/{pid}", json={"coa_archetype": "fancy_chart"})
    assert r.status_code == 400
    assert "limit_table" in r.json()["detail"]


def test_profile_coa_archetype_can_be_cleared(client, db_session):
    r = client.post("/analysis-profiles", json={
        "key": "hm3", "name": "HM3", "is_addon": True,
    })
    pid = r.json()["id"]
    client.patch(f"/analysis-profiles/{pid}", json={"coa_archetype": "limit_table"})
    r = client.patch(f"/analysis-profiles/{pid}", json={"coa_archetype": None})
    assert r.status_code == 200
    assert r.json()["coa_archetype"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_profile_coa_columns.py -v`
Expected: FAIL — `coa_archetype` not in response / unknown column.

- [ ] **Step 3: Implement**

`backend/models.py`, inside `AnalysisProfile` after `active`:

```python
    # ── COA section wiring (spec 2) ──────────────────────────────────────────
    # NULL coa_archetype = profile is NOT reported on the certificate (a
    # legitimate internal-only test). The only legal non-NULL value today is
    # 'limit_table'; validation lives in the route so the constant stays in
    # one place (COA_ARCHETYPES in main.py).
    coa_section_title: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    coa_archetype: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    coa_sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
```

`backend/database.py`, append to the migrations list (same idiom as its neighbours):

```python
        # --- Native COA sections (spec 2): profile -> certificate wiring ---
        "ALTER TABLE analysis_profiles ADD COLUMN IF NOT EXISTS coa_section_title VARCHAR(200)",
        "ALTER TABLE analysis_profiles ADD COLUMN IF NOT EXISTS coa_archetype VARCHAR(50)",
        "ALTER TABLE analysis_profiles ADD COLUMN IF NOT EXISTS coa_sort_order INTEGER NOT NULL DEFAULT 0",
```

`backend/main.py`: add near the profile schemas:

```python
COA_ARCHETYPES = {"limit_table"}
```

Add to `AnalysisProfileUpdate`:

```python
    coa_section_title: Optional[str] = None
    coa_archetype: Optional[str] = None
    coa_sort_order: Optional[int] = None
```

Add to `AnalysisProfileResponse`:

```python
    coa_section_title: Optional[str] = None
    coa_archetype: Optional[str] = None
    coa_sort_order: int = 0
```

In `update_analysis_profile`, before the setattr loop:

```python
    fields = data.model_dump(exclude_unset=True)
    if "coa_archetype" in fields and fields["coa_archetype"] is not None \
            and fields["coa_archetype"] not in COA_ARCHETYPES:
        raise HTTPException(
            400,
            f"unknown coa_archetype {fields['coa_archetype']!r}; "
            f"allowed: {sorted(COA_ARCHETYPES)} or null (not reported)",
        )
    for field, value in fields.items():
        setattr(p, field, value)
```

(The loop currently iterates `data.model_dump(exclude_unset=True)` directly — reuse the `fields` dict.) Update `_profile_to_response` if it builds the dict by hand. `AnalysisProfileCreate` deliberately does NOT gain the fields — a new profile starts unreported and the lab opts in via edit; note this in the route docstring.

Frontend: add the three fields to `AnalysisProfile` in `src/lib/api.ts` (`coa_section_title: string | null`, `coa_archetype: string | null`, `coa_sort_order: number`). In `AnalysisProfilesPage.tsx`'s edit panel (edit mode only, beside the Active checkbox), add: a "COA section" select with options "Not reported" (null) / "Limit table" (`limit_table`); a "Section title" text input (placeholder = profile name, only enabled when archetype non-null); a "Section order" number input. Extend `FormState`, `toFormState`-equivalent seeding, and `handleSave`'s update payload with the three fields (send only on edit, mirroring `active`). House tooltip on the select explaining "Not reported = internal-only; Limit table = renders as Test/Result/Unit/Specification/Verdict on the certificate."

- [ ] **Step 4: Run the tests, typecheck**

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_profile_coa_columns.py tests/test_analysis_profiles.py tests/test_api_analysis_profiles.py -v`
Expected: all pass (pre-existing profile tests unaffected — the columns are additive).
Run: `cd /c/tmp/Accu-Mk1-coa-sections && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/models.py backend/database.py backend/main.py backend/tests/test_profile_coa_columns.py src/lib/api.ts src/components/hplc/AnalysisProfilesPage.tsx
git commit -m "feat(coa): profile COA columns — section title, archetype, sort order"
```

---

### Task 3: The section builder — `build_native_sections` (Accu-Mk1)

**Files:**
- Create: `backend/coa/native_sections.py`
- Test: `backend/tests/test_native_sections.py` (new)

**Interfaces:**
- Consumes: `AnalysisProfile` (+ Task 2 columns), `analysis_profile_members`, `LimsAnalysis` parent-tier rows, `sub_samples.service.fetch_sample_services(sample_id)` (existing IS pass-through; raises on network error, `None` on 404).
- Produces:
  - `class NativeSectionsError(Exception)` — carries `.detail: str`; every abort path raises it with a rule-specific message.
  - `build_native_sections(db, parent: LimsSample) -> dict` — the wire document `{"sample_id": str, "ordered_profiles": [str], "sections": [...]}` exactly as the spec's wire contract. Empty order → `{"sample_id": ..., "ordered_profiles": [], "sections": []}` (a valid document, not an error).
  - Task 4 attaches this document verbatim as `native_sections` in COABuilder request bodies.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_native_sections.py` — fixtures create profiles + member services + parent rows directly in the session; `fetch_sample_services` is monkeypatched (it is an HTTP pass-through). The cases, each pinned to its fail-closed rule:

```python
"""build_native_sections: the wire document + fail-closed rules 1-4.

fetch_sample_services is monkeypatched throughout — it is a live HTTP
pass-through to Integration Service.
"""
import pytest

from coa.native_sections import NativeSectionsError, build_native_sections


def _mk_native_profile(db, *, key, services, archetype="limit_table",
                       title=None, sort=10):
    """Profile with the given member services (list of (keyword, origin))."""
    from models import AnalysisProfile, AnalysisService, analysis_profile_members
    prof = AnalysisProfile(
        key=key, name=key.replace("_", " ").title(), is_addon=True,
        coa_archetype=archetype, coa_section_title=title, coa_sort_order=sort,
    )
    db.add(prof); db.flush()
    svcs = []
    for i, (kw, origin) in enumerate(services):
        svc = AnalysisService(title=kw.title(), keyword=kw, origin=origin, unit="ppm")
        db.add(svc); db.flush()
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=i,
        ))
        svcs.append(svc)
    db.flush()
    return prof, svcs


def _mk_parent_with_rows(db, svcs, *, state="verified", result="0.12"):
    from models import LimsAnalysis, LimsSample
    parent = LimsSample(sample_id="P-7001")
    db.add(parent); db.flush()
    for svc in svcs:
        db.add(LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            result_value=result, result_unit=svc.unit, review_state=state,
        ))
    db.flush()
    return parent


def test_happy_path_document_shape(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(
        db_session, key="heavy_metals",
        services=[("HM-PB", "mk1"), ("HM-AS", "mk1")],
        title="Heavy Metals",
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": "core"},
    )
    doc = build_native_sections(db_session, parent)
    assert doc["sample_id"] == "P-7001"
    assert doc["ordered_profiles"] == ["heavy_metals"]
    [section] = doc["sections"]
    assert section["profile_key"] == "heavy_metals"
    assert section["title"] == "Heavy Metals"
    assert section["archetype"] == "limit_table"
    assert section["sort_order"] == 10
    assert [r["keyword"] for r in section["rows"]] == ["HM-PB", "HM-AS"]  # member order
    row = section["rows"][0]
    assert row["result"] == "0.12" and row["unit"] == "ppm"
    assert row["specification"] is None and row["conforms"] is None


def test_rule1_is_fetch_failure_aborts(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs)
    def _boom(sample_id):
        raise RuntimeError("IS unreachable")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", _boom)
    with pytest.raises(NativeSectionsError, match="order lookup failed"):
        build_native_sections(db_session, parent)


def test_rule4_ineligible_state_aborts_not_skips(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, state="to_be_verified")
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="no eligible result"):
        build_native_sections(db_session, parent)


def test_rule3_empty_result_aborts(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, result="")
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="empty result"):
        build_native_sections(db_session, parent)


def test_mixed_origin_profile_is_not_reportable(db_session, monkeypatch):
    """A profile with any SENAITE member is excluded from ordered_profiles
    entirely (all-native rule) — it does NOT abort, and it does NOT emit."""
    prof, svcs = _mk_native_profile(
        db_session, key="bac_water_panel",
        services=[("ENDO-XYZ", "senaite"), ("HM-PB", "mk1")],
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"bac_water_panel": True}, "package": None},
    )
    doc = build_native_sections(db_session, parent)
    assert doc["ordered_profiles"] == [] and doc["sections"] == []


def test_null_archetype_profile_is_not_reportable(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="internal_qc",
                                    services=[("QC-X", "mk1")], archetype=None)
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"internal_qc": True}, "package": None},
    )
    doc = build_native_sections(db_session, parent)
    assert doc["ordered_profiles"] == [] and doc["sections"] == []


def test_retested_row_is_not_current(db_session, monkeypatch):
    """A parent row that has been retest-superseded (retracted) plus a new
    verified retest row: the retest row is used; if ONLY the retracted row
    exists, the section aborts (rule 4)."""
    from models import LimsAnalysis
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, state="retracted")
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="no eligible result"):
        build_native_sections(db_session, parent)
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svcs[0].id,
        keyword="HM-PB", title="Hm-Pb", result_value="0.09",
        result_unit="ppm", review_state="verified",
    ))
    db_session.flush()
    doc = build_native_sections(db_session, parent)
    assert doc["sections"][0]["rows"][0]["result"] == "0.09"


def test_no_order_linked_yields_empty_document(db_session, monkeypatch):
    from models import LimsSample
    parent = LimsSample(sample_id="P-7002")
    db_session.add(parent); db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: None,   # IS 404: no linked order
    )
    doc = build_native_sections(db_session, parent)
    assert doc == {"sample_id": "P-7002", "ordered_profiles": [], "sections": []}
```

(Adjust constructor kwargs to the real models as in Task 1; add `method` assertions once the implementation lands — `method` is the row's `hplc_methods.name` when `method_id` is set, else `""`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_native_sections.py -v`
Expected: FAIL — `ModuleNotFoundError: coa.native_sections`.

- [ ] **Step 3: Implement `backend/coa/native_sections.py`**

```python
"""Native COA sections: catalog-derived certificate sections from Mk1 results.

One builder, two entry points (spec 2): the primary-COA path calls
build_native_sections in-process; GET /samples/{id}/coa-sections exposes the
same document to Integration Service for the additional-COA path. The document
is passed to COABuilder verbatim as `native_sections`.

FAIL-CLOSED: every abort raises NativeSectionsError with a rule-specific
message. A heavy-metals result is a paid, reportable test — if the document
cannot be assembled completely and correctly, the certificate must not be
generated at all. (Contrast with the variance overlay, which is best-effort.)
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from sub_samples.service import fetch_sample_services

log = logging.getLogger(__name__)

# Mirror of the states a native result may be certified from. Deliberately
# narrower than coa/source_resolver._LIVE_RESULT_STATES: native services have
# no SENAITE verify step, so Mk1 review_state is the only gate that exists.
ELIGIBLE_STATES = ("verified", "published")


class NativeSectionsError(Exception):
    """Any condition that must abort COA generation (fail-closed rules 1-4)."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def _ordered_native_profiles(db: Session, services: dict, package: Optional[str]) -> list:
    """Profiles that are ordered AND reportable: the order bought the key,
    every member is origin='mk1', and coa_archetype is non-NULL.

    Mixed-origin or NULL-archetype profiles are silently excluded — they are
    legitimately not-native-reportable, not errors (all-native scope rule).
    """
    from models import AnalysisProfile

    ordered_keys = [k for k, v in (services or {}).items() if v]
    if package:
        ordered_keys.append(package)

    out = []
    for key in ordered_keys:
        prof = db.execute(
            select(AnalysisProfile).where(AnalysisProfile.key == key)
        ).scalar_one_or_none()
        if prof is None or prof.coa_archetype is None:
            continue
        members = prof.analysis_services  # ordered by member sort_order (spec 1)
        if not members or any(svc.origin != "mk1" for svc in members):
            continue
        out.append(prof)
    out.sort(key=lambda p: (p.coa_sort_order, p.key))
    return out


def _eligible_parent_row(db: Session, parent_pk: int, service_id: int):
    """The current, certifiable parent-tier row for a member service.

    ID-keyed (native promote stores parent rows by analysis_service_id).
    Retest supersession retracts superseded rows in the same transaction, so
    at most one row is in an eligible state.
    """
    from models import LimsAnalysis

    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_pk,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.review_state.in_(ELIGIBLE_STATES),
        )
    ).scalars().first()


def _method_label(db: Session, method_id: Optional[int]) -> str:
    if method_id is None:
        return ""
    from models import HplcMethod

    m = db.get(HplcMethod, method_id)
    return (m.name or "") if m is not None else ""


def build_native_sections(db: Session, parent) -> dict:
    """Assemble the native-sections wire document for a parent LimsSample.

    Returns {"sample_id", "ordered_profiles", "sections"}. An order with no
    reportable native profiles yields empty lists — a VALID document (the
    ordered_profiles cross-check is what lets callers distinguish "nothing
    ordered" from "something broke"). All failures raise NativeSectionsError.
    """
    sample_id = parent.sample_id

    # Rule 1: the order lookup itself is fail-closed.
    try:
        raw = fetch_sample_services(sample_id)
    except Exception as e:
        raise NativeSectionsError(
            f"native sections: order lookup failed for {sample_id}: {e}"
        ) from e

    if raw is None:
        # IS 404 — no linked order. Nothing native can have been bought.
        return {"sample_id": sample_id, "ordered_profiles": [], "sections": []}

    profiles = _ordered_native_profiles(db, raw.get("services") or {}, raw.get("package"))

    sections = []
    for prof in profiles:
        rows = []
        for svc in prof.analysis_services:
            row = _eligible_parent_row(db, parent.id, svc.id)
            if row is None:
                # Rule 4: a member without a certifiable result makes the
                # section INCOMPLETE — abort, never skip.
                raise NativeSectionsError(
                    f"native sections: profile '{prof.key}' member service "
                    f"'{svc.keyword}' (id={svc.id}) has no eligible result "
                    f"(need review_state in {ELIGIBLE_STATES}) on {sample_id}"
                )
            if not (row.result_value or "").strip():
                # Rule 3 (row half): an eligible row with an empty result.
                raise NativeSectionsError(
                    f"native sections: profile '{prof.key}' row "
                    f"'{svc.keyword}' has an empty result on {sample_id}"
                )
            rows.append({
                "keyword": svc.keyword,
                "name": svc.title,
                "result": row.result_value,
                "unit": row.result_unit or (svc.unit or ""),
                "method": _method_label(db, row.method_id),
                "specification": None,   # COABuilder fills from baked specs
                "conforms": None,        # COABuilder fills from baked specs
            })
        if not rows:
            # Rule 3 (section half): unreachable while members are required
            # non-empty in _ordered_native_profiles, kept as defence.
            raise NativeSectionsError(
                f"native sections: profile '{prof.key}' produced zero rows on {sample_id}"
            )
        sections.append({
            "profile_key": prof.key,
            "title": prof.coa_section_title or prof.name,
            "archetype": prof.coa_archetype,
            "sort_order": prof.coa_sort_order,
            "rows": rows,
        })

    return {
        "sample_id": sample_id,
        "ordered_profiles": [p.key for p in profiles],
        "sections": sections,
    }
```

Verify the real model/class names before writing (`HplcMethod` — grep `hplc_methods` in `backend/models.py` for the actual class name; adjust the import if it differs). `backend/coa/` already exists (`coa/source_resolver.py`, `coa/variance_series.py`) — no `__init__.py` work needed if it's already a package; check.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_native_sections.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/coa/native_sections.py backend/tests/test_native_sections.py
git commit -m "feat(coa): native-sections builder — wire document, fail-closed rules 1-4"
```

---

### Task 4: S2S endpoint + fail-closed attach on the COA-generation paths (Accu-Mk1)

**Files:**
- Modify: `backend/main.py` (new endpoint beside `get_sample_variance_payload` ~:18258; primary-COA attach inside `generate_sample_coa` ~:10144-10188; regular-child attach in `_maybe_emit_regular_coa_child` ~:9987)
- Test: `backend/tests/test_coa_sections_endpoint.py` (new)

**Interfaces:**
- Consumes: `build_native_sections` / `NativeSectionsError` (Task 3), `require_internal_service_token` (`backend/auth.py:137`).
- Produces: `GET /samples/{sample_id}/coa-sections` (X-Service-Token; 404 unknown sample; 502 with detail on any builder failure; 200 with the document otherwise). Primary-COA and regular-child bodies gain `native_sections` (attached fail-closed). Integration Service (Task 9) consumes the endpoint.

- [ ] **Step 1: Write the failing tests**

```python
"""S2S coa-sections endpoint + fail-closed attach semantics."""
from unittest.mock import patch

from coa.native_sections import NativeSectionsError

SVC_TOKEN_HEADER = {"X-Service-Token": "test-internal-token"}
# conftest must set ACCUMK1_INTERNAL_SERVICE_TOKEN=test-internal-token for
# these tests (mirror how the variance-payload endpoint's tests do it — grep
# tests for require_internal_service_token / variance-payload usage first).


def test_coa_sections_endpoint_requires_token(client, db_session):
    r = client.get("/samples/P-1/coa-sections")
    assert r.status_code == 401


def test_coa_sections_endpoint_404_unknown_sample(client, db_session):
    r = client.get("/samples/NOPE/coa-sections", headers=SVC_TOKEN_HEADER)
    assert r.status_code == 404


def test_coa_sections_endpoint_returns_document(client, db_session, monkeypatch):
    from models import LimsSample
    db_session.add(LimsSample(sample_id="P-8001")); db_session.commit()
    with patch("main.build_native_sections",
               return_value={"sample_id": "P-8001", "ordered_profiles": [], "sections": []}):
        r = client.get("/samples/P-8001/coa-sections", headers=SVC_TOKEN_HEADER)
    assert r.status_code == 200
    assert r.json() == {"sample_id": "P-8001", "ordered_profiles": [], "sections": []}


def test_coa_sections_endpoint_502_on_builder_failure(client, db_session):
    from models import LimsSample
    db_session.add(LimsSample(sample_id="P-8002")); db_session.commit()
    with patch("main.build_native_sections",
               side_effect=NativeSectionsError("order lookup failed")):
        r = client.get("/samples/P-8002/coa-sections", headers=SVC_TOKEN_HEADER)
    assert r.status_code == 502
    assert "order lookup failed" in r.json()["detail"]
```

(Import path for the patch target depends on how the endpoint imports the builder — patch where it is LOOKED UP. If the endpoint does `from coa.native_sections import build_native_sections` at module top, patch `main.build_native_sections` as above; if it imports inside the function, patch `coa.native_sections.build_native_sections`.)

The attach semantics on `generate_sample_coa` are covered by an integration-marked test if the existing suite has a harness for it — grep `generate_sample_coa` in `backend/tests/`; if no harness exists, the attach is verified in Task 10's stack E2E and by the mutation check in Step 3. State which applies in the report.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_coa_sections_endpoint.py -v`
Expected: 404s from FastAPI (route not defined) → FAIL.

- [ ] **Step 3: Implement**

(a) Endpoint, placed directly below `get_sample_variance_payload` (~main.py:18291), same shape:

```python
@app.get("/samples/{sample_id}/coa-sections")
def get_sample_coa_sections(
    sample_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_internal_service_token),
):
    """Native COA sections document for S2S consumers (spec 2).

    Called by integration-service on the additional-COA path. FAIL-CLOSED:
    unlike /variance-payload (best-effort overlay), any assembly failure is a
    502 and the caller must NOT generate a certificate. 404 = sample unknown
    to Mk1 (pre-Mk1 legacy sample; nothing native can exist). 200 with empty
    ordered_profiles/sections = valid "nothing native ordered".
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise HTTPException(status_code=404, detail=f"sample {sample_id} not found")
    from coa.native_sections import NativeSectionsError, build_native_sections
    try:
        return build_native_sections(db, parent)
    except NativeSectionsError as e:
        raise HTTPException(status_code=502, detail=e.detail)
```

(b) Primary-COA attach in `generate_sample_coa` — immediately AFTER the existing variance block (`alias_body.update(process_variance_fields(db, _parent_row))`, inside the `if _parent_row is not None:` branch) and BEFORE the `httpx` POST:

```python
            # Native sections (spec 2) — FAIL-CLOSED, unlike the best-effort
            # variance overlay above. If the document cannot be assembled the
            # certificate must not be generated at all.
            from coa.native_sections import NativeSectionsError, build_native_sections
            try:
                _native_doc = build_native_sections(db, _parent_row)
            except NativeSectionsError as e:
                return SampleCOAActionResponse(
                    success=False,
                    message=f"COA aborted — {e.detail}",
                )
            alias_body["native_sections"] = _native_doc
```

Attach unconditionally (an empty document is the "nothing ordered" cross-check COABuilder validates against; a COABuilder without native support ignores the unknown key). Sub-sample COAs (`is_sub`) and per-vial child COAs (`generate_vial_coas`, ~:10407) are NOT touched — native sections are parent-tier.

(c) Regular-child attach in `_maybe_emit_regular_coa_child` (~:9987): this child IS a full certificate of the parent (the Core COA for a variance lot), so it needs the identical fail-closed attach. Read the function; it builds its own request body for `POST /process/{sample_id}` — apply the same try/except + `body["native_sections"] = _native_doc` pattern, aborting the child emission (and logging at ERROR with the `e.detail`) on failure rather than emitting a section-less certificate. If the function shares the body-construction helper with `generate_sample_coa`, attach at the shared site once — do not attach twice.

(d) Mutation check: comment out the `alias_body["native_sections"] = _native_doc` line, confirm `test_coa_sections_endpoint_returns_document` still passes but grep proves the primary path no longer references `native_sections` — then restore. (The endpoint tests cannot see the attach; the E2E in Task 10 is its real coverage. The mutation check documents the wiring exists.)

- [ ] **Step 4: Run tests + failure-set diff**

Run: `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_coa_sections_endpoint.py tests/test_native_sections.py tests/test_native_promote.py -v`
Expected: all PASS.
Full failure-set diff vs baseline (same command as Task 1 Step 6): empty.
Run: `cd /c/tmp/Accu-Mk1-coa-sections && npx tsc --noEmit` — clean (no frontend change in this task; cheap sanity).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_coa_sections_endpoint.py
git commit -m "feat(coa): S2S coa-sections endpoint; fail-closed attach on primary + regular-child COA paths"
```

---

### Task 5: COABuilder native-sections module — validation, spec fill, badge downgrade

**Repo: COABuilder** (worktree `C:\tmp\coabuilder-coa-sections`, branch from `origin/master` = `49ff801`).

**Files:**
- Create: `src/coabuilder_core/native_sections.py`
- Modify: `src/coabuilder_core/baked_specs.py`
- Modify: `src/coabuilder_core/data_model.py` (`CoAData` gains one field)
- Test: `tests/test_native_sections_validation.py` (new; if the repo keeps tests elsewhere, follow its existing layout — check for a `tests/` dir first)

**Interfaces:**
- Consumes: `BAKED_SPECS` / `TEST_TECHNIQUES` / `lookup_spec` / `lookup_technique` (`baked_specs.py`), `CoAData` (`data_model.py`).
- Produces:
  - `class NativeSectionsValidationError(Exception)` with `.detail: str`.
  - `attach_native_sections(data: CoAData, doc: Optional[dict]) -> None` — validates the wire document (fail-closed rules 2, 3, 5, 6), fills `specification`/`conforms`/`status` per row from baked specs, assigns the enriched sections to `data.native_sections`, and downgrades `data.overall_status_badge` to `"FAILED"` if any row does not conform. `doc=None` or an absent key = legacy caller, no-op (back-compat).
  - `CoAData.native_sections: list = field(default_factory=list)` — enriched section dicts; Tasks 6 and 7 consume it.
  - `INFORMATIONAL_KEYWORDS: set[str]` and `BakedSpec.equals: str` (string-match specs, e.g. Sterility "No Growth") in `baked_specs.py`.

- [ ] **Step 1: Write the failing tests**

```python
"""attach_native_sections: fail-closed rules 2/3/5/6, spec fill, badge downgrade."""
import pytest

from coabuilder_core.data_model import CoAData
from coabuilder_core.native_sections import (
    NativeSectionsValidationError,
    attach_native_sections,
)


def _doc(rows=None, *, profiles=None, archetype="limit_table"):
    rows = rows if rows is not None else [
        {"keyword": "HM-PB", "name": "Lead (Pb)", "result": "0.12", "unit": "ppm",
         "method": "ICP-MS", "specification": None, "conforms": None},
    ]
    return {
        "sample_id": "P-7001",
        "ordered_profiles": profiles if profiles is not None else ["heavy_metals"],
        "sections": [{
            "profile_key": "heavy_metals", "title": "Heavy Metals",
            "archetype": archetype, "sort_order": 10, "rows": rows,
        }],
    }


def _coa(matrix="Peptide", badge="PASSED"):
    d = CoAData()
    d.matrix_type = matrix
    d.overall_status_badge = badge
    return d


def test_conforming_row_filled_from_baked_specs():
    d = _coa()
    attach_native_sections(d, _doc())
    [sec] = d.native_sections
    row = sec["rows"][0]
    assert row["specification"]          # filled, non-empty
    assert row["conforms"] is True
    assert d.overall_status_badge == "PASSED"


def test_nonconforming_row_downgrades_badge():
    d = _coa()
    doc = _doc(rows=[{"keyword": "HM-PB", "name": "Lead (Pb)", "result": "9.99",
                      "unit": "ppm", "method": "ICP-MS",
                      "specification": None, "conforms": None}])
    attach_native_sections(d, doc)
    assert d.native_sections[0]["rows"][0]["conforms"] is False
    assert d.overall_status_badge == "FAILED"


def test_rule2_ordered_profile_without_section_aborts():
    d = _coa()
    doc = _doc(profiles=["heavy_metals", "moisture"])   # no moisture section
    with pytest.raises(NativeSectionsValidationError, match="moisture"):
        attach_native_sections(d, doc)


def test_rule3_empty_result_aborts():
    d = _coa()
    doc = _doc(rows=[{"keyword": "HM-PB", "name": "Lead (Pb)", "result": "",
                      "unit": "ppm", "method": "", "specification": None,
                      "conforms": None}])
    with pytest.raises(NativeSectionsValidationError, match="empty result"):
        attach_native_sections(d, doc)


def test_rule5_unknown_keyword_aborts():
    d = _coa()
    doc = _doc(rows=[{"keyword": "HM-UNOBTAINIUM", "name": "X", "result": "1",
                      "unit": "ppm", "method": "", "specification": None,
                      "conforms": None}])
    with pytest.raises(NativeSectionsValidationError, match="HM-UNOBTAINIUM"):
        attach_native_sections(d, doc)


def test_rule6_unknown_archetype_aborts():
    d = _coa()
    with pytest.raises(NativeSectionsValidationError, match="fancy_chart"):
        attach_native_sections(d, _doc(archetype="fancy_chart"))


def test_informational_keyword_renders_without_spec():
    from coabuilder_core.baked_specs import INFORMATIONAL_KEYWORDS
    INFORMATIONAL_KEYWORDS.add("HM-INFO-TEST")   # test-scoped; no baked entry
    try:
        d = _coa()
        doc = _doc(rows=[{"keyword": "HM-INFO-TEST", "name": "Info", "result": "42",
                          "unit": "", "method": "", "specification": None,
                          "conforms": None}])
        attach_native_sections(d, doc)
        row = d.native_sections[0]["rows"][0]
        assert row["specification"] == "" and row["conforms"] is None
        assert d.overall_status_badge == "PASSED"   # informational never fails
    finally:
        INFORMATIONAL_KEYWORDS.discard("HM-INFO-TEST")


def test_equals_spec_string_match():
    d = _coa()
    doc = _doc(rows=[{"keyword": "STERILITY_USP71", "name": "Sterility (USP<71>)",
                      "result": "No Growth", "unit": "", "method": "",
                      "specification": None, "conforms": None}])
    attach_native_sections(d, doc)
    assert d.native_sections[0]["rows"][0]["conforms"] is True


def test_unparseable_numeric_result_aborts():
    d = _coa()
    doc = _doc(rows=[{"keyword": "HM-PB", "name": "Lead (Pb)", "result": "N/A",
                      "unit": "ppm", "method": "", "specification": None,
                      "conforms": None}])
    with pytest.raises(NativeSectionsValidationError, match="not numeric"):
        attach_native_sections(d, doc)


def test_none_doc_is_noop_backcompat():
    d = _coa()
    attach_native_sections(d, None)
    assert d.native_sections == [] and d.overall_status_badge == "PASSED"


def test_empty_doc_is_valid_nothing_ordered():
    d = _coa()
    attach_native_sections(d, {"sample_id": "P-1", "ordered_profiles": [], "sections": []})
    assert d.native_sections == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/tmp/coabuilder-coa-sections && python -m pytest tests/test_native_sections_validation.py -v`
Expected: FAIL — `ModuleNotFoundError: coabuilder_core.native_sections`. (Check how existing tests import the package — `src/` layout may need the repo's existing pytest config/conftest; follow it.)

- [ ] **Step 3: Extend `baked_specs.py`**

Add `equals` to the TypedDict, the informational set, the heavy-metals + sterility entries, and techniques:

```python
class BakedSpec(TypedDict, total=False):
    min: float           # lower bound (inclusive) — None/absent = no lower bound
    max: float           # upper bound (inclusive) — None/absent = no upper bound
    equals: str          # exact string match (case-insensitive) — for text results
    unit: str            # display unit; independent of the analysis's SENAITE unit
    display: str         # human-friendly spec string for the COA (e.g. "0.9% (v/v) ±10%")
```

```python
# Keywords that render on a native COA section with an EMPTY Specification and
# Verdict, by design (informational results). A keyword absent from BOTH this
# set and BAKED_SPECS aborts the COA (fail-closed rule 5): a result printed
# without a verdict because nobody added its limit is exactly the failure that
# rule exists to prevent.
INFORMATIONAL_KEYWORDS: set[str] = set()
```

```python
    # --- Native sections (spec 2), first tenants -----------------------------
    # Heavy Metals on peptide samples, ICP-MS, USP <232>-shaped initial limits.
    # >>> Handler/lab gate G-A: the lab confirms or replaces these numbers
    # >>> before the combined deploy; nothing renders in prod until then.
    ("Peptide", "HM-PB"): {"max": 0.5,  "unit": "ppm", "display": "≤ 0.5 ppm"},
    ("Peptide", "HM-AS"): {"max": 1.5,  "unit": "ppm", "display": "≤ 1.5 ppm"},
    ("Peptide", "HM-CD"): {"max": 0.5,  "unit": "ppm", "display": "≤ 0.5 ppm"},
    ("Peptide", "HM-HG"): {"max": 1.5,  "unit": "ppm", "display": "≤ 1.5 ppm"},
    # Sterility USP<71> as a native text-match spec (string equality).
    ("Peptide", "STERILITY_USP71"): {"equals": "No Growth", "display": "No Growth"},
```

```python
TEST_TECHNIQUES: dict[str, str] = {
    "Benzyl_Alcohol_Assay": "HPLC",
    "PH-DETERM": "pH",
    "FILL-NET-CONTENT": "Gravimetric",
    "HM-PB": "ICP-MS",
    "HM-AS": "ICP-MS",
    "HM-CD": "ICP-MS",
    "HM-HG": "ICP-MS",
    "STERILITY_USP71": "USP <71>",
}
```

- [ ] **Step 4: Add the `CoAData` field**

`data_model.py`, next to `addon_results`:

```python
    # Native COA sections (spec 2): enriched section dicts (specification /
    # conforms / status filled from baked specs by attach_native_sections).
    # Empty for samples with no reportable native profiles.
    native_sections: list = field(default_factory=list)
```

- [ ] **Step 5: Implement `src/coabuilder_core/native_sections.py`**

```python
"""Native COA sections: fail-closed validation + baked-spec enrichment.

The wire document arrives from Mk1 (primary path) or Integration Service
(additional path) as `native_sections` in the request body. Mk1 sends
specification/conforms as null, ALWAYS — this module fills them from
baked_specs so the wire format survives the future conformance-engine
migration unchanged (Mk1 will fill the same two fields; this lookup then
gets deleted; the renderer never changes).

Fail-closed rules enforced here (2, 3, 5, 6 of the spec's six; 1 and 4 are
enforced at the producers): a violation raises NativeSectionsValidationError
and the certificate must not be generated.
"""
from __future__ import annotations

from typing import Optional

from .baked_specs import INFORMATIONAL_KEYWORDS, lookup_spec

KNOWN_ARCHETYPES = {"limit_table"}


class NativeSectionsValidationError(Exception):
    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def _verdict(keyword: str, result: str, spec: dict) -> bool:
    """Conformance of a native row against its baked spec."""
    if "equals" in spec:
        return result.strip().lower() == str(spec["equals"]).strip().lower()
    try:
        value = float(str(result).strip())
    except ValueError:
        raise NativeSectionsValidationError(
            f"native sections: result {result!r} for {keyword!r} is not numeric "
            f"but its spec is a numeric range — cannot verdict, aborting"
        )
    if "min" in spec and spec["min"] is not None and value < spec["min"]:
        return False
    if "max" in spec and spec["max"] is not None and value > spec["max"]:
        return False
    return True


def attach_native_sections(data, doc: Optional[dict]) -> None:
    """Validate + enrich + attach. Mutates `data` (CoAData) in place.

    doc=None (or missing key upstream) = legacy caller without native
    support: no-op. An empty document ({"ordered_profiles": [], ...}) is the
    valid "nothing native ordered" case.
    """
    if not doc:
        return

    sections = doc.get("sections") or []
    ordered = doc.get("ordered_profiles") or []

    # Rule 2: every ordered profile must have a section. This is what lets a
    # caller tell "nothing was ordered" apart from "something broke".
    section_keys = {s.get("profile_key") for s in sections}
    missing = [k for k in ordered if k not in section_keys]
    if missing:
        raise NativeSectionsValidationError(
            f"native sections: ordered profile(s) {missing} have no section — "
            f"a paid test would be silently missing; aborting"
        )
    extra = [s.get("profile_key") for s in sections if s.get("profile_key") not in ordered]
    if extra:
        raise NativeSectionsValidationError(
            f"native sections: section(s) {extra} not in ordered_profiles — "
            f"refusing to print un-ordered results"
        )

    matrix = getattr(data, "matrix_type", "") or ""
    enriched = []
    any_nonconforming = False
    for sec in sorted(sections, key=lambda s: (s.get("sort_order", 0), s.get("profile_key", ""))):
        # Rule 6: exactly one legal archetype today; unknown ABORTS, never skips.
        archetype = sec.get("archetype")
        if archetype not in KNOWN_ARCHETYPES:
            raise NativeSectionsValidationError(
                f"native sections: unrecognised archetype {archetype!r} on "
                f"profile {sec.get('profile_key')!r}; known: {sorted(KNOWN_ARCHETYPES)}"
            )
        rows = sec.get("rows") or []
        # Rule 3 (section half): zero rows.
        if not rows:
            raise NativeSectionsValidationError(
                f"native sections: profile {sec.get('profile_key')!r} has zero rows"
            )
        out_rows = []
        for row in rows:
            keyword = row.get("keyword") or ""
            result = row.get("result")
            # Rule 3 (row half): null/empty result.
            if result is None or not str(result).strip():
                raise NativeSectionsValidationError(
                    f"native sections: row {keyword!r} in profile "
                    f"{sec.get('profile_key')!r} has an empty result"
                )
            if keyword in INFORMATIONAL_KEYWORDS:
                out_rows.append({**row, "specification": "", "conforms": None,
                                 "status": ""})
                continue
            spec = lookup_spec(matrix, keyword)
            # Rule 5: absent from the table and not informational = abort.
            if spec is None:
                raise NativeSectionsValidationError(
                    f"native sections: keyword {keyword!r} has no baked spec for "
                    f"matrix {matrix!r} and is not marked informational — a result "
                    f"must not print without a verdict; aborting"
                )
            conforms = _verdict(keyword, str(result), spec)
            any_nonconforming = any_nonconforming or not conforms
            out_rows.append({
                **row,
                "specification": spec.get("display", ""),
                "conforms": conforms,
                "status": "Conforms" if conforms else "Does Not Conform",
            })
        enriched.append({**sec, "rows": out_rows})

    data.native_sections = enriched

    # Overall-verdict downgrade: native sections bypass both engines, so a
    # non-conforming native row must force the badge — matching the existing
    # rule that overall_status fails on any non-conforming reported test.
    if any_nonconforming:
        data.overall_status_badge = "FAILED"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /c/tmp/coabuilder-coa-sections && python -m pytest tests/test_native_sections_validation.py -v`
Expected: all PASS. Then run the full COABuilder suite (`python -m pytest`) — no new failures vs the branch-point baseline (record the baseline first if non-empty).

- [ ] **Step 7: Commit**

```bash
git add src/coabuilder_core/native_sections.py src/coabuilder_core/baked_specs.py src/coabuilder_core/data_model.py tests/test_native_sections_validation.py
git commit -m "feat(native-coa): validation module, baked HM/USP71 specs, badge downgrade"
```

---

### Task 6: COABuilder server intake + digital-COA parity

**Repo: COABuilder.**

**Files:**
- Modify: `scripts/server.py` (`ProcessSampleRequest` ~:500, `process_sample` ~:541-620, `ProcessAdditionalRequest` ~:913, `process_additional_coa` ~:970, `_build_coa_data_json` ~:87-236)
- Test: `tests/test_native_sections_server.py` (new)

**Interfaces:**
- Consumes: `attach_native_sections` / `NativeSectionsValidationError` (Task 5).
- Produces: both request models accept `native_sections: Optional[dict] = None`; a validation failure returns **422** with the rule's detail (mirroring the existing non-conforming-remarks 422 precedent); `_build_coa_data_json` output gains a top-level `"native_sections"` key (list, same enriched shape the PDF renders — digital parity).

- [ ] **Step 1: Write the failing tests**

Test at the unit level (route handlers are heavy on SENAITE I/O): the request models parse the new field, and `_build_coa_data_json` emits it.

```python
"""Server intake + digital parity for native sections."""
from scripts.server import ProcessAdditionalRequest, ProcessSampleRequest, _build_coa_data_json
from coabuilder_core.data_model import CoAData


_DOC = {"sample_id": "P-1", "ordered_profiles": ["heavy_metals"],
        "sections": [{"profile_key": "heavy_metals", "title": "Heavy Metals",
                      "archetype": "limit_table", "sort_order": 10,
                      "rows": [{"keyword": "HM-PB", "name": "Lead (Pb)",
                                "result": "0.12", "unit": "ppm", "method": "ICP-MS",
                                "specification": None, "conforms": None}]}]}


def test_process_request_accepts_native_sections():
    req = ProcessSampleRequest(native_sections=_DOC)
    assert req.native_sections["ordered_profiles"] == ["heavy_metals"]
    assert ProcessSampleRequest().native_sections is None   # back-compat


def test_process_additional_request_accepts_native_sections():
    req = ProcessAdditionalRequest(
        config_id="c1", coa_index=1, coa_info={}, primary_generation_id="g1",
        native_sections=_DOC,
    )
    assert req.native_sections is not None


def test_coa_data_json_emits_native_sections():
    d = CoAData()
    d.native_sections = [{"profile_key": "heavy_metals", "title": "Heavy Metals",
                          "archetype": "limit_table", "sort_order": 10,
                          "rows": [{"keyword": "HM-PB", "name": "Lead (Pb)",
                                    "result": "0.12", "unit": "ppm", "method": "ICP-MS",
                                    "specification": "≤ 0.5 ppm", "conforms": True,
                                    "status": "Conforms"}]}]
    out = _build_coa_data_json(d)
    assert out["native_sections"] == d.native_sections


def test_coa_data_json_native_sections_key_absent_when_empty():
    out = _build_coa_data_json(CoAData())
    assert "native_sections" not in out
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/tmp/coabuilder-coa-sections && python -m pytest tests/test_native_sections_server.py -v`
Expected: FAIL (unknown field / missing key).

- [ ] **Step 3: Implement**

(a) Add to BOTH request models (`ProcessSampleRequest` and `ProcessAdditionalRequest`), with the same comment:

```python
    # Native COA sections wire document from Mk1 (spec 2): {sample_id,
    # ordered_profiles, sections}. FAIL-CLOSED — a validation failure aborts
    # generation with 422. None = caller without native support (legacy) or
    # nothing native ordered upstream.
    native_sections: Optional[dict] = None
```

(b) In `process_sample`, immediately after `data = client.fetch_sample_data(...)` (~:620) — and in `process_additional_coa` after its `fetch_sample_data` (~:970) — the identical block:

```python
        # Native sections (spec 2): validate + enrich + attach, FAIL-CLOSED.
        # Runs after the engine set overall_status_badge so the downgrade in
        # attach_native_sections is the final word on the badge.
        from coabuilder_core.native_sections import (
            NativeSectionsValidationError,
            attach_native_sections,
        )
        try:
            attach_native_sections(data, body.native_sections if body else None)
        except NativeSectionsValidationError as e:
            raise HTTPException(status_code=422, detail=e.detail)
```

(In `process_additional_coa` the body is required, so `body.native_sections` directly.) Check how each route raises errors today (`HTTPException` import exists in server.py — verify) and where the additional-COA loop inside `process_sample` builds `alt_data` (~:836): the additional-COA loop re-fetches per config — apply `attach_native_sections(alt_data, body.native_sections if body else None)` there too, so re-branded COAs generated inline by the primary flow also carry sections.

(c) `_build_coa_data_json`: add after the `"variance_report"` key:

```python
        # Native COA sections (spec 2) — digital parity with the PDF. The
        # enriched rows (specification/conforms filled) are what both render.
        **({"native_sections": data.native_sections}
           if getattr(data, "native_sections", None) else {}),
```

(If the return dict's construction style makes `**` awkward there, assign into the dict after construction — match the file's style.)

- [ ] **Step 4: Run tests + full suite**

Run: `cd /c/tmp/coabuilder-coa-sections && python -m pytest tests/test_native_sections_server.py tests/test_native_sections_validation.py -v` — all PASS.
Full suite: no new failures vs baseline.

- [ ] **Step 5: Commit**

```bash
git add scripts/server.py tests/test_native_sections_server.py
git commit -m "feat(native-coa): request intake on both process routes; digital coa_data parity"
```

---

### Task 7: COABuilder renderer — template, page routing, allow-list, drawing, pagination

**Repo: COABuilder.**

**Files:**
- Create: `Templates/Additional Analyses/layout.json`
- Modify: `src/coabuilder_core/logic.py` (`resolve_templates`)
- Modify: `src/coabuilder_core/generator.py` (dynamic-background condition ~:246, frame loop ~:293, new `_draw_native_sections`)
- Modify: `src/coabuilder_core/native_sections.py` (pagination helper)
- Test: `tests/test_native_sections_render.py` (new)

**Interfaces:**
- Consumes: `CoAData.native_sections` (Task 5).
- Produces: `native_section_page_count(sections) -> int` and `native_section_page_slice(sections, ordinal) -> list` in `native_sections.py` (both pure; slice returns `[(section, row_start, row_end), ...]` for that page); `resolve_templates` appends `"Additional Analyses"` × page count in BOTH matrix branches; `generator._draw_native_sections(c, cfg, data, page_h, ordinal)` draws one page's slice; the dynamic-background condition becomes an allow-list.

- [ ] **Step 1: Create the template**

`Templates/Additional Analyses/layout.json` — the variance template's header/footer/images/backgrounds copied verbatim, with the magic frame renamed and `VarianceList` absent:

```json
{
    "frames": {
        "Client Logo": { "x": 24.0, "y": 90.0, "width": 45.0, "height": 45.0, "font": "Helvetica", "size": 10.0, "leading": 12.0, "row_height": 0.0, "gap": 2.0, "align": "left", "valign": "top", "color": "#000000", "fields": [] },
        "HEADER_COMPANY": { "x": 84.0, "y": 85.0, "width": 199.4, "height": 11.8, "font": "Inter", "size": 10.0, "leading": 10.5, "row_height": 0.0, "gap": 2.0, "align": "left", "valign": "top", "color": "#c6cee3", "fields": ["client_company_name"] },
        "HEADER_ADDRESS": { "x": 84.0, "y": 98.0, "width": 199.4, "height": 47.3, "font": "Inter", "size": 8.0, "leading": 10.5, "row_height": 0.0, "gap": 0.0, "align": "left", "valign": "top", "color": "#c6cee3", "fields": ["client_address_line1", "client_phone", "client_email", "client_website"] },
        "HEADER_SAMPLE": { "x": 459.3, "y": 84.6, "width": 125.6, "height": 43.0, "font": "Inter", "size": 8.0, "leading": 11.0, "row_height": 0.0, "gap": 2.0, "align": "right", "valign": "top", "color": "#c6cee3", "fields": ["sample_name", "coa_key", "received_date", "published_date"] },
        "FOOTER_CERTIFIED": { "x": 92.5, "y": 741.1, "width": 87.0, "height": 40.5, "font": "Inter", "size": 8.0, "leading": 10.0, "row_height": 0.0, "gap": 2.0, "align": "left", "valign": "top", "color": "#e2e7f1", "fields": ["certified_by_name", "certified_by_title", "published_date"] },
        "FOOTER_REVIEWED": { "x": 258.8, "y": 741.1, "width": 93.0, "height": 40.5, "font": "Inter", "size": 8.0, "leading": 10.0, "row_height": 0.0, "gap": 2.0, "align": "left", "valign": "top", "color": "#e2e7f1", "fields": ["reviewed_by_name", "reviewed_by_title", "reviewed_by_date"] },
        "FOOTER_QR": { "x": 515.4, "y": 716.9, "width": 60.0, "height": 60.0, "font": "Inter", "size": 8.0, "leading": 12.0, "row_height": 0.0, "gap": 2.0, "align": "center", "valign": "top", "color": "#e2e7f1", "fields": ["coa_key"] },
        "FOOTER_CERTIFIED_Title": { "x": 188.0, "y": 721.1, "width": 114.7, "height": 15.5, "font": "Inter", "size": 9.0, "leading": 10.0, "row_height": 0.0, "gap": 0.0, "align": "left", "valign": "top", "color": "#e2e7f1", "fields": ["certified_by_section_title"] },
        "FOOTER_Accumark": { "x": 418.3, "y": 745.0, "width": 88.6, "height": 43.0, "font": "Inter", "size": 8.0, "leading": 11.0, "row_height": 0.0, "gap": 0.0, "align": "right", "valign": "top", "color": "#c6cee3", "fields": ["coa_key", "published_date"] },
        "FOOTER_Reviewed_Title": { "x": 22.3, "y": 721.1, "width": 114.7, "height": 15.5, "font": "Inter", "size": 9.0, "leading": 10.0, "row_height": 0.0, "gap": 0.0, "align": "left", "valign": "top", "color": "#e2e7f1", "fields": ["certified_by_section_title"] },
        "NativeSections": { "x": 18.6, "y": 172.0, "width": 573.9, "height": 500.0, "font": "Inter", "size": 8.0, "leading": 10.5, "row_height": 0.0, "gap": 0.0, "align": "center", "valign": "center", "color": "#0e1534", "fields": [] }
    },
    "images": {
        "Client Logo": { "visible": true, "x": 31.4, "y": 90.0, "width": 45.0, "height": 45.0, "data_field": "client_logo_path", "fallback": "../UnifiedCOA_v1/DefaultCompany.jpg" },
        "Certified By Signature": { "visible": true, "x": 21.7, "y": 736.9, "width": 70.0, "height": 40.0, "data_field": "certified_by_signature" },
        "Reviewed By Signature": { "visible": true, "x": 188.0, "y": 738.5, "width": 70.0, "height": 40.0, "data_field": "reviewed_by_signature" }
    },
    "backgrounds": { "background": { "file": "../UnifiedCOA_v1/Single & Blend Blank Page.pdf" } }
}
```

(`NativeSections` height 500.0 vs variance's 400.0 — the sections table may run longer; the frame bottom at y=172+500=672 stays above the footers at y≥716.9.)

- [ ] **Step 2: Write the failing tests**

```python
"""Renderer routing + pagination for native sections."""
import pytest

from coabuilder_core.data_model import CoAData
from coabuilder_core.logic import resolve_templates
from coabuilder_core.native_sections import (
    NativeSectionsValidationError,
    native_section_page_count,
    native_section_page_slice,
)


def _sections(n_rows, n_sections=1):
    return [{
        "profile_key": f"p{s}", "title": f"Section {s}", "archetype": "limit_table",
        "sort_order": s,
        "rows": [{"keyword": f"K{s}-{i}", "name": f"Row {i}", "result": "1",
                  "unit": "ppm", "method": "", "specification": "≤ 2", "conforms": True,
                  "status": "Conforms"} for i in range(n_rows)],
    } for s in range(n_sections)]


def test_peptide_matrix_appends_native_page():
    d = CoAData()
    d.matrix_type = "Peptide"
    d.declared_components = ["BPC-157"]
    d.native_sections = _sections(3)
    assert resolve_templates(d).count("Additional Analyses") == 1


def test_non_peptide_matrix_appends_native_page():
    """The early-return trap: BW certificates must still get the section page."""
    d = CoAData()
    d.matrix_type = "Bacteriostatic Water"
    d.native_sections = _sections(3)
    templates = resolve_templates(d)
    assert templates[0] == "Generic Page 1"
    assert templates.count("Additional Analyses") == 1


def test_no_native_sections_appends_nothing():
    d = CoAData()
    d.matrix_type = "Peptide"
    d.declared_components = ["BPC-157"]
    assert "Additional Analyses" not in resolve_templates(d)


def test_many_rows_paginate_without_truncation():
    secs = _sections(80)          # far more than one page fits
    n = native_section_page_count(secs)
    assert n >= 2
    seen = 0
    for ordinal in range(n):
        for _sec, start, end in native_section_page_slice(secs, ordinal):
            seen += end - start
    assert seen == 80             # every row lands exactly once


def test_multi_page_template_count_matches():
    d = CoAData()
    d.matrix_type = "Peptide"
    d.declared_components = ["BPC-157"]
    d.native_sections = _sections(80)
    n = native_section_page_count(d.native_sections)
    assert resolve_templates(d).count("Additional Analyses") == n
```

Run: `cd /c/tmp/coabuilder-coa-sections && python -m pytest tests/test_native_sections_render.py -v` — Expected: FAIL (helpers/appends missing).

- [ ] **Step 3: Implement pagination helpers in `native_sections.py`**

```python
# ── Pagination (pure layout math; the generator draws what these slice) ──────
# Geometry mirrors Templates/Additional Analyses/layout.json's NativeSections
# frame (height 500pt) and _draw_native_sections' bands: section heading 20pt,
# column sub-header 14pt, row 16pt. A section's heading + sub-header + first
# row must fit together (no orphan headings).
FRAME_HEIGHT = 500.0
SECTION_HEAD_H = 20.0
SUBHEAD_H = 14.0
ROW_H = 16.0
SECTION_GAP = 10.0


def _page_capacity_used(items):
    used = 0.0
    for _sec, start, end in items:
        used += SECTION_HEAD_H + SUBHEAD_H + (end - start) * ROW_H + SECTION_GAP
    return used


def _paginate(sections):
    """[(section, row_start, row_end)] per page. Sections are never silently
    truncated: a section whose heading + one row cannot fit on an EMPTY page
    is unrenderable and aborts (truncation is not an acceptable outcome)."""
    min_needed = SECTION_HEAD_H + SUBHEAD_H + ROW_H
    if min_needed > FRAME_HEIGHT:
        raise NativeSectionsValidationError(
            "native sections: frame too small for a single row — layout broken"
        )
    pages, current, remaining = [], [], FRAME_HEIGHT
    for sec in sections:
        n_rows, start = len(sec["rows"]), 0
        while start < n_rows:
            fixed = SECTION_HEAD_H + SUBHEAD_H + SECTION_GAP
            fit = int((remaining - fixed) // ROW_H)
            if fit < 1:
                if not current:
                    raise NativeSectionsValidationError(
                        f"native sections: section {sec.get('profile_key')!r} "
                        f"cannot be laid out on an empty page — aborting"
                    )
                pages.append(current)
                current, remaining = [], FRAME_HEIGHT
                continue
            end = min(start + fit, n_rows)
            current.append((sec, start, end))
            remaining -= SECTION_HEAD_H + SUBHEAD_H + (end - start) * ROW_H + SECTION_GAP
            start = end
    if current:
        pages.append(current)
    return pages


def native_section_page_count(sections) -> int:
    if not sections:
        return 0
    return len(_paginate(sections))


def native_section_page_slice(sections, ordinal: int):
    return _paginate(sections)[ordinal]
```

- [ ] **Step 4: Wire `resolve_templates` — BOTH branches**

In `logic.py`, import at top: `from .native_sections import native_section_page_count`. In the **non-peptide branch** (before its returns):

```python
    if data.matrix_type and data.matrix_type not in _PEPTIDE_MATRICES:
        # (existing comment about the variance-list page staying peptide-only)
        has_addons = bool(data.addon_results)
        base = ["Generic Page 1", "Generic Page 2 - Addons"] if has_addons else ["Generic Page 1"]
        # Native sections render on EVERY matrix — this branch returning early
        # is exactly how heavy metals would silently vanish from BacWater
        # certificates (spec 2 structural trap #1).
        base += ["Additional Analyses"] * native_section_page_count(
            getattr(data, "native_sections", None) or [])
        return base
```

And at the peptide branch's tail, after the variance append:

```python
    # Native sections append LAST (after analyte/addon/variance pages).
    templates += ["Additional Analyses"] * native_section_page_count(
        getattr(data, "native_sections", None) or [])

    return templates
```

- [ ] **Step 5: Convert the dynamic-background deny-list to an allow-list**

`generator.py` ~:246 currently:

```python
            if i == 1 and template_name != "Generic Page 2 - Variance List":
```

Replace with:

```python
            # Allow-list: dynamic page-2 backgrounds apply ONLY to the
            # templates that were designed for them. The old form was a
            # deny-list (name != variance page) that every new page landing at
            # index 1 had to remember to join — a programmatic-background page
            # (variance, native sections) is now excluded by default.
            # NOTE: "Generic Page 2 - Addons" IS in the allow-list — on master
            # it flows through this block (0-analyte background). Excluding it
            # would change BacWater certificates. (Plan correction to the spec,
            # which named only the two Blend templates.)
            _DYNAMIC_BG_TEMPLATES = (
                "Blend Page 2 - 4 Analyte_Addons",
                "Blend Page 2 - 4 Analyte_NoAddons",
                "Generic Page 2 - Addons",
            )
            if i == 1 and template_name in _DYNAMIC_BG_TEMPLATES:
```

(Hoist `_DYNAMIC_BG_TEMPLATES` to module level beside other constants if the file has a constants area.)

- [ ] **Step 6: Frame interception + `_draw_native_sections`**

In the frame loop (~:293), beside the `VarianceList` branch:

```python
                if frame_name == "NativeSections":
                    _ordinal = templates[:i].count(template_name)
                    self._draw_native_sections(c, frame_cfg, data, height, _ordinal)
                    continue
```

(`templates` must be in scope at the frame loop — it is the list `generate` iterates; confirm the loop variable names and reuse them. The ordinal is how many "Additional Analyses" pages precede this one.)

New method, modeled on `_draw_variance_table`'s palette and text helpers:

```python
    def _draw_native_sections(self, c, cfg, data, page_h, ordinal):
        """One page of native limit-table sections (spec 2). Pure ReportLab on
        the blank background; geometry constants MUST match the pagination
        helpers in native_sections.py (SECTION_HEAD_H/SUBHEAD_H/ROW_H)."""
        from .native_sections import (
            ROW_H, SECTION_GAP, SECTION_HEAD_H, SUBHEAD_H,
            native_section_page_slice,
        )
        sections = getattr(data, "native_sections", None) or []
        if not sections:
            return
        items = native_section_page_slice(sections, ordinal)

        BRAND_BLUE = HexColor("#1D3D8F")
        BRAND_BLUE_LT = HexColor("#2A4DA0")
        CORAL = HexColor("#FF6B5B")
        INK = HexColor(cfg.get("color", "#0e1534"))
        WHITE = HexColor("#FFFFFF")
        ROW_ALT = HexColor("#F4F6FB")
        SEP = HexColor("#E2E7F1")

        x0 = float(cfg["x"])
        top = page_h - float(cfg["y"])
        total_w = float(cfg["width"])
        font = cfg.get("font", "Helvetica")
        size = float(cfg.get("size", 8.0))

        # Test | Result | Unit | Specification | Verdict
        col_fracs = ((0.00, 0.34, "left"), (0.34, 0.14, "center"),
                     (0.48, 0.10, "center"), (0.58, 0.24, "center"),
                     (0.82, 0.18, "center"))
        headers = ("Test", "Result", "Unit", "Specification", "Verdict")

        def text(s, cx, cy, w, color=INK, bold=False, align="center", fsize=None):
            c.setFillColor(color)
            c.setFont("Helvetica-Bold" if bold else font, fsize if fsize is not None else size)
            s = "" if s is None else str(s)
            if align == "center":
                c.drawCentredString(cx + w / 2.0, cy, s)
            elif align == "right":
                c.drawRightString(cx + w - 3, cy, s)
            else:
                c.drawString(cx + 3, cy, s)

        y = top
        for sec, start, end in items:
            # Section heading band
            c.setFillColor(BRAND_BLUE)
            c.rect(x0, y - SECTION_HEAD_H, total_w, SECTION_HEAD_H, stroke=0, fill=1)
            text(sec["title"], x0, y - SECTION_HEAD_H / 2.0 - 3.2, total_w,
                 color=WHITE, bold=True, fsize=9.0, align="left")
            y -= SECTION_HEAD_H
            # Column sub-header band
            c.setFillColor(BRAND_BLUE_LT)
            c.rect(x0, y - SUBHEAD_H, total_w, SUBHEAD_H, stroke=0, fill=1)
            for hi, h in enumerate(headers):
                off, frac, al = col_fracs[hi]
                text(h, x0 + off * total_w, y - SUBHEAD_H / 2.0 - 2.6,
                     frac * total_w, color=WHITE, fsize=7.5, align=al)
            y -= SUBHEAD_H
            # Rows
            for ri, row in enumerate(sec["rows"][start:end]):
                c.setFillColor(WHITE if ri % 2 == 0 else ROW_ALT)
                c.rect(x0, y - ROW_H, total_w, ROW_H, stroke=0, fill=1)
                cy = y - ROW_H / 2.0 - size * 0.35
                verdict = row.get("status", "")
                v_color = INK if row.get("conforms") in (True, None) else CORAL
                cells = (row.get("name", ""), row.get("result", ""),
                         row.get("unit", ""), row.get("specification", ""), verdict)
                for ci, val in enumerate(cells):
                    off, frac, al = col_fracs[ci]
                    text(val, x0 + off * total_w, cy, frac * total_w,
                         color=v_color if ci == 4 else INK,
                         bold=(ci == 4), align=al)
                c.setStrokeColor(SEP)
                c.setLineWidth(0.5)
                c.line(x0, y - ROW_H, x0 + total_w, y - ROW_H)
                y -= ROW_H
            y -= SECTION_GAP
        c.setFillColor(INK)
```

(`HexColor` is already imported for `_draw_variance_table` — confirm.)

- [ ] **Step 7: Run tests, then a smoke render**

Run: `cd /c/tmp/coabuilder-coa-sections && python -m pytest tests/test_native_sections_render.py tests/test_native_sections_validation.py tests/test_native_sections_server.py -v` — all PASS.
Smoke render (add as a test if the suite has a synthetic-render precedent, else run as a script and attach the PDF path to the report): build a `CoAData` with 2 sections × 30 rows, `matrix_type="Peptide"`, call `resolve_templates` + `generator.generate`, assert the output PDF exists and has `1 + native_section_page_count(...)` pages (pypdf `len(reader.pages)`), and that page 1's background wasn't overridden (allow-list) — extract page-2+ text and assert a known row string is present.

- [ ] **Step 8: Commit**

```bash
git add "Templates/Additional Analyses/layout.json" src/coabuilder_core/logic.py src/coabuilder_core/generator.py src/coabuilder_core/native_sections.py tests/test_native_sections_render.py
git commit -m "feat(native-coa): Additional Analyses page — routing both branches, bg allow-list, paginated limit-table renderer"
```

---

### Task 8: Integration Service — fail-closed native-sections fetch on the additional-COA path

**Repo: integration-service** (worktree `C:\tmp\is-coa-sections`, branch from `origin/master`).

**Files:**
- Modify: `app/adapters/accumk1.py` (new method beside `get_variance_payload` ~:249)
- Modify: `app/api/webhook.py` (`_trigger_additional_coa_if_published`, the fetch block ~:683-748)
- Test: `tests/test_native_sections_fetch.py` (new; follow the repo's existing webhook/adapter test layout)

**Interfaces:**
- Consumes: Mk1 `GET /samples/{sample_id}/coa-sections` (Task 4: 200 document / 404 unknown sample / 502 fail-closed).
- Produces: `AccuMk1Adapter.get_native_sections(sample_id: str) -> dict | None` (None on 404 — legacy pre-Mk1 sample, proceed bare; raises on transport error or any non-404 failure); the webhook aborts the builder call entirely when the fetch raises.

- [ ] **Step 1: Write the failing tests**

Follow the repo's existing adapter-test pattern (httpx mocking — grep how `get_variance_payload` is tested). Required behaviors:

```python
"""Native-sections S2S fetch: fail-closed, unlike the variance fetch."""
import httpx
import pytest
import respx   # or the repo's established httpx-mock tool — match existing tests

from app.adapters.accumk1 import AccuMk1Adapter


DOC = {"sample_id": "P-1", "ordered_profiles": [], "sections": []}


@pytest.mark.anyio
async def test_get_native_sections_returns_document(respx_mock, settings_env):
    respx_mock.get("https://mk1.test/samples/P-1/coa-sections").mock(
        return_value=httpx.Response(200, json=DOC))
    out = await AccuMk1Adapter(base_url="https://mk1.test", service_token="t").get_native_sections("P-1")
    assert out == DOC


@pytest.mark.anyio
async def test_get_native_sections_none_on_404(respx_mock, settings_env):
    respx_mock.get("https://mk1.test/samples/P-1/coa-sections").mock(
        return_value=httpx.Response(404))
    out = await AccuMk1Adapter(base_url="https://mk1.test", service_token="t").get_native_sections("P-1")
    assert out is None


@pytest.mark.anyio
async def test_get_native_sections_raises_on_502(respx_mock, settings_env):
    respx_mock.get("https://mk1.test/samples/P-1/coa-sections").mock(
        return_value=httpx.Response(502, json={"detail": "order lookup failed"}))
    with pytest.raises(httpx.HTTPStatusError):
        await AccuMk1Adapter(base_url="https://mk1.test", service_token="t").get_native_sections("P-1")
```

Plus one webhook-level test asserting the abort: with `get_native_sections` raising, `_trigger_additional_coa_if_published` returns WITHOUT posting to COABuilder (mock the builder POST and assert not called; mirror how the function's variance behavior is tested today — if it has no test, build the minimal harness the same way the module's other background functions are tested).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/tmp/is-coa-sections && python -m pytest tests/test_native_sections_fetch.py -v`
Expected: FAIL — `AttributeError: get_native_sections`.

- [ ] **Step 3: Implement the adapter method**

In `app/adapters/accumk1.py`, directly below `get_variance_payload`, same shape and typing discipline (mypy strict):

```python
    async def get_native_sections(self, sample_id: str) -> dict | None:
        """Native COA sections wire document for a sample (spec 2).

        Calls GET /samples/{sample_id}/coa-sections. FAIL-CLOSED by contract:
        the caller must NOT generate a certificate when this raises — unlike
        the variance payload, native sections are paid reportable results.

        Returns None ONLY on 404 (sample unknown to Mk1 — a pre-Mk1 legacy
        sample cannot have native results; proceeding bare is correct).
        Raises httpx.HTTPStatusError / RequestError / TimeoutException on any
        other failure, including Mk1's own fail-closed 502.
        """
        url = f"{self.base_url}/samples/{sample_id}/coa-sections"
        logger.info("accumk1_native_sections_get_start", url=url, sample_id=sample_id)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(url, headers=self._headers())
        except httpx.TimeoutException:
            logger.error("accumk1_native_sections_get_timeout", url=url, sample_id=sample_id)
            raise
        except httpx.RequestError as e:
            logger.error(
                "accumk1_native_sections_get_connection_error",
                url=url, sample_id=sample_id, error=str(e),
            )
            raise
        logger.info(
            "accumk1_native_sections_get_response",
            http_status=response.status_code, sample_id=sample_id,
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        result: dict = response.json()
        return result
```

- [ ] **Step 4: Wire the webhook — fail-closed, distinct from the fail-soft variance block**

In `_trigger_additional_coa_if_published`, AFTER the existing variance try/except and BEFORE the `_body = {...}` construction:

```python
    # Native COA sections (spec 2) — FAIL-CLOSED, deliberately unlike the
    # variance fetch above. Variance is an enhancement (degrade + log);
    # native sections are paid reportable results: if we cannot learn whether
    # any were ordered, we must NOT generate a certificate that might silently
    # omit one. 404 => sample unknown to Mk1 (legacy) => nothing native can
    # exist => proceed bare.
    native_sections: dict | None = None
    try:
        native_sections = await AccuMk1Adapter().get_native_sections(senaite_id)
    except Exception as e:  # noqa: BLE001 — abort path, never proceed bare
        logger.error(
            "additional_coa_native_sections_fetch_failed_ABORTING",
            senaite_id=senaite_id,
            config_id=config_id,
            error=str(e),
        )
        return
```

And add to the body construction:

```python
    if native_sections is not None:
        _body["native_sections"] = native_sections
```

(`AccuMk1Adapter` is already imported inside the variance try-block — hoist the import above both blocks. `native_sections` with empty `ordered_profiles` is still sent: it is the "nothing ordered" cross-check.)

- [ ] **Step 5: Run gates**

Run: `cd /c/tmp/is-coa-sections && python -m pytest tests/test_native_sections_fetch.py -v` — PASS.
Run: `cd /c/tmp/is-coa-sections && ruff check . && mypy app` — clean (mypy is strict; the new method and locals are fully typed).
Full suite: `python -m pytest` — no new failures vs branch point.

- [ ] **Step 6: Commit**

```bash
git add app/adapters/accumk1.py app/api/webhook.py tests/test_native_sections_fetch.py
git commit -m "feat(native-coa): fail-closed native-sections fetch on the additional-COA path"
```

---

### Task 9: Cross-repo E2E on an isolated stack — golden render + regression proof

**Repos: all three** (read-mostly; this task produces evidence and small fixes only). Runs on a fresh devbox stack via the `accumark-stack-platform` skill — NEVER the live host or the user's `catui` stack. Mount all three worktrees (`--mk1 --is --coabuilder`); remember coabuilder has no hot reload (`docker compose -p accumark-<name> restart coabuilder` after each save) and the wave-1 topology trap (the baked image serves :5000 — verify the mounted checkout is what's actually serving before trusting any result).

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: evidence artifacts in the SDD workspace: the golden heavy-metals PDF + its extracted text, the `coa_data` JSON, and the regression comparison. Plus any integration fixes (each fix follows the loop: fix in the owning worktree, focused test, commit there).

- [ ] **Step 1: Provision**

Create the stack, validate 21/21 (the `create` minio-init false-failure workaround is in memory `project_stack_create_aborts_prerestore`: manual `restore.sh` + state fix). Mount the three worktrees. Restart backend after mount; verify `GET /samples/{any}/coa-sections` 401s without a token (route exists, auth on).

- [ ] **Step 2: Seed the heavy-metals catalog THROUGH THE API** (proves the spec-1 admin surface carries spec 2)

Via the Mk1 API (service create → department assign → profile create → members → PATCH archetype): 4 services `HM-PB`/`HM-AS`/`HM-CD`/`HM-HG` (origin auto-`mk1`, unit `ppm`, department Analytical), profile `heavy_metals` (addon, 1 vial), members in order, `coa_archetype='limit_table'`, `coa_section_title='Heavy Metals'`, `coa_sort_order=10`.

- [ ] **Step 3: Manual bench path end to end** (the spec's "verify the manual path before automating")

Pick a golden peptide sample with a published order; add HM analyses to a vial (through the existing add/assign flow), enter results (`0.12`/`0.8`/`0.05`/`0.3`), submit → to_be_verified → promote each through `POST /api/lims-analyses/promote`. Assert: 201s, parent rows `verified`, and SENAITE was never called (tail the backend log for `native_promote_writeback_skipped`, one per service). The order's `services` dict must include `heavy_metals: true` — inject it via the IS `order_submissions.payload` edit mechanism (memory `reference_remove_variance_from_sample` documents the pattern) since spec-3 routing doesn't exist yet.

- [ ] **Step 4: Golden render — primary path**

Generate the COA from the sample page (or `generate_sample_coa` equivalent API). Assert: PDF produced; extracted text (pypdf) contains "Heavy Metals", all four row names, "≤ 0.5 ppm", and "Conforms"; `coa_generations.coa_data` JSON contains the identical `native_sections`; `overall_status` unchanged (all conforming). Save the PDF + text as artifacts. Then flip one result to non-conforming (re-enter + re-promote via retest or direct row edit), regenerate, assert the badge reads FAILED on both PDF and JSON; restore.

- [ ] **Step 5: Fail-closed proof — primary path**

Retract one HM parent row (leave the profile ordered). Regenerate → the API must return the abort message (`no eligible result`), and NO new `coa_generations` row may appear. Restore the row.

- [ ] **Step 6: Additional-COA path**

Trigger an additional COA for the same sample (the `/additional-coa-ordered` webhook or its test harness). Assert the additional PDF carries the same Heavy Metals section. Then stop the Mk1 backend container and re-trigger: IS must log `additional_coa_native_sections_fetch_failed_ABORTING` and produce NO certificate. Restart Mk1.

- [ ] **Step 7: Regression — a no-native peptide COA is content-identical**

Generate a COA for a golden peptide sample with NO native profiles, on the stack (branch code), and compare against the same sample's COA generated from the baked master images (the unmounted stack state, or a second unmounted stack): extracted text identical page-for-page, same page count (PDF bytes differ by timestamps — text comparison is the gate). Also assert its `coa_data` has no `native_sections` key and the `resolve_templates` output (from logs or a debug call) is unchanged.

- [ ] **Step 8: Record + commit evidence**

Write the artifact paths + every assertion result into the task report. Any code fix made along the way is committed in its owning repo with its own focused test. Destroy the stack.

---

## Deploy-window runbook additions (NOT tasks — carried to the combined all-specs deploy)

- Lab enters the correct ENDO-LAL unit (`EU/mL`) on the Endotoxin service via the admin UI BEFORE any profile containing it becomes reportable; rehearsal asserts catalog unit == `EU/mL`.
- G-A: lab confirms/replaces the baked heavy-metals limits (Task 5 values are USP <232>-shaped placeholders pending sign-off).
- G-B: lab decides whether native non-conformance trips the remarks gate (not implemented in this plan — current behavior: it does not; the badge downgrade is implemented).
- G-C: lab signs off the first rendered Heavy Metals certificate (no prior render exists to diff).
- G-D: lab confirms `verified`/`published` as the release point for tests with no SENAITE verify step.
- Confirm section placement (append-last) reads correctly on a real certificate (open question 2).

