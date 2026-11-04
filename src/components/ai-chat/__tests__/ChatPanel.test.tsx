import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  getMessages,
  listChats,
  listProviders,
  type AiChat,
  type AiMessage,
  type AiProvider,
} from '@/lib/ai-chat-api'
import { useAuthStore, type AuthUser } from '@/store/auth-store'
import { useAiChatStore } from '../chat-store'
import { ChatButton } from '../ChatButton'
import { ChatPanel } from '../ChatPanel'

import type * as Api from '@/lib/ai-chat-api'

vi.mock('@/lib/ai-chat-api', async importOriginal => ({
  ...(await importOriginal<typeof Api>()),
  getMessages: vi.fn(),
  listChats: vi.fn(),
  listProviders: vi.fn(),
  createChat: vi.fn(),
  sendPrompt: vi.fn(),
  cancelTurn: vi.fn(),
  decidePermission: vi.fn(),
}))

const mocks = {
  getMessages: vi.mocked(getMessages),
  listChats: vi.mocked(listChats),
  listProviders: vi.mocked(listProviders),
}

const NOVA: AiProvider = { id: 1, slug: 'nova', display_name: 'Nova' }
const GEORGE: AiProvider = { id: 2, slug: 'george', display_name: 'George' }
const store = () => useAiChatStore.getState()

const user = (id: number): AuthUser => ({
  id,
  email: `u${id}@example.com`,
  role: 'standard',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  senaite_configured: false,
})

const chatRow = (id: number, over: Partial<AiChat> = {}): AiChat => ({
  id,
  provider_id: 1,
  title: `Chat ${id}`,
  archived: false,
  created_at: '2026-11-03T00:00:00Z',
  updated_at: '2026-11-03T00:00:00Z',
  running_turn_id: null,
  pending_approvals: [],
  ...over,
})

const message = (seq: number, role: string, text: string): AiMessage => ({
  id: seq,
  seq,
  role,
  text,
  meta: null,
  created_at: '2026-11-03T00:00:00Z',
})

async function mount(providers: AiProvider[] = [NOVA]) {
  mocks.listProviders.mockResolvedValue(providers)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <ChatButton />
      <ChatPanel />
    </QueryClientProvider>
  )
  await waitFor(() => expect(mocks.listProviders).toHaveBeenCalled())
  return view
}

const panel = () => screen.getByRole('complementary', { hidden: true })
const button = () =>
  screen.queryByRole('button', { name: 'Open AI chat', hidden: true })

beforeEach(() => {
  act(() => store().reset())
  useAuthStore.setState({ user: user(1), token: 't' })
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.listChats.mockResolvedValue([])
  mocks.getMessages.mockResolvedValue([])
})

describe('ChatButton', () => {
  it('renders nothing while no provider is available', async () => {
    await mount([])
    expect(button()).toBeNull()
    expect(screen.queryByRole('complementary', { hidden: true })).toBeNull()
  })

  it('shows once a provider is available, and opens the panel', async () => {
    await mount()
    const open = await screen.findByRole('button', { name: 'Open AI chat' })
    expect(store().open).toBe(false)
    await userEvent.click(open)
    expect(store().open).toBe(true)
  })

  it('shows a spinner while a turn runs, and an amber dot while an approval waits', async () => {
    await mount()
    const open = await screen.findByRole('button', { name: 'Open AI chat' })
    expect(within(open).queryByTestId('ai-chat-running')).toBeNull()
    expect(within(open).queryByTestId('ai-chat-pending')).toBeNull()

    act(() => {
      store().apply({
        seq: 1,
        type: 'turn_started',
        chat_id: 1,
        turn_id: 't1',
        starting: false,
        resuming: false,
      })
    })
    expect(within(open).getByTestId('ai-chat-running')).toBeInTheDocument()
    expect(within(open).queryByTestId('ai-chat-pending')).toBeNull()

    act(() => {
      store().apply({
        seq: 2,
        type: 'permission_requested',
        chat_id: 1,
        turn_id: 't1',
        permission_id: 'p1',
        source: 'agent',
        title: 'Run ls',
        detail: '',
        can_allow: true,
        agent: 'Nova',
      })
    })
    expect(within(open).getByTestId('ai-chat-pending')).toBeInTheDocument()
  })

  it('puts focus in the message box when the panel opens', async () => {
    await mount()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open AI chat' })
    )
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus()
  })

  it('moves focus back to the button when the panel closes', async () => {
    await mount()
    const open = await screen.findByRole('button', { name: 'Open AI chat' })
    await userEvent.click(open)
    await userEvent.click(screen.getByRole('button', { name: 'Close AI chat' }))
    expect(store().open).toBe(false)
    await waitFor(() => expect(open).toHaveFocus())
  })
})

