# Mk1-Native Analyses — Sub-Samples Own Their Analyses

**Date:** 2026-06-02
**Status:** Draft — design under review.
**Scope:** Stop creating sub-sample ARs in SENAITE. Sub-samples remain Mk1-owned first-class objects (`lims_sub_samples`, already shipped) and now also own their analyses via a new `lims_analyses` table. The parent AR stays in SENAITE for customer-facing identity, billing linkage, and its own analyses (HPLC primary today). Mk1 owns the analysis state machine, result entry, worksheet routing, and family-state aggregation for vials. SENAITE shrinks toward being a legacy adapter; this is the first concrete step of the *Mk1 becomes the LIMS* arc.
**Repos touched:** `Accu-Mk1` (backend + frontend), `coabuilder` (input-payload extension), `integration-service` (WP signaling source-of-truth shift).
**Predecessor work:**
- `feat/sub-samples` — sub-sample ARs in SENAITE (the layer we're removing for sub-samples).
- `feat/vial-assignment-step` — HPLC / ENDO / STER / XTRA roles on lims_sub_samples.
- `2026-06-02-worksheet-variance-grouping-design.md` — variance set membership + lock state on Mk1 tables.
- `2026-06-02-coa-rollup-override-design.md` — Phase 1 COA resolver + pin/manifest. Carries over almost unchanged; this spec describes how.
**Successor:** A future "parent analyses move to Mk1" phase migrates the parent AR's analyses into `lims_analyses` too, at which point SENAITE retains only sample identity / order linkage. Out of scope here.

---

## Goals

- **Sub-samples own their analyses in Mk1.** A `lims_analyses` row carries the (analysis_service, result, state, method, instrument, analyst, timeline) tuple for one analysis instance on one vial (or on a parent).
- **No sub-sample ARs in SENAITE.** Receive Wizard inserts `lims_sub_samples` + `lims_analyses` rows directly; no `@@accumark-create-subsample` calls. SENAITE retains the parent AR only.
- **Variance HPLC works naturally.** Parent + N HPLC sub-samples = N+1 rows in `lims_analyses` for the HPLC keyword, each independently transitionable. The COA resolver's candidate-gathering layer becomes a single Mk1 SQL query.
- **Family state is Mk1-computed.** `waiting_for_addon_results` (and its successors) are derived from `lims_analyses` across `{parent, all subs}`, not pulled from SENAITE's parent-AR workflow. WP signals fire off family-state transitions.
- **Customer-facing prelim-COA opt-in becomes a feature.** When the family state crosses into "HPLC verified, addons pending," IS pushes a WP prompt: "Want a preliminary HPLC-only COA now, or wait for full?" Customer picks; opted-out analytes drop from the COA via the existing `reportable` flag.
- **Check-in flow is bench-identical.** Photo capture, label, vial assignment — unchanged from the tech's perspective. Only the backend writes change.
- **Additive only on existing data.** No production sub-sample ARs exist today (BW-0013-S01..S05 and prior are dev/test only) — those get wiped and recreated under Model D during cutover. No data migration script for production.

## Non-goals

- **No parent-AR migration in this phase.** Parent AR's analyses (today's HPLC primary, water content, etc.) stay in SENAITE for now. The resolver reads from both sources and unifies in code; the data model carries it.
- **No customer-facing visible identity change.** BW-0013 is still BW-0013, BW-0013-S01 is still BW-0013-S01. The format is preserved; the *creator* of the IDs flips from SENAITE to Mk1.
- **No SENAITE-side workflow changes** other than removing sub-AR creation hooks. SENAITE's existing parent-AR workflow continues.
- **No new analyte-routing rules** beyond what the assignment role already gives us. HPLC services route to hplc-role vials; ENDO services to endo-role vials; STER to ster; XTRA gets none.
- **No retroactive prelim-COA on already-published samples.** Opt-in surfaces only on samples that cross the trigger after rollout.
- **No multiple COA generations per family in one go.** Generate-COA still operates on the parent identity (BW-0013) once per click; sub-samples don't get their own COAs.
- **No bench-tech UI rewrite** beyond what's strictly required to point result-entry at the Mk1 endpoint instead of the SENAITE proxy. Look, feel, and keystrokes unchanged.

