# COA Text Variants per Sample Form: Design

**Date:** 2026-10-30
**Status:** Approved by the Handler 2026-11-02. Plan: [2026-11-02-coa-text-variants.md](../plans/2026-11-02-coa-text-variants.md)
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
- The flow and the overrides are obvious in the editor: which text prints for a form, where it came from, and why any of it is being held back (Handler, 2026-10-30).

## Non-goals (for now)

- Variants keyed by anything other than sample form (peptide, matrix, client). Spec tiers were added one at a time, and this can grow the same way.
- Taking a field's text from the method record. That comes later, once results reliably carry the right method. Today the prep wizard stamps `peptide.methods[0]` (see the 10-30 method linkage audit).
- Varying archetype, sort order or section membership per form.
- Any change to COA Builder, IS or WP. The wire document keeps its exact shape.
- Bulk regeneration of COAs already published.
- Per-vial forms. The form stays on the sample (`lims_samples.sample_form_id`).

## Anti-goals

- **A certificate printing text meant for another form.** The variant must be picked by exactly the same form the spec resolver uses.
- **A certificate that judges against powder limits without the powder disclosure.** The resolver falls back to the matrix or wildcard row for any service that has no row for the sample's form (backend/coa/spec_rules.py:139-168), and a peptide-tier row beats a form row. A variant must not strip the basis note or footnotes from a section whose limits did not come from that form's rules (see "Limits guard" below).
- **A blank box that silently means "same as default" when the user meant "leave off".** Today the profile editor saves `trim() || null` (src/components/hplc/AnalysisProfilesPage.tsx:360-363 and 386-389), so blank and unset collapse into one value. Variants need an explicit three-way choice per field.
- **Lost history.** Variants are switched off, never deleted, and every write is logged.
- **A macro typo on a certificate.** Variant text goes through the same validators as profile text.
- **Any change for a profile with no variants.** Its sections must come out byte for byte the same as today.

## Constraints

- **Additive only:** one new table, three new routes, one lookup in the section builder and one new editor block. Profile columns are untouched. The only profile route change is that profile delete logs the variants it removes (see Data).
- Mk1 frontend stays on npm.
- Backend suites run in a stack container, never against the host dev Postgres.
- Deploy after lab hours.

## Decided

### Data

New table `analysis_profile_coa_variants`, with its model in backend/models.py next to `AnalysisProfile`. `create_all` builds the table and its declared indexes on the next boot, which is how Mk1 makes a new table. (Changed while planning, 2026-11-02. This doc first called for raw `CREATE TABLE` statements like `lims_sample_forms`, but those exist because later `ALTER`s needed that table before `create_all` runs. Nothing depends on this one, and `_run_migrations` runs first, so raw DDL would only duplicate the model and log a skipped migration on a fresh database.)

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
- Profile delete: `DELETE /analysis-profiles/{id}` (main.py:21988) hard-deletes a profile with no custody history, and the CASCADE takes its variants with it. That route writes a `log_delete` row (`entity_type="profile_coa_variant"`) for each of the profile's variants, active or not, before the delete, so no variant disappears unlogged. My call: RESTRICT would turn this into an opaque 500, the failure the custody guard's comment there warns about.
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
- `None` and `[]` are the exact values Josh's blanking produced on prod (basis note and footnotes were set to NULL), and those COAs published normally. COA Builder treats empty values as absent in both outputs. Line numbers are from coab master 2fba4f5 (2.35.6, the prod release); the workspace `coabuilder` checkout is older and has no native_sections.py.
  - PDF basis note: src/coabuilder_core/generator.py:1001
  - PDF footnotes: generator.py:1070
  - PDF method and prep line: src/coabuilder_core/native_sections.py:337-340
  - Digital payload: native_sections.py:440-443
- `build_native_sections` has two callers, the parent document and the per-vial certificate (backend/coa/wire_document.py:29 and 51). Both get variants. Vials are judged by their parent's form (native_sections.py:364-365), and so is their text.
- No new wire key. The published COA's stored document already records the text that printed.

### Limits guard (Handler kept it, 2026-10-30)

