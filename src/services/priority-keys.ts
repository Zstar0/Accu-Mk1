// Query keys live in their own module so `services/sla.ts` can invalidate the
// priorities catalog without importing `services/priorities.ts`, which already
// imports `slaQueryKeys` from `services/sla.ts` (that pair would be a cycle).
// `services/priorities.ts` re-exports `priorityQueryKeys`, so existing
// importers are unaffected.
export const priorityQueryKeys = {
  all: ['priorities'] as const,
  customers: ['priorities', 'customers'] as const,
}
