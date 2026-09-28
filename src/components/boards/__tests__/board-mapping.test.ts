import { describe, it, expect } from 'vitest'
import {
  edgeIdsToDelete,
  parseViewport,
  resizePatch,
  resolveParentOnDrop,
  toFlowNodes,
  toPositionItems,
} from '@/components/boards/board-mapping'
import type { BoardNode } from '@/lib/api-boards'

const row = (o: Partial<BoardNode>): BoardNode => ({
  id: 1,
  board_id: 1,
  kind: 'text',
  label: 'T',
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

describe('board-mapping', () => {
  it('frames get sizes, children get parentId and extent, drag follows canEdit', () => {
    const nodes = toFlowNodes(
      [
        row({ id: 1, kind: 'frame', w: 400, h: 200 }),
        row({ id: 2, parent_id: 1, x: 10, y: 5 }),
      ],
      false
    )
    const frame = nodes.find(n => n.id === '1')
    const child = nodes.find(n => n.id === '2')
    expect(frame?.type).toBe('frame')
    expect(frame?.style).toEqual({ width: 400, height: 200 })
    expect(child?.parentId).toBe('1')
    expect(child?.extent).toBe('parent')
    expect(child?.position).toEqual({ x: 10, y: 5 })
    expect(child?.draggable).toBe(false)
  })

  it('a node dropped inside a frame saves a relative position (Review Focus 1)', () => {
    const frames = [
      { id: '1', position: { x: 100, y: 50 }, width: 400, height: 200 },
    ]
    const dropped = resolveParentOnDrop(
      { id: '2', position: { x: 130, y: 60 }, width: 40, height: 20 },
      frames
    )
    expect(dropped).toEqual({ parentId: '1', position: { x: 30, y: 10 } })
    const outside = resolveParentOnDrop(
      { id: '3', position: { x: 900, y: 900 }, width: 40, height: 20 },
      frames
    )
    expect(outside).toEqual({ parentId: null, position: { x: 900, y: 900 } })
    const already = resolveParentOnDrop(
      { id: '4', position: { x: 5, y: 5 }, parentId: '1' },
      frames
    )
    expect(already).toEqual({ parentId: '1', position: { x: 5, y: 5 } })
  })

  it('position items carry the row version and a changed parent', () => {
    const rows = new Map([[2, row({ id: 2, version: 3 })]])
    expect(
      toPositionItems(rows, [
        { id: '2', position: { x: 1, y: 2 }, parentId: '1' },
      ])
    ).toEqual([{ id: 2, x: 1, y: 2, parent_id: 1, version: 3 }])
    expect(
      toPositionItems(rows, [{ id: '2', position: { x: 1, y: 2 } }])
    ).toEqual([{ id: 2, x: 1, y: 2, version: 3 }])
  })

  it('a frame resize patch carries only size and the row version', () => {
    expect(
      resizePatch(row({ id: 5, kind: 'frame', version: 4 }), {
        width: 500,
        height: 260,
      })
    ).toEqual({ id: 5, data: { w: 500, h: 260, version: 4 } })
  })

  it('frames carry the board slug for their own resize writes', () => {
    const [frame] = toFlowNodes([row({ kind: 'frame' })], true, 'org')
    expect(frame?.data.slug).toBe('org')
  })

  it('Delete removes only the edges the user selected, not a selected node edges', () => {
    expect(
      edgeIdsToDelete([
        { id: '4', source: '1', target: '2', selected: true },
        { id: '5', source: '1', target: '3' },
      ])
    ).toEqual([4])
  })

  it('parseViewport accepts only finite x, y and zoom (M4)', () => {
    expect(parseViewport('{"x":1,"y":2,"zoom":0.5}')).toEqual({
      x: 1,
      y: 2,
      zoom: 0.5,
    })
    for (const bad of [
      null,
      '',
      'nope',
      '{}',
      '[]',
      '1',
      '{"x":1,"y":2}',
      '{"x":"1","y":2,"zoom":1}',
      '{"x":1e999,"y":2,"zoom":1}',
    ])
      expect(parseViewport(bad)).toBeNull()
  })
})
