// Shared refresh for box mutations, mirroring invalidateVialAssignmentCaches
// in vial-assignment.ts: one helper owns the key list so the surfaces that
// render box state can't silently drift from the invalidate calls.
import type { QueryClient } from '@tanstack/react-query'

/**
 * Refetch every active query that renders box state after a box mutation
 * (create/assign/unassign/delete/print in BoxStep, close on Active Boxes).
 *
 * A box change touches more than the Boxing tab: the Active Boxes page's
 * counts (['active-boxes']), the sample-header box chip fed by the parent's
 * sub-samples list (['sub-samples']), and the worksheet Box column
 * (['worksheets']) all carry box membership. Pass the orderKey to scope the
 * order-level keys (['order-boxes'|'order-vials', orderKey, ...] match by
 * prefix); omit it where the order is unknown (e.g. closing from the Active
 * Boxes list) to invalidate every order's box/vial queries.
 */
export async function invalidateBoxCaches(
  queryClient: QueryClient,
  orderKey?: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: orderKey ? ['order-boxes', orderKey] : ['order-boxes'],
    }),
    queryClient.invalidateQueries({
      queryKey: orderKey ? ['order-vials', orderKey] : ['order-vials'],
    }),
    queryClient.invalidateQueries({ queryKey: ['active-boxes'] }),
    queryClient.invalidateQueries({ queryKey: ['sub-samples'] }),
    queryClient.invalidateQueries({ queryKey: ['worksheets'] }),
  ])
}
