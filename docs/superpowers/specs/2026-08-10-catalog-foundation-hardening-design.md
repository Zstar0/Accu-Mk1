# Catalog Foundation Hardening — the Mk1-only world

*Design spec, 2026-08-10. Handler rulings baked in: (1) design for the Accu-Mk1-only world — SENAITE
is being discontinued; (2) backward compatibility is owed ONLY to existing prod samples/results,
never to future SENAITE writes; (3) keyword-as-identity retirement is a long-standing goal and is
this program's centerpiece. Companion visual: the catalog entity map artifact (2026-08-10).*

*Origin: the 2026-08-10 architecture review. Every issue here has already bitten at least once —
citations inline. This is an umbrella spec: each slice gets its own implementation plan (and where
marked, its own sub-spec) before build.*

---

## 0. Design North Star

**One identity, three axes, everything audited.**

- The **analysis service row** (`analysis_services.id`) is the identity of a test. Strings
  (keyword, title) are display.
- The three axes stand: **profile** = sale/report/SLA · **department + role + station** = physical
  lab · **peptide** = HPLC science. `service_groups` retire.
- Every catalog mutation that changes what a customer's order provisions or what a certificate
  claims is **append-only auditable**, using the amendment-audit vocabulary
  (`{"changed": {field: {before, after}}}`) shipped 2026-08-10.
- **Data-driven over hardcoded (Handler ruling 2026-08-10).** The litmus test: *who should change
  this?* If a lab manager could reasonably want to change it (names, labels, colors, groupings,
  demand, tiers, wire keys, classification of tests), it is a catalog row with Mk1 UI CRUD and a
  `catalog_change_log` entry — never a constant, a hardcoded map, or a keyword regex. If only an
  engineer should change it (state-machine legality, audit invariants, index predicates, rendering
  implementations), it stays code — datafying the *list* without the *behavior behind it* is fake
  configurability. Data-driven code must fail closed and loud on unknown values (the spec-4
  fail-closed idiom), never silently fall back — silent fallbacks are how the `usp71` badge bug
  happened. Precedents already in-repo: `vial_roles`/`FlagType` (hardcoded catalogs promoted to
  tables), and the workflow catalog (`lims_workflow_states/transitions` — data-driven workflow is
  its own in-flight program, the 2026-07-12 authority-swap spec, out of scope here).

**Back-compat doctrine (applies to every slice):**
- Existing prod samples/results are READ-compatible forever: senaite-origin rows keep their
  keyword-based read paths until the phase-out formally freezes them. No prod data rewrites.
- All schema changes additive-alongside (new column/index/table + dual-read), never replace-in-place.
- The SENAITE mirror writers stay exempt and untouched (established ruling); they die with SENAITE.

---

## Slice 1 — Roles-as-data (kills the live UI bug class)

**Problem (bit today):** `vial_roles` carries `label` + `department` in the DB, but ≥6 FE surfaces
ship hardcoded `ROLE_BADGES` maps — so the `usp71` role renders "Unassigned"/"—" on the vial list,
sub-sample page, and worksheet inbox while the assign step (catalog-driven) renders it correctly.

**Design:**
- Add nullable `color: String(50)` to `vial_roles` (additive; NULL falls back to the role's
  department color, then a neutral). Seed colors for the 5 legacy roles to match today's rendering
  exactly (hplc=green, endo=orange, ster=purple, xtra=sky, hm=slate).
- One FE hook `useVialRoles()` (react-query, cached) + one shared `<RoleBadge role={code}>`
  component sourcing label/color from the catalog. Unknown/NULL code renders the amber
  "Unassigned" badge — the fallback stays, it just can't fire for real roles anymore.
- Replace all hardcoded maps: `VialsList`, `VialDetailsTab`, `InboxVialCard`,
  `vial-quicklook-helpers`, `SenaiteDashboard`, worksheet panels. `assignment-colors.ts` keeps only
  the class-string helpers, keyed by DB color names.
- Rider (same FE wave): wire `vialAssignmentByKeyword` into `NativeParentAnalysesCard`'s
  `AnalysisTable` so native rows get the "Vial N — P-xxxx-Sxx" sub-line (one prop, map already
  exists on the parent page).

**Tests:** badge component renders from catalog fixtures incl. an unknown code; a grep-guard-style
test asserting no `ROLE_BADGES: Record` literal remains outside the shared component.

