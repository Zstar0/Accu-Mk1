# Internal Remarks — "internal note" amber treatment

*Design spec — 2026-07-02*

## Purpose

Give the **Internal Remarks** posts on the Sample Details page a warm amber "internal note" look (like Plain's internal notes), signaling at a glance that these are lab-internal and never shared with the customer. Reuse the **exact color scheme from the Flags user guide's callouts** for visual consistency across the product.

## Scope

Frontend-only. No backend, API, or data change. New branch off master (Mk1 1.0.18); ships as a future 1.0.19.

## Current state

`src/components/senaite/SampleDetails.tsx` (~line 5515) renders the Internal Remarks section. Each remark is an inline `<div>` card styled neutral grey (`p-3 rounded-lg bg-muted/40 border border-border/30`): a small `User`-icon avatar, the author (`r.user_id ?? 'System'`), a timestamp (`formatDate(r.created)`), and a DOMPurify-sanitized HTML body. Remarks come from `data.remarks: SenaiteRemark[]` (`{ content: string; user_id: string | null; created: … }`). The separate **Customer Remarks** card below is the customer-facing one — Internal Remarks are always lab-internal.

## Color scheme (from the Flags guide callouts)

The guide's callout hexes map almost 1:1 to Tailwind `amber`:

| Role | Light | Dark |
| --- | --- | --- |
| Background | `bg-amber-100` (`#fef3c7`) | `dark:bg-[#3f2f0c]` (the guide's warm brown) |
| Left border | `border-amber-500` (`#f59e0b`) | `dark:border-amber-600` (`#d97706`) |
| Text | `text-amber-900` (`#78350f`) | `dark:text-amber-200` (`#fde68a`) |

The guide callout's signature is a **4px left border** on the tinted panel. So each card uses `border-l-4` (not a full border), matching the orange left edge in the reference.

## Design

**Extract a presentational component** `src/components/senaite/InternalRemarkCard.tsx`:

- **Props:** `{ author: string; createdLabel: string; content: string }` — primitives only, so it has no dependency on `SampleDetails` internals (`formatDate` stays where it is; the caller passes `formatDate(r.created)`). Owns its own `DOMPurify` import for the body.
- **Renders** an amber card:
  - Container: `rounded-lg border-l-4 border-amber-500 bg-amber-100 p-3 dark:border-amber-600 dark:bg-[#3f2f0c]`.
  - Header row: a small avatar circle tinted amber (`bg-amber-200 dark:bg-amber-800/40`, `User` icon `text-amber-700 dark:text-amber-300`) + author (`text-xs font-medium text-amber-900 dark:text-amber-200`) + timestamp (`text-[11px] text-amber-700 dark:text-amber-300/80`).
  - Body: DOMPurify-sanitized HTML (same allow-list as today: `a b i em strong br p span` + `href target rel class`), `text-sm text-amber-900 dark:text-amber-200`, links keep `[&_a]:text-blue-700 dark:[&_a]:text-blue-400 [&_a]:underline`.
  - Caption: an `EyeOff` icon + **"Internal — not shared with the customer"**, `pl-7 mt-1.5 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300/80`.

> **Avatar note (minor deviation from the approved sketch):** the small avatar circle gets a subtle amber tint too, so the card reads as one cohesive amber note rather than a grey chip on an amber panel — in the spirit of "same color scheme." It's *not* the full gold Plain tile.

**Wire it in `SampleDetails.tsx`:** replace the inline remark `<div>` in the `data.remarks.map(...)` with `<InternalRemarkCard author={String(r.user_id ?? 'System')} createdLabel={formatDate(r.created)} content={r.content} key={…} />`. Add the `InternalRemarkCard` import; drop now-unused `User` from the SampleDetails lucide import **only if** it's unused elsewhere (verify — it's used widely, so likely keep). The empty state ("No remarks") and `AddRemarkForm` are unchanged.

## Testing

Vitest on `InternalRemarkCard` (self-contained, fast — no `SampleDetails` import):

- Renders the author, the `createdLabel`, and the sanitized body (e.g. `<b>` bold survives, a `<script>` is stripped, an `<a>` link renders).
- Renders the **"Internal — not shared with the customer"** caption.

## Files

- **New:** `src/components/senaite/InternalRemarkCard.tsx`, `src/components/senaite/__tests__/InternalRemarkCard.test.tsx`.
- **Edit:** `src/components/senaite/SampleDetails.tsx` (import + swap the inline card for `<InternalRemarkCard>`).

## Verification

`npx tsc --noEmit`, the new vitest, `npm run build`, prettier + eslint — all green. I'll also screenshot the rendered card (light + dark) so the amber shade can be eyeballed. PR held for sign-off.
