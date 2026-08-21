# COA Display Fields + Native-Section Restyle — Design

*2026-08-16. Approved in discussion with the Handler (rulings: native-sections-only restyle; LOQ on the spec row; fields must generalize to all test families, not just Heavy Metals).*

## Goal

Two coordinated slices that let the certificate's native sections render like the approved Heavy Metals mockup (`C:\Users\forre\Downloads\accumark_heavy_metals_coa_mockup.html`), driven entirely by catalog data:

- **Slice A (Mk1, `feat/coa-display-fields` @ `C:\tmp\Accu-Mk1-coa-display`, stacked on the specs-editor tip `27d04b47`):** new catalog columns — per-spec LOQ and per-profile section display text — crossing the native-sections wire.
- **Slice B (coabuilder, `feat/native-coa-restyle` @ `C:\tmp\coabuilder-coa-restyle`, stacked on `feat/native-spec-wire` tip `04aceac`):** restyle `_draw_native_sections` to the mockup chrome and render the new fields.

Every new field is optional. A profile/spec with none of them set renders exactly today's certificate content (restyled). The two slices are independently mergeable in either order: coabuilder tolerates absent keys; Mk1 sends keys coabuilder may ignore.

**Generality contract:** nothing in this design is keyed to Heavy Metals, the `hm` role, or any keyword. Fields attach to `analysis_profiles` (section-scoped chrome, archetype-independent) and `analysis_service_specs` (per-analyte numeric floor). Sterility (`equals` specs), endotoxin ("< 0.05 EU/mg" reporting), micro counts ("< 10 CFU/g"), and pH (blank unit) were each walked through the design; the adaptive rules below are what make them render correctly with no family-specific code.

## Slice A — Mk1 producer

### A1. Schema (additive, nullable, following the specs-editor slice's migration pattern)

- `analysis_service_specs.loq` — `Numeric`, NULL. Unit is implicitly the spec row's `unit` (the only unit-coherence anchor; spec unit is display-only, no unit matching exists).
- `analysis_profiles.coa_basis_note` — `String(200)`, NULL. Header annotation (e.g. "Basis: USP <232> Parenteral PDE | Assumed MDD 50 mg/day").
- `analysis_profiles.coa_method_text` — `Text`, NULL (e.g. "Microwave Plasma Atomic Emission Spectrometry (MP-AES) following hot block acid digestion").
- `analysis_profiles.coa_prep_text` — `Text`, NULL (e.g. "100 mg / 10 mL digest").
- `analysis_profiles.coa_footnotes` — `JSONB`, NULL. Ordered list `[{"label": str, "text": str}]` (e.g. label "Specification basis.", text = the derivation paragraph). List shape is deliberate: families differ in footnote count/content without schema change.

No backfill needed: all NULL defaults, and NULL means "absent from the wire" (heavy_metals profile id 6 on arcitest is hand-authored — fields get authored through the UI, not seeded).

### A2. Authoring surfaces

- **LOQ:** `ServiceSpecsSection.tsx` gains an LOQ input beside min/max (same styling/validation idiom; blank = null; must be a finite non-negative number when set). Crosses the existing POST/PATCH spec routes; joins the editable-fields surface audited by `record_spec_change`. Rows remain deactivate-never-delete.
- **Profile fields:** `AnalysisProfilesPage.tsx` gains the four fields (basis note: single-line input; method/prep: textareas; footnotes: repeatable label+text rows with add/remove/reorder). Crosses the existing AnalysisProfile create/update routes; joins the profile's audited/editable field surface exactly as `coa_section_title` does today.

### A3. Wire contract (`backend/coa/native_sections.py`)

Section dict gains (from the profile row, key always present, value None/empty when unset):

- `basis_note`, `method_text`, `prep_text` — strings or None
- `footnotes` — list of `{label, text}` (empty list when unset)

`_spec_wire_dict` gains `"loq"`: float or None (same Decimal→float conversion as min/max).

Row dict gains `"result_display"`: string or None. **Contract: this is Mk1's applied lab-reporting convention, not an LOQ-specific field.** The renderer prints it verbatim in place of `result` when present. The only convention today:

- **LOQ censoring:** applies iff resolved spec `rule_kind == 'range'` AND `loq` is not None AND `result` parses as a finite float AND `float(result) < loq` → `result_display = "< LOQ"`. Boundary: `result == loq` is NOT censored. `equals`-kind rows never censor regardless of a stray loq. Non-numeric results never censor (evaluate() has already aborted those for range rows anyway — censoring runs on the post-evaluate row, so it can assume evaluate() passed).

