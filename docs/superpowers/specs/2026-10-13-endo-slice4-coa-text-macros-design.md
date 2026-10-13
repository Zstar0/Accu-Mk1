# Endotoxin slice 4: the result's LOD on the COA through profile text macros

Status: approved in conversation by the Handler on 2026-10-13. This is the written spec for review.
Builds on: slice 3 (`feat/endo-slice3`): `lims_analyses.loq`, `lod`, `lod_unit`, and the result's own LOQ on the wire.

## 1. Goal

A customer's endotoxin certificate shows the result's LOD (the cartridge sensitivity, always EU/mL) in the section's footer text. It appears on both the PDF and the AccuVerify verify page. The results table stays as it is: Test, Specification, Result, LOQ and Verdict, with the unit folded into the headers.

The Handler's mockup footer reads:

> Method: Endotoxin testing performed using Limulus Amebocyte Lysate assay in accordance with USP <85> under validated laboratory conditions. Results and limit are per vial (5 EU/kg × 70 kg, the whole vial as one dose). LOD 0.05 EU/mL.

The lab authors that text on the analysis profile, as today. The new part is that `0.05 EU/mL` comes from the result through a macro: `... dose). [LOD {lod}.]`

## 2. Decisions (Handler, 2026-10-13)

| # | Decision |
|---|---|
| D1 | Surfaces are the PDF and the AccuVerify verify page. The badge also gets it, because it renders the same text. The portal, the per-row LOD columns and the customer API are not in scope. |
| D2 | LOD goes in the profile's footer text through a macro, not a new table column. |
| D3 | A result with no LOD drops an optional segment: `[LOD {lod}.]` disappears entirely. |
| D4 | Bac water has its own analysis profile, so each profile carries its own text (no unit-conditional syntax). |
| D5 | Mk1 resolves the macros when it builds the COA wire, so coabuilder, WordPress and the Integration Service do not change, and slice 4 is a Mk1-only deploy. |

## 3. Why Mk1-only works

The profile's `coa_method_text`, `coa_prep_text`, `coa_basis_note` and `coa_footnotes` already travel on the native-sections wire and render on every surface:

- coabuilder PDF: `src/coabuilder_core/native_sections.py:335` prints "Method: ...", with the notes box below the section.
- coabuilder digital sections: these copy `method_text`, `prep_text`, `basis_note` and `footnotes` into `coa_data`. IS passes them through untouched.
- WordPress verify page: `templates/accuverify-content.php:300` prints "Method: ...", and `:359` prints the footnotes.
- Badge: `accuverify-badge-embed.js:3370` prints the method text, and `:3373` the notes.

If Mk1 sends the resolved text, every surface prints it with no change. Source: the slice 4 hop map, `.superpowers/slice4-hop-map.md`.

## 4. The macro language

It applies to five places on an analysis profile: `coa_basis_note`, `coa_method_text`, `coa_prep_text`, and the `text` of each `coa_footnotes` entry. Footnote labels print as typed.

### Macros

| Macro | Resolves to | Empty when |
|---|---|---|
| `{lod}` | The section's LOD with its unit, for example `0.05 EU/mL`. The number prints with up to 6 decimals, no trailing zeros and no exponent (`0.005`, `0.05`, `0.01`). If several rows in the section carry different LODs, the distinct values are joined with `, ` in row order. | No row in the section has an LOD (results before slice 3, hand-entered results, non-endotoxin sections). |

A macro is `{` + a name of lowercase letters or underscores + `}`. Only `{lod}` exists today. The resolver is written so adding a macro is one entry in a table.

### Optional segments

- `[` ... `]` that contains at least one macro is an optional segment.
  - If any macro inside it is empty, the whole segment, brackets included, is removed.
  - Otherwise the segment prints its resolved inner text, without the brackets.
- `[` ... `]` that contains no macro prints exactly as typed, brackets included. This keeps every existing profile text byte-identical.
- Segments do not nest: the first `]` after a `[` closes it. An unmatched `[` or `]` prints as typed.
- A macro outside any segment that is empty resolves to an empty string. The editor hint recommends brackets.

### Whitespace

Only text that contained at least one macro is cleaned after resolution:
- runs of two or more spaces collapse to one;
- leading and trailing whitespace is trimmed.

Text with no macro is never touched.

### Footnotes

A footnote whose `text` resolves to an empty string is dropped from the section's list (its label would otherwise print alone).

