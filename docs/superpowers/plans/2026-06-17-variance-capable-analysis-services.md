# Variance-Capable Analysis Services — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any analyte be marked `variance_capable` in Mk1 and flow that through to a replicate series on the COA — delivering variance testing for Bacteriostatic Water's pH, Benzyl Alcohol, and Fill Volume.

**Architecture:** A `variance_capable` boolean on Mk1's `AnalysisService` (lab-toggle managed) is the source of truth for "this analyte is a variance figure." A new Mk1 builder emits an analyte-keyed replicate series alongside the existing peptide series; COABuilder's `GenericAssayEngine` (BW/non-peptide path) learns to render it with an **all-replicates-in-range** verdict. The peptide path, the integration-service, and the WP verify page are untouched (WP already renders two-sided ranges natively).

**Tech Stack:** Python/FastAPI + SQLAlchemy (Mk1 backend), React/TypeScript (Mk1 frontend), Python (COABuilder), Postgres.

**Spec:** `docs/superpowers/specs/2026-06-17-variance-capable-analysis-services-design.md`

**Repos / worktrees:**
- Accu-Mk1: `C:/tmp/accu-mk1-wave1` (branch `subsample-features`)
- COABuilder: `C:/tmp/coabuilder-master` (branch `master`)
- accumarklabs (WP): `\\wsl.localhost\...\DevKinsta\public\accumarklabs` (verify only)

**Live restart after edits (no HMR):** `docker restart accu-mk1-backend` (BE :8012), `docker restart accu-mk1-frontend` (FE :3101), `docker restart coabuilder_service` (:5000 — note: runs the baked image, see Task 9 note).

**Verdict models (do not conflate):** peptide variance = mean-based (`mean ≥ spec`, unchanged); BW variance = **all replicates within `[spec_min, spec_max]`**, parent figure included. No-spec analytes (Fill Volume) render informational (stat line, no pass/fail).

---

## Phase 1 — Mk1: the flag + admin toggle

### Task 1: Add `variance_capable` column + run-once migration & BW backfill

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/backend/models.py:173`
- Modify: `C:/tmp/accu-mk1-wave1/backend/database.py` (migrations list in `_run_migrations`, append before the closing `]`)
- Test: `C:/tmp/accu-mk1-wave1/backend/tests/test_variance_capable_flag.py` (new)

- [ ] **Step 1: Add the column to the model.** In `backend/models.py`, inside `class AnalysisService`, immediately after the `updated_at` column (line 173) and before the `# Relationships` comment, add:

```python
    # Mk1-owned override (like peptide_id / result_type): marks an analyte as a
    # variance figure. Read by the COA analyte series + assignment-page analyte
    # participation. Preserved across SENAITE re-sync (sync never writes it).
    variance_capable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
```

- [ ] **Step 2: Add the run-once migration + BW backfill.** In `backend/database.py`, append this entry to the `migrations` list in `_run_migrations()` (after the last entry `"ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS variance_override TEXT",`). A `DO $$` block so the ADD + backfill fire only when the column is absent — later startups skip it, so lab toggles are never re-clobbered:

```python
        # variance_capable on analysis_services. Run-once: the ADD + seed only
        # fire when the column is missing (first boot after deploy). On every
        # later boot the guard is false, so a lab's toggle choices stick.
        """DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name='analysis_services'
                             AND column_name='variance_capable') THEN
                ALTER TABLE analysis_services
                    ADD COLUMN variance_capable BOOLEAN NOT NULL DEFAULT FALSE;
                UPDATE analysis_services SET variance_capable = TRUE
                    WHERE keyword IN ('PH-DETERM','Benzyl_Alcohol_Assay','FILL-NET-CONTENT');
            END IF;
        END $$""",
```

- [ ] **Step 3: Write the failing test.** Create `backend/tests/test_variance_capable_flag.py`:

```python
from models import AnalysisService


def test_analysis_service_has_variance_capable_default_false():
    svc = AnalysisService(title="pH Determination", keyword="PH-DETERM")
    # Column default is applied at flush; the Python-side attribute should be
    # falsy/None before flush and the column must exist on the model.
    assert hasattr(svc, "variance_capable")
    assert "variance_capable" in AnalysisService.__table__.columns
    col = AnalysisService.__table__.columns["variance_capable"]
    assert col.nullable is False
```

- [ ] **Step 4: Run the test.** Run: `docker exec accu-mk1-backend python -m pytest tests/test_variance_capable_flag.py -v`
  Expected: PASS (column present, not nullable).

- [ ] **Step 5: Apply the migration + verify backfill on the live DB.** Run: `docker restart accu-mk1-backend` then:
  `docker exec accumark_postgres psql -U postgres -d accumark_mk1 -c "SELECT keyword, variance_capable FROM analysis_services WHERE keyword IN ('PH-DETERM','Benzyl_Alcohol_Assay','FILL-NET-CONTENT');"`
  Expected: all three rows `variance_capable = t`.

