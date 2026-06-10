# Spec: Variance-gated indicator + bulk Verify (Variance)

*2026-06-10. Surface which sub-sample rows belong to a variance series, across all
lifecycle states, and add a bulk "Verify (Variance) selected" action to the
selection toolbar. Pure FE, additive, no backend or schema change. Builds on the
variance addon (`2026-06-10-variance-testing-addon-design.md`, Phases 1+2).*

## Why

Variance entitlement is **parent-scoped** (`lims_samples.variance_override` today, the
WP→IS map after Phase 3) — every sub-hosted vial whose `assignment_role` maps to a
purchased key (n≥2) is a variance replicate. But the only visual cue today is the
`Verify (Variance)` row action and the "Ready to Verify" label flip, both of which
fire **only** when `review_state === 'to_be_verified'` (`canVarianceVerify`,
`AnalysisTable.tsx:198`). So a variance vial is invisible as such through every prior
state (unassigned, assigned, in progress, awaiting result). A tech can't tell that
PB-0076-S06 is an HPLC variance candidate until it's already sitting at sign-off.

Two gaps:
1. **No membership signal.** Nothing says "this row is part of a variance series"
   outside the sign-off moment.
2. **No bulk sign-off.** `Verify (Variance)` exists only in the per-row `...` menu;
   the bottom selection toolbar offers Promote/Retest/Retract/Reject but not variance
   sign-off, so a multi-vial series must be signed off one row at a time.

## What already exists (verified)

- **Entitlement plumbed into the table:** `AnalysisTable` receives `varianceEntitlement`
  (`Record<string,int>`, parent-scoped) and `ROLE_VARIANCE_KEYS`
  (`hplc→hplcpurity_identity`, `endo→endotoxin`, `ster→sterility_pcr`,
  `AnalysisTable.tsx:187`). `canVarianceVerify` (`:198`) uses both.
- **Demand split in AssignStep:** `plan.variance` (per-bucket n) drives the existing
  `VARIANCE · x/y` count lines (`AssignStep.tsx:498`, `VarianceCountLines`).
- **Lifecycle states:** sub rows end at `promoted` (canonical, `promoted_to_parent_id`
  set) or `variance_verified` (badged "Verified — Variance", `STATUS_LABELS:95`).
- **Bulk infra:** `deriveBulkActions` (`:256`) intersects allowed transitions across the
  selection; `showPromote` (`:280`) is a separate flag because Promote isn't a plain
  state transition. The toolbar (`:1731`) renders `bulkShowPromote` + `bulkAvailableActions`.
  `useBulkAnalysisTransition.executeBulk(uids, transition)` runs them sequentially.
  `variance_verify` is **not** in `BULK_TRANSITIONS` (`:248`) — it needs the same
  special-cased treatment as Promote, because its gate depends on parent entitlement
  that `deriveBulkActions` doesn't currently receive.

## Design

### 1. Membership predicate

New exported helper in `AnalysisTable.tsx`, next to `canVarianceVerify`:

```ts
/** True when a row is a member of a variance series — sub-hosted (native mk1: uid),
 *  its host vial's role maps to a parent-purchased variance key (n>=2). State-
 *  INDEPENDENT, unlike canVarianceVerify (which also requires to_be_verified &
 *  not-promoted). Drives the membership chip. */
export function isVarianceMember(
  a: SenaiteAnalysis,
  vialRole: string | null | undefined,
  entitlement: Record<string, number> | undefined,
): boolean {
  if (!a.uid || !a.uid.startsWith('mk1:')) return false
  const key = vialRole ? ROLE_VARIANCE_KEYS[vialRole] : undefined
  if (!key || !entitlement) return false
  const n = entitlement[key]
  return typeof n === 'number' && n >= 2
}
```

`canVarianceVerify` is unchanged (actionability stays separate from membership).

### 2. Row badge

In the row render (`AnalysisRow`, where `StatusBadge` is rendered, ~`:1273`):

- Render a small `Variance` chip next to the `StatusBadge` when
  `isVarianceMember(analysis, vialRole, varianceEntitlement)` is true,
  **suppressed** when:
  - `isPromoted(a)` — the row became the parent's canonical line; "Variance" reads wrong.
  - `a.review_state === 'variance_verified'` — already self-describes as "Verified — Variance".
- Styling: a muted/outline chip distinct from the colored status badges (e.g. sky/violet
  outline to echo the existing `text-sky-500` variance annotation in AssignStep). Reuse
  the `StatusBadge` chip shape (`inline-flex items-center px-2 py-0.5 rounded-md text-xs
  font-medium border`) for visual consistency.