## Architecture

### The 50-foot view

Today, BW-0013-S01 is a SENAITE AnalysisRequest with its own analyses; Mk1 mirrors its identity in `lims_sub_samples`. Result entry, state transitions, worksheet routing — all proxied through SENAITE.

Under this design, BW-0013-S01 is a `lims_sub_samples` row. Its analyses live in `lims_analyses` as rows with `lims_sub_sample_pk = <S01's pk>`. State transitions are Mk1 endpoints. Worksheet items reference `lims_analyses.id`. SENAITE has no record of BW-0013-S01 at all.

The parent (BW-0013) keeps its SENAITE AR for now. Its analyses live in SENAITE. The resolver / family-state derivation joins both worlds: Mk1 queries for sub-sample analyses, the existing SENAITE proxy for parent analyses, unified in service-layer code.

### Diagram

```
                       ┌──────────────────────┐
                       │   SENAITE (legacy)   │
                       │  ┌────────────────┐  │
                       │  │ Parent AR      │  │
                       │  │  BW-0013       │  │
                       │  │  analyses ×N   │  │  ← parent's HPLC, etc.
                       │  └────────────────┘  │
                       └──────────┬───────────┘
                                  │  (read-only proxy
                                  │   for parent analyses)
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                            Mk1                                  │
│  ┌──────────────┐    ┌─────────────────┐    ┌──────────────┐    │
│  │ lims_samples │◄───┤ lims_sub_samples│◄───┤ lims_analyses│    │
│  │  (parent)    │    │  (vials)        │    │              │    │
│  └──────────────┘    └─────────────────┘    └──────────────┘    │
│                                                ▲                │
│                                                │                │
│  ┌──────────────────────┐    ┌───────────────────────────────┐  │
│  │ Receive Wizard       │────► writes lims_analyses rows on  │  │
│  │ (check-in)           │      vial creation + assignment    │  │
│  └──────────────────────┘                                       │
│                                                                 │
│  ┌──────────────────────┐    ┌───────────────────────────────┐  │
│  │ Worksheet            │────► worksheet_items.lims_analysis │  │
│  │ assignment + entry   │      _id, drives result entry      │  │
│  └──────────────────────┘                                       │
│                                                                 │
│  ┌──────────────────────┐                                       │
│  │ COA resolver         │────► reads lims_analyses + parent    │
│  │                      │      SENAITE proxy, unified          │
│  └──────────────────────┘                                       │
│                                                                 │
│  ┌──────────────────────┐                                       │
│  │ Family state         │────► fires WP signal events          │
│  │ derivation           │      via IS                           │
│  └──────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────┘
```

### State machine

`lims_analyses.review_state` mirrors the SENAITE vocabulary so the UI palette + transition handlers we already shipped stay valid:

```
                ┌──────────────┐
                │  unassigned  │   default on insert
                └──────┬───────┘
                       │ assign (worksheet add)
                       ▼
                ┌──────────────┐
                │   assigned   │
                └──────┬───────┘
                       │ submit (result entered)
                       ▼
                ┌──────────────┐
                │to_be_verified│
                └──┬──┬──┬─────┘
            verify│  │  │ retract
                  ▼  │  ▼
        ┌──────────┐ │ ┌──────────┐
        │ verified │ │ │retracted │
        └────┬─────┘ │ └──────────┘   (back to unassigned-equivalent;
             │       │ reject          new attempt creates a retest)
             │ publish▼
             │  ┌──────────┐
             ▼  │ rejected │   terminal — excluded from candidates
        ┌──────────┐ └──────────┘
        │published │
        └──────────┘
```

