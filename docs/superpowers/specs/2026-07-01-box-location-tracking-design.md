# Box Location Tracking via QR — Design

*2026-07-01. Brainstormed with Forrest after the team walkthrough of the boxing feature. Approved design; implementation split into buildable-now and deferred slices.*

## Problem

Boxes of vials move around the lab: check-in desk → analytical bench (HPLC / Endotoxin / Sterility) → storage. Today the system knows a box's contents but not its location. The lab is installing QR scanners at each bench and at storage; scanning a box on arrival should record where it is. Techs and leads need to see where any active box currently sits, and its movement history. When testing completes, the box goes to storage, is emptied, and the physical container returns to the check-in desk for reuse.

## Decisions (locked)

| Question | Decision |
|---|---|
| What does the QR identify? | **The per-order box** — the existing `lims_boxes` row. No permanent physical-box asset entity. "Reuse" means the physical container gets a fresh box record + freshly printed label on its next order. |
| How does a scan know its location? | **Station model** — each bench/storage has a scanner station that knows its own `bench_id`. The box QR carries only the box id; the station appends its bench id and calls the check-in endpoint. |
| What does the QR encode? | **Bare `lims_boxes.id`** (e.g. `137`), not a URL. Keeps the QR sparse enough to print scannably at 5.5 mm on the existing 2"×¼" strip (CAB Mach 4S). Label stock unchanged. |
| Sequencing | **Spec everything now; build the independent slices now** (QR repoint, storage/empty lifecycle, minimal Active Boxes page); **defer location capture** until the Department/Bench hierarchy (owned by another agent, in progress) lands. |

## Interface to reconcile: `bench_id`

Location events reference a bench from the Department/Bench hierarchy being built separately. Its shape (int FK? string code?) is **that project's contract to publish**. Everything in the "deferred" column below binds to it; nothing in the "build now" column does. When the hierarchy lands, agree on: the `bench_id` column type + FK target, and whether storage locations are benches in that hierarchy (recommended: yes — storage is just another scannable location).

## Data model

**`lims_boxes` — additive columns (build now):**
- `stored_at TIMESTAMP NULL` — set when the box is closed out to storage. *Active box* = `stored_at IS NULL`.
- `stored_by_user_id INTEGER NULL REFERENCES users(id)` — who closed it.

**`lims_box_location_events` — new table (deferred; needs bench hierarchy):**
- `id` PK
- `box_id` → `lims_boxes.id` `ON DELETE CASCADE`
- `bench_id` — **INTERFACE**: type/FK per the Dept/Bench hierarchy
- `scanned_at TIMESTAMP NOT NULL`
- `scanned_by_user_id INTEGER NULL REFERENCES users(id)` — null when the station scans unauthenticated
- Current location = the row with the latest `scanned_at` per box. History = all rows, newest first. Re-scans simply append (idempotent-friendly; a duplicate scan is a truthful "still here" event).

## QR contract (build now)

`BoxLabelTemplate` currently encodes the human label code (`WP-3267-1`). Change: encode `String(box.id)` instead; the human `label_code` remains as printed text on the label. `BoxStep` threads `box.id` into the template alongside the existing props. Scanner stations treat the scanned payload as the box id verbatim.

Backward compatibility: labels printed before this change encode the label code, which is non-numeric — stations should reject non-numeric payloads with a "reprint this label" message. Reprinting any old box's label from the UI yields a compliant QR.

## Location check-in endpoint (deferred)

`POST /api/boxes/{box_id}/location` with body `{ bench_id }`:
- 404 unknown box; 400 unknown bench; 409 if the box is already stored — a stored box must never silently come back to life; the station shows "box is closed — return it to check-in for relabeling."
- Inserts one `lims_box_location_events` row; `scanned_by_user_id` from auth when present.
- Storage stations call the same endpoint; if the bench is flagged as a storage location, the server ALSO runs the close-out (below) — that's the "scan at storage closes the loop" behavior.

## Empty & reuse lifecycle (build now)

**Close-out** (one server-side action, `POST /api/boxes/{box_id}/close`):
1. Unassign every vial in the box (`box_id → NULL` — same mechanic as `delete_box`, which stays for mistake-boxes).
2. Set `stored_at` / `stored_by_user_id`.
3. Box drops off the active list. Physical container returns to the check-in desk; next order mints a new box record + label.

Ships now with a manual **Close** button on the Active Boxes page; the storage scan becomes an automated caller of the same action later. `delete_box` (trashcan in BoxStep) remains the "this box shouldn't exist" path; close-out is the normal end-of-life path and — unlike delete — leaves the box row + (future) location history behind as a record.

## Active Boxes page (build now, minimal)

New page listing boxes where `stored_at IS NULL`, grouped or sortable by order:
- Columns now: label code, order, role, vial count (chips on expand ok), created, **Close** action (confirm dialog — it unassigns vials).
- Columns later (deferred slice): current location, last-scan time, and a history drawer per box.
- Route suggestion: `/boxes`. Uses the existing `listOrderBoxes`-style serialization plus a new `GET /api/boxes/active` (no order_key filter).

## ISO 17025 alignment

- **7.4 handling of test items:** location events give per-box custody through the lab — where an item was, when, continuously from receipt to storage.
- **7.5 technical records:** events are append-only with actor + timestamp; close-out is stamped (`stored_at`, `stored_by`). Never hard-delete events.
- Known gap (existing posture): storage-condition monitoring (7.4.4) is separate and remains opt-in.

## Slices

| # | Slice | Depends on | Status |
|---|---|---|---|
| 1 | QR repoint to bare box id (`BoxLabelTemplate` + `BoxStep` thread-through) | — | build now |
| 2 | `stored_at` columns + close-out endpoint + minimal Active Boxes page | — | build now |
| 3 | `lims_box_location_events` + location check-in endpoint | bench hierarchy | deferred |
| 4 | Active Boxes location columns + history drawer; storage-scan auto-close | slices 2+3 | deferred |

## Out of scope

- Permanent physical-box asset tracking (rejected: per-order model chosen).
- Scanner-station hardware/provisioning and station auth (operational; revisit at slice 3).
- Any WP/customer-facing surface.