---

## Slice 2 — Worksheets/inbox off service groups (unblocks analyst flow)

**Problem (bit today):** analyst stamping scopes by `service_group_members`; native services have
no group, so assigning P-0146-S04 to a worksheet stamps nothing. Inbox lanes are already
department-driven; worksheets are the unswept remainder. Prod group data is sparse and name-drifted.

**Design (sub-spec + plan of its own — this is the largest slice):**
- `worksheets.department_id` + `worksheet_items.department_id` (additive FKs), backfilled through
  `catalog/departments.py`'s existing bridge; dual-read with `service_group_id` until retirement.
- `stamp_for_item` resolves the vial's live analyses by **department** (service → department_id),
  with the hm precedent generalized: role/`role_codes` fallback for anything department-less
  during transition. Group filter retired.
- `_inbox_allowed_group_ids` shim deleted; the lane key IS the department.
- `service_group_name` display fields become department names (additive field first, FE flips,
  old field deprecated).
- Group admin CRUD → read-only "legacy" page once nothing writes groups.
- **Must-verify during planning:** the "COA blocking gate" cited in the 2026-07-28 foundation
  ruling as a group consumer — not found group-keyed in current code; pin it down or record that
  it was already migrated.

**Back-compat:** historical worksheets keep their `service_group_id` values (read-only); no backfill
failure may block a worksheet from rendering (NULL department renders as "Legacy").

---

## Slice 3 — Native identity convergence (the centerpiece)

**Problem (long record):** identity-critical paths key on the mutable, nullable `keyword` string:
the canonical parent unique index is `(lims_sample_pk, keyword)`, the vial-tier root index is
`(lims_sub_sample_pk, keyword)`, the FE parent↔vial join is keyword-based, senaite-origin promote
matches by keyword. Incident record: P-1611 re-label break, Replace-leaves-wrong-analysis, the
identity-conformance two-operands rule, PUR_/QTY_ derivation gaps blocking P-1500.

**Design:**
1. **New partial unique indexes alongside** the keyword ones, keyed
   `(host_pk, analysis_service_id)` with the same predicates (canonical parent root, vial root).
   Migration pre-check queries count would-be violations on prod-shaped data BEFORE index
   creation; violations are reported, never auto-healed.
2. **Identity rule in code:** for `origin='mk1'` services, every identity comparison uses
   `analysis_service_id` — promote already does (native-identity override, step 4c); extend to:
   the FE parent↔vial join (service_id when present, keyword fallback for senaite rows), retest
   lineage checks, dedupe/collapse readers, `_eligible_parent_row`, conformance operands.
3. **Keyword demoted to display** on mk1 rows: still copied for rendering, never compared. The
   catalog may then safely re-label (title/keyword) without breaking identity — closing the
   re-label incident class permanently.
4. **Enforcement:** an AST/grep-guard-style test with an explicit shrinking allow-list of
   keyword-identity sites (all senaite-path); any new keyword comparison outside the list fails
   loudly. Same idiom as the amendment-audit guard.
