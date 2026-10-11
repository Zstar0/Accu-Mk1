# Endotoxin worksheet v2 (slices 1 + 2) - design

Date: 2026-10-10. Status: design approved in conversation section by section (Handler, 2026-10-09 and 2026-10-10); this written spec awaits Handler review.

Sources:
- Change report (Claude Doc, private): "Endotoxin v2 in Accu-Mk1: change report", https://claude.ai/code/artifact/765af45c-2818-4a57-9193-dee782df8ee5 (decisions Q0, R1 to R11; build plan slices 1 to 5).
- Dennis's tool: `ValenceAnalytical/tools-dennis` at `5ef2a62` (2026-10-09), `tools/endotoxin-log/` (`calc.js`, `calc.test.js` 52 tests, `endotoxin.html`), his specs `docs/superpowers/specs/2026-10-07-endotoxin-mvd-cartridge-design.md` and `2026-10-08-endotoxin-2ml-prep-design.md`.
- Meeting: Grain "Endotoxin Update", 2026-10-09 (Dennis, Forrest).
- Prior Mk1 work: `docs/superpowers/specs/2026-09-18-endo-worksheet-design.md` (Worksheets 2.0, shipped 1.25.0).

## 1. Intent

Mk1's endotoxin worksheet becomes Dennis's current tool: the 2 mL prep, his three-box layout on screen and paper, and a Results section that turns the instrument reading (typed, or imported from the reader's export) into LOD, LOQ, EU per vial and a verdict. Cartridges come from a managed consumables catalog linked to methods, so the lab, not code, decides which cartridges a method allows. Endo worksheets get a full page; the flyout becomes a read-only summary.

Success means:
- Mk1's numbers equal Dennis's on the 18 of his 52 test cases that cover the 2 mL prep, results and the reader import (the rest cover stock runs, his own intake file and method rules; mapping in section 11).
- The printed bench sheet and the three boxes match his layout, column order and spacing (checked side by side, section 11).
- Every worksheet that exists today, and every completed one, looks and calculates exactly as before.
- Nothing in this release writes results, units or limits to a sample's analyses or reaches a COA. The only analysis write is today's MCS-tick instrument stamp, which the reader import reuses.
- Admins add, edit and retire cartridges, and set a method's cartridges and run parameters, without a code change.

### Rulings (Handler)

| Ruling | Date |
| --- | --- |
| Slices 1 and 2 ship together as one release | 10-09 |
| Consumables catalog with method-linked cartridges (option B) | 10-09 |
| A method's allowed cartridges change only through a new method revision | 10-10 |
| Run parameters (standard dilution, water, spike recovery and CV limits) live on the method, revision-locked | 10-10 (proposed, not objected to) |
| Read-only "How results are judged" panel on the Analysis Service page | 10-10 (proposed, not objected to) |
| Serial number on instruments; the reader import stamps the instrument by serial | 10-10 |
| Endo worksheets get a full page; the endo flyout becomes read-only | 10-10 |
| Open worksheets created on or after 2026-10-08 (lab date) start on 2 mL at release (open and staging; completed ones stay on stock) | 10-10 |
| The Accu-Mk1 value stays visible on the worksheet, with its unit | 10-10 |
| Manual result entry on AR rows stays; worksheet-to-AR (Promote to Parent) is slice 3, as planned | 10-10 |
| Derived numbers and reader-file parsing run in the browser (server-side maths declined) | 10-10 |
| Layout and spacing match Dennis's as closely as possible | 10-10 |

### Out of scope

Promote to Parent and anything on `lims_analyses` (slice 3); COA, Integration Service, coabuilder and WordPress changes (slices 3 and 4); the spec switch to 350 EU per vial (R6); per-result LOQ and LOD on analyses (R11); method rules and their rule lock (slice 5); consumable lots, expiry tracking and the inventory link; a Mk1 agent role or worksheet tools in `labmanager-mcp`; full pages for PCR and HPLC worksheets.

## 2. Findings that shape the design

Read from `origin/master` (v1.42.0/1.42.1).

- Endo prep figures are computed on screen and never stored (`src/lib/endo-prep.ts:7-10`, `backend/models.py:1124-1125`). Changing the maths in place would change every past worksheet's screen, reprint and CSV, so the model must be chosen per worksheet.
- Item fields follow a seven-place path: migration line (`backend/database.py` `_run_migrations`), model column, `WorksheetItemUpdate` (`backend/main.py:25203`), the serializer dict (`_serialize_worksheets`, `main.py:23811`), `WorksheetItemPatch` (`src/lib/api.ts:6308`), the items type (`api.ts:6119-6183`) and the optimistic merge (`src/hooks/use-worksheet-drawer.ts:210-249`).
- The item PATCH has no completed-worksheet guard (`main.py:25219-25308`); bulk ticks return 409 on a completed worksheet (`main.py:25006`). Prep cells refuse values at or below 0 on both sides (`EndoPrepLine.tsx:94-112`, `main.py:25299`).
- `worksheets.bench_config` is replaced whole by PUT with no validation or audit (`main.py:24344`); only PCR uses it. Cartridge picks get real FK columns instead.
- Methods (`hplc_methods`, all techniques) are controlled documents: content fields lock once issued or referenced (`METHOD_LOCKED_FIELDS`, `main.py:3214`); `new-revision` clones content, instruments and service links (`main.py:4982`); `activate` hands service defaults over and retires the predecessor (`main.py:5027`). Instruments and service links stay editable on active methods today.
- `_sole_instrument_for_item` (`main.py:24892`) finds the endo instrument by walking service, active default method, linked instrument, and stamps it only when exactly one resolves; it never writes a method.
- Catalog edits log to `catalog_change_log` through `catalog/change_log.py` (`log_create`, `apply_and_log`, `log_members`); operational events go to `audit_logs`.
- Navigation is a zustand store with hash sync (`src/lib/hash-navigation.ts`); `worksheet-detail?id=` opens the flyout (`:118`); full-page detail views with an id already exist (customer detail, documents).
- Roles are `standard` and `admin`; instruments and methods are editable by any logged-in user.
- Lab time zone: `scheduled_publish.lab_tz(db)` (default `America/Los_Angeles`).

## 3. Data model

All new columns are nullable unless stated. All changes are additive.

### 3.1 `consumable_types` (new table)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | serial PK | |
| `kind` | varchar(40), not null | a key from the kind registry (3.2) |
| `name` | varchar(200), not null | e.g. "Endosafe cartridge 0.05" |
| `manufacturer` | varchar(200) | |
| `part_number` | varchar(100) | the stable key the inventory system will join on |
| `instrument_id` | FK `instruments`, ON DELETE SET NULL | the instrument it fits |
| `specs` | JSON, not null, default `{}` | kind-specific numbers, validated by the registry |
| `active` | bool, not null, default true | retire = false; never deleted |
| `origin` | varchar(20), not null, default `mk1` | catalog convention |
| `created_at`, `updated_at` | timestamp | |

Unique `(kind, name)`. Partial unique index on `(coalesce(manufacturer, ''), part_number) WHERE part_number IS NOT NULL`.

**Lock on use.** Once any `worksheets.cartridge_type_id` or `worksheet_items.cartridge_type_id` references a type, a PATCH touching `kind` or `specs` returns 409 naming the fields. `name`, `manufacturer`, `part_number`, `instrument_id` and `active` stay editable. A wrong number is fixed by retiring the type and adding a new one. Saving a reading always stores the row's resolved cartridge on the item (8.2, 9), so every cartridge a result was computed with is referenced, and therefore locked.

### 3.2 Kind registry (code)

`backend/catalog/consumables.py`:

```python
CONSUMABLE_KINDS = {
    "endo_cartridge": {
        "label": "Endotoxin cartridge",
        "specs": {"sensitivity_eu_ml": "positive_float"},  # required; the cartridge's lambda = LOD
    },
}
```

Create and PATCH reject an unknown kind, a missing required spec, an unknown spec key, or a non-positive number (400). A new kind later is one registry entry plus rows. The frontend reads the registry from `GET /consumables/kinds` to build its form.

### 3.3 `method_consumables` (new table)

| Column | Type | Notes |
| --- | --- | --- |
| `method_id` | FK `hplc_methods`, ON DELETE CASCADE | |
| `consumable_type_id` | FK `consumable_types` | |
| `kind` | varchar(40), not null | copied from the type, so the default index can be per kind |
| `is_default` | bool, not null, default false | |

PK `(method_id, consumable_type_id)`. Partial unique index `(method_id, kind) WHERE is_default`: one default per method per kind.

- **Editable on draft methods only.** `PUT /hplc/methods/{id}/consumables` (replace-set, the `method_services` precedent) returns 409 when the method's status is not `draft`.
- **New revision** copies every link **including `is_default`** (the default belongs to one method, so it cannot clash with another).
- **Activate and retire** need no change.
- Logged with `log_members` to `catalog_change_log`.

### 3.4 `hplc_methods.run_parameters` (new JSON column)

```json
{"endotoxin": {"std_total_dilution": 250, "recon_water_ml": 2,
               "spike_recovery_min_pct": 50, "spike_recovery_max_pct": 200,
               "cv_limit_pct": 25}}
```

- Every key is optional; a missing key falls back to Dennis's value (the numbers above). Keyed by block (`endotoxin`) rather than by `technique`, so validation does not depend on a free-text technique string.
- Validation: known keys only, positive numbers, `spike_recovery_min_pct < spike_recovery_max_pct`, `std_total_dilution >= 20` (the standard step 1 at 1:10 times the fixed step 3 at 1:2).
- Added to `METHOD_LOCKED_FIELDS`; set through the existing method PUT (`MethodUpdate.run_parameters`); copied by `new_method_revision`; logged with the method's other fields.

### 3.5 `instruments.serial_number` (new column)

varchar(100). Partial unique index `WHERE serial_number IS NOT NULL` (a duplicate returns 409). Added to `InstrumentCreate`/`InstrumentUpdate` and `INSTRUMENT_LOG_FIELDS`.

### 3.6 `worksheets` (new columns)

| Column | Type | Notes |
| --- | --- | --- |
| `endo_prep` | varchar(10) | `2ml` or `stock`; default `2ml` for new rows (3.8) |
| `cartridge_type_id` | FK `consumable_types` | the run's cartridge |
| `endo_method_id` | FK `hplc_methods` | the method revision pinned at first print or first reading (4.1) |

Non-endo worksheets carry `endo_prep` harmlessly; only endo views read it.

### 3.7 `worksheet_items` (new columns)

| Column | Type | Meaning |
| --- | --- | --- |
| `prep_form` | varchar(10) | `powder`, `liquid` or `bac`; empty = worked out from the sample (4.2) |
| `prep_water_ml` | float, > 0 | 2 mL runs: water in the vial when not 2 mL; required for `liquid` (the customer's volume). Separate from `prep_volume_ml`, which keeps its stock meaning |
| `prep_total_dilution` | float | the row's desired total when not the method's standard |
| `prep_steps` | JSON | `[[sample_ul, ratio] or null, [sample_ul] or null, [sample_ul] or null]`; null entries = standard |
| `cartridge_type_id` | FK `consumable_types` | the row's cartridge override |
| `result_reading` | varchar(40) | the reading exactly as the instrument shows it: `<0.05`, `0.8`, `0` |
| `result_reader` | JSON | the reader's record for this test (8.4) |
| `result_entered_at` | timestamp | |
| `result_entered_by_user_id` | FK `users` | |

`prep_steps` validation: exactly three entries; each `sample_ul > 0`; step 1 `ratio >= 1`. `result_reading` validation: a non-negative number, or `<` followed by a positive number.

### 3.8 Migrations

In `database.py`, a new `_run_endo_v2_migrations(bind)` called from `init_db` right after `create_all` (the `_ensure_documents_space_column` precedent; `_run_migrations` runs before `create_all`, so foreign keys to the new tables cannot be added there). Postgres only, one transaction, in this order, all idempotent:
1. `CREATE TABLE` via `create_all` for `consumable_types` and `method_consumables`; `CREATE UNIQUE INDEX IF NOT EXISTS` for the partial indexes.
2. `ADD COLUMN IF NOT EXISTS` for every column in 3.4 to 3.7, **without defaults**.
3. The one-time 2 mL switch, guarded on `endo_prep IS NULL`:
   - `UPDATE worksheets SET endo_prep = '2ml' WHERE endo_prep IS NULL AND status <> 'completed' AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE :lab_tz)::date >= DATE '2026-10-08'`
   - `UPDATE worksheets SET endo_prep = 'stock' WHERE endo_prep IS NULL`
4. `ALTER TABLE worksheets ALTER COLUMN endo_prep SET DEFAULT '2ml'`; the ORM column also defaults to `2ml`.

After the first boot no row is NULL, so later boots change nothing, and a worksheet someone switched back to stock is never switched again. Adding the column with a default in step 2 would have filled every existing row with `2ml`, which is why the default comes last.

`backend/scripts/backfill_endo_worksheets.py` (the pending historical backfill) sets `endo_prep='stock'` on every worksheet it creates: those runs were prepped the old way, and the new column default would otherwise give them 2 mL maths.

## 4. Resolution rules

### 4.1 The worksheet's endo method

The serializer adds `endo_method` to each worksheet: for every endo item, follow the vial's endo analysis service to its active default method (`method_services.is_default`, method `status = 'active'`). If every endo item resolves to the same single method, return it with its `run_parameters` and its endo-cartridge consumables; otherwise `null`.

**Pinning.** The first time the worksheet is printed (`POST /worksheets/{id}/printed`, Mk1's bench-start event) or a reading is saved on it (item PATCH or reader import), whichever comes first, the server stores that resolved method in `worksheets.endo_method_id`. From then on the worksheet uses the pinned revision, not whatever is active later. Pinning at print matters because the bench preps from the paper: the sheet and the results must use the same standard dilution and cartridge. Revision content is locked, so a pinned worksheet's run parameters and allowed cartridges never change, and neither do its results. Before that, the current active method applies. If no method resolves, nothing is pinned and Dennis's values apply.

**Cost.** `endo_method` is resolved only on `GET /worksheets/{id}`, the item PATCH response and the reader-import response, never on the list endpoints, and in a fixed number of queries per call (all endo items' services at once, then their methods, then the consumables), never per item. The shared serializer serves the list endpoints too, and a per-item lookup there is the fan-out class behind the 2026-09-15 connection-pool outage.

### 4.2 Form

`prep_form` if set; else `bac` when the sample is bac water; else `powder`. Bac water, one shared rule: the Sample ID starts `BW-`, or the sample type contains "bacteriostatic", or the identity matches `/bacteriostatic|bac\.?\s*water/i`. The stock model keeps its current rule untouched.

### 4.3 Cartridges

- **Allowed list:** the method's active `endo_cartridge` consumables; if no method resolves (for example the legacy ENDO-LAL test), or the method lists none yet (between deploy and the launch revision), every active `endo_cartridge` type, with no default.
- **Run cartridge:** `worksheets.cartridge_type_id`, else the method's default, else none. Results do not compute until there is one.
- **Row cartridge:** `worksheet_items.cartridge_type_id`; else, for a bac water row, the allowed type with sensitivity 0.01 EU/mL (Dennis's rule); else the run cartridge.
- The sensitivity is read from the type's `specs.sensitivity_eu_ml`; it cannot change once used (3.1).

### 4.4 Run parameters

Each key from the method's `run_parameters.endotoxin`, else Dennis's value. The fixed parts of the maths stay in code: step 1 standard ratio 1:10, step 3 fixed at 1:2, suggested sample volumes 20 / 20 / 125 uL, 1.5 mL tube, bac water 20x.

### 4.5 Instrument stamp on import

The reader record's serial is matched to an active instrument's `serial_number`; that instrument is stamped through the existing tick path. No match falls back to `_sole_instrument_for_item`, as today. No method is ever written.

## 5. Calculations

New `src/lib/endo-prep-2ml.ts`, a port of Dennis's `calc.js` at `5ef2a62`, with run parameters and cartridge sensitivity passed in as arguments (never module constants):

| Area | Functions (Dennis's names) |
| --- | --- |
| Form, water | `formOf`, `isBacWaterSample`, `waterOf` |
| Steps | `stepsOf`, `dilutionPlan`, `vialDilutionOf`, `targetDilutionOf`, tube fit |
| Cartridge check | `prep2Check`: loaded mg/mL, MVD, MVC, valid, needs, floor shown, floor per vial, fail line, LOD (lambda, EU/mL), LOQ (lambda x total x water, EU per vial; bac water lambda x 20, EU/mL) |
| Results | `parseResult`, `prep2Result`: EU/mL of the vial, EU per vial, EU/mg, limit, verdict, expected floor, floor mismatch; `judgeWater`; `mk1Value` |
| Verdicts | Pass, Fail, Inconclusive (a `<` whose floor is above the limit), Invalid (spike recovery outside the method's range or a CV above its limit), none |
| Order | group by total, ascending; ties in bench order; unmakeable totals after numbers; bac water last |
| Reader | `parseEndoScan`, `baseSampleId`, `matchReaderTests`, `readerCartridge`, `splitIdentity` |

**Limits in this release.** The worksheet judges against Dennis's working limits, 350 EU per vial for peptides and 0.25 EU/mL for bac water, as constants in this file. They are not the COA spec: the spec stays at today's values until R6. The Results box says so (6.1). These limits and the fixed parts of the maths (4.4) change only in a reviewed release; everything an admin can change (cartridges, run parameters) is pinned per worksheet (4.1).

**Parity.** `src/lib/__tests__/endo-prep-2ml.test.ts` ports the 18 of Dennis's cases listed in section 11, with inputs and expected outputs unchanged; the reader cases use his made-up export, never real results. `endo-prep.ts` and its tests are untouched, which proves stock worksheets do not move.

## 6. Screens

### 6.1 The worksheet page (endo)

Route `#hplc-analysis/worksheet?id=N`: a new `worksheet` subsection, a `navigateToWorksheet(id)` store action and a hash branch beside `worksheet-detail`. Only all-endo worksheets get the page in this release; any other worksheet id shows a one-line notice with an "Open in flyout" button.

Layout, top to bottom, with the run log (`BenchRunLog`, kind `endo`) as a left rail:

- **Run header:** title, analyst, date made, due, orders; the **Prep** switch (`2 mL` / `1 mg/mL stock`); the **run cartridge** picker (the allowed list, preset to the method default); the method name and revision; Preview, Print and CSV.
- **Box 1, Prep** (2 mL columns): #, Received, Due (with time), Priority, Order #, Sample ID (stacked vial), Sample identity, Declared wt, Form, Water (mL), Vial conc, Cartridge with MVD/MVC and its verdict under it, Status, Made, MCS, Flag. Stock worksheets show today's columns unchanged.
- **Box 2, Sample dilution** (2 mL only): #, Sample ID ("no ID yet" when empty), Total, then one cell per step: step 1 ratio box and sample uL (Tris computed), step 2 derived ratio and sample uL (LAL water computed), step 3 "1:2" and sample uL (BG600 computed), each with its total uL and running dilution and a tube-overflow warning; then Loaded (mg/mL). Grouped by total with a rule per group; the row number is the Box 1 row.
- **Box 3, Results** (2 mL only; stock worksheets have no Results box, as today): #, Sample ID, mg, Cartridge, Loaded, MVD, MVC, Reading (its own input, 6.1.1), Reader (spike recovery and the larger CV; red when Invalid; the whole record on hover), LOD (EU/mL), LOQ, EU/mg, EU per vial, Limit, Verdict, **Accu-Mk1 value** (blue, with its unit; a click copies the number). Under the box title, one line: "Accu-Mk1 values are per vial; Mk1's endotoxin test reports {unit} against {limit} until the spec switch", with unit and limit read from the endo service's peptide spec tier through the existing spec API, not hardcoded (the 09-01 snapshot of <= 5 EU/mL is unverified). The reader import drop zone sits in the box header (section 8).
- Calculations legend and notes, as today.
- Every computed cell shows its worked line on hover.

#### 6.1.1 Inputs

Prep inputs use the existing `PrepField`. The Reading input is new: it accepts `<0.05`, `0.8` and `0`, stays in the cell with `aria-invalid` until the text parses, and saves through the item PATCH. Completed worksheets render every input read-only.

### 6.2 The endo flyout (read-only)

For all-endo worksheets the flyout no longer renders the editable table and no longer widens. It shows: title, analyst, due, prep and run cartridge; counts (rows, Made, MCS, results in, Invalid, ready for Mk1); a compact row list with status chips; Print; and **Open worksheet**. Every existing caller (flags, worksheets list, sample details, main window) keeps opening the flyout. PCR and HPLC flyouts are unchanged.

### 6.3 Mixed worksheets

`EndoPrepLine` on a mixed worksheet shows the 2 mL water, total and cartridge when the worksheet is on 2 mL, with the same prep inputs as Box 1. Results stay on the full page of all-endo worksheets.

### 6.4 Consumables admin page

A **Consumables** entry in the LIMS sidebar group (three edits: `AppSidebar.tsx`, `MainWindowContent.tsx`, `ui-store.ts`). Built like `InstrumentsPage.tsx`: a table (kind, name, manufacturer, part number, instrument, the kind's numbers, used yes/no, active) and the same right-hand slide-out panel for create and edit. Locked numbers render read-only with "In use; retire and add a new one to change". Retire is a toggle; there is no delete.

### 6.5 Method panel

Two new sections in `MethodPanel.tsx`:
- **Consumables:** allowed types grouped by kind, with a default per kind. Editable on drafts; on active or retired methods it is read-only with "Changes need a new revision".
- **Run parameters (endotoxin):** the five values, each showing Dennis's value as its placeholder. Same lock.

### 6.6 Instruments page

A Serial number field in the panel and a column in the table.

### 6.7 Analysis Service page: "How results are judged"

A read-only panel on the service detail for endo services (keyword contains `ENDO`). It lists:
- per spec tier (sample type): unit, limit, fixed LOQ (as configured today);
- the worksheet rules: LOD = the cartridge's sensitivity; LOQ = sensitivity x total dilution x water (bac water: sensitivity x 20); validity from the method's spike recovery range and CV limit; the worksheet's working limits (350 EU per vial, 0.25 EU/mL) marked "not yet the COA spec";
- the resolved method with its revision and its cartridges with sensitivities, each linking to its admin page.

### 6.8 Layout parity with Dennis's tool

- Box order, numbered box titles, column order and captions as in his `endotoxin.html`.
- The page copies his on-screen CSS (sizes, paddings, gaps; box padding 4px 14px 14px with a 12px gap); paper copies his print CSS (base 10pt, titles 14pt, colgroup percentages). Where the two disagree on screen, the parity check (section 11) decides.
- His colours (calculated-column tint, step colours for Tris, LAL water and BG600, violet for the vial) mapped to Mk1 theme tokens, with dark-mode variants (his tool is light only).
- Font: Mk1's font stack at his sizes.
- Verified by the side-by-side check in section 11.

## 7. Paper and CSV

A 2 mL variant beside the stock sheet in `endo-bench-sheet.ts` (stock printing is unchanged), following Dennis's printout at `5ef2a62`:

- **Columns:** #, Due with the Priority pill under it, Cart., Order #, Sample ID, Peptide with declared mg under it, Water (mL in vial), Step 1 Tris, Step 2 Water, Step 3 BG600 (the standard ratio in each heading; each cell "sample + diluent" with "uL sample" / "uL diluent" over the numbers), Made, MCS. No Total, Accmk1 or Flag boxes.
- **Order:** grouped by total, a rule across the table per group; the printed row number is the Box 1 row.
- **Marks:** a value set by hand prints bold and underlined; a non-standard step is boxed in its step colour with its ratio as the note; a step over the 1.5 mL tube or an unmakeable total prints boxed in red; bac water prints one "50 + 950" cell.
- **Summary page:** tiles for Samples, Off the standard, 0.1 M Tris uL, LAL water uL, BG600 uL and 1.5 mL tubes; the rule lines; a note explaining underlines, boxes and ratios.
- **Page fitting:** Dennis's fitter rules (two-line step cells, the Peptide line count, the Due cell).
- **CSV, 2 mL runs:** water; each step's sample uL, ratio and diluent uL; total; cartridge; loaded; MVD; MVC; reading; EU/mL of the vial; EU per vial; EU/mg; limit; verdict; Accu-Mk1 value and unit; reader fields (spike recovery, sample CV, spike CV, reader check, test ID, reader serial and slot, cartridge lot and expiry, operator, tested at); Tris, LAL water and BG600 used, tubes; a final "Run total" line. Formula-defused as today.
- **Identity label:** Dennis found identities exported as "Retatrutide - Identity (HPLC)". The plan's first task traces where Mk1 adds the assay suffix; if it does, the 2 mL sheet strips it with Dennis's `splitIdentity` rule.

## 8. Reader import

### 8.1 Flow

1. The analyst drops the EndoScan-V export on Box 3, or picks it.
2. The browser parses it (`parseEndoScan`) and matches each test to a row (`matchReaderTests`): exact Sample ID first; otherwise the parent ID when exactly one vial row on the sheet fits; never a guess between two vials; a parent tested twice uses its latest test.
3. A preview dialog lists every test: matched row, reading, spike recovery, CVs, validity, cartridge. Unmatched tests are listed and skipped. A row that already holds a different reading is replaced only when its box is ticked.
4. **Apply** sends one request (8.2). The page refreshes from the response.

The raw file is not stored; the per-row record keeps everything in it.

### 8.2 `POST /worksheets/{id}/reader-import`

Request:
```json
{"file_name": "EndoScanV-Export-2026-10-09.csv",
 "tests": [{"item_id": 812, "reading": "<0.05", "record": {"test_id": "...", "reader": "...", "slot": 2, "...": "..."},
            "cartridge_type_id": 3, "replace": false}]}
```

Server, for the whole request in one transaction (all or nothing):
- 404 when the worksheet does not exist; 409 when it is completed.
- 400 naming the failing rows when an item is not on this worksheet, the reading does not parse, a row already holds a different reading and `replace` is false, or the cartridge is retired, of the wrong kind or not in the allowed list.
- Pin the method revision if the worksheet has none (4.1).
- Per row: store `result_reading`, `result_reader`, `result_entered_at` and `_by`; store the row's cartridge (the reader's, or the row's resolved one) in `cartridge_type_id`; set **Ran (MCS)** through `_apply_bench_ticks`, passing the instrument matched by serial (4.5); write one `audit_logs` row `endo_reader_imported` with the file name, test ID, reader serial and slot.
- An identical reading and test ID already on the row is a no-op for that row.
- Response: the updated worksheet items, serialized as the worksheet GET does.

### 8.3 Matching the cartridge

`readerCartridge` reads the export's cartridge range; its lower bound is the sensitivity. The browser picks the allowed type with that `sensitivity_eu_ml`; no match marks the row "cartridge not in the catalog" in the preview and it cannot be applied.

### 8.4 The reader record (`result_reader`)

`test_id`, `result` (the reading exactly as the reader showed it, so the screen can flag a typed reading that differs), `reader` (serial), `slot`, `operator`, `tested_at`, `temp_start`, `temp_end`, `software`, `cartridge_lot`, `cartridge_expiry`, `cartridge_range`, `spike_level`, `recovery`, `rec_min`, `rec_max`, `sample_cv`, `spike_cv`, `cv_limit`, `reader_pass` (the reader's flags), `valid` and `why` (worked out from the numbers), `file_name`, `imported_at`, `imported_by_user_id`.

## 9. API changes

| Endpoint | Change |
| --- | --- |
| `GET /consumables`, `POST /consumables`, `PATCH /consumables/{id}` | new; `?kind=` and `?active=` filters; PATCH enforces the lock (3.1) |
| `GET /consumables/kinds` | new; the registry for the admin form |
| `GET /hplc/methods/{id}/consumables`, `PUT /hplc/methods/{id}/consumables` | new; PUT is replace-set, drafts only |
| `PUT /hplc/methods/{id}` | `run_parameters` accepted (locked fields rule applies) |
| `POST /hplc/methods/{id}/new-revision` | also copies `run_parameters` and `method_consumables` |
| `POST/PATCH /instruments` | `serial_number` |
| `PUT /worksheets/{id}` | `endo_prep`, `cartridge_type_id` (409 on completed; audited) |
| `PATCH /worksheets/{ws}/items/{item}` | `prep_form`, `prep_water_ml`, `prep_total_dilution`, `prep_steps`, `cartridge_type_id`, `result_reading` (409 on completed for these fields only; audited). Setting `result_reading` requires the row's resolved `cartridge_type_id` in the same request when the item has none, and pins the worksheet's method (4.1). A typed reading over an imported one keeps `result_reader` (the screen flags the difference); clearing the reading also clears `result_reader` |
| `GET /worksheets`, `GET /worksheets/{id}` | serialize the new worksheet and item fields and each referenced cartridge's sensitivity; `endo_method` (4.1) on the single-worksheet GET only |
| `POST /worksheets/{id}/printed` | also pins the method (4.1) |
| `POST /worksheets/{id}/reader-import` | new (8.2) |

New endpoints declare their response models.

## 10. Rules, errors and audit

- **Who can edit:** worksheet entry as today (any logged-in user). Consumables and instrument serials: any logged-in user, every change in `catalog_change_log`. Method content, run parameters and allowed cartridges: drafts only (409 on active or retired).
- **Completed worksheets:** read-only on screen; the server returns 409 for the new item fields, the run fields and the reader import. Existing fields keep today's behaviour.
- **Validation (400 with the reason):** a reading that is not a number or `<number>`; water at or below 0; a total below twice the row's step 1 ratio (step 2 cannot be made; tube overflow stays an on-screen warning); malformed `prep_steps`; an unknown Form; a retired, wrong-kind or not-allowed cartridge; malformed `run_parameters`.
- **Conflicts (409):** editing a used cartridge's `kind` or `specs`; a duplicate instrument serial; editing a non-draft method's consumables or run parameters.
- **Audit (`audit_logs`):** `endo_prep_set`, `endo_cartridge_set` (run and row), `endo_method_pinned`, `endo_reading_set` / `endo_reading_cleared`, `endo_reader_imported`, each with the item or worksheet id and old and new values.
- **Audit (`catalog_change_log`):** consumable create, edit and retire; method consumables (`log_members`); method `run_parameters`; instrument `serial_number`.

## 11. Testing

- **Maths:** `endo-prep-2ml.test.ts` ports 18 of Dennis's 52 cases (`calc.test.js` at `5ef2a62`, by line); the existing endo tests (`endo-prep.test.ts`, `endo-bench-sheet.test.ts`, `endo-holidays.test.ts`, `worksheet-kind.test.ts`) pass unchanged.

  | Dennis's tests | Count | Here |
  | --- | --- | --- |
  | 2 mL: prep and floors (533), reading to EU/vial (602), the 2 mL flag vs stock fields (641, as the worksheet prep switch), dilution scheme (670), LOD and LOQ (820), bac water 20x on 2 mL (835, without its method-rule clause), bac water last and on 0.01 (861), bac water limit 0.25 (879), liquid form (906), Accu-Mk1 value (934) | 10 | Ported |
  | Shared helpers: 350 per vial and per mg (196), MVC (210), parseResult (352), limit flat per vial (480), small-number formatting (517) | 5 | Ported |
  | Reader: parse and checks (992), invalid verdict (1016), matching by Sample ID (1035) | 3 | Ported |
  | Stock prep, dates, order, intake parsing, storage (17 to 181) | 15 | Not ported: the stock maths is unchanged and already covered by the September port's tests; his intake file and storage do not exist in Mk1 |
  | Stock-run cartridge and results, 10-07 (224, 240, 254, 284, 305, 324, 345, 362, 381, 403, 416, 435, 447, 469, 496) | 15 | Not ported: stock worksheets get no cartridge or Results box in Mk1 |
  | Method rules (747, 768, 797) | 3 | Slice 5 |
  | Inbox identity label (952) | 1 | Ported only if the identity trace (section 7) finds Mk1 adds the assay suffix |
- **Paper:** `endo-bench-sheet` tests for the 2 mL sheet (grouping, marks, summary totals, CSV columns and defusing); stock output byte-identical to today.
- **Backend (pytest, the `test_worksheet_endo_prep.py` style):** consumables CRUD, registry validation, lock on use, retire; method consumables replace-set, draft-only 409, copied with default on new revision; `run_parameters` validation, lock and copy; instrument serial uniqueness; the new item fields (validation, null clears, 409 on completed, audit rows); `endo_method` resolution (single method, mixed, none; a query-count assertion proving it is batched) and pinning (first print or first reading pins, whichever comes first; a later activated revision does not change a pinned worksheet; a reading without a resolved cartridge is refused); reader import (ownership, completed 409, all-or-nothing, replace flag, cartridge rules, serial-to-instrument stamp and fallback, no-op repeat, audit rows); the backfill script writing `stock`. The migration switch (run twice, including a worksheet switched back to stock) uses Postgres-only SQL, so that test runs against the stack's Postgres inside the container, not the in-memory SQLite the other worksheet tests use.
- **Frontend:** hash route and store action; the read-only flyout; the Reading input; the import preview (matched, unmatched, replace ticks, invalid).
- **Layout parity:** run Dennis's tool locally (`serve-local.js`) and the Mk1 page on the same run data; compare screenshots at 1920 and 1440 wide for box order, columns, widths and spacing; differences listed and either fixed or accepted by the Handler.
- **UAT:** an isolated accumark-stack with the Handler and Dennis.
- **Gates:** `npm run check:all`; the backend suite inside the stack container, as a failure-set diff against master (one suite at a time).

## 12. Rollout

- Mk1 only; no coabuilder, Integration Service or WordPress change. Deployed after lab hours via the `accumark-deploy` skill.
- At first boot the migration switches open worksheets made since 2026-10-08 to 2 mL (3.8).
- **Launch steps for the lab:**
  1. Add the three cartridges on the Consumables page with their real part numbers (sensitivities 0.05, 0.01 and 0.005 EU/mL; the fit instrument is the Nexgen-MCS).
  2. Set the Nexgen-MCS serial number on its instrument.
  3. Make a new revision of the Endotoxin method; add the cartridges with 0.05 as default, set run parameters only where they differ from Dennis's values; activate it.
  4. Send the lab the release note, including the line about Accu-Mk1 values being per vial.
- **Rollback:** redeploy the previous image. New columns and tables are additive and ignored by the old code.

## 13. Open items

- **Dennis:** keep the Flag cell on screen (proposed) though he dropped it on 2 mL runs; which "top section" he wants removed.
- **Identity label:** trace the " - Identity (HPLC)" suffix (section 7).
- **Unverified:** the live prod catalog for the endo test (unit, result type, spec rows, LOQ); a read-only prod query was blocked on 10-09. The 6.7 panel shows whatever is configured.

## 14. Follow-ups (not this release)

- Slice 3: Promote to Parent from the Results box; per-result LOQ and LOD on analyses (R11); the spec switch (R6).
- Slice 4: LOD on the COA through coabuilder and WordPress.
- Slice 5: method rules and their rule lock; Re-apply rules.
- Consumable lots and expiry as catalog records, and the inventory link (the reader record already carries lot and expiry per test).
- Server-side endo maths for agents (declined 10-10; revisit with `labmanager-mcp` worksheet tools and an agent role).
- Full pages for PCR and HPLC worksheets.
