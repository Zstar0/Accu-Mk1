/**
 * Task 7: the inbox bulk toolbar assigns priority at the VIAL level through
 * `PUT /priorities/assign/bulk`, addressing each selected row by the native
 * sub-sample pk it carries. Rows with no native vial (parent rows,
 * SENAITE-only rows) are skipped and reported, never retargeted at the parent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { toast } from 'sonner'
import type { InboxVialItem } from '@/lib/api'
import type * as PriorityApi from '@/lib/api-priorities'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/api-priorities', async importOriginal => ({
  ...(await importOriginal<typeof PriorityApi>()),
  getPriorities: vi.fn(async () => [
    {
      key: 'expedited',
      name: 'Expedited',
      rank: 20,
      icon: 'chevrons-up',
      color: 'red',
      pulse: true,
      is_default: false,
      is_active: true,
      sla_tier_id: null,
    },
    {
      key: 'default',
      name: 'Default',
      rank: 0,
      icon: 'minus',
      color: 'zinc',
      pulse: false,
      is_default: true,
      is_active: true,
      sla_tier_id: null,
    },
  ]),
  assignPriorityBulk: vi.fn(async () => []),
  assignPriority: vi.fn(async () => ({
    level: 'vial',
    id: '11',
    old_key: null,
    new_key: 'expedited',
    affected_sample_pks: [],
  })),
}))

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}))

vi.mock('@/store/ui-store', () => {
  const state = { navigateToSample: vi.fn() }
  const useUIStore = <T,>(selector: (s: typeof state) => T): T =>
    selector(state)
  useUIStore.getState = () => state
  return { useUIStore }
})

const { assignPriority, assignPriorityBulk } =
  await import('@/lib/api-priorities')
const { InboxBulkToolbar } = await import('@/components/hplc/InboxBulkToolbar')
const { InboxVialCard } = await import('@/components/hplc/InboxVialCard')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function vial(overrides: Partial<InboxVialItem>): InboxVialItem {
  return {
    uid: 'mk1://v1',
    sample_id: 'P-0141-S01',
    is_parent: false,
    parent_sample_id: 'P-0141',
    assignment_role: 'hplc',
    vial_sequence: 1,
    vial_total: 2,
    title: '',
    client_id: null,
    client_order_number: null,
    date_received: null,
    review_state: 'sample_received',
    priority: 'normal',
    assignment_summary: '',
    analyses: [],
    ...overrides,
  } as InboxVialItem
}

async function pickExpedited() {
  // Radix Select needs fireEvent under jsdom (hasPointerCapture is missing) —
  // same workaround as worksheet-apply-method.test.tsx.
  fireEvent.click(
    await screen.findByRole('combobox', { name: /set priority/i })
  )
  fireEvent.click(await screen.findByRole('option', { name: 'Expedited' }))
}

describe('InboxBulkToolbar priority assign', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends one vial-level assign per selected row that carries a sub-sample pk', async () => {
    render(
      <InboxBulkToolbar
        selected={[
          vial({ uid: 'mk1://v1', sub_sample_pk: 11 }),
          vial({ uid: 'mk1://v2', sample_id: 'P-0141-S02', sub_sample_pk: 12 }),
        ]}
        onCreateWorksheet={vi.fn()}
        onClearSelection={vi.fn()}
      />,
      { wrapper }
    )

    await pickExpedited()

    await waitFor(() =>
      expect(assignPriorityBulk).toHaveBeenCalledWith([
        { level: 'vial', id: '11', priority_key: 'expedited' },
        { level: 'vial', id: '12', priority_key: 'expedited' },
      ])
    )
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('skips rows with no native vial and reports how many', async () => {
    render(
      <InboxBulkToolbar
        selected={[
          vial({ uid: 'mk1://v1', sub_sample_pk: 11 }),
          vial({ uid: 'senaite-1', is_parent: true, sub_sample_pk: null }),
        ]}
        onCreateWorksheet={vi.fn()}
        onClearSelection={vi.fn()}
      />,
      { wrapper }
    )

    await pickExpedited()

    await waitFor(() =>
      expect(assignPriorityBulk).toHaveBeenCalledWith([
        { level: 'vial', id: '11', priority_key: 'expedited' },
      ])
    )
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toContain('1 item')
  })

  it('clears the explicit key when Inherit is chosen', async () => {
    render(
      <InboxBulkToolbar
        selected={[vial({ sub_sample_pk: 11 })]}
        onCreateWorksheet={vi.fn()}
        onClearSelection={vi.fn()}
      />,
      { wrapper }
    )

    fireEvent.click(
      await screen.findByRole('combobox', { name: /set priority/i })
    )
    fireEvent.click(await screen.findByRole('option', { name: 'Inherit' }))

    await waitFor(() =>
      expect(assignPriorityBulk).toHaveBeenCalledWith([
        { level: 'vial', id: '11', priority_key: null },
      ])
    )
  })
})

describe('InboxVialCard priority picker', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pins a value the vial is only INHERITING (the picker is write-only)', async () => {
    // The row resolves to expedited from its ORDER, with no explicit vial key.
    // A picker bound to the resolved value would already read 'Expedited' and
    // Radix would swallow the re-pick; this must still write.
    render(
      <InboxVialCard
        vial={vial({
          sub_sample_pk: 11,
          priority_effective: {
            key: 'expedited',
            rank: 20,
            source_level: 'order',
            source_id: '3291',
          },
        })}
        groupedWithPrevious={false}
      />,
      { wrapper }
    )

    // The inherited value is still shown, via the glyph's accessible name.
    expect(
      await screen.findByRole('img', { name: 'Expedited via order 3291' })
    ).toBeInTheDocument()

    fireEvent.click(
      await screen.findByRole('combobox', { name: /priority for P-0141-S01/i })
    )
    fireEvent.click(await screen.findByRole('option', { name: 'Expedited' }))

    await waitFor(() =>
      expect(assignPriority).toHaveBeenCalledWith({
        level: 'vial',
        id: '11',
        priority_key: 'expedited',
      })
    )
  })

  it('cannot be used on a row with no native vial', async () => {
    render(
      <InboxVialCard
        vial={vial({ is_parent: true, sub_sample_pk: null })}
        groupedWithPrevious={false}
      />,
      { wrapper }
    )
    expect(
      await screen.findByRole('combobox', { name: /priority for P-0141-S01/i })
    ).toBeDisabled()
    expect(assignPriority).not.toHaveBeenCalled()
  })
})
