import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'

const update = vi.fn()
const test = vi.fn()
const prefs = {
  enabled: true,
  slack_member_id: null as string | null,
  linked: false,
  notify_assigned: true,
  notify_mentioned: true,
  notify_raised_activity: true,
  notify_watching_activity: true,
  notify_status_changes: true,
}
vi.mock('@/services/slack-prefs', () => ({
  useSlackPrefs: () => ({ data: prefs, isLoading: false, isError: false }),
  useUpdateSlackPrefs: () => ({ mutate: update, isPending: false }),
  useTestSlackDm: () => ({ mutate: test, isPending: false, data: undefined }),
}))

describe('SlackPrefsSection', () => {
  beforeEach(() => {
    update.mockReset()
    test.mockReset()
  })

  it('renders master toggle, five category toggles, link state', async () => {
    const { SlackPrefsSection } =
      await import('@/components/preferences/panes/SlackPrefsSection')
    render(<SlackPrefsSection />)
    expect(screen.getByText(/not linked/i)).toBeInTheDocument()
    // master + 5 categories
    expect(screen.getAllByRole('switch')).toHaveLength(6)
  })

  it('toggling a category saves that field', async () => {
    const { SlackPrefsSection } =
      await import('@/components/preferences/panes/SlackPrefsSection')
    render(<SlackPrefsSection />)
    const switches = screen.getAllByRole('switch')
    await userEvent.click(switches[4]!)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ notify_watching_activity: false })
    )
  })

  it('test button fires the test mutation', async () => {
    const { SlackPrefsSection } =
      await import('@/components/preferences/panes/SlackPrefsSection')
    render(<SlackPrefsSection />)
    await userEvent.click(screen.getByRole('button', { name: /send test dm/i }))
    expect(test).toHaveBeenCalled()
  })
})
