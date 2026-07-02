import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@/test/test-utils'
import { useAuthStore } from '@/store/auth-store'

// Count POSTs to the create-type endpoint. Preserve the real module for
// FlagTypeApiError + types the pane imports.
const createFlagType = vi.fn()
vi.mock('@/lib/flags-api', async () => {
  const actual = (await vi.importActual('@/lib/flags-api')) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    getFlagTypes: vi.fn(async () => []),
    getFlagEntityTypes: vi.fn(async () => [
      'sample',
      'sub_sample',
      'worksheet',
    ]),
    createFlagType: (data: unknown) => createFlagType(data),
    updateFlagType: vi.fn(),
    deleteFlagType: vi.fn(),
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

async function renderPaneAsAdmin() {
  const { FlagsPane } = await import('@/components/preferences/panes/FlagsPane')
  render(<FlagsPane />)
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /add type/i })
    ).toBeInTheDocument()
  )
  return screen.getByRole('button', { name: /add type/i })
}

describe('FlagsPane — Add Type button', () => {
  beforeEach(() => {
    createFlagType.mockReset().mockResolvedValue({
      id: 7,
      slug: 'new_type_2',
      label: 'New type',
      color: '#3b82f6',
      kind: 'issue',
      is_blocking: false,
      is_active: true,
      sort_order: 9,
      entity_types: [],
      is_builtin: false,
    })
    useAuthStore.setState({ user: { id: 1, role: 'admin' } as never })
  })

  it('creates only ONE type when the button double-fires in a single tick', async () => {
    const btn = await renderPaneAsAdmin()
    // Two native clicks in the SAME act — before React can commit the
    // disabled attribute — reproduces the observed double-POST. An in-flight
    // guard must collapse them to a single create.
    await act(async () => {
      btn.click()
      btn.click()
    })
    expect(createFlagType).toHaveBeenCalledTimes(1)
  })

  it('re-enables so a later, separate click can still add another type', async () => {
    const btn = await renderPaneAsAdmin()
    await act(async () => {
      btn.click()
    })
    // First create settled → the guard must reset (not latch), or the admin
    // could never add a second type.
    await act(async () => {
      btn.click()
    })
    expect(createFlagType).toHaveBeenCalledTimes(2)
  })
})