Basis note and footnotes describe the limits; title, method and prep describe what the lab did to the sample. So the variant applies differently to the two groups:

- **Title, method, prep:** follow the variant whenever the sample has that form.
- **Basis note, footnotes:** follow the variant only when every printed row in the section was judged by a spec row filed for this sample's form (`spec.sample_form_id == sample_form_id`, tracked in the row loop next to `all_form_report_only` at 494-496).
  - Otherwise these two fields use the default, with today's 1.55.0 hide.
  - The builder logs `native_section_variant_limits_guard sample=... profile=...` so the fallback is visible.

This keeps the powder disclosure on any section still judged by powder rows, for example a metal with no Nasal Spray rule, or a peptide-tier override. It still lets nasal prep text print on that section. Heavy metals does not trip the guard today: all four metals have Nasal Spray rules.

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

The Handler approved this layout from a clickable mockup on 2026-11-02: [2026-10-30-coa-text-variants-mockup.html](2026-10-30-coa-text-variants-mockup.html). Its nasal prep and footnote text are placeholders. Where the mockup and this section differ, this section wins.

The test for every choice below: someone opening the panel can see which text prints for a form, and why, without being told. On screen the word is "version". "Variant" is only for code and schema.

**Where it lives.** A new section, "COA text by sample form", in the profile slide-out panel (src/components/hplc/AnalysisProfilesPage.tsx). It goes after the Save Changes button (1367-1373) and before Members (1376), in edit mode only. Members and Ride Hosts already sit there with their own Save buttons. Its intro line: "Every sample prints the Default text above. A form listed here prints its own version instead, field by field."

**The Default fields.** They behave as they do today. The COA display block (1111) gets a "Default text" heading. When the profile has versions, it also gets one line per form that overrides something, for example "Nasal Spray overrides prep, basis note and footnotes", so whoever edits the Default sees which forms do not follow it.

**The list.** One card per active version.
- Closed, a card shows the form's icon and name, a summary, and Edit. The summary reads "Overrides: basis note left off, prep custom", or "Same as default (no changes yet)".
- Edit opens the editor in place. One card is open at a time. Opening another card, or Add form, keeps the first card's edits. Only Cancel drops them.
- A card with unsaved edits shows an "Unsaved" tag, open or closed.

**Add form.** The button opens a form picker that copies the inline `Select` in ServiceSpecsSection.tsx:438-460 (`listSampleForms` + `SampleFormIcon`), listing active forms that have no active version. Do not use `SampleFormSelect`: it PATCHes one sample's form. Picking a form opens a new card with every field on Same as default. Nothing is written until Save.

**The editor.** From top to bottom: the guard line, the macro hint (the text at line 1112), five field rows, the preview, the buttons.

| Field | Choices | Label |
|---|---|---|
| Section title | Same as default, Custom | |
| Basis note | Same as default, Custom, Leave off | "describes the limits" |
| Method | Same as default, Custom, Leave off | |
| Sample prep | Same as default, Custom, Leave off | |
| Footnotes | Same as default, Custom, Leave off | "describes the limits" |

The choice is a `ToggleGroup type="single"` (src/components/ui/toggle-group.tsx). Radix sends an empty value when the active item is clicked again: ignore it, so a field always has a choice. Each choice shows what it means right under the control:

- **Same as default:** the Default's text, grayed, tagged "Default". The title falls back to the profile name, as it does on the wire. A blank Default says "The Default is blank, so nothing prints".
- **Custom:** the input, prefilled with the Default's text so the lab edits rather than retypes. Footnotes use the footnote list editor. Today that is inline markup driven by the helpers at 460-486. Pull it out into a small component that both the Default and the version editor use, with no change to the Default's behavior.
- **Leave off:** "Not printed on Nasal Spray COAs".

Inherited and prefilled text come from the saved profile (`editingProfile`), not from unsaved typing in the Default boxes, because only saved text prints. After a successful Save Changes, point `editingProfile` at the refreshed row before `closePanel` runs, so cancelling the unsaved-edits prompt does not leave the cards showing the old Default. Text typed under Custom survives switching to another choice and back while the editor stays open.

