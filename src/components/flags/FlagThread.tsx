import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Send,
  Bold,
  Italic,
  Code,
  List,
  Link as LinkIcon,
  MessageSquare,
  AlignLeft,
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import {
  useFlag,
  useChangeStatus,
  useAssignFlag,
  useAddComment,
  useSetDue,
  flagKeys,
} from '@/hooks/use-flags'
import { markRead, addFlagAttachment } from '@/lib/flags-api'
import type {
  FlagStatus,
  CommentResponse,
  EventResponse,
} from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import { useItemKindLabels } from '@/services/item-kinds'
import {
  entityMeta,
  entityDisplayLabel,
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
} from '@/components/flags/mention-parse'
import {
  formatClock,
  formatDateTime,
  dueLabel,
} from '@/components/flags/flag-format'
import { STATUS_LABELS, STATUS_DOT } from '@/components/flags/flag-status'
import { FlagAvatar } from '@/components/flags/FlagAvatar'
import { FlagWatchers } from '@/components/flags/FlagWatchers'
import { FlagLinkChips } from '@/components/flags/FlagLinkChips'
import { FlagWatchChips } from '@/components/flags/FlagWatchChips'
import { CommentBody } from '@/components/flags/CommentBody'
import { FlagReactions } from '@/components/flags/FlagReactions'
import {
  useThreadViewMode,
  type ThreadViewMode,
} from '@/components/flags/use-thread-view-mode'

type TimelineEntry =
  | { kind: 'comment'; at: string; comment: CommentResponse }
  | { kind: 'event'; at: string; event: EventResponse }

