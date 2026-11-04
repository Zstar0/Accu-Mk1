/**
 * App glue for the AI chat: who may use it, the event stream, the chat list,
 * approval toasts, and wiping one user's chats before the next user's start.
 *
 * Call `useAiChatGlue()` once, in `MainWindow`: it opens the one event stream.
 * Anything else that needs the provider list uses `useAiProviders()`.
 *
 * Chat state belongs to one signed-in user. The store and the query client live
 * outside `MainWindow`, and logout unmounts `MainWindow` (`App` renders the
 * login page instead), so the glue cannot watch the id turn null. It wipes in
 * the cleanup of an effect keyed on the id, which runs on unmount (logout) and
 * on any in-place change. Everything that can write late checks the id it
 * started with.
 */

import { useEffect } from 'react'
import {
  useQuery,
  useQueryClient,
  type Query,
  type QueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getMessages,
  listChats,
  listProviders,
  type AiChatEvent,
  type AiProvider,
} from '@/lib/ai-chat-api'
import { useAiChatStream } from '@/lib/ai-chat-stream'
import { useAuthStore } from '@/store/auth-store'
import { useAiChatStore } from './chat-store'

export const AI_CHAT_KEY = ['ai-chat'] as const
export const CHATS_KEY = ['ai-chat', 'chats'] as const
/** Keyed on the user, so one user's list is never another's. */
export const providersKey = (userId: number | null) =>
  ['ai-chat', 'providers', userId] as const

const NO_PROVIDERS: AiProvider[] = []

const currentUserId = (): number | null =>
  useAuthStore.getState().user?.id ?? null

// ---- providers -------------------------------------------------------------

/**
 * The providers the signed-in user may use. Empty while loading, on an error
 * and for a user with none: the feature stays dark in all three.
 */
export function useAiProviders(): AiProvider[] {
  const userId = useAuthStore(s => s.user?.id ?? null)
  const { data } = useQuery({
    queryKey: providersKey(userId),
    queryFn: listProviders,
    enabled: userId != null,
  })
  return userId == null ? NO_PROVIDERS : (data ?? NO_PROVIDERS)
}

/**
 * The provider the panel talks to: the active chat's, else the one picked,
 * else the first. Null while there is none.
 */
export function useActiveProvider(): AiProvider | null {
  const providers = useAiProviders()
  const providerId = useAiChatStore(s => s.providerId)
  const chatProviderId = useAiChatStore(s =>
    s.activeChatId === null
      ? null
      : (s.chats.find(c => c.id === s.activeChatId)?.provider_id ?? null)
  )
  const wanted = chatProviderId ?? providerId
  return providers.find(p => p.id === wanted) ?? providers[0] ?? null
}

// ---- fetching --------------------------------------------------------------

/**
 * Fetch the chat list fresh and put it in the store. A fetch already in flight
 * is cancelled, not joined: it may have been answered before the event that
 * made us ask. The cancel happens before the first `await`, so a caller that
 * has just created a chat has already ended the older fetch when this returns
 * its promise. Never rejects.
 */
export async function refreshChats(qc: QueryClient): Promise<void> {
  const userId = currentUserId()
  try {
    await qc.cancelQueries({ queryKey: CHATS_KEY })
    const rows = await qc.fetchQuery({
      queryKey: CHATS_KEY,
      queryFn: listChats,
      staleTime: 0,
    })
    if (currentUserId() === userId) useAiChatStore.getState().setChats(rows)
  } catch {
    // The next connect, resync or turn end asks again; a failed list changes nothing.
  }
}

let loadCounter = 0
/** Highest load that has written, per chat. */
const lastWrite = new Map<number, number>()

/**
 * Fetch a chat's messages into the store. The refetch flag is cleared first,
 * so an event that lands during the fetch sets it again. A load older than one
 * that already wrote is dropped, and so is one for a user who has left. Never
 * rejects; resolves true when it wrote.
 */
