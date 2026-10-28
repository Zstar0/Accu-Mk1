import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { applyNavToStore, buildHash, parseNavHash } from '@/lib/hash-navigation'

function applyHash(hash: string) {
  const nav = parseNavHash(hash)
  if (!nav) throw new Error(`unparseable hash ${hash}`)
  applyNavToStore(nav)
}

const currentHash = () => buildHash(useUIStore.getState())

describe('the endo worksheet page in the hash', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeSection: 'dashboard',
      activeSubSection: 'orders',
      worksheetPageId: null,
      worksheetDrawerOpen: false,
    })
  })

  it('parses ?id= into the store and builds it back', () => {
    applyHash('#hplc-analysis/worksheet?id=42')
    const s = useUIStore.getState()
    expect([s.activeSection, s.activeSubSection, s.worksheetPageId]).toEqual([
      'hplc-analysis',
      'worksheet',
      42,
    ])
    expect(currentHash()).toBe('#hplc-analysis/worksheet?id=42')
  })

  it('navigateToWorksheet closes the flyout and moves the hash', () => {
    useUIStore.setState({ worksheetDrawerOpen: true })
    useUIStore.getState().navigateToWorksheet(7)
    expect(useUIStore.getState().worksheetDrawerOpen).toBe(false)
    expect(currentHash()).toBe('#hplc-analysis/worksheet?id=7')
  })

  it('generic navigateTo clears the page id', () => {
    useUIStore.getState().navigateToWorksheet(7)
    useUIStore.getState().navigateTo('hplc-analysis', 'worksheets')
    expect(useUIStore.getState().worksheetPageId).toBeNull()
    expect(currentHash()).toBe('#hplc-analysis/worksheets')
  })

  it('a non-numeric id is a plain navigate, never NaN', () => {
    applyHash('#hplc-analysis/worksheet?id=abc')
    expect(useUIStore.getState().worksheetPageId).toBeNull()
    expect(currentHash()).toBe('#hplc-analysis/worksheet')
  })

  it('leaves the flyout deep link as it is', () => {
    applyHash('#hplc-analysis/worksheet-detail?id=9')
    expect(useUIStore.getState().worksheetDrawerOpen).toBe(true)
    expect(useUIStore.getState().worksheetPageId).toBeNull()
  })

  it('round-trips the prep rules page (slice 5)', () => {
    applyHash('#hplc-analysis/endo-prep-rules')
    expect(useUIStore.getState().activeSubSection).toBe('endo-prep-rules')
    expect(currentHash()).toBe('#hplc-analysis/endo-prep-rules')
  })
})
