import { useEffect, useState } from 'react'

/**
 * The latest `value` after it has stopped changing for `delayMs`. A hand-rolled
 * debounce (no new dependency) — each change resets a timer; only the last value
 * in a burst is committed. Used to throttle the flag comment-search request.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
