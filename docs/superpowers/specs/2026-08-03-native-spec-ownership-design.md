---
title: "Native Spec Ownership — pass/fail rules move from COABuilder onto Accu-Mk1 Analysis Services"
date: 2026-08-03
status: draft
authors: [ZeroSignal, forrestp]
depends_on: "docs/superpowers/specs/2026-07-28-native-coa-sections-design.md (spec 2); docs/superpowers/specs/2026-07-31-catalog-driven-bench-design.md (spec 4)"
part_of: "New-test-families program — first slice of the conformance-engine migration"
---

# Native Spec Ownership

## Summary

Move the **specification and the pass/fail verdict for native COA sections** out of COABuilder's
hardcoded `BAKED_SPECS` dict and onto the Accu-Mk1 Analysis Service that owns the result. Mk1 then
fills the two fields it currently sends `null`.

Scope is deliberately one slice of the larger conformance-engine migration
([[project_spec_validation_engine_migration]]): **native sections only**. The 1,163-line peptide
`conformance.py`, the 439-line `generic_assay_engine.py`, and `addon_parsing.py` are untouched.

### Why now

Adding a test family currently requires a **COABuilder code change and deploy** to add a spec row.
That is the third of three manual touchpoints per family. The other two (the Integration Service
declared key, the WordPress product) are deliberate gates — order-path isolation and sale gating.
This one is not deliberate; it is a stopgap that `baked_specs.py`'s own docstring calls a stopgap.

### Why this is a correctness fix, not just ergonomics

A native section's verdict currently hinges on **exact case-insensitive string equality** between a
dropdown value a lab manager edits freely in the Mk1 admin UI
(`analysis_services.result_options[].value`) and a hardcoded literal in a different repository
(`baked_specs.py`). Nothing cross-checks the pair.

Worse, the mismatch does **not** fail closed. `_verdict`'s `equals` branch silently returns `False`
(`coabuilder/src/coabuilder_core/native_sections.py:35-36`), so a passing result prints
`Does Not Conform` and flips `overall_status_badge` to `FAILED` for the whole certificate — with no
`nonconformance_reasons` recorded and **without tripping the lab-remarks gate** (native rows carry no
`test_type` and are not in `data.results`, so `coa_requires_lab_remarks` never sees them).

This was reproduced end-to-end on stack `s3rehe` on 2026-08-02 against real certificates: service 234
`STERILITY_USP71` stored `"0"`/`"1"` while the baked spec expected `"No Growth"`. Certificate
`F6UX-5UWP` page 4 printed a clean sterility pass as `Does Not Conform` with the badge at `FAILED`,
while all four heavy metals conformed in the section above. After aligning both sides,
`AH5F-2QSD` page 4 printed `Conforms` / `PASSED`.

That specific instance is fixed (coabuilder `64e5981`, Mk1 `a1841c5`). **The class is not.** Every
future qualitative family re-opens it, because the contract is still two hand-edited literals in two
repositories. Co-locating the spec with the `result_options` it must agree with is the structural fix:
same table, same admin screen, same person, same transaction.

## The seam is pre-drawn

This spec does the thing spec 2 explicitly built for. `native_sections.py:1-13`:

> *"Mk1 sends specification/conforms as null, ALWAYS — this module fills them from baked_specs so the
> wire format survives the future conformance-engine migration unchanged (Mk1 will fill the same two
> fields; this lookup then gets deleted; the renderer never changes)."*

Consequences, and they are the reason this slice is small:

- **No wire-format change.** `specification` and `conforms` already exist on every row
  (`backend/coa/native_sections.py:159-167`); they are currently always `None`.
- **No renderer change.** `generator.py:858-866` already reads `row["specification"]`,
  `row["conforms"]`, `row["status"]`.
- **No template change.** The `NativeSections` frame and its pagination geometry are untouched.

## What moves, and what explicitly does not

