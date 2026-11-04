/**
 * The real sonner, not a mock. Sonner 2.0.7 ignores a `toast()` that reuses the
 * id of a toast it is still removing (about 200 ms after `dismiss`), so a card
 * that returns right after a resync must not reuse the id of the toast the
 * resync just dismissed. A mock that only counts `toast()` calls cannot see
 * that; this renders the `Toaster` and looks at the DOM.
 *
 * A swallowed toast is not absent from the DOM: the dismissed one lingers with
 * `data-removed="true"` (CSS hides it in a browser, jsdom has none). So the
 * test counts toasts that are not marked removed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import {
  listChats,
  listProviders,
  type AiChat,
  type AiChatEvent,
} from '@/lib/ai-chat-api'
import type * as Api from '@/lib/ai-chat-api'
import { useAiChatStream } from '@/lib/ai-chat-stream'
import { useAuthStore } from '@/store/auth-store'
import { useAiChatStore } from '../chat-store'
import { useAiChatGlue } from '../use-ai-chat-glue'

vi.mock('@/lib/ai-chat-api', async importOriginal => ({
  ...(await importOriginal<typeof Api>()),
  getMessages: vi.fn(),
  listChats: vi.fn(),
  listProviders: vi.fn(),
}))
vi.mock('@/lib/ai-chat-stream', () => ({ useAiChatStream: vi.fn() }))

const stream = vi.mocked(useAiChatStream)
const store = () => useAiChatStore.getState()
const TEXT = 'Nova is waiting for your approval'

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

const lastStream = () => {
  const call = stream.mock.calls.at(-1)
  if (!call) throw new Error('useAiChatStream was never called')
  return { enabled: call[0], onEvent: call[1] }
}
const deliver = (e: AiChatEvent) => act(() => lastStream().onEvent(e))
const pause = (ms: number) =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })

function Harness() {
  useAiChatGlue()
  return null
}

beforeEach(() => {
  act(() => store().reset())
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'u1@example.com',
      role: 'standard',
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
      senaite_configured: false,
    },
    token: 't',
  })
  stream.mockReset()
  vi.mocked(listProviders).mockReset()
  vi.mocked(listChats).mockReset()
  vi.mocked(listProviders).mockResolvedValue([
    { id: 1, slug: 'nova', display_name: 'Nova' },
  ])
})

describe('approval toasts with the real sonner', () => {
  it('shows the toast of a card that comes back from a resync at once', async () => {
    const card = {
      permission_id: 'p1',
      source: 'agent',
      title: 'Run ls',
      detail: 'ls',
      can_allow: true,
    }
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Harness />
        <Toaster />
      </QueryClientProvider>
    )
    await waitFor(() => expect(lastStream().enabled).toBe(true))
    act(() => store().setChats([chatRow(7)]))

    deliver({
      seq: 1,
      type: 'permission_requested',
      chat_id: 7,
      turn_id: 't1',
      permission_id: 'p1',
      source: 'agent',
      title: 'Run ls',
      detail: 'ls',
      can_allow: true,
      agent: 'Nova',
    })
    expect(await screen.findByText(TEXT)).toBeInTheDocument()

    // The resync empties the cards, which dismisses the toast; the list that
    // follows (it answers at once here, as it usually does) brings the card
    // back inside the 200 ms sonner takes to remove the old toast.
    vi.mocked(listChats).mockResolvedValue([
      chatRow(7, { pending_approvals: [card] }),
    ])
    deliver({ seq: 2, type: 'resync', chat_id: null, turn_id: null })
    await waitFor(() => expect(Object.keys(store().approvals)).toEqual(['p1']))

    // Long enough for the dismissed toast to have gone: what is left, and not
    // marked removed, must be the new one.
    await pause(800)
    const alive = Array.from(
      document.querySelectorAll('[data-sonner-toast]')
    ).filter(el => el.getAttribute('data-removed') !== 'true')
    expect(alive).toHaveLength(1)
    expect(alive[0]).toHaveTextContent(TEXT)
  })
})
