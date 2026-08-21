# Analysis Amendment Audit — before/after capture on `lims_analysis_transitions`

*Design spec, 2026-08-07. Scope ruled by Handler the same day: pure Accu-Mk1 AR data only —
SENAITE-sourced values are explicitly out (SENAITE is being phased out; its own workflow store
holds that history until then).*

*Line references are against the arc tip `feat/native-parent-placeholders` @ `01e01c1`
(`C:\tmp\Accu-Mk1-parent-placeholder`). Implementation must be sequenced AFTER that branch merges —
this slice edits the same `backend/lims_analyses/service.py` and would conflict.*

---

## 1. Problem

Every state change on a `lims_analyses` row writes an append-only audit row
(`lims_analysis_transitions`: from_state, to_state, kind, user_id, reason, occurred_at). That
satisfies ISO/IEC 17025 §7.5.1 (attribution: who + when). What it does **not** satisfy is §7.5.2
(amendments traceable against the original): the audit is **value-blind**.

Verified lossy paths (all `backend/lims_analyses/service.py`):

| Site | What happens | What is lost |
|---|---|---|
| `apply_transition` submit branch (`:352`) | `row.result_value = result_value` — including the **in-place correction self-edge** `to_be_verified --submit--> to_be_verified` | the prior result. Gone entirely — no other table holds it. **This is the §7.5.2 hole.** |
| `apply_transition` reset branch (`:378`) | clears result_value, result_unit, method_id, instrument_id, captured_at, submitted_at | all cleared draft values |
| `set_method_instrument` (`:543`) | overwrites both ids; audit reason records the **new** values only | prior method/instrument |
| `set_reportable` (`:510`) | flips flag, replaces reportable_reason | prior reason (flag itself derivable from the flip) |
| un-promote, parent-retest cascade (`:1489`) | parent result_value/unit → NULL | cleared value (recoverable only via promotion→source join) |
| un-promote, vial source-retest (`:1757`) | same | same |

A lab tech can today correct a submitted result and the record proves *that* a correction happened,
by whom, when, and why — but not *from what*. Months of bench corrections would accumulate with
unrecoverable priors. That is the one structural gap between the current schema and the
"no silent overwrites" bar.

## 2. Design

### 2.1 The column

Add one nullable column to `lims_analysis_transitions`:

```python
# models.py, LimsAnalysisTransition
details: Mapped[Optional[dict]] = mapped_column(
    JSONB().with_variant(JSON(), "sqlite"), nullable=True
)
```

Identical idiom to `LimsSubSampleEvent.details` — JSONB in Postgres, JSON in SQLite fixtures.

**Shape contract** (documented in the model docstring; enforced by tests, not CHECKs — same
last-boot-wins reasoning as `lims_workflow_shadow_evaluations`):

```json
{"changed": {"result_value": {"before": "0.92", "after": "0.95"},
             "result_unit":  {"before": null,  "after": "mg"}}}
```

- `changed` contains **only fields whose value actually changed** in the mutation that wrote this
  transition row. Values are the raw column values (strings/ints/bools/None) — no formatting.
