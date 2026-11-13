import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiFetch: h.apiFetch }))

import {
  createNode,
  deleteNode,
  getBoard,
  isStale,
  listBoards,
  patchPositions,
} from '@/lib/api-boards'

describe('api-boards', () => {
  beforeEach(() => h.apiFetch.mockReset())

  it('hits the documented paths with the documented bodies', async () => {
    h.apiFetch.mockResolvedValue([])
    await listBoards()
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards')
    await getBoard('org')
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards/org')
    await createNode('org', {
      kind: 'frame',
      label: 'Marketing',
      x: 1,
      y: 2,
      data: { color: 'purple' },
    })
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards/org/nodes', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'frame',
        label: 'Marketing',
        x: 1,
        y: 2,
        data: { color: 'purple' },
      }),
    })
    await patchPositions('org', [{ id: 3, x: 10, y: 20, version: 1 }])
    expect(h.apiFetch).toHaveBeenLastCalledWith(
      '/api/boards/org/nodes/positions',
      {
        method: 'PATCH',
        body: JSON.stringify([{ id: 3, x: 10, y: 20, version: 1 }]),
      }
    )
    await deleteNode('org', 3)
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards/org/nodes/3', {
      method: 'DELETE',
    })
  })

  it('recognises a stale-version failure from apiFetch error text', () => {
    expect(
      isStale(new Error('PATCH /api/boards/org/nodes/3 failed: 409'))
    ).toBe(true)
    expect(
      isStale(new Error('PATCH /api/boards/org/nodes/3 failed: 400'))
    ).toBe(false)
    expect(isStale('nope')).toBe(false)
  })
})
