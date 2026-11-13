import type { KeyboardEvent } from 'react'

/**
 * The lab tool's keyboard model for a step table (tools-dennis
 * hplc-peptide-quant app.js, onSheetKey with verticalNext, gridNeighbour,
 * goTo and atEdge), as one delegated handler on the table. Tab and Enter go
 * down the column (then the next column from the top), Shift goes back up;
 * the arrow keys go to the box above, below, left or right. Only boxes that
 * can be typed in count. Columns in WALK_SKIP are left out of the Tab and
 * Enter walk; the arrow keys and the mouse still reach them.
 */
const WALK_SKIP = new Set(['diluent_ul'])

type Box = HTMLInputElement | HTMLSelectElement

const isBox = (el: unknown): el is Box =>
  el instanceof HTMLInputElement || el instanceof HTMLSelectElement

/** The table's boxes as a grid: grid[row][col], or null for a cell without
 *  a live box. */
function sheetGrid(table: HTMLTableElement): (Box | null)[][] {
  const body = table.tBodies[0]
  if (!body) return []
  return [...body.rows].map(r =>
    [...r.cells].map(cell => {
      const box = cell.querySelector('input, select')
      return isBox(box) && !box.disabled ? box : null
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

/** The nearest box up, down, left or right of this one (skipping gaps). */
function gridNeighbour(t: Box, dir: Dir): Box | null {
  const table = t.closest('table')
  if (!table) return null
  const grid = sheetGrid(table)
  const r0 = grid.findIndex(row => row.includes(t))
  if (r0 < 0) return null
  const c0 = (grid[r0] ?? []).indexOf(t)
  const [dr, dc] = STEP[dir]
  for (
    let r = r0 + dr, c = c0 + dc;
    r >= 0 && r < grid.length && c >= 0 && c < (grid[r] ?? []).length;
    r += dr, c += dc
  ) {
    const box = grid[r]?.[c]
    if (box) return box
  }
  return null
}

/** Focus a box as a Tab into it does: its text selected, and marked as
 *  arrived by keyboard so Left and Right move on at once. */
function goTo(box: Box) {
  box.focus()
  if (box instanceof HTMLInputElement) box.select()
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
  if (!isBox(t)) return
  if (e.altKey || e.ctrlKey || e.metaKey) return // Alt+Down still opens a select
  if (t.type === 'radio' || t.type === 'checkbox') return
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
