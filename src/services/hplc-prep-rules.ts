import { useQuery } from '@tanstack/react-query'
import { getHplcPrepRules } from '@/lib/api'

/** The HPLC rules list's cache key: the rules page writes it, and saving a
 *  line updates it. */
export const HPLC_PREP_RULES_KEY = ['hplc-prep-rules'] as const

/** Every HPLC rule line (inactive ones too; the matcher skips them).
 *  Short-lived, as the endotoxin rules are: the lab edits them often. */
export function useHplcPrepRules(enabled = true) {
  return useQuery({
    queryKey: HPLC_PREP_RULES_KEY,
    queryFn: getHplcPrepRules,
    staleTime: 30_000,
    enabled,
  })
}
