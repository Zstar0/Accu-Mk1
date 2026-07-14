# Workflow State System — Catalog, Native Transition Log, and Admin Page

**Date:** 2026-07-12
**Status:** Approved (Handler, 2026-07-12)
**Program:** SENAITE phase-out, slice 3 (after basic-info ✅ and parent-analysis mirror ✅, both live in prod as of Mk1 1.2.0)
**Branch:** `feat/state-system-mirror` off `origin/master` `8856e28` (= prod v1.2.0)

## 1. Context and program position

The phase-out program mirrors each SENAITE data section into Accu-Mk1 as a
read-dormant native record while SENAITE remains system-of-record. Slices 1–2
gave us current-state coverage; this slice makes the *state system itself*
native: the workflow definitions (states, paths, requirements) as first-class
editable data, and a complete transition log in the Mk1 DB.

What exists today (the substrate):

| Layer | Current state | Transition history | Definition (states/paths/rules) |
|---|---|---|---|
| Sample | `lims_samples.status` (mirrored + reconciled) | `sample_status_events` — **IS DB**, fed by SENAITE pushing status changes to IS | implicit in SENAITE + scattered Mk1 literals |
| Parent analysis | `mirror_review_state` shadow rows | `lims_analysis_transitions` (Mk1-initiated events only) | hardcoded CHECK + reader allow-lists |
| Sub-sample analysis | native `review_state` | `lims_analysis_transitions` | hardcoded CHECK + allow-lists |

Observed prod sample-state universe (2026-07-11): `published`, `sample_due`,
`sample_received`, `cancelled`, `verified`, `to_be_verified`,
`waiting_for_addon_results`, `invalid`, `ready_for_initial_review`,
`dispatched`. Two of these (`waiting_for_addon_results`,
`ready_for_initial_review`) are custom Accumark extensions — the workflow is
already beyond stock SENAITE, which is part of why a data-driven catalog is
needed.

## 2. Goals

1. **Workflow catalog** — states and transitions for BOTH scopes (sample +
   analysis) as editable data: slug, label, description, category, and
   machine-checkable **requirements** per transition.
2. **Complete transition logging in the Mk1 DB** — every sample transition
   (new `lims_sample_transitions`) and every analysis transition (existing
   `lims_analysis_transitions`, coverage gap closed by a passive drift
   observer), each row carrying verb, from→to, source, actor when known, and
   real timestamp.
3. **Historical seed** — one-time backfill of sample transition history from
   the IS `sample_status_events` stream.
4. **Admin Settings page** — React Flow graph of paths through the states,
   per-state/per-transition descriptions and requirements, full CRUD with
   guardrails.

## 3. Non-goals (later, separately-gated slices)

- **Enforcement.** Requirements evaluate nothing in this slice; they render as
  documentation. The catalog *drives* no live behavior.
- **Read-flip / authority swap.** All live state reads keep sourcing what they
  source today. Existing DB CHECK constraints stay untouched as the hard
  floor; the catalog is a descriptive layer above them.
- **Mk1→IS feed inversion** (see §7) — designed for, not built.
- Per-sample timeline UI on sample-details (the log makes it trivial later).

## 4. Handler decisions (locked 2026-07-12)

1. Unified catalog covering **both scopes** (`entity_scope: sample|analysis`),
   one settings page with a scope switcher.
2. Requirements are **machine-checkable structured entries** from day one,
   **enforcing nothing** until the authority swap. Role-gating folds in as a
   requirement kind (`role_at_least`) — no separate permission machinery.
3. Sample history **seeded from the IS event stream** (no SENAITE crawl).
4. **Editing is live immediately** (admin-only): edits affect only the
   catalog (documentation) until the swap. Built-in/in-use states are
   deactivate-not-delete; new custom states badge "defined — not yet
   reachable".
5. **React Flow** (`@xyflow/react`) for the graph, lazy-loaded; editing is
   form-driven (no drag-to-connect in v1).
6. SENAITE-side sample transitions captured via **IS-stream incremental
   sync** (not reconcile-only); reconcile stays as last-resort drift catcher.
7. **Passive analysis drift observer** folded into this slice (§6.4).
8. Direction inversion noted as a design constraint: near disconnect,
   **Accu-Mk1 will feed events to IS** (which still drives WordPress customer
   status); today's IS→Mk1 puller must be cleanly retirable.

