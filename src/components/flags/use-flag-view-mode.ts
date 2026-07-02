/**
 * Persisted flyout view mode — the stacked `list` cards vs. the aligned-columns
 * `table` (Plan 8). Backed by `localStorage` so the choice sticks across
 * sessions; defaults to `table`. SSR/no-window safe (returns the default and
 * silently skips persistence).
 */
import { useCallback, useState } from 'react'

export type FlagViewMode = 'list' | 'table'

const STORAGE_KEY = 'flags:viewMode'
const DEFAULT_MODE: FlagViewMode = 'table'

function readStored(): FlagViewMode {
  if (typeof window === 'undefined') return DEFAULT_MODE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === 'list' || raw === 'table' ? raw : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

/** `[mode, setMode]` — persists every set to `localStorage` (`flags:viewMode`). */
export function useFlagViewMode(): [
  FlagViewMode,
  (mode: FlagViewMode) => void,
] {
  const [mode, setMode] = useState<FlagViewMode>(readStored)

  const set = useCallback((next: FlagViewMode) => {
    setMode(next)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Ignore write failures (private mode / quota) — state still updates.
    }
  }, [])

  return [mode, set]
}
