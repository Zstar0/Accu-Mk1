import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CrmError } from '@/lib/api-crm'
import {
  cancelTurn,
  createChat,
  getMessages,
  listChats,
  listProviders,
  sendPrompt,
  type AiChat,
} from '@/lib/ai-chat-api'
import { useAuthStore, type AuthUser } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { useAiChatStore } from '../chat-store'
import { ChatComposer } from '../ChatComposer'

import type * as Api from '@/lib/ai-chat-api'

vi.mock('@/lib/ai-chat-api', async importOriginal => ({
  ...(await importOriginal<typeof Api>()),
  createChat: vi.fn(),
  sendPrompt: vi.fn(),
  cancelTurn: vi.fn(),
  getMessages: vi.fn(),
  listChats: vi.fn(),
  listProviders: vi.fn(),
}))

const mocks = {
  createChat: vi.mocked(createChat),
  sendPrompt: vi.mocked(sendPrompt),
  cancelTurn: vi.mocked(cancelTurn),
  getMessages: vi.mocked(getMessages),
  listChats: vi.mocked(listChats),
  listProviders: vi.mocked(listProviders),
}

const NOVA = { id: 1, slug: 'nova', display_name: 'Nova' }

const chatRow = (id: number, over: Partial<AiChat> = {}): AiChat => ({
  id,
  provider_id: 1,
  title: '',
  archived: false,
  created_at: '2026-11-03T00:00:00Z',
  updated_at: '2026-11-03T00:00:00Z',
  running_turn_id: null,
  pending_approvals: [],
  ...over,
})

const user = (id: number): AuthUser => ({
  id,
  email: `u${id}@example.com`,
  role: 'standard',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  senaite_configured: false,
})

async function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <ChatComposer />
    </QueryClientProvider>
  )
  // The composer needs the provider list for the agent's name.
  const box = await screen.findByPlaceholderText('Message Nova')
  return { qc, box: box as HTMLTextAreaElement }
}

const store = () => useAiChatStore.getState()
const send = () => screen.getByRole('button', { name: 'Send' })

beforeEach(() => {
  act(() => store().reset())
  useAuthStore.setState({ user: user(1), token: 't' })
  useUIStore.setState({
    activeSection: 'dashboard',
    activeSubSection: 'orders',
  })
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.listProviders.mockResolvedValue([NOVA])
  mocks.listChats.mockResolvedValue([chatRow(11)])
  mocks.createChat.mockResolvedValue(chatRow(11))
  mocks.sendPrompt.mockResolvedValue({ turn_id: 't1' })
  mocks.getMessages.mockResolvedValue([])
  mocks.cancelTurn.mockResolvedValue({ cancelled: true })
})

