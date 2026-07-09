/**
 * Per-tab persisted filter state for the flags flyout.
 * Stored under `flags:filter:<tab>` (same localStorage idiom as
 * `flags:viewMode`); personal tabs default to the composite All-Open status.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  EMPTY_FLAG_FILTER,
  type FlagFilterState,
} from '@/components/flags/flag-filter'

const KEY = (tab: string) => `flags:filter:${tab}`
const PERSONAL_TABS = new Set(['assigned', 'raised', 'watching'])

export function defaultFlagFilter(tab: string): FlagFilterState {
  return {
    ...EMPTY_FLAG_FILTER,
    status: PERSONAL_TABS.has(tab) ? 'all_open' : 'all',
  }
}

function load(tab: string): FlagFilterState {
  try {
    const raw = localStorage.getItem(KEY(tab))
    if (!raw) return defaultFlagFilter(tab)
    const parsed = JSON.parse(raw)
    // Merge over defaults so missing/new keys stay valid.
    return { ...defaultFlagFilter(tab), ...parsed, text: '' }
  } catch {
    return defaultFlagFilter(tab)
  }
}

/** [filter, setFilter] for a tab; setFilter writes through to localStorage.
 *  Free-text is deliberately session-only (never persisted). */
export function useFlagFilter(
  tab: string
): [FlagFilterState, (next: FlagFilterState) => void] {
  // Free text is session-only; a write bumps `session` (new ref), which
  // re-runs the memo and re-reads localStorage. load() is cheap.
  const [session, setSession] = useState<Record<string, string>>({})

  const filter = useMemo(
    () => ({ ...load(tab), text: session[tab] ?? '' }),
    [tab, session]
  )

  const setFilter = useCallback(
    (next: FlagFilterState) => {
      const { text, ...persisted } = next
      try {
        localStorage.setItem(KEY(tab), JSON.stringify(persisted))
      } catch {
        /* quota/SSR — session-only */
      }
      setSession(s => ({ ...s, [tab]: text }))
    },
    [tab]
  )

  return [filter, setFilter]
}