5. **Senaite-origin rows are grandfathered:** their keyword identity is frozen legacy behavior,
   removed only when the phase-out decommissions the mirror (out of this spec's scope).

**Non-goal:** renaming/merging any existing service rows; healing historical mis-identified rows
(separate, dry-run-first data work).

---

## Slice 4 — Catalog change history (ISO document control for the catalog)

**Problem:** profile membership, `vials_required`, ride hosts, role wiring, and mk1-owned service
fields have only last-write `updated_at/updated_by`. What a customer's order provisions is
determined by catalog state, and that state has no history. (Specs already have
`record_spec_change` — the template.)

**Design:**
- One append-only table `catalog_change_log`: `entity_type` (profile | profile_members |
  ride_hosts | service | vial_role | department | sla_tier), `entity_pk`, `action`
  (create/update/deactivate), `details` JSONB `{"changed": {field: {before, after}}}`,
  `user_id`, `occurred_at`. Same shape vocabulary as `lims_analysis_transitions.details`.
- Writers: every catalog CRUD route (profiles PUT/members PUT/ride hosts, vial-roles, departments,
  mk1-owned service field edits, SLA tier edits). SENAITE sync writes are exempt (they mirror an
  external system that is going away); `local_overrides`-protected fields ARE logged when edited
  locally.
- Spec-audit (`record_spec_change`) stays as-is; do not double-log specs.
- **Rider RULED 2026-08-11: SNAPSHOT.** Registration stamps a resolved `catalog_snapshot`
  (profile → member service ids + vial demand) onto the registration record; **check-in seeds from
  the snapshot, not the live catalog** — what the customer bought is what they get, and catalog
  edits never silently retro-apply to in-flight orders. Applying a catalog fix to an in-flight
  order becomes a deliberate, audited "reprovision" action. Gets its own mini-plan (seeding input
  change).

---

## Slice 5 — One demand oracle (kills the billing/cart divergence class)

**Problem (open 🔴s):** vial demand is re-implemented on multiple surfaces — WP cart says
`heavy_metals`=1, checkout says 2; `Cart_Order` maps by NAME and looks up by wire KEY, so heavy
metals bills nothing. String contracts stand in for one computation.

**Design (cross-repo: Mk1 + IS + wpstar; rides the IS catalog registry, slice 1 of which is
already PR'd — Mk1 #94 / IS #27):**
- Mk1's `compute_vial_plan` (spec 4's public oracle) is THE demand computation. The IS registry
  exposes per-profile demand + wire keys; WP cart AND checkout consume the registry — neither
  re-derives.
- Wire keys resolve by KEY everywhere (the name-vs-key mismatch dies at the registry boundary).
- Rollout feature-flagged per surface; parity harness compares old-vs-new demand for every live
  product before flip (the pricing-display harness idiom).

---

## Slice 6 — Catalog hygiene invariants

**a) Department totality.** `analysis_services.department_id` is load-bearing (seeding allow-list,
post-Slice-2 worksheets) but nullable. Backfill actives through the departments bridge; add a
drift surface (registry-inspect idiom) + a test invariant: zero ACTIVE services with NULL
department. Sync-created services get department assigned at sync time via the bridge. Not a
NOT NULL constraint (senaite sync must not fail-hard mid-phase-out) — a loud check, not a wall.

**b) PUR_/QTY_ derivation → reconciler.** Today per-substance services derive as a boot
side-effect (P-1500: heal = restart). Move to an idempotent catalog reconciler runnable on demand
(admin button/endpoint + boot), with a visible report of minted/missing rows.

**c) `peptide_analytes` slot ceiling (4)** — confirm against blend ambitions; if 4 stands, document
it as a product decision in the model docstring; if not, widen CHECK in this slice.

---

## Slice 7 — SLA semantics + re-key

**Problem:** tiering is stored-but-inert; before activation two things were undefined: multi-profile
semantics and the group-scoped override table.

**Design (semantics RULED 2026-08-11: CONCURRENT PER-PROFILE CLOCKS):**
- A sample carries **one SLA clock per purchased profile** — no resolution rule, because nothing
  is resolved away. Handler's grounding: the order-status page already surfaces multiple SLAs on
  hover (HPLC vs Micro), and the analyses tables already render per-row countdowns — the UI has
  been telling this truth all along; the engine catches up to it.
- Each clock's tier: priority override > that profile's `sla_tier_id` > [group fallback during
  transition] > default.
- **Endpoints per clock (to pin in this slice's plan against the existing per-analysis SLA
  machinery, `useAnalysisSlaMap`):** the PRIMARY profile's clock keeps the existing definition —
  received → first primary COA publish — and remains THE headline TAT metric (the sla-report
  measures it, unchanged). Add-on profile clocks end at that profile's results
  verified/ACOA-published; exact endpoint verified against how per-analysis SLA computes today,
  not invented fresh.
- Rollups: dashboards/sorting use most-urgent-remaining across a sample's clocks; breach reporting
  is per-clock, never collapsed.
- `SlaPriorityTier.profile_id` (additive) alongside `service_group_id`; group scoping deprecated
  with Slice 2.

---

## Slice 8 — Sample-adoption guard (small, interim)

**Problem (bit twice this week):** `ensure_sample_row` adopts by external ID string and overwrites —
the stack's counter regression manufactured chimeras P-0145/P-0146; the uid guard is a known-open
item. In prod, a SENAITE counter fault would corrupt real data.