Every transition writes a `lims_analysis_transitions` audit row (`from_state`, `to_state`, `transition_kind`, `user_id`, `reason`, `occurred_at`). The bench-tech result-entry hooks call `submit`; supervisors call `verify`/`retract`/`reject`; the publish-COA flow calls `publish` on each manifest row's analysis.

### Family state derivation

`family_state(parent_sample_id) → enum` is a single SQL aggregate over `lims_analyses` for `{parent, all subs}`, plus parent-AR analyses pulled from the SENAITE proxy. Definition (simplified):

```
inputs:
  • Mk1 lims_analyses rows for parent_pk + all sub_pks where reportable=true
  • SENAITE parent AR analyses where reportable=true
                                   (Mk1 will own these in a later phase)

states (ordered by precedence — earliest wins):
  pending                   ← any input in unassigned | assigned
  to_be_verified            ← any input in to_be_verified (no earlier states)
  waiting_for_addon_results ← all HPLC-keyword inputs verified+ AND any
                              non-HPLC input not verified+
  verified                  ← all inputs verified, none published
  published                 ← all inputs published
```

WP signaling subscribes to family-state transitions. When a family crosses into `waiting_for_addon_results`, IS pushes the prelim-COA opt-in to WP.

## Data model

### `lims_analyses` (new)

```sql
CREATE TABLE IF NOT EXISTS lims_analyses (
    id                    SERIAL PRIMARY KEY,
    -- Polymorphic attachment. Exactly one of these must be non-null.
    lims_sample_pk        INTEGER REFERENCES lims_samples(id) ON DELETE CASCADE,
    lims_sub_sample_pk    INTEGER REFERENCES lims_sub_samples(id) ON DELETE CASCADE,
    CHECK ((lims_sample_pk IS NULL) <> (lims_sub_sample_pk IS NULL)),

    -- Service identity. analysis_service_id FK + denormalized keyword for
    -- fast filtering without a join.
    analysis_service_id   INTEGER NOT NULL REFERENCES analysis_services(id) ON DELETE RESTRICT,
    keyword               TEXT NOT NULL,
    title                 TEXT NOT NULL,        -- denormalized service title for UI

    -- Result
    result_value          TEXT,
    result_unit           TEXT,

    -- Workflow state — mirrors SENAITE vocabulary.
    review_state          TEXT NOT NULL DEFAULT 'unassigned'
                          CHECK (review_state IN (
                              'unassigned', 'assigned', 'to_be_verified',
                              'verified', 'published', 'rejected', 'retracted'
                          )),

    -- Provenance (nullable until populated)
    method_id             INTEGER REFERENCES hplc_methods(id) ON DELETE SET NULL,
    instrument_id         INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    analyst_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,

    -- Timeline. Each ts is set on the transition that caused it.
    captured_at           TIMESTAMP,
    submitted_at          TIMESTAMP,
    verified_at           TIMESTAMP,
    published_at          TIMESTAMP,

    -- Retest chain. retest_of_id points at the previous (now-retracted/
    -- rejected) attempt. UI groups by retest_root_id (computed; not stored).
    retested              BOOLEAN NOT NULL DEFAULT FALSE,
    retest_of_id          INTEGER REFERENCES lims_analyses(id) ON DELETE SET NULL,

    -- Reportability. Folds in the Phase 1 analysis_reportable sidecar.
    -- Default TRUE; tech/manager toggles FALSE to exclude from COA.
    reportable            BOOLEAN NOT NULL DEFAULT TRUE,
    reportable_reason     TEXT,

    -- Audit
    created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX ix_lims_analyses_sample        ON lims_analyses (lims_sample_pk);
CREATE INDEX ix_lims_analyses_sub_sample    ON lims_analyses (lims_sub_sample_pk);
CREATE INDEX ix_lims_analyses_keyword       ON lims_analyses (keyword);
CREATE INDEX ix_lims_analyses_review_state  ON lims_analyses (review_state);
-- One service per (host, retest-root). Retests share keyword; they're
-- distinguished by the retest_of_id chain. Enforce uniqueness for non-retest
-- root rows only.
CREATE UNIQUE INDEX uq_lims_analyses_sub_service_root
    ON lims_analyses (lims_sub_sample_pk, keyword)
    WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL;
CREATE UNIQUE INDEX uq_lims_analyses_parent_service_root
    ON lims_analyses (lims_sample_pk, keyword)
    WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL;
```

