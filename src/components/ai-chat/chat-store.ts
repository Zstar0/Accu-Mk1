/**
 * AI chat client state: what the server told us about chats and messages, what
 * is streaming right now, and the panel's own UI state.
 *
 * `applyEvent` is the reducer for the SSE events. It is pure (the timestamp of
 * a provisional row is a parameter) and must never throw: `useAiChatStream`
 * treats an exception in its callback as a dropped connection and skips the
 * event on reconnect. So no branch assumes the page saw the turn start, and
 * none assumes the chat is in `chats` (it may have been created in another tab).
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type {
  AiChat,
  AiChatEvent,
  AiMessage,
  PendingApproval,
} from '@/lib/ai-chat-api'

/**
 * One tool call, in the shape the backend stores in an assistant row's
 * `meta.tools` (`sessions.py`), so a live chip and a stored one are alike.
 * `title` is null for a tool the page only saw an update for.
 */
export interface ToolChip {
  id: string
  title: string | null
  kind: string | null
  status: string | null
}

export type LivePhase = 'starting' | 'resuming' | 'running' | 'waiting'

/** The turn streaming into a chat right now. */
export interface LiveTurn {
  turnId: string
  text: string
  thought: string
  tools: Record<string, ToolChip>
  phase: LivePhase
}

export type ApprovalCard = PendingApproval & { chatId: number }

export interface ChatData {
  chats: AiChat[]
  messages: Record<number, AiMessage[]>
  live: Record<number, LiveTurn>
  /** By `permission_id`. */
  approvals: Record<string, ApprovalCard>
  /** Chats whose messages must be fetched again; the glue clears them. */
  needsRefetch: number[]
}

export interface ChatNotice {
  kind: 'busy' | 'unreachable' | 'error' | 'cancelled'
  message: string
  /** Show only on this chat; none means any chat. */
  chatId?: number
}

// ---- reducer ---------------------------------------------------------------

const hasCard = (approvals: Record<string, ApprovalCard>, chatId: number) =>
  Object.values(approvals).some(card => card.chatId === chatId)

/** A turn that is running, or waits while its chat has a card open. */
const phaseFor = (
  approvals: Record<string, ApprovalCard>,
  chatId: number
): LivePhase => (hasCard(approvals, chatId) ? 'waiting' : 'running')

const freshTurn = (turnId: string, phase: LivePhase): LiveTurn => ({
  turnId,
  text: '',
  thought: '',
  tools: {},
  phase,
})

/**
 * The chat's live turn for `e`, started on the spot when the page never saw
 * `turn_started` (reload mid-turn). A turn id that differs means a new turn:
 * the server runs one at a time, so the old one is over.
 */
function liveFor(
  data: ChatData,
  e: { chat_id: number; turn_id: string }
): LiveTurn {
  const current = data.live[e.chat_id]
  return current?.turnId === e.turn_id
    ? current
    : freshTurn(e.turn_id, phaseFor(data.approvals, e.chat_id))
}

/** A first sign of life ends starting and resuming; waiting stays waiting. */
const afterActivity = (phase: LivePhase): LivePhase =>
  phase === 'starting' || phase === 'resuming' ? 'running' : phase

const withLive = (
  data: ChatData,
  chatId: number,
  turn: LiveTurn
): ChatData => ({
  ...data,
  live: { ...data.live, [chatId]: turn },
})

/** A copy of `rec` without `key` (a key like `__proto__` stays a plain key). */
function omit<K extends string | number, V>(
  rec: Record<K, V>,
  key: K
): Record<K, V> {
  return Object.fromEntries(
    Object.entries(rec).filter(([k]) => k !== String(key))
  ) as Record<K, V>
}

