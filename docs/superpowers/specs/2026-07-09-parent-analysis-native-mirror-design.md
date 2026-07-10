# Parent Analysis Line-Items → Accu-Mk1 (native shadow mirror)

*Design spec — 2026-07-09. SENAITE phase-out program, slice: "analysis line items."*

## Context

The SENAITE phase-out program mirrors each section of SENAITE data into Accu-Mk1 as a read-shadow via **dual-write at the Mk1 save sites**, then flips reads once proven — the pattern that shipped basic-info (`lims_samples`) and went live for everyone 2026-07-09. Program order: basic-info ✅ → **analysis line items (this slice)** → state system → small items → COABuilder re-wire last.

Today a parent sample's **basic info** is registry-native, but its **analysis line items** — the per-service rows (result, review_state, method/instrument/analyst) on the parent AR — still live only in SENAITE. Mk1 fakes them on the sample-details page with an FE keyword-join overlay. This slice gives those line items a native home so later slices (state ownership, the sterility PCR/USP<71> split, the order-status page, COABuilder) can read them from Mk1.

**The end-goal shape** the user chose (Option A): a single canonical home for parent analyses in the existing `lims_analyses` table, reached in fewer steps than a separate parallel structure. Because that table is already read live by certificate generation, the mirror must be **fail-closed**: incapable of reaching a customer certificate until we deliberately flip it.

## Goal

Every Mk1-side write that pushes a parent analysis change to SENAITE also writes a **native shadow row** in `lims_analyses`, keyed to the parent. Faithful mirror of result, state, method/instrument, timestamps, and a transition audit trail. SENAITE stays system-of-record; the shadow is read-dormant.

## Non-goals (explicitly deferred to later slices)

- **Owning the state machine.** Shadow rows are not driven through the tier-gated native state machine; their state is copied from SENAITE. Native authority over submit/verify/etc. is the next slice ("state system").
- **Flipping reads.** The FE overlay keeps rendering from SENAITE; no reader consumes shadow rows this slice.
- **Reconcile backstop for SENAITE-UI-origin edits.** Nothing reads the shadow, so staleness is invisible until the read-flip. Deferred (avoids re-introducing `complete=yes`-adjacent bulk load).
- **Integration Service changes.** The IS-proxied composition writes are covered Mk1-side (below).

## The write surface (verified inventory)

The complete parent-analysis SENAITE write surface is nine endpoints through two mechanisms (`POST /@@API/senaite/v1/update/{uid}` and one Plone `workflow_action`). State of native mirroring today:

| Site | Endpoint → handler | Verb | Mirrored today? |
|---|---|---|---|
| A1 | `POST /wizard/senaite/analyses/{uid}/result` → `set_analysis_result` (`backend/main.py:13690`) | set result | **NO — gap** |
| A2/A3 | `POST /wizard/senaite/analyses/{uid}/transition` → `transition_analysis` (`backend/main.py:13840`) | submit/verify/retract/reject/retest (row + bulk) | **NO — gap** |
| A4 | `POST /wizard/senaite/analyses/{uid}/method-instrument` → `set_analysis_method_instrument` (`backend/main.py:13760`) | method/instrument | **NO — gap** (parent target) |
| A5 | `POST /explorer/samples/{id}/analytes/{slot}/replace` → `replace_analyte` (`backend/main.py:8849`) | swap identity analyte | partial (slot field + vial re-mirror) |
| A6 | `POST /wizard/senaite/samples/{id}/publish-coa` → `publish_sample_coa` (`backend/main.py:9965`) | publish AR | partial (VerificationCode) |
| A7 | `POST`/`DELETE /explorer/samples/{id}/analyses[/{keyword}]` → `add_sample_analysis` (`8611`) / `remove_sample_analysis` (`8718`) | add/remove line | vial-cascade only (IS does SENAITE write) |
| — | `POST /api/lims-analyses/promote` → `promote_to_parent` (`backend/lims_analyses/service.py:543`) + `writeback_promotion` (`backend/lims_analyses/senaite_writeback.py:241`) | vial result → parent | **YES — already dual-writes** the canonical parent row (born `verified`), fail-closed |

