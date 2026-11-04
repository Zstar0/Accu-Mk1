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
 * the cleanup of an effect keyed on the id (and on `visible`, so the wipe also
 * runs when the feature goes dark), which runs on unmount (logout) and on any
 * in-place change. Everything that can write late checks the id it started
 * with.
 */

import { useEffect, useRef } from 'react'
import {
  useQuery,
  useQueryClient,
  type Query,
  type QueryClient,
} from '@tanstack/react-query'
import { toast, type ToasterProps } from 'sonner'
import {
  getMessages,
  listChats,
  listProviders,
  type AiChat,
  type AiChatEvent,
  type AiMessage,
  type AiProvider,
} from '@/lib/ai-chat-api'
import { useAiChatStream } from '@/lib/ai-chat-stream'
import { useAuthStore } from '@/store/auth-store'
import { useAiChatStore, type ApprovalCard } from './chat-store'

export const AI_CHAT_KEY = ['ai-chat'] as const
export const CHATS_KEY = ['ai-chat', 'chats'] as const
/** Every user's provider list: what the admin pane marks stale. */
export const PROVIDERS_KEY = ['ai-chat', 'providers'] as const
/** Keyed on the user, so one user's list is never another's. */
export const providersKey = (userId: number | null) =>
  [...PROVIDERS_KEY, userId] as const

const NO_PROVIDERS: AiProvider[] = []

const currentUserId = (): number | null =>
  useAuthStore.getState().user?.id ?? null

// ---- providers -------------------------------------------------------------

function useProvidersQuery() {
  const userId = useAuthStore(s => s.user?.id ?? null)
  return useQuery({
    queryKey: providersKey(userId),
    queryFn: listProviders,
    enabled: userId != null,
    // Not `true`: the app's default stale time would make that a no-op for five
    // minutes after every fetch.
    refetchOnWindowFocus: 'always',
  })
}

/**
 * The providers the signed-in user may use. Empty while loading, on an error
 * and for a user with none: the feature stays dark in all three.
 */
export function useAiProviders(): AiProvider[] {
  const userId = useAuthStore(s => s.user?.id ?? null)
  const { data } = useProvidersQuery()
  return userId == null ? NO_PROVIDERS : (data ?? NO_PROVIDERS)
}

/**
 * The provider the panel talks to: the active chat's, else the one picked,
 * else the first. Null while there is none. A chat whose provider is not in the
 * list (disabled, or the role was taken away) gets the first provider's id, for
 * New chat and the menu, but no other agent's name.
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
  const found = providers.find(p => p.id === wanted)
  if (found !== undefined) return found
  const first = providers[0] ?? null
  return first !== null && chatProviderId !== null
    ? { ...first, display_name: 'The agent' }
    : first
}

// ---- a backend restart mid-turn ---------------------------------------------

/**
 * Chats whose live turn a resync wiped, until a list that landed says what
 * became of them. A restart is the one path with no `turn_ended`, so a partial
 * reply and a card vanish with no other explanation.
 */
const interrupted = new Set<number>()

/** A chat still running needs no words. Any other: its rows tell which it was. */
function explainInterrupted(rows: AiChat[]) {
  for (const chatId of [...interrupted]) {
    const row = rows.find(r => r.id === chatId)
    if (row === undefined || row.running_turn_id !== null) {
      interrupted.delete(chatId)
    } else {
      void explainChat(chatId)
    }
  }
}

async function explainChat(chatId: number): Promise<void> {
  const userId = currentUserId()
  let rows: AiMessage[]
  try {
    rows = await getMessages(chatId)
  } catch {
    return // it stays in the set: the next list that lands asks again
  }
  // False when the wipe got here first, or another list's check did.
  if (currentUserId() !== userId || !interrupted.delete(chatId)) return
  const store = useAiChatStore.getState()
  // An approval row answers nothing: a restart can land while a card is up.
  const last = rows.filter(m => m.role !== 'permission').at(-1)
  if (last?.role === 'user' && store.live[chatId] === undefined) {
    store.raiseNotice({
      kind: 'busy',
      message: 'The reply was interrupted. Send your message again.',
      chatId,
    })
  }
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
    if (currentUserId() !== userId) return
    useAiChatStore.getState().setChats(rows)
    explainInterrupted(rows)
  } catch {
    // The next connect, resync or turn end asks again; a failed list changes nothing.
  }
}

let loadCounter = 0
/** Highest load that has written, per chat. */
const lastWrite = new Map<number, number>()
/**
 * Chats whose last load failed. The next connect tries them again; the catch
 * must not, or the refetch effect would fire at once and loop for as long as
 * the backend is down.
 */
const failedLoads = new Set<number>()

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
    failedLoads.delete(chatId)
    useAiChatStore.getState().setMessages(chatId, rows)
    return true
  } catch {
    // Not for a user who has left: their failures are not the next user's.
    if (currentUserId() === userId) failedLoads.add(chatId)
    return false
  }
}

/** The stream reconnected: load again what failed, once each. */
function retryFailedLoads() {
  for (const id of [...failedLoads]) void loadMessages(id)
}