/** Union by `seq`, ordered; on a clash the `incoming` row wins. */
function mergeBySeq(base: AiMessage[], incoming: AiMessage[]): AiMessage[] {
  const bySeq = new Map<number, AiMessage>()
  for (const m of base) bySeq.set(m.seq, m)
  for (const m of incoming) bySeq.set(m.seq, m)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Remove a card, and put the chat's turn back to running when that was its
 * last one. Nothing to change: the same object back.
 */
function dropCard(
  data: ChatData,
  permissionId: string,
  chatId: number
): ChatData {
  const known = Object.hasOwn(data.approvals, permissionId)
  const approvals = omit(data.approvals, permissionId)
  const turn = data.live[chatId]
  // Back to running only when no other card of this chat is open.
  const resumes = turn?.phase === 'waiting' && !hasCard(approvals, chatId)
  if (!known && !resumes) return data
  return {
    ...data,
    approvals,
    live:
      turn && resumes
        ? { ...data.live, [chatId]: { ...turn, phase: 'running' } }
        : data.live,
  }
}

/**
 * `now` stamps a provisional row (default: the clock; pass it in a test). An event with an unknown
 * `type` (a newer server) and `error` (a `turn_ended` follows it) change nothing.
 */
export function applyEvent(
  data: ChatData,
  e: AiChatEvent,
  now?: string
): ChatData {
  switch (e.type) {
    case 'turn_started': {
      const phase = e.starting
        ? 'starting'
        : e.resuming
          ? 'resuming'
          : 'running'
      return withLive(data, e.chat_id, freshTurn(e.turn_id, phase))
    }

    case 'message_chunk': {
      const turn = liveFor(data, e)
      return withLive(data, e.chat_id, {
        ...turn,
        text: turn.text + e.text,
        phase: afterActivity(turn.phase),
      })
    }

    case 'thought_chunk': {
      const turn = liveFor(data, e)
      return withLive(data, e.chat_id, {
        ...turn,
        thought: turn.thought + e.text,
        phase: afterActivity(turn.phase),
      })
    }

    case 'tool_call': {
      const turn = liveFor(data, e)
      const chip: ToolChip = {
        id: e.id,
        title: e.title,
        kind: e.kind,
        status: e.status,
      }
      return withLive(data, e.chat_id, {
        ...turn,
        tools: { ...turn.tools, [e.id]: chip },
        phase: afterActivity(turn.phase),
      })
    }

    case 'tool_call_update': {
      const turn = liveFor(data, e)
      // `hasOwn`: an id such as `constructor` must not find an inherited member.
      const known = Object.hasOwn(turn.tools, e.id)
        ? turn.tools[e.id]
        : undefined
      const prev = known ?? { id: e.id, title: null, kind: null, status: null }
      // Like the backend: a null field means unchanged.
      const chip: ToolChip = {
        ...prev,
        title: e.title ?? prev.title,
        status: e.status ?? prev.status,
      }
      return withLive(data, e.chat_id, {
        ...turn,
        tools: { ...turn.tools, [e.id]: chip },
        phase: afterActivity(turn.phase),
      })
    }

    case 'permission_requested': {
      const turn = liveFor(data, e)
      const card: ApprovalCard = {
        permission_id: e.permission_id,
        source: e.source,
        title: e.title,
        detail: e.detail,
        can_allow: e.can_allow,
        hidden: e.hidden,
        chatId: e.chat_id,
      }
      return {
        ...withLive(data, e.chat_id, { ...turn, phase: 'waiting' }),
        approvals: { ...data.approvals, [e.permission_id]: card },
      }
    }

    case 'permission_resolved':
      return dropCard(data, e.permission_id, e.chat_id)

    case 'turn_ended': {
      // Only this turn's own live state is its to read or to remove.
      const turn =
        data.live[e.chat_id]?.turnId === e.turn_id
          ? data.live[e.chat_id]
          : undefined
      const live = turn ? omit(data.live, e.chat_id) : data.live

      // Keep the reply on screen until the refetch returns the stored row. A
      // turn with no text (a reload seeded it from the chat list) has none to
      // keep, and an empty bubble would show until the refetch lands.
      const loaded = data.messages[e.chat_id]
      const seqKnown = loaded?.some(m => m.seq === e.message_seq)
      const messages =
        turn &&
        turn.text !== '' &&
        loaded &&
        typeof e.message_seq === 'number' &&
        !seqKnown
          ? {
              ...data.messages,
              [e.chat_id]: mergeBySeq(loaded, [
                {
                  id: -e.message_seq,
                  seq: e.message_seq,
                  role: 'assistant',
                  text: turn.text,
                  meta: {
                    tools: Object.values(turn.tools),
                    stop_reason: e.stop_reason,
                  },
                  created_at: now ?? new Date().toISOString(),
                },
              ]),
            }
          : data.messages

      return {
        ...data,
        live,
        messages,
        needsRefetch: data.needsRefetch.includes(e.chat_id)
          ? data.needsRefetch
          : [...data.needsRefetch, e.chat_id],
      }
    }

    case 'resync': {
      // `Object.keys` gives strings; the flags are chat ids.
      const loaded = Object.keys(data.messages).map(Number)
      return {
        ...data,
        live: {},
        approvals: {},
        needsRefetch: [...new Set([...data.needsRefetch, ...loaded])],
      }
    }

    default:
      return data
  }
}

/** The notice an event also raises; `applyEvent` stays about chat data. */
function noticeFor(
  e: AiChatEvent,
  agent: string,
  current: ChatNotice | null
): ChatNotice | null {
  if (e.type === 'error') {
    return {
      kind: e.code === 'agent_unreachable' ? 'unreachable' : 'error',
      message: e.message,
      chatId: e.chat_id,
    }
  }
  if (e.type !== 'turn_ended') return null
  if (e.stop_reason === 'cancelled') {
    return { kind: 'cancelled', message: 'Stopped.', chatId: e.chat_id }
  }
  if (typeof e.message_seq === 'number') return null
  // The `error` event ahead of this one has already said why, with its advice
  // or its Retry.
  const explained =
    current?.chatId === e.chat_id &&
    (current.kind === 'error' || current.kind === 'unreachable')
  return explained
    ? null
    : {
        // `busy`: an `error` notice would append "Try a new chat."
        kind: 'busy',
        message: `${agent} ended without a reply.`,
        chatId: e.chat_id,
      }
}

/**
 * Fold a fresh chat list in. Cards and live turns are only ever added here: a
 * list fetched before an event can land after it, and must not undo it.
 */
function withChatList(data: ChatData, rows: AiChat[]): ChatData {
  const fromRows = Object.fromEntries(
    rows.flatMap(row =>
      row.pending_approvals.map(card => [
        card.permission_id,
        { ...card, chatId: row.id },
      ])
    )
  ) as Record<string, ApprovalCard>
  // Cards already held win: they are the ones on screen.
  const approvals = { ...fromRows, ...data.approvals }

  // A reload mid-turn has nothing but the list to say a turn runs.
  const live = { ...data.live }
  for (const row of rows) {
    if (row.running_turn_id && live[row.id] === undefined) {
      live[row.id] = freshTurn(row.running_turn_id, phaseFor(approvals, row.id))
    }
  }
  return { ...data, chats: rows, approvals, live }
}

// ---- selectors over the data ----------------------------------------------

/** Any chat waits on an approval. */
export const hasPendingApproval = (data: ChatData): boolean =>
  Object.keys(data.approvals).length > 0

/** Any chat has a turn in progress (waiting for approval included). */
export const isRunning = (data: ChatData): boolean =>
  Object.keys(data.live).length > 0

// ---- store -----------------------------------------------------------------

/** Everything the store holds except its actions. */
interface AiChatFields extends ChatData {
  open: boolean
  activeChatId: number | null
  providerId: number | null
  notice: ChatNotice | null
}

/**
 * The starting state, written once: the store is created from it and `reset`
 * returns to it. Typed, so a field added to `AiChatFields` fails to compile
 * until it is listed here. Fresh containers on every call.
 */
const initialFields = (): AiChatFields => ({
  chats: [],
  messages: {},
  live: {},
  approvals: {},
  needsRefetch: [],
  open: false,
  activeChatId: null,
  providerId: null,
  notice: null,
})

interface AiChatState extends AiChatFields {
  setOpen: (open: boolean) => void
  /** Also clears the notice, so one cannot sit on the wrong chat. */
  selectChat: (chatId: number | null) => void
  setProviderId: (providerId: number | null) => void
  /**
   * Drop a card no event will ever remove (the request expired or was already
   * decided), as `permission_resolved` would.
   */
  dismissApproval: (permissionId: string) => void
  /**
   * Reduce one SSE event, and raise its notice if it has one. `agent` names the
   * chat's agent in that notice: the store does not hold the provider list.
   */
  apply: (e: AiChatEvent, agent?: string) => void
  /** Merge by `seq`, the server's row winning; never loses a newer row. */
  setMessages: (chatId: number, rows: AiMessage[]) => void
  /** Also clears the active chat when it is no longer in `rows`. */
  setChats: (rows: AiChat[]) => void
  setNotice: (notice: ChatNotice | null) => void
  /** Stop answered "nothing runs": drop the chat's live turn. */
  clearLive: (chatId: number) => void
  /** The glue calls this after it refetched those chats. */
  clearRefetch: (chatIds: number[]) => void
  /** Back to the starting state, e.g. on logout: nothing of one user's chats may reach the next. */
  reset: () => void
}

const chatDataOf = (s: ChatData): ChatData => ({
  chats: s.chats,
  messages: s.messages,
  live: s.live,
  approvals: s.approvals,
  needsRefetch: s.needsRefetch,
})

export const useAiChatStore = create<AiChatState>()(
  devtools(
    set => ({
      ...initialFields(),

      reset: () => set(initialFields(), undefined, 'reset'),

      setOpen: open => set({ open }, undefined, 'setOpen'),

      selectChat: chatId =>
        set({ activeChatId: chatId, notice: null }, undefined, 'selectChat'),

      setProviderId: providerId =>
        set({ providerId }, undefined, 'setProviderId'),

      dismissApproval: permissionId =>
        set(
          state => {
            const chatId = Object.hasOwn(state.approvals, permissionId)
              ? state.approvals[permissionId]?.chatId
              : undefined
            if (chatId === undefined) return state
            const data = chatDataOf(state)
            const next = dropCard(data, permissionId, chatId)
            return next === data ? state : next
          },
          undefined,
          'dismissApproval'
        ),

      apply: (e, agent = 'The agent') =>
        set(
          state => {
            const data = chatDataOf(state)
            const next = applyEvent(data, e)
            const notice = noticeFor(e, agent, state.notice)
            // Nothing to write: keep the state object, so nothing re-renders.
            if (next === data && notice === null) return state
            return notice === null ? next : { ...next, notice }
          },
          undefined,
          `apply:${e.type}`
        ),

      setMessages: (chatId, rows) =>
        set(
          state => ({
            messages: {
              ...state.messages,
              [chatId]: mergeBySeq(state.messages[chatId] ?? [], rows),
            },
          }),
          undefined,
          'setMessages'
        ),

      setChats: rows =>
        set(
          state => {
            const next = withChatList(chatDataOf(state), rows)
            // A chat archived in another tab must not stay selected.
            const gone =
              state.activeChatId !== null &&
              !rows.some(row => row.id === state.activeChatId)
            return gone ? { ...next, activeChatId: null } : next
          },
          undefined,
          'setChats'
        ),

      setNotice: notice => set({ notice }, undefined, 'setNotice'),

      clearLive: chatId =>
        set(
          state => ({ live: omit(state.live, chatId) }),
          undefined,
          'clearLive'
        ),

      clearRefetch: chatIds =>
        set(
          state => ({
            needsRefetch: state.needsRefetch.filter(
              id => !chatIds.includes(id)
            ),
          }),
          undefined,
          'clearRefetch'
        ),
    }),
    { name: 'ai-chat-store' }
  )
)
