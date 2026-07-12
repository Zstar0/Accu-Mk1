import { describe, it, expect } from 'vitest'
import { layoutGraph } from '../GraphCanvas'
import type { WorkflowGraph } from '@/lib/workflow-api'

/**
 * Unlike WorkflowPane.test.tsx (which mocks this whole module so it can
 * assert the pane's plumbing without driving real @xyflow/react in jsdom),
 * this file exercises the REAL dagre integration `layoutGraph` wraps —
 * `new dagre.graphlib.Graph()`, `setNode`/`setEdge`, `dagre.layout`,
 * `g.node()` — since nothing else in the suite ever executes it. Pure
 * function, no React, so no ResizeObserver/jsdom-dimension concerns.
 */

const SAMPLE_GRAPH: WorkflowGraph = {
  scope: 'sample',
  states: [
    {
      id: 1,
      slug: 'sample_due',
      label: 'Sample Due',
      description: null,
      category: 'active',
      color: null,
      sort_order: 0,
      is_builtin: true,
      is_active: true,
      usage_count: 5,
    },
    {
      id: 2,
      slug: 'received',
      label: 'Received',
      description: null,
      category: 'active',
      color: null,
      sort_order: 1,
      is_builtin: true,
      is_active: true,
      usage_count: 3,
    },
    {
      id: 3,
      slug: 'archived',
      label: 'Archived',
      description: null,
      category: 'terminal',
      color: null,
      sort_order: 2,
      is_builtin: false,
      is_active: false,
      usage_count: 0,
    },
  ],
  transitions: [
    {
      id: 10,
      from_state_id: 1,
      to_state_id: 2,
      verb: 'receive',
      label: 'Receive',
      description: null,
      requirements: [],
      is_builtin: true,
      is_active: true,
    },
    {
      id: 11,
      from_state_id: 2,
      to_state_id: 3,
      verb: 'archive',
      label: null,
      description: null,
      requirements: [],
      is_builtin: false,
      is_active: false,
    },
  ],
}

// Mirrors the analysis scope's 'retest' verified -> verified self-loop the
// task brief calls out explicitly as a v1 acceptance criterion.
const ANALYSIS_GRAPH: WorkflowGraph = {
  scope: 'analysis',
  states: [
    {
      id: 1,
      slug: 'verified',
      label: 'Verified',
      description: null,
      category: 'active',
      color: null,
      sort_order: 0,
      is_builtin: true,
      is_active: true,
      usage_count: 12,
    },
  ],
  transitions: [
    {
      id: 20,
      from_state_id: 1,
      to_state_id: 1,
      verb: 'retest',
      label: 'Retest',
      description: null,
      requirements: [],
      is_builtin: true,
      is_active: true,
    },
  ],
}

describe('layoutGraph (real dagre integration)', () => {
  it('positions every visible state as a node and every visible transition as an edge', () => {
    const { nodes, edges } = layoutGraph(SAMPLE_GRAPH, false)

    // 'archived' is inactive and showInactive=false, so it (and the
    // transition into it) is dropped entirely, not just ghosted.
    expect(nodes.map(n => n.id).sort()).toEqual(['1', '2'])
    expect(edges.map(e => e.id)).toEqual(['10'])

    for (const node of nodes) {
      expect(node.type).toBe('state')
      expect(node.style).toEqual({ width: 180, height: 64 })
      // dagre must have actually run and returned finite coordinates —
      // this is the line that would throw/NaN if the dagre default-export
      // ESM interop were wrong.
      expect(Number.isFinite(node.position.x)).toBe(true)
      expect(Number.isFinite(node.position.y)).toBe(true)
    }

    const sampleDueNode = nodes.find(n => n.id === '1')
    expect(sampleDueNode?.data.state.slug).toBe('sample_due')

    const edge = edges[0]
    expect(edge).toBeDefined()
    expect(edge?.source).toBe('1')
    expect(edge?.target).toBe('2')
    expect(edge?.label).toBe('Receive')
  })

  it('includes inactive states/transitions, ghosted via style, when showInactive is true', () => {
    const { nodes, edges } = layoutGraph(SAMPLE_GRAPH, true)

    expect(nodes.map(n => n.id).sort()).toEqual(['1', '2', '3'])
    expect(edges.map(e => e.id).sort()).toEqual(['10', '11'])

    const archiveEdge = edges.find(e => e.id === '11')
    // Inactive transitions get a dashed/faded style, not a different type.
    expect(archiveEdge?.style).toMatchObject({ opacity: 0.5 })
  })

  it('lays out a self-loop transition (verified -> verified) without throwing, offset via labelStyle', () => {
    const { nodes, edges } = layoutGraph(ANALYSIS_GRAPH, false)

    expect(nodes).toHaveLength(1)
    expect(edges).toHaveLength(1)

    const loop = edges[0]
    expect(loop).toBeDefined()
    expect(loop?.source).toBe('1')
    expect(loop?.target).toBe('1')
    expect(loop?.label).toBe('Retest')
    // The v1 self-loop treatment: default edge type + an offset label,
    // rather than custom loop-path geometry.
    expect(loop?.labelStyle).toMatchObject({
      transform: expect.stringContaining('translateY'),
    })
  })
})
