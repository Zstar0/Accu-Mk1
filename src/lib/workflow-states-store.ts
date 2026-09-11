import { create } from 'zustand'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { getWorkflowGraph, type WorkflowCategory, type WorkflowScope, type WorkflowState } from '@/lib/workflow-api'

/** Catalog is the source of truth for sample status labels (spec 2026-09-09 §7.2).
 *  A plain zustand store so badges work with no provider (tests, storybook);
 *  empty store = hardcoded fallback maps.
 *
 *  Scope-aware (final-review follow-up 2026-09-09): `states` holds the
 *  sample-scope catalog (unchanged name/shape for existing callers/tests);
 *  `analysisStates` holds the analysis-scope catalog for analysis-tier rows
 *  (unassigned/assigned/to_be_verified/verified/promoted/…). The two maps
 *  are independent — loading one never touches the other. */
interface StateInfo { label: string; category: WorkflowCategory; sort_order: number }
interface WorkflowStatesStore {
  states: Record<string, StateInfo>
  analysisStates: Record<string, StateInfo>
  setStates: (list: WorkflowState[], scope?: WorkflowScope) => void
}

function toStateMap(list: WorkflowState[]): Record<string, StateInfo> {
  return Object.fromEntries(
    list.map(s => [s.slug, { label: s.label, category: s.category, sort_order: s.sort_order }])
  )
}

export const useWorkflowStatesStore = create<WorkflowStatesStore>(set => ({
  states: {},
  analysisStates: {},
  setStates: (list, scope = 'sample') =>
    set(scope === 'analysis' ? { analysisStates: toStateMap(list) } : { states: toStateMap(list) }),
}))

export function labelFor(slug: string, fallback: string, scope: WorkflowScope = 'sample'): string {
  const state = useWorkflowStatesStore.getState()
  const map = scope === 'analysis' ? state.analysisStates : state.states
  return map[slug]?.label ?? fallback
}

export function useStateLabel(slug: string, fallback: string, scope: WorkflowScope = 'sample'): string {
  return useWorkflowStatesStore(s => (scope === 'analysis' ? s.analysisStates : s.states)[slug]?.label ?? fallback)
}

/** Mount once near the app root: fetches the sample-scope and analysis-scope
 *  graphs and fills the store. */
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

  const { data: analysisData } = useQuery({
    queryKey: ['workflow', 'graph', 'analysis'],
    queryFn: () => getWorkflowGraph('analysis'),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })
  useEffect(() => {
    if (analysisData?.states) setStates(analysisData.states.filter(s => s.is_active), 'analysis')
  }, [analysisData, setStates])

  return null
}
