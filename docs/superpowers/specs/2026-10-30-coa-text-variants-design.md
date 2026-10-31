# COA Text Variants per Sample Form: Design

**Date:** 2026-10-30
**Status:** Draft, awaiting Handler approval
**Repos:** Accu-Mk1 only (no COA Builder, Integration Service or WordPress change)

## Why

Each analysis profile carries one set of certificate text: section title, basis note, method, prep and footnotes (`analysis_profiles.coa_*`, backend/models.py:567-580). For heavy metals that text describes the powder workflow: a USP<232> Parenteral PDE basis, an assumed MDD of 25 mg/day, and hot block acid digestion.

Sample Forms (1.55.0) added nasal spray samples. Their heavy metals rows are report-only form rules (four active Nasal Spray rows on prod). Josh says the inhalants "are prepped differently. They require a lower dilution and do not undergo digestion." So on a nasal certificate, the powder prep line, basis note and MDD footnotes are wrong.

1.55.0 only partly covers this. When every row in a section is a form report-only row, the basis note is hidden (backend/coa/native_sections.py:494-496 and 519). Prep, method and footnotes still print, and the rule can only hide text. It cannot print other text.

On 2026-10-30 Josh worked around it by editing the shared profile. `catalog_change_log` on prod, user 9:

| UTC | Change |
|---|---|
| 16:16:12 | prep text cleared |
| 19:00:30 | basis note and footnotes cleared |
| 19:02 to 19:07 | four nasal COAs published (PB-1084 g7, PB-1083 g6, PB-1082 g6, P-5401 g4) |
| 19:09:59 | basis note and footnotes restored exactly; prep set to new wording ("...followed by 1:100 fold dilution", where it used to say "...of 100 mg of sample... diluted to 10 mL") |

No other heavy metals COA was built in that window, so nothing went out wrong. But the workaround changes text for every sample while it is in place. It also leaves a trap: regenerating any of the four nasal COAs, or adding a COA to one, prints the powder footnotes and the powder prep line again.

## What we're building

Alternate certificate text per sample form, managed on the analysis profile. Spec rules already work this way: a service has a default rule and can have a rule for one form.

The profile's current text becomes its **Default**. The lab adds a **variant** for a sample form (Nasal Spray) and sets each field to one of three choices:

- **Same as default:** prints whatever the default says, including later edits to it.
- **Custom:** prints this variant's text.
- **Leave off:** prints nothing for that field.

When a sample of that form gets a COA, the variant applies. A sample of any other form, or with no form, prints the default exactly as today.

## Goals

- Nasal spray heavy metals COAs print the nasal prep text, with no powder basis note or MDD footnotes, without touching the default.
- The lab manages variants in the Mk1 profile editor. A text change needs no deploy.
- Variant edits are audited like every other catalog edit.
- Generating, regenerating or reissuing a COA picks up the variant with no extra step.

## Non-goals (for now)

- Variants keyed by anything other than sample form (peptide, matrix, client). Spec tiers were added one at a time, and this can grow the same way.
- Taking a field's text from the method record. That comes later, once results reliably carry the right method. Today the prep wizard stamps `peptide.methods[0]` (see the 10-30 method linkage audit).
- Varying archetype, sort order or section membership per form.
- Any change to COA Builder, IS or WP. The wire document keeps its exact shape.
- Bulk regeneration of COAs already published.
- Per-vial forms. The form stays on the sample (`lims_samples.sample_form_id`).

## Anti-goals

- **A certificate printing text meant for another form.** The variant must be picked by exactly the same form the spec resolver uses, so a section's text and its limits can never disagree.
- **A blank box that silently means "same as default" when the user meant "leave off".** Today the profile editor saves `trim() || null` (src/components/hplc/AnalysisProfilesPage.tsx:360-363 and 386-389), so blank and unset collapse into one value. Variants need an explicit three-way choice per field.
- **Lost history.** Variants are switched off, never deleted, and every write is logged.
- **A macro typo on a certificate.** Variant text goes through the same validators as profile text.
- **Any change for a profile with no variants.** Its sections must come out byte for byte the same as today.

## Constraints

- **Additive only:** one new table, three new routes, one lookup in the section builder and one new editor block. Profile columns and profile routes are untouched.
- Mk1 frontend stays on npm.
- Backend suites run in a stack container, never against the host dev Postgres.
- Deploy after lab hours.