| Concern | Disposition |
|---|---|
| Spec storage for native services | **Moves** to Mk1 (new table) |
| Native row verdict (`range` / `equals`) | **Moves** to Mk1 |
| `specification` display string | **Stays** COABuilder-formatted from structured bounds Mk1 sends |
| Native-section pagination (`native_sections.py:149-201`) | **Stays** — pure ReportLab geometry |
| Hex colors, `_COLOR_DEFAULT` | **Stays** — presentation |
| `conformance.py` (peptide: identity, 98% purity, blend, variance mean) | **UNTOUCHED** |
| `generic_assay_engine.py` (BW and other non-peptide matrices) | **UNTOUCHED** |
| `addon_parsing.py` (ENDO-LAL, STER-PCR legacy rows) | **UNTOUCHED** |
| `BAKED_SPECS` rows for non-native keywords | **UNTOUCHED** (`Benzyl_Alcohol_Assay`, `PH-DETERM`, BW `ENDO-LAL`) |

Only the five native rows (`HM-PB`, `HM-AS`, `HM-CD`, `HM-HG`, `STERILITY_USP71`) plus
`TEST_TECHNIQUES` are in scope, and even they are not deleted in this slice — see Rollout.

## Data model

### `analysis_service_specs`

A separate table rather than columns on `analysis_services`, because one service can legitimately need
different limits per matrix (pH in bacteriostatic water vs. pH in a peptide solution), and because a
spec has its own lifecycle and audit surface.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `analysis_service_id` | int FK → `analysis_services.id` `ON DELETE CASCADE` | The **identity join is the FK**, never the keyword |
| `matrix` | `VARCHAR(100)` **NULL** | NULL = applies to every matrix. See below. |
| `rule_kind` | `VARCHAR(16)` NOT NULL | `range` \| `equals` |
| `min_value` | `NUMERIC` NULL | `range` only |
| `max_value` | `NUMERIC` NULL | `range` only |
| `equals_value` | `TEXT` NULL | `equals` only |
| `unit` | `VARCHAR(50)` NULL | Spec's own unit; compared against the row's unit |
| `display_override` | `TEXT` NULL | NULL = COABuilder formats from bounds |
| `active` | bool NOT NULL default true | Deactivate rather than delete |
| `created_at` / `updated_at` | timestamps | |
| `updated_by_id` | int FK → `users.id` `ON DELETE SET NULL` | |

Constraints:

- Partial unique index on `(analysis_service_id, matrix)` where `active` — one active spec per
  service per matrix. Postgres treats NULLs as distinct in unique indexes, so the NULL-matrix default
  row needs its own partial unique index on `(analysis_service_id)` where `matrix IS NULL AND active`.
- `CHECK` (`rule_kind='range'` AND `equals_value IS NULL` AND at least one bound non-NULL) OR
  (`rule_kind='equals'` AND `equals_value IS NOT NULL` AND both bounds NULL).
- Mk1 has **no alembic**: schema flows through `Base.metadata.create_all` plus the idempotent raw-DDL
  helpers in `backend/database.py`. Follow that convention; see the LAST-BOOT-WINS hazard note at
  `backend/database.py:1400-1418`.

### `matrix` is lab-controlled and deliberately NOT the customer's dropdown

The column is named `matrix`, **not** `sample_type_title`, to stop three distinct axes being
conflated:

- **Matrix** — what the analyte is dissolved or embedded in. Changes prep, interference, recovery, and
  therefore the number. *In scope for this column.*
- **Presentation / dosage form** — powder, solution, tablet, capsule. Overlaps matrix but is not it.
- **Container** — vial, ampoule, pre-filled syringe. Changes handling, never the number. *Never in
  this table.*

Test: **if it changes the result it is a matrix; if it only changes handling it is a container.** A
tablet is a matrix (an excipient bed is in the measurement path). A pre-filled syringe is a container
— though an *oil-based* suspension is a different matrix from an aqueous one, because of the oil.

Two hard rules:

1. **Resolution is NULL-first in practice.** Today the entire live requirement is two values
   (`Peptide`, with `Peptide Blend` normalising into it, and `Bacteriostatic Water`). A NULL-matrix
   spec covers everything, which is what all five native services want. Per-matrix rows are the rare
   override.
