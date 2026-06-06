/**
 * Shared helpers for the vial analyses surfaces (SampleDetails vial mode and
 * VialsQuickLookDialog). Extracted from SampleDetails.tsx so the quick-look
 * dialog can use them without a circular import.
 */
import { cn } from '@/lib/utils'
import type { SenaiteAnalysis } from '@/lib/api'

// --- Role header badge ---
// Mirrors the palette in VialDetailsTab.tsx / VialsList.tsx / SenaiteDashboard.tsx /
// InboxVialCard.tsx. Moved here from SampleDetails.tsx (was the fifth inline copy);
// dedup of the remaining copies is a tracked fast-follow, not in scope here.
export const ROLE_HEADER_BADGES: Record<string, { label: string; cls: string }> = {
  hplc: { label: 'HPLC',   cls: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300' },
  endo: { label: 'ENDO',   cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-300' },
  ster: { label: 'STERYL', cls: 'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300' },
  xtra: { label: 'XTRA',   cls: 'bg-zinc-500/15 text-zinc-700 border-zinc-500/40 dark:text-zinc-300' },
}

export function RoleHeaderBadge({ role }: { role: string }) {
  const b = ROLE_HEADER_BADGES[role]
  if (!b) return null
  return (
    <span
      className={cn(
        'inline-block text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide font-medium',
        b.cls,
      )}
      title={`Vial assignment: ${b.label}`}
    >
      {b.label}
    </span>
  )
}

/**
 * Build the set of analysis UIDs that are "primary" for a vial-assignment
 * role — used to highlight (not filter) rows in the analyses table. Mapping:
 *   hplc → analyses in service_group 'Analytics'
 *   endo → keyword starts with 'ENDO' (within Microbiology)
 *   ster → keyword starts with 'STER' (within Microbiology)
 *   xtra → no primary analyses (vial parked for backup)
 */
export function computePrimaryAnalysisUids(
  analyses: SenaiteAnalysis[],
  role: string | null
): Set<string> {
  const set = new Set<string>()
  if (!role) return set
  for (const a of analyses) {
    if (!a.uid) continue
    const kw = (a.keyword ?? '').toUpperCase()
    const groupName = a.service_group_name ?? ''
    if (role === 'hplc') {
      if (groupName === 'Analytics') set.add(a.uid)
    } else if (role === 'endo') {
      if (kw.startsWith('ENDO')) set.add(a.uid)
    } else if (role === 'ster') {
      if (kw.startsWith('STER')) set.add(a.uid)
    }
  }
  return set
}

/**
 * Immutable single-row patch used by onResultSaved/onMethodInstrumentSaved
 * cache updates. Mirrors the setData mapping in SampleDetails.tsx (~3592-3604).
 */
export function patchAnalysisInList(
  list: SenaiteAnalysis[],
  uid: string,
  newResult: string,
  newReviewState: string | undefined
): SenaiteAnalysis[] {
  return list.map(a =>
    a.uid === uid
      ? { ...a, result: newResult, review_state: newReviewState ?? a.review_state }
      : a
  )
}
