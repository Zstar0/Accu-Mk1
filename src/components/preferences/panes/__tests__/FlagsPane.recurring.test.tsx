import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { useAuthStore } from '@/store/auth-store'

// Follow FlagsPane.addtype.test.tsx: mock the api layer, keep the real services
// + real store. Adds recurring stubs alongside the flag-type ones.
vi.mock('@/lib/flags-api', async () => {
  const actual = (await vi.importActual('@/lib/flags-api')) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    getFlagTypes: vi.fn(async () => [
      {
        id: 1,
        slug: 'task',
        label: 'Task',
        color: '#0ea5a5',
        kind: 'issue',
        is_blocking: false,
        is_active: true,
        sort_order: 5,
        entity_types: [],
        is_builtin: true,
      },
    ]),
    getFlagEntityTypes: vi.fn(async () => [
      'sample',
      'sub_sample',
      'worksheet',
    ]),
    createFlagType: vi.fn(),
    updateFlagType: vi.fn(),
    deleteFlagType: vi.fn(),
    listRecurring: vi.fn(async () => [
      {
        id: 1,
        title: 'Calibrate HPLC',
        type: 'task',
        cadence: 'weekly:0',
        active: true,
        skip_if_open: true,
        watchers: [],
        assignee_id: null,
        next_run_at: '',
        created_by: 1,
        created_at: '',
        last_minted_flag_id: null,
        body: null,
        entity_type: null,
        entity_id: null,
      },
    ]),
    createRecurring: vi.fn(),
    updateRecurring: vi.fn(),
    deleteRecurring: vi.fn(),
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('FlagsPane recurring section', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 1, role: 'admin' } as never })
  })

  it('lists recurring templates for an admin', async () => {
    const { FlagsPane } =
      await import('@/components/preferences/panes/FlagsPane')
    render(<FlagsPane />)
    // The template title renders in an editable Input (mirrors TypeCard).
    expect(
      await screen.findByDisplayValue('Calibrate HPLC')
    ).toBeInTheDocument()
  })
})
