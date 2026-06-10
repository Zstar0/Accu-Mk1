# Spec: Variance Testing Addon — per-service replicates, `variance_verified` lifecycle

*2026-06-10. Clients can buy **variance testing** per service (HPLC panel, Endotoxin,
Sterility, and future tests): n replicate vials from one lot, tested independently,
reported as variance statistics (mean / SD / CV%). Full-chain design: WP addon →
integration-service contract → Mk1 vial demand + Assignment UI → a new
**`variance_verified`** sub-sample lifecycle state for replicates that are signed off
but never promoted. Mk1 is built first (testable on the stack with a simulated
services payload); IS exposure and the WP product follow. Builds on the promoted-state
spec (`2026-06-08-subsample-workflow-promoted-state-design.md`) and its 2026-06-10
amendment.*

## Why

Variance testing means 2–3+ samples from one client lot, each fully tested. Only one
result per keyword can be the parent's canonical row (partial unique index on
(parent, keyword); the COA resolver treats >1 live candidates as a conflict; the
SENAITE write-back targets *the* parent AR line — three writes to one line is
last-write-wins). So replicate results **cannot all promote**. Today the only "done"
path for a sub-sample row is `promoted` — a variance replicate would be stranded at
`to_be_verified` ("Ready to Promote") forever, with no way for a senior tech to sign
it off.

Decision (Option B from design discussion): replicate results **stay on the
sub-samples** and get a distinct sign-off state, `variance_verified`. The parent
keeps exactly one canonical row per keyword (the parent's own HPLC run, or the one
promoted endo/ster vial); the variance series is evidence, consumed by
`compute_variance_stats`, not by promotion. Plain `verified` is NOT reused — the
promoted-state spec removed sub-level `verify` to kill the stranded-verified-sub bug
class, and a distinct state keeps the two "done" paths structurally separate.

## The scoping rule (keeps the analyte explosion out)

Variance counts attach **only to the coarse WP service keys that already drive vial
demand** — `hplcpurity_identity`, `endotoxin`, `sterility_pcr` (future service keys
join automatically). **Never to individual analytes.** A variance vial assigned to
HPLC is seeded with the parent's complete mirrored analyte set (per-substance
`PUR_<X>` / `QTY_<X>` / identity) by the existing assignment mirror — "HPLC variance"
always means the full panel per compound with zero per-analyte configuration.
`compute_variance_stats` already computes per-keyword stats across vials.

## What already exists (verified)

- **Mk1 membership + lock:** `lims_samples.in_variance_set` (`models.py:740`,
  default TRUE — the parent counts as a replicate) and
  `lims_sub_samples.in_variance_set` (`models.py:772`);
  `variance_locked_at/by` + `lock_variance_set` / `unlock_variance_set`
  (`sub_samples/service.py:1046,1066`) with a minimum-selection guard.
- **Stats:** `get_variance_set` (`sub_samples/service.py:954`) reads each vial's results
  regardless of promotion; `compute_variance_stats` (`sub_samples/variance.py`)
  does numeric (mean/SD/CV%/spec-pass) and categorical (conforms k/n) per keyword.
  `VarianceSummary` FE component renders it.
- **COA:** source mode `'variance_set'` is already reserved
  (`models.py:907`, `pin | auto | variance_set`).
- **Integration-service:** order model carries `services.samplevariance` +
  per-sample `variance_value`; `order_validator.py` parses it to `variance_count`
  (int, validation error on garbage); webhook ingestion logs both
  (`app/api/webhook.py:483-487`); SENAITE adapter attaches a `sample_variance`
  profile (`SENAITE_VARIANCE_PROFILE_UID`). **Single flag + single count today.**
- **Demand chain:** Mk1 `_fetch_wp_services_for_parent`
  (`sub_samples/service.py:346`) → IS order-services payload → `derive_demand`
  (`:506`) maps service keys → per-bucket counts → `get_vial_plan` → `auto_assign`
  (`:638`) → `AssignStep.tsx` buckets (MicroBucket already renders ENDO/STERILITY
  sub-rows — the pattern variance reuses).
- **Lifecycle:** promoted-state spec + amendment: sub rows end at `promoted`
  (via promote) and offer no manual transitions from it; corrections via parent
  retest cascade.

## Design

### 1. Data contract (WP → IS → Mk1)

Per-sample **variance map** keyed by service key, count = **total n in the set**
(including the canonical carrier):

```json
"variance": { "hplcpurity_identity": 3, "endotoxin": 2 }
```