**The guard line.** It shows only while Basis note or Footnotes is on something other than Same as default, because the guard changes nothing otherwise. It reads the rules of the profile's saved members, as last loaded or saved by Save Members. It does not use `selectedOrder`, which also holds unsaved Members edits. There is one `listServiceSpecs` call per member via `useQueries`, only while an editor is open. That route returns active rows only, with `sample_form_id` and `peptide_id`. A member "has a rule" when one of its rows has `sample_form_id` equal to this form and no `peptide_id`.

| State | Line |
|---|---|
| Loading | "Checking the Nasal Spray rules..." |
| Any call failed, or the profile has no members | "Could not confirm the Nasal Spray rules." Never green. |
| Every member has a rule (green) | "All 4 services have a Nasal Spray rule, so this version's basis note and footnotes print." |
| A member has none (amber) | "Arsenic has no Nasal Spray rule, so it is judged on its general limits. A Nasal Spray COA that includes it keeps the Default basis note and footnotes. Title, method and prep still use this version." Each name links to its rules with `navigateToAnalysisService` (src/store/ui-store.ts), labeled "Add the rule". |

- When a member has an active peptide rule, either line adds: "A peptide-specific rule also keeps the Default basis note and footnotes." The editor cannot resolve this per sample.
- In the amber state, Basis note and Footnotes (when overridden) also say "Held: the Default prints on a COA that includes Arsenic".
- This line is advice. A COA prints only the rows on that sample, so the line can warn about a service a given sample does not have. The builder's check on printed rows (Limits guard, above) decides what prints.

**The preview.** Caption: "What prints on a Nasal Spray COA". It is built in the browser from the editor's current state, so it shows what Save would do. It shows the title and basis note, the saved members as rows with a dash for the result, the method and prep line, and the footnotes.
- Every piece carries a tag: "Default", "Nasal Spray", or "Default, held". A missing piece says so: "no basis note", "no footnotes".
- It assumes every member is on the COA. Its held state matches the guard line.
- A basis note on Same as default follows the 1.55.0 hide. When every member's rule for this form has `rule_kind == "informational"`, the preview says "no basis note" and tags it "Default, hidden: every row is report only". Without this, the preview would show a basis note that the COA leaves off.
- `{lod}` and `[ ]` print as typed, with the note "{lod} fills in from each sample's results". The preview makes no backend call and does not try to match the PDF layout.

**The buttons.**
- **Save Nasal Spray text:** POST or PATCH, disabled until something changed. The PATCH sends all five `coa_*` fields, with `null` for Same as default. Custom with blank text blocks Save with "Type the text, or choose Leave off" (for the title: "Type the title, or choose Same as default"). Custom footnotes with no filled-in rows block it the same way, because cleaning them would produce `[]`, which means Leave off.
- **Cancel:** drops the edits and closes the card.
- **Stop using this version** (existing versions only): `window.confirm`, the page's pattern at line 405, with "Stop using the Nasal Spray version? Nasal Spray COAs go back to the Default text. Published COAs stay as they are until they are regenerated." Then PATCH `active: false`. Adding that form again starts on Same as default. The old text stays in the change log.

**Unsaved edits.** Save Changes closes the panel (line 396), so it would silently drop an open version's edits. `closePanel` and the "Add the rule" links ask first through `window.confirm` when a version has unsaved edits.

Variants can be set up before the profile is armed (`coa_archetype` NULL). Like the default text, they do nothing until then.

### Rollout

1. Before building: confirm with Josh that the default prep he set at 19:09:59 on 10-30 is the wording he wants for powder. It prints on every powder heavy metals COA now. If it is not, correct the default first (a normal profile edit, logged).
2. Ship Mk1 only, after lab hours. No COA Builder, IS or WP release.
3. Josh adds the Heavy Metals / Nasal Spray variant with:
   - his nasal prep wording
   - basis note: Leave off
   - footnotes: Leave off
   - method: Same as default, or Custom if the nasal method line differs
   - No seed data: the text is Josh's.
