/**
 * Persisted "unseen flags" — the flag ids the current user was pinged about (a
 * relevant SSE event) but hasn't looked at yet. Backed by `localStorage` so the
 * Flags-bar pulse SURVIVES a page reload and only clears when the user actually
 * opens the flyout. SSR/no-window safe (empty set, no persistence).
 *
 * One primitive, four fields:
 *  - `unseenIds`   (persisted)  → drives the header-button pulse; the standing
 *                                 "you have something new you haven't looked at".
 *  - `pendingTab`  (persisted)  → the triage tab holding the NEWEST ping
 *                                 ('assigned' vs 'raised'), so the flyout can
 *                                 auto-jump there even after a reload.
 *  - `justOpened`  (transient)  → snapshot of `unseenIds` taken when the flyout
 *                                 opens, so the pinged rows can pulse even though
 *                                 `unseenIds` is being cleared on the same tick.
 *  - `justOpenedTab` (transient)→ snapshot of `pendingTab` for the same open;
 *                                 the tab the flyout jumps to.
 *
 * The bar glow lands off THIS state — set synchronously in the SSE callback, not
 * on the toast lifecycle — so it's reliable even when the fly-home flourish
 * doesn't run (e.g. a backgrounded tab pausing rAF). The animation is flourish;
 * this is the source of truth.
 */
import { create } from 'zustand'
import type { FlagTab } from '@/lib/flags-api'

const IDS_KEY = 'flags:unseen'
const TAB_KEY = 'flags:unseenTab'

function readStoredIds(): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(IDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === 'number')
      : []
  } catch {
    return []
  }
}

const FLAG_TABS: readonly FlagTab[] = ['assigned', 'raised', 'watching', 'all_open']

function readStoredTab(): FlagTab | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(TAB_KEY)
    return FLAG_TABS.includes(raw as FlagTab) ? (raw as FlagTab) : null
  } catch {
    return null
  }
}

function writeStored(ids: number[], tab: FlagTab | null): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(IDS_KEY, JSON.stringify(ids))
    if (tab) window.localStorage.setItem(TAB_KEY, tab)
    else window.localStorage.removeItem(TAB_KEY)
  } catch {
    // Ignore write failures (private mode / quota) — in-memory state still updates.
  }
}

interface FlagUnseenState {
  /** Persisted: pinged-but-not-looked-at flag ids. Drives the bar pulse. */
  unseenIds: number[]
  /** Persisted: triage tab of the newest ping — the flyout's auto-jump target. */
  pendingTab: FlagTab | null
  /** Transient: snapshot of `unseenIds` captured when the flyout opened. */
  justOpened: number[]
  /** Transient: snapshot of `pendingTab` for the same open. */
  justOpenedTab: FlagTab | null
  /** A relevant event arrived for a flag the user isn't already looking at. */
  markUnseen: (flagId: number, tab?: FlagTab | null) => void
  /** Flyout opened: snapshot unseen ids + tab → transient, clear the persisted set. */
  acknowledge: () => void
  /** Flyout closed: drop the transient snapshots so a re-open doesn't re-pulse/jump. */
  clearJustOpened: () => void
}

export const useFlagUnseen = create<FlagUnseenState>((set, get) => ({
  // Read once at store init — a page reload re-runs this and rehydrates both.
  unseenIds: readStoredIds(),
  pendingTab: readStoredTab(),
  justOpened: [],
  justOpenedTab: null,
  markUnseen: (flagId, tab = null) => {
    const { unseenIds } = get()
    const ids = unseenIds.includes(flagId) ? unseenIds : [...unseenIds, flagId]
    // Newest ping wins the jump target, even if the id was already unseen.
    writeStored(ids, tab)
    set({ unseenIds: ids, pendingTab: tab })
  },
  acknowledge: () => {
    const { unseenIds, pendingTab } = get()
    if (unseenIds.length === 0) return
    writeStored([], null)
    set({
      unseenIds: [],
      pendingTab: null,
      justOpened: unseenIds,
      justOpenedTab: pendingTab,
    })
  },
  clearJustOpened: () => {
    if (get().justOpened.length === 0 && get().justOpenedTab == null) return
    set({ justOpened: [], justOpenedTab: null })
  },
}))