export async function loadMessages(chatId: number): Promise<boolean> {
  const userId = currentUserId()
  const mine = ++loadCounter
  useAiChatStore.getState().clearRefetch([chatId])
  try {
    const rows = await getMessages(chatId)
    if (currentUserId() !== userId) return false
    if ((lastWrite.get(chatId) ?? 0) > mine) return false
    lastWrite.set(chatId, mine)
    useAiChatStore.getState().setMessages(chatId, rows)
    return true
  } catch {
    return false
  }
}

// ---- approval toasts -------------------------------------------------------

/** Sonner ids (= permission ids) of the toasts that are up. */
const toasted = new Set<string>()

function toastForApproval(
  e: Extract<AiChatEvent, { type: 'permission_requested' }>
) {
  const s = useAiChatStore.getState()
  // The card is already in view.
  if (s.open && s.activeChatId === e.chat_id) return
  toasted.add(e.permission_id)
  toast(`${e.agent} is waiting for your approval`, {
    id: e.permission_id,
    duration: Infinity,
    action: {
      label: 'Open',
      onClick: () => {
        const st = useAiChatStore.getState()
        st.selectChat(e.chat_id)
        st.setOpen(true)
      },
    },
  })
}

function handleEvent(qc: QueryClient, e: AiChatEvent) {
  useAiChatStore.getState().apply(e)
  // The stream treats a throw as a dropped connection and skips this event.
  try {
    if (e.type === 'permission_requested') toastForApproval(e)
    if (e.type === 'turn_ended' || e.type === 'resync') void refreshChats(qc)
  } catch {
    // A side effect must not cost the stream the event the store already took.
  }
}

// ---- wiping one user's chats -----------------------------------------------

function teardown(qc: QueryClient) {
  // Keep the providers query of whoever is signed in now (nobody, on logout):
  // removing a query a mounted observer just built would leave it detached.
  const now = currentUserId()
  const filters = {
    queryKey: AI_CHAT_KEY,
    predicate: (q: Query) =>
      !(now !== null && q.queryKey[1] === 'providers' && q.queryKey[2] === now),
  }
  void qc.cancelQueries(filters)
  qc.removeQueries(filters)
  useAiChatStore.getState().reset()
  for (const id of toasted) toast.dismiss(id)
  toasted.clear()
}

// ---- the hook --------------------------------------------------------------

export function useAiChatGlue(): { visible: boolean } {
  const qc = useQueryClient()
  const userId = useAuthStore(s => s.user?.id ?? null)
  const providers = useAiProviders()
  const visible = userId != null && providers.length > 0

  // The stream is declared before the wipe below: on unmount or a user change
  // React runs cleanups in declaration order, so the connection is closed
  // before the store is reset and no late event can refill it. `visible` also
  // flips with the user (the provider query is keyed on the id), so even a
  // direct A to B change restarts the stream under B's token.
  useAiChatStream(
    visible,
    e => handleEvent(qc, e),
    () => void refreshChats(qc)
  )

  useEffect(() => () => teardown(qc), [qc, userId])

  // A toast lasts until its card is gone or in view.
  const approvals = useAiChatStore(s => s.approvals)
  const open = useAiChatStore(s => s.open)
  const activeChatId = useAiChatStore(s => s.activeChatId)
  useEffect(() => {
    for (const id of [...toasted]) {
      const card = Object.hasOwn(approvals, id) ? approvals[id] : undefined
      if (card === undefined || (open && activeChatId === card.chatId)) {
        toast.dismiss(id)
        toasted.delete(id)
      }
    }
  }, [approvals, open, activeChatId])

  // A turn ended (or the stream resynced): fetch the stored rows of the chats
  // the panel has loaded. An unloaded chat stays flagged; whoever loads it
  // clears the flag first.
  const needsRefetch = useAiChatStore(s => s.needsRefetch)
  const messages = useAiChatStore(s => s.messages)
  useEffect(() => {
    for (const id of needsRefetch) {
      if (messages[id] !== undefined) void loadMessages(id)
    }
  }, [needsRefetch, messages])

  return { visible }
}
