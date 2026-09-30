import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BoardToolDrawer } from '@/components/boards/BoardToolDrawer'

const LABELS = [
  'Frame',
  'Text',
  'Note',
  'Link',
  'Person',
  'Document',
  'Sample',
  'Order',
  'Worksheet',
]

describe('BoardToolDrawer', () => {
  let store: Record<string, string>
  beforeEach(() => {
    store = {}
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      k => store[k] ?? null
    )
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => {
      store[k] = String(v)
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('renders nine chips for editors', () => {
    render(<BoardToolDrawer canEdit onPlace={() => undefined} />)
    for (const l of LABELS)
      expect(screen.getByRole('button', { name: l })).toBeInTheDocument()
  })

  it('renders nothing for viewers', () => {
    const { container } = render(
      <BoardToolDrawer canEdit={false} onPlace={() => undefined} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('hovering a chip shows its label and the placement hint', async () => {
    render(<BoardToolDrawer canEdit onPlace={() => undefined} />)
    await userEvent
      .setup()
      .hover(screen.getByRole('button', { name: 'Worksheet' }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Worksheet')
    expect(tip).toHaveTextContent(/Drag onto the board/)
  })

  it('the chevron keeps focus across the toggle', () => {
    render(<BoardToolDrawer canEdit onPlace={() => undefined} />)
    const chevron = screen.getByRole('button', { name: 'Hide tools' })
    chevron.focus()
    fireEvent.click(chevron)
    expect(screen.getByRole('button', { name: 'Show tools' })).toHaveFocus()
  })

  it('a chip drag carries its kind in the dataTransfer', () => {
    render(<BoardToolDrawer canEdit onPlace={() => undefined} />)
    const setData = vi.fn()
    const dataTransfer = { setData, effectAllowed: 'all' }
    fireEvent.dragStart(screen.getByRole('button', { name: 'Sample' }), {
      dataTransfer,
    })
    expect(setData).toHaveBeenCalledWith('application/x-board-kind', 'sample')
    expect(dataTransfer.effectAllowed).toBe('move')
  })

  it('clicking a chip places its kind', () => {
    const onPlace = vi.fn()
    render(<BoardToolDrawer canEdit onPlace={onPlace} />)
    fireEvent.click(screen.getByRole('button', { name: 'Note' }))
    expect(onPlace).toHaveBeenCalledWith('note')
  })

  it('the chevron collapses the strip and remembers it', () => {
    render(<BoardToolDrawer canEdit onPlace={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide tools' }))
    expect(screen.queryByRole('button', { name: 'Text' })).toBeNull()
    expect(store['boards:drawer:collapsed']).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Show tools' }))
    expect(screen.getByRole('button', { name: 'Text' })).toBeInTheDocument()
    expect(store['boards:drawer:collapsed']).toBe('0')
  })

  it('starts collapsed when that was remembered', () => {
    store['boards:drawer:collapsed'] = '1'
    render(<BoardToolDrawer canEdit onPlace={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Show tools' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Frame' })).toBeNull()
  })
})
