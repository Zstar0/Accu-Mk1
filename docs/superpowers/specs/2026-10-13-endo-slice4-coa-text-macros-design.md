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
- A segment is a `[` ... `]` pair with no bracket inside it, so segments never nest; any other bracket, including an unmatched `[` or `]` or the outer pair around a nested one, prints as typed.
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

### Pre-launch check (required, read-only)

Run it before the deploy, against the production profiles, only with the Handler's approval. It runs inside the Mk1 backend container (`cd /app && python -`) and writes nothing:

```python
from sqlalchemy import text
from database import engine
from coa.text_macros import resolve, unknown_macros

with engine.connect() as c:
    rows = c.execute(text(
        "SELECT id, key, coa_basis_note, coa_method_text, coa_prep_text, coa_footnotes "
        "FROM analysis_profiles ORDER BY id")).all()
hits = []
for pid, key, basis, method, prep, notes in rows:
    items = [("coa_basis_note", basis), ("coa_method_text", method), ("coa_prep_text", prep)]
    for i, n in enumerate(notes if isinstance(notes, list) else []):
        if isinstance(n, dict):
            items += [(f"coa_footnotes[{i}].text", n.get("text")),
                      (f"coa_footnotes[{i}].label", n.get("label"))]
    for where, t in items:
        if isinstance(t, str) and (unknown_macros(t) or resolve(t, {}) != t):
            hits.append((pid, key, where, t))
for h in hits:
    print(h)
print(len(rows), "profiles,", len(hits), "hits")
```

A text is a hit when either test holds:
- `unknown_macros(t)` is non-empty: a lowercase `{token}` Mk1 cannot fill, or a near miss such as `{LOD}` or `{ lod }`. The editor sends every COA field on each save, so a stored token like this makes the next save of that profile a 400.
- `resolve(t, {}) != t`: the text already holds a known `{lod}`. That is the one way existing data changes output on deploy, because text with no known macro is returned exactly as typed.

Footnote labels are included because the save now refuses a macro in a label. Expect zero hits. Fix any hit in the profile before the deploy.

### Launch

Same after-hours window as v2 and slice 3.

1. Deploy the new image and confirm it is healthy (the profile editor loads and `GET /analysis-profiles` answers).
2. Only then add `[LOD {lod}.]` to the method text of the peptide endotoxin profile and the bac water endotoxin profile, in the profile editor. The Handler or the profile owner does this.

The macro text goes in after the new image is live and healthy, never before. An image without the resolver accepts `[LOD {lod}.]` on save and prints it literally on any COA it generates.

### Rollback

An image without the resolver prints the macro text literally ("[LOD {lod}.]") on any COA it generates. The order is: remove the macros, then roll back the image. This is in addition to slice 3's rollback runbook.

1. List every profile that holds the macro. This query is read-only; expect exactly the two launch profiles:

   ```sql
   SELECT id, key, name
   FROM analysis_profiles
   WHERE coa_basis_note LIKE '%{lod}%'
      OR coa_method_text LIKE '%{lod}%'
      OR coa_prep_text LIKE '%{lod}%'
      OR coa_footnotes::text LIKE '%{lod}%'
   ORDER BY id;
   ```

2. Remove the macro from each of those profiles in the profile editor.
3. Run the query again: zero rows.
4. Then roll back the image.

**If the new image's API is down**, the editor in step 2 is not available. Clear the macro text with one UPDATE instead, run by the Handler (it is documented here and is never run as part of the slice). It removes the `[...]` segment that holds `{lod}` and any bare `{lod}`, and leaves the rest of each column:

```sql
UPDATE analysis_profiles
SET coa_basis_note = CASE WHEN coa_basis_note LIKE '%{lod}%'
      THEN NULLIF(btrim(regexp_replace(regexp_replace(coa_basis_note,
        '\s*\[[^\[\]]*\{lod\}[^\[\]]*\]', '', 'g'), '\s*\{lod\}', '', 'g')), '')
      ELSE coa_basis_note END,
    coa_method_text = CASE WHEN coa_method_text LIKE '%{lod}%'
      THEN NULLIF(btrim(regexp_replace(regexp_replace(coa_method_text,
        '\s*\[[^\[\]]*\{lod\}[^\[\]]*\]', '', 'g'), '\s*\{lod\}', '', 'g')), '')
      ELSE coa_method_text END,
    coa_prep_text = CASE WHEN coa_prep_text LIKE '%{lod}%'
      THEN NULLIF(btrim(regexp_replace(regexp_replace(coa_prep_text,
        '\s*\[[^\[\]]*\{lod\}[^\[\]]*\]', '', 'g'), '\s*\{lod\}', '', 'g')), '')
      ELSE coa_prep_text END,
    updated_at = now() AT TIME ZONE 'utc'
WHERE coa_basis_note LIKE '%{lod}%'
   OR coa_method_text LIKE '%{lod}%'
   OR coa_prep_text LIKE '%{lod}%';
```

Then run the query from step 1 again. A profile that the query lists only through `coa_footnotes` is not touched by the UPDATE: roll back the image, then remove the macro in the old editor straight away (the old editor accepts any text). Hold COA publishing until that footnote text is fixed and the step 1 query returns zero rows, because a footnote macro prints literally in the gap.

**Coverage of slice 3's hold.** Slice 3's rollback hold covers COA generation only for samples whose endotoxin parent result is in EU/vial. Bac water samples and peptide samples whose endotoxin result is in EU/mL are not held. Their COAs are printed under the new image from profiles that carry the macro, so if the image is rolled back with the macros still in the profile text, regenerating any of them prints the literal `[LOD {lod}.]` in the footer. Removing the macros first (steps 1 to 3) is therefore not optional for those samples, and the slice 3 hold does not stand in for it.

## 10. Out of scope

- Per-row LOD columns, the portal and the customer API (D1).
- Macros other than `{lod}`.
- Unit-conditional text (D4).
- Back-filling LOD into issued certificates. Regenerate instead; never edit stored `coa_data`.