**The three gaps to close: A1, A2/A3, A4.** Promotion already creates the canonical parent row; A5/A6/A7 mirror partially and get extended to also stamp the shadow analysis row.

## Data model

Add to `lims_analyses` (additive columns + a sentinel state; migration is a hand-rolled idempotent `ALTER TABLE` per house convention, `backend/database.py`):

1. **`provenance TEXT NOT NULL DEFAULT 'canonical'`** — `'canonical'` for every existing/promoted row (backfill trivially via default), `'shadow'` for mirror rows. The semantic discriminator every reader filters on.
2. **Sentinel `review_state = 'senaite_mirror'`** for shadow rows — added to the live `review_state` CHECK constraint (`backend/database.py:751`) so inserts are valid, but **absent from every reader's `IN(...)` allow-list** (`_LIVE_RESULT_STATES`, `_SERIES_STATES`, `_VIAL_COA_STATES`). This is the fail-closed mechanism: a state-filtered reader excludes shadow rows without any code change; a reader that is *added later* and forgets a provenance filter still cannot surface a shadow row on the cert path, because it will only match rows whose state is in a real-states list.
3. **`mirror_review_state TEXT`** — the true SENAITE state of a shadow row (`submitted`/`to_be_verified`/`verified`/`published`/`retracted`/`rejected`). NULL on canonical rows. This is what the state-system slice promotes into `review_state` at the flip.

**Invariant (this slice):** `provenance='shadow'` ⟺ `review_state='senaite_mirror'` — the two are always set together, and either alone identifies a shadow row. `provenance` is the filter unfiltered readers use; the sentinel state is the fail-closed enforcement for state-filtered readers. Shadow rows never reach a certificate regardless of their `reportable` value — exclusion is enforced by state+provenance, not by `reportable`.

Result, unit, method_id, instrument_id, timestamps, `retested`/`retest_of_id`, `reportable`, and the `LimsAnalysisTransition` audit rows use the existing columns unchanged.

**Index change:** the parent partial-unique index `uq_lims_analyses_parent_service_root` (`backend/database.py:640`, `WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL AND review_state NOT IN ('retracted','rejected')`) must not let a shadow row collide with the promoted canonical row for the same (parent, service). Resolve by adding `AND provenance = 'canonical'` to that index predicate, and (optionally) a second partial unique index scoped to `provenance='shadow'` so shadows are also deduped one-per-(parent,service).

**Why `tier_of` is not a hazard:** `tier_of()` (`backend/lims_analyses/state_machine.py:180`) reads a `lims_sample_pk` row in a non-terminal state as a variance vial. A shadow row's `review_state` is the sentinel, and shadow rows are never driven through `apply_transition`, so `tier_of` is never consulted for them. Parent-line-state readers get an explicit provenance filter (below).

## Write path

New helper, modeled exactly on `apply_senaite_fields_to_row` (`backend/sub_samples/service.py:265`):

```
mirror_parent_analysis(db, senaite_uid, *, result?, review_state?, method_id?, instrument_id?, ...) -> bool
```

- Resolve the parent `LimsSample` + `analysis_service_id`/keyword from the SENAITE analysis uid (reuse `resolve_parent_analyte_target` / `find_parent_analysis_line`). Return `False` (silent no-op) when no registry parent row exists — the documented pre-registry contract callers already rely on.
- **Get-or-create** the shadow row for (parent, service, `provenance='shadow'`), born with `review_state='senaite_mirror'`; set `mirror_review_state` + the mirrored fields; append a `LimsAnalysisTransition` recording the mirrored change.
- **Retest** is special-cased as create-new-shadow-row (`retest_of_id` → prior shadow) + mark-old `retested=True`, matching `service.py:267` — it is not a state edit.

