# COA Display Fields + Native-Section Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catalog-driven COA display data (per-spec LOQ, per-profile basis/method/prep/footnotes) crossing the native-sections wire, and the mockup restyle of coabuilder's native-section renderer.

**Architecture:** Two independently mergeable slices. Slice A (Mk1, tasks 1–7) adds nullable catalog columns and wire keys — absent fields render today's document. Slice B (coabuilder, tasks 8–11) validates the new wire keys, adds variable-height layout math for method/footnote bands, and restyles `_draw_native_sections` to the approved mockup. Spec: `docs/superpowers/specs/2026-08-16-coa-display-fields-design.md` (in this worktree).

**Tech Stack:** Mk1 backend FastAPI + SQLAlchemy (Postgres prod / SQLite tests), React+TS frontend (npm only); coabuilder ReportLab 4.x + pypdf.

## Global Constraints

- **Worktrees:** Slice A in `C:\tmp\Accu-Mk1-coa-display` (branch `feat/coa-display-fields`, base `27d04b47`). Slice B in `C:\tmp\coabuilder-coa-restyle` (branch `feat/native-coa-restyle`, base `04aceac`). Never touch other checkouts.
- **Test commands:** Mk1 backend: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe -m pytest <files> -q` with cwd `C:\tmp\Accu-Mk1-coa-display\backend`. Coabuilder: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\coabuilder\.venv\Scripts\python.exe -m pytest <files> -q` with cwd `C:\tmp\coabuilder-coa-restyle`.
- **Mk1 full-suite gate is a failure-SET diff** against the 68F/14E baseline (sorted failure sets in `C:\tmp\Accu-Mk1-s9-demand\.superpowers\sdd\2026-08-14-s9-demand-dehardcode-mk1\task-7-report.md`) — NEVER zero-failures, NEVER "count looks close".
- **Every `analysis_service_specs` write goes through `record_spec_change`** (no exceptions); rows are deactivated, never deleted; no DELETE routes.
- **All new columns nullable, no defaults, no backfill.** NULL/absent must render exactly today's certificate content.
- **Wire contract:** section keys `basis_note`/`method_text`/`prep_text` (str|None), `footnotes` (list, possibly empty); spec dict key `loq` (float|None); row key `result_display` (non-empty str|None). Keys ALWAYS present.
- **Censoring rule (only convention today):** `result_display = "< LOQ"` iff spec `rule_kind == 'range'` AND `loq` set AND result parses finite AND `float(result) < float(loq)`. `result == loq` NOT censored. Equals rows never censor.
- **Fail-closed doctrine (coabuilder):** malformed wire aborts; pagination never truncates — it aborts.
- **npm only** in the Mk1 frontend. Frontend gate: `npm run check:all`.
- Match surrounding comment density/idiom; commit after each task with the repo's conventional style (`feat(coa-display): ...` / `feat(native-coa): ...`).

---

## Slice A — Mk1 producer (`C:\tmp\Accu-Mk1-coa-display`)

### Task 1: Schema — `loq` + four profile columns

**Files:**
- Modify: `backend\models.py` (AnalysisServiceSpec ~line 268 after `display_override`; AnalysisProfile ~line 481 after `coa_sort_order`)
- Modify: `backend\database.py` (CREATE TABLE `analysis_service_specs` ~line 1569; append to `migrations` list before the closing `]` at ~line 1663)
- Test: `backend\tests\test_analysis_service_spec_model.py` (extend)

**Interfaces:**
- Produces: `AnalysisServiceSpec.loq: Optional[Decimal]`; `AnalysisProfile.coa_basis_note: Optional[str]`, `.coa_method_text: Optional[str]`, `.coa_prep_text: Optional[str]`, `.coa_footnotes: Optional[list]`.

- [ ] **Step 1: Write failing model tests** (extend `test_analysis_service_spec_model.py`, following its existing fixture idiom):

