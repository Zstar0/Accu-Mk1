# Read-Source Settings, Precedence, and Multi-Page Read-from-Accu-Mk1 — Design

*Created 2026-07-08. Status: **approved design**, ready for implementation plan.*

## Base branch / worktree

Builds on **`feat/registry-read-toggle`** (the existing sample-details read-source toggle, `C:\tmp\Accu-Mk1-panel`), which is itself stacked on PR #50 (debug panel). This feature evolves that work; it is **not** yet merged, so this slice stacks on `feat/registry-read-toggle` (new branch, e.g. `feat/read-source-settings-multipage`). Backend + frontend both live in the Accu-Mk1 repo (`Zstar0/Accu-Mk1`).

## Context & motivation

The Accu-Mk1 dual-write program is making `lims_samples` the canonical local sample record so Mk1 stops reading basic-info live from SENAITE. Today the only read-source control is a **binary, admin-only, per-tab** `sessionStorage` toggle (`registryReadSource`, `read-source.ts`) buried in the sample-details admin debug overlay (`SampleRegistryDebug.tsx`), wired through `useReadSource()`, with a one-directional mk1-only banner (`ReadSourceBanner.tsx`). The single-sample wrapper endpoint `GET /registry/sample/{id}/details` reads the registry with per-field SENAITE fallback.

We want to graduate this into a **real, persisted, org-controllable, multi-page** capability:

- Move the read-source control into **Settings**, persisted server-side, so it can be **turned on for everyone**.
- Roll out **page-by-page** (sample-details first, then the samples-list page).
- Always **label** the current read source on the page ("Read from Accu-Mk1" / "Read from SENAITE").
- Let **any user override** the source per-page via the toggle we already have.
- Keep page loads **fast** by rendering from the registry immediately and **progressively backfilling** SENAITE-only / lagging values (notably analyte info) via background polling.

## Goals

1. A **per-page global default** read-source, persisted in Mk1's existing global `/settings` store, admin-configurable from a Preferences pane.
2. A **per-page, tri-state override** (Follow default / SENAITE / Accu-Mk1) available to **all users**, per-tab.
3. A single **`useEffectiveReadSource(pageKey)`** resolution hook consumed by every read-source-aware page.
4. A **bidirectional read-source label** shown on each such page.
5. The **samples-list page** reads from Accu-Mk1 via a new `GET /registry/samples` endpoint (fast render), with per-row **progressive SENAITE backfill** of analytes / SENAITE-only values.
6. sample-details keeps working, its toggle promoted to a visible page control, and its analytes backfilled from SENAITE progressively (superseding the current guarded-off analytes overlay).

## Non-goals (this slice)

- **Continuous SENAITE→registry freshness sync** for workflow fields (status, etc.). Registry-sourced fields may lag; this is accepted (D3). A future "freshness" slice addresses it.
- **Per-user persisted preference tier.** Explicitly out of scope — global default + per-page override is sufficient. (Mk1 `/settings` is global-only today; per-user would be net-new plumbing.)
- **`coa` overlay from the registry.** Stays SENAITE-sourced/deferred (nested model). Not part of the progressive backfill set for now.
- **Flipping `samples_list` global → Accu-Mk1 for everyone.** The endpoint + wiring ship, but until the freshness slice lands, the samples-list Accu-Mk1 read is a per-page **override/preview** capability. The global default for `samples_list` stays SENAITE.

## Decisions (locked)

- **D1 — Per-page rollout granularity.** The global default is **per-page scoped**, so each page can be flipped to Accu-Mk1 for everyone independently as it earns trust.
- **D2 — Override visibility.** The per-page override is **promoted to a visible page control available to all users** (not just admins in the debug overlay). Changing the *global default* remains admin-only.
- **D3 — Freshness = registry-first + progressive SENAITE backfill.** Accept that registry-sourced fields may lag ("fine to lag"), but **pull analyte info (and other SENAITE-only/live values) by polling SENAITE in the background**, filling in as fetched — mirroring the order-receive rail's per-sample detail pattern. Fast page load; live values stream in.

## Architecture

### 1. Precedence & the effective-source hook (core)

Effective source for a page = **`override ?? globalDefault[pageKey] ?? 'senaite'`**.

