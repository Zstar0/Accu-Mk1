# Productionize Accu-Mk1-as-default: registry-owned analytes, slim SENAITE refresh, provenance icons

*2026-07-08. Approved in brainstorm (Handler). Stacks on `feat/read-source-settings-multipage` (PR #52).*

## Goal

Make read-from-Accu-Mk1 safe and cheap enough to become the prod default on both the
samples list and sample details. The load win is on the **samples list**: after this
phase, a list page load in mk1 mode costs SENAITE **one catalog-only query, zero
object wake-ups**. Today it fires a full `complete=yes` hydration of every listed row
— *more* total SENAITE work than SENAITE mode, which is the blocker for the flip.

**Explicitly out of scope**

- The prod default flip itself. It stays a manual admin-UI action (Preferences → Data
  Source), gated on the dual-write prod chain: Mk1 #46 deploy → prod basic-info
  backfill → IS deploy + `ACCUMK1_*` env → re-sweep. Prod `lims_samples` is sparse
  until backfilled; flipping before that shows a subset list.
- Details-page SENAITE cost. The details endpoint keeps its full SENAITE lookup
  (analyses, remarks, attachments, COA live only there). Decided: the win is the list.
- Parent-shadow analysis rows (`lims_analyses` parent records) — separate deferred
  project; nothing here prejudges it.

## Decision record (from brainstorm)

- **Option A chosen: analytes become registry-owned.** `lims_samples.analytes` (flat
  JSON slot list) is already written by IS at order time and by
  `_populate_basic_info` on every refresh/backfill. The only Mk1-side mutation of
  `Analyte{N}Peptide` is `replace_analyte` (`backend/main.py:8835`, verified by grep)
  — close that gap and the column can't go stale through any Mk1 code path.
- **No SENAITE-side changes** (catalog metadata columns were rejected: Zope-side work
  on a system being phased out).
- **Spike result (2026-07-08, registry stack, live):** a no-`complete` jsonapi listing
  returns catalog brains with `review_state`, `id`, `uid`, `getClientTitle`,
  `getClientOrderNumber`, `getDateReceived`, `getDateSampled`, `getSampleTypeTitle`,
  `created` — everything `_item_to_model` reads **except** `Analyte{N}Peptide` and
  `VerificationCode`. The slim path can reuse `_item_to_model` unchanged.

## Design

### 1. Replace dual-write (backend)

At the end of `replace_analyte` (after the `replace_analyte_slot` re-mirror step),
call `_refresh_parent_from_senaite(db, row)` + commit, **best-effort**: wrap in
try/except, log a warning on failure, never fail the request (same posture as the
endpoint's IS-proxy step). Re-reading SENAITE truth (rather than trusting in-memory
state) makes the write self-healing — whatever Replace actually landed is what the
registry gets, including the analytes JSON, via the canonical `_populate_basic_info`.

The endpoint already loads the `LimsSample` row (`main.py` ~8803); reuse it.

### 2. Slim listing (backend)

`slim: bool = False` query param on the existing `GET /senaite/samples` handler —
a param, **not** a second endpoint: the review-state/multi-state/search/sub-sample
filter logic is shared and must not fork. When `slim=true`, omit `complete: "yes"`
from `base_params`. Everything else (params, `_item_to_model`, response model) is
unchanged — per the spike, catalog brains feed `_item_to_model` fine; `analytes`
comes back `[]` and `verification_code` `None`, which the sole caller ignores.
SENAITE-mode callers never pass `slim`.

### 3. Details-overlay `review_state` correction (backend)

Found during exploration: `GET /registry/sample/{id}/details` overlays registry
`status` **over** the live SENAITE `review_state` it just fetched — stale-over-fresh,
violating the field-ownership principle (workflow state is SENAITE-owned until
receive/verify/publish move natively). Remove `review_state` from `OVERLAY_FIELDS`
and `registry_row_to_display`; the live SENAITE value stands and `field_sources` no
longer carries a `review_state` key (the FE treats absent as SENAITE-sourced).
Branch-local behavior change — this feature lineage is not deployed to prod.

### 4. Frontend refresh slimming

`startBackgroundRefresh` (`src/components/senaite/SenaiteDashboard.tsx`) calls the
slim variant (extend `getSenaiteSamples` in `src/lib/api.ts` with an optional
trailing `slim?: boolean` arg — no separate wrapper) and merges **`review_state` only** — analytes leave the
merge, the registry is authoritative for them. Single-batched-call discipline,
request-id superseding, and swallow-on-failure stay exactly as-is.

### 5. Provenance icons (mk1 mode only; zero visual change in SENAITE mode)

- **List:** the **Status column header** gets a small SENAITE glyph — post-phase it
  is the only SENAITE-pulled thing on the list (the handoff's "2 columns" became 1
  when analytes went registry-owned). Rich tooltip (shadcn sectioned font-mono card,
  per `docs/developer/ui-patterns.md` house style): live from SENAITE, refreshed each
  page load.
- **Details:** per-field glyph beside each basic-info field whose `field_sources`
  entry is `senaite` (registry-null fallbacks, `analytes`, and `review_state` via
  the absent-key rule above). Driven by one explicit FE const map from rendered
  field → `field_sources` key (the keys are `SenaiteLookupResult` names: `client`,
  `contact`, `client_lot`, …). Rich tooltip carries the field's source and why.
- One shared presentational **`FieldSourceGlyph`** component, props-only,
  unit-testable like `ReadSourceBanner`.

### Data flow after the phase (mk1 list page load)

1. `GET /registry/samples` — fast paint, all columns including analytes (registry).
2. `GET /senaite/samples?slim=true` — one catalog-only query, no object wake-ups.
3. Merge `review_state` by id over the committed baseline. Done.

## Error handling & drift posture

- Slim fetch fails → registry render stands (existing catch).
- Replace's registry refresh fails → warning logged; list shows the old analyte until
  repair (debug-panel refresh button, or the backfill/re-sweep script); SENAITE mode
  is one toggle away as the escape hatch.
- **Accepted residual drift:** direct-in-SENAITE analyte edits bypassing Mk1's
  Replace endpoint (ZODB console, raw jsonapi). No code path catches those; repair
  paths above. Named and accepted.

## Testing

- **Backend:** `slim=true` sends no `complete` param to SENAITE and passes
  `review_state` through (mock transport asserting outbound params);
  `replace_analyte` updates `lims_samples.analytes` post-replace (extend existing
  replace fixtures) and stays non-fatal when the refresh raises; details endpoint no
  longer overlays `review_state` (update `OVERLAY_FIELDS` coverage tests in
  `tests/test_registry_read*.py`).
- **Frontend:** refresh merge is `review_state`-only (update
  `SenaiteDashboard.readsource.test.tsx`); `FieldSourceGlyph` renders per
  `field_sources` including the absent-key=senaite rule; list header glyph appears
  only in mk1 mode. `npm run typecheck` clean.
- **Stack eyeball:** on the `registry` stack, Replace an analyte and watch the list
  show the new analyte from the registry alone (SENAITE refresh merges only status);
  confirm one slim call per page load in backend logs.

## ISO 17025 alignment

Provenance icons make the data source of every displayed basic-info field explicit
(registry vs live LIMS), supporting data-integrity/traceability expectations (clause
7.5 technical records, 7.11 data control). The Replace dual-write keeps the
registry's declared-analyte record consistent with the executed change, with the
drift-repair paths documented above.

## Execution shape

Same as the read-source feature: subagent-driven with per-task spec+quality review,
final opus whole-branch review, validate on the `registry` stack before PR. New
branch stacks on `feat/read-source-settings-multipage` @ `96a296e`.
