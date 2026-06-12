# Vial-Level Worksheets Inbox — Design

*2026-06-11. Follows the prep cutover (`ed4dcf9`…`c3f637d`) and container-mode parent
(2026-06-10). Approved direction: native vials become first-class inbox rows; family
grouping preserved.*

## Problem

The worksheets inbox (`GET /worksheets/inbox`, `backend/main.py` step 7) is
SENAITE-driven: one row per `sample_received` AR. Container-mode parents appear as
addable rows because they are the only worksheet-assignment handle for Mk1-native
vials, which have no SENAITE AR and therefore never appear as rows
(`InboxVialCard.tsx:144-146`). Now that the working mode is vial-only (prep cutover,
container-mode parents), a container parent is not a physical work unit and should
not be worksheet-assignable — but its vials must be.

## Decisions (Handler-approved)

1. **Native vials become inbox rows** (option 1). Worksheet items get a non-SENAITE
   identity for native vials.
2. **Legacy parents keep today's behavior** — non-container parents (parent AR ==
   physical vial 1) and the no-`lims_samples`-row fallback remain addable rows.
   Only container-mode parents are suppressed.
3. **Family grouping is a requirement**: HPLC techs must be able to grab all of a
   sample's vials in one gesture.

## Backend

### Inbox emission (`GET /worksheets/inbox`)

- In the step-7 loop, when `vial_meta["is_parent"]` and `container_mode=True` **and
  the family has ≥1 vial in `lims_sub_samples`**: do not emit the parent row. Emit
  one row per **native** vial of the family instead (subs with
  `external_lims_uid IS NULL`; AR-backed subs keep their existing SENAITE-loop path
  — no dedup risk because native vials have no AR).
- **Zero-vial container families keep the parent row** — otherwise the sample
  vanishes from the inbox until the Receive Wizard registers vials.
- Native vial row shape:
  - `uid = sub.external_lims_uid` — **plan-time correction**: native vials already
    carry a NOT NULL UNIQUE `mk1://{uuid4-hex}` uid (`sub_samples/native.py`), so no
    synthesis is needed (the spec's earlier `mk1-sub-{pk}` idea is obsolete).
  - `analyses` from the existing `_fetch_mk1_inbox_analyses_for_sub_sample`
    (Phase 3.5 source; its empty result hides the vial via the existing
    "no analyses → skip" rule, so fully-completed vials drop out naturally).
  - Per-vial filters mirror the AR path: `assignment_role ∈ allowed_vial_roles`
    (NULL excluded as today), claim filter via `assigned_pairs` keyed on the
    synthesized uid, prepped filter via `sample_preps.lims_sub_sample_pk` (and
    `senaite_sample_id == vial sample_id` if vial-scoped preps store it — verify
    at plan time).
  - Parent context flows down: `title`, `client_id`, `client_order_number` from the
    parent's SENAITE item; `date_received` from the vial's own `received_at`,
    falling back to the parent's.
  - Priority: `SamplePriority` keyed by the synthesized uid; order-level
    auto-priority (step 4b) extends to family vials without a manual override.
  - `is_parent=false`, `parent_sample_id`, `vial_sequence`, `vial_total`,
    `container_mode=true` — same fields the FE already renders.

### Worksheet write paths

- `POST /worksheets/{id}/add-group` and `POST /worksheets/create-from-drop` accept
  arbitrary uid strings already — **no change**.
- Bulk `POST /worksheets` stale-guard: **dropped at plan time** — the endpoint has
  no FE callers (`CreateWorksheetDialog`/`useCreateWorksheetMutation` are dead
  code) and it fails closed for `mk1://` uids.
- `stamp_for_item` (`lims_analyses/worksheet_analyst.py`): **no change needed** —
  it already resolves by exact `external_lims_uid` match, which native vials have.
- `_notify_worksheet_assigned`: for vial-shaped items (native or AR-backed sub),
  notify the IS with the **parent** sample_id so the WP order-status flip
  (`analyzing`) keeps working. Today it fires the vial ID, which the IS cannot map
  to an order — pre-existing quirk this fixes. Verify the IS endpoint's matching
  behavior during execution before changing the AR-sub path.

## Frontend

### Family grouping (WorksheetsInboxPage)

- Replace the flat list + indent/connector treatment with **family group sections**:
  vials sharing a `parent_sample_id` render under a slim family header showing
  parent ID, client, "N vials", and the family aging timer. Families that render a
  single row (legacy parents, lone vials) keep today's standalone card.
- **Family header is draggable**: dropping it on a worksheet (or "new worksheet")
  adds every visible — bench-filtered, unclaimed — vial in the family as individual
  worksheet items. Implementation: client-side loop over the existing
  `addGroupToWorksheet` / `createWorksheetFromDrop` endpoints so per-vial collision
  guards stay intact; partial failures surface per-vial via toast and the inbox
  refresh shows leftovers.
- Individual vial drag is unchanged.
- `InboxVialCard`: native vial rows render identically to AR-backed vial rows (uid
  shape is the only difference). The container-parent "N vials" card branch
  (`InboxVialCard.tsx:147-153`) becomes reachable only for zero-vial families.
- `AddSamplesModal` consumes the same endpoint — native vials appear with no change.

## Out of scope

- Worksheet drawer / Start Prep flow — already vial-aware (`lims_sub_sample_pk`
  threads through to the wizard and `VialResultsView`).
- Micro bench semantics — the role filter applies per vial exactly as today.
- Parent sample pages, COA gate, attachments — untouched.
- Removing the legacy no-`lims_samples`-row fallback.

## Testing

- Backend (`tests/test_worksheets_inbox.py` pattern — mock SENAITE/service layer,
  real logic at service level):
  - Container parent with vials → parent suppressed, native vial rows emitted with
    synthesized uids and role/claim/prepped filters applied.
  - Container parent with zero vials → parent row retained.
  - Legacy non-container parent → unchanged row.
  - Bulk create stale-guard skips SENAITE for `mk1-sub-*` and validates Mk1-side.
  - `stamp_for_item` resolves `mk1-sub-{pk}`.
  - Worksheet-assigned notify uses parent sample_id for vial items.
- FE (vitest): family grouping logic (section assembly from the flat sorted list),
  family-drag payload assembly (visible+unclaimed vials only).

## Risks / notes

- The inbox route is one large function; changes stay additive within step 7 plus a
  small native-vial enumeration helper. No schema changes — `worksheet_items.sample_uid`
  is already a free string column.
- N sequential add calls from a family drag fire N IS notifications; the status flip
  is idempotent, and switching to parent-id notify collapses them to the same order
  anyway.
- Pre-existing test failures in `test_container_mode`/`test_sub_samples_routes` are
  baseline (stash-verified) — do not chase them as regressions.
