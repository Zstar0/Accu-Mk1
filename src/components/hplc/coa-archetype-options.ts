// COA Section archetype choices for the Analysis Profile editor's Select.
// 'none' is the sentinel for a NULL coa_archetype (not reported); see the
// onValueChange handler in AnalysisProfilesPage.tsx.
export const COA_ARCHETYPE_OPTIONS = [
  { value: 'none', label: 'Not reported' },
  { value: 'limit_table', label: 'Limit table' },
  { value: 'legacy_hplc', label: 'Legacy (HPLC page 1)' },
] as const