- **Global default (per-page):** one `/settings` key `registry_read_source` holding a JSON map, e.g. `{"sample_details":"mk1","samples_list":"senaite"}`. Read via the existing `getSettings` / `['settings']` react-query; written via `updateSetting`. Unknown/missing page keys default to `senaite`.
- **Per-page override:** evolve `read-source.ts` from a single binary value to a **tri-state, per-page** store. `sessionStorage` holds a small map, e.g. `{"sample_details":"mk1"}`; a missing/`null` entry means *follow global*. Per-tab, transient (clears on tab close → falls back to global). Keeps `useSyncExternalStore` for cross-component sync.
- **`useEffectiveReadSource(pageKey)`** returns `{ effective, override, setOverride, globalDefault }`. Single source of truth; pages never read `sessionStorage`/settings directly.

`ReadSource` type stays `'senaite' | 'mk1'`; the override adds a third *unset* state represented as absence of a key (not a new enum value on the resolved `effective`).

### 2. Global-default Preferences pane

- New **"Data Source"** pane in `PreferencesDialog` (follows the `DataPipelinePane` pattern: `getSettings` query → local form → `updateSetting` mutation → invalidate `['settings']`).
- One row per read-source-aware page (`sample-details`, `samples-list`) with a SENAITE / Accu-Mk1 segmented control + explanatory copy ("Applies to all users. Users can override per page.").
- **Gating:** only admins can change the global default. (Reading the resolved value is unrestricted.)

### 3. Read-source label (bidirectional)

