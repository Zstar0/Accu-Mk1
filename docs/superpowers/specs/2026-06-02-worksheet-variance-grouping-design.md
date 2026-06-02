# Worksheet Sub-Sample Grouping + Variance Set — Design

**Date:** 2026-06-02
**Scope:** Group sub-samples on the worksheet inbox so a parent's vials present as a single draggable family card; add a per-parent variance set with selectable membership, lockable for downstream COA aggregation. Mk1-only changes; SENAITE, integration-service, and coabuilder untouched in this phase.
**Repos touched:** `Accu-Mk1` only.
**Predecessor phases:** `feat/sub-samples` (vial intake), `feat/vial-assignment-step` (HPLC / ENDO / STER / XTRA role assignment).
**Successor phase:** Variance Addon (coabuilder COA section that consumes locked variance sets — separate spec).

---

## Goals

- **One family card per `(parent × service_group × hplc-domain)`** on the worksheet inbox. A 5-vial HPLC order with 2 service groups currently produces 10 cards; this design reduces it to 2 family cards, each containing 5 vials.
- **Collapsed-by-default family card with atomic whole-family drag.** Expanding the card surfaces per-vial drag handles for precision moves. Matches the collapse pattern already shipping on the SENAITE samples list.
- **Per-parent variance set** with explicit user-controlled membership. Each vial in a family can be checked in or out of the variance set with an optional exclusion reason. Statistics (mean, SD, CV%) compute over selected vials only.
- **Variance set lockable** — two-click commit gate; locked sets are read-only at the per-vial layer until an admin unlocks. Locked sets are the contract the future Variance Addon will read.
- **Backward-compatible.** Single-vial orders render the same flat card they always have; no group chrome on degenerate families.
- **Sterility / endo / xtra vials excluded from variance by default.** HPLC variance is HPLC's concern. The backfill captures this; per-vial opt-in remains possible for special cases.

## Non-goals

- **No SENAITE schema changes.** Variance membership is Mk1-internal. SENAITE keeps its workflow per-AR with no awareness of variance grouping.
- **No integration-service changes.** IS does not learn about variance sets.
- **No WordPress / customer-facing changes in this phase.** Variance results land on the COA only when the Variance Addon ships (separate phase). Customer doesn't see "vial X excluded" until then.
- **No multiple variance sets per parent.** One variance set per parent AR, no exceptions. A future "advanced mode" could revisit this if real lab need surfaces.
- **No worksheet run-sequence changes.** HPLC sample prep sequencing lives in a different system and bulk-processes samples independently of variance set membership.
- **No new `assignment_role` value for "variance candidate."** Variance membership is orthogonal to role assignment. A vial's role stays driven by the wizard's auto-assign + manual override; variance is a separate boolean.
- **No automated variance computation on result entry.** Stats display on the summary page; per-vial result entry is unaware of variance state until the user opens the summary.
- **No upstream WP "variance run" service line.** Whether the lab decides to run multiple HPLC vials for variance stays an internal decision driven by manual vial assignment. Demand-bump on the assignment side is a separate concern outside this spec.

## Architecture

### Family card model

A **family** is keyed by `(parent_sample_id, service_group, hplc-domain)`. The HPLC inbox renders one family card per key, containing the family's HPLC-role vials that have analyses in the given service group.

Same parent appears in **multiple family cards** when its vials span multiple service groups (e.g., `Analytics` + `Core Panel`). This mirrors today's `(sample × service_group)` card structure — the unit changes from a single AR to a parent's vial set, but the cross-service-group breakdown stays intact.

Mixed-role parents (e.g., 3 HPLC + 1 sterility) show one family on the HPLC inbox (3 vials) and separate families on each micro inbox view. A **sibling context badge** on the HPLC card reads `+1 sterility · +1 extra` so the tech sees the full order shape without those vials appearing in the HPLC inbox.

### Variance set

The variance set is a per-parent subset of family vials selected for variance computation. Membership is a stored boolean on each vial row (parent and sub-sample). Default `TRUE` for new HPLC-role vials, `FALSE` for non-HPLC roles (via migration backfill — see *Data model* below).