// ---- approval toasts -------------------------------------------------------

/**
 * The sonner id of the live toast of each card, by permission id. A card stays
 * here after the reader swipes its toast away, so the toast does not come back
 * while the card stays; it leaves when its card goes or comes into view, so a
 * card that returns (a resync, a switch back) is toasted again.
 *
 * Every raise gets its own sonner id. Sonner ignores a `toast()` that reuses
 * the id of a toast it is still removing (about 200 ms after `dismiss`), and a
 * card that comes back right after a resync does exactly that. There is still
 * one live toast per permission id.
 */
const toastIds = new Map<string, string>()
let raised = 0 // never reset: a reused id could meet a toast still leaving

function raiseApprovalToast(card: ApprovalCard, agent: string) {
  const id = `${card.permission_id}#${++raised}`
  toastIds.set(card.permission_id, id)
  toast(`${agent} is waiting for your approval`, {
    id,
    duration: Infinity,
    action: {
      label: 'Open',
      onClick: () => {
        const st = useAiChatStore.getState()
        st.selectChat(card.chatId)
        st.setOpen(true)
      },
    },
  })
}

/** A chat's agent, or "The agent" when its provider is not in the user's list. */
function agentOf(qc: QueryClient, chatId: number): string {
  const providerId = useAiChatStore
    .getState()
    .chats.find(c => c.id === chatId)?.provider_id
  return (
    qc
      .getQueryData<AiProvider[]>(providersKey(currentUserId()))
      ?.find(p => p.id === providerId)?.display_name ?? 'The agent'
  )
}

function handleEvent(qc: QueryClient, e: AiChatEvent) {
  const store = useAiChatStore.getState()
  if (e.type === 'resync') {
    // Before the reducer wipes them.
    for (const id of Object.keys(store.live)) interrupted.add(Number(id))
  }
  const agent = e.type === 'turn_ended' ? agentOf(qc, e.chat_id) : undefined
  store.apply(e, agent)
  // The stream treats a throw as a dropped connection and skips this event.
  try {
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
  for (const id of toastIds.values()) toast.dismiss(id)
  toastIds.clear()
  failedLoads.clear()
  interrupted.clear()
}

// ---- the hook --------------------------------------------------------------

/** Keep in step with `w-[clamp(360px,35vw,720px)]` in `ChatPanel.tsx`. */
const PANEL_WIDTH = 'clamp(360px, 35vw, 720px)'

export function useAiChatGlue(): {
  visible: boolean
  /** For `<Toaster offset>`: clears the button, and the panel while it is open. */
  toasterOffset: ToasterProps['offset']
} {
  const qc = useQueryClient()
  const userId = useAuthStore(s => s.user?.id ?? null)
  const providersQuery = useProvidersQuery()
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
    () => {
      void refreshChats(qc)
      retryFailedLoads()
    }
  )

  // Also when the feature goes dark (the list emptied while signed in): a
  // toast with an Open action, an open panel and a held card would stay behind,
  // and a stream restarted later has no Last-Event-ID, so stale turns would
  // come back as a spinner. Cleanups run before setups, so going dark and
  // coming back in one commit is safe.
  useEffect(() => () => teardown(qc), [qc, userId, visible])

  // The panel vanishes when the list empties, with whatever notice or draft it
  // held. Say why; a user switch or logout is not that.
  const wasVisible = useRef(false)
  const settled = providersQuery.isSuccess
  useEffect(() => {
    if (wasVisible.current && !visible && userId != null && settled) {
      toast('AI chat is no longer available to you.', {
        id: 'ai-chat-unavailable',
      })
    }
    wasVisible.current = visible
  }, [visible, userId, settled])

  // A toast for every card that is not in view, however the card arrived (an
  // event, the chat list after a reload, a resync). It lasts until its card is
  // gone or in view. The agent is the event's name, else from the card's chat.
  const approvals = useAiChatStore(s => s.approvals)
  const open = useAiChatStore(s => s.open)
  const activeChatId = useAiChatStore(s => s.activeChatId)
  const chats = useAiChatStore(s => s.chats)
  useEffect(() => {
    const inView = (card: ApprovalCard) => open && activeChatId === card.chatId
    for (const [permissionId, sonnerId] of [...toastIds]) {
      const card = Object.hasOwn(approvals, permissionId)
        ? approvals[permissionId]
        : undefined
      if (card === undefined || inView(card)) {
        toast.dismiss(sonnerId)
        toastIds.delete(permissionId)
      }
    }
    for (const card of Object.values(approvals)) {
      if (toastIds.has(card.permission_id) || inView(card)) continue
      const providerId = chats.find(c => c.id === card.chatId)?.provider_id
      const agent =
        card.agent ??
        providers.find(p => p.id === providerId)?.display_name ??
        'The agent'
      raiseApprovalToast(card, agent)
    }
  }, [approvals, open, activeChatId, chats, providers])

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

  const toasterOffset: ToasterProps['offset'] = !visible
    ? undefined
    : open
      ? { bottom: 72, right: `calc(${PANEL_WIDTH} + 16px)` }
      : { bottom: 72 }

  return { visible, toasterOffset }
}
