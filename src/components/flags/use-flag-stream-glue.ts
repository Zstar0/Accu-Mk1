import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useFlagStream, type FlagStreamEvent } from '@/lib/flag-stream'
import { flagKeys } from '@/hooks/use-flags'
import { flagTypeKeys } from '@/services/flag-types'
import { useUIStore } from '@/store/ui-store'
import { useAuthStore } from '@/store/auth-store'
import { useFlagUnseen } from '@/components/flags/use-flag-unseen'
import { evaluateRelevance } from '@/components/flags/flag-relevance'
import { CODE_ENTITY_TYPES } from '@/components/flags/flag-entity'
import { toast } from 'sonner'
import { flagTypeDef, type FlagTypeDef } from '@/components/flags/flag-catalog'
import { flagToastBody, flagToastHeading } from '@/components/flags/flag-toast'
import type { FlagTab, FlagType } from '@/lib/flags-api'
import { FLAGS_BUTTON_ID } from '@/components/flags/FlagsHeaderButton'

/** Trailing-debounce window for coalescing SSE-driven query invalidation. Event
 *  bursts (reaction storms, digest-time activity) collapse into one refetch
 *  cycle fired this long after the last event. */
const INVALIDATE_DEBOUNCE_MS = 300

/** Resolve a type slug → {label,color,kind} at event time, reading the managed
 *  catalog from the query cache (incl. inactive types) and falling back to the
 *  static catalog for slugs not yet cached / unknown. */
function resolveTypeDef(qc: QueryClient, type: string): FlagTypeDef {
  const rows = qc.getQueryData<FlagType[]>(flagTypeKeys.list({}))
  const row = rows?.find(t => t.slug === type)
  if (row) return { label: row.label, color: row.color, kind: row.kind }
  return flagTypeDef(type)
}

/** Friendly toast title per event type. */
function toastTitle(e: FlagStreamEvent, me: number | null): string {
  switch (e.event_type) {
    case 'raised':
      return 'Flag raised'
    case 'assigned':
      return e.flag.assignee_id === me ? 'Assigned to you' : 'Flag reassigned'
    case 'unassigned':
      return 'Flag unassigned'
    case 'commented':
      return 'New comment'
    case 'status_changed':
      return 'Status changed'
    case 'watcher_added':
      return 'New watcher'
    case 'watcher_removed':
      return 'Watcher removed'
    default:
      return 'Flag updated'
  }
}

function notifyForEvent(
  e: FlagStreamEvent,
  me: number | null,
  def: FlagTypeDef,
  mentioned: boolean
) {
  const title = mentioned ? 'You were mentioned' : toastTitle(e, me)
  // Clicking the toast opens this flag's thread and dismisses the toast. sonner
  // v2 has no whole-toast onClick, so the handler is wired onto the heading +
  // body nodes we render; `toastId` is captured after creation (the handler
  // only ever fires later, so the forward reference is safe).
  let toastId: string | number | undefined
  const open = () => {
    useUIStore.getState().openFlagThread(e.flag_id)
    if (toastId !== undefined) toast.dismiss(toastId)
  }
  const opts = {
    description: flagToastBody(e.flag, def, open),
    // The fly-home flourish waits until the toast auto-dismisses (starts to
    // slide away) — and only if the user hasn't opened the flyout meanwhile.
    onAutoClose: () => {
      if (!useUIStore.getState().flagsFlyoutOpen) flyToFlagsButton(def.color)
    },
  }
  const heading = flagToastHeading(title, open)
  if (e.flag.type === 'blocker') toastId = toast.error(heading, opts)
  else if (e.flag.type === 'critical') toastId = toast.warning(heading, opts)
  else if (def.kind === 'signal') toastId = toast.success(heading, opts)
  else toastId = toast.info(heading, opts)
}

/**
 * Best-effort "fly home" (toast-animation.html): a small colored chip springs
 * from the bottom and flies into the Flags button, which bumps. We can't see
 * this headless — the user verifies the feel against the running stack. The
 * glow + badge increment land regardless (via hasNew + summary refetch).
 *
 * Deviation from the mockup: the *toast itself* doesn't fly (sonner owns it);
 * we approximate with a separate chip + button bump + glow + count bump.
 */
