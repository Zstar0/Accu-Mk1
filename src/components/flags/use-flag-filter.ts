/**
 * Per-tab persisted filter state for the flags flyout (and the Tasks page).
 * Stored under `<scope>:filter:<tab>`, scope defaulting to `flags` (same
 * localStorage idiom as `flags:viewMode`); personal tabs default to the
 * composite All-Open status in every scope.
 */
import { useCallback, useState } from 'react'
import {
  EMPTY_FLAG_FILTER,
  type FlagFilterState,
} from '@/components/flags/flag-filter'

const KEY = (scope: string, tab: string) => `${scope}:filter:${tab}`
const PERSONAL_TABS = new Set(['assigned', 'raised', 'watching'])

export function defaultFlagFilter(tab: string): FlagFilterState {
  return {
    ...EMPTY_FLAG_FILTER,
    status: PERSONAL_TABS.has(tab) ? 'all_open' : 'all',
  }
}

function load(scope: string, tab: string): FlagFilterState {
  try {
    const raw = localStorage.getItem(KEY(scope, tab))
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
  tab: string,
  scope = 'flags'
): [FlagFilterState, (next: FlagFilterState) => void] {
  // React state is the source of truth; localStorage is a write-through
  // consulted only for tabs with no state yet (first render / tab switch).
  // Do NOT re-read localStorage inside render memoization: React Compiler
  // caches the impure read keyed on `tab` alone, so same-tab writes persist
  // but never re-render — filters silently "apply on next reload".
  const [byTab, setByTab] = useState<Record<string, FlagFilterState>>({})

  const key = KEY(scope, tab)
  const filter = byTab[key] ?? load(scope, tab)

  const setFilter = useCallback(
    (next: FlagFilterState) => {
      const { text: _text, ...persisted } = next
      try {
        localStorage.setItem(key, JSON.stringify(persisted))
      } catch {
        /* quota/SSR — session-only */
      }
      setByTab(s => ({ ...s, [key]: next }))
    },
    [key]
  )

  return [filter, setFilter]
}
