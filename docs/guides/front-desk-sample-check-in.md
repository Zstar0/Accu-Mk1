# Front-Desk Sample Check-in Guide

## At a glance

This guide walks you through receiving a sample shipment and checking each vial into Accu-Mk1 using the Receive Wizard. It covers the dominant happy path (open a sample, capture each vial, assign roles, print labels) plus the variants and recovery steps you'll actually hit.

A heads-up: the **Receive Wizard** and the **sub-samples workflow** described here are new — Accu-Mk1 now treats every physical vial in a shipment as its own tracked unit, with a photo, an assignment role, and a label. Read this once end-to-end before your first big shipment.

## What this workflow gives you

> **At a glance:**
>
> - **One wizard to check in every vial in a shipment.** Live camera capture, photo retake, optional remarks, save. The wizard remembers where you are if you come back to add more vials later.
> - **A persistent sample-info sidebar** during capture (Client, Contact, Peptide, Quantity, etc.) so you keep full context while the camera has your attention.
> - **The first vial of a multi-vial shipment lands on the parent sample directly.** Vial 2 and beyond become sub-samples named `<parent>-S01`, `<parent>-S02`, etc. Single-vial shipments stay clean — no sub-samples created.
> - **Assignment tab with drag-and-drop role buckets** (HPLC, ENDO, STERYL, XTRA). Whichever bucket you drop a vial into is where the lab tech finds it later.
> - **Print Labels tab** with per-label checkboxes. By default every vial in the session is selected; uncheck any you don't need. The parent's label prints alongside the sub-sample labels in one pass.
> - **A [Finish] button on every tab** — you don't have to walk through every step. Capture vials, assign roles, finish; or capture and finish; or capture, assign, print, finish. Whatever the situation calls for.
> - **File picker fallback** when the camera fails or is denied — pick a JPEG / PNG of the vial from disk and the wizard treats it identically.
> - **Bac Water HPLC filter** — when the parent's sample type is "Bacteriostatic Water," the HPLC wizard Step 1 filters its analyte dropdown to additives (currently just Benzyl Alcohol), so the list looks short on purpose.

## Before you start

Have Accu-Mk1 open and signed in. You'll be moving between the **Intake** area and the **Cab label printer** at your station, so make sure both are reachable before you open the first box. If your station camera permission was reset (new browser, new profile), expect a permission prompt the first time you hit the capture screen.

Prerequisites:

- Accu-Mk1 web app open, logged in.
- Camera permission granted to the browser (or a fallback JPEG/PNG of the vial on disk).
- Cab label printer connected and selected as a printer in the browser.
- Label stock loaded: **30x15mm**.
- The shipment box opened, vials lined up in the order you'll check them in.

## The main workflow

### Step 1 - Find the sample in the Receive list

1. Open **Intake -> Receive Sample** from the left sidebar.
2. The **Samples** list loads. Columns: **Sample ID**, **Order #**, **Client**, **Sample Type**, **Date Sampled**, **Vials**, **State**, **Age**.
3. Click any column header to sort (tri-state: ascending -> descending -> unsorted). Default is SENAITE's order with no client-side sort applied.
4. If you don't see the order you're looking for, hit the **Refresh** button in the top-right.
5. If you're testing or expecting an internal order, tick **Show Test Samples**. Test contacts (forrest@valenceanalytical.com, etc.) are hidden by default.

<!-- screenshot: Samples list with the Show Test Samples checkbox and Refresh button visible -->

| Control | What it does |
| --- | --- |
| Column header click | Sort tri-state: ascending -> descending -> unsorted |
| **Refresh** | Re-pulls the list from SENAITE |
| **Show Test Samples** | Includes orders from internal test contacts (off by default) |

Click the row for the sample you're receiving. The **Receive Wizard** modal opens with that parent pre-selected.

### Step 2 - Vial Management (capture)