### `lims_analysis_transitions` (new)

```sql
CREATE TABLE IF NOT EXISTS lims_analysis_transitions (
    id                SERIAL PRIMARY KEY,
    analysis_id       INTEGER NOT NULL REFERENCES lims_analyses(id) ON DELETE CASCADE,
    from_state        TEXT,
    to_state          TEXT NOT NULL,
    transition_kind   TEXT NOT NULL
                      CHECK (transition_kind IN
                          ('assign','submit','verify','retract','reject',
                           'retest','publish','reset','auto')),
    user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason            TEXT,
    occurred_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_lims_analysis_transitions_analysis ON lims_analysis_transitions (analysis_id);
```

### Changes to existing tables

`worksheet_items` gets a nullable `lims_analysis_id` FK. Old SENAITE-AR-based items keep their existing `(sample_uid, analysis_uid)` pair — the column is additive, not a replacement. New items inserted under Model D set `lims_analysis_id` and leave the SENAITE pair null. Read-side resolves whichever is populated.

```sql
ALTER TABLE worksheet_items
    ADD COLUMN IF NOT EXISTS lims_analysis_id INTEGER
        REFERENCES lims_analyses(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS ix_worksheet_items_lims_analysis
    ON worksheet_items (lims_analysis_id);
```

### Phase 1 carry-over

`coa_result_pins` and `coa_generation_sources` columns stay as-is. The semantics of `source_sample_id` shift: under Model D it's still the human-readable sample_id (BW-0013-S02), but `source_analysis_uid` becomes a string representation of `lims_analyses.id` (e.g. `"mk1:1234"`) for vial-owned analyses, and the SENAITE UID for parent-owned analyses. The resolver's `CandidateInfo` already abstracts this — no schema change.

`analysis_reportable` sidecar can stay (zero risk if empty) but new code reads `lims_analyses.reportable` directly. Drop in a cleanup phase later.

## Receive Wizard flow

### Before

```
POST /api/sub-samples → backend/sub_samples/senaite.py creates SENAITE AR
                     → copies parent AR's analyses to sub AR
                     → uploads photo as SENAITE attachment
                     → inserts lims_sub_samples row mirror
```

### After

```
POST /api/sub-samples → Mk1 generates next sample_id (parent + "-S" + seq)
                     → inserts lims_sub_samples row
                     → inserts lims_analyses rows from the parent's profile,
                       filtered by service_group matching the vial's
                       assignment_role:
                           hplc role → services in 'Analytics' group
                           endo role → services in 'Microbiology' w/ ENDO keyword
                           ster role → services in 'Microbiology' w/ STER keyword
                           xtra role → no analyses
                     → uploads photo to parent AR with vial-tag metadata
                       (or to a Mk1-side blob store — see Open Question 3)
                     → no SENAITE AR call
```

The user-facing wizard, the photo capture, the print labels, the assignment step UI — all unchanged. The sample_id format stays `{parent}-S{NN}` so existing UI components, COA labels, and the worksheet inbox don't see a difference.

### Profile lookup

To know what analyses to seed on a new vial, Mk1 reads the parent's order profile. The order_submissions table (in IS) holds the WP profile data (e.g. "Bac Water Full Panel" = HPLC + ENDO + STER). Mk1 already pulls this for the worksheet inbox's `linked_orders` filter. The new path reuses that lookup.

If the assignment role hasn't been picked yet at vial-creation time (XTRA default), Mk1 inserts no analyses; the Assign step's later patch can populate them, OR the profile-services can be inserted speculatively with the vial in XTRA and then promoted/withdrawn when the role flips. Recommendation: speculative insert + role-flip handler — keeps the resolver's view consistent.

