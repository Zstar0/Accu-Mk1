# Worksheet Vial-Inbox Redesign — Design

**Date:** 2026-06-02
**Scope:** Replace the worksheet inbox's `(parent × service_group)` fan-out with a flat vial-per-card model, surface sub-samples as inbox line items, and add a top-level HPLC / Microbiology filter. Mk1-only changes; SENAITE, integration-service, and coabuilder untouched.
**Repos touched:** `Accu-Mk1` only.
**Predecessor specs:**
- `2026-04-27-sub-samples-design.md` — vial intake + Receive Wizard
- `2026-06-02-worksheet-variance-grouping-design.md` — **Phase 1-2 (variance set) shipped, Phase 3-4 (family card) is superseded by this doc.**
**Successor phases:** Worksheet drag/drop wiring of vial-level inbox items (separate plan).

---

## Why we're reworking the family card

The predecessor's Phase 3-4 proposed a **collapsed family card per `(parent × service_group × hplc-domain)`**, on the premise that a parent's sub-samples needed grouping under one draggable card so techs could move the whole family atomically. Two things have changed since that was written:

1. **Vial role assignment shipped** (`assignment_role` on `lims_samples` + `lims_sub_samples`). Every vial — parent or sub — now carries a role: `hplc | endo | ster | xtra`. The role IS the routing tag for which bench handles the vial. The role is set during intake (Receive Wizard's Assignment step) and stored as pure metadata; it does NOT re-route analyses between ARs in SENAITE.
2. **Live testing surfaced two gaps in the family-card direction:**
   - Sub-samples never enter the inbox at all today — the linked-orders filter only knows the parent's senaite_id from `order_submissions.sample_results`, and sub-samples are created later via the Receive Wizard. Confirmed live with BW-0009-S01 (`sample_received` in SENAITE, has 5 analyses, returns 0 inbox items).
   - The per-service-group fan-out makes BW-0009 (one parent, two service groups: Analytics + Microbiology) show as two cards already. Adding family-card chrome on top of that is double abstraction — one card per `(parent × group)`, each grouping vials of that role. Once role IS the unit of work, the parent-as-anchor stops earning its complexity.

The clean reframe: **the unit of worksheet work is a vial, not a sample.** A vial carries a role; the role determines which bench's inbox it appears in. Sub-samples and parents are equal-class citizens in the inbox.

## Goals

- **One inbox line item per vial.** No more flatten-to-cards in the frontend; the backend returns the flat list directly. BW-0009 family with 1 sub-sample and `parent=hplc / sub=ster` produces **2** inbox items (parent on HPLC filter, sub on Microbiology filter), not 4.
- **Sub-samples surface in the inbox.** The linked-orders filter extends to "any sample_id matching a linked parent's senaite_id, OR any sub-sample of that parent in `lims_sub_samples`."
- **Server-side analysis filtering by role.** A vial's inbox card shows only the analyses whose service group matches its role. Parent BW-0009 (`role=hplc`) shows only the 3 Analytics analyses on its card; its 2 Microbiology analyses on the same AR are hidden on that card and would be picked up by whichever vial in the family carries a Microbiology role.
- **Top-level filter: HPLC | Microbiology.** Single-select chip strip at the top of the inbox. Filters server-side on `assignment_role`. Defaults to whatever the tech last selected (persisted in `localStorage`).
- **Backward-compatible for single-vial orders.** A parent with no sub-samples and `assignment_role=hplc` still renders one card on the HPLC filter — same data, same drag/drop, just one card instead of "family card collapsed to look like one card."
- **No new schema.** Everything below is implementable against the existing tables (`lims_samples`, `lims_sub_samples`, `service_groups`, `service_group_members`, `analysis_services`).

## Non-goals

- **No analysis re-routing in SENAITE.** A vial's AR keeps all its analyses regardless of role; we never `PATCH` SENAITE to move PH-DETERM off a Micro-assigned vial. Result entry naturally happens only on the role-matching analyses, and the others sit as inert metadata in SENAITE. *(See the "Inert duplicate analyses" question below for the explicit decision.)*
- **No variance-set changes.** Phase 1-2 stays as-is — variance is a per-parent concept driven by `lims_samples`/`lims_sub_samples` flags and is orthogonal to inbox filtering.
- **No new endpoint surface for sub-samples.** They flow through the same `/worksheets/inbox` route as parents; the route's contract changes but no new route lands.
- **No worksheet `WorksheetItem` schema change.** It still keys on `(sample_uid, service_group_id)`. A sub-sample is just a different `sample_uid` (its own SENAITE AR UID).
- **No retroactive role assignment for legacy parents.** Pre-wizard parents carry the migration-default `assignment_role='hplc'` on `lims_samples`. They show under the HPLC filter by default. If their analyses span Microbiology too, those analyses simply don't surface in the inbox until somebody manually assigns a vial to a Micro role.
- **No "All" or "Unassigned" filter in v1.** Two filter values: HPLC and Microbiology. XTRA vials are hidden from the inbox (they're explicitly extra capacity, not worksheet-bound).

## Architecture

### Inbox unit = vial

A **vial** is one of:
- A row in `lims_samples` (the parent AR), OR
- A row in `lims_sub_samples` (a sub-sample AR)

Each vial maps to exactly one SENAITE AR (by `external_lims_uid`). Each vial carries an `assignment_role` (`hplc | endo | ster | xtra | NULL`).

The inbox returns a flat list of vials. Each vial appears as a card.

### Role → bench mapping

| Vial role | Bench (filter) | Service groups it pulls analyses from |
|---|---|---|
| `hplc` | HPLC | `Analytics` (id=1) |
| `endo` | Microbiology | `Microbiology` (id=2), Endotoxin subset |
| `ster` | Microbiology | `Microbiology` (id=2), Sterility subset |
| `xtra` | (hidden) | — |
| `NULL` | (hidden) | — |

Endotoxin and Sterility share the `Microbiology` service group in the DB today. Distinguishing them is left for a Phase 3.5 enhancement (Endo and Ster benches presumably want their own filter eventually); for now they collapse into one Microbiology filter that surfaces both.

The role→service_group lookup is a backend constant (small, slow-moving, lives in `backend/sub_samples/inbox_roles.py` or inline in `main.py`). Not data-driven via a new table — would be over-engineering for a 4-row mapping that hasn't churned in the lab's history.

### Per-card analysis filtering

For each vial item, the analyses displayed are the intersection of:
1. Analyses on the vial's SENAITE AR (via `getRequestID={vial.sample_id}`)
2. Analyses whose service group ∈ the role's allowed service groups (via `service_group_members`)

So BW-0009 with `role=hplc`:
- AR has 5 analyses: PH-DETERM, FILL-NET-CONTENT, Benzyl_Alcohol_Assay, ENDO-LAL, STER-PCR
- Allowed groups for `hplc`: `{Analytics}`
- Card shows: PH-DETERM, FILL-NET-CONTENT, Benzyl_Alcohol_Assay
- Filtered out (not deleted from SENAITE, just invisible on this card): ENDO-LAL, STER-PCR

### Sub-sample inclusion

The linked-orders filter today (`main.py:11989-11993`) admits only senaite_ids that appear in `order_submissions.sample_results.<key>.senaite_id`. Sub-samples never appear there (they're created post-order by the Receive Wizard). The fix:

```python
# After building linked_senaite_ids (parents only) from order_submissions...
linked_subs = db.execute(
    select(LimsSubSample.sample_id)
    .join(LimsSample, LimsSubSample.parent_sample_id == LimsSample.id)
    .where(LimsSample.sample_id.in_(linked_senaite_ids))
).scalars().all()
linked_senaite_ids.update(linked_subs)
```

Single SQL round-trip. Sub-samples of a linked parent ride along with their parent's order linkage. No new column, no new table.

### Family context, lost or kept?

Today's frontend doesn't have family-card chrome (the family-card direction never shipped). Going to flat-vial cards means we don't lose anything visible. But the **mental grouping** of "these N cards all belong to BW-0009" is still useful when scanning the inbox.

Design choice: each vial card surfaces `parent_sample_id` and `is_parent` in its body, and the inbox UI groups visually (subtle indentation + connector) when adjacent cards share a parent. Sort order: by `parent_sample_id`, then `is_parent DESC` (parent first), then `vial_sequence`. Within a parent group on one filter, cards stack in vial order.

No collapse/expand chrome. The grouping is purely visual — drag/drop targets the individual card. Atomic "drag whole family" was a Phase 3-4 goal that doesn't earn its complexity now that families typically split across filters anyway (parent on HPLC, sub on Micro).

## Data model

**No schema changes.** Existing tables suffice:
- `lims_samples.assignment_role` (default `'hplc'`)
- `lims_sub_samples.assignment_role` (default `NULL`, auto-assigned by `vial-plan`)
- `service_groups`, `service_group_members`, `analysis_services` for the keyword→group mapping

## API

### `/worksheets/inbox` — new contract

Existing query params unchanged: `hide_test_orders` (default `True`), `hide_prepped` (default `True`), `force_refresh` (default `False`).

**New required query param:** `role` — one of `hplc` | `microbiology`. No default at the route layer; the frontend sets it from `localStorage`. Server-side validation: 400 on missing or invalid value.

Returns (renamed from `InboxSampleItem` to `InboxVialItem` to signal the unit change):

```jsonc
{
  "items": [
    {
      "sample_id": "BW-0009",
      "uid": "10d4490178c94e75a5e4f3d0f3c99eff",
      "is_parent": true,
      "parent_sample_id": "BW-0009",
      "assignment_role": "hplc",
      "vial_sequence": 0,
      "vial_total": 2,                       // parent + 1 sub
      "title": "Benzyl Alcohol",
      "client_id": "Wellness Co",
      "client_order_number": "3233",
      "priority": "normal",
      "date_received": "2026-05-30T...",
      "analyses": [
        { "keyword": "PH-DETERM",            "title": "pH Determination", "group_id": 1, "group_name": "Analytics", "review_state": "sample_received" },
        { "keyword": "FILL-NET-CONTENT",     "title": "Fill / Net Content", "group_id": 1, "group_name": "Analytics", "review_state": "sample_received" },
        { "keyword": "Benzyl_Alcohol_Assay", "title": "Benzyl Alcohol Assay", "group_id": 1, "group_name": "Analytics", "review_state": "sample_received" }
      ],
      "assignment": null                     // populated if (uid, group_id=1) is in a staging worksheet
    },
    {
      "sample_id": "BW-0009-S01",
      "uid": "<sub uid>",
      "is_parent": false,
      "parent_sample_id": "BW-0009",
      "assignment_role": "hplc",             // if assigned hplc; otherwise this row wouldn't be in role=hplc results
      "vial_sequence": 1,
      "vial_total": 2,
      // ...same shape
    }
  ],
  "total": 2,
  "filter_role": "hplc"
}
```

Key shape diffs from today:
- `analyses_by_group` flat-list → `analyses` flat list, already filtered to role's groups.
- Removed: `priority` mutation hooks unchanged but the per-group `assigned_analyst_id` / `instrument_uid` move from nested-per-group to per-item (since each card now represents one vial).
- Added: `is_parent`, `parent_sample_id`, `vial_sequence`, `vial_total` for the visual grouping.
- Added: `filter_role` echo so the frontend can confirm the current filter without a separate roundtrip.

### `/worksheets/inbox?grouped=true` (predecessor's family-shape) — **dropped**

The predecessor spec proposed a `grouped=true` variant returning `families`. That shape is not implemented and not needed under this model. Skip.

### Worksheet drag mechanics

Unchanged backend contract. Frontend dispatches `WorksheetItem` creates keyed on `(vial.uid, group_id)`. A vial with 3 Analytics analyses across two HPLC sub-groups (if any are ever split that way) creates 2 worksheet items. Today's data shows only one Analytics group, so this is a single-item create per vial in practice.

## UI

### Filter chip strip

Single-select chip strip at the top of `/worksheets/inbox`:

```
┌─────────────────────────────────────────────────────┐
│  [ HPLC ]   ( Microbiology )         Inbox · 4      │
│                                       hide-test ▢   │
│                                       hide-prepped▣ │
└─────────────────────────────────────────────────────┘
```

- Two pills: `HPLC` and `Microbiology`. Sky highlight for selected, neutral outline for unselected. Match the role-badge palette from `VialsList.tsx` (HPLC=sky-500, Micro=violet-500).
- Counter on the right: `Inbox · {total}` from the response.
- Toggles for `hide_test_orders` and `hide_prepped` carry over from today's UI, just relocated to the right of the chips.
- `localStorage` key: `accu_mk1_worksheet_inbox_role`. Default: `hplc` if unset.

### Vial card

Each card represents one vial. Layout:

```
┌──────────────────────────────────────────────────────────────┐
│  ⠿  BW-0009            [HPLC]   parent · 1 of 2              │
│     Wellness Co · WP-3233 · received 2d ago · normal         │
│                                                              │
│     PH-DETERM           pH Determination                     │
│     FILL-NET-CONTENT    Fill / Net Content                   │
│     Benzyl_Alcohol_Assay  Benzyl Alcohol Assay               │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│  ⠿  BW-0009-S01        [HPLC]   vial 2 of 2                  │  (indented under BW-0009)
│     Wellness Co · WP-3233 · vial of BW-0009                  │
│                                                              │
│     PH-DETERM           pH Determination                     │
│     FILL-NET-CONTENT    Fill / Net Content                   │
│     Benzyl_Alcohol_Assay  Benzyl Alcohol Assay               │
└──────────────────────────────────────────────────────────────┘
```

- Role badge top-right (sky/emerald/violet palette).
- `parent · 1 of N` / `vial K of N` chip showing position.
- When the card is for a sub-sample, the body's second line shows `vial of {parent_sample_id}` instead of the parent's `client_order_number`. Order # still surfaces from the linked parent (sort grouping ensures parent renders just above so it's not lost).
- Whole-card drag handle (`⠿`) — drops create `WorksheetItem(sample_uid=vial.uid, service_group_id=...)`.

### Visual grouping

Vials sharing a `parent_sample_id` stack with a thin connector line on the left margin (border-l-2 in a muted color). Subs indent by 8px. No expand/collapse — purely a sort-and-visual-cue treatment.

### Empty state

Two cases:
- **Filter returns no items but other filter has items** — show `No HPLC vials waiting. Try Microbiology.` with the other-filter chip emphasized.
- **Both filters empty** — show today's empty state (`No samples in the inbox.`).

## Backward compat / migration

- **No data migration required.** Existing rows have all the fields the new endpoint needs.
- **Legacy parents** (`lims_samples.assignment_role='hplc'` by migration default, never explicitly set): show under HPLC. Their Microbiology analyses don't appear in the inbox until somebody adds a Micro-role vial to the family. Acceptable — Micro analyses already aren't on a worksheet without explicit action, so no regression.
- **Existing open worksheets** (worksheet_items already assigned): the `(uid, group_id) IN assigned_pairs` exclusion logic from today still applies and still works — the keys haven't changed shape.
- **Frontend `flattenToCards`** in `WorksheetsInboxPage.tsx:60-83` — **deleted**. Card list comes flat from backend.

## Open questions / decisions to confirm

These are the three I flagged in conversation. Reasonable defaults baked into the spec above; **mark them confirmed / overridden before plan-phase**.

### Q1. Microbiology = ster + endo collapsed into one filter — confirm?
**Default in spec:** Yes — one Microbiology filter that surfaces both `ster` and `endo` vials.
**Override considered:** Split into HPLC | Endo | Sterility (3 pills). Adds a third bench at filter level. Defer unless the Endo and Ster benches genuinely want their own inbox views.

### Q2. Unassigned / XTRA / legacy vials — hide, or surface in their own filter?
**Default in spec:** Hide. XTRA is explicit extra capacity (not bench-bound). NULL `assignment_role` on subs means auto-assign hasn't run yet — they ride in on `/vial-plan` once a worksheet picks them up. Legacy parents default to `'hplc'` so they show under HPLC (not Unassigned).
**Override considered:** Third "Unassigned" filter for techs hunting for vials in limbo. Useful diagnostic but pollutes the dominant flow. Lean keep-it-hidden; revisit if a real lab incident says otherwise.

### Q3. Worksheet item granularity per vial
**Default in spec:** Keep today's `WorksheetItem.service_group_id` column. Dropping a vial onto a worksheet creates one item per `(vial.uid, group_id)` where the vial has matching analyses. Practically one item per vial today since Analytics is the only HPLC group, but the model supports future HPLC-domain splits (Core HPLC vs Identity HPLC, etc.).
**Override considered:** Collapse `WorksheetItem` to one row per vial (`service_group_id` becomes unused). Simpler at the worksheet layer but loses the per-group split that the worksheet detail page presumably uses. Don't change without auditing worksheet UI consumers.

## Inert duplicate analyses — explicit decision

A consequence of role-as-routing-tag with no SENAITE-side re-routing: every vial in a family carries an identical analysis set on its AR. Only the analyses matching the vial's role get surfaced in the inbox; the others sit unused in SENAITE.

**This is acceptable** for two reasons:
1. Result entry naturally only happens on the role-matching analyses (the tech at the HPLC bench never sees the Micro keywords).
2. The unused analyses don't break anything in SENAITE — they sit in `unassigned` review_state indefinitely.

**Known consequence:** SENAITE-side reporting tools that count "open analyses across the lab" will over-count by `(family size - 1) × (analyses count)`. Acceptable cost for not touching SENAITE; if it becomes a problem, a Phase 3.6 cleanup job could `transition_analysis(target=cancel)` on the inert duplicates.

## Out of scope (follow-ups)

- **Family card visual grouping refinement.** Today's spec ships indent + connector. A later iteration may collapse same-parent vials into a single expandable group on the inbox if the flat list gets too long.
- **Endo / Ster filter split.** Surfaces if benches want separate inbox views.
- **SENAITE inert-analysis cleanup.** If the over-counting bites.
- **"Lookup" tab for resurfacing past samples** — discussed in conversation, tabled.
- **Variance result fetch tab on the per-vial entry page** (predecessor's Phase 4) — independent of this redesign; can ship later.

## Verification

After implementation:
- BW-0009 with sub BW-0009-S01 (both `role=hplc` by default, no manual reassign) → HPLC filter returns 2 vial cards; Microbiology filter returns 0.
- After reassigning BW-0009-S01 to `role=ster`: HPLC returns 1 (parent only), Microbiology returns 1 (sub only).
- BW-0012 (1 sub, both `role=hplc` by default): HPLC returns 2 cards, both grouped under BW-0012 sort key. Each card shows the 3 Analytics analyses with results populated (Phase 1-2 fetch already wires these).
- BW-0012's Microbiology analyses (if any) don't appear under Micro filter (no Micro-role vial exists).
- Drag a vial card onto a staging worksheet → `WorksheetItem(sample_uid=<vial.uid>, service_group_id=1)` created; vial drops from inbox (same `assigned_pairs` filter as today).
