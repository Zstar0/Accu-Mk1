/**
 * Perf finding #2 — scoped + coalesced SSE query invalidation.
 *
 * The glue used to `invalidateQueries({ queryKey: ['flags'] })` on EVERY SSE
 * event, refetching every mounted flag query — including the 10–40 per-vial
 * EntityFlagButtons in VialsQuickLookDialog — on every event, per client. These
 * tests pin the replacement:
 *   (a) an entity-scoped event refetches only its OWN entity's button(s), never
 *       an unrelated entity's, and never blanket-invalidates;
 *   (b) a burst of events collapses into ONE debounced flush;
 *   (c) a degenerate / un-scopeable payload falls back to the old blanket;
 *   (d) a general-task event (no anchor) uses the standard set, NOT blanket —
 *       blanket-ing it would re-create the very per-vial storm this fix kills.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useAuthStore } from '@/store/auth-store'

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

const invalidateQueries = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-query', async orig => ({
  ...((await orig()) as object),
  useQueryClient: () => ({ invalidateQueries, getQueryData: () => undefined }),
}))

vi.mock('@/components/flags/use-flag-unseen', () => ({
  useFlagUnseen: {
    getState: () => ({
      markUnseen: vi.fn(),
      acknowledge: vi.fn(),
      clearJustOpened: vi.fn(),
    }),
  },
}))

let handler: (e: unknown) => void
vi.mock('@/lib/flag-stream', () => ({
  useFlagStream: (cb: (e: unknown) => void) => {
    handler = cb
  },
}))

type StreamEvent = Record<string, unknown>

function evt(overrides: StreamEvent = {}): StreamEvent {
  const { flag, ...rest } = overrides
  return {
    event_type: 'commented',
    flag_id: 7,
    actor_id: 1,
    from_value: null,
    to_value: null,
    details: {},
    event_id: 1,
    flag: {
      id: 7,
      title: 't',
      type: 'blocker',
      kind: 'issue',
      status: 'open',
      entity_type: 'sub_sample',
      entity_id: '1',
      assignee_id: 99,
      created_by: 99,
      ...(flag as object | undefined),
    },
    ...rest,
  }
}

function invalidatedKeys(): unknown[][] {
  return invalidateQueries.mock.calls
    .map(c => (c[0] as { queryKey?: unknown[] }).queryKey)
    .filter((k): k is unknown[] => Array.isArray(k))
}
function hasKey(target: unknown[]): boolean {
  const t = JSON.stringify(target)
  return invalidatedKeys().some(k => JSON.stringify(k) === t)
}
function keyCount(target: unknown[]): number {
  const t = JSON.stringify(target)
  return invalidatedKeys().filter(k => JSON.stringify(k) === t).length
}
function usedRollupPredicate(): boolean {
  return invalidateQueries.mock.calls.some(
    c => typeof (c[0] as { predicate?: unknown }).predicate === 'function'
  )
}

async function mountGlue() {
  const { useFlagStreamGlue } = await import(
    '@/components/flags/use-flag-stream-glue'
  )
  const { renderHook } = await import('@testing-library/react')
  return renderHook(() => useFlagStreamGlue())
}

describe('flag stream glue — scoped + coalesced invalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invalidateQueries.mockClear()
    // No current user → nothing is "relevant", so the toast/unseen path stays
    // out of the way; these tests are about invalidation only.
    useAuthStore.setState({ user: null as never })
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('scopes to the event entity — no blanket, no unrelated entity', async () => {
    await mountGlue()
    handler(evt({ flag: { entity_type: 'sub_sample', entity_id: '1' } }))

    // Debounced: nothing fires until the window elapses.
    expect(invalidateQueries).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)

    // Standard set + the affected vial's button.
    expect(hasKey(['flags', 'list'])).toBe(true)
    expect(hasKey(['flags', 'summary'])).toBe(true)
    expect(hasKey(['flags', 'unread'])).toBe(true)
    expect(hasKey(['flags', 'activity'])).toBe(true)
    expect(hasKey(['flags', 7])).toBe(true) // this flag's detail
    expect(hasKey(['flags', 'entity', 'sub_sample', '1'])).toBe(true)
    // A descendant event may restate a parent rollup button → rollup pass runs.
    expect(usedRollupPredicate()).toBe(true)

    // The whole point: never blanket, never touch an UNRELATED entity's button.
    expect(hasKey(['flags'])).toBe(false)
    expect(hasKey(['flags', 'entity', 'sub_sample', '2'])).toBe(false)
  })

  it('coalesces a burst into a single flush', async () => {
    await mountGlue()
    for (let i = 0; i < 5; i++)
      handler(evt({ event_id: i, flag: { entity_type: 'sub_sample', entity_id: '1' } }))

    expect(invalidateQueries).not.toHaveBeenCalled() // still debounced
    vi.advanceTimersByTime(300)

    // Five events → the summary (and the scoped entity) invalidate exactly once.
    expect(keyCount(['flags', 'summary'])).toBe(1)
    expect(keyCount(['flags', 'entity', 'sub_sample', '1'])).toBe(1)
    expect(keyCount(['flags', 'list'])).toBe(1)
  })

  it('falls back to blanket when the anchor is un-scopeable', async () => {
    await mountGlue()
    // Half-present anchor (type but no id) — can't be trusted to scope.
    handler(evt({ flag: { entity_type: 'sub_sample', entity_id: '' } }))
    vi.advanceTimersByTime(300)

    expect(hasKey(['flags'])).toBe(true) // blanket
    // Blanket subsumes everything → no scoped entity key emitted.
    expect(hasKey(['flags', 'entity', 'sub_sample', ''])).toBe(false)
    expect(usedRollupPredicate()).toBe(false)
  })

  it('general-task event uses the standard set, not blanket', async () => {
    await mountGlue()
    // No anchor at all (general task) — expected, first-class; NOT a blanket case.
    handler(evt({ flag: { entity_type: null, entity_id: null } }))
    vi.advanceTimersByTime(300)

    expect(hasKey(['flags', 'list'])).toBe(true)
    expect(hasKey(['flags', 'summary'])).toBe(true)
    expect(hasKey(['flags', 7])).toBe(true)
    // Not blanket, no entity scope, no rollup — nothing to storm.
    expect(hasKey(['flags'])).toBe(false)
    expect(usedRollupPredicate()).toBe(false)
  })
})
