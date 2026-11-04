import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getMessages,
  listChats,
  listProviders,
  type AiChat,
  type AiChatEvent,
  type AiMessage,
} from '@/lib/ai-chat-api'
import { useAiChatStream } from '@/lib/ai-chat-stream'
import { useAuthStore, type AuthUser } from '@/store/auth-store'
import { useAiChatStore } from '../chat-store'
import {
  CHATS_KEY,
  loadMessages,
  providersKey,
  refreshChats,
  useAiChatGlue,
} from '../use-ai-chat-glue'

import type * as Api from '@/lib/ai-chat-api'

vi.mock('@/lib/ai-chat-api', async importOriginal => ({
  ...(await importOriginal<typeof Api>()),
  getMessages: vi.fn(),
  listChats: vi.fn(),
  listProviders: vi.fn(),
}))
vi.mock('@/lib/ai-chat-stream', () => ({ useAiChatStream: vi.fn() }))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
}))

const stream = vi.mocked(useAiChatStream)
const showToast = vi.mocked(toast)
const dismissToast = vi.mocked(toast.dismiss)
const mocks = {
  getMessages: vi.mocked(getMessages),
  listChats: vi.mocked(listChats),
  listProviders: vi.mocked(listProviders),
}

const NOVA = { id: 1, slug: 'nova', display_name: 'Nova' }
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

const message = (seq: number, text = `m${seq}`): AiMessage => ({
  id: seq,
  seq,
  role: 'user',
  text,
  meta: null,
  created_at: '2026-11-03T00:00:00Z',
})

let seq = 0
const permissionEvent = (id: string, chat_id = 1): AiChatEvent => ({
  seq: ++seq,
  type: 'permission_requested',
  chat_id,
  turn_id: 't1',
  permission_id: id,
  source: 'agent',
  title: 'Run ls',
  detail: 'ls',
  can_allow: true,
  agent: 'Nova',
})
const resolvedEvent = (id: string, chat_id = 1): AiChatEvent => ({
  seq: ++seq,
  type: 'permission_resolved',
  chat_id,
  turn_id: 't1',
  permission_id: id,
  decision: 'allow',
})
const endedEvent = (chat_id = 1): AiChatEvent => ({
  seq: ++seq,
  type: 'turn_ended',
  chat_id,
  turn_id: 't1',
  stop_reason: 'end_turn',
  message_seq: null,
})
const resyncEvent = (): AiChatEvent => ({
  seq: ++seq,
  type: 'resync',
  chat_id: null,
  turn_id: null,
})

function Harness() {
  const { visible } = useAiChatGlue()
  return <div data-testid="visible">{String(visible)}</div>
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>
  )
  return { qc, ...view }
}

/** The arguments the glue gave the stream hook on its latest render. */
const lastStream = () => {
  const call = stream.mock.calls.at(-1)
  if (!call) throw new Error('useAiChatStream was never called')
  return { enabled: call[0], onEvent: call[1], onConnected: call[2] }
}
const deliver = (e: AiChatEvent) => act(() => lastStream().onEvent(e))
const connect = () => act(() => lastStream().onConnected?.())

beforeEach(() => {
  act(() => store().reset())
  useAuthStore.setState({ user: user(1), token: 't' })
  stream.mockReset()
  showToast.mockReset()
  dismissToast.mockReset()
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.listProviders.mockResolvedValue([NOVA])
  mocks.listChats.mockResolvedValue([])
  mocks.getMessages.mockResolvedValue([])
})

describe('visibility', () => {
  it('stays dark, with the stream off, when the user has no provider', async () => {
    mocks.listProviders.mockResolvedValue([])
    setup()
    await waitFor(() => expect(mocks.listProviders).toHaveBeenCalled())
    expect(screen.getByTestId('visible')).toHaveTextContent('false')
    expect(stream.mock.calls.every(c => c[0] === false)).toBe(true)
  })

  it('stays dark when the provider request fails', async () => {
    mocks.listProviders.mockRejectedValue(new Error('403'))
    setup()
    await waitFor(() => expect(mocks.listProviders).toHaveBeenCalled())
    expect(screen.getByTestId('visible')).toHaveTextContent('false')
    expect(stream.mock.calls.every(c => c[0] === false)).toBe(true)
  })

  it('shows and opens the stream once a provider is available', async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByTestId('visible')).toHaveTextContent('true')
    )
    expect(lastStream().enabled).toBe(true)
  })

  it('stays dark with nobody signed in', async () => {
    useAuthStore.setState({ user: null })
    setup()
    expect(mocks.listProviders).not.toHaveBeenCalled()
    expect(screen.getByTestId('visible')).toHaveTextContent('false')
    expect(lastStream().enabled).toBe(false)
  })
})

