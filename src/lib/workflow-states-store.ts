import { create } from 'zustand'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { getWorkflowGraph, type WorkflowCategory, type WorkflowState } from '@/lib/workflow-api'

/** Catalog is the source of truth for sample status labels (spec 2026-09-09 §7.2).
 *  A plain zustand store so badges work with no provider (tests, storybook);
 *  empty store = hardcoded fallback maps. */
interface StateInfo { label: string; category: WorkflowCategory; sort_order: number }
interface WorkflowStatesStore {
  states: Record<string, StateInfo>
  setStates: (list: WorkflowState[]) => void
}

export const useWorkflowStatesStore = create<WorkflowStatesStore>(set => ({
  states: {},
  setStates: list =>
    set({
      states: Object.fromEntries(
        list.map(s => [s.slug, { label: s.label, category: s.category, sort_order: s.sort_order }])
      ),
    }),
}))

export function labelFor(slug: string, fallback: string): string {
  return useWorkflowStatesStore.getState().states[slug]?.label ?? fallback
}

export function useStateLabel(slug: string, fallback: string): string {
  return useWorkflowStatesStore(s => s.states[slug]?.label ?? fallback)
}

/** Mount once near the app root: fetches the sample-scope graph and fills the store. */
export function WorkflowStatesLoader() {
  const setStates = useWorkflowStatesStore(s => s.setStates)
  const { data } = useQuery({
    queryKey: ['workflow', 'graph', 'sample'],
    queryFn: () => getWorkflowGraph('sample'),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })
  useEffect(() => {
    if (data?.states) setStates(data.states.filter(s => s.is_active))
  }, [data, setStates])
  return null
}
