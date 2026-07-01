import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// dnd-kit's draggable/droppable need a DOM measuring layer that jsdom lacks;
// stub the primitives to inert pass-throughs so the boxing logic is what's
// under test, not the drag library.
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {} }),
}))

// usePrintLabel pulls in createRoot/print plumbing; we only care about the
// boxing flow, so stub it to a no-op that still returns the expected shape.
vi.mock('@/components/samples/usePrintLabel', () => ({
  usePrintLabel: () => ({ printNode: () => {} }),
}))

import {
  listOrderBoxes, createBox, assignVialsToBox, deleteBox, listSubSamples,
  printBox, type LimsBox, type SubSample,
} from '@/lib/api'

vi.mock('@/lib/api', () => ({
  listOrderBoxes: vi.fn(),
  createBox: vi.fn(),
  assignVialsToBox: vi.fn(),
  deleteBox: vi.fn(),
  printBox: vi.fn(),
  listSubSamples: vi.fn(),
}))

import { BoxStep } from '@/components/intake/ReceiveWizard/BoxStep'

const mockListOrderBoxes = vi.mocked(listOrderBoxes)
const mockCreateBox = vi.mocked(createBox)
const mockAssignVialsToBox = vi.mocked(assignVialsToBox)
const mockDeleteBox = vi.mocked(deleteBox)
const mockListSubSamples = vi.mocked(listSubSamples)
const mockPrintBox = vi.mocked(printBox)

type Vial = SubSample & { box_id?: number | null }

const vial = (sampleId: string, role: 'hplc' | 'endo' | 'ster', boxId: number | null = null): Vial =>
  ({
    id: Number(sampleId.replace(/\D/g, '')) || 0,
    sample_id: sampleId,
    parent_sample_id: 'P-1',
    vial_sequence: 1,
    received_at: '2026-06-30T00:00:00Z',
    received_by_user_id: null,
    photo_external_uid: null,
    remarks: null,
    assignment_role: role,
    box_id: boxId,
  }) as unknown as Vial

const ORDER = 'WP-1042'

/**
 * A controllable backend: `boxesState` is mutated by createBox/deleteBox so a
 * refetch reflects reality (exercises auto-create idempotency for real).
 */
function setupBackend(vials: Vial[]) {
  const boxesState: LimsBox[] = []
  let nextId = 1
  let nextNumber = 1

  mockListSubSamples.mockResolvedValue({
    parent: { sub_sample_count: vials.length },
    sub_samples: vials,
  } as never)

  mockListOrderBoxes.mockImplementation(async () => boxesState.map(b => ({ ...b })))

  mockCreateBox.mockImplementation(async (orderKey: string, role) => {
    const box: LimsBox = {
      id: nextId++,
      order_key: orderKey,
      box_number: nextNumber++,
      role,
      label_code: `${orderKey}-${nextNumber - 1}`,
      vial_count: 0,
      printed_at: null,
    }
    boxesState.push(box)
    return { ...box }
  })

  mockDeleteBox.mockImplementation(async (boxId: number) => {
    const i = boxesState.findIndex(b => b.id === boxId)
    if (i >= 0) boxesState.splice(i, 1)
  })

  mockAssignVialsToBox.mockImplementation(async (boxId: number, ids: string[]) => {
    const box = boxesState.find(b => b.id === boxId)!
    box.vial_count += ids.length
    return { ...box }
  })

  mockPrintBox.mockResolvedValue({} as never)

  return { boxesState }
}

function renderBoxStep(sampleIds: string[] = ['P-1']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(
    <BoxStep orderKey={ORDER} orderLabel={ORDER} clientId="acme" sampleIds={sampleIds} />,
    { wrapper },
  )
  return { qc }
}

