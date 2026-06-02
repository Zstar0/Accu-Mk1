# Lab Tech Guide: Worksheets & Variance

## At a glance

This guide walks you through planning worksheets from the inbox, running items through the bench, and locking variance sets on multi-vial parents. The June 2026 release reworked the inbox from grouped families to flat vials and added a proper variance membership workflow, so even if you've been doing this for months, a few of the clicks have moved.

## What's new in this release

> **What's new:**
>
> - The inbox is now one card per **vial** (parent or sub-sample), not one card per `(parent x service_group)` family. Vials from the same parent are connected visually but no longer collapse.
> - **Sub-samples now show up in the inbox.** Previously only parents appeared.
> - **Role filtering is a single-select chip pair: HPLC or Microbiology.** A separate **Show XTRA** toggle reveals XTRA-role vials. Your last choice sticks via localStorage.
> - **Variance Summary dialog** on each parent sample page. You pick which vials count toward Mean / SD / CV%, lock the set, and (if you're an admin) unlock it for corrections.
> - **SLA age column** on the worksheet items table, banded red / amber / green.
> - **Print Labels now includes the parent** when it's received in the same session as sub-samples — one pass, not two.
> - **First vial of a never-received parent stays on the parent AR** (no `-S01` is created). Sub-samples start at vial 2.

## Before you start

You'll want the LIMS open in your usual browser, signed in with the role that matches the bench you're working from (HPLC technician or Microbiologist). The inbox auto-routes you based on role, but you can flip the filter chips manually any time. Have your tablet or label printer reachable if you'll be reprinting.

- Logged into the LIMS web app with your tech account
- Role: HPLC technician, Microbiologist, or Lab admin (admin needed to unlock variance sets)
- SENAITE reachable (the inbox pulls from SENAITE; if cards look stale, you'll hit **Refresh**)
- Label printer paired if you plan to reprint sub-sample labels
- For variance work: at least one parent sample with two or more vials received

## The main workflow

### 1. Open the Worksheets Inbox

From the main sidebar, expand **HPLC Automation** and click **Inbox**. Your last filter choice (HPLC or Microbiology) is remembered between sessions via `localStorage`, so you'll usually land on the bench you worked from last.

<!-- screenshot: Worksheets Inbox landing page with vial cards on the left and worksheet zones on the right -->

You'll see vial-flat cards on the left side. Each card is one vial — either a parent AR or a sub-sample AR. Vials that share a `parent_sample_id` are visually connected with a grouping line but do not collapse into a single card.

### 2. Set your filters (top-right filter bar)

Before you drag anything, get the inbox showing only what you care about.

1. Click either the **HPLC** chip or the **Microbiology** chip. This is single-select; the last one you used is remembered between sessions.
2. Check **Hide test orders** (default ON). Real orders have a linked WordPress order; test orders do not.
3. Check **Hide prepped** (default ON). Hides items already through prep.
4. Check **Show XTRA** (default OFF) only if you need to see XTRA-role vials in the current filter.
5. If you suspect the inbox is stale (rare in production), click **Refresh** to force a re-pull from SENAITE.

| Filter | Default | What it does |
|---|---|---|
| **HPLC** chip | Selected for HPLC role | Shows only vials with `assignment_role = hplc` (plus parents whose role is hplc). |
| **Microbiology** chip | Selected for Microbiologist role | Shows only vials with `assignment_role` in `endo` or `ster`. |
| **Hide test orders** | ON | Hides any AR not linked to a WordPress order. |
| **Hide prepped** | ON | Hides items already marked prepped on a worksheet. |
| **Show XTRA** | OFF | When ON, includes XTRA-role vials in the active filter results. |

Each vial card only shows analyses that match its role's service groups. A parent on the HPLC filter will hide its Microbiology analyses; a sub-sample on Microbiology will show only Endo / Ster.

### 3. Drag a vial onto a worksheet

This is the core action. On the right side of the inbox you have a **New Worksheet** drop zone and any open worksheet cards.

1. Grab a vial card on the left (drag handle or the card body).
2. Drop it on **New Worksheet** to create a blank worksheet with this vial as the first item — or drop it on an existing worksheet card to add it there.
3. The vial card optimistically hides from the inbox.
4. A toast confirms: "Created worksheet" or "Added to worksheet".

<!-- screenshot: Mid-drag, vial card hovering over an existing worksheet card -->

### 4. Set up the worksheet from the right panel

While still on the inbox page, you can manage worksheets in place from their cards on the right.

- Click the pencil icon to rename the worksheet. Press Enter to save, Escape to cancel.
- Click the **Assign tech** dropdown and pick a technician. The choice is persisted immediately.
- Hover an item in the worksheet card and click the **X** to send it back to the inbox.
- Click the trash icon to delete the entire worksheet. You'll get a confirmation dialog.

### 5. Open the worksheet detail page

Click the worksheet card title (or its open arrow) to drop into the detail page. This is where you actually run the bench work.

<!-- screenshot: Worksheet Detail page with the items table and SLA banded column -->

The items table shows:

- **Sample ID**
- **Service Group**
- **Priority**
- **Peptide names**
- **Method**
- **Instrument**
- **SLA age** — banded red (overdue), amber (within the per-tier warning threshold; default 20% of remaining time), green (on track)
- **Status**
- **Actions**

### 6. Work the rows

Each row supports a handful of actions. Most are hover-revealed.

1. Drag the left-edge handle to reorder items in the worksheet (only before completion).
2. Click the hover **X** to remove an item back to the inbox.
3. (HPLC only) Use the **Status** dropdown to move an item between `ready`, `in_progress`, and `complete`. Once the worksheet is completed, this is locked.
4. (HPLC only) Use the **Instrument** dropdown to choose which analyzer runs the item.
5. (Hover) Click the **Move arrow** to reassign the item to another open worksheet via a dropdown.
6. (HPLC only) Click **Start Prep** to launch the prep wizard for that item.

### 7. Add more items, then complete

- Click **Add Samples** in the worksheet header to open a modal of inbox items not yet on this worksheet; click items to add them.
- When every item is `ready` (or further along), click **Complete Worksheet**. This locks status changes and marks prep complete.

### 8. Lock the variance set (parent samples with multiple vials)

Variance lives at the parent sample. After results come in (or even before, see Edge cases), open the parent sample's detail page and click **Variance Summary**.

<!-- screenshot: Variance Summary dialog header showing parent sample ID -->

In the dialog:

1. The vial selection table lists every vial on this parent — the parent itself plus any sub-samples. Checkboxes on the left.
2. Use the checkboxes to choose which vials are members of the variance set. **Select all** and **Clear all** at the footer are shortcuts (disabled once locked).
3. For each unchecked vial, fill in the **Exclusion reason** field (e.g., "contaminated", "out of range prep").
4. Below, the **Stats table** shows one row per analysis (e.g., PURITY), with Mean, SD, CV%, n, spec limits, and PASS / FAIL. It populates as vial results land in SENAITE.
5. Click **Lock variance set** at the bottom. The button is only enabled when at least two vials are selected and the set isn't already locked.
6. A gold banner appears. Membership and results for these vials are now immutable.

If you're an admin, an **Unlock** button is available once the set is locked — use it sparingly and only to correct real mistakes.

### 9. Check the Sub-Sample Details tab when relevant

Sub-samples have their own tab inside the Receive Wizard and on the parent detail page. The table columns are:

- **Vial #**
- **Sample ID** (clickable, navigates to that vial's detail)
- **Role** — badge shows HPLC, ENDO, STER, or XTRA
- **Photo** thumbnail (loads via the authed proxy)
- **Received timestamp**
- **Received by**
- **Actions** — **Open** and **Print Label**

Empty state reads "No sub-samples yet" if the parent has no secondaries.

| Role badge | Meaning |
|---|---|
| **HPLC** | Vial heads to the HPLC bench. |
| **ENDO** | Endotoxin testing (Microbiology filter). |
| **STER** | Sterility testing (Microbiology filter). |
| **XTRA** | Extra / experimental; hidden unless **Show XTRA** is on. |

## Variants

### Adding a vial to a parent that's already checked in

Use the standard intake / Receive Wizard for the additional vial. The new vial will appear as a sub-sample (vial 2+). The first vial of a never-received parent lands on the parent AR alone (no `-S01` is created); only subsequent vials become secondaries. Parent shows as "Vial 1 / N", sub-samples as "Vial 2 / N", etc.

### Reprinting a label

From the Sub-Sample Details table, click **Print Label** in the Actions column of the row you want. If you're receiving a parent in the same session as sub-samples, the print step shows the parent label alongside the sub-sample labels in one pass.

| Action | When to use |
|---|---|
| **Check-in (Receive Wizard)** | First time the vial is received. |
| **Print Label (from row)** | Re-print only — vial is already checked in. |

### Adjusting variance membership before locking

Open **Variance Summary** on the parent. Toggle checkboxes freely while the set is unlocked. Add or clear exclusion reasons as you go. Click **Lock variance set** when membership is final. After locking, the only way to change membership is admin unlock.

### Reassigning a worksheet item to a different worksheet

On the worksheet detail page, hover the row and click the **Move arrow**. Pick a target open worksheet from the dropdown. The item moves; status carries with it. Only available while the source worksheet is not completed.

### Renaming or deleting a worksheet from the inbox

Pencil icon to rename inline (Enter saves, Escape cancels). Trash icon to delete entirely (confirmation dialog). Deleting sends all items back to the inbox.

## Common pitfalls

- **`Hide test orders` is ON by default.** If the inbox looks empty, this is usually why. Real orders have a linked WordPress order number; test orders do not.
- **`Show XTRA` is OFF by default.** XTRA-role vials won't appear under either HPLC or Microbiology until you flip this.
- **Sub-samples without an assignment role stay invisible.** They surface once the Vial Plan auto-assigns or you manually override.
- **Variance lock is immutable.** Once locked, no member vial can be added, removed, or have its results edited. Admin unlock is the only way back; the two-click gate is intentional.
- **Legacy pre-wizard parents default to `role = hplc`.** If their analyses include Microbiology tests, those analyses won't appear on Microbiology filter cards until a vial is manually assigned `endo` or `ster`.
- **Decimal quantities don't inherit parent to sub.** DeclaredTotalQuantity and similar fields must be set manually in SENAITE UI due to a known SENAITE / Plone validator bug. Most other fields inherit fine.
- **Cold-cache parents on first inbox load.** When a parent is linked for the first time, SENAITE fetch can return stale data. Hit **Refresh** to force a re-pull.

## Edge cases & recovery

- **Both camera and file-picker fail during vial capture.** A fallback **Upload** button (styled, with icon) replaces the camera UI. Click it to open the system file picker. If both still fail, skip the photo, add remarks, and save.
- **Variance lock with no results yet.** Allowed. The stats table shows "No results entered yet — stats will populate as vial results land." Useful for pre-registration workflows where you want membership decided before run-time.
- **Sub-sample created without parent contact UID.** The service refuses with a 400 and auto-refreshes the parent from SENAITE once. If it's still missing, you'll get a 502 with `code: "secondary_fallout"` — frontend prompts for manual cleanup.
- **Worksheet moved to completed.** All rows become read-only — no status, instrument, or reorder changes. Items can still be viewed; the only way to remove them is to delete the entire worksheet.
- **Orphan sub-sample AR in SENAITE (no local row).** Drift reconciliation on the parent detail page detects this and logs a warning. Happens when a secondary is created in SENAITE but the local DB insert failed (e.g., a network blip). Manual UID cleanup in SENAITE is required.
- **Multi-group vials (rare HPLC sub-group split).** When a single vial's analyses span two HPLC service groups, one vial creates two worksheet items (one per group). Dragging a multi-group vial copies it to two items in the target worksheet — that's expected, not a duplicate bug.

## Glossary

- **Assignment role** — Metadata flag on each vial: `hplc`, `endo`, `ster`, `xtra`, or `NULL`. Decides which bench filter shows the vial. Set during the Receive Wizard; can be overridden post-intake.
- **Linked order** — A SENAITE sample matched to a WordPress order via `order_submissions`. Only linked orders appear in the inbox by default.
- **Prep status** — Per-worksheet-item flag: `ready`, `in_progress`, `complete`. Locked once the worksheet is completed.
- **Secondary AR / Sub-sample** — A SENAITE AR created as a child of a parent, auto-named `<parent>-S<NN>`. Represents vial 2+ on a multi-vial order.
- **Service group** — SENAITE concept: `Analytics`, `Microbiology`, `Endotoxin`, `Sterility`, etc. Decides which analyses an AR can hold.
- **Show XTRA toggle** — Inbox filter checkbox. When ON, XTRA-role vials are included in the active filter. Persisted in localStorage.
- **SLA** — Service-level agreement on turnaround time (default 48 hours), tracked from `date_received`. Inbox bands age red / amber / green.
- **Variance set** — Per-parent subset of vials participating in Mean / SD / CV% statistics. Membership is user-controlled via the Variance Summary dialog. Needs at least two selected vials to lock.
- **Vial** — A physical sample container, represented as a parent AR or sub-sample AR in SENAITE. Each has its own UID and can carry its own role and results.
- **Worksheet** — A grouping of vials for batch processing on an instrument. Created from the inbox by drag-drop. Holds items of `(vial_uid, service_group_id, assigned_analyst)`.
- **XTRA vial** — A vial with `assignment_role = 'xtra'`. Not assigned to HPLC or Microbiology benches; used for experimental or extra-capacity runs. Hidden until **Show XTRA** is toggled on.
