import { Fragment, useState, type ReactNode } from 'react'
import { CircleCheck, EyeOff, Flag, Tag, UserRound } from 'lucide-react'
import { renderCommentHtml } from '@/components/flags/comment-markdown'
import type { SupportEntry } from '@/lib/api-support'
import { cn } from '@/lib/utils'
import { PlainAvatar } from './PlainAvatar'
import { ago, dayLabel, exact } from './plain-time'

const ICON = {
  status: CircleCheck,
  label: Tag,
  assign: UserRound,
  priority: Flag,
} as const
const MENTION = /(@[A-Z][\w'.-]*(?: [A-Z][\w'.-]*)?)/g

function withMentions(text: string): ReactNode[] {
  return text.split(MENTION).map((part, i) =>
    i % 2 === 1 ? (
      <span
        key={i}
        data-mention
        className="rounded bg-[var(--pv-chip)] px-1 text-[var(--pv-accent)]"
      >
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}

function Body({ e }: { e: SupportEntry }) {
  if (e.markdown) {
    return (
      <div
        className="break-words text-sm [&_a]:text-[var(--pv-accent)] [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4"
        // Sanitised by renderCommentHtml (markdown-it html:false + DOMPurify).
        dangerouslySetInnerHTML={{ __html: renderCommentHtml(e.markdown, []) }}
      />
    )
  }
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {e.internal ? withMentions(e.text) : e.text}
    </p>
  )
}

function Card({
  e,
  customerFirstName,
}: {
  e: SupportEntry
  customerFirstName: string
}) {
  const [open, setOpen] = useState(false)
  const kind = e.internal
    ? 'note'
    : e.author_kind === 'customer'
      ? 'customer'
      : 'team'
  const name = e.author ?? (kind === 'customer' ? 'Customer' : 'Accumark Labs')
  const bg =
    kind === 'note'
      ? 'bg-[var(--pv-card-note)]'
      : kind === 'team'
        ? 'bg-[var(--pv-card-team)]'
        : 'bg-[var(--pv-card)]'
  return (
    <div className="flex gap-3">
      <PlainAvatar name={name} url={e.author_avatar_url} />
      <div
        data-card={kind}
        className={cn(
          'min-w-0 flex-1 rounded-lg border border-[var(--pv-border)] p-3',
          bg
        )}
      >
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-semibold">
            {e.automated ? `${name} (Autoresponse)` : name}
          </span>
          <span className="text-xs text-[var(--pv-ink-3)]" title={exact(e.at)}>
            {ago(e.at)}
          </span>
        </div>
        {e.subject && <div className="font-medium">{e.subject}</div>}
        {(e.email_to || e.email_from) && (
          <div className="mb-2 text-xs text-[var(--pv-ink-2)]">
            {`to: ${e.email_to ?? ''}, from: ${e.email_from ?? ''}`}
          </div>
        )}
        {e.automated && !open ? (
          <div className="flex flex-col items-center gap-2 py-1 text-sm text-[var(--pv-ink-2)]">
            <span>This email was sent automatically</span>
            <button
              type="button"
              className="rounded-md border border-[var(--pv-border)] px-2 py-1 text-xs"
              onClick={() => setOpen(true)}
            >
              Show message
            </button>
          </div>
        ) : (
          <Body e={e} />
        )}
        {kind === 'note' && (
          <div className="mt-2 flex items-center gap-1 text-xs text-[var(--pv-note-ink)]">
            <EyeOff className="h-3 w-3" /> Not visible to {customerFirstName}
          </div>
        )}
      </div>
    </div>
  )
}

function EventLine({ e, viewerName }: { e: SupportEntry; viewerName: string }) {
  const ev = e.event
  if (!ev)
    return <div className="pl-11 text-xs text-[var(--pv-ink-3)]">{e.text}</div>
  const Icon = ICON[ev.icon]
  return (
    <div className="flex items-center gap-2 pl-11 text-xs text-[var(--pv-ink-2)]">
      <Icon className="h-3.5 w-3.5 text-[var(--pv-ink-3)]" />
      <span className="font-medium text-[var(--pv-ink)]">
        {ev.actor === viewerName ? 'You' : ev.actor}
      </span>
      <span>{ev.text}</span>
      <span className="text-[var(--pv-ink-3)]" title={exact(e.at)}>
        · {ago(e.at)}
      </span>
    </div>
  )
}

/** Plain-style conversation: day dividers, cards and one-line events, in the order given. */
export function TicketTimeline({
  entries,
  customerFirstName,
  viewerName,
}: {
  entries: SupportEntry[]
  customerFirstName: string
  viewerName: string
}) {
  // The day of the nearest earlier entry that has a timestamp, so a divider shows once per day.
  const days = entries.map(e => (e.at ? dayLabel(e.at) : ''))
  const before: string[] = []
  let last = ''
  for (const d of days) {
    before.push(last)
    if (d) last = d
  }
  return (
    <div className="flex flex-col gap-3">
      {entries.map((e, i) => {
        const day = days[i] ?? ''
        const divider = day !== '' && day !== before[i]
        return (
          <Fragment key={e.id}>
            {divider && (
              <div className="pt-2 text-xs font-semibold text-[var(--pv-ink)]">
                {day}
              </div>
            )}
            {e.kind === 'event' ? (
              <EventLine e={e} viewerName={viewerName} />
            ) : (
              <Card e={e} customerFirstName={customerFirstName} />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
