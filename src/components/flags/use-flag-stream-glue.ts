import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useFlagStream, type FlagStreamEvent } from '@/lib/flag-stream'
import { flagKeys } from '@/hooks/use-flags'
import { flagTypeKeys } from '@/services/flag-types'
import { useUIStore } from '@/store/ui-store'
import { useAuthStore } from '@/store/auth-store'
import { useFlagUnseen } from '@/components/flags/use-flag-unseen'
import { toast } from 'sonner'
import { flagTypeDef, type FlagTypeDef } from '@/components/flags/flag-catalog'
import type { FlagType } from '@/lib/flags-api'
import { FLAGS_BUTTON_ID } from '@/components/flags/FlagsHeaderButton'

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
  def: FlagTypeDef
) {
  const title = toastTitle(e, me)
  const opts = {
    description: e.flag.title,
    // Click the toast → open the flyout to this flag's thread.
    onClick: () => useUIStore.getState().openFlagThread(e.flag_id),
    // The fly-home flourish waits until the toast auto-dismisses (starts to
    // slide away) — and only if the user hasn't opened the flyout meanwhile.
    onAutoClose: () => {
      if (!useUIStore.getState().flagsFlyoutOpen) flyToFlagsButton(def.color)
    },
  }
  if (e.flag.type === 'blocker') toast.error(title, opts)
  else if (e.flag.type === 'critical') toast.warning(title, opts)
  else if (def.kind === 'signal') toast.success(title, opts)
  else toast.info(title, opts)
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
    // Cheap blanket refresh: lists, summary badge, and any open thread.
    queryClient.invalidateQueries({ queryKey: flagKeys.all })

    const me = useAuthStore.getState().user?.id ?? null
    const ui = useUIStore.getState()
    const showingThisThread =
      ui.flagsFlyoutOpen && ui.flagsThreadId === e.flag_id
    // Never notify yourself for your OWN action (you're the actor).
    const isMyAction = me != null && e.actor_id === me
    const relevant =
      me != null &&
      !isMyAction &&
      (e.flag.assignee_id === me || e.flag.created_by === me)
    // Creating a flag assigned to someone emits 'raised' THEN 'assigned'. Let
    // the 'assigned' event be the single notification (with the "Assigned to
    // you" title + the fly) so the assignee isn't double-toasted.
    const supersededByAssign =
      e.event_type === 'raised' &&
      e.flag.assignee_id != null &&
      e.flag.assignee_id !== e.actor_id

    if (relevant && !showingThisThread && !supersededByAssign) {
      const def = resolveTypeDef(queryClient, e.flag.type)
      // Persist the ping: survives reload, and drives the header pulse
      // synchronously (independent of whether the fly animation runs).
      useFlagUnseen.getState().markUnseen(e.flag_id)
      // The toast owns the fly-home now: it fires on the toast's auto-close
      // (as it slides away), and clicking the toast opens this flag instead.
      notifyForEvent(e, me, def)
    }
  })
}