### Unknown macros

- **On save:** refused (section 6).
- **At COA build:** a profile written by SQL or migration could still carry one. The build leaves it as typed, so a certificate never fails because of profile text. This matches the fail-open rule the section builder already applies to malformed footnotes.

### Examples

| Profile text | Section rows | Result |
|---|---|---|
| `... dose). [LOD {lod}.]` | one row, LOD 0.05 EU/mL | `... dose). LOD 0.05 EU/mL.` |
| `... dose). [LOD {lod}.]` | one row, no LOD | `... dose).` |
| `See ref [1].` | any | `See ref [1].` (unchanged) |
| `LOD {lod}` | no LOD | `LOD` |

## 5. Where it resolves

In `backend/coa/native_sections.py`, the section builder (the `sections.append({...})` block, around lines 421-437 at slice 3 HEAD):
- While building a profile's rows, collect each row's `(lod, lod_unit)` from the `LimsAnalysis` rows that produced them.
- Pass the section's macro values to one resolver, `coa.text_macros.resolve(text, values) -> Optional[str]`.
- Resolve `basis_note`, `method_text`, `prep_text` and each footnote text, then drop the empty footnotes.
- A `None` text stays `None`.

The resolver is a new pure module, `backend/coa/text_macros.py`, with no database access. It holds:
- `MACROS`: the supported names;
- `unknown_macros(text) -> list[str]`, for validation;
- `resolve(text, values)`;
- `format_lod(values) -> str`.

Nothing else changes on the wire: no new keys and no per-row `lod`. Heavy-metal, sterility, pH and HPLC sections carry no macros today, so their wire output is byte-identical.

The Mk1 COA preview and the regenerate paths use the same builder, so they show the same text.

## 6. Validation and the editor

**Backend.** The analysis-profile create and update routes (`backend/main.py`, beside `_validate_coa_footnotes` at about :21441 and :21530) gain `_validate_coa_text_macros(fields)`.
- It checks all five places.
- Any unknown macro name is refused with 400: `unknown COA text macro {x}; supported: {lod}`.

**Frontend.** `src/components/hplc/AnalysisProfilesPage.tsx` gets one muted hint line under the COA text fields: "Macros: {lod}. Wrap optional text in [ ], for example [LOD {lod}.]". The save error from the server shows as profile save errors already do.

## 7. Error handling

- **Validation** is the only refusal (400 on save).
- **The COA build never fails because of macros.** An unknown macro stays as typed, an empty macro resolves to an empty string or drops its segment, and a malformed bracket prints as typed.
- **LOD values:** non-finite values are skipped. They cannot be stored anyway (slice 3's bounds), so this is defence only.

## 8. Testing

Unit tests for `text_macros` (`backend/tests/test_coa_text_macros.py`):
- the macro present, absent, inside and outside a segment;
- a segment with no macro (kept with its brackets);
- unmatched brackets;
- an unknown macro (kept as typed);
- distinct LODs across rows, joined in row order;
- number formatting (`0.005`, `0.05`, `0.01`, `0.1`);
- whitespace cleanup only on macro-bearing text;
- `None` text.

Wire build (`backend/tests/test_native_sections.py` or a new file):
- An endotoxin section whose method text ends `[LOD {lod}.]` prints `LOD 0.05 EU/mL.` with a 0.05 LOD row, and drops the segment with no LOD.
- A footnote made only of a dropped segment is removed.
- A heavy-metal section's dict is byte-identical to before. This extends the existing exact-dict pin.

Route tests:
- Create and update refuse an unknown macro in each of the five places.
- `{lod}` saves.
- Existing profiles with brackets and no macros save unchanged.

Frontend: the hint renders on the profile editor.

## 9. Launch and rollback

**Launch (same after-hours window as v2 and slice 3).** Add `[LOD {lod}.]` to the method text of the peptide endotoxin profile and the bac water endotoxin profile. The Handler or the profile owner does this in the profile editor.

**Rollback.** An image without the resolver would print the macro text literally ("[LOD {lod}.]") on any COA it generates. So the rollback order is:
1. Remove the macros from the profile texts.
2. Then roll back the image.

That is in addition to slice 3's rollback runbook.

## 10. Out of scope

- Per-row LOD columns, the portal and the customer API (D1).
- Macros other than `{lod}`.
- Unit-conditional text (D4).
- Back-filling LOD into issued certificates. Regenerate instead; never edit stored `coa_data`.
