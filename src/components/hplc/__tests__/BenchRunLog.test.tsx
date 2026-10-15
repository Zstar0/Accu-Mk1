import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { WorksheetBenchLogEntry } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getWorksheetBenchLog: vi.fn(),
}))

import { getWorksheetBenchLog } from '@/lib/api'
import { BenchRunLog } from '@/components/hplc/BenchRunLog'

const run = (id: number): WorksheetBenchLogEntry => ({
  id,
  title: `Endo run ${id}`,
  status: 'open',
  created_at: null,
  completed_at: null,
  assigned_analyst: null,
  item_count: 2,
  made_count: 0,
  ran_count: 0,
})

function renderLog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BenchRunLog
        kind="endo"
        label="Endotoxin"
        tickLabels={['Made', 'MCS']}
        activeId={41}
        users={[]}
        onSelect={vi.fn()}
      />
    </QueryClientProvider>
  )
}

const hide = () => screen.getByRole('button', { name: 'Hide the run log' })
const show = () => screen.getByRole('button', { name: 'Show the run log' })

describe('BenchRunLog collapse', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(getWorksheetBenchLog).mockResolvedValue([run(41), run(42)])
  })
  afterEach(() => vi.restoreAllMocks())

  it('starts expanded, and collapsing swaps the list for a strip with the count', async () => {
    renderLog()
    expect(await screen.findByText('Endo run 41')).toBeInTheDocument()
    expect(hide()).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(hide())

    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText('Endo run 41')).toBeNull()
    expect(show()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Run log')).toBeInTheDocument()
    expect(screen.getByTitle('2 worksheets')).toHaveTextContent('2')

    fireEvent.click(show())
    expect(screen.getByText('Endo run 41')).toBeInTheDocument()
  })

  it('remembers the choice across a remount', async () => {
    const first = renderLog()
    await screen.findByText('Endo run 41')
    fireEvent.click(hide())
    first.unmount()

    renderLog()
    expect(show()).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('works with storage blocked: opens expanded and still toggles', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderLog()
    expect(await screen.findByText('Endo run 41')).toBeInTheDocument()
    expect(() => fireEvent.click(hide())).not.toThrow()
    expect(show()).toBeInTheDocument()
  })
})
