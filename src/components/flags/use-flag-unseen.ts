/**
 * Persisted "unseen flags" — the flag ids the current user was pinged about (a
 * relevant SSE event) but hasn't looked at yet. Backed by `localStorage`
 * (`flags:unseen`) so the Flags-bar pulse SURVIVES a page reload and only clears
 * when the user actually opens the flyout. SSR/no-window safe (empty set, no
 * persistence).
 *
 * One primitive, two fields:
 *  - `unseenIds`  (persisted)  → drives the header-button pulse; the standing
 *                                "you have something new you haven't looked at".
 *  - `justOpened` (transient)  → a snapshot taken the instant the flyout opens,
 *                                so the rows the user was pinged about can pulse
 *                                even though `unseenIds` is being cleared on the
 *                                same tick.
 *
 * The bar glow lands off THIS state — set synchronously in the SSE callback, not
 * on the toast lifecycle — so it's reliable even when the fly-home flourish
 * doesn't run (e.g. a backgrounded tab pausing rAF). The animation is flourish;
 * this is the source of truth.
 */
import { create } from 'zustand'

const STORAGE_KEY = 'flags:unseen'

function readStored(): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === 'number')
      : []
  } catch {
    return []
  }
}

function writeStored(ids: number[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Ignore write failures (private mode / quota) — in-memory state still updates.
  }
}

interface FlagUnseenState {
  /** Persisted: pinged-but-not-looked-at flag ids. Drives the bar pulse. */
  unseenIds: number[]
  /** Transient: snapshot of `unseenIds` captured when the flyout opened. */
  justOpened: number[]
  /** A relevant event arrived for a flag the user isn't already looking at. */
  markUnseen: (flagId: number) => void
  /** Flyout opened: snapshot unseen → `justOpened`, then clear unseen (stops the bar pulse). */
  acknowledge: () => void
  /** Flyout closed: drop the row-pulse snapshot so a re-open doesn't re-pulse. */
  clearJustOpened: () => void
}

export const useFlagUnseen = create<FlagUnseenState>((set, get) => ({
  // Read once at store init — a page reload re-runs this and rehydrates the set.
  unseenIds: readStored(),
  justOpened: [],
  markUnseen: flagId => {
    const { unseenIds } = get()
    if (unseenIds.includes(flagId)) return
    const next = [...unseenIds, flagId]
    writeStored(next)
    set({ unseenIds: next })
  },
  acknowledge: () => {
    const { unseenIds } = get()
    if (unseenIds.length === 0) return
    writeStored([])
    set({ unseenIds: [], justOpened: unseenIds })
  },
  clearJustOpened: () => {
    if (get().justOpened.length === 0) return
    set({ justOpened: [] })
  },
}))