2. **A customer-declared matrix must never key resolution directly.** Because resolution is
   fail-closed, a customer picking a synonym the lab never filed a spec under **refuses the whole
   certificate** rather than mis-verdicting. If a customer-facing matrix field is ever added (a WP →
   IS → Mk1 wire change belonging to [[project_mk1_commercial_layer_program]], explicitly **out of
   scope here**), it must reach this resolver through a **lab-owned mapping** from declared value to
   spec matrix, so a human can correct a bad guess.

Note the survey of a competitor intake list (Powder / Liquid-Solution / Lyophilized / Capsule-Tablet /
Raw Material / BAC Water / Other) mixes physical state, process, dosage form, supply-chain role, and a
specific product. `Powder` and `Lyophilized` fully overlap; `Raw Material` is not a matrix at all.
Cited as evidence that intake vocabularies are *not* safe resolution keys, not as a model to copy.

### Why matrix scoping stays narrow

Per-matrix limits only matter for **generic services shared across products** (pH, fill volume,
endotoxin). Peptide-specific services carry their method in the service itself. And a genuinely new
matrix (tablets) would almost certainly need a different method — i.e. a *new Analysis Service* with
its own spec, not a matrix override on an existing one.

## Resolution and verdict

### Resolver

`resolve_spec(db, service_id, matrix) -> ResolvedSpec | None`, in a new `backend/coa/spec_rules.py`:

1. Exact active row for `(service_id, matrix)`.
2. Else the active row for `(service_id, NULL)`.
3. Else `None`.

Matrix normalisation mirrors COABuilder exactly — `Peptide Blend` → `Peptide`
(`coabuilder/src/coabuilder_core/logic.py:5`, imported by `native_sections.py:20`) — and this parity
gets its own test, because a divergence here silently changes which spec resolves.

### Verdict

`evaluate(spec, result_value) -> Verdict`, pure and side-effect free:

- `equals` — case-insensitive, whitespace-trimmed string equality.
- `range` — parse to a number; fail closed if unparseable.
- **`min`/`max` bounds are INCLUSIVE**, matching the current implementation
  (`native_sections.py:44-47` fails only on `value < min` / `value > max`).

Two defects in the current implementation are fixed rather than ported:

1. **NaN false-pass (real bug).** `float("nan")` parses successfully, and `nan < min` / `nan > max`
   are both `False`, so a result of `"nan"` currently returns **Conforms**. The new evaluator rejects
   non-finite values fail-closed.
2. **Asymmetric failure between rule kinds.** Today an unparseable numeric *aborts* the COA while a
   non-matching `equals` string *silently prints a failure*. That asymmetry is exactly what made the
   USP<71> bug print a wrong certificate instead of erroring. Both kinds now behave the same: a
   verdict is only emitted when the rule can actually be applied; anything else is fail-closed.

### Fail-closed placement

`build_native_sections` (`backend/coa/native_sections.py`) gains one abort rule alongside its existing
ones: **a member service with no resolvable active spec aborts the section build**, in the same
`NativeSectionsError` style as current rules A1–A4. This moves the check to where the data lives and
keeps the existing 502 / `success:false` semantics on all four call paths.

An `informational` escape hatch is deliberately **out of scope**: COABuilder's
`INFORMATIONAL_KEYWORDS` is `set()` today and nothing populates it. Do not port a dead mechanism.

## Wire contract

Mk1 fills the two fields it already sends. Per row, `specification` becomes structured rather than a
prose string:

```json
{
  "keyword": "STERILITY_USP71",
  "name": "Sterility USP<71>",
  "result": "Not Detected",
  "unit": "Pos/Neg",
  "method": "",
  "specification": {
    "rule_kind": "equals",
    "equals": "Not Detected",
    "min": null, "max": null,
    "unit": "Pos/Neg",
    "display": null
  },
  "conforms": true
}
```

