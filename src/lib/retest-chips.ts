import type {
  ParentPromotionInfo,
  SampleRetestInfo,
  SenaiteAnalysis,
} from './api'

export type RetestLineChip = 'retesting' | 'added' | null

/** Chip for an ORDERED placeholder line on a retest sample: the profile is
 *  being re-run ('retesting') or was bought new on the retest ('added'). */
export function retestChipFor(
  row: Pick<SenaiteAnalysis, 'provenance' | 'profile_section_key'>,
  info:
    | Pick<SampleRetestInfo, 'is_retest' | 'retest' | 'add'>
    | null
    | undefined
): RetestLineChip {
  if (
    !info?.is_retest ||
    row.provenance !== 'ordered' ||
    !row.profile_section_key
  )
    return null
  if (info.retest?.includes(row.profile_section_key)) return 'retesting'
  if (info.add?.includes(row.profile_section_key)) return 'added'
  return null
}

export function isCarriedPromotion(
  p: Pick<ParentPromotionInfo, 'sources'> | undefined
): boolean {
  return Boolean(p?.sources.some(s => s.contribution_kind === 'carried'))
}

/** Where a carried result came from: the original vial, else the original sample. */
export function carriedSourceLabel(
  p: Pick<ParentPromotionInfo, 'sources'>
): string {
  const s =
    p.sources.find(x => x.contribution_kind === 'carried') ?? p.sources[0]
  return s?.sample_id ?? s?.parent_sample_id ?? 'original'
}
