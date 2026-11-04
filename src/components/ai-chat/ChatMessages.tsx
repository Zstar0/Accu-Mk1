/**
 * The conversation: stored rows, then the turn streaming right now, then the
 * approval cards of the chat.
 *
 * Everything the agent wrote is untrusted. Assistant text goes through
 * `renderAgentHtml(text)` (sanitized markdown, links shown as text), the only
 * thing that reaches `dangerouslySetInnerHTML`; user text, tool titles,
 * thoughts and approval text render as plain text.
 */

import { useDeferredValue, useLayoutEffect, useMemo, useRef } from 'react'
import { Check, Loader2, ShieldCheck, Wrench, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { AiMessage } from '@/lib/ai-chat-api'
import { renderAgentHtml } from './agent-html'
import { ApprovalCard } from './ApprovalCard'
import { useAiChatStore, type ToolChip } from './chat-store'

/** Within this many px of the bottom counts as "reading the latest". */
const NEAR_BOTTOM_PX = 80

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** `meta.tools` of a stored assistant row, whatever shape it really has. */
function toolsOf(meta: AiMessage['meta']): ToolChip[] {
  const raw = meta?.tools
  if (!Array.isArray(raw)) return []
  return raw.flatMap((t): ToolChip[] =>
    isRecord(t) && typeof t.id === 'string'
      ? [
          {
            id: t.id,
            title: str(t.title),
            kind: str(t.kind),
            status: str(t.status),
          },
        ]
      : []
  )
}

/** Sanitized markdown; re-rendered only when the text changes. */
function AssistantText({ text }: { text: string }) {
  // A streaming reply changes on every chunk and the parse reads all of it;
  // deferred, a burst of chunks costs one parse, not one each.
  const shown = useDeferredValue(text)
  const html = useMemo(() => renderAgentHtml(shown), [shown])
  return (
    <div
      className={cn(
        'break-words [overflow-wrap:anywhere] text-sm leading-relaxed',
        '[&_p]:m-0 [&_p+p]:mt-2',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1',
        '[&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground'
      )}
      // Safe: `renderAgentHtml` sanitizes with renderCommentHtml, then makes every
      // link plain text.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ChipIcon({ status }: { status: string | null }) {
  const cls = 'size-3 shrink-0'
  if (status === 'completed')
    return <Check className={cls} aria-hidden="true" />
  if (status === 'failed') {
    return <X className={cn(cls, 'text-destructive')} aria-hidden="true" />
  }
  if (status === 'pending' || status === 'in_progress') {
    return (
      <Loader2
        className={cn(cls, 'animate-spin motion-reduce:animate-none')}
        aria-hidden="true"
      />
    )
  }
  return <Wrench className={cls} aria-hidden="true" />
}

function ToolChips({ tools }: { tools: ToolChip[] }) {
  if (tools.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tools used">
      {tools.map(tool => {
        const label = tool.title ?? tool.kind ?? 'tool'
        return (
          <li key={tool.id}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                >
                  <ChipIcon status={tool.status} />
                  <span className="truncate">{label}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs break-words font-mono">
                {label}
                {tool.status !== null && ` (${tool.status})`}
              </TooltipContent>
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}

const DECISION_LABEL: Record<string, string> = {
  allow: 'Allowed once',
  deny: 'Denied',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

/** A stored approval. Never a live card: only `approvals` makes one. */
function PermissionRow({ message }: { message: AiMessage }) {
  const decision = str(message.meta?.decision)
  const title = str(message.meta?.title) ?? message.text
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="break-words">{title}</p>
        <p className="font-medium">
          {(decision !== null ? DECISION_LABEL[decision] : undefined) ??
            'No decision recorded'}
        </p>
      </div>
    </div>
  )
}

const STOP_NOTE: Record<string, string> = {
  max_tokens: 'This reply was cut off at the length limit.',
  max_turn_requests:
    'The agent stopped at its step limit, so this reply may be incomplete.',
  refusal: 'The agent declined to continue.',
}

/** What to say under a stored reply about how it ended, if anything. */
function stopNote(meta: AiMessage['meta']): string | null {
  const reason = str(meta?.stop_reason)
  if (reason === null || reason === 'end_turn' || reason === 'cancelled') {
    return null
  }
  // `hasOwn`: the reason comes off the wire, and could be `constructor`.
  return Object.hasOwn(STOP_NOTE, reason)
    ? (STOP_NOTE[reason] ?? null)
    : 'This reply may be incomplete.'
}

function MessageRow({ message }: { message: AiMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          {message.text}
        </p>
      </div>
    )
  }
  if (message.role === 'permission') return <PermissionRow message={message} />
  const note = stopNote(message.meta)
  return (
    <div className="flex flex-col gap-2">
      <ToolChips tools={toolsOf(message.meta)} />
      {message.text !== '' && <AssistantText text={message.text} />}
      {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

export function ChatMessages({ chatId }: { chatId: number }) {
  const rows = useAiChatStore(s => s.messages[chatId])
  const live = useAiChatStore(s => s.live[chatId])
  const approvals = useAiChatStore(s => s.approvals)
  const cards = useMemo(
    () => Object.values(approvals).filter(card => card.chatId === chatId),
    [approvals, chatId]
  )

  // Follow the end of the conversation only while the reader is already near
  // it; someone reading history must not be pulled away by a streaming reply.
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useLayoutEffect(() => {
    following.current = true
  }, [chatId])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [chatId, rows, live, cards])

  return (
    <div
      ref={scroller}
      data-testid="chat-scroll"
      role="region"
      aria-label="Conversation"
      tabIndex={0}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      onScroll={e => {
        const el = e.currentTarget
        following.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
      }}
    >
      {(rows ?? []).map(message => (
        <MessageRow key={message.seq} message={message} />
      ))}

      {live !== undefined && (
        <div className="flex flex-col gap-2">
          {live.thought !== '' && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Thinking</summary>
              <p className="mt-1 whitespace-pre-wrap break-words">
                {live.thought}
              </p>
            </details>
          )}
          <ToolChips tools={Object.values(live.tools)} />
          {live.text !== '' && <AssistantText text={live.text} />}
        </div>
      )}

      {cards.map(card => (
        <ApprovalCard key={card.permission_id} card={card} />
      ))}
    </div>
  )
}