- New presentational **`<ReadSourceIndicator source={effective} />`** badge in the page header: **"Read from Accu-Mk1"** / **"Read from SENAITE"**. Shown on every read-source-aware page (both directions — unlike today's mk1-only banner).
- The existing `ReadSourceBanner` "N/M fields from Accu-Mk1" detail is folded in as sample-details subtext / tooltip. `ReadSourceBanner` is superseded.

### 4. sample-details integration

- The `SampleRegistryDebug` segmented control becomes **tri-state** (Follow default / SENAITE / Accu-Mk1) via `useEffectiveReadSource('sample_details')`.
- The override is **also surfaced as a clean, visible page control** next to the indicator so **all users** can override (D2). The admin debug overlay keeps its own copy for diagnostics.
- **Analytes:** when reading from Accu-Mk1, analytes are **backfilled from SENAITE progressively** (see §6), replacing the current "analytes overlay guarded off" deferral (registry `{name, declared_quantity}` shape stays out of the overlay; SENAITE remains the analyte source, just async).
- `sample_uid` stays SENAITE-authoritative (unchanged — keys real SENAITE writes).

### 5. samples-list integration + `GET /registry/samples`

- **Backend:** new `GET /registry/samples` mirroring `/senaite/samples`'s query params and response row shape, sourced from `lims_samples` via a new `registry_rows_to_list()` resolver (analogous to `registry_row_to_display`). Admin-gated like `GET /registry/sample/{id}/details`. Fields the registry lacks are omitted/null and covered by the progressive backfill.
- **Frontend:** the `samples` subsection picks its list fetch (`/registry/samples` vs `/senaite/samples`) from `useEffectiveReadSource('samples_list')`; renders the indicator + tri-state override.
- Registry render is **fast** (local Postgres, no SENAITE round-trip).

### 6. Progressive SENAITE backfill (the D3 mechanism)

Pattern reference: `OrderReceiveSession.tsx` → `SampleRailRow` + `useParentSampleDetails(sampleId)` — each row lazily runs a per-sample `useQuery` (`staleTime: 5 * 60_000`, errors swallowed, `…` placeholder while loading), react-query cache dedupes/prevents refire.

- When a page is showing Accu-Mk1 data, each visible sample independently fetches its **SENAITE-only / live values** (primarily **analytes**; extensible to other lagging fields) via a per-sample query keyed by `sampleId`, and merges them in as they resolve.
- Registry-sourced static basic-info renders immediately; the SENAITE-backed fields show a placeholder, then fill.
- Errors are non-fatal (glanceable, not a save path). `staleTime` + cache keep it cheap and dedupe with any other call for the same sample.
- Applies to **both** samples-list rows and sample-details.

## Data model / storage

- **Global default:** `/settings` row `registry_read_source` = JSON string of `Record<PageKey, 'senaite'|'mk1'>`. No schema migration (KV store already exists).
- **Override:** `sessionStorage['registryReadSource']` migrates from a bare `'senaite'|'mk1'` string to a JSON map `Record<PageKey, 'senaite'|'mk1'>` (missing key = follow global). Back-compat: a legacy bare value is treated as a `sample_details` override on first read, then rewritten.
- **`PageKey`** = `'sample_details' | 'samples_list'` (extensible).

## Access control / gating

| Action | Who |
|---|---|
| Read effective source / view indicator | everyone |
| Per-page override (tri-state toggle) | **everyone** (D2) |
| Change global default (Preferences pane) | **admins only** |
| `GET /registry/sample/{id}/details`, `GET /registry/samples` | admin-gated (unchanged posture) |

**Decision (security-adjacent — needs Handler sign-off):** For D2 to actually work for non-admins, the registry **read** endpoints backing user-visible pages (`GET /registry/sample/{id}/details`, `GET /registry/samples`) must be reachable by the **same authenticated audience that already views those pages**, not admin-only. Rationale + threat model: these are **read-only projections of data the user already sees** on the SENAITE-sourced version of the same page — no new data is exposed, no write path is touched, and no privilege boundary is crossed (same user, same samples, different source). This is a **widening** of the current admin-only posture on those two GETs, so it is called out explicitly for sign-off. The Preferences pane (global-default *write*) stays admin-only. Validate on the isolated stack before prod.

## Freshness & staleness

- Registry-sourced fields render instantly and **may lag** live SENAITE (status/workflow). Accepted (D3).
- The **label makes provenance explicit**, and the **progressive SENAITE backfill** keeps analytes/live values current on-screen.
- The **global default for `samples_list` stays SENAITE** until a future freshness slice; Accu-Mk1 on the list is reached via per-page override for validation/preview.

## ISO 17025 alignment

- **Data provenance / transparency (cl. 7.5, 7.11):** the always-on read-source label ensures a viewer can never be ambiguous about whether displayed data came from the authoritative LIMS (SENAITE) or the local registry projection — supporting traceability of reported values.
- **No alteration of authoritative records:** this feature is **read-only**. It never writes to SENAITE or to published/authoritative records; `sample_uid` and all write paths remain SENAITE-authoritative. The registry is a local read projection.
- **Known-lag disclosure:** registry-sourced fields that can lag are disclosed via the label + progressive backfill, avoiding silent presentation of stale workflow state as current.

## Testing strategy

- **Precedence resolution** — matrix over {override set/unset} × {global mk1/senaite/absent} × page keys → correct `effective`.
- **Tri-state override store** — set/clear per page; legacy bare-value migration; cross-component sync.
- **`ReadSourceIndicator`** — renders both directions.
- **`GET /registry/samples`** — registry hit/miss, gating, param passthrough, response-shape parity with `/senaite/samples`, field mapping via `registry_rows_to_list()`.
- **Progressive backfill** — row renders before SENAITE resolves (placeholder), then analytes fill; errors swallowed; no refire within `staleTime`.
- **Preferences pane** — save writes `registry_read_source` map; admin gating.

## Suggested build order (for the plan)

1. Precedence core: per-page tri-state override + global-default map + `useEffectiveReadSource(pageKey)` (+ legacy migration).
2. `ReadSourceIndicator` + fold in the mk1 banner.
3. Preferences "Data Source" pane (global defaults, admin-gated).
4. sample-details: tri-state override as visible control + indicator + analytes progressive backfill.
5. Backend `GET /registry/samples` + `registry_rows_to_list()` resolver (+ tests).
6. samples-list: source switch + indicator + override + per-row progressive backfill.

## Open items to confirm in planning

- The concrete field set the samples-list shows (drives `registry_rows_to_list()` mapping) — resolve against the live `/senaite/samples` response shape.
- Placement/styling of the visible override control + indicator in each page header (small badge + segmented control).
- The exact SENAITE-only field set for progressive backfill beyond analytes (if any).

## Needs Handler sign-off before prod

- Widening `GET /registry/sample/{id}/details` and `GET /registry/samples` from admin-only to the authenticated page audience (see Access control). Read-only, same-audience, but an explicit posture change.
