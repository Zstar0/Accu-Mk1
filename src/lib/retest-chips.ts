import {
  HPLC_PROFILE_KEYS,
  type ParentPromotionInfo,
  type SampleRetestInfo,
  type SenaiteAnalysis,
} from './api'

export type RetestLineChip = 'retesting' | 'added' | null

const HPLC_KEYS: readonly string[] = HPLC_PROFILE_KEYS

/** A spec may name the legacy HPLC alias while the placeholders carry the
 *  native twin's key: both spellings are one profile. */
function sameProfile(a: string, b: string): boolean {
  return a === b || (HPLC_KEYS.includes(a) && HPLC_KEYS.includes(b))
}

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
  const key = row.profile_section_key
  if (info.retest?.some(k => sameProfile(k, key))) return 'retesting'
  if (info.add?.some(k => sameProfile(k, key))) return 'added'
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
