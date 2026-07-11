import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@/test/test-utils'
import { useAuthStore } from '@/store/auth-store'

// A type scoped to a virtual item kind (`general_task`) must render — and light
// up — a scope chip for that kind on its card, exactly like a code-entity chip.
// Before slice 7 wired kinds into TypeCard the card only knew code slugs, so a
// kind-scoped type showed NO active chip (read as "scoped to nothing") and its
// "All" chip would silently clobber the kind scope.
vi.mock('@/lib/flags-api', async () => {
  const actual = (await vi.importActual('@/lib/flags-api')) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    getFlagTypes: vi.fn(async () => [
      {
        id: 5,
        slug: 'blocker',
        label: 'Blocker',
        color: '#ef4444',
        kind: 'issue',
        is_blocking: false,
        is_active: true,
        sort_order: 0,
        entity_types: ['general_task'],
        is_builtin: false,
      },
    ]),
    getFlagEntityTypes: vi.fn(async () => ['sample', 'sub_sample', 'worksheet']),
    getItemKinds: vi.fn(async () => [
      {
        id: 1,
        slug: 'general_task',
        label: 'General Task',
        color: '#6b7280',
        is_active: true,
        is_builtin: true,
        sort_order: 0,
      },
    ]),
    updateFlagType: vi.fn(),
    deleteFlagType: vi.fn(),
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('FlagsPane — TypeCard scope chips include item kinds', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 1, role: 'admin' } as never })
  })

  it('renders an active scope chip for a kind the type is scoped to', async () => {
    const { FlagsPane } = await import(
      '@/components/preferences/panes/FlagsPane'
    )
    render(<FlagsPane />)

    // The active chip is the only General Task control marked aria-pressed;
    // the admin kinds manager and the board header also print "General Task"
    // but neither is a pressed toggle, so this uniquely targets the card chip.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'General Task', pressed: true })
      ).toBeInTheDocument()
    )
  })
})