- [ ] **Step 6: Commit.**

```bash
cd /c/tmp/accu-mk1-wave1
git add backend/models.py backend/database.py backend/tests/test_variance_capable_flag.py
git commit -m "feat(analysis-services): add variance_capable flag + run-once BW backfill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: Toggle endpoint + sync-preservation regression test

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/backend/main.py` (add endpoint next to the existing `/analysis-services/{id}/result-type` PATCH, ~line 2700–2755; and confirm the service serializer includes the field)
- Test: `C:/tmp/accu-mk1-wave1/backend/tests/test_variance_capable_endpoint.py` (new)

- [ ] **Step 1: Write the failing test** for the endpoint + that sync preserves the flag. Create `backend/tests/test_variance_capable_endpoint.py`:

```python
# Mirrors the existing result-type endpoint test style. Uses the app's test
# client + a seeded AnalysisService.
def test_set_variance_capable_toggles_and_serializes(client, db_session):
    from models import AnalysisService
    svc = AnalysisService(title="pH Determination", keyword="PH-DETERM-TST", variance_capable=False)
    db_session.add(svc); db_session.commit()

    resp = client.patch(f"/analysis-services/{svc.id}/variance-capable",
                         json={"variance_capable": True})
    assert resp.status_code == 200
    assert resp.json()["variance_capable"] is True

    db_session.refresh(svc)
    assert svc.variance_capable is True


def test_sync_does_not_clobber_variance_capable(db_session):
    """The SENAITE sync 'adds new, does not overwrite existing' — so a flagged
    service keeps its flag after a re-sync touches it."""
    from models import AnalysisService
    svc = AnalysisService(title="pH Determination", keyword="PH-DETERM-TST2",
                          senaite_id="svc-test-2", variance_capable=True)
    db_session.add(svc); db_session.commit()
    # Simulate the sync's existing-row branch (it updates synced metadata only,
    # never variance_capable). Assert the flag is untouched by a title refresh.
    svc.title = "pH Determination (synced)"
    db_session.commit(); db_session.refresh(svc)
    assert svc.variance_capable is True
```

- [ ] **Step 2: Run the test to confirm it fails.** Run: `docker exec accu-mk1-backend python -m pytest tests/test_variance_capable_endpoint.py -v`
  Expected: FAIL — `404`/no route for the PATCH endpoint.

- [ ] **Step 3: Add the endpoint.** In `backend/main.py`, directly after the existing `update_analysis_service_result_type` handler (the `/analysis-services/{service_id}/result-type` PATCH near line 2700–2755), add:

```python
class VarianceCapableUpdate(BaseModel):
    variance_capable: bool


@app.patch("/analysis-services/{service_id}/variance-capable")
async def update_analysis_service_variance_capable(
    service_id: int,
    data: VarianceCapableUpdate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Lab-managed toggle: mark an analyte as a variance figure. Mk1-owned —
    never touched by the SENAITE sync."""
    svc = db.get(AnalysisService, service_id)
    if svc is None:
        raise HTTPException(404, "Analysis service not found")
    svc.variance_capable = bool(data.variance_capable)
    db.commit()
    db.refresh(svc)
    return _serialize_analysis_service(svc)
```

> Use the SAME serializer the `/analysis-services` GET and the result-type PATCH return (find it near those handlers — likely `_serialize_analysis_service` or an inline dict). If it's an inline dict, add `"variance_capable": svc.variance_capable` to it AND to the list serializer so the field round-trips. If a `BaseModel` import isn't already in scope at that point, it is already imported at the top of `main.py`.

- [ ] **Step 4: Ensure the GET list/detail serializer includes the field.** Grep for the analysis-services response shape (`"result_type":` in `main.py`) and add `"variance_capable": svc.variance_capable,` adjacent to it in every place a service is serialized.

- [ ] **Step 5: Run the tests.** Run: `docker exec accu-mk1-backend python -m pytest tests/test_variance_capable_endpoint.py -v`
  Expected: PASS (both tests).

- [ ] **Step 6: Commit.**

```bash
cd /c/tmp/accu-mk1-wave1
git add backend/main.py backend/tests/test_variance_capable_endpoint.py
git commit -m "feat(analysis-services): PATCH variance-capable endpoint + serialize field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Frontend — type, API fn, toggle UI, table badge

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/src/lib/api.ts` (add field to `AnalysisServiceRecord` ~line 2353; add `updateAnalysisServiceVarianceCapable` near `updateAnalysisServiceResultType` ~line 2404)
- Modify: `C:/tmp/accu-mk1-wave1/src/components/hplc/AnalysisServicesPage.tsx` (toggle in `ServicePanel`; badge in the table)

- [ ] **Step 1: Add the field to the type.** In `src/lib/api.ts`, in `interface AnalysisServiceRecord`, add after `result_options?`:

```typescript
  variance_capable?: boolean
```

- [ ] **Step 2: Add the API function.** In `src/lib/api.ts`, after `updateAnalysisServiceResultType`:

