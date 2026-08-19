# Methods Foundation — generic analytical methods + local instruments (slice 1)

*Designed 2026-08-19 with the Handler. Slice 1 of the methods/instruments program:
foundation only — the bench stamping UX is slice 2, the controlled-document
lifecycle is slice 3, instrument calibration logs are a later program.
Mk1-only; no wire, IS, WP, SENAITE, or COABuilder changes.*

## 1. Problem

New test families (Heavy Metals live on arcitest; Moisture, USP <71> behind it)
have no method or instrument representation:

- `hplc_methods` stores HPLC **run parameters** (`size_peptide`,
  `starting_organic_pct`, `temperature_mct_c`, `dissolution`) — not documented
  analytical procedures. There is nowhere to record "AM-ELEM-001, ICP-MS per
  USP <232>/<233>".
- Method resolution is peptide-keyed: the worksheet drawer derives method from
  instrument + peptide (`WorksheetDrawerItems.tsx:322` — "computed from
  instrument+peptide"), so an HM row shows `—`.
- Instruments have **no local create path**: only `GET /instruments` and
  `POST /instruments/sync` (SENAITE) exist (`main.py:3269,3276`); the
  Instruments page is a sync viewer. An ICP-MS or KF titrator cannot be added.
- Native `lims_analyses` rows carry `method_id`/`instrument_id` NULL, so the
  COA Method column is blank and there is no run traceability — the ISO 17025
  alignment gap ([[project_iso17025_alignment]]).

## 2. As-is facts (verified 2026-08-19 against the arcitest composition)

Cite these; don't re-derive.

- **The traceability chain already exists and is starved at the source.**
  `PATCH /api/lims-analyses/{id}/method-instrument`
  (`lims_analyses/routes.py:470`) → `service.set_method_instrument`
  (audit transition, Phase 3.6, `service.py:600`). `promote_to_parent` carries
  `method_id`/`instrument_id` to the parent row (`routes.py:546`). The COA
  native-sections builder prints the method name per row
  (`coa/native_sections.py:117` `_method_label`). **Nothing in this slice
  touches that chain; it only makes rows worth stamping.**
- Methods have full **local CRUD**: GET/POST/PUT/DELETE `/hplc/methods`
  (`main.py:4105–4161`). `MethodsPage.tsx` is a full CRUD UI with
  per-instrument tabs; `MethodPanel.tsx` assigns peptides (via
  `updatePeptide(method_ids)`) and instruments.
- **No live SENAITE method sync exists** — no `/hplc/methods/sync`;
  `senaite_id` is clone-time provenance only. So methods need NO
  `local_overrides` non-destructive-sync machinery (unlike
  `analysis_services`, `models.py:216–221`). A simple `origin` provenance
  column suffices.
- `instruments` is already nearly generic: free-string `instrument_type`,
  `brand`, `model`, `active`, m2m `instrument_methods` (models.py:153–175).
  `POST /instruments/sync` matches on `senaite_id` (verify match key at plan
  time before relying on rename-safety).
- Existing m2m tables `instrument_methods` (instrument ↔ method, kept and
  reused) and `peptide_methods` (peptide ↔ method, **untouched** — the HPLC
  resolution path keeps working exactly as today).
- `department_id` FK idiom exists on services, vial roles, etc.
  (`models.py:211` and siblings).
- 🔴 **Latent hazard fixed by this slice:** `DELETE /hplc/methods/{id}`
  (`main.py:4161`) has zero referential guard while
  `lims_analyses.method_id` is `ON DELETE SET NULL` — deleting a stamped
  method silently erases traceability from every historical result.

## 3. Rulings already made (Handler, 2026-08-19 session)

- **R1 — extend `hplc_methods` in place; no second methods table.** Every
  consumer (analyses FK, promote, COA label, `instrument_methods`) points at
  it; a parallel table would force union reads at each — the silent-miss class
  the vial-roles work deliberately avoided. The table name stays legacy (house
  precedent: `lims_` prefix). UI concept name is "Method".
- **R2 — methods anchor to analysis services, never to profiles.**
  `method_services` m2m. A profile's method is *derived* through its members
  (pH sold two ways = one service, one method, always right; BacWater panel =
  three measurements, three possible methods). Profile-level "Method:" text on
  the COA remains `analysis_profiles.coa_method_text` (display string, #106);
  no stored method↔profile edge, ever.
- **R3 — one *default* method per service; a service may link many methods.**
  Picker (slice 2) shows every active linked method with the default
  pre-selected; the stamped `method_id` records what was actually used, not
  the default.
- **R4 — method revision = new row** (`supersedes_id`), never mutation of a
  used row. Historical analyses then pin the exact version forever through the
  existing FK. Full lifecycle (status enum, immutability, attachments) is
  slice 3; slice 1 only seeds `supersedes_id` and keeps `active` as the sole
  lifecycle switch.

## 4. Design

### 4.1 Schema — additive columns on `hplc_methods`

| Column | Type | Notes |
|---|---|---|
| `code` | VARCHAR(50) NULL | controlled-doc id, e.g. `AM-ELEM-001`. Partial unique index `WHERE code IS NOT NULL`. |
| `technique` | VARCHAR(100) NULL | free string, mirrors `instruments.instrument_type` (`ICP-MS`, `KF`, `PCR`, `HPLC`…). |
| `department_id` | INT NULL FK departments ON DELETE SET NULL | picker scoping. |
| `reference` | VARCHAR(500) NULL | compendial citation (`USP <232>/<233>`). |
| `procedure_summary` | TEXT NULL | the "place to start documenting" — full doc lifecycle is slice 3. |
| `supersedes_id` | INT NULL FK hplc_methods(id) ON DELETE SET NULL | version chain seed. |
| `origin` | VARCHAR NOT NULL | backfill `'senaite'` where `senaite_id IS NOT NULL` else `'mk1'`; new rows `'mk1'`. Provenance only — no sync guard needed (§2). |

Backfill: `technique = 'HPLC'` on all existing rows (the table has only ever
held HPLC methods). Existing HPLC columns stay nullable and are simply
meaningless for other techniques. Migration via the `database.py`
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` idiom (cf. `database.py:1467`) +
`CREATE TABLE IF NOT EXISTS method_services` — idempotent, additive only.

### 4.2 Schema — new `method_services` join

```
method_services(
  id PK,
  method_id INT NOT NULL FK hplc_methods ON DELETE CASCADE,
  analysis_service_id INT NOT NULL FK analysis_services ON DELETE CASCADE,
  is_default BOOL NOT NULL DEFAULT false,
  created_at, updated_at
)
UNIQUE (method_id, analysis_service_id)
UNIQUE partial: (analysis_service_id) WHERE is_default        -- one default per service
```

Resolution rule (consumed by slice 2, defined here): a service's effective
default = its `is_default` row **whose method is `active`**; a default
pointing at a deactivated method resolves to *no default* (fail-open to an
unfiltered picker — deactivation must never block the bench or force admin
cleanup first).

### 4.3 API

- `MethodCreate` / `MethodUpdate` (`PUT /hplc/methods/{id}`) /
  `MethodResponse` gain the §4.1 fields (`origin` read-only, derived at
  create).
- **`GET /hplc/methods/{id}/services`** and **`PUT …/services`** with
  `[{analysis_service_id, is_default}]` — mirror the profile-members PUT
  (replace-set semantics, one transaction). PUT enforces one-default-per-
  service at the route edge (clear 400 naming the conflicting method) — the
  partial unique index is the backstop.
- `MethodResponse` gains `services: [{id, keyword, title, is_default}]`;
  `AnalysisServiceResponse` gains read-only `default_method_id` (cheap join,
  the hook slice 2's picker reads). `default_method_id` applies the §4.2
  resolution rule — it is NULL when the default row's method is inactive, so
  every consumer inherits fail-open behavior for free.
- **`DELETE /hplc/methods/{id}` gains the referential guard**: 409 when any
  `lims_analyses` row references the method ("deactivate instead" in the
  message; same protection class as keyword-immutability-once-referenced).
  `method_services` rows still cascade on legitimate deletes of never-used
  methods.
- **Instruments become locally manageable**: `POST /instruments`,
  `PATCH /instruments/{id}` (name unique guard; all fields editable; `active`
  flip = retire). New nullable `department_id` column + `origin` derived from
  `senaite_id` exactly as methods. `/instruments/sync` behavior unchanged.

### 4.4 FE

- **MethodsPage / MethodPanel**: create + edit gain Code, Technique,
  Department, Reference, Procedure summary; the card face shows `code` +
  `technique` chips. MethodPanel gains a **Covered services** block —
  add/remove services with a per-row Default toggle — mirroring its existing
  peptide-assignment pattern. Existing instrument-linking and peptide blocks
  unchanged. Non-HPLC methods simply leave the HPLC parameter fields blank
  (group them under an "HPLC parameters" subsection so a KF method's form
  isn't dominated by gradient fields).
- **InstrumentsPage**: Add Instrument + edit (name / type / brand / model /
  department / active). Sync button and behavior kept; page copy updated
  ("synced from SENAITE" → provenance shown per row via `origin`).

### 4.5 Explicit non-goals (this slice)

- No worksheet/bench stamping UX, no picker, no seeding of defaults onto rows
  (slice 2). No status enum / immutability / attachments / supersede UI
  (slice 3). No calibration or maintenance logs. No per-matrix defaults
  (deliberately deferred; the per-run override covers it). No change to
  `peptide_methods`, the HPLC drawer derivation, `prep_bridge`, COA wire,
  `coa_method_text`, IS, WP, or SENAITE. No rename of `hplc_methods`.

## 5. Failure modes addressed

| Mode | Control |
|---|---|
| Delete a stamped method → historical traceability silently nulled | DELETE 409 referential guard (§4.3) |
| Two defaults for one service | partial unique index + route-edge 400 |
| Default points at deactivated method → bench blocked | fail-open resolution rule (§4.2) |
| Duplicate controlled-doc codes | partial unique on `code` |
| SENAITE sync clobbers local edits | methods: no live sync exists (§2); instruments: sync matches `senaite_id` — verify at plan time, guard if wrong |

## 6. Acceptance (arcitest, end of slice)

1. Create instrument "Agilent 7900 ICP-MS" (type `ICP-MS`, department Heavy
   Metals) via the UI — no SENAITE involved.
2. Create method `AM-ELEM-001` (technique `ICP-MS`, reference
   `USP <232>/<233>`, procedure summary filled), link the four HM services
   with Default on, link the instrument.
3. `PUT …/services` attempting a second default for `LEAD-PPM` → 400.
4. Stamp one HM analysis on P-0157 via the **existing**
   `PATCH /method-instrument` → audit transition written; promote → parent row
   carries both; (once the profile is armed) the COA Method column prints
   `AM-ELEM-001`'s name — proving the foundation feeds the existing chain with
   zero slice-2 code.
5. `DELETE` on the now-referenced method → 409.
6. Existing HPLC flows untouched: drawer derivation, MethodsPage HPLC fields,
   `peptide_methods`, prep bridge — regression suites green by failure-set
   diff.

## 7. Follow-ups ledgered (not this slice)

- **Slice 2 — bench stamping:** worksheet flyout method+instrument pickers for
  non-HPLC lanes, worksheet-level "apply to all items", defaults from
  `default_method_id`; ruling needed there: stamp at assignment vs result
  entry (lean: result entry, default pre-selected).
- **Slice 3 — controlled documents:** status enum (draft/active/retired)
  reconciled with `active`, immutable published versions, supersede UI,
  method attachments, `coa_method_text` auto-suggest from members' derived
  methods.
- Instrument calibration/maintenance event log (separate from HPLC
  `calibration_curves`).
- Per-matrix method defaults if a real case appears.
