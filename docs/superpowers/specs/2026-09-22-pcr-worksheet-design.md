# PCR worksheet (Worksheets 2.0, slice 2): design

Written 2026-09-22 from Dennis's `tools-dennis/tools/qpcr-plate-builder` (in daily use since
2026-09-14: 3 runs of 20, 53 and 19 samples on file) and read-only probes of prod Mk1 on
2026-09-21. The endotoxin slice (`2026-09-18-endo-worksheet-design.md`, shipped as Mk1
1.25.0) set the pattern; this slice hangs the PCR bench off the same worksheet system.

## Rulings (Dennis Nguyen via the Handler, 2026-09-22 12:01)

1. **The worksheet is the run.** One PCR worksheet spans every order on the plate. It
   replaces the lab's per-order "8120 P" worksheets for PCR work.
2. **Wells freeze once the plate is loaded.** After the first print or QuantStudio export
   the printed wells never move. Late additions take the free wells after them. **The NPC
   is always the last well on the plate**, so it is re-placed after the last sample and is
   never itself frozen.
3. **Legacy `ster` and native `pcr` vials share a plate.** Both carry the rapid sterility
   PCR test (`STER-PCR` service 75, `STERILITY-PCR` service 282). `ster` is phasing out and
   is treated as an alias of `pcr`; nothing is built for it specifically.

4. **A sample leaves a run by going back to the inbox** (Handler, 2026-09-23). The PCR
   samples list offers Remove only, no Reassign; the removed vial rejoins the next run like
   a new arrival, which is how Dennis's lab carried unrun samples into the next day's CSV.
   Reassign from anywhere else (a mixed worksheet's list, the API) releases the frozen
   well, because the well belongs to the plate it was printed on.

Standing rulings carried over from endo: extend the worksheet system, keep Dennis's layout
and way of working inside the flyout in Mk1 styling, due dates from the SLA engine.

## 1. What Dennis built

Drop the day's sample list on it; it lays the samples onto 96-well plates, works out every
reagent volume, prints one landscape page per plate, writes the QuantStudio import file and
files the run in a searchable log. In every filed run: only the automatic NPC control (never
an NTC), overage 1.4, sort by order on, the four status ticks unused, notes empty, curve
"Quantitative", plate type "8-Well Strip", instrument "QS-6Flex".

## 2. What Mk1 gets

A PCR worksheet is an ordinary Mk1 worksheet whose items are all PCR vials (`assignment_role`
`pcr` or `ster`, or an item whose analyses carry a PCR keyword). The inbox, worksheet
creation, Add samples, analyst assignment, priority, SLA due dates, completion and result
attribution apply unchanged. Added on top:

1. **`ster` classifies as PCR** in `src/lib/worksheet-kind.ts` and `_ROLE_BENCH_KIND`.
2. **Frozen wells on `worksheet_items`:** `plate_no INTEGER` (1-based), `well_pos INTEGER`
   (0..47, column-major within the bacterial block). NULL = not frozen.
   `POST /worksheets/{id}/freeze-wells` pins every unfrozen item to the well the client laid
   it out in; frozen items are never moved; two items can never share a well (409).
   `DELETE /worksheets/{id}/frozen-wells` releases every well (a deliberate re-layout, with
   an audit row). Both refuse a completed worksheet.
3. **Run settings on `worksheets.bench_config JSON`** (nullable, free-form per bench kind).
   PCR stores `{overage, curve, plate_type, sort_by_order}`. `PUT /worksheets/{id}` accepts
   `bench_config` and replaces it whole.
4. **The plate builder in the frontend** (`src/lib/pcr-plate.ts`), a port of `calc.js`:
   layout with freezing, reagent prep, order groups, the four export layouts. Derived
   figures are never stored.
5. **Dennis's screen inside the flyout** when every item is PCR work: run header (meta,
   run status, run parameters), samples panel beside the plate map(s), one calculation
   panel per plate, notes. The PCR run log rail is the endo rail generalised by kind.
6. **Exports and print:** QuantStudio sample file (one per plate), plate map CSV, well list
   CSV, Preview, Print (one landscape page per plate). Print and the QuantStudio export
   freeze the wells first; Print is recorded like the endo sheet (`printed_at`).