`evaluate()` and the verdict are untouched: conformance is always computed on the raw entered number (a below-LOQ value conforms naturally; the mockup's reporting footnote states this convention to the reader).

### A4. Tests (Mk1)

- Spec model/routes: loq accepted/persisted/audited; rejects negative/non-finite; null round-trips.
- Wire: new section keys present and None/empty-safe; loq crosses in the spec dict; censoring boundary trio (below → "< LOQ", equal → None, above → None); equals-kind never censors; profile with no fields set produces today's document plus the new always-present keys.
- Gate: full backend suite judged as failure-SET diff vs the 68F/14E baseline (never zero-failures).

## Slice B — coabuilder renderer

### B1. Chrome (mockup → `_draw_native_sections`)

Per section, in order:

1. **Container:** rounded-rect (≈8pt radius, 1pt border, light line color) wrapping header + table. Technique note: ReportLab `roundRect` (present in deployed 4.5.1) rounds all four corners — draw the navy roundRect full-section, overlay a white body rect, restroke the border, rather than attempting clipping.
2. **Header band:** navy (reuse existing `BRAND_BLUE` family — do NOT introduce the mockup's near-identical second navy), section `title` left in white bold; `basis_note` right-aligned in the light-blue tint, same band. Absent basis_note → title only.
3. **Column header band:** existing sub-header blue, columns `Test | Result | LOQ | Specification | Verdict`.
4. **Rows:** alternating white / row-alt tint; analyte name semibold; `result_display or result` (result_display rendered muted); verdict green "Conforms" / red "Does Not Conform" (existing status strings).
5. **Method/prep line** (below the section box, small muted text): `Method: {method_text}  |  Sample Prep: {prep_text}` — render only the parts present; skip the line entirely when both absent.
6. **Footnotes block** (light-tinted rounded box, wrapped text): one paragraph per `{label, text}`, label bold. Skip when empty.

### B2. Adaptive column rules (the generality mechanics)

- **LOQ column renders only when ≥1 row in the section carries a non-null `rule.loq`** (sterility sections: no column).
- **Unit folding:** when every row in a section has the same non-empty unit, fold it into the column headers ("Result (µg/g)", "LOQ (µg/g)", "Specification (µg/g)") and drop the per-row Unit column; otherwise render the per-row Unit column as today. (pH's blank unit ⇒ mixed ⇒ per-row column; that's correct.)
- LOQ cell: the row's `rule.loq` formatted like other numerics; blank when null.

### B3. Wire intake

- `_validate_wire_spec` accepts optional `loq` (numeric or None; abort on other types — fail-closed like its siblings).
- `result_display` flows through the `{**row}` spread untouched; renderer contract is `result_display or result`. Validation: must be a non-empty string or None (the wire sends an explicit None when no convention applied); any other type aborts.
- Baked-spec fallback path: **untouched** (documented rollback path; deleted in the conformance-migration slice, not here).

### B4. Pagination lockstep (the constraint that bites)

`_paginate` currently budgets `SECTION_HEAD_H + SUBHEAD_H + n·ROW_H + SECTION_GAP` against `FRAME_HEIGHT = 500.0`, matching the draw code and `Templates/Additional Analyses/layout.json`. This slice:

- Adjusts band constants to the new chrome (header/subheader/row heights change with the restyle) — **all three places move together** (`_paginate` constants, draw code, layout.json frame if its height changes; prefer keeping the frame at 500).
- Adds two **variable-height** bands: method/prep line and footnotes block. Heights computed from actual text wrapping at layout time (same wrap routine the draw code uses — single source of truth for measurement, e.g. a shared helper returning both wrapped lines and height).
- **Placement rule:** method line + footnotes render after the section's final row and must fit on the page containing that final row segment. If they cannot fit even with the minimal final segment on an empty page → `NativeSectionsValidationError` (fail-closed, never truncate — existing doctrine).

### B5. Tests (coabuilder)

- Validator: loq accepted (numeric/None), wrong-type aborts; result_display string/None accepted, wrong-type aborts.
- Renderer/pagination: unit folding on/off; LOQ column presence on/off; result_display printed in place of result; method line and footnotes heights enter pagination math; fail-closed when notes can't fit; a full HM-shaped section with every field populated (the mockup case) and a sterility-shaped section (equals spec, no loq, footnotes only).
- Existing native-section test corpus stays green (absent keys ⇒ old content, new chrome).

## Out of scope (explicit)

- Page-1 artwork restyle (Handler ruling: native sections only for now).
- Per-analysis achieved-LOQ override / prep-deviation capture (future; `lims_sub_samples.remarks` is the interim escape hatch).
- Unit matching or conversion (spec unit remains display-only; the save-time soft warning remains a separately offered follow-up).
- Generalized method entity for native families (revisit when methods carry structured behavior — ISO 17025 direction).
- Retiring coabuilder's baked-spec fallback (conformance-migration slice 3).
- Per-profile column-label overrides (e.g. micro "RL" instead of "LOQ").
- Arc/prod deployment (follows the established arc-composition deploy pattern separately; merge train HELD).

## Known limits (accepted on the record)

1. `coa_basis_note` is profile-level while specs resolve per-tier (peptide > matrix > wildcard). If tiered specs ever diverge in *derivation*, one note can't describe both. Accepted; revisit on real occurrence.
2. Method text is per-section. A future mixed-method profile uses the existing per-row `method` wire field (needs `method_id` populated — separate work).
3. The MDD assumption appears in both `coa_basis_note` and a footnote paragraph — two authored places to update if it changes. Accepted over building templating.
