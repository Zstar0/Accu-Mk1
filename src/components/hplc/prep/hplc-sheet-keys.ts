import type { KeyboardEvent } from 'react'

/**
 * The lab tool's keyboard model for a step table (tools-dennis
 * hplc-peptide-quant app.js, onSheetKey with verticalNext, gridNeighbour,
 * goTo and atEdge), as one delegated handler on the table. Tab and Enter go
 * down the column (then the next column from the top), Shift goes back up;
 * the arrow keys go to the box above, below, left or right. Only boxes that
 * can be typed in count for Tab and Enter. Columns in WALK_SKIP are left out
 * of the Tab and Enter walk; the arrow keys and the mouse still reach them.
 * The arrow keys (only) also stop on a row's buttons and links and on a Lead
 * radio, which Tab cannot reach while every box takes it for the walk.
 */
const WALK_SKIP = new Set(['diluent_ul'])

type Box = HTMLInputElement | HTMLSelectElement

const isBox = (el: unknown): el is Box =>
  el instanceof HTMLInputElement || el instanceof HTMLSelectElement

/** A box the walk stops in: not disabled, and not a radio, checkbox or
 *  hidden input (the source's typable; the Lead radio is an arrow stop only).
 *  The source's "not displayed" check is left out: the sheet never renders
 *  a hidden box, and jsdom has no layout. */
const typable = (el: unknown): el is Box =>
  isBox(el) &&
  !el.disabled &&
  !['radio', 'checkbox', 'hidden'].includes(el.type)

/** The table's boxes as a grid: grid[row][col], or null for a cell without
 *  a live box. */
function sheetGrid(table: HTMLTableElement): (Box | null)[][] {
  const body = table.tBodies[0]
  if (!body) return []
  return [...body.rows].map(r =>
    [...r.cells].map(cell => {
      const box = cell.querySelector('input, select')
      return typable(box) ? box : null
    })
  )
}

/** The next box down the columns (Tab, Enter), or back up (Shift). */
function verticalNext(t: Box, back: boolean): Box | null {
  const table = t.closest('table')
  if (!table) return null
  const grid = sheetGrid(table)
  const width = Math.max(0, ...grid.map(r => r.length))
  const order: Box[] = []
  for (let c = 0; c < width; c++)
    for (const row of grid) {
      const box = row[c]
      if (box && (box === t || !WALK_SKIP.has(box.dataset.field ?? '')))
        order.push(box)
    }
  const at = order.indexOf(t)
  if (at < 0) return null
  return order[at + (back ? -1 : 1)] ?? null
}

const STEP = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
} as const
type Dir = keyof typeof STEP

/** What the arrow keys stop on besides the boxes (ours, not the source's):
 *  a live button or link (Promote, the prep link, "usual"), a focusable
 *  wrapper (a disabled Promote's, which carries its reasons), a Lead radio. */
const isRadio = (el: unknown): boolean =>
  el instanceof HTMLInputElement && el.type === 'radio'

const arrowStop = (el: Element): el is HTMLElement =>
  typable(el) ||
  (el instanceof HTMLInputElement && isRadio(el) && !el.disabled) ||
  (el instanceof HTMLButtonElement && !el.disabled) ||
  (el instanceof HTMLAnchorElement && el.href !== '') ||
  (el instanceof HTMLElement &&
    !isBox(el) &&
    !(el instanceof HTMLButtonElement) &&
    el.getAttribute('tabindex') === '0')

/** The table's arrow stops as a grid: grid[row][col] is the cell's stops in
 *  page order (a Lead cell can hold its radio and "usual"). */
function arrowGrid(table: HTMLTableElement): HTMLElement[][][] {
  const body = table.tBodies[0]
  if (!body) return []
  return [...body.rows].map(r =>
    [...r.cells].map(cell =>
      [
        ...cell.querySelectorAll('input, select, button, a, [tabindex="0"]'),
      ].filter(arrowStop)
    )
  )
}

/** The nearest stop up, down, left or right of this one (skipping gaps):
 *  Left and Right go through the row's stops in order, Up and Down keep to
 *  the column. */
