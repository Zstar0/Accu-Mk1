import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_COLLAPSED_KANBAN_COLS,
  loadOrderFilters,
} from '@/components/OrderStatusPage'

// Hidden-by-default kanban columns (v1.11.4, Handler request): Sample Due and
// Published start collapsed. Pins the three loadOrderFilters branches: fresh
// defaults, one-time migration of pre-existing saved filters (no marker), and
// marker-present saved filters where the user's own expand choice wins.

const LS_KEY = 'order-status-filters'

beforeEach(() => {
  localStorage.clear()
})

describe('kanban hidden-by-default columns', () => {
  it('fresh state starts with Sample Due + Published collapsed', () => {
    const f = loadOrderFilters()
    expect(f.collapsedKanbanCols).toEqual(
      expect.arrayContaining(['sample_due', 'published'])
    )
    expect(f.kanbanColDefaultsV2).toBe(true)
    expect(DEFAULT_COLLAPSED_KANBAN_COLS).toEqual(['sample_due', 'published'])
  })

  it('legacy saved filters (no marker) get the defaults unioned in once', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ collapsedKanbanCols: ['verified'], activeStates: [] })
    )
    const f = loadOrderFilters()
    expect(f.collapsedKanbanCols.sort()).toEqual(
      ['published', 'sample_due', 'verified'].sort()
    )
    expect(f.kanbanColDefaultsV2).toBe(true)
  })

  it("marker-present saved filters keep the user's expand choice", () => {
    // User un-hid Published after the migration — must NOT be re-hidden.
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        collapsedKanbanCols: ['sample_due'],
        kanbanColDefaultsV2: true,
        activeStates: [],
      })
    )
    const f = loadOrderFilters()
    expect(f.collapsedKanbanCols).toEqual(['sample_due'])
  })
})