## Worksheet routing + result entry

Bench-tech UI shape unchanged. Backend swaps:

| Today | Model D |
|---|---|
| `GET /senaite-proxy/analyses/{ar_uid}` returns SENAITE analyses | `GET /api/lims-analyses?host=sub_sample&pk=<id>` returns Mk1 rows |
| `PATCH /senaite-proxy/analyses/{uid}` writes result | `PATCH /api/lims-analyses/{id}` writes result + transitions to `to_be_verified` |
| `POST /senaite-proxy/transition` fires verify/retract/reject | `POST /api/lims-analyses/{id}/transitions` does the same, writes audit row |

`AnalysisTable.tsx` reads through an adapter that detects which world the sample is in:

```ts
function useAnalysesForSample(sampleId: string) {
  const isSub = /-S\d{2,}$/.test(sampleId)
  return isSub
    ? useLimsAnalyses({ host: 'sub_sample', sampleId })   // Mk1 endpoint
    : useSenaiteAnalyses({ sampleId })                     // existing proxy
}
```

For the parent (non-sub), nothing changes — analyses still come from SENAITE. For sub-samples, the table is fed by the Mk1 endpoint. The hook returns the same shape (`SenaiteAnalysis[]`) so the table renders without modification.

### Worksheet inbox

The vial-flat inbox shipped on this branch becomes simpler: it already groups by parent + vial. Today it joins SENAITE-AR-derived analyses to vials via Mk1 sub-sample mirrors. Under Model D it joins `lims_analyses` to `lims_sub_samples` directly — same shape (`InboxVialItem[]`), fewer SENAITE round-trips, faster page.

## COA roll-up integration

Phase 1 design (the resolver + pin + manifest) carries through unchanged at the contract layer. The resolver's `_gather_candidates_for` swap:

```python
# Before — SENAITE round-trip per AR
async def _gather_candidates_for(sid, ...):
    items = await senaite_reader.list_for_sample(sid)  # HTTP call
    ...

# After — Mk1 query for vials, SENAITE for parent
def _gather_candidates_for(parent_pk, ...):
    # All Mk1-owned analyses for the family in one query.
    rows = db.execute(
        select(LimsAnalysis, LimsSubSample.sample_id)
        .join(LimsSubSample,
              LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id,
              isouter=True)
        .where(or_(
            LimsAnalysis.lims_sample_pk == parent_pk,
            LimsSubSample.parent_sample_pk == parent_pk,
        ))
        .where(LimsAnalysis.reportable == True)
    ).all()
    # Plus parent AR analyses via the existing SENAITE proxy
    parent_ar_analyses = await senaite_reader.list_for_sample(parent.sample_id)
    # Merge into CandidateInfo list.
```

`CandidateInfo.source_analysis_uid` becomes `f"mk1:{lims_analyses.id}"` for vial analyses or the SENAITE UID for parent analyses. Pin lookups + manifest writes unchanged.

The Phase 1 wiring into `/wizard/senaite/samples/{sample_id}/generate-coa` stays. The resolver pre-flight reads from both sources; manifests are written with mixed `source_analysis_uid` formats. Pin upserts work either way.

### COABuilder contract extension

COABuilder currently fetches the parent AR's analyses from SENAITE. Under Model D, sub-sample analyses don't exist in SENAITE. Two paths:

1. **Inject `result_sources` in the request body.** Mk1 resolves first, sends COABuilder a payload like `{ "IDENTITY_HPLC": {"value": "98.55", "unit": "%"}, ... }`. COABuilder treats this as the source of truth, doesn't re-query SENAITE. Already on the Phase 1 → Phase 3 roadmap.