## 5. Data model (all additive; `lims_` prefix; idempotent `database.py` migrations)

### 5.1 `lims_workflow_states`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `entity_scope` | TEXT NOT NULL | `'sample'` \| `'analysis'` (CHECK) |
| `slug` | TEXT NOT NULL | e.g. `sample_received`, `to_be_verified` |
| `label` | TEXT NOT NULL | display name |
| `description` | TEXT | shown on the page |
| `category` | TEXT NOT NULL DEFAULT `'active'` | `'active'` \| `'terminal'` \| `'exception'` (CHECK) — drives node color |
| `color` | TEXT | optional override |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | |
| `is_builtin` | BOOLEAN NOT NULL DEFAULT FALSE | seeded rows; blocks hard-delete |
| `is_active` | BOOLEAN NOT NULL DEFAULT TRUE | deactivate-not-delete |
| `created_at` / `updated_at` | TIMESTAMP | |

Unique `(entity_scope, slug)`.

### 5.2 `lims_workflow_transitions`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `entity_scope` | TEXT NOT NULL | denormalized to match its states (CHECK) |
| `from_state_id` | INTEGER NOT NULL REFERENCES lims_workflow_states(id) | |
| `to_state_id` | INTEGER NOT NULL REFERENCES lims_workflow_states(id) | |
| `verb` | TEXT NOT NULL | `receive`, `submit`, `verify`, `retract`, `retest`, `reject`, `publish`, `cancel`, `dispatch`, … |
| `label` | TEXT | display name; defaults from verb |
| `description` | TEXT | |
| `requirements` | JSONB NOT NULL DEFAULT `'[]'` | list of typed entries, §5.3 |
| `is_builtin` / `is_active` / `sort_order` | | as states |
| `created_at` / `updated_at` | TIMESTAMP | |

Unique `(entity_scope, from_state_id, verb)`. Application-level guard: both
endpoint states must share `entity_scope` (validated in service; no cross-scope
edges).

### 5.3 Requirement entries (JSONB schema)

Each entry: `{"kind": <str>, "value": <str|null>, "note": <str|null>}`.

v1 kinds (validated on write; unknown kinds rejected):