This is the tab the wizard lands on. Left panel holds the persistent sample info card (Client, Contact, Type, Order #, Client Sample ID, Lot, Profiles, Declared Qty, Date Sampled, Analytes) so you have context while shooting photos.

<!-- screenshot: Vial Management tab with sample info card on the left, camera preview center, vial sidebar right -->

1. On the right sidebar, you'll see the vial list. If the parent was received in this session, it's marked **Vial 1**. Sub-samples (vial 2+) appear under it.
2. In the main panel:
    - If the camera is available, you'll see a live video preview and a **[Capture]** button.
    - If the camera fails or is denied, you'll see a styled **[Upload]** button instead. Pick a JPEG or PNG of the vial from disk.
3. Tap **[Capture]**. A static preview card replaces the live feed; **[Retake]** lets you redo it.
4. Optional: type into the **Remarks** textarea. If you're editing an existing vial, this is pre-populated.
5. Click **[Save Vial]**. The button is disabled until a photo is captured.
6. On success a confirmation card appears with the new sample ID and a **[Receive another vial]** button. Use it to bang through the rest of the vials.

### Step 3 - Assignment (drag-and-drop roles)

The **Assignment** tab is disabled until at least one vial is saved this session (or the parent has already been received in a prior session).

<!-- screenshot: Assignment tab with four role buckets and vial cards on the left -->

1. Drag a vial card from the left into the appropriate role bucket. The four buckets are:

| Role | Used for |
| --- | --- |
| **HPLC** | Identity and quantitation HPLC analyses |
| **ENDO** | Endotoxin testing |
| **STERYL** | Sterility testing |
| **XTRA** | Held for future use / unassigned downstream routing |

2. The role persists to the database the moment you drop. UI updates optimistically.
3. If a drop fails (backend error), the UI rolls back and shows an error. Hit **Refresh** to re-fetch from backend before trying again.
4. There is no undo button. To change a role, drag the vial into a different bucket. To clear it entirely, contact a backend admin.

### Step 4 - Print Labels

The **Print Labels** tab is disabled until at least one vial exists in the session. The parent vial is included in this list if you received it this session, so one print pass covers everything.

<!-- screenshot: Print Labels tab with selection counter, per-label rows, QR previews -->

1. Per-label rows show: checkbox, QR preview, sample ID, order #, vial position.
2. The control panel above the list shows **"N of M labels selected"** with **[Select all]** and **[Clear all]** buttons.
3. Tick the labels you want, then click **[Print N labels]**.
4. The browser print dialog opens. Select the **Cab printer** and paper size **30x15mm**.
5. Confirm in the dialog. Labels include QR code, sample ID, order #, and vial position.

There is no **[Skip Printing]** button. If you don't need to print, just close the wizard or navigate away.

### Step 5 - Sub Sample Details (read-only)

This tab is disabled until at least one sub-sample exists. Parent-only sessions skip it.

<!-- screenshot: Sub Sample Details table with View Details and Print Label per row -->

| Column | Notes |
| --- | --- |
| **Vial #** | Position within the parent's vial set |
| **Sample ID** | `<parent>-S<NN>` |
| **Received At** | Timestamp |
| **Received By** | Staff name |
| **Status** | Current SENAITE state |
| **[View Details]** | Opens the sub-sample's detail page |
| **[Print Label]** | Reprints a single label without leaving this tab |

### Wizard footer behavior

- **[Back]** appears on all tabs except Vial Management.
- **[Finish]** is available on every tab whenever you've saved at least one vial in the current session. (When the wizard is opened from a sample's detail page just to view its existing sub-samples — no new check-in work — [Finish] is hidden and the X in the dialog corner is the close affordance.)
- **[Continue]** appears on Vial Management (disabled until a vial is saved).
- On Assignment, the forward button becomes **[Print Labels]**.
- Print Labels has no forward button beyond **[Finish]**.

## Variants

### Adding a vial to a parent that's already checked in

1. Open the parent sample detail page.
2. Scroll to the **Sub-Samples** section.
3. Click **[Add Sub-Sample]**. The wizard launches with the parent pre-selected and the vial sequence already incremented to the next slot.
4. Proceed as in Step 2 above. The wizard sidebar will show all prior vials (read-only, linked) above the new one.

This is allowed even on already-published parents. Parent state is not touched; the new vial sits with no analyses until a worksheet routes it. COA invalidation is not handled in v1.

### Reprinting a label

You have two paths:

- From inside the wizard: open the **Sub Sample Details** tab and use the per-row **[Print Label]** button.
- From the parent sample detail page: each sub-sample row has its own **[Print Label]** action that re-opens the print dialog.

