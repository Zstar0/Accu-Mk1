import { useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Check, Eye, Send } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import {
  useFlag,
  useChangeStatus,
  useAssignFlag,
  useAddComment,
  useAddWatcher,
  useRemoveWatcher,
} from '@/hooks/use-flags'
import type {
  FlagStatus,
  CommentResponse,
  EventResponse,
} from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import {
  entityMeta,
  entityLabel,
  navigateToEntity,
} from '@/components/flags/flag-entity'
import {
  useFlagUsers,
  nameForUser,
  initialsForUser,
  avatarColor,
  type UserMap,
} from '@/components/flags/flag-users'
import { displayName } from '@/lib/user-display'
import {
  activeMentionQuery,
  mentionIdsInBody,
  renderCommentSegments,
} from '@/components/flags/mention-parse'
import { formatClock } from '@/components/flags/flag-format'
import { STATUS_LABELS, STATUS_DOT } from '@/components/flags/flag-status'
import { FlagAvatar } from '@/components/flags/FlagAvatar'

type TimelineEntry =
  | { kind: 'comment'; at: string; comment: CommentResponse }
  | { kind: 'event'; at: string; event: EventResponse }

/**
 * One flag's thread: breadcrumb + entity/resolve header, status/assignee/watch
 * controls, an interleaved audit+comment timeline, and a composer. Visual
 * target: flag-thread-dark.html.
 *
 * Gaps vs the mockup (API limits, noted): the detail API exposes no watchers
 * list, so the watcher count is derived best-effort from the event trail and
 * the Watch toggle's initial state is inferred the same way.
 */
