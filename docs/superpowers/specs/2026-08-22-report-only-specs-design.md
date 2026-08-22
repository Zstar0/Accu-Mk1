# Report-only specs ("as measured") — design

*2026-08-22. Trigger: Moisture Content setup — the lab reports a measured value with no
pass/fail. Today the spec system cannot express that: native-sections rule 5 is fail-closed
(every member service must resolve an active spec row or COA generation aborts), and
`analysis_service_specs.rule_kind` only knows `range` and `equals`, both of which mint a
verdict. The legacy core panel's "Quantity is informational and never gates" concept was never
generalized. This slice generalizes it, admin-configurably, without touching rule 5.*

**Prior art already shipped (the renderer is fluent in verdict-less rows):**
- Wire rows with `conforms: null` render a neutral **N/A** pill on the PDF (coab restyle),
  the verify page, and badge v1.6.0 (`_resultStatus` strict `conforms === null` branch).
- coabuilder `baked_specs.INFORMATIONAL_KEYWORDS` (empty set) documents the intended
  presentation on the baked-fallback path: "EMPTY Specification and Verdict, by design."
- A profile with an empty `coa_archetype` skips its COA section entirely — so the lab can
  start moisture bench work BEFORE this slice lands; the certificate simply omits the section
  until the archetype is armed.

## 1. What ships

A third spec rule kind, `informational`: a real `analysis_service_specs` row that satisfies
rule 5 (a spec exists, deliberately) but declares "no verdict — print the measured value."

## 2. Schema (additive)

- Widen the `rule_kind` CHECK on `analysis_service_specs` to include `'informational'`.
  Migration = drop + re-add CHECK (the review_state precedent, but clean here: no existing
  row can violate the widened constraint, so the re-add cannot enter the skip-forever class).
- No new columns. Informational rows carry `min_value/max_value/equals_value = NULL`,
  `loq = NULL` (see Non-goals), `unit` optional (display unit, e.g. `% w/w`),
  `display_override` optional (spec-cell text if the lab wants any).

## 3. Producer (Mk1)

- **Resolver: unchanged.** Informational rows participate in the peptide > matrix > wildcard
  tiers like any other row. Deliberate consequence (R2 below): a wildcard `informational` and
  a peptide-tier `range` can coexist for one service — the tier winner decides whether that
  peptide gets a verdict. That is a feature (e.g. moisture measured-only generally, but
  spec-bound for one product line later).
- **Evaluator:** `evaluate()` returns `None` for `rule_kind='informational'` — no numeric
  parsing, no NaN/±inf abort (those guards stay for range/equals). The existing empty-result
  abort (rule 3) is row-level and still applies: a blank result still blocks the COA.
- **Wire** (`_spec_wire_dict` / row build): `specification = {rule_kind: "informational",
  equals/min/max: null, unit, display: display_override|null, loq: null}`;
  row `conforms: null`. `result_display` censoring untouched (range-only today).
- **Overall-status fold:** wherever section/overall verdicts aggregate, `conforms is None`
  must count as neither pass nor fail (pin with a test; coabuilder's
  `coa_requires_lab_remarks` already only reacts to `conforms is False`).

## 4. Specs editor (API + UI)

- Rule-kind selector gains **"Report as measured (no verdict)"**.
- UI hides min/max/equals/LOQ inputs for it; API **rejects** (400) any of those values on an
  informational create — explicit, not silently nulled (R3).
- Writes go through `record_spec_change` like every other spec write (R3 of the S2 slice
  holds: no unaudited path, deactivate-never-delete unchanged).

## 5. Renderer / downstream (expected: zero code, pinned by tests)

- coabuilder: `conforms: null` → neutral pill; no LOQ column contribution; spec cell renders
  `display` if present, else empty (matches the INFORMATIONAL_KEYWORDS docblock precedent, R1).
- Verify page / portal / badge: already strict-null aware — regression-pin only.

## 6. Tests

- **Cross-repo parity twins move together** (`backend/tests/test_spec_rules.py` ↔ coabuilder
  `tests/test_verdict_parity.py`): add identical informational cases to BOTH in one motion —
  editing one side silently breaks the gate.
- Mk1: evaluator returns None; wire-shape test (spec dict + conforms null); resolver tier test
  (peptide `range` beats wildcard `informational` and vice versa); editor route tests (create
  ok, 400 on min/max/equals/loq, audited write); overall-fold ignores None.
- coabuilder: render pin — neutral pill fill at draw time (recorder canvas, same idiom as
  `test_variance_table_native_card_style`), no LOQ column, folded-unit variant.
- Full-suite gate: failure-ID set vs baseline, never zero-failures.

## 7. Rollout (moisture recipe)

1. Lab can begin NOW: create Moisture department/service/profile (`moisture`, 1 vial, role
   `kf`), leave `coa_archetype` EMPTY → bench work runs, COA omits the section.
2. Slice lands (Mk1 + test twins; coabuilder likely test-only) → deploy per skill.
3. File the informational spec row(s) for the moisture service via the editor (wildcard tier
   first; unit `% w/w`).
4. Arm `coa_archetype` on the profile → sections start printing "as measured" with the
   neutral pill.
5. Method item owed by the lab regardless: the moisture LOQ table is µg H₂O and needs the
   nominal mass to become % w/w (Slack canvas F0BE21Y1PTM).

## 8. Non-goals

- LOQ/censoring on informational rows (v1 excludes; revisit when the lab's % w/w LOQ method
  lands — R4).
- Retro-fitting the legacy core panel (Quantity keeps its hardcoded path).
- Any badge/verify-page code change (null-aware already).
- Populating coabuilder's `INFORMATIONAL_KEYWORDS` (that hook is the baked-fallback path;
  the Mk1-owned wire is authoritative and this slice makes the hook unnecessary for catalog
  families).

## 9. Handler veto window

- **R1** — informational spec cell renders EMPTY by default (`display_override` available for
  text like "Report only"). Alternative: a default literal "As measured".
- **R2** — informational participates in tiers normally (peptide-tier verdict can override a
  wildcard informational, and vice versa). Alternative: forbid mixing kinds across tiers.
- **R3** — editor REJECTS bounds/LOQ on informational rows (loud), never silently nulls.
- **R4** — no LOQ on informational rows in v1.
