import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useUIStore } from '@/store/ui-store'
import {
  applyNavToStore,
  buildHash,
  parseNavHash,
  useHashNavigation,
} from '@/lib/hash-navigation'

function applyHash(hash: string) {
  const nav = parseNavHash(hash)
  if (!nav) throw new Error(`unparseable hash ${hash}`)
  applyNavToStore(nav)
}

const currentHash = () => buildHash(useUIStore.getState())
const LIST = '#hplc-analysis/hplc-calibration'

describe('the calibration worksheet page in the hash (M2)', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeSection: 'dashboard',
      activeSubSection: 'orders',
      calibrationSheetPageId: null,
      worksheetPageId: null,
    })
  })

  it('builds ?id= for an open sheet, and none for the list', () => {
    useUIStore.getState().navigateToCalibrationSheet(5)
    expect(currentHash()).toBe(`${LIST}?id=5`)
    useUIStore.getState().navigateToCalibrationSheet(null)
    expect(currentHash()).toBe(LIST)
  })

  it('parses ?id= into the store (a reload on a sheet reopens it)', () => {
    applyHash(`${LIST}?id=42`)
    const s = useUIStore.getState()
    expect([
      s.activeSection,
      s.activeSubSection,
      s.calibrationSheetPageId,
    ]).toEqual(['hplc-analysis', 'hplc-calibration', 42])
    expect(currentHash()).toBe(`${LIST}?id=42`)
  })

  it('a non-numeric id, or none, is the list', () => {
    applyHash(`${LIST}?id=abc`)
    expect(useUIStore.getState().calibrationSheetPageId).toBeNull()
    useUIStore.getState().navigateToCalibrationSheet(5)
    applyHash(LIST)
    expect(useUIStore.getState().calibrationSheetPageId).toBeNull()
    expect(currentHash()).toBe(LIST)
  })

  it('N3: an id that is not a positive whole number is the list', () => {
    // as ruled, Number.isInteger(n) && n > 0: 0x10 and 1e3 are whole
    // numbers (16, 1000) and open that sheet
    const whole: Record<string, number> = { '0x10': 16, '1e3': 1000 }
    for (const raw of ['-3', '1.5', '1e400', '%20', '0', '0x10', '1e3']) {
      useUIStore.setState({
        activeSection: 'dashboard',
        activeSubSection: 'orders',
        calibrationSheetPageId: null,
      })
      applyHash(`${LIST}?id=${raw}`)
      const s = useUIStore.getState()
      expect([raw, s.activeSubSection, s.calibrationSheetPageId]).toEqual([
        raw,
        'hplc-calibration',
        whole[raw] ?? null,
      ])
    }
    expect(currentHash()).toBe(`${LIST}?id=1000`)
  })

  it('opening a sheet pushes a history entry, and Back returns to the list', () => {
    window.history.replaceState(null, '', LIST)
    applyHash(LIST)
    const { unmount } = renderHook(() => useHashNavigation())
    const before = window.history.length
    act(() => useUIStore.getState().navigateToCalibrationSheet(7))
    expect(window.location.hash).toBe(`${LIST}?id=7`)
    expect(window.history.length).toBe(before + 1)
    // Back: the browser shows the list's hash, then fires popstate
    act(() => {
      window.history.replaceState(null, '', LIST)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(useUIStore.getState().calibrationSheetPageId).toBeNull()
    expect(useUIStore.getState().activeSubSection).toBe('hplc-calibration')
    // Forward: the sheet again
    act(() => {
      window.history.replaceState(null, '', `${LIST}?id=7`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(useUIStore.getState().calibrationSheetPageId).toBe(7)
    unmount()
  })

  it('I1: on the calibration page, moving between sheets keeps the page mounted (navigationKey stays)', () => {
    const s = () => useUIStore.getState()
    const k0 = s().navigationKey
    s().navigateToCalibrationSheet(5) // from elsewhere: remount as today
    expect(s().navigationKey).toBe(k0 + 1)
    s().navigateToCalibrationSheet(9) // sheet to sheet
    s().navigateToCalibrationSheet(null) // sheet to list
    s().navigateToCalibrationSheet(4) // list to sheet
    expect(s().navigationKey).toBe(k0 + 1)
    expect(s().calibrationSheetPageId).toBe(4)
    s().navigateTo('hplc-analysis', 'worksheets')
    s().navigateToCalibrationSheet(4) // from another page again
    expect(s().navigationKey).toBe(k0 + 3)
  })

  it('leaves the endo worksheet page as it is', () => {
    applyHash('#hplc-analysis/worksheet?id=9')
    expect(useUIStore.getState().worksheetPageId).toBe(9)
    expect(useUIStore.getState().calibrationSheetPageId).toBeNull()
    expect(currentHash()).toBe('#hplc-analysis/worksheet?id=9')
  })
})