7. **Run status** "Plate Made" and "Ran on QuantStudio" = the existing bulk bench ticks
   over every row. "Ran" stamps the QuantStudio through the existing sole-instrument walk
   (prod: methods 24 and 27 both link only instrument 6, QuantStudio 6 Flex).

Not ported (and why): the CSV/paste intake (the inbox is the intake), the holiday calendar
(SLA engine), run ids (`WS-<id>`), the run-log dialog and cross-run sample search (Mk1's
sample page and the bench-log rail cover it; a well search can ride the frozen wells later),
"Inputted to SENAITE" and "Flag Dennis" (the worksheet flag exists), `+ NTC` (never used),
the JSON backup/restore, the file-batch ordering (no files).

## 3. Rules (must match `calc.js`; the workbook figures are the tests)

```
per well (uL)      MM 10, assay mix 1, IPC mix 2.4, template 6.6 (total 20)
wells              MM = 2N + 4, BAC = N + 2, FUN = N + 2, IPC = 2N + 4     (N = wells on the plate, NPC included)
bulk (uL)          per-well volume x wells of that kind; master mix is never scaled
assay mix parts    F primer 9, R primer 9, probe 5, H2O 77  ->  x bulk BAC / FUN, then x overage
IPC mix parts      IPC 20, IPC DNA 4, H2O 16                ->  x bulk IPC, then x overage
overage            1.4 default, an input on the run
```

Layout: 8 rows x 6 bacterial columns (1-6) = 48 wells; every well mirrors into the fungal
block at column + 6. Fill is column-major, A1..H1 then A2..H2. A plate holds 47 samples
plus the NPC. With sort on: by order number ascending (numeric where possible), samples with
no order number after those with one, the worksheet's own order within an order. Controls
(the NPC) go last on every plate. Order groups are contiguous runs of one order number and
are numbered once across the run.

Freezing: frozen samples keep their (plate, pos). The next free well on a plate is one past
its highest frozen well; a well once issued is never re-issued, even after its sample was
removed. Unfrozen samples fill plate 1's free wells, then plate 2's, then new plates. The
NPC sits at (highest sample well + 1) on every plate that has a sample.

Priority flag = priority expedited or high, or overdue (due before the run date), or due
today. The run date is today in lab time for an open worksheet and the completion day for a
completed one. Due = the SLA engine's `due_at`, as on the endo sheet.

## 4. Data and API

`worksheet_items` + `plate_no INTEGER`, `well_pos INTEGER`; `worksheets` + `bench_config JSON`,
`well_high_water JSON` (the highest well ever frozen per plate, `{"1": 46}`; server-owned: freeze
raises it and rejects a pin at or below it, unfreeze clears it)
(boot ALTERs in `database.py`, models in `models.py`). Additive; nothing existing changes.

`GET /worksheets` and `GET /worksheets/{id}` gain `bench_config` on the worksheet and
`plate_no`, `well_pos` on every item (handlers declare no `response_model`).

`POST /worksheets/{id}/freeze-wells` body `{"wells": [{"item_id", "plate_no", "well_pos"}]}`;
`DELETE /worksheets/{id}/frozen-wells`; `PUT /worksheets/{id}` body gains `bench_config`.

`GET /worksheets/bench-log?kind=pcr` already works; `ster` items now count as PCR.

## 5. Tests

Backend: `ster` classifies as pcr in the bench log; freeze pins only unfrozen items and never
moves a frozen one; a taken well is a 409; unfreeze clears every well with an audit row;
both refuse a completed worksheet; `bench_config` round-trips through PUT and GET; the item
dict carries `plate_no` / `well_pos`.

Frontend: the workbook vectors (48 wells at 1.4x, the blank template at 1.1x, master mix
unscaled, well counts, fractions); layout (column-major and mirror, 47 + NPC puts the NPC in
H6 / H12, 48 samples spill to a complete second plate, order sort and groups); freezing
(frozen wells stay after a re-sort, late additions follow the last frozen well, the NPC is
always last, a removed sample's well is not re-issued, a full plate spills late additions to
the next); exports (well list, plate map, prep rows, QuantStudio file with tab scrubbing and
one file per plate); the print document (one page per plate, escaping).
