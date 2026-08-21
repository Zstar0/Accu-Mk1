---
title: "Catalog-driven bench — vial roles as rows, ride lists, dynamic assignment, custody edges"
date: 2026-07-31
status: draft
authors: [ZeroSignal, forrestp]
depends_on:
  - "docs/superpowers/specs/2026-07-28-analysis-catalog-foundation-design.md (spec 1)"
  - "docs/superpowers/specs/2026-07-28-native-coa-sections-design.md (spec 2)"
  - "docs/superpowers/specs/2026-07-28-catalog-order-routing-design.md (spec 3)"
part_of: "New-test-families program, spec 4 — the 'manager authors, lab follows' phase"
---

# Catalog-Driven Bench

## Summary

Specs 1–3 made the *sale* catalog-driven: a manager creates a profile and the order, demand,
seeding, inbox lane, and COA follow. This spec makes the *bench* catalog-driven and closes the
loop the Handler named: **create a department and it appears as an assignment section; create a
profile with vial rules and its spot appears in that department; the vial is traceable at every
step for ISO 17025.**

Five moves:

1. **Vial roles become catalog rows** (`vial_roles`), auto-minted 1:1 when a profile is created.
   The role stays the DB join key on vials (`assignment_role`, VARCHAR(8), unchanged); the
   profile becomes its face.
2. **Conditional vial sharing becomes data**: a profile may declare an ordered **ride list** of
   host roles. Paired with a host → zero own vials, services seed onto the host's vial.
   No host → the profile mints its own role's vial (**Handler-locked 2026-07-31**).
3. **Vial↔profile custody edges are persisted at assignment time** — point-in-time,
   immutable, host/rider-tagged — because ISO traceability cannot rest on inference through
   mutable catalog state.
4. **The assignment page renders from the catalog**: department sections from rows, one spot
   per active role labeled by its fulfilling profile(s), rider chips, XTRA and the variance
   zone unchanged.
5. **Service groups starve**: SLA moves to the profile; nothing new ever gets a group; the
   remaining group consumers (worksheet scoping, COA gate) are explicitly deferred to the
   SENAITE phase-out and NOT touched here.

## Handler rulings captured (2026-07-31 discussion — cite, don't re-litigate)

- **Analysis Profile is the one lab-facing concept.** Groups frozen; retire by starvation.
- **Role = key, profile = face.** Roles auto-mint with profiles; managers never hand-manage
  them in the common case.
- **Standalone rider mints its own assignment.** Fent alone → `fent` vial in a `fent` spot.
  Cross-rider sharing only when explicitly authored in a ride list; hosts resolve before riders.
- **Sharing-by-shared-role is retired as the sharing mechanism** (it mis-identifies and
  mis-seeds the standalone case — the `hplc` role routes to the parent-mirror seeder). The
  legacy five keep their current roles, frozen.
- **BacWater correction:** the panel = Benzyl Alcohol + pH + Fill Volume, all Analytical;
  Endotoxin is an add-on with its own vial. No current product spans departments.
- **Custody:** the vial must be traceable end-to-end — assignment, bench scan-in, storage —
  for the ISO 17025 pursuit. Bench/station scan-in enters this spec; storage scans ride the
  open location slices.
- **Sub-departments and instrument queues are future Department refinements**, not sale
  objects; screening→confirmatory (tox) is a service-workflow edge, not an org node. Out of
  scope here; nothing in this spec may block them.

## Layer 1 — `vial_roles` table + auto-mint

New table (LIMS side, `lims_` prefix not required — catalog family):

| column | type | notes |
|---|---|---|
| `code` | VARCHAR(8) PK-unique | the value vials carry in `assignment_role`; `[a-z][a-z0-9_]{0,7}` |
| `label` | VARCHAR(100) | display everywhere (spots, chips, box labels) |
| `department_id` | FK departments, NOT NULL | drives section placement, lanes, role-flip cleanup |
| `boxable` | BOOL default false | replaces `BOXABLE_ROLES` |
| `variance_eligible` | BOOL default false | replaces `_VARIANCE_INELIGIBLE_ROLES` (inverted sense) |
| `sort_order` | INT | section/spot ordering |
| `frozen` | BOOL | set once any vial references the code; retire-don't-delete |

- Seed the five legacy codes (`hplc`, `endo`, `ster`, `xtra`, `hm`) with today's exact
  behaviors (`hplc/endo/ster` boxable, `hplc` variance-eligible, `xtra` reserved/special).
- `analysis_profiles.fulfillment_role` keeps its string type and now must reference an
  existing `vial_roles.code` (validated at POST/PATCH; no FK rewrite — additive).