export function FlagThread({
  flagId,
  tabLabel,
}: {
  flagId: number
  tabLabel: string
}) {
  const { data: flag, isLoading, isError } = useFlag(flagId)
  const users = useFlagUsers()
  const typesMap = useFlagTypesMap()
  const currentUserId = useAuthStore(state => state.user?.id ?? null)

  const changeStatus = useChangeStatus(flagId)
  const assign = useAssignFlag(flagId)
  const addComment = useAddComment(flagId)
  const addWatcher = useAddWatcher(flagId)
  const removeWatcher = useRemoveWatcher(flagId)

  const [draft, setDraft] = useState('')
  // @mention picker state: the users chosen (id → display name), the open
  // `@token` menu, and the keyboard-highlighted candidate.
  const [selected, setSelected] = useState<Map<number, string>>(new Map())
  const [menu, setMenu] = useState<{ query: string; start: number } | null>(
    null
  )
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const mentionCandidates = menu
    ? [...users.values()]
        .filter(u => {
          const q = menu.query.toLowerCase()
          return (
            displayName(u).toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q)
          )
        })
        .slice(0, 6)
    : []

  const onDraftChange = (value: string, caret: number) => {
    setDraft(value)
    setMenu(activeMentionQuery(value, caret))
    setActiveIdx(0)
  }

  const pickMention = (u: { id: number; email: string }) => {
    if (!menu) return
    const name = displayName(u)
    const before = draft.slice(0, menu.start)
    const after = draft.slice(menu.start + 1 + menu.query.length)
    setDraft(`${before}@${name} ${after}`)
    setSelected(prev => new Map(prev).set(u.id, name))
    setMenu(null)
    queueMicrotask(() => inputRef.current?.focus())
  }

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  if (isError || !flag) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <p className="text-sm font-semibold">Could not load this flag.</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => useUIStore.getState().closeFlagThread()}
        >
          Back to flags
        </Button>
      </div>
    )
  }

  const def = typesMap[flag.type] ?? flagTypeDef(flag.type)
  const { Icon, canDeepLink } = entityMeta(flag.entity_type)
  const status = (flag.status as FlagStatus) ?? 'open'

  // Best-effort watcher state from the audit trail (no watchers list on the API).
  const watchers = new Set<number>()
  for (const e of flag.events) {
    if (e.actor_id == null) continue
    if (e.event_type === 'watcher_added') watchers.add(e.actor_id)
    if (e.event_type === 'watcher_removed') watchers.delete(e.actor_id)
  }
  const iWatch = currentUserId != null && watchers.has(currentUserId)

  // Merge comments + non-comment events into one time-ordered timeline.
  const timeline: TimelineEntry[] = [
    ...flag.comments.map(
      (comment): TimelineEntry => ({
        kind: 'comment',
        at: comment.created_at,
        comment,
      })
    ),
    ...flag.events
      .filter(e => e.event_type !== 'commented')
      .map(
        (event): TimelineEntry => ({
          kind: 'event',
          at: event.created_at,
          event,
        })
      ),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  const submit = () => {
    const body = draft.trim()
    if (!body || addComment.isPending) return
    addComment.mutate({ body, mentionIds: mentionIdsInBody(body, selected) })
    setDraft('')
    setSelected(new Map())
    setMenu(null)
  }

  const eventText = (e: EventResponse): string => {
    const actor = nameForUser(users, e.actor_id)
    switch (e.event_type) {
      case 'raised':
        return `🚩 ${actor} raised this · ${def.label}`
      case 'assigned':
        return `Assigned to ${nameForUser(users, e.to_value ? Number(e.to_value) : null)}`
      case 'unassigned':
        return `${actor} unassigned this`
      case 'status_changed':
        return `Status → ${STATUS_LABELS[e.to_value as FlagStatus] ?? e.to_value} · ${actor}`
      case 'watcher_added':
        return `${actor} started watching`
      case 'watcher_removed':
        return `${actor} stopped watching`
      default:
        return `${actor} · ${e.event_type}`
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Breadcrumb */}
      <button
        type="button"
        onClick={() => useUIStore.getState().closeFlagThread()}
        className="flex items-center gap-2 border-b px-4 py-2.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Flags <span className="text-muted-foreground/50">/</span>
        <span className="text-foreground/70">{tabLabel}</span>
      </button>

      {/* Header */}
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px] font-bold text-foreground/80">
            <Icon className="h-3.5 w-3.5" />
            {entityLabel(flag.entity_type, flag.entity_id)}
            {canDeepLink && (
              <button
                type="button"
                aria-label="Open entity"
                onClick={() =>
                  navigateToEntity(flag.entity_type, flag.entity_id)
                }
                className="opacity-70 hover:opacity-100"
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
          {status !== 'resolved' && status !== 'closed' && (
            <Button
              size="sm"
              className="h-7 gap-1.5 bg-emerald-700 text-emerald-50 hover:bg-emerald-700/90"
              disabled={changeStatus.isPending}
              onClick={() => changeStatus.mutate('resolved')}
            >
              <Check className="h-3.5 w-3.5" /> Resolve
            </Button>
          )}
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <h2 className="text-base font-bold text-foreground">{flag.title}</h2>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: def.color }}
          >
            {def.label}
          </span>
        </div>

        {/* Controls */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            value={status}
            onValueChange={v => changeStatus.mutate(v as FlagStatus)}
          >
            <SelectTrigger className="h-8 w-auto gap-1.5 text-xs">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: STATUS_DOT[status] }}
              />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_LABELS) as FlagStatus[]).map(s => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={
              flag.assignee_id == null ? 'unassigned' : String(flag.assignee_id)
            }
            onValueChange={v =>
              assign.mutate(v === 'unassigned' ? null : Number(v))
            }
          >
            <SelectTrigger className="h-8 w-auto gap-1.5 text-xs">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {[...users.values()].map(u => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {nameForUser(users, u.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={
              addWatcher.isPending ||
              removeWatcher.isPending ||
              currentUserId == null
            }
            onClick={() => {
              if (currentUserId == null) return
              if (iWatch) removeWatcher.mutate(currentUserId)
              else addWatcher.mutate(currentUserId)
            }}
          >
            <Eye className="h-3.5 w-3.5" />
            {iWatch ? 'Watching' : 'Watch'}
            {watchers.size > 0 && (
              <span className="text-muted-foreground">· {watchers.size}</span>
            )}
          </Button>
        </div>
      </div>

      {/* Timeline */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto bg-muted/30 px-4 py-3.5">
        {timeline.map((entry, i) =>
          entry.kind === 'event' ? (
            <div
              key={`e-${entry.event.id}`}
              className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground"
            >
              <span className="h-px flex-1 bg-border" />
              <span className="text-center">
                {eventText(entry.event)} · {formatClock(entry.at)}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : (
            <CommentRow
              key={`c-${entry.comment.id}`}
              comment={entry.comment}
              isMe={entry.comment.author_id === currentUserId}
              name={nameForUser(users, entry.comment.author_id)}
              initials={initialsForUser(
                users,
                entry.comment.author_id,
                currentUserId
              )}
              color={avatarColor(entry.comment.author_id)}
              users={users}
              index={i}
            />
          )
        )}
        {timeline.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No activity yet.
          </p>
        )}
      </div>

      {/* Composer */}
      <div className="relative flex items-center gap-2.5 border-t bg-background px-3 py-2.5">
        <FlagAvatar
          initials={initialsForUser(users, currentUserId, currentUserId)}
          color={avatarColor(currentUserId)}
          isYou
          size={22}
        />
        {menu && mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-12 z-20 mb-1 w-64 overflow-hidden rounded-md border bg-popover shadow-md">
            {mentionCandidates.map((u, i) => (
              <button
                key={u.id}
                type="button"
                onMouseDown={e => {
                  e.preventDefault()
                  pickMention(u)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]',
                  i === activeIdx ? 'bg-accent' : 'hover:bg-accent/60'
                )}
              >
                <FlagAvatar
                  initials={initialsForUser(users, u.id, currentUserId)}
                  color={avatarColor(u.id)}
                  size={18}
                />
                <span className="truncate">{displayName(u)}</span>
              </button>
            ))}
          </div>
        )}
        <Input
          ref={inputRef}
          value={draft}
          onChange={e =>
            onDraftChange(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length
            )
          }
          onKeyDown={e => {
            if (menu && mentionCandidates.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIdx(i => Math.min(i + 1, mentionCandidates.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIdx(i => Math.max(i - 1, 0))
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                const chosen = mentionCandidates[activeIdx]
                if (chosen) pickMention(chosen)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMenu(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Write a comment… use @ to mention"
          className="h-10 flex-1"
        />
        <Button
          size="icon"
          className="h-10 w-10 shrink-0"
          disabled={!draft.trim() || addComment.isPending}
          onClick={submit}
          aria-label="Send comment"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function CommentRow({
  comment,
  isMe,
  name,
  initials,
  color,
  users,
  index,
}: {
  comment: CommentResponse
  isMe: boolean
  name: string
  initials: string
  color: string
  users: UserMap
  index: number
}) {
  return (
    <div
      className="flag-cmt-in flex gap-2.5"
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <FlagAvatar initials={initials} color={color} isYou={isMe} size={22} />
      <div
        className={cn(
          'max-w-[300px] rounded-xl border px-3 py-2',
          isMe ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/60'
        )}
      >
        <div className="mb-0.5 flex items-center gap-2">
          <b className="text-xs text-foreground">{isMe ? 'You' : name}</b>
          <span className="text-[10.5px] text-muted-foreground">
            {formatClock(comment.created_at)}
          </span>
        </div>
        <div className="text-[13px] leading-relaxed text-foreground/90">
          {renderCommentSegments(comment.body, comment.mentions ?? [], id =>
            nameForUser(users, id)
          ).map((seg, i) =>
            seg.mentionId != null ? (
              <span
                key={i}
                className="rounded bg-primary/15 px-1 font-medium text-primary"
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </div>
      </div>
    </div>
  )
}

export default FlagThread
