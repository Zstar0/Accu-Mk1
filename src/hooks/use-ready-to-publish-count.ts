/**
 * Ready to Publish counts for the header button and the sidebar entry.
 *
 * One query key shared by every consumer, so the header and the sidebar never
 * double-fetch. Polls every 60 s and on window focus; the backend serves the
 * same 60 s cache to every client and clears it on each publish, so the chips
 * are at most a minute behind and never show a sample that just went out.
 *
 * Two numbers (Handler ruling 2026-09-11):
 *  - `ready`   — live rows that are NOT partial: every line verified (or a
 *                full "Ready for Publish" flag). Red chip.
 *  - `partial` — live rows carrying a "Ready for Partial Publish" flag: these
 *                usually publish twice (HPLC first, the rest later). Green chip.
 * Held rows are in neither.
 */
import { useQuery } from '@tanstack/react-query'
import { getReadyToPublishSummary } from '@/lib/api'

export const READY_TO_PUBLISH_SUMMARY_KEY = [
  'reports',
  'ready-to-publish',
  'summary',
] as const

export interface ReadyToPublishCounts {
  ready: number
  partial: number
}

export function useReadyToPublishCount(): ReadyToPublishCounts {
  const { data } = useQuery({
    queryKey: READY_TO_PUBLISH_SUMMARY_KEY,
    queryFn: () => getReadyToPublishSummary(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
  const totals = data?.totals
  if (!totals) return { ready: 0, partial: 0 }
  const partial = totals.flag_partial
  return { ready: Math.max(0, totals.rows - partial), partial }
}
