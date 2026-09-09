import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useWorkflowStatesStore, labelFor } from '@/lib/workflow-states-store'
import { StateBadge } from '@/components/senaite/senaite-utils'
import { StatusBadge } from '@/components/senaite/AnalysisTable'

beforeEach(() => {
  useWorkflowStatesStore.setState({ states: {}, analysisStates: {} })
})

describe('workflow states store', () => {
  it('falls back to the hardcoded map when the store is empty', () => {
    render(<StateBadge state="to_be_verified" />)
    expect(screen.getByText('To Verify')).toBeInTheDocument()
    expect(labelFor('on_hold', 'on_hold')).toBe('on_hold')
  })

  it('uses the catalog label once loaded, including runtime-added states', () => {
    useWorkflowStatesStore.getState().setStates([
      { id: 1, slug: 'to_be_verified', label: 'Awaiting review', category: 'active', sort_order: 60 } as never,
      { id: 2, slug: 'on_hold', label: 'On hold', category: 'active', sort_order: 55 } as never,
    ])
    render(<><StateBadge state="to_be_verified" /><StateBadge state="on_hold" /></>)
    expect(screen.getByText('Awaiting review')).toBeInTheDocument()
    expect(screen.getByText('On hold')).toBeInTheDocument()
  })

  // spec 7.2 named two more hardcoded maps; both now consult the catalog.
  // AnalysisTable's StatusBadge covers analysis-tier rows (unassigned/
  // assigned/to_be_verified/verified/promoted/…), so it reads the
  // analysis-scope catalog, not the sample-scope map above (final-review
  // follow-up 2026-09-09: fixes a scope mismatch where analysis rows were
  // rendering the sample state's label).
  it("AnalysisTable's StatusBadge falls back to its own map, then reads the analysis-scope catalog", () => {
    const { unmount } = render(<StatusBadge state="on_hold" />)
    expect(screen.getByText('on hold')).toBeInTheDocument()
    unmount()
    useWorkflowStatesStore.getState().setStates([
      { id: 1, slug: 'on_hold', label: 'On hold', category: 'active', sort_order: 55 } as never,
    ], 'analysis')
    render(<StatusBadge state="on_hold" />)
    expect(screen.getByText('On hold')).toBeInTheDocument()
  })

  // Sample-scope and analysis-scope catalogs are separate maps: loading one
  // must not leak into the other, and each accessor must pick the map its
  // caller asked for.
  describe('scope isolation', () => {
    it('setStates(list, "analysis") fills analysisStates without touching states', () => {
      useWorkflowStatesStore.getState().setStates([
        { id: 1, slug: 'to_be_verified', label: 'Awaiting Promotion', category: 'active', sort_order: 60 } as never,
      ], 'analysis')
      expect(useWorkflowStatesStore.getState().states).toEqual({})
      expect(useWorkflowStatesStore.getState().analysisStates.to_be_verified?.label).toBe('Awaiting Promotion')
    })

    it('labelFor resolves the analysis-scope label only when scope="analysis" is passed, and the sample map stays independent', () => {
      useWorkflowStatesStore.getState().setStates([
        { id: 1, slug: 'to_be_verified', label: 'Awaiting Promotion', category: 'active', sort_order: 60 } as never,
      ], 'analysis')
      expect(labelFor('to_be_verified', 'To Verify', 'analysis')).toBe('Awaiting Promotion')
      // sample map (default scope) is still empty, so the fallback wins
      expect(labelFor('to_be_verified', 'x')).toBe('x')
    })
  })

  // OrderStatusPage's sampleStateLabel is a module-private function, so its
  // resolution chain is pinned through the store helper it now calls —
  // labelFor(slug, map[slug] ?? state ?? 'Unknown').
  it("resolves OrderStatusPage's sample-state chain: catalog, then map, then raw", () => {
    expect(labelFor('sample_received', 'Received')).toBe('Received')
    expect(labelFor('on_hold', 'on_hold')).toBe('on_hold')
    useWorkflowStatesStore.getState().setStates([
      { id: 1, slug: 'sample_received', label: 'Checked in', category: 'active', sort_order: 30 } as never,
      { id: 2, slug: 'on_hold', label: 'On hold', category: 'active', sort_order: 55 } as never,
    ])
    expect(labelFor('sample_received', 'Received')).toBe('Checked in')
    expect(labelFor('on_hold', 'on_hold')).toBe('On hold')
  })
})