- **Auto-mint on profile create:** when the create payload carries no existing role, mint one —
  code suggested from the profile key (truncated/uniquified to 8), department defaulted from
  the members' common department (explicit when mixed), flags safe-defaulted (not boxable,
  not variance-eligible). One confirm in the UI; the escape hatch is picking an existing role.
- Spec-3's reserved-role rider (legacy roles blocked on non-legacy profiles) and the `xtra`
  reservation carry over into the table-backed validation unchanged, until the demand
  shadow-compare retires.

## Layer 2 — ride lists + demand algorithm v2

New junction `profile_ride_hosts` (`analysis_profile_id`, `host_role_code`, `priority`).

Resolution, per order (deterministic, catalog-only — no code special cases):

1. Partition ordered `dim='role'` profiles into **anchors** (empty ride list) and **riders**.
2. Anchors mint demand: `MAX(vials_required)` per role (unchanged spec-3 semantics).
3. Riders resolve in ride-list priority order against the roles minted so far: first hit →
   attach (zero own vials; membership seeds onto the host role's vial). No hit → the rider
   **self-mints its own role** and — by being minted — becomes attachable for later riders.
   Iteration order over riders: role `sort_order` then key (deterministic).
4. Variance composes on top exactly as today; `dim='kind'` untouched.

Sensitive tests never share by construction: `endo`/`ster` appear on no ride list, and their
profiles carry none.

Seeding: `_catalog_members_for_role` extends its predicate from "profiles fulfilling this
role" to "profiles fulfilling OR attached-as-rider to this role **on this order**" — the
attachment fact comes from the Layer-3 custody edge, not re-derivation.

## Layer 3 — custody edges (ISO backbone)

New table `vial_profile_assignments`:

| column | notes |
|---|---|
| `lims_sub_sample_pk` | the vial |
| `analysis_profile_id` | the product whose work is on it |
| `relation` | `host` \| `rider` |
| `assigned_at`, `assigned_by_id` | point-in-time actor record |

- Written when the vial plan is persisted (and on manual drag/role-flip); **immutable** —
  corrections append a superseding row, never rewrite (keyword-immutability discipline).
- Readers: assignment-page rider chips, seeding (Layer 2), and audit/export. The display and
  the audit trail are the same record and cannot disagree.
- Bench scan-in: new event kind on the existing `LimsSubSampleEvent` stream —
  vial × station × tech × timestamp, captured via the deployed QR plumbing. Requires a minimal
  `bench_stations` table (name, `department_id`, active). Storage-scan events are the same
  stream but land with the open location slices 3–4, not here.

## Layer 4 — dynamic assignment page

Replace `AssignStep.tsx`'s hardcoded three buckets:

- **Sections = Department rows** present in the plan (roles' departments), ordered by
  department; section header = the department's real name (retires the hardcoded
  "Analyses Dept." string).
- **Spots = active roles** in the plan, labeled by the fulfilling profile(s)' names (1:1
  common case reads as the profile; a shared role lists both). Riders render as chips on the
  host spot — the existing "HPLC VARIANCE · paid 1" visual pattern.
- Micro keeps its endo/ster sub-bucket layout (data-driven: two roles, one department).
- XTRA stays, always rendered, as the manual-override drop target. Variance zone and the
  variance override editor unchanged (variance is legacy-only by backend contract).
- Drag/reset/auto-assign become role-generic (they nearly are — `_BUCKET_PRIORITY` etc.
  become reads of `vial_roles.sort_order`).
- The `VialPlanResponse`/`AssignStep` fixed-shape types (ledgered spec-3 debt) widen here.

## Layer 5 — role-site conversions + SLA move