- Tooltip / `title`: "Replicate in a variance series — signed off via Verify (Variance),
  never promoted."

Renders in both SampleDetails and QuickLook (both use `AnalysisTable`).

### 3. AssignStep bucket tag

In `Bucket` / `MicroBucket` headers (`AssignStep.tsx:476`, `:543`):

- When the bucket's `varianceN >= 2`, render a `Variance ×N` pill in the header
  (next to the `x/y` count), where N is `varianceN`. Complements — does not replace —
  the existing `VARIANCE · x/y` count line.
- Micro bucket: per-sub-zone (`endoVarianceN`, `sterVarianceN`); a pill on whichever
  sub-zone(s) have variance.
- No per-vial badge inside the bucket — the spec's "demand math, not vial designation"
  rule (`2026-06-10-variance-testing-addon-design.md` §2) means same-role vials are
  gated identically; a per-vial mark would imply a canonical-vs-variance choice that
  doesn't exist.

### 4. Bulk Verify (Variance) action

- Extend `deriveBulkActions` to accept `varianceEntitlement` and a
  `vialRoleFor(a) => string | null` resolver (or precompute per-row role on the
  selected analyses), and return an added `showVarianceVerify: boolean`:

  ```ts
  showVarianceVerify =
    selected.length > 0 &&
    selected.every(a => canVarianceVerify(a, roleOf(a), varianceEntitlement))
  ```

  `canVarianceVerify` already encodes the full per-row gate (native, `to_be_verified`,
  not promoted, entitled), so the bulk button shows only when **every** selected row
  qualifies. Mutually exclusive with `showPromote` in practice (a row is promotable
  XOR variance-verifiable).
- Toolbar (`:1771`): add a `showVarianceVerify` button labeled `Verify (Variance) selected`,
  `variant="default"` (non-destructive), that calls
  `bulk.executeBulk([...bulk.selectedUids], 'variance_verify')`. No confirm dialog
  (non-destructive, mirrors Promote's lack of a destructive gate).
- The "No common actions for selection" fallback (`:1800`) must also account for
  `showVarianceVerify` (don't show it when the variance button is present).
- Backend gate (`ensure_variance_entitlement`) stays authoritative and fail-closed per
  row — the FE flag only controls visibility.

### 5. Data flow / wiring

- `varianceEntitlement` and the per-row vial role are already available where the row
  badge and `deriveBulkActions` are called (`selectedAnalyses` is built at `:1649`;
  thread the same role lookup the row render uses). No new fetch.
- `vialRole` resolution: rows already resolve their host vial's `assignment_role` for
  `canVarianceVerify` (`:1169`). The bulk path must resolve the same per selected row;
  if a clean per-uid role map isn't already in scope, build one from the groups/vial
  data already present rather than adding a request.

## Out of scope

- Backend / schema / endpoint changes (none — all inputs already exist FE-side).
- Changing what variance *means* or the gate logic (`canVarianceVerify` unchanged).
- AssignStep drag-zone split (explicitly rejected: no canonical-vs-variance vial).
- COA variance rendering (own spec).

## Testing

- `variance-verify-gating.test.tsx` / `status-badge.test.tsx`: `isVarianceMember`
  true across non-terminal states for an entitled sub-hosted role; false when
  unentitled / parent-hosted / non-mk1; chip suppressed on `promoted` and
  `variance_verified`.
- `deriveBulkActions`: `showVarianceVerify` true only when ALL selected rows pass
  `canVarianceVerify`; false if any is unentitled, promoted, promotable, or not
  `to_be_verified`; mutual exclusivity with `showPromote`.
- `assign-step.test.tsx`: `Variance ×N` pill renders when `varianceN >= 2`, absent
  otherwise; Micro per-sub-zone.
- Pre-existing failures baselined per the project rule (stash-baseline is the arbiter);
  don't chase unrelated reds.
- Live verification on the stack against PB-0076 (HPLC variance n=2 already set): chip
  visible on S06's HPLC rows pre-signoff, gone once promoted/variance-verified; bucket
  pill in Assignment tab; bulk button appears when only entitled to_be_verified rows
  are selected and signs them off.

## Build order

1. `isVarianceMember` predicate + row badge (§1, §2).
2. AssignStep bucket pill (§3).
3. Bulk `showVarianceVerify` + toolbar button (§4).

Each task: tests + live check, per-task commit
(`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).