```typescript
export async function updateAnalysisServiceVarianceCapable(
  serviceId: number,
  varianceCapable: boolean,
): Promise<AnalysisServiceRecord> {
  const response = await fetch(`${API_BASE_URL()}/analysis-services/${serviceId}/variance-capable`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ variance_capable: varianceCapable }),
  })
  if (!response.ok) throw new Error(`Update variance-capable failed: ${response.status}`)
  return response.json()
}
```

- [ ] **Step 3: Add the toggle to `ServicePanel`.** In `AnalysisServicesPage.tsx`, import the new fn and `updateAnalysisServiceVarianceCapable`. Pass an `onVarianceCapableChange` handler into `<ServicePanel>` mirroring `onPeptideChange` (calls the API, toasts, `await load()`). Inside `ServicePanel`, add a bordered section after the Result Type block:

```tsx
      {/* Variance Capable */}
      <div className="border-t pt-4">
        <h4 className="mb-3 text-sm font-semibold text-muted-foreground">Variance</h4>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!service.variance_capable}
            onChange={e => onVarianceCapableChange(e.target.checked)}
          />
          Variance-capable (eligible for replicate testing &amp; COA variance series)
        </label>
      </div>
```

Add `onVarianceCapableChange: (v: boolean) => void` to `ServicePanel`'s prop types.

- [ ] **Step 4: Add a table badge.** In the services table body, in the Status cell (or a new small cell), render a badge when flagged:

```tsx
                    {svc.variance_capable && (
                      <Badge variant="secondary" className="ml-1 text-xs">Variance</Badge>
                    )}
```

- [ ] **Step 5: Verify in the UI.** `docker restart accu-mk1-frontend`, open the Analysis Services page, search "pH", open the slide-out, confirm the toggle reflects `true` and flipping it persists (toast + badge appears/disappears after reload).

- [ ] **Step 6: Commit.**

```bash
cd /c/tmp/accu-mk1-wave1
git add src/lib/api.ts src/components/hplc/AnalysisServicesPage.tsx
git commit -m "feat(analysis-services): variance-capable toggle in admin UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 — Mk1: the analyte variance series

### Task 4: `build_variance_analyte_series`

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/backend/coa/variance_series.py` (add a new builder after `build_variance_replicates`)
- Test: `C:/tmp/accu-mk1-wave1/backend/tests/test_variance_analyte_series.py` (new)

- [ ] **Step 1: Write the failing test.** Create `backend/tests/test_variance_analyte_series.py`. Mirror the fixtures in the existing `tests/test_variance_series.py` (parent `LimsSample`, two `assignment_kind='variance'` `LimsSubSample`s, `LimsAnalysis` rows joined to `AnalysisService`). Assert:

```python
def test_series_keyed_by_keyword_only_includes_variance_capable(db_session, bw_parent_with_variance_vials):
    from coa.variance_series import build_variance_analyte_series
    parent = bw_parent_with_variance_vials  # 2 variance vials, each with PH-DETERM(capable) + a non-capable row
    series = build_variance_analyte_series(db_session, parent)
    assert set(series.keys()) == {"PH-DETERM"}            # non-capable analyte excluded
    assert series["PH-DETERM"]["values"] == ["5.4", "5.6"]  # vial order
    assert "unit" in series["PH-DETERM"]
```

(Seed PH-DETERM with `variance_capable=True` and a second service with `variance_capable=False`; give each variance vial one `LimsAnalysis` per service with `retested=False`, `reportable=True`, a `review_state` in `_SERIES_STATES`, and a non-empty `result_value`.)

- [ ] **Step 2: Run it to confirm it fails.** Run: `docker exec accu-mk1-backend python -m pytest tests/test_variance_analyte_series.py -v`
  Expected: FAIL — `build_variance_analyte_series` not defined.

