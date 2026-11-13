# Endotoxin worksheet v2: layout and number parity with Dennis's tool

Checked 2026-10-11 on the devbox stack `endov2` (branch `feat/endo-worksheet-v2`) against Dennis's
endotoxin log (`tools-dennis/tools/endotoxin-log` at `5ef2a62`, run locally from a scratch copy).

## How it was checked

Both tools were given the same run: worksheet 24 "UAT endo 2 mL run" in Mk1 and a run dated 2026-10-10 in
Dennis's tool, with the same seven samples, declared weights, one non-standard total and the same readings.
The comparison was measured in the browser at a 1920 px viewport (box order, captions, column order and
widths, type, computed numbers) rather than judged from screenshots, because the in-app browser pane scales an
emulated 1920 px page down too far to read.

| Sample | Declared wt | Total | Reading |
|---|---|---|---|
| P-0147-S02 (BPC-157) | 10 mg | 1:250 | <0.05 |
| P-0152-S02 (BPC-157) | 5 mg | 1:500 | 0.8 |
| P-0153-S02 (BPC-157) | 2 mg | 1:250 | <0.05 |
| P-0155-S02 (BPC-157) | 20 mg | 1:250 | <0.05 |
| PB-0077-S02 (KPV) | 10 mg | 1:250 | <0.05 |
| PB-0078-S02 (KPV) | 5 mg | 1:250 | 0.3 |
| BW-0015-S04 (bac water) | n/a | 1:20 | <0.2 |

## Numbers: identical

Every computed value matches row for row: vial concentration, MVD (3500x), MVC, Box 2 step volumes, groups
and row order (the 1:500 row after the 1:250 group, bac water last), Loaded, EU/mg, LOD, LOQ (25 EU/vial at
1:250, 50 at 1:500, 0.2/mL for bac water), EU/vial, limit, verdict and the Accu-Mk1 value (for example
P-0152-S02: 160 EU/mg, 800 EU/vial, Fail; PB-0078-S02: 30 EU/mg, 150 EU/vial, Pass).

The verdict differs only on P-0153-S02 and P-0155-S02: Mk1 holds an imported reader record for each that
failed spike recovery (40 %) or spike CV (30 %), so Mk1 reads Invalid; Dennis's tool has no record for a typed
reading, so it reads Pass. Expected.

## Chrome: identical

Box order and titles (a colon where Dennis uses a dash, house style), box border and 5 px radius, box titles and
table headers (9.5 px, weight 600, uppercase, same letter spacing), Box 2 column widths within about one
percentage point, Box 3 column order.

## Differences and what happened to each

| # | Difference | Outcome |
|---|---|---|
| 1 | Bac water rows were first in Mk1's Box 1 and Box 3 (Mk1 orders by due and priority); Dennis puts them last | Fixed (`767c979a`): last on every 2 mL surface, stock order unchanged |
| 2 | Mk1's 2 mL Calculations legend still showed the stock formulas | Fixed (`767c979a`): Dennis's 2 mL legend, numbers from the method |
| 3 | Box 1 sub-text lacked "(2 mL standard)" | Fixed (`767c979a`) |
| 4 | Header names "Water" and "Reading" vs "Reconstitution water" and "Result as read" | Fixed (`767c979a`) |
| 5 | MVD and MVC sit under the cartridge picker, not in their own columns | Accepted (spec 6.1, ruled in the plan) |
| 6 | Mk1 keeps its Status and Flag columns; no Accmk1 tick column | Accepted (Mk1 workflow) |
| 7 | Box 3's cartridge is shown, not picked (the picker is Box 1's) | Accepted (ruled in the plan) |
| 8 | Due date from the SLA clock, not "+3 business days" | Accepted (Handler ruling, v1) |
| 9 | Body text 13 px in Mk1 vs 12.5 px in Dennis's Boxes 2 and 3 | Accepted by default; the Handler can ask for a pixel match |
| 10 | At 1920 px the sheet was 1456 px wide in Mk1 vs 1603 px in Dennis's tool (app sidebar plus run log rail) | Fixed (`d2fac12b`): the run log folds to a strip, remembered per browser |
| 11 | Mk1's dropdowns opened the operating system's white list | Fixed (`2464d8ed`): every endo dropdown uses the app's Select, as the Analyst picker does |

## UAT

To be recorded here after the Handler's and Dennis's click-through on the stack.