## Decided

### Data

New table `analysis_profile_coa_variants`, with its model in backend/models.py next to `AnalysisProfile`. Create it the way the Sample Forms release created `lims_sample_forms`: idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` statements in backend/database.py (the pattern at 2230-2285).

| Column | Type | Meaning |
|---|---|---|
| `id` | int PK | |
| `analysis_profile_id` | int, FK `analysis_profiles.id` ON DELETE CASCADE, NOT NULL | owning profile |
| `sample_form_id` | int, FK `lims_sample_forms.id`, NOT NULL | the form it applies to |
| `coa_section_title` | varchar(200) NULL | NULL = same as default. Two states only: a section always has a title. |
| `coa_basis_note` | varchar(200) NULL | NULL = same as default, `''` = leave off, text = custom |
| `coa_method_text` | text NULL | same three states |
| `coa_prep_text` | text NULL | same three states |
| `coa_footnotes` | jsonb NULL | NULL = same as default, `[]` = none, list of `{label, text}` = custom |
| `active` | bool NOT NULL default true | |
| `created_at`, `updated_at`, `updated_by_id` | as on `analysis_service_specs` | |

- One active variant per profile and form: a partial unique index on `(analysis_profile_id, sample_form_id) WHERE active`. This is the pattern of `uq_analysis_service_specs_form_unit` (models.py:303-309).
- Column names and lengths match the profile's, so the existing validators apply unchanged.
- Naming: catalog tables use the `analysis_` prefix (`analysis_service_specs`). The `lims_` prefix is for LIMS sample-side tables.

### Which text prints

In `build_native_sections` (backend/coa/native_sections.py), reuse the `sample_form_id` the spec tier already settled at lines 366-368, including the guard that drops it for a non-Peptide matrix. Load the active variants for that form and this document's profiles in one query, keyed by profile id. With no form, there is no variant.

For each section (the dict built at 514-529), each field resolves as follows:

| Variant value | What goes on the wire |
|---|---|
| no variant, or NULL (same as default) | today's expression, unchanged, including the 1.55.0 basis note hide at 519 |
| custom text | `resolve(variant_text, values)`; footnotes via `_section_footnotes(variant_list, values)`, so `{lod}` and `[ ]` work |
| `''` (leave off) | `None` |
| `[]` (no footnotes) | `[]` |

- A custom or leave-off basis note overrides the 1.55.0 hide, because the lab chose that text for this form on purpose. "Same as default" falls through to the default, and the hide still applies.
- Title is `variant title or coa_section_title or name`.
- `None` and `[]` are the exact values Josh's blanking produced on prod (basis note and footnotes were set to NULL), and those COAs published normally. COA Builder treats empty values as absent in both outputs:
  - PDF basis note: src/coabuilder_core/generator.py:1001
  - PDF footnotes: generator.py:1070
  - PDF method and prep line: src/coabuilder_core/native_sections.py:337-340
  - Digital payload: native_sections.py:440-443
- `build_native_sections` has two callers, the parent document and the per-vial certificate (backend/coa/wire_document.py:29 and 51). Both get variants. Vials are judged by their parent's form (native_sections.py:364-365), and so is their text.
- No new wire key. The published COA's stored document already records the text that printed.

### API

These routes mirror the spec routes (main.py:4773-4870).

- `GET /analysis-profiles/{profile_id}/coa-variants` returns the profile's active variants, each with `sample_form_name`.
- `POST /analysis-profiles/{profile_id}/coa-variants` takes `{sample_form_id, coa_section_title?, coa_basis_note?, coa_method_text?, coa_prep_text?, coa_footnotes?}`. Responses:
  - 404: unknown profile.
  - 400: unknown or missing form.
  - 409 when an active variant already exists for that form: "an active variant already exists for this form; deactivate it first". This is the `create_service_spec` pattern (main.py:4816-4820).
- `PATCH /analysis-profile-coa-variants/{variant_id}` edits the `coa_*` fields and `active`.
  - It uses `exclude_unset`: an omitted field is unchanged, and an explicit null means "back to same as default".
  - Profile and form cannot change. To move a variant to another form, switch it off and add a new one.
- There is no DELETE.

**Validation.** Reuse `_validate_coa_footnotes` and `_validate_coa_text_macros` (main.py:21727-21767) as they are, passing the same `coa_*` key names. Both already accept `''` and `[]`. A `coa_section_title` of `''` returns 400.

**Audit.** Use `catalog/change_log.py` with `entity_type="profile_coa_variant"`, as its docstring requires for catalog admin writes:
- On create, `log_create` after flush.
- On PATCH, `apply_and_log`, which also covers switching a variant off, since `active` is a field.
- Do not use `record_spec_change`, which is the spec table's own audit trail.

**Auth.** The same as the profile routes.

### Profile editor

The changes go in the COA display block of the profile slide-out panel (AnalysisProfilesPage.tsx, from line 1107).

- The existing fields get a **Default** heading. Their behavior does not change.
- Below them is a **Variants by sample form** list.
  - Each row shows the form with its icon (`SampleFormIcon`) and a one-line summary of what differs, for example "Prep: custom · Basis: left off · Footnotes: none".
  - Each row has Edit and Switch off.
- **Add variant** asks for a form first (`SampleFormSelect`, leaving out forms that already have an active variant). Then each field gets a three-way control: Same as default / Custom / Leave off.
  - Custom opens the input, prefilled with the default's text so the lab edits rather than retypes.
  - Custom footnotes reuse the existing footnote list editor (the helpers at 460-484).
  - Title offers Same as default / Custom only.
- A variant saves on its own (its own POST or PATCH), apart from the profile's Save, the way `ServiceSpecsSection` saves spec rows.
- The macro hint at line 1112 applies to variant fields too.
- Variants can be set up before the profile is armed (`coa_archetype` NULL). Like the default text, they do nothing until then.

### Rollout

1. Ship Mk1 only, after lab hours. No COA Builder, IS or WP release.
2. Josh adds the Heavy Metals / Nasal Spray variant with:
   - his nasal prep wording
   - basis note: Leave off
   - footnotes: none
   - method: Same as default, or Custom if the nasal method line differs
   - No seed data: the text is Josh's.
3. Build one nasal sample's sections read-only on prod (build in a transaction that is rolled back, nothing generated) and confirm the text before anyone regenerates a nasal COA.
4. The four 10-30 nasal COAs are correct as published. They can be regenerated safely only after step 3.

### Tests

Backend, in a stack container:
- A profile with no variants gives sections identical to today (regression).
- A variant for form X on a sample of form X prints its custom text, with macros filled.
- Default text prints for each of these:
  - a sample of another form
  - a sample with no form
  - a non-Peptide matrix that has a form set
  - an inactive variant
- Leave off gives `None` / `[]` on the wire.
- "Same as default" keeps the 1.55.0 basis note hide. A custom basis note overrides it.
- A per-vial certificate uses the parent's form.
- A second active variant for the same profile and form returns 409. After switching the first off, the create succeeds.
- An unknown macro returns 400, and so does a macro in a footnote label. `[]` footnotes are accepted.
- Audit rows:
  - create writes `action="create"`
  - PATCH writes `action="update"` with the changed fields
  - a PATCH that changes nothing writes no row

Frontend:
- Each three-way control maps correctly: Same as default → `null`, Leave off → `''` (footnotes `[]`), Custom → text.
- Custom with empty or whitespace-only text blocks Save.

## My calls (Handler to confirm)

- Variants key on sample form only for now.
- A custom or leave-off basis note overrides the 1.55.0 hide.
- Custom prefills with the default's text.
- Variants save on their own, not with the profile's Save.
- Switched-off variants are not listed in the editor. They stay in the table and the change log.
- A variant whose form is later deactivated keeps working for samples that already have that form.
- No new wire key records which variant printed.

## Left to the builder

- Component split: a `ProfileCoaVariantsSection` next to `ServiceSpecsSection` is reasonable, since AnalysisProfilesPage.tsx is already large.
- Pydantic model names and response shape details.
- Ordering of the variants list (form sort order is a sensible default).

## Known limits

- Forms are per sample. If one submission ever holds vials of different forms, a section built from several vials will need a rule for which variant prints.
- Adding "from the method" later turns the three-way control into four. That needs method linkage fixed first.