describe('the chat list', () => {
  it('is fetched on connect, not on mount', async () => {
    mocks.listChats.mockResolvedValue([chatRow(3)])
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    expect(mocks.listChats).not.toHaveBeenCalled()

    connect()
    await waitFor(() => expect(store().chats.map(c => c.id)).toEqual([3]))
    expect(mocks.listChats).toHaveBeenCalledTimes(1)
  })

  it('is fetched again on every connect, even inside the stale time', async () => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    connect()
    await waitFor(() => expect(mocks.listChats).toHaveBeenCalledTimes(1))
    connect()
    await waitFor(() => expect(mocks.listChats).toHaveBeenCalledTimes(2))
  })

  it.each([
    ['turn_ended', endedEvent],
    ['resync', resyncEvent],
  ])('is fetched again on %s', async (_name, make) => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    deliver(make())
    await waitFor(() => expect(mocks.listChats).toHaveBeenCalledTimes(1))
  })

  it('a failed fetch changes nothing and throws nowhere', async () => {
    mocks.listChats.mockRejectedValue(new Error('down'))
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    connect()
    await waitFor(() => expect(mocks.listChats).toHaveBeenCalled())
    expect(store().chats).toEqual([])
  })
})

describe('approval toasts', () => {
  it('raises one toast per permission, by its id, until it is answered', async () => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    deliver(permissionEvent('p1'))

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith(
      'Nova is waiting for your approval',
      expect.objectContaining({ id: 'p1', duration: Infinity })
    )
    expect(dismissToast).not.toHaveBeenCalled()

    deliver(resolvedEvent('p1'))
    await waitFor(() => expect(dismissToast).toHaveBeenCalledWith('p1'))
  })

  it('its action opens the panel on that chat', async () => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    deliver(permissionEvent('p1', 4))
    const options = showToast.mock.calls[0]?.[1] as unknown as {
      action: { onClick: () => void }
    }
    act(() => options.action.onClick())
    expect(store()).toMatchObject({ open: true, activeChatId: 4 })
    // The card is in view now, so the toast goes.
    await waitFor(() => expect(dismissToast).toHaveBeenCalledWith('p1'))
  })

  it('raises none when the panel is open on that chat', async () => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    act(() => {
      store().setChats([chatRow(1)])
      store().selectChat(1)
      store().setOpen(true)
    })
    deliver(permissionEvent('p1', 1))
    expect(showToast).not.toHaveBeenCalled()
  })

  it('raises one when the panel is open on another chat', async () => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    act(() => {
      store().setChats([chatRow(1), chatRow(2)])
      store().selectChat(2)
      store().setOpen(true)
    })
    deliver(permissionEvent('p1', 1))
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it('is dismissed when the reader dismisses a stale card', async () => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    deliver(permissionEvent('p1'))
    act(() => store().dismissApproval('p1'))
    await waitFor(() => expect(dismissToast).toHaveBeenCalledWith('p1'))
  })

  it('is dismissed on resync, which drops every card', async () => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    deliver(permissionEvent('p1'))
    deliver(resyncEvent())
    await waitFor(() => expect(dismissToast).toHaveBeenCalledWith('p1'))
  })
})

describe('refetching messages', () => {
  it('refetches a loaded chat after its turn ends, then clears the flag', async () => {
    mocks.getMessages.mockResolvedValue([message(1), message(2, 'reply')])
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    act(() => store().setMessages(1, [message(1)]))
    deliver(endedEvent(1))

    await waitFor(() => expect(mocks.getMessages).toHaveBeenCalledWith(1))
    await waitFor(() =>
      expect(store().messages[1]?.map(m => m.text)).toEqual(['m1', 'reply'])
    )
    expect(store().needsRefetch).toEqual([])
  })

  it('leaves a chat the panel never loaded flagged, and does not fetch it', async () => {
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    deliver(endedEvent(9))
    await waitFor(() => expect(store().needsRefetch).toEqual([9]))
    expect(mocks.getMessages).not.toHaveBeenCalled()
  })

  it('a failed refetch keeps the provisional row and throws nowhere', async () => {
    mocks.getMessages.mockRejectedValue(new Error('down'))
    setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    act(() => store().setMessages(1, [message(1)]))
    deliver({
      seq: ++seq,
      type: 'message_chunk',
      chat_id: 1,
      turn_id: 't1',
      text: 'partial reply',
    })
    deliver({ ...endedEvent(1), message_seq: 2 } as AiChatEvent)

    await waitFor(() => expect(mocks.getMessages).toHaveBeenCalled())
    expect(store().messages[1]?.map(m => m.text)).toEqual([
      'm1',
      'partial reply',
    ])
  })
})

