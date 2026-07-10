/**
 * Persisted thread timeline view mode — the default chat `bubbles` vs. the
 * flush-left Slack-style `compact` rows. Backed by `localStorage` so the choice
 * sticks across sessions; defaults to `bubbles`. SSR/no-window safe (returns the
 * default and silently skips persistence). Mirrors `use-flag-view-mode.ts`.
 */
import { useCallback, useState } from 'react'

export type ThreadViewMode = 'bubbles' | 'compact'

const STORAGE_KEY = 'flags:threadView'
const DEFAULT_MODE: ThreadViewMode = 'bubbles'

function readStored(): ThreadViewMode {
  if (typeof window === 'undefined') return DEFAULT_MODE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === 'bubbles' || raw === 'compact' ? raw : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

/** `[mode, setMode]` — persists every set to `localStorage` (`flags:threadView`). */
export function useThreadViewMode(): [
  ThreadViewMode,
  (mode: ThreadViewMode) => void,
] {
  const [mode, setMode] = useState<ThreadViewMode>(readStored)

  const set = useCallback((next: ThreadViewMode) => {
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
