import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUIStore } from '@/store/ui-store'
import { useRegisterActiveFlagEntity } from '@/components/flags/use-active-flag-entity'

describe('useRegisterActiveFlagEntity', () => {
  beforeEach(() => {
    useUIStore.setState({ activeFlagEntityStack: [] })
  })

  it('pushes on mount and pops on unmount', () => {
    const { unmount } = renderHook(() =>
      useRegisterActiveFlagEntity('sample', 'P-0071', 'P-0071')
    )
    expect(useUIStore.getState().activeFlagEntityStack).toEqual([
      { type: 'sample', id: 'P-0071', label: 'P-0071' },
    ])
    unmount()
    expect(useUIStore.getState().activeFlagEntityStack).toEqual([])
  })

  it('is a no-op while type/id are missing, registers once they resolve', () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useRegisterActiveFlagEntity('sample', id, id),
      { initialProps: { id: null as string | null } }
    )
    expect(useUIStore.getState().activeFlagEntityStack).toEqual([])
    rerender({ id: 'P-0071' })
    expect(useUIStore.getState().activeFlagEntityStack).toHaveLength(1)
  })

  it('re-registers (replace, not accumulate) when the entity changes', () => {
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useRegisterActiveFlagEntity('sample', id, id),
      { initialProps: { id: 'P-0071' } }
    )
    rerender({ id: 'P-0072' })
    const stack = useUIStore.getState().activeFlagEntityStack
    expect(stack).toHaveLength(1)
    expect(stack.at(-1)?.id).toBe('P-0072')
  })

  it('defaults the label from entityLabel when omitted', () => {
    renderHook(() => useRegisterActiveFlagEntity('sub_sample', '42'))
    expect(useUIStore.getState().activeFlagEntityStack.at(-1)?.label).toBe(
      'Sub Sample 42'
    )
  })
})