Variance set state transitions:

- **Unlocked** (default) — tech edits membership freely from the variance summary page. Per-vial result entry is open.
- **Locked** — `variance_locked_at` and `variance_locked_by_user_id` set. Membership and per-vial results immutable. A "Locked — unlock to edit" banner appears on per-vial pages. Lock is two-click (button → confirm dialog).
- **Admin unlock** — restores unlocked state. Audit fields cleared.

Lock requires `n_selected ≥ 2` (variance is undefined for n=1).

### Source of truth

- **SENAITE** remains canonical for sample hierarchy and analysis results.
- **Mk1 `lims_samples` / `lims_sub_samples`** owns variance set membership + lock state. These fields exist nowhere else.
- The future Variance Addon (coabuilder) will read locked variance sets via a Mk1 API; until that lands, the data is captured but unused downstream.

## Data model

Five additive columns. All migrations land in `database._run_migrations()` via `ADD COLUMN IF NOT EXISTS`.

### `lims_sub_samples`

```
ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS in_variance_set           BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS variance_exclusion_reason TEXT;
```

### `lims_samples` (parent shares the membership model since parent is vial 1)

```
ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS in_variance_set            BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS variance_exclusion_reason  TEXT;
ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS variance_locked_at         TIMESTAMP;
ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS variance_locked_by_user_id INTEGER REFERENCES users(id);
```

### Backfill

After column add, flip non-HPLC sub-samples out of the default variance set:

```sql
UPDATE lims_sub_samples
   SET in_variance_set = FALSE,
       variance_exclusion_reason = 'auto: assignment_role != hplc'
 WHERE assignment_role IN ('endo', 'ster', 'xtra')
   AND in_variance_set = TRUE;
```

Idempotent on re-run — rows already flipped don't match the predicate. Parent table needs no backfill: parent role is always `hplc`.

### `lims_samples.in_variance_set` semantics

`TRUE` on the parent means the parent participates in its own variance set. Default `TRUE` is correct because the parent is vial 1 of the family.

### Why stored vs. derived

`in_variance_set` could be a derived column (`assignment_role = 'hplc' OR assignment_role IS NULL` minus explicit exclusions). Stored is preferred because:

- Lets a tech opt a sterility vial into variance for a one-off justified case (rare but legitimate)
- Decouples membership from role — assignment_role drift won't silently change variance results
- Lock state needs stored fields anyway; consistency benefit from co-locating membership

The backfill is the cost. One-row UPDATE per row matching the predicate. Tiny.

## API endpoints

```
GET    /api/sub-samples/{parent_sample_id}/variance-set
       → {
           parent: { sample_id, locked_at, locked_by_user, ... },
           vials: [
             {
               sample_id, vial_sequence, is_parent,
               in_variance_set: bool,
               exclusion_reason: str | null,
               results: { Purity: ..., Identity: ..., Quantity: ..., ... },
               status: review_state,
             }
           ],
           stats: {
             "Purity": { mean, sd, cv_pct, n, spec, pass },
             "Identity": { conforms_count, total, pass },
             "Quantity": { mean, sd, cv_pct, n, spec, pass },
             ...
           },
           locked: bool,
         }

PATCH  /api/sub-samples/{sample_id}/variance-set
       body: { in_variance_set: bool, exclusion_reason?: str | null }
       → updated vial row; 409 when family is locked

POST   /api/sub-samples/{parent_sample_id}/variance-set/lock
       → variance_locked_at = NOW(), variance_locked_by_user_id = current_user
       → 422 when n_selected < 2

POST   /api/sub-samples/{parent_sample_id}/variance-set/unlock
       → admin role required (403 otherwise)
       → clears lock fields; family becomes editable again
```

### Worksheet inbox endpoint — grouped shape

`/worksheets/inbox?grouped=true` returns families instead of flat samples:

```
{
  families: [
    {
      parent_sample_id: "P-0142",
      wp_order_number: "5234",
      priority: "high",
      client_id: "WellnessCo",
      peptide_name: "BPC-157",
      earliest_received: "2026-05-30T...",
      analyses_by_group: [...],          // union across vials — for the family card header
      vials: [
        { sample_id, vial_sequence, is_parent, assignment_role,
          review_state, analyses_by_group, in_variance_set, ... }
      ],
      sibling_context: { ster_count: 1, endo_count: 0, xtra_count: 1 },
    },
    ...
  ],
  total_families: int,
  total_vials: int,
}
```

`?grouped=false` preserves today's flat `InboxSampleItem[]` shape — kept available for one release as a rollback safety net, then removed.

### Service layer

Pure-ish helpers compose with existing infrastructure:

- `service.compute_variance_stats(vials: list[dict]) -> dict` — pure, no DB. Per-keyword stats. Identity (categorical) returns `{conforms_count, total, pass}`. Numeric keywords return `{mean, sd, cv_pct, n, spec, pass}`. Vials with `in_variance_set=False` skipped.
- `service.list_inbox_families(db, hide_test_orders, hide_prepped) -> InboxResponse` — wraps the existing SENAITE inbox fetch (preserves the 30-min cache untouched), enriches with `lims_sub_samples` data, groups by parent.
- `service.set_variance_membership(db, sample_id, in_set, reason) -> dict` — single-vial mutation. Refuses with 409 when the parent's `variance_locked_at IS NOT NULL`.
- `service.lock_variance_set(db, parent_sample_id, user) -> dict` — asserts `n_selected ≥ 2`, sets lock fields.
- `service.unlock_variance_set(db, parent_sample_id, user) -> dict` — admin-only; clears lock fields.

## UI changes

### Inbox: family card

**Collapsed state** — default for every family with vial count > 1:

```
[PRIORITY]  P-0142 · N vials                                  ▼
            <peptide_name> (<service_group>)
            <client> · WP #<order_number>
            Analyses: <list shared across vials>
            Received Nd ago · <sibling_context_badge>     <assignment_summary>
```

- Single draggable target — dragging the card drops the entire family on a worksheet drop panel.
- Expand chevron `▼` opens the per-vial rows.
- Sibling context badge clickable → popover with sub-sample IDs on other roles.

**Expanded state** — per-vial rows surfaced:

```
[PRIORITY]  P-0142 · N vials                                  ▲
            (header same as collapsed)

  ┌────────────────────────────────────────────────────────┐
  │ ⠿ P-0142          Vial 1 (parent)    Replicate    HPLC │
  │ ⠿ P-0142-S01      Vial 2             Replicate    HPLC │
  │ ⠿ P-0142-S02      Vial 3             Replicate    HPLC │
  │ ...                                                    │
  └────────────────────────────────────────────────────────┘
       [ Drag whole family ]
```

- Whole-family drag handle is replaced by an explicit `[ Drag whole family ]` button in the expanded state to prevent accidental whole-family drops during per-vial work.
- Each row has its own grab handle. Dropping a single vial removes it from the family in the inbox; the family card re-renders with N-1 vials.

**Singleton families** (vial count = 1) render flat. No expand chevron, no vial count line, no `Replicate` badge. Identical to today's card.

### Worksheet sample list panel

Mirrors the inbox grouping. Families collapse-expand the same way. A `Variance summary` row at the bottom of each family with vial count ≥ 2 opens the variance summary page.

```
▼ P-0142 · 5 vials   BPC-157 (HPLC)        in-prep
    P-0142            Vial 1 (parent)      ▢ no data
    P-0142-S01        Vial 2               ▢ no data
    ...
    ⊕  Variance summary                    —
    ⊖  Remove family from worksheet

▶ P-0151                                   in-prep
   GHK-Cu (HPLC) — singleton, no group chrome
```

### Per-vial result-entry panel

Existing per-vial result entry stays as-is. Two additions:

- **Replicate context strip** at the top: `Vial N of M · Replicate context: variance set of N — currently k/N results entered · Family running mean ...`. Hidden for singleton families.
- **`[< prev vial]` / `[next vial >]`** navigation buttons in the panel header — fast traversal across family members without leaving the panel.

When the variance set is locked, the entry form's inputs become read-only (values stay visible) and a banner appears at the top reading `Locked at <timestamp> by <user>. Unlock to edit.` Admins see an inline `Unlock` button next to the banner.

### Variance summary page

New route: `/samples/{parent_sample_id}/variance-summary` (or equivalent — final URL TBD with router). Read-only result columns, checkbox membership editor, computed stats, lock control.

```
P-0142 — Variance Summary                     N vials in family · k in variance set

  Select which vials participate in variance:

  ✓  P-0142          Vial 1 (parent)   <results columns>
  ✓  P-0142-S01      Vial 2            <results columns>
  ☐  P-0142-S04      Vial 5            <results columns>
                                       Reason: <text>  [edit]

  [ Select all ]   [ Clear all ]

  Computed across selected (n=k):

  Purity (HPLC)       Mean ...   SD ...   CV% ...   spec ...   ✓ PASS
  Identity (HPLC)     ✓ Conforms (k of k)            spec ...   ✓ PASS
  Quantity (HPLC)     Mean ...   SD ...   CV% ...   spec ...   ✓ PASS

  [ Lock variance set ]   (disabled until ≥2 vials selected)
```

Per-vial result columns are read from the existing per-vial result entry (not editable here). Lock button gates downstream effects (Variance Addon — future).

## Error handling

### Worksheet inbox

- **SENAITE timeout / failure**: existing 30-min cache + serve-stale behavior unchanged. Grouping happens after the SENAITE fetch, so grouping errors are downstream and surface as a partial inbox.
- **lims_sub_samples query failure**: family enrichment falls back gracefully — group by parent_sample_id alone, vials list shows the parent only with a `couldn't load vial details` toast.

### Variance set mutation

- **PATCH on locked family**: 409 with `{ code: "variance_locked", locked_at, locked_by_user }`. Frontend shows the locked banner.
- **Lock with n_selected < 2**: 422 with `{ code: "variance_too_few_vials", required: 2, selected: n }`.
- **Unlock without admin role**: 403.
- **Lock race condition** (two techs lock at once): existing row-level transaction semantics; second lock no-ops since `variance_locked_at` is set.

### Drag operations

- **Drop family on a worksheet that already has a vial from this family**: silently merge into existing entries on that worksheet — frontend dedupes by `sample_id`. No surface warning unless the merge would create a state conflict (e.g., partial assignment).
- **Drop individual vial on different worksheet than family**: family stays in inbox with N-1 vials. Variance summary on that family later will skip the moved-vial's results since they live elsewhere — but the moved vial can still be selected for variance from the summary page if the tech wants (the data is global, the worksheet is just an assignment view).

### Variance computation edge cases

- **All vials excluded** (`n=0`): stats show `—` for all rows. Lock button disabled.
- **Single vial selected** (`n=1`): mean shows, SD/CV show `—` (undefined). Lock button disabled.
- **Mixed pass/fail across selected vials**: stats compute over the included values. Pass status reflects mean vs. spec, not per-vial pass. Per-vial fail is visible in the row but doesn't auto-exclude.
- **Numeric vs. categorical**: stats helper dispatches by keyword type. Identity always categorical. Quantity uses declared-weight spec window cached in `lims_samples`.
- **Result not yet entered**: vial shows `—` in result columns. If `in_variance_set=TRUE` and result missing, stats compute over the entered-results subset and show `n < selected` so the tech sees the gap.

## Testing

### Backend unit (pytest)

- `compute_variance_stats`: singleton, normal multi-vial, all-excluded, mixed-pass-fail, identity categorical, quantity with spec window, decimal precision, NaN guards
- `set_variance_membership`: lock guard, reason-field handling, refresh-on-mutate
- `lock_variance_set`: n<2 rejection, sets fields, idempotent on re-lock
- `unlock_variance_set`: admin-only, clears fields
- `list_inbox_families`: grouping correctness, sibling_context counts, singleton fall-through