/**
 * One flag's thread: breadcrumb + entity/resolve header, status/assignee
 * controls, a watcher row (FlagWatchers, backed by the detail API's watchers
 * list), an interleaved audit+comment timeline, and a composer. Visual target:
 * flag-thread-dark.html.
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
  const kindLabels = useItemKindLabels()
  const currentUserId = useAuthStore(state => state.user?.id ?? null)
  const [threadView, setThreadView] = useThreadViewMode()

  const changeStatus = useChangeStatus(flagId)
  const assign = useAssignFlag(flagId)
  const addComment = useAddComment(flagId)
  const setDueM = useSetDue(flagId)

  const [draft, setDraft] = useState('')
  // @mention picker state: the users chosen (id → display name), the open
  // `@token` menu, and the keyboard-highlighted candidate.
  const [selected, setSelected] = useState<Map<number, string>>(new Map())
  const [menu, setMenu] = useState<{ query: string; start: number } | null>(
    null
  )
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

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

  // Wrap the current selection with markdown tokens (bold/italic/code/link).
  const surround = (before: string, after = before) => {
    const ta = inputRef.current
    if (!ta) return
    const s = ta.selectionStart ?? draft.length
    const e = ta.selectionEnd ?? s
    const next =
      draft.slice(0, s) + before + draft.slice(s, e) + after + draft.slice(e)
    setDraft(next)
    queueMicrotask(() => {
      ta.focus()
      ta.setSelectionRange(s + before.length, e + before.length)
    })
  }
  const insertAtCaret = (text: string) => {
    const ta = inputRef.current
    const at = ta?.selectionStart ?? draft.length
    setDraft(draft.slice(0, at) + text + draft.slice(at))
    queueMicrotask(() => {
      ta?.focus()
      const pos = at + text.length
      ta?.setSelectionRange(pos, pos)
    })
  }
  const uploadImage = async (file: File) => {
    try {
      const att = await addFlagAttachment(flagId, file)
      insertAtCaret(`{attachment:${att.id}}`)
    } catch {
      /* surfaced by the failing send if the token dangles; no toast in v1 */
    }
  }

  // Opening a flag marks it read (clears its unread bar). Keyed on the flag's
  // `updated_at` too, so a flag you're actively viewing stays read as it changes
  // under you (your own comment won't re-flag it unread). Off the render path —
  // POST + query invalidate, no setState.
  const queryClient = useQueryClient()
  const flagUpdatedAt = flag?.updated_at
  useEffect(() => {
    if (flagUpdatedAt == null) return // not loaded yet
    void markRead(flagId)
      .then(() =>
        queryClient.invalidateQueries({ queryKey: flagKeys.unread() })
      )
      .catch(() => undefined)
  }, [flagId, flagUpdatedAt, queryClient])

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
      case 'due_set':
        return `${actor} set the due date to ${e.to_value ? formatDateTime(e.to_value) : ''}`
      case 'due_changed':
        return `${actor} changed the due date to ${e.to_value ? formatDateTime(e.to_value) : ''}`
      case 'due_cleared':
        return `${actor} cleared the due date`
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
            {entityDisplayLabel(flag, kindLabels)}
            {canDeepLink && (
              <button
                type="button"
                aria-label="Open item"
                onClick={() =>
                  navigateToEntity(flag.entity_type, flag.entity_id)
                }
                className="opacity-70 hover:opacity-100"
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
          <div className="flex items-center gap-2">
            <ThreadViewToggle mode={threadView} onChange={setThreadView} />
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

          {/* Due date: display + inline edit/clear (PUT /due; Slice 2 backend). */}
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              aria-label="Due date"
              className="h-8 w-36 text-xs"
              value={flag.due_at ? flag.due_at.slice(0, 10) : ''}
              onChange={e =>
                setDueM.mutate(
                  // 5pm local = end-of-workday semantics (matches the composer).
                  e.target.value
                    ? new Date(`${e.target.value}T17:00:00`).toISOString()
                    : null
                )
              }
            />
            {flag.due_at && (
              <>
                <span
                  className={
                    dueLabel(flag.due_at)?.overdue
                      ? 'text-xs font-medium text-destructive'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {dueLabel(flag.due_at)?.text}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs"
                  onClick={() => setDueM.mutate(null)}
                >
                  Clear
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Watchers: real list from the detail API (add / remove / self-toggle). */}
        <div className="mt-3">
          <FlagWatchers
            flagId={flag.id}
            watchers={flag.watchers ?? []}
            currentUserId={currentUserId}
          />
        </div>

        {/* Related entity + flag links (navigational only — not in rollups). */}
        <div className="mt-3">
          <FlagLinkChips flagId={flag.id} currentFlag={flag} />
        </div>

        {/* State-change watches on the anchor entity (Plan 6); renders nothing
            when the anchor type has no backend state seam. */}
        <div className="mt-3">
          <FlagWatchChips
            flagId={flag.id}
            entityType={flag.entity_type}
            entityId={flag.entity_id}
          />
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
              flagId={flagId}
              currentUserId={currentUserId}
              mode={threadView}
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
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Bold"
              onClick={() => surround('**')}
            >
              <Bold className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Italic"
              onClick={() => surround('_')}
            >
              <Italic className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Code"
              onClick={() => surround('`')}
            >
              <Code className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="List"
              onClick={() => insertAtCaret('\n- ')}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Link"
              onClick={() => surround('[', '](url)')}
            >
              <LinkIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Textarea
            ref={inputRef}
            value={draft}
            rows={2}
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
                  setActiveIdx(i =>
                    Math.min(i + 1, mentionCandidates.length - 1)
                  )
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActiveIdx(i => Math.max(i - 1, 0))
                  return
                }
                // Enter or Tab completes the highlighted candidate.
                if (e.key === 'Enter' || e.key === 'Tab') {
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
              if (
                (e.metaKey || e.ctrlKey) &&
                (e.key === 'b' || e.key === 'i')
              ) {
                e.preventDefault()
                surround(e.key === 'b' ? '**' : '_')
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            onPaste={e => {
              const img = Array.from(e.clipboardData?.files ?? []).find(f =>
                f.type.startsWith('image/')
              )
              if (img) {
                e.preventDefault()
                void uploadImage(img)
              }
            }}
            onDrop={e => {
              const img = Array.from(e.dataTransfer?.files ?? []).find(f =>
                f.type.startsWith('image/')
              )
              if (img) {
                e.preventDefault()
                void uploadImage(img)
              }
            }}
            placeholder="Write a comment… use @ to mention"
            className="max-h-40 min-h-10 flex-1 resize-none"
          />
        </div>
        <Button
          size="icon"
          className="h-10 w-10 shrink-0 self-end"
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

const THREAD_VIEW_OPTIONS = [
  { mode: 'bubbles' as const, Icon: MessageSquare, label: 'Bubble view' },
  { mode: 'compact' as const, Icon: AlignLeft, label: 'Compact view' },
]

/** Compact segmented control (chat bubbles ⇄ flush-left compact rows) — mirrors
 *  the flyout's list/table ViewToggle. */
function ThreadViewToggle({
  mode,
  onChange,
}: {
  mode: ThreadViewMode
  onChange: (mode: ThreadViewMode) => void
}) {
  return (
    <div
      role="group"
      aria-label="Thread view"
      className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
    >
      {THREAD_VIEW_OPTIONS.map(({ mode: m, Icon, label }) => (
        <button
          key={m}
          type="button"
          aria-label={label}
          aria-pressed={mode === m}
          onClick={() => onChange(m)}
          className={cn(
            'inline-flex h-6 w-6 items-center justify-center rounded transition-colors',
            mode === m
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
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
  flagId,
  currentUserId,
  mode,
}: {
  comment: CommentResponse
  isMe: boolean
  name: string
  initials: string
  color: string
  users: UserMap
  index: number
  flagId: number
  currentUserId: number | null
  mode: ThreadViewMode
}) {
  // Rich content (markdown, mentions, attachments+lightbox, reactions) renders
  // identically in both modes — only the wrapper presentation changes.
  const content = (
    <>
      <CommentBody
        body={comment.body}
        mentions={comment.mentions ?? []}
        users={users}
      />
      <FlagReactions
        commentId={comment.id}
        flagId={flagId}
        currentUserId={currentUserId}
        reactions={comment.reactions ?? []}
      />
    </>
  )
  const animationDelay = `${Math.min(index, 8) * 30}ms`

  if (mode === 'compact') {
    return (
      <div
        className="flag-cmt-in group -mx-2 flex items-start gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/40"
        style={{ animationDelay }}
      >
        <FlagAvatar initials={initials} color={color} isYou={isMe} size={20} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <b className="text-xs text-foreground">{isMe ? 'You' : name}</b>
            <span className="text-[10.5px] text-muted-foreground">
              {formatClock(comment.created_at)}
            </span>
          </div>
          {content}
        </div>
      </div>
    )
  }

  return (
    <div
      className="flag-cmt-in flex gap-2.5"
      style={{ animationDelay }}
    >
      <FlagAvatar initials={initials} color={color} isYou={isMe} size={22} />
      <div
        className={cn(
          'min-w-0 max-w-full rounded-xl border px-3 py-2',
          isMe ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/60'
        )}
      >
        <div className="mb-0.5 flex items-center gap-2">
          <b className="text-xs text-foreground">{isMe ? 'You' : name}</b>
          <span className="text-[10.5px] text-muted-foreground">
            {formatClock(comment.created_at)}
          </span>
        </div>
        {content}
      </div>
    </div>
  )
}

export default FlagThread