describe('ChatComposer sending', () => {
  it('Enter creates the chat on the first send, sends the prompt with the page, and clears the box', async () => {
    const { box } = await mount()
    await userEvent.type(box, 'hello there{Enter}')

    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(1))
    expect(mocks.createChat).toHaveBeenCalledWith(1)
    expect(mocks.sendPrompt).toHaveBeenCalledWith(11, 'hello there', {
      section: 'dashboard',
      subsection: 'orders',
    })
    expect(box.value).toBe('')
    expect(store().activeChatId).toBe(11)
    // The user's own bubble comes from the server.
    await waitFor(() => expect(mocks.getMessages).toHaveBeenCalledWith(11))
  })

  it('sends into the active chat without creating another', async () => {
    act(() => {
      store().setChats([chatRow(5)])
      store().selectChat(5)
    })
    const { box } = await mount()
    await userEvent.type(box, 'again{Enter}')
    await waitFor(() =>
      expect(mocks.sendPrompt).toHaveBeenCalledWith(
        5,
        'again',
        expect.anything()
      )
    )
    expect(mocks.createChat).not.toHaveBeenCalled()
  })

  it('Shift+Enter adds a newline and sends nothing', async () => {
    const { box } = await mount()
    await userEvent.type(box, 'line one{Shift>}{Enter}{/Shift}line two')
    expect(box.value).toBe('line one\nline two')
    expect(mocks.sendPrompt).not.toHaveBeenCalled()
    expect(mocks.createChat).not.toHaveBeenCalled()
  })

  it('does not send on the Enter that confirms an IME composition', async () => {
    const { box } = await mount()
    fireEvent.change(box, { target: { value: 'konnichiwa' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(mocks.sendPrompt).not.toHaveBeenCalled()
    expect(mocks.createChat).not.toHaveBeenCalled()
    expect(box.value).toBe('konnichiwa')
  })

  it('keeps Send off for an empty or blank box, and caps the length', async () => {
    const { box } = await mount()
    expect(send()).toBeDisabled()
    await userEvent.type(box, '   ')
    expect(send()).toBeDisabled()
    await userEvent.type(box, 'x')
    expect(send()).toBeEnabled()
    expect(box).toHaveAttribute('maxLength', '8000')
  })

  it('clears an old notice when a new prompt goes out', async () => {
    act(() =>
      store().setNotice({
        kind: 'busy',
        message: 'Nova is busy, try again in a minute.',
      })
    )
    const { box } = await mount()
    await userEvent.type(box, 'hi{Enter}')
    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalled())
    expect(store().notice).toBeNull()
  })
})

describe('ChatComposer failures restore the text', () => {
  async function failWith(error: unknown, where: 'send' | 'create' = 'send') {
    if (where === 'send') mocks.sendPrompt.mockRejectedValue(error)
    else mocks.createChat.mockRejectedValue(error)
    const { qc, box } = await mount()
    await userEvent.type(box, 'my question{Enter}')
    await waitFor(() => expect(box.value).toBe('my question'))
    return { qc, box }
  }

  it('429 shows the busy notice', async () => {
    await failWith(new CrmError(429, 'provider_busy'))
    expect(store().notice).toMatchObject({
      kind: 'busy',
      message: 'Nova is busy, try again in a minute.',
    })
  })

  it('409 turn_running is ignored: no notice', async () => {
    await failWith(new CrmError(409, 'turn_running'))
    expect(store().notice).toBeNull()
  })

  it('403 says the chat is gone and refreshes the providers', async () => {
    await failWith(new CrmError(403, 'role_not_allowed'), 'create')
    expect(store().notice).toMatchObject({
      kind: 'error',
      message: 'This chat is not available any more. Try a new chat.',
    })
    // mount() fetched the providers once; the failure fetches them again.
    await waitFor(() => expect(mocks.listProviders).toHaveBeenCalledTimes(2))
  })

  it('404 chat_not_found also clears the active chat', async () => {
    act(() => {
      store().setChats([chatRow(5)])
      store().selectChat(5)
    })
    await failWith(new CrmError(404, 'chat_not_found'))
    expect(store().activeChatId).toBeNull()
    expect(store().notice).toMatchObject({
      kind: 'error',
      message: 'This chat is not available any more. Try a new chat.',
    })
  })

  it('404 provider_not_found says the same', async () => {
    await failWith(new CrmError(404, 'provider_not_found'), 'create')
    expect(store().notice?.message).toBe(
      'This chat is not available any more. Try a new chat.'
    )
  })

  it('422 and anything else say try a new chat', async () => {
    await failWith(new CrmError(422, 'invalid_input'))
    expect(store().notice).toMatchObject({ kind: 'error' })
    expect(store().notice?.message).toMatch(/Try a new chat\.$/)
  })

  it('a network failure says try a new chat too', async () => {
    await failWith(new TypeError('Failed to fetch'))
    expect(store().notice?.message).toMatch(/Try a new chat\.$/)
  })
})

describe('ChatComposer Stop', () => {
  const startTurn = () =>
    act(() => {
      store().setChats([chatRow(5)])
      store().selectChat(5)
      store().apply({
        seq: 1,
        type: 'turn_started',
        chat_id: 5,
        turn_id: 't1',
        starting: false,
        resuming: false,
      })
    })

  it('replaces Send with Stop while a turn runs', async () => {
    startTurn()
    await mount()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(mocks.cancelTurn).toHaveBeenCalledWith(5)
    // {cancelled: true}: turn_ended clears the turn, not this.
    await waitFor(() => expect(mocks.cancelTurn).toHaveBeenCalled())
    expect(store().live[5]).toBeDefined()
  })

  it('Enter does not send while a turn runs', async () => {
    startTurn()
    const { box } = await mount()
    await userEvent.type(box, 'wait{Enter}')
    expect(mocks.sendPrompt).not.toHaveBeenCalled()
    expect(box.value).toBe('wait')
  })

  it('{cancelled: false} means nothing runs: drop the live turn and refetch', async () => {
    mocks.cancelTurn.mockResolvedValue({ cancelled: false })
    startTurn()
    await mount()
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(store().live[5]).toBeUndefined())
    expect(mocks.getMessages).toHaveBeenCalledWith(5)
  })
})