### Backend integration (against local SENAITE)

- `/worksheets/inbox?grouped=true` end-to-end against snapshot — families resolve correctly, sibling counts match
- Variance set round-trip — PATCH membership, GET reflects, lock, PATCH refuses
- Lock + unlock flow with non-admin / admin users

### Frontend unit (vitest)

- Family card render matrix: singleton, multi-vial, with-siblings, locked
- Expand-collapse state machine
- Variance summary checkbox interactions + `Select all` / `Clear all`
- Replicate context strip computation

### E2E (Playwright)

- Drag family to worksheet, open variance summary, exclude one vial with reason, lock the set, see locked banner on per-vial page
- Drag individual vial out of a family expanded inbox card, verify family card re-renders
- Admin unlock flow

## Rollout

### Deploy sequence

1. **Backend deploy** — schema migration, new endpoints, `?grouped=true` shape on the inbox endpoint. UI exposes none of this yet; safe to ship.
2. **Frontend deploy** — family card on inbox + worksheet variance summary page. Cuts over to `?grouped=true` by default. `?grouped=false` remains available for one release as a rollback escape hatch.
3. **Future** — Variance Addon (coabuilder) consumes locked variance sets. Separate spec.

No feature flag wrapping. Mk1 is internal; the lab can revert the inbox via `?grouped=false` directly in the URL bar if the new card pattern misbehaves.

### Backward compatibility

- **Singleton orders** render flat — no group chrome.
- **Pre-existing sub-sample families with results already entered**: defaults populate (`in_variance_set=TRUE` for HPLC-role, `FALSE` for non-HPLC). Tech reviews and locks normally.
- **Pre-existing worksheets**: items render as today; variance summary is a new affordance reachable from any family the worksheet contains, regardless of when it was created.
- **Lock state**: pre-existing data starts unlocked. Locking is opt-in.

## Observability

- Log every variance lock / unlock: parent ID, user, timestamp, n_selected, previous state.
- Log family grouping inbox responses: family count, vial count, time-to-group (post-SENAITE-fetch).
- WARN level on lock-on-locked attempts (row contention surfaces here).
- WARN level on inbox endpoint when `?grouped=false` is requested after the cutover — signals rollback usage.

## Open items resolved at planning time

- **Final URL for variance summary page** — `/samples/{parent_id}/variance-summary` is the working assumption; confirm at planning time against the existing router structure.
- **Whether to show the variance summary entry point on singleton families** — currently hidden; consider showing it as disabled-with-tooltip so the affordance is discoverable.
- **Default membership for unassigned (role IS NULL) vials** — currently `TRUE` (treated as eligible HPLC). Confirm this matches lab intent; the alternative is `FALSE` until role is assigned.
- **Whether locking should cascade to lock the underlying per-vial SENAITE workflow state** — current design says no, locking is Mk1-internal only.

## Future phases (named, not built)

- **Variance Addon** (coabuilder): COA section that consumes locked variance sets and renders mean ± SD per analysis. Adds a new page to the COA when the parent's variance set is locked.
- **Variance demand upstream**: a WP service line that signals "this is a variance order, N vials," which would bump the assignment system's `derive_demand` to expect N HPLC vials instead of 1. Removes the manual XTRA-promotion step in the wizard.
- **Multiple variance sets per parent** — a single order containing multiple compared groups (e.g., morning batch vs afternoon batch). Out of scope for v1; revisit if real demand surfaces.
- **Per-keyword variance set membership** — currently membership applies to the whole vial. Per-keyword would let a vial participate in Purity variance but skip Identity variance. Unlikely to be needed.
- **Variance trend analysis across orders** — comparing CV% across recent runs to flag method drift. Reporting concern, not this spec.
- **Customer-facing variance request flow** in WordPress — checkbox on order form, bumps internal demand. Coupled to the Variance Addon ship.
