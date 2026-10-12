import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api-agents'
import type { Agent } from '@/lib/api-agents'
import { AgentsPane } from '../AgentsPane'
import { visibleNavItems } from '../../panes'

const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: auth.role } }),
}))
vi.mock('@/services/groups', () => ({
  useGroups: () => ({ data: [{ id: 7, name: 'Leadership', is_active: true }] }),
}))
vi.mock('@/lib/api-agents', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api-agents')
  return {
    ...actual,
    listAgents: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    rotateAgentKey: vi.fn(),
    setAgentGroups: vi.fn(),
  }
})

const pia: Agent = {
  id: 3,
  username: 'pia',
  display_name: 'Pia',
  is_active: true,
  lab_tools: false,
  coa_publishing: false,
  key_hint: 'abc123',
  created_at: '2026-10-12T10:00:00',
  created_by_name: 'Ada Admin',
  rotated_at: null,
  last_used_at: null,
  group_ids: [],
}
const KEY = 'mk1a.pia.' + 'x'.repeat(43)

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AgentsPane />
    </QueryClientProvider>
  )
}

describe('AgentsPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.role = 'admin'
    vi.mocked(api.listAgents).mockResolvedValue([pia])
  })

  it('lists agents with their switches and key hint, never a key', async () => {
    renderPane()
    expect(await screen.findByText('Pia')).toBeInTheDocument()
    expect(screen.getByText(/abc123/)).toBeInTheDocument()
    expect(screen.queryByText(/mk1a\./)).toBeNull()
  })

  it('shows a new key once, with the two MCP settings, and hides it on Done', async () => {
    vi.mocked(api.createAgent).mockResolvedValue({
      agent: { ...pia, id: 4, username: 'devon', display_name: 'Devon' },
      key: KEY.replace('pia', 'devon'),
    })
    renderPane()
    await screen.findByText('Pia')
    await userEvent.type(screen.getByLabelText('Username'), 'devon')
    await userEvent.type(screen.getByLabelText('Display name'), 'Devon')
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    const once = await screen.findByTestId('agent-key-once')
    expect(once.textContent).toContain('LABMGR_MK1_AGENT_NAME=devon')
    expect(once.textContent).toContain('LABMGR_MK1_AGENT_KEY=mk1a.devon.')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('agent-key-once')).toBeNull()
    expect(screen.queryByText(/mk1a\./)).toBeNull()
  })

  it('keeps COA publishing off until Lab tools is on', async () => {
    renderPane()
    await screen.findByText('Pia')
    expect(screen.getByLabelText('COA publishing for Pia')).toBeDisabled()
  })

  it('rotates only after confirmation and shows the new key once', async () => {
    vi.mocked(api.rotateAgentKey).mockResolvedValue({ agent: pia, key: KEY })
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    renderPane()
    await screen.findByText('Pia')
    await userEvent.click(
      screen.getByRole('button', { name: 'Rotate key for Pia' })
    )
    expect(api.rotateAgentKey).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Rotate key for Pia' })
    )
    await waitFor(() => expect(api.rotateAgentKey).toHaveBeenCalledWith(3))
    expect(await screen.findByTestId('agent-key-once')).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('does not say Copied when the clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    vi.mocked(api.rotateAgentKey).mockResolvedValue({ agent: pia, key: KEY })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPane()
    await screen.findByText('Pia')
    await userEvent.click(
      screen.getByRole('button', { name: 'Rotate key for Pia' })
    )
    await screen.findByTestId('agent-key-once')
    await userEvent.click(screen.getByRole('button', { name: 'Copy settings' }))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`LABMGR_MK1_AGENT_KEY=${KEY}`)
    )
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Copy settings' })
    ).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('a second issuance shows the new key and Copy settings, not Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const KEY2 = 'mk1a.pia.' + 'y'.repeat(43)
    vi.mocked(api.rotateAgentKey)
      .mockResolvedValueOnce({ agent: pia, key: KEY })
      .mockResolvedValueOnce({ agent: pia, key: KEY2 })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const rotate = () =>
      userEvent.click(
        screen.getByRole('button', { name: 'Rotate key for Pia' })
      )
    renderPane()
    await screen.findByText('Pia')
    await rotate()
    await screen.findByTestId('agent-key-once')
    await userEvent.click(screen.getByRole('button', { name: 'Copy settings' }))
    expect(
      await screen.findByRole('button', { name: 'Copied' })
    ).toBeInTheDocument()
    await rotate()
    await waitFor(() =>
      expect(screen.getByTestId('agent-key-once').textContent).toContain(KEY2)
    )
    expect(screen.getByTestId('agent-key-once').textContent).not.toContain(KEY)
    expect(
      screen.getByRole('button', { name: 'Copy settings' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    confirm.mockRestore()
  })

  it('is admin-only, in the pane and in the nav', () => {
    auth.role = 'standard'
    renderPane()
    expect(
      screen.getByText('Only admins can manage agents.')
    ).toBeInTheDocument()
    expect(visibleNavItems(false).some(i => i.id === 'agents')).toBe(false)
    expect(visibleNavItems(true).some(i => i.id === 'agents')).toBe(true)
  })
})