- A pure state move writes `{"changed": {}}` — NOT NULL. After this slice, NULL means
  "grandfathered pre-slice row **or a write from the exempt SENAITE-mirror paths**
  (`parent_mirror.py` / `workflow/observer.py`, which keep writing details-less rows by ruling)";
  `{"changed": {}}` means "captured, nothing tracked changed". Mk1-native write sites must never
  write NULL. *(Corrected 2026-08-09 after final review — the original "NULL unambiguously =
  pre-slice" claim ignored the mirror exemption.)*
- `review_state` is deliberately NOT in `changed` — it already lives in the typed
  `from_state`/`to_state` columns.

**Tracked field set** (v1, extensible by adding to one tuple):

```python
TRACKED_FIELDS = ("result_value", "result_unit", "method_id", "instrument_id",
                  "reportable", "reportable_reason", "analyst_user_id", "retested")
```

Per-state timestamps (`captured_at`/`submitted_at`/…) are excluded: they are derivable from the
transition rows themselves and would only add noise.

**Fork decided (flagged):** JSONB `details` over dedicated `result_before`/`result_after` columns.
Dedicated columns are more queryable but cover exactly one field — every future tracked field
means another migration pair, and method/instrument/reportable changes would stay second-class. The
JSONB shape covers all six lossy sites uniformly, matches the existing `lims_sub_sample_events`
pattern, and GIN-indexing remains available later if querying ever demands it. Reversible either
way (additive column, additive change).

**Fork decided (flagged):** name it `details`, not `changes` — consistency with
`lims_sub_sample_events.details` beats marginal precision.

### 2.2 The capture helper

One module-level helper in `lims_analyses/service.py` (no new file — it is 15 lines and private):

```python
def _snapshot(row) -> dict:
    return {f: getattr(row, f) for f in TRACKED_FIELDS}

def _deltas(before: dict, row) -> dict:
    after = _snapshot(row)
    return {"changed": {f: {"before": before[f], "after": after[f]}
                        for f in TRACKED_FIELDS if before[f] != after[f]}}
```

Writer idiom: snapshot before mutating, compute deltas right before constructing the
`LimsAnalysisTransition`, pass `details=_deltas(before, row)`.

### 2.3 Write-site inventory (exhaustive, all in-scope sites)

Every `LimsAnalysisTransition(` construction in `lims_analyses/service.py` gains `details`.
Verified complete inventory at `01e01c1` — ten sites:

| Line | Site | details content |
|---|---|---|
| `:222` | `create_analysis` initial insert | `{"changed": {}}` — the row itself is the "after" |
| `:317` | retest branch, new row insert | `{"changed": {}}` (lineage already in `retest_of_id`) |
| `:329` | retest branch, old-row `retested` flip | captures `retested: false→true` |
| `:424` | `apply_transition` main path | **the choke point** — captures submit overwrites (incl. the self-edge correction), reset clears, verify/retract/etc. field effects |
| `:528` | `set_reportable` | captures `reportable`, `reportable_reason` |
| `:566` | `set_method_instrument` | captures `method_id`, `instrument_id` |
| `:824` | re-promote supersession (old parent → retracted) | `{"changed": {}}` today (values are kept on the retracted row) — helper still runs, future-proof |
| `:879` | `promote_to_parent`, new parent row insert | `{"changed": {}}` |
| `:912` | `promote_to_parent`, source → promoted | `{"changed": {}}` today; helper still runs |
| `:1492` + `:1760` | both un-promote sites | captures `result_value`/`result_unit` → None |

**Exempt, with reasons written at the site (Handler ruling 2026-08-07):**
- `lims_analyses/parent_mirror.py` `:112/:132/:148` and `workflow/observer.py` `:104/:117` — shadow
  (`provenance='shadow'`) mirror rows. The values are SENAITE's; SENAITE's workflow store is the
  system of record for their history until the phase-out replaces them wholesale. Mirror-row
  amendment capture would record IS-sync churn, not lab-tech actions.
- The SENAITE result proxy (`main.py` ~`:15030`) — writes to SENAITE, not to `lims_analyses`.
- `hplc_analyses` (the prep world) — out of scope; its results enter AR rows through
  `prep_bridge` → `apply_transition`, which the choke point captures — **including the instrument
  stamp** since the 2026-08-10 Handler-ruled fix: `apply_transition` gained optional
  `method_id`/`instrument_id` kwargs applied post-snapshot, and `prep_bridge` passes them instead
  of mutating the row pre-call. (The gap found 2026-08-09 is CLOSED; prep_bridge was verified to
  have no other pre-call stamping site.) `worksheet_analyst.py` remains PARKED by the same ruling:
  analyst reassignment there is audited in its own append-only `LimsSubSampleEvent` surface, which
  satisfies attribution/traceability without duplicating into `details`.

**Regression guard:** a test greps `lims_analyses/service.py` for `LimsAnalysisTransition(` and
asserts every construction passes `details=` — so a future site cannot silently regress to
value-blind. (Pattern precedent: the mutation-check discipline from the placeholder program.)

### 2.4 Migration

`database.py` `_run_migrations()`, one idempotent statement plus fresh-install DDL parity:

```sql
ALTER TABLE lims_analysis_transitions ADD COLUMN IF NOT EXISTS details JSONB;
```

- Nullable, no default, no backfill — **backfill is impossible by definition** (the data was never
  captured; that is the bug).
- The fresh-install `CREATE TABLE` block for `lims_analysis_transitions` gains the column so new
  stacks match migrated ones.
- SQLite fixtures get it automatically via `Base.metadata.create_all()` from the model column.

### 2.5 Read surface

`GET /api/lims-analyses/{id}` already returns the full chain via `AnalysisWithTransitions`
(`schemas.py:179`). Add `details: Optional[dict] = None` to `TransitionInfo`. NULL rows serialize
as `null` — readers must tolerate it (grandfathered data).

### 2.6 Activity-log blend (Handler-requested 2026-08-08 — in scope)

The sample-details Activity flyout is fed by the federated aggregator
`GET /samples/{sample_id}/activity` (`main.py:905`), which already blends multiple sources.
*(Corrected 2026-08-09 — the original premise here was wrong: a pre-existing source at
`main.py:~1254-1292` ALREADY emits a generic `analysis_transition` event for every transition on
family-vial analyses. The new curated events therefore partially overlap that feed — a vial
submit can render both as "unassigned→to_be_verified" and "Result entered — …". Functionally
additive and safe; whether to accept the duplication or curate the generic source is an OPEN
Handler ruling.)* Add one source block:

**Query:** transitions joined to analyses hosted by this sample — parent tier
(`lims_sample_pk = s.id`) plus vial tier (`lims_sub_sample_pk IN` the sample's vials) — joined to
`users` for attribution and `lims_sub_samples` for the vial label.

**Emission rule (the curation decision):** emit an event ONLY for rows whose
`details->'changed'` is **non-empty**. State-only rows (`{"changed": {}}`) are skipped — promote,
verify, and variance sign-offs already have richer dedicated events in this timeline, and
re-emitting every assign/submit/auto edge would drown it. Grandfathered NULL-details rows are
skipped for the same reason (nothing to show). Two event types:

| event | rule | label shape | bucket |
|---|---|---|---|
| `result_entered` | `result_value` changed from `None` → value, and it is the only material change | `Result entered — Sterility USP<71>: Not Detected (P-0145-S02)` | `info` |
| `analysis_amended` | any other non-empty `changed` (result corrections, method/instrument changes, reportable flips, un-promote clears, retested flips) | `Result corrected — Sterility USP<71>: 0.92 → 0.95 (P-0145-S02)` — per-field before → after in the label; full `changed` map in `details` | `warn` |

Amendments render `warn` deliberately — corrections are exactly what an ISO assessor scans an
activity log for, so they must be visually distinct from routine flow.

**Frontend:** `SampleActivityLog.tsx` renders events generically (label + details + a
per-event-string style/icon map at `:40-68`). Change = two entries in the bucket map, two icons.
No new rendering machinery.

This block reads only Mk1 tables — consistent with the scope ruling (no SENAITE values).

## 3. Non-goals (explicit)

1. **Backfill** — impossible, see §2.4.
2. **DB-level immutability** (trigger / `REVOKE UPDATE` on the transitions table) — separate
   hardening ruling, not needed pre-audit; append-only stays app-discipline for now.
3. **CASCADE tombstones** (audit rows dying with their sample/vial — "gap 2" from the 2026-08-07
   architecture assessment) — separate spec; needs its own ruling on soft-delete vs no-delete
   doctrine.
4. **SENAITE-side history migration** — belongs to the phase-out program, not here.
5. **Retro-display of pre-slice history** — grandfathered NULL-details transitions stay out of the
   activity log (there is nothing to render); they remain retrievable via the GET-by-id chain.

## 4. ISO/IEC 17025 mapping

| Clause | Status after this slice |
|---|---|
| 7.5.1 technical records attributable (who/when) | already met (`user_id`, `occurred_at` on every transition) |
| 7.5.2 amendments traceable to original observations | **met for tracked-field changes flowing through the transition write sites** — before/after in the same transaction, on the same append-only row that records who/when/why. `prep_bridge`'s instrument stamp: CLOSED (2026-08-10 ruling, kwargs through the choke point). `worksheet_analyst`: PARKED by ruling (own event-log audit suffices). Sole remaining hole: `set_reportable`'s pre-existing early-return on reason-only edits (no row at all) — **ruling still open** |

## 5. Testing

House rule applies: judge the backend suite as a **failure-SET diff** against the 64-failure
baseline, never a count.

New tests in a new file `tests/test_amendment_audit.py`, reusing the fixture idiom from
`tests/test_parent_placeholders.py`:

1. **The self-edge correction** — submit "0.92", re-submit "0.95" from `to_be_verified`: second
   transition row carries `{"changed": {"result_value": {"before": "0.92", "after": "0.95"}}}`.
2. **Reset** captures every cleared field.
3. **`set_method_instrument`** captures old→new ids; **`set_reportable`** captures flag + reason.
4. **Un-promote** (via vial source-retest) captures the parent's cleared value.
5. **Pure state move** writes `{"changed": {}}` (not NULL).
6. **Grandfathered NULL** — a hand-inserted NULL-details row serializes without error through
   `AnalysisWithTransitions`.
7. **The grep guard** (§2.3) — every construction site passes `details=`.
8. Promote/retest flows still green (their transition rows now carry `{"changed": {}}` — asserts
   the helper doesn't perturb them).
9. **Activity blend** — after an entry + correction on a vial analysis, the activity endpoint
   returns one `result_entered` and one `analysis_amended` event with the vial label and
   before/after values; state-only and NULL-details rows produce no events.

SQLite-fixture caveat from the placeholder program does **not** bite here: no index/constraint
semantics are involved — a JSON column behaves identically enough in both engines for these tests
to be honest.

## 6. Sequencing & size

- **After** `feat/native-parent-placeholders` merges (same-file conflicts otherwise).
- One PR, additive only: 1 model column + 1 migration + 1 helper + 10 write-site touches
  + 1 schema field + 1 activity-source block + 2 FE style-map entries + tests. No behavior change
  to any state machine edge, reader, or COA path — logic never reads `details`; only the activity
  aggregator and the transitions serializer surface it.
- Estimated diff: ~220 lines production (BE ~200 / FE ~20), ~300 lines tests.