**Design:** adoption requires uid agreement (or a NULL stored uid); on mismatch: refuse the adopt,
create the sample row under collision quarantine (flagged via the flag system, `identity` kind),
alert loudly. No healing of existing chimeras (dev-only so far). This guard is interim scaffolding —
it retires when Mk1 mints its own sample IDs post-phase-out.

---

## Slice 9 — De-hardcoding sweep (inventory-driven)

**Problem:** hardcoded values and lookup maps survive across both repos wherever the catalog
predates them. Each is a drift bomb of the `usp71`-badge class. Known inventory at spec time
(the plan's first task is completing this inventory):

| Hardcoded thing | Verdict under the litmus test |
|---|---|
| FE `ROLE_BADGES` maps (≥6 surfaces) | → data (Slice 1 does this) |
| `_ROLE_VARIANCE_KEYS` (role → WP variance entitlement key, `service.py`) | → data: the entitlement key belongs on the PROFILE (it already owns the wire key); role-keyed map retires |
| Endo-vs-sterility keyword classification (`ENDO-*` prefixes, product-completion et al.) | → obsolete for mk1 rows once S2/S3 land (department + service-id classify); keep only on frozen senaite paths, marked legacy |
| Identity-analysis matching (`ID_*` prefix / title-suffix regex, `isIdentityAnalysis`) | → obsolete for mk1 rows: native identity relates via `peptide_id`/`peptide_analytes`, not name shapes (S3); frozen-legacy elsewhere |
| `PARENT_ANALYTE` / `PUR_`/`QTY_` prefix regexes | senaite-era convention: frozen legacy; native path never mints them (S6b reconciler owns the derivation story) |
| `catalog/departments.py` name-map + ungrouped-rescue patterns | transition shim that DIES with S2 + S6a — do NOT datafy a dying shim; delete with groups |
| `COA_ARCHETYPES` constant | stays code, documented: each archetype has a renderer behind it; a data row without its renderer is fake configurability |
| Department name constants (`ANALYTICAL_DEPARTMENT`…) | departments are already data; constants shrink to seed-names only; consumers read the table |
| State machine `_ALLOWED` / tier matrix | stays code here; data-driving it is the 2026-07-12 workflow authority-swap program |

**Design:** plan opens with a repo-wide inventory task (both `backend/` and `src/`, plus wpstar's
catalog-adjacent maps); every entry gets one of three verdicts — **datafy** (with UI CRUD + S4
audit + fail-closed unknown handling), **obsolete-by-S2/S3** (delete on that slice's schedule,
marked legacy until then), or **stays-code** (with the reason written at the site). A guard test
per datafied vocabulary (the shrinking-allow-list idiom) keeps new hardcoded maps from creeping in.

## Sequencing & dependencies

```
S1 roles-as-data ──────────────► independent, FIRST (live bug, small)
S2 worksheets off groups ──────► independent of S1; unblocks analyst flow; sub-spec
S3 identity convergence ───────► independent; the centerpiece; sub-spec (index migration care)
S4 catalog change log ─────────► independent; template exists (amendment audit)
S5 demand oracle ──────────────► rides IS registry PRs (#94/#27); cross-repo window
S6 hygiene invariants ─────────► 6a helps S2; can ride S2's PR
S7 SLA re-key ─────────────────► after S2 direction is set; ruling needed
S8 adoption guard ─────────────► anytime; tiny
S9 de-hardcoding sweep ────────► inventory task anytime; datafy-verdicts ride S1/S4;
                                 obsolete-verdicts ride S2/S3's schedules
```

All slices are additive and independently shippable. S2 and S3 warrant their own sub-specs; the
rest go straight to plans. Existing open PRs (#97 placeholder, #98 amendment audit) merge first —
S3 and S4 build on the amendment-audit vocabulary and guard idioms.

## What this program does NOT do

- No SENAITE-side changes, no mirror-writer changes, no prod-data healing/rewrites.
- No re-architecture of the three axes — this hardens the foundation the schema already declares.
- No service-row renames/merges; no historical worksheet backfill beyond display fallbacks.

## ISO mapping

| Concern | Slice |
|---|---|
| 7.4.2 unambiguous identification (test identity survives re-labels) | S3 |
| 8.3 document control of the catalog (what was sold/reported, when, by whom) | S4 |
| 7.5.1 attribution on catalog changes | S4 |
| Data integrity against external-system faults | S8 |
| Single source of truth for customer-facing demand/billing | S5 |