describe('BoxStep — capacity-driven boxing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('auto-creates exactly one box for an active role on mount, none for empty roles', async () => {
    setupBackend([vial('P-101', 'hplc'), vial('P-102', 'hplc')])
    renderBoxStep()

    await waitFor(() => expect(mockCreateBox).toHaveBeenCalledTimes(1))
    expect(mockCreateBox).toHaveBeenCalledWith(ORDER, 'hplc')
    // No box for roles with zero assigned vials.
    expect(mockCreateBox).not.toHaveBeenCalledWith(ORDER, 'endo')
    expect(mockCreateBox).not.toHaveBeenCalledWith(ORDER, 'ster')
  })

  it('does not re-create the first box after a refetch (idempotent)', async () => {
    setupBackend([vial('P-101', 'hplc')])
    const { qc } = renderBoxStep()

    await waitFor(() => expect(mockCreateBox).toHaveBeenCalledTimes(1))

    // Force the box list to refetch; the ref + roleBoxes>0 must prevent a re-create.
    await qc.invalidateQueries({ queryKey: ['order-boxes', ORDER] })
    await waitFor(() => expect(mockListOrderBoxes).toHaveBeenCalled())
    // Settle any pending re-render before asserting the count held.
    await new Promise(r => setTimeout(r, 20))
    expect(mockCreateBox).toHaveBeenCalledTimes(1)
  })

  it('creates a trailing box once when Auto-assign leaves a remainder', async () => {
    setupBackend([vial('P-101', 'hplc'), vial('P-102', 'hplc'), vial('P-103', 'hplc')])
    renderBoxStep()

    // First box auto-created on mount.
    await waitFor(() => expect(mockCreateBox).toHaveBeenCalledTimes(1))
    await screen.findByLabelText('Capacity')

    // Lower capacity to 2 so Auto-assign leaves a remainder of 1.
    fireEvent.change(screen.getByLabelText('Capacity'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Auto-assign' }))

    await waitFor(() => expect(mockAssignVialsToBox).toHaveBeenCalledTimes(1))
    // The trailing box: second createBox for hplc, fired exactly once.
    await waitFor(() => expect(mockCreateBox).toHaveBeenCalledTimes(2))
    expect(mockCreateBox.mock.calls.every(c => c[1] === 'hplc')).toBe(true)
  })

  it('Auto-assign assigns at most `capacity` vials', async () => {
    setupBackend([vial('P-101', 'hplc'), vial('P-102', 'hplc'), vial('P-103', 'hplc')])
    renderBoxStep()

    await waitFor(() => expect(mockCreateBox).toHaveBeenCalledTimes(1))
    await screen.findByLabelText('Capacity')

    fireEvent.change(screen.getByLabelText('Capacity'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Auto-assign' }))

    await waitFor(() => expect(mockAssignVialsToBox).toHaveBeenCalledTimes(1))
    const ids = mockAssignVialsToBox.mock.calls[0]![1]
    expect(ids.length).toBeLessThanOrEqual(2)
    expect(ids).toEqual(['P-101', 'P-102'])
  })

  it('renders a box\'s assigned vials as chips inside the box card', async () => {
    // A pre-existing box (id 7) with one vial already assigned to it. Because
    // the vial is boxed, no first-box auto-create fires — the chip must show
    // inside the box card, and the Unboxed panel reports everything boxed.
    const { boxesState } = setupBackend([vial('P-101', 'hplc', 7)])
    boxesState.push({
      id: 7, order_key: ORDER, box_number: 1, role: 'hplc',
      label_code: `${ORDER}-1`, vial_count: 1, printed_at: null,
    })
    renderBoxStep()

    expect(await screen.findByText('P-101')).toBeInTheDocument()
    expect(screen.getByText('All vials boxed.')).toBeInTheDocument()
    expect(mockCreateBox).not.toHaveBeenCalled()
  })

  it('remove on an empty box calls deleteBox with the box id', async () => {
    setupBackend([vial('P-101', 'hplc')])
    renderBoxStep()

    // Auto-created box has vial_count 0 → the remove control shows.
    const removeBtn = await screen.findByLabelText('Remove box')
    fireEvent.click(removeBtn)

    await waitFor(() => expect(mockDeleteBox).toHaveBeenCalledTimes(1))
    expect(mockDeleteBox).toHaveBeenCalledWith(1)
  })
})