- Validation (IS `order_validator`): each value an int **≥ 2** (n=1 ≡ no variance;
  reject with a per-sample validation error like the existing `variance_value` one).
  A variance key is only valid when the corresponding service is actually ordered
  (`variance.endotoxin` requires `services.endotoxin` — otherwise reject), so
  demand math can never demand vials for an unordered test.
- **Back-compat:** legacy `samplevariance` + `variance_value` stay; when only the
  legacy pair is present, IS normalizes it to
  `{ "hplcpurity_identity": variance_count }`. The SENAITE `sample_variance`
  profile keeps attaching when any variance is present.
- **IS → Mk1:** the order-services endpoint Mk1 consumes adds the (normalized)
  `variance` map alongside the existing boolean service keys.
- **WP addon product (own build phase):** per-test variance quantity selectors,
  priced per extra item (client buys n−1 extras on top of the base test);
  serializes to the map. Detailed WP form/pricing UX may get its own spec at build
  time — the contract above is what it must emit.

### 2. Vial demand + check-in (AssignStep)

- `derive_demand`: per-bucket demand = `max(base_demand, variance_n)` for the
  bucket the service key maps to (`hplcpurity_identity`→hplc, `endotoxin`→endo,
  `sterility_pcr`→ster). E.g. HPLC base 1, variance n=3 → hplc demand 3 (parent +
  2 subs fill it); endo base 1, n=2 → endo demand 2.
- `get_vial_plan` response adds the per-bucket variance breakdown
  (`variance: {hplc: 3, endo: 2}` or equivalent) so the FE can render sub-rows.
- **AssignStep UI:** buckets with variance render sub-rows exactly like
  MicroBucket's ENDO/STERILITY split:

  ```
  ANALYSES DEPT.        3 / 3
    HPLC · 1/1
    VARIANCE · 2/2
  ```

  The sub-rows are **demand math, not vial designation** — all vials stay plain
  `assignment_role='hplc'` (bench routing + analyte-mirror seeding unchanged);
  the first fills the base row, surplus fills VARIANCE. Front desk never chooses
  a "canonical" vial. `in_variance_set` stays default-true.
- EXPECTED VIALS header reflects inflated counts; the existing received-vs-expected
  check works unchanged. `auto_assign` works unchanged (it just sees bigger demand).

### 3. Sub-sample lifecycle: `variance_verified`

State machine (`lims_analyses/state_machine.py`):

- `STATES` += `variance_verified`. **Non-terminal** (retest legal from it);
  `TERMINAL_STATES` unchanged (`published`, `rejected`).
- `TRANSITION_KINDS` += `variance_verify`. The transitions table's
  `transition_kind` CHECK constraint is extended accordingly (idempotent ALTER —
  unlike the promote audit which reused `'auto'`, sign-off deserves a first-class
  audit kind).
- `_ALLOWED` += `("to_be_verified", "variance_verify") -> "variance_verified"`.
- `_TIER_ALLOWED_KINDS[TIER_VIAL]` += `variance_verify`; parent tier unchanged.
  The generic `verify` stays blocked at the vial tier — this spec does NOT revive
  it.
- `tier_of` unchanged: `variance_verify` is additionally guarded to rows with
  `lims_sub_sample_pk` set (see below), so a parent-attached `variance_verified`
  row never exists.
- `review_state` CHECK constraint += `variance_verified` (idempotent ALTER,
  mirrored in `backend/database.py`).

Service guards (`apply_transition`):

- `variance_verify` requires a `result_value` on the row (same rule as `verify`).
- **Host guard:** row must be sub-sample-hosted (`lims_sub_sample_pk IS NOT NULL`).
  The parent acting as a vial always promotes (it IS the canonical); for endo/ster
  the canonical is the one promoted sub.
- **Commercial gate (fail closed):** the parent's WP variance map must contain the
  service key whose bucket covers this row's service group (hplc→Analytics,
  endo/ster→Microbiology, scoped per key). Resolved via
  `_fetch_wp_services_for_parent`; if WP/IS is unreachable the transition is
  rejected with a clear retryable error — never silently allowed.
- **Permission:** any logged-in tech (the audit transition records `user_id`).
  Role gating deferred until Mk1 grows a senior-tech role.
- **Retest from `variance_verified` is legal** (service retest branch source
  states += `variance_verified`): these rows never touched the parent, so there is
  no SENAITE lock to collide with (unlike `promoted`). Retest creates the usual
  linked `unassigned` row.