4. Build one nasal sample's and one powder sample's sections read-only on prod (in a transaction that is rolled back, nothing generated). Confirm the nasal one prints the variant and the powder one prints the default, before anyone regenerates a nasal COA.
5. The four 10-30 nasal COAs are correct as published. They can be regenerated safely only after step 4.

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
- Limits guard, a section where one row is judged by a matrix or wildcard row (no form rule for that service): the variant's prep prints, but its leave-off basis note and footnotes do not, so the default prints, and the guard log line fires.
- Limits guard, a peptide-tier row in the section: same fallback.
- Deleting a profile that has variants writes one `log_delete` row per variant.
- A second active variant for the same profile and form returns 409. After switching the first off, the create succeeds.
- An unknown macro returns 400, and so does a macro in a footnote label. `[]` footnotes are accepted.
- Audit rows:
  - create writes `action="create"`
  - PATCH writes `action="update"` with the changed fields
  - a PATCH that changes nothing writes no row

Frontend:
- Each three-way control maps correctly: Same as default → `null`, Leave off → `''` (footnotes `[]`), Custom → text.
- Clicking the active choice again keeps it.
- Custom with empty or whitespace-only text blocks Save, with its message. So do Custom footnotes with no filled-in rows.
- Opening another card keeps the first card's edits and its "Unsaved" tag.
- Guard line:
  - green only when every call succeeded and every saved member has a rule for this form
  - a failed call or no members is never green
  - an unsaved Members edit does not change it
  - hidden while Basis note and Footnotes are both Same as default
  - amber names the service and marks the overridden limit fields "Held"
- Preview:
  - tags follow the choice: Default, the form's name, or "Default, held"
  - a basis note on Same as default shows as hidden when every member's rule for this form is `informational`
- Closing the panel with unsaved version edits asks first. Cancelling that keeps the panel and the edits. After Save Changes, the cards show the new Default.

## My calls (Handler to confirm)

- Variants key on sample form only for now.
- A custom or leave-off basis note overrides the 1.55.0 hide.
- Custom prefills with the default's text.
- Variants save on their own, not with the profile's Save.
- Switched-off variants are not listed in the editor. They stay in the table and the change log.
- A variant whose form is later deactivated keeps working for samples that already have that form.
- No new wire key records which variant printed.
- Profile delete keeps CASCADE and logs each variant it removes.
- The footnote list editor is pulled out into a shared component.
- The section sits under Save Changes and above Members.
- One card is open at a time. A new form writes nothing until Save.
- The form picker lists active forms only.
- The guard line shows only while Basis note or Footnotes is overridden. The peptide sentence shows only when a member has an active peptide rule.
- The preview is built in the browser and is not a real render. Macros print as typed.
- Closing the panel with unsaved version edits asks first. This is new behavior: the panel has no such check for its other sections, and Save Changes closes it.

Added while planning, 2026-11-02:

- The table comes from `create_all`, with no raw DDL (see Data).
- The guard log line fires only when a basis note or footnotes override was actually held back.
- The routes also refuse whitespace-only text (400) and a title or basis note over 200 characters (422), and the inputs cap at 200. Neither would otherwise be caught before Postgres or the certificate.
- While the rules are loading or could not be confirmed, the preview shows the choice as set. The guard line carries the warning.
- A successful Save closes the card.
- The panel's close button gets an accessible name, "Close panel".

## Open for the Handler

- ~~Limits guard~~: kept (Handler, 10-30).
- **Default prep wording (Josh):** is the 10-30 19:09:59 prep text right for powder? See Rollout step 1.

## Left to the builder

- Component split: a `ProfileCoaVariantsSection` next to `ServiceSpecsSection` is reasonable, since AnalysisProfilesPage.tsx is already large.
- Pydantic model names and response shape details.
- Ordering of the variants list (form sort order is a sensible default).

## Known limits

- Forms are per sample. If one submission ever holds vials of different forms, a section built from several vials will need a rule for which variant prints.
- Adding "from the method" later turns the three-way control into four. That needs method linkage fixed first.
