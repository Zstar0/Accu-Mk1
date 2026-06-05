# Result Type & Options on Analysis Services — Design

*Created 2026-06-04.*

## Purpose

Mk1-native (Model D) vial analyses carry only a free-text result, because the
result *type* (numeric / dropdown / text) and the dropdown *options* live on the
SENAITE Analysis Service and were never synced into Mk1. Result: a sterility
result that should be a **Conforms / Does Not Conform** dropdown accepts a raw
number on a native AR. This design stores each service's result type + options
locally, surfaces them to the result-entry cell, and adds a management UI so the
lab can curate them.

## Decisions (locked in brainstorming)

1. **Local wins.** The SENAITE service sync only *seeds* `result_type`/
   `result_options` when the local value is NULL. Once set — by a prior sync or a
   manual edit — re-sync never overwrites. Local `analysis_services` is the source
   of truth, matching the Mk1-replaces-SENAITE direction.
2. **Mirror all SENAITE types (full fidelity in storage).** `result_type` stores
   SENAITE's value verbatim (`numeric`, `select`, `multiselect`, `string`, or
   anything else) — no enum constraint. The result cell renders the common types
   and falls back to a text input for anything unrecognized, so storage never
   loses fidelity even if rendering hasn't caught up.
3. **Multiselect rendering deferred.** `multiselect` is stored and manageable
   (you can set the type and define options), but the result-entry cell renders
   it as a **text input** for now. Proper multi-select rendering is a follow-up.

## Architecture

Data flows in one direction at read time:
`analysis_services` (result_type + options) → Mk1 senaite-shape response
(`result_options`, `result_type`) → `EditableResultCell` renders the right input.

Local authority is enforced at the single sync write site (seed-when-NULL). The
management UI writes directly to `analysis_services` via a new PATCH endpoint;
because that sets the columns non-NULL, the row becomes sync-immune automatically
(no separate "overridden" flag needed).

## Components

### 1. Schema (`backend/models.py` + `backend/database.py`)

Two additive columns on `AnalysisService` / `analysis_services`:
- `result_type: Optional[str]` — `Text`, nullable. SENAITE's ResultType verbatim.
- `result_options: Optional[list]` — `JSON`/`JSONB`, nullable. List of
  `{"value": str, "label": str}` — matching the existing `SenaiteShapeResultOption`
  shape (value + label) so it passes straight through to the response. Meaningful
  only for select/multiselect types.

Idempotent migration in `database.py`'s lightweight-migrations block:
```sql
ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS result_type TEXT
ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS result_options JSONB
```

### 2. Sync — seed only (`backend/main.py` `sync_analysis_services`, ~2503/2579)

For each SENAITE service, parse `ResultType` and `ResultOptions` (reuse the parse
at main.py:10623 — maps `ResultValue→value`, `ResultText→label`). When upserting
the local row:
- **New row:** set `result_type` + `result_options` from SENAITE.
- **Existing row:** set them **only if the local `result_type` is NULL** (seed the
  gap); otherwise leave both untouched.

This is the only place local-wins is enforced.

### 3. Response wiring (`backend/lims_analyses/`)

- `SenaiteShapeAnalysisResponse` (schemas.py): add `result_type: Optional[str] = None`.
  (`result_options: List[SenaiteShapeResultOption]` already exists.)
- `list_analyses_in_senaite_shape` (service.py:~563, currently `result_options=[]`):
  join each row's `analysis_service` and populate `result_type` +
  `result_options` from it. Map the stored `{value, text}` JSON to
  `SenaiteShapeResultOption`. Bulk-load the services (one query) to avoid N+1.

### 4. Result-entry rendering (`src/components/senaite/AnalysisTable.tsx` `EditableResultCell`)

Render by `analysis.result_type`:
- `numeric` → number input
- `select` → dropdown from `result_options` (already supported)
- `string` → text input
- `multiselect` → **text input (deferred)**
- missing / unrecognized → **text input (fallback)**

Add `result_type` to the FE `SenaiteAnalysis` type (`src/lib/api.ts`).

### 5. Management UI (`src/components/hplc/AnalysisServicesPage.tsx` flyout)

A new section in the service detail flyout, beside the existing peptide editor:
- **Result Type** — an editable select (numeric / select / multiselect / string),
  free-typeable to accept exotic SENAITE values.
- **Result Options** — an add / remove / edit list of `{value, label}` rows. Shown
  only when result_type is `select` or `multiselect`. Each row: a value input + a
  label input + a remove button; an "Add option" button.
- **Save** button (explicit — a list shouldn't save per-keystroke) → new endpoint.
  On save, the flyout refreshes the service.

New endpoint: `PATCH /analysis-services/{id}/result-type` taking
`{result_type: str|null, result_options: list|null}`, updating the row, returning
the updated service. Mirrors the existing `updateAnalysisServicePeptide` pattern.

Extract the options editor as a focused component (e.g. `ResultOptionsEditor`) so
it's testable independently of the large page.

## Data flow example (sterility)

1. Sync (or manual edit) sets STER-PCR service: `result_type='select'`,
   `result_options=[{value:'1',label:'Conforms'},{value:'0',label:'Does Not Conform'}]`.
2. A native ster vial's senaite-shape row now carries those options + type.
3. `EditableResultCell` sees `result_type='select'` → renders the dropdown.
4. Tech picks "Conforms"; the stored result_value is `1` (or the chosen value).

## Testing

**Backend:**
- Sync seed-when-NULL: seeds a service with NULL result_type; does NOT overwrite a
  service that already has one (local-wins).
- `list_analyses_in_senaite_shape` carries `result_type` + `result_options` from
  the joined service (and `[]`/None when the service has none).
- `PATCH /analysis-services/{id}/result-type` updates the row and returns it.

**Frontend:**
- `ResultOptionsEditor`: add / edit / remove rows; emits the expected
  `{value, label}[]`.
- `EditableResultCell` rendering: `select` → dropdown with options; `numeric` →
  number input; `multiselect` / unknown → text fallback.

## Build order

1. Schema (columns + migration).
2. Sync seed-only logic.
3. Response wiring (`result_type` on the shape + populate from service).
   **— at this point a re-sync makes the sterility dropdown work end-to-end.**
4. Cell rendering by type.
5. Management UI + PATCH endpoint.

## Out of scope

- Multiselect *rendering* (stored/managed, rendered as text for now).
- Two-way sync / pushing local edits back to SENAITE.
- A per-field "overridden" flag (non-NULL = locally authoritative is sufficient).
- Result validation rules / ranges (separate concern).
- Bulk editing result types across many services.
