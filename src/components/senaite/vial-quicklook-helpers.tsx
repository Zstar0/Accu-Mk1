/**
 * Shared helpers for the vial analyses surfaces (SampleDetails vial mode and
 * VialsQuickLookDialog). Extracted from SampleDetails.tsx so the quick-look
 * dialog can use them without a circular import.
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { fetchSubSamplePhotoUrl } from '@/lib/api'
import { ROLE_BADGE_CLASS } from '@/lib/assignment-colors'
import type { SenaiteAnalysis } from '@/lib/api'

/**
 * Vial photo thumbnail. Mirrors the private VialThumb in
 * intake/ReceiveWizard/VialsList.tsx:44 (fetchSubSamplePhotoUrl is
 * module-level cached, so repeated opens are free). Shared by the Quick Look
 * dialog and the SampleDetails sticky header.
 *
 * `hoverZoom`: on hover the thumbnail appears to grow in place. The base thumb
 * stays static and in flow (constant container size); a second, ALWAYS-absolute
 * overlay img (pointer-events-none, aria-hidden) fades + scales up from the
 * top-right corner on group-hover. Transitioning only opacity/transform (not
 * `position`, which snaps) avoids the v1.4 layout-shift + right-exit flicker.
 *
 * `hideWhenEmpty` renders nothing (no placeholder box) until a photo URL has
 * actually loaded — for surfaces like the sticky header where an optimistic
 * fetch may 404 (the photo endpoint falls back to the parent AR's last
 * attachment for non-sub-sample IDs, which may not exist).
 */
export function VialPhotoThumb({
  sampleId,
  hasPhoto,
  sizeClass = 'w-12 h-12',
  hoverZoom = false,
  hideWhenEmpty = false,
}: {
  sampleId: string
  hasPhoto: boolean
  sizeClass?: string
  hoverZoom?: boolean
  hideWhenEmpty?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hasPhoto) {
      setUrl(null)
      return
    }
    let cancelled = false
    void fetchSubSamplePhotoUrl(sampleId)
      .then(u => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [sampleId, hasPhoto])

  if (hideWhenEmpty && !url) return null

  return (
    <div
      className={cn(
        'rounded bg-muted/60 border shrink-0 overflow-hidden flex items-center justify-center',
        hoverZoom && url && 'relative group overflow-visible',
        sizeClass,
      )}
    >
      {url ? (
        <>
          {/* Base thumb: static, in flow, never changes — container size is
              constant, so the header never shifts. */}
          <img
            src={url}
            alt={`${sampleId} photo`}
            className="w-full h-full object-cover rounded"
          />
          {/* Enlarged overlay: ALWAYS absolute (never in flow → zero layout
              shift), pointer-events-none (can never capture hover → no flicker
              loop), aria-hidden + empty alt (no duplicate a11y node). Animates
              only opacity+transform (GPU-composited, smooth), scaling from the
              top-right corner so it reads as the thumb itself growing. */}
          {hoverZoom && (
            <img
              src={url}
              alt=""
              aria-hidden
              className="pointer-events-none absolute top-0 right-0 z-50 w-[360px] max-w-[70vw] max-h-[480px] object-contain rounded-lg border shadow-xl bg-background opacity-0 scale-50 origin-top-right transition-[opacity,transform] duration-150 group-hover:opacity-100 group-hover:scale-100"
            />
          )}
        </>
      ) : (
        <span className="text-[8px] text-muted-foreground">no photo</span>
      )}
    </div>
  )
}

// --- Role header badge ---
// Mirrors the palette in VialDetailsTab.tsx / VialsList.tsx / SenaiteDashboard.tsx /
// InboxVialCard.tsx. Moved here from SampleDetails.tsx (was the fifth inline copy);
// dedup of the remaining copies is a tracked fast-follow, not in scope here.
export const ROLE_HEADER_BADGES: Record<string, { label: string; cls: string }> = {
  hplc: { label: 'HPLC',   cls: ROLE_BADGE_CLASS.hplc },
  endo: { label: 'ENDO',   cls: ROLE_BADGE_CLASS.endo },
  ster: { label: 'STERYL', cls: ROLE_BADGE_CLASS.ster },
  xtra: { label: 'XTRA',   cls: ROLE_BADGE_CLASS.xtra },
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
  newReviewState: string | null | undefined
): SenaiteAnalysis[] {
  return list.map(a =>
    a.uid === uid
      ? { ...a, result: newResult, review_state: newReviewState ?? a.review_state }
      : a
  )
}
