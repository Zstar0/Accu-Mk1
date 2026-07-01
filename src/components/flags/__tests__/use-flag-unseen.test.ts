import { beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'flags:unseen'
const TAB_KEY = 'flags:unseenTab'

/**
 * The store reads localStorage ONCE at module init, so "survives refresh" is
 * only provable by re-importing the module fresh (a reload analogue) after
 * seeding storage — not by in-memory assertions. `vi.resetModules()` + dynamic
 * import gives us that, mirroring FlagsFlyout.test.tsx.
 */
describe('useFlagUnseen', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('marks a flag unseen and persists it to localStorage', async () => {
    const { useFlagUnseen } = await import('../use-flag-unseen')
    useFlagUnseen.getState().markUnseen(42)
    expect(useFlagUnseen.getState().unseenIds).toEqual([42])
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify([42]))
  })

  it('dedupes repeated marks of the same flag', async () => {
    const { useFlagUnseen } = await import('../use-flag-unseen')
    useFlagUnseen.getState().markUnseen(42)
    useFlagUnseen.getState().markUnseen(42)
    expect(useFlagUnseen.getState().unseenIds).toEqual([42])
  })

  it('rehydrates unseen ids from localStorage on (re)load — survives refresh', async () => {
    window.localStorage.setItem(KEY, JSON.stringify([7, 8]))
    vi.resetModules()
    const { useFlagUnseen } = await import('../use-flag-unseen')
    expect(useFlagUnseen.getState().unseenIds).toEqual([7, 8])
  })

  it('acknowledge() snapshots unseen → justOpened and clears the bar + storage', async () => {
    const { useFlagUnseen } = await import('../use-flag-unseen')
    useFlagUnseen.getState().markUnseen(1)
    useFlagUnseen.getState().markUnseen(2)
    useFlagUnseen.getState().acknowledge()
    const s = useFlagUnseen.getState()
    expect(s.unseenIds).toEqual([])
    expect(s.justOpened).toEqual([1, 2])
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify([]))
  })

  it('tracks the newest ping tab and persists it as the auto-jump target', async () => {
    const { useFlagUnseen } = await import('../use-flag-unseen')
    useFlagUnseen.getState().markUnseen(1, 'assigned')
    useFlagUnseen.getState().markUnseen(2, 'raised')
    // Newest ping wins the jump target, even across different flags.
    expect(useFlagUnseen.getState().pendingTab).toBe('raised')
    expect(window.localStorage.getItem(TAB_KEY)).toBe('raised')
  })

  it('acknowledge() snapshots the tab into justOpenedTab and clears pendingTab', async () => {
    const { useFlagUnseen } = await import('../use-flag-unseen')
    useFlagUnseen.getState().markUnseen(5, 'raised')
    useFlagUnseen.getState().acknowledge()
    const s = useFlagUnseen.getState()
    expect(s.justOpenedTab).toBe('raised')
    expect(s.pendingTab).toBeNull()
    expect(window.localStorage.getItem(TAB_KEY)).toBeNull()
  })

  it('rehydrates the pending tab from localStorage on (re)load', async () => {
    window.localStorage.setItem(KEY, JSON.stringify([9]))
    window.localStorage.setItem(TAB_KEY, 'raised')
    vi.resetModules()
    const { useFlagUnseen } = await import('../use-flag-unseen')
    expect(useFlagUnseen.getState().pendingTab).toBe('raised')
  })

  it('ignores a malformed persisted tab', async () => {
    window.localStorage.setItem(TAB_KEY, 'bogus')
    vi.resetModules()
    const { useFlagUnseen } = await import('../use-flag-unseen')
    expect(useFlagUnseen.getState().pendingTab).toBeNull()
  })

  it('acknowledge() is a no-op when nothing is unseen', async () => {
    const { useFlagUnseen } = await import('../use-flag-unseen')
    useFlagUnseen.getState().acknowledge()
    expect(useFlagUnseen.getState().justOpened).toEqual([])
  })

  it('clearJustOpened() drops the row-pulse + jump snapshots', async () => {
    const { useFlagUnseen } = await import('../use-flag-unseen')
    useFlagUnseen.getState().markUnseen(1, 'raised')
    useFlagUnseen.getState().acknowledge()
    useFlagUnseen.getState().clearJustOpened()
    expect(useFlagUnseen.getState().justOpened).toEqual([])
    expect(useFlagUnseen.getState().justOpenedTab).toBeNull()
  })

  it('ignores malformed persisted data', async () => {
    window.localStorage.setItem(KEY, '{not json')
    vi.resetModules()
    const { useFlagUnseen } = await import('../use-flag-unseen')
    expect(useFlagUnseen.getState().unseenIds).toEqual([])
  })
})