Hook after `raise_for_status()` at A1, A2/A3, A4 using the verbatim house guard (best-effort, `db.rollback()` nested-guarded, `logger.warning("registry.analysis_mirror_failed …")`, **never re-raise** — a mirror failure must never fail the user's edit). Extend A5/A6/A7 to also stamp the shadow row (A7 rides the existing Mk1-side `cascade_parent_add_to_vials`/`cascade_parent_remove_from_vials` that already fire after the IS proxy — no IS change).

## Read path — the audit checklist (grep-verified; each gets `provenance='canonical'`)

Reads do **not** change behavior this slice; the filter guarantees shadow invisibility.

- [ ] `backend/coa/source_resolver.py:268` (canonical COA results) — fail-closed by state; add explicit filter as defense-in-depth.
- [ ] `backend/coa/source_resolver.py:354` (`db.get` by row id) — cannot receive a shadow `mk1:` uid via canonical decisions; assert/guard.
- [ ] `backend/coa/variance_series.py:78` (`_parent_quantity_unit`) — fail-closed by state; add filter.
- [ ] `backend/families/service.py:65` (`_gather_analytes`) — **no state filter today; the provenance filter is mandatory here.**
- [ ] `backend/lims_analyses/service.py:1892` (parent-line-states) — add filter.
- [ ] Confirm-pass: `backend/lims_analyses/service.py:695, 815, 984` (promote-adjacent parent reads).
- [ ] Indexes `backend/database.py:568` and `:640`.

## Keying, birth timing, coverage gaps

- **Keying:** SENAITE analysis uid → parent + `analysis_service_id` + keyword via the existing promote/writeback resolvers. Parent AR keywords (`ANALYTE-{slot}-{cat}`, generic `HPLC-ID`) already have resolution machinery.
- **Birth timing:** shadow rows are born lazily on the first mirrored write (parallels `ensure_sample_row`); no parent-tier row is created at receive/seed today.
- **Not Mk1-hookable (documented, deferred to the read-flip's reconcile):** direct edits in the SENAITE UI / SENAITE-side workflow. Harmless this slice — nothing reads the shadow.

## Safety gates (before merge)

1. **COA output shadow-diff:** render a certificate for representative parents (HPLC promoted, variance, blend) with shadow rows present vs. absent; assert byte-identical output. This is the backstop that proves fail-closed holds even if a reader was missed.
2. The read-path checklist above, completed and attached to the PR as a grep-verified artifact.
3. Backend test-baseline failure-SET diff (gate on the set, not zero).

## Testing strategy

- Unit: `mirror_parent_analysis` get-or-create, retest branch, no-op-on-missing-parent, guard-swallows-errors.
- Integration: each hook (A1/A2/A4) writes SENAITE + shadow; a SENAITE failure aborts before the mirror and never leaves a shadow; the user edit still succeeds when the mirror raises.
- Fail-closed: assert `source_resolver` / `variance_series` / `families` return identical results with shadow rows present.
- Migration: sentinel accepted by the CHECK; index allows shadow+canonical coexistence; existing rows default `provenance='canonical'`.

## ISO 17025 alignment

The `LimsAnalysisTransition` audit trail on shadow rows preserves who/when/what for every mirrored change (traceability). The COA shadow-diff gate is coverage evidence that the mirror does not alter reported results. No reported result changes this slice — the shadow is non-reportable until an explicit, separately-gated flip.

## Open questions (non-blocking)

- Exact sentinel name (`senaite_mirror` proposed) and companion column name (`mirror_review_state` proposed).
- Whether to add the second `provenance='shadow'` partial unique index now or defer to the state-system slice.
- Whether A6 publish should mirror the analysis→`published` state onto existing shadow rows, or leave publish to the AR-level flow (lean: mirror it, for a complete shadow).
