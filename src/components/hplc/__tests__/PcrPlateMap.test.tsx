import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  layoutPlates,
  type PcrLayout,
  type PcrPins,
  type PcrSample,
} from '@/lib/pcr-plate'
import { PcrPlateMap } from '@/components/hplc/PcrPlateMap'

const sample = (n: number, frozen: PcrSample['frozen'] = null): PcrSample => ({
  itemId: n,
  id: `P-000${n}-S01`,
  order: '9001',
  identity: 'BPC-157',
  received: null,
  priority: 'default',
  assessment: { due: null, urgency: '', flagged: false, reasons: [] },
  frozen,
})

function renderMap(L: PcrLayout, onPins?: (p: PcrPins) => void) {
  const plate = L.plates[0]
  if (!plate) throw new Error('no plate')
  render(
    <PcrPlateMap
      plate={plate}
      plateCount={1}
      outlineGroups
      frozenCount={L.frozenCount}
      isCompleted={false}
      onUnfreeze={vi.fn()}
      layout={L}
      onPins={onPins}
    />
  )
}

/** The cell of a well by its grid address, e.g. cell('B', 5). */
function cell(row: string, col: number): HTMLElement {
  const tr = screen.getAllByRole('row')['ABCDEFGH'.indexOf(row) + 1]
  const td = tr?.querySelectorAll('td')[col - 1]
  if (!td) throw new Error(`no cell ${row}${col}`)
  return td as HTMLElement
}

// Rearrange (Dennis, 2026-10-26; in Mk1 2026-11-20).
describe('PcrPlateMap Rearrange', () => {
  const two = () => layoutPlates([sample(1), sample(2)], { kind: 'mid' })

  it('select a well, click an empty one: it moves and the rest are held', () => {
    const onPins = vi.fn()
    renderMap(two(), onPins)
    fireEvent.click(screen.getByRole('button', { name: /Rearrange/ }))
    fireEvent.click(cell('B', 6))
    fireEvent.click(cell('B', 5))
    expect(onPins).toHaveBeenCalledWith({
      samples: {
        1: { plate: 1, pos: 0, held: true },
        2: { plate: 1, pos: 9 },
      },
      npc: { 1: { pos: 2, held: true } },
    })
  })

  it('a click on the fungal well selects the same sample', () => {
    const onPins = vi.fn()
    renderMap(two(), onPins)
    fireEvent.click(screen.getByRole('button', { name: /Rearrange/ }))
    fireEvent.click(cell('A', 7))
    fireEvent.click(cell('A', 12))
    expect(onPins.mock.calls[0]?.[0].samples[1]).toEqual({ plate: 1, pos: 40 })
  })

  it('a taken well moves nothing and says which well', () => {
    const onPins = vi.fn()
    renderMap(two(), onPins)
    fireEvent.click(screen.getByRole('button', { name: /Rearrange/ }))
    fireEvent.click(cell('A', 6))
    fireEvent.dragStart(cell('A', 6), {
      dataTransfer: { setData: vi.fn(), effectAllowed: '' },
    })
    fireEvent.drop(cell('B', 6))
    expect(onPins).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'B6 is taken by P-0002-S01; nothing moved.'
    )
  })

  it('is off on a printed plate and absent where the plate is read-only', () => {
    const locked = layoutPlates([sample(1, { plate: 1, pos: 0 })], {
      kind: 'mid',
    })
    renderMap(locked, vi.fn())
    expect(screen.getByRole('button', { name: /Rearrange/ })).toBeDisabled()
  })

  it('offers Fill gaps and Reset layout once something was placed by hand', () => {
    const onPins = vi.fn()
    const L = layoutPlates([sample(1), sample(2)], {
      kind: 'mid',
      pins: { samples: { 2: { plate: 1, pos: 9 } }, npc: {} },
    })
    renderMap(L, onPins)
    fireEvent.click(screen.getByRole('button', { name: 'Fill gaps' }))
    expect(onPins).toHaveBeenLastCalledWith({
      samples: {
        1: { plate: 1, pos: 0, held: true },
        2: { plate: 1, pos: 1 },
      },
      npc: {},
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }))
    expect(onPins).toHaveBeenLastCalledWith({ samples: {}, npc: {} })
  })
})