```python
def test_spec_loq_round_trip(db_session, hm_service):
    spec = AnalysisServiceSpec(analysis_service_id=hm_service.id,
                               rule_kind="range", max_value=Decimal("100"),
                               unit="µg/g", loq=Decimal("0.5"))
    db_session.add(spec); db_session.commit(); db_session.refresh(spec)
    assert spec.loq == Decimal("0.5")

def test_spec_loq_nullable(db_session, hm_service):
    spec = AnalysisServiceSpec(analysis_service_id=hm_service.id,
                               rule_kind="range", max_value=Decimal("100"))
    db_session.add(spec); db_session.commit()
    assert spec.loq is None

def test_profile_coa_display_columns_round_trip(db_session):
    prof = AnalysisProfile(key="hm_t1", name="HM", is_addon=True,
                           coa_basis_note="USP <232> Parenteral PDE | MDD 50 mg/day",
                           coa_method_text="MP-AES following hot block acid digestion",
                           coa_prep_text="100 mg / 10 mL digest",
                           coa_footnotes=[{"label": "Reporting.", "text": "µg/g = ppm."}])
    db_session.add(prof); db_session.commit(); db_session.refresh(prof)
    assert prof.coa_footnotes[0]["label"] == "Reporting."

def test_profile_coa_display_columns_default_null(db_session):
    prof = AnalysisProfile(key="hm_t2", name="HM2", is_addon=True)
    db_session.add(prof); db_session.commit()
    assert (prof.coa_basis_note, prof.coa_method_text,
            prof.coa_prep_text, prof.coa_footnotes) == (None, None, None, None)
```
(Adjust `AnalysisProfile` required kwargs to whatever the file's existing profile fixtures pass — `is_addon` is NOT NULL.)

- [ ] **Step 2: Run → verify FAIL** (`TypeError: 'loq' is an invalid keyword argument` etc.)

- [ ] **Step 3: Model columns.** In `AnalysisServiceSpec` after `display_override`:

```python
    # Limit of quantitation in the spec row's own unit (display + censoring
    # only — evaluate() never reads it; the verdict is always the raw number).
    loq: Mapped[Optional[Decimal]] = mapped_column(Numeric, nullable=True)
```

In `AnalysisProfile` after `coa_sort_order` (inside the COA-section-wiring block):

```python
    # COA display chrome (spec 2026-08-16): section-scoped, archetype-
    # independent, all inert until the renderer slice consumes them.
    coa_basis_note: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    coa_method_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    coa_prep_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Ordered [{"label": str, "text": str}] — list shape so families differ
    # in footnote count without schema change.
    coa_footnotes: Mapped[Optional[list]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )
```

- [ ] **Step 4: Migrations.** In `database.py`: add `loq NUMERIC,` to the `CREATE TABLE IF NOT EXISTS analysis_service_specs` column list (after `display_override TEXT,` — fresh installs), AND append to the `migrations` list before the closing `]`:

```python
        # --- COA display fields (spec 2026-08-16): all nullable, no backfill ---
        "ALTER TABLE analysis_service_specs ADD COLUMN IF NOT EXISTS loq NUMERIC",
        "ALTER TABLE analysis_profiles ADD COLUMN IF NOT EXISTS coa_basis_note VARCHAR(200)",
        "ALTER TABLE analysis_profiles ADD COLUMN IF NOT EXISTS coa_method_text TEXT",
        "ALTER TABLE analysis_profiles ADD COLUMN IF NOT EXISTS coa_prep_text TEXT",
        "ALTER TABLE analysis_profiles ADD COLUMN IF NOT EXISTS coa_footnotes JSONB",
```

- [ ] **Step 5: Run tests → PASS.** Also run the untouched spec-model file to prove no regression: `...python.exe -m pytest tests/test_analysis_service_spec_model.py -q`
- [ ] **Step 6: Commit** `feat(coa-display): loq on analysis_service_specs + profile COA display columns`

### Task 2: Spec routes + audit carry `loq`

**Files:**
- Modify: `backend\main.py` — `ServiceSpecResponse` (~3405), `ServiceSpecCreate` (~3422), `ServiceSpecPatch` (~3433), `_spec_response` (~3491), `create_service_spec` (~3527), `patch_service_spec` (~3558)
- Modify: `backend\catalog\service_spec_audit.py` — `snapshot_spec`
- Test: `backend\tests\test_service_spec_routes.py` (extend)

**Interfaces:**
- Consumes: Task 1's `AnalysisServiceSpec.loq`.
- Produces: `loq: Optional[str]` on all three Pydantic models (string-typed like min/max — `_dec_to_str` on the way out, `_parse_decimal` on the way in); `snapshot_spec()["loq"]`.

- [ ] **Step 1: Failing route tests** (follow the file's existing client/fixture idiom):

```python
def test_create_spec_with_loq(client, hm_service):
    r = client.post(f"/analysis-services/{hm_service.id}/specs",
                    json={"rule_kind": "range", "max_value": "100",
                          "unit": "µg/g", "loq": "0.5"})
    assert r.status_code == 201 and r.json()["loq"] == "0.5"

def test_patch_spec_loq_and_clear(client, spec_row):
    r = client.patch(f"/analysis-service-specs/{spec_row.id}", json={"loq": "0.25"})
    assert r.status_code == 200 and r.json()["loq"] == "0.25"
    r = client.patch(f"/analysis-service-specs/{spec_row.id}", json={"loq": None})
    assert r.status_code == 200 and r.json()["loq"] is None

def test_loq_rejects_negative_and_nonfinite(client, hm_service):
    for bad in ("-1", "nan", "abc"):
        r = client.post(f"/analysis-services/{hm_service.id}/specs",
                        json={"rule_kind": "range", "max_value": "100", "loq": bad})
        assert r.status_code == 422, bad

def test_loq_in_audit_snapshot(client, db_session, hm_service):
    client.post(f"/analysis-services/{hm_service.id}/specs",
                json={"rule_kind": "range", "max_value": "100", "loq": "0.5"})
    log = db_session.execute(select(AuditLog).where(
        AuditLog.operation == "analysis_service_spec_changed")).scalars().all()[-1]
    assert log.details["after"]["loq"] == "0.5"
```

- [ ] **Step 2: Run → FAIL** (422 unknown field / KeyError loq)
- [ ] **Step 3: Implement.** Add `loq: Optional[str] = None` to `ServiceSpecCreate`, `ServiceSpecPatch`, and `ServiceSpecResponse`. In `create_service_spec` pass `loq=_parse_loq(req.loq)`; in `patch_service_spec` add `"loq"` to the `_parse_decimal`-converting comprehension key set (`k in ("min_value", "max_value", "loq")` → but via `_parse_loq` for the negative check). Add next to `_parse_decimal`:

```python
def _parse_loq(value: Optional[str]) -> Optional[Decimal]:
    """LOQ shares _parse_decimal's finite gate and additionally must be
    non-negative — a negative floor would censor every result."""
    parsed = _parse_decimal(value, "loq")
    if parsed is not None and parsed < 0:
        raise HTTPException(422, "loq must be non-negative")
    return parsed
```

In `patch_service_spec`, change the `converted` comprehension to:

```python
    converted = {
        k: (_parse_decimal(v, k) if k in ("min_value", "max_value") and v is not None
            else _parse_loq(v) if k == "loq" and v is not None
            else v)
        for k, v in fields.items()
    }
```

In `_spec_response` add `loq=_dec_to_str(spec.loq)`. In `snapshot_spec` add `"loq": str(spec.loq) if spec.loq is not None else None` (after `unit`). A stray loq on an `equals` row is deliberately tolerated in storage (spec: censoring never fires there) — do NOT extend `_validate_spec_shape`.
- [ ] **Step 4: Run task tests + full `tests/test_service_spec_routes.py` → PASS**
- [ ] **Step 5: Commit** `feat(coa-display): loq through spec routes + audit snapshot`

### Task 3: Profile routes carry the COA display fields

**Files:**
- Modify: `backend\main.py` — `AnalysisProfileCreate` (~2492), `AnalysisProfileUpdate` (~2525), `AnalysisProfileResponse` (~2545), `create_analysis_profile` (~16112), `update_analysis_profile` (~16197)
- Test: `backend\tests\test_native_sections.py` sibling route tests live where the existing profile-route tests are — find with `grep -rl "coa_section_title" backend\tests` and extend THAT file.

**Interfaces:**
- Consumes: Task 1's profile columns.
- Produces: `coa_basis_note`/`coa_method_text`/`coa_prep_text` (`Optional[str]`) and `coa_footnotes` (`Optional[list[dict]]`) on Create/Update/Response; `_validate_coa_footnotes(value)` helper (raises HTTPException 400).

- [ ] **Step 1: Failing tests** (in the discovered profile-route test file, its idiom):

```python
def test_profile_patch_coa_display_fields(client, profile_row):
    r = client.patch(f"/analysis-profiles/{profile_row.id}", json={
        "coa_basis_note": "USP <232> Parenteral PDE | MDD 50 mg/day",
        "coa_method_text": "MP-AES", "coa_prep_text": "100 mg / 10 mL digest",
        "coa_footnotes": [{"label": "Reporting.", "text": "µg/g = ppm."}]})
    assert r.status_code == 200
    body = r.json()
    assert body["coa_basis_note"].startswith("USP") and body["coa_footnotes"][0]["label"] == "Reporting."

def test_profile_footnotes_shape_rejected(client, profile_row):
    for bad in ("notalist", [{"label": "x"}], [{"label": "", "text": "y"}],
                [{"label": "a", "text": "b", "extra": 1}], [42]):
        r = client.patch(f"/analysis-profiles/{profile_row.id}",
                         json={"coa_footnotes": bad})
        assert r.status_code == 400, bad

def test_profile_coa_fields_clear_to_null(client, profile_row):
    client.patch(f"/analysis-profiles/{profile_row.id}", json={"coa_method_text": "MP-AES"})
    r = client.patch(f"/analysis-profiles/{profile_row.id}", json={"coa_method_text": None})
    assert r.status_code == 200 and r.json()["coa_method_text"] is None
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement.** Add the four fields (`Optional[str] = None` ×3, `coa_footnotes: Optional[list] = None`) to `AnalysisProfileCreate`, `AnalysisProfileUpdate`, `AnalysisProfileResponse`. Add near the profile routes:

```python
def _validate_coa_footnotes(value) -> None:
    """[{label, text}] and nothing else — the renderer trusts this shape."""
    if value is None:
        return
    if not isinstance(value, list):
        raise HTTPException(400, "coa_footnotes must be a list of {label, text} objects")
    for i, note in enumerate(value):
        if (not isinstance(note, dict) or set(note.keys()) != {"label", "text"}
                or not isinstance(note.get("label"), str)
                or not isinstance(note.get("text"), str)
                or not note["label"].strip() or not note["text"].strip()):
            raise HTTPException(
                400, f"coa_footnotes[{i}] must be {{label, text}} with non-empty strings")
```

Call it in `create_analysis_profile` (`_validate_coa_footnotes(data.coa_footnotes)`) and in `update_analysis_profile` (`if "coa_footnotes" in fields: _validate_coa_footnotes(fields["coa_footnotes"])`). The fields then flow through the routes' existing `model_dump(exclude_unset=True)` → constructor/setattr paths with no further wiring.
- [ ] **Step 4: Run task tests + the whole discovered test file → PASS**
- [ ] **Step 5: Commit** `feat(coa-display): profile COA display fields through routes`

### Task 4: Wire — censoring + new section/spec keys

**Files:**
- Modify: `backend\coa\native_sections.py` — `_spec_wire_dict` (~126), row assembly (~218), section assembly (~233); new `_result_display` helper
- Test: `backend\tests\test_native_sections.py` (extend)

**Interfaces:**
- Consumes: Tasks 1–3 columns; existing `evaluate`, `resolve_spec`.
- Produces: wire keys per Global Constraints; `_result_display(spec, result) -> Optional[str]`.

- [ ] **Step 1: Failing wire tests** (extend `test_native_sections.py`, reusing its profile/spec/analysis fixtures):

```python
def test_wire_carries_loq_and_display_fields(...):
    # spec row with loq=0.5, max=100; profile with all four display fields;
    # verified parent row result "0.2"
    doc = build_native_sections(db, parent)
    sec = doc["sections"][0]
    assert sec["basis_note"] and sec["method_text"] and sec["prep_text"]
    assert sec["footnotes"][0]["label"]
    row = sec["rows"][0]
    assert row["specification"]["loq"] == 0.5
    assert row["result_display"] == "< LOQ"
    assert row["conforms"] is True          # verdict on the RAW number

def test_censoring_boundary(...):
    # result "0.5" with loq 0.5 -> result_display None (== not censored)
    # result "0.51" -> None; result "0.49" -> "< LOQ"

def test_equals_rows_never_censor(...):
    # equals spec with stray loq; result "Not Detected" -> result_display None

def test_unset_fields_wire_shape(...):
    # profile with no display fields, spec with no loq:
    sec = doc["sections"][0]
    assert (sec["basis_note"], sec["method_text"], sec["prep_text"]) == (None, None, None)
    assert sec["footnotes"] == []
    assert sec["rows"][0]["specification"]["loq"] is None
    assert sec["rows"][0]["result_display"] is None
```

- [ ] **Step 2: Run → FAIL** (KeyError)
- [ ] **Step 3: Implement.** In `_spec_wire_dict` add `"loq": float(spec.loq) if spec.loq is not None else None,` after `"unit"`. Add after `_spec_wire_dict`:

```python
def _result_display(spec, result) -> Optional[str]:
    """Mk1's applied lab-reporting convention for the PRINTED result — the
    verdict never reads it. Only convention today: LOQ censoring on range
    rows. Runs after evaluate(), which guarantees a finite numeric for
    range rows; the guards here are belt-and-braces, not policy."""
    if spec.rule_kind != "range" or spec.loq is None:
        return None
    try:
        value = float(str(result or "").strip())
    except ValueError:
        return None
    if not math.isfinite(value):
        return None
    return "< LOQ" if value < float(spec.loq) else None
```

(`import math` at top.) In the row dict add `"result_display": _result_display(spec, row.result_value),` after `"conforms"`. In the section dict add after `"sort_order"`:

```python
            "basis_note": prof.coa_basis_note,
            "method_text": prof.coa_method_text,
            "prep_text": prof.coa_prep_text,
            "footnotes": list(prof.coa_footnotes or []),
```

- [ ] **Step 4: Run task tests + full `tests/test_native_sections.py` → PASS**
- [ ] **Step 5: Commit** `feat(coa-display): loq + display fields + result_display on the native-sections wire`

### Task 5: Frontend — LOQ in the specs editor

**Files:**
- Modify: `src\components\hplc\ServiceSpecsSection.tsx`
- Test: extend the component's existing test file (find with `grep -rl "ServiceSpecsSection\|analysis-service-specs" src\test`)

**Interfaces:** Consumes Task 2's `loq` (string|null) on GET/POST/PATCH payloads.

- [ ] **Step 1: Failing test** (existing test idiom — render, fill, assert payload): create/edit a range spec with LOQ "0.5" → POST/PATCH body contains `loq: "0.5"`; blank → `loq: null`; an `equals` spec form does not send loq (mirror the `min_value` gating at line ~104).
- [ ] **Step 2: Run (`npm run test -- <file>`) → FAIL.** (First run: `npm install` in the worktree — npm ONLY.)
- [ ] **Step 3: Implement.** Follow the exact `unit` field idiom: add `loq: string` to the form state type (init `''`, hydrate from `spec.loq ?? ''` on edit), an input beside min/max visible only when `ruleKind === 'range'` (label "LOQ", placeholder "e.g. 0.5"), payload `loq: f.ruleKind === 'range' ? f.loq.trim() || null : null`, and show LOQ in the read-only spec row display (the `formatSpec`-style summary at ~line 51: append `· LOQ {loq}` when present). Rich hover tooltip on the label per FE default: "Limit of quantitation in the spec's unit. Results below it print as "< LOQ" on the COA; the pass/fail verdict still uses the raw number."
- [ ] **Step 4: Run tests → PASS**
- [ ] **Step 5: Commit** `feat(coa-display): LOQ input in the service specs editor`

### Task 6: Frontend — profile COA display fields

**Files:**
- Modify: `src\components\hplc\AnalysisProfilesPage.tsx`
- Test: extend `src\test\analysis-profiles-fulfillment.test.tsx`'s sibling (whichever existing profile-page test file covers the COA Section form block)

**Interfaces:** Consumes Task 3's four fields on GET/POST/PATCH.

- [ ] **Step 1: Failing test:** edit a profile, fill basis note, method, prep, and add two footnotes → PATCH body carries all four (`coa_footnotes` as `[{label, text}, ...]`); clearing them sends nulls (empty footnote list → `null`).
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement.** In the existing COA Section form block (where `coa_section_title` lives, ~lines 190-306): add form-state fields `coa_basis_note: string`, `coa_method_text: string`, `coa_prep_text: string`, `coa_footnotes: {label: string; text: string}[]`; hydrate on edit (`profile.coa_footnotes ?? []`); inputs — single-line for basis note, textareas for method/prep, and a repeatable footnote editor (label input + text textarea per row, Add/Remove buttons, ↑/↓ reorder buttons swapping adjacent entries). Payloads (both create and edit branches, matching lines ~278-306): `coa_basis_note: form.coa_basis_note.trim() || null` (same for method/prep), `coa_footnotes: cleaned.length ? cleaned : null` where `cleaned` drops rows whose label AND text are both blank and trims the rest (a row with only one side filled stays — the backend 400 surfaces it; do not silently drop half-filled rows).
- [ ] **Step 4: Run tests → PASS**
- [ ] **Step 5: Commit** `feat(coa-display): profile COA display fields editor`

### Task 7: Slice A gates

- [ ] **Step 1: Backend full suite:** `...\.venv\Scripts\python.exe -m pytest tests/ -q` (cwd `C:\tmp\Accu-Mk1-coa-display\backend`, ~10 min). Extract the sorted failure set; diff against the 68F/14E baseline sets in `C:\tmp\Accu-Mk1-s9-demand\.superpowers\sdd\2026-08-14-s9-demand-dehardcode-mk1\task-7-report.md`. Gate: failure-set diff EMPTY (new passes are fine; new failures are not).
- [ ] **Step 2: Frontend:** `npm run check:all` in the worktree → green (typecheck + lint + ast:lint + format + rust + tests).
- [ ] **Step 3: Commit** any formatter output; record both gate results in the progress ledger.

---

## Slice B — coabuilder (`C:\tmp\coabuilder-coa-restyle`)

### Task 8: Wire intake — `loq` + `result_display` validation

**Files:**
- Modify: `src\coabuilder_core\native_sections.py` — `_validate_wire_spec` (~70), row loop in `attach_native_sections` (~142)
- Test: `tests\test_native_sections_wire.py` (extend, existing idiom)

**Interfaces:**
- Produces: rows out of `attach_native_sections` keep `result_display` (validated) and carry the full wire spec (incl. `loq`) under `"rule"` (already the case via `{**row, "rule": wire_spec}`).

- [ ] **Step 1: Failing tests:**

```python
def test_wire_spec_loq_accepted_and_kept():
    # dict spec with "loq": 0.5 -> no raise; enriched row["rule"]["loq"] == 0.5

def test_wire_spec_loq_wrong_type_aborts():
    # "loq": "0.5" (string) -> NativeSectionsValidationError

def test_result_display_accepted_and_kept():
    # row with result_display "< LOQ" -> survives enrichment verbatim

def test_result_display_wrong_shape_aborts():
    # result_display "" and result_display 42 -> NativeSectionsValidationError
```

- [ ] **Step 2: Run → FAIL** (no raise where expected)
- [ ] **Step 3: Implement.** In `_validate_wire_spec`, after the shape check:

```python
    loq = spec.get("loq")
    if loq is not None and (isinstance(loq, bool) or not isinstance(loq, (int, float))):
        raise NativeSectionsValidationError(
            f"native sections: row {keyword!r} carries a non-numeric loq "
            f"({loq!r}) — aborting")
```

In the row loop, immediately after the empty-result check (so it guards baked-path rows too):

```python
            result_display = row.get("result_display")
            if result_display is not None and (
                    not isinstance(result_display, str) or not result_display.strip()):
                raise NativeSectionsValidationError(
                    f"native sections: row {keyword!r} carries a malformed "
                    f"result_display ({result_display!r}) — aborting")
```

- [ ] **Step 4: Run task tests + `tests\test_native_sections_wire.py` + `tests\test_native_sections_validation.py` → PASS**
- [ ] **Step 5: Commit** `feat(native-coa): validate loq + result_display on the wire`

### Task 9: Layout math — wrap helpers, extras height, pagination

**Files:**
- Modify: `src\coabuilder_core\native_sections.py` — constants block (~209) and `_paginate` (~221)
- Test: `tests\test_native_sections_validation.py` (extend — it owns pagination today; confirm via its content, else the file that tests `_paginate`)

**Interfaces:**
- Produces (renderer consumes in Task 10): `FRAME_WIDTH`, `NOTE_SIZE`, `NOTE_LEADING`, `METHOD_GAP`, `NOTES_GAP`, `NOTES_PAD`, `NOTES_TEXT_PAD`, `BODY_FONT`, `BOLD_FONT`; `_method_line_string(sec) -> str`; `_wrap_plain(text, size, max_w, font=BODY_FONT) -> list[str]`; `_wrap_after_prefix(prefix, text, size, max_w) -> list[str]` (line 0 starts after the bold prefix; renderer draws prefix separately); `_section_extras_height(sec) -> float`. `_paginate` keeps its `[(section, row_start, row_end)]` page shape — extras implicitly belong to the segment where `row_end == len(rows)`.

- [ ] **Step 1: Failing tests:**

```python
def _sec(n_rows, **extra):
    rows = [{"keyword": f"K{i}", "result": "1"} for i in range(n_rows)]
    return {"profile_key": "p", "archetype": "limit_table", "rows": rows, **extra}

def test_extras_height_zero_without_fields():
    assert _section_extras_height(_sec(2)) == 0.0

def test_extras_height_positive_with_method_and_footnotes():
    s = _sec(2, method_text="MP-AES", prep_text="100 mg / 10 mL digest",
             footnotes=[{"label": "Reporting.", "text": "x " * 200}])
    assert _section_extras_height(s) > 40

def test_paginate_reserves_extras_with_final_rows():
    # 28 rows alone fit page 1 exactly (fixed 44 + 28*16 = 492 <= 500), so a
    # sizable footnote must force an EARLIER break: last row moves to page 2
    # with the extras
    s = _sec(28, footnotes=[{"label": "L.", "text": "t " * 120}])
    pages = _paginate([s])
    assert len(pages) == 2
    last_sec, start, end = pages[-1][-1]
    assert end == 28 and start == 27

def test_paginate_aborts_when_extras_plus_one_row_cannot_fit_empty_page():
    s = _sec(1, footnotes=[{"label": "L.", "text": "word " * 3000}])
    with pytest.raises(NativeSectionsValidationError):
        _paginate([s])

def test_paginate_unchanged_without_extras():
    # regression pin: 40 plain rows paginate exactly as before this slice
    # (fit = (500-44)//16 = 28 on an empty page)
    pages = _paginate([_sec(40)])
    assert [(s, e) for pg in pages for (_, s, e) in pg] == [(0, 28), (28, 40)]
```

(Verify the expectation against the CURRENT `_paginate` by running this test BEFORE editing `_paginate` — pin whatever it actually produces today, then it must still pass after.)

- [ ] **Step 2: Run → FAIL** (names undefined)
- [ ] **Step 3: Implement.** Extend the constants block:

```python
FRAME_WIDTH = 573.9   # NativeSections frame width — layout.json is the master
NOTE_SIZE = 6.5
NOTE_LEADING = 9.0
METHOD_GAP = 4.0      # table bottom -> method line
NOTES_GAP = 4.0       # method line -> footnotes box
NOTES_PAD = 6.0       # footnotes box inner top/bottom padding
NOTES_TEXT_PAD = 8.0  # footnotes box inner left/right padding
BODY_FONT = "Helvetica"
BOLD_FONT = "Helvetica-Bold"
```

Add `from reportlab.pdfbase.pdfmetrics import stringWidth` (module stays canvas-free — stringWidth is pure metrics) and:

```python
def _method_line_string(sec) -> str:
    parts = []
    if (sec.get("method_text") or "").strip():
        parts.append(f"Method: {sec['method_text'].strip()}")
    if (sec.get("prep_text") or "").strip():
        parts.append(f"Sample Prep: {sec['prep_text'].strip()}")
    return "   |   ".join(parts)


def _wrap_plain(text, size, max_w, font=BODY_FONT):
    words, lines, cur = str(text or "").split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if cur and stringWidth(trial, font, size) > max_w:
            lines.append(cur); cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def _wrap_after_prefix(prefix, text, size, max_w):
    """Wrap `text` where line 0 begins after a bold `prefix ` (drawn by the
    renderer); continuation lines get the full width."""
    avail = max(max_w - stringWidth(prefix + " ", BOLD_FONT, size), 1.0)
    words, lines, cur = str(text or "").split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if cur and stringWidth(trial, BODY_FONT, size) > avail:
            lines.append(cur); cur, avail = w, max_w
        else:
            cur = trial
    lines.append(cur)
    return lines


def _section_extras_height(sec) -> float:
    """Vertical budget of the method line + footnotes box below a section's
    table. Measured against FRAME_WIDTH so pagination needs no canvas —
    the renderer MUST wrap with the same helpers/constants."""
    h = 0.0
    m = _method_line_string(sec)
    if m:
        h += METHOD_GAP + len(_wrap_plain(m, NOTE_SIZE, FRAME_WIDTH)) * NOTE_LEADING
    notes = [n for n in (sec.get("footnotes") or []) if isinstance(n, dict)]
    if notes:
        h += NOTES_GAP + 2 * NOTES_PAD
        text_w = FRAME_WIDTH - 2 * NOTES_TEXT_PAD
        for n in notes:
            h += len(_wrap_after_prefix(str(n.get("label") or ""),
                                        str(n.get("text") or ""),
                                        NOTE_SIZE, text_w)) * NOTE_LEADING
    return h
```

Replace `_paginate`'s body (same signature, same page shape):

```python
def _paginate(sections):
    """[(section, row_start, row_end)] per page. Never truncates — aborts.
    A section's method/footnote extras ride with its FINAL row segment; the
    loop breaks a page early rather than stranding extras alone."""
    pages, current, remaining = [], [], FRAME_HEIGHT
    for sec in sections:
        n_rows = len(sec["rows"])
        extras_h = _section_extras_height(sec)
        min_needed = SECTION_HEAD_H + SUBHEAD_H + ROW_H + extras_h + SECTION_GAP
        if min_needed > FRAME_HEIGHT:
            raise NativeSectionsValidationError(
                f"native sections: section {sec.get('profile_key')!r} cannot fit "
                f"one row plus its method/footnote block on an empty page — "
                f"layout broken (needs {min_needed:.0f}pt of {FRAME_HEIGHT:.0f}pt)"
            )
        start = 0
        while start < n_rows:
            fixed = SECTION_HEAD_H + SUBHEAD_H + SECTION_GAP
            avail = remaining - fixed
            rows_left = n_rows - start
            fit = int(avail // ROW_H)
            if fit >= rows_left and rows_left * ROW_H + extras_h <= avail:
                current.append((sec, start, n_rows))
                remaining -= fixed + rows_left * ROW_H + extras_h
                start = n_rows
                continue
            take = min(fit, rows_left - 1)  # keep >=1 row for the extras' page
            if take < 1:
                if not current:
                    raise NativeSectionsValidationError(
                        f"native sections: section {sec.get('profile_key')!r} "
                        f"cannot be laid out on an empty page — aborting"
                    )
                pages.append(current)
                current, remaining = [], FRAME_HEIGHT
                continue
            current.append((sec, start, start + take))
            remaining -= fixed + take * ROW_H
            start += take
    if current:
        pages.append(current)
    return pages
```

- [ ] **Step 4: Run task tests + the whole pagination test file → PASS** (the no-extras regression pin proves old behavior preserved)
- [ ] **Step 5: Commit** `feat(native-coa): variable-height layout math for method line + footnotes`

### Task 10: Renderer restyle — mockup chrome + adaptive columns + extras

**Files:**
- Modify: `src\coabuilder_core\generator.py` — `_draw_native_sections` (~793)
- Test: `tests\test_native_sections_render.py` (extend, following its existing draw-and-assert idiom)

**Interfaces:**
- Consumes: Task 9's constants/helpers (import from `.native_sections`); Task 8's validated rows (`rule.loq`, `result_display`); section keys `basis_note`/`method_text`/`prep_text`/`footnotes` (`.get(...)` — absent keys legal, Slice A may not be deployed).

- [ ] **Step 1: Failing render tests:**

```python
def test_render_mockup_section_smoke(tmp_path):
    # section with basis_note, method+prep, 2 footnotes, rows with rule.loq
    # and one result_display="< LOQ" -> generate page, assert no raise and
    # the canvas received roundRect calls (patch canvas or assert PDF bytes non-empty
    # per the file's existing idiom)

def test_adaptive_columns_uniform_unit_folds_into_headers():
    # all rows unit "µg/g" -> header text contains "Result (µg/g)"; no Unit column

def test_adaptive_columns_mixed_units_keep_unit_column():
    # units "µg/g" and "" -> headers are the legacy 5-column set

def test_loq_column_only_when_present():
    # no rule.loq anywhere -> headers contain no "LOQ"

def test_result_display_printed_over_result():
    # row result "0.2", result_display "< LOQ" -> drawn strings include "< LOQ" and not "0.2"
```

(Introspect drawn strings the way the existing render tests do — e.g. monkeypatching the canvas text methods; follow the file's established mechanism.)

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement.** Rewrite `_draw_native_sections` keeping its signature and the `native_section_page_slice` entry:

Palette additions next to the existing constants: `GREEN = HexColor("#0F7B3D")`, `MUTED = HexColor("#5B6474")`, `LINE = HexColor("#DDE4EE")`, `NOTE_BG = HexColor("#F7F9FC")`, `TINT = HexColor("#C6D2F0")`; radius `R = 6.0`. Import the Task 9 names: `FRAME_WIDTH` unused here (width comes from cfg), `NOTE_SIZE, NOTE_LEADING, METHOD_GAP, NOTES_GAP, NOTES_PAD, NOTES_TEXT_PAD, _method_line_string, _wrap_plain, _wrap_after_prefix`.

Per section segment `(sec, start, end)`:

1. Segment height `seg_h = SECTION_HEAD_H + SUBHEAD_H + (end - start) * ROW_H`. Container: `c.roundRect(x0, y - seg_h, total_w, seg_h, R, stroke=0, fill=1)` filled `BRAND_BLUE`; then body overlay `c.rect(x0, y - seg_h, total_w, seg_h - SECTION_HEAD_H, stroke=0, fill=1)` filled WHITE **but** bottom corners must stay rounded — draw the white body as `roundRect` + a white square patch over its top edge (`c.rect(x0, y - SECTION_HEAD_H - (seg_h - SECTION_HEAD_H)/2 ...)`) — concretely:

```python
            c.setFillColor(BRAND_BLUE)
            c.roundRect(x0, y - seg_h, total_w, seg_h, R, stroke=0, fill=1)
            body_h = seg_h - SECTION_HEAD_H
            c.setFillColor(WHITE)
            c.roundRect(x0, y - seg_h, total_w, body_h, R, stroke=0, fill=1)
            c.rect(x0, y - SECTION_HEAD_H - body_h / 2.0, total_w, body_h / 2.0,
                   stroke=0, fill=1)  # square the white body's TOP edge
```

2. Header text: title left (white, bold, 9.0) exactly as today; `basis_note` right-aligned in the same band, `TINT`, size 6.5, ellipsized to the space right of the title:

```python
            note = sec.get("basis_note") or ""
            if note:
                title_w = stringWidth(str(sec["title"]), "Helvetica-Bold", 9.0)
                max_note_w = total_w - title_w - 24
                while note and stringWidth(note, font, 6.5) > max_note_w:
                    note = note[:-2].rstrip() + "…" if len(note) > 1 else ""
                if note:
                    text(note, x0, y - SECTION_HEAD_H / 2.0 - 2.4, total_w,
                         color=TINT, fsize=6.5, align="right")
```

3. Column model, computed once per section (before the segment loop over `items` — compute per `sec` since a section can span segments):

```python
        def _columns(sec):
            rows = sec["rows"]
            units = {(r.get("unit") or "").strip() for r in rows}
            uniform = units.copy().pop() if len(units) == 1 and "" not in units else None
            has_loq = any((r.get("rule") or {}).get("loq") is not None for r in rows)
            u = f" ({uniform})" if uniform else ""
            if uniform and has_loq:
                cols = ((0.00, 0.30, "left", "Test"), (0.30, 0.16, "center", f"Result{u}"),
                        (0.46, 0.14, "center", f"LOQ{u}"), (0.60, 0.22, "center", f"Specification{u}"),
                        (0.82, 0.18, "center", "Verdict"))
            elif uniform:
                cols = ((0.00, 0.34, "left", "Test"), (0.34, 0.18, "center", f"Result{u}"),
                        (0.52, 0.28, "center", f"Specification{u}"), (0.80, 0.20, "center", "Verdict"))
            elif has_loq:
                cols = ((0.00, 0.28, "left", "Test"), (0.28, 0.14, "center", "Result"),
                        (0.42, 0.10, "center", "Unit"), (0.52, 0.12, "center", "LOQ"),
                        (0.64, 0.20, "center", "Specification"), (0.84, 0.16, "center", "Verdict"))
            else:
                cols = ((0.00, 0.34, "left", "Test"), (0.34, 0.14, "center", "Result"),
                        (0.48, 0.10, "center", "Unit"), (0.58, 0.24, "center", "Specification"),
                        (0.82, 0.18, "center", "Verdict"))
            return cols, uniform, has_loq
```

4. Cell values per column label: Test → `row.get("name")`; Result → `row.get("result_display") or row.get("result", "")` (color `MUTED` when `result_display`); Unit → `row.get("unit")`; LOQ → `f"{loq:g}"` if `(row.get('rule') or {}).get('loq') is not None` else `""`; Specification → `row.get("specification", "")`, and when `uniform`, strip a trailing `f" {uniform}"` suffix (`val = val[:-len(sfx)] if val.endswith(sfx) else val`); Verdict → `row.get("status", "")`, color `GREEN` bold when `conforms is True`, `CORAL` bold when `False`, `INK` when `None`.

5. Row stripes as today (WHITE/ROW_ALT) but drawn INSIDE the container (the body roundRect already painted white; stripe only the alt rows, and give the LAST row segment a rounded bottom via `roundRect` + top-edge square patch, mirroring step 1's technique).

6. After the segment's rows, `if end == len(sec["rows"]):` draw extras with the shared helpers, advancing `y` by exactly the amounts `_section_extras_height` budgets:

```python
                m = _method_line_string(sec)
                if m:
                    y -= METHOD_GAP
                    for ln in _wrap_plain(m, NOTE_SIZE, total_w):
                        y -= NOTE_LEADING
                        # BODY_FONT, not cfg's font: measurement (Task 9) and
                        # draw must use the same face or heights drift.
                        c.setFillColor(MUTED)
                        c.setFont(BODY_FONT, NOTE_SIZE)
                        c.drawString(x0, y + NOTE_LEADING * 0.25, ln)
                notes = [n for n in (sec.get("footnotes") or []) if isinstance(n, dict)]
                if notes:
                    y -= NOTES_GAP
                    text_w = total_w - 2 * NOTES_TEXT_PAD
                    wrapped = [(str(n.get("label") or ""),
                                _wrap_after_prefix(str(n.get("label") or ""),
                                                   str(n.get("text") or ""),
                                                   NOTE_SIZE, text_w)) for n in notes]
                    box_h = 2 * NOTES_PAD + sum(len(ls) for _, ls in wrapped) * NOTE_LEADING
                    c.setFillColor(NOTE_BG); c.setStrokeColor(LINE); c.setLineWidth(1)
                    c.roundRect(x0, y - box_h, total_w, box_h, R, stroke=1, fill=1)
                    ny = y - NOTES_PAD
                    for label, lines in wrapped:
                        for li, ln in enumerate(lines):
                            ny -= NOTE_LEADING
                            tx = x0 + NOTES_TEXT_PAD
                            if li == 0 and label:
                                c.setFillColor(INK)
                                c.setFont(BOLD_FONT, NOTE_SIZE)
                                c.drawString(tx, ny, label)
                                tx += stringWidth(label + " ", BOLD_FONT, NOTE_SIZE)
                            c.setFillColor(MUTED)
                            c.setFont(BODY_FONT, NOTE_SIZE)  # match Task 9 measurement
                            c.drawString(tx, ny, ln)
                    y -= box_h
```

7. Container border stroke last per segment: `c.setStrokeColor(LINE); c.setLineWidth(1); c.roundRect(x0, seg_bottom, total_w, seg_h, R, stroke=1, fill=0)` (record `seg_top`/`seg_bottom` before drawing rows). Note in a comment that a multi-page section gets a container per page segment — deliberate.

(`from reportlab.pdfbase.pdfmetrics import stringWidth` at the top of generator.py if not already imported.)
- [ ] **Step 4: Run task tests + `tests\test_native_sections_render.py` → PASS**
- [ ] **Step 5: Commit** `feat(native-coa): mockup restyle — rounded sections, adaptive columns, LOQ, method line, footnotes`

### Task 11: Slice B gate

- [ ] **Step 1:** Full suite: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\coabuilder\.venv\Scripts\python.exe -m pytest tests/ -q` (cwd `C:\tmp\coabuilder-coa-restyle`) → same pass/fail set as at base `04aceac` (run at base first if unsure; expected: all green or a pre-existing known set — record it).
- [ ] **Step 2:** Record the gate result in the progress ledger; commit anything outstanding.
