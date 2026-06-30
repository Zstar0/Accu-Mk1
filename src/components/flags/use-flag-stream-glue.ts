import { useEffect, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useFlagStream, type FlagStreamEvent } from '@/lib/flag-stream'
import { flagKeys } from '@/hooks/use-flags'
import { flagTypeKeys } from '@/services/flag-types'
import { useUIStore } from '@/store/ui-store'
import { useAuthStore } from '@/store/auth-store'
import { notifications } from '@/lib/notifications'
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
  if (e.flag.type === 'blocker') notifications.error(title, e.flag.title)
  else if (e.flag.type === 'critical')
    notifications.warning(title, e.flag.title)
  else if (def.kind === 'signal') notifications.success(title, e.flag.title)
  else notifications.info(title, e.flag.title)
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
 * relevant to the current user that they aren't already looking at — raises the
 * glow signal, a toast, and (when the flyout is closed) the fly-home flourish.
 *
 * Relevance = assignee or creator is me. "Watching"-based relevance is deferred:
 * the event payload doesn't carry the viewer's watch set, so we can't decide it
 * client-side without extra state (documented gap — lists still update in place).
 *
 * Returns `hasNew` for the header button glow.
 */
export function useFlagStreamGlue(): boolean {
  const queryClient = useQueryClient()
  const [hasNew, setHasNew] = useState(false)

  // Opening the flyout is where you see what's new — clear the glow on the
  // closed→open transition. Driven by a store subscription (not a setState in an
  // effect body) so it stays off React's render path.
  useEffect(() => {
    return useUIStore.subscribe((state, prev) => {
      if (state.flagsFlyoutOpen && !prev.flagsFlyoutOpen) setHasNew(false)
    })
  }, [])

  useFlagStream((e: FlagStreamEvent) => {
    // Cheap blanket refresh: lists, summary badge, and any open thread.
    queryClient.invalidateQueries({ queryKey: flagKeys.all })

    const me = useAuthStore.getState().user?.id ?? null
    const ui = useUIStore.getState()
    const showingThisThread =
      ui.flagsFlyoutOpen && ui.flagsThreadId === e.flag_id
    const relevant =
      me != null && (e.flag.assignee_id === me || e.flag.created_by === me)

    if (relevant && !showingThisThread) {
      const def = resolveTypeDef(queryClient, e.flag.type)
      setHasNew(true)
      notifyForEvent(e, me, def)
      if (e.event_type === 'raised' && !ui.flagsFlyoutOpen) {
        flyToFlagsButton(def.color)
      }
    }
  })

  return hasNew
}