### 4. Promote vs. variance-verify (how the canonical emerges)

No new "canonical" designation. In a variance bucket both actions are offered on a
`to_be_verified` sub row, and existing machinery arbitrates:

- **Promote stays available until the keyword has a canonical parent row** — the
  partial unique index forbids a second anyway (409). First promoted vial = the
  canonical (for HPLC, normally the parent's own run promotes; subs supply
  variance).
- **`variance_verify` is offered alongside** (gated per §3). Once a canonical
  exists for the keyword, promote disappears and variance-verify is the remaining
  path for the other replicates.

FE (`AnalysisTable.tsx`):

- `STATUS_LABELS/COLORS` += `variance_verified` → badge **"Verified — Variance"**
  (distinct hue from `promoted` teal and parent `verified` emerald).
- `ALLOWED_TRANSITIONS` += `variance_verified: ['retest']`;
  `to_be_verified` rows additionally offer **Verify (Variance)** when the gate
  data says the row qualifies (variance map by bucket + sub-hosted).
- The vial pages need the parent's variance map for gating/labels — extend the
  sub-samples/parent-summary payload the pages already fetch (exact wiring pinned
  at plan time).
- Badge: "Ready to Promote" yields to **"Ready to Verify"** on rows where promote
  is no longer the path (canonical already exists for the keyword — derive from
  the existing parent-line-states / promotions fetches; exact mechanism at plan
  time).
- The promoted-row rules from the amendment are untouched (`promoted: []`, help
  hint).

### 5. Variance set lock

`lock_variance_set` gains a completion guard: every non-retracted/non-rejected
analysis row on in-set vials **in variance-purchased buckets** must be `promoted`
or `variance_verified` before the set can lock. Lock remains the "series complete,
stats citable" gate; `compute_variance_stats` and `VarianceSummary` are unchanged.

## Behavior notes

- A variance replicate can never strand: its terminal-ish states are
  `variance_verified` (recoverable via retest) or `promoted` (if it was chosen as
  canonical).
- No SENAITE changes anywhere: variance-verified rows never write back; IS already
  attaches the `sample_variance` profile to the parent AR.
- Orders without variance behave byte-for-byte as today (`max(base, —)` = base;
  no sub-rows; gate never satisfied so the action never appears).
- Mixed case is per-row by construction: a vial's endo row can promote while a
  purity row on the same vial variance-verifies — state lives on the analysis row.

## Testing

- **Contract (IS):** map parsing + ≥2 validation; legacy normalization
  (`samplevariance`+`variance_value` → `{hplcpurity_identity: n}`); services
  payload exposes the map.
- **Demand (Mk1):** `derive_demand` max() inflation per bucket; vial-plan response
  carries the breakdown; no-variance orders unchanged (regression lock).
- **State machine:** `variance_verify` legal only from `to_be_verified` at vial
  tier; rejected on parent-hosted rows; requires result; CHECK constraints accept
  the new state/kind; retest legal from `variance_verified`.
- **Service gate:** rejected when the parent has no variance for the bucket;
  fail-closed when WP unreachable; audit row written with user + kind.
- **Promote interplay:** promote then variance-verify siblings (endo n=2 walk);
  second promote for the keyword 409s (existing).
- **FE:** badge renders; Verify (Variance) action appears only on gated rows;
  AssignStep variance sub-row counts; "Ready to Verify" label flip.
- **Lock guard:** lock rejected while a gated row is still `to_be_verified`.
- Live verification on the stack with a simulated services payload (monkeypatched
  `_fetch_wp_services_for_parent`, same pattern as the role-change tests).

## Build order

1. **Mk1 — lifecycle** (§3, §4): state + transition + gate + FE actions/badges.
2. **Mk1 — demand + AssignStep** (§2): `derive_demand`, vial-plan breakdown,
   bucket sub-rows. (Both Mk1 phases testable against a simulated payload.)
3. **IS — contract** (§1): per-service map parse/validate/normalize + expose in
   the services payload.
4. **WP — addon product**: form + pricing, emits the map (own plan; possibly own
   spec for the product UX).
5. **COA — variance section** (separate spec; `variance_set` mode already
   reserved).

## Out of scope

- COA rendering of variance statistics (own spec).
- SENAITE workflow changes (none needed).
- Admin un-promote / retract-from-`promoted` (still the deferred follow-up).
- Senior-tech role/RBAC (gate is any-tech for now).
- Detailed WP product/pricing UX (contract pinned here; UX at build time).
