import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// Captures the DndContext handlers so a test can drive onDragEnd directly —
// jsdom can't produce real pointer-drag geometry, so we invoke the branch.
const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((e: unknown) => void) }))

// dnd-kit's draggable/droppable need a DOM measuring layer that jsdom lacks;
// stub the primitives to inert pass-throughs so the boxing logic is what's
// under test, not the drag library.
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd: (e: unknown) => void }) => {
    dnd.onDragEnd = onDragEnd
    return <div>{children}</div>
  },
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PointerSensor: class {},
  KeyboardSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {} }),
}))

// usePrintLabel pulls in createRoot/print plumbing; we only care about the
// boxing flow, so stub it to a spy that still returns the expected shape.
const printing = vi.hoisted(() => ({ printNode: vi.fn() }))
vi.mock('@/components/samples/usePrintLabel', () => ({
  usePrintLabel: () => ({ printNode: printing.printNode }),
}))

import {
  listOrderBoxes, createBox, assignVialsToBox, unassignVialsFromBox, deleteBox, listSubSamples,
  printBox, type LimsBox, type SubSample,
} from '@/lib/api'

vi.mock('@/lib/api', () => ({
  listOrderBoxes: vi.fn(),
  createBox: vi.fn(),
  assignVialsToBox: vi.fn(),
  unassignVialsFromBox: vi.fn(),
  deleteBox: vi.fn(),
  printBox: vi.fn(),
  listSubSamples: vi.fn(),
}))

import { BoxStep, boxKeyboardCoordinates } from '@/components/intake/ReceiveWizard/BoxStep'

const mockListOrderBoxes = vi.mocked(listOrderBoxes)
const mockCreateBox = vi.mocked(createBox)
const mockAssignVialsToBox = vi.mocked(assignVialsToBox)
const mockUnassignVialsFromBox = vi.mocked(unassignVialsFromBox)
const mockDeleteBox = vi.mocked(deleteBox)
const mockListSubSamples = vi.mocked(listSubSamples)
const mockPrintBox = vi.mocked(printBox)

type Vial = SubSample & { box_id?: number | null }