**Structured, not a prose string, on purpose.** Spec 2 deliberately kept limit formatting
(`"≤ 0.5 ppm"`, en-dashes, `≥`/`≤` glyphs) in COABuilder as presentation. Sending `{min, max, unit}`
preserves that boundary; `display` is an optional lab override for cases the formatter cannot express.

COABuilder's `attach_native_sections` changes to:

- **`specification` is a dict** → trust it. Format the display string, evaluate nothing, use the
  wire `conforms`.
- **`specification` is `None`** → current behaviour: `lookup_spec` + `_verdict` from `BAKED_SPECS`.

That fallback is what makes the deploy order safe in both directions, and it is the only change to
that file in this slice.

## Auditability — a required, not optional, part of this slice

Moving specs from a git-versioned Python literal into an admin-editable row is **on its own a
regression in auditability**, against an ISO 17025 alignment posture
([[project_iso17025_alignment]]). Today a limit change is a commit; afterwards it is an `UPDATE`.

Two mitigations ship here:

1. **Applied-rule record.** COABuilder carries the wire `specification` dict onto the enriched row
   as a `rule` key, and the enriched sections are what the Integration Service persists per
   generation in `coa_generations.coa_data` — so every generated certificate carries the
   machine-readable rule it was judged against alongside the formatted display string. (Enrichment
   replaces `specification` itself with the display string before persistence; without the `rule`
   key the persisted record stays prose-only — the slice-1 review caught that an earlier draft
   wrongly assumed the raw wire dict survived on its own.)
2. **Spec-change audit rows.** Every write to `analysis_service_specs` writes an `AuditLog` row
   (`operation='analysis_service_spec_changed'`) with before/after values and actor. The table has an
   `updated_by_id`; changes are appended, and rows are deactivated rather than deleted.

**Explicitly NOT in this slice:** the versioned publish-time snapshot with reproducible re-render.
Verified 2026-08-02: nothing of the kind exists anywhere today — no `spec_version`, no
`validated_against`, no freeze mechanism, and `date_published` is `datetime.now()` at engine-run time,
so a regeneration already silently re-dates a certificate. That is greenfield work and its own spec
([[architecture_published_coa_snapshot_retest]] is the related requirement).

## Seeding

Seed the five current native specs to **parity with `BAKED_SPECS`**, all with `matrix = NULL`:

| Service keyword | rule | value | unit |
|---|---|---|---|
| `HM-PB` | range | max 0.5 | ppm |
| `HM-AS` | range | max 1.5 | ppm |
| `HM-CD` | range | max 0.5 | ppm |
| `HM-HG` | range | max 1.5 | ppm |
| `STERILITY_USP71` | equals | `Not Detected` | **NULL** |

`STERILITY_USP71`'s spec unit is NULL on purpose: `BAKED_SPECS` carries no `unit` key for it, so
seeding one would not be parity and would newly arm the unit-divergence comparison against the
service's `Pos/Neg`. The row's own `unit` field is unaffected and still ships `Pos/Neg`. (Whether
`Pos/Neg` should print in the Unit column at all for a qualitative test is a separate display question
— the legacy `STER-PCR` add-on row hardcodes a blank unit. Out of scope; flagged for the lab.)

`display_override` is NULL for all five: the formatter yields `≤ 0.5 ppm` from `{max: 0.5, unit: ppm}`
and `Not Detected` from the `equals` value, matching today's `display` strings exactly.

Idempotent, keyed on `(analysis_service_id, matrix IS NULL)`, resolving the service **by keyword at
seed time only** (the stored row holds the FK). Skip silently when the service does not exist — a
fresh DB may not have the native services.

`matrix = NULL` **fixes the Bacteriostatic Water gap for free**: every baked native spec is keyed
`("Peptide", …)` today, so a native section on a BW sample resolves nothing and **422s the entire
certificate**. Whether USP<71> and heavy metals are sellable on BW remains a product question, but the
NULL default means the answer no longer has to be encoded before it is asked.

`TEST_TECHNIQUES` (the `test_type` display label, e.g. `"USP <71>"`) is **not** part of this slice —
it is a display concern with no verdict role. Note as a follow-up candidate for
`analysis_services.category`.

