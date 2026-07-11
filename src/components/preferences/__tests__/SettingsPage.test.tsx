import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Isolate the page's nav/routing behavior from pane internals (which pull tauri
// + query deps). We assert the wiring: one nav item per registry entry, the
// active pane renders, clicking a nav item navigates to #settings/<pane>.
const h = vi.hoisted(() => ({
  navigateTo: vi.fn(),
  state: { activeSubSection: 'general' as string },
}))

vi.mock('@/store/ui-store', () => ({
  useUIStore: (sel: (s: unknown) => unknown) =>
    sel({ activeSubSection: h.state.activeSubSection, navigateTo: h.navigateTo }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('@/components/preferences/panes', () => ({
  navigationItems: [
    { id: 'general', labelKey: 'preferences.general', icon: () => null },
    { id: 'flags', labelKey: 'preferences.flags', icon: () => null },
  ],
  PANE_COMPONENTS: {
    general: () => <div>general-pane-content</div>,
    flags: () => <div>flags-pane-content</div>,
  },
  isPreferencePane: (id: string) => id === 'general' || id === 'flags',
}))

import { SettingsPage } from '@/components/preferences/SettingsPage'

describe('SettingsPage', () => {
  beforeEach(() => {
    h.navigateTo.mockReset()
    h.state.activeSubSection = 'general'
  })

  it('renders a nav item per registry entry', () => {
    render(<SettingsPage />)
    expect(
      screen.getByRole('button', { name: 'preferences.general' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'preferences.flags' })
    ).toBeInTheDocument()
  })

  it('renders the active pane', () => {
    h.state.activeSubSection = 'flags'
    render(<SettingsPage />)
    expect(screen.getByText('flags-pane-content')).toBeInTheDocument()
    expect(screen.queryByText('general-pane-content')).not.toBeInTheDocument()
  })

  it('falls back to the general pane for a non-settings subsection', () => {
    h.state.activeSubSection = 'overview'
    render(<SettingsPage />)
    expect(screen.getByText('general-pane-content')).toBeInTheDocument()
  })

  it('navigates to #settings/<pane> when a nav item is clicked', async () => {
    render(<SettingsPage />)
    await userEvent.click(
      screen.getByRole('button', { name: 'preferences.flags' })
    )
    expect(h.navigateTo).toHaveBeenCalledWith('settings', 'flags')
  })
})