describe('ChatPanel', () => {
  it('is rendered through a portal to body, not inside its parent', async () => {
    const { container } = await mount()
    await screen.findByRole('button', { name: 'Open AI chat' })
    expect(panel().parentElement).toBe(document.body)
    expect(container.contains(panel())).toBe(false)
  })

  it('is a non-modal region: labelled, inert while closed, reachable once open', async () => {
    await mount()
    await screen.findByRole('button', { name: 'Open AI chat' })
    expect(panel()).toHaveAttribute('aria-label', 'AI chat')
    expect(panel()).toHaveAttribute('inert')
    expect(panel()).not.toHaveAttribute('aria-modal')
    act(() => store().setOpen(true))
    expect(panel()).not.toHaveAttribute('inert')
    expect(
      screen.getByRole('complementary', { name: 'AI chat' })
    ).toBeInTheDocument()
  })

  it('names the agent and states the footer note', async () => {
    await mount()
    await screen.findByRole('button', { name: 'Open AI chat' })
    act(() => store().setOpen(true))
    expect(screen.getByRole('heading', { name: 'Nova' })).toBeInTheDocument()
    expect(
      screen.getByText(
        "Chats are processed and stored by Nova on Accumark's bot server."
      )
    ).toBeInTheDocument()
    // One provider: no picker.
    expect(screen.queryByRole('button', { name: 'Choose agent' })).toBeNull()
  })

  it('offers a picker only with more than one provider', async () => {
    await mount([NOVA, GEORGE])
    await screen.findByRole('button', { name: 'Open AI chat' })
    act(() => store().setOpen(true))
    expect(
      screen.getByRole('button', { name: 'Choose agent' })
    ).toBeInTheDocument()
  })

  it('shows the empty state when there is no chat', async () => {
    await mount()
    await screen.findByRole('button', { name: 'Open AI chat' })
    act(() => store().setOpen(true))
    expect(
      screen.getByText('Ask Nova about the page you are on.')
    ).toBeInTheDocument()
  })

  it('Esc closes it when focus is inside', async () => {
    await mount()
    await screen.findByRole('button', { name: 'Open AI chat' })
    act(() => store().setOpen(true))
    const box = screen.getByRole('textbox', { name: 'Message' })
    box.focus()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(store().open).toBe(false)
  })

  it('Esc elsewhere on the page does not close it', async () => {
    await mount()
    await screen.findByRole('button', { name: 'Open AI chat' })
    act(() => store().setOpen(true))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(store().open).toBe(true)
  })

  describe('opening', () => {
    it("shows the provider's most recent chat when none is selected", async () => {
      mocks.getMessages.mockResolvedValue([
        message(1, 'user', 'earlier question'),
      ])
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      act(() => {
        store().setChats([chatRow(8, { provider_id: 1 }), chatRow(7)])
        store().setOpen(true)
      })
      await waitFor(() => expect(store().activeChatId).toBe(8))
      expect(await screen.findByText('earlier question')).toBeInTheDocument()
      expect(mocks.getMessages).toHaveBeenCalledWith(8)
    })

    it('picks it up when the list arrives after the panel opened', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      act(() => store().setOpen(true))
      expect(store().activeChatId).toBeNull()
      act(() => store().setChats([chatRow(8)]))
      await waitFor(() => expect(store().activeChatId).toBe(8))
    })

    it('New chat only clears the selection, and the latest chat does not come back', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      act(() => {
        store().setChats([chatRow(8)])
        store().setOpen(true)
      })
      await waitFor(() => expect(store().activeChatId).toBe(8))
      await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
      expect(store().activeChatId).toBeNull()
      expect(
        screen.getByText('Ask Nova about the page you are on.')
      ).toBeInTheDocument()
      // A list refresh must not pull the old chat back in.
      act(() => store().setChats([chatRow(8), chatRow(7)]))
      expect(store().activeChatId).toBeNull()
    })

    it('says so when a chat cannot be loaded, and Retry loads it', async () => {
      mocks.getMessages.mockRejectedValueOnce(new Error('down'))
      mocks.getMessages.mockResolvedValue([message(1, 'user', 'back again')])
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      act(() => {
        store().setChats([chatRow(8)])
        store().selectChat(8)
        store().setOpen(true)
      })
      expect(
        await screen.findByText('Could not load this chat.')
      ).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByText('back again')).toBeInTheDocument()
    })
  })

  describe('recent chats', () => {
    it('lists chats and selects the one chosen', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      act(() => {
        store().setChats([
          chatRow(8, { title: 'Latest' }),
          chatRow(7, { title: 'Older' }),
        ])
        store().setOpen(true)
      })
      await waitFor(() => expect(store().activeChatId).toBe(8))
      await userEvent.click(
        screen.getByRole('button', { name: 'Recent chats' })
      )
      await userEvent.click(
        await screen.findByRole('menuitem', { name: 'Older' })
      )
      expect(store().activeChatId).toBe(7)
    })
  })

  describe('states', () => {
    /** Open on chat 1 with its transcript already loaded, so nothing fetches. */
    const select = (loaded = true) =>
      act(() => {
        store().setChats([chatRow(1)])
        if (loaded) store().setMessages(1, [])
        store().selectChat(1)
        store().setOpen(true)
      })
    const apply = (e: Parameters<ReturnType<typeof store>['apply']>[0]) =>
      act(() => store().apply(e))
    const status = () => screen.getByRole('status', { name: 'Chat status' })

    it('Starting {agent}...', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select()
      apply({
        seq: 1,
        type: 'turn_started',
        chat_id: 1,
        turn_id: 't',
        starting: true,
        resuming: false,
      })
      expect(status()).toHaveTextContent('Starting Nova...')
    })

    it('Resuming...', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select()
      apply({
        seq: 1,
        type: 'turn_started',
        chat_id: 1,
        turn_id: 't',
        starting: false,
        resuming: true,
      })
      expect(status()).toHaveTextContent('Resuming...')
    })

    it('Running', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select()
      apply({
        seq: 1,
        type: 'turn_started',
        chat_id: 1,
        turn_id: 't',
        starting: false,
        resuming: false,
      })
      expect(status()).toHaveTextContent('Working...')
    })

    it('{agent} is waiting for your approval, with the card', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select(false)
      apply({
        seq: 1,
        type: 'turn_started',
        chat_id: 1,
        turn_id: 't',
        starting: false,
        resuming: false,
      })
      apply({
        seq: 2,
        type: 'permission_requested',
        chat_id: 1,
        turn_id: 't',
        permission_id: 'p1',
        source: 'agent',
        title: 'Run ls',
        detail: 'ls',
        can_allow: true,
        agent: 'Nova',
      })
      expect(status()).toHaveTextContent('Nova is waiting for your approval')
      // The card does not wait for the transcript to load.
      expect(store().messages[1]).toBeUndefined()
      expect(
        screen.getByRole('button', { name: 'Allow once' })
      ).toBeInTheDocument()
      // Let the transcript load finish inside the test.
      await waitFor(() => expect(store().messages[1]).toBeDefined())
    })

    it('shows the card even when the transcript cannot be loaded', async () => {
      mocks.getMessages.mockRejectedValue(new Error('down'))
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select(false)
      apply({
        seq: 1,
        type: 'permission_requested',
        chat_id: 1,
        turn_id: 't',
        permission_id: 'p1',
        source: 'agent',
        title: 'Run ls',
        detail: 'ls',
        can_allow: true,
        agent: 'Nova',
      })
      expect(
        await screen.findByText('Could not load this chat.')
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    })

    it('shows nothing in the status line when idle', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select()
      expect(status().textContent).toBe('')
      expect(status()).toHaveAttribute('aria-live', 'polite')
    })

    it('Cancelled', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select()
      apply({
        seq: 1,
        type: 'turn_started',
        chat_id: 1,
        turn_id: 't',
        starting: false,
        resuming: false,
      })
      apply({
        seq: 2,
        type: 'turn_ended',
        chat_id: 1,
        turn_id: 't',
        stop_reason: 'cancelled',
        message_seq: null,
      })
      expect(screen.getByText('Stopped.')).toBeInTheDocument()
      expect(status().textContent).toBe('')
    })

    it('Agent unreachable: the message, with Retry', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select()
      apply({
        seq: 1,
        type: 'error',
        chat_id: 1,
        turn_id: 't',
        code: 'agent_unreachable',
        message: 'Nova could not be reached.',
      })
      expect(screen.getByText('Nova could not be reached.')).toBeInTheDocument()
      // Retry needs a prompt to re-send: the last stored user row is one.
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      act(() => store().setMessages(1, [message(1, 'user', 'earlier')]))
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })

    it('Busy', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select()
      act(() =>
        store().setNotice({
          kind: 'busy',
          message: 'Nova is busy, try again in a minute.',
          chatId: 1,
        })
      )
      expect(
        screen.getByText('Nova is busy, try again in a minute.')
      ).toBeInTheDocument()
    })

    it('Error: the message plus "Try a new chat."', async () => {
      await mount()
      await screen.findByRole('button', { name: 'Open AI chat' })
      select()
      apply({
        seq: 1,
        type: 'error',
        chat_id: 1,
        turn_id: 't',
        code: 'agent_exited',
        message: 'Nova stopped unexpectedly.',
      })
      expect(
        screen.getByText('Nova stopped unexpectedly. Try a new chat.')
      ).toBeInTheDocument()
    })
  })
})