## Parity gate (the load-bearing verification)

The migration is only safe if the new engine agrees with the old one. A shadow-compare test asserts
that for every native keyword and a table of representative results — in-range, out-of-range, exactly
on each bound, unparseable, empty, wrong-case `equals`, matching `equals` — `evaluate()` returns the
same verdict as COABuilder's `_verdict()` did.

The **inclusive-bound and case-insensitivity cases are the ones most likely to drift**, and NaN is the
one case where the answer must deliberately *differ* (old: Conforms; new: fail-closed). That
divergence is asserted explicitly so it can never be mistaken for a regression.

## Slices

1. **Core (this spec).** Table + DDL, `spec_rules.py` resolver/evaluator, `build_native_sections`
   fills the fields + new abort rule, COABuilder prefers-wire-else-baked, seed to parity, audit rows,
   parity gate.
2. **Admin spec editor** on the Analysis Services page. Without it this is not self-service; it does
   not block slice 1. Must surface `result_options` and the `equals` value **on the same screen** —
   that adjacency is the point of the whole migration.
3. **Delete the five native rows from `BAKED_SPECS`** and the fallback branch, once slice 1 has lived
   in production. Separate by design: the fallback is the rollback path.
4. **Publish-time snapshot** — own spec, greenfield.

## Rollout and rollback

- Additive only ([[feedback_additive_only]]). New table, new module, two touched functions.
- **Deploy order is COABuilder → Mk1** — belt-and-braces, NOT load-bearing. Verified against
  `64e5981` during the slice-1 final review: old COABuilder unconditionally overwrites an incoming
  `specification` from the baked lookup (`{**row, "specification": spec.get("display", "")}`) and
  re-verdicts via `_verdict`, so a dict arriving early is discarded and the certificate degrades to
  today's baked behaviour — not the garbage-prose cell an earlier draft of this spec claimed. Ship
  COABuilder first anyway; it costs nothing inside the one combined window.
- **Rollback = deactivate the seeded spec rows.** Resolution then finds nothing… which now *aborts*.
  So the real rollback is reverting the Mk1 image (COABuilder's baked fallback is still present until
  slice 3). State this in the deploy runbook.
- Rehearse on an isolated devbox stack ([[project_active_focus_accumark_stack]]), never the live host.
  `s3rehe` already carries USP<71> + heavy metals with verified parent-tier results and is the natural
  rehearsal target: regenerate P-0141 and diff the certificate against `AH5F-2QSD`.
- Attaches to the ONE combined deploy window with the rest of the program; no independent deploy.

## Risks

| Risk | Mitigation |
|---|---|
| New engine disagrees with old → wrong verdict on a real certificate | Parity gate above; rehearse by regenerating P-0141 and diffing against `AH5F-2QSD` |
| Matrix normalisation drifts from COABuilder's | Dedicated parity test on the `Peptide Blend` → `Peptide` rule |
| Admin edits a limit with no trace | Audit rows + applied-rule record in `coa_data` (both in this slice) |
| A lab admin deactivates a spec and silently breaks certificate generation | Fail-closed abort names the service and matrix; deactivation warns when the service has any parent-tier result |
| Unit divergence between spec and result | Current behaviour is warn-and-render, which can produce a confidently wrong verdict (ppm vs ppb). Preserved as-is in this slice; **flagged as a follow-up**, since tightening it is a production-behaviour change needing sign-off |
| Scope creep into the peptide engine | Table above is the contract: `conformance.py` and `generic_assay_engine.py` are untouched |

## Open questions

1. **Is USP<71> (and heavy metals) sellable on Bacteriostatic Water?** Product question. `matrix=NULL`
   makes it work either way; an explicit answer would let the lab file a BW-specific limit if the
   numbers differ.
2. **Should unit divergence become fail-closed?** Production-behaviour change → needs sign-off. Listed
   as a follow-up, not built here.
3. **Customer-facing sample-matrix field** — deferred to
   [[project_mk1_commercial_layer_program]]; if built, it reaches this resolver only through a
   lab-owned mapping, never directly.