function flyToFlagsButton(color: string) {
  if (typeof document === 'undefined') return
  const btn = document.getElementById(FLAGS_BUTTON_ID)
  if (!btn) return

  const bump = () => {
    btn.classList.add('flags-bump')
    setTimeout(() => btn.classList.remove('flags-bump'), 450)
  }

  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const chip = document.createElement('div')
  chip.setAttribute('aria-hidden', 'true')
  chip.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:84px',
    'transform:translateX(-50%)',
    'width:28px',
    'height:28px',
    'border-radius:8px',
    `background:${color}`,
    'z-index:9999',
    'pointer-events:none',
    'box-shadow:0 10px 28px rgba(0,0,0,.35)',
  ].join(';')
  document.body.appendChild(chip)

  if (reduce) {
    chip.remove()
    bump()
    return
  }

  const tr = chip.getBoundingClientRect()
  const br = btn.getBoundingClientRect()
  const dx = br.left + br.width / 2 - (tr.left + tr.width / 2)
  const dy = br.top + br.height / 2 - (tr.top + tr.height / 2)

  requestAnimationFrame(() => {
    chip.style.transition =
      'transform .6s cubic-bezier(.5,0,.18,1), opacity .42s ease-in .16s'
    chip.style.transform = `translateX(-50%) translate(${dx}px,${dy}px) scale(.18)`
    chip.style.opacity = '0'
  })
  setTimeout(() => {
    chip.remove()
    bump()
  }, 640)
}

/**
 * App-scope SSE glue. Mounts the flag stream once, refreshes all flag queries on
 * every event (so open lists/threads update in place), and — for events
 * relevant to the current user that they aren't already looking at — marks the
 * flag unseen (persisted → drives the header pulse across reloads), raises a
 * toast, and (when the flyout is closed) the fly-home flourish.
 *
 * Relevance = assignee or creator is me. "Watching"-based relevance is deferred:
 * the event payload doesn't carry the viewer's watch set, so we can't decide it
 * client-side without extra state (documented gap — lists still update in place).
 *
 * The header pulse now reads from the persisted `useFlagUnseen` store, so this
 * hook is a pure side-effect (no return): mount it once at app scope.
 */