- `all_analyses_in_state` — value = analysis state slug (e.g. "all analyses
  `verified` before sample → verified")
- `field_present` — value = lims_samples/lims_analyses field name (e.g.
  `date_received`)
- `role_at_least` — value = Mk1 role (`admin`, `lab`, …)
- `manual` — free-text requirement, `note` carries the text

Dormant contract: in this slice entries are stored, validated for shape, and
rendered on the page. **No transition path evaluates them.** At the authority
swap, the native transition machine evaluates entries by kind; `manual`
entries render as operator checklist items.

### 5.4 `lims_sample_transitions`

Mirrors `lims_analysis_transitions`'s shape:

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `lims_sample_pk` | INTEGER NOT NULL REFERENCES lims_samples(id) ON DELETE CASCADE | |
| `verb` | TEXT | nullable — reconcile-synthesized rows have no verb |
| `from_status` | TEXT | nullable (unknown for some seeds) |
| `to_status` | TEXT NOT NULL | |
| `source` | TEXT NOT NULL | `'mk1'` \| `'senaite'` \| `'reconcile'` \| `'is_seed'` (CHECK) |
| `actor_user_id` | INTEGER REFERENCES users(id) ON DELETE SET NULL | known only for `mk1` |
| `occurred_at` | TIMESTAMP NOT NULL | SENAITE-real when known, else now |
| `is_event_id` | TEXT | IS stream `event_id` for dedup |
| `created_at` | TIMESTAMP NOT NULL DEFAULT now | |

Indexes: `(lims_sample_pk, occurred_at)`; partial unique on `(is_event_id)
WHERE is_event_id IS NOT NULL` (idempotent sync + seed).

`lims_analysis_transitions` needs no new column: it already carries
`transition_kind` (CHECK-constrained verb) + `reason`. Observer rows use a new
`transition_kind='observed'` (one idempotent CHECK drop/re-add migration —
the slice-2 review_state pattern), `user_id=NULL`, and `reason` describing the
observation ("SENAITE-direct change observed via display fetch"). Observed
rows are thereby cleanly distinguishable for queries and rollback.

### 5.5 Seeds (idempotent, `is_builtin=TRUE`)

- **Sample states:** the 10 observed prod values + `sample_registered`
  (transient; rarely at rest). Categories: `published`/`dispatched` terminal;
  `cancelled`/`invalid` exception; rest active.
- **Analysis states:** the 10-value CHECK universe (`unassigned`, `assigned`,
  `to_be_verified`, `verified`, `published`, `rejected`, `retracted`,
  `promoted`, `variance_verified`, `senaite_mirror`) + mirror-observed
  `registered`, `cancelled`. `senaite_mirror` seeds as
  `category='exception'`, description "internal sentinel — shadow mirror rows;
  never a real workflow position", `is_active=FALSE` so it renders in the
  catalog for honesty but never as a live workflow node.
- **Transitions:** known SENAITE workflow edges + Mk1 verbs, both scopes
  (sample: register→due→received→…→published, reject/cancel/invalidate edges,
  dispatch; analysis: unassigned→assigned→to_be_verified→verified→published,
  retract's retire-and-replace edge modeled as verb `retract`
  (any-active → `retracted`) plus verb `retest`, reject edges, promote for the
  sub-sample scope). Seed descriptions are minimal; Handler curates via the
  page (that is the point of shipping editing now).

## 6. Event capture — three sources, one log, deduped

### 6.1 Mk1 hooks (`source='mk1'`)

Slice-2 pattern exactly: best-effort background recorder
(`run_in_threadpool`, own `SessionLocal`, rollback-guarded, never raises, never
fails or slows the request) at **every Mk1 site that transitions a SENAITE
sample**. Known sites: `publish_sample_coa` (publish), `PUT
/samples/{sample_id}/reject`, the receive path(s) (receive wizard / complete
check-in), retest-auto-checkin if it re-transitions parents. The plan's first
task is a **grep-backed write-surface audit** (the slice-2 method) to
enumerate all sites; the audit list gates hook completeness. Actor = the
authenticated user. `from_status` = registry value before the write;
`to_status` = confirmed post-state where the endpoint re-fetches (retract-fix
idiom), else the expected post-state.

### 6.2 IS-stream incremental sync (`source='senaite'`)

A small module (working name `sub_samples/is_event_stream.py`) with a
cursor (max `created_at`/id seen) over the IS DB's `sample_status_events` —
Mk1 already queries the IS DB directly (main.py explorer timing query), so no
new connectivity. Each new event maps `sample_id` → `lims_samples` row and
inserts `verb`, `new_status`→`to_status`, `event_timestamp`→`occurred_at`,
`event_id`→`is_event_id`.

**Dedup:** a transition initiated in Mk1 also flows SENAITE→IS→stream (seen
twice). The sync skips insert when an `mk1`-source row exists for the same
`(lims_sample_pk, verb)` within ±5 minutes. The partial unique on
`is_event_id` makes re-syncs idempotent regardless.

**Cadence:** piggybacks the existing background reconcile interval (5 min);
one cheap indexed IS query per tick. Failure is logged and non-fatal; the
cursor only advances after commit.

**Retirement:** this module is the *only* IS→Mk1 puller; at inversion (§7) it
is deleted wholesale.

**Log-and-heal (amendment, 2026-07-13, Handler-approved during UAT):** a
freshly-INSERTED `senaite` row also updates `lims_samples.status` in the same
batch transaction, so the mirror doesn't sit visibly behind SENAITE (amber
"log ahead of status" glyph) until the next display-fetch reconcile. Strictly
a mirror move, not an authority change: dup rows never heal, and an event
older than the sample's `last_synced_at` never heals (a catch-up backlog
after sync downtime must not regress a status a fresher reconcile already
wrote). Heal failures log `workflow.is_sync_heal_failed` and never break the
sync loop.

### 6.3 Reconcile fallback (`source='reconcile'`)

`_refresh_parent_from_senaite` already updates `lims_samples.status`. When it
changes the value and neither an `mk1` nor `senaite` row already explains the
new status (same to_status within a recent window), synthesize a row:
`verb=NULL, from_status=old, to_status=new, occurred_at=now`. This is the
catch-all for anything the push hook missed (bulk/admin ZODB changes).

