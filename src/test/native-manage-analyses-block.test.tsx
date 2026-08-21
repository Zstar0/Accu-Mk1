import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SenaiteAnalysis } from '@/lib/api'

const api = vi.hoisted(() => ({
  listNativeParentAnalysesShaped: vi.fn(),
  listNativeProfilesForParent: vi.fn(),
  addNativeProfileToParent: vi.fn(),
  removeNativeParentAnalysis: vi.fn(),
  resyncParentFromOrder: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, ...api }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { NativeManageAnalysesBlock } from '@/components/senaite/NativeManageAnalysesBlock'

// senaite-shape rows: id travels in uid ("mk1:<id>"); provenance is the new optional field
const ordered = (id: number, keyword: string, title: string): SenaiteAnalysis =>
  ({ uid: `mk1:${id}`, keyword, title, review_state: 'unassigned', provenance: 'ordered' } as unknown as SenaiteAnalysis)
const canonical = (id: number, keyword: string, title: string): SenaiteAnalysis =>
  ({ uid: `mk1:${id}`, keyword, title, review_state: 'verified', provenance: 'canonical' } as unknown as SenaiteAnalysis)

function renderBlock(props: Partial<React.ComponentProps<typeof NativeManageAnalysesBlock>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChanged = vi.fn()
  const utils = render(
    <QueryClientProvider client={qc}>
      <NativeManageAnalysesBlock sampleId="PB-0156" isAdmin={false} onChanged={onChanged} {...props} />
    </QueryClientProvider>
  )
  return { ...utils, onChanged }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listNativeParentAnalysesShaped.mockResolvedValue([ordered(31, 'MOISTURE-KF', 'Residual Moisture'), canonical(32, 'LEAD-PPM', 'Lead')])
  api.listNativeProfilesForParent.mockResolvedValue([
    { id: 7, key: 'moisture', name: 'Residual Moisture', fulfillment_role: 'kf', on_sample: 'full', host_vials: ['PB-0156-S04'],
      members: [{ service_id: 233, keyword: 'MOISTURE-KF', title: 'Residual Moisture' }] },
    { id: 6, key: 'heavy_metals', name: 'Heavy Metals', fulfillment_role: 'hm', on_sample: 'none', host_vials: [],
      members: [{ service_id: 229, keyword: 'LEAD-PPM', title: 'Lead' }, { service_id: 230, keyword: 'ARSENIC-PPM', title: 'Arsenic' }] },
  ])
})

describe('NativeManageAnalysesBlock', () => {
  it('lists native rows; trash enabled only on ordered rows', async () => {
    renderBlock()
    expect(await screen.findByText('MOISTURE-KF')).toBeInTheDocument()
    const rows = screen.getAllByTestId('native-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole('button', { name: /remove/i })).toBeEnabled()
    expect(within(rows[1]!).getByRole('button', { name: /remove/i })).toBeDisabled()
    expect(within(rows[0]!).getByText('kf · PB-0156-S04')).toBeInTheDocument()
  })

  it('hides fully-present profiles from the picker and shows the no-host hint', async () => {
    renderBlock()
    await screen.findByText('MOISTURE-KF')
    const picker = screen.getByTestId('native-profile-picker')
    expect(within(picker).queryByText('Residual Moisture')).toBeNull()
    expect(within(picker).getByText('Heavy Metals')).toBeInTheDocument()
    expect(within(picker).getByText(/no hm vial yet — placeholder only/)).toBeInTheDocument()
  })

  it('adds a profile and calls onChanged', async () => {
    api.addNativeProfileToParent.mockResolvedValue({ profile_key: 'heavy_metals', profile_name: 'Heavy Metals',
      placeholders_created: 2, placeholders_existing: 0, hosts: [], no_host_vial: true })
    const { onChanged } = renderBlock()
    await screen.findByText('MOISTURE-KF')
    await userEvent.click(within(screen.getByTestId('native-profile-picker')).getByRole('button', { name: /add heavy metals/i }))
    await waitFor(() => expect(api.addNativeProfileToParent).toHaveBeenCalledWith('PB-0156', 6))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('removes an ordered row straight away when no confirm is needed', async () => {
    api.removeNativeParentAnalysis.mockResolvedValue({ analysis_id: 31, keyword: 'MOISTURE-KF', analysis_service_id: 233,
      vial_rows_deleted: 1, vial_rows_rejected: 0, edges_superseded: 1 })
    const { onChanged } = renderBlock()
    await screen.findByText('MOISTURE-KF')
    await userEvent.click(within(screen.getAllByTestId('native-row')[0]!).getByRole('button', { name: /remove/i }))
    await waitFor(() => expect(api.removeNativeParentAnalysis).toHaveBeenCalledWith('PB-0156', 31, false))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('opens the confirm modal on 412 and confirms with confirm=true', async () => {
    const { NativeRemovalNeedsConfirm } = await import('@/lib/api')
    api.removeNativeParentAnalysis
      .mockRejectedValueOnce(new NativeRemovalNeedsConfirm({ pristine: [], blocked: [],
        worked_unverified: [{ sample_id: 'PB-0156-S04', analysis_id: 40, review_state: 'assigned', keyword: 'MOISTURE-KF' }] } as never))
      .mockResolvedValueOnce({ analysis_id: 31, keyword: 'MOISTURE-KF', analysis_service_id: 233,
        vial_rows_deleted: 0, vial_rows_rejected: 1, edges_superseded: 1 })
    renderBlock()
    await screen.findByText('MOISTURE-KF')
    await userEvent.click(within(screen.getAllByTestId('native-row')[0]!).getByRole('button', { name: /remove/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /remove|retract/i }))
    await waitFor(() => expect(api.removeNativeParentAnalysis).toHaveBeenLastCalledWith('PB-0156', 31, true))
  })

  it('shows Re-sync only for admins and reports counts', async () => {
    api.resyncParentFromOrder.mockResolvedValue({ placeholders_created: 1, edges_created: 1, vial_rows_created: 1 })
    const { rerender } = renderBlock({ isAdmin: false })
    await screen.findByText('MOISTURE-KF')
    expect(screen.queryByRole('button', { name: /re-sync from order/i })).toBeNull()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(<QueryClientProvider client={qc}><NativeManageAnalysesBlock sampleId="PB-0156" isAdmin onChanged={() => {}} /></QueryClientProvider>)
    await userEvent.click(await screen.findByRole('button', { name: /re-sync from order/i }))
    await waitFor(() => expect(api.resyncParentFromOrder).toHaveBeenCalledWith('PB-0156'))
  })

  it('renders nothing when there are no native rows and no native profiles', async () => {
    api.listNativeParentAnalysesShaped.mockResolvedValue([])
    api.listNativeProfilesForParent.mockResolvedValue([])
    const { container } = renderBlock()
    await waitFor(() => expect(api.listNativeProfilesForParent).toHaveBeenCalled())
    // Both queries resolve asynchronously (mocked promises + React Query's own
    // microtask hops); `toHaveBeenCalled()` only proves the fetch started, not
    // that the resulting re-render has landed yet, so the null-render check
    // needs its own wait rather than a synchronous assertion right after.
    await waitFor(() => expect(container.querySelector('[data-testid="native-manage-block"]')).toBeNull())
  })
})