### Adjusting a vial's role assignment

Re-assignment is a drag from the current bucket to a different one. The backend handles it as a PATCH; if it fails, the UI rolls back and you'll see an error. Hit **Refresh** before retrying. There's no explicit lock at intake — once a vial is on a worksheet, the lab tech locks the **variance set** (a separate concept they own; you don't need to touch it).

### Bacteriostatic Water analyte filter

When the parent sample type is **Bacteriostatic Water**, the HPLC wizard Step 1 filters to `'additive'`-class analytes (currently just Benzyl Alcohol). Additives are hidden in all other contexts. Nothing for you to do here; the filter is automatic. Flagging it so the list doesn't look "wrong" when you see only one analyte.

## Common pitfalls

- **"Show Test Samples" is off by default.** Internal test orders (forrest@valenceanalytical.com and similar) won't appear until you tick the checkbox.
- **XTRA is a real role, not a placeholder.** It's the fourth bucket on Assignment and is meant for vials held for future use. Drag vials into it intentionally.
- **No undo on Assignment drops.** A drop persists immediately. To change a role, drag to a different bucket. To clear it entirely, you need a backend admin.
- **Decimal quantity fields don't inherit to sub-samples.** Plone-5 validators reject Python 3 types, so `Analyte{N}DeclaredQuantity` and `DeclaredTotalQuantity` won't carry from parent to sub. Enter them manually on the SENAITE AR page if you need them populated.
- **Print Labels does not block sub-sample persistence.** If the printer dies, the vial is still saved. Reprint later from **Sub Sample Details** or the parent sample page.

## Edge cases & recovery

- **Camera and file picker both fail:** photo capture is blocked. There's no path forward in that branch. Resolve the browser/permission state, then retry.
- **Drag-to-new-bucket PATCH fails:** UI rolls back, error appears. Click **Refresh** on the Assignment tab to re-sync state with the backend, then redo the drop.
- **Wizard closed mid-session with an unsaved vial:** saved vials persist atomically; the in-flight unsaved one is lost. Re-open the wizard from the parent; the sidebar pre-populates with the saved vials, and you can capture the missing one fresh.
- **Wizard reopens and you see prior-session vials in the sidebar:** that's expected. They render read-only with links to detail pages. New session vials appear below them.
- **Adding a vial to an already-published parent:** allowed unconditionally. Parent state is untouched, the new vial has no analyses until a worksheet routes it, and no COA invalidation happens.
- **Cold-cache parent on save:** if `lims_samples` is more than ~5 min stale, the backend auto-refreshes from SENAITE and reconciles. Rare. If it surfaces in an error, just retry.
- **Print dialog fails or you pick the wrong printer:** worst case, write the sample ID on the vial in marker and reprint from **Sub Sample Details** or the parent detail page later.

## Glossary

- **Additive class:** Analyte discriminator (`'peptide'` or `'additive'`). Drives the HPLC Step 1 filter for Bacteriostatic Water.
- **Contact (SENAITE Contact field):** Client contact person. Inherits parent -> sub-sample. Required for `update_remarks` to succeed.
- **Secondary AR:** SENAITE's `AnalysisRequestSecondary`. The technical term for a sub-sample. Auto-named `<parent>-S<NN>`.
- **Service group:** A grouping of tests/analyses. Used downstream in worksheets and SLAs; not shown in the wizard.
- **Sub-sample:** One physical vial received as a child of a parent. Represented as `<parent>-S<NN>` (e.g. `P-0134-S02`). Vial 1 is the parent; vial 2+ are sub-samples.
- **Assignment role:** Which bench a vial goes to: `hplc`, `endo`, `ster`, or `xtra`. Set via drag-to-bucket on the Assignment tab. Different from the lab tech's "variance set" (which is about which vials count toward statistics — not your concern at intake).
- **Vial sequence:** Integer (1, 2, 3, ...) representing the sub-sample's position within its parent's vial set. Displayed as "Vial 2 of 4" (vial_sequence + 1). Unique per parent; assigned atomically at save.
- **XTRA vial:** Assignment role for vials held for future use, not routed to a specific test yet.