### 6.4 Passive analysis drift observer (`transition_kind='observed'`)

Closes the analysis-scope gap (SENAITE-direct analysis changes currently
surface only as panel drift). Mk1 already fetches parent analyses from SENAITE
on every sample-details view (`fetch_parent_analyses` — the normal display
fetch) and in the registry-debug panel. A passive observer diffs that
already-fetched response against the live shadow rows:

- state differs → heal the shadow (`mirror_review_state`, result if changed)
  AND write a `lims_analysis_transitions` row recording from→to with
  `transition_kind='observed'` (§5.4).
- **Zero additional SENAITE load** — it only ever consumes responses already
  fetched for display. Coverage-by-usage is accepted: an unviewed sample logs
  the change on next view or manual re-sweep; content-complete, not instant.
- Same never-fail posture: observer errors are logged, never break the page
  fetch. Writes go through a background task with its own session.

### 6.5 Historical seed (`source='is_seed'`)

`backend/scripts/backfill_sample_transitions_from_is.py`, same operational
shape as the two shipped backfills: idempotent (keyed on `is_event_id`),
checkpoint-resumable, `--dry-run` prints would-insert counts and writes
nothing, `--limit N` smoke mode. DB-to-DB (IS → Mk1), zero SENAITE load, no
throttling needed beyond batching. Events with no matching `lims_samples` row
are counted and skipped (they predate the registry or are secondaries).
Caveat recorded: the stream is only as complete as SENAITE's push hook — this
is a best-effort seed, not a certified audit trail; the certified record
starts at this slice's deploy.

## 7. Direction inversion (design constraint, not built now)

Today: SENAITE → IS (`sample_status_events`) → Mk1 (sync + seed).
Near disconnect, the arrow reverses: **Mk1's native log becomes the canonical
event stream and Mk1 feeds IS**, because IS still needs transition events to
drive WordPress customer-status updates (`status_service.py` →
`_determine_wp_status` → WP notify).

Contract this slice honors so inversion is a projection, not a remodel:

- `lims_sample_transitions` carries everything IS/WP consumes today: verb,
  `to_status` (= `new_status`), real timestamp, and sample identity that joins
  to order linkage via `lims_samples`.
- The IS puller (§6.2) is one self-contained module with no tendrils.
- The future feed is then: Mk1 pushes (or IS pulls) new `source='mk1'` rows —
  a later slice belonging to the authority swap.

## 8. Admin Settings page

Admin-gated pane in Preferences ("Workflow"), following the existing pane
conventions (`panes.tsx` registry, lazy-loaded content).

- **Scope switcher:** Sample | Analysis.
- **Graph:** React Flow (`@xyflow/react`, new dep, code-split so the main
  bundle is untouched). Nodes = active states, colored by category, with a
  **usage-count badge** (live rows currently in that state). Edges =
  transitions labeled by verb. Auto-layout (layered, left→right lifecycle
  flow), pan/zoom. Inactive states render ghosted behind a toggle.
- **Detail drawer** (shadcn, click node or edge): label, description,
  category/color, requirements editor (typed entries with kind-specific value
  pickers + `manual` free text), active toggle, built-in marker, usage count.
- **Create:** "Add state" / "Add transition" buttons open form dialogs
  (from/to/verb pickers constrained to the current scope).
- **Guardrails:** hard-delete allowed ONLY for non-builtin states with zero
  usage and zero attached transitions — otherwise 409 + deactivate offered.
  Custom states not yet reachable by any real row badge **"defined — not yet
  reachable"**. A persistent banner: *"Descriptive while SENAITE is system of
  record — requirements are documentation until the authority swap."*
- **Backend API** (admin-gated):
  - `GET /api/workflow/graph?scope=sample|analysis` — states + transitions +
    usage counts in one payload (page load).
  - `POST/PATCH/DELETE /api/workflow/states/{id}` and
    `/api/workflow/transitions/{id}` — CRUD with the guardrails above;
    requirement-entry shape validated server-side.
- **Registry-inspect tail:** the sample registry-debug panel gains a "recent
  transitions" section — last 5 `lims_sample_transitions` rows (verb, from→to,
  source, occurred_at) — the same drift-eyeballing surface that made slice-2
  UAT effective.

## 9. Invariants and error handling

