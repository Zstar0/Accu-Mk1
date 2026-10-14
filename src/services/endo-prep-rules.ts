import { useQuery } from '@tanstack/react-query'
import { getEndoPrepRules } from '@/lib/api'

/** The rules list's cache key: the rules page writes it, every 2 mL surface
 *  reads it, and saving a line invalidates it. */
export const ENDO_PREP_RULES_KEY = ['endo-prep-rules'] as const

/** Every rule line (inactive ones too; the matcher skips them). Short-lived:
 *  the lab edits rules several times a week and a row that is not locked
 *  follows them. */
export function useEndoPrepRules(enabled = true) {
  return useQuery({
    queryKey: ENDO_PREP_RULES_KEY,
    queryFn: getEndoPrepRules,
    staleTime: 30_000,
    enabled,
  })
}
