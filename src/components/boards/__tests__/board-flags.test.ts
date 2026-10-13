import { describe, it, expect } from 'vitest'
import {
  assignedCount,
  attentionList,
  blockingTypeSet,
  dueLabel,
  flagsByAnchor,
  frameRollup,
  locateTargetFor,
  nodeAnchor,
} from '@/components/boards/board-flags'
import type { BoardNode } from '@/lib/api-boards'
import type { FlagResponse } from '@/lib/flags-api'

const node = (o: Partial<BoardNode>): BoardNode => ({
  id: 1,
  board_id: 1,
  kind: 'note',
  label: 'N',
  parent_id: null,
  x: 0,
  y: 0,
  w: null,
  h: null,
  z: 0,
  entity_type: null,
  entity_id: null,
  data: null,
  version: 1,
  created_by: null,
  updated_by: null,
  created_at: '',
  updated_at: '',
  ...o,
})
const flag = (o: Partial<FlagResponse>): FlagResponse => ({
  id: 1,
  entity_type: 'board_node',
  entity_id: '1',
  kind: 'issue',
  type: 'task',
  status: 'open',
  title: 'T',
  created_by: 1,
  assignee_id: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  resolved_at: null,
  resolved_by: null,
  due_at: null,
  ...o,
})
const NOW = new Date('2026-10-12T12:00:00Z')
const blocking = new Set(['blocker'])

describe('board-flags', () => {
  it('anchors: a generic item by its node id, an entity item by its entity', () => {
    expect(nodeAnchor(node({ id: 7 }))).toBe('board_node:7')
    expect(
      nodeAnchor(
        node({ id: 8, kind: 'entity', entity_type: 'sample', entity_id: 'P-1' })
      )
    ).toBe('sample:P-1')
    const by = flagsByAnchor([
      flag({ id: 1, entity_id: '7' }),
      flag({ id: 2, entity_type: 'sample', entity_id: 'P-1' }),
    ])
    expect(by.get('board_node:7')?.map(f => f.id)).toEqual([1])
    expect(by.get('sample:P-1')?.map(f => f.id)).toEqual([2])
  })

  it('a frame rolls up its children, counting an entity child by its entity anchor (Review Focus 2)', () => {
    const nodes = [
      node({ id: 1, kind: 'frame' }),
      node({ id: 2, parent_id: 1 }),
      node({
        id: 3,
        parent_id: 1,
        kind: 'entity',
        entity_type: 'sample',
        entity_id: 'P-1',
      }),
      node({ id: 4 }),
    ]
    const flags = [
      flag({ id: 10, entity_id: '2', type: 'blocker' }),
      flag({ id: 11, entity_type: 'sample', entity_id: 'P-1' }),
      flag({ id: 12, entity_id: '4' }),
      flag({ id: 13, entity_id: '1' }),
    ]
    // The frame's own flag counts too; the loose item (4) does not.
    expect(frameRollup(flags, nodes, 1, blocking)).toEqual({
      blocking: 1,
      other: 2,
    })
    expect(frameRollup(flags, nodes, 4, blocking)).toEqual({
      blocking: 0,
      other: 1,
    })
  })

  it('assigned count is per user over the board flags', () => {
    const flags = [
      flag({ assignee_id: 5 }),
      flag({ id: 2, assignee_id: 5 }),
      flag({ id: 3, assignee_id: 6 }),
    ]
    expect(assignedCount(flags, 5)).toBe(2)
    expect(assignedCount(flags, null)).toBe(0)
  })

  it('attention list: blocking or past due, overdue first by due date, then blocking by recency', () => {
    const flags = [
      flag({ id: 1, type: 'blocker', updated_at: '2026-10-10T00:00:00Z' }),
      flag({ id: 2, due_at: '2026-10-11T00:00:00Z' }),
      flag({ id: 3, due_at: '2026-10-09T00:00:00Z' }),
      flag({ id: 4, due_at: '2026-10-20T00:00:00Z' }),
      flag({ id: 5, type: 'blocker', updated_at: '2026-10-11T00:00:00Z' }),
    ]
    expect(attentionList(flags, blocking, NOW).map(f => f.id)).toEqual([
      3, 2, 5, 1,
    ])
  })

  it('due labels', () => {
    expect(dueLabel(null, NOW)).toBeNull()
    expect(dueLabel('2026-10-09T12:00:00Z', NOW)).toBe('overdue 3d')
    expect(dueLabel('2026-10-12T18:00:00Z', NOW)).toBe('due today')
    expect(dueLabel('2026-10-14T12:00:00Z', NOW)).toBe('due in 2d')
  })

  it('locate target: the item for board_node and entity anchors, none for the board', () => {
    const nodes = [
      node({ id: 1 }),
      node({ id: 2, kind: 'entity', entity_type: 'sample', entity_id: 'P-1' }),
    ]
    expect(locateTargetFor(flag({ entity_id: '1' }), nodes)).toBe(1)
    expect(
      locateTargetFor(flag({ entity_type: 'sample', entity_id: 'P-1' }), nodes)
    ).toBe(2)
    expect(
      locateTargetFor(flag({ entity_type: 'board', entity_id: '9' }), nodes)
    ).toBeNull()
    expect(locateTargetFor(flag({ entity_id: '99' }), nodes)).toBeNull()
  })

  it('blocking set reads is_blocking off the type list', () => {
    expect(
      blockingTypeSet([
        { slug: 'blocker', is_blocking: true },
        { slug: 'task', is_blocking: false },
      ])
    ).toEqual(new Set(['blocker']))
    expect(blockingTypeSet(undefined)).toEqual(new Set())
  })
})