describe('a waiting approval can be reached', () => {
  const card = {
    permission_id: 'p1',
    source: 'agent',
    title: 'Run rm',
    detail: 'rm -rf /tmp/x',
    can_allow: true,
  }
  /** Chat 8 is the most recent; the card waits on chat 7. */
  const seed = () =>
    act(() =>
      store().setChats([chatRow(8), chatRow(7, { pending_approvals: [card] })])
    )

  it('the button opens the chat that holds the card, not the most recent one', async () => {
    await mount()
    const open = await screen.findByRole('button', { name: 'Open AI chat' })
    seed()
    await userEvent.click(open)

    expect(store().open).toBe(true)
    expect(store().activeChatId).toBe(7)
    expect(
      await screen.findByRole('button', { name: 'Allow once' })
    ).toBeInTheDocument()
  })

  it('leaves an active chat alone when it already holds a card', async () => {
    await mount()
    const open = await screen.findByRole('button', { name: 'Open AI chat' })
    act(() =>
      store().setChats([
        chatRow(9, { pending_approvals: [{ ...card, permission_id: 'p9' }] }),
        chatRow(7, { pending_approvals: [card] }),
      ])
    )
    act(() => store().selectChat(9))
    await userEvent.click(open)
    expect(store().activeChatId).toBe(9)
  })

  it('opens the latest chat as before when no card waits', async () => {
    await mount()
    const open = await screen.findByRole('button', { name: 'Open AI chat' })
    act(() => store().setChats([chatRow(8), chatRow(7)]))
    await userEvent.click(open)
    await waitFor(() => expect(store().activeChatId).toBe(8))
  })

  it('marks the rows of the recent-chats menu that hold a card', async () => {
    await mount()
    await screen.findByRole('button', { name: 'Open AI chat' })
    seed()
    act(() => {
      store().selectChat(8)
      store().setOpen(true)
    })
    await userEvent.click(screen.getByRole('button', { name: 'Recent chats' }))
    const rows = await screen.findAllByRole('menuitem')
    const named = (title: string) =>
      rows.find(r => r.textContent?.includes(title))
    expect(named('Chat 7')?.textContent).toContain('Approval waiting')
    expect(named('Chat 8')?.textContent).not.toContain('Approval waiting')
  })
})

describe('New chat', () => {
  it('keeps the agent of the chat it leaves', async () => {
    await mount([NOVA, GEORGE])
    await screen.findByRole('button', { name: 'Open AI chat' })
    act(() => {
      store().setChats([chatRow(3, { provider_id: 2 })])
      store().setMessages(3, [])
      store().selectChat(3)
      store().setOpen(true)
    })
    expect(store().providerId).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(store().activeChatId).toBeNull()
    expect(store().providerId).toBe(2)
    expect(
      screen.getByText('Ask George about the page you are on.')
    ).toBeInTheDocument()
  })
})
