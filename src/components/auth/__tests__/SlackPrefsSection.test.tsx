import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'

const update = vi.fn()
const test = vi.fn()
const prefs = {
  enabled: true,
  slack_member_id: null as string | null,
  slack_display_name: null as string | null,
  linked: false,
  notify_assigned: true,
  notify_mentioned: true,
  notify_raised_activity: true,
  notify_watching_activity: true,
  notify_status_changes: true,
  digest_enabled: false,
  digest_hour: 8,
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
    prefs.linked = false
    prefs.slack_member_id = null
    prefs.slack_display_name = null
  })

  it('linked state shows WHO the mapping resolved to', async () => {
    prefs.linked = true
    prefs.slack_member_id = 'U123'
    prefs.slack_display_name = 'forrest'
    const { SlackPrefsSection } =
      await import('@/components/auth/SlackPrefsSection')
    render(<SlackPrefsSection />)
    expect(screen.getByText(/slack linked → forrest/i)).toBeInTheDocument()
  })

  it('renders master toggle, five category toggles, link state', async () => {
    const { SlackPrefsSection } =
      await import('@/components/auth/SlackPrefsSection')
    render(<SlackPrefsSection />)
    expect(screen.getByText(/not linked/i)).toBeInTheDocument()
    // master + 5 categories + digest
    expect(screen.getAllByRole('switch')).toHaveLength(7)
  })

  it('flipping the digest toggle enables the morning digest', async () => {
    const { SlackPrefsSection } =
      await import('@/components/auth/SlackPrefsSection')
    render(<SlackPrefsSection />)
    // The digest switch is the last one (after master + 5 categories).
    const digestSwitch = screen.getAllByRole('switch').at(-1)
    if (!digestSwitch) throw new Error('digest switch not found')
    await userEvent.click(digestSwitch)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ digest_enabled: true })
    )
  })

  it('toggling a category saves that field', async () => {
    const { SlackPrefsSection } =
      await import('@/components/auth/SlackPrefsSection')
    render(<SlackPrefsSection />)
    const watchingSwitch = screen.getAllByRole('switch').at(4)
    if (!watchingSwitch) throw new Error('watching-activity switch not found')
    await userEvent.click(watchingSwitch)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ notify_watching_activity: false })
    )
  })

  it('test button fires the test mutation', async () => {
    const { SlackPrefsSection } =
      await import('@/components/auth/SlackPrefsSection')
    render(<SlackPrefsSection />)
    await userEvent.click(screen.getByRole('button', { name: /send test dm/i }))
    expect(test).toHaveBeenCalled()
  })
})