2. **Mk1 pre-creates parent-AR analysis instances for the values it owns.** Just before generate-COA, Mk1 calls SENAITE `update` to write the resolved values back to placeholder analyses on the parent AR. COABuilder reads SENAITE as today. *Rejected* — re-introduces dual-write pain and re-creates the multi-instance-on-one-AR question we're avoiding.

Path 1 is the design. Cross-repo coordination required.

## Family state + WP signaling

Today: IS subscribes to SENAITE workflow transitions (or polls) and fires WP webhooks on parent-AR state changes. Under Model D:

- Mk1 emits a `family_state_changed` event on every `lims_analyses` transition that could shift the family state.
- IS consumes the event and computes whether a WP signal should fire.
- WP-facing API unchanged — IS still posts to the same WP endpoints.

The integration point is a new Mk1 endpoint IS calls on every family-state recomputation, or a queue/event-bus pattern. Phase-internal decision; either works.

### Customer-visible state evolution

Today WP shows `processing / completed / on-hold / failed`. Family state opens up cleaner messaging:

| Family state | WP customer-facing copy |
|---|---|
| `pending` | "Sample received — testing in progress" |
| `to_be_verified` | "Initial results in — under final review" |
| `waiting_for_addon_results` | "HPLC complete — endotoxin / sterility still in progress" *(+ prelim-COA opt-in prompt)* |
| `verified` | "All testing complete — final COA being prepared" |
| `published` | "Your COA is ready" |

The "prelim-COA opt-in prompt" is a new WP page rendered when family state crosses into `waiting_for_addon_results` and no prelim COA has been opted into yet.

## Prelim-COA opt-in flow

When family_state transitions to `waiting_for_addon_results`:

1. IS receives the event from Mk1.
2. IS pushes a notification to WP — "HPLC results ready. Want a prelim COA now, or wait for full?" with an opt-in button per order.
3. **Opt-in path:**
   - Customer clicks "Yes, send prelim."
   - WP POSTs back to IS with the choice.
   - IS calls Mk1's `/wizard/senaite/samples/BW-0013/generate-coa?prelim=true`.
   - Mk1 sets `reportable=false` on all non-HPLC `lims_analyses` rows for the family (and the parent AR's non-HPLC analyses, via the existing reportable sidecar fallback).
   - Resolver runs, manifest writes, COABuilder generates a PDF marked **"Preliminary Certificate of Analysis"**.
   - Publish via existing path. WP webhook fires "Your preliminary COA is ready."
4. **Wait-for-full path:** customer clicks "No, wait" → IS records the choice → no prelim COA. When addon analyses verify, family state crosses to `verified` → standard full-COA flow.
5. **Re-publish on addon verify** (regardless of opt-in choice): when all addons verify and a prelim COA was published, IS triggers a regen with `reportable=true` everywhere → "Your final COA is ready" notification fires. Old prelim generation marked `superseded` per the existing publish-flow conventions.

The PDF needs a "Preliminary" stamp + a "this is not the final COA" footer when generated with the prelim flag. COABuilder layout change.

## SENAITE integration boundary

| Concern | Today | Model D |
|---|---|---|
| Parent AR creation | SENAITE on order ingest | SENAITE on order ingest (unchanged) |
| Parent AR's analyses | SENAITE | SENAITE (still — future phase) |
| Sub-sample AR creation | SENAITE on Receive Wizard | **gone** (Mk1 only) |
| Sub-sample analyses | SENAITE per sub AR | Mk1 (`lims_analyses`) |
| Analysis state machine | SENAITE per AR | Mk1 for vials; SENAITE for parent |
| Worksheet routing | SENAITE analysis UIDs | `lims_analyses.id` for vials; SENAITE UIDs for parent (unchanged) |
| Photo storage | SENAITE attachment on sub AR | parent AR attachment with vial-tag metadata (see Open Question 3) |
| Result entry endpoint | SENAITE proxy | Mk1 endpoint for vials; SENAITE proxy for parent |
| Verification code | SENAITE field on parent AR | unchanged |
| COA publish workflow transition | SENAITE on parent AR | unchanged |
| WP signaling source-of-truth | parent-AR state | family state (Mk1-computed) |

## Migration

No production sub-sample ARs exist today, so no data migration script is required. Cutover:

1. Ship the Mk1 endpoints + schema changes (additive).
2. Switch the Receive Wizard backend to the new path.
3. Wipe the dev environment's existing test sub-sample ARs from SENAITE (manual or scripted, dev-only).
4. Re-check-in BW-0013 family on the new path for live verification.

The dev wipe is a one-time housekeeping action — no operator process, no customer impact.

## Phasing

Five phases, sized to land independently in the order presented:

**Phase 1 — Schema + state machine (foundation).** S-M.
- `lims_analyses` + `lims_analysis_transitions` migrations + ORM.
- Mk1 transition endpoints (`/api/lims-analyses/{id}/transitions/{kind}`).
- Audit-log writer.
- Unit tests for the state machine.

**Phase 2 — Receive Wizard backend swap.** M.
- Replace `backend/sub_samples/senaite.py` AR-creation logic with Mk1 inserts.
- Profile-services lookup (which analyses to seed per vial based on parent's order + role).
- Speculative-insert + role-flip handler for XTRA → assigned-role promotion.
- Photo storage decision (Open Question 3).

**Phase 3 — Worksheet routing.** M-L.
- `worksheet_items.lims_analysis_id` column + read-side dual-source.
- Worksheet inbox query rewrite for the vial path.
- `AnalysisTable.tsx` adapter hook (`useAnalysesForSample`).
- Bench-tech result-entry rewires to Mk1 endpoints for vial analyses.

**Phase 4 — COA resolver upgrade + family state.** M.
- Resolver `_gather_candidates_for` reads `lims_analyses` for vials, SENAITE proxy for parent, unifies.
- Family-state derivation endpoint (`GET /api/families/{parent_id}/state`).
- WP signaling event emission on family-state transitions.

**Phase 5 — Customer prelim-COA opt-in.** M.
- IS event handler for family→waiting_for_addon_results transitions.
- WP opt-in page + IS endpoint pair.
- Mk1 generate-COA `prelim=true` flag (sets reportable=false on non-HPLC).
- COABuilder "Preliminary" stamp + footer (cross-repo).
- Auto re-publish on addon verification.

Phases 1-3 cover the architectural shift. Phases 4-5 unlock the customer-facing wins.

## Open questions

### 1. Speculative analysis seeding for XTRA vials

When a tech checks in a vial as XTRA (unassigned), do we:
- (a) Insert zero `lims_analyses` rows; populate them later when the role is assigned.
- (b) Insert speculative rows for the whole profile, flag with `reportable=false`, flip to TRUE when the role assigns.

(a) keeps the table cleaner; (b) keeps the resolver's view consistent at all times. Lean (b) — the resolver doesn't have to special-case "no rows yet" vs "verified and missing".

### 2. Retest chains in Mk1

`retest_of_id` lets us chain retests on `lims_analyses`. SENAITE has its own retest mechanism we proxy today. Question: do we re-implement the SENAITE retest UI on top of `lims_analyses` for vial analyses, or punt this until a sub-sample legitimately needs a retest?

Recommendation: ship the data model now (retest_of_id + uniqueness-excluding-retests), defer UI implementation until first real need.

### 3. Photo storage

Sub-sample photos today attach to the sub-sample AR in SENAITE. Under Model D, the sub-sample AR is gone. Two options:
- Attach to the parent AR with metadata tagging the vial.
- Store in a Mk1-side blob (e.g., S3 / local FS / Postgres bytea).

The parent-AR attach path keeps photos discoverable through SENAITE for legacy tools. The Mk1-side path is the long-term direction. Recommend parent-AR attach for this phase (keeps SENAITE-touching code minimal) with a TODO to migrate when the parent AR eventually moves into Mk1.

### 4. Parent's analyses dual-source for the resolver

Phase 4's resolver reads two sources: `lims_analyses` for vials, SENAITE proxy for parent. This is a transitional state. Eventually we'll move parent analyses into `lims_analyses` too — at which point the SENAITE branch deletes itself.

The interim design: the resolver's `_gather_candidates_for` function has two branches and merges results. CandidateInfo's `source_analysis_uid` discriminates by prefix (`mk1:NNNN` vs raw SENAITE UID). This is a string-typing convention worth documenting at the schema level — proposal: rename `source_analysis_uid` → `source_ref` in Phase 4 to make the polymorphism explicit, or add a `source_kind` enum column.

### 5. Worksheet item migration

Existing worksheet_items in production reference SENAITE analysis UIDs. New worksheet_items under Model D reference `lims_analysis_id`. Read-side dual-source until older worksheets close out. Question: do we plan a backfill once all old worksheets close, to drop the dual-read?

Recommendation: defer the dual-read removal indefinitely; the cost of carrying it is small.

### 6. SLA model

SLA today is computed per-analysis-instance against the parent AR's `date_received`. Under Model D, sub-sample analyses get an `lims_analyses.created_at`. Do we key SLA off that, or off the parent's `date_received`?

Recommendation: parent's date_received — same SLA target whether HPLC ran on the parent or on a sub, since the customer's order was placed once.

### 7. Customer-facing identity for sub-samples

Sub-samples currently get SENAITE-assigned IDs (BW-0013-S01). Under Model D, Mk1 generates them. The format stays identical; the *creator* changes. No customer impact. But the WP customer portal currently links sub-samples to a SENAITE-side URL — those links go away. Replace with Mk1-side equivalents, or drop the per-sub links entirely.

Recommendation: drop the per-sub links from the customer portal. Customers don't think in vials; they think in samples (the parent). Sub-sample existence is internal.

## Verification

### Phase 1 acceptance

- `lims_analyses` + `lims_analysis_transitions` tables present.
- Transition endpoint moves an analysis through `unassigned → assigned → to_be_verified → verified → published` with one audit row per step.
- Reject + retract end states correctly excluded from "valid" filters in subsequent tests.

### Phase 2 acceptance

- Check in a new vial via the Receive Wizard. `lims_sub_samples` and `lims_analyses` rows are inserted; no SENAITE sub-AR is created.
- The vial appears in `AnalysisTable` with the seeded `lims_analyses` rows.
- Photo uploads via the new path; an image shows in the existing photo cell.

### Phase 3 acceptance

- Worksheet drag-drop adds the vial's analyses to a worksheet via `lims_analysis_id`.
- Result entry on the worksheet writes to `lims_analyses.result_value`; row state moves to `to_be_verified`.
- Bench-tech UI looks identical to today.

### Phase 4 acceptance

- Resolver on BW-0013 (Model D family) returns the same shape as on BW-0012 (legacy family) — confirmed by candidate counts and decisions matching expectations.
- Family-state endpoint returns `waiting_for_addon_results` for a parent whose HPLC is verified but whose endo sub is not.
- WP event fires once on the family-state transition.

### Phase 5 acceptance

- WP customer portal shows the prelim-COA opt-in prompt at the right time.
- "Yes" generates a PDF with the Preliminary stamp; HPLC values present, endo/ster blanked or annotated.
- Auto-republish on addon verify triggers the "final COA" notification.

## Out of scope

- Parent analyses moving to Mk1 (future phase; this design covers the data model that will receive them).
- Multi-customer COA opt-in (one prelim choice per family, no per-customer split).
- Customer-facing display of the variance set or which vial each result came from (internal only, per Phase 1 non-goal).
- Bench-tech UI redesign — the existing AnalysisTable.tsx is reused with an adapter swap.
- IS migration to a different signaling mechanism — same WP-facing API; only the trigger source changes.
- A dedicated "vial registry" page for customers (sub-samples remain internal).
- Cross-family aggregation (e.g. "all my Bac Water lots over time") — separate roadmap.
