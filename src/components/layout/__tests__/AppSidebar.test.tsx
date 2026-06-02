import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SidebarProvider } from '@/components/ui/sidebar'

// Mutable mock state — overridable per test via setMockState() below.
interface MockUIState {
  activeSection: string
  activeSubSection: string
  navigateTo: ReturnType<typeof vi.fn>
  setPreferencesOpen: ReturnType<typeof vi.fn>
  updateVersion: string | null
  updateReady: boolean
}

const uiState: MockUIState = {
  activeSection: 'accumark-tools',
  activeSubSection: 'order-status',
  navigateTo: vi.fn(),
  setPreferencesOpen: vi.fn(),
  updateVersion: null,
  updateReady: false,
}

function setMockState(overrides: Partial<MockUIState>) {
  Object.assign(uiState, overrides)
}

vi.mock('@/store/ui-store', () => {
  const useUIStore = <T,>(selector: (s: MockUIState) => T): T =>
    selector(uiState)
  // Static getState for non-React callers (none in AppSidebar today, but keep
  // parity with the canonical mock pattern from peptide-request-detail.test.tsx).
  ;(useUIStore as unknown as { getState: () => MockUIState }).getState = () =>
    uiState
  return { useUIStore }
})

interface MockAuthState {
  user: { role: string; email: string } | null
}
const authState: MockAuthState = {
  user: { role: 'user', email: 'lab@example.com' },
}
vi.mock('@/store/auth-store', () => {
  const useAuthStore = <T,>(selector: (s: MockAuthState) => T): T =>
    selector(authState)
  ;(useAuthStore as unknown as { getState: () => MockAuthState }).getState =
    () => authState
  return { useAuthStore }
})

const wizardResetSpy = vi.fn()
vi.mock('@/store/wizard-store', () => {
  const useWizardStore = <T,>(
    selector: (s: { resetWizard: () => void }) => T
  ): T => selector({ resetWizard: wizardResetSpy })
  ;(
    useWizardStore as unknown as {
      getState: () => { resetWizard: () => void }
    }
  ).getState = () => ({ resetWizard: wizardResetSpy })
  return { useWizardStore }
})

vi.mock('@/lib/auth-api', () => ({
  logout: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}))

const { AppSidebar } = await import('../AppSidebar')

function renderSidebar() {
  return render(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  )
}

describe('AppSidebar — Customers entry (Phase 29-03)', () => {
  beforeEach(() => {
    // Reset mock spies + restore defaults
    uiState.navigateTo.mockReset()
    uiState.setPreferencesOpen.mockReset()
    wizardResetSpy.mockReset()
    setMockState({
      activeSection: 'accumark-tools',
      activeSubSection: 'order-status',
      updateVersion: null,
      updateReady: false,
    })
    // Pre-seed localStorage so the accumark-tools group is expanded on mount.
    localStorage.setItem(
      'sidebar-expanded-sections',
      JSON.stringify({ 'accumark-tools': true })
    )
  })

  it('renders the Customers sub-item under AccuMark Tools', () => {
    renderSidebar()
    const customersBtn = screen.getByRole('button', { name: 'Customers' })
    expect(customersBtn).toBeInTheDocument()
  })

  it('orders AccuMark Tools sub-items as Overview → Order Explorer → Order Status → Customers → COA Explorer → Digital COA → Chromatographs', () => {
    renderSidebar()
    // Scope to the AccuMark Tools group: walk up from a uniquely-named
    // sibling (Order Explorer is only present under accumark-tools) to find
    // the enclosing <ul data-sidebar="menu-sub">, then read its direct
    // sub-button labels in document order.
    const anchor = screen.getByRole('button', { name: 'Order Explorer' })
    const subMenu = anchor.closest('[data-sidebar="menu-sub"]')
    if (!subMenu) throw new Error('AccuMark Tools sub-menu not found in DOM')
    const labels = Array.from(
      subMenu.querySelectorAll('[data-sidebar="menu-sub-button"]')
    ).map(el => el.textContent?.trim() ?? '')
    expect(labels).toEqual([
      'Overview',
      'Order Explorer',
      'Order Status',
      'Customers',
      'COA Explorer',
      'Digital COA',
      'Chromatographs',
    ])
  })

  it('clicking Customers dispatches navigateTo("accumark-tools", "customers")', () => {
    renderSidebar()
    const customersBtn = screen.getByRole('button', { name: 'Customers' })
    fireEvent.click(customersBtn)
    expect(uiState.navigateTo).toHaveBeenCalledWith(
      'accumark-tools',
      'customers'
    )
  })

  it('Customers sub-item is active when activeSubSection === "customers"', () => {
    setMockState({
      activeSection: 'accumark-tools',
      activeSubSection: 'customers',
    })
    renderSidebar()
    const customersBtn = screen.getByRole('button', { name: 'Customers' })
    // shadcn SidebarMenuSubButton surfaces isActive via data-active="true"
    expect(customersBtn.getAttribute('data-active')).toBe('true')
  })

  it('Customers sub-item stays active when activeSubSection === "customer-detail" (widened check)', () => {
    setMockState({
      activeSection: 'accumark-tools',
      activeSubSection: 'customer-detail',
    })
    renderSidebar()
    const customersBtn = screen.getByRole('button', { name: 'Customers' })
    expect(customersBtn.getAttribute('data-active')).toBe('true')
  })

  it('Customers sub-item is NOT active when activeSubSection is unrelated (e.g. "order-status")', () => {
    setMockState({
      activeSection: 'accumark-tools',
      activeSubSection: 'order-status',
    })
    renderSidebar()
    const customersBtn = screen.getByRole('button', { name: 'Customers' })
    expect(customersBtn.getAttribute('data-active')).not.toBe('true')
  })
})
