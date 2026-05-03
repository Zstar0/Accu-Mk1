# Vial Assignment Step — Design Spec

**Date:** 2026-05-03
**Status:** Approved, ready for implementation plan
**Scope:** Phase 1 (label printing). Phase 2 (analysis filtering) is out of scope here but the data model accommodates it.

---

## Goal

Add a third step to the Receive Sample wizard ([http://localhost:3101/#senaite/receive-sample](http://localhost:3101/#senaite/receive-sample)) that visually buckets checked-in vials into the lab departments they need to go to (HPLC / Microbiology(Endo + Sterility) / Xtra), persists the assignment, and prints the role short-name on each label so the lab tech can sort vials by reading them across the bench.

The current wizard has two phases (`capture` → `print`). This adds an `assign` phase between them.

---

## Vial demand rules

Computed per parent sample from the WP `services` dict. Demands stack — a sample with both addons needs both vials.

| WP service flag | Bucket | Vials |
|---|---|---|
| `hplcpurity_identity` **or** `bac_water_panel` | Analyses Dept. (HPLC) | 1 |
| `endotoxin` | Microbiology → Endo | 1 |
| `sterility_pcr` | Microbiology → Sterility | 2 |

`samplevariance` is not a separate vial. `residualsolvents` is out of scope for now (the section structure is built such that adding a 4th bucket later is non-breaking).

Fully-loaded BW sample (all addons) = 4 vials minimum: 1 HPLC + 1 ENDO + 2 STERYL.

---

## Architecture

```
WP order ─┐
          ▼
   IS order_submissions.payload.samples[N].services    ◄── source of truth
          │
          │  HTTP GET (Mk1 → IS, new endpoint)
          ▼
   Mk1 backend resolves services for parent (via ClientOrderNumber + sample_results map)
          │
          ▼
   Receive wizard step 3 (AssignStep): auto-assign + DnD override
          │
          ▼
   PATCH /sub-samples/{id}/assignment ──► writes lims_sub_samples.assignment_role
          │
          ▼
   PrintStep reads role per vial, renders 3rd line on label
```

**Source-of-truth choice:** WP `services` dict over SENAITE Department field. Reasons: (a) it's our domain model, (b) it lives in IS's local DB so no SENAITE round-trip needed, (c) survives the eventual SENAITE deprecation.

---

## Data model

Single Alembic migration on the Mk1 DB:

| Table | Column | Type | Default | Purpose |
|---|---|---|---|---|
| `lims_sub_samples` | `assignment_role` | `varchar(8)` nullable | `NULL` | Values: `hplc`, `endo`, `ster`, `xtra`, NULL. NULL = auto-assign hasn't run yet for this row. |
| `lims_samples` | `assignment_role` | `varchar(8)` nullable | `'hplc'` | Parent AR's role. Defaults to `hplc` per the "primary always HPLC" rule. Overridable via DnD. Backfilled to `'hplc'` for all existing rows in the migration. |

No backend cache of the `services` dict — Mk1 calls IS for it every time the wizard opens. Tiny payload, IS already has it indexed by `order_id`.

**Allowed values for `assignment_role`** (enum-like, not a Postgres enum to keep it cheap to extend):
- `hplc` — Analyses Dept.
- `endo` — Microbiology / Endotoxin
- `ster` — Microbiology / Sterility
- `xtra` — customer-overshoot bucket
- `NULL` — pending auto-assign (sub-samples only; the parent's column has a non-NULL default)

---

## Endpoints

### IS — new read endpoint

Lives in `integration-service/app/api/desktop.py` (the existing Mk1-facing router) alongside the publish endpoint already there.

```
GET /explorer/orders/sample-services?sample_id=BW-0006
→ 200 {
    "services": {
      "endotoxin": true,
      "sterility_pcr": true,
      "samplevariance": false,
      "bac_water_panel": true,
      "residualsolvents": false,
      "hplcpurity_identity": false
    },
    "analytical_test": "Bacteriostatic Water",
    "wp_order_number": "3229"
  }
→ 404 if sample_id not found in any order_submissions row
```

**Lookup logic:** scan `order_submissions.sample_results` jsonb for `senaite_id == sample_id`, identify the slot (1-based key), return `payload.samples[slot - 1].services` plus `analytical_test` and `wp_order_number` (= `order_number`). `analytical_test` is included for surfaceable error / debug context; not consumed by core demand logic.

### Mk1 — new endpoints (under existing `/sub-samples` router)

```
GET /sub-samples/{parent_sample_id}/vial-plan
→ 200 {
    "demand": { "hplc": 1, "endo": 1, "ster": 2 },
    "wp_order_number": "3229",
    "vials": [
      { "sample_id": "BW-0006",     "is_parent": true,  "vial_sequence": 0, "assignment_role": "hplc" },
      { "sample_id": "BW-0006-S01", "is_parent": false, "vial_sequence": 1, "assignment_role": "endo" },
      { "sample_id": "BW-0006-S02", "is_parent": false, "vial_sequence": 2, "assignment_role": "ster" },
      { "sample_id": "BW-0006-S03", "is_parent": false, "vial_sequence": 3, "assignment_role": "ster" }
    ]
  }
→ 503 if IS unreachable — body { "error": "is_unreachable", "demand": {"hplc":0,"endo":0,"ster":0}, "vials": [...] }
       (the wizard renders all vials in Xtra with a banner — see Edge cases.)
```

Side effect: when called, runs the auto-assign algorithm for any sub-sample vial whose `assignment_role IS NULL`, persists the new assignments, and returns the resolved plan. Parent's `assignment_role` is never modified by this endpoint (defaults to `'hplc'` from the migration).

```
PATCH /sub-samples/{sample_id}/assignment
→ Body: { "role": "hplc" | "endo" | "ster" | "xtra" | null }
→ 200 { "sample_id": "...", "assignment_role": "..." }
→ Routes to lims_sub_samples or lims_samples based on whether sample_id is the parent or a sub-sample
→ For sub-samples: null role = "reset, let auto-assign decide on next /vial-plan call"
→ For parent (lims_samples): null role is coerced to 'hplc' (parent never goes NULL — preserves the
   "primary always HPLC" rule even after a reset)
```

---

## Auto-assign algorithm

Runs server-side inside `GET /vial-plan`. Only mutates rows where `assignment_role IS NULL` — user overrides are sticky.

```
1. demand = derive_demand(services):
     hplc = 1 if (services.hplcpurity_identity or services.bac_water_panel) else 0
     endo = 1 if services.endotoxin else 0
     ster = 2 if services.sterility_pcr else 0
2. vials = [parent] + sub_samples.order_by(vial_sequence)
3. For each vial in order:
     if vial.assignment_role is not NULL: skip (override wins, decrement remaining demand if it matches a real bucket)
     else: assign to first bucket with remaining demand, in priority [hplc, endo, ster]
            if no demand left: assign to xtra
4. Persist newly-computed roles back to DB
5. Return plan
```

**Parent-AR special case:** the parent's `assignment_role` defaults to `'hplc'` at migration time, so it's never NULL when auto-assign runs. It's effectively pinned to HPLC unless explicitly dragged. This implements the "primary sample always goes to HPLC for now" rule.

---

## UI components

### New file: `src/components/intake/ReceiveWizard/AssignStep.tsx`

Variant B layout — three buckets, vials draggable between them via `@dnd-kit/core`:

```
┌──────────────────────┬──────────────────────────────────┬──────────────┐
│ Analyses Dept.   1/1 │ Microbiology              3 / 3  │ Xtra      0  │
│                      │   Endo · 1 / 1                   │              │
│   [BW-0006 HPLC]     │     [BW-0006-S01 ENDO]           │              │
│                      │   Sterility · 2 / 2              │              │
│                      │     [BW-0006-S02 STERYL]         │              │
│                      │     [BW-0006-S03 STERYL]         │              │
└──────────────────────┴──────────────────────────────────┴──────────────┘
```

Bucket states:
- **Full** (demand met exactly) — solid blue border
- **Short** (fewer assigned than demand) — amber border, "X / Y — need N more" warning
- **Empty section hidden** — Microbiology is not rendered at all on a peptide-only order

Each vial card shows: photo thumbnail (small), sample ID (mono), role badge (color-coded). Parent AR styled distinctly (teal background) so it's obvious it's the AR.

A small "Reset to auto" link in each bucket header NULLs the `assignment_role` of any **sub-sample** vial in that bucket and re-runs `/vial-plan`. The parent AR is excluded from the reset (its role is coerced back to `'hplc'` per the parent-special-case rule, not NULLed). Mostly for "I dragged the wrong vial, undo me."

### Wizard phase enum

`ReceiveWizard.tsx` gains `'assign'` as a phase between `'capture'` and `'print'`:

```tsx
type Phase = 'capture' | 'assign' | 'print'
```

Footer on the capture step:
- `Print labels` button is replaced by **`Continue →`** when at least one session vial exists
- Clicking `Continue` calls `/vial-plan` (which runs auto-assign) and transitions to `'assign'`

Footer on the assign step: `← Back` (returns to capture) and **`Print labels →`** (transitions to `'print'`).

### Sidebar (capture step)

`WizardSidebar.tsx` gets a small role badge next to each vial in the list, showing the current `assignment_role`. Only visible after `/vial-plan` has been called once (i.e. after the user has been to the assign step at least once); first-time capture flow renders without the badge.

### LabelTemplate update

```tsx
<div className="label-text">
  <div className="label-id">{sampleId}</div>
  {orderNumber && (
    <div className="label-order">
      {orderNumber}{vialPosition && ` · Vial ${vialPosition}/${vialTotal}`}
    </div>
  )}
  {role && <div className="label-role">{ROLE_SHORT_NAMES[role]}</div>}
</div>
```

```ts
const ROLE_SHORT_NAMES = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'STERYL',
  xtra: 'XTRA',
} as const
```

New CSS rule (`PrintStep.css`):

```css
.label-role {
  font-family: ui-monospace, monospace;
  font-weight: 700;
  font-size: 7pt;
  line-height: 1;
  letter-spacing: 0.04em;
  color: #000;
  white-space: nowrap;
}
```

The order line additionally gets a `· Vial X/Y` suffix when `vialPosition` is supplied. Font size on the order line drops from 6.5pt to 6pt to keep it on one line. Both sidebar (`@media screen`) and printer (`@media print`) variants updated identically.

`PrintStep.tsx`'s `printList` is reshaped to include `role`, `vialPosition`, `vialTotal` per label. The total = parent + count of session sub-samples (matches the existing logic for which vials get printed).

---

## Edge cases

| Case | Behavior |
|---|---|
| Empty Microbiology (no `endotoxin`, no `sterility_pcr`) | Microbiology section hidden entirely. Only HPLC + Xtra render. |
| Short demand (fewer vials than required, e.g. 1 sterility vial when 2 needed) | Bucket shown with amber border + "1 / 2 — need 1 more". Soft warning. User can still print and add more vials in a later session. |
| Surplus vials (e.g. 5 vials checked in when 4 needed) | Land in Xtra automatically. Drag-able into a bucket as a spare if the tech wants them physically racked with a department. Printed label shows `XTRA`. |
| IS unreachable | `/vial-plan` returns 503. Wizard shows banner "Couldn't load order services — auto-assign skipped, drag manually." All vials rendered in Xtra; demand counters show 0. Print still works (XTRA appears on every label until manually fixed). |
| Wizard re-opened after some vials assigned | Pre-existing `assignment_role` values are preserved (sticky overrides). New vials added since last open get auto-assigned on top. |
| User clicks "Reset to auto" in a bucket | All vials in that bucket get their `assignment_role` set to NULL. The next `/vial-plan` call runs auto-assign, which re-fills based on demand. |
| Parent on an Endo-only order | Parent defaults to `hplc` per migration default. The HPLC bucket renders empty (`0 / 0`) but visible because parent is in it. Tech can manually drag parent to ENDO. Future enhancement: hide HPLC bucket when demand is 0 — deferred. |

---

## Testing

**Backend unit tests:**
- `derive_demand()` — every combination of `services` flags maps to the expected demand dict.
- `auto_assign()` — table-driven: fixed parent + N sub-samples, varying demand, varying pre-existing overrides. Verify (a) NULLs get filled in priority order, (b) non-NULLs are preserved, (c) surplus → xtra.
- `GET /v1/orders/sample-services` (IS) — happy path, 404 on unknown sample_id, slot-out-of-range guard.
- `GET /sub-samples/{parent}/vial-plan` (Mk1) — returns 503 with empty demand when IS is mocked to fail.

**Frontend tests:**
- `AssignStep` renders the three buckets with vials in correct positions per a stub `/vial-plan` response.
- DnD between buckets fires the `PATCH /sub-samples/{id}/assignment` call.
- Empty Microbiology section is hidden when both Endo and Sterility have demand 0.
- Short bucket renders amber state.

**Manual verify (smoke):**
- Run on test order #3229 sample 2 (BW-0006). Expected: parent → HPLC, S01 → ENDO, S02/S03 → STERYL. Print labels and visually confirm the third line reads HPLC / ENDO / STERYL / STERYL.
- Drag S01 from ENDO to Xtra; refresh wizard; assignment persisted.
- Click "Reset to auto" in Xtra; S01 returns to ENDO.

---

## Phase 2 hand-off (out of scope here)

After this ships, Phase 2 implements per-sub-sample analysis filtering. Phase 2 will:
- On sub-sample creation, instead of inheriting the parent's full `Profiles` + all `Analyte*Peptide` slots, set only the analyses relevant to the sub-sample's `assignment_role`.
- Update `INHERITABLE_FIELDS` in `backend/sub_samples/senaite.py` to be role-aware.
- Add a SENAITE-side analysis-removal step after secondary-create (since SENAITE inherits all on create; Phase 2 will need to delete the wrong-bucket analyses).

This spec persists `assignment_role` cleanly so Phase 2's filtering logic just reads the column.

---

## Files touched

**New files:**
- Mk1: `src/components/intake/ReceiveWizard/AssignStep.tsx` — the new wizard step component using `@dnd-kit/core`.

**Modified:**
- Mk1: `backend/database.py` — add migration entries to `_run_migrations()` for `lims_samples.assignment_role` (default `'hplc'`, backfilled to `'hplc'` for existing rows) and `lims_sub_samples.assignment_role` (nullable). Mk1 uses lightweight `ALTER TABLE` migrations in this function, not Alembic.
- Mk1: `backend/models.py` — add `assignment_role` Column to `LimsSample` and `LimsSubSample`.
- Mk1: `backend/sub_samples/routes.py` — add `GET /sub-samples/{parent_sample_id}/vial-plan` and `PATCH /sub-samples/{sample_id}/assignment`.
- Mk1: `backend/sub_samples/service.py` — add `derive_demand()`, `auto_assign()`, and a small client wrapper for the IS sample-services endpoint.
- Mk1: `backend/sub_samples/schemas.py` — add `VialPlanResponse`, `VialPlanItem`, `AssignmentPatchRequest`.
- Mk1: `src/components/intake/ReceiveWizard/ReceiveWizard.tsx` — add `'assign'` phase between capture and print.
- Mk1: `src/components/intake/ReceiveWizard/PrintStep.tsx` — extend `printList` to include `role`, `vialPosition`, `vialTotal` per label.
- Mk1: `src/components/intake/ReceiveWizard/PrintStep.css` — add `.label-role`, tweak `.label-order` font size to keep "Vial X/Y" suffix on one line. Update both `@media screen` and `@media print` blocks.
- Mk1: `src/components/intake/ReceiveWizard/LabelTemplate.tsx` — render 3rd line + vial position suffix.
- Mk1: `src/components/intake/ReceiveWizard/WizardSidebar.tsx` — render role badge per vial after first `/vial-plan` call.
- Mk1: `src/lib/api.ts` — typed wrappers for `getVialPlan()` and `patchVialAssignment()`.
- IS: `app/api/desktop.py` — add `GET /explorer/orders/sample-services` endpoint. Lookup logic queries `order_submissions` for the row whose `sample_results` jsonb contains a value with `senaite_id == sample_id`.

**Dependencies:**
- New npm: `@dnd-kit/core`, `@dnd-kit/sortable` for drag-and-drop. ~12 KB gzipped, accessible by default.
