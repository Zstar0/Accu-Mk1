import { useStore } from '@xyflow/react'

export const COMPACT_BELOW = 0.5

/** Below this zoom, items show their label only (spec 8.3 zoom-semantic rendering). */
export function useCompact(): boolean {
  return useStore(s => s.transform[2] < COMPACT_BELOW)
}