Every spec-3 "7-site checklist" site becomes a read of `vial_roles`, fail-closed (an unknown
role code REFUSES loudly, never silently drops — the program's standing conversion discipline):
`_VALID_ROLES`, `_BUCKET_PRIORITY`/`_REAL_BUCKETS`, `_ROLE_DEPARTMENT_NAMES`,
`ROLE_TO_DEPARTMENT_NAME`/`ROLE_TO_VIAL_ROLES`/lanes, `BOXABLE_ROLES` + BoxStep column
rendering + `ROLE_SHORT` fallback, FE label maps (already fallback-hardened by spec-3's fix
waves). The database.py variance-exclusion backfills stay as-is for historical rows.

**SLA:** `sla_days` (matching the group column's semantics) moves onto `analysis_profiles`;
`useAnalysisSlaMap` and its consuming pages read profile SLA with group SLA as fallback for
legacy rows. Groups are otherwise untouched.

## ISO 17025 alignment

| Requirement (traceability clauses) | Mechanism |
|---|---|
| Unique item identification | `native_id` / `sample_id` per vial (shipped) |
| What work, on which item, decided when/by whom | `vial_profile_assignments` (host/rider, actor, timestamp) |
| Custody transfers | `LimsSubSampleEvent` stream: check-in (shipped) → assignment (shipped) → bench scan-in (this spec) → storage (location slices) |
| Condition/identity at receipt | vial photos + QR capture (shipped) |
| Records protected from amendment | append-only edges + events; frozen roles; retire-don't-delete |
| Method/equipment linkage | bench stations carry `department_id`; instrument registry mapping is a named future refinement |

## Deliberately deferred

- **Worksheet re-key and the COA blocking gate** (the last real group consumers) — SENAITE
  phase-out territory. Groups are frozen here, not dropped.
- Migrating the legacy five roles/profiles onto auto-mint or ride lists. Frozen as-is.
- Storage/disposal scan events (location slices 3–4); sub-departments; instrument queues;
  reflex-testing workflow edges.
- The demand shadow-compare's retirement (separate decision; the reserved-role rider lives
  until then).

## Risks

| Risk | Mitigation |
|---|---|
| Role-site conversion misses a site (the silent-miss class spec 3 warned about) | The spec-3 sweeps already converted or fallback-hardened most sites; the remainder is the enumerated Layer-5 list; every conversion fail-closed + a role-coverage test asserting a novel role traverses demand→assign→lane→box-label rendering without a silent drop |
| Demand v2 nondeterminism (rider resolution order) | Priority-ordered ride lists + deterministic iteration; property test over permutations of order payloads |
| Custody edges drift from seeded reality | Edges written in the same transaction as the plan/role flip; seeding reads the edge, not a re-derivation |
| Auto-mint code collisions (8-char truncation) | Uniquify with numeric suffix; manager can edit before first vial freezes it |
| A rider's host retires | `frozen` roles can't be deleted; ride lists validated against existing codes |

## Testing (headline cases)

- Fent alone → one `fent` vial, own spot, seeded from fent's members. Fent + HPLC → one
  `hplc` vial, fent attached as rider, edge rows `host`+`rider`, seeding = union.
  Fent + Endo → two vials (no host on the list). Fent + vacuum, no HPLC, vacuum rides
  `[hplc, fent]` → one `fent` vial hosting vacuum.
- New department + new profile via API only → assignment page shows the new section and spot
  with zero code changes (the "manager authors, lab follows" acceptance test).
- Legacy five: every existing order shape produces byte-identical demand, assignment,
  seeding, boxing, and lane behavior (failure-set diff discipline; parity suite reruns).
- Custody: edge rows immutable; superseding row on manual reassign; bench scan event
  round-trip via QR endpoint.
- Fail-closed: a vial carrying an unknown role code surfaces loudly at every Layer-5 site.

## Execution environment

Accu-Mk1 only (no IS/COABuilder/WP changes — the wire contract is untouched). Builds on the
spec-1→3 chain: branch from `feat/catalog-order-routing` (or master once the chain merges).
Rehearse on a fresh devbox stack (`accumark-stack-platform` skill); the acceptance test above
runs there. Gates per repo convention: pytest failure-set diff vs baseline, `npx tsc --noEmit`,
vitest for the new FE.

## Handler / lab gates

- **G-RIDE** — ride-list contents for vacuum/fent (which hosts, what priority) are
  lab-protocol calls; profiles can ship with empty lists and gain them later.
- **G-STATION** — bench/station inventory (names, departments) before scan-in goes live.
- Existing program gates unchanged (G-P/G-V/G-PUB/G-ENDO + spec-2's G-A…G-D); this spec adds
  no deploy coupling to IS/COABuilder/WP.

## Open questions

1. Should auto-minted roles for ride-capable profiles default to `boxable=false` until
   G-STATION, or inherit the host's boxability when attached? (Riders on a boxable host are
   boxed with it either way; the question is only the standalone case.)
2. Does the bench scan-in event *gate* result entry (hard custody) or merely record (soft
   custody, flagged in review)? ISO leans hard; lab throughput may prefer soft-with-report
   first.

## Cross-references

- Specs 1–3 (this directory); spec-3 SDD ledger `C:\tmp\Accu-Mk1-order-routing\.superpowers\sdd\2026-07-30-catalog-order-routing\progress.md` (deferred minors this spec absorbs: AssignStep/VialPlanResponse shapes, BOXABLE_ROLES, ROLE_SHORT fallback, WorksheetsInboxPage labels, "HM HM" glyph)
- Hierarchy illustration (Handler-corrected): https://claude.ai/code/artifact/156b985d-211e-4833-8d17-c1aeeda6fafb
- ISO posture: `project_iso17025_alignment` (aligning to pursue; lab-workflow specs carry an alignment section)