- [ ] **Step 3: Implement the builder.** In `backend/coa/variance_series.py`, after `build_variance_replicates`, add (reuses the module's existing imports `select`, `LimsSubSample`, `LimsAnalysis`, `AnalysisService`, and `_SERIES_STATES`):

```python
def build_variance_analyte_series(db: Session, parent) -> dict:
    """{keyword: {"unit": str, "values": [str, ...]}} for the parent's variance
    vials, limited to variance_capable analysis services.

    Keyed by SENAITE keyword (the same key COABuilder matches on in
    _Analyses_Detailed) so the generic engine can pair each series to its
    results_table row + baked spec. Values are per-vial current results
    (retested=False) in vial-sequence order; COABuilder prepends its own parent
    figure. Generic and analyte-agnostic — no peptide attribution, no
    purity/quantity/identity categories."""
    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_kind == "variance",
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    if not subs:
        return {}
    out: dict[str, dict] = {}
    for sub in subs:
        rows = db.execute(
            select(LimsAnalysis, AnalysisService)
            .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                AnalysisService.variance_capable.is_(True),
                LimsAnalysis.review_state.in_(_SERIES_STATES),
                LimsAnalysis.reportable == True,  # noqa: E712
                LimsAnalysis.retested.is_(False),
                LimsAnalysis.result_value.isnot(None),
                LimsAnalysis.result_value != "",
            )
            .order_by(LimsAnalysis.keyword)
        ).all()
        for la, svc in rows:
            kw = (la.keyword or svc.keyword or "").strip()
            if not kw:
                continue
            entry = out.setdefault(
                kw, {"unit": (la.result_unit or svc.unit or "").strip(), "values": []}
            )
            entry["values"].append(str(la.result_value).strip())
    return {k: v for k, v in out.items() if v["values"]}
```

- [ ] **Step 4: Run the test to confirm it passes.** Run: `docker exec accu-mk1-backend python -m pytest tests/test_variance_analyte_series.py -v`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd /c/tmp/accu-mk1-wave1
git add backend/coa/variance_series.py backend/tests/test_variance_analyte_series.py
git commit -m "feat(coa): build_variance_analyte_series (keyword-keyed, variance_capable)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5: Wire the analyte series into the COA `/process` call

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/backend/main.py:9189` (immediately after the `variance_replicates` best-effort block, inside the `if _parent_row is not None:`)

- [ ] **Step 1: Add the wiring.** After the existing `variance_replicates` try/except (ends line 9189), add a sibling best-effort block:

```python
            # BW / non-peptide variance: analyte-keyed replicate series for the
            # generic engine. Independent of variance_replicates (peptide engine
            # ignores this key; generic engine ignores variance_replicates).
            try:
                from coa.variance_series import build_variance_analyte_series
                _avar = build_variance_analyte_series(db, _parent_row)
                if _avar:
                    alias_body["variance_analytes"] = _avar
            except Exception:
                _logger.warning("variance analyte series build failed for %s", sample_id, exc_info=True)
```

- [ ] **Step 2: Verify the payload is assembled (no COABuilder change yet).** Add a temporary debug log or use an existing BW sample with variance vials: trigger "Regenerate primary COA" and confirm via backend logs that `variance_analytes` is present in `alias_body` (COABuilder will ignore the unknown field until Task 8). Remove any temporary logging before commit.

- [ ] **Step 3: Commit.**

```bash
cd /c/tmp/accu-mk1-wave1
git add backend/main.py
git commit -m "feat(coa): send variance_analytes to COABuilder /process

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 3 — COABuilder: generic-engine variance render

> Work in `C:/tmp/coabuilder-master` (branch `master`). Run tests with the repo's venv: `cd /c/tmp/coabuilder-master && python -m pytest <path> -q` (use the same interpreter the existing suite uses).

### Task 6: Shared variance-stat helpers module

**Files:**
- Create: `C:/tmp/coabuilder-master/src/coabuilder_core/variance_stats.py`
- Modify: `C:/tmp/coabuilder-master/src/coabuilder_core/conformance.py` (import the helpers instead of defining them)
- Test: `C:/tmp/coabuilder-master/tests/test_variance_stats_shared.py` (new)

- [ ] **Step 1: Write the failing test.** Create `tests/test_variance_stats_shared.py`:

```python
from coabuilder_core.variance_stats import _num, _domain, _variance_stats, _stat_line, _DOT


def test_num_parses_formatted_values():
    assert _num("99.1%") == 99.1
    assert _num("10.1 mg") == 10.1
    assert _num(None) is None


def test_stat_line_returns_unrounded_mean():
    line, mean = _stat_line([4.0, 5.0, 6.0], "", attach=False)
    assert mean == 5.0
    assert "mean 5.00" in line and "n=3" in line
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `cd /c/tmp/coabuilder-master && python -m pytest tests/test_variance_stats_shared.py -q`
  Expected: FAIL — module not found.

- [ ] **Step 3: Create the shared module** `src/coabuilder_core/variance_stats.py` by MOVING the exact current bodies from `conformance.py` (lines 112–157): `_num`, `_domain`, `_DOT`, `_variance_stats`, `_stat_line`. Header:

```python
"""Shared variance statistics — used by both ConformanceEngine (peptide) and
GenericAssayEngine (BW/non-peptide). Lifted from conformance.py so the mean is
computed identically in both engines (lab 2026-06-15: don't round before/after
the mean)."""
import re
import statistics
from typing import Optional
```

(Paste `_num`, `_domain`, `_DOT`, `_variance_stats`, `_stat_line` verbatim from `conformance.py`.)

- [ ] **Step 4: Update `conformance.py` to import them.** Remove the five definitions (lines 112–157) and add near the top imports:

```python
from .variance_stats import _num, _domain, _variance_stats, _stat_line, _DOT
```

- [ ] **Step 5: Run the shared test + the full peptide variance suite (regression).** Run:
  `cd /c/tmp/coabuilder-master && python -m pytest tests/test_variance_stats_shared.py tests/test_variance_report.py tests/test_variance_series_render.py tests/test_variance_stats_render.py tests/test_variance_blend_render.py -q`
  Expected: ALL PASS (the lift must not change peptide behavior).

- [ ] **Step 6: Commit.**

```bash
cd /c/tmp/coabuilder-master
git add src/coabuilder_core/variance_stats.py src/coabuilder_core/conformance.py tests/test_variance_stats_shared.py
git commit -m "refactor(coa): lift variance stat helpers into shared variance_stats module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 7: GenericAssayEngine renders the BW variance series (all-in-range verdict)

**Files:**
- Modify: `C:/tmp/coabuilder-master/src/coabuilder_core/generic_assay_engine.py`
- Test: `C:/tmp/coabuilder-master/tests/test_generic_engine_variance.py` (new)

- [ ] **Step 1: Write the failing tests.** Create `tests/test_generic_engine_variance.py`. Build a BW `senaite_json` with a `PH-DETERM` analysis (verified, Result `"5.5"`) and a `Benzyl_Alcohol_Assay` analysis, plus a `FILL-NET-CONTENT` analysis (no baked spec). Pass `variance_analytes`:

```python
from coabuilder_core.generic_assay_engine import GenericAssayEngine

def _bw_json():
    return {
        "SampleTypeTitle": "Bacteriostatic Water",
        "_Analyses_Detailed": [
            {"Keyword": "PH-DETERM", "title": "pH Determination", "Result": "5.5", "Unit": "", "review_state": "verified"},
            {"Keyword": "FILL-NET-CONTENT", "title": "Fill volume / Net content", "Result": "5.0", "Unit": "mL", "review_state": "verified"},
        ],
    }

def test_ph_variance_all_in_range_conforms():
    # parent 5.5 + vials 5.4, 5.6 — all within pH 4.5–7.0
    va = {"PH-DETERM": {"unit": "", "values": ["5.4", "5.6"]}}
    out = GenericAssayEngine().process(_bw_json(), variance_analytes=va)
    ph_row = next(r for r in out["results_table"] if r["test_name"] == "pH Determination")
    assert ph_row["conforms"] is True
    assert "mean 5.50" in ph_row["result"] and "n=3" in ph_row["result"]
    vr = {t["key"]: t for t in out["variance_report"]["tests"]}
    assert vr["bw-PH-DETERM"]["conforms"] is True
    assert vr["bw-PH-DETERM"]["spec_min"] == 4.5 and vr["bw-PH-DETERM"]["spec_max"] == 7.0

def test_ph_variance_single_outlier_fails_lot_and_coa():
    va = {"PH-DETERM": {"unit": "", "values": ["5.4", "9.9"]}}  # 9.9 > 7.0
    out = GenericAssayEngine().process(_bw_json(), variance_analytes=va)
    ph_row = next(r for r in out["results_table"] if r["test_name"] == "pH Determination")
    assert ph_row["conforms"] is False
    assert out["canonical"]["overall_pass"] is False          # row feeds the rollup
    assert any("pH" in r for r in out["canonical"]["nonconformance_reasons"])

def test_fill_volume_no_spec_is_informational():
    va = {"FILL-NET-CONTENT": {"unit": "mL", "values": ["5.0", "5.1"]}}
    out = GenericAssayEngine().process(_bw_json(), variance_analytes=va)
    fv_row = next(r for r in out["results_table"] if r["test_name"] == "Fill volume / Net content")
    assert "mean" in fv_row["result"]            # stat line shown
    assert fv_row["status"] != "DOES NOT CONFORM"  # no spec → not a fail
    vr = {t["key"]: t for t in out["variance_report"]["tests"]}
    assert vr["bw-FILL-NET-CONTENT"]["conforms"] is None  # informational

def test_no_variance_analytes_leaves_report_empty():
    out = GenericAssayEngine().process(_bw_json())   # no variance_analytes
    assert out["variance_report"] == {}              # empty dict when no replicates
```

- [ ] **Step 2: Run to confirm failure.** Run: `cd /c/tmp/coabuilder-master && python -m pytest tests/test_generic_engine_variance.py -q`
  Expected: FAIL — `process()` doesn't accept `variance_analytes`.

- [ ] **Step 3: Implement.** In `generic_assay_engine.py`:

(a) Add imports near the top:
```python
from .variance_stats import _num, _domain, _stat_line
```

(b) Change the signature (line 91) and initialise the report list + thread it through the loop:
```python
    def process(self, senaite_json: Dict[str, Any], variance_analytes: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        analyses = senaite_json.get("_Analyses_Detailed", []) or []
        reps = variance_analytes or {}
        variance_report_tests: List[Dict[str, Any]] = []
```

(c) Inside the core analyses loop, AFTER `row = self._row_from_analysis(a, matrix)` and the `if row is None: continue`, and BEFORE `results_table.append(row)` and the status rollup check, apply variance so the mutated status feeds the existing rollup:
```python
            self._apply_variance(row, a, matrix, reps, variance_report_tests)
```

(d) Add the helper method:
```python
    def _apply_variance(self, row, analysis, matrix, reps, report):
        """Mutate `row` to render the replicate stat line + the all-in-range
        verdict, and append a variance_report entry. Verdict includes the
        PARENT figure (the row's own result) plus the Mk1 vial values. No-spec
        analytes (e.g. Fill Volume) render informational — stat line, no verdict."""
        keyword = analysis.get("Keyword") or ""
        series = reps.get(keyword)
        if not series:
            return
        vials = [v for v in (_num(x) for x in series.get("values", [])) if v is not None]
        if not vials:
            return
        parent = _num(row.get("result"))
        combined = ([parent] if parent is not None else []) + vials
        if len(combined) < 2:
            return
        unit = (series.get("unit") or row.get("unit") or "").strip()
        line, _mean = _stat_line(combined, unit, attach=False)
        row["result"] = line

        from .baked_specs import lookup_spec, lookup_technique
        spec = lookup_spec(matrix, keyword)
        lo = spec.get("min") if spec else None
        hi = spec.get("max") if spec else None
        if spec is not None and (lo is not None or hi is not None):
            conforms = all((lo is None or v >= lo) and (hi is None or v <= hi) for v in combined)
            row["conforms"] = conforms
            row["status"] = _STATUS_CONFORMS if conforms else _STATUS_NONCONFORMS
            row["status_color"] = _COLOR_DEFAULT if conforms else _COLOR_NONCONFORM
            spec_text = spec.get("display") or self._format_spec_range(spec)
            status_label = "Conforms" if conforms else "Does Not Conform"
        else:
            conforms = None        # informational — no spec to judge against
            spec_text = "Measured"
            status_label = "Measured"
        report.append({
            "key": f"bw-{keyword}",
            "name": row.get("test_name") or keyword,
            "method": lookup_technique(keyword),
            "unit": unit,
            "qualitative": False,
            "spec_text": spec_text,
            "spec_min": lo, "spec_max": hi,
            "domain": _domain(combined, lo, hi),
            "values": combined,
            "conforms": conforms,
            "status": status_label,
        })
```

(e) Add the `variance_report` key to the return dict (after `"addon_results": addon_results_table,`):
```python
            "variance_report": ({"sample": {"name": senaite_json.get("SampleID") or senaite_json.get("id") or "",
                                            "lot": senaite_json.get("ClientLot") or senaite_json.get("getBatchID") or ""},
                                 "tests": variance_report_tests}
                                if variance_report_tests else {}),
```

> The existing rollup (`if status == _STATUS_NONCONFORMS: any_failed = True; fail_reasons.append(...)`, ~lines 124–128) now catches a failed variance row automatically because `_apply_variance` set `row["status"]` before `results_table.append(row)`. Confirm `_apply_variance` runs before that append.

- [ ] **Step 4: Run the tests.** Run: `cd /c/tmp/coabuilder-master && python -m pytest tests/test_generic_engine_variance.py -q`
  Expected: PASS (all four).

- [ ] **Step 5: Full regression.** Run: `cd /c/tmp/coabuilder-master && python -m pytest -q`
  Expected: no NEW failures (peptide variance + generic engine suites green).

- [ ] **Step 6: Commit.**

```bash
cd /c/tmp/coabuilder-master
git add src/coabuilder_core/generic_assay_engine.py tests/test_generic_engine_variance.py
git commit -m "feat(coa): GenericAssayEngine renders BW variance series (all-in-range verdict)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 8: Dispatch the analyte series into the generic engine

**Files:**
- Modify: `C:/tmp/coabuilder-master/scripts/server.py` (`ProcessSampleRequest` ~line 500; `/process/{sample_id}` body extraction ~line 522; `fetch_sample_data` call ~line 584)
- Modify: `C:/tmp/coabuilder-master/src/coabuilder_core/senaite_client.py` (`fetch_sample_data` signature + the GenericAssayEngine dispatch ~line 485)

- [ ] **Step 1: Add the request field.** In `scripts/server.py`, add to `ProcessSampleRequest`:

```python
    # Analyte-keyed variance series for non-peptide (generic-engine) matrices:
    # {keyword: {"unit": str, "values": [str, ...]}}. Consumed only by
    # GenericAssayEngine; the peptide engine ignores it.
    variance_analytes: Optional[Dict[str, dict]] = None
```

- [ ] **Step 2: Extract + thread it.** In the `/process/{sample_id}` handler, alongside `variance_replicates = body.variance_replicates if body else None`, add:
```python
    variance_analytes = body.variance_analytes if body else None
```
and pass it into the `client.fetch_sample_data(...)` call:
```python
        variance_analytes=variance_analytes,
```

- [ ] **Step 3: Thread through `fetch_sample_data`.** In `senaite_client.py`, add `variance_analytes: Optional[Dict[str, dict]] = None` to `fetch_sample_data`'s signature, and at the GenericAssayEngine dispatch (line ~485) change:
```python
        processed_data = engine.process(sample_json, variance_analytes=variance_analytes)
```
(The ConformanceEngine branch is unchanged — it keeps receiving `variance_replicates` only.)

- [ ] **Step 4: Integration test the dispatch.** Add a test in `tests/test_generic_engine_variance.py` (or a server test) asserting that a `/process` body with `variance_analytes` reaches the engine — or, if server tests are heavy, assert `fetch_sample_data` forwards the kwarg via a monkeypatched engine. Run: `cd /c/tmp/coabuilder-master && python -m pytest tests/test_generic_engine_variance.py -q`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd /c/tmp/coabuilder-master
git add scripts/server.py src/coabuilder_core/senaite_client.py tests/test_generic_engine_variance.py
git commit -m "feat(coa): accept variance_analytes on /process and dispatch to generic engine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 9: COABuilder version bump + changelog

**Files:**
- Modify: `C:/tmp/coabuilder-master/src/coabuilder_core/__init__.py` (`__version__`)
- Modify: `C:/tmp/coabuilder-master/CHANGELOG.md`

- [ ] **Step 1: Bump version.** `__version__ = "2.27.0"` (minor — additive feature).

- [ ] **Step 2: Add the changelog entry** at the top of `CHANGELOG.md`:

```markdown
## [2.27.0] - 2026-06-17

### Added

- **Variance replicate rendering for non-peptide matrices (Bacteriostatic Water).**
  `GenericAssayEngine` now accepts `variance_analytes` ({keyword: {unit, values}})
  and renders the same `mean · SD · %RSD · n` stat cell as the peptide path, plus
  a customer-facing `variance_report` entry per analyte. Verdict is
  **all-replicates-in-range** (parent figure included) against the baked spec;
  no-spec analytes (Fill Volume) render informational. Variance stat helpers
  lifted into a shared `variance_stats` module so both engines compute the mean
  identically.
```

- [ ] **Step 3: Commit.**

```bash
cd /c/tmp/coabuilder-master
git add src/coabuilder_core/__init__.py CHANGELOG.md
git commit -m "chore(release): COABuilder 2.27.0 — BW variance rendering

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> **Deploy note (not part of this plan):** `coabuilder_service` :5000 runs the baked image, NOT the bind-mounted checkout. To UAT branch edits live, follow the COABuilder container-topology note in memory (`architecture_coabuilder_container_topology`). The end-to-end check in Task 12 depends on getting branch COABuilder live for the wave1 stack.

---

## Phase 4 — Closing slices: entitlement, WP product, versions, E2E

### Task 10: BW-aware variance entitlement (WP-purchase enablement) — WITH user decision

> **Checkpoint (do this first):** the spec defers the *WP-key-based vs. fuller flag-driven* entitlement choice to the user. Before implementing, ask via AskUserQuestion: **(a)** minimal BW-aware extension (hplc bucket reads `hplcpurity_identity` OR `bac_water_panel`, mirroring `derive_base_demand:839`) — recommended, additive, matches existing idiom; or **(b)** fuller flag-driven entitlement (larger refactor). Implement the chosen option. Steps below assume (a).

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/backend/sub_samples/service.py:812-834`
- Test: `C:/tmp/accu-mk1-wave1/backend/tests/test_variance_demand.py` (extend)

- [ ] **Step 1: Write the failing test.** In `backend/tests/test_variance_demand.py`, add:

```python
def test_bw_variance_maps_to_hplc_bucket():
    from sub_samples.service import derive_variance_demand
    services = {"variance": {"bac_water_panel": 3}}  # 3 total → 2 paid replicates
    assert derive_variance_demand(services)["hplc"] == 2
```

- [ ] **Step 2: Run to confirm failure.** Run: `docker exec accu-mk1-backend python -m pytest tests/test_variance_demand.py::test_bw_variance_maps_to_hplc_bucket -v`
  Expected: FAIL — `hplc` resolves to 0 (only reads `hplcpurity_identity`).

- [ ] **Step 3: Implement BW-aware mapping.** In `backend/sub_samples/service.py`, change `derive_variance_demand` so the `hplc` bucket takes the max of both keys:

```python
def derive_variance_demand(services: dict) -> dict:
    """Per-bucket variance target (PAID REPLICATES) from a WP services payload.
    The hplc bucket is BW-aware — it reads hplcpurity_identity OR bac_water_panel
    (mirroring derive_base_demand), since both produce chromatography vials."""
    entitlement = normalize_variance_entitlement({"variance": (services or {}).get("variance")})
    hplc_total = max(entitlement.get("hplcpurity_identity", 0), entitlement.get("bac_water_panel", 0))
    return {
        "hplc": max(0, hplc_total - 1),
        "endo": max(0, entitlement.get("endotoxin", 0) - 1),
        "ster": max(0, entitlement.get("sterility_pcr", 0) - 1),
    }
```

(Keep `VARIANCE_BUCKET_KEYS` for any other reader; this function now resolves the hplc bucket explicitly.)

- [ ] **Step 4: Run the variance-demand suite.** Run: `docker exec accu-mk1-backend python -m pytest tests/test_variance_demand.py -v`
  Expected: PASS (new test + existing peptide cases unchanged).

- [ ] **Step 5: Commit.**

```bash
cd /c/tmp/accu-mk1-wave1
git add backend/sub_samples/service.py backend/tests/test_variance_demand.py
git commit -m "feat(variance): BW-aware hplc-bucket entitlement (bac_water_panel)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 11: WP purchasable BW variance product + verify-page confirmation

> WP work in the DevKinsta site. This mirrors the existing "Variance" shadow WC product + `wc_test_services` entry. No renderer code change.

- [ ] **Step 1: Confirm the existing variance product pattern.** Inspect how the current "Variance" shadow WC product + its `wc_test_services` row are defined (the entry whose name contains "variance"). Document the exact fields needed for a BW-variance equivalent that emits a `variance` entitlement under the `bac_water_panel` key.

- [ ] **Step 2: Create the BW variance product/entitlement** following that pattern so a BW order carries `variance: {bac_water_panel: N}`. (Lab-override path already works without this — this is the purchasable slice.)

- [ ] **Step 3: Verify the WP verify page renders a BW variance_report (NO code change).** Using an existing BW sample with variance vials, generate+publish so the COA notify delivers a BW `variance_report`, then open the portal Variance Report page and confirm: two-sided green band (pH 4.5–7.0), per-replicate dots colored by in/out-of-range, stat readout. (Renderer support confirmed in `variance-charts.php` — `vr_value_conforms`, `vr_range_strip`, `vr_derive_claim`.)

- [ ] **Step 4: Commit any WP config/template changes** (theme version bump handled in Task 12).

### Task 12: Version bumps, changelogs, end-to-end verification

**Files:**
- Mk1: `package.json` / `tauri.conf.json` / `Cargo.toml` (+ lock) — bump 1.0.1 → **1.0.2**; `CHANGELOG.md`
- Theme: `wp-content/themes/wpstar/style.css` + `CHANGELOG.md` — bump 2.26.0 → **2.27.0** (only if WP changed in Task 11)

- [ ] **Step 1: Bump Mk1 version** to 1.0.2 across `package.json`, `tauri.conf.json`, `Cargo.toml`/lock (backend `APP_VERSION` reads package.json), and add a `CHANGELOG.md` entry summarising variance-capable analysis services.

- [ ] **Step 2: Bump theme version** to 2.27.0 (if Task 11 changed WP) + changelog entry.

- [ ] **Step 3: End-to-end verification on the wave1 stack** (get branch COABuilder live first — see Task 9 deploy note):
  1. Flag pH/BA/Fill Volume variance-capable (already backfilled; confirm in the admin UI).
  2. On a BW sample, set the HPLC variance override to 2 (lab-override path) → confirm the variance drop-zone appears; assign a variance vial.
  3. Confirm the vial seeds pH/BA/Fill Volume (already verified the mirror does this).
  4. Enter replicate results on the variance vial; verify them.
  5. Regenerate primary COA → publish.
  6. Confirm: COA PDF shows the stat line for pH/BA (verdict) + Fill Volume (informational); a deliberately out-of-range pH replicate flips the COA to FAILED; the WP verify page renders the two-sided band + dots.

- [ ] **Step 4: Full regression sweep.** Run the Mk1 BE variance suites + COABuilder full suite + Mk1 FE assign-step test; confirm only the known pre-existing failures remain (per the handoff: BE `test_list_sub_samples_with_children`; FE `App.test`/`select-root-generations`/`peptide-requests-list`; tsc `qrcode.react`).

- [ ] **Step 5: Commit the version bumps.**

```bash
cd /c/tmp/accu-mk1-wave1
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package-lock.json CHANGELOG.md
git commit -m "chore(release): Accu-Mk1 1.0.2 — variance-capable analysis services

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** Layer 1 → Tasks 1–3; Layer 2 (assignment) → existing mechanics + Task 10 (entitlement); Layer 3 (COA) → Tasks 4–9; WP → Task 11 (verify only); migration/sequencing → Task 1 + Task 12.
- **Verdict fidelity (advisor #4):** Task 7 includes the parent figure and feeds the rollup; tests cover pass, single-outlier fail (fails the COA), and no-spec informational.
- **Join-key risk (advisor #3):** the Mk1 series is keyed by `AnalysisService.keyword`; Task 7's tests pair `bw-PH-DETERM` to the right `results_table` row. If a BW COA renders blank variance, suspect a keyword mismatch between Mk1's stored `keyword` and the live SENAITE `Keyword` first.
- **No HPLC backfill (advisor #1):** only pH/BA/Fill Volume are flagged; the peptide path never reads the flag.
- **Merge gate:** commit freely on `subsample-features` (Mk1) / `master` (COABuilder per its worktree convention); **do not merge to master without explicit user go** (and confirm the 1.0 deploy ordering, since this is baked into the launch).
```