const vial = (sampleId: string, role: 'hplc' | 'endo' | 'ster' | 'xtra', boxId: number | null = null): Vial =>
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
      label_code: `BOX-${orderKey.replace(/^WP-/i, '')}-${nextNumber - 1}`,
      vial_count: 0,
      printed_at: null,
      created_at: null,
      stored_at: null,
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
  mockUnassignVialsFromBox.mockResolvedValue(undefined)

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

  it('shows an unboxed xtra vial in the Unboxed panel under Extras (no longer filtered out)', async () => {
    setupBackend([vial('P-201', 'xtra')])
    renderBoxStep()

    // The chip is in the Unboxed panel (never assigned), grouped under an
    // "Extras" heading that renders twice: the xtra role column + the panel group.
    expect(await screen.findByText('P-201')).toBeInTheDocument()
    expect(screen.getAllByText('Extras').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('All vials boxed.')).not.toBeInTheDocument()
    // xtra is boxable now: the first-box auto-create fires for it too.
    await waitFor(() => expect(mockCreateBox).toHaveBeenCalledWith(ORDER, 'xtra'))
  })

  it('renders a box\'s assigned vials as chips inside the box card', async () => {
    // A pre-existing box (id 7) with one vial already assigned to it. Because
    // the vial is boxed, no first-box auto-create fires — the chip must show
    // inside the box card, and the Unboxed panel reports everything boxed.
    const { boxesState } = setupBackend([vial('P-101', 'hplc', 7)])
    boxesState.push({
      id: 7, order_key: ORDER, box_number: 1, role: 'hplc',
      label_code: 'BOX-1042-1', vial_count: 1, printed_at: null,
      created_at: null, stored_at: null,
    })
    renderBoxStep()

    expect(await screen.findByText('P-101')).toBeInTheDocument()
    expect(screen.getByText('All vials boxed.')).toBeInTheDocument()
    expect(mockCreateBox).not.toHaveBeenCalled()
  })

  it('remove on an empty box calls deleteBox with the box id', async () => {
    setupBackend([vial('P-101', 'hplc')])
    renderBoxStep()

    // Every box now shows a Delete control (trashcan).
    const removeBtn = await screen.findByLabelText('Delete box')
    fireEvent.click(removeBtn)

    await waitFor(() => expect(mockDeleteBox).toHaveBeenCalledTimes(1))
    expect(mockDeleteBox).toHaveBeenCalledWith(1)
  })

  it('dropping a boxed vial on the "unboxed" droppable unassigns it', async () => {
    // A pre-existing box (id 7) holding one vial; dragging that chip onto the
    // Unboxed tray (over.id === "unboxed") must clear its box membership.
    const { boxesState } = setupBackend([vial('P-101', 'hplc', 7)])
    boxesState.push({
      id: 7, order_key: ORDER, box_number: 1, role: 'hplc',
      label_code: 'BOX-1042-1', vial_count: 1, printed_at: null,
      created_at: null, stored_at: null,
    })
    renderBoxStep()
    await screen.findByText('P-101')

    // Drive the drag-end branch directly (jsdom lacks pointer geometry).
    await act(async () => {
      await dnd.onDragEnd!({ active: { id: 'P-101' }, over: { id: 'unboxed' } })
    })

    expect(mockUnassignVialsFromBox).toHaveBeenCalledWith(['P-101'])
    expect(mockAssignVialsToBox).not.toHaveBeenCalled()
  })

  it('dropping a vial on a box id assigns (not unassigns)', async () => {
    const { boxesState } = setupBackend([vial('P-101', 'hplc', 7)])
    boxesState.push({
      id: 7, order_key: ORDER, box_number: 1, role: 'hplc',
      label_code: 'BOX-1042-1', vial_count: 1, printed_at: null,
      created_at: null, stored_at: null,
    })
    renderBoxStep()
    await screen.findByText('P-101')

    await act(async () => {
      await dnd.onDragEnd!({ active: { id: 'P-101' }, over: { id: '7' } })
    })

    expect(mockAssignVialsToBox).toHaveBeenCalledWith(7, ['P-101'])
    expect(mockUnassignVialsFromBox).not.toHaveBeenCalled()
  })

  describe('boxKeyboardCoordinates — arrows jump the lifted chip between drop targets', () => {
    const rect = (left: number, top: number, width = 120, height = 80) =>
      ({ left, top, width, height, right: left + width, bottom: top + height })

    // A lifted chip is small relative to the box-card droppables.
    const chip = rect(0, 0, 40, 16)

    const call = (code: string, rects: Record<string, ReturnType<typeof rect>>) =>
      boxKeyboardCoordinates(
        new KeyboardEvent('keydown', { code, cancelable: true }),
        {
          active: 'P-101',
          currentCoordinates: { x: chip.left, y: chip.top },
          context: {
            droppableRects: new Map(Object.entries(rects)),
            droppableContainers: {
              getEnabled: () => Object.keys(rects).map(id => ({ id })),
            },
            collisionRect: chip,
          },
        } as unknown as Parameters<typeof boxKeyboardCoordinates>[1],
      )

    it('centers the chip over the nearest target in the pressed direction', () => {
      const coords = call('ArrowRight', {
        unboxed: rect(-300, 0), // behind the chip — must be ignored
        near: rect(200, 0),
        far: rect(500, 0),
      })
      expect(coords).toEqual({ x: 200 + (120 - 40) / 2, y: (80 - 16) / 2 })
    })

    it('returns nothing when no target lies in the pressed direction', () => {
      expect(call('ArrowLeft', { box7: rect(200, 0) })).toBeUndefined()
    })

    it('ignores non-arrow keys (Enter/Esc stay dnd-kit\'s drop/cancel)', () => {
      expect(call('Enter', { box7: rect(200, 0) })).toBeUndefined()
    })

    it('moves vertically within a column', () => {
      const coords = call('ArrowDown', {
        above: rect(0, -200),
        below: rect(0, 150),
      })
      expect(coords).toEqual({ x: (120 - 40) / 2, y: 150 + (80 - 16) / 2 })
    })
  })

  it('moves the chip into the box card from the cache patch, before the vials refetch lands', async () => {
    // Pre-existing empty hplc box (id 7) so no auto-create fires; P-101 unboxed.
    const { boxesState } = setupBackend([vial('P-101', 'hplc')])
    boxesState.push({
      id: 7, order_key: ORDER, box_number: 1, role: 'hplc',
      label_code: 'BOX-1042-1', vial_count: 0, printed_at: null,
      created_at: null, stored_at: null,
    })
    renderBoxStep()
    await screen.findByText('P-101')

    // From here on, every listSubSamples refetch hangs forever — so anything
    // that renders after the drop can only have come from the cache patch,
    // not from the background invalidation's refetch.
    mockListSubSamples.mockImplementation(() => new Promise(() => {}))

    await act(async () => {
      await dnd.onDragEnd!({ active: { id: 'P-101' }, over: { id: '7' } })
    })

    // The chip left the Unboxed panel (it now reports empty) and still renders
    // — i.e. inside the box card — and the patched box shows its new count.
    expect(await screen.findByText('All vials boxed.')).toBeInTheDocument()
    expect(screen.getByText('P-101')).toBeInTheDocument()
    expect(screen.getByText('1 vials')).toBeInTheDocument()
  })

  it('shows "Saving…" while the assign call is in flight and hides it after it settles', async () => {
    const { boxesState } = setupBackend([vial('P-101', 'hplc')])
    const box7: LimsBox = {
      id: 7, order_key: ORDER, box_number: 1, role: 'hplc',
      label_code: 'BOX-1042-1', vial_count: 0, printed_at: null,
      created_at: null, stored_at: null,
    }
    boxesState.push(box7)
    renderBoxStep()
    await screen.findByText('P-101')

    // A deferred assign: the handler is pending until we resolve it.
    let resolveAssign!: (b: LimsBox) => void
    mockAssignVialsToBox.mockImplementation(() => new Promise(r => { resolveAssign = r }))

    let dragDone!: Promise<unknown>
    act(() => {
      dragDone = Promise.resolve(dnd.onDragEnd!({ active: { id: 'P-101' }, over: { id: '7' } }))
    })

    expect(await screen.findByText('Saving…')).toBeInTheDocument()

    await act(async () => {
      resolveAssign({ ...box7, vial_count: 1 })
      await dragDone
    })

    await waitFor(() => expect(screen.queryByText('Saving…')).not.toBeInTheDocument())
  })

  it('"Print box labels" prints one job covering only the vialed boxes', async () => {
    // Two pre-existing boxes: id 7 holds the order's only vial, id 8 is empty.
    // The toolbar button must stamp printed_at for the vialed box only and
    // issue a single print job (one printNode call carrying every label).
    const { boxesState } = setupBackend([vial('P-101', 'hplc', 7)])
    boxesState.push(
      {
        id: 7, order_key: ORDER, box_number: 1, role: 'hplc',
        label_code: 'BOX-1042-1', vial_count: 1, printed_at: null,
        created_at: '2026-07-01T12:00:00', stored_at: null,
      },
      {
        id: 8, order_key: ORDER, box_number: 2, role: 'hplc',
        label_code: 'BOX-1042-2', vial_count: 0, printed_at: null,
        created_at: null, stored_at: null,
      },
    )
    renderBoxStep()
    await screen.findByText('P-101')

    fireEvent.click(screen.getByRole('button', { name: 'Print box labels' }))

    await waitFor(() => expect(mockPrintBox).toHaveBeenCalledTimes(1))
    expect(mockPrintBox).toHaveBeenCalledWith(7)
    expect(printing.printNode).toHaveBeenCalledTimes(1)
  })
})
