/**
 * The message box, Send/Stop, and the notice above it (busy, unreachable with
 * Retry, error, stopped).
 *
 * New chats are lazy: the chat is created by the first send, so a panel that
 * is opened and closed leaves nothing behind. A failed send puts the text back
 * in the box.
 */

import { useRef, useState, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SendHorizontal, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { CrmError } from '@/lib/api-crm'
import { cancelTurn, createChat, sendPrompt } from '@/lib/ai-chat-api'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { useAiChatStore, type ChatNotice } from './chat-store'
import { currentPageContext } from './page-context'
import {
  AI_CHAT_KEY,
  loadMessages,
  refreshChats,
  useActiveProvider,
} from './use-ai-chat-glue'

/** Stable DOM id, so the panel can focus the box on open and on New chat. */
export const COMPOSER_ID = 'ai-chat-composer'

const MAX_LENGTH = 8000
const TRY_NEW = 'Try a new chat.'
const GONE = `This chat is not available any more. ${TRY_NEW}`

/** An error notice always ends by telling the reader what to do. */
const withAdvice = (message: string) =>
  message.endsWith(TRY_NEW) ? message : `${message} ${TRY_NEW}`

export function ChatComposer() {
  const qc = useQueryClient()
  const agent = useActiveProvider()
  const activeChatId = useAiChatStore(s => s.activeChatId)
  const running = useAiChatStore(
    s => s.activeChatId !== null && s.live[s.activeChatId] !== undefined
  )
  const notice = useAiChatStore(s => s.notice)
  // The last thing the user said in this chat, from the stored rows. Read
  // through a selector so Retry appears when the transcript loads after the
  // error did (a reload mid-turn).
  const storedPrompt = useAiChatStore(s =>
    s.activeChatId === null
      ? undefined
      : s.messages[s.activeChatId]?.filter(m => m.role === 'user').at(-1)?.text
  )

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  // What each chat was last asked in this session, for Retry. Component
  // state, not the store. Replaced, never mutated, so a change re-renders.
  const [prompts, setPrompts] = useState<ReadonlyMap<number, string>>(
    () => new Map()
  )
  const guard = useRef(false)

  const agentName = agent?.display_name ?? 'The agent'
  const empty = text.trim() === ''

  /** Turn a rejected create/send into a notice. */
  function explain(e: unknown, chatId: number | null) {
    const store = useAiChatStore.getState()
    const status = e instanceof CrmError ? e.status : null
    const code = e instanceof CrmError ? e.code : null
    const where = chatId === null ? {} : { chatId }

    // A turn already runs on this chat; the reply is on its way.
    if (status === 409 && code === 'turn_running') return

    if (status === 429) {
      store.setNotice({
        kind: 'busy',
        message: `${agentName} is busy, try again in a minute.`,
        ...where,
      })
    } else if (
      status === 403 ||
      (status === 404 &&
        (code === 'provider_not_found' || code === 'chat_not_found'))
    ) {
      // The chat, or the user's access to it, is gone.
      const gone = code === 'chat_not_found'
      if (gone) store.selectChat(null) // clears the notice, so set it after
      store.setNotice({
        kind: 'error',
        message: GONE,
        ...(gone ? {} : where),
      })
      void qc.invalidateQueries({ queryKey: [...AI_CHAT_KEY, 'providers'] })
    } else {
      store.setNotice({
        kind: 'error',
        message: withAdvice('Could not send that message.'),
        ...where,
      })
    }
  }

  /**
   * `fromBox`: the text came from the box, so the box is cleared for the send
   * and gets it back if the send fails. Retry sends an old prompt and leaves
   * the box, and any draft in it, alone.
   */
  async function submit(raw: string, fromBox: boolean) {
    const prompt = raw.trim()
    if (prompt === '' || guard.current || agent === null) return
    guard.current = true
    setSending(true)
    if (fromBox) setText('')
    useAiChatStore.getState().setNotice(null)

    let chatId = useAiChatStore.getState().activeChatId
    try {
      if (chatId === null) {
        const chat = await createChat(agent.id)
        // End any list fetch that began before this chat existed, so it cannot
        // land after the selection below and clear it.
        void refreshChats(qc)
        const s = useAiChatStore.getState()
        s.setChats([chat, ...s.chats.filter(c => c.id !== chat.id)])
        s.selectChat(chat.id)
        chatId = chat.id
      }
      await sendPrompt(
        chatId,
        prompt,
        currentPageContext(useUIStore.getState())
      )
      const sentTo = chatId // `chatId` is reassigned above; a closure would see number | null
      setPrompts(p => new Map(p).set(sentTo, prompt))
      void loadMessages(sentTo)
    } catch (e) {
      // Keep whatever was typed since; otherwise put the message back.
      if (fromBox) setText(now => (now === '' ? raw : now))
      explain(e, chatId)
    } finally {
      guard.current = false
      setSending(false)
    }
  }

  async function stop() {
    const chatId = activeChatId
    if (chatId === null) return
    const userId = useAuthStore.getState().user?.id
    try {
      const { cancelled } = await cancelTurn(chatId)
      if (cancelled || useAuthStore.getState().user?.id !== userId) return
      // Nothing was running: the turn_ended we wait for never comes.
      useAiChatStore.getState().clearLive(chatId)
      void loadMessages(chatId)
    } catch {
      // Stop stays on offer; the reader can press it again.
    }
  }

  function retry() {
    if (activeChatId === null) return
    const prompt = prompts.get(activeChatId) ?? storedPrompt
    if (prompt !== undefined) void submit(prompt, false)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (!running) void submit(text, true)
  }

  return (
    <div className="border-t p-3">
      <NoticeBanner
        notice={notice}
        chatId={activeChatId}
        onRetry={
          activeChatId !== null &&
          (prompts.has(activeChatId) || storedPrompt !== undefined)
            ? retry
            : undefined
        }
      />
      <form
        className="flex items-end gap-2"
        onSubmit={e => {
          e.preventDefault()
          void submit(text, true)
        }}
      >
        <Textarea
          id={COMPOSER_ID}
          aria-label="Message"
          placeholder={`Message ${agentName}`}
          value={text}
          maxLength={MAX_LENGTH}
          rows={1}
          className="max-h-40 min-h-10 resize-none"
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Stop"
            onClick={() => void stop()}
          >
            <Square className="size-4" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            aria-label="Send"
            disabled={empty || sending || agent === null}
          >
            <SendHorizontal className="size-4" aria-hidden="true" />
          </Button>
        )}
      </form>
    </div>
  )
}

function NoticeBanner({
  notice,
  chatId,
  onRetry,
}: {
  notice: ChatNotice | null
  chatId: number | null
  onRetry?: (() => void) | undefined
}) {
  // A notice without a chat belongs to wherever the reader is.
  if (
    notice === null ||
    (notice.chatId !== undefined && notice.chatId !== chatId)
  ) {
    return null
  }
  const message =
    notice.kind === 'error' ? withAdvice(notice.message) : notice.message
  return (
    <div
      role={notice.kind === 'cancelled' ? 'status' : 'alert'}
      className="mb-2 flex items-start gap-2 rounded-md border bg-muted/50 px-2.5 py-1.5 text-xs"
    >
      <p className="min-w-0 flex-1 break-words">{message}</p>
      {notice.kind === 'unreachable' && onRetry !== undefined && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => useAiChatStore.getState().setNotice(null)}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
