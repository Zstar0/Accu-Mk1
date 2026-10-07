import { describe, it, expect } from 'vitest'
import { layoutScope, type LayoutBox } from '@/components/boards/board-layout'

const box = (
  id: string,
  x: number,
  y: number,
  o: Partial<LayoutBox> = {}
): LayoutBox => ({ id, position: { x, y }, width: 180, height: 56, ...o })
/** Moved positions by id; `of` throws for an item that did not move. */
function at(moved: { id: string; position: { x: number; y: number } }[]) {
  const m = new Map(moved.map(x => [x.id, x.position]))
  return {
    ids: [...m.keys()].sort(),
    all: [...m.values()],
    of(id: string) {
      const p = m.get(id)
      if (!p) throw new Error(`item ${id} did not move`)
      return p
    },
  }
}

describe('layoutScope', () => {
  it('stacks a frame top-down: the line origin on top, its targets side by side below', () => {
    const boxes = [
      box('1', 0, 0, { width: 360, height: 220 }),
      box('2', 200, 150, { parentId: '1' }),
      box('3', 10, 60, { parentId: '1' }),
      box('4', 10, 60, { parentId: '1' }),
      box('5', 300, 10, { parentId: '1' }),
    ]
    const { moved, size } = layoutScope(
      boxes,
      [
        { source: '2', target: '3' },
        { source: '2', target: '4' },
      ],
      '1'
    )
    const p = at(moved)
    // Unconnected items stay where they are.
    expect(p.ids).toEqual(['2', '3', '4'])
    expect(p.of('2').y).toBeLessThan(p.of('3').y)
    expect(p.of('3').y).toBe(p.of('4').y)
    expect(Math.abs(p.of('3').x - p.of('4').x)).toBeGreaterThanOrEqual(180)
    // Clear of the frame's edge and title.
    for (const pos of p.all) {
      expect(pos.x).toBeGreaterThanOrEqual(16)
      expect(pos.y).toBeGreaterThanOrEqual(40)
    }
    // The frame must be at least this big to hold what moved.
    const right = Math.max(...p.all.map(q => q.x + 180))
    const bottom = Math.max(...p.all.map(q => q.y + 56))
    expect(size).toEqual({ width: right + 16, height: bottom + 16 })
  })

  it('on the whole board an edge to an item inside a frame moves the frame, never the item', () => {
    const boxes = [
      box('1', 500, 500, { width: 360, height: 220 }),
      box('2', 20, 50, { parentId: '1' }),
      box('3', 900, 900),
      box('4', 40, 40),
    ]
    const { moved, size } = layoutScope(
      boxes,
      [{ source: '3', target: '2' }],
      null
    )
    const p = at(moved)
    expect(p.ids).toEqual(['1', '3'])
    expect(p.of('3').y + 56).toBeLessThanOrEqual(p.of('1').y)
    // The block keeps its current top-left corner.
    expect(Math.min(p.of('1').x, p.of('3').x)).toBe(500)
    expect(Math.min(p.of('1').y, p.of('3').y)).toBe(500)
    expect(size).toBeNull()
  })

  it('moves nothing when the scope has no connections', () => {
    const boxes = [
      box('1', 0, 0, { width: 360, height: 220 }),
      box('2', 20, 50, { parentId: '1' }),
      box('3', 900, 900),
    ]
    // The only edge leaves the frame, so the frame scope has none.
    expect(layoutScope(boxes, [{ source: '2', target: '3' }], '1')).toEqual({
      moved: [],
      size: null,
    })
    expect(layoutScope(boxes, [], null)).toEqual({ moved: [], size: null })
  })
})