describe('ChatComposer notices and Retry', () => {
  it('shows Retry on an unreachable agent and re-sends the last prompt', async () => {
    const { box } = await mount()
    await userEvent.type(box, 'ping{Enter}')
    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(1))

    act(() =>
      store().setNotice({
        kind: 'unreachable',
        message: 'Nova could not be reached.',
        chatId: 11,
      })
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(2))
    expect(mocks.sendPrompt).toHaveBeenLastCalledWith(
      11,
      'ping',
      expect.anything()
    )
    expect(store().notice).toBeNull()
  })

  describe('Retry after a reload (nothing sent in this session)', () => {
    const stored = {
      id: 1,
      seq: 1,
      role: 'user',
      text: 'earlier question',
      meta: null,
      created_at: '2026-11-03T00:00:00Z',
    }
    const unreachable = () =>
      act(() =>
        store().apply({
          seq: 1,
          type: 'error',
          chat_id: 5,
          turn_id: 't',
          code: 'agent_unreachable',
          message: 'Nova could not be reached.',
        })
      )
    const open = () =>
      act(() => {
        store().setChats([chatRow(5)])
        store().selectChat(5)
      })

    it('re-sends the last stored user row when the transcript was loaded first', async () => {
      open()
      act(() => store().setMessages(5, [stored]))
      await mount()
      unreachable()
      await userEvent.click(
        await screen.findByRole('button', { name: 'Retry' })
      )
      await waitFor(() =>
        expect(mocks.sendPrompt).toHaveBeenCalledWith(
          5,
          'earlier question',
          expect.anything()
        )
      )
    })

    it('offers Retry once the transcript loads after the error arrived', async () => {
      open()
      await mount()
      unreachable()
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()

      act(() => store().setMessages(5, [stored]))
      await userEvent.click(
        await screen.findByRole('button', { name: 'Retry' })
      )
      await waitFor(() =>
        expect(mocks.sendPrompt).toHaveBeenCalledWith(
          5,
          'earlier question',
          expect.anything()
        )
      )
    })
  })

  it('Retry leaves a draft being typed alone, and a failed Retry does not paste the old prompt into the box', async () => {
    const { box } = await mount()
    await userEvent.type(box, 'ping{Enter}')
    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(1))

    act(() =>
      store().setNotice({
        kind: 'unreachable',
        message: 'Nova could not be reached.',
        chatId: 11,
      })
    )
    await userEvent.type(box, 'half a thought')
    mocks.sendPrompt.mockRejectedValue(new CrmError(500, null))
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(store().notice?.kind).toBe('error'))
    expect(box.value).toBe('half a thought')
  })

  it('shows an error notice with "Try a new chat." once', async () => {
    act(() => {
      store().setChats([chatRow(5)])
      store().selectChat(5)
      store().setNotice({
        kind: 'error',
        message: 'The agent exited.',
        chatId: 5,
      })
    })
    await mount()
    expect(
      screen.getByText('The agent exited. Try a new chat.')
    ).toBeInTheDocument()
  })

  it('does not double the suffix a message already carries', async () => {
    act(() => {
      store().setChats([chatRow(5)])
      store().selectChat(5)
      store().setNotice({
        kind: 'error',
        message: 'This chat is not available any more. Try a new chat.',
        chatId: 5,
      })
    })
    await mount()
    expect(
      screen.getByText('This chat is not available any more. Try a new chat.')
    ).toBeInTheDocument()
  })

  it("hides another chat's notice", async () => {
    act(() => {
      store().setChats([chatRow(5), chatRow(6)])
      store().selectChat(5)
      store().setNotice({ kind: 'busy', message: 'Elsewhere', chatId: 6 })
    })
    await mount()
    expect(screen.queryByText('Elsewhere')).toBeNull()
  })

  it('shows Stopped. for a cancelled turn and lets the reader dismiss it', async () => {
    act(() => {
      store().setChats([chatRow(5)])
      store().selectChat(5)
      store().setNotice({ kind: 'cancelled', message: 'Stopped.', chatId: 5 })
    })
    await mount()
    expect(screen.getByText('Stopped.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(store().notice).toBeNull()
  })
})