function gridNeighbour(t: HTMLElement, dir: Dir): HTMLElement | null {
  const table = t.closest('table')
  if (!table) return null
  const grid = arrowGrid(table)
  const r0 = grid.findIndex(row => row.some(cell => cell.includes(t)))
  if (r0 < 0) return null
  const row0 = grid[r0] ?? []
  if (dir === 'left' || dir === 'right') {
    const flat = row0.flat()
    return flat[flat.indexOf(t) + (dir === 'left' ? -1 : 1)] ?? null
  }
  const c0 = row0.findIndex(cell => cell.includes(t))
  const i0 = (row0[c0] ?? []).indexOf(t)
  const dr = STEP[dir][0]
  for (let r = r0 + dr; r >= 0 && r < grid.length; r += dr) {
    const cell = grid[r]?.[c0] ?? []
    if (cell.length) return cell[Math.min(i0, cell.length - 1)] ?? null
  }
  return null
}

/** Focus a stop as a Tab into it does: a box's text selected, and marked as
 *  arrived by keyboard so Left and Right move on at once. */
function goTo(box: HTMLElement) {
  box.focus()
  if (box instanceof HTMLInputElement && box.type === 'text') box.select()
  box.dataset.navFresh = '1'
  // a click puts the caret where the tech wants it: Left and Right move it
  // again (the source clears the flag on mousedown); one listener per box
  box.addEventListener('mousedown', clearFresh)
}

function clearFresh(e: Event) {
  if (e.currentTarget instanceof HTMLElement)
    e.currentTarget.dataset.navFresh = ''
}

/** Left and Right stay inside the text while editing it; they move on when
 *  the caret is at that edge, all the text is selected, or the box was just
 *  arrived in by keyboard. */
function atEdge(t: Box, dir: 'left' | 'right'): boolean {
  if (t instanceof HTMLSelectElement) return true
  if (t.dataset.navFresh === '1' || t.value === '') return true
  const s = t.selectionStart
  const e = t.selectionEnd
  if (s === null || e === null) return false
  if (s === 0 && e === t.value.length) return true
  return dir === 'left'
    ? s === 0 && e === 0
    : s === t.value.length && e === t.value.length
}

const ARROWS: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

export function onSheetKey(e: KeyboardEvent<HTMLTableElement>) {
  const t = e.target
  // a key in the Promote dialog bubbles here through React's tree, though
  // the dialog is not in the table
  if (!(t instanceof HTMLElement) || !e.currentTarget.contains(t)) return
  if (e.altKey || e.ctrlKey || e.metaKey) return // Alt+Down still opens a select
  if (!isBox(t) || isRadio(t)) {
    // a button, a link or a Lead radio: the arrow keys move on, every other
    // key is the browser's (Enter and Space press a button, Space picks a
    // radio). On a radio the browser's own arrows would change the lead
    // unseen, so all four are taken.
    const dir = ARROWS[e.key]
    if (!dir || !arrowStop(t)) return
    e.preventDefault()
    const next = gridNeighbour(t, dir)
    if (next) goTo(next)
    return
  }
  if (t instanceof HTMLInputElement && t.type === 'checkbox') return
  if (e.key === 'Tab' || e.key === 'Enter') {
    const next = verticalNext(t, e.shiftKey)
    if (next) {
      e.preventDefault()
      goTo(next)
    } else if (e.key === 'Enter') e.preventDefault() // the last box: Enter stays put
    return
  }
  const dir = ARROWS[e.key]
  if (dir) {
    // Up and Down always move: in a number box they would add or take 1
    // from a weight, in a select they would change the Form or Instrument
    // unseen.
    if (
      (dir === 'left' || dir === 'right') &&
      (e.shiftKey || !atEdge(t, dir))
    ) {
      t.dataset.navFresh = '' // Shift+Left and Shift+Right select text
      return
    }
    e.preventDefault()
    const next = gridNeighbour(t, dir)
    if (next) goTo(next)
    return
  }
  // any other key edits the box: from here Left and Right move the caret
  if (
    e.key.length === 1 ||
    ['Backspace', 'Delete', 'Home', 'End'].includes(e.key)
  )
    t.dataset.navFresh = ''
}