describe('late writes', () => {
  it('loadMessages drops a result that arrives after the user changed', async () => {
    let finish: (rows: AiMessage[]) => void = () => undefined
    mocks.getMessages.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const pending = loadMessages(1)
    useAuthStore.setState({ user: user(2) })
    finish([message(1, "user one's secret")])
    expect(await pending).toBe(false)
    expect(store().messages).toEqual({})
  })

  it('loadMessages drops a load that a newer one already overtook', async () => {
    const resolvers: ((rows: AiMessage[]) => void)[] = []
    mocks.getMessages.mockImplementation(
      () => new Promise(resolve => resolvers.push(resolve))
    )
    const first = loadMessages(1)
    const second = loadMessages(1)
    resolvers[1]?.([message(1, 'new')])
    expect(await second).toBe(true)
    resolvers[0]?.([message(1, 'old')])
    expect(await first).toBe(false)
    expect(store().messages[1]?.[0]?.text).toBe('new')
  })

  it('refreshChats drops a list that arrives after the user changed', async () => {
    let finish: (rows: AiChat[]) => void = () => undefined
    mocks.listChats.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const qc = new QueryClient()
    const pending = refreshChats(qc)
    await waitFor(() => expect(mocks.listChats).toHaveBeenCalled())
    useAuthStore.setState({ user: user(2) })
    finish([chatRow(1)])
    await pending
    expect(store().chats).toEqual([])
  })

  it('refreshChats restarts a fetch already in flight instead of joining it', async () => {
    const resolvers: ((rows: AiChat[]) => void)[] = []
    mocks.listChats.mockImplementation(
      () => new Promise(resolve => resolvers.push(resolve))
    )
    const qc = new QueryClient()
    const first = refreshChats(qc)
    await waitFor(() => expect(resolvers).toHaveLength(1))
    const second = refreshChats(qc)
    await waitFor(() => expect(resolvers).toHaveLength(2))
    resolvers[0]?.([chatRow(1)]) // the older answer must not land
    resolvers[1]?.([chatRow(1), chatRow(2)])
    await Promise.all([first, second])
    expect(store().chats.map(c => c.id)).toEqual([1, 2])
  })
})

describe('one user to the next', () => {
  /** A user with chats loaded, a card up, and cached queries. */
  async function fillFor1() {
    mocks.listChats.mockResolvedValue([chatRow(3)])
    const view = setup()
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    connect()
    await waitFor(() => expect(store().chats).toHaveLength(1))
    act(() => {
      store().setMessages(3, [message(1, "user one's chat")])
      store().selectChat(3)
      store().setOpen(true)
      store().setNotice({ kind: 'error', message: 'old notice', chatId: 3 })
    })
    deliver(permissionEvent('p1', 7))
    expect(showToast).toHaveBeenCalledTimes(1)
    return view
  }

  const nothingLeft = (qc: QueryClient, keep?: readonly unknown[]) => {
    const left = qc
      .getQueryCache()
      .findAll({ queryKey: ['ai-chat'] })
      .map(q => q.queryKey)
    expect(left).toEqual(keep ? [keep] : [])
  }

  it('logout (the glue unmounts): the store is initial, the queries are gone, the toast is down', async () => {
    const { qc, unmount } = await fillFor1()
    expect(qc.getQueryData(CHATS_KEY)).toBeDefined()

    // `clearAuth` flips `isAuthenticated`; `App` then drops `MainWindow`.
    act(() => useAuthStore.setState({ user: null, token: null }))
    unmount()

    expect(store()).toEqual(useAiChatStore.getInitialState())
    nothingLeft(qc)
    expect(dismissToast).toHaveBeenCalledWith('p1')
  })

  it('a direct switch to another user: stream closes, store and queries are wiped, no toast survives', async () => {
    const { qc } = await fillFor1()
    expect(qc.getQueryData(providersKey(1))).toBeDefined()
    stream.mockClear()

    act(() => useAuthStore.setState({ user: user(2), token: 't2' }))

    expect(store()).toEqual(useAiChatStore.getInitialState())
    expect(dismissToast).toHaveBeenCalledWith('p1')
    // The stream was off for user 2's first render, so it cannot carry on
    // under user 1's connection and token...
    expect(stream.mock.calls[0]?.[0]).toBe(false)
    // ...and comes back, for user 2, once 2's providers arrive.
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    // Only user 2's provider list remains of anything cached.
    nothingLeft(qc, providersKey(2))
    expect(qc.getQueryData(providersKey(1))).toBeUndefined()
  })

  it('does not wipe when the same user is refreshed', async () => {
    await fillFor1()
    const before = store()
    act(() => useAuthStore.setState({ user: { ...user(1), first_name: 'A' } }))
    expect(store().chats).toBe(before.chats)
    expect(store().messages).toBe(before.messages)
    expect(dismissToast).not.toHaveBeenCalled()
  })
})