1. **No live behavior changes.** Catalog drives nothing; log writes are
   fire-and-forget mirrors; existing CHECKs/readers untouched.
2. Log/observer/sync writes **never fail or slow a request** (bg task, own
   session, rollback-guarded, `logger.warning` on failure).
3. Sync + seed **idempotent** (partial unique on `is_event_id`; cursor
   advances only post-commit; re-runs are no-ops).
4. Catalog CRUD **fail-loud guardrails**: cross-scope edges rejected; unknown
   requirement kinds rejected; delete-with-references → 409; builtin →
   deactivate only.
5. Seeds idempotent (`INSERT … WHERE NOT EXISTS`, `database.py` per-statement
   isolation pattern).

## 10. Testing

House pattern (live dev DB, TEST-prefixed rows, FK-safe cleanup, skip-if-
missing-seed; gate on failure-SET diff vs base, not zero failures):

- **Catalog:** CRUD guardrails (409 paths, deactivate-not-delete, cross-scope
  rejection), requirement-entry validation per kind, seed idempotency
  (run twice → identical).
- **Sample log:** per-hook tests (row written with actor/verb; endpoint
  behavior byte-identical when recorder throws — never-fail proof), reconcile
  synthesis (drift with no explaining event → row; with explaining event → no
  row), IS-sync dedup (mk1-row-within-window → skip; event_id re-sync → skip),
  cursor advance semantics.
- **Observer:** display-fetch diff → shadow healed + transition row; no diff →
  no writes; fetch failure → page unaffected.
- **Backfill:** dry-run writes nothing + counts match; idempotent re-run;
  missing-sample skip counting.
- **FE:** pane tests with React Flow mocked (graph payload → nodes/edges,
  drawer edit round-trip, guardrail 409 surfaces, banner + badges).
- **UAT** on an isolated devbox stack: drive sample verbs end-to-end, watch
  the log + registry-inspect tail; make a SENAITE-direct change and watch the
  IS-stream sync + observer capture it.

## 11. Rollback runbook

**Deploy note — `'observed'` CHECK is last-boot-wins (final-review Important 3).**
The `transition_kind` CHECK is enforced by a DROP/re-ADD migration pair that
re-runs on every backend boot. Any OLDER-image boot against the same DB
(rollback, roll-forward sequencing, a sibling stack on a shared dev DB)
re-applies the old 10-value list — after which every observer write dies
silently (IntegrityError swallowed by the never-fail wrapper: capture goes
dark, pages stay fine). This was observed live on the shared dev DB during
the branch. Remedy: after any rollback→roll-forward or mixed-version window,
boot the CURRENT image last (or rerun `init_db()`) to restore the 12-value
CHECK. A union-preserving re-add can ride a later slice.

Everything is additive and dormant. Rollback = revert the image; optionally
drop the four new-table datasets (`lims_sample_transitions`,
`lims_workflow_states`, `lims_workflow_transitions`) and delete
observer-written `lims_analysis_transitions` rows (identifiable by
`transition_kind='observed'`). No reader depends on any of it in this slice, so a revert is
safe in either order.

## 12. ISO 17025 alignment

This slice is a direct alignment investment (we are not accredited; we align
to pursue — see program posture):

- **Attributable, time-stamped records** (§7.5): every state transition
  recorded with actor (where known), source, verb, from→to, and real
  timestamp — in our own system of record, surviving SENAITE retirement.
- **Defined procedures** (§7.1/7.4): the catalog makes the lab's workflow —
  states, allowed paths, entry requirements — an explicit, reviewable,
  versionable artifact instead of implicit software behavior.
- **Honest provenance:** seeded history is labeled `is_seed` (best-effort,
  hook-dependent); the certified continuous record begins at deploy. Observer
  rows are labeled as observed, not acted.

## 13. Follow-ups (explicitly out of slice)

- Enforcement wiring (requirements → native transition validation) — the
  authority-swap slice.
- Mk1→IS event feed (§7) + retirement of the IS puller.
- Read-flip of state-driven UI (kanban/order explorer can then read Mk1 only).
- Sample-details timeline UI fed by the log.
- Relaxing/replacing the hardcoded CHECKs with catalog-driven validation
  (only after enforcement is live and trusted).
- Method/instrument fidelity gap from slice 2 (HplcMethod.senaite_uid) rides
  the same later wave.