export function useFlagStreamGlue(): void {
  const queryClient = useQueryClient()

  // --- scoped + coalesced query invalidation (perf) ---------------------
  // Every SSE event marks a BOUNDED set of query keys stale (its lists/tabs,
  // summary, unread, activity, own detail, and — crucially — only its OWN
  // entity's button, not all 10–40 per-vial EntityFlagButtons). A trailing
  // debounce collapses bursts into one refetch cycle. Toasts / unseen marking /
  // fly-home stay synchronous below — only the invalidation is deferred.
  const pendingKeys = useRef<Map<string, readonly unknown[]>>(new Map())
  const pendingRollup = useRef(false)
  const pendingBlanket = useRef(false)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushInvalidations = () => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    const blanket = pendingBlanket.current
    const rollup = pendingRollup.current
    const keys = [...pendingKeys.current.values()]
    pendingKeys.current.clear()
    pendingRollup.current = false
    pendingBlanket.current = false

    // Defensive fallback: a degenerate payload we couldn't scope. One blanket
    // refresh subsumes every scoped target (correctness over efficiency).
    if (blanket) {
      queryClient.invalidateQueries({ queryKey: flagKeys.all })
      return
    }
    for (const key of keys) {
      queryClient.invalidateQueries({ queryKey: key })
    }
    // Descendant events (a vial) can restate a PARENT's rollup button, but the
    // payload names only the descendant. Rollup (includeDescendants=true) entity
    // queries are page-scoped and few (≤1 in practice: the open parent page), so
    // refetch just those to keep the aggregate live — the per-vial buttons
    // (includeDescendants=false) stay untouched.
    if (rollup) {
      queryClient.invalidateQueries({
        predicate: q => {
          const k = q.queryKey
          return (
            Array.isArray(k) &&
            k[0] === 'flags' &&
            k[1] === 'entity' &&
            k[4] === true
          )
        },
      })
    }
  }

  const enqueueInvalidations = (e: FlagStreamEvent) => {
    const mark = (key: readonly unknown[]) =>
      pendingKeys.current.set(JSON.stringify(key), key)

    // Standard set — every event can restate these regardless of anchor.
    mark(flagKeys.lists())
    mark(flagKeys.summary())
    mark(flagKeys.unread())
    mark(flagKeys.activity())
    if (typeof e.flag_id === 'number') mark(flagKeys.detail(e.flag_id))

    const et = e.flag?.entity_type
    const eid = e.flag?.entity_id
    const hasType = et != null && et !== ''
    const hasId = eid != null && eid !== ''
    if (hasType && hasId) {
      // Scope to just this entity's button(s) (both includeDescendants variants);
      // flag the rollup pass for the descendant→parent case.
      mark(flagKeys.entityScope(et as string, eid as string))
      pendingRollup.current = true
    } else if (
      !e.flag ||
      (hasId && !hasType) ||
      (hasType && !hasId && CODE_ENTITY_TYPES.has(et as string))
    ) {
      // Un-scopeable: no flag snapshot, an id without a type, or a CODE entity
      // missing its id (all three impossible via create_flag — pure defense).
      // General tasks (both absent) and KIND-ANCHORED flags (non-code type,
      // id NULL — legal since slice 7; kinds have no entity buttons) are NOT
      // this case: the standard set already covers them, and blanket-ing them
      // would re-create the per-vial storm this fix exists to kill.
      pendingBlanket.current = true
    }

    // Trailing debounce: reset the window on each event so a burst collapses
    // into a single flush fired after it quiets.
    if (flushTimer.current) clearTimeout(flushTimer.current)
    flushTimer.current = setTimeout(flushInvalidations, INVALIDATE_DEBOUNCE_MS)
  }

  // Keep a stable handle to the latest flush so the unmount cleanup can call it
  // WITHOUT taking a reactive dependency — disabling a hook rule to silence that
  // dependency would switch React Compiler off for this whole component.
  const flushRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    flushRef.current = flushInvalidations
  })
  // Flush anything still pending on unmount so nothing is dropped, and never
  // leak the debounce timer (flush is a no-op when the queue is empty).
  useEffect(() => () => flushRef.current(), [])

  // Opening the flyout is where you see what's new: snapshot the unseen set into
  // `justOpened` (so the pinged rows can pulse) and clear the persisted set (so
  // the bar pulse stops). Closing drops that snapshot so a re-open doesn't
  // re-pulse. Driven by a store subscription (not setState in an effect body) so
  // it stays off React's render path.
  useEffect(() => {
    return useUIStore.subscribe((state, prev) => {
      if (state.flagsFlyoutOpen && !prev.flagsFlyoutOpen) {
        useFlagUnseen.getState().acknowledge()
      } else if (!state.flagsFlyoutOpen && prev.flagsFlyoutOpen) {
        useFlagUnseen.getState().clearJustOpened()
      }
    })
  }, [])

  useFlagStream((e: FlagStreamEvent) => {
    // Scoped + coalesced refresh (replaces the per-event blanket): lists,
    // summary badge, unread, activity, this flag's thread, and only the affected
    // entity's button(s).
    enqueueInvalidations(e)

    // Reactions (and in-flight attachment uploads) refresh the thread live but
    // must NOT toast, ping unread, or fly home — reactions never mark a thread
    // unread (spec §6). Guard first, before any relevance/e.flag access.
    if (
      e.event_type === 'comment_reaction' ||
      e.event_type === 'attachment_added'
    )
      return

    const me = useAuthStore.getState().user?.id ?? null
    const ui = useUIStore.getState()
    const showingThisThread =
      ui.flagsFlyoutOpen && ui.flagsThreadId === e.flag_id
    // Relevance (assignee / creator / @mention, minus self-actions) is decided
    // purely from the payload. Watching does NOT notify live.
    const mentions = Array.isArray(e.details?.mentions)
      ? (e.details.mentions as number[])
      : []
    const { relevant, mentioned } = evaluateRelevance(
      {
        actorId: e.actor_id,
        assigneeId: e.flag.assignee_id,
        createdBy: e.flag.created_by,
        mentions,
      },
      me
    )
    // Creating a flag assigned to someone emits 'raised' THEN 'assigned'. Let
    // the 'assigned' event be the single notification (with the "Assigned to
    // you" title + the fly) so the assignee isn't double-toasted.
    const supersededByAssign =
      e.event_type === 'raised' &&
      e.flag.assignee_id != null &&
      e.flag.assignee_id !== e.actor_id

    if (relevant && !showingThisThread && !supersededByAssign) {
      const def = resolveTypeDef(queryClient, e.flag.type)
      // Which triage tab holds this flag for me — the flyout's auto-jump target.
      // Assignee → "Assigned to me"; otherwise (creator or mention) → "Raised by
      // me" as a reasonable default landing tab.
      const tab: FlagTab = e.flag.assignee_id === me ? 'assigned' : 'raised'
      // Persist the ping: survives reload, and drives the header pulse
      // synchronously (independent of whether the fly animation runs).
      useFlagUnseen.getState().markUnseen(e.flag_id, tab)
      // The toast owns the fly-home now: it fires on the toast's auto-close
      // (as it slides away), and clicking the toast opens this flag instead.
      notifyForEvent(e, me, def, mentioned)
    }
  })
}
