import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import type { ColumnDef, ColumnSizingState } from '@tanstack/react-table'
import { render, screen, fireEvent, act } from '@/test/test-utils'
import { DataTable } from '@/components/ui/data-table'

interface Row {
  id: number
  name: string
  n: number
}

// Seeded out of order so a sort visibly reorders them.
const rows: Row[] = [
  { id: 1, name: 'bravo', n: 2 },
  { id: 2, name: 'charlie', n: 3 },
  { id: 3, name: 'alpha', n: 1 },
]

const columns: ColumnDef<Row>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'n', header: 'N' },
]

const bodyNames = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map(r => r.querySelector('td')?.textContent)

const nameHeader = () => screen.getByRole('columnheader', { name: 'Name' })

function resizeHandle(th: HTMLElement): Element {
  const handle = th.querySelector('.cursor-col-resize')
  if (!handle) throw new Error('no resize handle')
  return handle
}

// Holds columnSizing in state and feeds it back, as the Tasks page does.
function ControlledSizing({
  onCommit,
}: {
  onCommit: (sizing: ColumnSizingState) => void
}) {
  const [sizing, setSizing] = useState<ColumnSizingState>({})
  return (
    <DataTable
      columns={columns}
      data={rows}
      columnSizing={sizing}
      onColumnSizingChange={setSizing}
      onColumnSizingCommit={onCommit}
    />
  )
}

describe('DataTable', () => {
  it('uncontrolled: clicking a header still sorts rows', () => {
    render(<DataTable columns={columns} data={rows} />)
    expect(bodyNames()).toEqual(['bravo', 'charlie', 'alpha'])
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(bodyNames()).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('uncontrolled: dragging a resize handle still widens the column', () => {
    render(<DataTable columns={columns} data={rows} />)
    const th = nameHeader()
    expect(th).toHaveStyle({ width: '100px' })
    fireEvent.mouseDown(resizeHandle(th), { clientX: 100 })
    fireEvent.mouseMove(document, { clientX: 150 })
    fireEvent.mouseUp(document, { clientX: 150 })
    expect(th).toHaveStyle({ width: '150px' })
  })

  it('controlled sorting: header click reports, rows follow the prop', () => {
    const spy = vi.fn()
    const { rerender } = render(
      <DataTable
        columns={columns}
        data={rows}
        sorting={[]}
        onSortingChange={spy}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(spy).toHaveBeenCalledWith([{ id: 'name', desc: false }])
    // The prop did not change, so the rows did not either.
    expect(bodyNames()).toEqual(['bravo', 'charlie', 'alpha'])

    rerender(
      <DataTable
        columns={columns}
        data={rows}
        sorting={[{ id: 'name', desc: true }]}
        onSortingChange={spy}
      />
    )
    expect(bodyNames()[0]).toBe('charlie')
  })

  it('controlled sizing: header width comes from the prop', () => {
    render(
      <DataTable columns={columns} data={rows} columnSizing={{ name: 240 }} />
    )
    expect(nameHeader()).toHaveStyle({ width: '240px' })
  })

  it('a resize drag fires onColumnSizingCommit exactly once, with the final width', () => {
    const commit = vi.fn()
    render(<ControlledSizing onCommit={commit} />)
    const th = nameHeader()
    const startWidth = parseFloat(th.style.width)
    expect(startWidth).toBe(100)

    fireEvent.mouseDown(resizeHandle(th), { clientX: 100 })
    for (const x of [120, 140, 160]) {
      fireEvent.mouseMove(document, { clientX: x })
    }
    expect(commit).not.toHaveBeenCalled()
    fireEvent.mouseUp(document, { clientX: 160 })

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].name).toBe(startWidth + 60)
    expect(th).toHaveStyle({ width: `${startWidth + 60}px` })
  })

  it('commit gets the final width when moves land before a render', () => {
    // A slow render lets several mouse events queue up before React flushes.
    const commit = vi.fn()
    render(<ControlledSizing onCommit={commit} />)
    const th = nameHeader()
    const startWidth = parseFloat(th.style.width)

    fireEvent.mouseDown(resizeHandle(th), { clientX: 100 })
    act(() => {
      for (const x of [120, 140, 160]) {
        fireEvent.mouseMove(document, { clientX: x })
      }
      fireEvent.mouseUp(document, { clientX: 160 })
    })

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].name).toBe(startWidth + 60)
  })

  it('keyboard rows: Enter activates, and rows are not focusable without the flag', () => {
    const onRowClick = vi.fn()
    const { unmount } = render(
      <DataTable
        columns={columns}
        data={rows}
        onRowClick={onRowClick}
        keyboardRowActivation
      />
    )
    const row = screen.getByText('alpha').closest('tr')
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(row as HTMLElement, { key: 'Enter' })
    expect(onRowClick).toHaveBeenCalledWith(rows[2])
    fireEvent.keyDown(row as HTMLElement, { key: ' ' })
    expect(onRowClick).toHaveBeenCalledTimes(2)
    // Keys aimed at something inside the row are not the row's to handle.
    fireEvent.keyDown(screen.getByText('alpha'), { key: 'Enter' })
    expect(onRowClick).toHaveBeenCalledTimes(2)
    unmount()

    render(<DataTable columns={columns} data={rows} onRowClick={onRowClick} />)
    expect(screen.getByText('alpha').closest('tr')).not.toHaveAttribute(
      'tabindex'
    )
  })

  it('getRowClassName adds its class to the row', () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowClassName={r => (r.n === 2 ? 'row-marked' : undefined)}
      />
    )
    expect(screen.getByText('bravo').closest('tr')).toHaveClass('row-marked')
    expect(screen.getByText('alpha').closest('tr')).not.toHaveClass(
      'row-marked'
    )
  })
})
