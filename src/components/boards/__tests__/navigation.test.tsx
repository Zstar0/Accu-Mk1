import { render, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useHashNavigation } from '@/lib/hash-navigation'
import { useUIStore } from '@/store/ui-store'
import { navigateToDeepLink } from '@/components/flags/flag-entity'

function Probe() {
  useHashNavigation()
  return null
}

describe('boards navigation', () => {
  beforeEach(() => {
    window.location.hash = ''
    useUIStore.setState({
      activeSection: 'dashboard',
      activeSubSection: 'orders',
      boardTargetSlug: null,
      pendingBoardNode: null,
    })
  })

  it('parses #boards/board?id=<slug>&node=<id> and the node param is one-shot', async () => {
    window.location.hash = '#boards/board?id=org&node=42'
    render(<Probe />)
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    const s = useUIStore.getState()
    expect(s.activeSection).toBe('boards')
    expect(s.activeSubSection).toBe('board')
    expect(s.boardTargetSlug).toBe('org')
    expect(s.pendingBoardNode).toBe('42')
    expect(useUIStore.getState().consumePendingBoardNode()).toBe('42')
    expect(useUIStore.getState().consumePendingBoardNode()).toBeNull()
    // A real navigation change (not a same-value re-set, which the
    // pushState subscriber ignores) proves buildHash never re-emits `node`.
    act(() => useUIStore.getState().navigateToBoards())
    act(() => useUIStore.getState().navigateToBoard('org'))
    expect(window.location.hash).toBe('#boards/board?id=org')
  })

  it('navigateTo clears the board target and the list route is #boards/overview', () => {
    render(<Probe />)
    act(() => useUIStore.getState().navigateToBoard('org'))
    expect(useUIStore.getState().boardTargetSlug).toBe('org')
    act(() => useUIStore.getState().navigateTo('boards', 'overview'))
    expect(useUIStore.getState().boardTargetSlug).toBeNull()
    expect(window.location.hash).toBe('#boards/overview')
  })

  it('a board_node deep link opens the board with the node pending', () => {
    expect(navigateToDeepLink({ kind: 'board_node', id: 'exec:7' })).toBe(true)
    const s = useUIStore.getState()
    expect(s.activeSection).toBe('boards')
    expect(s.boardTargetSlug).toBe('exec')
    expect(s.pendingBoardNode).toBe('7')
    expect(navigateToDeepLink({ kind: 'board_node', id: 'malformed' })).toBe(
      false
    )
  })

  it('a plain board navigation drops a stale pending node', () => {
    useUIStore.getState().setPendingBoardNode('42')
    useUIStore.getState().navigateToBoard('other')
    expect(useUIStore.getState().pendingBoardNode).toBeNull()
  })
})
