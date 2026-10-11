import type { ReactNode } from 'react'
import type { WorksheetItemPatch, WorksheetListItem } from '@/lib/api'
import type { EndoCtx } from '@/lib/endo-prep-2ml'
import type { EndoCartridgeOption, EndoRow } from '@/lib/endo-worksheet-2ml'

/*
 * Dennis's numbered boxes, from his screen stylesheet (endotoxin.html at
 * 5ef2a62), mapped to Mk1 tokens so dark mode follows the app theme:
 *   .sheet         border:1px solid var(--line); border-radius:5px;
 *                  box-shadow:var(--shadow); overflow:hidden;
 *                  margin:0 24px 24px  (24px sides: the page column's px-6;
 *                  24px between boxes: EndoWorksheetView's children wrapper)
 *   .results-head  padding:12px 16px 10px; border-bottom:1px solid var(--line)
 *   .legend-title  padding:0 24px 8px; margin:0 0 3px; font-size:9.5px;
 *                  font-weight:600; letter-spacing:.13em; uppercase; muted
 *   .results-sub   font-size:12px; muted
 * Spec 6.8's "10pt / 14pt / 4px 14px 14px / 12px" are his print sheet and
 * his intake panel, not these boxes; the side-by-side check (Task 20) rules.
 */

/** A box's numbered title and caption ("1 · Sample intake"). */
export function EndoBoxHead({
  n,
  title,
  sub,
  children,
}: {
  n: number
  title: string
  sub?: ReactNode
  /** Extra header content, e.g. Box 3's reader drop zone (Task 16). */
  children?: ReactNode
}) {
  return (
    <div className="border-b px-4 pb-2.5 pt-3">
      <p className="mb-[3px] px-6 pb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        {n} · {title}
      </p>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      {children}
    </div>
  )
}

/** A numbered box (Boxes 2 and 3). Box 1 is EndoWorksheetTable with `heading`. */
export function EndoBox({
  n,
  title,
  sub,
  actions,
  children,
}: {
  n: number
  title: string
  sub?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-[5px] border bg-card shadow-sm"
    >
      <EndoBoxHead n={n} title={title} sub={sub}>
        {actions}
      </EndoBoxHead>
      {children}
    </section>
  )
}

/** What the page hands Box 2 (EndoSampleDilutionBox, Task 14) and Box 3
 *  (EndoResultsBox, Task 15). */
export interface EndoBoxProps {
  worksheet: WorksheetListItem
  /** The endo rows in Box 1 order: `row.n` is the Box 1 row number,
   *  `row.cartridge` the row's resolved cartridge, whose id goes with every
   *  reading saved on a row without its own. */
  rows: EndoRow[]
  ctx: EndoCtx
  /** The allowed cartridges, least sensitive first. */
  cartridges: EndoCartridgeOption[]
  isCompleted: boolean
  /** Saves one row's fields. The page's resolves to the server's refusal
   *  text (null once saved) so a box can show it on the row; it never
   *  rejects. */
  onUpdateItem: (
    itemId: number,
    data: WorksheetItemPatch
  ) => Promise<string | null> | undefined
}
